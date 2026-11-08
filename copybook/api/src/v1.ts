import type { Env } from './env';
import { authKey, limitHeaders, meter, type ApiKey } from './keys';

/** Bumped on any breaking change to a /v1 response shape. Every response carries it. */
export const SCHEMA_VERSION = '2026-11-08';

/** Stable error codes; documented in the OpenAPI spec. */
export const ERRORS = {
  unauthorized: 'No API key was sent.',
  invalid_key: 'The API key is malformed, unknown or revoked.',
  subscription_inactive: 'The Copy Pro subscription behind this key is not active.',
  pro_required: 'API access is part of Copy Pro.',
  rate_limited: 'Too many requests for this key; see the RateLimit headers.',
  not_found: 'No such resource.',
  bad_request: 'A parameter is missing or invalid.',
  server_error: 'Something went wrong on our side.',
} as const;
export type ErrorCode = keyof typeof ERRORS;

const base = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'private, no-store' };

export function v1json(data: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ schema_version: SCHEMA_VERSION, ...data }), { status, headers: { ...base, ...headers } });
}

export function v1error(code: ErrorCode, status: number, message?: string, headers: Record<string, string> = {}): Response {
  return v1json({ error: { code, message: message ?? ERRORS[code] } }, status, headers);
}

export interface V1Context {
  env: Env;
  url: URL;
  key: ApiKey;
}

type Handler = (ctx: V1Context, params: string[]) => Promise<Response>;

/** Routes, as [method, path regex, handler]. Handlers are added by the data endpoints module. */
export const ROUTES: [string, RegExp, Handler][] = [
  [
    'GET',
    /^\/v1\/me$/,
    async ({ env, key }) => v1json({ data: { key: { id: key.id, name: key.name, prefix: key.prefix, created: key.created }, usage: await meter(env, key.id).usage(30) } }),
  ],
];

/** /v1: API-key auth, per-key rate limits and usage counting, then the route. */
export async function handleV1(req: Request, env: Env, url: URL, path: string): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'authorization', 'access-control-max-age': '86400' } });
  }
  if (path === '/v1/openapi.json') {
    const { openapi } = await import('./openapi');
    return new Response(JSON.stringify(openapi()), { headers: { ...base, 'cache-control': 'public, max-age=300' } });
  }
  const auth = await authKey(env, req.headers.get('authorization'));
  if (!auth.ok) return v1error(auth.code as ErrorCode, auth.status, auth.message);
  const r = await meter(env, auth.key.id).hit();
  const limits = limitHeaders(r);
  if (!r.allowed) return v1error('rate_limited', 429, undefined, limits);
  for (const [method, re, handler] of ROUTES) {
    const m = path.match(re);
    if (!m) continue;
    if (req.method !== method) return v1error('bad_request', 405, `Use ${method}.`, limits);
    const res = await handler({ env, url, key: auth.key }, m.slice(1));
    for (const [k, v] of Object.entries(limits)) res.headers.set(k, v);
    return res;
  }
  return v1error('not_found', 404, undefined, limits);
}
