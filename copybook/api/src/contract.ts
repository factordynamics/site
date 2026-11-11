/**
 * The contract between ingest's index.json (managers[]) and alert routing: the fields routing reads and the values
 * it understands. A renamed type (active -> long_only, Nov 9) silently stopped stock-match alerts for two days; this
 * check fails the build (test/contract.test.ts runs it against the live index) and alerts at runtime (runBackstop).
 * Ingest runs the same check before it publishes; keep both in step.
 */

/** Filer types ingest publishes. Routing treats any other value (or none) as a broken contract. */
export const FILER_TYPES = ['hedge_fund', 'long_only', 'index', 'bank', 'insurance', 'wealth', 'pension', 'sovereign', 'other'] as const;

/** Filer types whose 13F moves alert members who watch or own the stock without following the fund. */
export const STOCK_ALERT_TYPES: ReadonlySet<string> = new Set(['hedge_fund', 'long_only']);

/**
 * Institutions whose books would flood stock watchers (a bank's or index sponsor's 13F changes most of its lines each
 * quarter). Every other tracked fund keeps stock-match alerts whatever ingest types it (wealth, other: Gabelli,
 * Olstein and Advent were retyped from long-only on Nov 11), so a reclassification can't silently stop them.
 */
export const NO_STOCK_ALERT_TYPES: ReadonlySet<string> = new Set(['bank', 'index', 'insurance', 'pension', 'sovereign']);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;

/** Each managers[] field routing reads: why, and whether a value is acceptable. */
export const INDEX_FIELDS: Record<string, { used_for: string; ok: (v: unknown, row: Record<string, unknown>) => boolean }> = {
  slug: { used_for: 'follows, KV alerts:ciks', ok: (v) => typeof v === 'string' && /^[a-z0-9-]+$/.test(v) },
  cik: { used_for: "matching EDGAR's feed to a fund", ok: (v) => typeof v === 'string' && /^\d{1,10}$/.test(v) },
  type: { used_for: 'stock-match 13F alerts (STOCK_ALERT_TYPES)', ok: (v) => typeof v === 'string' && (FILER_TYPES as readonly string[]).includes(v) },
  featured: { used_for: "the default alert set and the type fallback", ok: (v) => typeof v === 'boolean' },
  ok: { used_for: 'the hourly backstop', ok: (v) => typeof v === 'boolean' },
  form: { used_for: 'the hourly backstop (13F-HR only)', ok: (v) => typeof v === 'string' && /^13F-/.test(v) },
  accession: { used_for: 'the hourly backstop, dedupe', ok: (v, r) => (r.ok === false && v == null) || (typeof v === 'string' && ACCESSION.test(v)) },
  report_date: { used_for: "the hourly backstop's periods", ok: (v, r) => (r.ok === false && v == null) || (typeof v === 'string' && DAY.test(v)) },
  filing_date: { used_for: 'whether a filing is still alertable', ok: (v, r) => (r.ok === false && v == null) || (typeof v === 'string' && DAY.test(v)) },
  reported_by: { used_for: "a parent's CIK that files for the fund", ok: (v) => v == null || typeof v === 'string' || (typeof v === 'object' && /^\d{1,10}$/.test(String((v as { cik?: unknown }).cik))) },
};

/** What's wrong with an index.json for routing, one line per problem; empty when it meets the contract. */
export function checkIndex(idx: unknown): string[] {
  const rows = (idx as { managers?: unknown } | null)?.managers;
  if (!Array.isArray(rows) || !rows.length) return ['managers[] is missing or empty'];
  const out: string[] = [];
  for (const [field, spec] of Object.entries(INDEX_FIELDS)) {
    const bad = new Map<string, number>();
    for (const r of rows as Record<string, unknown>[]) {
      if (spec.ok(r[field], r)) continue;
      const v = !(field in r) ? '(missing)' : JSON.stringify(r[field])?.slice(0, 40) ?? '(undefined)';
      bad.set(v, (bad.get(v) ?? 0) + 1);
    }
    if (bad.size) out.push(`${field} (${spec.used_for}): ${[...bad].map(([v, n]) => `${v} x${n}`).slice(0, 5).join(', ')}`);
  }
  const types = new Set((rows as { type?: unknown }[]).map((r) => r.type));
  for (const t of STOCK_ALERT_TYPES) if (!types.has(t)) out.push(`type: no filer is ${t}, so no ${t} 13F can alert stock watchers`);
  return out;
}
