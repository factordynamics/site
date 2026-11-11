/**
 * GET /events?tickers=: the latest Form 4s by a company's own insiders and the Schedule 13D/Gs any
 * filer made on it, per ticker, for My book. Read from the issuer's EDGAR company feed; each filing
 * is parsed once and kept in R2 (tev/{TICKER}.json), so a refresh only fetches what's new.
 */
import { companyFilings, type FeedEntry, fetchSchedule13, fetchSubmission, type Form4Class, type Form4Line, parseForm4, secBudget } from './edgar';
import type { Env } from './env';
import { quarterStart } from './seasons';

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
  /** Form 4: every non-derivative transaction code in the filing, in filing order (P, S, G, F, M, A, C, ...). */
  codes: string[] | null;
  /** Form 4: every transaction line as filed (code, shares, price, acquired/disposed, direct/indirect, date), derivative lines flagged. */
  transactions: Form4Line[] | null;
  /** Form 4: non-derivative shares and value per kind. value_usd is null where the filing gives no price (gifts, grants, conversions). */
  totals: Partial<Record<Kind, { shares: number; value_usd: number | null }>> | null;
  /** Form 4: an open-market purchase or sale (P or S) is in it. Gifts, grants, withholding, exercises and conversions alone are not trades. */
  open_market: boolean | null;
  /** Form 4 holdings per class, as /v1/events serves them. */
  classes?: Form4Class[] | null;
  /** The first transaction date (Form 4) or event date (13D/G): what window=quarter filters on. Filing can be days later. */
  trade_date?: string | null;
  /** Form 4: codes other than P/S on the traded class (J: "after distribution"; M: exercise; F: tax withholding). */
  has_other_codes?: string[];
  /** The ET date EDGAR accepted the filing. */
  filed_date?: string;
  /**
   * Form 4 with open-market trades: (P − S shares) ÷ the owner's holding of the traded security just before
   * those trades (after-filing holding minus P plus S), across all their direct and indirect lines, in percent.
   * Gifts and transfers between the owner's own accounts move nothing; exercised shares count as held. Null
   * without P or S, or with no prior holding.
   */
  pct_change?: number | null;
  /** Form 4: an option exercise (M or X) and a sale (S) on the same date, e.g. a CFO exercising and selling. */
  exercise_and_sale?: boolean;
  accepted_at: string;
  accession: string;
  url: string;
}

/** v3: Form 4 transaction lines and totals, 13D/G share classes, the issuer-only Form 4 window. */
const VERSION = 3;
type Kind = 'bought' | 'sold' | 'gifted' | 'granted' | 'withheld' | 'exercised' | 'converted' | 'other';
const KIND: Record<string, Kind> = { P: 'bought', S: 'sold', G: 'gifted', A: 'granted', F: 'withheld', M: 'exercised', X: 'exercised', C: 'converted' };
/** The action a Form 4 without open-market trades shows: its largest kind of transaction, a conversion only when that's all it is. */
const ACTION: Record<Kind, string> = { bought: 'buy', sold: 'sell', gifted: 'gift', granted: 'grant', withheld: 'tax_withholding', exercised: 'option_exercise', converted: 'conversion', other: 'other' };

interface Cached {
  v?: number;
  cik: string;
  checked_at: number;
  /** How far back each feed was read: the oldest filing examined (ISO), per form family. */
  from?: { form4: string | null; schedule13: string | null };
  /** Every issuer Form 4 and 13D/G accepted since this date is in (quarterStart); null when a cap cut it short. */
  window?: string | null;
  /** Parsed filings from the latest feeds: the event, or 0 when it's about another issuer (this CIK as an owner) or another share class. */
  seen: Record<string, StockEvent | 0>;
  /** Every ticker the issuer trades as (BRK.A and BRK.B), for placing a 13D/G on its class. */
  tickers?: string[];
  /** The latest re-read: when and how it ended (complete, budget, unreadable:{accession}, error:{message}). */
  last_try?: { at: number; result: string };
  /** Filings that failed to parse, by accession: tries so far (3 and it's skipped, so one bad filing can't stall a ticker). */
  failed?: Record<string, number>;
}

const FRESH_MS = 20 * 60_000;
/**
 * Kept per ticker: every Form 4 where the company is the issuer and every Schedule 13D/G on it since the
 * start of the quarter whose 13Fs are due next (quarterStart), and at least the latest 20 and 10. The feeds
 * are paged back 100 at a time until they pass that date, at most PAGES pages and MAX_F4 issuer Form 4s.
 */
const KEEP_F4 = 20;
const KEEP_13 = 10;
const MAX_F4 = 150;
const PAGES = 3;
/** SEC requests one /events call may spend refreshing; tickers left over come back in `pending`. */
const BUDGET = 36;

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
  const totals: NonNullable<StockEvent['totals']> = {};
  for (const l of f.lines.filter((x) => !x.derivative && x.code)) {
    const t = (totals[KIND[l.code] ?? 'other'] ??= { shares: 0, value_usd: null });
    t.shares += l.shares;
    if (l.price) t.value_usd = Math.round((t.value_usd ?? 0) + l.shares * l.price);
  }
  // No open-market trade: the largest other kind leads (Buffett's C then G is a gift); a conversion only when alone.
  const kinds = (Object.entries(totals) as [Kind, { shares: number; value_usd: number | null }][]).sort((a, b) => b[1].shares - a[1].shares);
  const lead = kinds.find(([k]) => k !== 'converted') ?? kinds[0];
  return {
    ticker,
    form: e.form,
    filer_name: who?.name ?? f.owners[0]?.name ?? '',
    filer_cik: who?.cik ?? f.owners[0]?.cik ?? null,
    issuer: f.issuer,
    role: who?.roles.map((r) => (/^see remarks$/i.test(r) ? 'Officer' : r)).join(', ') || null,
    action: f.action !== 'other' ? f.action : lead ? ACTION[lead[0]] : 'other',
    // Open-market shares; otherwise the leading kind's shares (a gift's, a grant's).
    shares: traded || lead?.[1].shares || null,
    price: traded && value ? Math.round((value / traded) * 100) / 100 : null,
    value_usd: value || (lead?.[1].value_usd ?? null),
    shares_after: after,
    prev_shares_after: before,
    percent_of_class: null,
    event_date: f.event_date,
    last_transaction_date: f.last_transaction_date,
    ownership: f.classes.flatMap((c) => (c.holdings ?? []).map((x) => ({ security: c.security, ...x }))),
    codes: f.codes,
    transactions: f.lines,
    totals,
    open_market: f.codes.includes('P') || f.codes.includes('S'),
    classes: f.classes,
    accepted_at: noMs(e.accepted),
    accession: e.accession,
    url: index(cik, e.accession),
  };
}

async function schedule13Event(ticker: string, cik: string, e: FeedEntry, siblings: string[]): Promise<StockEvent | 0 | null> {
  const s = await fetchSchedule13(cik, e.accession);
  if (!s) return null;
  if (s.issuer_cik !== cik) return 0;
  // An issuer with several listed classes: a 13D/G on "Class A Common Stock" belongs to BRK.A, not BRK.B.
  const cls = s.security?.match(/\bclass\s+([A-Z])\b/i)?.[1]?.toUpperCase();
  const home = cls && siblings.length > 1 ? siblings.find((t) => t.endsWith(`.${cls}`)) : undefined;
  if (home && home !== ticker) return 0;
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
    codes: null,
    transactions: null,
    totals: null,
    open_market: null,
    classes: null,
    accepted_at: noMs(e.accepted),
    accession: e.accession,
    url: index(cik, e.accession),
  };
}

const etDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** trade_date, filed_date, pct_change and exercise_and_sale, from the cached transaction lines (no re-parse). */
export function withTrade(e: StockEvent): StockEvent {
  const lines = (e.transactions ?? []).filter((l) => !l.derivative);
  const dates = lines.map((l) => l.date).filter((d): d is string => !!d).sort();
  const trade_date = e.form.startsWith('4') ? (dates[0] ?? e.event_date) : e.event_date;
  let pct_change: number | null = null;
  let has_other_codes: string[] = [];
  const traded = new Set(lines.filter((l) => l.code === 'P' || l.code === 'S').map((l) => l.security));
  if (e.form.startsWith('4') && traded.size) {
    const of = (l: { security: string }) => traded.has(l.security);
    const after = (e.ownership ?? []).filter(of).reduce((s, o) => s + o.shares_after, 0);
    // The holding before the filing, before any line in it, on the traded class: every line moves it except
    // gifts (G, between the owner's own accounts, as GOOGL's into his trust) and exercises (M/X: the shares
    // exercised to sell count as held, so an exercise and same-day sale reads as the sale). DASH's Tang: J
    // distributions of 7,828 and 72,367 shares, then 84,526 sold: 50,579 -> 46,248, -8.56%, not -65%.
    const moved = lines.filter((l) => of(l) && !['G', 'M', 'X'].includes(l.code)).reduce((s, l) => s + (l.acquired_disposed === 'D' ? -l.shares : l.shares), 0);
    const before = after - moved;
    pct_change = before > 0 ? Math.round(((after - before) / before) * 10000) / 100 : null;
    has_other_codes = [...new Set(lines.filter((l) => of(l) && !['P', 'S'].includes(l.code)).map((l) => l.code))].sort();
  }
  const all = e.transactions ?? [];
  const exercise_and_sale = all.some((m) => (m.code === 'M' || m.code === 'X') && m.date && all.some((x) => x.code === 'S' && !x.derivative && x.date === m.date));
  return { ...e, trade_date: trade_date ?? null, filed_date: etDate(e.accepted_at), pct_change, has_other_codes, exercise_and_sale };
}

const events = (c: Cached) =>
  Object.values(c.seen)
    .filter((v): v is StockEvent => !!v)
    .map(withTrade)
    .sort((a, b) => b.accepted_at.localeCompare(a.accepted_at));

/** Re-reads the issuer's feeds and parses new filings newest first until the window is in. False when the budget ran out. */
async function refresh(ticker: string, c: Cached, now = Date.now()): Promise<boolean> {
  if (secBudget.left < 2) return (c.last_try = { at: now, result: 'budget' }), false;
  const since = quarterStart(now);
  // Newest first, a page at a time, until a page ends before the window (or is the feed's last).
  const pages = async (type: string, size: number) => {
    const out: FeedEntry[] = [];
    for (let p = 0; p < PAGES; p++) {
      const page = await companyFilings(c.cik, type, size, p * size);
      out.push(...page);
      if (page.length < size || page[page.length - 1].accepted < since) return { feed: out, reached: true };
    }
    return { feed: out, reached: false };
  };
  const [f4, s13] = await Promise.all([pages('4', 100), pages('SCHEDULE 13', 40)]);
  const feed = [...f4.feed.filter((e) => /^4(\/A)?$/.test(e.form)), ...s13.feed].sort((a, b) => b.accepted.localeCompare(a.accepted));
  const seen: Cached['seen'] = {};
  const isF4 = (form: string) => form.startsWith('4');
  const kept = (f4only: boolean) => feed.filter((e) => isF4(e.form) === f4only && seen[e.accession]).length;
  const room = (e: FeedEntry) => (isF4(e.form) ? kept(true) < MAX_F4 && (e.accepted >= since || kept(true) < KEEP_F4) : e.accepted >= since || kept(false) < KEEP_13);
  // Newest first, until the window and each family's minimum are in: older filings beyond them are dropped from the cache.
  for (const e of feed) if (e.accession in c.seen && (c.seen[e.accession] === 0 || room(e))) seen[e.accession] = c.seen[e.accession];
  let complete = true;
  let result = 'complete';
  const failed = c.failed ?? {};
  for (let i = 0; i < feed.length; i += 5) {
    const todo = feed.slice(i, i + 5).filter((e) => !(e.accession in seen) && room(e));
    if (todo.length > secBudget.left) {
      complete = false;
      result = 'budget';
      break;
    }
    const parsed = await Promise.all(todo.map((e) => (isF4(e.form) ? form4Event(ticker, c.cik, e) : schedule13Event(ticker, c.cik, e, c.tickers ?? [ticker])).catch(() => null)));
    todo.forEach((e, j) => {
      if (parsed[j] !== null) seen[e.accession] = parsed[j];
      else if ((failed[e.accession] = (failed[e.accession] ?? 0) + 1) >= 3) seen[e.accession] = 0; // unreadable 3 times: skipped
      else (complete = false), (result = `unreadable:${e.accession}`); // unreadable now: tried again next refresh
    });
  }
  c.failed = Object.fromEntries(Object.entries(failed).filter(([a]) => a in seen || feed.some((e) => e.accession === a)));
  c.last_try = { at: now, result };
  c.seen = seen;
  const oldest = (xs: FeedEntry[]) => xs.filter((e) => e.accession in seen).map((e) => noMs(e.accepted)).sort()[0] ?? null;
  c.from = { form4: oldest(feed.filter((e) => e.form.startsWith('4'))), schedule13: oldest(feed.filter((e) => !e.form.startsWith('4'))) };
  // Complete back to the window start when both feeds were read past it and no cap cut the Form 4s.
  c.window = complete && f4.reached && s13.reached && kept(true) < MAX_F4 ? noMs(since) : null;
  if (complete) c.checked_at = Date.now();
  return complete;
}

/** Ticker -> issuer CIK and every ticker that CIK trades as, from the precomputed SEC map (string searches, no 200 KB parse). */
async function issuerCiks(env: Env, tickers: string[]): Promise<Record<string, { cik: string; tickers: string[] }>> {
  const obj = await env.HIST.get('pre/sec-tickers.json');
  if (!obj) return {};
  const text = await new Response(obj.body).text();
  const out: Record<string, { cik: string; tickers: string[] }> = {};
  for (const t of tickers) {
    const at = text.indexOf(`"${t}":"`);
    if (at < 0) continue;
    const cik = text.slice(at + t.length + 4, at + t.length + 14);
    out[t] = { cik, tickers: [...text.matchAll(new RegExp(`"([A-Z0-9.]+)":"${cik}"`, 'g'))].map((m) => m[1]) };
  }
  return out;
}

/**
 * Tickers' events, refreshing those older than `freshMs` with at most `budget` SEC requests (a request
 * spends its own; the scheduled precompute passes what the minute left). The rest come back in `pending`.
 */
/** Tickers whose EDGAR feeds a request is reading now (one read per ticker at a time, across requests). */
const READING = new Set<string>();

export async function stockEvents(env: Env, tickers: string[], limit: number, opts: { budget?: number; freshMs?: number; keep?: (e: StockEvent) => boolean; deadlineMs?: number } = {}) {
  // A request reads EDGAR only until its deadline: the rest is served from the cache and listed in `pending`
  // (the cron refreshes owned and watched names on its own).
  const until = opts.deadlineMs ? Date.now() + opts.deadlineMs : Infinity;
  secBudget.left = opts.budget ?? BUDGET;
  const fresh = opts.freshMs ?? FRESH_MS;
  const cache = new Map<string, Cached>();
  await Promise.all(
    tickers.map(async (t) => {
      const o = await env.HIST.get(`tev/${t}.json`);
      const c = o ? (JSON.parse(await new Response(o.body).text()) as Cached) : null;
      // Parsed by an older version (fewer fields): read again.
      // An older version's cache: its Form 4s are read again (new fields); v2's 13D/G rows are still current.
      if (c) cache.set(t, c.v === VERSION ? c : { v: VERSION, cik: c.cik, checked_at: 0, seen: {} });
    }),
  );
  const missing = tickers.filter((t) => !cache.get(t)?.tickers);
  const ciks = missing.length ? await issuerCiks(env, missing) : {};
  for (const t of missing) {
    const c = cache.get(t);
    if (c) c.tickers = ciks[t]?.tickers ?? [t];
    else if (ciks[t]) cache.set(t, { v: VERSION, cik: ciks[t].cik, checked_at: 0, seen: {}, tickers: ciks[t].tickers });
  }

  const pending: string[] = [];
  const unknown = tickers.filter((t) => !cache.has(t));
  // Stalest first, so tickers never loaded beat ones that are merely 20 minutes old.
  const stale = tickers.filter((t) => cache.has(t) && Date.now() - cache.get(t)!.checked_at > fresh).sort((a, b) => cache.get(a)!.checked_at - cache.get(b)!.checked_at);
  for (const t of stale) {
    const left = until - Date.now();
    if (left <= 0) {
      pending.push(t);
      continue;
    }
    // A read another request started is still going: served from the cache, listed as pending.
    if (left !== Infinity && READING.has(t)) {
      pending.push(t);
      continue;
    }
    // Under a deadline, refreshed on a copy: a read cut off mid-way can't change what this response serves.
    const c = left === Infinity ? cache.get(t)! : (structuredClone(cache.get(t)!) as Cached);
    const before = JSON.stringify(c);
    const save = async (ok: boolean) => {
      // Partial progress is kept too (a ticker needing more reads than one call's budget gets there over several);
      // only a complete read moves checked_at and the window.
      if (JSON.stringify(c) !== before) await env.HIST.put(`tev/${t}.json`, JSON.stringify(c));
      return ok;
    };
    const read = refresh(t, c).catch((e) => ((c.last_try = { at: Date.now(), result: `error:${String(e).slice(0, 120)}` }), false));
    if (left === Infinity) {
      cache.set(t, c);
      if (!(await save(await read))) pending.push(t);
      continue;
    }
    READING.add(t);
    // A read past the deadline finishes after the response and is saved, so the next call serves it (the analyst: a
    // late read was thrown away, so polls repeated it and slow tickers stayed pending). gene's process keeps running.
    const kept = read.then(save).catch(() => false).finally(() => READING.delete(t));
    const done = await Promise.race([kept, new Promise<'late'>((r) => setTimeout(() => r('late'), left))]);
    if (done === 'late') {
      pending.push(t);
      continue;
    }
    cache.set(t, c);
    if (!done) pending.push(t);
  }
  const data: Record<string, { cik: string; checked_at: string | null; last_try: { at: string; result: string } | null; from: Cached['from'] | null; window: string | null; events: StockEvent[] }> = {};
  for (const [t, c] of cache) data[t] = { cik: c.cik, checked_at: c.checked_at ? noMs(new Date(c.checked_at).toISOString()) : null, last_try: c.last_try ? { at: noMs(new Date(c.last_try.at).toISOString())!, result: c.last_try.result } : null, from: c.from ?? null, window: c.window ?? null, events: (opts.keep ? events(c).filter(opts.keep) : events(c)).slice(0, limit) };
  return { tickers: data, pending, unknown };
}

/**
 * Scheduled: keeps every owned and watched name's insider and 13D/G events current, so the Friday
 * email, My book and /v1 never depend on someone having opened the stock. Refreshes the stalest names
 * (KV issuers:checked) older than an hour (10 minutes in filing week), with the SEC requests the minute left.
 */
export async function precomputeIssuers(env: Env, now: number, season: boolean, budget: number): Promise<Record<string, unknown>> {
  const list = JSON.parse((await env.DB.get('issuers:tickers')) ?? '[]') as string[];
  const checked = JSON.parse((await env.DB.get('issuers:checked')) ?? '{}') as Record<string, number>;
  const ttl = season ? 10 * 60_000 : 60 * 60_000;
  const due = list.filter((t) => now - (checked[t] ?? 0) > ttl).sort((a, b) => (checked[a] ?? 0) - (checked[b] ?? 0));
  if (!due.length || budget < 4) return { names: list.length, due: due.length };
  const batch = due.slice(0, 6);
  const r = await stockEvents(env, batch, 1, { budget, freshMs: ttl });
  for (const t of batch) {
    const at = r.tickers[t]?.checked_at;
    if (at) checked[t] = Date.parse(at);
    else if (r.unknown.includes(t)) checked[t] = now; // no SEC CIK: nothing to read
  }
  for (const t of Object.keys(checked)) if (!list.includes(t)) delete checked[t];
  await env.DB.put('issuers:checked', JSON.stringify(checked));
  return { names: list.length, due: due.length, refreshed: batch.filter((t) => !r.pending.includes(t)).length, pending: r.pending.length };
}
