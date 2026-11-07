import { alertMail, sendMail } from './email';
import { isActive, type Env } from './env';
import { listMembers } from './members';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

const CSV_FIELDS = ['manager', 'slug', 'cik', 'quarter', 'report_date', 'filing_date', 'accession', 'ticker', 'issuer', 'cusip', 'title', 'put_call', 'shares', 'value_usd', 'weight'];

function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const SHARD_KEY = /^h\/[a-z0-9][a-z0-9-]{0,120}\/\d{4}Q[1-4]\.(json|csv)$/;

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
      const holdings = q.holdings ?? (q.holdings_url ? ((await new Response(await mustShard(env, q.holdings_url)).json()) as { holdings?: unknown[] }).holdings : []);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = ((holdings ?? []) as any[]).map(
        (p) => [h.manager, h.slug, h.cik, q.quarter, q.report_date, q.filing_date, q.accession, p.ticker ?? '', p.issuer ?? '', p.cusip ?? '', p.title ?? '', p.put_call ?? '', p.shares ?? 0, p.value ?? 0, p.weight ?? 0].map(cell).join(',') + '\r\n',
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

export async function fetchHistory(env: Env, slug: string): Promise<unknown | null> {
  const res = await fetch(`${env.DATA_URL}${slug}-history.json`, { cf: { cacheTtl: 900 } } as RequestInit);
  if (!res.ok) return null;
  return res.json();
}

interface Filing {
  slug: string;
  manager: string;
  name: string;
  quarter: string;
  filing_date: string;
  sec_url: string;
  accession: string;
}

/**
 * Cron: diff each manager's latest accession against the last run and email
 * active members who track that manager. The first run only records state.
 */
export async function runAlerts(env: Env): Promise<{ new: number; emails: number; status: string }> {
  const res = await fetch(`${env.DATA_URL}index.json`);
  if (!res.ok) throw new Error(`index.json ${res.status}`);
  const index = (await res.json()) as { managers?: (Filing & { ok?: boolean })[] };
  const current: Record<string, Filing> = {};
  for (const m of index.managers ?? []) if (m.ok && m.slug && m.accession) current[m.slug] = m;

  const seenRaw = await env.DB.get('alerts:seen');
  const seen: Record<string, string> = seenRaw ? JSON.parse(seenRaw) : {};
  const next = Object.fromEntries(Object.entries(current).map(([s, f]) => [s, f.accession]));
  if (!seenRaw) {
    await env.DB.put('alerts:seen', JSON.stringify(next));
    return { new: 0, emails: 0, status: 'seeded' };
  }
  // A fund newly added to the roster is not news unless its filing is recent.
  const recent = (d: string) => Date.now() - Date.parse(d) < 10 * 86400_000;
  const fresh = Object.values(current).filter((f) => seen[f.slug] !== f.accession && (seen[f.slug] || recent(f.filing_date)));
  if (!fresh.length) return { new: 0, emails: 0, status: 'none' };

  const mails = [];
  for (const m of await listMembers(env)) {
    if (!isActive(m) || !m.email || m.alerts === 'off') continue;
    const mine = m.alerts === 'all' ? fresh : fresh.filter((f) => (m.alerts as string[]).includes(f.slug));
    if (mine.length) mails.push(alertMail(env, m.email, mine));
  }
  const status = await sendMail(env, mails);
  await env.DB.put('alerts:seen', JSON.stringify({ ...seen, ...next }));
  return { new: fresh.length, emails: mails.length, status };
}
