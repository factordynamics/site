import type { Env } from './env';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

/** The data run's per-quarter CSV columns (h/{slug}/{q}.csv); every export row has exactly these. */
const CSV_FIELDS = [
  'manager', 'slug', 'cik', 'quarter', 'report_date', 'filing_date', 'accession', 'ticker', 'issuer', 'cusip', 'title', 'put_call', 'shares', 'value_usd', 'weight',
  // Change vs the prior quarter; exited positions come last with shares 0.
  'change', 'prev_shares', 'share_change', 'value_delta_usd', 'delta_pct_of_book', 'pct_of_book',
  'shares_type', 'principal_amount', 'split_ratio', 'prev_shares_as_filed', 'source_accession', 'first_disclosed_at', 'late_disclosure',
  'discretion', 'other_managers', 'vote_sole', 'vote_shared', 'vote_none',
];
const HEADER = CSV_FIELDS.join(',');
/** JSON book field for a CSV column, where the names differ. */
const JSON_FIELD: Record<string, string> = { value_usd: 'value', value_delta_usd: 'value_delta' };

/** One CSV line into cells (RFC 4180 quoting). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out;
}

function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Per quarter: .json and .csv (history pages, CSV export) and .v1.json (point-in-time /v1 layout).
export const SHARD_KEY = /^h\/[a-z0-9][a-z0-9-]{0,120}\/(\d{4}Q[1-4](\.json|\.csv|\.v1\.json)|index\.json)$/;

/**
 * A per-quarter history file from the private R2 bucket. Until the bucket holds
 * every file, a missing object falls back to the public copy under DATA_URL.
 */
export async function shard(env: Env, key: string): Promise<ReadableStream<Uint8Array> | null> {
  if (!SHARD_KEY.test(key)) return null;
  const obj = await env.HIST.get(key);
  if (obj) return obj.body;
  const res = await fetch(new URL(key, env.DATA_URL).toString(), { cf: { cacheTtl: 86400 } } as RequestInit);
  return res.ok && res.body ? res.body : null;
}

async function mustShard(env: Env, key: string): Promise<ReadableStream<Uint8Array>> {
  const body = await shard(env, key);
  if (!body) throw new Error(`${key}: missing`);
  return body;
}

/**
 * Streams every quarter's holdings as one CSV, one quarter at a time so a big fund
 * stays within the Workers CPU and memory limits. Per quarter it uses, in order:
 * `csv_url` (a ready CSV with the CSV_FIELDS header, piped through unparsed),
 * `holdings_url` (a JSON shard with `holdings`), or inline `holdings`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function historyCsv(env: Env, h: any): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  // Workers' IdentityTransformStream pipes bytes natively; the standard one runs JS per chunk.
  const Identity = (globalThis as { IdentityTransformStream?: typeof TransformStream }).IdentityTransformStream ?? TransformStream;
  const { readable, writable } = new Identity<Uint8Array, Uint8Array>();
  (async () => {
    let w = writable.getWriter();
    await w.write(enc.encode(HEADER + '\r\n'));
    for (const q of h.history ?? []) {
      // A ready CSV when there is one; otherwise the JSON book below.
      const body = q.csv_url ? (q.holdings_url ? await shard(env, q.csv_url) : await mustShard(env, q.csv_url)) : null;
      if (body) {
        // Read the shard's header line in JS. With today's columns, the runtime pipes the rest natively
        // (per-chunk JS would cost ~0.5 s CPU on the largest books); an older layout is remapped per row.
        const reader = body.getReader();
        let head = '';
        let rest: Uint8Array | null = null;
        const dec = new TextDecoder();
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
          const nl = r.value.indexOf(10);
          if (nl < 0) {
            head += dec.decode(r.value, { stream: true });
            continue;
          }
          head += dec.decode(r.value.subarray(0, nl));
          rest = r.value.subarray(nl + 1);
          break;
        }
        head = head.replace(/\r$/, '');
        if (head === HEADER) {
          if (rest?.length) await w.write(rest);
          reader.releaseLock();
          w.releaseLock();
          await body.pipeTo(writable, { preventClose: true });
          w = writable.getWriter();
          continue;
        }
        const cols = splitCsv(head);
        const at = CSV_FIELDS.map((f) => cols.indexOf(f));
        let text = rest ? dec.decode(rest, { stream: true }) : '';
        for (let r = await reader.read(); !r.done; r = await reader.read()) text += dec.decode(r.value, { stream: true });
        text += dec.decode();
        reader.releaseLock();
        const lines = text.split(/\r?\n/).filter((l) => l);
        const rows = lines.map((l) => {
          const c = splitCsv(l);
          return at.map((i) => cell(i < 0 ? '' : c[i])).join(',') + '\r\n';
        });
        if (rows.length) await w.write(enc.encode(rows.join('')));
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const book: { holdings?: any[]; exited?: any[] } = q.holdings ? q : q.holdings_url ? await new Response(await mustShard(env, q.holdings_url)).json() : {};
      // Several funds in one file (the follows CSV) carry their own manager, slug and CIK per quarter.
      const filing: Record<string, unknown> = { manager: q.manager ?? h.manager, slug: q.slug ?? h.slug, cik: q.cik ?? h.cik, quarter: q.quarter, report_date: q.report_date, filing_date: q.filing_date, accession: q.accession };
      const rows = [...(book.holdings ?? []), ...(book.exited ?? [])].map(
        (p) =>
          CSV_FIELDS.map((f) => {
            const v = f in filing ? filing[f] : (p[JSON_FIELD[f] ?? f] ?? (f === 'title' ? p.title_of_class : undefined));
            // Lists (other_managers) are space-separated, as in the data run's CSV.
            return cell(Array.isArray(v) ? v.join(' ') : v);
          }).join(',') + '\r\n',
      );
      if (rows.length) await w.write(enc.encode(rows.join('')));
    }
    await w.close();
  })().catch((err) => {
    console.log(`csv ${h.slug}: ${err}`);
    writable.abort(err).catch(() => {});
  });
  return readable;
}

/** The full history index (every quarter's top holdings) is private in R2; the public file is the fallback. */
export async function fetchHistory(env: Env, slug: string): Promise<unknown | null> {
  const obj = SLUG.test(slug) ? await env.HIST.get(`h/${slug}/index.json`) : null;
  if (obj) return new Response(obj.body).json();
  const res = await fetch(`${env.DATA_URL}${slug}-history.json`, { cf: { cacheTtl: 900 } } as RequestInit);
  if (!res.ok) return null;
  return res.json();
}

/** Holders of one stock as CSV: every 13F holder (R2 s/{issuer}.json) when published, else Copybook's curated funds. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function holdersCsv(rows: any[]): string {
  const head = ['filer_cik', 'filer_name', 'slug', 'kind', 'quarter', 'shares', 'prev_shares', 'share_change', 'value_usd', 'prev_value_usd', 'change', 'weight', 'accession', 'accepted_at'];
  const out = rows.map((r) => [r.cik, r.name, r.slug, r.kind, r.quarter, r.shares, r.prev_shares, r.prev_shares == null ? '' : r.shares - r.prev_shares, r.value, r.prev_value, r.change, r.weight, r.accession, r.accepted_at].map(cell).join(','));
  return [head.join(','), ...out].join('\r\n') + '\r\n';
}
