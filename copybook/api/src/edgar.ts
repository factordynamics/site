/**
 * Reading 13F filings straight from EDGAR, so a filing can be emailed with its moves within
 * minutes instead of waiting for the next data run. Everything here comes from SEC filings.
 */

export const SEC_UA = 'Copybook copybook@factordynamics.com';
/**
 * SEC requests left in this invocation. The free plan allows 50 subrequests per run; the cron sets
 * a budget below that (leaving room for the mailer and GitHub), and optional work stops when it's spent.
 */
export const secBudget = { left: Infinity };
const sec = (url: string) => {
  if (secBudget.left <= 0) return Promise.reject(new Error('subrequest budget spent'));
  secBudget.left--;
  // A hung EDGAR connection never holds a request or the minute cron: 15 s, then it counts as a failed read.
  return fetch(url, { headers: { 'user-agent': SEC_UA, accept: '*/*' }, signal: AbortSignal.timeout(15_000) });
};

/** Biggest infotable we parse in the Worker; bigger books wait for the data run's moves. */
const MAX_TABLE_BYTES = 400_000;
const MOVE_ROWS = 5;

export interface FeedEntry {
  form: string;
  cik: string; // 10 digits
  accession: string;
  accepted: string; // ISO time EDGAR accepted the filing
  /** The CIK's role in a getcurrent entry: Filer, Reporting, Issuer, Filed by, Subject. */
  role?: string;
}

/** EDGAR's "latest filings" Atom feed for one form type (prefix match, so 13F-HR also lists 13F-HR/A), 100 per page. */
export async function latestFilings(type: string, start = 0): Promise<FeedEntry[]> {
  const res = await sec(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(type)}&company=&dateb=&owner=include&start=${start}&count=100&output=atom`);
  if (!res.ok) throw new Error(`edgar feed ${type}@${start}: ${res.status}`);
  return parseFeed(await res.text());
}

/** One filer's latest filings of a type, from its EDGAR company feed (a few KB). */
export async function companyFilings(cik: string, type: string, count = 3, start = 0): Promise<FeedEntry[]> {
  const res = await sec(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(type)}&dateb=&owner=include&count=${count}${start ? `&start=${start}` : ''}&output=atom`);
  if (!res.ok) throw new Error(`edgar company ${cik}: ${res.status}`);
  return parseFeed(await res.text(), cik);
}

/** Entries of a getcurrent feed, or of a company feed when `cik` is given (its titles carry no CIK). */
export function parseFeed(xml: string, cik?: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const e of xml.split('<entry>').slice(1)) {
    const form = e.match(/term="([^"]+)"/)?.[1];
    const t = e.match(/<title>[^<]*\((\d{10})\)\s*\(([^)]+)\)/);
    const filer = cik ?? t?.[1] ?? e.match(/<title>[^<]*\((\d{10})\)/)?.[1];
    const accession = e.match(/accession-number=(\d{10}-\d{2}-\d{6})/)?.[1];
    const accepted = e.match(/<updated>([^<]+)<\/updated>/)?.[1];
    if (form && filer && accession && accepted) out.push({ form, cik: filer, accession, accepted: new Date(accepted).toISOString(), ...(t?.[2] ? { role: t[2] } : {}) });
  }
  return out;
}

export interface Position {
  cusip: string;
  put_call: string | null;
  issuer: string;
  title?: string;
  shares: number;
  value: number;
  ticker?: string | null;
  display_name?: string | null;
  /** Principal amount (notes), not shares. */
  prn?: boolean;
}

/**
 * A book whose numbers can't be trusted, the rule Holdterm's data proxy uses: the information table's total
 * is more than 1.5x the cover page's tableValueTotal or less than it / 1.5 (Wilkinson Global's merged in
 * Fiera's whole 13F), or notes (PRN) are over 25% of it.
 */
export function bookSuspect(holdings: Position[], coverTotal: number | null): boolean {
  const total = holdings.reduce((s, h) => s + h.value, 0);
  if (!total) return false;
  if (coverTotal && (total > 1.5 * coverTotal || total < coverTotal / 1.5)) return true;
  return holdings.filter((h) => h.prn).reduce((s, h) => s + h.value, 0) > 0.25 * total;
}

export interface MoveRow {
  change?: string;
  ticker: string | null;
  display_name: string | null;
  issuer: string;
  cusip: string;
  put_call: string | null;
  shares: number;
  prev_shares: number;
  value: number;
  value_delta: number;
  /** A bond (PRN) line: shares and prev_shares are principal. */
  prn?: boolean;
  /** Held 24 hours because the filer's own value per share looks wrong (units, price vs filers), then sent as filed. */
  filer_value?: boolean;
  /** The trade as a signed fraction of this filing's book (0-1). */
  delta_pct_of_book: number | null;
  /** Older data-run rows used this name for the trade size. */
  pct_of_book?: number | null;
  /** The prior quarter's value, when known (guards the size). */
  prev_value?: number | null;
  /** A stock split between the two quarters: prev_shares is multiplied by it; prev_shares_as_filed keeps the filed count. */
  split?: number;
  prev_shares_as_filed?: number;
  /** Ingest's flag for a unit mismatch between quarters. */
  suspect_units?: boolean;
  /** A real but unusually large move: shown with "Unusual size · check the filing". */
  unusual?: boolean;
}

export interface Moves {
  bought_usd: number;
  sold_usd: number;
  new: MoveRow[];
  exited: MoveRow[];
  added: MoveRow[];
  trimmed: MoveRow[];
  /** Held reissues (a CUSIP exchanged, units not 1:1): one line each, no dollar move, outside bought, sold and net. */
  exchanged?: MoveRow[];
}

const TAGS = new Map<string, RegExp>();
export const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function tag(block: string, name: string): string {
  let re = TAGS.get(name);
  if (!re) TAGS.set(name, (re = new RegExp(`<(?:\\w+:)?${name}>([^<]*)<`)));
  return (block.match(re)?.[1]?.trim() ?? '').replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]);
}

const FIELD = /<(?:\w+:)?(nameOfIssuer|titleOfClass|cusip|value|sshPrnamt|sshPrnamtType|putCall)>([^<]*)</g;
const unescape = (v: string) => v.trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]);

/** Info-table rows summed per (CUSIP, put/call), the same key the data run uses. One regex pass. */
export function parseInfoTable(xml: string): Position[] {
  const by = new Map<string, Position>();
  let row: Record<string, string> | null = null;
  const flush = () => {
    if (!row?.cusip) return;
    const cusip = row.cusip.toUpperCase();
    const pc = row.putCall;
    const put_call = pc ? pc[0].toUpperCase() + pc.slice(1).toLowerCase() : null;
    const k = `${cusip}|${put_call ?? ''}`;
    const p = by.get(k) ?? { cusip, put_call, issuer: unescape(row.nameOfIssuer ?? ''), title: unescape(row.titleOfClass ?? ''), shares: 0, value: 0 };
    p.shares += Number(row.sshPrnamt) || 0;
    p.value += Number(row.value) || 0;
    if (row.sshPrnamtType?.toUpperCase() === 'PRN') p.prn = true;
    by.set(k, p);
  };
  for (const m of xml.matchAll(FIELD)) {
    // nameOfIssuer opens every infoTable entry.
    if (m[1] === 'nameOfIssuer') {
      flush();
      row = {};
    }
    if (row) row[m[1]] = m[2].trim();
  }
  flush();
  return [...by.values()];
}

export interface Filing13F {
  report_date: string; // YYYY-MM-DD
  holdings: Position[] | null; // null when the table is too big to parse here
  /** The cover page's tableValueTotal. */
  cover_total?: number | null;
}

/** The period and, for books small enough to parse in the Worker, the holdings of one 13F-HR. */
export async function fetch13F(cik: string, accession: string, maxBytes = MAX_TABLE_BYTES): Promise<Filing13F | null> {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/`;
  const dir = await sec(`${base}index.json`);
  if (!dir.ok) return null;
  const items = ((await dir.json()) as { directory?: { item?: { name: string; size: string }[] } }).directory?.item ?? [];
  const primary = await sec(`${base}primary_doc.xml`);
  if (!primary.ok) return null;
  const cover = await primary.text();
  const period = tag(cover, 'periodOfReport').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!period) return null;
  const report_date = `${period[3]}-${period[1]}-${period[2]}`;
  const cover_total = Number(tag(cover, 'tableValueTotal')) || null;
  const table = items.find((i) => i.name.toLowerCase().endsWith('.xml') && i.name !== 'primary_doc.xml');
  if (!table || Number(table.size) > maxBytes) return { report_date, holdings: null, cover_total };
  const res = await sec(`${base}${table.name}`);
  return { report_date, holdings: res.ok ? parseInfoTable(await res.text()) : null, cover_total };
}

/** One 13F-HR or 13F-HR/A a CIK filed. */
export interface Filed13F {
  accession: string;
  form: string;
  report_date: string;
}

/** Every 13F-HR and 13F-HR/A among a CIK's recent EDGAR filings (submissions JSON, up to its latest 1,000 filings). */
export async function filings13F(cik: string): Promise<Filed13F[] | null> {
  const res = await sec(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`);
  if (!res.ok) return null;
  const r = ((await res.json()) as { filings?: { recent?: { accessionNumber: string[]; form: string[]; reportDate: string[] } } }).filings?.recent;
  if (!r) return null;
  const out: Filed13F[] = [];
  r.form.forEach((form, i) => {
    if (form === '13F-HR' || form === '13F-HR/A') out.push({ accession: r.accessionNumber[i], form, report_date: r.reportDate[i] });
  });
  return out;
}

/** The quarter-end before a report date (2026-09-30 -> 2026-06-30). */
export function prevQuarterEnd(reportDate: string): string {
  const [y, m] = reportDate.split('-').map(Number);
  const q = Math.ceil(m / 3) - 1;
  return q === 0 ? `${y - 1}-12-31` : `${y}-${['03-31', '06-30', '09-30'][q - 1]}`;
}

/** A filer's book for the quarter before `reportDate`, from its original 13F-HR on EDGAR (any size). */
export async function prior13F(cik: string, reportDate: string): Promise<Position[] | null> {
  const want = prevQuarterEnd(reportDate);
  const prev = (await filings13F(cik))?.find((f) => f.form === '13F-HR' && f.report_date === want);
  return prev ? ((await fetch13F(cik, prev.accession, Infinity))?.holdings ?? null) : null;
}

export function quarterOf(reportDate: string): string {
  const [y, m] = reportDate.split('-').map(Number);
  return `${y}Q${Math.ceil(m / 3)}`;
}

/** Value per share of the same CUSIP across other filers, by quarter (median of at least 3), this quarter's and the prior one. */
export type PerShare = { cur?: number | null; prev?: number | null };

/**
 * Whether a 13F move can be shown, for every email, chat post, webhook and the weekly:
 * - `drop`: a unit error, never shown. Ingest flags it `suspect_units`; or the value per share moved 100x
 *   or more against the prior quarter with no split on file (real unit errors are ~1000x); or either
 *   quarter's value per share is 5x or more off the median of other filers for that CUSIP and quarter
 *   (GuardCap's Q3 BKNG: ~$5,120 a share when every other filer reports ~$162 after the 25-for-1 split).
 * - `unusual`: sent with an "Unusual size · check the filing" tag. A value per share 5-100x off the prior
 *   quarter that other filers don't contradict (a real 5x rally or 80% fall); a $ change over half the
 *   larger of the prior and current books (Scion's SPY puts); or a share-count break, over 1.5x the larger
 *   of the two positions, whose size becomes the change in reported value (value - prev_value).
 * - `ok` otherwise. `value_delta` is the size to show.
 */
export function checkMove(
  r: { value_delta: number; value?: number | null; prev_value?: number | null; shares?: number | null; prev_shares?: number | null; suspect_units?: boolean },
  book: number | null,
  split = false,
  median: PerShare = {},
): { verdict: 'ok' | 'unusual' | 'drop'; value_delta: number } {
  if (r.suspect_units) return { verdict: 'drop', value_delta: r.value_delta };
  const { value, prev_value, shares, prev_shares } = r;
  const ps = value && shares && value > 0 && shares > 0 ? value / shares : null;
  const pps = prev_value && prev_shares && prev_value > 0 && prev_shares > 0 ? prev_value / prev_shares : null;
  const off = (x: number | null, m: number | null | undefined, k: number) => !!x && !!m && (x / m >= k || m / x >= k);
  if (off(ps, median.cur, 5) || off(pps, median.prev, 5)) return { verdict: 'drop', value_delta: r.value_delta };
  let unusual = false;
  if (!split && ps && pps) {
    if (off(ps, pps, 100)) return { verdict: 'drop', value_delta: r.value_delta };
    if (off(ps, pps, 5)) unusual = true;
  }
  let d = r.value_delta;
  if (prev_value != null && value != null && Math.abs(d) > 1.5 * Math.max(value, prev_value)) {
    d = Math.round(value - prev_value);
    unusual = true;
  }
  if (book && Math.abs(d) > 0.5 * book) unusual = true;
  return { verdict: unusual ? 'unusual' : 'ok', value_delta: d };
}

/** CUSIPs held in both books whose value per share moved 5x or more: the rows worth a cross-filer check. */
export function perShareSuspects(cur: Position[], prev: Position[]): string[] {
  const before = new Map(prev.filter((p) => !p.put_call && p.shares > 0 && p.value > 0).map((p) => [p.cusip, p.value / p.shares]));
  return [...new Set(cur.filter((c) => !c.put_call && c.shares > 0 && c.value > 0 && before.has(c.cusip)).filter((c) => {
    const x = c.value / c.shares / before.get(c.cusip)!;
    return x >= 5 || x <= 1 / 5;
  }).map((c) => c.cusip))];
}

/** The tag a large but real move carries in emails, chat posts and the weekly. */
export const UNUSUAL = 'Unusual size · check the filing';
export const FILER_VALUE = "Filer's reported value looks wrong; shown as filed";

/** Applies checkMove to rows: drops unit errors, tags and resizes the rest (`unusual: true`). */
export function guardRows<T extends MoveRow>(rows: T[], book: number | null, prevValue: (r: T) => number | null | undefined, splits?: Set<string> | Map<string, number>, medians?: Map<string, PerShare>): T[] {
  const out: T[] = [];
  for (const r of rows) {
    const c = checkMove({ ...r, prev_value: prevValue(r) ?? r.prev_value ?? null }, book, !!splits && (splits.has(r.cusip) || (!!r.ticker && splits.has(r.ticker))), r.put_call ? {} : (medians?.get(r.cusip) ?? {}));
    if (c.verdict === 'drop') continue;
    out.push(c.verdict === 'unusual' ? { ...r, value_delta: c.value_delta, ...(c.value_delta !== r.value_delta && book ? { delta_pct_of_book: c.value_delta / book } : {}), unusual: true } : r);
  }
  return out;
}

/** All-caps filer names ("GUARDCAP ASSET MANAGEMENT Ltd") as "Guardcap Asset Management Ltd"; short acronyms (AQR, LLC) stay. */
export function displayCase(name: string): string {
  if ((name.match(/\b[A-Z]{4,}\b/g) ?? []).length < 1 || /[a-z]{3,}/.test(name.replace(/\b(Ltd|Inc|Co|Corp|Llc|Plc)\b\.?/g, ''))) return name;
  return name.replace(/\b([A-Z])([A-Z&']{3,})\b/g, (_, a: string, b: string) => a + b.toLowerCase()).replace(/\b(Of|And|The|For)\b/g, (w, _x, i: number) => (i ? w.toLowerCase() : w));
}

/**
 * New, exited, added and trimmed positions against the prior quarter, sized by the trade at this
 * filing's own value per share (a price move alone is no trade), as the data run computes them.
 */
/**
 * CUSIPs reissued for the same security, share for share (old -> new). Exxon's Q3 2026 holding-company
 * reorganisation: 30231G102 -> 30233Q108. Without the link every Q3 holder reads as "exited XOM" plus a new position.
 */
/** 2026Q3's, as ingest links them (data/cusip_links.json from Nov 11). */
/** ratio: new shares per old share where the link is also a split (DD 1-for-3: 1/3); the prior's shares are scaled. */
/** quarter: the first quarter filed under the new CUSIP. */
export const REISSUED: Record<string, { to: string; ticker: string; ratio?: number; quarter?: string }> = {
  '30231G102': { to: '30233Q108', ticker: 'XOM', quarter: '2026Q3' },
  '682680103': { to: '30609A109', ticker: 'OKE', quarter: '2026Q3' },
  '26614N102': { to: '26614N201', ticker: 'DD', ratio: 1 / 3, quarter: '2026Q2' },
  '04351P101': { to: 'K08588103', ticker: 'ASND', quarter: '2026Q2' }, // ADS to ordinary
  '881624209': { to: 'M8769Q102', ticker: 'TEVA', quarter: '2026Q3' }, // ADR to ordinary
  '811916105': { to: '811927102', ticker: 'SA', quarter: '2026Q2' },
};
/**
 * SEC-confirmed reissues whose units aren't confirmed yet (ingest's `held`): never linked share for share. HON is a
 * 1-for-2 reverse split done the day of the HONA spin-off (8-K 0000773840-26-000084, Ex. 99.1): it links at 0.5 once
 * ingest's file gives it ratio 0.5 with units_basis split_confirmed. NVRI 0.333x, unconfirmed. Until linked, a filer that
 * leaves the old CUSIP for the new one in the same quarter gets one "CUSIP exchanged" line, no trade.
 */
export const HELD: Record<string, { to: string; ticker: string }> = {
  '438516106': { to: '438516205', ticker: 'HON' },
  '415864107': { to: '29390K102', ticker: 'NVRI' },
};
/** The hand-coded lists: every load of ingest's file starts again from these, so a link the file drops is dropped here. */
const BASE = { reissued: JSON.stringify(REISSUED), held: JSON.stringify(HELD) };
/** A linked CUSIP's ratio (new shares per old share; 1 when one-for-one or not linked), by either side. */
export const reissueRatio = (cusip?: string | null): number => {
  const c = (cusip ?? '').toUpperCase();
  return REISSUED[c]?.ratio ?? Object.values(REISSUED).find((x) => x.to === c)?.ratio ?? 1;
};
/**
 * Old issuer code -> current one, where a reissue changed the 6-character issuer (XOM 30231G -> 30233Q, TEVA 881624 ->
 * M8769Q); HON's and DD's kept theirs. Only these SEC-confirmed links: never units, rights or warrants.
 */
export const REISSUED_ISSUER: Record<string, string> = {};
const REISSUED_TO = new Map<string, string>();
function indexReissued(): void {
  REISSUED_TO.clear();
  for (const k of Object.keys(REISSUED_ISSUER)) delete REISSUED_ISSUER[k];
  for (const [o, r] of Object.entries(REISSUED)) {
    REISSUED_TO.set(r.to, r.ticker);
    if (o.slice(0, 6) !== r.to.slice(0, 6)) REISSUED_ISSUER[o.slice(0, 6)] = r.to.slice(0, 6);
  }
}
indexReissued();
let reissuesAt = 0;
/**
 * Ingest's reissue links (data/cusip_links.json), read hourly (5 minutes after a failed read). Each good read rebuilds
 * the maps from the hand-coded lists plus the file, so a link the file drops is dropped: a link applies only with the
 * SEC's 13(f) List basis and ingest's units result (ratio and units_basis), and a pair in `held` never links. The maps
 * are swapped in only after the whole file is read; a missing, unreadable or malformed file leaves them as they were.
 */
export async function loadReissues(env: { DATA_URL: string }, now = Date.now()): Promise<number> {
  if (now < reissuesAt) return Object.keys(REISSUED).length;
  // A failed read retries in 5 minutes; a good one holds for the hour.
  reissuesAt = now + 300_000;
  try {
    const res = await fetch(`${env.DATA_URL}cusip_links.json`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      type Link = { old?: string; new?: string; ticker?: string; basis?: string; ratio?: number | null; units_basis?: string | null; units_check?: { split_ratio?: number | null } };
      const file = (await res.json()) as { links?: Record<string, Link>; held?: Link[] | Record<string, Link> };
      const ok = (from: string, to: string) => /^[0-9A-Z]{8}[0-9]$/.test(from) && /^[0-9A-Z]{8}[0-9]$/.test(to);
      // Held pairs (an array from Nov 11 12:2x, a map before): ingest's word overrides a hand-coded link, never a 1:1
      // merge of mismatched or unchecked units.
      const heldList = (Array.isArray(file.held) ? file.held : Object.entries(file.held ?? {}).map(([o, v]) => (v && typeof v === 'object' ? { ...v, old: o } : null))).filter((l): l is Link => !!l && typeof l === 'object');
      // Built apart and swapped in only once the whole file has been read: a bad entry never leaves the maps half-built.
      const nextR = JSON.parse(BASE.reissued) as typeof REISSUED;
      const nextH = JSON.parse(BASE.held) as typeof HELD;
      for (const l of heldList) {
        const from = String(l.old ?? '').toUpperCase(), to = String(l.new ?? '').toUpperCase();
        if (!ok(from, to)) continue;
        delete nextR[from];
        nextH[from] = { to, ticker: String(l.ticker ?? nextH[from]?.ticker ?? '').toUpperCase() };
      }
      for (const [old, l] of Object.entries(file.links ?? {})) {
        if (!l || typeof l !== 'object') continue;
        const from = old.toUpperCase(), to = String(l.new ?? '').toUpperCase();
        // Only with ingest's units result, ratio and units_basis both: a COM -> COM NEW link without one may be a reverse
        // split, which netted 1:1 reads as a huge trim (ONCY, BARK, UPLD...). A units_basis alone never means 1:1. ratio
        // multiplies the prior's shares (HON 0.5, NVRI 1/3, RBKB 1.3978).
        const k = l.ratio == null ? NaN : Number(l.ratio);
        if (l.basis !== 'sec_13f_list' || !ok(from, to) || !l.ticker || !(k > 0) || !l.units_basis || heldList.some((h) => String(h.old ?? '').toUpperCase() === from)) continue;
        delete nextH[from];
        const lq = typeof (l as { quarter?: string }).quarter === 'string' && /^\d{4}Q[1-4]$/.test((l as { quarter: string }).quarter) ? (l as { quarter: string }).quarter : nextR[from]?.quarter;
        nextR[from] = { to, ticker: String(l.ticker).toUpperCase(), ...(Math.abs(k - 1) > 1e-6 ? { ratio: k } : {}), ...(lq ? { quarter: lq } : {}) };
      }
      for (const k of Object.keys(REISSUED)) delete REISSUED[k];
      for (const k of Object.keys(HELD)) delete HELD[k];
      Object.assign(REISSUED, nextR);
      Object.assign(HELD, nextH);
      indexReissued();
      reissuesAt = now + 3600_000;
    }
  } catch {
    // keep the known links
  }
  return Object.keys(REISSUED).length;
}
/** Both CUSIPs of every known reissue (old and new). */
export const isReissued = (cusip?: string | null): boolean => !!cusip && (!!REISSUED[cusip.toUpperCase()] || REISSUED_TO.has(cusip.toUpperCase()) || !!HELD[cusip.toUpperCase()] || Object.values(HELD).some((h) => h.to === cusip.toUpperCase()));
/** The ticker of a reissued CUSIP, old or new: rows without a ticker yet still net (stored moves, the site's cards). */
export const reissuedTicker = (cusip?: string | null): string | null => (cusip ? (REISSUED[cusip.toUpperCase()]?.ticker ?? REISSUED_TO.get(cusip.toUpperCase()) ?? null) : null);
/**
 * The prior book with reissued CUSIPs renamed to the new one, when this filing holds the new CUSIP and not the old,
 * so the diff, the price gate and alerts see one continuing position (no ticker lookup needed). Else unchanged.
 */
export function linkReissued<T extends { cusip: string }>(prev: T[], cur: { cusip: string }[]): T[] {
  const now = new Set(cur.map((c) => c.cusip.toUpperCase()));
  const to = (p: T) => {
    const n = REISSUED[p.cusip.toUpperCase()]?.to;
    return n && now.has(n) && !now.has(p.cusip.toUpperCase()) ? n : null;
  };
  // A link that is also a split carries the prior in today's units (DD: 3 old shares are 1 new).
  const k = (p: T) => REISSUED[p.cusip.toUpperCase()]?.ratio ?? 1;
  const sh = (p: T) => (k(p) === 1 ? {} : { shares: Math.round(Number((p as { shares?: number }).shares ?? 0) * k(p)) });
  return prev.some(to) ? prev.map((p) => (to(p) ? { ...p, ...sh(p), cusip: to(p)! } : p)) : prev;
}

export function computeMoves(cur: Position[], prev: Position[], limit = MOVE_ROWS, splits?: Set<string> | Map<string, number>, medians?: Map<string, PerShare>): { moves: Moves; changed: MoveRow[] } {
  prev = linkReissued(prev, cur);
  const prevTotal = prev.reduce((s, p) => s + p.value, 0);
  let total = cur.reduce((s, p) => s + p.value, 0);
  // A filer that reports in thousands by mistake: scale to dollars like the data run's unit fix.
  const scale = total > 0 && total * 200 < prevTotal ? 1000 : 1;
  total *= scale;
  // Trade sizes are measured against the larger of the two books (an exit from a book that shrank).
  const book = Math.max(total, prevTotal);
  // One key across EDGAR's table ("Call") and ingest's books ("CALL"); a bond's count is its principal, which ingest's
  // books keep in principal_amount with shares 0 (Advent's Q3 bonds read as bought from zero).
  prev = prev.map((p) => (p.shares ? p : { ...p, shares: Number((p as { principal_amount?: number }).principal_amount) || 0 }));
  const before = new Map(prev.map((p) => [posKey(p), p]));
  // Held reissues: the old CUSIP gone and the new one held is an exchange, kept out of the trades.
  const curCusips = new Set(cur.map((c) => c.cusip.toUpperCase()));
  const exch = new Map<string, Position>();
  for (const p of prev) {
    const h = HELD[p.cusip.toUpperCase()];
    if (h && curCusips.has(h.to) && !curCusips.has(p.cusip.toUpperCase())) {
      exch.set(posKey({ ...p, cusip: h.to }), p);
      before.delete(posKey(p));
    }
  }
  const exchanged: MoveRow[] = [];
  const rows: MoveRow[] = [];
  // A split on file (the data run's splits.json, by CUSIP): the prior shares in today's units, as the data run does.
  // Only when the prior is still on the pre-split basis: its value per share sits nearer the ratio than 1 times today's
  // (a filer that already reported post-split shares, like Amundi's Q2 CRWD, gets no factor). An exit has no price to
  // compare, so it takes the factor.
  const ratio = (p: Position, cur?: { shares: number; value: number }) => {
    const k = splits instanceof Map ? (splits.get(p.cusip) ?? 1) : 1;
    if (k === 1 || !cur) return k;
    const rel = p.shares && cur.shares && cur.value ? p.value / p.shares / (cur.value / cur.shares) : 0;
    return rel && (k > 1 ? rel >= Math.sqrt(k) : rel <= Math.sqrt(k)) ? k : 1;
  };
  const adj = (p: Position, k: number) => (k === 1 ? {} : { split: k, prev_shares_as_filed: p.shares });
  const row = (p: Position, change: string, shares: number, prev_shares: number, value: number, delta: number, extra = {}) => ({
    change,
    ticker: p.ticker ?? null,
    display_name: p.display_name ?? null,
    issuer: p.issuer,
    cusip: p.cusip,
    put_call: p.put_call,
    shares,
    prev_shares,
    value,
    value_delta: Math.round(delta),
    delta_pct_of_book: book ? delta / book : null,
    // A bond line (principal, not shares): the gate doesn't compare its value per unit with share prices.
    ...((p as { prn?: boolean }).prn || (p as { shares_type?: string }).shares_type === 'PRN' ? { prn: true } : {}),
    ...extra,
  });
  for (const c of cur) {
    const value = c.value * scale;
    const k = posKey(c);
    const p = before.get(k);
    before.delete(k);
    const named = { ...c, ticker: p?.ticker ?? c.ticker, display_name: p?.display_name ?? c.display_name };
    const ex = exch.get(k);
    if (ex) {
      const r = row({ ...c, ticker: c.ticker ?? ex.ticker ?? HELD[ex.cusip.toUpperCase()]?.ticker ?? null, display_name: c.display_name ?? ex.display_name }, 'exchanged', c.shares, ex.shares, value, 0, { prev_cusip: ex.cusip });
      exchanged.push({ ...r, delta_pct_of_book: 0 });
      continue;
    }
    if (!p) {
      rows.push(row(named, 'new', c.shares, 0, value, value));
      continue;
    }
    const f = ratio(p, { shares: c.shares, value });
    const ps = Math.round(p.shares * f);
    if (c.shares !== ps) rows.push(row(named, c.shares > ps ? 'added' : 'trimmed', c.shares, ps, value, c.shares ? ((c.shares - ps) * value) / c.shares : 0, adj(p, f)));
  }
  for (const p of before.values()) rows.push(row(p, 'exited', 0, Math.round(p.shares * ratio(p)), 0, -p.value, adj(p, ratio(p))));
  // Unit errors are left out; unusually large moves are tagged. The larger book is the yardstick.
  const prior = new Map(prev.map((p) => [posKey(p), p.value]));
  rows.splice(0, rows.length, ...guardRows(rows, book, (r) => prior.get(posKey(r)), splits, medians), ...exchanged);
  return { moves: movesOf(rows, limit), changed: rows };
}

/** An alert's ID in delivery logs, feeds and chats: the first email, its moves follow-up, or its checked rows. */
export const filingId = (a: { accession: string; followup?: boolean; checked?: boolean }) => `${a.accession}${a.checked ? ':checked' : a.followup ? ':moves' : ''}`;

/** Ingest's cross-filer rule (copybook/ingest/build.py OFF_MEDIAN): a line priced over 3x off the CUSIP's median is mis-scaled. */
export const OFF_MEDIAN = 3;
/** Other filers' median value per share for one CUSIP (ingest's consensus.json): this quarter and the one before. */
export interface Consensus {
  cur?: number | null;
  prev?: number | null;
}
/** A move row the publish gate held back: named in the alert as "pending check", its figures left out. */
export interface HeldRow {
  cusip: string;
  ticker: string | null;
  issuer: string;
  display_name: string | null;
  put_call: string | null;
  change?: string;
  reason: 'units' | 'price_vs_filers' | 'split_basis' | 'own_prior';
}

/** A position's key across EDGAR tables and ingest's books: CUSIP and put/call, case-blind. */
export const posKey = (p: { cusip: string; put_call?: string | null }) => `${p.cusip.toUpperCase()}|${(p.put_call ?? '').toUpperCase()}`;
/** Filers report the same quarter-end price, so they agree to rounding: a line over 1.25x off the median is held. */
export const OFF_FILERS = 1.25;
/** A unit error (thousands read as dollars) is about 1000x: 100x off is held whatever else is known. */
export const OFF_UNITS = 100;
/** Lines under this value skip the cross-filer price check (a few shares' value rounds coarsely). */
const MIN_PRICE_CHECK_USD = 50_000;

/**
 * The after-send check's cross-filer test on a row as emailed: its value per share over 1.25x off the median other
 * filers report this quarter (stock lines of $50K or more). The figure is as filed; true means the filer's looks wrong.
 */
export function offFilers(r: MoveRow, c?: Consensus): boolean {
  if (r.put_call || r.prn || !c?.cur || r.shares <= 0 || r.value < MIN_PRICE_CHECK_USD) return false;
  const ps = r.value / r.shares;
  return ps / c.cur > OFF_FILERS || c.cur / ps > OFF_FILERS;
}

/**
 * The publish gate for one move row, before it is sent: null when it passes, else why it is held.
 * - units: this line's or the prior line's value per share is 100x or more off other filers' median or its own prior.
 * - price_vs_filers: over 1.25x off other filers' median value per share for that CUSIP and quarter (ingest's
 *   consensus.json); the prior line may sit on either side of a split on file.
 * - split_basis: a split is on file (splits.json) and the row's prior shares aren't in today's units.
 * - own_prior: a split not on file yet. The filer's own value per share moved by about an integer k >= 2 and its
 *   share count by at least k/1.5 the other way (Jensen's APH: $176.32 to $84.30 a share, 614,660 to 1,047,486 sh).
 * Options are not checked (their value is the underlying's).
 */
export function gateRow(r: MoveRow, prior: { shares: number; value: number } | undefined, k: number, c: Consensus = {}): HeldRow['reason'] | null {
  if (r.put_call) return null;
  const off = (x: number, m: number, lim: number) => x / m > lim || m / x > lim;
  const ps = r.shares > 0 && r.value > 0 ? r.value / r.shares : null;
  const pps = prior && prior.shares > 0 && prior.value > 0 ? prior.value / prior.shares : null;
  // The factor the prior's shares were taken at (1, or the split ratio once applied).
  const f = pps && r.prev_shares > 0 ? r.prev_shares / prior!.shares : 1;
  // Bonds: value per $ of principal, not a share price; only a 100x jump against its own prior is held.
  if (r.prn) return ps && pps && off(pps / f, ps, OFF_UNITS) ? 'units' : null;
  if ((ps && c.cur && off(ps, c.cur, OFF_UNITS)) || (pps && c.prev && [1, k].every((s) => off(pps, c.prev! / s, OFF_UNITS))) || (ps && pps && off(pps / f, ps, OFF_UNITS))) return 'units';
  if (r.value >= MIN_PRICE_CHECK_USD || (prior?.value ?? 0) >= MIN_PRICE_CHECK_USD) {
    if (ps && c.cur && off(ps, c.cur, OFF_FILERS)) return 'price_vs_filers';
    if (pps && c.prev && [1, k].every((s) => off(pps, c.prev! / s, OFF_FILERS))) return 'price_vs_filers';
  }
  if (!pps) return null;
  const near = (x: number, m: number) => Math.abs(Math.log(x / m));
  const ref = c.prev ? [c.prev, c.prev / k] : ps ? [ps * k, ps] : null;
  const g = k !== 1 && ref && near(pps, ref[0]) <= near(pps, ref[1]) ? k : 1;
  if (k !== 1 && ref && Math.abs(r.prev_shares - prior!.shares * g) > 0.005 * prior!.shares * g) return 'split_basis';
  if (ps && r.shares > 0 && r.prev_shares > 0) {
    // A split nobody listed: the price fell by about k and the share count rose by about k (or the reverse). Both
    // ratios must sit near k: a 50% fall that a fund bought into 4x (Davis's APP) is a real trade, not a split.
    const p = pps / f / ps;
    const up = p >= 1;
    const pr = up ? p : 1 / p;
    const kk = Math.round(pr);
    const sr = up ? r.shares / r.prev_shares : r.prev_shares / r.shares;
    const dp = Math.abs(Math.log(pr / kk));
    const big = r.value >= MIN_PRICE_CHECK_USD || (prior?.value ?? 0) >= MIN_PRICE_CHECK_USD;
    if (big && kk >= 2 && dp <= Math.log(1.15) && dp + Math.abs(Math.log(sr / kk)) <= Math.log(1.25)) return 'own_prior';
  }
  return null;
}

/** computeMoves' result through the publish gate: rows that fail it leave the moves and totals and come back as `held`. */
export function gateMoves(r: { moves: Moves; changed: MoveRow[] }, prev: Position[], splits: Map<string, number>, consensus: Map<string, Consensus>, limit = MOVE_ROWS): { moves: Moves; changed: MoveRow[]; held: HeldRow[] } {
  prev = linkReissued(prev.map((p) => (p.shares ? p : { ...p, shares: Number((p as { principal_amount?: number }).principal_amount) || 0 })), r.changed.filter((x) => x.change !== 'exited'));
  const before = new Map(prev.map((p) => [posKey(p), p]));
  const held: HeldRow[] = [];
  const changed = r.changed.filter((x) => {
    const reason = gateRow(x, before.get(posKey(x)), splits.get(x.cusip) ?? 1, consensus.get(x.cusip));
    if (reason) held.push({ cusip: x.cusip, ticker: x.ticker, issuer: x.issuer, display_name: x.display_name, put_call: x.put_call, change: x.change, reason });
    return !reason;
  });
  return held.length ? { moves: movesOf(changed, limit), changed, held } : { ...r, held };
}

export function movesOf(rows: MoveRow[], limit = MOVE_ROWS): Moves {
  const top = (c: string) =>
    rows
      .filter((r) => r.change === c)
      .sort((a, b) => Math.abs(b.value_delta) - Math.abs(a.value_delta))
      .slice(0, limit);
  return {
    bought_usd: rows.reduce((s, r) => s + Math.max(r.value_delta, 0), 0),
    sold_usd: rows.reduce((s, r) => s - Math.min(r.value_delta, 0), 0),
    new: top('new'),
    exited: top('exited'),
    added: top('added'),
    trimmed: top('trimmed'),
    ...(rows.some((r) => r.change === 'exchanged') ? { exchanged: rows.filter((r) => r.change === 'exchanged') } : {}),
  };
}
/** "HON: CUSIP exchanged (438516106 → 438516205), not a trade" */
export const exchangeLine = (r: MoveRow) => `${r.ticker || r.display_name || r.issuer || r.cusip}${r.put_call ? ` ${r.put_call.toLowerCase()}s` : ''}: CUSIP exchanged (${(r as { prev_cusip?: string }).prev_cusip} → ${r.cusip}), not a trade`;

/**
 * A security whose CUSIP changed (Exxon's Q3 holding-company reorganisation: 30231G102 -> 30233Q108) shows as an exit
 * of the old CUSIP and a new position in the new one. Netted by ticker that is the change in reported value (Fisher's
 * XOM: +$5,197.2M - $4,302.3M = +$894.9M, mostly price). Once tickers are known, the pair becomes one add or trim
 * sized by shares at this filing's price (+465,409 sh x $162.75 = +$75.7M), or nothing when the shares are the same.
 */
export function netRenamed(r: { moves: Moves; changed: MoveRow[] }, limit = MOVE_ROWS): { moves: Moves; changed: MoveRow[] } {
  const key = (x: MoveRow) => {
    // A held pair's two lines are never netted by ticker (HON: 0.5x the shares would read as a 50% trim).
    if (x.cusip && (HELD[x.cusip.toUpperCase()] || Object.values(HELD).some((h) => h.to === x.cusip.toUpperCase()))) return null;
    const t = x.ticker ?? reissuedTicker(x.cusip);
    return t ? `${t}|${(x.put_call ?? '').toUpperCase()}` : null;
  };
  const exits = new Map<string, MoveRow>();
  for (const x of r.changed) if (x.change === 'exited' && key(x)) exits.set(key(x)!, x);
  if (!exits.size) return r;
  const drop = new Set<MoveRow>();
  const merged: MoveRow[] = [];
  for (const n of r.changed) {
    const e = n.change === 'new' && key(n) ? exits.get(key(n)!) : undefined;
    if (!e || drop.has(e) || !n.shares) continue;
    drop.add(e).add(n);
    exits.delete(key(n)!);
    if (n.shares === e.prev_shares) continue;
    const delta = ((n.shares - e.prev_shares) * n.value) / n.shares;
    merged.push({ ...n, change: n.shares > e.prev_shares ? 'added' : 'trimmed', prev_shares: e.prev_shares, value_delta: Math.round(delta), delta_pct_of_book: n.delta_pct_of_book != null && n.value_delta ? (n.delta_pct_of_book * delta) / n.value_delta : null });
  }
  if (!drop.size) return r;
  const changed = [...r.changed.filter((x) => !drop.has(x)), ...merged];
  return { moves: movesOf(changed, limit), changed };
}

/** Filing-level point-in-time facts from EDGAR, for one accession. Immutable once filed. */
export interface FilingMeta {
  accession: string;
  form: string;
  filed_on: string; // EDGAR filing date, YYYY-MM-DD (ET)
  accepted_at: string; // EDGAR acceptance datetime, ISO 8601 UTC
  amendment_type: 'NEW HOLDINGS' | 'RESTATEMENT' | null;
  amendment_no: number | null;
  /** True when the amendment discloses holdings whose confidential treatment was denied or expired. */
  confidential_treatment_expired: boolean | null;
}

/** EDGAR timestamps are US Eastern wall time: DST from the 2nd Sunday of March to the 1st Sunday of November, at 02:00. */
export function easternToUtc(stamp: string): string {
  const [y, mo, d, h, mi, s] = [stamp.slice(0, 4), stamp.slice(4, 6), stamp.slice(6, 8), stamp.slice(8, 10), stamp.slice(10, 12), stamp.slice(12, 14)].map(Number);
  const sunday = (month: number, nth: number) => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (nth - 1) * 7;
  };
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  const dstStart = Date.UTC(y, 2, sunday(2, 2), 2);
  const dstEnd = Date.UTC(y, 10, sunday(10, 1), 2);
  const offsetHours = local >= dstStart && local < dstEnd ? 4 : 5;
  return new Date(local + offsetHours * 3600_000).toISOString().replace('.000Z', 'Z');
}

/** Parses EDGAR's -index-headers.html and, for amendments, primary_doc.xml. */
export function parseFilingMeta(accession: string, headers: string, primary: string | null): FilingMeta | null {
  const h = (k: string) => headers.match(new RegExp(`<${k}>([^<\\s]+)`))?.[1] ?? null;
  const acc = h('ACCEPTANCE-DATETIME');
  const fd = h('FILING-DATE');
  const form = headers.match(/<TYPE>([^<\n]+)/)?.[1]?.trim();
  if (!acc || !fd || !form) return null;
  const p = (k: string) => (primary ? tag(primary, k) : '');
  const type = p('amendmentType').toUpperCase();
  return {
    accession,
    form,
    filed_on: `${fd.slice(0, 4)}-${fd.slice(4, 6)}-${fd.slice(6, 8)}`,
    accepted_at: easternToUtc(acc),
    amendment_type: type === 'NEW HOLDINGS' || type === 'RESTATEMENT' ? type : null,
    amendment_no: p('amendmentNo') ? Number(p('amendmentNo')) : null,
    confidential_treatment_expired: primary && form.endsWith('/A') ? p('confDeniedExpired') === 'true' : null,
  };
}

export async function fetchFilingMeta(cik: string, accession: string): Promise<FilingMeta | null> {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/`;
  const res = await sec(`${base}${accession}-index-headers.html`);
  if (!res.ok) return null;
  const headers = await res.text();
  let primary: string | null = null;
  if (/<TYPE>[^<\n]*\/A/.test(headers)) {
    const r = await sec(`${base}primary_doc.xml`);
    primary = r.ok ? await r.text() : null;
  }
  return parseFilingMeta(accession, headers, primary);
}

// ---------------------------------------------------------------------------------------------
// Form 4 and Schedule 13D/G, parsed in the Worker so an alert can go out within the minute.

const all = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
/** A Form 4 value: either <x><value>v</value></x> or <x>v</x>. */
const val = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}>\\s*(?:<value>)?([^<]*)`));
  return m ? unescape(m[1]) : '';
};

export interface Form4Class {
  /** securityTitle as filed, e.g. "Class A Common Stock". */
  security: string;
  bought: number; // open-market purchase shares (code P)
  sold: number; // open-market sale shares (code S)
  value_usd: number; // |P and S shares| x price
  shares_before: number | null;
  shares_after: number | null;
  /** Each ownership line: direct, or indirect with its nature ("By Jain Foundation Inc."), its balance after and its open-market trades. */
  holdings?: { ownership: 'direct' | 'indirect'; nature: string | null; shares_after: number; bought: number; sold: number }[];
}

export interface Form4 {
  issuer_cik: string;
  issuer: string;
  ticker: string | null;
  owners: { cik: string; name: string }[];
  ten_percent_owner: boolean;
  /** Each reporting owner's relationship to the issuer: director, officer (with title), 10% owner. */
  insiders: { cik: string; name: string; roles: string[] }[];
  /** Open-market purchases (code P), shares x price, all classes. */
  bought_usd: number;
  classes: Form4Class[];
  action: 'buy' | 'sell' | 'mixed' | 'other';
  footnotes: string[];
  /** The first transaction date (periodOfReport when no transaction is dated): the one event_date rule for Form 4s. */
  event_date: string | null;
  /** The last transaction date, when the filing reports several days. */
  last_transaction_date: string | null;
  /** Non-derivative transaction codes in filing order, once each (P, S, A, M, F, G, ...). */
  codes: string[];
  /** Per transaction code (non-derivative lines): shares and shares x price (0 where no price is filed, as for gifts and grants). */
  by_code: Record<string, { shares: number; value_usd: number }>;
  /** Every transaction line as filed, non-derivative first, then derivative (options, convertibles). */
  lines: Form4Line[];
}

export interface Form4Line {
  code: string;
  security: string;
  date: string | null;
  shares: number;
  /** Null when the filing gives no price (or 0, as gifts do). */
  price: number | null;
  acquired_disposed: 'A' | 'D' | null;
  ownership: 'direct' | 'indirect';
  nature: string | null;
  shares_after: number | null;
  derivative: boolean;
}

/**
 * One Form 4, holdings split per security class (Class A and Class B are different CUSIPs).
 * Shares after are the last reported balance per class and ownership line (direct, each indirect
 * holder), summed; shares before back out this filing's transactions from the first balance.
 */
export function parseForm4(xml: string): Form4 | null {
  const issuer_cik = val(xml, 'issuerCik');
  if (!issuer_cik) return null;
  const byClass = new Map<string, Form4Class & { lines: Map<string, { first: number; firstDelta: number; last: number; bought: number; sold: number }> }>();
  for (const b of [...all(xml, 'nonDerivativeTransaction'), ...all(xml, 'nonDerivativeHolding')]) {
    const security = val(b, 'securityTitle') || 'Common Stock';
    const c = byClass.get(security) ?? { security, bought: 0, sold: 0, value_usd: 0, shares_before: null, shares_after: null, lines: new Map() };
    const code = val(b, 'transactionCode');
    const shares = Number(val(b, 'transactionShares')) || 0;
    const price = Number(val(b, 'transactionPricePerShare')) || 0;
    const ad = val(b, 'transactionAcquiredDisposedCode');
    if (code === 'P') c.bought += shares;
    if (code === 'S') c.sold += shares;
    if (code === 'P' || code === 'S') c.value_usd += shares * price;
    const after = val(b, 'sharesOwnedFollowingTransaction');
    if (after !== '') {
      const line = `${val(b, 'directOrIndirectOwnership')}|${val(b, 'natureOfOwnership').trim()}`;
      const delta = !code ? 0 : ad === 'D' ? -shares : shares;
      const l = c.lines.get(line) ?? { first: Number(after), firstDelta: delta, last: Number(after), bought: 0, sold: 0 };
      l.last = Number(after);
      if (code === 'P') l.bought += shares;
      if (code === 'S') l.sold += shares;
      c.lines.set(line, l);
    }
    byClass.set(security, c);
  }
  const classes: Form4Class[] = [...byClass.values()].map(({ lines, ...c }) => {
    const ls = [...lines.values()];
    return {
      ...c,
      value_usd: Math.round(c.value_usd),
      shares_after: ls.length ? ls.reduce((s, l) => s + l.last, 0) : null,
      // Before this filing: the first balance minus its own transaction, across lines; open-market net otherwise.
      shares_before: ls.length ? ls.reduce((s, l) => s + l.first - l.firstDelta, 0) : null,
      holdings: [...lines].map(([k, l]) => {
        const [di, nature] = k.split('|');
        return { ownership: di === 'I' ? ('indirect' as const) : ('direct' as const), nature: nature || null, shares_after: l.last, bought: l.bought, sold: l.sold };
      }),
    };
  });
  const dates = all(xml, 'nonDerivativeTransaction').map((b) => val(b, 'transactionDate').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const bought = classes.some((c) => c.bought > 0);
  const sold = classes.some((c) => c.sold > 0);
  return {
    issuer_cik: issuer_cik.padStart(10, '0'),
    issuer: val(xml, 'issuerName'),
    ticker: val(xml, 'issuerTradingSymbol').toUpperCase() || null,
    owners: all(xml, 'reportingOwnerId').map((o) => ({ cik: val(o, 'rptOwnerCik').padStart(10, '0'), name: val(o, 'rptOwnerName') })),
    ten_percent_owner: /<isTenPercentOwner>\s*(true|1)/.test(xml),
    insiders: all(xml, 'reportingOwner').map((o) => {
      const yes = (t: string) => /^(true|1)$/i.test(val(o, t).trim());
      const title = val(o, 'officerTitle').trim();
      const roles = [yes('isOfficer') && (title || 'Officer'), yes('isDirector') && 'Director', yes('isTenPercentOwner') && '10% owner'].filter((r): r is string => !!r);
      return { cik: val(o, 'rptOwnerCik').padStart(10, '0'), name: val(o, 'rptOwnerName'), roles };
    }),
    bought_usd: Math.round(
      all(xml, 'nonDerivativeTransaction')
        .filter((b) => val(b, 'transactionCode') === 'P')
        .reduce((s, b) => s + (Number(val(b, 'transactionShares')) || 0) * (Number(val(b, 'transactionPricePerShare')) || 0), 0),
    ),
    classes,
    action: bought && sold ? 'mixed' : bought ? 'buy' : sold ? 'sell' : 'other',
    footnotes: all(xml, 'footnote').map((f) => unescape(f).replace(/\s+/g, ' ')),
    event_date: dates[0] ?? (val(xml, 'periodOfReport') || null),
    last_transaction_date: dates[dates.length - 1] ?? (val(xml, 'periodOfReport') || null),
    codes: [...new Set(all(xml, 'nonDerivativeTransaction').map((b) => val(b, 'transactionCode')).filter(Boolean))],
    lines: [...all(xml, 'nonDerivativeTransaction').map((b) => [b, false] as const), ...all(xml, 'derivativeTransaction').map((b) => [b, true] as const)].map(([b, derivative]) => {
      const price = Number(val(b, 'transactionPricePerShare')) || 0;
      const ad = val(b, 'transactionAcquiredDisposedCode');
      const after = val(b, 'sharesOwnedFollowingTransaction');
      return {
        code: val(b, 'transactionCode'),
        security: val(b, 'securityTitle').trim(),
        date: val(b, 'transactionDate').slice(0, 10) || null,
        shares: Number(val(b, 'transactionShares')) || 0,
        price: price || null,
        acquired_disposed: ad === 'A' || ad === 'D' ? ad : null,
        ownership: val(b, 'directOrIndirectOwnership') === 'I' ? ('indirect' as const) : ('direct' as const),
        nature: val(b, 'natureOfOwnership').trim() || null,
        shares_after: after === '' ? null : Number(after),
        derivative,
      };
    }),
    by_code: all(xml, 'nonDerivativeTransaction').reduce<Record<string, { shares: number; value_usd: number }>>((acc, b) => {
      const code = val(b, 'transactionCode');
      if (!code) return acc;
      const sh = Number(val(b, 'transactionShares')) || 0;
      const c = (acc[code] ??= { shares: 0, value_usd: 0 });
      c.shares += sh;
      c.value_usd = Math.round(c.value_usd + sh * (Number(val(b, 'transactionPricePerShare')) || 0));
      return acc;
    }, {}),
  };
}

export interface Schedule13 {
  form: string;
  amendment_no: number | null;
  issuer_cik: string;
  issuer: string;
  cusip: string | null;
  security: string | null;
  event_date: string | null;
  persons: { cik: string | null; name: string }[];
  shares: number | null; // largest aggregate amount beneficially owned among reporting persons
  percent_of_class: number | null; // 0-100, as filed
  item4: string | null; // purpose of transaction (13D Item 4), excerpt
  item5c: string | null; // transactions in the last 60 days (13D Item 5(c)), excerpt
}

const excerpt = (s: string, n = 600) => {
  const t = unescape(s).replace(/\s+/g, ' ').trim();
  return t ? (t.length > n ? `${t.slice(0, n).replace(/\s\S*$/, '')}…` : t) : null;
};

/** Standard amendment openings that say nothing about the purpose ("Item 4 of the Initial 13D is hereby amended and supplemented by adding the following:"). */
const ITEM4_PREAMBLE = [
  /^Item\s*4\.?\s*(?:[-–—:]\s*)?(?:Purpose of (?:the )?Transactions?\.?\s*)?(?=Item\s*4\b|This\b|The\b|$)/i,
  /^(?:This\s+)?Item\s*4\b[^.:]{0,160}?\b(?:is|are|shall be)\s+(?:hereby\s+)?(?:amended|supplemented|restated)\b[^.:]{0,160}?(?:[:.]|\bfollowing\b[:.]?)\s*/i,
  /^(?:The\s+)?(?:Schedule\s+13D|Initial\s+13D|Original\s+13D)[^.:]{0,160}?\bhereby\s+(?:amended|supplemented)\b[^.:]{0,160}?[:.]\s*/i,
  // Any other short opening clause that names Item 4 and amends, supplements or restates it, up to its colon
  // ("This Amendment amends and supplements Item 4 of the Original Schedule 13D by adding the following:").
  /^(?=[^:]{0,240}:)(?=[^:]*\bItem\s*4\b)(?=[^:]*\b(?:amend|supplement|restat)\w*)[^.:]{0,240}:\s*/i,
];
/** Defined-term asides: (the "Underwriting Agreement"), (each, a "Lock-Up"), (collectively, the "Sellers"). */
const DEFINED = /\s*\((?:the|each|each,?\s+an?|an?|collectively,?\s+the|together,?\s+the)\s+["“][^"”]{1,60}["”]\)/g;

/**
 * The 13D's Item 4 for an alert or /v1: without the amendment boilerplate and defined-term asides,
 * as whole sentences up to `n` characters (then " …"). Safe on text cleaned or cut before.
 */
export function cleanItem4(raw: string | null | undefined, n = 600): string | null {
  if (!raw) return null;
  let t = unescape(raw).replace(/\s+/g, ' ').trim();
  // Already cut here at a sentence end (" …"): keep the cut. A stored excerpt cut mid-sentence: drop the partial sentence.
  const cut = /[.;] …$/.test(t);
  if (cut) t = t.slice(0, -2);
  else if (/…$/.test(t)) t = t.slice(0, sentenceEnds(t).pop() ?? 0).trim();
  for (let again = true; again; ) {
    again = false;
    for (const re of ITEM4_PREAMBLE) {
      const next = t.replace(re, '');
      if (next !== t && next.length) (t = next.trim()), (again = true);
    }
  }
  t = t.replace(DEFINED, '');
  if (!t) return null;
  if (t.length <= n) return cut ? `${t} …` : t;
  const end = sentenceEnds(t).filter((i) => i <= n).pop();
  return `${end ? t.slice(0, end) : t.slice(0, n).replace(/\s\S*$/, '')} …`;
}

/** Positions just after each sentence end: a period or semicolon before a capital, quote or bracket, not after an abbreviation (Inc., Corp., No.). */
function sentenceEnds(t: string): number[] {
  const out: number[] = [];
  for (const m of t.matchAll(/[.;](?=\s+[A-Z"“(\[])/g)) {
    const before = t.slice(Math.max(0, m.index - 6), m.index);
    if (m[0] === '.' && /(?:^|[\s(])(?:Inc|Corp|Co|Ltd|No|Nos|Mr|Ms|Mrs|Dr|Jr|Sr|St|U\.S|L\.P|N\.A|S\.A|[A-Z])$/.test(before)) continue;
    out.push(m.index + 1);
  }
  return out;
}

/** A structured Schedule 13D or 13G (EDGAR XML, required since December 2024). */
export function parseSchedule13(xml: string): Schedule13 | null {
  const form = val(xml, 'submissionType');
  const issuer_cik = val(xml, 'issuerCIK') || val(xml, 'issuerCik');
  if (!form || !issuer_cik) return null;
  // 13D cover pages are reportingPersonInfo blocks; 13G's are coverPageHeaderReportingPersonDetails with their own tag names.
  const persons = [...all(xml, 'reportingPersonInfo'), ...all(xml, 'coverPageHeaderReportingPersonDetails')].map((b) => ({ cik: val(b, 'reportingPersonCIK') || null, name: val(b, 'reportingPersonName') }));
  const shares = [...all(xml, 'aggregateAmountOwned'), ...all(xml, 'reportingPersonBeneficiallyOwnedAggregateNumberOfShares')].map(Number).filter((n) => !Number.isNaN(n));
  const pct = [...all(xml, 'percentOfClass'), ...all(xml, 'classPercent')].map(Number).filter((n) => !Number.isNaN(n));
  const ev = (val(xml, 'dateOfEvent') || val(xml, 'eventDateRequiresFilingThisStatement')).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return {
    form,
    amendment_no: val(xml, 'amendmentNo') ? Number(val(xml, 'amendmentNo')) : null,
    issuer_cik: issuer_cik.padStart(10, '0'),
    issuer: val(xml, 'issuerName'),
    cusip: (val(xml, 'issuerCusipNumber') || val(xml, 'issuerCusip')).toUpperCase() || null,
    security: val(xml, 'securitiesClassTitle') || val(xml, 'securityClassTitle') || null,
    event_date: ev ? `${ev[3]}-${ev[1]}-${ev[2]}` : null,
    persons,
    shares: shares.length ? Math.max(...shares) : null,
    percent_of_class: pct.length ? Math.max(...pct) : null,
    item4: cleanItem4(all(xml, 'transactionPurpose')[0] ?? ''),
    item5c: excerpt(all(xml, 'transactionDesc')[0] ?? '', 300),
  };
}

const archive = (cik: string, accession: string) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/`;

/** The ownership XML of a Form 4 (its file name varies, so via the filing index). */
export async function fetchForm4(cik: string, accession: string): Promise<Form4 | null> {
  const dir = await sec(`${archive(cik, accession)}index.json`);
  if (!dir.ok) return null;
  const items = ((await dir.json()) as { directory?: { item?: { name: string }[] } }).directory?.item ?? [];
  const x = items.find((i) => i.name.toLowerCase().endsWith('.xml'));
  if (!x) return null;
  const res = await sec(`${archive(cik, accession)}${x.name}`);
  return res.ok ? parseForm4(await res.text()) : null;
}

/** A filing's full submission text in one request (a Form 4's is ~10 KB and holds its ownership XML). */
export async function fetchSubmission(cik: string, accession: string): Promise<string | null> {
  const res = await sec(`${archive(cik, accession)}${accession}.txt`);
  return res.ok ? res.text() : null;
}

export async function fetchSchedule13(cik: string, accession: string): Promise<Schedule13 | null> {
  const res = await sec(`${archive(cik, accession)}primary_doc.xml`);
  return res.ok ? parseSchedule13(await res.text()) : null;
}

/**
 * The same filer's previous Schedule 13D/G on this issuer: the subject company's EDGAR feed lists
 * every Schedule 13 filed on it; the first earlier one whose reporting persons overlap is it.
 * Only structured (XML) filings parse, so a previous one from before December 2024 returns null.
 */
export async function previousSchedule13(cur: Schedule13, accession: string, tries = 3): Promise<(Schedule13 & { accession: string }) | null> {
  const res = await sec(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cur.issuer_cik}&type=SCHEDULE%2013&dateb=&owner=include&count=20&output=atom`);
  if (!res.ok) return null;
  const mine = new Set(cur.persons.map((p) => p.cik).filter(Boolean));
  const feed = parseFeed(await res.text(), cur.issuer_cik);
  const i = feed.findIndex((e) => e.accession === accession);
  for (const e of feed.slice(i + 1, i + 1 + tries)) {
    if (!e.form.startsWith('SCHEDULE 13')) break; // older SC 13D/G filings are not structured
    const p = await fetchSchedule13(cur.issuer_cik, e.accession);
    if (p && p.persons.some((x) => x.cik && mine.has(x.cik))) return { ...p, accession: e.accession };
  }
  return null;
}
