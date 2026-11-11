import { type Alert13F, type AlertEvent, deliverTo, etDay, recentFeed, resolveFollowedFilers, runScheduled } from './alerts';
import { fetchHistory, historyCsv, holdersCsv, shard, SHARD_KEY, SLUG } from './data';
import { filers as curatedFilers, filerBook, filingMeta, resolveAny, rowsOf } from './v1data';
import { verifyGithubOidc } from './oidc';
import { type ChannelDelivery, channelScope, channelsView, failView, clearSeatDuplicates, getChannels, getFailures, rotateFeed, seedFeed, serveFeed, testChannels, updateChannels } from './channels';
import { createKey, listKeys, MAX_KEYS, meter, revokeKey } from './keys';
import { handleV1, v1error } from './v1';

export { KeyMeter } from './keys';
import { holdtermLoginMail, leadAckMail, leadNoticeMail, loginMail, sendMail } from './email';
import { ACTIVE, apiBase, followCounts, logAccess, isActive, isCopy, isPaused, isPro, linkBase, testAddress, type Env, type Member } from './env';
import { changeFollows, type FollowList, type FollowOp, type Follows, getFollows, getMember, isOurInvoice, isOurSubscription, listMembers, LOGIN_REQUEST_TTL, MAX_FOLLOWS, memberByEmail, publicView, putMember, SESSION_TTL, syncSubscription } from './members';
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
  if (/^pre\/(stock-codes|sec-tickers|events)\.json$|^pre\/v1-filers-rest\.txt$/.test(key)) return 'pre';
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

/** Member from `Authorization: Bearer <session token>`. Session tokens are never accepted from a URL. */
async function authed(req: Request, env: Env): Promise<Member | null> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const p = await verifyToken(env.SESSION_SECRET, token, 'session');
  const m = p ? await getMember(env, p.c) : null;
  // Signed out everywhere (a Fund owner revoked the seat's sessions): sessions issued before then are refused.
  return m && !(m.sessions_after && p!.x - SESSION_TTL <= m.sessions_after) ? m : null;
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
  const ignore = (what: string) => (console.log(`webhook: ${event.type} ${obj.id ?? ''} ignored (${what} not a Copybook price)`), json({ ok: true, ignored: true }, 200, {}));
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode === 'subscription' && obj.subscription) {
        const sub = await stripe(env, 'GET', `subscriptions/${obj.subscription}`);
        if (!isOurSubscription(sub)) return ignore('subscription');
        await syncSubscription(env, sub, obj.customer_details?.email);
      }
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      if (!isOurSubscription(obj)) return ignore('subscription');
      await syncSubscription(env, obj);
      break;
    case 'invoice.paid':
    case 'invoice.payment_failed':
      if (!(await isOurInvoice(env, obj))) return ignore('invoice');
  }
  switch (event.type) {
    case 'invoice.paid': {
      const { rewardReferrer } = await import('./referrals');
      console.log(`referral: ${await rewardReferrer(env, obj)}`);
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
function spread(xs: number[]) {
  return { count: xs.length, median_seconds: nearest(xs, 0.5), p90_seconds: nearest(xs, 0.9) };
}

/**
 * The public speed numbers for this filing season, live alerts only (replays excluded). Email is
 * acceptance to handing the alert to the mailer; chat, webhook and feed are acceptance to the
 * channel's first successful post (KV alerts:latency:ch).
 */
/** From then (the deploy of 0bf5b8f) a 13F is timed by the email that carries its moves. Filings accepted earlier are left out of the figures. */
const MOVES_FIX_AT = '2026-11-11T00:01:00Z';

export function latencyReport(log: LatencyRow[], now: number, ch: ChannelDelivery[] = []) {
  const { season, from } = seasonOf(now);
  const fixAt = Date.parse(MOVES_FIX_AT);
  // Before the fix, a 13F whose moves came in a later follow-up (tables too big, or no prior book) is reported apart;
  // one whose first email carried the moves is timed as usual.
  const isPre = (l: LatencyRow) => (l.kind ?? '13f') === '13f' && Date.parse(l.accepted) < fixAt && !!l.followup;
  // 13Fs are timed by the email that carried the moves (rows tagged `moves`); older 13F rows timed the first email.
  // Emails held for the daily limit aren't counted as fast (they're reported as email_delayed).
  // 13Fs accepted before the moves fix (sent before it, or their moves sent after it from the backlog) are reported apart.
  const counted = log.filter((l) => !l.replay && !l.email_delayed && Date.parse(l.sent) >= from && ((l.kind ?? '13f') !== '13f' || l.moves));
  const rows = counted.filter((l) => !isPre(l));
  const pre = counted.filter(isPre);
  const chRows = ch.filter((c) => Date.parse(c.delivered) >= from);
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
  return {
    ok: true,
    season,
    since: new Date(from).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    median_seconds: all.median_seconds,
    p90_seconds: all.p90_seconds,
    p95_seconds: nearest(rows.map((l) => l.seconds), 0.95),
    count: all.count,
    by_form: group(rows, (l) => family(formOf(l)), (l) => l.seconds),
    moves_fix_at: MOVES_FIX_AT,
    before_moves_fix: { '13F': { ...spread(pre.map((l) => l.seconds)), max_seconds: pre.length ? Math.max(...pre.map((l) => l.seconds)) : null, rows: pre.map((l) => ({ accession: l.accession, manager: l.manager ?? null, slug: l.slug, accepted_at: l.accepted, sent_at: l.sent, seconds: l.seconds })) } },
    by_channel: { email: all, ...group(chRows, (c) => c.channel, (c) => c.seconds) },
    by_coverage: group(rows, (l) => l.coverage ?? 'curated', (l) => l.seconds),
    recent: rows.slice(0, 20).map((l) => ({ form: formOf(l), manager: l.manager ?? null, slug: l.slug, coverage: l.coverage ?? 'curated', accession: l.accession, accepted_at: l.accepted, delivered_at: l.sent, seconds: l.seconds, channel: 'email' })),
    alerts: rows.map((l) => ({
      slug: l.slug,
      manager: l.manager ?? null,
      quarter: l.quarter ?? null,
      form: formOf(l),
      coverage: l.coverage ?? 'curated',
      accession: l.accession,
      accepted_at: l.accepted,
      sent_at: l.sent,
      gap_seconds: l.seconds,
    })),
  };
}
export async function buildLatency(env: Env, now: number) {
  const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as LatencyRow[];
  const ch = JSON.parse((await env.DB.get('alerts:latency:ch')) ?? '[]') as ChannelDelivery[];
  const r = latencyReport(log, now, ch);
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
  const poller = fo.syncOn(env) ? { poller_host: fo.isCloudflare(env) ? 'cloudflare' : 'gene', poller_last_run: new Date(Math.floor(now / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z') } : {};
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
    // Seconds from EDGAR acceptance to handing the alert to the mailer, for the latest alerted filings.
    // Live alerts only (test replays excluded); ?latency=all returns every stored one instead of the latest 10.
    const all = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as { seconds: number; replay?: boolean }[];
    const live = all.filter((l) => !l.replay);
    const sorted = live.map((l) => l.seconds).sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);
    const summary = { count: sorted.length, p50: q(0.5), p90: q(0.9), max: sorted.length ? sorted[sorted.length - 1] : null };
    const leads = Number((await env.DB.get('leads:count')) ?? 0);
    // Member and revenue counts only with the private token; the public view is operational.
    const priv = await isOperator(env, req);
    const business = priv ? { business: { ...(await businessSummary(env, Date.now())), fund_requests: leads } } : {};
    // Filings the missed-filing detector found unsent 10+ minutes after acceptance and put back in front of the polls.
    const missed_recovered = { count: Number((await env.DB.get('missed:count')) ?? 0), recent: (JSON.parse((await env.DB.get('missed:log')) ?? '[]') as unknown[]).slice(0, 10) };
    const { pollerStatus } = await import('./failover');
    return json({ ok: true, ...(await pollerStatus(env, Date.now())), alert_latency_summary: summary, missed_recovered, alert_latency: url.searchParams.get('latency') === 'all' ? live : live.slice(0, 10), replays_excluded: all.length - live.length, mail_quota: { ...(JSON.parse((await env.DB.get('host:mail-meter')) ?? 'null') ?? (await import('./email')).mailQuota), daily_cap: 100, monthly_cap: 3000, reserve_for_account_mail: 15 }, moves_queue: { pending: ((JSON.parse((await env.DB.get('alerts:pending-moves')) ?? '[]') as Alert13F[]).map((p) => p.accession)), last: JSON.parse((await env.DB.get('host:moves-last')) ?? 'null') }, ...business }, 200, h);
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
    if (n >= 30) return json({ ok: false, error: 'too many requests, try again in an hour', code: 'rate_limited' }, 429, { ...h, 'retry-after': '3600' });
    await env.DB.put(k, String(n + 1), { expirationTtl: 3600 });
    const { createCheckout } = await import('./referrals');
    const r = await createCheckout(env, await body(req));
    return json(r.body, r.status, h);
  }

  // Free accounts: the weekly email, no card. Rate-limited per IP and email; `website` is a honeypot.
  if (req.method === 'POST' && path === '/signup') {
    const { handleSignup } = await import('./free');
    const r = await handleSignup(env, await body(req), req.headers.get('cf-connecting-ip') ?? 'unknown');
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
  const ops = path.match(/^\/ops\/follows\/(cus_\w+)$/);
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
      const c = typeof b.customer === 'string' && /^(cus_\w+|free_\w+)$/.test(b.customer) ? b.customer : null;
      if (!c || typeof b.route !== 'string') return json({ ok: false, error: 'customer (row ID) and route' }, 400, h);
      await logAccess(env, req, b.route.slice(0, 120), [c], typeof b.note === 'string' ? b.note.slice(0, 300) : undefined, typeof b.who === 'string' ? b.who.slice(0, 120) : undefined, typeof b.at === 'string' && !Number.isNaN(Date.parse(b.at)) ? new Date(b.at).toISOString() : undefined);
      return json({ ok: true }, 200, h);
    }
    const c = url.searchParams.get('customer') ?? '';
    return json({ ok: true, customer: c, entries: JSON.parse((await env.DB.get(`access:${c}`)) ?? '[]') }, 200, h);
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
    return json(await previewWeekly(env, String(b.email ?? '').trim().toLowerCase(), Date.now(), b.dry === true), 200, h);
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
  if (req.method === 'POST' && path === '/ops/moves-requeue') {
    if (!(await isOperator(env, req))) return json({ ok: false, error: 'not found' }, 404, h);
    const want = new Set(((await body(req)).accessions as string[] | undefined) ?? []);
    const pending = JSON.parse((await env.DB.get('alerts:pending-moves')) ?? '[]') as Alert13F[];
    const have = new Set(pending.map((p) => p.accession));
    for (let d = 0; d < 7 && want.size > have.size; d++) {
      const day = JSON.parse((await env.DB.get(`digest:${etDay(Date.now() - d * 86_400_000)}`)) ?? '{"filings":[]}') as { filings: Alert13F[] };
      for (const f of day.filings) {
        if (!want.has(f.accession) || have.has(f.accession) || f.followup || f.moves) continue;
        const { sent_at: _s, ...a } = f;
        pending.push({ ...a, moves_pending: true });
        have.add(f.accession);
      }
    }
    await env.DB.put('alerts:pending-moves', JSON.stringify(pending));
    return json({ ok: true, queued: [...want].filter((a) => have.has(a)), not_found: [...want].filter((a) => !have.has(a)) }, 200, h);
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
    const mail = await sendMail(env, [leadAckMail(env, lead)]);
    if (!test && env.CONTACT_EMAIL) await sendMail(env, [leadNoticeMail(env, lead, id)]);
    return json({ ok: true, id, acknowledgement: mail === '200' ? 'sent' : 'not sent' }, 200, h);
  }

  // A member's private alert feed: the token in the path is the only credential, and revocable.
  const feed = path.match(/^\/feed\/([\w-]+)\.(json|rss)$/);
  if (req.method === 'GET' && feed) return serveFeed(env, feed[1], feed[2] as 'json' | 'rss', `${apiBase(env, url)}${url.pathname}`);

  // The data workflow reads which non-curated filers members follow (CIKs only), to back-fill a prior quarter.
  if (req.method === 'GET' && path === '/ingest/followed.json') {
    const why = await verifyGithubOidc(req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '', env.INGEST_WORKFLOW);
    if (why) return json({ ok: false, error: why }, 401, {});
    const obj = await env.HIST.get('followed/ciks.json');
    return obj ? new Response(obj.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) : json({ updated_at: null, ciks: [] }, 200, {});
  }

  // Many uploads in one request: PUT /ingest/bundle (an uncompressed tar, each entry named by its R2 key) or
  // POST /ingest-batch (a JSON manifest line, then the objects' bytes back to back). Each request counts against
  // the Workers plan's quota, so a full rebuild is ~50 of these, not ~25,000 single PUTs. Keys that fail the
  // allowlist are refused and listed; the rest are written.
  if ((req.method === 'PUT' && path === '/ingest/bundle') || (req.method === 'POST' && path === '/ingest-batch')) {
    const buf = new Uint8Array(await req.arrayBuffer());
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
    // A few at a time: R2 writes are I/O, not CPU.
    for (let i = 0; i < good.length; i += 25) {
      await Promise.all(good.slice(i, i + 25).map((o) => {
        const meta = { ...buildMeta(null, o.meta ?? null), ...head };
        return env.HIST.put(o.key, o.bytes, { httpMetadata: { contentType: contentTypeOf(o.key) }, ...(Object.keys(meta).length ? { customMetadata: meta } : {}) });
      }));
    }
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
      await sendMail(env, [holdterm ? holdtermLoginMail(env, m.email, token, false) : loginMail(env, m.email, token, false)]);
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
      // Once: the link's nonce is marked used until the link would have expired anyway.
      if (p.n) {
        if (await env.DB.get(`used:${p.n}`)) return json({ ok: false, error: 'This sign-in link was already used. Ask for a new one.', code: 'link_used' }, 401, h);
        await env.DB.put(`used:${p.n}`, '1', { expirationTtl: Math.max(60, Math.ceil(p.x - Date.now() / 1000)) });
      }
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
      const sub = await stripe(env, 'GET', `subscriptions/${cs.subscription}`);
      const m = await syncSubscription(env, sub, cs.customer_details?.email);
      return json(await issueSession(env, m), 200, h);
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
    return csvResponse(env, dlSlug, h);
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
  if (!m) return json({ ok: false, error: 'sign in required' }, 401, h);

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
    const { pauseOffer, DIGEST_LIVE } = await import('./revenue');
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
  if (path === '/seats' || path.startsWith('/seats/')) {
    if (m.seat_of) return json({ ok: false, error: "Seats are managed by your team's Copy Fund owner", code: 'seat' }, 403, h);
    if (m.plan !== 'fund') return json({ ok: false, error: 'Seats are part of Copy Fund', code: 'fund_required' }, 403, h);
    if (req.method === 'GET' && path === '/seats') return json({ ok: true, ...seatsView(m, await listSeats(env, m.customer)) }, 200, h);
    if (req.method === 'POST' && path === '/seats') {
      const email = String((await body(req)).email ?? '').trim().toLowerCase();
      if (!EMAIL.test(email)) return json({ ok: false, error: 'invalid email', code: 'bad_request' }, 400, h);
      const r = await inviteSeat(env, m, email);
      if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status, h);
      return json({ ok: true, ...seatsView(m, await listSeats(env, m.customer)) }, 201, h);
    }
    const revoke = path.match(/^\/seats\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && revoke) {
      if (!(await revokeSeatSessions(env, m, decodeURIComponent(revoke[1])))) return json({ ok: false, error: 'no such seat' }, 404, h);
      return json({ ok: true, revoked_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...seatsView(m, await listSeats(env, m.customer)) }, 200, h);
    }
    const del = path.match(/^\/seats\/([^/]+)$/);
    if (req.method === 'DELETE' && del) {
      if (!(await removeSeat(env, m, decodeURIComponent(del[1])))) return json({ ok: false, error: 'no such seat' }, 404, h);
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
      return json({ ok: true, channels: channelsView(m, await getChannels(env, m.customer), apiBase(env, url), await getFailures(env, m.customer), team) }, 200, h);
    }
    if (req.method === 'PUT' && path === '/channels') {
      // A seat can't save its team's destination (409 already_team_channel); an owner's save clears seats' copies of it.
      const team = m.seat_of ? await getChannels(env, m.seat_of) : undefined;
      const r = await updateChannels(env, m, await body(req), team);
      if (r.ok && channelScope(m) === 'team') await clearSeatDuplicates(env, m);
      return r.ok ? json({ ok: true, channels: channelsView(m, r.channels, apiBase(env, url), await getFailures(env, m.customer)) }, 200, h) : json({ ok: false, error: r.error, code: r.code }, r.code === 'pro_required' ? 403 : r.code === 'already_team_channel' ? 409 : 400, h);
    }
    if (req.method === 'POST' && path === '/channels/test') return json({ ok: true, ...(await testChannels(env, m, await getChannels(env, m.customer))) }, 200, h);
    if (path === '/channels/feed' && (req.method === 'POST' || req.method === 'DELETE')) {
      const c = await rotateFeed(env, m, req.method === 'DELETE');
      // A new feed starts with the member's alerts from the last 30 days (at most 20), not empty.
      if (req.method === 'POST') await seedFeed(env, m.customer, await recentFeed(env, m, Date.now()));
      return json({ ok: true, channels: channelsView(m, c, apiBase(env, url), await getFailures(env, m.customer)) }, 200, h);
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
    const flags = ['onboarded', 'include_13g', 'digest', 'insider_buys', 'cluster_buys', 'any_13d'] as const;
    const minUsd = b.insider_min_usd;
    const badMin = minUsd !== undefined && !(typeof minUsd === 'number' && Number.isFinite(minUsd) && minUsd >= 0 && minUsd <= 1e10);
    if (investors === null || stocks === null || owned === null || peers === null || badMin || flags.some((k) => b[k] !== undefined && typeof b[k] !== 'boolean')) {
      return json({ ok: false, error: `investors, peers: filer slugs; stocks, owned: tickers like BRK.B; at most ${MAX_FOLLOWS} each; onboarded, include_13g, digest, insider_buys, cluster_buys, any_13d: boolean; insider_min_usd: USD from 0` }, 400, h);
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
      return json({ ok: true, key: made.key, id, name, prefix, created }, 201, h);
    }
    const del = path.match(/^\/keys\/(key_[a-z0-9]{16})$/);
    if (req.method === 'DELETE' && del) {
      return (await revokeKey(env, m.customer, del[1])) ? json({ ok: true }, 200, h) : json({ ok: false, error: 'no such key' }, 404, h);
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
    return json({ ok: true, issuer: hs.issuer, ticker: is.ticker ?? hs.tickers[0] ?? null, tickers: hs.tickers, counts: hs.counts, truncated: hs.truncated, count: sp.count, filers: sp.filers, options_count: sp.options_count, exited_count: sp.exited_count, holders: sp.holders.slice(offset, offset + limit), options: sp.options, exited: sp.exited, next_offset: offset + limit < sp.count ? offset + limit : null }, 200, { ...h, 'cache-control': 'private, max-age=300' });
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

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    // A retired copy (MOVED_TO set as a secret on Cloudflare's fallback): every request, including links in emails
    // already sent (resume, unsubscribe, why, keep), goes to the same path on the live host. 308 keeps method and body.
    // It follows the API's current public base (the runner's api.json, read at most once a minute), else MOVED_TO,
    // so this hostname is the stable one for links in email and feed readers while the self-hosted base moves.
    // Failed over to this host (api.json names it): serve here, never a 308 to itself. MOVED_TO stays set, so this
    // copy keeps its identity (Cloudflare, the primary poller) through a failover and back.
    if (env.MOVED_TO) {
      const u = new URL(req.url);
      return movedBase(env).then((b) => (new URL(b).origin === u.origin ? serve(req, env) : new Response(null, { status: 308, headers: { location: `${b}${u.pathname}${u.search}`, 'access-control-allow-origin': '*', 'cache-control': 'no-store' } })));
    }
    return serve(req, env);
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
