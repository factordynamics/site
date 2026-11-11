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
