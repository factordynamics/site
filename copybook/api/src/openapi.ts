import { LIMITS } from './keys';
import { ERRORS, SCHEMA_VERSION } from './v1';

function envelope(data: unknown, extra: Record<string, unknown> = {}) {
  return { type: 'object', required: ['schema_version', 'data'], properties: { schema_version: { type: 'string' }, data, ...extra } };
}

/** OpenAPI 3.1 description of /v1, served at /v1/openapi.json. */
export function openapi() {
  const error = {
    type: 'object',
    required: ['schema_version', 'error'],
    properties: {
      schema_version: { type: 'string' },
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
    ].map(([s, d]) => [s, { description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }]),
  );
  return {
    openapi: '3.1.0',
    info: {
      title: 'Copybook API',
      version: SCHEMA_VERSION,
      description: `13F holdings, Form 4 and Schedule 13D/G data from SEC EDGAR, as filed. Copy Pro and Copy Fund. Units: money is whole US dollars (filings reported in thousands are rescaled); shares are as filed (principal amount for PRN rows); weights and fractions are 0-1; dates are ISO 8601, datetimes UTC. Authenticate with \`Authorization: Bearer cbk_live_...\` (create keys on your Copybook account page). Limits per key: ${LIMITS.minute} requests/minute and ${LIMITS.day} requests/day, reported in RateLimit-* and X-RateLimit-* headers; 429 responses carry Retry-After. Every response has \`schema_version\`. Error codes: ${Object.entries(ERRORS).map(([k, v]) => `\`${k}\` (${v})`).join('; ')}`,
    },
    servers: [{ url: 'https://copybook-api.factordynamics.workers.dev' }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'A Copybook API key, cbk_live_...' } },
      parameters: {
        filer: { name: 'filer', in: 'path', required: true, description: 'Filer slug from /v1/filers (e.g. warren-buffett) or its SEC CIK, with or without leading zeros (1067983).', schema: { type: 'string' } },
        quarter: { name: 'quarter', in: 'path', required: true, description: 'Calendar quarter of the 13F report period, e.g. 2025Q1 for the period ending 2025-03-31.', schema: { type: 'string', pattern: '^\\d{4}Q[1-4]$' } },
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
          required: ['slug', 'cik', 'name', 'manager', 'featured', 'status', 'latest_quarter', 'latest_report_date', 'latest_filing_date', 'latest_accession', 'total_value_usd', 'position_count', 'history_quarters'],
          properties: {
            slug: { type: 'string', description: 'Stable Copybook identifier' },
            cik: { type: 'string', pattern: '^\\d{10}$', description: 'SEC CIK, 10 digits' },
            name: { type: 'string', description: 'Filer name as on EDGAR' },
            manager: { type: 'string', description: 'Display name (the person, for superinvestors)' },
            featured: { type: 'boolean' },
            type: { type: 'string', enum: ['hedge_fund', 'active', 'bank', 'broker', 'index', 'other'], description: 'Filer type. Omitted until the filer is classified.' },
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
          required: ['cusip', 'ticker', 'issuer', 'title_of_class', 'put_call', 'sector', 'shares', 'shares_type', 'value_usd', 'weight', 'change', 'prev_shares', 'share_change', 'value_delta_usd', 'source_accession', 'first_disclosed_at'],
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
            weight: { type: 'number', minimum: 0, maximum: 1, description: 'value_usd / filing total_value_usd, as a 0-1 fraction (all rows, options included)' },
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
          required: ['filer', 'quarter', 'report_date', 'filing', 'prev_quarter', 'total_value_usd', 'position_count', 'holdings', 'exited'],
          properties: {
            filer: { type: 'object', required: ['slug', 'cik', 'name', 'manager'], properties: { slug: { type: 'string' }, cik: { type: 'string' }, name: { type: 'string' }, manager: { type: 'string' } } },
            quarter: { type: 'string' },
            report_date: { type: 'string', format: 'date', description: 'periodOfReport' },
            filing: {
              type: 'object',
              required: ['accession', 'form', 'filing_date', 'accepted_at', 'sec_url', 'amendments'],
              properties: {
                accession: { type: 'string', description: 'The original 13F-HR' },
                form: { type: 'string' },
                filing_date: { type: 'string', format: 'date', description: 'EDGAR filing date (ET)' },
                accepted_at: { type: ['string', 'null'], format: 'date-time', description: 'EDGAR acceptance datetime of the original, UTC (from the filing index headers). Null only if EDGAR could not be read.' },
                sec_url: { type: 'string', format: 'uri' },
                amendments: {
                  type: 'array',
                  description: '13F-HR/A filings merged into this book, oldest first. A quarter whose book changed after a date you care about has an amendment accepted after it.',
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
              content: { 'application/json': { schema: envelope({ type: 'object', properties: { key: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, prefix: { type: 'string' }, created: { type: 'string', format: 'date-time' }, last_used_at: { type: ['string', 'null'], format: 'date-time', description: 'Latest use, to the minute' } } }, usage: { $ref: '#/components/schemas/Usage' } } }) } },
            },
            ...errResponses,
          },
        },
      },
      '/v1/filers': {
        get: {
          summary: 'Every filer Copybook covers, with its latest 13F and available quarters',
          responses: { '200': { description: 'Filers', content: { 'application/json': { schema: envelope({ type: 'array', items: { $ref: '#/components/schemas/Filer' } }, { count: { type: 'integer' } }) } } }, ...errResponses },
        },
      },
      '/v1/filers/{filer}/holdings/{quarter}': {
        get: {
          summary: "A filer's full 13F book for one quarter, with changes vs the prior quarter",
          parameters: [{ $ref: '#/components/parameters/filer' }, { $ref: '#/components/parameters/quarter' }, { $ref: '#/components/parameters/as_of' }],
          responses: {
            '200': { description: 'Holdings', content: { 'application/json': { schema: envelope({ $ref: '#/components/schemas/Holdings' }) } } },
            '400': { description: 'bad_request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '501': { description: 'not_yet_available (as_of)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            ...errResponses,
          },
        },
      },
    } as Record<string, unknown>,
  };
}
