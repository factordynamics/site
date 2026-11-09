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
  return fetch(url, { headers: { 'user-agent': SEC_UA, accept: '*/*' } });
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
  /** The trade as a signed fraction of this filing's book (0-1). */
  delta_pct_of_book: number | null;
  /** Older data-run rows used this name for the trade size. */
  pct_of_book?: number | null;
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
    delta_pct_of_book: total ? delta / total : null,
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
