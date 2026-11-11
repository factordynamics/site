import { linkBase, type Env } from './env';
import { authKey, limitHeaders, meter, type ApiKey } from './keys';
import { secBudget } from './edgar';

/** Bumped on any breaking change to a /v1 response shape. Every response carries it. */
export const SCHEMA_VERSION = '2026-11-09';
/** Versions a client may pin with the Copybook-Schema-Version header (the current one, plus any in a notice window). */
export const SCHEMA_VERSIONS = [SCHEMA_VERSION];

/** Changes to /v1, newest first. Served at /v1/changelog and summarised in the spec. */
export const CHANGELOG: { id: string; date: string; schema_version: string; breaking: boolean; status: 'shipped' | 'announced'; changes: string[] }[] = [
  {
    id: '2026-11-11-suspect-units-null',
    date: '2026-11-11',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'Correction, widening the type to allow null: Position.`suspect_units` is now boolean or null. It is null until ingest\'s cross-filer check has run on the row, then true or false; it used to say false for rows never checked.',
      'A bad `limit` or `offset` on /v1/events and /v1/changes now names the parameter and the value it got.',
      'The spec declares the X-RateLimit-* headers (the same values as RateLimit-*) and gives /v1/stocks/{stock}/holders rows a schema (HolderRow), with `accepted_at` described as filing-level.',
    ],
  },
  {
    id: '2026-11-09-type-enum',
    date: '2026-11-09',
    schema_version: '2026-11-09',
    breaking: true,
    status: 'shipped',
    changes: [
      'Breaking: Filer.`type` values changed. `active` is now `long_only`; `broker` is removed; `wealth`, `insurance` and `sovereign` are added. Every filer has one of the 8 values in the spec.',
      'This shipped without the 90 days\' notice our versioning policy promises. We\'re sorry; future enum changes will be announced here first.',
      'schema_version is now 2026-11-09.',
    ],
  },
  {
    id: '2026-11-09-weight-equity-only',
    date: '2026-11-09',
    schema_version: SCHEMA_VERSION,
    breaking: true,
    status: 'announced',
    changes: [
      'Breaking, effective Mon Feb 8, 2027 (90 days\' notice): Position.`weight` becomes the equity-only weight (value_usd over the summed value of SH rows without put/call; null for options and PRN rows). Until then `weight` keeps its current meaning: value_usd over the book\'s total, all rows, options included.',
      'Use `weight_equity` for the equity-only weight (stable, available now) or `weight_incl_options` for the current definition (new today, an explicit alias of today\'s `weight`, kept after the switch).',
      'Holdings responses carry `Deprecation: @1794182400` and `Sunset: Mon, 08 Feb 2027 00:00:00 GMT`, with `Link: <…/v1/changelog?id=2026-11-09-weight-equity-only>; rel="deprecation"`.',
    ],
  },
  {
    id: '2026-11-09-spec-alignment',
    date: '2026-11-09',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'put_call is PUT or CALL everywhere (holdings, holders, changes), as EDGAR writes it; holders served Call/Put before.',
      'Filer type uses the data run\'s classification for every filer, in one enum: hedge_fund, long_only, index, bank, insurance, wealth, pension, sovereign, other, or null. long_only was named active (served as long_only from today; type=active still filters it); broker is served as other.',
      'Position.change can be disclosed_later: a position first disclosed in a later NEW HOLDINGS amendment for the period (typically expired confidential treatment).',
      'total_value_usd is a whole number of USD everywhere (a few filers report fractions of a dollar).',
      'Every /v1/changelog entry has a stable id.',
      'A request that takes over 3 s returns 503 with Retry-After and the documented error envelope, code busy.',
    ],
  },
  {
    id: '2026-11-09-holders',
    date: '2026-11-09',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'GET /v1/stocks/{ticker|cusip}/holders: every 13F filer holding the issuer in its latest full book (all filers, not only curated), largest first. Each row has filer (cik, name, slug, type, curated), period (each filer\'s own latest quarter), kind, shares, prev_shares, share_change, value_usd, prev_value_usd, change, weight (share of the filer\'s book; null when its total isn\'t known), accession and accepted_at (curated funds\' latest 13F, null otherwise). Filters: type= (hedge_fund, active, index, bank, wealth, pension, other; comma-separated), cohort=all|curated, quarter=; paginated with limit (1-1000) and offset, `count` and `next_offset`. `counts` has the issuer\'s holder counts by change and period. Until the full list is in R2 a ticker can return the public top 25 with `truncated: true`.',
      'GET /v1/changes/{quarter}?ticker= (or cusip=) is live from the same holder index, with cohort=<type>.',
      'Holders: `filers` (distinct filers with a nonzero position) next to `count` (position rows; shares, calls and puts apart, each with `put_call`). 0-share, $0 options rows never count as a holder and have no weight. current_only=true (default) lists only filers whose latest 13F is for the newest ended quarter or the one before, the stock page\'s rule; current_only=false adds the rest. type= takes ingest\'s new names (long_only, sovereign, insurance) as well as active; active and long_only match each other during the rename.',
      '?version=original (or a superseded accession) serves large superseded books such as Citadel and State Street 2026Q2 from the data run\'s v/ upload, with that upload\'s build_id.',
      'build_id and data_built_at now name the build of the data each response read: an R2 book or holder list carries its upload\'s build (or its upload time as r2-<time>), so books from an older upload no longer share the static data\'s build_id.',
      '/v1/filers lists each CIK once (a filer curated since the hourly list was built is no longer also listed as non-curated), and a newly curated filer whose history isn\'t in R2 yet serves its latest book like any filer instead of 404.',
    ],
  },
  {
    id: '2026-11-09-refiled-amendments',
    date: '2026-11-09',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'announced',
    changes: [
      'Re-filed 13F amendments no longer double a fund\'s book. A 13F-HR/A marked NEW HOLDINGS that re-files the whole book (more than half its positions, or a total within 20% with at least half its positions) replaces the book: it gets role base with mislabeled_amendment: true, and the original becomes superseded (its book in versions[]). Corrected, against each filing\'s cover-page total: First Eagle (Matthew McLennan) 2026Q2 $120.67B to $60.75B; Mizuho Securities USA 2026Q2 $10.44B to $6.20B; JPMorgan Chase 2025Q3 $3,338B to $1,669B; HSBC 2025Q4 $372.1B to $196.2B; T. Rowe Price Investment Management 2025Q4 $252.8B to $158.4B; Mason Morfit 2024Q3 $8.31B to $4.37B; also Brookfield 2024Q4 and 2025Q1, Check Capital 2026Q2, Heard Capital 2025Q3, Lingotto 2025Q3 and UC Regents 2025Q2 to 2025Q4. The public site has the fixed books; /v1 holdings, changes and bulk switch when the data run\'s upload of the fixed books to the API lands, and this entry turns shipped then.',
    ],
  },
  {
    id: '2026-11-09-bulk-and-events',
    date: '2026-11-09',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'Bulk exports, partial: GET /v1/bulk lists per-quarter gzip CSVs of every filer\'s 13F book (2026Q1 to 2026Q3 today) and GET /v1/bulk/{YYYYQn}.csv.gz streams one. Parquet is coming (501 until then). The files are as-filed books, not point-in-time yet: no accepted_at, source_accession, first_disclosed_at or change columns. Only files that pass a size check are listed; stubs from a failed run are hidden until regenerated. Built from original filings: a re-filed book such as First Eagle (Matthew McLennan) 2026Q2 shows its $59.92B original, not the $60.75B refile; see 2026-11-09-refiled-amendments.',
      'Webhook detected_at, like every /v1 timestamp, has no milliseconds (the test webhook included).',
      'GET /v1/events?tickers= (and ticker=): also every Form 4 by the company\'s own insiders and every 13D/G any filer made on it (`source: "issuer"`), with `coverage` (how far back each EDGAR feed reached per ticker) and `pending`. Insider rows carry `insider.ownership`: direct and indirect lines with their balances and trades. Lookback: the issuer\'s latest 20 Form 4s and 10 Schedule 13D/Gs.',
      'Form 4 rows: `event_date` is the first transaction date (one rule everywhere) and `last_transaction_date` the last. Rows built before this change are corrected by the next hourly build.',
    ],
  },
  {
    id: '2026-11-08-coming',
    date: '2026-11-08',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'announced',
    changes: [
      'Coming, not live yet (these return 501 not_yet_available until the data run publishes their files; each moves to a shipped entry the day it returns data): GET /v1/changes/{quarter} across filers (filer= and ticker= are live); Parquet bulk exports (GET /v1/bulk/{YYYYQn}.parquet); point-in-time columns in the bulk files (accepted_at, source_accession, first_disclosed_at, change); as_of point-in-time books; filer `type` on /v1/filers (null until the data run publishes filer types) and cohort=<type> on /v1/changes.',
      'Timestamps (accepted_at, uploaded_at, data_built_at) are ISO 8601 UTC to the second, without milliseconds (2026-11-06T21:46:52Z).',
    ],
  },
  {
    id: '2026-11-08-every-filer',
    date: '2026-11-08',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'Every 13F filer: /v1/filers lists all of them (about 9,000) with `curated`; ?curated=true|false filters. Holdings work for any filer by its slug or CIK.',
      'Holdings: `latest` as the quarter, `truncated` (true while only the public top-500 shard is available for a filer), filer.curated.',
      'GET /v1/filers/{filer}/holdings?from=&to=: up to 8 quarters per call, with `missing` and `next_from`.',
      'filing.versions[]: every 13F-HR and 13F-HR/A for the period, oldest first, including originals a restatement replaced, each with status current, superseded, merged or not_merged. filing.amendment_type for the served filing.',
      'filing.amendments now lists every 13F-HR/A EDGAR has for the period, of any type and including a served restatement, not only those merged into the book: the amendment subset of versions[].',
      '?version=original|{accession} on holdings: the book exactly as that filing reported it.',
      'GET /v1/events: every Form 4 and 13D/G the investor pages show (each curated filer\'s since its latest 13F, plus what the minute poll parsed), with filer, ticker, cusip, issuer_cik, form and date filters, EDGAR acceptance time, per-class Form 4 holdings, the 13D/G\'s Item 4 (`purpose`) and the same filer\'s previous stake (`prev`).',
      'GET /v1/changes/{quarter}?filer=: that filer\'s new, added, trimmed and exited positions.',
    ],
  },
  {
    id: '2026-11-08-build-stamps',
    date: '2026-11-08',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'Every response carries data_built_at and build_id: when the data was built and which build it is, so a change in served data is detectable.',
      'Position: weight_equity (share of the equity book: SH rows without put/call), value_scale, value_as_filed, value_adjusted, zero_value, passed through from the data run when it publishes them.',
      'filing.filer_cik: the CIK that filed (e.g. Pershing Square for Ackman).',
      'GET /v1/changelog (no key needed). Versioning policy in the spec.',
      'weight_equity: the equity-only weight (SH rows without put/call over their summed value; null for options and PRN rows). `weight` keeps its meaning until Feb 8, 2027; see 2026-11-09-weight-equity-only.',
    ],
  },
  {
    id: '2026-11-08-launch',
    date: '2026-11-08',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: ['Launch: /v1/me, /v1/filers, /v1/filers/{filer}/holdings/{quarter} with filing.accepted_at and amendments[] objects, schema_version, stable error codes, per-key rate limits.'],
  },
];

/** One timestamp format across /v1: ISO 8601 UTC to the second, no milliseconds (2026-11-06T21:46:52Z). */
export const noMs = (t: string | null | undefined): string | null => (t ? t.replace(/\.\d+Z$/, 'Z') : null);

/** Which build a response read: data_built_at and build_id. */
export type Stamp = { build_id: string | null; data_built_at: string | null };
/**
 * The build of one R2 object: the build ingest named when uploading it (x-copybook-build-id and
 * x-copybook-built-at, kept as custom metadata), else its upload time. A response that read R2 says so,
 * so old R2 books and a newer static build never share a build_id.
 */
export function stampOf(o: { uploaded?: Date; customMetadata?: Record<string, string> } | null | undefined): Stamp | undefined {
  if (!o) return undefined;
  // Worker uploads store build_id/built_at; direct S3 uploads (x-amz-meta-copybook-build-id) arrive as copybook-build-id.
  const cm = o.customMetadata ?? {};
  const at = noMs(cm.built_at || cm['copybook-built-at'] || o.uploaded?.toISOString() || null);
  const id = cm.build_id || cm['copybook-build-id'] || (at ? `r2-${at.replace(/[-:]/g, '')}` : null);
  return id || at ? { build_id: id, data_built_at: at } : undefined;
}

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
  busy: 'The API is busy; retry after the Retry-After seconds.',
} as const;
export type ErrorCode = keyof typeof ERRORS;

const base = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'private, no-store' };
// The changelog on the base this request came in on (gene's front door keeps its /copybook prefix).
const WEIGHT_DEPRECATION = (base: string) => ({ deprecation: '@1794182400', sunset: 'Mon, 08 Feb 2027 00:00:00 GMT', link: `<${base}/v1/changelog?id=2026-11-09-weight-equity-only>; rel="deprecation"`, 'access-control-expose-headers': 'deprecation, sunset, link, retry-after' });

export function v1json(data: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ schema_version: SCHEMA_VERSION, ...build, ...data }), { status, headers: { ...base, ...headers } });
}

/** The start of a /v1 JSON body, up to the comma before the payload: for streamed responses. */
export function v1prefix(): string {
  return JSON.stringify({ schema_version: SCHEMA_VERSION, ...build }).slice(0, -1) + ',';
}

export function v1error(code: ErrorCode, status: number, message?: string, headers: Record<string, string> = {}): Response {
  return v1json({ error: { code, message: message ?? ERRORS[code] } }, status, headers);
}

export interface V1Context {
  env: Env;
  req: Request;
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
      return v1json({ data: { key: { id: key.id, name: key.name, prefix: key.prefix, created: noMs(key.created), last_used_at: noMs(u.last_used_at) }, usage: u.days } });
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
  if (b) {
    build = JSON.parse(b);
    build.data_built_at = noMs(build.data_built_at);
  }
  if (path === '/v1/changelog') {
    // Entries that ship when a data upload lands (the backstop sets v1:fixed:{id} once /v1 serves it).
    const fixed = await env.DB.get('v1:fixed:refiled-amendments');
    const data = CHANGELOG.map((c) => (c.id === '2026-11-09-refiled-amendments' && fixed ? { ...c, status: 'shipped' as const } : c));
    // ?id= returns one entry (the Deprecation Link points at it).
    const id = url.searchParams.get('id');
    const one = id ? data.filter((c) => c.id === id) : data;
    if (id && !one.length) return v1error('not_found', 404, `No changelog entry ${id}.`);
    return v1json({ data: one }, 200, { 'cache-control': 'public, max-age=300' });
  }
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
    const res = await handler({ env, req, url, key: auth.key }, m.slice(1));
    for (const [k, v] of Object.entries(limits)) res.headers.set(k, v);
    // `weight` in positions turns equity-only on Feb 8, 2027 (RFC 9745 Deprecation, RFC 8594 Sunset).
    if (/\/holdings/.test(path) && res.status === 200) for (const [k, v] of Object.entries(WEIGHT_DEPRECATION(linkBase(env, req, url)))) res.headers.set(k, v);
    return res;
  }
  return v1error('not_found', 404, undefined, limits);
}
