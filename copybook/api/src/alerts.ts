import { addToFeed, flushChannelLatency, getChannels, runWebhookRetries, sendChats, sendWebhooks } from './channels';
import { refreshBooks } from './book';
import { countAlerts, logSent, pausedFilingMail, resumeUrl, runRevenue } from './revenue';
import { inFilingWeek } from './seasons';
import { alertMail, digestMail, type FeedItem, feedItems, holdtermAlertMail, sendMail } from './email';
import { bookSuspect, companyFilings, computeMoves, netRenamed, perShareSuspects, type PerShare, displayCase, guardRows, fetch13F, fetchFilingMeta, fetchForm4, prevQuarterEnd, prior13F, fetchSchedule13, latestFilings, previousSchedule13, quarterOf, secBudget, type FeedEntry, type FilingMeta, type Form4Class, type MoveRow, type Moves, type Position } from './edgar';
import { isActive, isPaused, testAddress, type Env, type Member } from './env';
import { getFollows, getMember, listMembers, putMember, type Follows } from './members';
import { unsubscribeUrl } from './free';

/** A filing dated more than this many days ago never triggers an email, whatever the data says. */
export const MAX_ALERT_AGE_DAYS = 3;
const DAY = 86400_000;

export function alertable(f: { form: string; filing_date: string }, now = Date.now()): boolean {
  return f.form === '13F-HR' && now - Date.parse(f.filing_date) <= MAX_ALERT_AGE_DAYS * DAY;
}

export interface Alert13F {
  slug: string;
  /** The book fails Holdterm's data check (information table vs cover total, or mostly notes): never in Holdterm alerts. */
  suspect_book?: boolean;
  /** When it was sent (set in the day's store, for seeding a new feed). */
  sent_at?: string;
  /** Every curated slug this filing reports for (a parent can report for a manager). */
  slugs: string[];
  manager: string;
  name: string;
  quarter: string;
  report_date: string;
  filing_date: string;
  accession: string;
  sec_url: string;
  accepted?: string;
  moves: Moves | null;
  /** Tickers of every position that changed, for watchlist targeting and "stocks you own". */
  tickers: string[];
  /** The moves for a filing already alerted without them. */
  followup?: boolean;
  /** An operator's hand-off replay: only these (test) members get it, timed from `replay_at`, never in latency.json. */
  replay_to?: string[];
  replay_at?: string;
  /** A non-curated filer: only members who follow it get it, never "every investor". */
  extra?: boolean;
  /** Largest holdings, when there is no prior quarter to diff against. */
  top?: MoveRow[];
  /** Sent before its moves could be computed: the moves follow in a second email (gene computes them from EDGAR). */
  moves_pending?: boolean;
  /** Every changed position above $100K (largest first, up to 400): each member's owned and watched moves are named. */
  changed?: MoveRow[];
  /** A 13F-HR/A of type NEW HOLDINGS: positions added to an earlier quarter's book, often previously confidential. */
  reveal?: { confidential: boolean; amendment_no: number | null; book_total: number | null; rows: MoveRow[] };
  /** The site has a public filing card at /f/{accession}/ for this filing. */
  card?: boolean;
}

/** Marks the filings that have a public card; cards are rebuilt every 3 hours, so new ones may not yet. */
export async function withCards(env: Env, filings: Alert13F[]): Promise<Alert13F[]> {
  if (!filings.length) return filings;
  try {
    const res = await fetch(`${env.SITE_URL}d/f/index.json`, { cf: { cacheTtl: 600 } } as RequestInit);
    if (!res.ok) return filings;
    const have = new Set(((await res.json()) as { cards: { accession: string }[] }).cards.map((c) => c.accession));
    return filings.map((a) => ({ ...a, card: have.has(a.accession) }));
  } catch {
    return filings;
  }
}

export interface Insider {
  cik: string;
  name: string;
  roles: string[];
  bought_usd: number;
  accession: string;
  accepted: string;
}

export interface AlertEvent {
  id: string;
  /** When it was sent (set in the day's store, for seeding a new feed). */
  sent_at?: string;
  /** A company insider's open-market buy on a stock members own or watch. */
  insider?: Insider;
  /** Three or more insiders of one company buying within 30 days. */
  cluster?: Insider[];
  /** Accepted by EDGAR too long ago to send as news: held for the nightly digest instead. */
  late?: boolean;
  /** EDGAR acceptance time as the data run writes it. */
  accepted_at?: string;
  /** Filed by a followed non-curated filer: never sent to "every investor". */
  extra?: boolean;
  slug: string;
  manager: string;
  form: string;
  kind: 'form4' | '13d' | '13g';
  action: string;
  filing_date: string;
  url: string;
  issuer: string | null;
  display_name: string | null;
  ticker: string | null;
  shares: number | null;
  value_usd: number | null;
  avg_price: number | null;
  shares_after: number | null;
  percent_of_class: number | null;
  /** EDGAR acceptance (minute poll) and the detail the Worker parsed from the filing. */
  accepted?: string;
  /** Form 4: holdings per security class (Class A and Class B are separate CUSIPs). */
  classes?: Form4Class[];
  /** Form 4: the first and last transaction dates. */
  event_date?: string | null;
  last_transaction_date?: string | null;
  footnotes?: string[];
  cusip?: string | null;
  amendment_no?: number | null;
  /** Schedule 13D/G: the same filer's previous filing on this issuer. */
  prev_form?: string | null;
  prev_accession?: string | null;
  prev_percent_of_class?: number | null;
  prev_shares_after?: number | null;
  item4?: string | null;
  item5c?: string | null;
  /** Tickers members watch that this filing's subject company trades as (13D/G from any filer). */
  subject_tickers?: string[];
  /** Alerted before the filing could be read: details follow from the data run. */
  details_pending?: boolean;
  followup?: boolean;
}

interface Manager {
  slug: string;
  manager: string;
  name: string;
  cik: string;
  featured?: boolean;
  /** Filer type from the data run, e.g. hedge_fund, active, bank, broker, index. */
  type?: string | null;
  /** A non-curated 13F filer that a member follows; `report_date` is its latest quarter on file. */
  extra?: boolean;
  report_date?: string;
}

/** EDGAR filer CIK -> curated managers it reports for, built from index.json (incl. reported_by parents). */
type CikMap = Record<string, Manager[]>;

/** Times are ET-ish for day keys: EDGAR's filing day ends at 22:00 ET (03:00 UTC in winter). */
export const etDay = (t: number) => new Date(t - 5 * 3600_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Targeting and delivery

/** Filer types whose moves in a stock are worth an alert to someone who only watches or owns that stock. */
const STOCK_ALERT_TYPES = new Set(['hedge_fund', 'active']);
export type FilerMeta = Record<string, { featured?: boolean; type?: string | null }>;

/**
 * A watched or owned stock alerts only through active managers (hedge funds and other active
 * filers), never banks, brokers or index sponsors; otherwise filing season floods members (109 of
 * NVDA's 119 holders changed last quarter). Until the data run labels filer types, the featured
 * superinvestors stand in for active managers.
 */
function stockAlerts(meta: FilerMeta, slug: string): boolean {
  const m = meta[slug];
  if (!m) return false;
  return m.type ? STOCK_ALERT_TYPES.has(m.type) : !!m.featured;
}

/**
 * Holdterm Alerts: 13F filings from followed investors (every featured one when nobody is followed),
 * and 13D, 13G and Form 4 filings by a followed investor or on a followed stock.
 */
/**
 * Funds Holdterm holds back until their data is fixed (not on its live roster): Wilkinson Global (its book
 * merges Fiera's whole 13F), Check Capital (a wrong Q2 amendment), Aequim and Advent (mostly notes), Biglari
 * Capital (one company is 80% of the book).
 */
export const HOLDTERM_HOLDBACK = new Set(['0001764000', '0001032814', '0001728201', '0001097278', '0001334429', '0001334430']);

export function forHoldterm(f: Follows, filings: Alert13F[], events: AlertEvent[], meta: FilerMeta): { filings: Alert13F[]; events: AlertEvent[] } {
  const inv = new Set(f.investors);
  const stocks = new Set(f.stocks);
  const followed = (slug: string) => (inv.size ? inv.has(slug) : !!meta[slug]?.featured);
  const cikOf = (a: Alert13F) => a.sec_url.match(/\/data\/(\d+)\//)?.[1]?.padStart(10, '0') ?? '';
  return {
    filings: filings.filter((a) => a.slugs.some(followed) && !a.suspect_book && !HOLDTERM_HOLDBACK.has(cikOf(a))),
    events: events.filter((e) => (!!e.slug && followed(e.slug)) || [e.ticker, ...(e.subject_tickers ?? [])].some((t) => !!t && stocks.has(t))),
  };
}

/** Which of these filings and events a member gets, by their alert switch and follows. */
export function forMember(m: Member, f: Follows, filings: Alert13F[], events: AlertEvent[], meta: FilerMeta = {}): { filings: Alert13F[]; events: AlertEvent[] } {
  if (m.alerts === 'off') return { filings: [], events: [] };
  const all = m.alerts === 'all';
  const investors = new Set(Array.isArray(m.alerts) ? [...m.alerts, ...f.investors] : f.investors);
  const stocks = new Set(f.stocks);
  const fl = filings.filter(
    (x) =>
      (all && !x.extra) ||
      x.slugs.some((s) => investors.has(s)) ||
      (x.slugs.some((s) => stockAlerts(meta, s)) && x.tickers.some((t) => stocks.has(t))) ||
      // Any curated or followed fund revealing a position in a stock the member owns.
      (!!x.reveal && x.tickers.some((t) => f.owned.includes(t))),
  );
  const ev = events.filter(
    (e) =>
      (e.kind !== '13g' || f.include_13g) &&
      ((!!e.slug && ((all && !e.extra) || investors.has(e.slug) || (!!e.ticker && stocks.has(e.ticker) && stockAlerts(meta, e.slug)))) ||
        // A 13D/G on a stock the member owns or watches, from any filer.
        (e.kind !== 'form4' && f.any_13d !== false && (e.subject_tickers ?? []).some((t) => stocks.has(t))) ||
        // Company insiders buying on the open market, and clusters of them.
        (!!e.insider && f.insider_buys !== false && e.insider.bought_usd >= (f.insider_min_usd ?? 100_000) && (e.subject_tickers ?? []).some((t) => stocks.has(t))) ||
        (!!e.cluster && f.cluster_buys !== false && (e.subject_tickers ?? []).some((t) => stocks.has(t)))),
  );
  return {
    filings: fl.filter((x, i) => fl.findIndex((y) => y.accession === x.accession) === i),
    events: ev.filter((x, i) => ev.findIndex((y) => y.id === x.id) === i),
  };
}

async function filerMeta(env: Env): Promise<FilerMeta> {
  const meta: FilerMeta = {};
  for (const list of Object.values((await cikMap(env)) ?? {})) for (const m of list) meta[m.slug] = { featured: m.featured, type: m.type };
  return meta;
}

/**
 * Members who saved follows but never chose an alert scope still have the old "all" default:
 * move them to their followed funds once, and say so in their next email.
 */
async function scoped(env: Env, m: Member, f: Follows): Promise<Member> {
  if (m.alerts !== 'all' || m.alerts_chosen || !f.investors.length) return m;
  const next: Member = { ...m, alerts: f.investors, alerts_note: 'followed' };
  await putMember(env, next);
  return next;
}

/** Test and critic members: at most this many alert emails a UTC day; past it, feed, chat and webhooks only. */
export const TEST_MAIL_CAP = 10;
const testMailKey = (customer: string, now: number) => `mailn:${customer}:${new Date(now).toISOString().slice(0, 10)}`;
/** Leading-edge window: when email runs short, a member's first alert goes at once; later ones within it go as one email at its end. */
export const COALESCE_MS = 20 * 60_000;
const HELD = 'mail:held';
interface Held {
  until: number;
  filings: Alert13F[];
  events: AlertEvent[];
}

/**
 * Whether the day's email budget is tight: what both providers can still send against the projection for the rest
 * of the UTC day (the alert emails of the last two hours, at that rate). While it covers the projection, every alert
 * email goes at once.
 */
async function emailPressure(env: Env, now: number): Promise<{ room: number; projected: number }> {
  const { mailRoom } = await import('./email');
  const hour = Math.floor(now / 3600_000);
  const recent = (JSON.parse((await env.DB.get('stats:sent')) ?? '[]') as [number, number][]).filter(([h]) => h >= hour - 1).reduce((a, [, n]) => a + n, 0);
  const hoursLeft = 24 - (now % 86_400_000) / 3600_000;
  return { room: await mailRoom(env), projected: Math.ceil((recent / 2) * hoursLeft) };
}

/** Every minute: held alerts whose window has ended go out as one email per member, timed by that send. */
export async function flushHeld(env: Env, now: number): Promise<Record<string, unknown>> {
  const index = JSON.parse((await env.DB.get(HELD)) ?? '{}') as Record<string, number>;
  const due = Object.entries(index).filter(([, until]) => until <= now).map(([c]) => c);
  if (!due.length) return {};
  const mails = [];
  const sentWith: { filings: Alert13F[]; events: AlertEvent[] }[] = [];
  for (const c of due) {
    const w = JSON.parse((await env.DB.get(`mailwin:${c}`)) ?? 'null') as Held | null;
    await env.DB.delete(`mailwin:${c}`);
    delete index[c];
    const m = await getMember(env, c);
    if (!w || !m?.email || (!w.filings.length && !w.events.length) || !isActive(m)) continue;
    const f = await getFollows(env, m);
    const test = !!m.test || testAddress(m.email);
    if (test && Number((await env.DB.get(testMailKey(c, now))) ?? 0) >= TEST_MAIL_CAP) continue;
    if (test) await env.DB.put(testMailKey(c, now), String(Number((await env.DB.get(testMailKey(c, now))) ?? 0) + 1), { expirationTtl: 2 * 86400 });
    mails.push({ ...alertMail(env, m.email, w.filings, w.events, f, m), test, ids: [...w.filings.map((a) => a.accession), ...w.events.map((e) => e.id)] });
    sentWith.push(w);
  }
  await env.DB.put(HELD, JSON.stringify(index));
  if (!mails.length) return { held_flushed: 0 };
  const status = await sendMail(env, mails, { bulk: true });
  await logSent(env, mails.length, now);
  // Coalesced emails are timed as they went: a row per item at this send, tagged coalesced.
  const sentAt = Date.now();
  await logLatency(env, sentWith.flatMap((w) => w.filings.filter((a) => !a.moves_pending).map((a) => ({ ...a, kind: '13f', coalesced: true }))), sentAt);
  await logLatency(env, sentWith.flatMap((w) => w.events.filter((e) => !e.followup).map((e) => ({ slug: e.slug || e.subject_tickers?.join(',') || '', manager: e.manager, form: e.form, kind: e.kind, accession: e.id, accepted: e.accepted, extra: !e.slug, coalesced: true }))), sentAt);
  return { held_flushed: mails.length, status };
}

/**
 * Once, on the polling host: 13F latency rows logged before rows were tagged `moves` (Nov 9-11) are re-timed from
 * the day stores (what went out, and when). A first email that carried the moves keeps its time; otherwise the
 * follow-up's send, tagged followup; otherwise never_moves. Duplicates of a filing's moves row are dropped.
 */
export async function retimeLatency(env: Env): Promise<Record<string, unknown>> {
  if (await env.DB.get('latency:retimed:v1')) return {};
  type Row = { kind?: string; accession: string; accepted: string; sent: string; seconds: number; moves?: boolean; followup?: boolean; never_moves?: boolean };
  const seen = new Map<string, { first?: boolean; followup?: string }>();
  // The days since rows went untagged (Nov 8-11): few day stores, so the Worker's CPU limit holds.
  for (let d = 0; d < 5; d++) {
    const day = JSON.parse((await env.DB.get(`digest:${new Date(Date.now() - 5 * 3600_000 - d * 86_400_000).toISOString().slice(0, 10)}`)) ?? '{"filings":[]}') as { filings: (Alert13F & { sent_at?: string })[] };
    for (const f of day.filings) {
      const s = seen.get(f.accession) ?? {};
      if (f.followup && f.sent_at && (!s.followup || f.sent_at < s.followup)) s.followup = f.sent_at;
      if (!f.followup && f.moves) s.first = true;
      seen.set(f.accession, s);
    }
  }
  const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as Row[];
  const tagged = new Set(log.filter((l) => (l.kind ?? '13f') === '13f' && l.moves).map((l) => l.accession));
  const n = { kept: 0, retimed: 0, never_moves: 0, dropped_duplicates: 0, tagged_followup: 0 };
  const out: Row[] = [];
  for (const l of log) {
    if ((l.kind ?? '13f') !== '13f') {
      out.push(l);
      continue;
    }
    const s = seen.get(l.accession);
    if (l.moves) {
      // A moves row whose first email had none (the backlog sent after the fix): a follow-up.
      if (!l.followup && s?.followup && !s.first) (l.followup = true), n.tagged_followup++;
      out.push(l);
      continue;
    }
    if (tagged.has(l.accession)) {
      n.dropped_duplicates++;
      continue;
    }
    if (s?.first) out.push({ ...l, moves: true }), n.kept++;
    else if (s?.followup) out.push({ ...l, moves: true, followup: true, sent: s.followup, seconds: Math.round((Date.parse(s.followup) - Date.parse(l.accepted)) / 1000) }), n.retimed++;
    else out.push({ ...l, never_moves: true }), n.never_moves++;
    tagged.add(l.accession);
  }
  await env.DB.put('alerts:latency', JSON.stringify(out));
  await env.DB.put('latency:retimed:v1', JSON.stringify({ at: new Date().toISOString(), ...n }));
  return { latency_retimed: n };
}

/** Clears the one-time note once an email carrying it has been handed to the mailer. */
async function noted(env: Env, m: Member): Promise<void> {
  if (m.alerts_note) await putMember(env, { ...m, alerts_note: undefined });
}

/** A Form 4 or 13D/G accepted more than this long ago is no longer news: it waits for the digest. */
export const LATE_MS = 6 * 3600_000;

/** Late when EDGAR accepted it over 6 hours ago; with only a filing date, 6 hours after that day ends. */
export function isLate(e: AlertEvent, now: number): boolean {
  const at = e.accepted ?? e.accepted_at;
  if (at) return now - Date.parse(at) > LATE_MS;
  return now - Date.parse(e.filing_date) > DAY + LATE_MS;
}

/** The last 1,000 Form 4 and 13D/G events the minute poll parsed, newest first (KV v1:events). Follow-ups replace their first record. */
async function rememberEvents(env: Env, events: AlertEvent[]): Promise<void> {
  const real = events.filter((e) => !e.cluster && e.id);
  if (!real.length) return;
  const keep = ({ late, followup, details_pending, subject_tickers, insider, ...e }: AlertEvent) => ({ ...e, ...(insider ? { insider: { name: insider.name, roles: insider.roles, bought_usd: insider.bought_usd } } : {}), ...(details_pending && !followup ? { details_pending } : {}) });
  const ring = JSON.parse((await env.DB.get('v1:events')) ?? '[]') as AlertEvent[];
  const k = (e: AlertEvent) => `${e.id}|${e.slug}`;
  const ids = new Set(real.map(k));
  await env.DB.put('v1:events', JSON.stringify([...real.map(keep), ...ring.filter((e) => !ids.has(k(e)))].slice(0, 1000)));
}

type DigestDay = { filings: Alert13F[]; events: AlertEvent[]; late?: AlertEvent[] };

/** One stored event through the fan-out to the given members only (an operator's replay): no digest store, no late split. */
export async function deliverTo(env: Env, e: AlertEvent, only: Set<string>, now: number) {
  return deliver(env, [], [e], now, only);
}

export async function deliver(env: Env, filings: Alert13F[], allEvents: AlertEvent[], now: number, only?: Set<string>): Promise<{ emails: number; digest: number; mail: string; late?: number }> {
  if (!filings.length && !allEvents.length) return { emails: 0, digest: 0, mail: 'none' };
  if (only) return fanOut(env, filings, allEvents, now, [], only);
  // Old filings are never presented as news: they go to tonight's digest as "earlier filings".
  // Follow-ups complete an alert already sent, so they go out whenever they're ready.
  // /v1/events serves what the poll parsed (acceptance, classes, prior stake), newest first.
  await rememberEvents(env, allEvents);
  const late = allEvents.filter((e) => !e.followup && isLate(e, now)).map((e) => ({ ...e, late: true }));
  const events = allEvents.filter((e) => e.followup || !isLate(e, now));
  // Everything goes in the day's digest store; digest members get it from there tonight.
  const key = `digest:${etDay(now)}`;
  const day = JSON.parse((await env.DB.get(key)) ?? '{"filings":[],"events":[]}') as DigestDay;
  const sent_at = new Date(now).toISOString();
  day.filings.push(...filings.map((a) => ({ ...a, sent_at })));
  day.events.push(...events.map((e) => ({ ...e, sent_at })));
  day.late = [...(day.late ?? []), ...late];
  // Kept a month: a new private feed is seeded from the last 30 days.
  await env.DB.put(key, JSON.stringify(day), { expirationTtl: 31 * 86400 });
  if (!filings.length && !events.length) return { emails: 0, digest: 0, mail: 'none', late: late.length };
  return fanOut(env, filings, events, now, late);
}

/** Each member's share of these alerts: email (unless they take the digest), chat, webhook and feed. */
async function fanOut(env: Env, filings: Alert13F[], events: AlertEvent[], now: number, late: AlertEvent[], only?: Set<string>): Promise<{ emails: number; digest: number; mail: string; late?: number; chats?: string; paused_notes?: number }> {
  const meta = await filerMeta(env);
  filings = await withCards(env, filings);
  const mails = [];
  const notes: Member[] = [];
  const chats: string[] = [];
  // Chat and webhook destinations already posted to in this delivery (per alert): a destination shared
  // by several members, such as a Fund team's Slack, gets each alert once.
  const posted = new Set<string>();
  let digest = 0;
  let held = 0;
  let testCapped = 0;
  let pressure: { room: number; projected: number } | undefined;
  let heldIndex: Record<string, number> | undefined;
  // Paused members' followed funds that filed a 13F: one "resume now" note per member per ET day.
  const pausedNotes: { m: Member; key: string }[] = [];
  const news = filings.filter((x) => !x.followup && !x.reveal);
  for (const raw of await listMembers(env)) {
    if (!only && news.length && isPaused(raw, now) && raw.status === 'active' && raw.email && raw.alerts !== 'off' && raw.plan !== 'holdterm' && !raw.marketing_off) {
      const f = await getFollows(env, raw);
      const funds = new Set([...(Array.isArray(raw.alerts) ? raw.alerts : []), ...f.investors]);
      const hit = news.filter((x) => (raw.alerts === 'all' && !x.extra) || x.slugs.some((s) => funds.has(s)));
      const key = `pausenote:${raw.customer}:${etDay(now)}`;
      if (hit.length && !(await env.DB.get(key))) {
        mails.push(pausedFilingMail(raw, hit, await resumeUrl(env, raw), await unsubscribeUrl(env, raw.customer)));
        pausedNotes.push({ m: raw, key });
      }
      continue;
    }
    if (!isActive(raw) || !raw.email || raw.alerts === 'off' || (only && !only.has(raw.customer))) continue;
    if (raw.plan === 'holdterm') {
      // Holdterm members get Holdterm-branded alerts, never Copybook's.
      const mine = forHoldterm(await getFollows(env, raw), filings, events, meta);
      if (mine.filings.length || mine.events.length) mails.push({ ...holdtermAlertMail(env, raw.email, mine.filings, mine.events), test: !!raw.test || testAddress(raw.email), ids: [...mine.filings.map((a) => a.accession), ...mine.events.map((e) => e.id)] });
      continue;
    }
    // An operator's hand-off replay (test members only): the filer counts as followed, and it goes by email alone.
    const replay = !!only && filings.some((a) => a.replay_to?.includes(raw.customer));
    const f0 = await getFollows(env, raw);
    const f = replay ? { ...f0, investors: [...new Set([...f0.investors, ...filings.flatMap((a) => a.slugs)])] } : f0;
    const m = await scoped(env, raw, f);
    const mine = forMember(m, f, filings, events, meta);
    if (!mine.filings.length && !mine.events.length) continue;
    await countAlerts(env, m.customer, mine.filings, mine.events, f.owned, now, !!only);
    // Chat, feed and webhook get every alert as it happens, whatever the email schedule.
    const ch = replay ? ({} as Awaited<ReturnType<typeof getChannels>>) : await getChannels(env, m.customer);
    if (ch.discord || ch.slack || ch.telegram) chats.push(...Object.entries(await sendChats(env, m.customer, ch, mine.filings, mine.events, f, now, posted)).map(([k, v]) => `${k} ${v}`));
    if (ch.webhook) await sendWebhooks(env, m, ch, mine.filings, mine.events, now, posted);
    if (ch.feed_token) await addToFeed(env, m, ch, mine.filings, mine.events, now);
    // Without a feed, what was delivered is remembered (ids by day, 30 days) so a feed created later
    // starts with exactly what the member got, whatever their scope is by then.
    else if (!only) await rememberDelivered(env, m.customer, now, [...mine.filings.map((a) => `${a.accession}${a.followup ? ':moves' : ''}`), ...mine.events.map((e) => `${e.id}${e.followup ? ':details' : ''}`)]);
    if (f.digest) digest++;
    else {
      const test = !!m.test || testAddress(m.email);
      // Test members: at most TEST_MAIL_CAP alert emails a day; past that, the feed, chat and webhooks above only.
      const n = test && !only ? Number((await env.DB.get(testMailKey(m.customer, now))) ?? 0) : 0;
      if (test && !only && n >= TEST_MAIL_CAP) {
        testCapped++;
        continue;
      }
      let send = { filings: mine.filings, events: mine.events };
      if (!only) {
        const win = JSON.parse((await env.DB.get(`mailwin:${m.customer}`)) ?? 'null') as Held | null;
        const open = win && win.until > now;
        pressure ??= await emailPressure(env, now);
        const tight = pressure.room - mails.length <= pressure.projected;
        if (tight && open) {
          // Inside this member's window while email is short: held, sent with the window's other alerts at its end.
          await env.DB.put(`mailwin:${m.customer}`, JSON.stringify({ ...win, filings: [...win.filings, ...mine.filings], events: [...win.events, ...mine.events] }));
          held++;
          continue;
        }
        // Anything still held goes out with this email (the window ended, or email is no longer short).
        if (win && (win.filings.length || win.events.length)) send = { filings: [...win.filings, ...mine.filings], events: [...win.events, ...mine.events] };
        if (tight) {
          await env.DB.put(`mailwin:${m.customer}`, JSON.stringify({ until: now + COALESCE_MS, filings: [], events: [] } satisfies Held));
          (heldIndex ??= JSON.parse((await env.DB.get(HELD)) ?? '{}') as Record<string, number>)[m.customer] = now + COALESCE_MS;
        } else if (win) {
          await env.DB.delete(`mailwin:${m.customer}`);
          if ((heldIndex ??= JSON.parse((await env.DB.get(HELD)) ?? '{}') as Record<string, number>)[m.customer]) delete heldIndex[m.customer];
        }
      }
      if (test && !only) await env.DB.put(testMailKey(m.customer, now), String(n + 1), { expirationTtl: 2 * 86400 });
      const am = alertMail(env, m.email, send.filings, send.events, f, m);
      mails.push({ ...am, ...(replay ? { subject: `Replay (test): ${am.subject}` } : {}), test, ids: [...send.filings.map((a) => a.accession), ...send.events.map((e) => e.id)] });
      notes.push(m);
    }
  }
  if (heldIndex) await env.DB.put(HELD, JSON.stringify(heldIndex));
  const mail = await sendMail(env, mails, { bulk: true });
  await logSent(env, mails.length, now);
  await flushChannelLatency(env, !only);
  if (mail.split(',').every((s) => s === '200')) for (const m of notes) await noted(env, m);
  for (const p of pausedNotes) await env.DB.put(p.key, '1', { expirationTtl: 2 * 86400 });
  return { emails: mails.length, digest, mail, ...(held ? { held } : {}), ...(testCapped ? { test_capped: testCapped } : {}), ...(pausedNotes.length ? { paused_notes: pausedNotes.length } : {}), ...(chats.length ? { chats: chats.join(', ') } : {}), ...(late.length ? { late: late.length } : {}) };
}

type Delivered = { day: string; ids: string[] }[];

async function rememberDelivered(env: Env, customer: string, now: number, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const key = `delivered:${customer}`;
  const day = etDay(now);
  const log = (JSON.parse((await env.DB.get(key)) ?? '[]') as Delivered).filter((d) => d.day >= etDay(now - 30 * DAY));
  const today = log.find((d) => d.day === day) ?? (log.unshift({ day, ids: [] }), log[0]);
  today.ids = [...new Set([...today.ids, ...ids])].slice(-50);
  await env.DB.put(key, JSON.stringify(log), { expirationTtl: 31 * 86400 });
}

/**
 * A member's alerts from the last `days` days' stores, newest first (at most 20): what a new private
 * feed starts with. Every alert actually delivered (the delivery log), plus what their follows match
 * now for days before that log existed.
 */
export async function recentFeed(env: Env, raw: Member, now: number, days = 30): Promise<FeedItem[]> {
  const f = await getFollows(env, raw);
  const m = await scoped(env, raw, f);
  const meta = await filerMeta(env);
  const got = new Set((JSON.parse((await env.DB.get(`delivered:${raw.customer}`)) ?? '[]') as Delivered).flatMap((d) => d.ids));
  const out: FeedItem[] = [];
  for (let d = 0; d < days && out.length < 20; d++) {
    const day = await env.DB.get(`digest:${etDay(now - d * 86_400_000)}`);
    if (!day) continue;
    const { filings, events } = JSON.parse(day) as DigestDay;
    const mine = forMember(m, f, filings, events, meta);
    const fl = filings.filter((a) => got.has(`${a.accession}${a.followup ? ':moves' : ''}`) || mine.filings.includes(a));
    const ev = events.filter((e) => got.has(`${e.id}${e.followup ? ':details' : ''}`) || mine.events.includes(e));
    out.push(...feedItems(env, fl, ev, now, true).filter((i) => !out.some((x) => x.id === i.id)));
  }
  return out.sort((a, b) => (b.sent ?? b.published).localeCompare(a.sent ?? a.published)).slice(0, 20);
}

/** After EDGAR closes: one email per digest member with the day's filings and events they follow. */
export async function runDigest(env: Env, now: number): Promise<{ emails: number; status: string }> {
  const day = etDay(now);
  const raw = await env.DB.get(`digest:${day}`);
  if (!raw) return { emails: 0, status: 'none' };
  const { filings: stored, events, late = [] } = JSON.parse(raw) as DigestDay;
  const meta = await filerMeta(env);
  const filings = await withCards(env, stored);
  const mails = [];
  const notes: Member[] = [];
  for (const raw of await listMembers(env)) {
    if (!isActive(raw) || !raw.email || raw.alerts === 'off' || raw.plan === 'holdterm') continue;
    const f = await getFollows(env, raw);
    const m = await scoped(env, raw, f);
    // Digest members get the whole day; everyone else only the late filings they never got.
    const mine = f.digest ? forMember(m, f, filings, [...events, ...late], meta) : forMember(m, f, [], late, meta);
    if (mine.filings.length || mine.events.length) {
      mails.push(digestMail(env, m.email, day, mine.filings, mine.events, f, m, !f.digest));
      if (f.digest) notes.push(m);
    }
  }
  const status = await sendMail(env, mails, { bulk: true });
  await logSent(env, mails.length, now);
  if (status.split(',').every((s) => s === '200')) for (const m of notes) await noted(env, m);
  return { emails: mails.length, status };
}

// ---------------------------------------------------------------------------------------------
// 13F filings

/**
 * Advances the forward-only period state for one filing. A slug alerts only when the filing is a
 * 13F-HR original for a period later than any seen for it; first sightings only record state.
 */
function advance(periods: Record<string, string>, slugs: string[], report_date: string): { fresh: string[]; prev: Record<string, string> } {
  const fresh: string[] = [];
  const prev: Record<string, string> = {};
  for (const s of slugs) {
    const p = periods[s];
    if (p && report_date <= p) continue;
    periods[s] = report_date;
    if (p) {
      fresh.push(s);
      prev[s] = p;
    }
  }
  return { fresh, prev };
}

async function cikMap(env: Env): Promise<CikMap | null> {
  const raw = await env.DB.get('alerts:ciks');
  return raw ? (JSON.parse(raw) as CikMap) : null;
}

/** Non-curated 13F filers that members follow, by CIK (KV alerts:extra, written when follows are saved). */
async function extraMap(env: Env): Promise<CikMap> {
  return JSON.parse((await env.DB.get('alerts:extra')) ?? '{}') as CikMap;
}

const quarterEnd = (q: string) => `${q.slice(0, 4)}-${['03-31', '06-30', '09-30', '12-31'][Number(q[5]) - 1]}`;

/**
 * Checks followed investor slugs: curated ones pass; any other 13F filer is looked up in the data
 * run's filers.json and added to KV alerts:extra so the minute poll watches its CIK. Returns the
 * slugs that are no 13F filer at all.
 */
export async function resolveFollowedFilers(env: Env, slugs: string[]): Promise<string[]> {
  const curated = new Set(Object.values((await cikMap(env)) ?? {}).flatMap((ms) => ms.map((m) => m.slug)));
  const extra = await extraMap(env);
  const known = new Set(Object.values(extra).flatMap((ms) => ms.map((m) => m.slug)));
  const missing = slugs.filter((s) => !curated.has(s) && !known.has(s));
  if (!missing.length) return [];
  // 1.6 MB: find each slug's flat record by string search instead of parsing the whole list. gene's local copy first.
  const text = await (await import('./v1data')).dataText(env, 'filers.json');
  if (!text) throw new Error('filers.json not loaded yet');
  const unknown: string[] = [];
  for (const slug of missing) {
    const i = text.search(new RegExp(`"slug":\\s*"${slug}"`));
    if (i < 0) {
      unknown.push(slug);
      continue;
    }
    try {
      const f = JSON.parse(text.slice(text.lastIndexOf('{', i), text.indexOf('}', i) + 1)) as { cik: string; name: string; quarter?: string };
      const cik = f.cik.padStart(10, '0');
      (extra[cik] ??= []).push({ slug, manager: f.name, name: f.name, cik, featured: false, type: null, extra: true, ...(f.quarter ? { report_date: quarterEnd(f.quarter) } : {}) });
    } catch {
      unknown.push(slug);
    }
  }
  if (unknown.length < missing.length) {
    await saveExtra(env, extra);
    // Keep each new filer's current book as its baseline now: the data run will replace the shard
    // with the next quarter, possibly before that quarter's 13F reaches us.
    for (const [cik, ms] of Object.entries(extra)) if (ms.some((m) => missing.includes(m.slug))) await snapshotBaseline(env, cik).catch(() => false);
  }
  return unknown;
}

/** Drops non-curated filers nobody follows any more (hourly). */
async function pruneExtra(env: Env, followed: Set<string>): Promise<void> {
  const extra = await extraMap(env);
  const before = JSON.stringify(extra);
  for (const [cik, ms] of Object.entries(extra)) {
    const keep = ms.filter((m) => followed.has(m.slug));
    if (keep.length) extra[cik] = keep;
    else delete extra[cik];
  }
  if (JSON.stringify(extra) !== before) await saveExtra(env, extra);
}

/** Curated managers plus followed non-curated filers; a CIK in both stays curated. */
const withExtra = (ciks: CikMap, extra: CikMap): CikMap => ({ ...extra, ...ciks });

/**
 * Saves the followed non-curated filers, and the list of their CIKs (no member data) for the data
 * run, which back-fills a prior quarter for each: R2 followed/ciks.json, served to the data
 * workflow at GET /ingest/followed.json.
 */
async function saveExtra(env: Env, extra: CikMap): Promise<void> {
  await env.DB.put('alerts:extra', JSON.stringify(extra));
  await writeFollowedCiks(env, extra);
}

/** followed/ciks.json: followed and peer non-curated filers (alerts:extra) plus non-curated filers whose 13F is a member's linked book (KV followed:book-ciks, hourly). */
async function writeFollowedCiks(env: Env, extra: CikMap): Promise<void> {
  const books = JSON.parse((await env.DB.get('followed:book-ciks')) ?? '[]') as string[];
  const ciks = [...new Set([...Object.keys(extra), ...books])].sort();
  await env.HIST.put('followed/ciks.json', JSON.stringify({ updated_at: new Date().toISOString(), ciks }), { httpMetadata: { contentType: 'application/json' } });
}

const baselineKey = (cik: string, reportDate: string) => `b/${cik}/${reportDate}.json`;

/** Rows of an all-filer shard (data/f/{cik}.json) as positions. */
function shardPositions(d: { columns: string[]; rows: unknown[][] }): Position[] {
  const at = (k: string) => d.columns.indexOf(k);
  const [t, is, cu, pc, sh, v, dn] = ['ticker', 'issuer', 'cusip', 'put_call', 'shares', 'value', 'display_name'].map(at);
  return d.rows.map((r) => ({ ticker: r[t] as string | null, issuer: r[is] as string, cusip: r[cu] as string, put_call: (r[pc] as string | null) ?? null, shares: Number(r[sh]), value: Number(r[v]), display_name: (r[dn] as string | null) ?? null }));
}

/** Copies a non-curated filer's current shard into R2 as the baseline for its next quarter. */
async function snapshotBaseline(env: Env, cik: string): Promise<boolean> {
  const res = await fetch(`${env.DATA_URL}f/${cik}.json`);
  if (!res.ok) return false;
  const d = (await res.json()) as { report_date?: string; accession?: string; columns?: string[]; rows?: unknown[][] };
  if (!d.report_date || !d.columns || !d.rows) return false;
  if (await env.HIST.get(baselineKey(cik, d.report_date))) return true;
  await env.HIST.put(baselineKey(cik, d.report_date), JSON.stringify({ report_date: d.report_date, accession: d.accession ?? null, holdings: shardPositions({ columns: d.columns, rows: d.rows }) }));
  return true;
}

/** A non-curated filer's book for a quarter: the R2 snapshot, else the all-filer shard if it is that quarter. */
async function filerShardBook(env: Env, cik: string, reportDate: string): Promise<Position[] | null> {
  const snap = await env.HIST.get(baselineKey(cik, reportDate));
  if (snap) return ((await new Response(snap.body).json()) as { holdings: Position[] }).holdings;
  const res = await fetch(`${env.DATA_URL}f/${cik}.json`);
  if (!res.ok) return null;
  const d = (await res.json()) as { report_date?: string; columns?: string[]; rows?: unknown[][] };
  if (d.report_date !== reportDate || !d.columns || !d.rows) return null;
  return shardPositions({ columns: d.columns, rows: d.rows });
}

/** Tickers and names for CUSIPs from the public securities map, without parsing all of it. */
export async function lookupTickers(env: Env, rows: { cusip: string; ticker: string | null; display_name: string | null }[]): Promise<void> {
  const missing = rows.filter((r) => !r.ticker);
  if (!missing.length) return;
  const res = await fetch(`${env.DATA_URL}securities.json`, { cf: { cacheTtl: 86400 } } as RequestInit);
  if (!res.ok) return;
  const text = await res.text();
  for (const r of missing) {
    const i = text.indexOf(`"${r.cusip}":{`);
    if (i < 0) continue;
    try {
      const s = JSON.parse(text.slice(i + r.cusip.length + 3, text.indexOf('}', i) + 1)) as { ticker?: string; name?: string };
      r.ticker = s.ticker ?? null;
      r.display_name = r.display_name ?? s.name ?? null;
    } catch {
      /* leave the issuer name */
    }
  }
}

const prevQuarter = (q: string) => (q.endsWith('Q1') ? `${Number(q.slice(0, 4)) - 1}Q4` : `${q.slice(0, 5)}${Number(q[5]) - 1}`);

/**
 * Other filers' value per share for each CUSIP, from the holder index (R2 hl/{issuer6}.json, else the public
 * top 25): the median for `quarter` (rows of that period) and for the quarter before (their prior values),
 * each from at least 3 filers. Share rows only.
 */
export async function perShareMedians(env: Env, cusips: string[], quarter: string): Promise<Map<string, PerShare>> {
  const out = new Map<string, PerShare>();
  const prevQ = prevQuarter(quarter);
  const median = (xs: number[]) => (xs.length >= 3 ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  for (const cusip of cusips) {
    try {
      const code = cusip.slice(0, 6).toUpperCase();
      const obj = await env.HIST.get(`hl/${code}.json`);
      const res = obj ? null : await fetch(`${env.DATA_URL}hl/${code}.json`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = obj ? await new Response(obj.body).json() : res?.ok ? await res.json() : null;
      if (!d?.columns || !d.rows) continue;
      const at = (k: string) => (d.columns as string[]).indexOf(k);
      const [iP, iS, iPs, iV, iPv, iPc] = ['period', 'shares', 'prev_shares', 'value', 'prev_value', 'put_call'].map(at);
      const cur: number[] = [];
      const prev: number[] = [];
      for (const r of d.rows as unknown[][]) {
        if (iPc >= 0 && r[iPc]) continue;
        const s = Number(r[iS]), v = Number(r[iV]), ps = Number(r[iPs]), pv = Number(r[iPv]);
        if (r[iP] === quarter && s > 0 && v > 0) cur.push(v / s);
        if (r[iP] === prevQ && s > 0 && v > 0) prev.push(v / s);
        if (r[iP] === quarter && ps > 0 && pv > 0) prev.push(pv / ps);
      }
      out.set(cusip, { cur: median(cur), prev: median(prev) });
    } catch {
      // No cross-check for this CUSIP: the per-quarter rule still applies.
    }
  }
  return out;
}

/** Stock splits in the data run's splits.json that took effect in this quarter, by CUSIP and ticker (a share-count change that's no unit error). */
let SPLITS: { at: number; list: { cusip: string; ticker?: string; to_quarter: string }[] } | null = null;
export async function splitsFor(env: Env, quarter: string): Promise<Set<string>> {
  if (!SPLITS || Date.now() - SPLITS.at > 3600_000) {
    try {
      const r = await fetch(`${env.DATA_URL}splits.json`);
      SPLITS = { at: Date.now(), list: r.ok ? (((await r.json()) as { splits?: { cusip: string; ticker?: string; to_quarter: string }[] }).splits ?? []) : [] };
    } catch {
      SPLITS = { at: Date.now(), list: [] };
    }
  }
  return new Set(SPLITS.list.filter((x) => x.to_quarter === quarter).flatMap((x) => [x.cusip, ...(x.ticker ? [x.ticker] : [])]));
}

async function priorBook(env: Env, slug: string, reportDate: string, maxBytes = 2_000_000): Promise<Position[] | null> {
  const obj = await env.HIST.get(`h/${slug}/${quarterOf(reportDate)}.json`);
  if (!obj || (obj.size ?? 0) > maxBytes) return null;
  return ((await new Response(obj.body).json()) as { holdings?: Position[] }).holdings ?? null;
}

/** How far back each poll pages through the latest-filings feed; covers a few failed polls. */
const LOOKBACK_MS = 10 * 60_000;
/** 500 entries: on the Nov 14, 2025 deadline EDGAR took 1,731 13F-HRs in a day. */
const MAX_PAGES = 5;
/** SEC requests one 13F needs: filing index, cover page, information table. */
const SEC_PER_FILING = 3;
/** SEC requests the 13F poll leaves for the Form 4 and 13D/G poll in the same minute. */
const EVENT_POLL_RESERVE = 10;

/** Feed pages, newest first, until one reaches back past `since` (or the page cap). */
async function feedSince(type: string, since: number): Promise<FeedEntry[]> {
  const out: FeedEntry[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const entries = await latestFilings(type, page * 100);
    out.push(...entries);
    const last = entries[entries.length - 1];
    if (entries.length < 100 || !last || Date.parse(last.accepted) < since) break;
  }
  return out;
}

/** This minute's company-feed checks: 3 featured filers and 3 of all, cycling without stored state. */
export function rotation(ciks: CikMap, minute: number, n = 3): string[] {
  const all = Object.keys(ciks).sort();
  const featured = all.filter((c) => ciks[c].some((m) => m.featured));
  const pick = (list: string[]) => Array.from({ length: Math.min(n, list.length) }, (_, i) => list[(minute * n + i) % list.length]);
  return [...new Set([...pick(featured), ...pick(all)])];
}

/**
 * Every minute: EDGAR's latest 13F-HR filings, matched to curated managers by CIK, emailed with the
 * moves computed here from the filing and last quarter's book in R2. KV is written only when a
 * curated manager has filed, so the minute cron stays inside the free tier.
 */
/**
 * A NEW HOLDINGS amendment as an alert: the positions it adds, each with its share of the amended
 * book (the period's book plus the amendment, unless the data run already merged it). Returns
 * undefined when EDGAR couldn't be read, null when there is nothing to send.
 */
async function revealAlert(env: Env, e: FeedEntry, meta: FilingMeta, mgrs: Manager[], isExtra: boolean): Promise<Alert13F | null | undefined> {
  const f = await fetch13F(e.cik, e.accession);
  if (!f) return undefined;
  if (!f.holdings?.length) return null;
  const lead = mgrs.find((m) => m.featured) ?? mgrs.find((m) => m.cik === e.cik) ?? mgrs[0];
  const quarter = quarterOf(f.report_date);
  // The period's book as served (curated: R2 history; others: the follow-time snapshot).
  let total: number | null = null;
  if (isExtra) {
    const b = await filerShardBook(env, e.cik, f.report_date);
    total = b ? b.reduce((a, h) => a + h.value, 0) : null;
  } else {
    const obj = await env.HIST.get(`h/${lead.slug}/${quarter}.json`);
    if (obj && (obj.size ?? 0) < 2_000_000) {
      const q = (await new Response(obj.body).json()) as { total_value?: number; amendments?: (string | { accession: string })[] };
      const merged = (q.amendments ?? []).some((a) => (typeof a === 'string' ? a : a.accession) === e.accession);
      total = q.total_value != null ? q.total_value : null;
      if (total != null && !merged) total += f.holdings.reduce((a, h) => a + h.value, 0);
    }
  }
  const rows: MoveRow[] = [...f.holdings]
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
    .map((h) => ({ ticker: null, display_name: null, issuer: h.issuer, cusip: h.cusip, put_call: h.put_call, shares: h.shares, prev_shares: 0, value: h.value, value_delta: h.value, delta_pct_of_book: total ? h.value / total : null }));
  await lookupTickers(env, rows);
  return {
    slug: lead.slug,
    slugs: mgrs.map((m) => m.slug),
    manager: lead.manager,
    name: lead.name,
    quarter,
    report_date: f.report_date,
    filing_date: e.accepted.slice(0, 10),
    accession: e.accession,
    sec_url: `https://www.sec.gov/Archives/edgar/data/${Number(e.cik)}/${e.accession.replace(/-/g, '')}/${e.accession}-index.html`,
    accepted: e.accepted,
    moves: null,
    tickers: [...new Set(rows.map((r) => r.ticker).filter((t): t is string => !!t))],
    reveal: { confidential: meta.confidential_treatment_expired === true, amendment_no: meta.amendment_no, book_total: total, rows },
    ...(isExtra ? { extra: true } : {}),
  };
}

export async function runPoll(env: Env, now: number): Promise<Record<string, unknown>> {
  const curated = await cikMap(env);
  if (!curated) return { status: 'no cik map yet' };
  const extra = await extraMap(env);
  const ciks = withExtra(curated, extra);
  const errors: string[] = [];
  let entries: FeedEntry[] = [];
  try {
    entries = await feedSince('13F-HR', now - LOOKBACK_MS);
  } catch (err) {
    errors.push(String(err));
  }
  // Filings the missed-filing detector found unsent past their window (KV missed:queue).
  entries.push(...(await missedQueue(env)).filter((e) => e.form.startsWith('13F-HR')));
  // Backstop for a filing the feed pages missed (a failed poll, or a deadline-day burst): a few
  // curated filers' own feeds each minute, in rotation, featured managers more often, and the
  // followed non-curated filers too.
  const minute = Math.floor(now / 60_000);
  for (const cik of [...new Set([...rotation(curated, minute), ...rotation(extra, minute, 2)])]) {
    try {
      entries.push(...(await companyFilings(cik, '13F-HR')));
    } catch (err) {
      errors.push(String(err));
    }
  }
  const ids = new Set<string>();
  const feed = entries.filter((e) => (e.form === '13F-HR' || e.form === '13F-HR/A') && ciks[e.cik] && now - Date.parse(e.accepted) <= MAX_ALERT_AGE_DAYS * DAY && !ids.has(e.accession) && !!ids.add(e.accession));
  if (!feed.length) return { status: 'none', ...(errors.length ? { errors } : {}) };
  const handled = JSON.parse((await env.DB.get('alerts:handled')) ?? '[]') as string[];
  const todo = feed.filter((e) => !handled.includes(e.accession));
  if (!todo.length) return { status: 'none', ...(errors.length ? { errors } : {}) };

  const rawPeriods = await env.DB.get('alerts:periods');
  const periods = JSON.parse(rawPeriods ?? '{}') as Record<string, string>;
  const fresh: Alert13F[] = [];
  const done: FeedEntry[] = [];
  let deferred = 0;
  const { claimSend } = await import('./failover');
  for (const e of todo) {
    // The other poller (Cloudflare or gene) claimed this filing first: it sends it, this side only records it.
    if (!(await claimSend(env, e.accession, now))) {
      handled.push(e.accession);
      done.push(e);
      continue;
    }
    // Each filing needs up to 3 SEC requests; what doesn't fit this minute's budget (keeping some
    // for the Form 4 and 13D/G poll) waits for the next minute.
    if (secBudget.left < SEC_PER_FILING + EVENT_POLL_RESERVE) {
      deferred = todo.length - done.length;
      break;
    }
    try {
      if (e.form === '13F-HR/A') {
        // Amendments: only NEW HOLDINGS ones are news (positions revealed late); restatements reach
        // members through the data run's refreshed book.
        if (secBudget.left < SEC_PER_FILING + 2 + EVENT_POLL_RESERVE) {
          deferred = todo.length - done.length;
          break;
        }
        const meta = await fetchFilingMeta(e.cik, e.accession);
        if (!meta) continue;
        const r = meta.amendment_type === 'NEW HOLDINGS' && rawPeriods && alertable({ form: '13F-HR', filing_date: e.accepted }, now) ? await revealAlert(env, e, meta, ciks[e.cik], !curated[e.cik]) : null;
        if (r === undefined) continue; // the table couldn't be read yet: retried next minute
        handled.push(e.accession);
        done.push(e);
        if (r) fresh.push(r);
        continue;
      }
      const f = await fetch13F(e.cik, e.accession);
      if (!f) continue; // EDGAR hiccup: retried next minute while still in the feed
      handled.push(e.accession);
      done.push(e);
      const mgrs = ciks[e.cik];
      const isExtra = !curated[e.cik];
      // A followed filer seen for the first time starts from its latest quarter in the data run.
      for (const m of mgrs) if (!periods[m.slug] && m.report_date) periods[m.slug] = m.report_date;
      const { fresh: slugs, prev } = advance(periods, mgrs.map((m) => m.slug), f.report_date);
      if (!rawPeriods || !slugs.length || !alertable({ form: e.form, filing_date: e.accepted }, now)) continue;
      let moves: Moves | null = null;
      let tickers: string[] = [];
      let top: MoveRow[] | undefined;
      let changed: MoveRow[] | undefined;
      if (f.holdings) {
        for (const s of slugs) {
          const book = isExtra ? await filerShardBook(env, e.cik, prev[s]) : await priorBook(env, s, prev[s]);
          if (!book) continue;
          const q = quarterOf(f.report_date);
          let r = computeMoves(f.holdings, book, undefined, await splitsFor(env, q), await perShareMedians(env, perShareSuspects(f.holdings, book).slice(0, 6), q));
          // Held positions already carry tickers from last quarter's book; look up only new ones (each lookup scans
          // the securities map, ~0.5 ms of CPU): the email's, plus the 30 largest when a held name was exited, so a
          // CUSIP change (XOM's Q3 reorganisation) nets into one share-based move.
          const exitedNamed = r.changed.some((x) => x.change === 'exited' && x.ticker);
          await lookupTickers(env, exitedNamed ? [...r.moves.new, ...r.changed.filter((x) => x.change === 'new').sort((a, b) => b.value - a.value).slice(0, 30)] : r.moves.new);
          r = netRenamed(r);
          moves = r.moves;
          changed = keepChanged(r.changed);
          tickers = [...new Set(r.changed.map((x) => x.ticker).filter((t): t is string => !!t))];
          break;
        }
        if (!moves && isExtra) {
          // No prior quarter on file for this filer: the email lists its largest holdings instead.
          top = [...f.holdings].sort((a, b) => b.value - a.value).slice(0, 10).map((h) => ({ ticker: h.ticker ?? null, display_name: h.display_name ?? null, issuer: h.issuer, cusip: h.cusip, put_call: h.put_call, shares: h.shares, prev_shares: 0, value: h.value, value_delta: h.value, delta_pct_of_book: null }));
          await lookupTickers(env, top);
        }
      }
      // This quarter is the next one's baseline for a filer the data run doesn't curate.
      if (isExtra && f.holdings) await env.HIST.put(baselineKey(e.cik, f.report_date), JSON.stringify({ report_date: f.report_date, accession: e.accession, holdings: f.holdings }));
      const lead = mgrs.find((m) => m.featured && slugs.includes(m.slug)) ?? mgrs.find((m) => m.cik === e.cik) ?? mgrs[0];
      fresh.push({
        slug: lead.slug,
        slugs,
        manager: displayCase(lead.manager),
        name: lead.name,
        quarter: quarterOf(f.report_date),
        report_date: f.report_date,
        filing_date: e.accepted.slice(0, 10),
        accession: e.accession,
        sec_url: `https://www.sec.gov/Archives/edgar/data/${Number(e.cik)}/${e.accession.replace(/-/g, '')}/${e.accession}-index.html`,
        accepted: e.accepted,
        moves,
        tickers,
        ...(changed ? { changed } : {}),
        // Too big to parse here, or no prior quarter on hand: gene computes the moves from EDGAR within minutes.
        ...(!moves && !top ? { moves_pending: true } : {}),
        ...(isExtra ? { extra: true } : {}),
        ...(top ? { top } : {}),
        ...(f.holdings && bookSuspect(f.holdings, f.cover_total ?? null) ? { suspect_book: true } : {}),
      });
    } catch (err) {
      // One bad filing never blocks the rest: it is retried next minute, the others are recorded.
      errors.push(`${e.accession}: ${err}`);
    }
  }
  if (done.length) {
    await env.DB.put('alerts:handled', JSON.stringify(handled.slice(-500)));
    await env.DB.put('alerts:periods', JSON.stringify(periods));
  }
  // Curated books too big to diff here get their moves in a follow-up once the data run has them.
  const later = fresh.filter((f) => f.moves_pending);
  if (later.length) await env.DB.put('alerts:pending-moves', JSON.stringify([...JSON.parse((await env.DB.get('alerts:pending-moves')) ?? '[]'), ...later]));
  const sent = await deliver(env, fresh, [], now);
  // A curated filer filed: refresh the data now, so pages, history and moves follow within ~15 minutes.
  const filed = done.filter((e) => curated[e.cik]);
  const refresh = filed.length && rawPeriods ? await dispatchRefresh(env, 'curated', `filing by ${curated[filed[0].cik][0].slug}`, now, filed[0].accession) : undefined;
  // A 13F is timed by the email that carries its moves: one sent without them is timed when they follow.
  const timed = fresh.filter((f) => !f.moves_pending);
  if (timed.length) await logLatency(env, timed.map((f) => (f.reveal ? { ...f, form: '13F-HR/A' } : f)), Date.now());
  return { status: 'checked', filings: fresh.map((f) => `${f.slug} ${f.quarter}${f.moves ? '' : ' (no moves)'}`), ...sent, ...(deferred ? { deferred } : {}), ...(refresh ? { refresh } : {}), ...(errors.length ? { errors } : {}) };
}

/**
 * Acceptance-to-send latency per alerted filing, newest first, for /health. Accessions listed in
 * KV alerts:replays (test sends of old filings) are marked and never counted. `coverage`: a curated
 * manager's filing, or any other filer's (followed, a peer, or a member's linked book).
 */
async function logLatency(env: Env, filings: { slug: string; accession: string; accepted?: string; kind?: string; manager?: string; quarter?: string; form?: string; extra?: boolean; coalesced?: boolean; followup?: boolean }[], sentAt: number): Promise<void> {
  if (!filings.length) return;
  const replays = new Set(JSON.parse((await env.DB.get('alerts:replays')) ?? '[]') as string[]);
  // Emails held for the daily limit: the row is kept but marked, and not counted as fast.
  const delayed = new Set(JSON.parse((await env.DB.get((await import('./email')).DELAYED_IDS)) ?? '[]') as string[]);
  const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as unknown[];
  const add = filings
    .filter((f) => f.accepted)
    .map((f) => ({ slug: f.slug, manager: f.manager || undefined, quarter: f.quarter, form: f.form ?? '13F-HR', kind: f.kind ?? '13f', ...((f.kind ?? '13f') === '13f' ? { moves: true } : {}), accession: f.accession, accepted: f.accepted, coverage: f.extra ? 'any_filer' : 'curated', sent: new Date(sentAt).toISOString(), seconds: Math.round((sentAt - Date.parse(f.accepted!)) / 1000), ...(replays.has(f.accession) ? { replay: true } : {}), ...(delayed.has(f.accession) ? { email_delayed: true } : {}), ...(f.coalesced ? { coalesced: true } : {}), ...(f.followup ? { followup: true } : {}) }));
  // A filing season's worth: the public /latency page reports the whole season.
  await env.DB.put('alerts:latency', JSON.stringify([...add, ...log].slice(0, 2000)));
}

interface IndexRow {
  ok?: boolean;
  slug: string;
  cik: string;
  manager: string;
  name: string;
  featured?: boolean;
  type?: string | null;
  status?: string;
  total_value?: number;
  position_count?: number;
  history_quarters?: string[];
  form?: string;
  accession?: string;
  report_date?: string;
  filing_date?: string;
  quarter?: string;
  sec_url?: string;
  reported_by?: { cik: string } | string;
  accepted_at?: string;
}

/**
 * Hourly backstop from the data run's index.json, for anything the minute poll missed: same
 * forward-only periods, moves taken from alerts.json. Also refreshes the CIK map for the poll.
 */
/**
 * The data run's moves (alerts.json), guarded like the poll's. Its delta_pct_of_book is against this
 * quarter's book only, so the yardstick is the larger of that and the prior book (estimated as this one
 * less buys plus sells: Scion's put exits from a book that shrank to $99M). Exits and new positions carry
 * both values.
 */
export function guardDataRun(m: Moves): Moves {
  const cur = [...m.new, ...m.added, ...m.trimmed, ...m.exited].map((r) => (r.delta_pct_of_book && r.value_delta ? Math.abs(r.value_delta / r.delta_pct_of_book) : 0)).find((x) => x > 0) ?? 0;
  const book = Math.max(cur, cur - m.bought_usd + m.sold_usd) || null;
  const ok = (rows: MoveRow[]) => guardRows(rows, book, (r) => (r.change === 'exited' || !r.shares ? -r.value_delta : !r.prev_shares ? 0 : r.prev_value));
  return { ...m, new: ok(m.new), added: ok(m.added), trimmed: ok(m.trimmed), exited: ok(m.exited) };
}

/** The data run's moves per accession (alerts.json), fetched once on first use. */
function recentMoves(env: Env): (acc: string) => Promise<Moves | null> {
  let recent: { accession: string; moves?: Moves }[] | null = null;
  return async (acc) => {
    if (!recent) {
      const r = await fetch(`${env.DATA_URL}alerts.json`);
      recent = r.ok ? (((await r.json()) as { recent?: { accession: string; moves?: Moves }[] }).recent ?? []) : [];
    }
    const m = recent.find((x) => x.accession === acc)?.moves ?? null;
    if (!m) return null;
    return guardDataRun(m);
  };
}

const changedTickers = (m: Moves) => [...m.new, ...m.added, ...m.trimmed, ...m.exited].map((r) => r.ticker).filter((t): t is string => !!t);

/** Follow-ups with the moves for filings the minute poll sent without them. */
async function pendingFollowups(env: Env, now: number, movesFor = recentMoves(env)): Promise<Record<string, unknown>> {
  const pendingRaw = await env.DB.get('alerts:pending-moves');
  if (!pendingRaw) return {};
  const pending = JSON.parse(pendingRaw) as Alert13F[];
  const ready: Alert13F[] = [];
  const wait: Alert13F[] = [];
  for (const p of pending) {
    const moves = await movesFor(p.accession);
    if (moves) ready.push({ ...p, moves, tickers: changedTickers(moves), followup: true });
    else if (now - Date.parse(p.filing_date) <= MAX_ALERT_AGE_DAYS * DAY) wait.push(p);
  }
  if (wait.length) await env.DB.put('alerts:pending-moves', JSON.stringify(wait));
  else await env.DB.delete('alerts:pending-moves');
  return sendFollowups(env, ready, now);
}

/** Sends moves follow-ups once, whichever host computed them first (an R2 claim per filing), and times them. */
async function sendFollowups(env: Env, ready: Alert13F[], now: number): Promise<Record<string, unknown>> {
  const { claimOnce } = await import('./failover');
  const mine: Alert13F[] = [];
  const replays: Record<string, unknown>[] = [];
  for (const f of ready) {
    if (f.replay_to?.length) {
      if (!(await claimOnce(env, `moves/replay/${f.accession}/${f.replay_at}`, now))) continue;
      const r = await deliver(env, [f], [], now, new Set(f.replay_to));
      const sent = Date.now();
      const row = { accession: f.accession, queued_at: f.replay_at, sent_at: new Date(sent).toISOString(), seconds: f.replay_at ? Math.round((sent - Date.parse(f.replay_at)) / 1000) : null, members: f.replay_to.length, emails: r.emails, mail: r.mail };
      await env.DB.put('alerts:moves-replays', JSON.stringify([row, ...(JSON.parse((await env.DB.get('alerts:moves-replays')) ?? '[]') as unknown[])].slice(0, 50)));
      replays.push(row);
      continue;
    }
    if (await claimOnce(env, `moves/${f.accession}`, now)) mine.push(f);
  }
  if (!mine.length) return replays.length ? { replays } : {};
  const sent = await deliver(env, mine, [], now);
  await logLatency(env, mine.map((f) => ({ ...f, kind: '13f', followup: true })), Date.now());
  return { followups: { filings: mine.map((f) => f.slug), ...sent }, ...(replays.length ? { replays } : {}) };
}

/** Changed rows kept on the alert: $100K and up, largest first, at most 400 (owned and watched names come from these). */
const keepChanged = (rows: MoveRow[]) => rows.filter((r) => Math.abs(r.value_delta) >= 100_000).sort((a, b) => Math.abs(b.value_delta) - Math.abs(a.value_delta)).slice(0, 400);

/**
 * gene, every minute: moves for 13Fs sent without them (tables too big for Cloudflare's CPU limit, or no prior book in
 * Cloudflare's R2). gene has no CPU limit: it reads the whole table from EDGAR, the prior quarter from R2 (h/, or a
 * non-curated filer's baseline) or else from EDGAR, and sends the follow-up. The data run's moves stay the fallback.
 */
export async function geneMoves(env: Env, now: number, budgetMs = 45_000): Promise<Record<string, unknown>> {
  const pending = JSON.parse((await env.DB.get('alerts:pending-moves')) ?? '[]') as Alert13F[];
  if (!pending.length) return { pending: 0 };
  const t0 = Date.now();
  secBudget.left = Math.max(secBudget.left, 30);
  const ready: Alert13F[] = [];
  const failed: string[] = [];
  for (const p of pending) {
    if (Date.now() - t0 > budgetMs) break;
    const cik = p.sec_url.match(/\/edgar\/data\/(\d+)\//)?.[1];
    if (!cik) continue;
    try {
      const f = await fetch13F(cik, p.accession, Infinity);
      if (!f?.holdings) {
        failed.push(p.accession);
        continue;
      }
      const prevEnd = prevQuarterEnd(f.report_date);
      const book = (p.extra ? await filerShardBook(env, cik, prevEnd) : await priorBook(env, p.slug, prevEnd, Infinity)) ?? (await prior13F(cik, f.report_date));
      if (!book) {
        failed.push(p.accession);
        continue;
      }
      const q = quarterOf(f.report_date);
      const raw = computeMoves(f.holdings, book, undefined, await splitsFor(env, q), await perShareMedians(env, perShareSuspects(f.holdings, book).slice(0, 6), q));
      // EDGAR tables carry no tickers: look up every changed row, so owned and watched names match and a CUSIP
      // change nets into one share-based move.
      await lookupTickers(env, raw.changed);
      const r = netRenamed(raw);
      ready.push({ ...p, moves: r.moves, changed: keepChanged(r.changed), tickers: [...new Set(r.changed.map((x) => x.ticker).filter((t): t is string => !!t))], followup: true, moves_pending: undefined });
    } catch (e) {
      failed.push(`${p.accession}: ${e}`);
    }
  }
  // Shown on /health (accessions and errors only): gene's minute logs aren't visible elsewhere.
  if (failed.length) await env.DB.put('host:moves-last', JSON.stringify({ at: new Date(now).toISOString(), failed }));
  if (!ready.length) return { pending: pending.length, failed };
  // Take the sent ones off the list as it is now (Cloudflare may have added filings meanwhile).
  const key = (x: Alert13F) => `${x.accession}|${x.replay_at ?? ''}`;
  const done = new Set(ready.map(key));
  const left = (JSON.parse((await env.DB.get('alerts:pending-moves')) ?? '[]') as Alert13F[]).filter((x) => !done.has(key(x)));
  if (left.length) await env.DB.put('alerts:pending-moves', JSON.stringify(left));
  else await env.DB.delete('alerts:pending-moves');
  return { pending: pending.length, ...(await sendFollowups(env, ready, now)), ...(failed.length ? { failed } : {}) };
}

export async function runBackstop(env: Env, now: number): Promise<Record<string, unknown>> {
  // The re-filed-amendments fix reaches /v1 when the data run re-uploads the books to R2: First Eagle's
  // 2026Q2 book drops from $120.67B to $60.75B. Checked hourly until it has (the changelog entry turns shipped).
  if (!(await env.DB.get('v1:fixed:refiled-amendments'))) {
    const fe = await env.HIST.get('h/matthew-mclennan/2026Q2.json');
    const total = fe ? ((await new Response(fe.body).json()) as { total_value?: number }).total_value : undefined;
    if (total && total < 1e11) await env.DB.put('v1:fixed:refiled-amendments', new Date(now).toISOString());
  }
  // index.json (900 KB) only changes with a data build: when it hasn't, skip parsing it and go
  // straight to the follow-ups. Its derived KV (CIK map, /v1 filers, periods) is unchanged too.
  const etag = await env.DB.get('idx:etag');
  const res = await fetch(`${env.DATA_URL}index.json`, etag ? { headers: { 'if-none-match': etag } } : {});
  if (res.status !== 304 && !res.ok) throw new Error(`index.json ${res.status}`);
  const idx = (res.status === 304 ? { managers: [] } : await res.json()) as { managers?: IndexRow[]; generated_at?: string; build_id?: string };
  if (res.status === 304) return { status: 'unchanged', ...(await pendingFollowups(env, now)) };
  const rows = idx.managers ?? [];
  // /v1 responses say when and from which build the data was made.
  const build = JSON.stringify({ data_built_at: idx.generated_at ?? null, build_id: idx.build_id ?? (idx.generated_at ? idx.generated_at.replace(/[-:]/g, '') : null) });
  // Never backwards: a stale cached index.json (an older build) never replaces the build /v1 already reports.
  const was = JSON.parse((await env.DB.get('v1:build')) ?? '{}') as { data_built_at?: string | null };
  const older = !!was.data_built_at && !!idx.generated_at && idx.generated_at < was.data_built_at;
  if (older) return { status: 'older index ignored', index_built_at: idx.generated_at, serving: was.data_built_at };
  if (JSON.stringify(was) !== build) {
    await env.DB.put('v1:build', build);
    // /status/ freshness: the build, and the newest 13F in it (by EDGAR acceptance).
    const last = rows.filter((r) => r.accepted_at && r.accession && /^13F/.test(r.form ?? '13F')).sort((a, b) => b.accepted_at!.localeCompare(a.accepted_at!))[0];
    await env.DB.put('status:fresh', JSON.stringify({ ...JSON.parse(build), last_13f: last ? { slug: last.slug, manager: last.manager, accession: last.accession, accepted_at: last.accepted_at!.replace(/\.\d{3}Z$/, 'Z') } : null }));
  }

  const ciks: CikMap = {};
  const byCik = (cik: string, m: IndexRow) => (ciks[cik.padStart(10, '0')] ??= []).push({ slug: m.slug, manager: m.manager, name: m.name, cik: m.cik.padStart(10, '0'), featured: m.featured, type: m.type ?? null });
  for (const m of rows) {
    if (!m.slug || !m.cik) continue;
    byCik(m.cik, m);
    if (m.reported_by && typeof m.reported_by === 'object' && m.reported_by.cik) byCik(m.reported_by.cik, m);
  }
  const cikJson = JSON.stringify(ciks);
  if ((await env.DB.get('alerts:ciks')) !== cikJson) await env.DB.put('alerts:ciks', cikJson);
  // The /v1/filers list, written only when it changes.
  const filerJson = JSON.stringify(
    rows.filter((m) => m.slug && m.cik).map((m) => ({
      slug: m.slug,
      cik: m.cik.padStart(10, '0'),
      name: m.name,
      manager: m.manager,
      featured: !!m.featured,
      type: m.type === 'active' ? 'long_only' : m.type === 'broker' ? 'other' : (m.type ?? null),
      status: m.status ?? null,
      latest_quarter: m.quarter ?? null,
      latest_report_date: m.report_date ?? null,
      latest_filing_date: m.filing_date ?? null,
      latest_accession: m.accession ?? null,
      total_value_usd: m.total_value == null ? null : Math.round(m.total_value),
      position_count: m.position_count ?? null,
      history_quarters: m.history_quarters ?? [],
    })),
  );
  if ((await env.DB.get('v1:filers')) !== filerJson) await env.DB.put('v1:filers', filerJson);

  const raw = await env.DB.get('alerts:periods');
  const periods = JSON.parse(raw ?? '{}') as Record<string, string>;
  const before = JSON.stringify(periods);
  const out: Record<string, unknown> = {};
  const movesFor = recentMoves(env);
  Object.assign(out, await pendingFollowups(env, now, movesFor));
  const fresh: IndexRow[] = [];
  for (const f of rows) {
    // Holdings reports (13F-HR and restated 13F-HR/A) record the period; notices (13F-NT) don't.
    if (!f.ok || !f.slug || !f.accession || !f.report_date || !f.form?.startsWith('13F-HR')) continue;
    if (advance(periods, [f.slug], f.report_date).fresh.length && raw && alertable({ form: f.form, filing_date: f.filing_date ?? '' }, now)) fresh.push(f);
  }
  if (JSON.stringify(periods) !== before || !raw) await env.DB.put('alerts:periods', JSON.stringify(periods));
  const tag = res.headers.get('etag');
  if (tag && tag !== etag) await env.DB.put('idx:etag', tag);
  if (!raw) {
    await env.DB.delete('alerts:seen'); // the old accession-keyed state
    return { ...out, status: 'seeded' };
  }
  if (!fresh.length) return { ...out, status: 'none' };

  // One filing listed under two slugs (a parent reporting for a manager) becomes one alert.
  const alerts: Alert13F[] = [];
  for (const f of fresh) {
    const same = alerts.find((a) => a.accession === f.accession);
    if (same) {
      same.slugs.push(f.slug);
      continue;
    }
    const moves = await movesFor(f.accession!);
    const tickers = moves ? changedTickers(moves) : [];
    alerts.push({ slug: f.slug, slugs: [f.slug], manager: f.manager, name: f.name, quarter: f.quarter ?? quarterOf(f.report_date!), report_date: f.report_date!, filing_date: f.filing_date!, accession: f.accession!, sec_url: f.sec_url ?? '', moves, tickers });
  }
  return { ...out, status: 'checked', filings: alerts.map((f) => f.slug), ...(await deliver(env, alerts, [], now)) };
}

// ---------------------------------------------------------------------------------------------
// Form 4 and Schedule 13D/G between quarters

/** Form 4 open-market buys and sells and 13D filings alert by default; 13G only for members who opt in. */
export function eventAlertable(e: AlertEvent, now: number): boolean {
  if (now - Date.parse(e.filing_date) > MAX_ALERT_AGE_DAYS * DAY) return false;
  if (e.kind === 'form4') return e.action === 'buy' || e.action === 'sell' || e.action === 'mixed';
  return e.kind === '13d' || e.kind === '13g';
}

/**
 * Hourly: new entries in the data run's events.json, keyed by accession. First run only records.
 * Filings the minute poll already alerted are skipped, except that one alerted before it could be
 * read gets a follow-up with the data run's details.
 */
export async function runEvents(env: Env, now: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${env.DATA_URL}events.json`);
  if (!res.ok) return { status: `events.json ${res.status}` };
  const events = ((await res.json()) as { events?: AlertEvent[] }).events ?? [];
  const raw = await env.DB.get('events:seen');
  const seen = new Set(JSON.parse(raw ?? '[]') as string[]);
  const handled = new Set(JSON.parse((await env.DB.get('events:handled')) ?? '[]') as string[]);
  const pending = new Set(JSON.parse((await env.DB.get('events:pending')) ?? '[]') as string[]);
  const fresh = events.filter((e) => !seen.has(e.id));
  if (raw && !fresh.length) return { status: 'none' };
  // Keep ids still in the 30-day feed so the list doesn't grow.
  await env.DB.put('events:seen', JSON.stringify([...new Set(events.map((e) => e.id))]));
  if (!raw) return { status: 'seeded', events: events.length };
  const followups = fresh.filter((e) => pending.has(e.id)).map((e) => ({ ...e, followup: true }));
  if (followups.length) await env.DB.put('events:pending', JSON.stringify([...pending].filter((id) => !followups.some((e) => e.id === id))));
  const send = [...fresh.filter((e) => !handled.has(e.id) && eventAlertable(e, now)), ...followups];
  return { status: 'checked', new: fresh.length, alertable: send.length, followups: followups.length, ...(await deliver(env, [], send, now)) };
}

// ---------------------------------------------------------------------------------------------
// Form 4 and Schedule 13D/G within the minute

/** Issuer CIK -> tickers that active members own or watch, rebuilt hourly from SEC's ticker map. */
export async function runWatchMap(env: Env): Promise<Record<string, unknown>> {
  const want = new Set<string>();
  const followed = new Set<string>();
  const bookCiks = new Set<string>();
  const members = await listMembers(env);
  // Books imported from a 13F filer follow its newest quarter.
  const books = await refreshBooks(env, members.filter((m) => isActive(m))).catch(() => 0);
  // Every owned and watched name, free members' included, for the issuer-events precompute.
  const names = new Set<string>();
  for (const m of members) {
    if (m.status === 'free') for (const t of (await getFollows(env, m)).owned) names.add(t);
    if (!isActive(m)) continue;
    if (m.alerts === 'off') {
      for (const t of (await getFollows(env, m)).stocks) names.add(t);
      continue;
    }
    const f = await getFollows(env, m);
    for (const t of f.stocks) {
      want.add(t);
      names.add(t);
    }
    // Peers count as followed filers here (their CIKs reach the data run for a prior quarter, and they
    // get baselines); their alerts still go only to members who follow them as investors.
    for (const s of [...f.investors, ...(f.peers ?? []), ...(Array.isArray(m.alerts) ? m.alerts : [])]) followed.add(s);
    if (f.book?.cik) bookCiks.add(f.book.cik);
  }
  // Follows saved before any filer could be followed get their CIKs here.
  await resolveFollowedFilers(env, [...followed]).catch(() => []);
  const nameList = JSON.stringify([...names].sort());
  if ((await env.DB.get('issuers:tickers')) !== nameList) await env.DB.put('issuers:tickers', nameList);
  const curatedCiks = new Set(Object.keys((await cikMap(env)) ?? {}));
  await env.DB.put('followed:book-ciks', JSON.stringify([...bookCiks].filter((c) => !curatedCiks.has(c)).sort()));
  await pruneExtra(env, followed);
  await writeFollowedCiks(env, await extraMap(env));
  // Baselines for followed filers that don't have one yet (followed before snapshots existed).
  let snaps = 0;
  for (const [cik, ms] of Object.entries(await extraMap(env))) {
    const rd = ms[0]?.report_date;
    if (snaps >= 5 || !rd || (await env.HIST.get(baselineKey(cik, rd)))) continue;
    if (await snapshotBaseline(env, cik).catch(() => false)) snaps++;
  }
  const map: Record<string, string[]> = {};
  const pre = want.size ? await env.HIST.get('pre/sec-tickers.json') : null;
  if (pre) {
    // The precomputed ticker -> CIK map: a string search per watched ticker, no 800 KB parse.
    const text = await new Response(pre.body).text();
    for (const t of want) {
      const at = text.indexOf(`"${t}":"`);
      if (at >= 0) (map[text.slice(at + t.length + 4, at + t.length + 14)] ??= []).push(t);
    }
  } else if (want.size) {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'user-agent': 'Copybook copybook@factordynamics.com' } });
    if (!res.ok) return { status: `company_tickers ${res.status}` };
    for (const v of Object.values((await res.json()) as Record<string, { cik_str: number; ticker: string }>)) {
      // SEC writes class tickers with a dash (BRK-B); members and Copybook use a dot (BRK.B).
      const t = v.ticker.replace('-', '.');
      if (want.has(t)) (map[String(v.cik_str).padStart(10, '0')] ??= []).push(t);
    }
  }
  const json = JSON.stringify(map);
  if ((await env.DB.get('alerts:watch')) !== json) await env.DB.put('alerts:watch', json);
  return { status: 'ok', tickers: want.size, issuers: Object.keys(map).length, books };
}

const EVENT_PAGES = 2;
const EVENTS_PER_MINUTE = 8;

/** Form 4 and 13D/G feed pages back to `since` (newest first), at most EVENT_PAGES each. */
// ---------------------------------------------------------------------------------------------
// Missed-filing detector: the safety net for deadline day

/** Filings a poll should have sent by now: accepted more than 10 minutes ago, within the last 90. */
const MISSED_AFTER_MS = 10 * 60_000;
const MISSED_WINDOW_MS = 90 * 60_000;
/** Feed pages read per form type (100 entries each), newest first, stopping at the window's start. */
const MISSED_PAGES: [string, number][] = [['13F-HR', 3], ['4', 6], ['SCHEDULE 13', 2]];

type Missed = FeedEntry & { detected_at: string };

async function missedQueue(env: Env): Promise<Missed[]> {
  return JSON.parse((await env.DB.get('missed:queue')) ?? '[]') as Missed[];
}

/** The events poll's rule for which Form 4 and 13D/G filings concern a followed filer or a watched issuer. */
function eventCandidate(es: FeedEntry[], ciks: CikMap, watch: Record<string, string[]>): boolean {
  return es.some((e) => ((e.role === 'Reporting' || e.role === 'Filed by') && !!ciks[e.cik]) || (e.role === 'Subject' && e.form.startsWith('SCHEDULE 13') && !!watch[e.cik]) || (e.role === 'Issuer' && e.form === '4' && !!watch[e.cik]));
}

/**
 * Every 10 minutes, after the polls: reads EDGAR's latest 13F-HR, 13F-HR/A, Form 4 and Schedule 13D/G
 * filings over the last 90 minutes and compares the curated and followed filers' (and watched issuers')
 * ones with what the polls handled. Anything accepted more than 10 minutes ago and never handled is
 * put back in front of the polls (KV missed:queue), logged (missed:log) and counted (missed:count,
 * missed_recovered on /health). The polls then send it as usual; a 13D/G or Form 4 more than 6 hours
 * old goes to the digest. Sources a poll hasn't seeded yet are skipped.
 */
export async function runMissedDetector(env: Env, now: number): Promise<Record<string, unknown>> {
  const curated = await cikMap(env);
  if (!curated) return { status: 'no cik map yet' };
  const ciks = withExtra(curated, await extraMap(env));
  const watch = JSON.parse((await env.DB.get('alerts:watch')) ?? '{}') as Record<string, string[]>;
  const rawPeriods = await env.DB.get('alerts:periods');
  const rawEvents = await env.DB.get('events:handled');
  const handled = new Set([...(JSON.parse((await env.DB.get('alerts:handled')) ?? '[]') as string[]), ...(JSON.parse(rawEvents ?? '[]') as string[])]);
  const queue = await missedQueue(env);
  const entries: FeedEntry[] = [];
  const errors: string[] = [];
  for (const [type, pages] of MISSED_PAGES) {
    if (type === '13F-HR' ? !rawPeriods : !rawEvents) continue;
    for (let page = 0; page < pages && secBudget.left >= 2; page++) {
      try {
        const es = await latestFilings(type, page * 100);
        entries.push(...es);
        const last = es[es.length - 1];
        if (es.length < 100 || !last || Date.parse(last.accepted) < now - MISSED_WINDOW_MS) break;
      } catch (err) {
        errors.push(`${type}: ${err}`);
        break;
      }
    }
  }
  const byAcc = new Map<string, FeedEntry[]>();
  for (const e of entries) (byAcc.get(e.accession) ?? byAcc.set(e.accession, []).get(e.accession)!).push(e);
  const queued = new Set(queue.map((e) => e.accession));
  const found: Missed[] = [];
  const log: { accession: string; form: string; cik: string; accepted: string; detected_at: string; minutes_late: number }[] = [];
  for (const [acc, es] of byAcc) {
    const at = Math.min(...es.map((e) => Date.parse(e.accepted)));
    if (handled.has(acc) || queued.has(acc) || at > now - MISSED_AFTER_MS || at < now - MISSED_WINDOW_MS) continue;
    const is13F = es[0].form.startsWith('13F-HR');
    if (is13F ? !es.some((e) => ciks[e.cik]) : !eventCandidate(es, ciks, watch)) continue;
    const detected_at = new Date(now).toISOString();
    found.push(...es.map((e) => ({ ...e, detected_at })));
    const lead = es.find((e) => ciks[e.cik]) ?? es[0];
    log.push({ accession: acc, form: es[0].form, cik: lead.cik, accepted: new Date(at).toISOString(), detected_at, minutes_late: Math.round((now - at) / 60_000) });
  }
  // Drop what the polls have handled since, and anything too old to alert.
  const keep = queue.filter((e) => !handled.has(e.accession) && now - Date.parse(e.accepted) <= MAX_ALERT_AGE_DAYS * DAY);
  if (found.length || keep.length !== queue.length) await env.DB.put('missed:queue', JSON.stringify([...keep, ...found].slice(-300)));
  if (log.length) {
    for (const l of log) console.log(`missed filing requeued: ${l.form} ${l.accession} (CIK ${l.cik}), accepted ${l.accepted}, ${l.minutes_late} min ago`);
    await env.DB.put('missed:count', String(Number((await env.DB.get('missed:count')) ?? 0) + log.length));
    await env.DB.put('missed:log', JSON.stringify([...log, ...(JSON.parse((await env.DB.get('missed:log')) ?? '[]') as unknown[])].slice(0, 100)));
  }
  return { status: 'checked', read: entries.length, requeued: log.map((l) => `${l.form} ${l.accession}`), queued: keep.length + found.length, ...(errors.length ? { errors } : {}) };
}

async function eventFeed(type: string, since: number): Promise<FeedEntry[]> {
  const out: FeedEntry[] = [];
  for (let page = 0; page < EVENT_PAGES; page++) {
    const entries = await latestFilings(type, page * 100);
    out.push(...entries);
    const last = entries[entries.length - 1];
    if (entries.length < 100 || !last || Date.parse(last.accepted) < since) break;
  }
  return out;
}

const CLUSTER_DAYS = 30;
const CLUSTER_MIN = 3;

/**
 * Keeps each watched company's insider buys of the last 30 days (KV insider:{issuer CIK}). Returns
 * the buyers when this buy makes 3 or more distinct insiders and no cluster was alerted in 30 days.
 */
async function recordInsiderBuy(env: Env, issuerCik: string, buy: Insider, now: number): Promise<Insider[] | null> {
  const key = `insider:${issuerCik}`;
  const state = JSON.parse((await env.DB.get(key)) ?? '{"buys":[]}') as { buys: Insider[]; cluster_at?: number };
  const since = now - CLUSTER_DAYS * DAY;
  state.buys = [...state.buys.filter((b) => Date.parse(b.accepted) >= since && b.accession !== buy.accession), buy];
  const byInsider = new Map<string, Insider>();
  for (const b of state.buys) byInsider.set(b.cik, { ...b, bought_usd: (byInsider.get(b.cik)?.bought_usd ?? 0) + b.bought_usd });
  const hit = byInsider.size >= CLUSTER_MIN && !(state.cluster_at && state.cluster_at >= since);
  if (hit) state.cluster_at = now;
  await env.DB.put(key, JSON.stringify(state), { expirationTtl: (CLUSTER_DAYS + 1) * 86400 });
  return hit ? [...byInsider.values()] : null;
}

const kindOf = (form: string): AlertEvent['kind'] => (form.startsWith('4') ? 'form4' : form.includes('13D') ? '13d' : '13g');

/**
 * Every minute: Form 4 filings by curated filers, and Schedule 13D/G filed by curated filers or on
 * a stock members own or watch (from any filer). Each is read at once (per-class holdings, stake
 * and Item 4, the previous 13D/G for the change) and alerted; a filing that can't be read yet is
 * alerted with what the feed says and completed from the data run.
 */
export async function runEventPoll(env: Env, now: number): Promise<Record<string, unknown>> {
  const curated = await cikMap(env);
  if (!curated) return { status: 'no cik map yet' };
  const ciks = withExtra(curated, await extraMap(env));
  const watch = JSON.parse((await env.DB.get('alerts:watch')) ?? '{}') as Record<string, string[]>;
  const since = now - LOOKBACK_MS;
  const entries: FeedEntry[] = [];
  const errors: string[] = [];
  for (const type of ['4', 'SCHEDULE 13']) {
    try {
      entries.push(...(await eventFeed(type, since)));
    } catch (err) {
      errors.push(String(err));
    }
  }
  entries.push(...(await missedQueue(env)).filter((e) => !e.form.startsWith('13F-HR')));
  // One filing appears once per party (Reporting/Issuer, Filed by/Subject): group by accession.
  const byAcc = new Map<string, FeedEntry[]>();
  for (const e of entries) if (Date.parse(e.accepted) >= now - MAX_ALERT_AGE_DAYS * DAY) (byAcc.get(e.accession) ?? byAcc.set(e.accession, []).get(e.accession)!).push(e);
  const candidates = [...byAcc.entries()].filter(([, es]) =>
    es.some((e) => ((e.role === 'Reporting' || e.role === 'Filed by') && ciks[e.cik]) || (e.role === 'Subject' && e.form.startsWith('SCHEDULE 13') && watch[e.cik]) || (e.role === 'Issuer' && e.form === '4' && watch[e.cik])),
  );
  const rawHandled = await env.DB.get('events:handled');
  if (!rawHandled && !errors.length) {
    // First run: record what is already there, send nothing.
    await env.DB.put('events:handled', JSON.stringify(candidates.map(([acc]) => acc).slice(-1000)));
    return { status: 'seeded', events: candidates.length };
  }
  if (!candidates.length || !rawHandled) return { status: 'none', ...(errors.length ? { errors } : {}) };
  const handled = JSON.parse(rawHandled) as string[];
  const todo = candidates.filter(([acc]) => !handled.includes(acc)).slice(0, EVENTS_PER_MINUTE);
  if (!todo.length) return { status: 'none', ...(errors.length ? { errors } : {}) };

  const fresh: AlertEvent[] = [];
  const pending: string[] = [];
  const { claimSend } = await import('./failover');
  for (const [accession, es] of todo) {
    // A Form 4 takes 2 SEC requests, a 13D/G up to 5 with its previous filing: the rest wait a minute.
    if (secBudget.left < 5) break;
    if (!(await claimSend(env, `ev/${accession}`, now))) {
      handled.push(accession);
      continue;
    }
    const form = es[0].form;
    const kind = kindOf(form);
    const filer = es.find((e) => (e.role === 'Reporting' || e.role === 'Filed by') && ciks[e.cik]);
    const subject = es.find((e) => e.role === 'Subject' || e.role === 'Issuer');
    const mgr = filer ? (ciks[filer.cik].find((m) => m.featured) ?? ciks[filer.cik][0]) : null;
    const anyCik = (filer ?? es[0]).cik;
    const base: AlertEvent = {
      id: accession,
      slug: mgr?.slug ?? '',
      manager: mgr?.manager ?? '',
      ...(mgr?.extra ? { extra: true } : {}),
      form,
      kind,
      action: 'filed',
      filing_date: es[0].accepted.slice(0, 10),
      accepted: es[0].accepted,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(anyCik)}/${accession.replace(/-/g, '')}/${accession}-index.html`,
      issuer: null,
      display_name: null,
      ticker: subject && watch[subject.cik]?.length === 1 ? watch[subject.cik][0] : null,
      shares: null,
      value_usd: null,
      avg_price: null,
      shares_after: null,
      percent_of_class: null,
      subject_tickers: subject && (kind !== 'form4' || !filer) ? (watch[subject.cik] ?? []) : [],
    };
    // A Form 4 on a watched company by someone we don't track: alert only an insider's open-market buy.
    const insiderOnly = kind === 'form4' && !filer;
    let ev: AlertEvent | null = null;
    try {
      if (kind === 'form4') {
        const f4 = await fetchForm4(anyCik, accession);
        if (f4 && insiderOnly) {
          const who = f4.insiders.filter((i) => i.roles.length);
          handled.push(accession);
          if (!f4.bought_usd || !who.length) continue; // a sale, grant or exercise: not an alert
          const ins: Insider = { cik: who[0].cik, name: who[0].name, roles: [...new Set(who.flatMap((i) => i.roles))], bought_usd: f4.bought_usd, accession, accepted: es[0].accepted };
          const bought = f4.classes.reduce((s, c) => s + c.bought, 0);
          const ev: AlertEvent = { ...base, manager: who.map((i) => i.name).join(', '), action: 'buy', issuer: f4.issuer, ticker: base.ticker ?? f4.ticker, shares: bought, value_usd: f4.bought_usd, avg_price: bought ? f4.bought_usd / bought : null, classes: f4.classes, footnotes: f4.footnotes, insider: ins, event_date: f4.event_date, last_transaction_date: f4.last_transaction_date };
          if (eventAlertable(ev, now)) fresh.push(ev);
          const cluster = await recordInsiderBuy(env, subject!.cik, ins, now);
          if (cluster) fresh.push({ ...ev, id: `cluster:${subject!.cik}:${accession}`, manager: `${cluster.length} insiders`, insider: undefined, cluster, value_usd: cluster.reduce((s, i) => s + i.bought_usd, 0), shares: null, avg_price: null, classes: undefined, footnotes: undefined });
          continue;
        }
        if (!f4 && insiderOnly) continue; // unreadable now: retried next minute, never sent half-known
        if (f4) {
          const bought = f4.classes.reduce((s, c) => s + c.bought, 0);
          const sold = f4.classes.reduce((s, c) => s + c.sold, 0);
          const after = f4.classes.every((c) => c.shares_after != null) ? f4.classes.reduce((s, c) => s + (c.shares_after ?? 0), 0) : null;
          ev = {
            ...base,
            action: f4.action,
            issuer: f4.issuer,
            ticker: f4.ticker,
            shares: bought - sold,
            value_usd: f4.classes.reduce((s, c) => s + c.value_usd, 0),
            avg_price: bought + sold ? f4.classes.reduce((s, c) => s + c.value_usd, 0) / (bought + sold) : null,
            shares_after: after,
            classes: f4.classes,
            footnotes: f4.footnotes,
            event_date: f4.event_date,
            last_transaction_date: f4.last_transaction_date,
          };
        }
      } else {
        const s13 = await fetchSchedule13(anyCik, accession);
        if (s13) {
          const prev = await previousSchedule13(s13, accession).catch(() => null);
          const amended = form.endsWith('/A');
          ev = {
            ...base,
            action: !amended && !prev ? 'new_stake' : (s13.percent_of_class ?? 100) < 5 ? 'below_threshold' : 'stake_update',
            manager: base.manager || s13.persons[0]?.name || '',
            issuer: s13.issuer,
            cusip: s13.cusip,
            shares_after: s13.shares,
            percent_of_class: s13.percent_of_class,
            amendment_no: s13.amendment_no,
            item4: s13.item4,
            item5c: s13.item5c,
            prev_form: prev?.form ?? null,
            prev_accession: prev?.accession ?? null,
            prev_percent_of_class: prev?.percent_of_class ?? null,
            prev_shares_after: prev?.shares ?? null,
          };
        }
      }
    } catch (err) {
      errors.push(`${accession}: ${err}`);
    }
    if (!ev) {
      // Couldn't read it now: alert with what the feed says, and complete it from the data run.
      ev = { ...base, details_pending: true };
      pending.push(accession);
    }
    handled.push(accession);
    if (eventAlertable(ev, now) || ev.details_pending) fresh.push(ev);
  }
  await env.DB.put('events:handled', JSON.stringify(handled.slice(-1000)));
  if (pending.length) await env.DB.put('events:pending', JSON.stringify([...(JSON.parse((await env.DB.get('events:pending')) ?? '[]') as string[]), ...pending].slice(-200)));
  const sent = await deliver(env, [], fresh, now);
  const live = fresh.filter((e) => !isLate(e, now) && !e.cluster);
  if (live.length) await logLatency(env, live.map((e) => ({ slug: e.slug || e.subject_tickers?.join(',') || '', manager: e.manager, form: e.form, kind: e.kind, accession: e.id, accepted: e.accepted, extra: !e.slug })), Date.now());
  return { status: 'checked', events: fresh.map((e) => `${e.kind} ${e.slug || e.manager} ${e.ticker ?? e.issuer ?? ''}${e.details_pending ? ' (pending)' : ''}`), ...sent, ...(errors.length ? { errors } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Triggering the gust data refresh (GitHub skips scheduled runs under load)

const WORKFLOW_API = 'https://api.github.com/repos/refcell/gust/actions/workflows/copybook-data.yml';
const DISPATCH_GAP_MS = 20 * 60_000;

/**
 * Dispatches copybook-data.yml at most once per 20 minutes. A `curated` refresh (a curated filer
 * just filed) that can't go now is kept in KV dispatch:pending and retried every minute. Skips when
 * a run is already queued: the workflow's concurrency group would collapse it anyway. A scheduled
 * `full` refresh also skips while one is running.
 */
export async function dispatchRefresh(env: Env, scope: 'curated' | 'full', reason: string, now: number, accession?: string): Promise<string> {
  const token = env.GITHUB_DISPATCH_TOKEN;
  if (!token) return 'no token';
  const pend = async () => {
    if (scope === 'curated' && !(await env.DB.get('dispatch:pending'))) await env.DB.put('dispatch:pending', JSON.stringify({ reason, accession }));
  };
  if (now - Number((await env.DB.get('dispatch:last')) ?? 0) < DISPATCH_GAP_MS) {
    await pend();
    return 'spaced';
  }
  const gh = (path: string, init: RequestInit = {}) =>
    fetch(`${WORKFLOW_API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Copybook-api' } });
  for (const status of scope === 'full' ? ['queued', 'in_progress'] : ['queued']) {
    const r = await gh(`/runs?status=${status}&per_page=1`);
    if (r.ok && ((await r.json()) as { total_count?: number }).total_count) {
      await pend();
      return `skipped: run ${status}`;
    }
  }
  const inputs = { scope, reason, ...(accession ? { accession } : {}) };
  let res = await gh('/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main', inputs }) });
  // Before the workflow declares its inputs, GitHub rejects them: a plain (full) dispatch still refreshes.
  if (res.status === 422) res = await gh('/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
  if (res.status !== 204) {
    console.log(`dispatch ${res.status}: ${await res.text()}`);
    await pend();
    return `error ${res.status}`;
  }
  await env.DB.put('dispatch:last', String(now));
  if (scope === 'curated') await env.DB.delete('dispatch:pending');
  return 'dispatched';
}

/** One cron, every minute; hourly work runs in the same invocation as that minute's poll so state writes never race. */
interface Job {
  name: 'backstop' | 'events' | 'digest' | 'watch' | 'revenue' | 'weekly' | 'issuers' | 'seasonal' | 'ops' | 'quota';
  at: number;
}

export async function runScheduled(env: Env, scheduledTime: number): Promise<Record<string, unknown>> {
  // Two hosts (Cloudflare polls, gene serves members): state synced both ways, one poller at a time (failover.ts).
  const fo = await import('./failover');
  if (fo.syncOn(env)) return fo.syncedMinute(env, scheduledTime, (e) => runMinute(e, scheduledTime));
  return runMinute(env, scheduledTime);
}

async function runMinute(env: Env, scheduledTime: number): Promise<Record<string, unknown>> {
  const t = new Date(scheduledTime);
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (err) {
      out[name] = `error: ${err}`;
    }
  };
  // /status/'s 1-minute probe of the members' API: Cloudflare's cron only, started now so it never delays the polls.
  const fo = await import('./failover');
  const st = fo.isCloudflare(env) ? await import('./status') : null;
  const probe = st?.probeOnce(env, scheduledTime);
  // Alerts first: the 13F and Form 4 / 13D/G polls always run, at the start of the invocation.
  secBudget.left = Number(env.SEC_BUDGET ?? 40);
  await step('poll', () => runPoll(env, scheduledTime));
  await step('events_poll', () => runEventPoll(env, scheduledTime));
  await step('mail_retry', async () => (await import('./email')).retryMail(env));
  await step('mail_held', () => flushHeld(env, scheduledTime));
  await step('latency_retime', () => retimeLatency(env));
  // The missed-filing detector, every 10 minutes whatever else the minute did: it only reads feed
  // pages with the SEC budget the polls left, and the polls send what it finds from the next minute.
  if (t.getUTCMinutes() % 10 === 5) await step('missed', () => runMissedDetector(env, scheduledTime));
  // A minute that sent or read filings has spent its CPU on them: the hourly and daily jobs wait for
  // the next quiet minute (one per minute), and webhook retries for the next.
  const count = (x: unknown) => (Array.isArray(x) ? x.length : typeof x === 'number' ? x : 0);
  const p = out.poll as { filings?: unknown; deferred?: number } | undefined;
  const e = out.events_poll as { events?: unknown } | undefined;
  const busy = count(p?.filings) + count(p?.deferred) + count(e?.events) > 0;
  const m = t.getUTCMinutes();
  const h = t.getUTCHours();
  const due: Job[] = [];
  if (m === 17) due.push({ name: 'backstop', at: scheduledTime });
  if (m === 47) due.push({ name: 'events', at: scheduledTime });
  if (m === 32 && h === 3) due.push({ name: 'digest', at: scheduledTime - 3600_000 });
  if (m === 52) due.push({ name: 'watch', at: scheduledTime });
  // Trial reminders and the season recap, once a day mid-morning in New York.
  if (m === 12 && h === 15) due.push({ name: 'revenue', at: scheduledTime });
  if (m === 12 && h === 16) due.push({ name: 'seasonal', at: scheduledTime });
  if (m === 12 && h === 13) due.push({ name: 'ops', at: scheduledTime });
  // The account's daily request budget, hourly: a warning at 70%.
  if (m === 23) due.push({ name: 'quota', at: scheduledTime });
  // The free weekly: Saturday 02:00 UTC (9pm ET Friday), so it has Friday's after-close filers and their pages.
  if (m === 0 && h === 2 && t.getUTCDay() === 6) due.push({ name: 'weekly', at: scheduledTime });
  // Owned and watched names' insider and 13D/G events: every 10 minutes (each name hourly, 10 minutes in filing week).
  if (m % 10 === 9) due.push({ name: 'issuers', at: scheduledTime });
  const rawQueue = await env.DB.get('jobs:due');
  const queue = [...(JSON.parse(rawQueue ?? '[]') as Job[]), ...due].filter((j, i, all) => all.findIndex((x) => x.name === j.name) === i);
  if (!busy && queue.length) {
    const job = queue.shift()!;
    const run: Record<Job['name'], () => Promise<unknown>> = {
      backstop: () => runBackstop(env, job.at),
      events: () => runEvents(env, scheduledTime),
      digest: () => runDigest(env, job.at),
      watch: () => runWatchMap(env),
      revenue: () => runRevenue(env, scheduledTime),
      seasonal: () => import('./revenue').then((x) => x.runSeasonal(env, job.at)),
      ops: () => import('./revenue').then((x) => x.runOpsDigest(env, job.at)),
      quota: () => import('./revenue').then((x) => x.runQuotaCheck(env, job.at)),
      weekly: () => import('./free').then((x) => x.runWeekly(env, job.at)),
      // A quiet minute's leftover SEC requests, keeping 4 for the mailer and GitHub.
      issuers: () => import('./stockevents').then((x) => x.precomputeIssuers(env, scheduledTime, inFilingWeek(scheduledTime), Math.min(16, secBudget.left - 4))),
    };
    await step(job.name, run[job.name]);
  }
  if (queue.length) out.deferred_jobs = queue.map((j) => j.name);
  // The public latency.json, on every quiet minute (a busy one has spent its CPU on alerts; the next one catches up).
  if (!busy) await step('latency_json', () => import('./index').then((x) => x.publishLatency(env, scheduledTime)));
  if (st && probe) await step('status', () => st.runStatus(env, scheduledTime, probe, !busy));
  const next = JSON.stringify(queue);
  if (next !== (rawQueue ?? '[]')) await env.DB.put('jobs:due', next);
  // Chat and webhook retries get a slot every minute, so a deadline afternoon of back-to-back filings
  // can't starve them: 2 on a busy minute, 5 on a quiet one, oldest due first.
  await step('webhooks', () => runWebhookRetries(env, scheduledTime, busy ? 2 : 5));
  // Every 3 hours, 10 minutes after gust's own cron: a full refresh only if that run didn't start.
  if (t.getUTCMinutes() === 33 && t.getUTCHours() % 3 === 0) await step('dispatch', () => dispatchRefresh(env, 'full', 'scheduled by copybook-api', scheduledTime));
  else if (env.GITHUB_DISPATCH_TOKEN) {
    const pending = await env.DB.get('dispatch:pending');
    if (pending) {
      const p = JSON.parse(pending) as { reason: string; accession?: string };
      await step('dispatch', () => dispatchRefresh(env, 'curated', p.reason, scheduledTime, p.accession));
    }
  }
  return out;
}
