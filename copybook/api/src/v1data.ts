import type { Env } from './env';
import { lookupTickers } from './alerts';
import { fetch13F, fetchFilingMeta, filings13F, type Filed13F, type FilingMeta } from './edgar';
import { ROUTES, v1error, v1json } from './v1';

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
function position(h: any, equityTotal: number) {
  // Once the data run publishes its equity-book weight (ingest item W: pct_of_book next to the
  // renamed trade size delta_pct_of_book), `weight` is that definition; before, the all-rows weight.
  const w = 'delta_pct_of_book' in h;
  const eqw = w ? (h.pct_of_book ?? null) : isEquity(h) && equityTotal > 0 && h.value ? h.value / equityTotal : isEquity(h) ? 0 : null;
  return {
    cusip: h.cusip,
    ticker: h.ticker ?? null,
    issuer: h.issuer,
    title_of_class: h.title ?? null,
    put_call: h.put_call ?? null,
    sector: h.sector ?? null,
    shares: h.shares,
    shares_type: h.shares_type ?? h.sh_prn ?? null,
    value_usd: h.value,
    weight: w ? eqw : h.weight,
    // Alias of the equity-only weight, kept for one release after `weight` switches.
    weight_equity: eqw,
    value_scale: h.value_scale ?? null,
    value_as_filed: h.value_as_filed ?? null,
    value_adjusted: h.value_adjusted ?? null,
    zero_value: h.zero_value ?? (h.change !== 'exited' && h.value === 0),
    change: h.change ?? null,
    prev_shares: h.prev_shares ?? null,
    share_change: h.share_change ?? null,
    value_delta_usd: h.value_delta ?? null,
    // Point-in-time provenance: filled once the data run publishes it per row.
    source_accession: h.source_accession ?? null,
    first_disclosed_at: h.first_disclosed_at ?? null,
  };
}

/** Acceptance time and amendment type per accession, from EDGAR once, then KV (filings never change). */
async function filingMeta(env: Env, cik: string, accession: string): Promise<FilingMeta | null> {
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

async function filersJson(env: Env): Promise<string | null> {
  const res = await fetch(`${env.DATA_URL}filers.json`, { cf: { cacheTtl: 3600 } } as RequestInit);
  return res.ok ? res.text() : null;
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

async function resolveAny(env: Env, id: string): Promise<Filer | null> {
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
  if (full) return { ...((await new Response(full.body).json()) as any), truncated: false };
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
      accepted_at: m?.accepted_at ?? null,
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
      vs.push({ accession: f.accession, form: m?.form ?? f.form, amendment_type: m?.amendment_type ?? null, accepted_at: m?.accepted_at ?? null, filed_on: m?.filed_on ?? null });
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
async function bookFor(env: Env, f: Filer, quarter: string): Promise<Record<string, unknown> | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any;
  if (f.curated) {
    const obj = await env.HIST.get(`h/${f.row.slug}/${quarter}.json`);
    if (!obj) return null;
    q = await new Response(obj.body).json();
  } else {
    q = await filerBook(env, f.row.cik, quarter);
    if (!q) return null;
  }
  const holdings = q.holdings ?? (q.columns ? rowsOf(q) : []);
  const cik = cikOf(q.sec_url, f.row.cik);
  const equityTotal = holdings.filter(isEquity).reduce((s: number, h: { value?: number }) => s + (h.value || 0), 0);
  const main = q.accession ? await filingMeta(env, cik, q.accession) : null;
  const merged = ((q.amendments ?? []) as unknown[]).map((a) => (typeof a === 'string' ? a : (a as { accession?: string })?.accession)).filter(Boolean) as string[];
  const versions = await versionsFor(env, cik, q.report_date ?? quarterEnd(quarter), q.accession ?? null, merged);
  // Amendments: every 13F-HR/A EDGAR has for the period, whatever its type and including a served
  // restatement (not only those the data run merged); versions[] adds the original.
  const amendments = versions ? versions.filter((v) => v.form.endsWith('/A')).map((v) => v.accession) : (q.amendments ?? []);
  return {
    filer: f.curated ? { slug: f.row.slug, cik: f.row.cik, name: f.row.name, manager: f.row.manager, curated: true } : { slug: f.row.slug, cik: f.row.cik, name: f.row.name, manager: null, curated: false },
    quarter: q.quarter ?? quarter,
    report_date: q.report_date ?? quarterEnd(quarter),
    filing: {
      accession: q.accession ?? null,
      filer_cik: pad(q.filer_cik ?? cik),
      form: q.form ?? '13F-HR',
      filing_date: q.filing_date ?? null,
      accepted_at: main?.accepted_at ?? null,
      sec_url: q.sec_url ?? null,
      amendment_type: main?.amendment_type ?? null,
      amendments: await amendmentsOf(env, cik, amendments),
      versions,
    },
    prev_quarter: q.prev_quarter ?? null,
    total_value_usd: q.total_value ?? holdings.reduce((s: number, h: { value?: number }) => s + (h.value || 0), 0),
    position_count: q.position_count ?? holdings.length,
    // A public shard holds the top 500 positions by value until the full book is in R2.
    truncated: Boolean(q.truncated ?? (q.position_count != null && q.position_count > holdings.length)),
    holdings: holdings.map((h: unknown) => position(h, equityTotal)),
    exited: (q.exited ?? []).map((h: unknown) => position(h, equityTotal)),
  };
}

/** Superseded and original books: the data run's copy in R2 (v/{cik}/{accession}.json), else EDGAR when the table is small. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function versionHoldings(env: Env, cik: string, v: Version): Promise<any[] | null> {
  const obj = await env.HIST.get(`v/${pad(cik)}/${v.accession}.json`);
  if (obj) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = (await new Response(obj.body).json()) as any;
    return b.holdings ?? (b.columns ? rowsOf(b) : null);
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
  if (v.status === 'current' && !versions.some((x) => x.status === 'merged')) return v1json({ data: { ...book, version: v.accession } });
  const rows = await versionHoldings(env, filing.filer_cik, v);
  if (!rows) return v1error('not_yet_available', 501, `The book as filed in ${v.accession} is too large to read live; it is served once the data run publishes superseded books.`);
  const equityTotal = rows.filter(isEquity).reduce((s: number, h: { value?: number }) => s + (h.value || 0), 0);
  const dir = `https://www.sec.gov/Archives/edgar/data/${Number(filing.filer_cik)}/${v.accession.replace(/-/g, '')}/`;
  return v1json({
    data: {
      ...book,
      version: v.accession,
      filing: { ...filing, accession: v.accession, form: v.form, filing_date: v.filed_on, accepted_at: v.accepted_at, amendment_type: v.amendment_type, sec_url: `${dir}${v.accession}-index.html`, amendments: [] },
      total_value_usd: rows.reduce((s: number, h: { value?: number }) => s + (h.value || 0), 0),
      position_count: rows.length,
      truncated: false,
      // As filed in that one filing: no changes against the prior quarter.
      holdings: rows.map((h: unknown) => position(h, equityTotal)),
      exited: [],
    },
  });
}

const latestOf = (f: Filer) => (f.curated ? f.row.latest_quarter : f.row.quarter);
const MAX_RANGE = 8;

/** The 6-character issuer code for a ticker or CUSIP, from the public stock list (string search, no full parse). */
async function issuerCode(env: Env, id: string): Promise<{ code: string; ticker: string | null } | null> {
  const up = id.toUpperCase();
  if (/^[0-9A-Z]{8}[0-9]$/.test(up) || /^[0-9A-Z]{6}$/.test(up)) {
    if (/^[A-Z]{1,6}$/.test(up)) {
      // Six letters could be a ticker; fall through to the ticker lookup first.
    } else return { code: up.slice(0, 6), ticker: null };
  }
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(up)) return null;
  const res = await fetch(`${env.DATA_URL}stock_holders.json`, { cf: { cacheTtl: 3600 } } as RequestInit);
  if (!res.ok) return null;
  const m = (await res.text()).match(new RegExp(`"issuer":"([0-9A-Z]{6})","ticker":"${up.replace(/[.-]/g, '\\$&')}"`));
  return m ? { code: m[1], ticker: up } : /^[0-9A-Z]{6}$/.test(up) ? { code: up, ticker: null } : null;
}

ROUTES.push(
  ['GET', /^\/v1\/filers$/, async ({ env, url }) => {
    // Curated filers first (with their history), then every other filer the data run parsed.
    const want = url.searchParams.get('curated');
    const curated = (await filers(env)).map(({ type, ...f }) => ({ ...f, curated: true, ...(type ? { type } : { type: null }) }));
    if (want === 'true') return v1json({ data: curated, count: curated.length });
    const text = await filersJson(env);
    if (!text) return v1error('server_error', 503, 'The filer list is unavailable; retry shortly.');
    const seen = new Set(curated.map((f) => f.cik));
    const rest = ((JSON.parse(text) as { filers: AllFiler[] }).filers ?? [])
      .filter((f) => f.ok && !seen.has(f.cik))
      .map((f) => ({ slug: f.slug, cik: f.cik, name: f.name, manager: null, featured: false, status: null, latest_quarter: f.quarter, latest_report_date: f.quarter ? quarterEnd(f.quarter) : null, latest_filing_date: f.filing_date, latest_accession: null, total_value_usd: null, position_count: f.position_count, history_quarters: f.quarter ? [f.quarter] : [], curated: false, type: f.type ?? null }));
    const data = want === 'false' ? rest : [...curated, ...rest];
    return v1json({ data, count: data.length });
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
    return version ? versionBook(env, book, version) : v1json({ data: book });
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
    return v1json({ data, missing, next_from: last < to ? nextQuarter(last) : null });
  }],
  ['GET', /^\/v1\/stocks\/([^/]+)\/holders$/, async ({ env, url }, [id]) => {
    const quarter = url.searchParams.get('quarter');
    const cohort = url.searchParams.get('cohort') ?? 'all';
    if (quarter && !QUARTER.test(quarter)) return v1error('bad_request', 400, 'quarter must look like 2025Q1.');
    if (!['all', 'curated'].includes(cohort)) return v1error('bad_request', 400, 'cohort is all or curated.');
    const is = await issuerCode(env, decodeURIComponent(id));
    if (!is) return v1error('not_found', 404, 'No such ticker or CUSIP among 13F holdings.');
    const obj = await env.HIST.get(`s/${is.code}.json`);
    if (!obj) return v1error('not_yet_available', 501, 'Per-stock holder lists are published with the next full data run.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (await new Response(obj.body).json()) as any;
    if (quarter && quarter !== s.period) return v1error('not_found', 404, `Holder lists are served for ${s.period} (vs ${s.prev_period}); other quarters are in /v1/filers/{filer}/holdings.`);
    const curatedCiks = cohort === 'curated' ? new Set((await filers(env)).map((f) => f.cik)) : null;
    const rows = rowsOf({ columns: s.columns, rows: s.holders })
      .filter((h) => !curatedCiks || curatedCiks.has(pad(String(h.cik))))
      .map((h) => ({
        filer: { cik: pad(String(h.cik)), name: h.name, slug: h.slug ?? null },
        kind: h.kind,
        shares: h.shares,
        prev_shares: h.prev_shares,
        share_change: h.prev_shares == null ? null : h.shares - h.prev_shares,
        value_usd: h.value,
        prev_value_usd: h.prev_value,
        change: h.change,
        accession: h.accession ?? null,
        accepted_at: h.accepted_at ?? null,
      }));
    return v1json({ data: { issuer: s.issuer, ticker: s.ticker ?? is.ticker, display_name: s.display_name ?? null, quarter: s.period, prev_quarter: s.prev_period, cohort, holders: rows }, count: rows.length });
  }],
  ['GET', /^\/v1\/bulk$/, async ({ env, url }) => {
    // Persistent per-quarter exports of every filer's book, uploaded by the data run.
    const list = await env.HIST.list({ prefix: 'bulk/' });
    const data = list.objects.map((o) => ({ file: o.key.slice('bulk/'.length), quarter: o.key.slice(5, 11), bytes: o.size, uploaded_at: o.uploaded.toISOString(), url: `${url.origin}/v1/${o.key}` }));
    return v1json({ data: data.sort((a: { file: string }, b: { file: string }) => b.file.localeCompare(a.file)) });
  }],
  ['GET', /^\/v1\/bulk\/(\d{4}Q[1-4]\.(?:csv\.gz|parquet))$/, async ({ env }, [file]) => {
    const obj = await env.HIST.get(`bulk/${file}`);
    if (!obj) return v1error('not_found', 404, `No bulk export ${file} yet; GET /v1/bulk lists what is available.`);
    return new Response(obj.body, {
      headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'content-disposition': `attachment; filename="copybook-13f-${file}"`, ...(obj.size != null ? { 'content-length': String(obj.size) } : {}), 'cache-control': 'private, max-age=3600', 'access-control-allow-origin': '*' },
    });
  }],
);
