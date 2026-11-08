import { addToFeed, getChannels, runWebhookRetries, sendChats, sendWebhooks } from './channels';
import { alertMail, digestMail, holdtermAlertMail, sendMail } from './email';
import { companyFilings, computeMoves, fetch13F, fetchForm4, fetchSchedule13, latestFilings, previousSchedule13, quarterOf, secBudget, type FeedEntry, type Form4Class, type MoveRow, type Moves, type Position } from './edgar';
import { isActive, type Env, type Member } from './env';
import { getFollows, listMembers, putMember, type Follows } from './members';

/** A filing dated more than this many days ago never triggers an email, whatever the data says. */
export const MAX_ALERT_AGE_DAYS = 3;
const DAY = 86400_000;

export function alertable(f: { form: string; filing_date: string }, now = Date.now()): boolean {
  return f.form === '13F-HR' && now - Date.parse(f.filing_date) <= MAX_ALERT_AGE_DAYS * DAY;
}

export interface Alert13F {
  slug: string;
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
  /** A non-curated filer: only members who follow it get it, never "every investor". */
  extra?: boolean;
  /** Largest holdings, when there is no prior quarter to diff against. */
  top?: MoveRow[];
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
const etDay = (t: number) => new Date(t - 5 * 3600_000).toISOString().slice(0, 10);

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
export function forHoldterm(f: Follows, filings: Alert13F[], events: AlertEvent[], meta: FilerMeta): { filings: Alert13F[]; events: AlertEvent[] } {
  const inv = new Set(f.investors);
  const stocks = new Set(f.stocks);
  const followed = (slug: string) => (inv.size ? inv.has(slug) : !!meta[slug]?.featured);
  return {
    filings: filings.filter((a) => a.slugs.some(followed)),
    events: events.filter((e) => (!!e.slug && followed(e.slug)) || [e.ticker, ...(e.subject_tickers ?? [])].some((t) => !!t && stocks.has(t))),
  };
}

/** Which of these filings and events a member gets, by their alert switch and follows. */
export function forMember(m: Member, f: Follows, filings: Alert13F[], events: AlertEvent[], meta: FilerMeta = {}): { filings: Alert13F[]; events: AlertEvent[] } {
  if (m.alerts === 'off') return { filings: [], events: [] };
  const all = m.alerts === 'all';
  const investors = new Set(Array.isArray(m.alerts) ? [...m.alerts, ...f.investors] : f.investors);
  const stocks = new Set(f.stocks);
  const fl = filings.filter((x) => (all && !x.extra) || x.slugs.some((s) => investors.has(s)) || (x.slugs.some((s) => stockAlerts(meta, s)) && x.tickers.some((t) => stocks.has(t))));
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

type DigestDay = { filings: Alert13F[]; events: AlertEvent[]; late?: AlertEvent[] };

async function deliver(env: Env, filings: Alert13F[], allEvents: AlertEvent[], now: number): Promise<{ emails: number; digest: number; mail: string; late?: number }> {
  if (!filings.length && !allEvents.length) return { emails: 0, digest: 0, mail: 'none' };
  // Old filings are never presented as news: they go to tonight's digest as "earlier filings".
  // Follow-ups complete an alert already sent, so they go out whenever they're ready.
  const late = allEvents.filter((e) => !e.followup && isLate(e, now)).map((e) => ({ ...e, late: true }));
  const events = allEvents.filter((e) => e.followup || !isLate(e, now));
  // Everything goes in the day's digest store; digest members get it from there tonight.
  const key = `digest:${etDay(now)}`;
  const day = JSON.parse((await env.DB.get(key)) ?? '{"filings":[],"events":[]}') as DigestDay;
  day.filings.push(...filings);
  day.events.push(...events);
  day.late = [...(day.late ?? []), ...late];
  await env.DB.put(key, JSON.stringify(day), { expirationTtl: 3 * 86400 });
  if (!filings.length && !events.length) return { emails: 0, digest: 0, mail: 'none', late: late.length };

  const meta = await filerMeta(env);
  const mails = [];
  const notes: Member[] = [];
  const chats: string[] = [];
  let digest = 0;
  for (const raw of await listMembers(env)) {
    if (!isActive(raw) || !raw.email || raw.alerts === 'off') continue;
    if (raw.plan === 'holdterm') {
      // Holdterm members get Holdterm-branded alerts, never Copybook's.
      const mine = forHoldterm(await getFollows(env, raw), filings, events, meta);
      if (mine.filings.length || mine.events.length) mails.push(holdtermAlertMail(env, raw.email, mine.filings, mine.events));
      continue;
    }
    const f = await getFollows(env, raw);
    const m = await scoped(env, raw, f);
    const mine = forMember(m, f, filings, events, meta);
    if (!mine.filings.length && !mine.events.length) continue;
    // Chat, feed and webhook get every alert as it happens, whatever the email schedule.
    const ch = await getChannels(env, m.customer);
    if (ch.discord || ch.slack || ch.telegram) chats.push(...Object.entries(await sendChats(env, ch, mine.filings, mine.events, f)).map(([k, v]) => `${k} ${v}`));
    if (ch.webhook) await sendWebhooks(env, m, ch, mine.filings, mine.events, now);
    if (ch.feed_token) await addToFeed(env, m, ch, mine.filings, mine.events, now);
    if (f.digest) digest++;
    else {
      mails.push(alertMail(env, m.email, mine.filings, mine.events, f, m));
      notes.push(m);
    }
  }
  const mail = await sendMail(env, mails);
  if (mail.split(',').every((s) => s === '200')) for (const m of notes) await noted(env, m);
  return { emails: mails.length, digest, mail, ...(chats.length ? { chats: chats.join(', ') } : {}), ...(late.length ? { late: late.length } : {}) };
}

/** After EDGAR closes: one email per digest member with the day's filings and events they follow. */
export async function runDigest(env: Env, now: number): Promise<{ emails: number; status: string }> {
  const day = etDay(now);
  const raw = await env.DB.get(`digest:${day}`);
  if (!raw) return { emails: 0, status: 'none' };
  const { filings, events, late = [] } = JSON.parse(raw) as DigestDay;
  const meta = await filerMeta(env);
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
  const status = await sendMail(env, mails);
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
  const res = await fetch(`${env.DATA_URL}filers.json`, { cf: { cacheTtl: 3600 } } as RequestInit);
  if (!res.ok) throw new Error(`filers.json ${res.status}`);
  // 1.6 MB: find each slug's flat record by string search instead of parsing the whole list.
  const text = await res.text();
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
  await env.HIST.put('followed/ciks.json', JSON.stringify({ updated_at: new Date().toISOString(), ciks: Object.keys(extra).sort() }), { httpMetadata: { contentType: 'application/json' } });
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
async function lookupTickers(env: Env, rows: { cusip: string; ticker: string | null; display_name: string | null }[]): Promise<void> {
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

async function priorBook(env: Env, slug: string, reportDate: string): Promise<Position[] | null> {
  const obj = await env.HIST.get(`h/${slug}/${quarterOf(reportDate)}.json`);
  if (!obj || (obj.size ?? 0) > 2_000_000) return null;
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
  const feed = entries.filter((e) => e.form === '13F-HR' && ciks[e.cik] && now - Date.parse(e.accepted) <= MAX_ALERT_AGE_DAYS * DAY && !ids.has(e.accession) && !!ids.add(e.accession));
  if (!feed.length) return { status: 'none', ...(errors.length ? { errors } : {}) };
  const handled = JSON.parse((await env.DB.get('alerts:handled')) ?? '[]') as string[];
  const todo = feed.filter((e) => !handled.includes(e.accession));
  if (!todo.length) return { status: 'none', ...(errors.length ? { errors } : {}) };

  const rawPeriods = await env.DB.get('alerts:periods');
  const periods = JSON.parse(rawPeriods ?? '{}') as Record<string, string>;
  const fresh: Alert13F[] = [];
  const done: FeedEntry[] = [];
  let deferred = 0;
  for (const e of todo) {
    // Each filing needs up to 3 SEC requests; what doesn't fit this minute's budget (keeping some
    // for the Form 4 and 13D/G poll) waits for the next minute.
    if (secBudget.left < SEC_PER_FILING + EVENT_POLL_RESERVE) {
      deferred = todo.length - done.length;
      break;
    }
    try {
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
      if (f.holdings) {
        for (const s of slugs) {
          const book = isExtra ? await filerShardBook(env, e.cik, prev[s]) : await priorBook(env, s, prev[s]);
          if (!book) continue;
          const r = computeMoves(f.holdings, book);
          moves = r.moves;
          // Held positions already carry tickers from last quarter's book; look up only the new ones
          // shown in the email (each lookup scans the securities map, ~0.5 ms of CPU).
          await lookupTickers(env, moves.new);
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
        manager: lead.manager,
        name: lead.name,
        quarter: quarterOf(f.report_date),
        report_date: f.report_date,
        filing_date: e.accepted.slice(0, 10),
        accession: e.accession,
        sec_url: `https://www.sec.gov/Archives/edgar/data/${Number(e.cik)}/${e.accession.replace(/-/g, '')}/${e.accession}-index.html`,
        accepted: e.accepted,
        moves,
        tickers,
        ...(isExtra ? { extra: true } : {}),
        ...(top ? { top } : {}),
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
  const later = fresh.filter((f) => !f.moves && !f.extra);
  if (later.length) await env.DB.put('alerts:pending-moves', JSON.stringify([...JSON.parse((await env.DB.get('alerts:pending-moves')) ?? '[]'), ...later]));
  const sent = await deliver(env, fresh, [], now);
  // A curated filer filed: refresh the data now, so pages, history and moves follow within ~15 minutes.
  const filed = done.filter((e) => curated[e.cik]);
  const refresh = filed.length && rawPeriods ? await dispatchRefresh(env, 'curated', `filing by ${curated[filed[0].cik][0].slug}`, now, filed[0].accession) : undefined;
  if (fresh.length) await logLatency(env, fresh, Date.now());
  return { status: 'checked', filings: fresh.map((f) => `${f.slug} ${f.quarter}${f.moves ? '' : ' (no moves)'}`), ...sent, ...(deferred ? { deferred } : {}), ...(refresh ? { refresh } : {}), ...(errors.length ? { errors } : {}) };
}

/**
 * Acceptance-to-send latency per alerted filing, newest first, for /health. Accessions listed in
 * KV alerts:replays (test sends of old filings) are marked and never counted.
 */
async function logLatency(env: Env, filings: { slug: string; accession: string; accepted?: string; kind?: string; manager?: string; quarter?: string; form?: string }[], sentAt: number): Promise<void> {
  const replays = new Set(JSON.parse((await env.DB.get('alerts:replays')) ?? '[]') as string[]);
  const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as unknown[];
  const add = filings
    .filter((f) => f.accepted)
    .map((f) => ({ slug: f.slug, manager: f.manager || undefined, quarter: f.quarter, form: f.form ?? '13F-HR', kind: f.kind ?? '13f', accession: f.accession, accepted: f.accepted, sent: new Date(sentAt).toISOString(), seconds: Math.round((sentAt - Date.parse(f.accepted!)) / 1000), ...(replays.has(f.accession) ? { replay: true } : {}) }));
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
}

/**
 * Hourly backstop from the data run's index.json, for anything the minute poll missed: same
 * forward-only periods, moves taken from alerts.json. Also refreshes the CIK map for the poll.
 */
export async function runBackstop(env: Env, now: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${env.DATA_URL}index.json`);
  if (!res.ok) throw new Error(`index.json ${res.status}`);
  const idx = (await res.json()) as { managers?: IndexRow[]; generated_at?: string; build_id?: string };
  const rows = idx.managers ?? [];
  // /v1 responses say when and from which build the data was made.
  const build = JSON.stringify({ data_built_at: idx.generated_at ?? null, build_id: idx.build_id ?? (idx.generated_at ? idx.generated_at.replace(/[-:]/g, '') : null) });
  if ((await env.DB.get('v1:build')) !== build) await env.DB.put('v1:build', build);

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
      type: m.type ?? null,
      status: m.status ?? null,
      latest_quarter: m.quarter ?? null,
      latest_report_date: m.report_date ?? null,
      latest_filing_date: m.filing_date ?? null,
      latest_accession: m.accession ?? null,
      total_value_usd: m.total_value ?? null,
      position_count: m.position_count ?? null,
      history_quarters: m.history_quarters ?? [],
    })),
  );
  if ((await env.DB.get('v1:filers')) !== filerJson) await env.DB.put('v1:filers', filerJson);

  const raw = await env.DB.get('alerts:periods');
  const periods = JSON.parse(raw ?? '{}') as Record<string, string>;
  const before = JSON.stringify(periods);
  const out: Record<string, unknown> = {};
  let recent: { accession: string; moves?: Moves }[] | null = null;
  const movesFor = async (acc: string) => {
    if (!recent) {
      const r = await fetch(`${env.DATA_URL}alerts.json`);
      recent = r.ok ? (((await r.json()) as { recent?: { accession: string; moves?: Moves }[] }).recent ?? []) : [];
    }
    return recent.find((x) => x.accession === acc)?.moves ?? null;
  };
  const changedTickers = (m: Moves) => [...m.new, ...m.added, ...m.trimmed, ...m.exited].map((r) => r.ticker).filter((t): t is string => !!t);

  // Follow-ups with the moves for filings the minute poll sent without them.
  const pendingRaw = await env.DB.get('alerts:pending-moves');
  if (pendingRaw) {
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
    if (ready.length) out.followups = { filings: ready.map((f) => f.slug), ...(await deliver(env, ready, [], now)) };
  }
  const fresh: IndexRow[] = [];
  for (const f of rows) {
    // Holdings reports (13F-HR and restated 13F-HR/A) record the period; notices (13F-NT) don't.
    if (!f.ok || !f.slug || !f.accession || !f.report_date || !f.form?.startsWith('13F-HR')) continue;
    if (advance(periods, [f.slug], f.report_date).fresh.length && raw && alertable({ form: f.form, filing_date: f.filing_date ?? '' }, now)) fresh.push(f);
  }
  if (JSON.stringify(periods) !== before || !raw) await env.DB.put('alerts:periods', JSON.stringify(periods));
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
  for (const m of await listMembers(env)) {
    if (!isActive(m) || m.alerts === 'off') continue;
    const f = await getFollows(env, m);
    for (const t of f.stocks) want.add(t);
    for (const s of [...f.investors, ...(Array.isArray(m.alerts) ? m.alerts : [])]) followed.add(s);
  }
  // Follows saved before any filer could be followed get their CIKs here.
  await resolveFollowedFilers(env, [...followed]).catch(() => []);
  await pruneExtra(env, followed);
  // Baselines for followed filers that don't have one yet (followed before snapshots existed).
  let snaps = 0;
  for (const [cik, ms] of Object.entries(await extraMap(env))) {
    const rd = ms[0]?.report_date;
    if (snaps >= 5 || !rd || (await env.HIST.get(baselineKey(cik, rd)))) continue;
    if (await snapshotBaseline(env, cik).catch(() => false)) snaps++;
  }
  const map: Record<string, string[]> = {};
  if (want.size) {
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
  return { status: 'ok', tickers: want.size, issuers: Object.keys(map).length };
}

const EVENT_PAGES = 2;
const EVENTS_PER_MINUTE = 8;

/** Form 4 and 13D/G feed pages back to `since` (newest first), at most EVENT_PAGES each. */
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
  for (const [accession, es] of todo) {
    // A Form 4 takes 2 SEC requests, a 13D/G up to 5 with its previous filing: the rest wait a minute.
    if (secBudget.left < 5) break;
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
          const ev: AlertEvent = { ...base, manager: who.map((i) => i.name).join(', '), action: 'buy', issuer: f4.issuer, ticker: base.ticker ?? f4.ticker, shares: bought, value_usd: f4.bought_usd, avg_price: bought ? f4.bought_usd / bought : null, classes: f4.classes, footnotes: f4.footnotes, insider: ins };
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
  if (live.length) await logLatency(env, live.map((e) => ({ slug: e.slug || e.subject_tickers?.join(',') || '', manager: e.manager, form: e.form, kind: e.kind, accession: e.id, accepted: e.accepted })), Date.now());
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
export async function runScheduled(env: Env, scheduledTime: number): Promise<Record<string, unknown>> {
  const t = new Date(scheduledTime);
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (err) {
      out[name] = `error: ${err}`;
    }
  };
  // Spread the hourly jobs over the hour so each invocation stays within the free plan's CPU time.
  if (t.getUTCMinutes() === 17) await step('backstop', () => runBackstop(env, scheduledTime));
  if (t.getUTCMinutes() === 47) await step('events', () => runEvents(env, scheduledTime));
  if (t.getUTCMinutes() === 32 && t.getUTCHours() === 3) await step('digest', () => runDigest(env, scheduledTime - 3600_000));
  if (t.getUTCMinutes() === 52) await step('watch', () => runWatchMap(env));
  // SEC requests this run may make; the rest of the 50-subrequest limit is for mail, GitHub and data.
  secBudget.left = Number(env.SEC_BUDGET ?? 40);
  await step('poll', () => runPoll(env, scheduledTime));
  await step('events_poll', () => runEventPoll(env, scheduledTime));
  await step('webhooks', () => runWebhookRetries(env, scheduledTime));
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
