import { linkBase, type Env } from './env';
import { membersApi } from './status';
import { signToken, verifyToken } from './tokens';

/**
 * Large downloads that come in on the Funnel name go to the quick tunnel: Tailscale's relay caps Funnel at about
 * 0.47 MB/s, the tunnel moves a 7.4 MB CSV in 2-3 s. The 302 carries a single-use token, valid 5 minutes, that
 * authorizes the request by itself (curl and most clients drop Authorization on a cross-host redirect). When the
 * tunnel is down, or the request didn't come in on the Funnel name, the caller serves it here as usual.
 */
export const LARGE_BYTES = 1_000_000;
const TTL = 300;
let tunnelUp: { at: number; ok: boolean; base: string } | null = null;

export const viaFunnel = (env: Env, req: Request, url: URL) => /\.ts\.net\/copybook$/.test(linkBase(env, req, url));

/** The tunnel's base when it answers its probe within 2 s (checked at most once a minute), else null. */
async function tunnel(env: Env, now = Date.now()): Promise<string | null> {
  const base = await membersApi(env, now);
  if (!base || /\.ts\.net\//.test(`${base}/`)) return null;
  if (!tunnelUp || tunnelUp.base !== base || now - tunnelUp.at > 60_000) {
    const r = await fetch(`${base}/health?probe=1`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    tunnelUp = { at: now, ok: !!r?.ok, base };
  }
  return tunnelUp.ok ? base : null;
}

/** The request's path and query without our own token, as the token signs it. */
const target = (url: URL) => {
  const q = new URLSearchParams(url.search);
  q.delete('dlt');
  return `${url.pathname}${q.size ? `?${q}` : ''}`;
};

/**
 * A 302 to the same path on the tunnel. `grant` is what the redirected request may act as (the API key record),
 * kept server-side under the token's nonce; null when the tunnel is down. `selfAuthorized`: the URL already carries its
 * own single-use token (a CSV link), so it goes as it is.
 */
export async function toTunnel(env: Env, url: URL, grant: unknown, selfAuthorized = false): Promise<Response | null> {
  const base = await tunnel(env);
  if (!base) return null;
  const loc = new URL(`${base}${target(url)}`);
  if (!selfAuthorized) {
    const n = crypto.randomUUID();
    await env.DB.put(`dlx:${n}`, JSON.stringify(grant), { expirationTtl: TTL });
    loc.searchParams.set('dlt', await signToken(env.SESSION_SECRET, 'download', 'x', TTL, { n, s: target(url) }));
  }
  return new Response(null, { status: 302, headers: { location: loc.toString(), 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}

/** The grant behind ?dlt=, once: null when the token is bad, expired, for another path, or already used. */
export async function redeem<T>(env: Env, url: URL): Promise<T | null> {
  const p = await verifyToken(env.SESSION_SECRET, url.searchParams.get('dlt') ?? '', 'download');
  if (!p?.n || p.s !== target(url)) return null;
  const raw = await env.DB.get(`dlx:${p.n}`);
  if (!raw) return null;
  await env.DB.delete(`dlx:${p.n}`);
  return JSON.parse(raw) as T;
}
