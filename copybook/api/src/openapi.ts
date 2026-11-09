import { LIMITS } from './keys';
import { CHANGELOG, ERRORS, SCHEMA_VERSION } from './v1';

const META = {
  schema_version: { type: 'string', description: 'Response schema version (a date). See the versioning policy.' },
  data_built_at: { type: ['string', 'null'], format: 'date-time', description: 'When the served data was built (UTC). Changes whenever the data is rebuilt.' },
  build_id: { type: ['string', 'null'], description: 'Identifier of the data build. Compare across calls to detect that served data changed.' },
};

function envelope(data: unknown, extra: Record<string, unknown> = {}) {
  return { type: 'object', required: ['schema_version', 'data_built_at', 'build_id', 'data'], properties: { ...META, data, ...extra } };
}

const json = (schema: unknown, example: unknown) => ({ 'application/json': { schema, example } });
const BUILD = { schema_version: SCHEMA_VERSION, data_built_at: '2026-11-08T21:29:01Z', build_id: '20261108T212901Z' };

const POSITION_EXAMPLE = {
  cusip: '02079K305', ticker: 'GOOGL', issuer: 'ALPHABET INC', title_of_class: 'CAP STK CL A', put_call: null, sector: 'Communication Services',
  shares: 54000000, shares_type: 'SH', value_usd: 9512640000, weight: 0.0367, weight_equity: 0.0367, value_scale: null, value_as_filed: null, value_adjusted: null, zero_value: false,
  change: 'added', prev_shares: 4200000, share_change: 49800000, value_delta_usd: 8770349040, source_accession: null, first_disclosed_at: null,
};

/** OpenAPI 3.1 description of /v1, served at /v1/openapi.json. */
export function openapi() {
  const error = {
    type: 'object',
    required: ['schema_version', 'error'],
    properties: {
      ...META,
      error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string', enum: Object.keys(ERRORS) }, message: { type: 'string' } } },
    },
  };
  const errResponses = Object.fromEntries(
    [
      ['401', 'unauthorized or invalid_key'],
      ['402', 'subscription_inactive'],
      ['403', 'pro_required'],
      ['404', 'not_found'],
      ['429', 'rate_limited'],
    ].map(([s, d]) => [s, { description: d, content: json({ $ref: '#/components/schemas/Error' }, { ...BUILD, error: { code: d.split(' ')[0], message: ERRORS[d.split(' ')[0] as keyof typeof ERRORS] } }) }]),
  );
  return {
    openapi: '3.1.0',
    info: {
      title: 'Copybook API',
      version: SCHEMA_VERSION,
      description: `13F holdings, Form 4 and Schedule 13D/G data from SEC EDGAR, as filed. Copy Pro and Copy Fund. Units: money is whole US dollars (filings reported in thousands are rescaled); shares are as filed (principal amount for PRN rows); weights and fractions are 0-1; dates are ISO 8601, datetimes UTC. Authenticate with \`Authorization: Bearer cbk_live_...\` (create keys on your Copybook account page). Limits per key: ${LIMITS.minute} requests/minute and ${LIMITS.day} requests/day, reported in RateLimit-* and X-RateLimit-* headers; 429 responses carry Retry-After. Every response has \`schema_version\`, \`data_built_at\` and \`build_id\`. Error codes: ${Object.entries(ERRORS).map(([k, v]) => `\`${k}\` (${v})`).join('; ')}.

**Coverage.** Every 13F filer (about 9,000). /v1/filers marks Copybook's curated filers with \`curated: true\`; they have quarterly history with changes. Other filers serve their latest 13F, from the full book when it is loaded and otherwise the top 500 positions by value (\`truncated: true\`), plus earlier quarters as full books are loaded.

**Send a User-Agent.** Requests with Python urllib's default User-Agent (\`Python-urllib/3.x\`) are refused by Cloudflare before they reach the API, with HTTP 403 and "error code: 1010" (not a JSON error). Set any descriptive User-Agent, e.g. \`urllib.request.Request(url, headers={"User-Agent": "myfund-research/1.0", "Authorization": "Bearer ..."})\`. requests, httpx, curl and Go's net/http work as they are.

**Versioning policy.** \`schema_version\` is a date and changes only on a breaking change. Not breaking (no new version, listed in /v1/changelog): new endpoints, new optional query parameters, new response fields, new values in enums documented as growing (\`type\`, \`status\`), new error codes for new situations. Breaking: removing or renaming a field, changing a field's type, unit or meaning, removing an endpoint or parameter, changing an existing error code. From public launch, breaking changes are announced in /v1/changelog and by email to key owners at least 90 days before they take effect (before launch they ship directly and are logged in /v1/changelog); during that window the old shape stays available to clients that pin it by sending \`Copybook-Schema-Version: <date>\` (an unknown version returns 400 bad_request). Data corrections (a restated filing, a better CUSIP-to-ticker map) are not schema changes; they show up as a new \`build_id\`.

**Weight.** \`weight\` is the share of the equity book: value_usd over the summed value of SH rows without put/call, as a 0-1 fraction; null for options and PRN rows. It takes that definition as soon as the data run publishes it per row; until then it is value_usd over the filing's total reported value, all rows. \`weight_equity\` always carries the equity-only value and is an alias of \`weight\` for one release after the switch.

**Non-curated filers.** Holdings of filers outside the curated set carry \`change\`, \`prev_shares\`, \`share_change\` and \`value_delta_usd\` only once a prior quarter is on file for them (the data run back-fills one for every filer a member follows, peers and linked books included); until then those fields are null. \`shares_type\` is null until the data run publishes it for them.

**Webhooks (Copy Pro).** Each alert is POSTed as JSON to the URL set in /account/ (see \`webhooks\` below for the payload). Headers: \`Copybook-Delivery\` (the alert id, stable across retries: use it to deduplicate) and \`Copybook-Signature: t=<unix seconds>,v1=<hex>\`, where v1 is HMAC-SHA256, keyed with your \`whsec_\` secret (the whole string, prefix included), over the bytes \`<t>.<raw body>\`. To verify: split the header on commas, recompute the HMAC over t, a dot and the raw request body exactly as received, compare in constant time, and reject a t more than 5 minutes from your clock (the replay window; each attempt is signed afresh with its own t). Answer 2xx within 10 seconds; anything else is retried after 1, 5, 30, 120 and 720 minutes, then dropped. Rotating the secret in /account/ takes effect on the next delivery. **Copy Fund teams:** the owner's webhook is the team's. Team alerts reach it once, signed with the team secret; seats see that secret read-only in their account and can't save the same URL with a secret of their own (409 already_team_channel).

**Changelog.** ${CHANGELOG.flatMap((c) => c.changes.map((x) => `${c.date} (${c.status}): ${x}`)).join(' ')}`,
    },
    servers: [{ url: 'https://copybook-api.factordynamics.workers.dev' }],
    'x-versioning': { current: SCHEMA_VERSION, pin_header: 'Copybook-Schema-Version', notice_days: 90, changelog: '/v1/changelog' },
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'A Copybook API key, cbk_live_...' } },
      parameters: {
        filer: { name: 'filer', in: 'path', required: true, description: 'Filer slug from /v1/filers (e.g. warren-buffett) or its SEC CIK, with or without leading zeros (1067983).', schema: { type: 'string' } },
        quarter: { name: 'quarter', in: 'path', required: true, description: 'Calendar quarter of the 13F report period, e.g. 2025Q1 for the period ending 2025-03-31, or latest.', schema: { type: 'string', pattern: '^(\\d{4}Q[1-4]|latest)$' } },
        as_of: {
          name: 'as_of',
          in: 'query',
          required: false,
          description:
            'NOT YET SERVED (returns 501 not_yet_available). Planned semantics: an ISO 8601 date or UTC datetime; the response is the book exactly as it was publicly known at that instant, i.e. only rows whose first_disclosed_at <= as_of, taken from the original 13F-HR and any amendments accepted by then (a RESTATEMENT amendment replaces the book from its acceptance; a NEW HOLDINGS amendment adds rows). Without as_of the book is the latest known, amendments merged.',
          schema: { type: 'string', format: 'date-time' },
        },
      },
      schemas: {
        Error: error,
        Usage: { type: 'array', items: { type: 'object', required: ['day', 'requests'], properties: { day: { type: 'string', format: 'date', description: 'UTC day' }, requests: { type: 'integer', description: 'Allowed requests that day (429s not counted)' } } } },
        Filer: {
          type: 'object',
          required: ['slug', 'cik', 'name', 'manager', 'featured', 'status', 'latest_quarter', 'latest_report_date', 'latest_filing_date', 'latest_accession', 'total_value_usd', 'position_count', 'history_quarters', 'curated', 'type'],
          properties: {
            curated: { type: 'boolean', description: "In Copybook's curated list (quarterly history and changes). Fields other filers lack are null." },
            slug: { type: 'string', description: 'Stable Copybook identifier' },
            cik: { type: 'string', pattern: '^\\d{10}$', description: 'SEC CIK, 10 digits' },
            name: { type: 'string', description: 'Filer name as on EDGAR' },
            manager: { type: ['string', 'null'], description: 'Display name (the person, for superinvestors); null for filers outside the curated list' },
            featured: { type: 'boolean' },
            type: { type: ['string', 'null'], enum: ['hedge_fund', 'active', 'bank', 'broker', 'index', 'other', null], description: 'Filer type; null until the data run classifies the filer.' },
            status: { type: ['string', 'null'], enum: ['current', 'stale', 'inactive', 'empty_latest', 'reported_by_other', 'notice_pending', 'unreadable_latest', null] },
            latest_quarter: { type: ['string', 'null'] },
            latest_report_date: { type: ['string', 'null'], format: 'date' },
            latest_filing_date: { type: ['string', 'null'], format: 'date', description: 'EDGAR filing date (ET)' },
            latest_accession: { type: ['string', 'null'], description: 'Accession of the latest original 13F-HR' },
            total_value_usd: { type: ['integer', 'null'], description: 'Reported value of the latest filing, whole USD' },
            position_count: { type: ['integer', 'null'], description: 'Distinct (CUSIP, put/call) positions' },
            history_quarters: { type: 'array', items: { type: 'string' }, description: 'Quarters available, newest first' },
          },
        },
        Position: {
          type: 'object',
          description: 'One position: info-table rows summed per (CUSIP, put/call).',
          required: ['cusip', 'ticker', 'issuer', 'title_of_class', 'put_call', 'sector', 'shares', 'shares_type', 'value_usd', 'weight', 'weight_equity', 'value_scale', 'value_as_filed', 'value_adjusted', 'zero_value', 'change', 'prev_shares', 'share_change', 'value_delta_usd', 'source_accession', 'first_disclosed_at'],
          properties: {
            cusip: { type: 'string', pattern: '^[0-9A-Z]{9}$' },
            ticker: { type: ['string', 'null'], description: 'Mapped from CUSIP; null when unknown' },
            issuer: { type: 'string', description: 'nameOfIssuer exactly as filed (not re-cased)' },
            title_of_class: { type: ['string', 'null'] },
            put_call: { type: ['string', 'null'], enum: ['Put', 'Call', null], description: 'Options rows: value_usd is the underlying, as filed' },
            sector: { type: ['string', 'null'], description: 'GICS-style sector, when mapped' },
            shares: { type: 'number', description: 'sshPrnamt as filed: shares (SH) or principal amount (PRN). 0 for exited rows.' },
            shares_type: { type: ['string', 'null'], enum: ['SH', 'PRN', null], description: 'sshPrnamtType as filed: SH (shares) or PRN (principal amount, e.g. convertible notes). Null until the data run publishes it; until then a PRN row is counted in weight like any other.' },
            value_usd: { type: 'integer', description: 'Reported value, whole USD. 0 for exited rows.' },
            weight: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'Share of the equity book, 0-1: value_usd over the summed value of SH rows without put/call; null for options and PRN rows. Until the data run publishes the equity-only weight, the older definition applies: value_usd / filing total_value_usd over all rows. See /v1/changelog.' },
            weight_equity: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'Equity-only weight, the same value `weight` carries once switched; an alias kept for one release. Null for options and PRN rows. Until shares_type is published, a PRN row without it counts as equity.' },
            value_scale: { type: ['number', 'null'], description: 'Factor applied to the value as filed to get whole USD (1000 for filers that reported in thousands). Null until the data run publishes it.' },
            value_as_filed: { type: ['number', 'null'], description: 'The value column exactly as filed, before value_scale. Null until published.' },
            value_adjusted: { type: ['boolean', 'null'], description: 'True when value_usd differs from value_as_filed x 1 (a unit fix was applied). Null until published.' },
            zero_value: { type: 'boolean', description: 'True for a held row filed with value 0 (not an exit); weight is 0 for it.' },
            change: { type: ['string', 'null'], enum: ['new', 'added', 'trimmed', 'unchanged', 'exited', null], description: 'vs prev_quarter; null when there is no prior quarter' },
            prev_shares: { type: ['number', 'null'], description: 'Shares in prev_quarter (0 for new)' },
            share_change: { type: ['number', 'null'], description: 'shares - prev_shares' },
            value_delta_usd: { type: ['integer', 'null'], description: 'Trade size in whole USD at this filing\'s own value per share: +value for new, -prior value for exited, share_change x value/shares otherwise. A price move alone is 0.' },
            source_accession: { type: ['string', 'null'], description: 'Point-in-time: the accession (original 13F-HR or amendment) this row was disclosed in. Null until point-in-time data is published.' },
            first_disclosed_at: { type: ['string', 'null'], format: 'date-time', description: 'Point-in-time: EDGAR acceptance datetime (UTC) of source_accession. Null until point-in-time data is published.' },
          },
        },
        Holdings: {
          type: 'object',
          required: ['filer', 'quarter', 'report_date', 'filing', 'prev_quarter', 'total_value_usd', 'position_count', 'truncated', 'holdings', 'exited'],
          properties: {
            filer: { type: 'object', required: ['slug', 'cik', 'name', 'manager', 'curated'], properties: { slug: { type: 'string' }, cik: { type: 'string' }, name: { type: 'string' }, manager: { type: ['string', 'null'] }, curated: { type: 'boolean' } } },
            truncated: { type: 'boolean', description: 'True when only the top 500 positions by value are served (position_count has the full count).' },
            quarter: { type: 'string' },
            report_date: { type: 'string', format: 'date', description: 'periodOfReport' },
            filing: {
              type: 'object',
              required: ['accession', 'filer_cik', 'form', 'filing_date', 'accepted_at', 'sec_url', 'amendments'],
              properties: {
                accession: { type: 'string', description: 'The original 13F-HR' },
                filer_cik: { type: 'string', pattern: '^\\d{10}$', description: 'CIK of the entity that filed this 13F (may differ from the manager, e.g. Pershing Square Capital Management for Bill Ackman)' },
                form: { type: 'string' },
                filing_date: { type: 'string', format: 'date', description: 'EDGAR filing date (ET)' },
                accepted_at: { type: ['string', 'null'], format: 'date-time', description: 'EDGAR acceptance datetime of the original, UTC (from the filing index headers). Null only if EDGAR could not be read.' },
                sec_url: { type: 'string', format: 'uri' },
                amendments: {
                  type: 'array',
                  description: 'The subset of versions[] that are amendments: every 13F-HR/A EDGAR has for this period, oldest first, of any type (RESTATEMENT or NEW HOLDINGS), including the served filing when it is a restatement, merged or not. A quarter whose book changed after a date you care about has an amendment accepted after it.',
                  items: {
                    type: 'object',
                    required: ['accession', 'filed_on', 'accepted_at', 'amendment_type', 'amendment_no', 'confidential_treatment_expired'],
                    properties: {
                      accession: { type: 'string' },
                      filed_on: { type: ['string', 'null'], format: 'date' },
                      accepted_at: { type: ['string', 'null'], format: 'date-time', description: 'UTC' },
                      amendment_type: { type: ['string', 'null'], enum: ['NEW HOLDINGS', 'RESTATEMENT', null], description: 'From the amendment cover page: NEW HOLDINGS adds rows, RESTATEMENT replaces the book' },
                      amendment_no: { type: ['integer', 'null'] },
                      confidential_treatment_expired: { type: ['boolean', 'null'], description: 'True when the amendment discloses positions whose confidential treatment was denied or expired (backdated disclosure)' },
                    },
                  },
                },
                amendment_type: { type: ['string', 'null'], enum: ['NEW HOLDINGS', 'RESTATEMENT', null], description: 'The served filing\'s own amendment type (RESTATEMENT when a restatement replaced the original)' },
                versions: {
                  type: ['array', 'null'],
                  description: 'The full lineage: every 13F-HR and 13F-HR/A for this period, oldest first, including originals a restatement replaced, each with its status. amendments is the subset that are 13F-HR/A. null when EDGAR could not be read; retry.',
                  items: {
                    type: 'object',
                    required: ['accession', 'form', 'amendment_type', 'accepted_at', 'filed_on', 'status'],
                    properties: {
                      accession: { type: 'string' },
                      form: { type: 'string', enum: ['13F-HR', '13F-HR/A'] },
                      amendment_type: { type: ['string', 'null'], enum: ['NEW HOLDINGS', 'RESTATEMENT', null] },
                      accepted_at: { type: ['string', 'null'], format: 'date-time' },
                      filed_on: { type: ['string', 'null'], format: 'date' },
                      status: { type: 'string', enum: ['current', 'superseded', 'merged', 'not_merged'], description: 'current: the served book; superseded: replaced by a later restatement; merged: NEW HOLDINGS folded into the served book; not_merged: filed after the served book and not folded in yet' },
                    },
                  },
                },
              },
            },
            prev_quarter: { type: ['string', 'null'], description: 'The quarter `change` fields compare against' },
            total_value_usd: { type: 'integer', description: 'Reported total, whole USD' },
            position_count: { type: 'integer' },
            holdings: { type: 'array', items: { $ref: '#/components/schemas/Position' } },
            exited: { type: 'array', items: { $ref: '#/components/schemas/Position' }, description: 'Positions in prev_quarter absent now (shares 0, value 0)' },
          },
        },
      },
    },
    paths: {
      '/v1/me': {
        get: {
          summary: 'The calling key and its daily request counts for the last 30 days',
          responses: {
            '200': {
              description: 'Key and usage',
              content: json(envelope({ type: 'object', properties: { key: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, prefix: { type: 'string' }, created: { type: 'string', format: 'date-time' }, last_used_at: { type: ['string', 'null'], format: 'date-time', description: 'Latest use, to the minute' } } }, usage: { $ref: '#/components/schemas/Usage' } } }), { ...BUILD, data: { key: { id: 'k_8f3a', name: 'research', prefix: 'cbk_live_8f3a', created: '2026-11-08T19:02:11Z', last_used_at: '2026-11-08T21:40:00Z' }, usage: [{ day: '2026-11-08', requests: 412 }] } }),
            },
            ...errResponses,
          },
        },
      },
      '/v1/filers': {
        get: {
          summary: 'Every filer Copybook covers, with its latest 13F and available quarters',
          description: 'Every 13F filer: curated filers first, then all others. ?curated=true or false filters.',
          parameters: [{ name: 'curated', in: 'query', required: false, schema: { type: 'string', enum: ['true', 'false'] } }],
          responses: {
            '200': {
              description: 'Filers',
              content: json(envelope({ type: 'array', items: { $ref: '#/components/schemas/Filer' } }, { count: { type: 'integer' } }), {
                ...BUILD,
                data: [
                  { slug: 'warren-buffett', cik: '0001067983', name: 'Berkshire Hathaway Inc', manager: 'Warren Buffett', featured: true, status: 'current', latest_quarter: '2026Q2', latest_report_date: '2026-06-30', latest_filing_date: '2026-08-14', latest_accession: '0001193125-26-352200', total_value_usd: 259000000000, position_count: 41, history_quarters: ['2026Q2', '2026Q1'], curated: true, type: null },
                  { slug: 'whale-rock-capital-management-llc-7322', cik: '0001387322', name: 'Whale Rock Capital Management LLC', manager: null, featured: false, status: null, latest_quarter: '2026Q2', latest_report_date: '2026-06-30', latest_filing_date: '2026-08-14', latest_accession: null, total_value_usd: null, position_count: 35, history_quarters: ['2026Q2'], curated: false, type: null },
                ],
                count: 8964,
              }),
            },
            ...errResponses,
          },
        },
      },
      '/v1/filers/{filer}/holdings/{quarter}': {
        get: {
          summary: "A filer's full 13F book for one quarter, with changes vs the prior quarter",
          parameters: [
            { $ref: '#/components/parameters/filer' },
            { $ref: '#/components/parameters/quarter' },
            { $ref: '#/components/parameters/as_of' },
            { name: 'version', in: 'query', required: false, description: 'original, or an accession from filing.versions: the book exactly as that one filing reported it (no changes vs the prior quarter; `change` fields are null). Response adds `version`. 501 when that filing is too large to read live and the data run has not published it yet.', schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Holdings',
              content: json(envelope({ $ref: '#/components/schemas/Holdings' }), {
                ...BUILD,
                data: {
                  filer: { slug: 'warren-buffett', cik: '0001067983', name: 'Berkshire Hathaway Inc', manager: 'Warren Buffett', curated: true },
                  quarter: '2026Q2',
                  report_date: '2026-06-30',
                  filing: { accession: '0001193125-26-352200', filer_cik: '0001067983', form: '13F-HR', filing_date: '2026-08-14', accepted_at: '2026-08-14T20:05:12Z', sec_url: 'https://www.sec.gov/Archives/edgar/data/1067983/000119312526352200/0001193125-26-352200-index.html', amendment_type: null, amendments: [], versions: [{ accession: '0001193125-26-352200', form: '13F-HR', amendment_type: null, accepted_at: '2026-08-14T20:05:12Z', filed_on: '2026-08-14', status: 'current' }] },
                  prev_quarter: '2026Q1',
                  total_value_usd: 259000000000,
                  position_count: 41,
                  truncated: false,
                  holdings: [POSITION_EXAMPLE],
                  exited: [],
                },
              }),
            },
            '400': { description: 'bad_request', content: json({ $ref: '#/components/schemas/Error' }, { ...BUILD, error: { code: 'bad_request', message: 'quarter must look like 2025Q1.' } }) },
            '501': { description: 'not_yet_available (as_of)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            ...errResponses,
          },
        },
      },
      '/v1/filers/{filer}/holdings': {
        get: {
          summary: "A filer's books for a range of quarters (at most 8 per call)",
          parameters: [
            { $ref: '#/components/parameters/filer' },
            { name: 'from', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}Q[1-4]$' } },
            { name: 'to', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}Q[1-4]$' } },
          ],
          responses: {
            '200': {
              description: 'One Holdings object per quarter on file, oldest first; quarters without a book are in `missing`. When the range is longer than 8 quarters, `next_from` continues it.',
              content: json(envelope({ type: 'array', items: { $ref: '#/components/schemas/Holdings' } }, { missing: { type: 'array', items: { type: 'string' } }, next_from: { type: ['string', 'null'] } }), { ...BUILD, data: [], missing: ['2025Q4'], next_from: null }),
            },
            '400': { description: 'bad_request', content: json({ $ref: '#/components/schemas/Error' }, { ...BUILD, error: { code: 'bad_request', message: 'from and to must be quarters like 2025Q1, from <= to.' } }) },
            ...errResponses,
          },
        },
      },
      '/v1/stocks/{stock}/holders': {
        get: {
          summary: 'Every 13F holder of one issuer, with the change vs the prior quarter (coming: returns 501 today)',
          'x-status': 'coming',
          description: '**Coming, not live yet:** returns 501 not_yet_available until the data run publishes per-stock holder files; /v1/changelog logs the day it ships. Share classes of one issuer (same 6-character CUSIP issuer code) are rolled up; calls and puts are separate rows (`kind`). Served for the latest complete 13F period.',
          parameters: [
            { name: 'stock', in: 'path', required: true, description: 'Ticker (NVDA), 9-character CUSIP or 6-character issuer code.', schema: { type: 'string' } },
            { name: 'cohort', in: 'query', required: false, schema: { type: 'string', enum: ['all', 'curated'], default: 'all' } },
            { name: 'quarter', in: 'query', required: false, schema: { type: 'string', pattern: '^\\d{4}Q[1-4]$' } },
          ],
          responses: {
            '200': {
              description: 'Holders, largest first',
              content: json(envelope({ type: 'object' }, { count: { type: 'integer' } }), {
                ...BUILD,
                data: { issuer: '67066G', ticker: 'NVDA', display_name: 'NVIDIA', quarter: '2026Q2', prev_quarter: '2026Q1', cohort: 'all', holders: [{ filer: { cik: '0001387322', name: 'Whale Rock Capital Management LLC', slug: 'whale-rock-capital-management-llc-7322' }, kind: 'equity', shares: 1200000, prev_shares: 900000, share_change: 300000, value_usd: 216000000, prev_value_usd: 140000000, change: 'added', accession: null, accepted_at: null }] },
                count: 1,
              }),
            },
            '501': { description: 'not_yet_available: holder lists are loading', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            ...errResponses,
          },
        },
      },
      '/v1/events': {
        get: {
          summary: 'Form 4 and Schedule 13D/G filings, newest first, with filters',
          description: 'The same filings the investor pages show: each curated filer\'s Form 4 and 13D/G since its latest 13F, plus every filing the minute poll parsed (followed filers, and any filer\'s 13D/G on members\' names). Each carries EDGAR\'s acceptance time (`accepted_at`), per-class Form 4 holdings (`classes`), the 13D\'s Item 4 excerpt (`purpose`) and the same filer\'s previous Schedule 13D/G on the issuer (`prev`). Details are read from EDGAR hourly, so a filing from the last hour can show null detail fields until then. Top-level `shares`, `shares_after` and `value_usd` sum every share class the filing reports (Lennar Class A and Class B together); `classes` has the per-class figures. `purpose` is set only on Schedule 13D filings and amendments that state or amend Item 4; it is null for 13Gs.\n\n**By stock (`tickers=`, up to 20; `ticker=` works the same):** besides the curated filers\' own filings (`source: "filer"`), the response adds every Form 4 by the company\'s own insiders (directors, officers, 10% owners) and every Schedule 13D/G any filer made on it (`source: "issuer"`), read from the issuer\'s EDGAR feeds, the same data as My book. Lookback: per ticker, the issuer\'s latest 20 Form 4s and 10 Schedule 13D/Gs on EDGAR, of which the latest 10 matching filings are kept; `coverage[ticker].form4_from` and `schedule13_from` give the oldest acceptance each feed reached (for BRK.B in November 2026, mid-August), so older filings are outside the window. Feeds are re-read at most every 20 minutes. A ticker not loaded yet in this call is listed in `pending`: call again in a second. Issuer rows carry `insider.ownership`, each ownership line (direct, or indirect with its nature such as "By Jain Foundation Inc.") with its balance after and its open-market trades.\n\n**Form 4 dates:** `event_date` is the first transaction date and `last_transaction_date` the last (the same day for most filings), on every Form 4 row whatever its source.',
          parameters: [
            { name: 'filer', in: 'query', required: false, description: 'Filer slug or CIK', schema: { type: 'string' } },
            { name: 'ticker', in: 'query', required: false, description: 'One ticker; the same as tickers=', schema: { type: 'string' } },
            { name: 'tickers', in: 'query', required: false, description: 'Up to 20 comma-separated tickers (BRK.B or BRK-B). Adds the issuer-side rows (insiders\' Form 4s, anyone\'s 13D/G) and `coverage`/`pending` to the response.', schema: { type: 'string' } },
            { name: 'cusip', in: 'query', required: false, description: '9-character CUSIP or 6-character issuer code', schema: { type: 'string' } },
            { name: 'issuer_cik', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'form', in: 'query', required: false, description: 'form4, 13d, 13g (comma-separated)', schema: { type: 'string' } },
            { name: 'from', in: 'query', required: false, description: 'Filing date, YYYY-MM-DD', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            '200': {
              description: 'Events',
              content: json(envelope({ type: 'array', items: { type: 'object' } }, { count: { type: 'integer' }, next_offset: { type: ['integer', 'null'] } }), {
                ...BUILD,
                data: [{ accession: '0000921669-26-000412', form: 'SC 13D/A', kind: '13d', action: 'stake_update', filer: { slug: 'carl-icahn', cik: '0000921669', name: 'Carl Icahn' }, issuer: { name: 'CVR ENERGY INC', cik: '0001376139', ticker: 'CVI', cusip: '12662P108', display_name: 'CVR Energy' }, filing_date: '2026-11-05', accepted_at: '2026-11-05T21:14:03Z', event_date: '2026-11-03', last_transaction_date: null, source: 'filer', shares: null, value_usd: null, avg_price: null, shares_after: 71198718, percent_of_class: 64.1, ten_percent_owner: null, amendment_no: 27, prev: { accession: '0000921669-25-000301', form: 'SC 13D/A', percent_of_class: 70.8, shares_after: 71198718 }, classes: null, purpose: null, insider: null, details_pending: false, sec_url: 'https://www.sec.gov/Archives/edgar/data/921669/000092166926000412/0000921669-26-000412-index.html' }],
                count: 1,
                next_offset: null,
              }),
            },
            ...errResponses,
          },
        },
      },
      '/v1/changes/{quarter}': {
        get: {
          summary: 'New, added, trimmed and exited positions for one report period, largest moves first',
          'x-status': 'partial',
          'x-status-detail': { 'filer=': 'live', 'ticker= / cusip=': 'coming', 'across filers': 'coming' },
          description: 'With filer=: that filer\'s change rows (exact); live. **Coming, not live yet** (501 not_yet_available until the data run publishes their files; /v1/changelog logs the day each ships): with ticker= or cusip=, every 13F holder\'s change in that stock; without either, across all filers with cohort=curated or a filer type.',
          parameters: [
            { $ref: '#/components/parameters/quarter' },
            { name: 'change', in: 'query', required: false, description: 'new, added, trimmed, exited (comma-separated)', schema: { type: 'string' } },
            { name: 'filer', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'ticker', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'cusip', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'cohort', in: 'query', required: false, description: 'all, curated, or a filer type (hedge_fund, active, bank, broker, index, other)', schema: { type: 'string', default: 'all' } },
            { name: 'min_value_usd', in: 'query', required: false, description: 'Smallest |value_delta_usd|', schema: { type: 'number', minimum: 0 } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            '200': {
              description: 'Change rows',
              content: json(envelope({ type: 'array', items: { type: 'object' } }, { quarter: { type: 'string' }, count: { type: 'integer' }, next_offset: { type: ['integer', 'null'] } }), {
                ...BUILD,
                data: [{ filer: { cik: '0001067983', slug: 'warren-buffett', name: 'Berkshire Hathaway Inc', curated: true }, cusip: '02079K305', ticker: 'GOOGL', issuer: 'ALPHABET INC', put_call: null, shares: 54000000, prev_shares: 4200000, share_change: 49800000, value_usd: 9512640000, value_delta_usd: 8770349040, change: 'added' }],
                quarter: '2026Q2',
                count: 1,
                next_offset: null,
              }),
            },
            '501': { description: 'not_yet_available: cross-filer changes not published yet', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            ...errResponses,
          },
        },
      },
      '/v1/bulk': {
        get: {
          summary: 'Persistent bulk exports: every filer\'s 13F book for a quarter, as gzip CSV (partial: csv.gz live, Parquet coming)',
          'x-status': 'partial',
          description: '**Partial:** gzip CSVs are live for the quarters listed. Parquet is coming. The files are as-filed books, not point-in-time yet: no accepted_at, source_accession, first_disclosed_at or change columns. Only files that pass a size check are listed. Known issue: Marsh & McLennan 2026Q2 is double counted until the data run\'s mislabeled-amendment fix lands.',
          responses: {
            '200': {
              description: 'Available files, newest first',
              content: json(envelope({ type: 'array', items: { type: 'object', required: ['file', 'quarter', 'bytes', 'uploaded_at', 'url'], properties: { file: { type: 'string' }, quarter: { type: 'string' }, bytes: { type: 'integer' }, uploaded_at: { type: 'string', format: 'date-time' }, url: { type: 'string' } } } }), { ...BUILD, data: [{ file: '2026Q2.csv.gz', quarter: '2026Q2', bytes: 48211933, uploaded_at: '2026-11-09T02:10:00Z', url: 'https://copybook-api.factordynamics.workers.dev/v1/bulk/2026Q2.csv.gz' }] }),
            },
            ...errResponses,
          },
        },
      },
      '/v1/bulk/{file}': {
        get: {
          summary: 'Download one bulk export (streams the file; not JSON) (partial: .csv.gz live, .parquet returns 501)',
          'x-status': 'partial',
          description: '**Partial:** .csv.gz streams for every quarter GET /v1/bulk lists; .parquet, and any quarter not listed, return 501 not_yet_available.',
          parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string', pattern: '^\\d{4}Q[1-4]\\.(csv\\.gz|parquet)$' } }],
          responses: { '200': { description: 'The file', content: { 'application/gzip': {}, 'application/vnd.apache.parquet': {} } }, '501': { description: 'not_yet_available: not published yet', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, ...errResponses },
        },
      },
      '/v1/changelog': {
        get: {
          summary: 'Changes to /v1, newest first. No API key needed.',
          security: [],
          responses: {
            '200': {
              description: 'Changelog',
              content: json(envelope({ type: 'array', items: { type: 'object', required: ['date', 'schema_version', 'breaking', 'status', 'changes'], properties: { date: { type: 'string', format: 'date' }, schema_version: { type: 'string' }, breaking: { type: 'boolean' }, status: { type: 'string', enum: ['shipped', 'announced'], description: 'shipped: live and returning data. announced: coming; not live yet.' }, changes: { type: 'array', items: { type: 'string' } } } } }), { ...BUILD, data: CHANGELOG.slice(0, 1) }),
            },
          },
        },
      },
    } as Record<string, unknown>,
    webhooks: {
      alert: {
        post: {
          summary: 'One alert, POSTed to your webhook URL (Copy Pro)',
          description: 'Sent once per filing (13F) or event (Form 4, 13D/G, insider buy, cluster). A follow-up with the same accession and `followup: true` (id suffixed :moves or :details) completes an alert first sent before its detail could be read. Verify Copybook-Signature as described in the API description.',
          parameters: [
            { name: 'Copybook-Signature', in: 'header', required: true, description: 't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed with the whsec_ secret>', schema: { type: 'string' }, example: 't=1794180000,v1=5f2b…' },
            { name: 'Copybook-Delivery', in: 'header', required: true, description: 'The alert id; the same across retries.', schema: { type: 'string' }, example: '0001193125-26-352200' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['schema_version', 'type', 'id', 'detected_at', 'filer', 'sec_url'],
                  properties: {
                    schema_version: { type: 'string' },
                    type: { type: 'string', enum: ['13f', 'form4', '13d', '13g', 'insider_buy', 'insider_cluster', 'test'], description: 'test: sent by "Send a test" in /account/, with a unique id and Copybook-Delivery each time; no filing behind it.' },
                    id: { type: 'string', description: 'Accession, with :moves or :details on a follow-up; cluster ids start with cluster:.' },
                    accession: { type: ['string', 'null'] },
                    form: { type: 'string' },
                    accepted_at: { type: ['string', 'null'], format: 'date-time', description: "EDGAR's acceptance time (UTC)." },
                    detected_at: { type: 'string', format: 'date-time', description: 'When Copybook read the filing.' },
                    followup: { type: 'boolean' },
                    filer: { type: 'object', properties: { slug: { type: ['string', 'null'] }, manager: { type: 'string' }, name: { type: 'string' } } },
                    quarter: { type: 'string', description: '13f only' },
                    report_date: { type: 'string', format: 'date', description: '13f only' },
                    moves: { type: ['object', 'null'], description: "13f only: { bought_usd, sold_usd, new[], added[], trimmed[], exited[] }, each row { cusip, ticker, issuer, shares, prev_shares, value, value_delta, ... }; null when the filing is too large to read live (a followup carries it)." },
                    top_holdings: { type: ['array', 'null'], description: '13f only: largest holdings when there is no prior quarter to compare.' },
                    issuer: { type: 'string', description: 'events only' },
                    ticker: { type: ['string', 'null'] },
                    action: { type: ['string', 'null'], description: 'buy, sell, mixed, other (Form 4); new_stake, stake_update, exit (13D/G)' },
                    details_pending: { type: 'boolean' },
                    shares: { type: ['number', 'null'] },
                    value_usd: { type: ['number', 'null'] },
                    avg_price: { type: ['number', 'null'] },
                    classes: { type: ['array', 'null'], description: 'Form 4 per share class: { security, bought, sold, value_usd, shares_before, shares_after }' },
                    percent_of_class: { type: ['number', 'null'], description: '0-100, as filed' },
                    shares_after: { type: ['number', 'null'] },
                    prev_percent_of_class: { type: ['number', 'null'] },
                    prev_shares_after: { type: ['number', 'null'] },
                    amendment_no: { type: ['integer', 'null'] },
                    item4: { type: ['string', 'null'], description: '13D Item 4 (purpose of transaction), excerpt' },
                    insider: { type: ['object', 'null'], description: 'insider_buy: { name, roles[], bought_usd }' },
                    insiders: { type: ['array', 'null'], description: 'insider_cluster: the insiders who bought' },
                    sec_url: { type: 'string' },
                    copybook_url: { type: ['string', 'null'] },
                  },
                },
                example: { schema_version: '2026-11-08', type: '13d', id: '0001193125-26-451979', accession: '0001193125-26-451979', form: 'SCHEDULE 13D/A', accepted_at: '2026-11-06T21:15:32Z', detected_at: '2026-11-06T21:16:01Z', filer: { slug: 'carl-icahn', name: 'Carl Icahn' }, issuer: 'CVR Energy, Inc.', ticker: 'CVI', action: 'stake_update', details_pending: false, followup: false, shares: null, value_usd: null, avg_price: null, classes: null, percent_of_class: 64.1, shares_after: 71201875, prev_percent_of_class: 70.8, prev_shares_after: 71201875, amendment_no: 41, item4: null, insider: null, insiders: null, sec_url: 'https://www.sec.gov/Archives/edgar/data/921669/000119312526451979/0001193125-26-451979-index.html', copybook_url: 'https://copybook.factordynamics.com/investors/carl-icahn' },
              },
            },
          },
          responses: { '200': { description: 'Any 2xx acknowledges the delivery.' } },
        },
      },
    },
  };
}
