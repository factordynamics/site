import { linkBase, type Env } from './env';

/**
 * Large responses that come in on the Funnel name go to a presigned URL on the account's R2 endpoint: Tailscale's relay
 * caps Funnel at about 0.47 MB/s, R2 serves a 7.4 MB CSV in a second or two, and its host is stable (one name to
 * allowlist). The object is written for this one response under dl/ (removed after a day by the bucket's lifecycle
 * rule) and the link is valid 5 minutes. When R2 can't take it, the caller serves the response here as usual.
 */
export const LARGE_BYTES = 1_000_000;
const TTL = 300;

export const viaFunnel = (env: Env, req: Request, url: URL) => /\.ts\.net\/copybook$/.test(linkBase(env, req, url));

/** A 302 to `body` stored on R2 with the response's own content type and filename; null when R2 can't take it. */
export async function toR2(env: Env, body: string, res: Response): Promise<Response | null> {
  const { putObject, presignGet } = await import('./failover');
  const key = `dl/${crypto.randomUUID()}`;
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  const r = await putObject(env, key, body, { 'content-type': type }).catch(() => null);
  if (!r?.ok) return null;
  const query: Record<string, string> = { 'response-content-type': type };
  const cd = res.headers.get('content-disposition');
  if (cd) query['response-content-disposition'] = cd;
  const loc = await presignGet(env, key, TTL, query).catch(() => null);
  return loc ? new Response(null, { status: 302, headers: { location: loc, 'cache-control': 'no-store', 'access-control-allow-origin': '*' } }) : null;
}

/**
 * Bulk exports. The data run uploads bulk/{quarter}.csv.gz to this copy's store (HIST); the download link is a presigned
 * URL on the account's R2 bucket. On gene those are two stores: from the move to gene (Nov 9) until 11 Nov the links
 * served the bucket's Nov 9 01:17 copy while the listing described gene's newer file. So each file is mirrored to the
 * bucket stamped with its sha256, and a link is handed out only when the bucket's copy has the listed size and sha256.
 */
export interface BulkFile { key: string; bytes: number; etag: string | null; sha256: string | null; uploaded: Date }
export interface Served { bytes: number; etag: string | null; sha256: string | null }
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (b: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>));
const unq = (e: string | null | undefined) => (e ? e.replace(/^W\//, '').replace(/"/g, '') : null);

/** The bulk files in this copy's store, with their sha256 (stamped at upload, or recorded by the first mirror). */
export async function bulkFiles(env: Env, min: number): Promise<BulkFile[]> {
  const list = await env.HIST.list({ prefix: 'bulk/', include: ['customMetadata'] });
  const out: BulkFile[] = [];
  for (const o of list.objects.filter((x) => x.size >= min)) {
    const etag = unq((o as { etag?: string }).etag);
    let sha = o.customMetadata?.sha256 ?? null;
    if (!sha && etag) {
      const rec = JSON.parse((await env.DB.get(`bulk:sha:${o.key}`)) ?? 'null') as { etag: string; sha256: string } | null;
      sha = rec?.etag === etag ? rec.sha256 : null;
    }
    out.push({ key: o.key, bytes: o.size, etag, sha256: sha, uploaded: o.uploaded });
  }
  return out;
}

/** What the presigned link serves for `key`: its size, ETag and sha256 stamp; null when the bucket has no copy. */
export async function servedHead(env: Env, key: string): Promise<Served | null> {
  const { headObject } = await import('./failover');
  const r = await headObject(env, key).catch(() => null);
  if (!r) return null;
  await r.body?.cancel().catch(() => {});
  if (r.status !== 200 && r.status !== 206) return null;
  const bytes = Number(r.headers.get('content-range')?.split('/')[1] ?? r.headers.get('content-length'));
  return { bytes, etag: unq(r.headers.get('etag')), sha256: r.headers.get('x-amz-meta-sha256') };
}

export const sameFile = (f: BulkFile, s: Served | null) => !!s && s.bytes === f.bytes && !!f.sha256 && s.sha256 === f.sha256;

/** Copies this store's bulk file to the bucket (stamped with its sha256) unless the bucket already has it. */
export async function mirrorBulk(env: Env, key: string): Promise<{ key: string; mirrored: boolean; bytes: number; sha256: string; served: Served | null }> {
  const obj = await env.HIST.get(key);
  if (!obj) throw new Error(`${key}: not in this store`);
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  const sha = obj.customMetadata?.sha256 ?? (await sha256Hex(bytes));
  const etag = unq((obj as { etag?: string }).etag);
  if (!obj.customMetadata?.sha256 && etag) await env.DB.put(`bulk:sha:${key}`, JSON.stringify({ etag, sha256: sha }));
  const before = await servedHead(env, key);
  if (before && before.bytes === bytes.length && before.sha256 === sha) return { key, mirrored: false, bytes: bytes.length, sha256: sha, served: before };
  const { putObject } = await import('./failover');
  const r = await putObject(env, key, bytes, { 'content-type': obj.httpMetadata?.contentType ?? 'application/gzip', 'x-amz-meta-sha256': sha });
  if (!r?.ok) throw new Error(`${key}: bucket PUT ${r?.status ?? 'unconfigured'}`);
  return { key, mirrored: true, bytes: bytes.length, sha256: sha, served: await servedHead(env, key) };
}

const running = new Set<string>();
/** One mirror per key at a time, in the background (gene's process keeps it; on Cloudflare the bucket is the store). */
export function mirrorSoon(env: Env, key: string): void {
  if (env.MOVED_TO || running.has(key)) return;
  running.add(key);
  mirrorBulk(env, key).catch((e) => console.error(`bulk mirror: ${e}`)).finally(() => running.delete(key));
}

/**
 * Listed against served, for every bulk file: size and sha256 must agree (ETags are reported, not compared). A mismatch starts a mirror and is
 * recorded (status.json bulk_check); hello@ hears once per new set of problems.
 */
export async function checkBulk(env: Env, min: number, now: number): Promise<{ ok: boolean; problems: string[] }> {
  // On Cloudflare the bucket the links sign is this copy's own store: nothing to compare.
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || env.MOVED_TO) return { ok: true, problems: [] };
  const files = await bulkFiles(env, min);
  const rows = [];
  const problems: string[] = [];
  for (const f of files) {
    const s = await servedHead(env, f.key);
    rows.push({ file: f.key.slice(5), listed_bytes: f.bytes, served_bytes: s?.bytes ?? null, etag: f.etag, served_etag: s?.etag ?? null, sha256: f.sha256, served_sha256: s?.sha256 ?? null });
    if (!sameFile(f, s)) {
      problems.push(`${f.key.slice(5)}: listed ${f.bytes} bytes, served ${s?.bytes ?? 'none'}${s && f.sha256 !== s.sha256 ? ' (sha256 differs)' : ''}`);
      mirrorSoon(env, f.key);
    }
  }
  const prev = JSON.parse((await env.DB.get('bulk:check')) ?? 'null') as { problems?: string[] } | null;
  await env.DB.put('bulk:check', JSON.stringify({ checked_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), ok: !problems.length, problems, files: rows }));
  if (problems.length && JSON.stringify(prev?.problems ?? []) !== JSON.stringify(problems)) {
    const { sendMail } = await import('./email');
    await sendMail(env, [{ to: env.CONTACT_EMAIL ?? 'hello@factordynamics.com', subject: 'Copybook: a bulk download differs from its listing (re-mirroring)', text: `${problems.join('\n')}\n\nDownloads of these files are served from the API itself until the bucket's copy matches.` }]);
  }
  return { ok: !problems.length, problems };
}
