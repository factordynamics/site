import { alertMail, sendMail } from './email';
import { isActive, type Env } from './env';
import { listMembers } from './members';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

const CSV_FIELDS = ['manager', 'slug', 'cik', 'quarter', 'report_date', 'filing_date', 'accession', 'ticker', 'issuer', 'cusip', 'title', 'put_call', 'shares', 'value_usd', 'weight'];

function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function historyCsv(h: any): string {
  const rows = [CSV_FIELDS.join(',')];
  for (const q of h.history ?? []) {
    for (const p of q.holdings ?? []) {
      rows.push(
        [h.manager, h.slug, h.cik, q.quarter, q.report_date, q.filing_date, q.accession, p.ticker ?? '', p.issuer ?? '', p.cusip ?? '', p.title ?? '', p.put_call ?? '', p.shares ?? 0, p.value ?? 0, p.weight ?? 0]
          .map(cell)
          .join(','),
      );
    }
  }
  return rows.join('\r\n') + '\r\n';
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
  const fresh = Object.values(current).filter((f) => seen[f.slug] !== f.accession);
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
