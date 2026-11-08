import type { Env } from './env';
import { fetchFilingMeta, type FilingMeta } from './edgar';
import { ROUTES, v1error, v1json } from './v1';

/**
 * /v1 data endpoints. Everything is from SEC EDGAR filings as filed. Units: money in whole US
 * dollars (filings in thousands are rescaled), share counts as filed (principal amount for PRN
 * rows), fractions as 0-1 (weight 0.256 means 25.6% of the filing's reported value).
 */

const QUARTER = /^\d{4}Q[1-4]$/;
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

ROUTES.push(
  ['GET', /^\/v1\/filers$/, async ({ env }) => {
    // `type` is omitted until the data run classifies filers.
    const data = (await filers(env)).map(({ type, ...f }) => (type ? { ...f, type } : f));
    return v1json({ data, count: data.length });
  }],
  ['GET', /^\/v1\/filers\/([^/]+)\/holdings\/([^/]+)$/, async ({ env, url }, [id, quarter]) => {
    if (url.searchParams.has('as_of')) {
      return v1error('not_yet_available', 501, 'as_of (point-in-time reconstruction) is coming; this endpoint currently returns the book as now known, with amendments merged.');
    }
    if (!QUARTER.test(quarter)) return v1error('bad_request', 400, 'quarter must look like 2025Q1.');
    const f = await resolve(env, id);
    if (!f) return v1error('not_found', 404, 'No such filer (use a slug from /v1/filers or a CIK).');
    const obj = await env.HIST.get(`h/${f.slug}/${quarter}.json`);
    if (!obj) return v1error('not_found', 404, `No ${quarter} 13F for ${f.slug}; see history_quarters in /v1/filers.`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = await new Response(obj.body).json();
    const cik = cikOf(q.sec_url, f.cik);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const equityTotal = ((q.holdings ?? []) as any[]).filter(isEquity).reduce((s, h) => s + (h.value || 0), 0);
    const main = await filingMeta(env, cik, q.accession);
    const amendments = [];
    for (const a of (q.amendments ?? []) as string[]) {
      const m = await filingMeta(env, cik, a);
      amendments.push({
        accession: a,
        filed_on: m?.filed_on ?? null,
        accepted_at: m?.accepted_at ?? null,
        amendment_type: m?.amendment_type ?? null,
        amendment_no: m?.amendment_no ?? null,
        confidential_treatment_expired: m?.confidential_treatment_expired ?? null,
      });
    }
    return v1json({
      data: {
        filer: { slug: f.slug, cik: f.cik, name: f.name, manager: f.manager },
        quarter: q.quarter,
        report_date: q.report_date,
        filing: {
          accession: q.accession,
          filer_cik: (q.filer_cik ?? cik).padStart(10, '0'),
          form: q.form,
          filing_date: q.filing_date,
          accepted_at: main?.accepted_at ?? null,
          sec_url: q.sec_url,
          amendments: amendments.sort((a, b) => (a.accepted_at ?? '').localeCompare(b.accepted_at ?? '')),
        },
        prev_quarter: q.prev_quarter ?? null,
        total_value_usd: q.total_value,
        position_count: q.position_count ?? (q.holdings ?? []).length,
        holdings: (q.holdings ?? []).map((h: unknown) => position(h, equityTotal)),
        exited: (q.exited ?? []).map((h: unknown) => position(h, equityTotal)),
      },
    });
  }],
);
