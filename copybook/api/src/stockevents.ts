/**
 * GET /events?tickers=: the latest Form 4s by a company's own insiders and the Schedule 13D/Gs any
 * filer made on it, per ticker, for My book. Read from the issuer's EDGAR company feed; each filing
 * is parsed once and kept in R2 (tev/{TICKER}.json), so a refresh only fetches what's new.
 */
import { companyFilings, type FeedEntry, fetchSchedule13, fetchSubmission, type Form4Class, parseForm4, secBudget } from './edgar';
import type { Env } from './env';

export interface StockEvent {
  ticker: string;
  form: string;
  filer_name: string;
  /** The reporting owner's CIK (Form 4) or the first reporting person's (13D/G). */
  filer_cik: string | null;
  issuer: string;
  /** Form 4: the insider's relationship, e.g. "Vice Chairman, Director" or "10% owner". Null on 13D/G. */
  role: string | null;
  /** buy, sell, mixed (open market), grant, option_exercise, tax_withholding, gift, other; 13D/G: new_stake, stake_update. */
  action: string;
  shares: number | null;
  price: number | null;
  value_usd: number | null;
  shares_after: number | null;
  prev_shares_after: number | null;
  percent_of_class: number | null;
  /** Form 4: the first transaction date; 13D/G: the date of the event. */
  event_date: string | null;
  /** Form 4: the last transaction date (the same day for most filings). */
  last_transaction_date: string | null;
  /** Form 4: each ownership line, e.g. direct 317 and indirect "By Jain Foundation Inc." 67,608, with its open-market trades. */
  ownership: { security: string; ownership: 'direct' | 'indirect'; nature: string | null; shares_after: number; bought: number; sold: number }[] | null;
  /** Form 4 holdings per class, as /v1/events serves them. */
  classes?: Form4Class[] | null;
  accepted_at: string;
  accession: string;
  url: string;
}

const VERSION = 2;

interface Cached {
  v?: number;
  cik: string;
  checked_at: number;
  /** How far back each feed was read: the oldest filing examined (ISO), per form family. */
  from?: { form4: string | null; schedule13: string | null };
  /** Parsed filings from the latest feeds: the event, or 0 when it's about another issuer (this CIK as an owner). */
  seen: Record<string, StockEvent | 0>;
}

const FRESH_MS = 20 * 60_000;
/** Matched events kept per ticker; the request's `limit` (default 5) picks from these. */
const KEEP = 10;
/** SEC requests one /events call may spend refreshing; tickers left over come back in `pending`. */
const BUDGET = 36;
const CODES: Record<string, string> = { A: 'grant', M: 'option_exercise', F: 'tax_withholding', G: 'gift', C: 'conversion' };

const ENTITY = /\b(L\.?P\.?|LLC|INC|CORP|CO|LTD|PLC|TRUST|FUND|PARTNERS|CAPITAL|HOLDINGS?|MANAGEMENT|GROUP|ADVISORS|INVESTMENTS?|FOUNDATION|BANK)\b/i;
const noMs = (iso: string) => iso.replace(/\.\d{3}Z$/, 'Z');
const index = (cik: string, accession: string) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${accession}-index.htm`;

async function form4Event(ticker: string, cik: string, e: FeedEntry): Promise<StockEvent | 0 | null> {
  const text = await fetchSubmission(cik, e.accession);
  const f = text ? parseForm4(text) : null;
  if (!f) return null;
  if (f.issuer_cik !== cik) return 0;
  const who = f.insiders.find((i) => i.roles.length) ?? f.insiders[0];
  const traded = f.classes.reduce((s, c) => s + c.bought + c.sold, 0);
  const value = f.classes.reduce((s, c) => s + c.value_usd, 0);
  const sum = (k: 'shares_after' | 'shares_before') => (f.classes.some((c) => c[k] !== null) ? f.classes.reduce((s, c) => s + (c[k] ?? 0), 0) : null);
  const after = sum('shares_after');
  const before = sum('shares_before');
  return {
    ticker,
    form: e.form,
    filer_name: who?.name ?? f.owners[0]?.name ?? '',
    filer_cik: who?.cik ?? f.owners[0]?.cik ?? null,
    issuer: f.issuer,
    role: who?.roles.map((r) => (/^see remarks$/i.test(r) ? 'Officer' : r)).join(', ') || null,
    action: f.action !== 'other' ? f.action : (CODES[f.codes[0]] ?? 'other'),
    // Open-market shares; for a gift, grant or withholding, how far the balance moved.
    shares: traded || (before !== null && after !== null && after !== before ? Math.abs(after - before) : null),
    price: traded && value ? Math.round((value / traded) * 100) / 100 : null,
    value_usd: value || null,
    shares_after: after,
    prev_shares_after: before,
    percent_of_class: null,
    event_date: f.event_date,
    last_transaction_date: f.last_transaction_date,
    ownership: f.classes.flatMap((c) => (c.holdings ?? []).map((x) => ({ security: c.security, ...x }))),
    classes: f.classes,
    accepted_at: noMs(e.accepted),
    accession: e.accession,
    url: index(cik, e.accession),
  };
}

async function schedule13Event(ticker: string, cik: string, e: FeedEntry): Promise<StockEvent | 0 | null> {
  const s = await fetchSchedule13(cik, e.accession);
  if (!s) return null;
  if (s.issuer_cik !== cik) return 0;
  const more = s.persons.length - 1;
  // Lead with the person behind the entities (CARL C ICAHN, not ICAHN ENTERPRISES HOLDINGS L.P.) when one filed.
  const lead = s.persons.find((p) => !ENTITY.test(p.name)) ?? s.persons[0];
  return {
    ticker,
    form: e.form,
    filer_name: `${lead?.name ?? ''}${more > 0 ? ` and ${more} other${more > 1 ? 's' : ''}` : ''}`,
    filer_cik: lead?.cik ? lead.cik.padStart(10, '0') : null,
    issuer: s.issuer,
    role: null,
    action: /\/A$/.test(e.form) ? 'stake_update' : 'new_stake',
    shares: null,
    price: null,
    value_usd: null,
    shares_after: s.shares,
    prev_shares_after: null,
    percent_of_class: s.percent_of_class,
    event_date: s.event_date,
    last_transaction_date: null,
    ownership: null,
    classes: null,
    accepted_at: noMs(e.accepted),
    accession: e.accession,
    url: index(cik, e.accession),
  };
}

const events = (c: Cached) =>
  Object.values(c.seen)
    .filter((v): v is StockEvent => !!v)
    .sort((a, b) => b.accepted_at.localeCompare(a.accepted_at));

/** Re-reads the issuer's feeds and parses new filings newest first until KEEP match. False when the budget ran out. */
async function refresh(ticker: string, c: Cached): Promise<boolean> {
  if (secBudget.left < 2) return false;
  const [f4, s13] = await Promise.all([companyFilings(c.cik, '4', 20), companyFilings(c.cik, 'SCHEDULE 13', 10)]);
  const feed = [...f4.filter((e) => /^4(\/A)?$/.test(e.form)), ...s13].sort((a, b) => b.accepted.localeCompare(a.accepted));
  const seen: Cached['seen'] = {};
  for (const e of feed) if (e.accession in c.seen) seen[e.accession] = c.seen[e.accession];
  let complete = true;
  for (let i = 0; i < feed.length; i += 5) {
    if (Object.values(seen).filter(Boolean).length >= KEEP) break;
    const todo = feed.slice(i, i + 5).filter((e) => !(e.accession in seen));
    if (todo.length > secBudget.left) {
      complete = false;
      break;
    }
    const parsed = await Promise.all(todo.map((e) => (e.form.startsWith('4') ? form4Event(ticker, c.cik, e) : schedule13Event(ticker, c.cik, e)).catch(() => null)));
    todo.forEach((e, j) => {
      if (parsed[j] !== null) seen[e.accession] = parsed[j];
      else complete = false; // unreadable now: tried again next refresh
    });
  }
  c.seen = seen;
  const oldest = (xs: FeedEntry[]) => xs.filter((e) => e.accession in seen).map((e) => noMs(e.accepted)).sort()[0] ?? null;
  c.from = { form4: oldest(feed.filter((e) => e.form.startsWith('4'))), schedule13: oldest(feed.filter((e) => !e.form.startsWith('4'))) };
  if (complete) c.checked_at = Date.now();
  return complete;
}

/** Ticker -> issuer CIK from the precomputed SEC map (a string search, no 200 KB parse). */
async function issuerCiks(env: Env, tickers: string[]): Promise<Record<string, string>> {
  const obj = await env.HIST.get('pre/sec-tickers.json');
  if (!obj) return {};
  const text = await new Response(obj.body).text();
  const out: Record<string, string> = {};
  for (const t of tickers) {
    const at = text.indexOf(`"${t}":"`);
    if (at >= 0) out[t] = text.slice(at + t.length + 4, at + t.length + 14);
  }
  return out;
}

export async function stockEvents(env: Env, tickers: string[], limit: number) {
  secBudget.left = BUDGET;
  const cache = new Map<string, Cached>();
  await Promise.all(
    tickers.map(async (t) => {
      const o = await env.HIST.get(`tev/${t}.json`);
      const c = o ? (JSON.parse(await new Response(o.body).text()) as Cached) : null;
      // Parsed by an older version (fewer fields): read again.
      if (c) cache.set(t, c.v === VERSION ? c : { v: VERSION, cik: c.cik, checked_at: 0, seen: {} });
    }),
  );
  const missing = tickers.filter((t) => !cache.has(t));
  const ciks = missing.length ? await issuerCiks(env, missing) : {};
  for (const t of missing) if (ciks[t]) cache.set(t, { v: VERSION, cik: ciks[t], checked_at: 0, seen: {} });

  const pending: string[] = [];
  const unknown = tickers.filter((t) => !cache.has(t));
  // Stalest first, so tickers never loaded beat ones that are merely 20 minutes old.
  const stale = tickers.filter((t) => cache.has(t) && Date.now() - cache.get(t)!.checked_at > FRESH_MS).sort((a, b) => cache.get(a)!.checked_at - cache.get(b)!.checked_at);
  for (const t of stale) {
    const c = cache.get(t)!;
    const before = JSON.stringify(c);
    const done = await refresh(t, c).catch(() => false);
    if (!done) pending.push(t);
    if (JSON.stringify(c) !== before) await env.HIST.put(`tev/${t}.json`, JSON.stringify(c));
  }
  const data: Record<string, { cik: string; checked_at: string | null; from: Cached['from'] | null; events: StockEvent[] }> = {};
  for (const [t, c] of cache) data[t] = { cik: c.cik, checked_at: c.checked_at ? noMs(new Date(c.checked_at).toISOString()) : null, from: c.from ?? null, events: events(c).slice(0, limit) };
  return { tickers: data, pending, unknown };
}
