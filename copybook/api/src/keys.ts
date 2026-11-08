import { isActive, isPro, type Env, type Member } from './env';
import { getMember } from './members';

/**
 * Copy Pro API keys. A key is shown once at creation; we keep only its SHA-256.
 *   apikey:{sha256}      -> ApiKey (lookup on every /v1 request)
 *   apikeys:{customer}   -> ApiKey[] (the member's list, for the account page)
 */
export interface ApiKey {
  id: string;
  customer: string;
  name: string;
  prefix: string; // first characters of the key, so members can tell keys apart
  hash: string;
  created: string;
}

export const MAX_KEYS = 10;
export const LIMITS = { minute: 60, day: 20_000 };
const KEY = /^cbk_live_[A-Za-z0-9_-]{43}$/;

async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `cbk_live_${btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export async function listKeys(env: Env, customer: string): Promise<ApiKey[]> {
  return JSON.parse((await env.DB.get(`apikeys:${customer}`)) ?? '[]') as ApiKey[];
}

export async function createKey(env: Env, m: Member, name: string): Promise<{ key: string; record: ApiKey } | null> {
  const keys = await listKeys(env, m.customer);
  if (keys.length >= MAX_KEYS) return null;
  const key = randomKey();
  const record: ApiKey = { id: `key_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, customer: m.customer, name, prefix: key.slice(0, 14), hash: await sha256(key), created: new Date().toISOString() };
  await env.DB.put(`apikey:${record.hash}`, JSON.stringify(record));
  await env.DB.put(`apikeys:${m.customer}`, JSON.stringify([...keys, record]));
  return { key, record };
}

export async function revokeKey(env: Env, customer: string, id: string): Promise<boolean> {
  const keys = await listKeys(env, customer);
  const k = keys.find((x) => x.id === id);
  if (!k) return false;
  await env.DB.delete(`apikey:${k.hash}`);
  await env.DB.put(`apikeys:${customer}`, JSON.stringify(keys.filter((x) => x.id !== id)));
  return true;
}

/** Revokes every key of a member, e.g. when the customer is deleted. */
export async function revokeAll(env: Env, customer: string): Promise<number> {
  const keys = await listKeys(env, customer);
  for (const k of keys) await env.DB.delete(`apikey:${k.hash}`);
  await env.DB.delete(`apikeys:${customer}`);
  return keys.length;
}

export type KeyAuth = { ok: true; key: ApiKey; member: Member } | { ok: false; status: number; code: string; message: string };

/** Who a `Bearer cbk_live_...` key belongs to, and whether that member may use /v1 (active Copy Pro). */
export async function authKey(env: Env, header: string | null): Promise<KeyAuth> {
  const token = header?.replace(/^Bearer\s+/i, '').trim() ?? '';
  if (!token) return { ok: false, status: 401, code: 'unauthorized', message: 'Send an API key as `Authorization: Bearer cbk_live_...`.' };
  if (!KEY.test(token)) return { ok: false, status: 401, code: 'invalid_key', message: 'That is not a Copybook API key.' };
  const raw = await env.DB.get(`apikey:${await sha256(token)}`);
  if (!raw) return { ok: false, status: 401, code: 'invalid_key', message: 'Unknown or revoked API key.' };
  const key = JSON.parse(raw) as ApiKey;
  const member = await getMember(env, key.customer);
  if (!isActive(member)) return { ok: false, status: 402, code: 'subscription_inactive', message: 'The Copy Pro subscription for this key is not active.' };
  if (!isPro(member)) return { ok: false, status: 403, code: 'pro_required', message: 'API access is part of Copy Pro and Copy Fund.' };
  return { ok: true, key, member };
}

// ---------------------------------------------------------------------------------------------
// Per-key rate limits and usage, in one Durable Object per key (KV can't take a write per request).

export interface Meter {
  hit(): Promise<MeterResult>;
  usage(days: number): Promise<Usage>;
}

export interface Usage {
  /** Time of the key's latest allowed request, to the minute (ISO, UTC), or null if never used. */
  last_used_at: string | null;
  days: { day: string; requests: number }[];
}

export interface MeterResult {
  allowed: boolean;
  minute: { limit: number; remaining: number; reset: number };
  day: { limit: number; remaining: number; reset: number };
}

interface MeterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** The counting logic, separate from the Durable Object shell so tests can run it in memory. */
export class MeterLogic implements Meter {
  private win = { start: 0, n: 0 };
  constructor(
    private storage: MeterStorage,
    private now: () => number = Date.now,
  ) {}

  async hit(): Promise<MeterResult> {
    const t = this.now();
    const minuteStart = Math.floor(t / 60_000) * 60_000;
    if (this.win.start !== minuteStart) this.win = { start: minuteStart, n: 0 };
    const day = new Date(t).toISOString().slice(0, 10);
    const used = (await this.storage.get<number>(`day:${day}`)) ?? 0;
    const allowed = this.win.n < LIMITS.minute && used < LIMITS.day;
    if (allowed) {
      // Last use is stored once per minute window, so it costs no extra write on busy keys.
      if (this.win.n === 0) await this.storage.put('last', t);
      this.win.n++;
      await this.storage.put(`day:${day}`, used + 1);
    }
    const dayReset = Date.parse(`${day}T00:00:00Z`) + 86400_000;
    return {
      allowed,
      minute: { limit: LIMITS.minute, remaining: Math.max(0, LIMITS.minute - this.win.n), reset: Math.ceil((minuteStart + 60_000 - t) / 1000) },
      day: { limit: LIMITS.day, remaining: Math.max(0, LIMITS.day - used - (allowed ? 1 : 0)), reset: Math.ceil((dayReset - t) / 1000) },
    };
  }

  async usage(days: number): Promise<Usage> {
    const out = [];
    for (let i = 0; i < days; i++) {
      const day = new Date(this.now() - i * 86400_000).toISOString().slice(0, 10);
      out.push({ day, requests: (await this.storage.get<number>(`day:${day}`)) ?? 0 });
    }
    const last = await this.storage.get<number>('last');
    return { last_used_at: last ? new Date(last).toISOString() : null, days: out };
  }
}

/** Durable Object (SQLite-backed, free plan) wrapping MeterLogic, addressed by key id. */
export class KeyMeter {
  private logic: MeterLogic;
  constructor(state: { storage: MeterStorage }) {
    this.logic = new MeterLogic(state.storage);
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/hit') return Response.json(await this.logic.hit());
    return Response.json(await this.logic.usage(Math.min(Number(url.searchParams.get('days')) || 30, 90)));
  }
}

export interface MeterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string): Promise<Response> };
}

export function meter(env: Env, keyId: string): Meter {
  const stub = env.METER.get(env.METER.idFromName(keyId));
  return {
    hit: async () => (await stub.fetch('https://meter/hit')).json() as Promise<MeterResult>,
    usage: async (days) => (await stub.fetch(`https://meter/usage?days=${days}`)).json() as Promise<Usage>,
  };
}

/** Standard rate-limit headers (IETF RateLimit draft, plus the common X-RateLimit-* names), for the tighter window. */
export function limitHeaders(r: MeterResult): Record<string, string> {
  const w = r.minute.remaining <= r.day.remaining && r.day.remaining > 0 ? r.minute : r.day;
  const h: Record<string, string> = {
    'RateLimit-Policy': `${LIMITS.minute};w=60, ${LIMITS.day};w=86400`,
    'RateLimit-Limit': String(w.limit),
    'RateLimit-Remaining': String(w.remaining),
    'RateLimit-Reset': String(w.reset),
    'X-RateLimit-Limit': String(w.limit),
    'X-RateLimit-Remaining': String(w.remaining),
    'X-RateLimit-Reset': String(w.reset),
  };
  if (!r.allowed) h['Retry-After'] = String(w.reset);
  return h;
}
