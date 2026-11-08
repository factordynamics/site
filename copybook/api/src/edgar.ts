/**
 * Reading 13F filings straight from EDGAR, so a filing can be emailed with its moves within
 * minutes instead of waiting for the next data run. Everything here comes from SEC filings.
 */

export const SEC_UA = 'Copybook copybook@factordynamics.com';
const sec = (url: string) => fetch(url, { headers: { 'user-agent': SEC_UA, accept: '*/*' } });

/** Biggest infotable we parse in the Worker; bigger books wait for the data run's moves. */
const MAX_TABLE_BYTES = 400_000;
const MOVE_ROWS = 5;

export interface FeedEntry {
  form: string;
  cik: string; // 10 digits
  accession: string;
  accepted: string; // ISO time EDGAR accepted the filing
}

/** EDGAR's "latest filings" Atom feed for one form type (prefix match, so 13F-HR also lists 13F-HR/A). */
export async function latestFilings(type: string): Promise<FeedEntry[]> {
  const res = await sec(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(type)}&company=&dateb=&owner=include&start=0&count=100&output=atom`);
  if (!res.ok) throw new Error(`edgar feed ${type}: ${res.status}`);
  return parseFeed(await res.text());
}

export function parseFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const e of xml.split('<entry>').slice(1)) {
    const form = e.match(/term="([^"]+)"/)?.[1];
    const cik = e.match(/<title>[^<]*\((\d{10})\)/)?.[1];
    const accession = e.match(/accession-number=(\d{10}-\d{2}-\d{6})/)?.[1];
    const accepted = e.match(/<updated>([^<]+)<\/updated>/)?.[1];
    if (form && cik && accession && accepted) out.push({ form, cik, accession, accepted: new Date(accepted).toISOString() });
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
  pct_of_book: number | null;
}

export interface Moves {
  bought_usd: number;
  sold_usd: number;
  new: MoveRow[];
  exited: MoveRow[];
  added: MoveRow[];
  trimmed: MoveRow[];
}

const TAGS = new Map<string, RegExp>();
export const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function tag(block: string, name: string): string {
  let re = TAGS.get(name);
  if (!re) TAGS.set(name, (re = new RegExp(`<(?:\\w+:)?${name}>([^<]*)<`)));
  return (block.match(re)?.[1]?.trim() ?? '').replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]);
}

const FIELD = /<(?:\w+:)?(nameOfIssuer|titleOfClass|cusip|value|sshPrnamt|putCall)>([^<]*)</g;
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
}

/** The period and, for books small enough to parse in the Worker, the holdings of one 13F-HR. */
export async function fetch13F(cik: string, accession: string): Promise<Filing13F | null> {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/`;
  const dir = await sec(`${base}index.json`);
  if (!dir.ok) return null;
  const items = ((await dir.json()) as { directory?: { item?: { name: string; size: string }[] } }).directory?.item ?? [];
  const primary = await sec(`${base}primary_doc.xml`);
  if (!primary.ok) return null;
  const period = tag(await primary.text(), 'periodOfReport').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!period) return null;
  const report_date = `${period[3]}-${period[1]}-${period[2]}`;
  const table = items.find((i) => i.name.toLowerCase().endsWith('.xml') && i.name !== 'primary_doc.xml');
  if (!table || Number(table.size) > MAX_TABLE_BYTES) return { report_date, holdings: null };
  const res = await sec(`${base}${table.name}`);
  return { report_date, holdings: res.ok ? parseInfoTable(await res.text()) : null };
}

export function quarterOf(reportDate: string): string {
  const [y, m] = reportDate.split('-').map(Number);
  return `${y}Q${Math.ceil(m / 3)}`;
}

/**
 * New, exited, added and trimmed positions against the prior quarter, sized by the trade at this
 * filing's own value per share (a price move alone is no trade), as the data run computes them.
 */
export function computeMoves(cur: Position[], prev: Position[], limit = MOVE_ROWS): { moves: Moves; changed: MoveRow[] } {
  const prevTotal = prev.reduce((s, p) => s + p.value, 0);
  let total = cur.reduce((s, p) => s + p.value, 0);
  // A filer that reports in thousands by mistake: scale to dollars like the data run's unit fix.
  const scale = total > 0 && total * 200 < prevTotal ? 1000 : 1;
  total *= scale;
  const before = new Map(prev.map((p) => [`${p.cusip}|${p.put_call ?? ''}`, p]));
  const rows: MoveRow[] = [];
  const row = (p: Position, change: string, shares: number, prev_shares: number, value: number, delta: number) => ({
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
    pct_of_book: total ? delta / total : null,
  });
  for (const c of cur) {
    const value = c.value * scale;
    const k = `${c.cusip}|${c.put_call ?? ''}`;
    const p = before.get(k);
    before.delete(k);
    const named = { ...c, ticker: p?.ticker ?? c.ticker, display_name: p?.display_name ?? c.display_name };
    if (!p) rows.push(row(named, 'new', c.shares, 0, value, value));
    else if (c.shares !== p.shares) rows.push(row(named, c.shares > p.shares ? 'added' : 'trimmed', c.shares, p.shares, value, c.shares ? ((c.shares - p.shares) * value) / c.shares : 0));
  }
  for (const p of before.values()) rows.push(row(p, 'exited', 0, p.shares, 0, -p.value));
  const top = (c: string) =>
    rows
      .filter((r) => r.change === c)
      .sort((a, b) => Math.abs(b.value_delta) - Math.abs(a.value_delta))
      .slice(0, limit);
  return {
    moves: {
      bought_usd: rows.reduce((s, r) => s + Math.max(r.value_delta, 0), 0),
      sold_usd: rows.reduce((s, r) => s - Math.min(r.value_delta, 0), 0),
      new: top('new'),
      exited: top('exited'),
      added: top('added'),
      trimmed: top('trimmed'),
    },
    changed: rows,
  };
}
