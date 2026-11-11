import { expect, it } from 'vitest';
import { checkIndex, FILER_TYPES, STOCK_ALERT_TYPES } from '../src/contract';

// The live index the Worker and gene read (wrangler.toml DATA_URL). Run by gene's deployer (vitest) and by
// scripts/bootcheck.sh before every push and Worker deploy, so a renamed field blocks the release.
const INDEX = 'https://refcell.github.io/gust/copybook/data/index.json';

const row = (o: Record<string, unknown> = {}) => ({ ok: true, slug: 'a-fund', cik: '0001067983', type: 'hedge_fund', featured: false, form: '13F-HR', accession: '0000950123-26-000001', report_date: '2026-09-30', filing_date: '2026-11-10', ...o });

it('index contract: a renamed type, a missing field or a stock-alert type with no filers is a problem', () => {
  const good = { managers: [row(), row({ slug: 'b-fund', type: 'long_only' }), row({ slug: 'c', type: 'bank', reported_by: { cik: '123' } })] };
  expect(checkIndex(good)).toEqual([]);
  // Nov 9: active became long_only. The old name (or any new one) is a problem, and so is losing every long_only filer.
  expect(checkIndex({ managers: [row(), row({ slug: 'b', type: 'active' })] })).toEqual([
    'type (stock-match 13F alerts (STOCK_ALERT_TYPES)): "active" x1',
    'type: no filer is long_only, so no long_only 13F can alert stock watchers',
  ]);
  const { featured: _, ...noFeatured } = row({ type: 'long_only' });
  expect(checkIndex({ managers: [row(), noFeatured] })).toEqual(['featured (the default alert set and the type fallback): (missing) x1']);
  expect(checkIndex({})).toEqual(['managers[] is missing or empty']);
  // Every type routing alerts on is one ingest publishes.
  for (const t of STOCK_ALERT_TYPES) expect(FILER_TYPES).toContain(t);
});

it('index contract: the live index.json meets it', async () => {
  let idx: unknown;
  try {
    const r = await fetch(INDEX, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(String(r.status));
    idx = await r.json();
  } catch (e) {
    // The data host unreachable is not a contract break; don't block a release on it.
    console.warn(`index contract: ${INDEX} unreachable (${e}); live check skipped`);
    return;
  }
  expect(checkIndex(idx)).toEqual([]);
}, 30_000);

it("types guard: a held run emails hello@ once and status.json carries it", async () => {
  const { runBackstop } = await import('../src/alerts');
  const kv = new Map<string, string>();
  const DB = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k), list: async () => ({ keys: [], list_complete: true }) };
  const sent: string[] = [];
  const guard = { checked_at: '2026-11-11T06:23:00Z', status: 'held', reason: 'hedge_fund moved -93%', moved: [{ type: 'hedge_fund', published: 1243, candidate: 88, change_pct: -92.9 }] };
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    if (String(u).endsWith('types_guard.json')) return Response.json(guard);
    if (String(u).endsWith('index.json')) return new Response(null, { status: 304 });
    if (String(u).includes('resend')) return sent.push(String(init?.body)), Response.json({ id: 'x' });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  try {
    const env = { DB, DATA_URL: 'https://d.test/', RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c', CONTACT_EMAIL: 'ops@test' } as never;
    await kv.set('status:fresh', '{}');
    await kv.set('idx:etag', 'e');
    await runBackstop(env, Date.now()).catch(() => null);
    await runBackstop(env, Date.now()).catch(() => null);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Copybook: ingest held a filer-type change (published types kept)');
    expect(JSON.parse(kv.get('types:guard')!)).toMatchObject({ checked_at: '2026-11-11T06:23:00Z', status: 'held' });
  } finally {
    globalThis.fetch = orig;
  }
});
