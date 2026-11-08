import { alertMail, digestMail, sendMail } from './email';
import { companyFilings, computeMoves, fetch13F, latestFilings, quarterOf, type FeedEntry, type MoveRow, type Moves, type Position } from './edgar';
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
}

export interface AlertEvent {
  id: string;
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
}

interface Manager {
  slug: string;
  manager: string;
  name: string;
  cik: string;
  featured?: boolean;
  /** Filer type from the data run, e.g. hedge_fund, active, bank, broker, index. */
  type?: string | null;
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

/** Which of these filings and events a member gets, by their alert switch and follows. */
export function forMember(m: Member, f: Follows, filings: Alert13F[], events: AlertEvent[], meta: FilerMeta = {}): { filings: Alert13F[]; events: AlertEvent[] } {
  if (m.alerts === 'off') return { filings: [], events: [] };
  const all = m.alerts === 'all';
  const investors = new Set(Array.isArray(m.alerts) ? [...m.alerts, ...f.investors] : f.investors);
  const stocks = new Set(f.stocks);
  const fl = filings.filter((x) => all || x.slugs.some((s) => investors.has(s)) || (x.slugs.some((s) => stockAlerts(meta, s)) && x.tickers.some((t) => stocks.has(t))));
  const ev = events.filter((e) => (e.kind !== '13g' || f.include_13g) && (all || investors.has(e.slug) || (!!e.ticker && stocks.has(e.ticker) && stockAlerts(meta, e.slug))));
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

async function deliver(env: Env, filings: Alert13F[], events: AlertEvent[], now: number): Promise<{ emails: number; digest: number; mail: string }> {
  if (!filings.length && !events.length) return { emails: 0, digest: 0, mail: 'none' };
  // Everything goes in the day's digest store; digest members get it from there tonight.
  const key = `digest:${etDay(now)}`;
  const day = JSON.parse((await env.DB.get(key)) ?? '{"filings":[],"events":[]}') as { filings: Alert13F[]; events: AlertEvent[] };
  day.filings.push(...filings);
  day.events.push(...events);
  await env.DB.put(key, JSON.stringify(day), { expirationTtl: 3 * 86400 });

  const meta = await filerMeta(env);
  const mails = [];
  const notes: Member[] = [];
  let digest = 0;
  for (const raw of await listMembers(env)) {
    if (!isActive(raw) || !raw.email || raw.alerts === 'off') continue;
    const f = await getFollows(env, raw);
    const m = await scoped(env, raw, f);
    const mine = forMember(m, f, filings, events, meta);
    if (!mine.filings.length && !mine.events.length) continue;
    if (f.digest) digest++;
    else {
      mails.push(alertMail(env, m.email, mine.filings, mine.events, f, m));
      notes.push(m);
    }
  }
  const mail = await sendMail(env, mails);
  if (mail.split(',').every((s) => s === '200')) for (const m of notes) await noted(env, m);
  return { emails: mails.length, digest, mail };
}

/** After EDGAR closes: one email per digest member with the day's filings and events they follow. */
export async function runDigest(env: Env, now: number): Promise<{ emails: number; status: string }> {
  const day = etDay(now);
  const raw = await env.DB.get(`digest:${day}`);
  if (!raw) return { emails: 0, status: 'none' };
  const { filings, events } = JSON.parse(raw) as { filings: Alert13F[]; events: AlertEvent[] };
  const meta = await filerMeta(env);
  const mails = [];
  const notes: Member[] = [];
  for (const raw of await listMembers(env)) {
    if (!isActive(raw) || !raw.email || raw.alerts === 'off') continue;
    const f = await getFollows(env, raw);
    if (!f.digest) continue;
    const m = await scoped(env, raw, f);
    const mine = forMember(m, f, filings, events, meta);
    if (mine.filings.length || mine.events.length) {
      mails.push(digestMail(env, m.email, day, mine.filings, mine.events, f, m));
      notes.push(m);
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

/** Tickers and names for CUSIPs from the public securities map, without parsing all of it. */
async function lookupTickers(env: Env, rows: MoveRow[]): Promise<void> {
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
  const ciks = await cikMap(env);
  if (!ciks) return { status: 'no cik map yet' };
  const errors: string[] = [];
  let entries: FeedEntry[] = [];
  try {
    entries = await feedSince('13F-HR', now - LOOKBACK_MS);
  } catch (err) {
    errors.push(String(err));
  }
  // Backstop for a filing the feed pages missed (a failed poll, or a deadline-day burst): a few
  // curated filers' own feeds each minute, in rotation, featured managers more often.
  for (const cik of rotation(ciks, Math.floor(now / 60_000))) {
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
  // At most 8 filings a minute keeps the run under the free plan's 50 subrequests; the rest go next minute.
  const todo = feed.filter((e) => !handled.includes(e.accession)).slice(0, 8);
  if (!todo.length) return { status: 'none', ...(errors.length ? { errors } : {}) };

  const rawPeriods = await env.DB.get('alerts:periods');
  const periods = JSON.parse(rawPeriods ?? '{}') as Record<string, string>;
  const fresh: Alert13F[] = [];
  for (const e of todo) {
    const f = await fetch13F(e.cik, e.accession);
    if (!f) continue; // EDGAR hiccup: retried next minute while still in the feed
    handled.push(e.accession);
    const mgrs = ciks[e.cik];
    const { fresh: slugs, prev } = advance(periods, mgrs.map((m) => m.slug), f.report_date);
    if (!rawPeriods || !slugs.length || !alertable({ form: e.form, filing_date: e.accepted }, now)) continue;
    let moves: Moves | null = null;
    let tickers: string[] = [];
    if (f.holdings) {
      for (const s of slugs) {
        const book = await priorBook(env, s, prev[s]);
        if (!book) continue;
        const r = computeMoves(f.holdings, book);
        moves = r.moves;
        // Held positions already carry tickers from last quarter's book; look up only the new ones
        // shown in the email (each lookup scans the securities map, ~0.5 ms of CPU).
        await lookupTickers(env, moves.new);
        tickers = [...new Set(r.changed.map((x) => x.ticker).filter((t): t is string => !!t))];
        break;
      }
    }
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
    });
  }
  await env.DB.put('alerts:handled', JSON.stringify(handled.slice(-500)));
  await env.DB.put('alerts:periods', JSON.stringify(periods));
  // Books too big to diff here get their moves in a follow-up once the data run has them.
  const later = fresh.filter((f) => !f.moves);
  if (later.length) await env.DB.put('alerts:pending-moves', JSON.stringify([...JSON.parse((await env.DB.get('alerts:pending-moves')) ?? '[]'), ...later]));
  const sent = await deliver(env, fresh, [], now);
  // A curated filer filed: refresh the data now, so pages, history and moves follow within ~15 minutes.
  const filed = todo.filter((e) => handled.includes(e.accession));
  const refresh = filed.length && rawPeriods ? await dispatchRefresh(env, 'curated', `filing by ${ciks[filed[0].cik][0].slug}`, now, filed[0].accession) : undefined;
  if (fresh.length) await logLatency(env, fresh, Date.now());
  return { status: 'checked', filings: fresh.map((f) => `${f.slug} ${f.quarter}${f.moves ? '' : ' (no moves)'}`), ...sent, ...(refresh ? { refresh } : {}), ...(errors.length ? { errors } : {}) };
}

/**
 * Acceptance-to-send latency per alerted filing, newest first, for /health. Accessions listed in
 * KV alerts:replays (test sends of old filings) are marked and never counted.
 */
async function logLatency(env: Env, filings: Alert13F[], sentAt: number): Promise<void> {
  const replays = new Set(JSON.parse((await env.DB.get('alerts:replays')) ?? '[]') as string[]);
  const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as unknown[];
  const add = filings
    .filter((f) => f.accepted)
    .map((f) => ({ slug: f.slug, accession: f.accession, accepted: f.accepted, sent: new Date(sentAt).toISOString(), seconds: Math.round((sentAt - Date.parse(f.accepted!)) / 1000), ...(replays.has(f.accession) ? { replay: true } : {}) }));
  await env.DB.put('alerts:latency', JSON.stringify([...add, ...log].slice(0, 300)));
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
  const rows = ((await res.json()) as { managers?: IndexRow[] }).managers ?? [];

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
  if (e.kind === 'form4') return e.action === 'buy' || e.action === 'sell';
  return e.kind === '13d' || e.kind === '13g';
}

/** Hourly: new entries in the data run's events.json, keyed by accession. First run only records. */
export async function runEvents(env: Env, now: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${env.DATA_URL}events.json`);
  if (!res.ok) return { status: `events.json ${res.status}` };
  const events = ((await res.json()) as { events?: AlertEvent[] }).events ?? [];
  const raw = await env.DB.get('events:seen');
  const seen = new Set(JSON.parse(raw ?? '[]') as string[]);
  const fresh = events.filter((e) => !seen.has(e.id));
  if (raw && !fresh.length) return { status: 'none' };
  // Keep ids still in the 30-day feed so the list doesn't grow.
  await env.DB.put('events:seen', JSON.stringify([...new Set(events.map((e) => e.id))]));
  if (!raw) return { status: 'seeded', events: events.length };
  const send = fresh.filter((e) => eventAlertable(e, now));
  return { status: 'checked', new: fresh.length, alertable: send.length, ...(await deliver(env, [], send, now)) };
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
  await step('poll', () => runPoll(env, scheduledTime));
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
