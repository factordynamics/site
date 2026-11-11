/**
 * Stale-while-revalidate on this Worker's proxy to gene (the lead, Nov 11: disk stalls on gene gave a 5.7 s p99 in the
 * 5x-Monday load test). Public /v1 GETs and /events get STALE_WAIT_MS from gene; past that, or on a 5xx or no answer,
 * the last good answer is served with Age and `"stale": true` (and `stale_as_of`), its body exactly as gene sent it, so
 * its data_build and build_id name the build it read. Gene's answer still refreshes the copy in the background.
 *
 * A copy is shared by URL (and schema pin), never by key, so it is served only to an API key or session gene accepted in
 * the last AUTH_OK_MS; a request with no Authorization only gets a copy gene served without one. With no copy the request
 * waits for gene as before. Copies live in this isolate's memory and in the Cache API where the host has one.
 */
export const STALE_WAIT_MS = 800;
const MAX_AGE_MS = 6 * 3600_000;
const AUTH_OK_MS = 30 * 60_000;
const MAX_ENTRY = 4 << 20;
const MAX_TOTAL = 32 << 20;
const KEEP_HEADERS = ['content-type', 'copybook-schema-version', 'deprecation', 'sunset', 'link', 'access-control-allow-origin', 'access-control-expose-headers'];

type Kept = { at: number; bytes: Uint8Array; headers: [string, string][] };
const mem = new Map<string, Kept>();
let total = 0;
const authOk = new Map<string, number>();

export type Swr = { key: string; auth: string | null };

const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].slice(0, 16).map((x) => x.toString(16).padStart(2, '0')).join('');
const cache = () => (typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default);

/** Whether a request may be answered from a stale copy, and its copy's key: public /v1 GETs (not /v1/me or a bulk file) and /events. */
export async function staleFor(req: Request, u: URL): Promise<Swr | null> {
  if (req.method !== 'GET') return null;
  if (u.pathname !== '/events' && !(u.pathname.startsWith('/v1/') && !/^\/v1\/(me|bulk\/[^/]+)$/.test(u.pathname))) return null;
  const a = req.headers.get('authorization');
  const pairs: [string, string][] = [];
  u.searchParams.forEach((v, k) => pairs.push([k, v]));
  const p = new URLSearchParams(pairs.sort(([x], [y]) => x.localeCompare(y)));
  p.set('_pin', req.headers.get('copybook-schema-version') ?? '');
  p.set('_auth', a ? 'key' : 'none');
  return { key: `https://copybook-stale.internal${u.pathname}?${p}`, auth: a ? await hex(a) : null };
}

/** Keeps gene's 200 JSON answer as the copy, and notes the key or session gene accepted. */
export async function keepFresh(s: Swr, r: Response): Promise<void> {
  if (r.status !== 200 || !(r.headers.get('content-type') ?? '').includes('json')) return;
  const now = Date.now();
  if (s.auth) {
    authOk.set(s.auth, now);
    if (authOk.size > 5000) authOk.clear();
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > MAX_ENTRY || bytes[0] !== 0x7b) return;
  const headers = KEEP_HEADERS.flatMap((k) => (r.headers.has(k) ? [[k, r.headers.get(k)!] as [string, string]] : []));
  const old = mem.get(s.key);
  if (old) total -= old.bytes.length;
  mem.delete(s.key);
  mem.set(s.key, { at: now, bytes, headers });
  total += bytes.length;
  for (const [k, v] of mem) {
    if (total <= MAX_TOTAL) break;
    mem.delete(k);
    total -= v.bytes.length;
  }
  const c = cache();
  if (!c) return;
  const at = new Date(now).toISOString();
  await c.put(s.key, new Response(bytes, { headers: [...headers, ['cache-control', `public, max-age=${MAX_AGE_MS / 1000}`], ['x-copybook-kept-at', at]] })).catch(() => undefined);
  if (s.auth) await c.put(`https://copybook-stale.internal/_auth/${s.auth}`, new Response('1', { headers: { 'cache-control': `public, max-age=${AUTH_OK_MS / 1000}`, 'x-copybook-kept-at': at } })).catch(() => undefined);
}

/** The stale answer, or null: no copy, too old (6 hours), or a key or session gene hasn't accepted lately. */
export async function staleAnswer(s: Swr, extra: Record<string, string> = {}): Promise<Response | null> {
  const now = Date.now();
  const c = cache();
  if (s.auth) {
    let ok = authOk.get(s.auth) ?? 0;
    if (now - ok > AUTH_OK_MS && c) ok = Date.parse((await c.match(`https://copybook-stale.internal/_auth/${s.auth}`).catch(() => undefined))?.headers.get('x-copybook-kept-at') ?? '') || 0;
    if (now - ok > AUTH_OK_MS) return null;
  }
  let k = mem.get(s.key);
  if (!k && c) {
    const hit = await c.match(s.key).catch(() => undefined);
    const at = Date.parse(hit?.headers.get('x-copybook-kept-at') ?? '');
    if (hit && at) k = { at, bytes: new Uint8Array(await hit.arrayBuffer()), headers: KEEP_HEADERS.flatMap((h) => (hit.headers.has(h) ? [[h, hit.headers.get(h)!] as [string, string]] : [])) };
  }
  if (!k || now - k.at > MAX_AGE_MS) return null;
  const asOf = new Date(k.at).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // The body as gene sent it, with the marker first: {"stale":true,"stale_as_of":"…", …}.
  const head = new TextEncoder().encode(`{"stale":true,"stale_as_of":"${asOf}"${k.bytes.length > 2 ? ',' : ''}`);
  const headers = new Headers(k.headers);
  for (const [h, v] of Object.entries(extra)) headers.set(h, v);
  headers.set('age', String(Math.floor((now - k.at) / 1000)));
  headers.set('cache-control', 'private, no-store');
  headers.set('x-copybook-stale', '1');
  const expose = headers.get('access-control-expose-headers');
  headers.set('access-control-expose-headers', expose ? `${expose}, age, x-copybook-stale` : 'age, x-copybook-stale');
  return new Response(new Blob([head, k.bytes.subarray(1) as Uint8Array<ArrayBuffer>]), { status: 200, headers });
}
