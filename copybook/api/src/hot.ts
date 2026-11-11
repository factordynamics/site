/**
 * gene's hot paths in memory (the lead, Nov 11: disk stalls from other software on gene gave a 5.7 s p99): the data
 * stores /v1 and /events read (hl/, changes/, filer views h/ and fb/, meta/builds.json) and buffered /track counts.
 * Member, follow and billing writes stay durable: only these. On when MEMORY_CACHE is "on" (wrangler.toml), never on
 * Cloudflare's copy (MOVED_TO), whose isolates come and go.
 */
import type { Env, R2, R2Object } from './env';

export const memoryOn = (env: Env) => env.MEMORY_CACHE === 'on' && !env.MOVED_TO;

const HOT = /^(hl\/|changes\/|h\/|fb\/|meta\/builds\.json$)/;
/** A copy is read again after a minute; a write through this host drops it at once. */
const TTL_MS = 60_000;
const MAX_OBJECT = 8 << 20;
const MAX_TOTAL = 96 << 20;
type Hot = { at: number; bytes: Uint8Array; meta: Omit<R2Object, 'body'> };
const mem = new Map<string, Hot>();
const loading = new Map<string, Promise<Hot | null>>();
let total = 0;
const drop = (k: string) => {
  const x = mem.get(k);
  if (x) total -= x.bytes.length;
  mem.delete(k);
};
const objOf = (h: Hot): R2Object => ({ ...h.meta, body: new Response(h.bytes as Uint8Array<ArrayBuffer>).body! });

async function load(r2: R2, key: string): Promise<Hot | null> {
  const obj = await r2.get(key);
  if (!obj) return null;
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  const h: Hot = { at: Date.now(), bytes, meta: { size: bytes.length, httpMetadata: obj.httpMetadata, uploaded: obj.uploaded, customMetadata: obj.customMetadata, etag: obj.etag } };
  if (bytes.length > MAX_OBJECT) return h;
  drop(key);
  mem.set(key, h);
  total += bytes.length;
  for (const [k] of mem) {
    if (total <= MAX_TOTAL) break;
    drop(k);
  }
  return h;
}

/** The bucket with hot keys read from memory (one disk read per key a minute, however many requests). */
export function hotHist(r2: R2): R2 {
  return new Proxy(r2, {
    get(t, p) {
      if (p === 'get')
        return async (key: string) => {
          if (!HOT.test(key)) return t.get(key);
          const hit = mem.get(key);
          if (hit && Date.now() - hit.at < TTL_MS) {
            mem.delete(key);
            mem.set(key, hit);
            return objOf(hit);
          }
          let l = loading.get(key);
          if (!l) {
            l = load(t, key).finally(() => loading.delete(key));
            loading.set(key, l);
          }
          const h = await l;
          return h ? objOf(h) : null;
        };
      if (p === 'put')
        return async (key: string, ...rest: unknown[]) => {
          drop(key);
          const out = await (t.put as (...a: unknown[]) => Promise<unknown>)(key, ...rest);
          drop(key);
          return out;
        };
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/** The env a request or cron run uses: hot reads on gene, else as given. */
export const hotEnv = (env: Env): Env => (memoryOn(env) ? { ...env, HIST: hotHist(env.HIST) } : env);

// ---------------------------------------------------------------------------------------------------
// /track: counted in memory and written every few seconds (and before /ops/funnel reads them).

/** One /track hit: the day key, the hour key, and what it adds to each (index.ts applyTrack). */
export type TrackHit = { day: string; hour: string; apply: (d: Record<string, Record<string, Record<string, number>>>) => void; applyHour: (hd: Record<string, Record<string, Record<string, number>>>) => void };
const FLUSH_MS = 5_000;
let hits: TrackHit[] = [];
let flushedAt = Date.now();
let flushing: Promise<void> | null = null;
const rl = new Map<string, { hour: number; n: number }>();

/** The per-IP limit (120 an hour) in memory on gene; KV elsewhere. True when this hit counts. */
export async function trackAllowed(env: Env, ip: string): Promise<boolean> {
  if (memoryOn(env)) {
    const hour = Math.floor(Date.now() / 3600_000);
    const x = rl.get(ip);
    const n = x && x.hour === hour ? x.n : 0;
    if (n >= 120) return false;
    if (rl.size > 20_000) rl.clear();
    rl.set(ip, { hour, n: n + 1 });
    return true;
  }
  const k = `rl:track:${ip}`;
  const n = Number((await env.DB.get(k)) ?? 0);
  if (n >= 120) return false;
  await env.DB.put(k, String(n + 1), { expirationTtl: 3600 });
  return true;
}

/** Counts a hit: written now off gene, else buffered and flushed every 5 seconds. */
export async function trackHit(env: Env, hit: TrackHit): Promise<void> {
  hits.push(hit);
  if (!memoryOn(env) || Date.now() - flushedAt >= FLUSH_MS || hits.length >= 1000) await flushTrack(env);
}

/** Writes the buffered hits: one read and one write per day and hour key. */
export async function flushTrack(env: Env): Promise<void> {
  if (flushing) await flushing;
  if (!hits.length) return;
  const batch = hits;
  hits = [];
  flushedAt = Date.now();
  flushing = (async () => {
    const write = async (key: string, ttl: number, fns: ((d: Record<string, Record<string, Record<string, number>>>) => void)[]) => {
      const d = JSON.parse((await env.DB.get(key)) ?? '{}');
      for (const f of fns) f(d);
      await env.DB.put(key, JSON.stringify(d), { expirationTtl: ttl });
    };
    const group = (k: (h: TrackHit) => string, f: (h: TrackHit) => TrackHit['apply']) => {
      const m = new Map<string, TrackHit['apply'][]>();
      for (const h of batch) m.set(k(h), [...(m.get(k(h)) ?? []), f(h)]);
      return m;
    };
    try {
      for (const [k, fns] of group((h) => h.day, (h) => h.apply)) await write(k, 400 * 86400, fns);
      for (const [k, fns] of group((h) => h.hour, (h) => h.applyHour)) await write(k, 30 * 86400, fns);
    } catch (e) {
      // Dropped rather than retried: a retry after a partial write would count twice.
      console.log(`track flush: ${e}`);
    }
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}
