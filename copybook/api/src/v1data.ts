import type { Env } from './env';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function position(h: any) {
  return {
    cusip: h.cusip,
    ticker: h.ticker ?? null,
    issuer: h.issuer,
    name: h.display_name ?? null,
    title_of_class: h.title ?? null,
    put_call: h.put_call ?? null,
    sector: h.sector ?? null,
    shares: h.shares,
    value_usd: h.value,
    weight: h.weight,
    change: h.change ?? null,
    prev_shares: h.prev_shares ?? null,
    share_change: h.share_change ?? null,
    value_delta_usd: h.value_delta ?? null,
    // Point-in-time provenance: filled once the data run publishes it per row.
    source_accession: h.source_accession ?? null,
    first_disclosed_at: h.first_disclosed_at ?? null,
  };
}

ROUTES.push(
  ['GET', /^\/v1\/filers$/, async ({ env }) => {
    const data = await filers(env);
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
    return v1json({
      data: {
        filer: { slug: f.slug, cik: f.cik, name: f.name, manager: f.manager },
        quarter: q.quarter,
        report_date: q.report_date,
        filing: { accession: q.accession, form: q.form, filing_date: q.filing_date, sec_url: q.sec_url, amendments: q.amendments ?? [] },
        prev_quarter: q.prev_quarter ?? null,
        total_value_usd: q.total_value,
        position_count: q.position_count ?? (q.holdings ?? []).length,
        holdings: (q.holdings ?? []).map(position),
        exited: (q.exited ?? []).map(position),
      },
    });
  }],
);
