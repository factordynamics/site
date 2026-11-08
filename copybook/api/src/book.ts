import type { Env, Member } from './env';
import { changeFollows, getFollows, manualOf, MAX_FOLLOWS, type Follows } from './members';
import { filerBook, rowsOf } from './v1data';

/**
 * Importing the stocks a member owns: a pasted list, a CSV export from a broker, or a 13F filer's
 * book (by CIK), which is then kept in step with that filer's newest quarter.
 */
const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const HEAD = /^(ticker|symbol|ticker symbol|instrument|security|stock)$/i;

/** One CSV line into cells (quoted cells may hold commas). */
function cells(line: string): string[] {
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
    else if (c === ',' || c === ';' || c === '\t') out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const clean = (raw: string) => raw.trim().replace(/^\$/, '').replace(/-(?=[A-Z]$)|\/(?=[A-Z]$)/, '.').toUpperCase();

/** Tickers from pasted text or a CSV. A CSV uses its ticker/symbol column, else its first column. */
export function parseBook(input: string): { tickers: string[]; skipped: string[] } {
  const lines = input.split(/\r?\n/).filter((l) => l.trim());
  const rows = lines.map(cells);
  const col = rows[0]?.findIndex((c) => HEAD.test(c)) ?? -1;
  // A CSV: several cells on the first line, or a header we recognize. Otherwise a free-form list.
  const isCsv = col >= 0 || (rows.length > 1 && rows[0].length > 1 && rows.every((r) => r.length === rows[0].length));
  const raw = isCsv ? rows.slice(col >= 0 ? 1 : 0).map((r) => r[Math.max(col, 0)] ?? '') : input.split(/[\s,;]+/);
  const tickers: string[] = [];
  const skipped: string[] = [];
  for (const r of raw) {
    if (!r.trim()) continue;
    const t = clean(r);
    // Broker exports end with totals and cash lines; those aren't tickers.
    if (TICKER.test(t) && !/^(TOTAL|CASH|USD|PENDING)/.test(t)) {
      if (!tickers.includes(t)) tickers.push(t);
    } else if (skipped.length < 50) skipped.push(r.trim().slice(0, 40));
  }
  return { tickers, skipped };
}

/** A 13F filer's latest book as tickers, largest first (equity rows only), or null. */
async function bookOfFiler(env: Env, cik: string): Promise<{ cik: string; name: string; quarter: string; tickers: string[] } | null> {
  const res = await fetch(`${env.DATA_URL}f/${cik}.json`, { cf: { cacheTtl: 900 } } as RequestInit);
  if (!res.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shard = (await res.json()) as any;
  if (!shard?.ok || !shard.quarter) return null;
  const full = await filerBook(env, cik, shard.quarter);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = full?.holdings ?? (full?.columns ? rowsOf(full) : rowsOf(shard));
  const tickers = [...new Set(rows.filter((r) => r.ticker && !r.put_call).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).map((r) => String(r.ticker).toUpperCase()))].filter((t) => TICKER.test(t));
  return { cik, name: shard.name ?? cik, quarter: shard.quarter, tickers: tickers.slice(0, MAX_FOLLOWS) };
}

/**
 * Owned is the hand-added names plus the linked 13F book's tickers. Linking, refreshing or unlinking a
 * book never touches hand-added names; names that leave owned also leave the watchlist.
 */
function ownedWith(f: Follows, manual: string[], book: string[]) {
  const owned = [...new Set([...manual, ...book])];
  const stocks = f.stocks.filter((t) => owned.includes(t) || !f.owned.includes(t));
  return { owned, owned_manual: manual, stocks };
}

export async function importBook(env: Env, m: Member, b: Record<string, unknown>) {
  const mode = b.mode === 'merge' ? 'merge' : 'replace';
  const f = await getFollows(env, m);
  if (typeof b.cik === 'string' || typeof b.cik === 'number') {
    const cik = String(b.cik).replace(/\D/g, '').padStart(10, '0');
    if (!/^\d{10}$/.test(cik) || /^0+$/.test(cik)) return { ok: false as const, status: 400, error: 'cik must be a SEC CIK like 1067983' };
    const book = await bookOfFiler(env, cik);
    if (!book?.tickers.length) return { ok: false as const, status: 404, error: 'no 13F book with tickers for that CIK' };
    const r = await changeFollows(env, m, { set: { ...ownedWith(f, manualOf(f), book.tickers), book } });
    return r.ok ? { ok: true as const, follows: r.follows, imported: book.tickers.length, skipped: [], source: { cik, name: book.name, quarter: book.quarter } } : { ok: false as const, status: 400, error: r.error };
  }
  const text = typeof b.csv === 'string' ? b.csv : typeof b.text === 'string' ? b.text : null;
  if (text === null || text.length > 500_000) return { ok: false as const, status: 400, error: 'send text (a pasted list), csv (a CSV file\'s contents) or cik' };
  const { tickers, skipped } = parseBook(text);
  if (!tickers.length) return { ok: false as const, status: 400, error: 'no tickers found', skipped };
  if (tickers.length > MAX_FOLLOWS) return { ok: false as const, status: 400, error: `at most ${MAX_FOLLOWS} stocks` };
  // A pasted list or CSV replaces the hand-added names (or adds to them with mode "merge"); a linked 13F book stays.
  const manual = mode === 'replace' ? tickers : [...new Set([...manualOf(f), ...tickers])];
  const r = await changeFollows(env, m, { set: { ...ownedWith(f, manual, f.book?.tickers ?? []) } });
  return r.ok ? { ok: true as const, follows: r.follows, imported: tickers.length, skipped, source: null } : { ok: false as const, status: 400, error: r.error };
}

/** Members whose book is a 13F filer's: when it files a newer quarter, swap in the new tickers. At most `limit` per run. */
export async function refreshBooks(env: Env, members: Member[], limit = 5): Promise<number> {
  let n = 0;
  for (const m of members) {
    if (n >= limit || m.seat_of) continue;
    const f = await getFollows(env, m);
    if (!f.book) continue;
    const res = await fetch(`${env.DATA_URL}f/${f.book.cik}.json`, { cf: { cacheTtl: 900 } } as RequestInit);
    const q = res.ok ? ((await res.json()) as { quarter?: string }).quarter : null;
    if (!q || q <= f.book.quarter) continue;
    const book = await bookOfFiler(env, f.book.cik);
    if (!book?.tickers.length) continue;
    await changeFollows(env, m, { set: { ...ownedWith(f, manualOf(f), book.tickers), book } });
    n++;
  }
  return n;
}
