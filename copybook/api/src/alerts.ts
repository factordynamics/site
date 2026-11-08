import { alertMail, digestMail, sendMail } from './email';
import { computeMoves, fetch13F, latestFilings, quarterOf, type MoveRow, type Moves, type Position } from './edgar';
import { isActive, type Env, type Member } from './env';
import { getFollows, listMembers, type Follows } from './members';

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
}

/** EDGAR filer CIK -> curated managers it reports for, built from index.json (incl. reported_by parents). */
type CikMap = Record<string, Manager[]>;

/** Times are ET-ish for day keys: EDGAR's filing day ends at 22:00 ET (03:00 UTC in winter). */
const etDay = (t: number) => new Date(t - 5 * 3600_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Targeting and delivery

/** Which of these filings and events a member gets, by their alert switch and follows. */
export function forMember(m: Member, f: Follows, filings: Alert13F[], events: AlertEvent[]): { filings: Alert13F[]; events: AlertEvent[] } {
  if (m.alerts === 'off') return { filings: [], events: [] };
  const all = m.alerts === 'all';
  const investors = new Set(Array.isArray(m.alerts) ? [...m.alerts, ...f.investors] : f.investors);
  const stocks = new Set(f.stocks);
  const fl = filings.filter((x) => all || x.slugs.some((s) => investors.has(s)) || x.tickers.some((t) => stocks.has(t)));
  const ev = events.filter((e) => (e.kind !== '13g' || f.include_13g) && (all || investors.has(e.slug) || (!!e.ticker && stocks.has(e.ticker))));
  return {
    filings: fl.filter((x, i) => fl.findIndex((y) => y.accession === x.accession) === i),
    events: ev.filter((x, i) => ev.findIndex((y) => y.id === x.id) === i),
  };
}

async function deliver(env: Env, filings: Alert13F[], events: AlertEvent[], now: number): Promise<{ emails: number; digest: number; mail: string }> {
  if (!filings.length && !events.length) return { emails: 0, digest: 0, mail: 'none' };
  // Everything goes in the day's digest store; digest members get it from there tonight.
  const key = `digest:${etDay(now)}`;
  const day = JSON.parse((await env.DB.get(key)) ?? '{"filings":[],"events":[]}') as { filings: Alert13F[]; events: AlertEvent[] };
  day.filings.push(...filings);
  day.events.push(...events);
  await env.DB.put(key, JSON.stringify(day), { expirationTtl: 3 * 86400 });

  const mails = [];
  let digest = 0;
  for (const m of await listMembers(env)) {
    if (!isActive(m) || !m.email || m.alerts === 'off') continue;
    const f = await getFollows(env, m);
    const mine = forMember(m, f, filings, events);
    if (!mine.filings.length && !mine.events.length) continue;
    if (f.digest) digest++;
    else mails.push(alertMail(env, m.email, mine.filings, mine.events, f));
  }
  return { emails: mails.length, digest, mail: await sendMail(env, mails) };
}

/** After EDGAR closes: one email per digest member with the day's filings and events they follow. */
export async function runDigest(env: Env, now: number): Promise<{ emails: number; status: string }> {
  const day = etDay(now);
  const raw = await env.DB.get(`digest:${day}`);
  if (!raw) return { emails: 0, status: 'none' };
  const { filings, events } = JSON.parse(raw) as { filings: Alert13F[]; events: AlertEvent[] };
  const mails = [];
  for (const m of await listMembers(env)) {
    if (!isActive(m) || !m.email || m.alerts === 'off') continue;
    const f = await getFollows(env, m);
    if (!f.digest) continue;
    const mine = forMember(m, f, filings, events);
    if (mine.filings.length || mine.events.length) mails.push(digestMail(env, m.email, day, mine.filings, mine.events, f));
  }
  return { emails: mails.length, status: await sendMail(env, mails) };
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

/**
 * Every minute: EDGAR's latest 13F-HR filings, matched to curated managers by CIK, emailed with the
 * moves computed here from the filing and last quarter's book in R2. KV is written only when a
 * curated manager has filed, so the minute cron stays inside the free tier.
 */
export async function runPoll(env: Env, now: number): Promise<Record<string, unknown>> {
  const ciks = await cikMap(env);
  if (!ciks) return { status: 'no cik map yet' };
  const feed = (await latestFilings('13F-HR')).filter((e) => e.form === '13F-HR' && ciks[e.cik]);
  if (!feed.length) return { status: 'none' };
  const handled = JSON.parse((await env.DB.get('alerts:handled')) ?? '[]') as string[];
  // At most 8 filings a minute keeps the run under the free plan's 50 subrequests; the rest go next minute.
  const todo = feed.filter((e) => !handled.includes(e.accession)).slice(0, 8);
  if (!todo.length) return { status: 'none' };

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
        const shown = [...moves.new, ...moves.added, ...moves.trimmed, ...moves.exited];
        await lookupTickers(env, r.changed.length <= 60 ? r.changed : shown);
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
  if (fresh.length) await logLatency(env, fresh, Date.now());
  return { status: 'checked', filings: fresh.map((f) => `${f.slug} ${f.quarter}${f.moves ? '' : ' (no moves)'}`), ...sent };
}

/** Acceptance-to-send latency per alerted filing, newest first, for /health. */
async function logLatency(env: Env, filings: Alert13F[], sentAt: number): Promise<void> {
  const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as unknown[];
  const add = filings.filter((f) => f.accepted).map((f) => ({ slug: f.slug, accession: f.accession, accepted: f.accepted, sent: new Date(sentAt).toISOString(), seconds: Math.round((sentAt - Date.parse(f.accepted!)) / 1000) }));
  await env.DB.put('alerts:latency', JSON.stringify([...add, ...log].slice(0, 50)));
}

interface IndexRow {
  ok?: boolean;
  slug: string;
  cik: string;
  manager: string;
  name: string;
  featured?: boolean;
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
  const byCik = (cik: string, m: IndexRow) => (ciks[cik.padStart(10, '0')] ??= []).push({ slug: m.slug, manager: m.manager, name: m.name, cik: m.cik.padStart(10, '0'), featured: m.featured });
  for (const m of rows) {
    if (!m.slug || !m.cik) continue;
    byCik(m.cik, m);
    if (m.reported_by && typeof m.reported_by === 'object' && m.reported_by.cik) byCik(m.reported_by.cik, m);
  }
  const cikJson = JSON.stringify(ciks);
  if ((await env.DB.get('alerts:ciks')) !== cikJson) await env.DB.put('alerts:ciks', cikJson);

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
  return out;
}
