import { alertMail, sendMail } from './email';
import { isActive, type Env } from './env';
import { listMembers } from './members';

/** A filing dated more than this many days ago never triggers an email. */
export const MAX_ALERT_AGE_DAYS = 3;

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
  report_date: string;
  form: string;
  filing_date: string;
  sec_url: string;
  accession: string;
  reported_by?: string;
}

/** Independent of what the data says: only an original 13F-HR filed in the last few days is news. */
export function alertable(f: Pick<Filing, 'form' | 'filing_date'>, now = Date.now()): boolean {
  return f.form === '13F-HR' && now - Date.parse(f.filing_date) <= MAX_ALERT_AGE_DAYS * 86400_000;
}

/**
 * Cron: a manager's filing is new when its report_date (the quarter it covers) is later than
 * any period already alerted for that manager. Seen-state only moves forward, so amendments,
 * re-parses and rollbacks of an old period never alert. First sightings (and the first run) only
 * record state. One email per member, with a filing listed once even if two slugs report it.
 */
export async function runAlerts(env: Env): Promise<{ new: number; emails: number; status: string }> {
  const res = await fetch(`${env.DATA_URL}index.json`);
  if (!res.ok) throw new Error(`index.json ${res.status}`);
  const index = (await res.json()) as { managers?: (Filing & { ok?: boolean })[] };

  const raw = await env.DB.get('alerts:periods');
  const periods: Record<string, string> = raw ? JSON.parse(raw) : {};
  const next = { ...periods };
  const fresh: Filing[] = [];
  for (const f of index.managers ?? []) {
    // Holdings reports (13F-HR and restated 13F-HR/A) record the period; notices (13F-NT) don't.
    if (!f.ok || !f.slug || !f.accession || !f.report_date || !f.form?.startsWith('13F-HR')) continue;
    const prev = periods[f.slug];
    if (prev && f.report_date <= prev) continue;
    next[f.slug] = f.report_date;
    if (raw && prev && alertable(f)) fresh.push(f);
  }
  await env.DB.put('alerts:periods', JSON.stringify(next));
  if (!raw) {
    await env.DB.delete('alerts:seen'); // the old accession-keyed state
    return { new: 0, emails: 0, status: 'seeded' };
  }
  if (!fresh.length) return { new: 0, emails: 0, status: 'none' };

  const mails = [];
  for (const m of await listMembers(env)) {
    if (!isActive(m) || !m.email || m.alerts === 'off') continue;
    const tracked = m.alerts === 'all' ? fresh : fresh.filter((f) => (m.alerts as string[]).includes(f.slug));
    const mine = tracked.filter((f, i) => tracked.findIndex((g) => g.accession === f.accession) === i);
    if (mine.length) mails.push(alertMail(env, m.email, mine));
  }
  const status = await sendMail(env, mails);
  return { new: fresh.length, emails: mails.length, status };
}
