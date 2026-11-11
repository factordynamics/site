/**
 * Two hosts, one state: Cloudflare's copy of this Worker polls EDGAR (primary poller, its minute cron) and gene
 * (the self-hosted API on Andreas's desktop) serves members, /v1, webhooks and ingest, and is the backup poller.
 * See HOSTING.md.
 *
 * Each side publishes the KV keys it changed to R2 (copybook-history, sync/{host}/{key} plus sync/{host}.json,
 * an index of key -> change time), and every minute applies the other side's newer changes. Cloudflare records
 * what its cron writes; gene diffs its whole KV each minute (its Durable Objects write KV too), which is cheap
 * locally. So a member's follows, channels or new subscription on gene reach Cloudflare's cron within a minute,
 * and the alerts the cron sent (handled filings, feeds, the day's digest) reach gene's pages within a minute.
 *
 * The poller: Cloudflare writes sync/alive-cloudflare.json every minute. gene polls only when that is 10 minutes
 * old. Cloudflare, after a gap of its own (5+ minutes), applies gene's changes and skips one minute before
 * polling, so whichever side polled meanwhile has its handled filings applied first. No filing goes out twice.
 */
import type { Env, KV, R2 } from './env';

/** When this process started: gene's uptime on /health. */
export const BOOT = Date.now();

/** The R2 bucket HIST binds on Cloudflare (wrangler.toml), reached over Cloudflare's API from gene. */
const BUCKET = 'copybook-history';
const ALIVE = 'sync/alive-cloudflare.json';
/** gene polls when Cloudflare's cron hasn't run for this long. */
export const BACKUP_AFTER_MS = 10 * 60_000;
/** Cloudflare's own gap after which it applies gene's changes for a minute before polling again. */
const GAP_MS = 5 * 60_000;
/** Index entries kept: a side down for up to a week still catches up. */
const WINDOW_MS = 7 * 86_400_000;

/** Never synced: per-host caches, rate limits and one-use tokens, the job queue, sync's own state. */
const SKIP = ['rl:', 'dl:', 'host:', 'sync:', 'filing:', 'subs13f:', 'jobs:'];
const synced = (k: string) => !SKIP.some((p) => k.startsWith(p));
/** Lists of handled filings (accessions): a union on sync, never last-writer-wins. */
const GROW_ONLY = new Set(['alerts:handled', 'events:handled']);

/**
 * Cloudflare's cron store: R2 objects kv/{key} (the free plan has about 33k R2 writes a day, KV 1,000), reading
 * through to the KV namespace for keys it hasn't written yet, so the switch needed no copy. Deletions are
 * tombstones (so KV's old value doesn't come back); expirationTtl is kept as metadata and honoured on read.
 */
export function r2kv(bucket: R2, kv: KV): KV {
  const key = (k: string) => `kv/${k}`;
  return {
    async get(k) {
      const o = await bucket.get(key(k));
      if (!o) return kv.get(k);
      const m = o.customMetadata ?? {};
      if (m.deleted || (m.expires && Number(m.expires) < Date.now())) return void (await o.body.cancel?.()), null;
      return new Response(o.body).text();
    },
    async put(k, v, opts) {
      await bucket.put(key(k), v, { customMetadata: opts?.expirationTtl ? { expires: String(Date.now() + opts.expirationTtl * 1000) } : {} });
    },
    async delete(k) {
      await bucket.put(key(k), '', { customMetadata: { deleted: '1' } });
    },
    // Both stores' keys under the prefix, R2's tombstones and expired keys left out. One page: the cron lists
    // members (cus:), channel failures and the like, hundreds of keys, not thousands.
    async list({ prefix }) {
      const names = new Map<string, boolean>();
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: key(prefix), cursor, include: ['customMetadata'] });
        for (const o of page.objects) {
          const m = o.customMetadata ?? {};
          names.set(o.key.slice(3), !m.deleted && !(m.expires && Number(m.expires) < Date.now()));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      let c: string | undefined;
      do {
        const page = await kv.list({ prefix, cursor: c });
        for (const k of page.keys) if (!names.has(k.name)) names.set(k.name, true);
        c = page.list_complete ? undefined : page.cursor;
      } while (c);
      return { keys: [...names].filter(([, live]) => live).map(([name]) => ({ name })).sort((a, b) => (a.name < b.name ? -1 : 1)), list_complete: true };
    },
  };
}

export const isCloudflare = (env: Env) => !!env.MOVED_TO;
export const syncOn = (env: Env) => env.SYNC === 'on' && !!env.CF_API_TOKEN && !!env.CF_ACCOUNT_ID;
const host = (env: Env) => (isCloudflare(env) ? 'cloudflare' : 'gene');
const peer = (env: Env) => (isCloudflare(env) ? 'gene' : 'cloudflare');
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Index of one side's changes: key -> change time (ms, that side's clock); negative for a deletion. */
interface Index {
  at: number;
  keys: Record<string, number>;
}

const api = (env: Env, key: string) => `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`;

/** R2 through the binding on Cloudflare, through Cloudflare's API on gene (its HIST is its own local store). */
async function r2Get(env: Env, key: string): Promise<string | null> {
  if (isCloudflare(env)) {
    const o = await env.HIST.get(key);
    return o ? new Response(o.body).text() : null;
  }
  const res = await fetch(api(env, key), { headers: { authorization: `Bearer ${env.CF_API_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`r2 get ${key}: ${res.status}`);
  return res.text();
}

async function r2Put(env: Env, key: string, body: string): Promise<void> {
  if (isCloudflare(env)) {
    await env.HIST.put(key, body);
    return;
  }
  const res = await fetch(api(env, key), { method: 'PUT', headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`r2 put ${key}: ${res.status}`);
}

/** A KV that records which keys were written (Cloudflare's cron, whose writes go to gene). */
export function recording(db: KV, written: Map<string, number>): KV {
  return {
    get: (k) => db.get(k),
    put: (k, v, o) => (written.set(k, Date.now()), db.put(k, v, o)),
    delete: (k) => (written.set(k, -Date.now()), db.delete(k)),
    list: (o) => db.list(o),
  };
}

/** FNV-1a: has a value changed since gene last published it. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + s.length.toString(36);
}

async function readIndex(env: Env, side: string): Promise<Index> {
  const raw = await r2Get(env, `sync/${side}.json`);
  return raw ? (JSON.parse(raw) as Index) : { at: 0, keys: {} };
}

/** Publishes changed keys (key -> time, negative = deleted), with their current values, and the updated index. */
async function publish(env: Env, changed: Map<string, number>, now: number): Promise<number> {
  if (!changed.size) return 0;
  const me = host(env);
  const index = await readIndex(env, me);
  for (const [k, t] of changed) {
    if (!synced(k)) continue;
    if (t > 0) {
      const v = await env.DB.get(k);
      if (v === null) index.keys[k] = -t;
      else await r2Put(env, `sync/${me}/${k}`, v);
    }
    index.keys[k] = index.keys[k] === -t ? -t : t;
  }
  for (const [k, t] of Object.entries(index.keys)) if (Math.abs(t) < now - WINDOW_MS) delete index.keys[k];
  index.at = Math.max(index.at, ...[...changed.values()].map(Math.abs));
  await r2Put(env, `sync/${me}.json`, JSON.stringify(index));
  return changed.size;
}

/**
 * Applies the other side's changes since the last applied one, oldest first, unless this side changed the key
 * later. At most `cap` keys a minute (Cloudflare's free plan has 10 ms of CPU per run): the cursor (change time,
 * then key) carries the rest to the next minute, so a big catch-up can never stall on one oversized run.
 */
async function apply(env: Env, mine: Index, cap = isCloudflare(env) ? 40 : 2000): Promise<number> {
  const from = peer(env);
  const theirs = await readIndex(env, from);
  const markKey = `sync:applied:${from}`;
  const mark = JSON.parse((await env.DB.get(markKey)) ?? '{"t":0,"k":""}') as { t: number; k: string };
  const after = ([k, t]: [string, number]) => Math.abs(t) > mark.t || (Math.abs(t) === mark.t && k > mark.k);
  const todo = Object.entries(theirs.keys).filter((e) => synced(e[0]) && after(e)).sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]) || (a[0] < b[0] ? -1 : 1));
  if (!todo.length) return 0;
  let n = 0;
  for (const [k, t] of todo.slice(0, cap)) {
    if (Math.abs(mine.keys[k] ?? 0) <= Math.abs(t)) {
      const cur = await env.DB.get(k);
      if (t < 0) {
        if (cur !== null) await env.DB.delete(k), n++;
      } else {
        let v = await r2Get(env, `sync/${from}/${k}`);
        // Handled-filing lists only grow: a peer's copy (often an echo of an older one of ours) is merged, never
        // replaces ours, or filings handled since would be sent again. Ours stay last, so trimming keeps them.
        if (v !== null && cur !== null && GROW_ONLY.has(k)) {
          const mineList = JSON.parse(cur) as string[];
          const have = new Set(mineList);
          v = JSON.stringify([...(JSON.parse(v) as string[]).filter((x) => !have.has(x)), ...mineList]);
        }
        if (v !== null && v !== cur) {
          await env.DB.put(k, v, k.startsWith('digest:') || k.startsWith('delivered:') ? { expirationTtl: 31 * 86400 } : undefined);
          n++;
        }
      }
    }
    mark.t = Math.abs(t);
    mark.k = k;
  }
  await env.DB.put(markKey, JSON.stringify(mark));
  return n;
}

/**
 * gene, every minute: what changed in its KV since the last minute (any writer: requests, Durable Objects, its
 * own cron), published; then Cloudflare's changes applied (and remembered as published, so they aren't echoed).
 */
async function geneSync(env: Env, now: number): Promise<{ published: number; applied: number }> {
  const hashes = JSON.parse((await env.DB.get('sync:hashes')) ?? '{}') as Record<string, string>;
  const seen = new Set<string>();
  const changed = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await env.DB.list({ prefix: '', cursor });
    for (const { name } of page.keys) {
      if (!synced(name)) continue;
      const v = await env.DB.get(name);
      if (v === null) continue;
      seen.add(name);
      const h = hash(v);
      if (hashes[name] !== h) changed.set(name, now), (hashes[name] = h);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  for (const k of Object.keys(hashes)) if (!seen.has(k)) changed.set(k, -now), delete hashes[k];
  const published = await publish(env, changed, now);
  const mine = await readIndex(env, 'gene');
  const applied = await apply(env, mine);
  if (applied) {
    // What Cloudflare wrote is now gene's value too: not a change of gene's to send back.
    for (const k of Object.keys(hashes)) {
      const v = await env.DB.get(k);
      if (v !== null) hashes[k] = hash(v);
    }
    let c: string | undefined;
    do {
      const page = await env.DB.list({ prefix: '', cursor: c });
      for (const { name } of page.keys) if (synced(name) && !hashes[name]) hashes[name] = hash((await env.DB.get(name)) ?? '');
      c = page.list_complete ? undefined : page.cursor;
    } while (c);
  }
  await env.DB.put('sync:hashes', JSON.stringify(hashes));
  return { published, applied };
}

// ---- One dedupe authority for both pollers: an R2 claim object per filing, created atomically ----

/** R2's S3 endpoint, signed with the Cloudflare API token (key id = the token's id, secret = SHA-256 of it). */
let tokenId: string | null = null;
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string | Uint8Array) => hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : (s as Uint8Array<ArrayBuffer>)));
const hmac = async (k: string | ArrayBuffer, s: string) => crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', typeof k === 'string' ? enc.encode(k) : k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(s));

async function s3(env: Env, method: 'PUT' | 'GET', key: string, body: string | Uint8Array = '', extra: Record<string, string> = {}): Promise<Response> {
  if (!tokenId) {
    const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${env.CF_API_TOKEN}` }, signal: AbortSignal.timeout(10_000) });
    tokenId = ((await r.json()) as { result?: { id?: string } }).result?.id ?? null;
    if (!tokenId) throw new Error('token id unavailable');
  }
  const hostname = `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const amz = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amz.slice(0, 8);
  const path = `/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const payload = await sha256(body);
  const headers: Record<string, string> = { host: hostname, 'x-amz-content-sha256': payload, 'x-amz-date': amz, ...extra };
  const names = Object.keys(headers).sort();
  const canonical = [method, path, '', ...names.map((n) => `${n}:${headers[n]}`), '', names.join(';'), payload].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  let k = await hmac(`AWS4${await sha256(env.CF_API_TOKEN!)}`, day);
  for (const part of ['auto', 's3', 'aws4_request']) k = await hmac(k, part);
  const sig = hex(await hmac(k, ['AWS4-HMAC-SHA256', amz, scope, await sha256(canonical)].join('\n')));
  const { host: _, ...send } = headers;
  return fetch(`https://${hostname}${path}`, { method, body: method === 'PUT' ? (body as BodyInit) : undefined, headers: { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${tokenId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` }, signal: AbortSignal.timeout(body.length > 1e7 ? 900_000 : body.length > 1e6 ? 60_000 : 10_000) });
}

/** One object PUT on the account's R2 endpoint (the service's own token): what toR2 hands out presigned. */
export const putObject = (env: Env, key: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  env.CF_API_TOKEN && env.CF_ACCOUNT_ID ? s3(env, 'PUT', key, body, headers) : Promise.resolve(null);
/** The first byte of one object on the account's R2 endpoint: its headers carry the size (content-range), ETag and metadata. */
export const headObject = (env: Env, key: string) =>
  env.CF_API_TOKEN && env.CF_ACCOUNT_ID ? s3(env, 'GET', key, '', { range: 'bytes=0-0' }) : Promise.resolve(null);

/**
 * A presigned GET for one copybook-history object on the account's R2 endpoint, valid `ttl` seconds (R2 answers
 * 403 after that). Signed with the service's own token; null when it isn't configured.
 */
export async function presignGet(env: Env, key: string, ttl: number, query: Record<string, string> = {}): Promise<string | null> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;
  if (!tokenId) {
    const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${env.CF_API_TOKEN}` }, signal: AbortSignal.timeout(10_000) });
    tokenId = ((await r.json()) as { result?: { id?: string } }).result?.id ?? null;
    if (!tokenId) return null;
  }
  const hostname = `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const amz = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amz.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const path = `/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const rfc3986 = (x: string) => encodeURIComponent(x).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const q: Record<string, string> = { ...query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${tokenId}/${scope}`, 'X-Amz-Date': amz, 'X-Amz-Expires': String(ttl), 'X-Amz-SignedHeaders': 'host' };
  const qs = Object.keys(q).sort().map((k) => `${rfc3986(k)}=${rfc3986(q[k])}`).join('&');
  const canonical = ['GET', path, qs, `host:${hostname}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  let k = await hmac(`AWS4${await sha256(env.CF_API_TOKEN)}`, day);
  for (const part of ['auto', 's3', 'aws4_request']) k = await hmac(k, part);
  const sig = hex(await hmac(k, ['AWS4-HMAC-SHA256', amz, scope, await sha256(canonical)].join('\n')));
  return `https://${hostname}${path}?${qs}&X-Amz-Signature=${sig}`;
}

/**
 * A request Cloudflare answers itself rather than sending on to gene (the one-click unsubscribe): it reads and writes
 * the cron's store (R2 kv/ over KV) and publishes what it wrote, so gene applies it within a minute.
 */
export async function writeThrough<T>(env: Env, fn: (env: Env) => Promise<T>): Promise<T> {
  const store = r2kv(env.HIST, env.DB);
  const written = new Map<string, number>();
  // Reads take the newest copy: our own write-through (kv/), or gene's published one (sync/gene/), which the minute
  // sync copies into this KV at most 40 keys a minute. Without it a member gene just created reads as unknown here
  // ("This link has expired" on a fresh unsubscribe link).
  const fresh: KV = {
    ...store,
    async get(k) {
      const [own, gene] = await Promise.all([env.HIST.get(`kv/${k}`), env.HIST.get(`sync/gene/${k}`)]);
      const live = (o: typeof own) => !!o && !o.customMetadata?.deleted && !(o.customMetadata?.expires && Number(o.customMetadata.expires) < Date.now());
      const pick = live(own) && (!gene || Number(own!.uploaded ?? 0) >= Number(gene.uploaded ?? 0)) ? own : gene;
      for (const o of [own, gene]) if (o && o !== pick) await o.body.cancel?.();
      if (pick) return new Response(pick.body).text();
      return env.DB.get(k);
    },
  };
  const out = await fn({ ...env, DB: recording(fresh, written) });
  await publish({ ...env, DB: store }, written, Date.now()).catch((e) => console.log(`unsubscribe publish: ${e}`));
  return out;
}

/** gene, every 5 minutes: held rows re-checked and sent 13F alerts reconciled against ingest's build. */
async function checks(env: Env, now: number): Promise<Record<string, unknown>> {
  if (new Date(now).getUTCMinutes() % 5 !== 1) return {};
  const a = await import('./alerts');
  const scrub = await a.scrubFalseCorrections(env, now).catch((e) => `error: ${e}`);
  const restated = await a.restateFeeds(env, now).catch((e) => `error: ${e}`);
  return { ...(scrub ? { scrubbed: scrub } : {}), ...(typeof restated === 'string' || restated.feeds ? { restated } : {}), held: await a.checkHeld(env, now).catch((e) => `error: ${e}`), reconciled: await a.reconcileAlerts(env, now).catch((e) => `error: ${e}`) };
}

/** Per invocation on Cloudflare: whether gene polled in the last 15 minutes (only then can both send). */
let claimsFor: { at: number; on: boolean } | null = null;

/**
 * Before a filing or event is sent: claims it for this host (an R2 object created only if absent). False when
 * the other host claimed it first: that host sends it, this one marks it handled. Cloudflare claims only while
 * gene has polled in the last 15 minutes (a claim is an outside request, and the free plan allows 50 a minute);
 * gene always claims. When R2 can't be reached the send goes ahead (a missed alert is worse).
 */
export async function claimSend(env: Env, id: string, now = Date.now()): Promise<boolean> {
  if (!syncOn(env)) return true;
  if (isCloudflare(env)) {
    if (!claimsFor || claimsFor.at !== Math.floor(now / 60_000)) {
      const raw = await r2Get(env, GENE_POLLED).catch(() => null);
      const last = raw ? Date.parse((JSON.parse(raw) as { last_run_at: string }).last_run_at) : 0;
      claimsFor = { at: Math.floor(now / 60_000), on: now - last < 15 * 60_000 };
    }
    if (!claimsFor.on) return true;
  }
  const me = host(env);
  try {
    const res = await s3(env, 'PUT', `claims/${id}`, JSON.stringify({ host: me, at: iso(now) }), { 'if-none-match': '*' });
    if (res.ok) return true;
    if (res.status !== 412) return true;
    const got = await s3(env, 'GET', `claims/${id}`);
    return got.ok ? ((await got.json()) as { host: string }).host === me : true;
  } catch {
    return true;
  }
}

/** The host that claimed a send, or null when no claim was written (latency rows from before `host`). */
export async function claimHost(env: Env, id: string): Promise<'cloudflare' | 'server' | null> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const got = await s3(env, 'GET', `claims/${id}`).catch(() => null);
  if (!got?.ok) return null;
  const h = ((await got.json().catch(() => ({}))) as { host?: string }).host;
  return h === 'cloudflare' ? 'cloudflare' : h === 'gene' ? 'server' : null;
}

/** One send for something either host may send (a moves follow-up): the first claim wins, whichever host. */
export async function claimOnce(env: Env, id: string, now = Date.now()): Promise<boolean> {
  if (!syncOn(env)) return true;
  try {
    const res = await s3(env, 'PUT', `claims/${id}`, JSON.stringify({ host: host(env), at: iso(now) }), { 'if-none-match': '*' });
    return res.ok || res.status !== 412;
  } catch {
    return true;
  }
}

const GENE_POLLED = 'sync/alive-gene-poll.json';

export interface PollerLine {
  host: 'cloudflare' | 'gene';
  last_run_at: string | null;
}

/**
 * The minute, both hosts. `run` is the usual minute (polls, jobs). Cloudflare: apply gene's changes, poll
 * (unless just back from a gap), publish what it wrote, write alive. gene: sync, and run the minute only while
 * Cloudflare's cron has been silent for 10 minutes.
 */
export async function syncedMinute(env: Env, now: number, run: (env: Env) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (isCloudflare(env)) {
    env = { ...env, DB: r2kv(env.HIST, env.DB) };
    const mine = await readIndex(env, 'cloudflare');
    out.sync_applied = await apply(env, mine);
    const raw = await r2Get(env, ALIVE);
    const last = raw ? Date.parse((JSON.parse(raw) as { last_run_at: string }).last_run_at) : 0;
    await r2Put(env, ALIVE, JSON.stringify({ last_run_at: iso(now), build: env.BUILD_SHA?.slice(0, 12) ?? null }));
    if (now - last > GAP_MS) {
      // Back from a gap (or first run): gene may have polled meanwhile. Its handled filings are applied above;
      // one more minute lets gene see this side alive and stop before this side polls.
      out.poller = 'resuming: polls from next minute';
      return out;
    }
    const written = new Map<string, number>();
    Object.assign(out, await run({ ...env, DB: recording(env.DB, written) }));
    out.sync_published = await publish(env, written, now).catch((e) => `error: ${e}`);
    return out;
  }
  // gene serves sign-in, pause and resume: what Resend refused here is retried here.
  Object.assign(out, await (await import('./email')).retryMail(env).catch((e) => ({ mail_retry: `error: ${e}` })));
  // Cloudflare's heartbeat. gene polls only on a heartbeat it read and found stale: failing to read it (gene's link,
  // or Cloudflare's API) is never a reason to poll, since Cloudflare may be polling fine.
  let cf: PollerLine | null = null;
  try {
    const raw = await r2Get(env, ALIVE);
    const alive = raw ? (JSON.parse(raw) as { last_run_at: string; build?: string | null }) : null;
    cf = { host: 'cloudflare', last_run_at: alive?.last_run_at ?? null };
    // Cloudflare's build, from its heartbeat, for /health's poller_builds.
    if (alive?.build && (await env.DB.get('host:cf-build')) !== alive.build) await env.DB.put('host:cf-build', alive.build);
  } catch (e) {
    out.alive = `error: ${e}`;
  }
  // Before polling, Cloudflare's latest writes (its handled filings) must be here.
  try {
    Object.assign(out, await geneSync(env, now));
  } catch (e) {
    out.sync = `error: ${e}`;
  }
  if (!cf) {
    out.poller = 'backup (cloudflare heartbeat unreadable)';
    return out;
  }
  // The data run's big files as local copies, every 10 minutes (requests read these, never a slow download).
  if (new Date(now).getUTCMinutes() % 10 === 2 || !(await env.HIST.get('data/filers.json'))) out.local_data = await (await import('./v1data')).refreshLocalData(env);
  const cfLast = cf.last_run_at ? Date.parse(cf.last_run_at) : 0;
  if (now - cfLast < BACKUP_AFTER_MS) {
    await env.DB.put('host:poller', JSON.stringify(cf));
    out.poller = 'backup (cloudflare polls)';
    // 13Fs Cloudflare sent without moves: gene computes them from EDGAR and sends the follow-up.
    out.moves = await (await import('./alerts')).geneMoves(env, now).catch((e) => `error: ${e}`);
    Object.assign(out, await checks(env, now));
    // Hourly: members re-read from Stripe (a missed webhook can't leave a stale record).
    if (new Date(now).getUTCMinutes() === 23) out.reconcile = await (await import('./members')).reconcileMembers(env).catch((e) => `error: ${e}`);
    // While Cloudflare polls, gene's spare minute fills holder rows' EDGAR acceptance times.
    out.accepted = await (await import('./v1data')).fillAccepted(env).catch((e) => `error: ${e}`);
    return out;
  }
  out.poller = 'gene polls (cloudflare silent)';
  // Cloudflare claims filings while gene has polled recently: written before gene's first send.
  await r2Put(env, GENE_POLLED, JSON.stringify({ last_run_at: iso(now) })).catch((e) => (out.gene_polled = `error: ${e}`));
  Object.assign(out, await run(env));
  out.moves = await (await import('./alerts')).geneMoves(env, now).catch((e) => `error: ${e}`);
  Object.assign(out, await checks(env, now));
  if (new Date(now).getUTCMinutes() === 23) out.reconcile = await (await import('./members')).reconcileMembers(env).catch((e) => `error: ${e}`);
  await env.DB.put('host:poller', JSON.stringify({ host: 'gene', last_run_at: iso(now) } satisfies PollerLine));
  // What this minute wrote goes to Cloudflare now, not next minute.
  try {
    await geneSync(env, now);
  } catch (e) {
    out.sync_after = `error: ${e}`;
  }
  return out;
}

/** The public poller line (/health): which host polls EDGAR and when it last ran; this host's uptime. */
export async function pollerStatus(env: Env, now: number) {
  const p = JSON.parse((await env.DB.get('host:poller')) ?? 'null') as PollerLine | null;
  const last = p?.last_run_at ? Date.parse(p.last_run_at) : 0;
  // Each poller's build (commit, 12 characters): this host's own, the other's from its heartbeat (null when unknown).
  const mine = env.BUILD_SHA?.slice(0, 12) ?? null;
  const poller_builds = isCloudflare(env) ? { cloudflare: mine, server: null } : { cloudflare: await env.DB.get('host:cf-build'), server: mine };
  return { poller_host: p?.host ?? null, poller_last_run: p?.last_run_at ?? null, poller_age_s: last ? Math.max(0, Math.round((now - last) / 1000)) : null, poller_builds, api_host: host(env), api_up_since: iso(BOOT), api_uptime_s: Math.round((now - BOOT) / 1000) };
}
