import type { Env } from './env';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

const CSV_FIELDS = [
  'manager', 'slug', 'cik', 'quarter', 'report_date', 'filing_date', 'accession', 'ticker', 'issuer', 'cusip', 'title', 'put_call', 'shares', 'value_usd', 'weight',
  // Change vs the prior quarter; exited positions come last with shares 0.
  'change', 'prev_shares', 'share_change', 'value_delta_usd', 'pct_of_book',
];
const CHANGE_FIELDS = ['change', 'prev_shares', 'share_change', 'value_delta', 'pct_of_book'];

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
    await w.write(enc.encode(CSV_FIELDS.join(',') + '\r\n'));
    for (const q of h.history ?? []) {
      if (q.csv_url) {
        // Drop the shard's header line in JS, then let the runtime pipe the rest
        // natively: per-chunk JS would cost ~0.5 s CPU on the largest books.
        const body = await mustShard(env, q.csv_url);
        const reader = body.getReader();
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
          const nl = r.value.indexOf(10);
          if (nl < 0) continue;
          if (nl + 1 < r.value.length) await w.write(r.value.subarray(nl + 1));
          break;
        }
        reader.releaseLock();
        w.releaseLock();
        await body.pipeTo(writable, { preventClose: true });
        w = writable.getWriter();
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shard: { holdings?: any[]; exited?: any[] } = q.holdings ? q : q.holdings_url ? await new Response(await mustShard(env, q.holdings_url)).json() : {};
      const rows = [...(shard.holdings ?? []), ...(shard.exited ?? [])].map(
        (p) =>
          [h.manager, h.slug, h.cik, q.quarter, q.report_date, q.filing_date, q.accession, p.ticker ?? '', p.issuer ?? '', p.cusip ?? '', p.title ?? '', p.put_call ?? '', p.shares ?? 0, p.value ?? 0, p.weight ?? 0, ...CHANGE_FIELDS.map((k) => p[k])]
            .map(cell)
            .join(',') + '\r\n',
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
