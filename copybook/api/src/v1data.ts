import { linkBase, type Env } from './env';
import { lookupTickers } from './alerts';
import { cleanItem4, easternToUtc, fetch13F, fetchFilingMeta, filings13F, SEC_UA, type Filed13F, type FilingMeta } from './edgar';
import { ROUTES, v1error, v1json, noMs, stampOf, type Stamp } from './v1';

/** Smallest bulk file served: a real quarter is tens of MB gzipped (2026Q2: 69 MB); smaller ones are stubs from a failed run. */
const MIN_BULK_BYTES = 1_000_000;

/**
 * /v1 data endpoints. Everything is from SEC EDGAR filings as filed. Units: money in whole US
 * dollars (filings in thousands are rescaled), share counts as filed (principal amount for PRN
 * rows), fractions as 0-1 (weight 0.256 means 25.6% of the filing's reported value).
 */

const QUARTER = /^\d{4}Q[1-4]$/;
const CIK = /^\d{1,10}$/;
const pad = (cik: string) => cik.padStart(10, '0');
const quarterEnd = (q: string) => `${q.slice(0, 4)}-${['03-31', '06-30', '09-30', '12-31'][Number(q[5]) - 1]}`;
const nextQuarter = (q: string) => (q[5] === '4' ? `${Number(q.slice(0, 4)) + 1}Q1` : `${q.slice(0, 5)}${Number(q[5]) + 1}`);
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

export interface FilerRow {
  slug: string;
  cik: string;
  name: string;
  manager: string;
  featured: boolean;
  type: string | null;
  status: string | null;
  latest_quarter: string | null;
  latest_report_date: string | null;
  latest_filing_date: string | null;
  latest_accession: string | null;
  total_value_usd: number | null;
  position_count: number | null;
  history_quarters: string[];
}

/** The filer list, refreshed hourly from the data run's index (see runBackstop). */
export async function filers(env: Env): Promise<FilerRow[]> {
  return JSON.parse((await env.DB.get('v1:filers')) ?? '[]') as FilerRow[];
}

/** A filer by slug or CIK (any width). */
async function resolve(env: Env, id: string): Promise<FilerRow | null> {
  const list = await filers(env);
  if (/^\d{1,10}$/.test(id)) return list.find((f) => f.cik === id.padStart(10, '0')) ?? null;
  return SLUG.test(id) ? (list.find((f) => f.slug === id) ?? null) : null;
}

/** Equity rows: shares (not principal amounts), no put/call. The denominator of weight_equity. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isEquity = (h: any) => !h.put_call && (h.shares_type ?? h.sh_prn ?? 'SH') !== 'PRN';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function position(h: any, equityTotal: number, allTotal: number) {
  // The equity-book weight: the data run's pct_of_book once it publishes it (ingest item W, next to the renamed
  // trade size delta_pct_of_book), else computed here over SH rows without put/call.
  // Computed here at full precision, like the other two (the data run's pct_of_book is rounded to 6 decimals).
  const w = 'delta_pct_of_book' in h;
  const eqw = isEquity(h) && equityTotal > 0 && h.value ? h.value / equityTotal : isEquity(h) ? 0 : null;
  // `weight` keeps its meaning until Feb 8, 2027 (90 days' notice, /v1/changelog): value over the book's total, all
  // rows, options included. The data run's per-row weight is that definition until it switches to pct_of_book.
  const allw = !w && h.weight != null ? h.weight : allTotal > 0 && h.value != null ? h.value / allTotal : null;
  return {
    cusip: h.cusip,
    ticker: h.ticker ?? null,
    issuer: h.issuer,
    title_of_class: h.title ?? null,
    put_call: h.put_call ? String(h.put_call).toUpperCase() : null,
    sector: h.sector ?? null,
    shares: h.shares,
    shares_type: h.shares_type ?? h.sh_prn ?? null,
    value_usd: h.value,
    weight: allw,
    weight_incl_options: allw,
    weight_equity: eqw,
    // The data run marks a row it rescaled (value_as_filed, value_adjusted); the factor follows from the two values.
    value_scale: h.value_scale ?? (h.value_adjusted === true && h.value_as_filed ? Math.round((h.value / h.value_as_filed) * 1000) / 1000 : null),
    value_as_filed: h.value_as_filed ?? null,
    value_adjusted: h.value_adjusted ?? null,
    zero_value: h.zero_value ?? (h.change !== 'exited' && h.value === 0),
    change: h.change ?? null,
    prev_shares: h.prev_shares ?? null,
    // As in the CSV: split only when a split adjusted prev_shares; prev_shares_as_filed on every row with a prior.
    split: h.split?.ratio ? { ratio: h.split.ratio, from_quarter: h.split.from_quarter ?? null, to_quarter: h.split.to_quarter ?? null } : null,
    prev_shares_as_filed: h.prev_shares_as_filed ?? null,
    share_change: h.share_change ?? null,
    value_delta_usd: h.value_delta ?? null,
    // Point-in-time provenance: filled once the data run publishes it per row.
    source_accession: h.source_accession ?? null,
    first_disclosed_at: h.first_disclosed_at ?? null,
    // Ingest's unit-error flag, passed through when the data carries it.
    // Null until ingest's cross-filer check has run on the row: false would claim a check that never happened.
    suspect_units: typeof h.suspect_units === 'boolean' ? h.suspect_units : null,
    // `exited`: the position was sold out (shares and value 0; the old position in prev_shares, prev_value).
    row_type: h.row_type === 'holding' || h.row_type === 'exited' ? h.row_type : null,
    // What the unit check compared against, and why a row was flagged (enums declared in the spec; null until set).
    suspect_units_basis: ['filers', 'own_prior', 'none'].includes(h.suspect_units_basis) ? h.suspect_units_basis : null,
    suspect_reason: ['cross_filer', 'cross_filer_prior', 'own_prior'].includes(h.suspect_reason) ? h.suspect_reason : null,
  };
}

/** Acceptance time and amendment type per accession, from EDGAR once, then KV (filings never change). */
export async function filingMeta(env: Env, cik: string, accession: string): Promise<FilingMeta | null> {
  const key = `filing:${accession}`;
  const cached = await env.DB.get(key);
  if (cached) return JSON.parse(cached) as FilingMeta;
  const m = await fetchFilingMeta(cik, accession);
  if (m) await env.DB.put(key, JSON.stringify(m));
  return m;
}

const cikOf = (secUrl: string | undefined, fallback: string) => secUrl?.match(/\/edgar\/data\/(\d+)\//)?.[1] ?? fallback;

/** One row of the data run's filers.json (every 13F filer it parsed). */
interface AllFiler {
  cik: string;
  name: string;
  slug: string;
  ok: boolean;
  quarter: string | null;
  filing_date: string | null;
  position_count: number | null;
  type?: string | null;
}

/** The data run's files a request reads (MBs each): kept in R2 as data/{name} and refreshed by gene's cron. */
export const LOCAL_DATA = ['filer_types.json', 'filers.json', 'index.json'];
/** The last copy fetched per file: only a fallback when a fetch is slower than a request can wait. */
const lastFetched = new Map<string, string>();
/**
 * One of the data run's files for a request: R2 data/{name} (gene's cron copy; a local read on gene), else GitHub
 * Pages. A slow link (gene's) never makes a request wait on a multi-MB download: past 2.5 s the fetch carries on
 * and this request gets the last copy fetched, or null.
 */
export async function dataText(env: Env, name: string): Promise<string | null> {
  const obj = await env.HIST.get(`data/${name}`);
  if (obj) return new Response(obj.body).text();
  const load = fetch(`${env.DATA_URL}${name}`, { cf: { cacheTtl: 900 } } as RequestInit).then(async (r) => {
    if (!r.ok) return lastFetched.get(name) ?? null;
    const text = await r.text();
    lastFetched.set(name, text);
    return text;
  });
  return Promise.race([load.catch(() => lastFetched.get(name) ?? null), new Promise<string | null>((r) => setTimeout(() => r(lastFetched.get(name) ?? null), 2500))]);
}

/** gene's cron: refreshes the local copies of the data run's files (no request budget; a slow link is fine here). */
let refreshing = false;
export async function refreshLocalData(env: Env): Promise<Record<string, string>> {
  if (refreshing) return { status: 'already running' };
  refreshing = true;
  const out: Record<string, string> = {};
  try {
    for (const name of LOCAL_DATA) {
      try {
        const r = await fetch(`${env.DATA_URL}${name}`, { signal: AbortSignal.timeout(240_000) });
        if (!r.ok) {
          out[name] = `http ${r.status}`;
          continue;
        }
        const text = await r.text();
        await env.HIST.put(`data/${name}`, text, { httpMetadata: { contentType: 'application/json' } });
        out[name] = `${text.length} bytes`;
      } catch (e) {
        out[name] = `error: ${e}`;
      }
    }
  } finally {
    refreshing = false;
  }
  return out;
}

async function filersJson(env: Env): Promise<string | null> {
  return dataText(env, 'filers.json');
}

/** A filer outside the curated list, by CIK or its all-filer slug, found without parsing all 9,000 rows. */
async function findFiler(env: Env, id: string): Promise<AllFiler | null> {
  const text = await filersJson(env);
  const at = text?.search(CIK.test(id) ? new RegExp(`"cik":\\s*"${pad(id)}"`) : new RegExp(`"slug":\\s*"${id}"`)) ?? -1;
  if (!text || at < 0) return null;
  try {
    const row = JSON.parse(text.slice(text.lastIndexOf('{', at), text.indexOf('}', at) + 1)) as AllFiler;
    return row.ok ? row : null;
  } catch {
    return null;
  }
}

type Filer = { curated: true; row: FilerRow } | { curated: false; row: AllFiler };

export async function resolveAny(env: Env, id: string): Promise<Filer | null> {
  const c = await resolve(env, id);
  if (c) return { curated: true, row: c };
  const a = CIK.test(id) || SLUG.test(id) ? await findFiler(env, id) : null;
  return a ? { curated: false, row: a } : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const rowsOf = (d: { columns: string[]; rows: unknown[][] }): any[] => d.rows.map((r) => Object.fromEntries(d.columns.map((c, i) => [c, r[i]])));

/**
 * A non-curated filer's book for a quarter: the full book in R2 (fb/), else the public shard when it
 * is that quarter (top 500 positions by value), else the baseline snapshotted when a member followed it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function filerBook(env: Env, cik: string, quarter: string): Promise<any | null> {
  const full = await env.HIST.get(`fb/${quarter}/${cik}.json`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (full) return { ...((await new Response(full.body).json()) as any), truncated: false, __stamp: stampOf(full) };
  const res = await fetch(`${env.DATA_URL}f/${cik}.json`, { cf: { cacheTtl: 900 } } as RequestInit);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shard = res.ok ? ((await res.json()) as any) : null;
  if (shard?.ok && shard.quarter === quarter) return shard;
  const snap = await env.HIST.get(`b/${cik}/${quarterEnd(quarter)}.json`);
  if (!snap) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = (await new Response(snap.body).json()) as any;
  return { quarter, report_date: b.report_date, accession: b.accession, holdings: b.holdings, truncated: b.holdings.length >= 500, form: '13F-HR' };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function amendmentsOf(env: Env, cik: string, list: any[]) {
  const out = [];
  for (const a of list) {
    const acc = typeof a === 'string' ? a : a?.accession;
    if (!acc) continue;
    const m = await filingMeta(env, cik, acc);
    out.push({
      accession: acc,
      filed_on: m?.filed_on ?? null,
      accepted_at: noMs(m?.accepted_at),
      amendment_type: m?.amendment_type ?? a?.amendment_type ?? null,
      amendment_no: m?.amendment_no ?? null,
      confidential_treatment_expired: m?.confidential_treatment_expired ?? null,
    });
  }
  return out.sort((a, b) => (a.accepted_at ?? '').localeCompare(b.accepted_at ?? ''));
}

interface Version {
  accession: string;
  form: string;
  amendment_type: 'NEW HOLDINGS' | 'RESTATEMENT' | null;
  accepted_at: string | null;
  filed_on: string | null;
  /** current: the book served; superseded: replaced by a later restatement; merged: NEW HOLDINGS folded
   * into the served book; not_merged: an amendment filed after the served book and not folded in yet. */
  status: 'current' | 'superseded' | 'merged' | 'not_merged';
}

/** Every 13F-HR and 13F-HR/A a CIK filed, from EDGAR's submissions JSON, cached for an hour. */
async function filed13F(env: Env, cik: string): Promise<Filed13F[] | null> {
  const key = `subs13f:${pad(cik)}`;
  const cached = await env.DB.get(key);
  if (cached) return JSON.parse(cached) as Filed13F[];
  const list = await filings13F(cik);
  if (list) await env.DB.put(key, JSON.stringify(list), { expirationTtl: 3600 });
  return list;
}

/**
 * Every filing for one period, oldest first, including originals a restatement replaced, with what
 * each is to the served book. Null when EDGAR can't be read right now.
 */
async function versionsFor(env: Env, cik: string, reportDate: string, served: string | null, merged: string[]): Promise<Version[] | null> {
  try {
    const list = await filed13F(env, cik);
    if (!list) return null;
    const vs: Omit<Version, 'status'>[] = [];
    for (const f of list.filter((x) => x.report_date === reportDate)) {
      const m = await filingMeta(env, cik, f.accession);
      vs.push({ accession: f.accession, form: m?.form ?? f.form, amendment_type: m?.amendment_type ?? null, accepted_at: noMs(m?.accepted_at), filed_on: m?.filed_on ?? null });
    }
    if (!vs.length) return null;
    vs.sort((a, b) => (a.accepted_at ?? '').localeCompare(b.accepted_at ?? ''));
    // The book in force: what the data run serves; failing that, the latest restatement, else the original.
    const base = (served && vs.find((v) => v.accession === served)) || [...vs].reverse().find((v) => v.amendment_type === 'RESTATEMENT') || vs.find((v) => v.form === '13F-HR') || vs[0];
    const at = base.accepted_at ?? '';
    return vs.map((v) => ({
      ...v,
      status: v === base ? 'current' : (v.accepted_at ?? '') < at ? 'superseded' : merged.includes(v.accession) ? 'merged' : v.amendment_type === 'RESTATEMENT' ? 'superseded' : 'not_merged',
    }));
  } catch {
    return null;
  }
}

/** One filer's book for one quarter, in the /v1 holdings shape; null when there is none. */
/** The build each served book was read from (see stampOf), kept beside the book rather than in it. */
const STAMP = new WeakMap<object, Stamp>();

async function bookFor(env: Env, f: Filer, quarter: string): Promise<Record<string, unknown> | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any;
  let stamp: Stamp | undefined;
  const obj = f.curated ? await env.HIST.get(`h/${f.row.slug}/${quarter}.json`) : null;
  if (obj) {
    q = await new Response(obj.body).json();
    stamp = stampOf(obj);
  } else {
    // A newly curated fund whose history isn't in R2 yet is served like any filer (full book, else the public shard).
    q = await filerBook(env, f.row.cik, quarter);
    if (!q) return null;
    stamp = q.__stamp;
  }
  const holdings = q.holdings ?? (q.columns ? rowsOf(q) : []);
  const cik = cikOf(q.sec_url, f.row.cik);
  const out: Record<string, unknown> = {};
  if (stamp) STAMP.set(out, stamp);
  const equityTotal = holdings.filter(isEquity).reduce((s: number, h: { value?: number }) => s + (h.value || 0), 0);
  const allTotal = q.total_value ?? holdings.reduce((s: number, h: { value?: number }) => s + (h.value || 0), 0);
  const main = q.accession ? await filingMeta(env, cik, q.accession) : null;
  const merged = ((q.amendments ?? []) as unknown[]).map((a) => (typeof a === 'string' ? a : (a as { accession?: string })?.accession)).filter(Boolean) as string[];
  // A mislabeled amendment: a 13F-HR/A marked NEW HOLDINGS that re-files the whole book. The lineage's own rule
  // decides it: when the served book is such an amendment, the original is superseded and the amendment is
  // mislabeled. Ingest's filings[] can also mark one. Null when neither the lineage nor the trail can be read.
  const trail = Array.isArray(q.filings) ? (q.filings as { accession?: string; mislabeled_amendment?: boolean }[]) : null;
  const lineage = await versionsFor(env, cik, q.report_date ?? quarterEnd(quarter), q.accession ?? null, merged);
  const replaced = new Set((lineage ?? []).filter((v) => v.status === 'current' && v.form === '13F-HR/A' && v.amendment_type !== 'RESTATEMENT' && lineage!.some((o) => o.status === 'superseded')).map((v) => v.accession));
  const mislabeled = (acc: string | null | undefined) =>
    !lineage && !trail && q.mislabeled_amendment == null
      ? null
      : replaced.has(acc ?? '') || !!trail?.some((f) => f.accession === acc && f.mislabeled_amendment === true) || (acc === q.accession && q.mislabeled_amendment === true);
  const versions = lineage?.map((v) => ({ ...v, mislabeled_amendment: mislabeled(v.accession) })) ?? null;
  // Amendments: every 13F-HR/A EDGAR has for the period, whatever its type and including a served
  // restatement (not only those the data run merged); versions[] adds the original.
  const amendments = versions ? versions.filter((v) => v.form.endsWith('/A')).map((v) => v.accession) : (q.amendments ?? []);
  return Object.assign(out, {
    filer: f.curated ? { slug: f.row.slug, cik: f.row.cik, name: f.row.name, manager: f.row.manager, curated: true } : { slug: f.row.slug, cik: f.row.cik, name: f.row.name, manager: null, curated: false },
    quarter: q.quarter ?? quarter,
    report_date: q.report_date ?? quarterEnd(quarter),
    filing: {
      accession: q.accession ?? null,
      filer_cik: pad(q.filer_cik ?? cik),
      form: q.form ?? '13F-HR',
      filing_date: q.filing_date ?? null,
      accepted_at: noMs(main?.accepted_at),
      sec_url: q.sec_url ?? null,
      amendment_type: main?.amendment_type ?? null,
      mislabeled_amendment: mislabeled(q.accession),
      amendments: (await amendmentsOf(env, cik, amendments)).map((a) => ({ ...a, mislabeled_amendment: mislabeled(a.accession) })),
      versions,
    },
    prev_quarter: q.prev_quarter ?? null,
    total_value_usd: Math.round(q.total_value ?? holdings.reduce((s: number, h: { value?: number }) => s + (h.value || 0), 0)),
    position_count: q.position_count ?? holdings.length,
    // A public shard holds the top 500 positions by value until the full book is in R2.
    truncated: Boolean(q.truncated ?? (q.position_count != null && q.position_count > holdings.length)),
    holdings: holdings.map((h: unknown) => position(h, equityTotal, allTotal)),
    exited: (q.exited ?? []).map((h: unknown) => position(h, equityTotal, allTotal)),
  });
}

/** Superseded and original books: the data run's copy in R2 (v/{cik}/{accession}.json), else EDGAR when the table is small. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function versionHoldings(env: Env, cik: string, v: Version): Promise<any[] | null> {
  const obj = await env.HIST.get(`v/${pad(cik)}/${v.accession}.json`);
  if (obj) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = (await new Response(obj.body).json()) as any;
    const rows = b.holdings ?? (b.columns ? rowsOf(b) : null);
    const st = stampOf(obj);
    if (rows && st) STAMP.set(rows, st);
    return rows;
  }
  const f = await fetch13F(cik, v.accession);
  if (!f?.holdings) return null;
  // Filings made before 2023-01-03 report value in thousands.
  const scale = (v.filed_on ?? '9999') < '2023-01-03' ? 1000 : 1;
  const rows = f.holdings.map((p) => ({ ...p, value: p.value * scale, ticker: null as string | null, display_name: null as string | null }));
  await lookupTickers(env, rows);
  return rows.sort((a, b) => b.value - a.value);
}

/** The book as it stood at one filing (?version=original or an accession), or an error response. */
async function versionBook(env: Env, book: Record<string, unknown>, version: string): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filing = book.filing as any;
  const versions = filing.versions as Version[] | null;
  if (!versions) return v1error('server_error', 503, 'EDGAR filing list unavailable; retry shortly.');
  const v = version === 'original' ? versions.find((x) => x.form === '13F-HR') : versions.find((x) => x.accession === version);
  if (!v) return v1error('not_found', 404, `No such filing for this period; see filing.versions (${versions.map((x) => x.accession).join(', ')}).`);
  if (v.status === 'current' && !versions.some((x) => x.status === 'merged')) return v1json({ ...(STAMP.get(book) ?? {}), data: { ...book, version: v.accession } });
  const rows = await versionHoldings(env, filing.filer_cik, v);
  if (!rows) return v1error('not_yet_available', 501, `The book as filed in ${v.accession} is too large to read live; it is served once the data run publishes superseded books.`);
  const equityTotal = rows.filter(isEquity).reduce((s: number, h: { value?: number }) => s + (h.value || 0), 0);
  const dir = `https://www.sec.gov/Archives/edgar/data/${Number(filing.filer_cik)}/${v.accession.replace(/-/g, '')}/`;
  return v1json({
    ...(STAMP.get(rows) ?? {}),
    data: {
      ...book,
      version: v.accession,
      filing: { ...filing, accession: v.accession, form: v.form, filing_date: v.filed_on, accepted_at: v.accepted_at, amendment_type: v.amendment_type, sec_url: `${dir}${v.accession}-index.html`, amendments: [] },
      total_value_usd: Math.round(rows.reduce((s: number, h: { value?: number }) => s + (h.value || 0), 0)),
      position_count: rows.length,
      truncated: false,
      // As filed in that one filing: no changes against the prior quarter.
      holdings: rows.map((h: unknown) => position(h, equityTotal, rows.reduce((s: number, h: { value?: number }) => s + (h.value || 0), 0))),
      exited: [],
    },
  });
}

const latestOf = (f: Filer) => (f.curated ? f.row.latest_quarter : f.row.quarter);
const MAX_RANGE = 8;

/** The 6-character issuer code for a ticker or CUSIP, from the public stock list (string search, no full parse). */
export async function issuerCode(env: Env, id: string): Promise<{ code: string; ticker: string | null } | null> {
  const up = id.toUpperCase();
  if (/^[0-9A-Z]{8}[0-9]$/.test(up) || /^[0-9A-Z]{6}$/.test(up)) {
    if (/^[A-Z]{1,6}$/.test(up)) {
      // Six letters could be a ticker; fall through to the ticker lookup first.
    } else return { code: up.slice(0, 6), ticker: null };
  }
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(up)) return null;
  // The precomputed ticker -> issuer map (90 KB) instead of scanning the 3.5 MB stock list.
  const pre = await env.HIST.get('pre/stock-codes.json');
  if (pre) {
    const text = await new Response(pre.body).text();
    const at = text.indexOf(`"${up}":"`);
    return at >= 0 ? { code: text.slice(at + up.length + 4, at + up.length + 10), ticker: up } : /^[0-9A-Z]{6}$/.test(up) ? { code: up, ticker: null } : null;
  }
  const res = await fetch(`${env.DATA_URL}stock_holders.json`, { cf: { cacheTtl: 3600 } } as RequestInit);
  if (!res.ok) return null;
  const m = (await res.text()).match(new RegExp(`"issuer":"([0-9A-Z]{6})","ticker":"${up.replace(/[.-]/g, '\\$&')}"`));
  return m ? { code: m[1], ticker: up } : /^[0-9A-Z]{6}$/.test(up) ? { code: up, ticker: null } : null;
}

/**
 * Filer types in the holder index (and changes/{q}.json), ingest's filer_types.json. Ingest is renaming
 * active to long_only and adding sovereign and insurance; both names match during the switch.
 */
/** A filer type in /v1's enum: ingest's names, with active (long_only's old name) and broker (other) mapped. */
export const normType = (t: string | null | undefined): string | null => (t == null ? null : ({ active: 'long_only', broker: 'other' } as Record<string, string>)[t] ?? t);
export const FILER_TYPES = ['hedge_fund', 'long_only', 'active', 'smart_money', 'index', 'bank', 'insurance', 'wealth', 'pension', 'sovereign', 'other'];
const SAME_TYPE: Record<string, string> = { active: 'long_only', long_only: 'active' };

/** The page's staleness rule: a holder is current when its latest 13F is for the newest ended quarter or the one before. */
export function currentQuarters(now: number): [string, string] {
  const d = new Date(now);
  const q = Math.floor(d.getUTCMonth() / 3);
  const y = d.getUTCFullYear();
  const newest = q === 0 ? `${y - 1}Q4` : `${y}Q${q}`;
  const [ny, nq] = newest.split('Q').map(Number);
  return [newest, nq === 1 ? `${ny - 1}Q4` : `${ny}Q${nq - 1}`];
}

/** A row that holds something: an exit (0 shares, $0, equity or options) is no holder. */
export const holds = (r: { shares: number; value_usd: number; change?: string | null }) => r.change !== 'exited' && ((r.shares ?? 0) > 0 || (r.value_usd ?? 0) > 0);
/** Distinct filers with a nonzero position among rows. */
export const filerCount = (rows: HolderRow[]) => new Set(rows.filter(holds).map((r) => r.filer.cik)).size;

/**
 * A holder list split the way /v1 and the member route return it: `holders` are current share (SH)
 * positions, or shares and options mixed with include_options=true; `options` the call and put rows;
 * `exited` the filers whose latest book left the position (0 shares). `filers` counts distinct filers
 * with a nonzero position among `holders`, `count` the rows in it.
 */
export function splitHolders(rows: HolderRow[], includeOptions: boolean) {
  const live = rows.filter(holds);
  const holders = includeOptions ? live : live.filter((r) => !r.put_call);
  const options = live.filter((r) => !!r.put_call);
  const exited = rows.filter((r) => !holds(r));
  const optionCount = (pc: string) => ({ rows: options.filter((r) => r.put_call === pc).length, filers: new Set(options.filter((r) => r.put_call === pc).map((r) => r.filer.cik)).size });
  return { holders, options, exited, count: holders.length, filers: filerCount(holders), options_count: { calls: optionCount('CALL'), puts: optionCount('PUT') }, exited_count: exited.length };
}

export interface HolderRow {
  filer: { cik: string; name: string; slug: string | null; type: string | null; curated: boolean | null };
  period: string | null;
  kind: string;
  /** Call or Put for an options row, null for shares (`kind` says the same: equity, calls, puts). */
  put_call: string | null;
  shares: number;
  prev_shares: number | null;
  share_change: number | null;
  value_usd: number;
  prev_value_usd: number | null;
  change: string | null;
  /** The position's share of the filer's whole 13F book that period; null when that total isn't known. */
  weight: number | null;
  accession: string | null;
  accepted_at: string | null;
}

/**
 * The quarters a non-curated filer's full book is stored for (fb/{quarter}/{cik}.json, what the holdings route serves),
 * newest first, listed once an hour per isolate. API host only: the Worker's bucket holds no full books (its failover
 * serves the latest quarter, so its rows keep that one), and 50+ list calls would pass the free plan's subrequest cap.
 */
let STORED: { at: number; by: Map<string, string[]> } | null = null;
async function storedQuarters(env: Env, latest: string): Promise<Map<string, string[]> | null> {
  if (env.MOVED_TO) return null;
  if (STORED && Date.now() - STORED.at < 3600_000) return STORED.by;
  const by = new Map<string, string[]>();
  try {
    for (let q = latest; q >= '2013Q2'; q = prevQuarter(q)) {
      let cursor: string | undefined;
      do {
        const r = await env.HIST.list({ prefix: `fb/${q}/`, cursor });
        for (const o of r.objects) {
          const cik = o.key.slice(`fb/${q}/`.length).replace(/\.json$/, '');
          if (!by.has(cik)) by.set(cik, []);
          by.get(cik)!.push(q);
        }
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
    }
  } catch {
    return STORED?.by ?? null;
  }
  STORED = { at: Date.now(), by };
  return by;
}
const prevQuarter = (q: string) => (q[5] === '1' ? `${Number(q.slice(0, 4)) - 1}Q4` : `${q.slice(0, 5)}${Number(q[5]) - 1}`);

/** Ingest's type for every 13F filer by CIK (filer_types.json, ~9,000 CIKs), read once an hour per isolate. */
let TYPES: { at: number; by: Map<string, string> } | null = null;
async function filerTypes(env: Env): Promise<Map<string, string>> {
  if (TYPES && Date.now() - TYPES.at < 3600_000) return TYPES.by;
  try {
    const text = await dataText(env, 'filer_types.json');
    // Not loaded yet (a slow link): rows fall back to their own type, and the next request tries again.
    if (!text) return TYPES?.by ?? new Map();
    const d = JSON.parse(text) as { filers?: Record<string, { type?: string }> };
    TYPES = { at: Date.now(), by: new Map(Object.entries(d?.filers ?? {}).filter(([, v]) => v?.type).map(([k, v]) => [pad(k), v.type!])) };
  } catch {
    TYPES = { at: Date.now(), by: TYPES?.by ?? new Map() };
  }
  return TYPES.by;
}

/**
 * EDGAR acceptance times for holder rows' accessions, every filer (not only curated): R2 data/accepted.json
 * ({accession: ISO UTC}, '' for an accession EDGAR doesn't have), filled by gene's cron (fillAccepted) for the
 * issuers requests queued (data/accepted-queue.json). Requests only read it, so it never slows a request.
 */
let ACCEPTED: { at: number; by: Record<string, string> } | null = null;
async function acceptedMap(env: Env, fresh = false): Promise<Record<string, string>> {
  if (!fresh && ACCEPTED && Date.now() - ACCEPTED.at < 120_000) return ACCEPTED.by;
  try {
    const obj = await env.HIST.get('data/accepted.json');
    ACCEPTED = { at: Date.now(), by: obj ? ((await new Response(obj.body).json()) as Record<string, string>) : (ACCEPTED?.by ?? {}) };
  } catch {
    ACCEPTED = { at: Date.now(), by: ACCEPTED?.by ?? {} };
  }
  return ACCEPTED.by;
}
/** 0001234567-26-000123, whatever form a row carries (no dashes too). */
const dashed = (a: string) => {
  const d = a.replace(/\D/g, '');
  return d.length === 18 ? `${d.slice(0, 10)}-${d.slice(10, 12)}-${d.slice(12)}` : a;
};
const QUEUE = 'data/accepted-queue.json';
/** Issuers this isolate queued lately: one queue write per issuer per 10 minutes. */
const queuedAt = new Map<string, number>();
async function queueAccepted(env: Env, code: string): Promise<void> {
  if (Date.now() - (queuedAt.get(code) ?? 0) < 600_000) return;
  queuedAt.set(code, Date.now());
  const obj = await env.HIST.get(QUEUE);
  const q = obj ? ((await new Response(obj.body).json()) as string[]) : [];
  if (!q.includes(code)) await env.HIST.put(QUEUE, JSON.stringify([...q, code].slice(-500)));
}

/**
 * gene's cron: acceptance times from EDGAR (each filing's index headers) for the queued issuers' rows that have an
 * accession but no accepted_at. At most `max` reads a run, about 8 a second (SEC's limit is 10).
 */
let filling = false;
export async function fillAccepted(env: Env, max = 300, budgetMs = 40_000): Promise<Record<string, unknown>> {
  if (filling) return { status: 'already running' };
  const qObj = await env.HIST.get(QUEUE);
  const queue = qObj ? ((await new Response(qObj.body).json()) as string[]) : [];
  if (!queue.length) return { queued: 0 };
  filling = true;
  const t0 = Date.now();
  const known = { ...(await acceptedMap(env, true)) };
  let fetched = 0;
  let errors = 0;
  const left: string[] = [];
  try {
    for (const code of queue) {
      const obj = (await env.HIST.get(`hl/${code}.json`)) ?? (await env.HIST.get(`s/${code}.json`));
      if (!obj) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = await new Response(obj.body).json();
      const todo = new Map<string, string>();
      for (const r of rowsOf({ columns: d.columns, rows: d.rows ?? d.holders ?? [] })) {
        if (!r.accession || r.accepted_at || r.cik == null) continue;
        const a = dashed(String(r.accession));
        if (!(a in known)) todo.set(a, String(Number(r.cik)));
      }
      const work = [...todo].slice(0, Math.max(0, max - fetched));
      // Four at a time, each at most 2 a second.
      for (let i = 0; i < work.length && Date.now() - t0 < budgetMs; i += 4) {
        const started = Date.now();
        await Promise.all(work.slice(i, i + 4).map(async ([a, cik]) => {
          try {
            const r = await fetch(`https://www.sec.gov/Archives/edgar/data/${cik}/${a.replace(/-/g, '')}/${a}-index-headers.html`, { headers: { 'user-agent': SEC_UA }, signal: AbortSignal.timeout(10_000) });
            fetched++;
            if (r.status === 404) return void (known[a] = '');
            if (!r.ok) return void errors++;
            const m = (await r.text()).match(/<ACCEPTANCE-DATETIME>\s*(\d{14})/);
            known[a] = m ? easternToUtc(m[1]) : '';
          } catch {
            errors++;
          }
        }));
        await new Promise((r) => setTimeout(r, Math.max(0, 500 - (Date.now() - started))));
      }
      if ([...todo.keys()].some((a) => !(a in known))) left.push(code);
    }
    await env.HIST.put('data/accepted.json', JSON.stringify(known), { httpMetadata: { contentType: 'application/json' } });
    ACCEPTED = { at: Date.now(), by: known };
    // Requests may have queued more meanwhile: keep those too.
    const now = await env.HIST.get(QUEUE);
    const added = now ? ((await new Response(now.body).json()) as string[]).filter((c) => !queue.includes(c)) : [];
    await env.HIST.put(QUEUE, JSON.stringify([...left, ...added]));
    return { fetched, errors, issuers_left: left.length + added.length, known: Object.keys(known).length };
  } finally {
    filling = false;
  }
}

/**
 * Every 13F filer holding one issuer in its latest full book: R2 hl/{issuer6}.json (all rows, uploaded by
 * the data run), else the older single-period s/{issuer6}.json. Largest first. Curated funds' rows carry
 * their 13F's accession and EDGAR acceptance when cached; weight comes from the row, else a curated fund's total.
 */
export async function holdersOf(env: Env, code: string, timing: string[] = []): Promise<{ issuer: string; tickers: string[]; display_name: string | null; period: string | null; prev_period: string | null; counts: Record<string, unknown> | null; rows: HolderRow[]; truncated: boolean; stamp?: Stamp; source: 'hl' | 's' | 'public' } | null> {
  let t = Date.now();
  const mark = (name: string) => (timing.push(`${name};dur=${Date.now() - t}`), (t = Date.now()));
  const hl = await env.HIST.get(`hl/${code}.json`);
  const obj = hl ?? (await env.HIST.get(`s/${code}.json`));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let d: any;
  if (obj) d = await new Response(obj.body).json();
  else {
    // Until the full list is in R2: the public file's top 25 holders, marked truncated.
    const res = await fetch(`${env.DATA_URL}hl/${code}.json`, { cf: { cacheTtl: 900 } } as RequestInit);
    if (!res.ok) return null;
    d = await res.json();
  }
  mark('read');
  const cur = new Map((await filers(env)).map((f) => [f.cik, f]));
  mark('filers');
  const types = await filerTypes(env);
  mark('types');
  const rows = rowsOf({ columns: d.columns, rows: d.rows ?? d.holders ?? [] }).map((h): HolderRow => {
    const cik = pad(String(h.cik));
    const c = cur.get(cik);
    const period = h.period ?? d.period ?? null;
    const latest = c && period && c.latest_quarter === period;
    const total = latest ? c.total_value_usd : null;
    return {
      filer: { cik, name: h.name, slug: h.slug ?? c?.slug ?? null, type: normType(types.get(cik) ?? h.type ?? c?.type ?? null), curated: h.curated ?? (c ? true : null) },
      period,
      kind: h.kind ?? (h.put_call ? `${String(h.put_call).toLowerCase()}s` : 'equity'),
      // As EDGAR writes it: PUT or CALL.
      put_call: h.put_call ? String(h.put_call).toUpperCase() : h.kind === 'calls' ? 'CALL' : h.kind === 'puts' ? 'PUT' : null,
      shares: h.shares,
      prev_shares: h.prev_shares ?? null,
      share_change: h.prev_shares == null ? null : h.shares - h.prev_shares,
      value_usd: h.value,
      prev_value_usd: h.prev_value ?? null,
      change: h.change ?? null,
      weight: !h.shares && !h.value ? null : (h.weight ?? (total && h.value != null ? Math.round((h.value / total) * 1e6) / 1e6 : null)),
      accession: h.accession ?? (latest ? c.latest_accession : null) ?? null,
      accepted_at: noMs(h.accepted_at) ?? null,
    };
  });
  // Acceptance for every row with an accession: gene's EDGAR-filled map (any filer), then the curated per-filing
  // cache. What neither has is queued for gene's cron; the request never waits on EDGAR.
  const known = await acceptedMap(env);
  for (const r of rows) if (r.accession && !r.accepted_at) r.accepted_at = known[dashed(r.accession)] || null;
  const accs = [...new Set(rows.filter((r) => r.accession && !r.accepted_at).map((r) => r.accession!))].slice(0, 60);
  const metas = await Promise.all(accs.map(async (a) => [a, (JSON.parse((await env.DB.get(`filing:${a}`)) ?? 'null') as FilingMeta | null)?.accepted_at ?? null] as const));
  const at = new Map(metas);
  for (const r of rows) if (r.accession && !r.accepted_at) r.accepted_at = noMs(at.get(r.accession) ?? null);
  if (obj && rows.some((r) => r.accession && !r.accepted_at && !(dashed(r.accession) in known))) await queueAccepted(env, code).catch(() => undefined);
  mark('rows');
  rows.sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0));
  return { issuer: d.issuer ?? code, tickers: d.tickers ?? (d.ticker ? [d.ticker] : []), display_name: d.display_name ?? null, period: d.period ?? null, prev_period: d.prev_period ?? null, counts: d.counts ?? null, rows, truncated: !obj && (d.rows_total ?? rows.length) > rows.length, stamp: stampOf(obj), source: obj ? (hl ? 'hl' : 's') : 'public' };
}

/**
 * type= (comma list of FILER_TYPES; type=hedge_fund,active is the stock page's lens), cohort= (all|curated)
 * and current_only= (default true: the page's rule, latest 13F for the newest ended quarter or the one before)
 * on a holder list; null when invalid.
 */
export function holderFilter(p: URLSearchParams, now = Date.now()): ((r: HolderRow) => boolean) | null {
  const types = p.get('type')?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
  const cohort = p.get('cohort') ?? 'all';
  const cur = p.get('current_only') ?? 'true';
  if (types.some((t) => !FILER_TYPES.includes(t)) || !['all', 'curated'].includes(cohort) || !['true', 'false'].includes(cur) || !['true', 'false', null].includes(p.get('include_options'))) return null;
  // smart_money is ingest's hedge_fund + long_only; active is long_only's retired name, still accepted.
  const want = new Set(types.flatMap((t) => (t === 'smart_money' ? ['hedge_fund', 'long_only', 'active'] : [t, SAME_TYPE[t] ?? t])));
  const quarters = currentQuarters(now);
  return (r) => (!types.length || want.has(r.filer.type ?? '')) && (cohort === 'all' || r.filer.curated === true) && (cur === 'false' || !r.period || quarters.includes(r.period));
}

ROUTES.push(
  ['GET', /^\/v1\/filers$/, async ({ env, url }) => {
    // Curated filers first (with their history), then every other filer the data run parsed; paged like the other
    // list routes (limit 1-1000, default 500; offset).
    const p = url.searchParams;
    const want = p.get('curated');
    const limit = Number(p.get('limit') ?? 500);
    const offset = Number(p.get('offset') ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return v1error('bad_request', 400, `limit must be an integer from 1 to 1000 (got ${p.get('limit')}); page with offset.`);
    if (!Number.isInteger(offset) || offset < 0) return v1error('bad_request', 400, `offset must be an integer from 0 (got ${p.get('offset')}).`);
    const curated = (await filers(env)).map(({ type, ...f }) => ({ ...f, curated: true, ...(type ? { type } : { type: null }) }));
    const seen = new Set(curated.map((f) => f.cik));
    let rest: { cik: string }[] = [];
    if (want !== 'true') {
      // The hourly precompute (a count line, then the rows), else the full filer list.
      const pre = await env.HIST.get('pre/v1-filers-rest.txt');
      if (pre) {
        const text = await new Response(pre.body).text();
        rest = (JSON.parse(text.slice(text.indexOf('\n') + 1)) as { cik: string }[]).filter((f) => !seen.has(f.cik));
      } else {
        const text = await filersJson(env);
        if (!text) return v1error('server_error', 503, 'The filer list is unavailable; retry shortly.');
        rest = ((JSON.parse(text) as { filers: AllFiler[] }).filers ?? [])
          .filter((f) => f.ok && !seen.has(f.cik))
        .map((f) => ({ slug: f.slug, cik: f.cik, name: f.name, manager: null, featured: false, status: null, latest_quarter: f.quarter, latest_report_date: f.quarter ? quarterEnd(f.quarter) : null, latest_filing_date: f.filing_date, latest_accession: null, total_value_usd: null, position_count: f.position_count, history_quarters: f.quarter ? [f.quarter] : [], curated: false, type: normType(f.type) }));;
      }
    }
    // Each filer's type from filer_types.json (as holders reads it), so hand-checked overrides and reclasses apply here
    // too; the row's own type only where that file has none.
    const types = await filerTypes(env);
    // A non-curated filer's history_quarters: every quarter the holdings route serves for it (stored full books, plus its
    // latest from the public shard), newest first.
    const latestQ = rest.reduce((m, f) => { const q = (f as { latest_quarter?: string | null }).latest_quarter ?? ''; return q > m ? q : m; }, '');
    const stored = latestQ ? await storedQuarters(env, latestQ) : null;
    const withQuarters = <T extends { cik: string; curated?: boolean; latest_quarter?: string | null; history_quarters?: string[] }>(f: T): T =>
      f.curated || !stored ? f : { ...f, history_quarters: [...new Set([...(stored.get(pad(f.cik)) ?? []), ...(f.latest_quarter ? [f.latest_quarter] : [])])].sort().reverse() };
    const typed = (f: { cik: string; type?: string | null }) => withQuarters(types.has(pad(f.cik)) ? { ...f, type: normType(types.get(pad(f.cik))!) } : f);
    const all = (want === 'false' ? rest : want === 'true' ? curated : [...curated, ...rest]).map(typed);
    return v1json({ data: all.slice(offset, offset + limit), count: all.length, next_offset: offset + limit < all.length ? offset + limit : null });
  }],
  ['GET', /^\/v1\/filers\/([^/]+)\/holdings\/([^/]+)$/, async ({ env, url }, [id, qp]) => {
    if (url.searchParams.has('as_of')) {
      return v1error('not_yet_available', 501, 'as_of (point-in-time reconstruction) is coming; this endpoint currently returns the book as now known, with amendments merged.');
    }
    if (qp !== 'latest' && !QUARTER.test(qp)) return v1error('bad_request', 400, 'quarter must look like 2025Q1, or be latest.');
    const f = await resolveAny(env, id);
    if (!f) return v1error('not_found', 404, 'No such filer (use a slug from /v1/filers or a CIK).');
    const quarter = qp === 'latest' ? latestOf(f) : qp;
    const book = quarter ? await bookFor(env, f, quarter) : null;
    if (!book) return v1error('not_found', 404, `No ${qp} 13F for ${f.row.slug}; latest is ${latestOf(f) ?? 'none'}.`);
    const version = url.searchParams.get('version');
    if (version && version !== 'original' && !/^\d{10}-\d{2}-\d{6}$/.test(version)) return v1error('bad_request', 400, 'version is original or an accession like 0001104659-26-097200.');
    return version ? versionBook(env, book, version) : v1json({ ...(STAMP.get(book) ?? {}), data: book });
  }],
  ['GET', /^\/v1\/filers\/([^/]+)\/holdings$/, async ({ env, url }, [id]) => {
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!QUARTER.test(from) || !QUARTER.test(to) || from > to) return v1error('bad_request', 400, 'from and to must be quarters like 2025Q1, from <= to.');
    const f = await resolveAny(env, id);
    if (!f) return v1error('not_found', 404, 'No such filer (use a slug from /v1/filers or a CIK).');
    const quarters: string[] = [];
    for (let q = from; q <= to && quarters.length < MAX_RANGE; q = nextQuarter(q)) quarters.push(q);
    const last = quarters[quarters.length - 1];
    const data = [];
    const missing = [];
    for (const q of quarters) {
      if (f.curated && !f.row.history_quarters.includes(q) && q !== f.row.latest_quarter) {
        missing.push(q);
        continue;
      }
      const b = await bookFor(env, f, q);
      if (b) data.push(b);
      else missing.push(q);
    }
    // At most 8 quarters per call; `next_from` continues the range.
    // Books read from different builds: the response names the oldest (each changes when its source is re-uploaded).
    const stamps = data.map((b) => STAMP.get(b)).filter((x): x is Stamp => !!x).sort((a, b) => (a.data_built_at ?? '').localeCompare(b.data_built_at ?? ''));
    return v1json({ ...(stamps[0] ?? {}), data, missing, next_from: last < to ? nextQuarter(last) : null });
  }],
  ['GET', /^\/v1\/stocks\/([^/]+)\/holders$/, async ({ env, url }, [id]) => {
    const p = url.searchParams;
    const quarter = p.get('quarter');
    const limit = Number(p.get('limit') ?? 100);
    const offset = Number(p.get('offset') ?? 0);
    const keep = holderFilter(p);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return v1error('bad_request', 400, `limit must be an integer from 1 to 1000 (got ${p.get('limit')}); page with offset.`);
    if (!Number.isInteger(offset) || offset < 0) return v1error('bad_request', 400, `offset must be an integer from 0 (got ${p.get('offset')}).`);
    if ((quarter && !QUARTER.test(quarter)) || !keep) {
      return v1error('bad_request', 400, `quarter like 2026Q2; type: ${FILER_TYPES.join(', ')} (comma-separated); cohort: all or curated; current_only: true or false; limit 1-1000; offset from 0.`);
    }
    const t0 = Date.now();
    const is = await issuerCode(env, decodeURIComponent(id));
    if (!is) return v1error('not_found', 404, 'No such ticker or CUSIP among 13F holdings.');
    const timing = [`issuer;dur=${Date.now() - t0}`];
    const h = await holdersOf(env, is.code, timing);
    if (!h) return v1error('not_found', 404, `No 13F filer reports holding ${is.ticker ?? is.code} in its latest book.`);
    // Each filer's latest full book: periods differ by filer (a fund that filed its Q3 13F shows Q3).
    const rows = h.rows.filter((r) => keep(r) && (!quarter || r.period === quarter));
    const sp = splitHolders(rows, p.get('include_options') === 'true');
    const data = { issuer: h.issuer, ticker: is.ticker ?? h.tickers[0] ?? null, tickers: h.tickers, display_name: h.display_name, cohort: p.get('cohort') ?? 'all', type: p.get('type') ?? null, counts: h.counts, truncated: h.truncated, holders: sp.holders.slice(offset, offset + limit), options: sp.options, exited: sp.exited };
    return v1json({ ...(h.stamp ?? {}), data, count: sp.count, filers: sp.filers, options_count: sp.options_count, exited_count: sp.exited_count, next_offset: offset + limit < sp.count ? offset + limit : null }, 200, { 'server-timing': timing.join(', ') });
  }],
  ['GET', /^\/v1\/bulk$/, async ({ env, req, url }) => {
    // Persistent per-quarter exports of every filer's book, uploaded by the data run. Every field comes from the stored
    // object itself (size, ETag, the sha256 stamped at upload); a download link serves exactly these bytes or the file
    // streams from here. Only files that pass a size check: a stub (a failed run) is hidden until regenerated.
    const { bulkFiles } = await import('./download');
    const data = (await bulkFiles(env, MIN_BULK_BYTES)).map((o) => ({ file: o.key.slice('bulk/'.length), quarter: o.key.slice(5, 11), bytes: o.bytes, etag: o.etag, sha256: o.sha256, uploaded_at: noMs(o.uploaded.toISOString()), url: `${linkBase(env, req, url)}/v1/${o.key}` }));
    return v1json({ data: data.sort((a: { file: string }, b: { file: string }) => b.file.localeCompare(a.file)) });
  }],
  ['GET', /^\/v1\/bulk\/(\d{4}Q[1-4]\.(?:csv\.gz|parquet))$/, async ({ env }, [file]) => {
    // A 302 to a 5-minute presigned URL on the account's R2 endpoint (a stable, fast host to allowlist), only when the
    // bucket's copy is the listed file (same size and sha256). Otherwise it streams from here and the mirror is redone.
    const { bulkFiles, servedHead, sameFile, mirrorSoon } = await import('./download');
    const f = (await bulkFiles(env, MIN_BULK_BYTES)).find((o) => o.key === `bulk/${file}`);
    if (f && env.CF_API_TOKEN && env.CF_ACCOUNT_ID) {
      if (sameFile(f, await servedHead(env, f.key))) {
        const { presignGet } = await import('./failover');
        const loc = await presignGet(env, f.key, 300, { 'response-content-disposition': `attachment; filename="copybook-13f-${file}"` }).catch(() => null);
        if (loc) return new Response(null, { status: 302, headers: { location: loc, 'cache-control': 'no-store', ...(f.etag ? { etag: `"${f.etag}"` } : {}) } });
      } else mirrorSoon(env, f.key);
    }
    const obj = await env.HIST.get(`bulk/${file}`);
    if (!obj || (obj.size ?? 0) < MIN_BULK_BYTES) return v1error('not_yet_available', 501, `Coming: bulk export ${file} is not published yet${obj ? ' (the uploaded file failed its size check and waits to be regenerated)' : ''}. Parquet is coming; csv.gz is live for the quarters GET /v1/bulk lists.`);
    // RFC 9530 Repr-Digest, so a client can check the bytes without the listing (the R2 link sends x-amz-meta-sha256).
    const sha = f?.sha256 ?? obj.customMetadata?.sha256;
    const digest: Record<string, string> = sha ? { 'repr-digest': `sha-256=:${btoa(String.fromCharCode(...(sha.match(/../g) ?? []).map((h) => parseInt(h, 16))))}:`, 'x-amz-meta-sha256': sha } : {};
    return new Response(obj.body, {
      headers: { ...digest, 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'content-disposition': `attachment; filename="copybook-13f-${file}"`, ...(obj.size != null ? { 'content-length': String(obj.size) } : {}), 'cache-control': 'private, max-age=3600', 'access-control-allow-origin': '*' },
    });
  }],
  ['GET', /^\/v1\/events$/, async ({ env, url }) => {
    const p = url.searchParams;
    const kinds = p.get('form')?.toLowerCase().split(',').map((x) => ({ '4': 'form4', 'form4': 'form4', '13d': '13d', '13g': '13g', 'sc13d': '13d', 'sc13g': '13g' })[x.trim().replace(/[^a-z0-9]/g, '')]);
    const from = p.get('from');
    const to = p.get('to');
    const limit = Number(p.get('limit') ?? 100);
    const offset = Number(p.get('offset') ?? 0);
    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return v1error('bad_request', 400, `limit must be an integer from 1 to 500 (got ${p.get('limit')}); page with offset.`);
    if (!Number.isInteger(offset) || offset < 0) return v1error('bad_request', 400, `offset must be an integer from 0 (got ${p.get('offset')}).`);
    if (kinds && kinds.some((k) => !k)) return v1error('bad_request', 400, `form must be form4, 13d or 13g, comma-separated (got ${p.get('form')}).`);
    // A real calendar date: 2026-13-01 and 2026-02-30 are refused, not read as empty ranges.
    const realDate = (d: string) => date.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
    for (const [k, v] of [['from', from], ['to', to]] as const) if (v && !(date.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && realDate(v))) return v1error('bad_request', 400, `${k} must be a filing date as YYYY-MM-DD (got ${v}).`);
    if (from && to && from > to) return v1error('bad_request', 400, `from (${from}) is after to (${to}).`);
    let filerSlug: string | null = null;
    let filerCik: string | null = null;
    const filer = p.get('filer');
    if (filer) {
      const f = await resolveAny(env, filer);
      if (!f) return v1error('not_found', 404, 'No such filer (use a slug from /v1/filers or a CIK).');
      filerSlug = f.row.slug;
      filerCik = f.row.cik;
    }
    // ticker= and tickers= (up to 20, comma-separated): also every Form 4 by the issuer's own insiders and
    // every 13D/G any filer made on it, read from the issuer's EDGAR feeds (the same data as My book's /events).
    const tickers = [...new Set(`${p.get('tickers') ?? ''},${p.get('ticker') ?? ''}`.toUpperCase().split(',').map((t) => t.trim().replace('-', '.')).filter(Boolean))];
    if (tickers.length > 20 || tickers.some((t) => !/^[A-Z][A-Z0-9.]{0,9}$/.test(t))) return v1error('bad_request', 400, 'tickers: up to 20 comma-separated tickers like BRK.B.');
    const cusip = p.get('cusip')?.toUpperCase() ?? null;
    const issuerCik = p.get('issuer_cik') ? pad(p.get('issuer_cik')!) : null;
    // Every event the investor pages show, with acceptance, Item 4, classes and the previous stake read
    // from EDGAR (pre/events.json, built hourly by scripts/events.mts), overlaid with what the minute
    // poll parsed. Before the first build: the data run's 30-day events.json.
    const pre = await env.HIST.get('pre/events.json');
    const res = pre ? null : await fetch(`${env.DATA_URL}events.json`, { cf: { cacheTtl: 300 } } as RequestInit);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: any[] = pre ? (((await new Response(pre.body).json()) as { events?: unknown[] }).events ?? []) : res?.ok ? (((await res.json()) as { events?: unknown[] }).events ?? []) : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ring: any[] = JSON.parse((await env.DB.get('v1:events')) ?? '[]');
    const key = (e: { id: string; slug: string }) => `${e.id}|${e.slug}`;
    const polled = new Map(ring.map((e) => [key(e), e]));
    const inBase = new Set(base.map(key));
    // The poll's fields win where it has them; a null from the poll never blanks a value the build read.
    const over = (e: Record<string, unknown>) => ({ ...e, ...Object.fromEntries(Object.entries(polled.get(key(e as { id: string; slug: string })) ?? {}).filter(([, v]) => v !== null && v !== undefined)) });
    const all = [...base.map(over), ...ring.filter((e) => !inBase.has(key(e)))];
    const curated = all
      .map((e) => ({
        accession: e.id,
        form: e.form,
        kind: e.kind,
        action: e.action ?? null,
        filer: { slug: e.slug || null, cik: pad(cikOf(e.url, '0')) as string | null, name: e.manager ?? null },
        issuer: { name: e.issuer ?? null, cik: e.issuer_cik ?? null, ticker: e.ticker ?? null, cusip: e.cusip ?? null, display_name: e.display_name ?? null },
        filing_date: e.filing_date,
        accepted_at: noMs(e.accepted ?? e.accepted_at),
        event_date: e.event_date ?? null,
        last_transaction_date: e.kind === 'form4' ? (e.last_transaction_date ?? null) : null,
        source: 'filer' as 'filer' | 'issuer',
        shares: e.shares ?? null,
        value_usd: e.value_usd ?? null,
        avg_price: e.avg_price ?? null,
        shares_after: e.shares_after ?? null,
        percent_of_class: e.percent_of_class ?? null,
        ten_percent_owner: e.ten_percent_owner ?? null,
        amendment_no: e.amendment_no ?? null,
        prev: e.prev_accession || e.prev_percent_of_class != null ? { accession: e.prev_accession ?? null, form: e.prev_form ?? null, percent_of_class: e.prev_percent_of_class ?? null, shares_after: e.prev_shares_after ?? null } : null,
        classes: e.classes ?? null,
        purpose: cleanItem4(e.item4),
        insider: e.insider ?? null,
        details_pending: e.details_pending ?? false,
        sec_url: e.url,
      }));
    let coverage: Record<string, unknown> | undefined;
    let pending: string[] | undefined;
    const issuerRows: typeof curated = [];
    if (tickers.length) {
      const { stockEvents } = await import('./stockevents');
      // Every filing kept per ticker (not a page of it), so `coverage` describes exactly what is served.
      const r = await stockEvents(env, tickers, 50, { deadlineMs: 2000 });
      pending = r.pending;
      coverage = Object.fromEntries(tickers.map((t) => [t, r.tickers[t] ? { issuer_cik: r.tickers[t].cik, from: r.tickers[t].window, form4_from: r.tickers[t].from?.form4 ?? null, schedule13_from: r.tickers[t].from?.schedule13 ?? null, checked_at: r.tickers[t].checked_at } : null]));
      const have = new Map(curated.map((e) => [e.accession, e]));
      for (const [t, x] of Object.entries(r.tickers)) {
        for (const e of x.events) {
          const same = have.get(e.accession);
          if (same) {
            // A filer's own row for this Form 4: the dates just read from the filing win over an older build's.
            if (same.kind === 'form4' && e.event_date) Object.assign(same, { event_date: e.event_date, last_transaction_date: e.last_transaction_date });
            continue;
          }
          const f4 = e.form.startsWith('4');
          issuerRows.push({
            accession: e.accession,
            form: e.form,
            kind: f4 ? 'form4' : /13G/.test(e.form) ? '13g' : '13d',
            action: e.action,
            filer: { slug: null, cik: e.filer_cik, name: e.filer_name },
            issuer: { name: e.issuer, cik: x.cik, ticker: t, cusip: null, display_name: null },
            // The ET day EDGAR accepted it (feeds carry no filing date).
            filing_date: new Date(Date.parse(e.accepted_at) - 5 * 3600_000).toISOString().slice(0, 10),
            accepted_at: e.accepted_at,
            event_date: e.event_date,
            last_transaction_date: e.last_transaction_date,
            source: 'issuer',
            shares: e.shares,
            value_usd: e.value_usd,
            avg_price: e.price,
            shares_after: e.shares_after,
            percent_of_class: e.percent_of_class,
            ten_percent_owner: f4 ? /10% owner/.test(e.role ?? '') : null,
            amendment_no: null,
            prev: null,
            classes: e.classes ?? null,
            purpose: null,
            insider: f4 ? { name: e.filer_name, roles: (e.role ?? '').split(', ').filter(Boolean), ownership: e.ownership, open_market: e.open_market, codes: e.codes, totals: e.totals, transactions: e.transactions, trade_date: e.trade_date ?? null, filed_date: e.filed_date ?? null, pct_change: e.pct_change ?? null, has_other_codes: e.has_other_codes ?? [], exercise_and_sale: e.exercise_and_sale ?? false } : null,
            details_pending: false,
            sec_url: e.url,
          });
          have.set(e.accession, issuerRows[issuerRows.length - 1]);
        }
      }
    }
    const rows = [...curated, ...issuerRows]
      .filter(
        (e) =>
          (!kinds || kinds.includes(e.kind)) &&
          (!filerSlug || e.filer.slug === filerSlug || e.filer.cik === filerCik) &&
          (!tickers.length || tickers.includes(e.issuer.ticker ?? '')) &&
          (!cusip || (e.issuer.cusip ?? '').startsWith(cusip.slice(0, cusip.length >= 9 ? 9 : 6))) &&
          (!issuerCik || e.issuer.cik === issuerCik) &&
          (!from || e.filing_date >= from) &&
          (!to || e.filing_date <= to),
      )
      .sort((a, b) => (b.accepted_at ?? `${b.filing_date}T23`).localeCompare(a.accepted_at ?? `${a.filing_date}T23`) || b.accession.localeCompare(a.accession));
    const page = rows.slice(offset, offset + limit);
    return v1json({ data: page, count: rows.length, next_offset: offset + limit < rows.length ? offset + limit : null, ...(coverage ? { coverage, pending } : {}) });
  }],
  ['GET', /^\/v1\/changes\/([^/]+)$/, async ({ env, url }, [quarter]) => {
    const p = url.searchParams;
    const CHANGES = ['new', 'added', 'trimmed', 'exited'];
    const want = (p.get('change') ?? CHANGES.join(',')).split(',').map((x) => x.trim());
    const limit = Number(p.get('limit') ?? 100);
    const offset = Number(p.get('offset') ?? 0);
    const minValue = Number(p.get('min_value_usd') ?? 0);
    const cohort = p.get('cohort') ?? 'all';
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return v1error('bad_request', 400, `limit must be an integer from 1 to 1000 (got ${p.get('limit')}); page with offset.`);
    if (!Number.isInteger(offset) || offset < 0) return v1error('bad_request', 400, `offset must be an integer from 0 (got ${p.get('offset')}).`);
    if (!QUARTER.test(quarter) || want.some((c) => !CHANGES.includes(c)) || !Number.isFinite(minValue) || minValue < 0) {
      return v1error('bad_request', 400, 'quarter like 2026Q2; change: new, added, trimmed, exited (comma-separated); limit 1-1000; offset from 0; min_value_usd from 0.');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: any[];
    let source: string;
    let stamp: Stamp | undefined;
    const filer = p.get('filer');
    const stock = p.get('ticker') ?? p.get('cusip');
    if (filer) {
      // One filer: its book's change rows (exact, every position).
      const f = await resolveAny(env, filer);
      if (!f) return v1error('not_found', 404, 'No such filer (use a slug from /v1/filers or a CIK).');
      const book = await bookFor(env, f, quarter);
      if (!book) return v1error('not_found', 404, `No ${quarter} 13F for ${f.row.slug}.`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fl = book.filer as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = [...(book.holdings as any[]), ...(book.exited as any[])].filter((h) => h.change).map((h) => ({ filer: { cik: fl.cik, slug: fl.slug, name: fl.name, curated: fl.curated }, ...h }));
      stamp = STAMP.get(book);
      source = 'filer';
    } else if (stock) {
      // One stock: every 13F holder's change in it, from the holder index (each filer's latest book in that quarter).
      const is = await issuerCode(env, stock);
      if (!is) return v1error('not_found', 404, 'No such ticker or CUSIP among 13F holdings.');
      const h = await holdersOf(env, is.code);
      if (!h) return v1error('not_found', 404, `No 13F filer reports holding ${is.ticker ?? is.code} in its latest book.`);
      stamp = h.stamp;
      rows = h.rows.filter((r) => r.period === quarter).map((r) => ({ filer: { cik: r.filer.cik, slug: r.filer.slug, name: r.filer.name, curated: r.filer.curated, type: r.filer.type }, cusip: null, ticker: is.ticker ?? h.tickers[0] ?? null, issuer: h.display_name, put_call: r.put_call, shares: r.shares, prev_shares: r.prev_shares, share_change: r.share_change, value_usd: r.value_usd, value_delta_usd: r.prev_value_usd == null ? null : r.value_usd - r.prev_value_usd, change: r.change, accession: r.accession, accepted_at: r.accepted_at }));
      source = 'stock';
    } else {
      // Across filers: the data run's per-quarter change file (largest moves first).
      const obj = await env.HIST.get(`changes/${quarter}.json`);
      stamp = stampOf(obj);
      if (!obj) return v1error('not_yet_available', 501, `Coming: cross-filer changes for ${quarter} are not published yet; /v1/changelog logs the day this ships. Meanwhile pass filer=.`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (await new Response(obj.body).json()) as any;
      const types = await filerTypes(env);
      rows = rowsOf(c).map((h) => ({ filer: { cik: pad(String(h.cik)), slug: h.slug ?? null, name: h.filer_name ?? null, curated: h.curated ?? null, type: normType(types.get(pad(String(h.cik))) ?? h.type) }, cusip: h.cusip, ticker: h.ticker ?? null, issuer: h.issuer ?? null, put_call: h.put_call ? String(h.put_call).toUpperCase() : null, shares: h.shares, prev_shares: h.prev_shares, share_change: h.share_change ?? (h.prev_shares == null ? null : h.shares - h.prev_shares), value_usd: h.value, value_delta_usd: h.value_delta, change: h.change, accession: h.accession ?? null, accepted_at: noMs(h.accepted_at) }));
      source = 'all';
    }
    const curatedCiks = cohort === 'curated' ? new Set((await filers(env)).map((f) => f.cik)) : null;
    if (cohort !== 'all' && cohort !== 'curated' && source === 'filer') return v1error('bad_request', 400, 'cohort by filer type works with ticker= or across filers (not filer=).');
    const out = rows
      .filter((r) => want.includes(r.change) && Math.abs(r.value_delta_usd ?? r.value_usd ?? 0) >= minValue)
      .filter((r) => cohort === 'all' || (curatedCiks ? curatedCiks.has(r.filer.cik) : r.filer.type === cohort))
      .sort((a, b) => Math.abs(b.value_delta_usd ?? 0) - Math.abs(a.value_delta_usd ?? 0));
    return v1json({ ...(stamp ?? {}), data: out.slice(offset, offset + limit), quarter, count: out.length, next_offset: offset + limit < out.length ? offset + limit : null });
  }],
);
