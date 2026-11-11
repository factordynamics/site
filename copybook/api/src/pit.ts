/**
 * Point in time (as_of, due Nov 30, 2026): the API's half of the design agreed with the quant and ingest (draft 2,
 * https://ampcode.com/artifacts/copybook-api-draft-as-of-and-per-row-lots-5070c55f-d969-4aa3-a29c-da00248d8597).
 *
 * Ingest writes, per CIK, `pit/{cik10}/index.json` (every epoch per quarter, oldest first; the last is the current
 * book) and the v1 book at each non-current epoch; pit bulk has one row per lot. This module is the rule both read by:
 * a lot is visible at T when accepted_at <= T < superseded_at, rows group by (cik, quarter, cusip, put_call,
 * shares_type), and each lot carries its held marking (unreliable, suspect_reason) as of its epoch, so a client
 * rebuilding changes from bulk holds the same lines /v1 holds (the analyst's blocker: GuardCap BKNG, Belvedere EW).
 * Pure functions, no I/O: the routes and the bootcheck call them.
 */

export type Side = 'value' | 'shares' | 'both';
export type LotKind = 'original' | 'new_holdings' | 'confidential_reveal' | 'restatement' | 'refile';

/** One pit bulk row: one filing's contribution to one row of one filer-quarter. */
export interface PitLot {
  cik: string;
  quarter: string;
  cusip: string;
  put_call: string | null;
  shares_type: 'SH' | 'PRN';
  accession: string;
  accepted_at: string;
  /** The acceptance of the RESTATEMENT or refile that replaced this lot's book; null when never replaced. */
  superseded_at: string | null;
  kind: LotKind;
  shares: number;
  value_as_filed: number;
  value_scale: number;
  value_usd: number;
  /** Maps this lot's shares into the next quarter's basis (rule 7); 1 without a split. */
  split_factor_next: number;
  prev_cusip: string | null;
  /** The side ingest holds as of this lot's epoch; null when the line is reliable. */
  unreliable: Side | null;
  suspect_reason: string | null;
}

/** A row of a filer-quarter at T, built from its visible lots. */
export interface PitRow {
  cik: string;
  quarter: string;
  cusip: string;
  put_call: string | null;
  shares_type: 'SH' | 'PRN';
  shares: number;
  value_usd: number;
  source_accession: string;
  first_disclosed_at: string;
  last_changed_accession: string;
  last_changed_at: string;
  lots: Omit<PitLot, 'cik' | 'quarter' | 'cusip' | 'put_call' | 'shares_type'>[];
  unreliable: Side | null;
  suspect_reason: string | null;
  prev_cusip: string | null;
}

export const ms = (t: string) => Date.parse(t);
export const visible = (l: Pick<PitLot, 'accepted_at' | 'superseded_at'>, T: number) => ms(l.accepted_at) <= T && (!l.superseded_at || T < ms(l.superseded_at));
export const rowKey = (l: Pick<PitLot, 'cik' | 'quarter' | 'cusip' | 'put_call' | 'shares_type'>) => `${l.cik}|${l.quarter}|${l.cusip}|${l.put_call ?? ''}|${l.shares_type}`;

/** A row's held side from its visible lots: one side when every flagged lot agrees, `both` when they differ. */
export function rowSide(lots: Pick<PitLot, 'unreliable'>[]): Side | null {
  const sides = new Set(lots.map((l) => l.unreliable).filter((s): s is Side => !!s));
  return sides.size === 0 ? null : sides.size === 1 ? [...sides][0] : 'both';
}

/**
 * Every row at T from pit bulk lots: lots visible at T, grouped by the row key. `first_disclosed_at` and the source are
 * the earliest lot for the key accepted by T, superseded ones included (a restated row keeps its first disclosure);
 * `last_changed_*` the latest visible lot.
 */
export function rowsAt(lots: PitLot[], T: number): PitRow[] {
  const all = new Map<string, PitLot[]>();
  for (const l of lots) if (ms(l.accepted_at) <= T) all.set(rowKey(l), [...(all.get(rowKey(l)) ?? []), l]);
  const out: PitRow[] = [];
  for (const group of all.values()) {
    const seen = [...group].sort((a, b) => ms(a.accepted_at) - ms(b.accepted_at));
    const live = seen.filter((l) => visible(l, T));
    if (!live.length) continue;
    const first = seen[0];
    const last = live[live.length - 1];
    const marked = live.find((l) => l.suspect_reason);
    out.push({
      cik: first.cik,
      quarter: first.quarter,
      cusip: first.cusip,
      put_call: first.put_call,
      shares_type: first.shares_type,
      shares: live.reduce((s, l) => s + l.shares, 0),
      value_usd: live.reduce((s, l) => s + l.value_usd, 0),
      source_accession: first.accession,
      first_disclosed_at: first.accepted_at,
      last_changed_accession: last.accession,
      last_changed_at: last.accepted_at,
      lots: live.map(({ accession, accepted_at, superseded_at, kind, shares, value_as_filed, value_scale, value_usd, split_factor_next, prev_cusip, unreliable, suspect_reason }) => ({ accession, accepted_at, superseded_at, kind, shares, value_as_filed, value_scale, value_usd, split_factor_next, prev_cusip, unreliable, suspect_reason })),
      unreliable: rowSide(live),
      suspect_reason: marked?.suspect_reason ?? null,
      prev_cusip: live.find((l) => l.prev_cusip)?.prev_cusip ?? null,
    });
  }
  return out;
}

/**
 * A row's prior shares at T (rule 6): Q−1 lots visible at the same T, in this quarter's basis (split_factor_next). A
 * prior merged across CIKs (`prev_combined_with`, Ackman's HHH with Pershing Square Inc.'s own 13F) sums every CIK in
 * the set. Null when nothing of the prior was visible at T.
 */
export function prevSharesAt(prevLots: PitLot[], T: number, row: Pick<PitLot, 'cusip' | 'put_call' | 'shares_type'> & { prev_cusip?: string | null }, ciks: string[]): number | null {
  const cusips = new Set([row.cusip, ...(row.prev_cusip ? [row.prev_cusip] : [])]);
  const lots = prevLots.filter((l) => ciks.includes(l.cik) && cusips.has(l.cusip) && (l.put_call ?? null) === (row.put_call ?? null) && l.shares_type === row.shares_type && visible(l, T));
  return lots.length ? lots.reduce((s, l) => s + l.shares * l.split_factor_next, 0) : null;
}

/** `pit/{cik10}/index.json`: every epoch per quarter, oldest first; the last is the current book. */
export interface PitIndex {
  quarters: Record<string, string[]>;
}

/** The latest epoch of one quarter at or before T, or null (404 not_yet_filed: no version accepted by T). */
export function epochAt(index: PitIndex, quarter: string, T: number): string | null {
  const e = (index.quarters[quarter] ?? []).filter((x) => ms(x) <= T);
  return e.length ? e[e.length - 1] : null;
}

/**
 * holdings/latest?as_of=T across a filer's CIK lineage (Appaloosa: 1006438, then 1656456): the latest quarter any CIK
 * had a version of by T, the CIK that filed it, and the epoch served. Null when nothing was filed by T.
 */
export function latestAt(lineage: { cik: string; index: PitIndex }[], T: number): { quarter: string; cik: string; epoch: string; current: boolean } | null {
  let best: { quarter: string; cik: string; epoch: string; current: boolean } | null = null;
  for (const { cik, index } of lineage) {
    for (const [quarter, epochs] of Object.entries(index.quarters)) {
      const epoch = epochAt(index, quarter, T);
      if (!epoch) continue;
      // A later quarter wins; for one quarter filed under two CIKs, the later acceptance.
      if (!best || quarter > best.quarter || (quarter === best.quarter && ms(epoch) > ms(best.epoch))) best = { quarter, cik, epoch, current: epoch === epochs[epochs.length - 1] };
    }
  }
  return best;
}

/**
 * Invariant 3, the last line before a response: nothing accepted after T in a served book (filing versions,
 * amendments, rows' lots). Returns the offending accessions; the route answers 500 when any.
 */
export function leaksAfter(book: { filing?: { versions?: { accession: string; accepted_at: string }[]; amendments?: { accession: string; accepted_at: string }[] }; holdings?: { lots?: { accession: string; accepted_at: string }[] }[]; exited?: { lots?: { accession: string; accepted_at: string }[] }[] }, T: number): string[] {
  const seen = [...(book.filing?.versions ?? []), ...(book.filing?.amendments ?? []), ...[...(book.holdings ?? []), ...(book.exited ?? [])].flatMap((r) => r.lots ?? [])];
  return [...new Set(seen.filter((x) => ms(x.accepted_at) > T).map((x) => x.accession))];
}

/** T from an as_of value (validated by the route): a date alone is 23:59:59Z that day; later than now is now. */
export function asOfTime(asOf: string, now = Date.now()): { T: number; echo: string; future: boolean } {
  const t = Date.parse(/T/.test(asOf) ? asOf : `${asOf}T23:59:59Z`);
  const T = Math.min(t, now);
  return { T, echo: new Date(T).toISOString().replace('.000Z', 'Z'), future: t > now };
}

/** An epoch's stored book: pit/{cik10}/{quarter}/{yyyymmddThhmmssZ}.json. */
export const epochKey = (cik: string, quarter: string, epoch: string) => `pit/${cik.padStart(10, '0')}/${quarter}/${epoch.replace(/[-:]/g, '').replace(/\.\d+/, '')}.json`;

/**
 * Responses always carry lots[] (Q3): stored books omit it on rows with one `original` lot, rebuilt here from the row's
 * source_accession, first_disclosed_at and filed figures. Rows already carrying lots[] are left as they are.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withLots<B extends { holdings?: any[]; exited?: any[] }>(book: B): B {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fill = (r: any) =>
    Array.isArray(r.lots) || !r.source_accession
      ? r
      : { ...r, lots: [{ accession: r.source_accession, accepted_at: r.first_disclosed_at, superseded_at: null, kind: 'original', shares: r.shares, value_as_filed: r.value_as_filed ?? null, value_scale: r.value_scale ?? 1, value_usd: r.value_usd ?? null }] };
  return { ...book, ...(book.holdings ? { holdings: book.holdings.map(fill) } : {}), ...(book.exited ? { exited: book.exited.map(fill) } : {}) };
}

/** The epoch to serve for one quarter across a lineage: the latest epoch at or before T over every CIK's index. */
export function quarterAt(lineage: { cik: string; index: PitIndex }[], quarter: string, T: number): { quarter: string; cik: string; epoch: string; current: boolean } | null {
  let best: { quarter: string; cik: string; epoch: string; current: boolean } | null = null;
  for (const { cik, index } of lineage) {
    const epoch = epochAt(index, quarter, T);
    const all = index.quarters[quarter] ?? [];
    if (epoch && (!best || ms(epoch) > ms(best.epoch))) best = { quarter, cik, epoch, current: epoch === all[all.length - 1] };
  }
  return best;
}
