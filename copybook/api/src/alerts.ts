import { addToFeed, flushChannelLatency, getChannels, getFailures, runWebhookRetries, sendChats, sendWebhooks } from './channels';
import { refreshBooks } from './book';
import { countAlerts, logSent, pausedFilingMail, resumeUrl, runRevenue, yearlyPeakLine } from './revenue';
import { DEADLINES, deadlineMs, inFilingWeek } from './seasons';
import { alertMail, digestMail, FOOTER, type FeedItem, feedItems, holdtermAlertMail, type Mail, sendMail, weeklyNamesMail } from './email';
import { guardShares, markUnreliable, unreliableSide, offFilers, reissuedTicker, isReissued, reissueRatio, loadReissues, bookSuspect, companyFilings, computeMoves, filingId, posKey, gateMoves, gateRow, movesOf, netRenamed, type Consensus, type HeldRow, perShareSuspects, type PerShare, displayCase, guardRows, fetch13F, fetchFilingMeta, fetchForm4, prevQuarterEnd, prior13F, fetchSchedule13, latestFilings, previousSchedule13, quarterOf, secBudget, type FeedEntry, type FilingMeta, type Form4Class, type MoveRow, type Moves, type Position } from './edgar';
import { isActive, isPaused, isPro, testAddress, type Env, type Member } from './env';
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
  /** When this host's poll first saw the filing (the feed read, or the missed-filing detector). */
  detected?: string;
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
  /** Rows the publish gate held back (named "pending check", figures left out); gene re-checks them against ingest's build. */
  held?: HeldRow[];
  /** A follow-up with held rows that passed against ingest's build. */
  checked?: boolean;
  /** Reconciliation found emailed rows that differ from the build: the stored, feed and archive copies say so. */
  corrected?: { at: string; rows: import('./email').CorrectionRow[] };
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
  /** When this host's poll first saw the filing. */
  detected?: string;
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
  /** index.json status `inactive` (SEC registration ended, e.g. Robert Olstein): routes no alerts at all. */
  inactive?: boolean;
  /** A non-curated 13F filer that a member follows; `report_date` is its latest quarter on file. */
  extra?: boolean;
  report_date?: string;
}

/** EDGAR filer CIK -> curated managers it reports for, built from index.json (incl. reported_by parents). */
type CikMap = Record<string, Manager[]>;

/** Times are ET-ish for day keys: EDGAR's filing day ends at 22:00 ET (03:00 UTC in winter). */
/** From then (the deploy of 0bf5b8f) a 13F is timed by the email that carries its moves. */
export const MOVES_FIX_AT = '2026-11-11T00:01:00Z';

export const etDay = (t: number) => new Date(t - 5 * 3600_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Targeting and delivery

import { NO_STOCK_ALERT_TYPES, checkIndex } from './contract';
export type FilerMeta = Record<string, { featured?: boolean; type?: string | null; inactive?: boolean }>;

/**
 * A watched or owned stock alerts only through active managers (hedge funds and other active
 * filers), never banks, brokers or index sponsors; otherwise filing season floods members (109 of
 * NVDA's 119 holders changed last quarter). Until the data run labels filer types, the featured
 * superinvestors stand in for active managers.
 */
function stockAlerts(meta: FilerMeta, slug: string): boolean {
  // meta holds tracked funds only (index.json); untracked filers that members follow alert their followers alone.
  const m = meta[slug];
  if (!m) return false;
  if (m.featured) return true;
  return m.type ? !NO_STOCK_ALERT_TYPES.has(m.type) : false;
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
  // An inactive filer (index.json status) alerts nobody: not followers, not stock watchers.
  const live = (slug: string | undefined) => !slug || !meta[slug]?.inactive;
  filings = filings.filter((x) => x.slugs.some(live));
  events = events.filter((e) => live(e.slug));
  const all = m.alerts === 'all';
  const investors = new Set(Array.isArray(m.alerts) ? [...m.alerts, ...f.investors] : f.investors);
  const stocks = new Set(f.stocks);
  // A reissued security's new line can arrive without a ticker yet (XOM's 30233Q108): its CUSIP names it.
  const tickersOf = (x: Alert13F) => [...x.tickers, ...(x.changed ?? []).map((r) => reissuedTicker(r.cusip)).filter((t): t is string => !!t)];
  const fl = filings.filter(
    (x) =>
      (all && !x.extra) ||
      x.slugs.some((s) => investors.has(s)) ||
      (x.slugs.some((s) => stockAlerts(meta, s)) && tickersOf(x).some((t) => stocks.has(t))) ||
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
  for (const list of Object.values((await cikMap(env)) ?? {})) for (const m of list) meta[m.slug] = { featured: m.featured, type: m.type, ...(m.inactive ? { inactive: true } : {}) };
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
/** Launch week (through Mon Nov 16): 5 a day, so test traffic leaves room for real members. */
/** Thu Nov 12 on: 3 (was 5), so Resend's daily room goes to real members. */
export const TEST_MAIL_CAP = 3;
const testMailKey = (customer: string, now: number) => `mailn:${customer}:${new Date(now).toISOString().slice(0, 10)}`;
/**
 * Leading-edge window, always on: a member's first alert email goes at once; later ones within COALESCE_BASE_MS go as
 * one email at its end (flushHeld, every minute), so a burst of filings costs one email a member per window, not one
 * per filing. While email runs short the window is COALESCE_MS.
 */
export const COALESCE_BASE_MS = 2 * 60_000;
export const COALESCE_MS = 20 * 60_000;
/** Deadline week (3 days before a 13F deadline to the day after): one alert email per member per hour, batched. */
export const DEADLINE_WINDOW_MS = 60 * 60_000;
export const inDeadlineWeek = (now: number) => DEADLINES.some((d) => now >= deadlineMs(d.date) - 3 * 86_400_000 && now <= deadlineMs(d.date) + 86_400_000);
/** Today's room kept for 13F alerts: an email with only Form 4s or 13D/Gs is skipped once this little is left. */
export const FILING_HOLD = 20;
/** The feed note when an email is skipped for the day's email limit. */
export const CAP_NOTE = 'Email limit reached today; this alert is in your feed';

/**
 * Over the day's email room (both providers; Mailgun counts when configured, so failover needs no change here): the
 * email is skipped, never queued for after the reset. The alert already went to the member's feed, chat and webhooks;
 * the feed gets one note a day saying why there was no email, and the day's count feeds /status/ (the lead, Nov 11).
 */
async function capSkipped(env: Env, m: Member, ch: { feed_token?: string | null }, now: number): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10);
  const k = `mail:capskip:${day}`;
  const c = JSON.parse((await env.DB.get(k)) ?? 'null') as { count: number; first_at: string; members: number } | null;
  const mine = `capskip:${m.customer}:${day}`;
  const firstForMember = !(await env.DB.get(mine));
  await env.DB.put(k, JSON.stringify({ count: (c?.count ?? 0) + 1, first_at: c?.first_at ?? new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), members: (c?.members ?? 0) + (firstForMember ? 1 : 0) }), { expirationTtl: 3 * 86400 });
  await env.DB.put(mine, String(Number((await env.DB.get(mine)) ?? 0) + 1), { expirationTtl: 2 * 86400 });
  if (firstForMember && ch.feed_token) {
    const key = `feed:${m.customer}`;
    const items = JSON.parse((await env.DB.get(key)) ?? '[]') as FeedItem[];
    const at = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const note: FeedItem = { id: `capnote:${day}`, title: CAP_NOTE, text: `${CAP_NOTE}. Today's other alerts arrive here, in chat and by webhook as they happen; email resumes after 00:00 UTC.`, url: `${env.SITE_URL}account/`, published: at, sent: at };
    if (!items.some((x) => x.id === note.id)) await env.DB.put(key, JSON.stringify([note, ...items].slice(0, 50)));
  }
}
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

/** An alert's id for a member's mailed record: a 13F's moves follow-up and an event's details follow-up are their own sends. */
const mailId = (x: Alert13F | AlertEvent) => ('accession' in x ? filingId(x) : `${x.id}${x.followup ? ':details' : ''}`);
/**
 * What this member hasn't been emailed yet (KV mailed:{customer}, ids with the time, 7 days), recorded as mailed now:
 * whatever path sends it (minute poll, a retry, the coalesced flush, two hosts in a hand-off), one alert is one email.
 */
async function unmailed(env: Env, customer: string, filings: Alert13F[], events: AlertEvent[], now: number) {
  const k = `mailed:${customer}`;
  const cut = Math.floor(now / 1000) - 7 * 86400;
  const log = Object.fromEntries(Object.entries(JSON.parse((await env.DB.get(k)) ?? '{}') as Record<string, number>).filter(([, t]) => t >= cut));
  const fresh = <T extends Alert13F | AlertEvent>(xs: T[]) => xs.filter((x) => !(mailId(x) in log));
  const out = { filings: fresh(filings), events: fresh(events) };
  const dupes = filings.length + events.length - out.filings.length - out.events.length;
  if (out.filings.length || out.events.length) {
    for (const x of [...out.filings, ...out.events]) log[mailId(x)] = Math.floor(now / 1000);
    await env.DB.put(k, JSON.stringify(log), { expirationTtl: 8 * 86400 });
  }
  if (dupes) {
    const d = await dupesBlocked(env, now);
    const day = new Date(now).toISOString().slice(0, 10);
    d.days[day] = (d.days[day] ?? 0) + dupes;
    await env.DB.put('alerts:dupes-blocked', JSON.stringify({ total: d.total + dupes, days: d.days }));
  }
  return out;
}

/** Alerts the per-member mailed: record stopped from going to a member twice, counted since it went live (1719066). */
export async function dupesBlocked(env: Env, now = Date.now()) {
  const raw = await env.DB.get('alerts:dupes-blocked');
  // The first copy stored a bare running total.
  const v = (raw?.startsWith('{') ? JSON.parse(raw) : { total: Number(raw ?? 0), days: {} }) as { total: number; days: Record<string, number> };
  const cut = new Date(now - 6 * 86400_000).toISOString().slice(0, 10);
  const days = Object.fromEntries(Object.entries(v.days ?? {}).filter(([d]) => d >= cut));
  return { total: v.total, last_7d: Object.values(days).reduce((a, b) => a + b, 0), days, since: '2026-11-11T02:29:00Z' };
}

/** Every minute: held alerts whose window has ended go out as one email per member, timed by that send. */
export async function flushHeld(env: Env, now: number): Promise<Record<string, unknown>> {
  const index = JSON.parse((await env.DB.get(HELD)) ?? '{}') as Record<string, number>;
  const due = Object.entries(index).filter(([, until]) => until <= now).map(([c]) => c);
  if (!due.length) return {};
  const mails = [];
  const sentWith: { filings: Alert13F[]; events: AlertEvent[] }[] = [];
  let room: number | undefined;
  let skipped = 0;
  for (const c of due) {
    const w = JSON.parse((await env.DB.get(`mailwin:${c}`)) ?? 'null') as Held | null;
    await env.DB.delete(`mailwin:${c}`);
    delete index[c];
    const m = await getMember(env, c);
    if (!w || !m?.email || (!w.filings.length && !w.events.length) || !isActive(m)) continue;
    const f = await getFollows(env, m);
    const test = !!m.test || testAddress(m.email);
    if (test && Number((await env.DB.get(testMailKey(c, now))) ?? 0) >= TEST_MAIL_CAP) continue;
    // The same room rule as fanOut: past it the batch is skipped (it went to feed, chat and webhooks as it happened).
    if (!test) {
      room ??= await (await import('./email')).mailRoom(env);
      if (room - mails.length - (w.filings.length ? 0 : FILING_HOLD) <= 0) {
        await capSkipped(env, m, await getChannels(env, c), now);
        skipped++;
        continue;
      }
    }
    const u = await unmailed(env, c, w.filings, w.events, now);
    if (!u.filings.length && !u.events.length) continue;
    if (test) await env.DB.put(testMailKey(c, now), String(Number((await env.DB.get(testMailKey(c, now))) ?? 0) + 1), { expirationTtl: 2 * 86400 });
    mails.push({ ...alertMail(env, m.email, u.filings, u.events, f, m), test, filing: u.filings.length > 0, ids: [...u.filings.map((a) => a.accession), ...u.events.map((e) => e.id)] });
    sentWith.push(u);
  }
  await env.DB.put(HELD, JSON.stringify(index));
  if (!mails.length) return { held_flushed: 0, ...(skipped ? { cap_skipped: skipped } : {}) };
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
  // The real send time, not the run's start: gene's moves take 25-45 s to compute, so rows re-timed from this store
  // (Acadian, Vulcan) came out that much early.
  const sent_at = new Date().toISOString();
  day.filings.push(...filings.map((a) => ({ ...a, sent_at })));
  day.events.push(...events.map((e) => ({ ...e, sent_at })));
  day.late = [...(day.late ?? []), ...late];
  // Kept a month: a new private feed is seeded from the last 30 days.
  await env.DB.put(key, JSON.stringify(day), { expirationTtl: 31 * 86400 });
  await rememberFollowMoves(env, filings);
  if (!filings.length && !events.length) return { emails: 0, digest: 0, mail: 'none', late: late.length };
  return fanOut(env, filings, events, now, late);
}

/** Rows per investor in the Friday email's "Your follows". */
export const FOLLOW_ROWS = 10;
/**
 * The Friday email's "Your follows": each investor's latest 13F with its moves, the FOLLOW_ROWS largest by value
 * (KV wk13f:{slug}, 45 days). Small, so the weekly run reads one key per followed investor, not the day stores.
 */
async function rememberFollowMoves(env: Env, filings: Alert13F[]): Promise<void> {
  for (const a of filings) {
    if (!a.moves || a.reveal) continue;
    const m = a.moves;
    const rows = (a.changed?.length ? a.changed : [...m.new.map((r) => ({ ...r, change: 'new' })), ...m.added.map((r) => ({ ...r, change: 'added' })), ...m.trimmed.map((r) => ({ ...r, change: 'trimmed' })), ...m.exited.map((r) => ({ ...r, change: 'exited' }))])
      .filter((r) => !r.unreliable) // a marked row is no trade: the Friday email never sizes one
      .sort((x, y) => Math.abs(y.value_delta) - Math.abs(x.value_delta))
      .slice(0, FOLLOW_ROWS);
    const of = (c: string) => rows.filter((r) => r.change === c);
    const keep: Alert13F = { slug: a.slug, slugs: a.slugs, manager: a.manager, name: a.name, quarter: a.quarter, report_date: a.report_date, filing_date: a.filing_date, accession: a.accession, sec_url: a.sec_url, accepted: a.accepted, card: a.card, tickers: [], moves: { bought_usd: m.bought_usd, sold_usd: m.sold_usd, new: of('new'), added: of('added'), trimmed: of('trimmed'), exited: of('exited') } };
    for (const s of new Set([a.slug, ...(a.slugs ?? [])])) await env.DB.put(`wk13f:${s}`, JSON.stringify(keep), { expirationTtl: 45 * 86400 });
  }
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
  let chatOnly = 0;
  let capSkips = 0;
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
    // An unconfirmed trial (email_pending) gets nothing until its emailed link is opened.
    if (!isActive(raw) || !raw.email || raw.email_pending || raw.alerts === 'off' || (only && !only.has(raw.customer))) continue;
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
    else if (!only) await rememberDelivered(env, m.customer, now, [...mine.filings.map((a) => `${filingId(a)}`), ...mine.events.map((e) => `${e.id}${e.followup ? ':details' : ''}`)]);
    if (f.digest) digest++;
    else {
      // A verified, working Discord, Slack, Telegram or webhook destination replaces email, unless the member kept email
      // (keep_email); then email too, while there's room for it today. Never for a replay or with all destinations failing.
      if (!only) {
        // Only destinations that took a connect message or a test (verified) replace email.
        const dests = (['discord', 'slack', 'telegram', 'webhook'] as const).filter((d) => !!ch[d] && !!ch.verified?.[d] && (d !== 'webhook' || isPro(m)));
        if (dests.length) {
          const fails = await getFailures(env, m.customer);
          pressure ??= await emailPressure(env, now);
          if (dests.some((d) => !fails[d]) && (!ch.keep_email || pressure.room - mails.length <= 0)) {
            chatOnly++;
            continue;
          }
        }
      }
      const test = !!m.test || testAddress(m.email);
      // Test members get no 13G or 13G/A by email (feed, chat and webhooks above only): the most frequent form, and
      // the least worth the shared email budget.
      const evs = test && !only ? mine.events.filter((e) => e.kind !== '13g') : mine.events;
      if (!mine.filings.length && !evs.length) continue;
      // Test members: at most TEST_MAIL_CAP alert emails a day; past that, the feed, chat and webhooks above only.
      const n = test && !only ? Number((await env.DB.get(testMailKey(m.customer, now))) ?? 0) : 0;
      if (test && !only && n >= TEST_MAIL_CAP) {
        testCapped++;
        continue;
      }
      let send = { filings: mine.filings, events: evs };
      if (!only) {
        const win = JSON.parse((await env.DB.get(`mailwin:${m.customer}`)) ?? 'null') as Held | null;
        const open = win && win.until > now;
        pressure ??= await emailPressure(env, now);
        const tight = pressure.room - mails.length <= pressure.projected;
        const deadline = inDeadlineWeek(now);
        // A 13F's moves follow-up (its first email went without them) is what the member waits for: never held for the
        // short window, only while email is short or in deadline week (one email an hour, the lead, Nov 11).
        if (open && (tight || deadline || !mine.filings.some((a) => a.followup))) {
          // Inside this member's window: held, sent with the window's other alerts at its end.
          await env.DB.put(`mailwin:${m.customer}`, JSON.stringify({ ...win, filings: [...win.filings, ...mine.filings], events: [...win.events, ...evs] }));
          held++;
          continue;
        }
        // Anything still held goes out with this email (the window ended, or email is no longer short).
        if (win && (win.filings.length || win.events.length)) send = { filings: [...win.filings, ...mine.filings], events: [...win.events, ...evs] };
        // This email opens the member's next window.
        const until = now + (deadline ? DEADLINE_WINDOW_MS : tight ? COALESCE_MS : COALESCE_BASE_MS);
        await env.DB.put(`mailwin:${m.customer}`, JSON.stringify({ until, filings: [], events: [] } satisfies Held));
        (heldIndex ??= JSON.parse((await env.DB.get(HELD)) ?? '{}') as Record<string, number>)[m.customer] = until;
      }
      // The day's email room: members' 13F alerts get all of it, other alert emails stop with FILING_HOLD left. Past it the
      // email is skipped (the alert went to feed, chat and webhooks above), with a feed note and a count for /status/.
      if (!only && !test) {
        pressure ??= await emailPressure(env, now);
        if (pressure.room - mails.length - (send.filings.length ? 0 : FILING_HOLD) <= 0) {
          await capSkipped(env, m, ch, now);
          capSkips++;
          continue;
        }
      }
      // Never the same alert twice to one member (an operator's replay excepted).
      if (!only) {
        send = await unmailed(env, m.customer, send.filings, send.events, now);
        if (!send.filings.length && !send.events.length) continue;
      }
      if (test && !only) await env.DB.put(testMailKey(m.customer, now), String(n + 1), { expirationTtl: 2 * 86400 });
      const am0 = alertMail(env, m.email, send.filings, send.events, f, m);
      // Berkshire's 13F (Nov 16): monthly members and monthly trials get one line to switch to yearly.
      const yl = replay ? null : await yearlyPeakLine(env, m, send.filings);
      const ylHtml = yl ? `<p style="margin:12px 0">${yl.replace(/ (Switch now|Add card): (https:\/\/\S+)$/, (_, w: string, u: string) => ` <a href="${u}" style="color:#1d4ed8">${w} →</a>`)}</p>` : '';
      const foot = am0.html ? am0.html.lastIndexOf('<p style="margin-top:24px') : -1;
      const am = yl ? { ...am0, text: am0.text.replace(FOOTER, `\n\n${yl}${FOOTER}`), html: am0.html && foot >= 0 ? am0.html.slice(0, foot) + ylHtml + am0.html.slice(foot) : am0.html } : am0;
      mails.push({ ...am, ...(replay ? { subject: `Replay (test): ${am.subject}` } : {}), test, filing: send.filings.length > 0, ids: [...send.filings.map((a) => a.accession), ...send.events.map((e) => e.id)] });
      notes.push(m);
    }
  }
  if (heldIndex) await env.DB.put(HELD, JSON.stringify(heldIndex));
  // An operator's replay or preview (`only`) counts against the day's preview cap.
  const mail = await sendMail(env, mails, { bulk: true, preview: !!only });
  await logSent(env, mails.length, now);
  await flushChannelLatency(env, !only);
  if (mail.split(',').every((s) => s === '200')) for (const m of notes) await noted(env, m);
  for (const p of pausedNotes) await env.DB.put(p.key, '1', { expirationTtl: 2 * 86400 });
  return { emails: mails.length, digest, mail, ...(held ? { held } : {}), ...(testCapped ? { test_capped: testCapped } : {}), ...(chatOnly ? { chat_only: chatOnly } : {}), ...(capSkips ? { cap_skipped: capSkips } : {}), ...(pausedNotes.length ? { paused_notes: pausedNotes.length } : {}), ...(chats.length ? { chats: chats.join(', ') } : {}), ...(late.length ? { late: late.length } : {}) };
}

type Delivered = { day: string; ids: string[] }[];

/**
 * Operator audit, read-only: one alert's stored copy (the day's store keeps a month) and the members it reached
 * (delivered:{customer}, 30 days), as row IDs with a test flag. The route logs the read for each member listed.
 */
export async function deliveryRecord(env: Env, id: string, now: number) {
  let alert: Record<string, unknown> | null = null;
  for (let d = 0; d < 31 && !alert; d++) {
    const raw = await env.DB.get(`digest:${etDay(now - d * DAY)}`);
    if (!raw) continue;
    const day = JSON.parse(raw) as DigestDay;
    const versions = [...day.filings.filter((a) => a.accession === id), ...[...day.events, ...(day.late ?? [])].filter((e) => e.id === id)];
    if (versions.length) alert = { day: etDay(now - d * DAY), versions: versions.length, last: versions[versions.length - 1] };
  }
  const recipients: { customer: string; test: boolean; day: string; parts: string[] }[] = [];
  const members = new Map((await listMembers(env)).map((m) => [m.customer, m]));
  for (const c of [...members.keys(), 'probe-latency']) {
    const log = JSON.parse((await env.DB.get(`delivered:${c}`)) ?? '[]') as Delivered;
    for (const d of log) {
      const parts = d.ids.filter((x) => x === id || x.startsWith(`${id}:`));
      const m = members.get(c);
      if (parts.length) recipients.push({ customer: c, test: !m || !!m.test || testAddress(m.email ?? ''), day: d.day, parts });
    }
  }
  return { id, alert, recipients, counts: { members: new Set(recipients.map((r) => r.customer)).size, real: new Set(recipients.filter((r) => !r.test).map((r) => r.customer)).size }, note: 'delivered: keeps 30 days and at most 50 IDs a member a day' };
}

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
    const fl = filings.filter((a) => got.has(`${filingId(a)}`) || mine.filings.includes(a));
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
    if (!isActive(raw) || !raw.email || raw.email_pending || raw.alerts === 'off' || raw.plan === 'holdterm') continue;
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

/**
 * Saturday: "Your names this week" to every Copy, Pro and Fund member, paused ones included, unless they turned it
 * off (weekly_digest). The week's alerts that match their follows, from the daily stores. `only`: an operator's preview.
 */
export async function runWeeklyNames(env: Env, now: number, only?: string[]): Promise<{ emails: number; status: string }> {
  const week = etDay(now);
  if (!only && (await env.DB.get('names-weekly:last')) === week) return { emails: 0, status: 'already sent' };
  if (!only && (await env.DB.get('names-weekly:tried')) === week) return { emails: 0, status: 'already tried' };
  const days = (await Promise.all(Array.from({ length: 7 }, (_, d) => env.DB.get(`digest:${etDay(now - d * 86_400_000)}`)))).flatMap((r) => (r ? [JSON.parse(r) as DigestDay] : []));
  // Each filing and event once, in its last stored version (a 13F's moves follow-up, a Form 4's details).
  const last = <T>(xs: T[], id: (x: T) => string) => [...new Map(xs.map((x) => [id(x), x])).values()];
  const filings = await withCards(env, last(days.reverse().flatMap((d) => d.filings), (a) => a.accession));
  const events = last(days.flatMap((d) => [...d.events, ...(d.late ?? [])]), (e) => e.id);
  const meta = await filerMeta(env);
  // Friday 9:15pm ET: the week of that Monday.
  const weekOf = new Date(now - 4 * 86_400_000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const mails: Mail[] = [];
  for (const raw of await listMembers(env)) {
    if (!raw.email || raw.email_pending || raw.plan === 'holdterm' || raw.plan === 'free' || (only ? !only.includes(raw.email) : !(isActive(raw) || isPaused(raw, now)))) continue;
    const f = await getFollows(env, raw);
    if (f.weekly_digest === false && !only) continue;
    // Paused members' alerts are off; the weekly summary still covers their follows.
    const mine = forMember({ ...raw, alerts: raw.alerts === 'off' ? f.investors : raw.alerts }, f, filings, events, meta);
    mails.push({ ...weeklyNamesMail(env, raw.email, weekOf, mine.filings, mine.events, f, isPaused(raw, now) ? raw.paused_until! : null), test: !!raw.test || testAddress(raw.email) });
  }
  // An operator's preview goes now; the real send is low priority (the weekend budget).
  if (!only) await env.DB.put('names-weekly:tried', week, { expirationTtl: 8 * 86400 });
  const status = await sendMail(env, mails, only ? { preview: true } : { tier: 'low' });
  if (!only && (status === 'none' || status.split(',').every((s) => s === '200'))) {
    await env.DB.put('names-weekly:last', week);
    // The front end shows the digest promise once the first real send went out.
    if (mails.some((m) => !m.test)) await env.DB.put('names-weekly:live', week);
  }
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

let secMap: { at: number; text: string } | null = null;
/** Tickers and names for CUSIPs from the public securities map, without parsing all of it. */
export async function lookupTickers(env: Env, rows: { cusip: string; ticker: string | null; display_name: string | null }[]): Promise<void> {
  const missing = rows.filter((r) => !r.ticker);
  if (!missing.length) return;
  // Kept per isolate for an hour: gene's restater names stored rows every 5 minutes, and gene has no edge cache.
  if (!secMap || Date.now() - secMap.at > 3600_000) {
    const res = await fetch(`${env.DATA_URL}securities.json`, { cf: { cacheTtl: 86400 } } as RequestInit);
    if (!res.ok) return;
    secMap = { at: Date.now(), text: await res.text() };
  }
  const text = secMap.text;
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

/**
 * Names an alert's shown rows from the ticker map (the lead, Nov 11): a row without a ticker takes the map's ticker and
 * name, so a filer's truncated nameOfIssuer ("Aperture Ac", "Drugs Made in America Acquis") shows only when the map has
 * no entry. Every list the email and feed name (moves, exchanged, not counted, held, the Corrected line), largest first,
 * at most `cap` rows (each lookup scans the map: Cloudflare's CPU).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nameRows(env: Env, m: Moves | undefined, extra: any[] = [], cap = 40): Promise<void> {
  type Named = { cusip: string; ticker: string | null; display_name: string | null; value?: number; value_delta?: number | null };
  const all = [...(m ? [...m.new, ...m.added, ...m.trimmed, ...m.exited, ...(m.exchanged ?? []), ...(m.not_counted ?? [])] : []), ...extra] as Named[];
  const rows = all.filter((r) => r && !r.ticker && r.cusip).sort((a, b) => Math.abs(b.value_delta ?? b.value ?? 0) - Math.abs(a.value_delta ?? a.value ?? 0)).slice(0, cap);
  await lookupTickers(env, rows);
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
let SPLITS: { at: number; list: { cusip: string; ticker?: string; to_quarter: string; ratio?: number }[] } | null = null;
export async function splitsFor(env: Env, quarter: string): Promise<Map<string, number>> {
  if (!SPLITS || Date.now() - SPLITS.at > 3600_000) {
    try {
      const r = await fetch(`${env.DATA_URL}splits.json`);
      SPLITS = { at: Date.now(), list: r.ok ? (((await r.json()) as { splits?: { cusip: string; ticker?: string; to_quarter: string; ratio?: number }[] }).splits ?? []) : [] };
    } catch {
      SPLITS = { at: Date.now(), list: [] };
    }
  }
  // By CUSIP: the ratio the prior quarter's shares are multiplied by. By ticker too, only to keep the row from the unit check.
  const on = SPLITS.list.filter((x) => x.to_quarter === quarter);
  return new Map([...on.flatMap((x) => (x.ticker ? [[x.ticker, 1] as [string, number]] : [])), ...on.map((x) => [x.cusip, Number(x.ratio) > 0 ? Number(x.ratio) : 1] as [string, number])]);
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
  await loadReissues(env, now);
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
  const detectedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
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
      let held: HeldRow[] = [];
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
          // The publish gate: a row whose price doesn't check out is named "pending check" and left out.
          const g = gateMoves(r, book, await splitsFor(env, q), await consensusFor(env, q, r.changed.map((x) => x.cusip)));
          r = g;
          held = g.held;
          moves = r.moves;
          // Every shown row named from the map, exits and held lines too (only new rows were looked up above).
          await nameRows(env, moves, g.held);
          changed = keepChanged(r.changed);
          // Watchers match on every row, held ones too: they get the alert with "TICKER: move pending check".
          tickers = [...new Set([...r.changed, ...g.held].map((x) => x.ticker).filter((t): t is string => !!t))];
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
        detected: (e as { detected_at?: string }).detected_at?.replace(/\.\d{3}Z$/, 'Z') ?? detectedAt,
        moves,
        tickers,
        ...(changed ? { changed } : {}),
        // Too big to parse here, or no prior quarter on hand: gene computes the moves from EDGAR within minutes.
        ...(!moves && !top ? { moves_pending: true } : {}),
        ...(isExtra ? { extra: true } : {}),
        ...(top ? { top } : {}),
        ...(held.length ? { held } : {}),
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
  // A 13F sent without its moves: its first alert time, for the latency row its moves follow-up logs.
  if (later.length) {
    const first = JSON.parse((await env.DB.get('alerts:first')) ?? '{}') as Record<string, string>;
    for (const f of later) first[f.accession] ??= new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    await env.DB.put('alerts:first', JSON.stringify(Object.fromEntries(Object.entries(first).slice(-500))));
  }
  await queueHeld(env, fresh);
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
async function logLatency(env: Env, filings: { slug: string; accession: string; accepted?: string; detected?: string; replay_to?: string[]; kind?: string; manager?: string; quarter?: string; form?: string; extra?: boolean; coalesced?: boolean; followup?: boolean }[], sentAt: number): Promise<void> {
  if (!filings.length) return;
  const replays = new Set(JSON.parse((await env.DB.get('alerts:replays')) ?? '[]') as string[]);
  // Emails held for the daily limit: the row is kept but marked, and not counted as fast.
  const delayed = new Set(JSON.parse((await env.DB.get((await import('./email')).DELAYED_IDS)) ?? '[]') as string[]);
  const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as unknown[];
  // Which poller sent it (the trader scores each host): `server` is ours, never named on public pages.
  const { isCloudflare } = await import('./failover');
  const host = isCloudflare(env) ? 'cloudflare' : 'server';
  // A 13F timed by its moves follow-up: its first alert went earlier, without the moves.
  const first = filings.some((f) => f.followup) ? (JSON.parse((await env.DB.get('alerts:first')) ?? '{}') as Record<string, string>) : {};
  const sentIso = new Date(sentAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const add = filings
    .filter((f) => f.accepted)
    .map((f) => ({ host, detected_at: f.detected ?? null, first_alert_at: (f.kind ?? '13f') === '13f' ? (f.followup ? (first[f.accession] ?? null) : sentIso) : null, ...(f.replay_to?.length ? { test: true } : {}), slug: f.slug, manager: f.manager || undefined, quarter: f.quarter, form: f.form ?? '13F-HR', kind: f.kind ?? '13f', ...((f.kind ?? '13f') === '13f' ? { moves: true } : {}), accession: f.accession, accepted: f.accepted, coverage: f.extra ? 'any_filer' : 'curated', sent: new Date(sentAt).toISOString(), seconds: Math.round((sentAt - Date.parse(f.accepted!)) / 1000), ...(replays.has(f.accession) ? { replay: true } : {}), ...(delayed.has(f.accession) ? { email_delayed: true } : {}), ...(f.coalesced ? { coalesced: true } : {}), ...(f.followup ? { followup: true } : {}) }));
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
  const at = Date.now();
  await logLatency(env, mine.map((f) => ({ ...f, kind: '13f', followup: true })), at);
  await env.DB.put('host:moves-sent-last', JSON.stringify({ at: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'), accession: mine[0].accession }));
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
  await loadReissues(env, now);
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
      const r = gateMoves(netRenamed(raw), book, await splitsFor(env, q), await consensusFor(env, q, raw.changed.map((x) => x.cusip)));
      ready.push({ ...p, moves: r.moves, changed: keepChanged(r.changed), tickers: [...new Set([...r.changed, ...r.held].map((x) => x.ticker).filter((t): t is string => !!t))], followup: true, moves_pending: undefined, held: r.held.length ? r.held : undefined });
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
  const sent = await sendFollowups(env, ready, now);
  await queueHeld(env, ready.filter((x) => !x.replay_to?.length));
  return { pending: pending.length, ...sent, ...(failed.length ? { failed } : {}) };
}

/** Ingest's consensus.json (other filers' median value per share by quarter and CUSIP), read at most hourly. */
let CONSENSUS: { at: number; quarters: Record<string, Record<string, number>> } | null = null;
export async function consensusFor(env: Env, quarter: string, cusips: string[]): Promise<Map<string, Consensus>> {
  // Parsing the 660 KB file takes about 8 ms of CPU, nearly all of Cloudflare's 10 ms a minute: there the gate checks
  // the split basis only (which holds every split error), and gene's own moves, re-checks and reconciliation add prices.
  if ((await import('./failover')).isCloudflare(env)) return new Map();
  if (!CONSENSUS || Date.now() - CONSENSUS.at > 3600_000) {
    try {
      const r = await fetch(`${env.DATA_URL}consensus.json`);
      CONSENSUS = { at: Date.now(), quarters: r.ok ? (((await r.json()) as { quarters?: Record<string, Record<string, number>> }).quarters ?? {}) : {} };
    } catch {
      CONSENSUS = { at: Date.now(), quarters: {} };
    }
  }
  const cur = CONSENSUS.quarters[quarter] ?? {};
  const prev = CONSENSUS.quarters[prevQuarter(quarter)] ?? {};
  return new Map(cusips.map((c) => [c, { cur: cur[c] ?? null, prev: prev[c] ?? null }]));
}

/** Alerts sent with rows held by the gate: gene re-checks them against ingest's build (KV alerts:pending-check). */
async function queueHeld(env: Env, sent: Alert13F[]): Promise<void> {
  const add = sent.filter((a) => a.held?.length);
  if (!add.length) return;
  const queue = JSON.parse((await env.DB.get('alerts:pending-check')) ?? '[]') as Alert13F[];
  const keep = queue.filter((x) => !add.some((a) => a.accession === x.accession));
  await env.DB.put('alerts:pending-check', JSON.stringify([...keep, ...add.map((a) => ({ ...a, sent_at: new Date().toISOString() }))]));
}

/** An ingest book row, as /v1 serves it: the move the data run computed for one position. */
type BuildRow = Omit<MoveRow, 'split'> & { split?: number | { ratio?: number } | null };

/**
 * Ingest's build of a 13F (R2 h/{slug}/{quarter}.json, or fb/{quarter}/{cik}.json for other filers): its changed rows by
 * CUSIP, once the build serves this accession (as the book, or as its base before a merged amendment). Null until then,
 * or when the book carries no per-row moves.
 */
async function buildRows(env: Env, a: Alert13F): Promise<{ build: string | null; rows: Map<string, BuildRow> } | null> {
  const cik = a.sec_url.match(/\/data\/(\d+)\//)?.[1]?.padStart(10, '0') ?? '';
  const obj = (!a.extra ? await env.HIST.get(`h/${a.slug}/${a.quarter}.json`) : null) ?? (cik ? await env.HIST.get(`fb/${a.quarter}/${cik}.json`) : null);
  if (!obj) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = await new Response(obj.body).json();
  const serves = q.accession === a.accession || (Array.isArray(q.filings) && q.filings.some((x: { accession?: string; role?: string }) => x.accession === a.accession && x.role === 'base'));
  // Exits are in the book's own exited[] list, not in holdings[].
  // An exit inside holdings[] (row_type exited, change possibly null) counts as exited too.
  const holdings = [...((q.holdings ?? []) as BuildRow[]), ...((q.exited ?? []) as BuildRow[]).map((h) => ({ ...h, change: h.change ?? 'exited' }))].map((h) =>
    (h as { row_type?: string }).row_type === 'exited' && !h.change ? { ...h, change: 'exited' } : h,
  );
  if (!serves || !holdings.some((h) => 'value_delta' in h)) return null;
  const rows = new Map(holdings.filter((h) => h.change && h.change !== 'unchanged').map((h) => [rowKey(h), h]));
  return { build: obj.customMetadata?.['build-id'] ?? obj.customMetadata?.build_id ?? q.build_id ?? null, rows };
}
/** One position's key across EDGAR tables and ingest's books: CUSIP and put/call ("Call" in one, "CALL" in the other). */
const rowKey = posKey;
const ratioOf = (r: BuildRow) => (typeof r.split === 'object' ? Number(r.split?.ratio) || 1 : Number(r.split) || 1);

/**
 * Once: correction notes that read a row missing from the build as "unchanged" (Nov 11, 10:4x UTC) are pulled from the
 * day stores, the verdicts and members' feeds. A verdict left with no failed row passes. No correction email went out
 * for them (alerts accepted before RECONCILE_MAIL_FROM are never mailed); any queued one is dropped.
 */
export async function scrubFalseCorrections(env: Env, now: number): Promise<Record<string, unknown> | null> {
  const FLAG = 'alerts:scrub-unchanged:v2';
  if (await env.DB.get(FLAG)) return null;
  const bogus = (r: import('./email').CorrectionRow) => r.v1.change === 'unchanged' && r.v1.value_delta === 0;
  const n = { stores: 0, verdicts: 0, feeds: 0, queued_mail: 0, accessions: new Set<string>() };
  for (let d = 0; d < 31; d++) {
    const key = `digest:${etDay(now - d * DAY)}`;
    const raw = await env.DB.get(key);
    if (!raw) continue;
    const store = JSON.parse(raw) as DigestDay;
    let hit = false;
    for (const x of store.filings) {
      if (!x.corrected?.rows.some(bogus)) continue;
      n.accessions.add(x.accession);
      const rows = x.corrected.rows.filter((r) => !bogus(r));
      x.corrected = rows.length ? { ...x.corrected, rows } : undefined;
      hit = true;
    }
    if (hit) {
      n.stores++;
      await env.DB.put(key, JSON.stringify(store), { expirationTtl: 31 * 86400 });
    }
  }
  const log = JSON.parse((await env.DB.get(RECONCILED)) ?? '[]') as Reconciled[];
  for (const v of log) {
    if (!v.failed.some(bogus)) continue;
    n.accessions.add(v.accession);
    v.failed = v.failed.filter((r) => !bogus(r));
    if (!v.failed.length) v.result = 'pass';
    v.class = alertClass(v.failed, v.rows, v.accession);
    n.verdicts++;
  }
  if (n.verdicts) await env.DB.put(RECONCILED, JSON.stringify(log));
  // Feeds keep their own copy of each item: rebuilt from the scrubbed day stores, with reissued CUSIPs netted (an
  // "EXIT XOM · NEW XOM" pair reads as the one add or trim it was) and today's display names ("Fidelity (FMR)").
  const fixed = new Map<string, Alert13F>();
  const rows = movesRows;
  for (let d = 0; d < 31; d++) {
    const raw = await env.DB.get(`digest:${etDay(now - d * DAY)}`);
    if (!raw) continue;
    for (const x of (JSON.parse(raw) as DigestDay).filings) {
      const ch = x.moves ? rows(x.moves) : [];
      const net = x.moves ? netRenamed({ moves: x.moves, changed: ch }) : null;
      const renamed = !!net && net.changed !== ch;
      if (!n.accessions.has(x.accession) && !renamed) continue;
      fixed.set(filingId(x), renamed ? { ...x, moves: { ...net!.moves, bought_usd: x.moves!.bought_usd, sold_usd: x.moves!.sold_usd } } : x);
    }
  }
  n.feeds = await rewriteFeeds(env, fixed, now);
  // Queued correction emails (delayed for the daily limit, or awaiting retry) with an "unchanged" line: dropped.
  for (const k of ['host:mail-delayed', 'host:mail-retry']) {
    const q = JSON.parse((await env.DB.get(k)) ?? '[]') as Mail[];
    const keep = q.filter((m) => !(/Correction:/.test(m.subject) && / was unchanged, not /.test(m.text)));
    if (keep.length !== q.length) {
      n.queued_mail += q.length - keep.length;
      await env.DB.put(k, JSON.stringify(keep));
    }
  }
  const res = { at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), stores: n.stores, verdicts: n.verdicts, feeds: n.feeds, queued_mail: n.queued_mail, accessions: [...n.accessions] };
  await env.DB.put(FLAG, JSON.stringify(res));
  return res;
}

/** Stored new and exited lines of one position (CUSIP and option type, case-blind) as one row; the rows as they are otherwise. */
function pairStored(rows: MoveRow[]): MoveRow[] {
  const key = (r: MoveRow) => `${r.cusip.toUpperCase()}|${(r.put_call ?? '').toUpperCase()}`;
  const exits = new Map(rows.filter((r) => r.change === 'exited').map((r) => [key(r), r]));
  const drop = new Set<MoveRow>();
  const merged: MoveRow[] = [];
  for (const n of rows) {
    const e = n.change === 'new' && n.shares > 0 ? exits.get(key(n)) : undefined;
    if (!e || !e.prev_shares || drop.has(e)) continue;
    drop.add(n).add(e);
    const prevValue = -e.value_delta;
    const ps = n.value / n.shares, pps = prevValue / e.prev_shares;
    const book = n.delta_pct_of_book ? Math.abs(n.value_delta / n.delta_pct_of_book) : null;
    const offUnits = ps > 0 && pps > 0 && (ps / pps > 3 || pps / ps > 3);
    const delta = offUnits ? n.value - prevValue : ((n.shares - e.prev_shares) * n.value) / n.shares;
    if (n.shares === e.prev_shares && !offUnits) continue;
    merged.push({ ...n, ticker: n.ticker ?? e.ticker, display_name: n.display_name ?? e.display_name, change: delta >= 0 ? 'added' : 'trimmed', prev_shares: e.prev_shares, prev_value: prevValue, value_delta: Math.round(delta), value_delta_basis: offUnits ? 'filed_value' : 'trade', delta_pct_of_book: book ? delta / book : null, ...(offUnits ? { unreliable: 'shares' as const } : {}) });
  }
  return drop.size ? [...rows.filter((r) => !drop.has(r)), ...merged] : rows;
}

const movesRows = (m: Moves) => [...m.new.map((r) => ({ ...r, change: 'new' })), ...m.added.map((r) => ({ ...r, change: 'added' })), ...m.trimmed.map((r) => ({ ...r, change: 'trimmed' })), ...m.exited.map((r) => ({ ...r, change: 'exited' }))] as MoveRow[];

/** Members' feed items for these alerts re-rendered (title and text) where they read differently; the feeds changed. */
async function rewriteFeeds(env: Env, fixed: Map<string, Alert13F>, now: number): Promise<number> {
  let feeds = 0;
  if (!fixed.size) return feeds;
  for (const m of await listMembers(env)) {
    const key = `feed:${m.customer}`;
    const raw = await env.DB.get(key);
    if (!raw) continue;
    let hit = false;
    const out = (JSON.parse(raw) as FeedItem[]).map((i) => {
      const a = fixed.get(i.id);
      if (!a) return i;
      const [fresh] = feedItems(env, [a], [], now, true);
      if (fresh.title === i.title && fresh.text === i.text) return i;
      hit = true;
      return { ...i, title: fresh.title, text: fresh.text };
    });
    if (hit) {
      feeds++;
      await env.DB.put(key, JSON.stringify(out));
    }
  }
  return feeds;
}

/**
 * A stored row sent before its split was on file, restated in today's units (prior shares times the ratio, the trade
 * re-sized as shares x this filing's price) only when that reproduces ingest's build figure from reconciliation: FMR's
 * Q3 CRWD, 4-for-1, 7,847,117 -> 31,388,468 prior shares, +$8.55B -> +$2.32B. Else the row as sent.
 */
function splitRestate(r: MoveRow, splits: Map<string, number>, built: import('./email').CorrectionRow[]): MoveRow[] {
  const k = splits.get(r.cusip) ?? 1;
  const b = built.find((c) => c.cusip === r.cusip && (c.put_call ?? '') === (r.put_call ?? ''));
  if (k === 1 || !b || r.split || r.put_call || !r.shares || !r.prev_shares || !r.value) return [r];
  const prev = Math.round(r.prev_shares * k);
  const delta = Math.round(((r.shares - prev) * r.value) / r.shares);
  const want = b.v1.value_delta;
  if (b.v1.change === 'unchanged' ? prev !== r.shares : Math.abs(delta - want) > Math.max(2, Math.abs(want) * 0.01)) return [r];
  if (prev === r.shares) return [];
  return [{ ...r, change: delta > 0 ? 'added' : 'trimmed', prev_shares: prev, split: k, prev_shares_as_filed: r.prev_shares, value_delta: delta, delta_pct_of_book: r.delta_pct_of_book != null && r.value_delta ? (r.delta_pct_of_book * delta) / r.value_delta : null }];
}

/**
 * gene, every 5 minutes: members' feed items restated from the day stores once the facts behind them are on file, so a
 * feed reads like ingest's build: a reissued CUSIP netted as one add or trim once it is linked with a units result (GTES
 * when ingest's file links it), and a split on file applied where the build confirms it (splitRestate). Emails and the
 * day stores keep what was sent; the feed's "Corrected" line still says what the alert said.
 */
export async function restateFeeds(env: Env, now: number): Promise<{ feeds: number; alerts: string[] }> {
  await loadReissues(env, now);
  const fixed = new Map<string, Alert13F>();
  for (let d = 0; d < 31; d++) {
    const raw = await env.DB.get(`digest:${etDay(now - d * DAY)}`);
    if (!raw) continue;
    for (const x of (JSON.parse(raw) as DigestDay).filings) {
      if (!x.moves) continue;
      // Rows stored before every shown row was named ("Aperture Ac"): named from the ticker map, the Corrected line's too.
      const corr = (x.corrected?.rows ?? []).filter((c) => !c.ticker).map((c) => ({ c, r: { cusip: c.cusip, ticker: null as string | null, display_name: null as string | null } }));
      await nameRows(env, x.moves, [...(x.held ?? []), ...corr.map((y) => y.r)], 80);
      for (const y of corr) if (y.r.ticker) Object.assign(y.c, { ticker: y.r.ticker, name: y.r.display_name ?? y.c.name });
      // A stored row on a line ingest has since flagged goes by its reliable side (markUnreliable): "both" on an add or
      // trim leaves the feed; "value" and "shares" stay, marked, out of the totals and the headline.
      // A stored row sized from share counts the filed values can't support (guardShares) takes the filed-value change:
      // its own prior value, else the correction's /v1 figure for the line (Mizuho's SPY calls, -$13.3B -> -$58.0M).
      const v1 = new Map((x.corrected?.rows ?? []).filter((c) => c.v1.change === 'added' || c.v1.change === 'trimmed').map((c) => [posKey({ cusip: c.cusip, put_call: c.put_call }), c.v1.value_delta]));
      const stored = movesRows(x.moves);
      // A new and an exited line on one CUSIP and option type (stored before put/call matched case-blind: Mizuho's Q3
      // "Call" against its Q2 "CALL") are one position: netted, sized from filed values when the two quarters' values per
      // share are over 3x apart (calls $1,272 -> $28,846 a share: -$58.0M, not -$13.3B), else as a trade.
      const paired = pairStored(stored);
      // Ingest's current flag on each line (its book for the filing; read only for filings with option or marked lines):
      // ingest's side wins. A line it now holds ("both": Mizuho's non-standard option lines under the options rule)
      // leaves the moves for the held line, and its correction note says so; an unmarked line takes its side.
      const book = stored.some((r) => r.put_call || r.unreliable) ? await buildRows(env, x).catch(() => null) : null;
      // Re-marked from ingest's current data, not the stored marking (the analyst's round 39): Mizuho Markets' SPY calls,
      // stored as \"shares\" with a -$58.0M filed change, are \"both\" in hl/ now. Its held_reason and cusip_mismatch ride along.
      const sideOf = (r: MoveRow) => {
        const b = book?.rows.get(rowKey(r)) as (BuildRow & { held_reason?: string }) | undefined;
        const s = b ? unreliableSide(b) : null;
        return s ? { unreliable: s, ...(b?.held_reason ? { held_reason: b.held_reason } : {}) } : undefined;
      };
      const flags = (r: MoveRow): MoveRow => {
        const b = book?.rows.get(rowKey(r)) as (BuildRow & { cusip_mismatch?: boolean }) | undefined;
        return b?.cusip_mismatch === true && !r.cusip_mismatch ? { ...r, cusip_mismatch: true } : r;
      };
      const marked0 = paired.map((r) => markUnreliable(guardShares(flags(r), r.prev_value != null ? r.value - r.prev_value : v1.get(posKey(r))), sideOf(r)));
      // A line whose value can't be trusted names other filers' median per share.
      const needMedian = marked0.filter((r) => r && (r.unreliable === 'value' || r.unreliable === 'both') && r.median_per_share == null);
      const cons = needMedian.length ? await consensusFor(env, x.quarter, needMedian.map((r) => r!.cusip)).catch(() => null) : null;
      const now1 = marked0.map((r) => (r && cons?.get(r.cusip)?.cur && (r.unreliable === 'value' || r.unreliable === 'both') && r.median_per_share == null ? { ...r, median_per_share: cons.get(r.cusip)!.cur! } : r));
      const heldNow = paired.filter((r, i) => !now1[i] && sideOf(r)?.unreliable === 'both').map((r) => ({ cusip: r.cusip, ticker: r.ticker, issuer: r.issuer, display_name: r.display_name, put_call: r.put_call, change: r.change, reason: 'unreliable_shares' as const }));
      const isHeld = (p: { cusip: string; put_call?: string | null }) => heldNow.some((h) => posKey(h) === posKey(p));
      const ch = now1.filter((r): r is MoveRow => !!r);
      const splits = x.corrected?.rows.length ? await splitsFor(env, x.quarter) : null;
      const adj = splits ? ch.flatMap((r) => splitRestate(r, splits, x.corrected!.rows)) : ch;
      const net = netRenamed({ moves: x.moves, changed: adj });
      if (paired === stored && now1.every((r, i) => r === stored[i]) && net.changed === adj && adj.length === ch.length && adj.every((r, i) => r === ch[i])) {
        // A corrected filing is rendered from its stored copy too: an item frozen with other figures (gene's Mizuho
        // item read "SPY calls -$13.3B" from a render the day store never kept) takes the stored moves and the correction.
        // Every stored item is re-rendered with today's rules (held lines on one "Not counted" line, possible CUSIP
        // changes held): rewriteFeeds writes only the items whose text changes.
        fixed.set(filingId(x), x);
        continue;
      }
      const moves = net.changed === adj ? movesOf(adj) : net.moves;
      // Totals cover every row (the stored lists keep the largest few): each changed row's stored figure comes out and
      // what it counts now goes in (nothing, once dropped or marked).
      const counts = (r: MoveRow | null) => (!r || r.unreliable ? 0 : r.value_delta);
      const was = stored.map(counts), is = now1.map(counts);
      const bought = x.moves.bought_usd - was.reduce((s, v) => s + Math.max(v, 0), 0) + is.reduce((s, v) => s + Math.max(v, 0), 0);
      const sold = x.moves.sold_usd + was.reduce((s, v) => s + Math.min(v, 0), 0) - is.reduce((s, v) => s + Math.min(v, 0), 0);
      const held = heldNow.length ? { held: [...(x.held ?? []).filter((h) => !isHeld(h)), ...heldNow], ...(x.corrected ? { corrected: { ...x.corrected, rows: x.corrected.rows.map((c) => (isHeld(c) ? { ...c, v1: { change: 'held', value_delta: 0 } } : c)) } } : {}) } : {};
      fixed.set(filingId(x), { ...x, moves: { ...moves, bought_usd: bought, sold_usd: sold }, ...held });
    }
  }
  return { feeds: await rewriteFeeds(env, fixed, now), alerts: [...fixed.keys()] };
}

/**
 * gene, every 5 minutes: rows the gate held, against ingest's build. A held row that the build has, with no unit flag,
 * and that now passes the same gate goes out in a "checked" follow-up; one the build shows unchanged is dropped; the rest
 * wait, for up to 7 days.
 */
export async function checkHeld(env: Env, now: number): Promise<Record<string, unknown>> {
  const queue = JSON.parse((await env.DB.get('alerts:pending-check')) ?? '[]') as Alert13F[];
  if (!queue.length) return { pending: 0 };
  const ready: Alert13F[] = [];
  const wait: Alert13F[] = [];
  const log: Record<string, unknown>[] = [];
  // Each held row's end, for latency.json's reconciliation.held (no member data).
  const ended: HeldEnd[] = [];
  const end = (a: Alert13F, h: HeldRow, outcome: HeldEnd['outcome']) =>
    ended.push({ accession: a.accession, ticker: h.ticker ?? null, cusip: h.cusip, rule: h.reason, held_at: a.accepted ?? a.filing_date, released_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), outcome });
  for (const a of queue) {
    const b = await buildRows(env, a);
    if (!b) {
      if (now - Date.parse(a.accepted ?? a.filing_date) < 7 * DAY) wait.push(a);
      else {
        log.push({ accession: a.accession, result: 'expired', rows: a.held!.length });
        for (const h of a.held!) end(a, h, 'expired');
      }
      continue;
    }
    const cons = await consensusFor(env, a.quarter, a.held!.map((h) => h.cusip));
    const ok: MoveRow[] = [];
    const still: HeldRow[] = [];
    for (const h of a.held!) {
      const r = b.rows.get(rowKey(h));
      if (!r) {
        end(a, h, 'dropped'); // the build shows no move here
        continue;
      }
      const prior = r.prev_shares ? { shares: r.prev_shares_as_filed ?? r.prev_shares, value: r.prev_value ?? 0 } : undefined;
      const row: MoveRow = { ...r, split: undefined, ticker: r.ticker ?? h.ticker, delta_pct_of_book: r.delta_pct_of_book ?? null };
      // A line the build flags goes by its reliable side (the analyst, Nov 11): "value" or "shares" out now, marked and
      // never in the totals; "both" (a pre-split count) waits, and is not counted once the 7 days are up. A held row whose
      // flag the build has cleared (an amendment, a later run) goes through the gate as any other: released when it passes.
      const side = unreliableSide(r);
      if (side) {
        const m = markUnreliable(row);
        if (m) {
          ok.push(m);
          end(a, h, 'passed');
        } else if (now - Date.parse(a.accepted ?? a.filing_date) >= 7 * DAY) end(a, h, 'not_counted');
        else still.push(h);
        continue;
      }
      const why = gateRow(row, prior, ratioOf(r), cons.get(r.cusip));
      const day = now - Date.parse(a.accepted ?? a.filing_date) >= DAY;
      if (!why) {
        ok.push(row);
        end(a, h, 'passed');
      } else if (day && why === 'own_prior') {
        // own_prior can't tell a real trade (a quant fund doubling shares as the price halves) from a split nobody
        // has listed; a day on, with the build agreeing and still no split in splits.json, it goes out unmarked.
        ok.push(row);
        end(a, h, 'released_after_1d');
      } else if (day) {
        // Every other rule (units, price vs filers, split basis): a day after acceptance, with the build still not
        // clearing it, the row goes out as filed and marked ("Filer's reported value looks wrong; shown as filed")
        // in the email, the feed and the archive. Never dropped silently.
        ok.push({ ...row, filer_value: true });
        end(a, h, 'shown_as_filed');
      } else still.push(h);
    }
    log.push({ accession: a.accession, build: b.build, passed: ok.length, held: still.length, dropped: a.held!.length - ok.length - still.length });
    if (ok.length) ready.push({ ...a, moves: movesOf(ok), changed: ok, tickers: [...new Set(ok.map((x) => x.ticker).filter((t): t is string => !!t))], followup: true, checked: true, held: undefined, moves_pending: undefined, sent_at: undefined });
    if (still.length && now - Date.parse(a.accepted ?? a.filing_date) < 7 * DAY) wait.push({ ...a, held: still });
  }
  if (ended.length) {
    const prev = JSON.parse((await env.DB.get(HELD_LOG)) ?? '[]') as HeldEnd[];
    await env.DB.put(HELD_LOG, JSON.stringify([...ended, ...prev].slice(0, 2000)));
  }
  const done = new Set(queue.map((x) => x.accession));
  const added = (JSON.parse((await env.DB.get('alerts:pending-check')) ?? '[]') as Alert13F[]).filter((x) => !done.has(x.accession));
  if (wait.length || added.length) await env.DB.put('alerts:pending-check', JSON.stringify([...wait, ...added]));
  else await env.DB.delete('alerts:pending-check');
  const { claimOnce } = await import('./failover');
  const mine: Alert13F[] = [];
  for (const f of ready) if (await claimOnce(env, `checked/${f.accession}`, now)) mine.push(f);
  const sent = mine.length ? await deliver(env, mine, [], now) : null;
  return { pending: queue.length, checked: log, ...(sent ? { sent } : {}) };
}

/** How each row the publish gate held ended (KV alerts:held-log, newest first): latency.json reconciliation.held. */
const HELD_LOG = 'alerts:held-log';
interface HeldEnd {
  accession: string;
  ticker: string | null;
  cusip: string;
  rule: HeldRow['reason'];
  held_at: string;
  released_at: string | null;
  outcome: 'passed' | 'released_after_1d' | 'shown_as_filed' | 'dropped' | 'not_counted' | 'expired' | null;
}

/** One reconciliation check, newest first in KV alerts:reconciled (latency.json's `reconciliation`). */
export interface Reconciled {
  accession: string;
  slug: string;
  quarter: string;
  accepted: string | null;
  checked_at: string;
  build: string | null;
  result: 'pass' | 'fail';
  /** One of ALERT_CLASSES: its worst failed row (rows before totals), matched, or no_rows. */
  class?: AlertClass;
  /** Emailed rows the after-send cross-filer check found off other filers' price (marked "shown as filed"). */
  filer_value?: string[];
  rows: number;
  failed: import('./email').CorrectionRow[];
  recipients: number;
  /** Correction emails sent (0 for alerts sent before reconciliation began: the /status/ Data entry is their notice). */
  mailed: number;
}

/**
 * Season 13F alerts already disclosed on /status/ ("13F alert moves didn't adjust for stock splits", Nov 11): their
 * split rows are `disclosed`, not mailed again.
 */
const DISCLOSED_SPLITS = new Set(['0001697850-26-000004', '0001062993-26-005832', '0000315066-26-002964', '0001171200-26-000023', '0001140361-26-042753', '0001386060-26-000054', '0001088875-26-000074', '0001172661-26-004909', '0001062993-26-005826']);
/** Other alerts named in a /status/ Data entry (Nov 11): Advent's bonds sized from zero, Mizuho Markets' SPY options. */
const DISCLOSED_ENTRIES = new Set(['0001140361-26-042650', '0001062993-26-005826']);
type RowClass = 'disclosed' | 'explained' | 'wrong';
/** One verdict per checked alert (latency.json reconciliation counts each). */
export const ALERT_CLASSES = ['matched', 'disclosed', 'disclosed_totals', 'explained', 'wrong', 'wrong_totals', 'no_rows'] as const;
type AlertClass = (typeof ALERT_CLASSES)[number];

/**
 * Why each failed row failed: `disclosed` (a split row of an alert on /status/), `explained` (a CUSIP change the alert
 * listed as a new position plus an exit of the same ticker, as McLennan's XOM and OKE, whose net shares at this quarter's
 * price come to the build's figure within 10%; or a difference under $1,000), or `wrong` (a real error not yet disclosed).
 */
function classify(a: Alert13F, rows: Map<string, MoveRow>, failed: import('./email').CorrectionRow[], splits: Map<string, number>, build: Map<string, BuildRow>): import('./email').CorrectionRow[] {
  const of = (t: string | null, c: string) => [...rows.values()].filter((x) => !!t && x.ticker === t && x.change === c && !x.put_call);
  // The pair's real move: share change across the two CUSIPs, at the new line's price (the build's convention).
  const netted = (t: string | null) => {
    const [nw, ex] = [of(t, 'new'), of(t, 'exited')];
    const shares = nw.reduce((s, x) => s + x.shares, 0);
    if (!nw.length || !ex.length || !shares) return false;
    const got = (shares - ex.reduce((s, x) => s + x.prev_shares, 0)) * (nw.reduce((s, x) => s + x.value, 0) / shares);
    const want = [...build.values()].filter((x) => x.ticker === t && !x.put_call).reduce((s, x) => s + (Number(x.value_delta) || 0), 0);
    return Math.abs(got - want) < 1000 || Math.abs(got - want) <= MISMATCH * Math.abs(want);
  };
  return failed.map((f) => {
    if (DISCLOSED_SPLITS.has(a.accession) && (splits.get(f.cusip) ?? 1) !== 1) return { ...f, class: 'disclosed', why: 'split' };
    if (!f.put_call && netted(f.ticker)) return { ...f, class: 'explained', why: 'cusip_change' };
    if (Math.abs(f.emailed.value_delta - f.v1.value_delta) < 1000) return { ...f, class: 'explained', why: 'rounding' };
    if (DISCLOSED_ENTRIES.has(a.accession)) return { ...f, class: 'disclosed', why: 'status_entry' };
    return { ...f, class: 'wrong' };
  });
}
/**
 * The emailed bought and sold totals against the build's (rows the gate held left out of both), each within 1% of the
 * build's total for that side or $1M, whichever is larger. Rows
 * already classed count at the build's figure, so a total off only because of a classed row isn't a second error.
 * A total that is off comes back as a row (`why: 'totals'`): disclosed for the split alerts on /status/, else wrong.
 */
function totalRows(a: Alert13F, sent: Moves[], failed: import('./email').CorrectionRow[], build: Map<string, BuildRow>, held: HeldRow[] = []): import('./email').CorrectionRow[] {
  const skip = new Set(held.map((h) => rowKey(h)));
  const rows = [...build.entries()].filter(([k]) => !skip.has(k)).map(([, v]) => Number(v.value_delta) || 0);
  const want = { bought: rows.reduce((s, x) => s + Math.max(x, 0), 0), sold: rows.reduce((s, x) => s - Math.min(x, 0), 0) };
  // Tighter than rows: over 1% or $1M, whichever is larger (Acadian's split alert was $203M off, 0.03%, and is disclosed).
  const off = (x: number, y: number) => Math.abs(x - y) > Math.max(1e6, 0.01 * Math.abs(y));
  const out: import('./email').CorrectionRow[] = [];
  for (const k of ['bought', 'sold'] as const) {
    // Every emailed version (first send, follow-ups): the one furthest from the build, if it's off both as sent and
    // with the classed rows at the build's figures.
    const bad = sent
      .filter((m) => {
        const adj = failed.reduce((s, f) => s + (k === 'bought' ? Math.max(f.v1.value_delta, 0) - Math.max(f.emailed.value_delta, 0) : Math.min(f.emailed.value_delta, 0) - Math.min(f.v1.value_delta, 0)), m[`${k}_usd`]);
        return off(m[`${k}_usd`], want[k]) && off(adj, want[k]);
      })
      .sort((x, y) => Math.abs(y[`${k}_usd`] - want[k]) - Math.abs(x[`${k}_usd`] - want[k]))[0];
    if (bad) out.push({ cusip: `total:${k}`, ticker: null, name: `Total ${k}`, put_call: null, emailed: { change: 'total', value_delta: Math.round(bad[`${k}_usd`]) }, v1: { change: 'total', value_delta: Math.round(want[k]) }, class: DISCLOSED_SPLITS.has(a.accession) || DISCLOSED_ENTRIES.has(a.accession) ? 'disclosed' : 'wrong', why: 'totals' });
  }
  return out;
}
/**
 * One class per alert. A /status/ Data entry decides an alert it names: the split entry's alerts are `disclosed`
 * (a wrong row) or `disclosed_totals` (rows right, totals off by any amount, even under the tolerance).
 */
const FIGURES: Record<AlertClass, { figures: string; disclosed: boolean | null }> = {
  matched: { figures: 'right', disclosed: null },
  explained: { figures: 'explained', disclosed: null },
  no_rows: { figures: 'no_rows', disclosed: null },
  disclosed: { figures: 'wrong_rows', disclosed: true },
  wrong: { figures: 'wrong_rows', disclosed: false },
  disclosed_totals: { figures: 'wrong_totals', disclosed: true },
  wrong_totals: { figures: 'wrong_totals', disclosed: false },
};
const alertClass = (failed: { class?: RowClass; why?: string }[], rows = 1, accession = ''): AlertClass => {
  const has = (c: RowClass, totals: boolean) => failed.some((f) => f.class === c && (f.why === 'totals') === totals);
  if (!rows) return 'no_rows';
  if (has('wrong', false)) return 'wrong';
  if (has('disclosed', false)) return 'disclosed';
  if (has('wrong', true)) return 'wrong_totals';
  if (has('disclosed', true) || DISCLOSED_SPLITS.has(accession)) return 'disclosed_totals';
  return failed.length ? 'explained' : 'matched';
};

/** Alerts accepted from here get correction emails; earlier ones are checked and logged only. */
export const RECONCILE_MAIL_FROM = '2026-11-11T05:00:00Z';
const MISMATCH = 0.1;
/**
 * Each alert's verdict: its first reconciliation, frozen (never renamed or overwritten again; the earlier logs v1-v5
 * were re-checked against later builds). Later re-checks go to RECHECKS, with the build and the reason.
 */
const RECONCILED = 'alerts:verdicts';
const RECONCILED_PREV = 'alerts:reconciled:v4';
const RECHECKS = 'alerts:rechecks';
/** The verdict's per-row figures, to tell whether a re-check differs. */
const sig = (failed: { cusip: string; put_call: string | null; class?: string; v1: { value_delta: number } }[]) =>
  failed.map((f) => `${f.cusip}|${f.put_call ?? ''}|${f.class ?? ''}|${Math.round(f.v1.value_delta)}`).sort().join(';');

/**
 * gene, every 5 minutes: each 13F alert with moves, once ingest's build serves its filing, row by row against the build
 * (what fund pages, the CSV and /v1 serve). A row fails on a different direction (new, added, trimmed, exited, or
 * unchanged), a different sign, or a value over 10% off. On a failure the alert's recipients get a correction email and
 * the stored copy (feed and archive) is marked corrected. Every check is logged pass or fail.
 * `only`: an operator's run for one accession; `to`: send its correction to these test inboxes instead.
 */
export async function reconcileAlerts(env: Env, now: number, only?: { accession: string; to?: string[] }): Promise<Record<string, unknown>> {
  const log = JSON.parse((await env.DB.get(RECONCILED)) ?? '[]') as Reconciled[];
  const done = new Set(log.map((x) => x.accession));
  // Alerts with a verdict are re-checked against the build at most hourly; the verdict never changes.
  const recheckDue = !only && now - Number((await env.DB.get('alerts:recheck-at')) ?? 0) >= 3600_000;
  if (recheckDue) await env.DB.put('alerts:recheck-at', String(now));
  const found = new Map<string, { a: Alert13F; rows: Map<string, MoveRow>; days: string[]; sent: Moves[] }>();
  for (let d = 0; d < (only ? 31 : 4); d++) {
    const day = etDay(now - d * DAY);
    const raw = await env.DB.get(`digest:${day}`);
    if (!raw) continue;
    for (const a of (JSON.parse(raw) as DigestDay).filings) {
      if (!a.moves || a.reveal || a.replay_to?.length || (only ? a.accession !== only.accession : done.has(a.accession) && !recheckDue)) continue;
      const x = found.get(a.accession) ?? { a, rows: new Map<string, MoveRow>(), days: [], sent: [] };
      x.sent.push(a.moves);
      for (const [change, rows] of [['new', a.moves.new], ['added', a.moves.added], ['trimmed', a.moves.trimmed], ['exited', a.moves.exited]] as const) for (const r of rows) x.rows.set(rowKey(r), { ...r, change });
      if (!x.days.includes(day)) x.days.push(day);
      found.set(a.accession, x);
    }
  }
  const out: Reconciled[] = [];
  const rechecks: Record<string, unknown>[] = [];
  let pending = 0;
  for (const { a, rows, days, sent } of found.values()) {
    const verdict = log.find((x) => x.accession === a.accession);
    const b = await buildRows(env, a);
    if (!b) {
      pending++;
      continue;
    }
    const byRow = classify(a, rows, compareToBuild(rows, b.rows), await splitsFor(env, a.quarter), b.rows);
    const failed = rows.size ? [...byRow, ...totalRows(a, sent, byRow, b.rows, a.held)] : byRow;
    // The 1.25x cross-filer price check on every emailed row (Cloudflare, the primary poller, sends without it): a row
    // whose own value per share is off other filers' is marked in the archive "shown as filed". No email: the figure is
    // what the filer reported, and it matches the published data.
    // A re-check: logged with the build and the reason when it differs from the verdict; no email, no archive change.
    if (verdict) {
      if (sig(failed) !== sig(verdict.failed)) {
        const was = new Map(verdict.failed.map((f) => [`${f.cusip}|${f.put_call ?? ''}`, f]));
        const nowF = new Map(failed.map((f) => [`${f.cusip}|${f.put_call ?? ''}`, f]));
        const keys = [...new Set([...was.keys(), ...nowF.keys()])].filter((k) => sig(was.has(k) ? [was.get(k)!] : []) !== sig(nowF.has(k) ? [nowF.get(k)!] : []));
        rechecks.push({
          accession: a.accession,
          checked_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          verdict_build: verdict.build,
          build: b.build,
          reason: only ? 'operator re-check' : b.build !== verdict.build ? 'a later build (an amendment or re-base of the filing or its prior)' : 'same build, check code changed',
          verdict_class: verdict.class ?? null,
          class_now: alertClass(failed, rows.size, a.accession),
          rows: keys.map((k) => ({ cusip: k.split('|')[0], ticker: (nowF.get(k) ?? was.get(k))!.ticker, verdict: was.get(k) ? { class: was.get(k)!.class, build: was.get(k)!.v1 } : null, now: nowF.get(k) ? { class: nowF.get(k)!.class, build: nowF.get(k)!.v1 } : null })),
        });
      }
      continue;
    }
    const filerValue = await filerValueRows(env, a, rows);
    if (filerValue.length) {
      const keys = new Set(filerValue.map((r) => rowKey(r)));
      for (const day of days) {
        const raw = await env.DB.get(`digest:${day}`);
        if (!raw) continue;
        const store = JSON.parse(raw) as DigestDay;
        let hit = false;
        for (const x of store.filings) {
          if (x.accession !== a.accession || !x.moves) continue;
          for (const list of [x.moves.new, x.moves.added, x.moves.trimmed, x.moves.exited]) for (const r of list) if (keys.has(rowKey(r)) && !r.filer_value) (r.filer_value = true), (hit = true);
        }
        if (hit) await env.DB.put(`digest:${day}`, JSON.stringify(store), { expirationTtl: 31 * 86400 });
      }
    }
    // Who got it: the delivery log, as /ops/delivery reads it.
    const rec = await deliveryRecord(env, a.accession, now);
    const members = new Map((await listMembers(env)).map((m) => [m.customer, m]));
    // Only undisclosed errors are mailed: disclosed ones have their /status/ entry, explained ones aren't wrong figures.
    const mailable = failed.filter((x) => x.class === 'wrong');
    const to = only?.to ?? (mailable.length && (a.accepted ?? '') >= RECONCILE_MAIL_FROM ? rec.recipients.map((x) => members.get(x.customer)?.email).filter((e): e is string => !!e) : []);
    let mailed = 0;
    if (mailable.length) {
      const { correctionMail, sendMail } = await import('./email');
      const uniq = [...new Set(to)];
      if (uniq.length) {
        await sendMail(env, uniq.map((t) => correctionMail(env, t, a, mailable)), { bulk: true, preview: !!only?.to });
        mailed = uniq.length;
      }
      if (!only?.to) {
        const corrected = { at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), rows: mailable };
        for (const day of days) {
          const raw = await env.DB.get(`digest:${day}`);
          if (!raw) continue;
          const store = JSON.parse(raw) as DigestDay;
          for (const x of store.filings) if (x.accession === a.accession) x.corrected = corrected;
          await env.DB.put(`digest:${day}`, JSON.stringify(store), { expirationTtl: 31 * 86400 });
        }
      }
    }
    out.push({ accession: a.accession, slug: a.slug, quarter: a.quarter, accepted: a.accepted ?? null, checked_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), build: b.build, result: failed.length ? 'fail' : 'pass', class: alertClass(failed, rows.size, a.accession), rows: rows.size, failed, ...(filerValue.length ? { filer_value: filerValue.map((r) => r.ticker ?? r.cusip) } : {}), recipients: rec.counts.members, mailed });
  }
  if (out.length && !only?.to) await env.DB.put(RECONCILED, JSON.stringify([...out, ...log].slice(0, 500)));
  if (rechecks.length) {
    // One entry per accession and build: a re-check that finds the same difference again isn't logged twice.
    const prev = JSON.parse((await env.DB.get(RECHECKS)) ?? '[]') as { accession: string; build: string | null }[];
    const fresh = rechecks.filter((r) => !prev.some((p) => p.accession === r.accession && p.build === r.build));
    if (fresh.length) await env.DB.put(RECHECKS, JSON.stringify([...fresh, ...prev].slice(0, 500)));
  }
  return { checked: out.map((x) => ({ accession: x.accession, result: x.result, rows: x.rows, failed: x.failed.length, mailed: x.mailed })), rechecked: rechecks.map((r) => r.accession), pending };
}

/** Emailed stock rows over 1.25x off the median price other filers report for the CUSIP this quarter (gene only). */
async function filerValueRows(env: Env, a: Alert13F, rows: Map<string, MoveRow>): Promise<MoveRow[]> {
  const list = [...rows.values()].filter((r) => r.change !== 'exited');
  if (!list.length) return [];
  const cons = await consensusFor(env, a.quarter, list.map((r) => r.cusip));
  return list.filter((r) => offFilers(r, cons.get(r.cusip)));
}

/** Alerted rows against the build's: the rows that differ in direction, sign, or by over 10% in value, largest first. */
export function compareToBuild(rows: Map<string, MoveRow>, build: Map<string, BuildRow>): import('./email').CorrectionRow[] {
  const b = { rows: build };
  const failed: import('./email').CorrectionRow[] = [];
  for (const r of rows.values()) {
    let v: BuildRow | undefined = b.rows.get(rowKey(r));
    // A CUSIP change the alert netted into one move (XOM's Q3 reorganisation): the build keeps the exit and the new line.
    if (!v && r.ticker && [...b.rows.values()].some((x) => x.ticker === r.ticker && x.change === 'exited')) continue;
    if (v?.change === 'new' && r.change !== 'new' && r.ticker && [...b.rows.values()].some((x) => x.ticker === r.ticker && x.change === 'exited')) continue;
    // A reissued CUSIP (either side of a SEC-confirmed link) is linked by our own table, whatever the build says: a build
    // that hasn't linked it (TEVA's ADS to ordinary, Nov 11) lists an exit plus a new line, and must never correct an
    // add or trim into either.
    if (isReissued(r.cusip) && (!v || v.change === 'new' || v.change === 'exited')) continue;
    // A split link the build lists as one position (DD 1-for-3, RBKB 1.3978): compare split-adjusted shares, the build's
    // prior possibly still in old units. A one-for-one link the build lists as added or trimmed is checked like any row,
    // so a wrong XOM or TEVA alert is corrected.
    const k = v && isReissued(r.cusip) ? reissueRatio(r.cusip) : 1;
    if (v && k !== 1) {
      const vp = Number(v.prev_shares ?? 0), rp = Number(r.prev_shares ?? 0), vs = Number(v.shares ?? 0);
      if (vs === Number(r.shares) && (Math.abs(rp - Math.round(vp * k)) <= 1 || Math.abs(rp - vp) <= 1)) continue;
      const adj = Math.abs(rp - vp) <= 1 ? vp : Math.round(vp * k);
      failed.push({ cusip: r.cusip, ticker: r.ticker ?? v.ticker ?? null, name: r.display_name || r.issuer, put_call: r.put_call, emailed: { change: r.change!, value_delta: r.value_delta }, v1: { change: !vs ? 'exited' : vs > adj ? 'added' : vs < adj ? 'trimmed' : 'unchanged', value_delta: Math.round(v.value_delta) } });
      continue;
    }
    // A row the build doesn't list can't be confirmed either way: never read as "unchanged" (retail, Nov 11: real exits
    // were "corrected" to unchanged when a build left its exits out).
    if (!v) continue;
    const got = { change: v.change!, value_delta: Math.round(v.value_delta) };
    const bad = got.change !== r.change || Math.sign(got.value_delta) !== Math.sign(r.value_delta) || Math.abs(r.value_delta - got.value_delta) > MISMATCH * Math.abs(got.value_delta);
    if (bad) failed.push({ cusip: r.cusip, ticker: r.ticker ?? v?.ticker ?? null, name: r.display_name || r.issuer, put_call: r.put_call, emailed: { change: r.change!, value_delta: r.value_delta }, v1: got });
    v = undefined;
  }
  failed.sort((x, y) => Math.abs(y.emailed.value_delta - y.v1.value_delta) - Math.abs(x.emailed.value_delta - x.v1.value_delta));
  return failed;
}

/** An alert's move rows by key, as its email listed them. */
const alertRows = (m: Moves, into = new Map<string, MoveRow>()) => {
  for (const [change, rows] of [['new', m.new], ['added', m.added], ['trimmed', m.trimmed], ['exited', m.exited]] as const) for (const r of rows) into.set(rowKey(r), { ...r, change });
  return into;
};

/**
 * Operator's dry run over the season (no email, no log): every 13F alert with moves in the last `days` days' stores,
 * against ingest's build, as sent and (with `recompute`) as the current code would send it now: the filing re-read from
 * EDGAR, the prior book as gene reads it, splits, netting and the publish gate. Paged with offset and limit.
 */
export async function reconcileDry(env: Env, now: number, o: { offset?: number; limit?: number; recompute?: boolean; days?: number } = {}): Promise<Record<string, unknown>> {
  const found = new Map<string, { a: Alert13F; rows: Map<string, MoveRow>; versions: Moves[] }>();
  for (let d = 0; d < (o.days ?? 31); d++) {
    const raw = await env.DB.get(`digest:${etDay(now - d * DAY)}`);
    if (!raw) continue;
    for (const a of (JSON.parse(raw) as DigestDay).filings) {
      if (!a.moves || a.reveal || a.replay_to?.length) continue;
      const x = found.get(a.accession) ?? { a, rows: new Map<string, MoveRow>(), versions: [] };
      alertRows(a.moves, x.rows);
      x.versions.push(a.moves);
      found.set(a.accession, x);
    }
  }
  const all = [...found.values()].sort((x, y) => (x.a.accepted ?? '').localeCompare(y.a.accepted ?? ''));
  const page = all.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? all.length));
  secBudget.left = Math.max(secBudget.left, 200);
  const out: Record<string, unknown>[] = [];
  const row = (f: import('./email').CorrectionRow) => ({ ticker: f.ticker, cusip: f.cusip, put_call: f.put_call, sent: f.emailed, build: f.v1, class: f.class, ...(f.why ? { why: f.why } : {}) });
  for (const { a, rows, versions } of page) {
    const b = await buildRows(env, a);
    if (!b) {
      out.push({ accession: a.accession, slug: a.slug, accepted: a.accepted ?? null, result: 'no_build' });
      continue;
    }
    const byRow = classify(a, rows, compareToBuild(rows, b.rows), await splitsFor(env, a.quarter), b.rows);
    const sent = rows.size ? [...byRow, ...totalRows(a, versions, byRow, b.rows, a.held)] : byRow;
    const item: Record<string, unknown> = { accession: a.accession, slug: a.slug, accepted: a.accepted ?? null, rows: rows.size, as_sent: { result: sent.length ? 'fail' : 'pass', class: alertClass(sent, rows.size, a.accession), filer_value: (await filerValueRows(env, a, rows)).map((r) => r.ticker ?? r.cusip), failed: sent.map(row) } };
    if (o.recompute) {
      try {
        const cik = a.sec_url.match(/\/edgar\/data\/(\d+)\//)?.[1] ?? '';
        const f = await fetch13F(cik, a.accession, Infinity);
        const prevEnd = f ? prevQuarterEnd(f.report_date) : '';
        const book = f && ((a.extra ? await filerShardBook(env, cik, prevEnd) : await priorBook(env, a.slug, prevEnd, Infinity)) ?? (await prior13F(cik, f.report_date)));
        if (!f?.holdings || !book) item.now = { result: 'unreadable' };
        else {
          const q = quarterOf(f.report_date);
          const raw = computeMoves(f.holdings, book, undefined, await splitsFor(env, q), await perShareMedians(env, perShareSuspects(f.holdings, book).slice(0, 6), q));
          await lookupTickers(env, raw.changed);
          const g = gateMoves(netRenamed(raw), book, await splitsFor(env, q), await consensusFor(env, q, raw.changed.map((x) => x.cusip)));
          const nowRows = alertRows(g.moves);
          const nowByRow = classify(a, nowRows, compareToBuild(nowRows, b.rows), new Map(), b.rows);
          const diff = nowRows.size ? [...nowByRow, ...totalRows(a, [g.moves], nowByRow, b.rows, g.held)] : nowByRow;
          item.now = { result: diff.length ? 'fail' : 'pass', class: alertClass(diff, nowRows.size), rows: nowRows.size, failed: diff.map(row), held: g.held.map((h) => ({ ticker: h.ticker, cusip: h.cusip, change: h.change, reason: h.reason })) };
        }
      } catch (e) {
        item.now = { result: `error: ${e}` };
      }
    }
    out.push(item);
  }
  const count = (k: 'as_sent' | 'now') => {
    const xs = out.map((x) => x[k] as { result?: string; class?: string } | undefined).filter(Boolean) as { result: string; class?: string }[];
    return { ...Object.fromEntries(ALERT_CLASSES.map((c) => [c, xs.filter((x) => x.class === c).length])), other: xs.filter((x) => x.result !== 'pass' && x.result !== 'fail').length };
  };
  return { total: all.length, offset: o.offset ?? 0, checked: out.length, as_sent: count('as_sent'), ...(o.recompute ? { now: count('now') } : {}), no_build: out.filter((x) => x.result === 'no_build').length, alerts: out };
}

/** latency.json's `reconciliation`: "alerts reconciled: N of N" on /status/. */
export async function reconciliation(env: Env): Promise<Record<string, unknown>> {
  // The two hosts load a new build up to an hour apart: until gene writes the new log, show the previous one.
  let log = JSON.parse((await env.DB.get(RECONCILED)) ?? '[]') as Reconciled[];
  // When the first frozen verdict was written (gene's 07:41 UTC run, Nov 11); null while the previous log is shown.
  const verdictsFrozenAt = log.length ? log.map((x) => x.checked_at).sort()[0] : null;
  const lastRun = Number((await env.DB.get('alerts:recheck-at')) ?? 0) || null;
  // The previous log predates the disclosure rule: its alerts named in a /status/ entry take that entry's class.
  if (!log.length)
    log = (JSON.parse((await env.DB.get(RECONCILED_PREV)) ?? '[]') as Reconciled[]).map((x) => ({
      ...x,
      class: x.class === 'wrong' && DISCLOSED_ENTRIES.has(x.accession) ? 'disclosed' : x.class === 'matched' && DISCLOSED_SPLITS.has(x.accession) ? 'disclosed_totals' : x.class,
    }));
  return {
    checked: log.length,
    passed: log.filter((x) => x.result === 'pass').length,
    failed: log.filter((x) => x.result === 'fail').length,
    // What a reader needs: matched, already disclosed on /status/, explained (no wrong figure), and wrong.
    ...Object.fromEntries(ALERT_CLASSES.map((k) => [k, log.filter((x) => (x.class ?? (x.result === 'pass' ? 'matched' : 'wrong')) === k).length])),
    // What the email got wrong, apart from whether /status/ discloses it.
    wrong_disclosed: log.filter((x) => x.class === 'disclosed').length,
    wrong_undisclosed: log.filter((x) => x.class === 'wrong').length,
    totals_disclosed: log.filter((x) => x.class === 'disclosed_totals').length,
    totals_undisclosed: log.filter((x) => x.class === 'wrong_totals').length,
    // Re-checks against later builds that differ from a verdict (the verdict stands).
    rechecks: JSON.parse((await env.DB.get(RECHECKS)) ?? '[]'),
    // Emailed rows the after-send cross-filer check marked "shown as filed".
    filer_value_rows: log.reduce((n, x) => n + (x.filer_value?.length ?? 0), 0),
    held_pending: (JSON.parse((await env.DB.get('alerts:pending-check')) ?? '[]') as unknown[]).length,
    // The first verdict: fixed once verdicts are frozen. last_run_at moves with each hourly re-check run (gene).
    since: log.length ? log.reduce((m, x) => (x.checked_at < m ? x.checked_at : m), log[0].checked_at) : null,
    verdicts_frozen_at: verdictsFrozenAt,
    last_run_at: lastRun ? new Date(lastRun).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    next_run_at: lastRun ? new Date(lastRun + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    // Every row the gate held: still held (outcome null), then how each ended.
    held: [
      ...(JSON.parse((await env.DB.get('alerts:pending-check')) ?? '[]') as Alert13F[]).flatMap((a) => (a.held ?? []).map((h): HeldEnd => ({ accession: a.accession, ticker: h.ticker ?? null, cusip: h.cusip, rule: h.reason, held_at: a.accepted ?? a.filing_date, released_at: null, outcome: null }))),
      ...(JSON.parse((await env.DB.get(HELD_LOG)) ?? '[]') as HeldEnd[]),
    ],
    // anchor: the accession, stable for links from /status/ Data entries. figures: what the email got wrong; disclosed:
    // whether a /status/ entry covers it (null when nothing was wrong).
    recent: log.map((x) => ({ anchor: x.accession, ...FIGURES[x.class ?? (x.result === 'pass' ? 'matched' : 'wrong')], accession: x.accession, slug: x.slug, quarter: x.quarter, checked_at: x.checked_at, result: x.result, class: x.class ?? null, rows: x.rows, failed_rows: x.failed.length, filer_value_rows: x.filer_value?.length ?? 0, corrections_sent: x.mailed })),
  };
}

async function indexContract(env: Env, idx: unknown, now: number): Promise<void> {
  const problems = checkIndex(idx);
  const build = (idx as { build_id?: string; generated_at?: string }).build_id ?? (idx as { generated_at?: string }).generated_at ?? null;
  const rec = JSON.stringify({ ok: !problems.length, build, problems });
  const was = await env.DB.get('index:contract');
  if (was && JSON.parse(was).build === build && JSON.parse(was).ok === !problems.length) return;
  await env.DB.put('index:contract', JSON.stringify({ ...JSON.parse(rec), checked_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') }));
  if (!problems.length) return;
  console.error(`index.json breaks the alert routing contract: ${problems.join('; ')}`);
  const { sendMail } = await import('./email');
  await sendMail(env, [{ to: env.CONTACT_EMAIL ?? 'hello@factordynamics.com', subject: `Copybook: index.json breaks the alert routing contract (${problems.length} problem${problems.length === 1 ? '' : 's'})`, text: `Build ${build}. Alerts may be missing until ingest fixes these fields (copybook/api/src/contract.ts):\n\n${problems.map((x) => `- ${x}`).join('\n')}\n` }], { tier: 'account' });
}

/**
 * Ingest's filer-type publish guard (data/types_guard.json): a full run that would move any type's count by over 10%
 * keeps the published types (`held`). One email to hello@ per held run; status.json shows the latest (types_guard).
 */
async function typesGuard(env: Env): Promise<void> {
  const g = (await fetch(`${env.DATA_URL}types_guard.json`, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { checked_at?: string; status?: string; reason?: string; moved?: { type: string; published: number; candidate: number; change_pct: number }[] } | null;
  if (!g?.checked_at) return;
  const was = JSON.parse((await env.DB.get('types:guard')) ?? 'null') as { checked_at?: string } | null;
  if (was?.checked_at === g.checked_at) return;
  await env.DB.put('types:guard', JSON.stringify({ checked_at: g.checked_at, status: g.status ?? null, reason: g.reason ?? null, moved: g.moved ?? [] }));
  if (g.status !== 'held') return;
  const { sendMail } = await import('./email');
  const moved = (g.moved ?? []).map((m) => `- ${m.type}: ${m.published} published, ${m.candidate} in the run (${m.change_pct > 0 ? '+' : ''}${m.change_pct}%)`).join('\n');
  await sendMail(env, [{ to: env.CONTACT_EMAIL ?? 'hello@factordynamics.com', subject: 'Copybook: ingest held a filer-type change (published types kept)', text: `The data run of ${g.checked_at} didn't publish its filer types: ${g.reason ?? 'the counts moved too far'}. Members still get alerts routed by the previous types.\n\n${moved}\n\nTo accept the move, dispatch a full run with accept_types.\n` }], { tier: 'account' });
}

export async function runBackstop(env: Env, now: number): Promise<Record<string, unknown>> {
  await typesGuard(env).catch((e) => console.error(`types_guard: ${e}`));
  await import('./download').then((d) => d.checkBulk(env, 1_000_000, now)).catch((e) => console.error(`bulk_check: ${e}`));
  // index.json (900 KB) only changes with a data build: when it hasn't, skip parsing it and go
  // straight to the follow-ups. Its derived KV (CIK map, /v1 filers, periods) is unchanged too.
  // Without /status/'s freshness record yet, read the index once even if unchanged, so it's filled.
  const etag = (await env.DB.get('status:fresh')) ? await env.DB.get('idx:etag') : null;
  const res = await fetch(`${env.DATA_URL}index.json`, etag ? { headers: { 'if-none-match': etag } } : {});
  if (res.status !== 304 && !res.ok) throw new Error(`index.json ${res.status}`);
  const idx = (res.status === 304 ? { managers: [] } : await res.json()) as { managers?: IndexRow[]; generated_at?: string; build_id?: string };
  if (res.status === 304) return { status: 'unchanged', ...(await pendingFollowups(env, now)) };
  const rows = idx.managers ?? [];
  // The routing contract (contract.ts): a renamed or missing field alerts hello@ once per build, and status.json shows it.
  await indexContract(env, idx, now);
  // /v1 responses say when and from which build the data was made.
  const build = JSON.stringify({ data_built_at: idx.generated_at ?? null, build_id: idx.build_id ?? (idx.generated_at ? idx.generated_at.replace(/[-:]/g, '') : null) });
  // Never backwards: a stale cached index.json (an older build) never replaces the build /v1 already reports.
  const was = JSON.parse((await env.DB.get('v1:build')) ?? '{}') as { data_built_at?: string | null };
  const older = !!was.data_built_at && !!idx.generated_at && idx.generated_at < was.data_built_at;
  if (older) return { status: 'older index ignored', index_built_at: idx.generated_at, serving: was.data_built_at };
  if (JSON.stringify(was) !== build || !(await env.DB.get('status:fresh'))) {
    await env.DB.put('v1:build', build);
    // /status/ freshness: the build, and the newest 13F in it (by EDGAR acceptance).
    const last = rows.filter((r) => r.accepted_at && r.accession && /^13F/.test(r.form ?? '13F')).sort((a, b) => b.accepted_at!.localeCompare(a.accepted_at!))[0];
    await env.DB.put('status:fresh', JSON.stringify({ ...JSON.parse(build), last_13f: last ? { slug: last.slug, manager: last.manager, accession: last.accession, accepted_at: last.accepted_at!.replace(/\.\d{3}Z$/, 'Z') } : null }));
  }

  const ciks: CikMap = {};
  const byCik = (cik: string, m: IndexRow) => (ciks[cik.padStart(10, '0')] ??= []).push({ slug: m.slug, manager: m.manager, name: m.name, cik: m.cik.padStart(10, '0'), featured: m.featured, type: m.type ?? null, ...((m as { status?: string }).status === 'inactive' ? { inactive: true } : {}) });
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
  const detectedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
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
  if (live.length) await logLatency(env, live.map((e) => ({ slug: e.slug || e.subject_tickers?.join(',') || '', manager: e.manager, form: e.form, kind: e.kind, accession: e.id, accepted: e.accepted, detected: e.detected ?? detectedAt, extra: !e.slug })), Date.now());
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
  name: 'backstop' | 'events' | 'digest' | 'watch' | 'revenue' | 'weekly' | 'issuers' | 'seasonal' | 'ops' | 'quota' | 'email2' | 'namesWeekly' | 'kahnConfirm' | 'winter' | 'parquet';
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
  // The account's daily request budget, every 10 minutes: a warning at 70%, shedding non-member paths from 85%.
  if (m % 10 === 3) due.push({ name: 'quota', at: scheduledTime });
  // The free weekly: Saturday 02:00 UTC (9pm ET Friday), so it has Friday's after-close filers and their pages.
  // Retried every 15 minutes to 05:45 UTC (Sat 12:45 am ET) if that minute's run was missed (host down); each job
  // records its week once sent, so a retry after a send does nothing.
  if (m % 15 === 0 && h >= 2 && h <= 5 && t.getUTCDay() === 6) due.push({ name: 'weekly', at: scheduledTime });
  // Members' "Your names this week": Saturday 02:15 UTC, after the free weekly.
  if (m % 15 === 0 && (h > 2 || m >= 15) && h >= 2 && h <= 5 && t.getUTCDay() === 6) due.push({ name: 'namesWeekly', at: scheduledTime });
  // Email 2, once: 13F deadline night, Mon Nov 16 9:30pm ET (Tue 02:30 UTC). runEmail2 records it done, sent or skipped.
  if (m === 30 && h === 2 && t.toISOString().slice(0, 10) === '2026-11-17') due.push({ name: 'email2', at: scheduledTime });
  // Once: Kahn Brothers' filing day, Thu Nov 12 10:00 UTC, unconfirmed trials' confirmation link (retried to 10:55).
  if (m % 5 === 0 && h === 10 && t.toISOString().slice(0, 10) === '2026-11-12') due.push({ name: 'kahnConfirm', at: scheduledTime });
  // Owned and watched names' insider and 13D/G events: every 10 minutes (each name hourly, 10 minutes in filing week).
  if (m % 10 === 9) due.push({ name: 'issuers', at: scheduledTime });
  // Last winter's events for members' names: gene, every 5 minutes, except from 3 days before a 13F deadline to the day
  // after, when the SEC budget is the alerts'.
  if (m % 5 === 4 && !fo.isCloudflare(env) && !DEADLINES.some((d) => scheduledTime >= deadlineMs(d.date) - 3 * 86_400_000 && scheduledTime <= deadlineMs(d.date) + 86_400_000)) due.push({ name: 'winter', at: scheduledTime });
  // Newly followed names' winter (the lead, Nov 11): every minute after alert polling, busy or not, with what the minute's
  // SEC budget left; not in the deadline windows, when the budget is the alerts'.
  const quietSeason = !DEADLINES.some((d) => scheduledTime >= deadlineMs(d.date) - 3 * 86_400_000 && scheduledTime <= deadlineMs(d.date) + 86_400_000);
  // Parquet bulk exports (parquet.ts): gene, hourly in the US night (06-10 UTC), one CSV per run whose Parquet is missing
  // or older than it; ~20 s and ~600 MB for a 1.6M-row quarter, so never in the deadline windows.
  if (m === 47 && h >= 6 && h <= 10 && !fo.isCloudflare(env) && quietSeason) due.push({ name: 'parquet', at: scheduledTime });
  if (!fo.isCloudflare(env) && quietSeason && secBudget.left > 8) await step('winter_follow', () => import('./stockevents').then((x) => x.fillWinterFollowed(env)));
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
      email2: () => import('./free').then((x) => x.runEmail2(env, job.at)),
      namesWeekly: () => runWeeklyNames(env, job.at),
      kahnConfirm: () => import('./revenue').then((x) => x.runKahnConfirm(env, job.at)),
      // A quiet minute's leftover SEC requests, keeping 4 for the mailer and GitHub.
      issuers: () =>
        import('./stockevents').then(async (x) => {
          const r = await x.precomputeIssuers(env, scheduledTime, inFilingWeek(scheduledTime), Math.min(16, secBudget.left - 4));
          return r;
        }),
      // gene only: last winter's events in members' names (the day-12 preview, /me?include=winter), with a quiet minute's
      // leftover SEC requests. It ran only outside filing week (Nov 9-17) and so read nothing before the Nov 23 emails.
      winter: () => import('./stockevents').then((x) => x.fillWinter(env, Math.min(20, secBudget.left - 6))),
      parquet: () => import('./parquet').then((x) => x.buildParquet(env)),
    };
    await step(job.name, run[job.name]);
  }
  if (queue.length) out.deferred_jobs = queue.map((j) => j.name);
  // The public latency.json, on every quiet minute (a busy one has spent its CPU on alerts; the next one catches up).
  if (!busy) await step('latency_json', () => import('./index').then((x) => x.publishLatency(env, scheduledTime)));
  if (st && probe) await step('status', () => st.runStatus(env, scheduledTime, probe, !busy));
  // Failover A without anyone: both of gene's front doors down 2 minutes -> api.json to this Worker, and back (autofailover.ts).
  if (st && probe) await step('auto_failover', async () => (await import('./autofailover')).runAutoFailover(env, scheduledTime, (await probe).ok));
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
