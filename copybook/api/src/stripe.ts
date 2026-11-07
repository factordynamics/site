import type { Env } from './env';
import { hmacHex } from './tokens';

/** Verifies a Stripe-Signature header (v1 scheme) against the raw body. */
export async function verifyStripeSignature(body: string, header: string | null, secret: string, now = Date.now() / 1000, tolerance = 300): Promise<boolean> {
  if (!header || !secret) return false;
  let t = '';
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't') t = v;
    else if (k === 'v1' && v) v1.push(v);
  }
  if (!t || !v1.length || Math.abs(now - Number(t)) > tolerance) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return v1.some((sig) => timingSafeEqual(sig, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function form(params: Record<string, string | number | boolean | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) out.append(k, String(v));
  return out.toString();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function stripe(env: Env, method: 'GET' | 'POST', path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<any> {
  const qs = form(params);
  const url = `https://api.stripe.com/v1/${path}${method === 'GET' && qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? qs : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`stripe ${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}
