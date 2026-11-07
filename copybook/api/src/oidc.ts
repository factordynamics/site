// Verifies GitHub Actions OIDC tokens, so the data workflow can upload history
// without a stored secret. Only the workflow named in INGEST_WORKFLOW is accepted.

export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const OIDC_AUDIENCE = 'copybook-api';

interface Jwk extends JsonWebKey {
  kid?: string;
}

let jwksCache: { at: number; keys: Jwk[] } | null = null;

async function jwks(refresh: boolean): Promise<Jwk[]> {
  if (!refresh && jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(`${OIDC_ISSUER}/.well-known/jwks`);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  jwksCache = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys };
  return jwksCache.keys;
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

function b64urlJson(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

/** Returns null when the token is a valid OIDC token from `workflow`, else the reason it failed. */
export async function verifyGithubOidc(token: string, workflow: string, now = Date.now() / 1000): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return 'malformed token';
  let header, claims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return 'malformed token';
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return 'unsupported token';
  let jwk = (await jwks(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await jwks(true)).find((k) => k.kid === header.kid);
  if (!jwk) return 'unknown signing key';
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return 'bad signature';
  if (claims.iss !== OIDC_ISSUER) return 'wrong issuer';
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(OIDC_AUDIENCE)) return 'wrong audience';
  if (typeof claims.exp !== 'number' || claims.exp < now) return 'expired';
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return 'not yet valid';
  if (!workflow || claims.workflow_ref !== workflow) return 'workflow not allowed';
  return null;
}
