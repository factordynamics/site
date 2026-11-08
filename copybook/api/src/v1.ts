import type { Env } from './env';
import { authKey, limitHeaders, meter, type ApiKey } from './keys';
import { secBudget } from './edgar';

/** Bumped on any breaking change to a /v1 response shape. Every response carries it. */
export const SCHEMA_VERSION = '2026-11-08';
/** Versions a client may pin with the Copybook-Schema-Version header (the current one, plus any in a notice window). */
export const SCHEMA_VERSIONS = [SCHEMA_VERSION];

/** Changes to /v1, newest first. Served at /v1/changelog and summarised in the spec. */
export const CHANGELOG: { date: string; schema_version: string; breaking: boolean; changes: string[] }[] = [
  {
    date: '2026-11-08',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    changes: [
      'Every 13F filer: /v1/filers lists all of them (about 9,000) with `curated` and `type`; ?curated=true|false filters. Holdings work for any filer by its slug or CIK.',
      'Holdings: `latest` as the quarter, `truncated` (true while only the public top-500 shard is available for a filer), filer.curated.',
      'GET /v1/filers/{filer}/holdings?from=&to=: up to 8 quarters per call, with `missing` and `next_from`.',
      'GET /v1/stocks/{ticker|cusip}/holders?cohort=all|curated&quarter=: every 13F holder of one issuer, with prior shares, share and value change.',
      'GET /v1/bulk and /v1/bulk/{YYYYQn}.csv.gz|.parquet: persistent per-quarter exports of every filer\'s book.',
      'filing.versions[]: every 13F-HR and 13F-HR/A for the period, oldest first, including originals a restatement replaced, each with status current, superseded, merged or not_merged. filing.amendment_type for the served filing.',
      'filing.amendments now lists every 13F-HR/A EDGAR has for the period, of any type and including a served restatement, not only those merged into the book: the amendment subset of versions[].',
      '?version=original|{accession} on holdings: the book exactly as that filing reported it.',
      'GET /v1/events: Form 4 and 13D/G with filer, ticker, cusip, issuer_cik, form and date filters, acceptance time, per-class holdings and prior stake.',
      'GET /v1/changes/{quarter}: new, added, trimmed and exited positions by filer, by stock, or across filers with cohort.',
    ],
  },
  {
    date: '2026-11-08',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    changes: [
      'Every response carries data_built_at and build_id: when the data was built and which build it is, so a change in served data is detectable.',
      'Position: weight_equity (share of the equity book: SH rows without put/call), value_scale, value_as_filed, value_adjusted, zero_value, passed through from the data run when it publishes them.',
      'filing.filer_cik: the CIK that filed (e.g. Pershing Square for Ackman).',
      'GET /v1/changelog (no key needed). Versioning policy in the spec.',
      '`weight` becomes the equity-only definition as soon as the data run publishes it (SH rows without put/call over their summed value; null for options and PRN rows). No 90-day notice: the API is pre-launch, and the notice policy starts at public launch. weight_equity carries the same value and stays for one release as an alias.',
    ],
  },
  {
    date: '2026-11-08',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    changes: ['Launch: /v1/me, /v1/filers, /v1/filers/{filer}/holdings/{quarter} with filing.accepted_at and amendments[] objects, schema_version, stable error codes, per-key rate limits.'],
  },
];

/** When the served data was built, from the data run's index (KV v1:build, refreshed hourly). */
let build: { data_built_at: string | null; build_id: string | null } = { data_built_at: null, build_id: null };

/** Stable error codes; documented in the OpenAPI spec. */
export const ERRORS = {
  unauthorized: 'No API key was sent.',
  invalid_key: 'The API key is malformed, unknown or revoked.',
  subscription_inactive: 'The Copy Pro subscription behind this key is not active.',
  pro_required: 'API access is part of Copy Pro.',
  rate_limited: 'Too many requests for this key; see the RateLimit headers.',
  not_found: 'No such resource.',
  bad_request: 'A parameter is missing or invalid.',
  not_yet_available: 'This option is documented but not served yet.',
  server_error: 'Something went wrong on our side.',
} as const;
export type ErrorCode = keyof typeof ERRORS;

const base = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'private, no-store' };

export function v1json(data: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ schema_version: SCHEMA_VERSION, ...build, ...data }), { status, headers: { ...base, ...headers } });
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
    async ({ env, key }) => {
      const u = await meter(env, key.id).usage(30);
      return v1json({ data: { key: { id: key.id, name: key.name, prefix: key.prefix, created: key.created, last_used_at: u.last_used_at }, usage: u.days } });
    },
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
  const b = await env.DB.get('v1:build');
  if (b) build = JSON.parse(b);
  if (path === '/v1/changelog') return v1json({ data: CHANGELOG }, 200, { 'cache-control': 'public, max-age=300' });
  const pin = req.headers.get('copybook-schema-version');
  if (pin && !SCHEMA_VERSIONS.includes(pin)) return v1error('bad_request', 400, `Unknown Copybook-Schema-Version ${pin}; served versions: ${SCHEMA_VERSIONS.join(', ')}.`);
  // The cron sets a per-run SEC budget on this module; a request after it in the same isolate
  // must not inherit a spent one (filing lookups would fail).
  secBudget.left = Math.max(secBudget.left, 30);
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
