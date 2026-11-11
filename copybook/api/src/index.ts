import { type Alert13F, type AlertEvent, deliverTo, etDay, MOVES_FIX_AT, recentFeed, resolveFollowedFilers, runScheduled } from './alerts';
import { fetchHistory, historyCsv, holdersCsv, shard, SHARD_KEY, SLUG } from './data';
import { filers as curatedFilers, filerBook, filingMeta, resolveAny, rowsOf } from './v1data';
import { verifyGithubOidc } from './oidc';
import { type ChannelDelivery, channelScope, channelsView, failView, clearSeatDuplicates, getChannels, getFailures, rotateFeed, seedFeed, serveFeed, testChannels, updateChannels } from './channels';
import { createKey, listKeys, MAX_KEYS, meter, revokeKey } from './keys';
import { logEvent, meAccess, teamAccess, teamCsv, teamOwner } from './accesslog';
import { handleV1, v1error } from './v1';

export { KeyMeter } from './keys';
import { holdtermLoginMail, leadAckMail, leadNoticeMail, loginMail, previewInbox, sendMail } from './email';
import { ACTIVE, followCounts, stableBase, logAccess, isActive, isCopy, isPaused, isPro, linkBase, testAddress, type Env, type Member } from './env';
import { changeFollows, type FollowList, type FollowOp, type Follows, getFollows, getMember, isOurInvoice, isOurSubscription, listMembers, planOf, LOGIN_REQUEST_TTL, MAX_FOLLOWS, memberByEmail, publicView, putMember, SESSION_TTL, syncSubscription } from './members';
export { MemberFollows } from './members';
import { importBook } from './book';
import { businessSummary, handleKeepResume, handleWhy } from './revenue';
import { inviteSeat, listSeats, removeSeat, revokeSeatSessions, seatsView } from './seats';
import { stripe, verifyStripeSignature } from './stripe';
import { hmacHex, signToken, verifyToken } from './tokens';

/** Paid data the data workflow uploads besides h/: every filer's full book per quarter, per-issuer holders, bulk exports. */
const INGEST_KEY = /^(fb\/\d{4}Q[1-4]\/\d{10}\.json|s\/[0-9A-Z]{6}\.json|hl\/[0-9A-Z]{6}\.json|v\/\d{10}\/\d{10}-\d{2}-\d{6}\.json|changes\/\d{4}Q[1-4]\.json|bulk\/\d{4}Q[1-4]\.(csv\.gz|parquet))$/;

type IngestKind = 'data' | 'flow' | 'pre';
/** Which workflow may upload a key: the full Flow lists come from the site's Pages workflow, pre/ from the precompute, the rest from the data workflow. */
function ingestKind(key: string): IngestKind | null {
  if (key === 'flow/full.json') return 'flow';
  if (/^pre\/(stock-codes|sec-tickers|issuer-cusips|events)\.json$|^pre\/v1-filers-rest\.txt$/.test(key)) return 'pre';
  return SHARD_KEY.test(key) || INGEST_KEY.test(key) ? 'data' : null;
}
const INGEST_KEYS_ERROR = 'key must be h/{slug}/{YYYYQn}.json|.csv|.v1.json, h/{slug}/index.json, fb/{YYYYQn}/{cik10}.json, s/{issuer6}.json, hl/{issuer6}.json, v/{cik10}/{accession}.json, changes/{YYYYQn}.json or bulk/{YYYYQn}.csv.gz|.parquet';
/** Null when the request's GitHub OIDC token is from a workflow allowed every kind of key in it, else why not. */
async function ingestAuth(env: Env, req: Request, kinds: Set<IngestKind>): Promise<string | null> {
  const tok = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const data = await verifyGithubOidc(tok, env.INGEST_WORKFLOW);
  if (!data) return null;
  // Another workflow's token covers only its own kind, and only when the request has nothing else.
  if (kinds.size === 1 && kinds.has('flow') && env.PAGES_WORKFLOW) return verifyGithubOidc(tok, env.PAGES_WORKFLOW);
  if (kinds.size === 1 && kinds.has('pre') && env.PRECOMPUTE_WORKFLOW) return verifyGithubOidc(tok, env.PRECOMPUTE_WORKFLOW);
  return data;
}
const contentTypeOf = (key: string) => (key.endsWith('.csv') ? 'text/csv; charset=utf-8' : key.endsWith('.csv.gz') ? 'application/gzip' : key.endsWith('.parquet') ? 'application/vnd.apache.parquet' : key.endsWith('.txt') ? 'text/plain' : 'application/json');
/** The uploading build (headers x-copybook-build-id/-built-at, or a manifest's build_id/built_at), so /v1 can name the build each response read. */
function buildMeta(req: Request | null, o: { build_id?: unknown; built_at?: unknown } | null): Record<string, string> {
  const v = { build_id: req?.headers.get('x-copybook-build-id') ?? o?.build_id, built_at: req?.headers.get('x-copybook-built-at') ?? o?.built_at };
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1] && e[1].length <= 64));
}

type Upload = { key: string; bytes: Uint8Array; meta?: { build_id?: unknown; built_at?: unknown } };
/** An uncompressed tar (ustar or GNU): each regular file's name is its R2 key. Headers are read, bodies only sliced. */
function untar(buf: Uint8Array): Upload[] | string {
  const out: Upload[] = [];
  const dec = new TextDecoder();
  const str = (o: number, n: number) => dec.decode(buf.subarray(o, o + n)).replace(/\0.*$/s, '');
  let at = 0;
  let longName: string | null = null;
  while (at + 512 <= buf.length) {
    if (buf.subarray(at, at + 512).every((b) => b === 0)) break; // end of archive
    const size = parseInt(str(at + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(buf[at + 156] || 48);
    const prefix = str(at + 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${str(at, 100)}` : str(at, 100));
    longName = null;
    if (!Number.isFinite(size) || at + 512 + size > buf.length) return 'truncated tar';
    const body = buf.subarray(at + 512, at + 512 + size);
    if (type === 'L') longName = dec.decode(body).replace(/\0.*$/s, '');
    // PAX (Python's default format): a long name comes as a "path=" record in the header before the file.
    else if (type === 'x') longName = dec.decode(body).match(/^\d+ path=(.*)$/m)?.[1] ?? null;
    else if (type === '0' || type === '7') out.push({ key: name.replace(/^\.\//, ''), bytes: body });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
/** POST /ingest-batch: {"objects":[{"key","size",build_id?,built_at?}]} on the first line, then the bytes in order. */
function unmanifest(buf: Uint8Array): Upload[] | string {
  const nl = buf.indexOf(10);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: any = null;
  try {
    m = nl > 0 ? JSON.parse(new TextDecoder().decode(buf.subarray(0, nl))) : null;
  } catch {
    m = null;
  }
  const objs: { key: string; size: number; build_id?: string; built_at?: string }[] = Array.isArray(m?.objects) ? m.objects : [];
  if (!objs.length || objs.some((o) => typeof o?.key !== 'string' || !Number.isInteger(o.size) || o.size < 0)) return 'first line: {"objects":[{"key","size"},...]}, then their bytes in order';
  if (objs.reduce((t, o) => t + o.size, 0) !== buf.length - nl - 1) return "the objects' sizes don't add up to the bytes after the manifest line";
  let at = nl + 1;
  return objs.map((o) => ({ key: o.key, bytes: buf.subarray(at, (at += o.size)), meta: { build_id: o.build_id ?? m.build_id, built_at: o.built_at ?? m.built_at } }));
}
const BATCH_MAX_OBJECTS = 500;
const BATCH_MAX_BYTES = 90_000_000;
const INGEST_PER_MINUTE = 120;
/** Counts this location's single uploads per minute in the Cache API (no KV writes); true past the cap. Approximate by design. */
async function overIngestRate(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  const c = (caches as unknown as { default: Cache }).default;
  const key = `https://copybook.internal/ingest-rate/${Math.floor(Date.now() / 60_000)}`;
  const n = Number((await (await c.match(key).catch(() => undefined))?.text()) ?? 0) + 1;
  await c.put(key, new Response(String(n), { headers: { 'cache-control': 'max-age=120' } })).catch(() => undefined);
  return n > INGEST_PER_MINUTE;
}

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function allowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  const list = [new URL(env.SITE_URL).origin, ...(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  return LOCAL_ORIGIN.test(origin) || list.includes(origin) ? origin : null;
}

function cors(origin: string | null): Record<string, string> {
  return origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : {};
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 16_384) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Members read through a signup's provisional session (the address not yet proven by an emailed link). */
const PROVISIONAL = new WeakSet<Member>();

/** Member from `Authorization: Bearer <session token>`. Session tokens are never accepted from a URL. */
async function authed(req: Request, env: Env): Promise<Member | null> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const p = await verifyToken(env.SESSION_SECRET, token, 'session');
  const m = p ? await getMember(env, p.c) : null;
  // Signed out everywhere (a Fund owner revoked the seat's sessions): sessions issued before then are refused.
  if (!m || (m.sessions_after && (p!.i ?? p!.x - SESSION_TTL) <= m.sessions_after)) return null;
  // A provisional session (the signup form, a new subscriber's checkout hand-off): until the member signs in by an
  // emailed link, which proves the address. A trial started meanwhile keeps it, still limited (see the router).
  if (p!.s === 'provisional') {
    if (m.verified) return null;
    PROVISIONAL.add(m);
  }
  return m;
}

async function issueSession(env: Env, m: Member) {
  return { token: await signToken(env.SESSION_SECRET, 'session', m.customer, SESSION_TTL), member: publicView(m) };
}

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json({ ok: false, error: 'bad signature' }, 400, {});
  }
  const event = JSON.parse(raw);
  const obj = event.data?.object ?? {};
  // Only Copybook and Holdterm prices make or change members: the account's other subscriptions (the Substack-era
  // newsletter, Creo) are logged and acknowledged, so Stripe doesn't retry, with no member, plan change or email.
  // A new Fund subscription: its invoices carry the order terms (footer), from the next one on. Never fails the hook.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Every Copybook customer's invoice defaults: footer (Fund terms, tax line), founding price, checkout's Company and PO.
  const invoiceTerms = async (sub: any, fields: { key: string; text?: { value?: string | null } }[] = []) => {
    if (typeof sub.customer !== 'string') return;
    const { ensureInvoiceTerms } = await import('./revenue');
    const field = (k: string) => fields.find((f) => f.key === k)?.text?.value ?? null;
    console.log(`invoice terms: ${await ensureInvoiceTerms(env, sub, planOf(sub), { company: field('company'), po: field('po') }).then((r) => r.result).catch((e) => `failed ${String(e).slice(0, 120)}`)}`);
  };
  const ignore = (what: string) => (console.log(`webhook: ${event.type} ${obj.id ?? ''} ignored (${what} not a Copybook price)`), json({ ok: true, ignored: true }, 200, {}));
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode === 'subscription' && obj.subscription) {
        const sub = await stripe(env, 'GET', `subscriptions/${obj.subscription}`);
        if (!isOurSubscription(sub)) return ignore('subscription');
        await syncSubscription(env, sub, obj.customer_details?.email);
        await invoiceTerms(sub, obj.custom_fields ?? []);
      }
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      if (!isOurSubscription(obj)) return ignore('subscription');
      await syncSubscription(env, obj);
      if (event.type === 'customer.subscription.created') await invoiceTerms(obj);
      break;
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.overdue':
      if (!(await isOurInvoice(env, obj))) return ignore('invoice');
  }
  switch (event.type) {
    case 'invoice.paid': {
      const { rewardReferrer } = await import('./referrals');
      console.log(`referral: ${await rewardReferrer(env, obj)}`);
      if (typeof obj.customer === 'string') console.log(`overdue: ${await (await import('./revenue')).clearOverdue(env, obj.customer)}`);
      break;
    }
    // An invoice (Copy Fund, Net 30) past its due date: access pauses for the owner and seats, with an email.
    case 'invoice.overdue': {
      if (typeof obj.customer === 'string' && obj.collection_method === 'send_invoice') console.log(`overdue: ${await (await import('./revenue')).markOverdue(env, obj.customer, obj)}`);
      break;
    }
    case 'invoice.payment_failed': {
      const { paymentFailed } = await import('./revenue');
      console.log(`dunning: ${await paymentFailed(env, obj)}`);
      break;
    }
  }
  return json({ ok: true }, 200, {});
}


interface LatencyRow {
  /** The poller that sent it (`server` is ours); rows logged before Nov 11 08:00 UTC carry their send claim's, or none. */
  host?: 'cloudflare' | 'server' | null;
  /** When the poll first saw the filing; first alert email (13F; earlier than `sent` when the moves followed). */
  detected_at?: string | null;
  first_alert_at?: string | null;
  /** An operator's test send. */
  test?: boolean;
  slug: string;
  manager?: string;
  quarter?: string;
  form?: string;
  kind?: string;
  accession: string;
  accepted: string;
  sent: string;
  seconds: number;
  replay?: boolean;
  /** A 13F row timed by the email that carried its moves. */
  moves?: boolean;
  /** Some of its emails waited for Resend's daily limit to reset. */
  email_delayed?: boolean;
  /** A 13F timed by a follow-up that carried its moves (the first email went without them). */
  followup?: boolean;
  /** A 13F row from before tagging whose moves never went out by email. */
  never_moves?: boolean;
  /** Timed at a coalesced email's send (a member's later alerts in a window, while email was short). */
  coalesced?: boolean;
  /** Rows from before the tag are curated managers' (the poll timed only those). */
  coverage?: 'curated' | 'any_filer';
}

/** The quarter whose filings are coming in at `t`: Q3 filings arrive Oct-Dec, and so on. */
function seasonOf(t: number): { season: string; from: number } {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3); // 0-3, the calendar quarter now
  return { season: q === 0 ? `${y - 1}Q4` : `${y}Q${q}`, from: Date.UTC(y, q * 3, 1) };
}

/** Season median and p95 of acceptance-to-send seconds, plus each live alert, newest first. */
/** Median and p90 of a list of seconds (nearest rank), with the count. */
function nearest(xs: number[], p: number): number | null {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
}
/** The median: the middle value, or the mean of the middle two for an even count (rounded to the second). */
export function median(xs: number[]): number | null {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return !s.length ? null : s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function spread(xs: number[]) {
  return { count: xs.length, median_seconds: median(xs), p90_seconds: nearest(xs, 0.9) };
}

/**
 * The public speed numbers for this filing season, live alerts only (replays excluded). Email is
 * acceptance to handing the alert to the mailer; chat, webhook and feed are acceptance to the
 * channel's first successful post (KV alerts:latency:ch).
 */
/** What latency.json's alert rows add beyond the send log: misses, held rows. */
export interface LatencyExtra {
  /** The missed-filing detector's log: filings found unsent past their window. */
  missed?: { accession: string; form: string; cik: string; accepted: string; detected_at: string; minutes_late: number }[];
  /** Rows the gate held, with how each ended (reconciliation.held). */
  held?: { accession: string; released_at: string | null; outcome: string | null }[];
}
/**
 * 13Fs whose stock-match alerts never reached members watching their tickers: ingest renamed active to long_only on
 * Nov 9 and routing kept only hedge_fund and active, until the Worker fix (05:36 UTC Nov 11) and gene's (06:36).
 * Followers got these alerts; watchers didn't, and they weren't re-sent (lead, Nov 11). /status/ Data lists them.
 */
/** When Saturday's "Your names this week" (Fri 9:15pm ET) brings LONG_ONLY_MISSED to the members watching their tickers. */
const WATCHERS_COVERED_AT = '2026-11-14T02:15:00Z';
/** From gene's 09:40 UTC restart (Nov 11) both pollers time a 13F's team posts by the moves follow-up too; before it, they weren't recorded. */
const TEAM_TIMED_FROM = '2026-11-11T09:40:00Z';
const LONG_ONLY_MISSED: [string, string, string][] = [
  ['0001088875-26-000074', 'baillie-gifford-co', '2026-11-09T11:35:17Z'],
  ['0001172661-26-004909', 'comgest-global-investors-s-a-s-4947', '2026-11-09T15:13:14Z'],
  ['0002033334-26-000005', 'north-of-south-capital-llp-3334', '2026-11-09T16:33:50Z'],
  ['0001140361-26-042753', 'acadian-asset-management-llc', '2026-11-09T19:45:16Z'],
  ['0001532262-26-000006', 'greenbrier-partners-capital-management-llc-2262', '2026-11-09T21:13:08Z'],
  ['0001556785-26-000022', 'vulcan-value-partners-llc-6785', '2026-11-10T14:10:42Z'],
  ['0000315066-26-002964', 'fmr-llc', '2026-11-10T14:26:26Z'],
  ['0001172661-26-004920', 'clarkston-capital-partners-llc-2855', '2026-11-10T16:54:10Z'],
  ['0001325447-26-000037', 'matthew-mclennan', '2026-11-10T17:09:56Z'],
  ['0001528593-26-000010', 'black-creek-investment-management-inc-8593', '2026-11-10T18:47:18Z'],
  ['0001426327-26-000007', 'scheer-rowlett-associates-investment-management-ltd-6327', '2026-11-10T19:00:10Z'],
  ['0001036325-26-000041', 'davis-selected-advisers', '2026-11-10T19:59:04Z'],
  ['0001172661-26-004931', 'wilkinson-global-asset-management-llc-4000', '2026-11-10T21:10:34Z'],
  ['0001171200-26-000023', 'jensen-investment-management-inc-6129', '2026-11-10T21:29:29Z'],
  ['0001386060-26-000054', 'boston-partners', '2026-11-10T21:35:04Z'],
  ['0001356513-26-000006', 'westwood-global-investments-llc-6513', '2026-11-10T21:50:43Z'],
];

export function latencyReport(log: LatencyRow[], now: number, ch: ChannelDelivery[] = [], extra: LatencyExtra = {}) {
  const { season, from } = seasonOf(now);
  const fixAt = Date.parse(MOVES_FIX_AT);
  // Before the fix, a 13F whose moves came in a later follow-up (tables too big, or no prior book) is reported apart;
  // one whose first email carried the moves is timed as usual.
  const isPre = (l: LatencyRow) => (l.kind ?? '13f') === '13f' && Date.parse(l.accepted) < fixAt && !!l.followup;
  // 13Fs are timed by the email that carried the moves (rows tagged `moves`); older 13F rows timed the first email.
  // Emails held for the daily limit aren't counted as fast (they're reported as email_delayed).
  // 13Fs accepted before the moves fix (sent before it, or their moves sent after it from the backlog) are reported apart.
  // One row per accession, its first delivery (a later send to another member, e.g. a coalesced one, isn't a second alert).
  const firsts = new Map<string, LatencyRow>();
  const delayedAcc = new Set(log.filter((l) => l.email_delayed && !l.replay && Date.parse(l.sent) >= from).map((l) => l.accession));
  for (const l of log.filter((l) => !l.replay && !l.email_delayed && Date.parse(l.sent) >= from && ((l.kind ?? '13f') !== '13f' || l.moves)).sort((a, b) => a.sent.localeCompare(b.sent)))
    if (!firsts.has(l.accession)) firsts.set(l.accession, l);
  const counted = [...firsts.values()].sort((a, b) => b.sent.localeCompare(a.sent));
  // Every alert counts in the season's figures; the late 13Fs from before the moves fix are also listed to explain them.
  const rows = counted;
  const pre = counted.filter(isPre);
  // A 13F's channel time is its moves post, as its email's is (a first post without the moves isn't timed).
  const chRows = ch.filter((c) => Date.parse(c.delivered) >= from && c.moves !== false);
  const all = spread(rows.map((l) => l.seconds));
  const FORM: Record<string, string> = { '13f': '13F-HR', form4: '4', '13d': 'SC 13D', '13g': 'SC 13G' };
  const formOf = (l: LatencyRow) => l.form ?? FORM[l.kind ?? '13f'] ?? 'other';
  // Form families as the page shows them: 13F-HR (and /A), Form 4, Schedule 13D, Schedule 13G.
  const family = (f: string) => (/^13F/.test(f) ? '13F' : /^4/.test(f) ? 'Form 4' : /13D/.test(f) ? '13D' : /13G/.test(f) ? '13G' : 'other');
  const group = <T,>(xs: T[], key: (x: T) => string, secs: (x: T) => number) => {
    const g: Record<string, number[]> = {};
    for (const x of xs) (g[key(x)] ??= []).push(secs(x));
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, spread(v)]));
  };
  const report = {
    ok: true,
    season,
    since: new Date(from).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    median_seconds: all.median_seconds,
    p90_seconds: all.p90_seconds,
    p95_seconds: nearest(rows.map((l) => l.seconds), 0.95),
    count: all.count,
    by_form: (() => {
      const g = group(rows, (l) => family(formOf(l)), (l) => l.seconds) as Record<string, Record<string, unknown>>;
      // 13F split by acceptance time, not by outcome: the season (each accession once, at its moves email, with how many
      // took over 15 minutes), and only those accepted after the moves fix.
      const f13 = rows.filter((l) => family(formOf(l)) === '13F');
      if (g['13F']) Object.assign(g['13F'], { season: { ...spread(f13.map((l) => l.seconds)), max_seconds: f13.length ? Math.max(...f13.map((l) => l.seconds)) : null, over_15m: f13.filter((l) => l.seconds > 900).length }, since_fix: spread(f13.filter((l) => Date.parse(l.accepted) >= fixAt).map((l) => l.seconds)) });
      return g;
    })(),
    moves_fix_at: MOVES_FIX_AT,
    // Team channels (Slack, Discord, Telegram, webhook) were timed only from here; before it, team_delivered_at is null.
    team_delivered_recorded_from: TEAM_TIMED_FROM,
    before_moves_fix: { '13F': { ...spread(pre.map((l) => l.seconds)), max_seconds: pre.length ? Math.max(...pre.map((l) => l.seconds)) : null, rows: pre.map((l) => ({ accession: l.accession, manager: l.manager ?? null, slug: l.slug, accepted_at: l.accepted, sent_at: l.sent, seconds: l.seconds })) } },
    by_channel: { email: all, ...group(chRows, (c) => c.channel, (c) => c.seconds) },
    by_coverage: group(rows, (l) => l.coverage ?? 'curated', (l) => l.seconds),
    recent: rows.slice(0, 20).map((l) => ({ form: formOf(l), manager: l.manager ?? null, slug: l.slug, coverage: l.coverage ?? 'curated', accession: l.accession, accepted_at: l.accepted, delivered_at: l.sent, seconds: l.seconds, channel: 'email' })),
    // One row per alert this season, replays and test sends included and flagged (the figures above exclude them),
    // then the misses that never went out. Times are UTC to the second; null where they weren't recorded.
    alerts: (() => {
      const iso = (t: string | null | undefined) => (t ? t.replace(/\.\d{3}Z$/, 'Z') : null);
      const one = new Map<string, LatencyRow>();
      for (const l of log.filter((l) => Date.parse(l.sent) >= from && ((l.kind ?? '13f') !== '13f' || l.moves)).sort((a, b) => a.sent.localeCompare(b.sent))) if (!one.has(l.accession)) one.set(l.accession, l);
      const team = new Map<string, string>();
      for (const c of chRows) if (c.channel !== 'feed' && (!team.has(c.accession) || c.delivered < team.get(c.accession)!)) team.set(c.accession, c.delivered);
      const missed = new Map((extra.missed ?? []).map((m) => [m.accession, m]));
      const held = new Map<string, { n: number; open: boolean; released: string | null }>();
      for (const h of extra.held ?? []) {
        const x = held.get(h.accession) ?? { n: 0, open: false, released: null };
        x.n++;
        if (!h.released_at) x.open = true;
        else if (!x.released || h.released_at > x.released) x.released = h.released_at;
        held.set(h.accession, x);
      }
      const sent = [...one.values()].sort((a, b) => b.sent.localeCompare(a.sent)).map((l) => {
        const f13 = (l.kind ?? '13f') === '13f';
        const m = missed.get(l.accession);
        const hd = held.get(l.accession);
        return {
          host: l.host ?? null,
          slug: l.slug,
          manager: l.manager ?? null,
          quarter: l.quarter ?? null,
          form: formOf(l),
          coverage: l.coverage ?? 'curated',
          accession: l.accession,
          accepted_at: iso(l.accepted),
          detected_at: iso(m?.detected_at ?? l.detected_at),
          email_accepted_at: iso(l.sent),
          sent_at: iso(l.sent),
          gap_seconds: l.seconds,
          team_delivered_at: iso(team.get(l.accession)),
          first_alert_at: f13 ? iso(l.first_alert_at ?? (l.followup ? null : l.sent)) : null,
          moves_sent_at: f13 ? iso(l.sent) : null,
          held: hd?.n ?? 0,
          released_at: hd && !hd.open ? iso(hd.released) : null,
          missed: !!m,
          delay_seconds: m ? l.seconds : null,
          never: false,
          in_stats: firsts.get(l.accession) === l,
          replay: !!l.replay,
          test: !!l.test,
          email_delayed: !!l.email_delayed,
          // Some member's email for it waited past the daily email limit (chat, feed and webhooks went at once).
          delayed_email_limit: delayedAcc.has(l.accession),
        };
      });
      const missRow = (accession: string, slug: string, form: string, accepted: string, detected: string | null, audience: string) => ({
        host: null, slug, manager: null as string | null, quarter: null as string | null, form, coverage: 'curated', accession, accepted_at: iso(accepted), detected_at: iso(detected), email_accepted_at: null, sent_at: null, gap_seconds: null,
        team_delivered_at: null, first_alert_at: null, moves_sent_at: null, held: 0, released_at: null, missed: true, delay_seconds: null, never: true, audience, in_stats: false, replay: false, test: false, email_delayed: false, delayed_email_limit: false,
      });
      // Found by the missed-filing detector and never sent (6 hours on, it isn't coming).
      const never = (extra.missed ?? []).filter((m) => !one.has(m.accession) && Date.parse(m.accepted) >= from && now - Date.parse(m.detected_at) > 6 * 3600_000).map((m) => missRow(m.accession, m.cik, m.form, m.accepted, m.detected_at, 'everyone'));
      // Sent to followers, never to the members watching its tickers (the long-only routing outage).
      // `never` is for this audience only: the filing's followers got it (followers_alerted_at, its own row above), and the
      // watchers get it in Saturday's "Your names this week" (Fri 9:15pm ET). Not in the latency figures.
      const watchers = LONG_ONLY_MISSED.filter(([, , a]) => Date.parse(a) >= from).map(([acc, slug, a]) => {
        const f = one.get(acc);
        return { ...missRow(acc, slug, '13F-HR', a, null, 'stock_watchers'), manager: f?.manager ?? null, quarter: f?.quarter ?? null, followers_alerted_at: iso(f?.sent), covered_by: 'weekly_names', covered_at: WATCHERS_COVERED_AT };
      });
      return [...sent, ...never, ...watchers];
    })(),
  };
  // Missed rows, apart from the figures: filings no one was alerted to, and filings their followers got but the members
  // watching their tickers didn't (each also has its sent row).
  // Alerts whose email to some member was queued past the daily email limit: counted on /speed/, not hidden.
  const delayed_email_limit = delayedAcc.size;
  const missedBy = (aud: string) => report.alerts.filter((a) => a.missed && a.never && 'audience' in a && a.audience === aud).length;
  return { ...report, delayed_email_limit, missed_never: missedBy('everyone'), missed_stock_watchers: missedBy('stock_watchers') };
}
export async function buildLatency(env: Env, now: number) {
  const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as LatencyRow[];
  const ch = JSON.parse((await env.DB.get('alerts:latency:ch')) ?? '[]') as ChannelDelivery[];
  const rec = await (await import('./alerts')).reconciliation(env);
  const missed = JSON.parse((await env.DB.get('missed:log')) ?? '[]') as LatencyExtra['missed'];
  const r: ReturnType<typeof latencyReport> & { reconciliation?: Record<string, unknown> } = latencyReport(log, now, ch, { missed, held: rec.held as LatencyExtra['held'] });
  r.reconciliation = rec;
  // The 13F rows are complete once the pre-tag rows were re-timed (/speed/ shows the 13F card from then).
  if (r.by_form['13F'] && (await env.DB.get('latency:retimed:v1'))) Object.assign(r.by_form['13F'], { complete: true });
  return r;
}

/** The last latency.json written by this isolate, so an unchanged report isn't rewritten every minute. */
let publishedLatency = '';
/**
 * Every quiet minute: the /latency report as a static public object (PUBLIC_BUCKET/latency.json through Cloudflare's
 * R2 API, so it works from the Worker and from a self-hosted copy alike). Written only when it changed.
 */
export async function publishLatency(env: Env, now: number): Promise<string> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.PUBLIC_BUCKET) return 'not configured';
  // The poller line for /speed/ ("Poller last ran 40 s ago · Cloudflare"): the host running this minute wrote it. With
  // two hosts it changes every minute, so latency.json is rewritten every quiet minute.
  const fo = await import('./failover');
  // When this run finished (it publishes last), not the minute it started: "last ran 40 s ago" is then true.
  const poller = fo.syncOn(env) ? { poller_host: fo.isCloudflare(env) ? 'cloudflare' : 'server', poller_last_run: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') } : {};
  const body = JSON.stringify({ ...(await buildLatency(env, now)), ...poller, generated_at: new Date(Math.floor(now / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  const same = body.replace(/"generated_at":"[^"]*"/, '');
  if (same === publishedLatency && new Date(now).getUTCMinutes() % 30 !== 0) return 'unchanged';
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${env.PUBLIC_BUCKET}/objects/latency.json`, { method: 'PUT', headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json', 'cache-control': 'public, max-age=60' }, body });
  if (!res.ok) return `error ${res.status}`;
  publishedLatency = same;
  return 'written';
}

const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;
/** How long a member or /v1 request may spend reading EDGAR before it answers from the cache (`pending` lists the rest). */
const EDGAR_READ_MS = 2000;
const REQUEST_MS = 3000;
const DOWNLOAD_TTL = 60; // KV's minimum expiry
const HANDOFF_TTL = 120;

async function csvResponse(env: Env, slug: string, h: Record<string, string>, data?: unknown): Promise<Response> {
  const hist = data ?? (await fetchHistory(env, slug));
  if (!hist) return json({ ok: false, error: 'unknown manager' }, 404, h);
  return new Response(historyCsv(env, hist), {
    status: 200,
    headers: { ...h, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="copybook-${slug}-13f-history.csv"`, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' },
  });
}

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const origin = allowedOrigin(req.headers.get('origin'), env);
  const h = cors(origin);

  // The versioned API for Copy Pro: API-key auth, open CORS, its own error shape.
  if (path === '/v1' || path.startsWith('/v1/')) return handleV1(req, env, url, path);

  if (req.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: h });
  if (req.method === 'POST' && path === '/webhook') return handleWebhook(req, env);
  if (req.method === 'POST' && req.headers.get('origin') && !origin) return json({ ok: false, error: 'origin not allowed' }, 403, {});

  if (req.method === 'GET' && path === '/health') {
    // /status/'s minute probe: up, since when, and which build (so a restart reads as a deploy or not).
    if (url.searchParams.get('probe') === '1') {
      const { pollerStatus } = await import('./failover');
      const p = await pollerStatus(env, Date.now());
      const { total, last_7d } = await (await import('./alerts')).dupesBlocked(env);
      const meter = JSON.parse((await env.DB.get('host:mail-meter')) ?? 'null') as { day?: string; used?: number; kinds?: unknown } | null;
      return json({ ok: true, api_host: p.api_host, api_up_since: p.api_up_since, api_build: env.BUILD_SHA?.slice(0, 12) ?? null, dupes_blocked: { total, last_7d }, mail_kinds: meter?.day ? { day: meter.day, used: meter.used ?? 0, ...((meter.kinds as object) ?? {}), waiting_now: { retry: (JSON.parse((await env.DB.get('host:mail-retry')) ?? '[]') as unknown[]).length, delayed: (JSON.parse((await env.DB.get('host:mail-delayed')) ?? '[]') as unknown[]).length } } : null }, 200, { 'cache-control': 'no-store' });
    }
    // Seconds from EDGAR acceptance to handing the alert to the mailer, for the latest alerted filings.
    // Live alerts only (test replays excluded); ?latency=all returns every stored one instead of the latest 10.
    const all = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as { seconds: number; replay?: boolean }[];
    const live = all.filter((l) => !l.replay);
    const sorted = live.map((l) => l.seconds).sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);
    const summary = { count: sorted.length, p50: median(sorted), p90: q(0.9), max: sorted.length ? sorted[sorted.length - 1] : null };
    const leads = Number((await env.DB.get('leads:count')) ?? 0);
    // Member and revenue counts only with the private token; the public view is operational.
    const priv = await isOperator(env, req);
    const business = priv ? { business: { ...(await businessSummary(env, Date.now())), fund_requests: leads } } : {};
    // Filings the missed-filing detector found unsent 10+ minutes after acceptance and put back in front of the polls.
    const missed_recovered = { count: Number((await env.DB.get('missed:count')) ?? 0), recent: (JSON.parse((await env.DB.get('missed:log')) ?? '[]') as unknown[]).slice(0, 10) };
    const st = await import('./status');
    // Alerts the per-member sent record stopped from reaching a member twice: total, the last 7 UTC days, per day.
    const dupes_blocked = await (await import('./alerts')).dupesBlocked(env);
    const { pollerStatus } = await import('./failover');
    return json({ ok: true, ...(await pollerStatus(env, Date.now())), alert_latency_summary: summary, missed_recovered, dupes_blocked, alert_latency: url.searchParams.get('latency') === 'all' ? live : live.slice(0, 10), replays_excluded: all.length - live.length, mail_quota: await (async () => {
      const { mailQuota, kindsView } = await import('./email');
      const m = (JSON.parse((await env.DB.get('host:mail-meter')) ?? 'null') ?? mailQuota) as typeof mailQuota;
      // Alert emails handed to the mailer this UTC day, by hour (both hosts: stats:sent is synced).
      const day0 = Math.floor(Date.now() / 86400_000) * 24;
      const byHour = Object.fromEntries((JSON.parse((await env.DB.get('stats:sent')) ?? '[]') as [number, number][]).filter(([hr]) => hr >= day0).map(([hr, n]) => [`${String(hr - day0).padStart(2, '0')}h`, n]));
      // kinds and by_kind are the same view, adding up to used: before_since + real + test + account + other.
      const view = kindsView(m.used, m.kinds);
      const waiting = { retry: (JSON.parse((await env.DB.get('host:mail-retry')) ?? '[]') as unknown[]).length, delayed: (JSON.parse((await env.DB.get('host:mail-delayed')) ?? '[]') as unknown[]).length };
      // Named (gene or cloudflare), with the same two views as the top level, so it reads on its own.
      const this_host = { scope: 'this host', host: (await import('./failover')).isCloudflare(env) ? 'cloudflare' : 'gene', used: m.used, kinds: view, by_kind: view, waiting_now: waiting };
      // The figures status.json publishes (both hosts, one since, one set of labels), as of its generated_at; this
      // host's own tally under this_host. Without a readable status.json for today: this host's view.
      const pub = env.PUBLIC_URL ? ((await fetch(`${env.PUBLIC_URL}status.json?t=${Date.now()}`, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { generated_at?: string; mail_quota?: { day?: string; resend_used: number; by_kind: typeof view; waiting_now: typeof waiting } } | null) : null;
      const both = pub?.mail_quota?.day === m.day && pub.mail_quota.by_kind ? pub.mail_quota : null;
      const shown = both ? { scope: 'both hosts', as_of: pub!.generated_at ?? null, used: both.resend_used, kinds: both.by_kind, by_kind: both.by_kind, waiting_now: both.waiting_now } : this_host;
      return { ...m, ...shown, this_host, alert_emails_today_by_hour: byHour, daily_cap: 100, monthly_cap: 3000, reserve_for_account_mail: 15, policy: (await import('./email')).MAIL_POLICY };
    })(), moves_queue: await st.movesQueue(env, await st.alertHealth(env, Date.now())), ...business }, 200, h);
  }

  // The site's page counts: visits, signup form views and trial clicks per page, utm_source and post (utm_source|utm_content). Counts only (no
  // IP, cookie or member stored); 120 a IP an hour. Read with GET /ops/funnel.
  if (req.method === 'POST' && path === '/track') {
    const b = await body(req);
    const kind = String(b.kind ?? '');
    if (!['visit', 'signup_view', 'trial_click'].includes(kind)) return json({ ok: false, error: 'kind: visit, signup_view or trial_click', code: 'bad_request' }, 400, h);
    const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? 'unknown';
    const k = `rl:track:${ip}`;
    const n = Number((await env.DB.get(k)) ?? 0);
    if (n >= 120) return json({ ok: true, counted: false }, 200, h);
    await env.DB.put(k, String(n + 1), { expirationTtl: 3600 });
    const clean = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase().replace(/[^a-z0-9/_.:-]/g, '').slice(0, max) || null : null);
    const page = (clean(b.page, 100) ?? '/').split('?')[0];
    const src = clean(b.utm_source, 60) ?? 'direct';
    const post = `${src}|${clean(b.utm_content, 60) ?? '-'}`;
    const key = `track:${new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10)}`;
    const d = JSON.parse((await env.DB.get(key)) ?? '{}') as Record<string, Record<string, Record<string, number>>>;
    const byPage = ((d[kind] ??= {}).page ??= {});
    const bySrc = (d[kind].source ??= {});
    const byPost = (d[kind].utm ??= {});
    // Bounded: at most 300 pages and 100 sources a day; the rest count as "other".
    const pk = page in byPage || Object.keys(byPage).length < 300 ? page : 'other';
    const sk = src in bySrc || Object.keys(bySrc).length < 100 ? src : 'other';
    byPage[pk] = (byPage[pk] ?? 0) + 1;
    bySrc[sk] = (bySrc[sk] ?? 0) + 1;
    const uk = post in byPost || Object.keys(byPost).length < 300 ? post : 'other';
    byPost[uk] = (byPost[uk] ?? 0) + 1;
    await env.DB.put(key, JSON.stringify(d), { expirationTtl: 400 * 86400 });
    return json({ ok: true, counted: true }, 200, h);
  }

  // The site's referral card: whether ?ref= is a live code. Says nothing about whose it is; rate-limited per IP.
  const refCheck = path.match(/^\/ref\/([^/]{1,40})$/);
  if (req.method === 'GET' && refCheck) {
    const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? 'unknown';
    const k = `rl:ref:${ip}`;
    const n = Number((await env.DB.get(k)) ?? 0);
    if (n >= 60) return json({ ok: false, error: 'too many requests, try again in an hour', code: 'rate_limited' }, 429, { ...h, 'retry-after': '3600' });
    await env.DB.put(k, String(n + 1), { expirationTtl: 3600 });
    const { canRefer } = await import('./referrals');
    const owner = await env.DB.get(`ref:${decodeURIComponent(refCheck[1]).trim().toLowerCase().slice(0, 20)}`);
    const m = owner ? await getMember(env, owner) : null;
    return json({ ok: true, valid: !!m && canRefer(m) }, 200, { ...h, 'cache-control': 'no-store' });
  }

  // A new subscription's Checkout, with a referral month applied server-side (typed promo codes are off on this account).
  if (req.method === 'POST' && path === '/checkout') {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const k = `rl:checkout:${ip}`;
    const n = Number((await env.DB.get(k)) ?? 0);
    if (n >= 30) return json({ ok: false, error: 'too many requests, try again in an hour', code: 'rate_limited', retry_after: 3600, retry_after_seconds: 3600, retry_at: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') }, 429, { ...h, 'retry-after': '3600', 'access-control-expose-headers': 'retry-after' });
    await env.DB.put(k, String(n + 1), { expirationTtl: 3600 });
    const { createCheckout } = await import('./referrals');
    const r = await createCheckout(env, await body(req));
    return json(r.body, r.status, h);
  }

  // Free accounts: the weekly email, no card. Rate-limited per IP and email; `website` is a honeypot.
  if (req.method === 'POST' && path === '/signup') {
    const { handleSignup } = await import('./free');
    // Signed in (the site sends the session): a follow is added without a sign-in email.
    const r = await handleSignup(env, await body(req), req.headers.get('cf-connecting-ip') ?? 'unknown', (await authed(req, env))?.customer);
    return json(r.body, r.status, { ...h, ...(r.headers ?? {}) });
  }
  // The one unsubscribe link in every weekly and lifecycle email (GET confirms; POST, incl. one-click, applies).
  if ((req.method === 'GET' || req.method === 'POST') && path === '/unsubscribe') {
    const { handleUnsubscribe } = await import('./free');
    return handleUnsubscribe(env, req, url);
  }
  // Trial-ending button (keep, yearly) and the trial-ended note's monthly restart.
  if ((req.method === 'GET' && path === '/keep') || ((req.method === 'GET' || req.method === 'POST') && path === '/resume')) return handleKeepResume(env, path as '/keep' | '/resume', url, req.method);

  // The one-click cancellation reason from the follow-up email (and an optional note).
  if ((req.method === 'GET' || req.method === 'POST') && path === '/why') return handleWhy(env, req, url);

  // Public alert latency for /speed/ and /pricing/: this filing season's live alerts, replays excluded. The cron also
  // writes it once a minute to PUBLIC_URL/latency.json (a public R2 object), which pages read without a Worker request.
  if (req.method === 'GET' && path === '/latency') {
    const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default;
    const key = 'https://copybook.internal/latency';
    const hit = await cache?.match(key).catch(() => undefined);
    if (hit) return new Response(hit.body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60, s-maxage=60', ...h } });
    const body = JSON.stringify(await buildLatency(env, Date.now()));
    await cache?.put(key, new Response(body, { headers: { 'cache-control': 's-maxage=60' } })).catch(() => undefined);
    return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60, s-maxage=60', ...h } });
  }

  // Support fixes to a member's follows (e.g. restoring lost names), through the same serialized path
  // as the member's own changes. Operator token only.
  const ops = path.match(/^\/ops\/follows\/(cus_\w+|free_[0-9a-f]{16})$/);
  if (req.method === 'POST' && ops) {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const m = await getMember(env, ops[1]);
    if (!m) return json({ ok: false, error: 'no such member' }, 404, h);
    const r = await changeFollows(env, m, (await body(req)) as unknown as FollowOp);
    await logAccess(env, req, 'POST /ops/follows/{customer}', [m.customer], 'follows changed and returned');
    return json(r.ok ? { ok: true, customer: m.customer, follows: m.test || testAddress(m.email) ? r.follows : followCounts(r.follows) } : r, r.ok ? 200 : 400, h);
  }

  // Operator, read-only: members whose Stripe subscription is not a Copybook or Holdterm price (made before the webhook's guard).
  if (req.method === 'GET' && path === '/ops/price-audit') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const out: Record<string, unknown>[] = [];
    let checked = 0;
    for (const m of await listMembers(env)) {
      if (!m.subscription?.startsWith('sub_')) continue;
      checked++;
      const sub = await stripe(env, 'GET', `subscriptions/${m.subscription}`).catch(() => null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sub && !isOurSubscription(sub)) out.push({ customer: m.customer, subscription: m.subscription, member_plan: m.plan, member_status: m.status, stripe_status: sub.status, prices: (sub.items?.data ?? []).map((i: any) => ({ id: i.price?.id, product: i.price?.product, unit_amount: i.price?.unit_amount, interval: i.price?.recurring?.interval, metadata: i.price?.metadata })) });
    }
    return json({ ok: true, checked, not_copybook: out.length, members: out }, 200, h);
  }

  // Operator: erase a member by email (gate test members, data-deletion requests). Delete the Stripe customer first.
  if (req.method === 'POST' && path === '/ops/erase-member') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const { eraseMember } = await import('./free');
    const email = String((await body(req)).email ?? '').trim().toLowerCase();
    if (!email) return json({ ok: false, error: 'email' }, 400, h);
    const r = await eraseMember(env, email);
    await logAccess(env, req, 'POST /ops/erase-member', r.customers, 'erased');
    console.log(`operator: erased member ${r.customers.join(',')} (${r.deleted} keys)`);
    return json({ ok: true, ...r }, 200, h);
  }

  // Operator: one account per email for a free signup and paid member split before the merge shipped.
  if (req.method === 'POST' && path === '/ops/merge-free') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const { mergeFreeSignup } = await import('./free');
    const email = String((await body(req)).email ?? '').trim().toLowerCase();
    await logAccess(env, req, 'POST /ops/merge-free', [await env.DB.get(`email:${email}`)], 'free and paid records merged');
    return json(await mergeFreeSignup(env, email), 200, h);
  }

  // Operator: this week's free email for one free member, now (Friday's issue, previewed).
  // Operator: a test member's referral code (the front end's end-to-end check). Never a real member's.
  if (req.method === 'POST' && path === '/ops/ref-code') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const email = String((await body(req)).email ?? '').trim().toLowerCase();
    const m = testAddress(email) ? await memberByEmail(env, email) : null;
    if (!m || !(m.test || testAddress(m.email))) return json({ ok: false, error: 'test members only' }, 400, h);
    const { referralView } = await import('./referrals');
    await logAccess(env, req, 'POST /ops/ref-code', [m.customer], 'referral code read');
    return json({ ok: true, referral: await referralView(env, m) }, 200, h);
  }

  // Operator: the funnel with the site's page counts (POST /track), per ET day.
  if (req.method === 'GET' && path === '/ops/funnel') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const days = Math.min(31, Math.max(1, Number(url.searchParams.get('days') ?? 7) || 7));
    const { funnel } = await import('./revenue');
    const track: Record<string, unknown> = {};
    for (let d = 0; d < days; d++) {
      const day = new Date(Date.now() - 5 * 3600_000 - d * 86_400_000).toISOString().slice(0, 10);
      const t = await env.DB.get(`track:${day}`);
      if (t) track[day] = JSON.parse(t);
    }
    // Totals over the window by post ("utm_source|utm_content"): page counts from /track, signups and the rest from the funnel.
    const track_by_utm: Record<string, Record<string, number>> = {};
    for (const d of Object.values(track) as Record<string, { utm?: Record<string, number> }>[])
      for (const [kind, x] of Object.entries(d)) for (const [k, n] of Object.entries(x.utm ?? {})) (track_by_utm[kind] ??= {})[k] = (track_by_utm[kind][k] ?? 0) + n;
    return json({ ok: true, funnel: await funnel(env, Date.now(), days), track, track_by_utm }, 200, h);
  }

  // Operator: one member's access log (for telling a member whether any session read their book), or an entry for a
  // read made outside the API (a script on gene minting a session).
  if ((req.method === 'GET' || req.method === 'POST') && path === '/ops/access-log') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    if (req.method === 'POST') {
      const b = await body(req);
      const c = typeof b.customer === 'string' && /^(cus_\w+|free_\w+|seat_\w+)$/.test(b.customer) ? b.customer : null;
      if (!c || typeof b.route !== 'string') return json({ ok: false, error: 'customer (row ID) and route' }, 400, h);
      await logAccess(env, req, b.route.slice(0, 120), [c], typeof b.note === 'string' ? b.note.slice(0, 300) : undefined, typeof b.who === 'string' ? b.who.slice(0, 120) : undefined, typeof b.at === 'string' && !Number.isNaN(Date.parse(b.at)) ? new Date(b.at).toISOString() : undefined);
      return json({ ok: true }, 200, h);
    }
    const c = url.searchParams.get('customer') ?? '';
    const entries = JSON.parse((await env.DB.get(`access:${c}`)) ?? '[]');
    // The read itself is logged after it, so it shows from the next read on.
    if (/^(cus_\w+|free_\w+|seat_\w+)$/.test(c)) await logAccess(env, req, 'GET /ops/access-log', [c], 'access log read');
    return json({ ok: true, customer: c, entries }, 200, h);
  }

  // Operator: member counts by status, plan and test flag (counts only; agent sessions are logged).
  if (req.method === 'GET' && path === '/ops/member-counts') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const counts: Record<string, number> = {};
    for (const m of await listMembers(env)) {
      const k = `${m.test || testAddress(m.email ?? '') ? 'test' : 'real'}:${m.status}:${m.plan}${m.status === 'free' && m.marketing_off ? ':marketing_off' : ''}`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return json({ ok: true, counts }, 200, h);
  }

  if (req.method === 'POST' && path === '/ops/weekly-preview') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const { previewWeekly } = await import('./free');
    const b = await body(req);
    await logAccess(env, req, 'POST /ops/weekly-preview', [await env.DB.get(`email:${String(b.email ?? '').trim().toLowerCase()}`)], 'owned names read for the preview');
    return json(await previewWeekly(env, String(b.email ?? '').trim().toLowerCase(), Date.now(), b.dry === true, b.postal === false ? false : typeof b.postal === 'string' ? b.postal.slice(0, 200) : undefined), 200, h);
  }

  // Operator: a net-30 Copy Fund order (yearly, founding price); the invoice carries the order terms and is emailed.
  if (req.method === 'POST' && path === '/ops/fund-invoice') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const b = await body(req);
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: 'email required', code: 'bad_request' }, 400, h);
    const { fundInvoice } = await import('./revenue');
    await logAccess(env, req, 'POST /ops/fund-invoice', [await env.DB.get(`email:${email}`)], 'Fund invoice drafted');
    return json({ ok: true, ...(await fundInvoice(env, email, b.name ? String(b.name).slice(0, 120) : undefined, b.po ? String(b.po).slice(0, 30) : undefined)) }, 200, h);
  }

  // Operator: "Your names this week" for the given test inboxes only (members' real addresses are dropped).
  if (req.method === 'POST' && path === '/ops/names-weekly-preview') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const b = await body(req);
    const to = (Array.isArray(b.to) ? b.to : []).map((x: unknown) => String(x).trim().toLowerCase()).filter(previewInbox);
    const { runWeeklyNames } = await import('./alerts');
    return json(to.length ? await runWeeklyNames(env, Date.now(), to) : { emails: 0, status: 'no test inbox given' }, 200, h);
  }

  // Operator: Email 2's preview, to our inbox and test inboxes only (other addresses are dropped).
  if (req.method === 'POST' && path === '/ops/email2-preview') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const b = await body(req);
    const to = (Array.isArray(b.to) ? b.to : []).map((x: unknown) => String(x).trim().toLowerCase());
    const { runEmail2 } = await import('./free');
    return json(await runEmail2(env, b.at ? Date.parse(String(b.at)) : Date.now(), to, b.dry === true), 200, h);
  }

  // Operator: clear Fund seats' copies of their team's destinations (one-off for duplicates saved before the 409).
  const dedupe = path.match(/^\/ops\/team-dedupe\/(cus_\w+)$/);
  if (req.method === 'POST' && dedupe) {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const owner = await getMember(env, dedupe[1]);
    await logAccess(env, req, 'POST /ops/team-dedupe/{customer}', [owner?.customer], 'team channels read');
    return owner ? json({ ok: true, cleared: await clearSeatDuplicates(env, owner) }, 200, h) : json({ ok: false, error: 'no such member' }, 404, h);
  }

  // Operator: send one real, already-parsed Form 4 or 13D/G (from /v1/events' store) through the alert
  // fan-out to the named members only: their email, chat, feed and webhook, with their team rules. It
  // is marked a replay (never counted in latency) and stays out of the day's digest store.
  // Operator: revokes one API key by member email and key name (test cleanup). Answers with counts only.
  if (req.method === 'POST' && path === '/ops/revoke-key') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const b = await body(req);
    const cus = await env.DB.get(`email:${String(b.email ?? '').trim().toLowerCase()}`);
    const keys = cus ? (await listKeys(env, cus)).filter((k) => k.name === b.name) : [];
    for (const k of keys) await revokeKey(env, cus!, k.id);
    await logAccess(env, req, 'POST /ops/revoke-key', [cus], 'API keys listed');
    return json({ ok: true, revoked: keys.length }, 200, h);
  }

  // Operator: 13Fs already alerted without moves (before moves_pending existed) go back on gene's moves queue.
  // With replay_to (test members only): a hand-off replay of an already-sent 13F, to those members alone, timed from
  // now (GET /ops/moves-replays) and never logged as live latency.
  if (req.method === 'POST' && path === '/ops/moves-requeue') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const b = await body(req);
    const want = new Set((b.accessions as string[] | undefined) ?? []);
    const replayTo = Array.isArray(b.replay_to) ? (b.replay_to as string[]) : null;
    if (replayTo) {
      for (const c of replayTo) {
        const m = await getMember(env, c);
        if (!m || !(m.test || testAddress(m.email))) return json({ ok: false, error: `replay_to: test members only (${c})`, code: 'bad_request' }, 400, h);
      }
    }
    const replayAt = new Date().toISOString();
    const pending = JSON.parse((await env.DB.get('alerts:pending-moves')) ?? '[]') as Alert13F[];
    const have = new Set(replayTo ? [] : pending.map((p) => p.accession));
    for (let d = 0; d < 7 && want.size > have.size; d++) {
      const day = JSON.parse((await env.DB.get(`digest:${etDay(Date.now() - d * 86_400_000)}`)) ?? '{"filings":[]}') as { filings: Alert13F[] };
      for (const f of day.filings) {
        if (!want.has(f.accession) || have.has(f.accession) || f.followup || (f.moves && !replayTo)) continue;
        const { sent_at: _s, ...a } = f;
        pending.push({ ...a, moves: null, moves_pending: true, ...(replayTo ? { replay_to: replayTo, replay_at: replayAt } : {}) });
        have.add(f.accession);
      }
    }
    // A replay of a curated 13F no longer in the alert store (older than its 7 days, or never alerted): from the data run's index.
    if (replayTo && want.size > have.size) {
      const idx = (await (await fetch(`${env.DATA_URL}index.json`)).json().catch(() => ({}))) as { managers?: { slug: string; cik: string; manager: string; name: string; featured?: boolean; quarter?: string; report_date?: string; filing_date?: string; accession?: string; accepted_at?: string; sec_url?: string }[] };
      for (const r of idx.managers ?? []) {
        if (!r.accession || !want.has(r.accession) || have.has(r.accession) || !r.quarter || !r.report_date) continue;
        const cik = String(Number(r.cik));
        pending.push({ slug: r.slug, slugs: [r.slug], manager: r.manager, name: r.name, quarter: r.quarter, report_date: r.report_date, filing_date: r.filing_date ?? '', accession: r.accession, sec_url: r.sec_url ?? `https://www.sec.gov/Archives/edgar/data/${cik}/${r.accession.replace(/-/g, '')}/${r.accession}-index.html`, accepted: r.accepted_at, moves: null, tickers: [], moves_pending: true, replay_to: replayTo, replay_at: replayAt });
        have.add(r.accession);
      }
    }
    await env.DB.put('alerts:pending-moves', JSON.stringify(pending));
    return json({ ok: true, queued: [...want].filter((a) => have.has(a)), not_found: [...want].filter((a) => !have.has(a)), ...(replayTo ? { replay_at: replayAt } : {}) }, 200, h);
  }
  // Operator audit: an alert's stored copy and who it reached (row IDs only); each member listed gets an access entry.
  // Operator: reconcile one sent 13F alert against ingest's build now; `to` (test inboxes only) gets its correction.
  if (req.method === 'POST' && path === '/ops/reconcile') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const b = (await req.json().catch(() => ({}))) as { accession?: string; to?: string[] };
    if (!/^\d{10}-\d{2}-\d{6}$/.test(b.accession ?? '')) return json({ ok: false, error: 'accession: 0000000000-00-000000', code: 'bad_request' }, 400, h);
    const { previewInbox } = await import('./email');
    if (b.to && (!Array.isArray(b.to) || !b.to.length || !b.to.every((t) => typeof t === 'string' && previewInbox(t)))) return json({ ok: false, error: 'to: test inboxes only', code: 'bad_request' }, 400, h);
    const r = await (await import('./alerts')).reconcileAlerts(env, Date.now(), { accession: b.accession!, to: b.to });
    await logAccess(env, req, 'POST /ops/reconcile', [], `reconcile ${b.accession}${b.to ? ` to ${b.to.length} test inbox(es)` : ''}`);
    return json({ ok: true, ...r }, 200, h);
  }

  // Operator, once: `host` on latency rows logged before it was recorded, from each send's claim (claims/{accession},
  // claims/moves/{accession} for a 13F timed by its moves follow-up, claims/ev/{accession} for an event). gene claims
  // every send; Cloudflare only while gene polls, so a row without a claim stays null.
  if (req.method === 'POST' && path === '/ops/latency-host-backfill') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const { claimHost } = await import('./failover');
    const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as LatencyRow[];
    const counts: Record<string, number> = {};
    for (const l of log) {
      if (l.host === undefined) {
        const id = (l.kind ?? '13f') !== '13f' ? `ev/${l.accession}` : l.followup ? `moves/${l.accession}` : l.accession;
        l.host = await claimHost(env, id);
      }
      counts[String(l.host)] = (counts[String(l.host)] ?? 0) + 1;
    }
    // Re-read so rows logged meanwhile are kept; this pass only adds the field.
    const now2 = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as LatencyRow[];
    const byKey = new Map(log.map((l) => [`${l.accession}|${l.sent}`, l.host]));
    await env.DB.put('alerts:latency', JSON.stringify(now2.map((l) => (l.host === undefined && byKey.has(`${l.accession}|${l.sent}`) ? { ...l, host: byKey.get(`${l.accession}|${l.sent}`) } : l))));
    return json({ ok: true, rows: log.length, by_host: counts }, 200, h);
  }

  // Operator: each test address's sink URL (launch week: test mail is stored there, not sent), for briefing testers.
  if (req.method === 'POST' && path === '/ops/test-inbox') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const b = await body(req);
    const { sinkKey, SINK_UNTIL } = await import('./email');
    // Test addresses, and seats of a test team (whatever their address).
    const testSeat = async (e: string) => {
      const m = await memberByEmail(env, e);
      return !!m?.seat_of && testAddress((await getMember(env, m.seat_of))?.email ?? '');
    };
    const raw = (Array.isArray(b.emails) ? b.emails : []).filter((e): e is string => typeof e === 'string').map((e) => e.trim().toLowerCase()).slice(0, 50);
    const list = (await Promise.all(raw.map(async (e) => (testAddress(e) || (await testSeat(e)) ? e : null)))).filter((e): e is string => !!e);
    // Each inbox: its URL in the public bucket, and what KV kept when a bucket write failed.
    const inboxes = await Promise.all(list.map(async (e) => {
      const key = await sinkKey(env, e);
      const kept = JSON.parse((await env.DB.get(key)) ?? 'null') as { items?: unknown[] } | null;
      return { email: e, url: `${env.PUBLIC_URL ?? ''}${key}`, ...(env.CF_API_TOKEN && kept?.items?.length ? { kept_in_kv: kept.items } : {}) };
    }));
    return json({ ok: true, until: new Date(SINK_UNTIL).toISOString(), inboxes }, 200, h);
  }

  // Operator: bulk files listed against what their download links serve, re-mirroring any that differ.
  if (req.method === 'POST' && path === '/ops/bulk-check') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    return json(await (await import('./download')).checkBulk(env, 1_000_000, Date.now()), 200, h);
  }

  // Operator: reconciliation as a dry run over the season, as sent and (recompute) as the current code would send it.
  if (req.method === 'POST' && path === '/ops/reconcile-dry') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const b = (await req.json().catch(() => ({}))) as { offset?: number; limit?: number; recompute?: boolean; days?: number };
    return json({ ok: true, ...(await (await import('./alerts')).reconcileDry(env, Date.now(), b)) }, 200, h);
  }

  if (req.method === 'GET' && path === '/ops/delivery') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const id = (url.searchParams.get('id') ?? '').trim();
    if (!/^[\w:.-]{3,80}$/.test(id)) return json({ ok: false, error: 'id: an accession or event id', code: 'bad_request' }, 400, h);
    const r = await (await import('./alerts')).deliveryRecord(env, id, Date.now());
    await logAccess(env, req, 'GET /ops/delivery', r.recipients.map((x) => x.customer).filter((c) => c.startsWith('cus_') || c.startsWith('seat_')), `delivery record of ${id}`);
    return json({ ok: true, ...r }, 200, h);
  }

  if (req.method === 'GET' && path === '/ops/moves-replays') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    return json({ ok: true, replays: JSON.parse((await env.DB.get('alerts:moves-replays')) ?? '[]') }, 200, h);
  }

  if (req.method === 'POST' && path === '/ops/deliver') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const b = (await body(req)) as { accession?: string; customers?: string[] };
    if (!b.accession || !Array.isArray(b.customers) || !b.customers.length) return json({ ok: false, error: 'accession and customers[]' }, 400, h);
    const pre = await env.HIST.get('pre/events.json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all: any[] = [...(JSON.parse((await env.DB.get('v1:events')) ?? '[]') as unknown[]), ...(pre ? (((await new Response(pre.body).json()) as { events: unknown[] }).events ?? []) : [])];
    const ev = all.find((e) => e.id === b.accession) as AlertEvent | undefined;
    if (!ev) return json({ ok: false, error: 'no such event in the store' }, 404, h);
    await logAccess(env, req, 'POST /ops/deliver', b.customers, `follows read to deliver ${ev.id}`);
    const replays = JSON.parse((await env.DB.get('alerts:replays')) ?? '[]') as string[];
    if (!replays.includes(ev.id)) await env.DB.put('alerts:replays', JSON.stringify([...replays, ev.id].slice(-200)));
    const at = new Date().toISOString();
    return json({ ok: true, sent_at: at, result: await deliverTo(env, ev, new Set(b.customers), Date.now()) }, 200, h);
  }

  // Fund-plan, support and data-deletion requests from the contact and pricing pages. No sign-in;
  // a filled `website` field (hidden from people) marks a bot and is dropped without saying so.
  if (req.method === 'POST' && path === '/fund-request') {
    const b = await body(req);
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const topic = b.topic === undefined ? 'fund' : b.topic;
    const email = String(b.email ?? '').trim().toLowerCase();
    const seats = b.seats === undefined || b.seats === null || b.seats === '' ? null : Number(b.seats);
    if (!['fund', 'support', 'delete'].includes(String(topic))) return json({ ok: false, error: 'topic must be fund, support or delete', code: 'bad_request' }, 400, h);
    if (!EMAIL.test(email)) return json({ ok: false, error: 'invalid email', code: 'bad_request' }, 400, h);
    if (seats !== null && !(Number.isInteger(seats) && seats >= 1 && seats <= 1000)) return json({ ok: false, error: 'seats must be a whole number from 1 to 1000', code: 'bad_request' }, 400, h);
    if (b.invoice !== undefined && typeof b.invoice !== 'boolean') return json({ ok: false, error: 'invoice must be true or false', code: 'bad_request' }, 400, h);
    // A Fund trial billed by invoice (no card): company, billing address and a work email; PO and AP email optional.
    const trial = topic === 'fund' && b.invoice_trial === true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addr = (b.billing_address && typeof b.billing_address === 'object' ? b.billing_address : {}) as Record<string, any>;
    if (trial) {
      const missing = [!str(b.fund ?? b.company, 200) && 'fund', ...['line1', 'city', 'postal_code', 'country'].filter((k) => !str(addr[k], 200)).map((k) => `billing_address.${k}`)].filter(Boolean) as string[];
      if (str(addr.country, 10) && !/^[A-Za-z]{2}$/.test(String(addr.country).trim())) missing.push('billing_address.country (2 letters, e.g. US)');
      if (b.ap_email !== undefined && b.ap_email !== null && b.ap_email !== '' && !EMAIL.test(String(b.ap_email).trim().toLowerCase())) missing.push('ap_email');
      if (missing.length) return json({ ok: false, error: `missing or invalid: ${missing.join(', ')}`, code: 'bad_request', fields: missing }, 400, h);
      const { domainOf, isFreemail } = await import('./revenue');
      if (isFreemail(domainOf(email))) return json({ ok: false, error: 'Use your work email: an invoice trial goes to a company address.', code: 'freemail' }, 400, h);
    }
    if (str(b.website, 200)) return json({ ok: true }, 200, h);
    // At most 5 requests an hour per IP and 3 per email address.
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    for (const [k, max] of [[`rl:lead-ip:${ip}`, 5], [`rl:lead:${email}`, 3]] as const) {
      const n = Number((await env.DB.get(k)) ?? 0);
      if (n >= max) return json({ ok: false, error: 'too many requests, try again in an hour', code: 'rate_limited' }, 429, { ...h, 'retry-after': '3600' });
      await env.DB.put(k, String(n + 1), { expirationTtl: 3600 });
    }
    const at = new Date().toISOString();
    const lead = {
      topic,
      name: str(b.name, 200),
      email,
      fund: str(b.fund, 200),
      seats,
      invoice: typeof b.invoice === 'boolean' ? b.invoice : null,
      plan_interval: b.plan_interval === 'yearly' || b.plan_interval === 'monthly' ? b.plan_interval : null,
      message: str(b.message ?? b.note, 4000),
      page: str(b.page, 200),
      received_at: at,
    };
    // Test submissions (reviewers, our own checks) are kept but never counted as leads.
    const test = /\btest\b/i.test([lead.name, lead.fund, lead.message].join(' ')) || email.startsWith('copybook-test-');
    const id = `${at}-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.put(`lead:${id}`, JSON.stringify({ ...lead, ...(test ? { test: true } : {}) }));
    if (!test) await env.DB.put('leads:count', String(Number((await env.DB.get('leads:count')) ?? 0) + 1));
    if (trial) {
      const { fundInvoiceTrial } = await import('./revenue');
      const r = await fundInvoiceTrial(env, {
        email,
        company: str(b.fund ?? b.company, 200)!,
        address: { line1: str(addr.line1, 200)!, line2: str(addr.line2, 200), city: str(addr.city, 200)!, state: str(addr.state, 100), postal_code: str(addr.postal_code, 40)!, country: String(addr.country).trim().toUpperCase() },
        po: str(b.po, 140),
        ap_email: str(b.ap_email, 200)?.toLowerCase() ?? null,
      }).catch((e) => (console.log(`invoice trial: ${String(e).slice(0, 200)}`), null));
      await env.DB.put(`lead:${id}`, JSON.stringify({ ...lead, invoice_trial: r?.state ?? 'error', ...(test ? { test: true } : {}) }));
      if (!test && env.CONTACT_EMAIL) await sendMail(env, [leadNoticeMail(env, { ...lead, message: `${lead.message ?? ''}\n[invoice trial: ${r?.state ?? 'error'}]`.trim() }, id)]);
      if (!r) return json({ ok: false, error: "We couldn't start the trial just now. We've got your request and will email you today.", code: 'server_error', id }, 502, h);
      if (r.state === 'started') return json({ ok: true, id, trial: 'started', trial_end: r.trial_end, invoice_on: r.invoice_on, due_on: r.due_on, sign_in_email: r.sign_in_email }, 200, h);
      if (r.state === 'already_member') return json({ ok: false, id, code: 'already_member', error: 'This address already has a Copybook subscription. Sign in, or switch to invoice billing in your account.' }, 409, h);
      if (r.state === 'domain_used') return json({ ok: false, id, code: 'trial_used', error: 'Your company has already had a Copy Fund trial. We have your request and will email you to set up an invoice.' }, 409, h);
      return json({ ok: false, id, code: 'freemail', error: 'Use your work email: an invoice trial goes to a company address.' }, 400, h);
    }
    const mail = await sendMail(env, [leadAckMail(env, lead)]);
    if (!test && env.CONTACT_EMAIL) await sendMail(env, [leadNoticeMail(env, lead, id)]);
    return json({ ok: true, id, acknowledgement: mail === '200' ? 'sent' : 'not sent' }, 200, h);
  }

  // A member's private alert feed: the token in the path is the only credential, and revocable.
  const feed = path.match(/^\/feed\/([\w-]+)\.(json|rss)$/);
  if (req.method === 'GET' && feed) return serveFeed(env, feed[1], feed[2] as 'json' | 'rss', `${stableBase(env, url)}${url.pathname}`);

  // The data workflow reads which non-curated filers members follow (CIKs only), to back-fill a prior quarter.
  if (req.method === 'GET' && path === '/ingest/followed.json') {
    const why = await verifyGithubOidc(req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '', env.INGEST_WORKFLOW);
    if (why) return json({ ok: false, error: why }, 401, {});
    const obj = await env.HIST.get('followed/ciks.json');
    return obj ? new Response(obj.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) : json({ updated_at: null, ciks: [] }, 200, {});
  }

  // Many uploads in one request: PUT /ingest/bundle (a tar, each entry named by its R2 key; gzipped when sent with
  // content-encoding: gzip, which cuts the bytes through gene's slow Funnel relay about 4x) or
  // POST /ingest-batch (a JSON manifest line, then the objects' bytes back to back). Each request counts against
  // the Workers plan's quota, so a full rebuild is ~50 of these, not ~25,000 single PUTs. Keys that fail the
  // allowlist are refused and listed; the rest are written.
  if ((req.method === 'PUT' && path === '/ingest/bundle') || (req.method === 'POST' && path === '/ingest-batch')) {
    let buf = new Uint8Array(await req.arrayBuffer());
    // A runtime that already decoded the body leaves no gzip magic, so check the bytes, not only the header.
    if (/gzip/i.test(req.headers.get('content-encoding') ?? '') && buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      } catch {
        return json({ ok: false, error: 'bad gzip body' }, 400, {});
      }
    }
    if (buf.length > BATCH_MAX_BYTES) return json({ ok: false, error: `bundle over ${BATCH_MAX_BYTES} bytes; split it` }, 413, {});
    const parsed = path === '/ingest/bundle' ? untar(buf) : unmanifest(buf);
    if (typeof parsed === 'string') return json({ ok: false, error: parsed }, 400, {});
    if (!parsed.length || parsed.length > BATCH_MAX_OBJECTS) return json({ ok: false, error: `1 to ${BATCH_MAX_OBJECTS} objects per bundle` }, 400, {});
    const kinds = parsed.map((o) => ingestKind(o.key));
    const good = parsed.filter((_, i) => kinds[i]);
    const refused = parsed.filter((_, i) => !kinds[i]).map((o) => o.key);
    const why = await ingestAuth(env, req, new Set(kinds.filter((k): k is IngestKind => !!k)));
    if (why) return json({ ok: false, error: why }, 401, {});
    const head = buildMeta(req, null);
    const { sha256Hex, mirrorSoon } = await import('./download');
    // A few at a time: R2 writes are I/O, not CPU.
    for (let i = 0; i < good.length; i += 25) {
      await Promise.all(good.slice(i, i + 25).map(async (o) => {
        // Bulk exports carry their sha256, so the listing and the bucket's mirrored copy can be checked against it.
        const meta = { ...buildMeta(null, o.meta ?? null), ...head, ...(o.key.startsWith('bulk/') ? { sha256: await sha256Hex(o.bytes) } : {}) };
        return env.HIST.put(o.key, o.bytes, { httpMetadata: { contentType: contentTypeOf(o.key) }, ...(Object.keys(meta).length ? { customMetadata: meta } : {}) });
      }));
    }
    // The download links sign the account's bucket: on gene that's another store, so each new export is copied there.
    for (const o of good) if (o.key.startsWith('bulk/')) mirrorSoon(env, o.key);
    return json({ ok: true, written: good.length, refused, ...(refused.length ? { error: INGEST_KEYS_ERROR } : {}) }, 200, {});
  }

  // The data workflow uploads per-quarter history here, authenticated by its GitHub OIDC token.
  if (req.method === 'PUT' && path.startsWith('/ingest/')) {
    const key = path.slice('/ingest/'.length);
    const kind = ingestKind(key);
    if (!kind) return json({ ok: false, error: INGEST_KEYS_ERROR }, 400, {});
    // Single uploads past the per-minute cap (per location) are refused: many objects go in one POST /ingest-batch.
    if (await overIngestRate()) return json({ ok: false, error: `over ${INGEST_PER_MINUTE} single uploads a minute; send many objects in one POST /ingest-batch`, code: 'rate_limited' }, 429, { 'retry-after': '60' });
    const why = await ingestAuth(env, req, new Set([kind]));
    if (why) return json({ ok: false, error: why }, 401, {});
    const meta = buildMeta(req, null);
    if (key.startsWith('bulk/')) {
      const { sha256Hex, mirrorSoon } = await import('./download');
      const bytes = new Uint8Array(await req.arrayBuffer());
      await env.HIST.put(key, bytes, { httpMetadata: { contentType: contentTypeOf(key) }, customMetadata: { ...meta, sha256: await sha256Hex(bytes) } });
      mirrorSoon(env, key);
      return json({ ok: true, key }, 200, {});
    }
    await env.HIST.put(key, req.body, { httpMetadata: { contentType: contentTypeOf(key) }, ...(Object.keys(meta).length ? { customMetadata: meta } : {}) });
    return json({ ok: true, key }, 200, {});
  }

  // Email a sign-in link to an active member. Always answers ok so it can't be used to probe emails.
  if (req.method === 'POST' && path === '/login') {
    const b = await body(req);
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) return json({ ok: false, error: 'invalid email' }, 400, h);
    const m = await memberByEmail(env, email);
    if (m && (m.status === 'free' || isActive(m)) && !(await env.DB.get(`rl:${email}`))) {
      await env.DB.put(`rl:${email}`, '1', { expirationTtl: 60 });
      const token = await signToken(env.SESSION_SECRET, 'login', m.customer, LOGIN_REQUEST_TTL);
      // A Holdterm member only ever hears from Holdterm; a sign-in started on Holdterm gets a Holdterm link.
      const holdterm = m.plan === 'holdterm' || b.brand === 'holdterm' || /holdterm/.test(origin ?? '');
      const mail = holdterm ? holdtermLoginMail(env, m.email, token, false) : loginMail(env, m.email, token, false);
      // A seat on a test team: its sign-in link goes to the sink too.
      const testTeam = m.seat_of ? testAddress((await getMember(env, m.seat_of))?.email ?? '') : false;
      await sendMail(env, [{ ...mail, ...(testTeam ? { test: true } : {}) }]);
    }
    return json({ ok: true }, 200, h);
  }

  // Exchange a sign-in link token, or a just-completed Checkout Session id, for a session token.
  if (req.method === 'POST' && path === '/session') {
    const b = await body(req);
    if (typeof b.login === 'string') {
      const p = await verifyToken(env.SESSION_SECRET, b.login, 'login');
      const m = p && (await getMember(env, p.c));
      if (!p || !m) return json({ ok: false, error: 'link expired or invalid' }, 401, h);
      // A link from before the member's sessions were ended (a removed or signed-out seat's old invite) is dead too.
      if (m.sessions_after && !((p.i ?? 0) > m.sessions_after)) return json({ ok: false, error: 'This sign-in link is no longer valid. Ask for a new one.', code: 'link_revoked' }, 401, h);
      // The address is proven: provisional sessions from the signup form stop working.
      if (!m.verified) await putMember(env, { ...m, verified: true });
      // Once: the link's nonce is marked used until the link would have expired anyway.
      if (p.n) {
        if (await env.DB.get(`used:${p.n}`)) return json({ ok: false, error: 'This sign-in link was already used. Ask for a new one.', code: 'link_used' }, 401, h);
        await env.DB.put(`used:${p.n}`, '1', { expirationTtl: Math.max(60, Math.ceil(p.x - Date.now() / 1000)) });
      }
      await logEvent(env, m.customer, { kind: 'sign_in', by: 'self', detail: 'email link' }, req);
      return json(await issueSession(env, m), 200, h);
    }
    if (typeof b.checkout_session === 'string' && /^cs_(test|live)_[A-Za-z0-9]+$/.test(b.checkout_session)) {
      let cs;
      try {
        cs = await stripe(env, 'GET', `checkout/sessions/${b.checkout_session}`);
      } catch {
        return json({ ok: false, error: 'unknown checkout session' }, 404, h);
      }
      const fresh = Date.now() / 1000 - Number(cs.created) < 24 * 3600;
      if (cs.status !== 'complete' || !cs.subscription || !fresh) return json({ ok: false, error: 'checkout not complete' }, 409, h);
      // An address that already had an account before this checkout gets no session from it: anyone can type an
      // address at checkout. They sign in with the emailed link (or keep the session they have on this device).
      const email = String(cs.customer_details?.email ?? '').trim().toLowerCase();
      // An account made before the checkout started: a free signup's record (it keeps its own created_at after it converts;
      // the paid record's is the conversion time), or another customer's account under this address.
      const startedAt = Number(cs.created) * 1000;
      const prior = email ? await memberByEmail(env, email) : null;
      const freeRec = email ? (JSON.parse((await env.DB.get(`cus:${await (await import('./free')).freeId(email)}`)) ?? 'null') as Member | null) : null;
      const before = (r: Member | null) => !!r && (!r.created_at || Date.parse(r.created_at) < startedAt);
      const existed = before(freeRec) || (!!prior && prior.customer !== cs.customer && before(prior));
      const sub = await stripe(env, 'GET', `subscriptions/${cs.subscription}`);
      const m = await syncSubscription(env, sub, cs.customer_details?.email);
      if (existed) return json({ ok: true, code: 'existing_account', sign_in: 'email', member: null }, 200, h);
      // A new subscriber: signed in on this device, provisionally (the address isn't proven yet), like the signup form.
      const { PROVISIONAL_TTL } = await import('./members');
      await logEvent(env, m.customer, { kind: 'sign_in', by: 'self', detail: 'checkout' }, req);
      return json({ ok: true, token: await signToken(env.SESSION_SECRET, 'session', m.customer, PROVISIONAL_TTL, { s: 'provisional' }), session: 'provisional', member: publicView(m) }, 200, h);
    }
    return json({ ok: false, error: 'login or checkout_session required' }, 400, h);
  }

  // A plain download link: /csv/{slug}.csv?dl=<token from POST /csv-link/{slug}>, valid once, for 60 s, for that one file.
  const dl = url.searchParams.get('dl');
  const dlSlug = path.match(/^\/csv\/([a-z0-9-]+)\.csv$/)?.[1];
  if (req.method === 'GET' && dl && dlSlug) {
    const p = await verifyToken(env.SESSION_SECRET, dl, 'download');
    const unused = p?.n && p.s === dlSlug && (await env.DB.get(`dl:${p.n}`));
    if (!p || !unused) return json({ ok: false, error: 'download link expired or already used' }, 401, h);
    await env.DB.delete(`dl:${p.n}`);
    const owner = await getMember(env, p.c);
    if (!isCopy(owner)) return json({ ok: false, error: 'Copy subscription required' }, 402, h);
    const res = await csvResponse(env, dlSlug, h);
    // On the Funnel name a CSV over 1 MB goes to presigned R2 (served here if R2 can't take it).
    const fwd = await import('./download');
    if (!res.ok || !fwd.viaFunnel(env, req, url)) return res;
    const body = await res.text();
    return (body.length > fwd.LARGE_BYTES && (await fwd.toR2(env, body, res))) || new Response(body, res);
  }

  let m = await authed(req, env);
  // A paid record not synced from Stripe in the last hour is re-read first (at most 2 s), so a missed webhook
  // can't show a stale plan ("Cancelled" after the member renewed in the portal).
  if (m && req.method === 'GET' && path === '/me' && m.subscription?.startsWith('sub_') && !m.seat_of && (!m.synced_at || Date.now() - Date.parse(m.synced_at) > 3600_000)) {
    const { reconcileMembers } = await import('./members');
    const cur = m;
    await Promise.race([reconcileMembers(env, [cur], 2000).catch(() => null), new Promise((r) => setTimeout(r, 2000))]);
    m = (await getMember(env, cur.customer)) ?? cur;
  }
  if (!m) {
    // invalid_session: forged, expired or revoked; the site signs out only on this. A valid session whose member this host
    // can't read (sync lag after a failover, a KV hiccup) is member_unavailable, and no token at all is no_session.
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const p = token ? await verifyToken(env.SESSION_SECRET, token, 'session') : null;
    const code = !token ? 'no_session' : !p ? 'invalid_session' : (await getMember(env, p.c)) ? 'invalid_session' : 'member_unavailable';
    return json({ ok: false, error: 'sign in required', code }, 401, h);
  }

  // A provisional session reads /me and changes follows, nothing else: API keys, channels, the billing portal, seats,
  // a cross-origin handoff and "sign out everywhere" (which mints a full session) wait for the emailed link. Starting
  // the trial needs no session (POST /checkout).
  if (PROVISIONAL.has(m) && !((req.method === 'GET' && path === '/me') || path === '/follows' || path.startsWith('/follows/'))) {
    return json({ ok: false, error: 'Open the sign-in link we emailed you to do this.', code: 'verify_email' }, 403, h);
  }

  // Any member: sign out everywhere. Every session issued before this second stops working at once (a copied token
  // included); the browser that asked gets a fresh session. API keys are separate and stay until deleted.
  if (req.method === 'POST' && path === '/me/sessions/revoke') {
    const now = Math.floor(Date.now() / 1000);
    // authed() refuses sessions issued at or before sessions_after: every token from this second too (a copy made in
    // the same second as the sign-out). The fresh one is dated a second later, so it alone gets through.
    const next = { ...m, sessions_after: now };
    await putMember(env, next);
    return json({ ok: true, revoked_at: new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), token: await signToken(env.SESSION_SECRET, 'session', next.customer, SESSION_TTL, {}, now + 1), member: publicView(next) }, 200, h);
  }

  // Short-lived sign-in token for carrying a session across origins in a URL (e.g. the old-host redirect).
  if (req.method === 'POST' && path === '/handoff') {
    return json({ ok: true, login: await signToken(env.SESSION_SECRET, 'login', m.customer, HANDOFF_TTL) }, 200, h);
  }

  // channels_failing: chat or webhook destinations that stopped (reason, since), so /account/ can flag them.
  if (req.method === 'GET' && path === '/me') {
    const { referralView } = await import('./referrals');
    // Free members' saved names from the KV mirror every change writes: no Durable Object read on a page view.
    const isFree = m.status === 'free';
    const names = isFree ? (await getFollows(env, m)).owned : [];
    // facts / hook / more: the Friday email's "In your names" block as it stands now.
    // The teaser reads EDGAR and the data run's files: at most 1.5 s, else /me answers without it this time.
    const none = { facts: [], hook: null, more: 0 };
    const teaser = isFree ? (await import('./free')).freeTeaser(env, names, Date.now()).catch(() => none) : null;
    const free = isFree ? { free_names: { names, limit: 5, ...(await Promise.race([teaser!, new Promise<typeof none>((r) => setTimeout(() => r(none), 1500))])) } } : {};
    // A Fund seat sees who to ask about billing: the plan owner's email.
    const owner = m.seat_of ? { owner: (await getMember(env, m.seat_of))?.email ?? null } : {};
    const { pauseOffer } = await import('./revenue');
    // True once Saturday's "Your names this week" first went to a real member.
    const DIGEST_LIVE = (await env.DB.get('names-weekly:live')) !== null;
    return json({ ok: true, member: { ...publicView(m), ...owner, pause_offer: pauseOffer(m), digest_live: DIGEST_LIVE, channels_failing: failView(await getFailures(env, m.customer)), referral: await referralView(env, m), ...free } }, 200, { ...h, 'cache-control': 'no-store' });
  }

  // Seasonal pause instead of cancelling: POST /pause {reason?} pauses billing and alerts until 14 days before the
  // next 13F deadline; DELETE /pause ends it now. POST /cancel-reason {reason, note?} stores the one cancellation question.
  if (path === '/pause' && (req.method === 'POST' || req.method === 'DELETE')) {
    if (m.seat_of) return json({ ok: false, error: "Billing is managed by your team's Copy Fund owner", code: 'seat' }, 403, h);
    const { pauseMember, unpauseMember } = await import('./revenue');
    const b = req.method === 'POST' ? await body(req) : {};
    const r = req.method === 'POST' ? await pauseMember(env, m, typeof b.reason === 'string' ? b.reason : null, Date.now(), typeof b.note === 'string' && b.note.trim() ? b.note.trim() : undefined) : await unpauseMember(env, m);
    return json(r.body, r.status, h);
  }
  if (req.method === 'POST' && path === '/cancel-reason') {
    const { noteReason, WHY } = await import('./revenue');
    const b = await body(req);
    const ok = await noteReason(env, m.customer, String(b.reason ?? ''), 'account', typeof b.note === 'string' ? b.note.trim() : undefined);
    return ok ? json({ ok: true }, 200, h) : json({ ok: false, error: `reason: ${Object.keys(WHY).join(', ')}`, code: 'bad_request' }, 400, h);
  }

  // A Fund owner on a card trial (yearly) switches to paying by invoice, Net 30.
  if (req.method === 'POST' && path === '/account/invoice') {
    const { switchToInvoice } = await import('./revenue');
    const b = await body(req);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 140) : null);
    const r = await switchToInvoice(env, m, { company: str(b.company), po: str(b.po), ap_email: str(b.ap_email) });
    return r.ok ? json({ ok: true, collection: r.collection, member: publicView((await getMember(env, m.customer)) ?? m) }, 200, h) : json(r, r.code === 'subscription_inactive' ? 402 : 403, h);
  }

  if (req.method === 'POST' && path === '/portal') {
    if (m.seat_of) return json({ ok: false, error: "Billing is managed by your team's Copy Fund owner", code: 'seat' }, 403, h);
    const ht = m.plan === 'holdterm';
    const s = await stripe(env, 'POST', 'billing_portal/sessions', {
      customer: m.customer,
      return_url: `${ht ? env.HOLDTERM_SITE_URL : env.SITE_URL}account/`,
      configuration: (ht ? env.HOLDTERM_PORTAL_CONFIGURATION : env.PORTAL_CONFIGURATION) || undefined,
    });
    return json({ ok: true, url: s.url }, 200, h);
  }

  // Free accounts: up to 5 owned names (for the Friday email's "In your names"), nothing else. No alerts.
  if (m.status === 'free') {
    const { FREE_NAMES } = await import('./free');
    if (req.method === 'GET' && path === '/follows') {
      const r = await changeFollows(env, m, { get: true });
      return json({ ok: true, follows: r.ok ? r.follows : await getFollows(env, m), limit: FREE_NAMES }, 200, h);
    }
    // Investors (up to 10) and stocks: follow and unfollow from /account/ or a page, signed in. /follows/{slug} is an
    // investor, as for paying members (the site's Follow buttons use it).
    const fl = path.match(/^\/follows\/(?:(investors|stocks)\/)?([^/]+)$/);
    if (fl && (req.method === 'POST' || req.method === 'DELETE')) {
      const { FREE_INVESTORS } = await import('./free');
      const list = (fl[1] ?? 'investors') as 'investors' | 'stocks';
      const value = list === 'investors' ? decodeURIComponent(fl[2]) : decodeURIComponent(fl[2]).toUpperCase().replace('-', '.');
      if (!(list === 'investors' ? SLUG : TICKER).test(value)) return json({ ok: false, error: list === 'investors' ? 'not a filer slug' : 'not a ticker like BRK.B', code: 'bad_request' }, 400, h);
      const had = (await getFollows(env, m))[list].includes(value);
      const r = await changeFollows(env, m, req.method === 'POST' ? { add: { list, value, max: FREE_INVESTORS } } : { remove: { list, value } });
      // At the cap: 402 with code and follow cap_reached (site bundles, cached ones included, show the cap message on it).
      if (!r.ok && r.error.startsWith('limit:')) return json({ ok: false, follow: 'cap_reached', error: `Free accounts follow up to ${FREE_INVESTORS} investors. Remove one, or start Copy for unlimited follows.`, code: 'cap_reached', limit: FREE_INVESTORS }, 402, h);
      const follow = req.method === 'POST' ? (had ? 'already' : 'added') : had ? 'removed' : 'not_following';
      return r.ok ? json({ ok: true, follow, follows: r.follows, limit: FREE_INVESTORS }, 200, h) : json({ ok: false, error: r.error }, 400, h);
    }
    const own = path.match(/^\/follows\/owned\/([^/]+)$/);
    if (own && (req.method === 'POST' || req.method === 'DELETE')) {
      const value = decodeURIComponent(own[1]).toUpperCase().replace('-', '.');
      if (!TICKER.test(value)) return json({ ok: false, error: 'not a ticker like BRK.B', code: 'bad_request' }, 400, h);
      const r = await changeFollows(env, m, req.method === 'POST' ? { add: { list: 'owned', value, max: FREE_NAMES } } : { remove: { list: 'owned', value } });
      if (!r.ok && r.error.startsWith('limit:')) return json({ ok: false, error: `Free accounts can save up to ${FREE_NAMES} names. Copy has no limit.`, code: 'free_limit', limit: FREE_NAMES }, 402, h);
      return r.ok ? json({ ok: true, follows: r.follows, limit: FREE_NAMES }, 200, h) : json({ ok: false, error: r.error }, 400, h);
    }
  }

  // A paused member keeps read-only access to their names and channels (writes and alerts wait for the resume).
  const pausedRead = isPaused(m) && ACTIVE.has(m.status) && req.method === 'GET' && (path === '/follows' || path === '/channels');
  if (!isActive(m) && !pausedRead) return json({ ok: false, error: 'Copy subscription required', member: publicView(m) }, 402, h);
  // Holdterm Alerts: alert settings only. History, CSV, keys and everything else are Copy features.
  if (m.plan === 'holdterm' && path !== '/alerts' && path !== '/follows' && !path.startsWith('/follows/')) {
    return json({ ok: false, error: 'Not part of Holdterm Alerts', code: 'holdterm_plan' }, 402, h);
  }

  // My book's per-stock column: company insiders' Form 4s and anyone's 13D/G, latest first, per ticker.
  if (req.method === 'GET' && path === '/events') {
    const tickers = [...new Set((url.searchParams.get('tickers') ?? '').toUpperCase().split(',').map((t) => t.trim().replace('-', '.')).filter(Boolean))];
    // window=quarter: every event since the window start (each ticker's `window`), up to 150.
    // open_market=1: only open-market Form 4 trades (P/S) and every 13D/G, so withholding and grants don't crowd them out.
    const quarter = url.searchParams.get('window') === 'quarter';
    const openOnly = url.searchParams.get('open_market') === '1';
    const max = quarter ? 150 : 10;
    const limit = Number(url.searchParams.get('limit') ?? (quarter ? max : 5));
    if (!tickers.length || tickers.length > 50 || !tickers.every((t) => TICKER.test(t)) || !(limit >= 1 && limit <= max) || !['quarter', null].includes(url.searchParams.get('window'))) {
      return json({ ok: false, error: `tickers: 1 to 50 comma-separated tickers like BRK.B; limit: 1 to 10 (150 with window=quarter); window: quarter`, code: 'bad_request' }, 400, h);
    }
    const { stockEvents } = await import('./stockevents');
    const { quarterStart } = await import('./seasons');
    const since = quarterStart(Date.now());
    const r = await stockEvents(env, tickers, Math.floor(limit), {
      deadlineMs: EDGAR_READ_MS,
      // Form 4s by when the trade happened (a Jun 29 sale filed Jul 1 is before a Jul 1 window); 13D/Gs by when
      // they were filed (their event date is the threshold crossing: FICO's Capital Research 13G, Jun 30, filed Aug 12).
      keep: (e) => (!quarter || (e.form.startsWith('4') ? (e.trade_date ?? e.filed_date ?? e.accepted_at) : (e.filed_date ?? e.accepted_at)) >= since.slice(0, 10)) && (!openOnly || !e.form.startsWith('4') || !!e.open_market),
    });
    for (const t of Object.values(r.tickers)) t.events = t.events.map(({ classes: _, ...e }) => e);
    return json({ ok: true, ...r }, 200, { ...h, 'cache-control': 'no-store' });
  }

  // Copy -> Pro/Fund (or Pro -> Fund): a portal page that confirms swapping the one subscription item to the
  // higher plan's price at the same interval, prorated. A new checkout would start a second subscription.
  if (req.method === 'POST' && path === '/upgrade') {
    if (m.seat_of) return json({ ok: false, error: "Billing is managed by your team's Copy Fund owner", code: 'seat' }, 403, h);
    const plan = String((await body(req)).plan ?? '');
    const rank: Record<string, number> = { copy: 1, pro: 2, fund: 3 };
    if (plan !== 'pro' && plan !== 'fund') return json({ ok: false, error: 'plan must be "pro" or "fund"', code: 'bad_request' }, 400, h);
    if (rank[m.plan] >= rank[plan]) return json({ ok: false, error: `Already on ${m.plan === 'fund' ? 'Copy Fund' : 'Copy Pro'}`, code: 'already_on_plan' }, 409, h);
    const sub = await stripe(env, 'GET', `subscriptions/${m.subscription}`);
    const item = sub.items?.data?.[0];
    const interval = item?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
    const price = (await stripe(env, 'GET', 'prices', { 'lookup_keys[]': `${plan}_${interval}`, active: true })).data?.[0];
    if (!item?.id || !price?.id) return json({ ok: false, error: 'upgrade unavailable for this subscription', code: 'upgrade_unavailable' }, 409, h);
    try {
      const s = await stripe(env, 'POST', 'billing_portal/sessions', {
        customer: m.customer,
        configuration: env.PORTAL_CONFIGURATION || undefined,
        return_url: `${env.SITE_URL}account/`,
        'flow_data[type]': 'subscription_update_confirm',
        'flow_data[subscription_update_confirm][subscription]': m.subscription,
        'flow_data[subscription_update_confirm][items][0][id]': item.id,
        'flow_data[subscription_update_confirm][items][0][price]': price.id,
        'flow_data[subscription_update_confirm][items][0][quantity]': 1,
        'flow_data[after_completion][type]': 'redirect',
        'flow_data[after_completion][redirect][return_url]': `${env.SITE_URL}account/?upgraded=${plan}`,
      });
      return json({ ok: true, url: s.url }, 200, h);
    } catch (e) {
      // e.g. a subscription already set to cancel: Stripe refuses the update flow.
      const msg = String((e as Error).message).match(/"message":"([^"]+)"/)?.[1] ?? 'Stripe refused the upgrade';
      return json({ ok: false, error: msg, code: 'upgrade_unavailable' }, 409, h);
    }
  }

  // Copy Fund seats: the owner invites teammates by email; each gets their own sign-in link.
  // The access log: every member's own (sign-ins, keys, changes, downloads, operator access), and a Fund owner's team.
  if (req.method === 'GET' && path === '/me/access') return json({ ok: true, ...(await meAccess(env, m)) }, 200, h);
  if (path === '/team/access' || path.startsWith('/team/keys/')) {
    if (!teamOwner(m)) return json({ ok: false, error: m.seat_of ? "Team access is the Copy Fund owner's" : 'Team access is part of Copy Fund', code: m.seat_of ? 'seat' : 'fund_required' }, 403, h);
    if (req.method === 'GET' && path === '/team/access') {
      const t = await teamAccess(env, m, url.searchParams.get('seat'));
      if (url.searchParams.get('format') === 'csv') return new Response(teamCsv(t.events), { headers: { ...h, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="copybook-team-access.csv"', 'cache-control': 'no-store' } });
      return json({ ok: true, ...t }, 200, h);
    }
    // The owner deletes any key on the team (a seat's or their own); the seat sees it on its own log.
    const tk = path.match(/^\/team\/keys\/(key_[a-z0-9]{16})$/);
    if (req.method === 'DELETE' && tk) {
      for (const s of [{ id: m.customer }, ...(await listSeats(env, m.customer))]) {
        const k = (await listKeys(env, s.id)).find((x) => x.id === tk[1]);
        if (!k || !(await revokeKey(env, s.id, k.id))) continue;
        await logEvent(env, s.id, { kind: 'key_deleted', by: s.id === m.customer ? 'self' : 'owner', key: { id: k.id, name: k.name } }, req);
        return json({ ok: true }, 200, h);
      }
      return json({ ok: false, error: 'no such key on this team' }, 404, h);
    }
    return json({ ok: false, error: 'not found' }, 404, h);
  }

  if (path === '/seats' || path.startsWith('/seats/')) {
    if (m.seat_of) return json({ ok: false, error: "Seats are managed by your team's Copy Fund owner", code: 'seat' }, 403, h);
    if (m.plan !== 'fund') return json({ ok: false, error: 'Seats are part of Copy Fund', code: 'fund_required' }, 403, h);
    if (req.method === 'GET' && path === '/seats') return json({ ok: true, ...seatsView(m, await listSeats(env, m.customer)) }, 200, h);
    if (req.method === 'POST' && path === '/seats') {
      const email = String((await body(req)).email ?? '').trim().toLowerCase();
      if (!EMAIL.test(email)) return json({ ok: false, error: 'invalid email', code: 'bad_request' }, 400, h);
      const r = await inviteSeat(env, m, email);
      if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status, h);
      await logEvent(env, r.seat.id, { kind: 'invite', by: 'owner' }, req);
      return json({ ok: true, ...seatsView(m, await listSeats(env, m.customer)) }, 201, h);
    }
    const revoke = path.match(/^\/seats\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && revoke) {
      const s = (await listSeats(env, m.customer)).find((x) => x.email === decodeURIComponent(revoke[1]).trim().toLowerCase());
      if (!(await revokeSeatSessions(env, m, decodeURIComponent(revoke[1])))) return json({ ok: false, error: 'no such seat' }, 404, h);
      await logEvent(env, s?.id, { kind: 'revoke', by: 'owner', detail: 'signed out everywhere; API keys deleted' }, req);
      return json({ ok: true, revoked_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...seatsView(m, await listSeats(env, m.customer)) }, 200, h);
    }
    const del = path.match(/^\/seats\/([^/]+)$/);
    if (req.method === 'DELETE' && del) {
      const s = (await listSeats(env, m.customer)).find((x) => x.email === decodeURIComponent(del[1]).trim().toLowerCase());
      if (!(await removeSeat(env, m, decodeURIComponent(del[1])))) return json({ ok: false, error: 'no such seat' }, 404, h);
      if (s) {
        await logEvent(env, s.id, { kind: 'removal', by: 'owner' }, req);
        await (await import('./accesslog')).noteSeatRemoved(env, m.customer, s);
      }
      return json({ ok: true, ...seatsView(m, await listSeats(env, m.customer)) }, 200, h);
    }
    return json({ ok: false, error: 'not found' }, 404, h);
  }

  // Where alerts go besides email: Discord, Slack, Telegram and a private feed (Copy); a signed webhook (Pro).
  if (path === '/channels' || path.startsWith('/channels/')) {
    if (req.method === 'GET' && path === '/channels') {
      // A seat also sees its team's channel (the Fund owner's), read-only.
      const owner = m.seat_of ? await getMember(env, m.seat_of) : null;
      const team = owner ? { owner, c: await getChannels(env, owner.customer), failing: await getFailures(env, owner.customer) } : undefined;
      return json({ ok: true, channels: channelsView(m, await getChannels(env, m.customer), stableBase(env, url), await getFailures(env, m.customer), team) }, 200, h);
    }
    if (req.method === 'PUT' && path === '/channels') {
      // A seat can't save its team's destination (409 already_team_channel); an owner's save clears seats' copies of it.
      const team = m.seat_of ? await getChannels(env, m.seat_of) : undefined;
      const b = await body(req);
      const r = await updateChannels(env, m, b, team);
      if (r.ok && channelScope(m) === 'team') await clearSeatDuplicates(env, m);
      if (r.ok) {
        const what = ['discord', 'slack', 'telegram', 'webhook', 'keep_email', 'email'].filter((k) => b[k] !== undefined);
        if (what.length) await logEvent(env, m.customer, { kind: what.includes('webhook') ? 'webhook_change' : 'channel_change', by: 'self', detail: what.join(', ') }, req);
      }
      return r.ok ? json({ ok: true, channels: channelsView(m, r.channels, stableBase(env, url), await getFailures(env, m.customer)) }, 200, h) : json({ ok: false, error: r.error, code: r.code }, r.code === 'pro_required' ? 403 : r.code === 'already_team_channel' ? 409 : 400, h);
    }
    if (req.method === 'POST' && path === '/channels/test') return json({ ok: true, ...(await testChannels(env, m, await getChannels(env, m.customer))) }, 200, h);
    if (path === '/channels/feed' && (req.method === 'POST' || req.method === 'DELETE')) {
      const c = await rotateFeed(env, m, req.method === 'DELETE');
      await logEvent(env, m.customer, { kind: 'channel_change', by: 'self', detail: req.method === 'DELETE' ? 'private feed removed' : 'private feed link made' }, req);
      // A new feed starts with the member's alerts from the last 30 days (at most 20), not empty.
      if (req.method === 'POST') await seedFeed(env, m.customer, await recentFeed(env, m, Date.now()));
      return json({ ok: true, channels: channelsView(m, c, stableBase(env, url), await getFailures(env, m.customer)) }, 200, h);
    }
    return json({ ok: false, error: 'not found' }, 404, h);
  }

  if (req.method === 'POST' && path === '/alerts') {
    const a = (await body(req)).alerts;
    const valid = a === 'all' || a === 'off' || (Array.isArray(a) && a.length <= 500 && a.every((s) => typeof s === 'string' && SLUG.test(s)));
    if (!valid) return json({ ok: false, error: 'alerts must be "all", "off", or a list of manager slugs' }, 400, h);
    if (Array.isArray(a)) {
      const unknown = await resolveFollowedFilers(env, a as string[]);
      if (unknown.length) return json({ ok: false, error: `not a 13F filer on Copybook: ${unknown.join(', ')}`, code: 'unknown_investor' }, 400, h);
    }
    const updated: Member = { ...m, alerts: a as Member['alerts'], alerts_chosen: true, alerts_note: undefined };
    await putMember(env, updated);
    if (Array.isArray(a)) await changeFollows(env, updated, { set: { investors: [...new Set(a as string[])] } });
    return json({ ok: true, member: publicView(updated) }, 200, h);
  }

  // One follow at a time, for the Follow buttons: POST adds, DELETE removes. Concurrent clicks never
  // overwrite each other. /follows/{slug} is an investor; /follows/{investors|stocks|owned}/{id}.
  const one = path.match(/^\/follows\/(?:(investors|stocks|owned|peers)\/)?([^/]+)$/);
  if (one && (req.method === 'POST' || req.method === 'DELETE')) {
    const list = (one[1] ?? 'investors') as FollowList;
    const bySlug = list === 'investors' || list === 'peers';
    const value = bySlug ? decodeURIComponent(one[2]) : decodeURIComponent(one[2]).toUpperCase();
    if (!(bySlug ? SLUG : TICKER).test(value)) return json({ ok: false, error: bySlug ? 'not a filer slug' : 'not a ticker like BRK.B', code: 'bad_request' }, 400, h);
    if (req.method === 'POST' && list === 'investors') {
      const unknown = await resolveFollowedFilers(env, [value]);
      if (unknown.length) return json({ ok: false, error: `not a 13F filer on Copybook: ${value}`, code: 'unknown_investor' }, 400, h);
    }
    const r = await changeFollows(env, m, req.method === 'POST' ? { add: { list, value } } : { remove: { list, value } });
    return r.ok ? json({ ok: true, follows: r.follows }, 200, h) : json({ ok: false, error: r.error }, 400, h);
  }

  if (path === '/follows' && (req.method === 'GET' || req.method === 'PUT')) {
    if (req.method === 'GET') {
      const r = await changeFollows(env, m, { get: true });
      return json({ ok: true, follows: r.ok ? r.follows : await getFollows(env, m) }, 200, h);
    }
    const b = await body(req);
    const list = (v: unknown, re: RegExp, upper: boolean): string[] | null | undefined => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.length > MAX_FOLLOWS || !v.every((x) => typeof x === 'string')) return null;
      const out = [...new Set((v as string[]).map((x) => (upper ? x.trim().toUpperCase() : x.trim())))];
      return out.every((x) => re.test(x)) ? out : null;
    };
    const investors = list(b.investors, SLUG, false);
    const stocks = list(b.stocks, TICKER, true);
    const owned = list(b.owned, TICKER, true);
    const peers = list(b.peers, SLUG, false);
    const flags = ['onboarded', 'include_13g', 'digest', 'insider_buys', 'cluster_buys', 'any_13d', 'weekly_digest'] as const;
    const minUsd = b.insider_min_usd;
    const badMin = minUsd !== undefined && !(typeof minUsd === 'number' && Number.isFinite(minUsd) && minUsd >= 0 && minUsd <= 1e10);
    if (investors === null || stocks === null || owned === null || peers === null || badMin || flags.some((k) => b[k] !== undefined && typeof b[k] !== 'boolean')) {
      return json({ ok: false, error: `investors, peers: filer slugs; stocks, owned: tickers like BRK.B; at most ${MAX_FOLLOWS} each; onboarded, include_13g, digest, insider_buys, cluster_buys, any_13d, weekly_digest: boolean; insider_min_usd: USD from 0` }, 400, h);
    }
    // Any 13F filer can be followed: non-curated ones are looked up and added to the minute poll.
    if (investors?.length) {
      const unknown = await resolveFollowedFilers(env, investors);
      if (unknown.length) return json({ ok: false, error: `not a 13F filer on Copybook: ${unknown.join(', ')}`, code: 'unknown_investor' }, 400, h);
    }
    // Only the fields sent change, so a settings save never undoes a Follow click made meanwhile.
    const set: Partial<Follows> = Object.fromEntries(
      Object.entries({ investors, stocks, owned, peers, ...Object.fromEntries(flags.map((k) => [k, b[k]])), insider_min_usd: minUsd }).filter(([, v]) => v !== undefined),
    );
    const r = await changeFollows(env, m, { set });
    return r.ok ? json({ ok: true, follows: r.follows }, 200, h) : json({ ok: false, error: r.error }, 400, h);
  }

  // Import owned stocks: a pasted list, a CSV, or a 13F filer's book by CIK (kept current each quarter).
  if (req.method === 'POST' && path === '/book/import') {
    const b = await body(req);
    // Linking a 13F filer's book is Pro and Fund; a pasted list or CSV is open to every Copy member.
    if (b.cik !== undefined && b.cik !== null && !isPro(m)) return json({ ok: false, error: 'Linking a 13F as your book is part of Copy Pro and Copy Fund', code: 'pro_required' }, 403, h);
    const r = await importBook(env, m, b);
    return r.ok ? json(r, 200, h) : json(r, r.status, h);
  }

  // Copy Pro API keys, managed from the account page. The secret is returned once, at creation.
  if (path === '/keys' || path.startsWith('/keys/')) {
    if (!isPro(m)) return json({ ok: false, error: 'API keys are part of Copy Pro', code: 'pro_required' }, 403, h);
    if (req.method === 'GET' && path === '/keys') {
      const keys = await listKeys(env, m.customer);
      const out = [];
      for (const k of keys) {
        const u = await meter(env, k.id).usage(30);
        out.push({ id: k.id, name: k.name, prefix: k.prefix, created: k.created, last_used_at: u.last_used_at, requests_today: u.days[0]?.requests ?? 0, usage: u.days });
      }
      return json({ ok: true, keys: out, max: MAX_KEYS }, 200, h);
    }
    if (req.method === 'POST' && path === '/keys') {
      const name = String((await body(req)).name ?? '').trim().slice(0, 60) || 'API key';
      const made = await createKey(env, m, name);
      if (!made) return json({ ok: false, error: `at most ${MAX_KEYS} keys; revoke one first` }, 400, h);
      const { id, prefix, created } = made.record;
      await logEvent(env, m.customer, { kind: 'key_created', by: 'self', key: { id, name } }, req);
      return json({ ok: true, key: made.key, id, name, prefix, created }, 201, h);
    }
    const del = path.match(/^\/keys\/(key_[a-z0-9]{16})$/);
    if (req.method === 'DELETE' && del) {
      const k = (await listKeys(env, m.customer)).find((x) => x.id === del[1]);
      if (!k || !(await revokeKey(env, m.customer, del[1]))) return json({ ok: false, error: 'no such key' }, 404, h);
      await logEvent(env, m.customer, { kind: 'key_deleted', by: 'self', key: { id: k.id, name: k.name } }, req);
      return json({ ok: true }, 200, h);
    }
    return json({ ok: false, error: 'not found' }, 404, h);
  }

  // One full quarter for the history page: the same object as data/h/{slug}/{quarter}.json used to be.
  const quarter = path.match(/^\/holdings\/([a-z0-9-]+)\/(\d{4}Q[1-4])$/);
  if (req.method === 'GET' && quarter) {
    const body = await shard(env, `h/${quarter[1]}/${quarter[2]}.json`);
    if (!body) return json({ ok: false, error: 'unknown manager or quarter' }, 404, h);
    return new Response(body, { status: 200, headers: { ...h, 'content-type': 'application/json', 'cache-control': 'private, max-age=3600' } });
  }

  const link = path.match(/^\/csv-link\/([a-z0-9-]+)$/);
  if (req.method === 'POST' && link && SLUG.test(link[1])) {
    const n = crypto.randomUUID();
    await env.DB.put(`dl:${n}`, '1', { expirationTtl: DOWNLOAD_TTL });
    const token = await signToken(env.SESSION_SECRET, 'download', m.customer, DOWNLOAD_TTL, { s: link[1], n });
    await logEvent(env, m.customer, { kind: 'csv_download', by: 'self', detail: link[1] }, req);
    return json({ ok: true, url: `${linkBase(env, req, url)}/csv/${link[1]}.csv?dl=${token}` }, 200, h);
  }

  // The full Flow lists (every name, every fund behind each move); the public file has the top rows.
  if (req.method === 'GET' && path === '/flow') {
    const obj = await env.HIST.get('flow/full.json');
    if (!obj) return json({ ok: false, error: 'full flow not published yet', code: 'not_yet_available' }, 404, h);
    return new Response(obj.body, { headers: { ...h, 'content-type': 'application/json', 'cache-control': 'private, max-age=300' } });
  }

  // Every 13F holder of one stock for Pro and Fund (My book's full lists), the same rows as /v1/stocks/{t}/holders:
  // ?type=hedge_fund,active&cohort=all|curated&limit=&offset=.
  const holdersJson = path.match(/^\/stocks\/([A-Za-z0-9.-]{1,10})\/holders$/);
  if (req.method === 'GET' && holdersJson) {
    if (!isPro(m)) return json({ ok: false, error: 'Every holder of a stock is part of Copy Pro and Copy Fund', code: 'pro_required' }, 403, h);
    const { holdersOf, holderFilter, issuerCode, splitHolders } = await import('./v1data');
    const keep = holderFilter(url.searchParams);
    const limit = Number(url.searchParams.get('limit') ?? 200);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!keep || !Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) return json({ ok: false, error: 'type: hedge_fund, long_only (or active), index, bank, wealth, pension, sovereign, insurance, other; cohort: all or curated; current_only: true or false; limit 1-1000', code: 'bad_request' }, 400, h);
    const is = await issuerCode(env, holdersJson[1]);
    const hs = is ? await holdersOf(env, is.code) : null;
    if (!is || !hs) return json({ ok: false, error: 'unknown ticker', code: 'not_found' }, 404, h);
    // Current share positions by default; calls and puts, and exits, in their own lists (include_options=true mixes options in).
    const sp = splitHolders(hs.rows.filter(keep), url.searchParams.get('include_options') === 'true');
    return json({ ok: true, issuer: hs.issuer, ...(is.superseded_by ? { superseded_by: is.superseded_by } : {}), ticker: is.ticker ?? hs.tickers[0] ?? null, tickers: hs.tickers, counts: hs.counts, truncated: hs.truncated, count: sp.count, filers: sp.filers, options_count: sp.options_count, exited_count: sp.exited_count, holders: sp.holders.slice(offset, offset + limit), options: sp.options, exited: sp.exited, next_offset: offset + limit < sp.count ? offset + limit : null }, 200, { ...h, 'cache-control': 'private, max-age=300' });
  }

  // Holders of one stock as CSV: every 13F filer (the holder index, ?type= lenses it), until it's in R2 Copybook's curated funds.
  const holders = path.match(/^\/stocks\/([A-Za-z0-9.-]{1,10})\/holders\.csv$/);
  if (req.method === 'GET' && holders) {
    const ticker = holders[1].toUpperCase();
    const { holdersOf, holderFilter, issuerCode } = await import('./v1data');
    const keep = holderFilter(url.searchParams);
    if (!keep) return json({ ok: false, error: 'type: hedge_fund, long_only (or active), index, bank, wealth, pension, sovereign, insurance, other; cohort: all or curated; current_only: true or false', code: 'bad_request' }, 400, h);
    const is = await issuerCode(env, ticker);
    const hs = is ? await holdersOf(env, is.code) : null;
    const full = hs && hs.source !== 'public' ? hs : null;
    const pub = full ? null : await fetch(`${env.SITE_URL}d/stocks/${ticker}.json`, { cf: { cacheTtl: 900 } } as RequestInit);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st: any = pub?.ok ? await pub.json() : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: any[];
    // Like /v1 holders: current share (SH) positions by default; ?include=options,exited adds those rows (`kind` and
    // `change` say which).
    const include = new Set((url.searchParams.get('include') ?? '').split(',').map((x) => x.trim()).filter(Boolean));
    if ([...include].some((x) => x !== 'options' && x !== 'exited')) return json({ ok: false, error: 'include: options, exited (comma-separated)', code: 'bad_request' }, 400, h);
    if (full) {
      const { splitHolders } = await import('./v1data');
      const sp = splitHolders(full.rows.filter(keep), include.has('options'));
      rows = [...sp.holders, ...(include.has('exited') ? sp.exited : [])].map((r) => ({ cik: r.filer.cik, name: r.filer.name, slug: r.filer.slug, type: r.filer.type, kind: r.kind, quarter: r.period, shares: r.shares, prev_shares: r.prev_shares, value: r.value_usd, prev_value: r.prev_value_usd, change: r.change, weight: r.weight, accession: r.accession, accepted_at: r.accepted_at }));
    } else if (st) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (st.holders ?? []).map((x: any) => ({ cik: null, name: x.manager, slug: x.slug, kind: 'equity', quarter: x.quarter, shares: x.shares, prev_shares: x.prev_shares ?? null, value: x.value, prev_value: x.prev_value ?? null, change: x.change ?? null, weight: x.weight }));
      // Each curated fund's CIK and, for its latest quarter, the 13F's accession and EDGAR acceptance
      // (cached per filing; at most 20 new EDGAR reads per download, the rest fill in on later ones).
      const list = await curatedFilers(env);
      let reads = 0;
      for (const r of rows) {
        const c = list.find((x) => x.slug === r.slug);
        if (!c) continue;
        r.cik = c.cik;
        if (r.quarter !== c.latest_quarter || !c.latest_accession) continue;
        r.accession = c.latest_accession;
        const cached = await env.DB.get(`filing:${c.latest_accession}`);
        const meta = cached ? JSON.parse(cached) : reads++ < 20 ? await filingMeta(env, c.cik, c.latest_accession).catch(() => null) : null;
        r.accepted_at = meta?.accepted_at ?? null;
      }
    } else return json({ ok: false, error: 'unknown ticker' }, 404, h);
    return new Response(holdersCsv(rows), { headers: { ...h, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="copybook-${ticker}-holders.csv"`, 'cache-control': 'private, no-store', 'x-copybook-coverage': full ? 'all-filers' : 'curated', 'x-copybook-rows': ['equity', ...include].join(',') } });
  }

  // Every followed fund's latest 13F in one CSV, streamed fund by fund.
  if (req.method === 'GET' && path === '/follows.csv') {
    // The member's object holds the authoritative follows; KV can lag a fresh Follow click by a minute.
    const r = await changeFollows(env, m, { get: true });
    const f = r.ok ? r.follows : await getFollows(env, m);
    const list = await curatedFilers(env);
    const history = [];
    for (const slug of f.investors.slice(0, 100)) {
      const c = list.find((x) => x.slug === slug);
      const q = c?.latest_quarter;
      if (c && q) {
        history.push({ manager: c.manager, slug, cik: c.cik, quarter: q, report_date: c.latest_report_date, filing_date: c.latest_filing_date, accession: c.latest_accession, csv_url: `h/${slug}/${q}.csv`, holdings_url: `h/${slug}/${q}.json` });
        continue;
      }
      // Any other filer: its latest book (full book, public shard, or the follow-time snapshot).
      const a = c ? null : await resolveAny(env, slug);
      if (!a || a.curated || !a.row.quarter) continue;
      const book = await filerBook(env, a.row.cik, a.row.quarter);
      if (!book) continue;
      history.push({ manager: a.row.name, slug, cik: a.row.cik, quarter: a.row.quarter, report_date: book.report_date ?? null, filing_date: book.filing_date ?? a.row.filing_date, accession: book.accession ?? null, holdings: book.holdings ?? (book.columns ? rowsOf(book) : []) });
    }
    // One quarter per fund, so rows are rewritten in JS: weight is the equity-book share for every fund.
    return new Response(historyCsv(env, { history, equity_weight: true }), {
      headers: { ...h, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="copybook-followed-funds-13f.csv"', 'cache-control': 'private, no-store', 'x-copybook-funds': String(history.length) },
    });
  }

  const hist = path.match(/^\/history\/([a-z0-9-]+)$/);
  const csv = path.match(/^\/csv\/([a-z0-9-]+)\.csv$/);
  const slug = hist?.[1] ?? csv?.[1];
  if (req.method === 'GET' && slug && SLUG.test(slug)) {
    const data = await fetchHistory(env, slug);
    if (!data) return json({ ok: false, error: 'unknown manager' }, 404, h);
    if (hist) return json(data, 200, { ...h, 'cache-control': 'private, max-age=300' });
    return csvResponse(env, slug, h, data);
  }

  return json({ ok: false, error: 'not found' }, 404, h);
}

/** The stable public name: clients keep it, and the self-hosted base behind it moves (a quick tunnel rotates). */
const PUBLIC_API = 'https://copybook-api.factordynamics.workers.dev';
const HEADER_WAIT_MS = 30_000;

/** The proof a proxied request came through this Worker: the client's IP, signed with the shared session secret per minute. */
async function proxyProof(env: Env, ip: string, minute = Math.floor(Date.now() / 60_000)): Promise<string> {
  return hmacHex(env.SESSION_SECRET, `proxy|${ip}|${minute}`);
}

/**
 * On the live host: a request this Worker proxied carries x-copybook-proxy (client IP and its proof). Valid, it is
 * answered as if it came in on the public name (client IP for rate limits, links on the workers.dev base); anything
 * else has the header dropped, so a client can't claim an IP or a base.
 */
export async function fromProxy(req: Request, env: Env): Promise<Request> {
  const v = req.headers.get('x-copybook-proxy');
  if (!v && !req.headers.has('x-copybook-country')) return req;
  const headers = new Headers(req.headers);
  headers.delete('x-copybook-proxy');
  // The country is only ever this Worker's word (after a valid proof), never a client's.
  headers.delete('x-copybook-country');
  const [ip, sig, country] = (v ?? '').split(' ');
  const m = Math.floor(Date.now() / 60_000);
  if (ip && sig && env.SESSION_SECRET && (sig === (await proxyProof(env, ip, m)) || sig === (await proxyProof(env, ip, m - 1)))) {
    headers.set('cf-connecting-ip', ip);
    headers.set('x-copybook-public-base', PUBLIC_API);
    if (country && /^[A-Z][A-Z0-9]$/.test(country)) headers.set('x-copybook-country', country);
  }
  return new Request(req, { headers });
}

/**
 * Any API request on the public name, answered here from the live host (the quant: a 307 to the tunnel lost the API key
 * on the hop, since clients drop Authorization across hosts, and leaked the host name). The live host's own redirects
 * come back on the public name; others (a bulk file's signed link) pass as they are. Unreachable or slow to answer:
 * 503 with Retry-After, never a redirect.
 */
async function proxyApi(req: Request, env: Env, base: string): Promise<Response> {
  const u = new URL(req.url);
  const headers = new Headers(req.headers);
  for (const k of ['host', 'x-copybook-public-base', 'x-copybook-proxy']) headers.delete(k);
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  // The client's country rides after the proof (the access log shows it; never the IP).
  const country = (req as { cf?: { country?: string } }).cf?.country;
  headers.set('x-copybook-proxy', `${ip} ${await proxyProof(env, ip)}${country && /^[A-Z][A-Z0-9]$/.test(country) ? ` ${country}` : ''}`);
  const unavailable = () =>
    u.pathname === '/v1' || u.pathname.startsWith('/v1/')
      ? v1error('busy', 503, 'Temporarily unavailable; retry after Retry-After seconds.', { 'retry-after': '30', 'access-control-expose-headers': 'retry-after' })
      : json({ ok: false, code: 'unavailable', error: 'Temporarily unavailable. Try again in a minute.' }, 503, { ...cors(allowedOrigin(req.headers.get('origin'), env)), 'retry-after': '30', 'access-control-expose-headers': 'retry-after' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sent = fetch(`${base}${u.pathname}${u.search}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body, redirect: 'manual' });
    const r = await Promise.race([sent, new Promise<null>((res) => (timer = setTimeout(() => res(null), HEADER_WAIT_MS)))]);
    if (!r) return unavailable();
    const out = new Headers(r.headers);
    const loc = r.headers.get('location');
    if (loc) {
      const to = new URL(loc, base);
      const b = new URL(base);
      if (to.origin === b.origin) out.set('location', `${PUBLIC_API}${to.pathname.startsWith(b.pathname) && b.pathname !== '/' ? to.pathname.slice(b.pathname.replace(/\/+$/, '').length) : to.pathname}${to.search}`);
    }
    // Never a permanent redirect from this name: clients and feed readers cache those.
    const status = r.status === 301 || r.status === 308 ? 307 : r.status;
    return new Response(r.body, { status, headers: out });
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
  }
}

/** A private feed, fetched from the live host and answered here: readers keep this stable name, never a redirect. */
async function proxyFeed(req: Request, to: string): Promise<Response> {
  try {
    const r = await fetch(to, { method: 'GET', headers: { accept: req.headers.get('accept') ?? '*/*', 'user-agent': req.headers.get('user-agent') ?? 'copybook-feed-proxy', 'x-copybook-public-base': PUBLIC_API }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const headers = new Headers({ 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'referrer-policy': 'no-referrer' });
    const ct = r.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    // A redirect from the live host would hand out its name: answered as unavailable instead.
    if (r.status >= 300 && r.status < 400) {
      headers.set('retry-after', '60');
      return new Response('Feed temporarily unavailable', { status: 503, headers });
    }
    return new Response(req.method === 'HEAD' ? null : r.body, { status: r.status, headers });
  } catch {
    return new Response('Feed temporarily unavailable', { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '60', 'access-control-allow-origin': '*' } });
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    // A retired copy (MOVED_TO set as a secret on Cloudflare's fallback): every request, including links in emails
    // already sent (resume, unsubscribe, why, keep), goes to the same path on the live host. 307 keeps method and body (temporary: the live host moves); private feeds are proxied, not redirected.
    // It follows the API's current public base (the runner's api.json, read at most once a minute), else MOVED_TO,
    // so this hostname is the stable one for links in email and feed readers while the self-hosted base moves.
    // Failed over to this host (api.json names it): serve here, never a redirect to itself. MOVED_TO stays set, so this
    // copy keeps its identity (Cloudflare, the primary poller) through a failover and back.
    if (env.MOVED_TO) {
      const u = new URL(req.url);
      // Unsubscribe (the List-Unsubscribe one-click POST and its page) is answered here, so it works with gene down.
      if (u.pathname === '/unsubscribe') return import('./failover').then((fo) => fo.writeThrough(env, (e) => serve(req, e)));
      // Failed over to this copy: every request reads and writes the synced store (writeThrough), so what members change
      // here (seats, sign-outs, API keys, channels, settings) is published and gene applies it once access moves back.
      // Follows live in each host's own per-member object, which doesn't sync: they can't change here.
      const followWrite = req.method !== 'GET' && req.method !== 'OPTIONS' && /^\/follows(\/|$)/.test(u.pathname);
      return movedBase(env).then((b) =>
        new URL(b).origin === u.origin && followWrite
          ? json({ ok: false, code: 'read_only', error: "Follows can't be changed while we run on our backup. Try again in a few minutes." }, 503, { ...cors(allowedOrigin(req.headers.get('origin'), env)), 'retry-after': '300', 'access-control-expose-headers': 'retry-after' })
          : new URL(b).origin === u.origin
            ? import('./failover').then((fo) => fo.writeThrough(env, (e) => serve(req, e)))
            : /^\/feed\/[\w-]+\.(json|rss)$/.test(u.pathname) && (req.method === 'GET' || req.method === 'HEAD')
              ? proxyFeed(req, `${b}${u.pathname}${u.search}`)
              // Everything else is answered here from the live host too: no redirect to a moving host name.
              : proxyApi(req, env, b),
      );
    }
    return fromProxy(req, env).then((r) => serve(r, env));
  },
  async scheduled(event: { scheduledTime?: number }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(runScheduled(env, event.scheduledTime ?? Date.now()).then((r) => console.log(`cron: ${JSON.stringify(r)}`)));
  },
};

/** Every request this copy answers itself, within the read budget. */
async function serve(req: Request, env: Env): Promise<Response> {
  const handled = handleRequest(req, env).catch((err) => {
    console.log(String(err?.stack ?? err));
    return json({ ok: false, error: 'server error' }, 500, cors(allowedOrigin(req.headers.get('origin'), env)));
  });
  // Every member and /v1 read answers within 3 s: past that the caller gets a 503 to retry, never a hung page.
  // Writes (sign-in, checkout, pause: they call Stripe or the mailer) are never cut off mid-way, and downloads and
  // whole books stream for longer.
  const path = new URL(req.url).pathname;
  // The operator (its bearer token) can time a slow route past the budget. x-copybook-operator only names the caller
  // for the access log, so it never has to carry a secret.
  const op = await isOperator(env, req);
  if (op || req.method !== 'GET' || /^\/(csv\/|feed\/|v1\/bulk|v1\/filers\/[^/]+\/holdings)/.test(path)) return handled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Retry-After is exposed to pages (CORS hides response headers from scripts otherwise).
  const retry = { 'retry-after': '5', 'access-control-expose-headers': 'retry-after' };
  const busy = () => (path === '/v1' || path.startsWith('/v1/') ? v1error('busy', 503, undefined, retry) : json({ ok: false, error: 'busy: try again in a few seconds', code: 'busy' }, 503, { ...cors(allowedOrigin(req.headers.get('origin'), env)), ...retry }));
  const late = new Promise<Response>((r) => (timer = setTimeout(() => r(busy()), REQUEST_MS)));
  return Promise.race([handled, late]).finally(() => clearTimeout(timer));
}

let moved: { at: number; base: string } | null = null;
async function movedBase(env: Env): Promise<string> {
  if (moved && Date.now() - moved.at < 60_000) return moved.base;
  let base = env.MOVED_TO!.replace(/\/+$/, '');
  try {
    const r = env.PUBLIC_URL ? await fetch(`${env.PUBLIC_URL}api.json`, { signal: AbortSignal.timeout(2000) }) : null;
    const api = r?.ok ? ((await r.json()) as { api?: string }).api : undefined;
    if (api && /^https:\/\/[a-z0-9.-]+(\/[a-z0-9-]+)?\/?$/.test(api)) base = api.replace(/\/+$/, '');
  } catch {
    // MOVED_TO
  }
  moved = { at: Date.now(), base };
  return base;
}

/** The operator's bearer token (HEALTH_TOKEN), compared in constant time. */
async function isOperator(env: Env, req: Request): Promise<boolean> {
  const tok = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return !!env.HEALTH_TOKEN && tok.length === env.HEALTH_TOKEN.length && (await hmacHex(env.SESSION_SECRET, tok)) === (await hmacHex(env.SESSION_SECRET, env.HEALTH_TOKEN));
}
