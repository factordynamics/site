// Signed, expiring tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256).

export type TokenKind = 'login' | 'session' | 'download' | 'why' | 'unsub' | 'keep' | 'resume';

export interface TokenPayload {
  k: TokenKind;
  c: string; // Stripe customer id
  x: number; // expiry, unix seconds
  s?: string; // scope, e.g. the manager slug a download token is for
  n?: string; // nonce for single-use tokens
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signToken(secret: string, kind: TokenKind, customer: string, ttlSeconds: number, extra: { s?: string; n?: string } = {}, now = Date.now() / 1000): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ k: kind, c: customer, x: Math.floor(now + ttlSeconds), ...extra })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifyToken(secret: string, token: string, kind: TokenKind, now = Date.now() / 1000): Promise<TokenPayload | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as TokenPayload;
    if (p.k !== kind || typeof p.c !== 'string' || typeof p.x !== 'number' || p.x < now) return null;
    return p;
  } catch {
    return null;
  }
}
