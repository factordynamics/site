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
/** On holdings 200s: the `weight` deprecation (RFC 9745, RFC 8594) and the key's rate limit (IETF RateLimit headers). */
const HOLDINGS_HEADERS = {
  Deprecation: { description: 'Always `@1794182400`: Position.`weight` changes meaning on Mon Feb 8, 2027 (see Link).', schema: { type: 'string' } },
  Sunset: { description: '`Mon, 08 Feb 2027 00:00:00 GMT`: from then `weight` is the equity-only weight.', schema: { type: 'string' } },
  Link: { description: '`<{base}/v1/changelog?id=2026-11-09-weight-equity-only>; rel="deprecation"`, on the base the request came in on.', schema: { type: 'string' } },
  'RateLimit-Policy': { description: 'Per-minute and per-day limits, e.g. `60;w=60, 10000;w=86400`.', schema: { type: 'string' } },
  'RateLimit-Limit': { description: 'The limit of the window closest to running out.', schema: { type: 'integer' } },
  'RateLimit-Remaining': { description: 'Requests left in that window.', schema: { type: 'integer' } },
  'RateLimit-Reset': { description: 'Seconds until that window resets.', schema: { type: 'integer' } },
  'X-RateLimit-Limit': { description: 'The same value as RateLimit-Limit, under the common legacy name.', schema: { type: 'integer' } },
  'X-RateLimit-Remaining': { description: 'The same value as RateLimit-Remaining.', schema: { type: 'integer' } },
  'X-RateLimit-Reset': { description: 'The same value as RateLimit-Reset (seconds, not a timestamp).', schema: { type: 'integer' } },
};
const BUILD = { schema_version: SCHEMA_VERSION, data_built_at: '2026-11-08T21:29:01Z', build_id: '20261108T212901Z' };

const POSITION_EXAMPLE = {
  cusip: '02079K305', ticker: 'GOOGL', issuer: 'ALPHABET INC', title_of_class: 'CAP STK CL A', put_call: null, sector: 'Communication Services',
  shares: 54000000, shares_type: 'SH', value_usd: 9512640000, weight: 0.0367, weight_incl_options: 0.0367, weight_equity: 0.0367, value_scale: null, value_as_filed: null, value_adjusted: null, zero_value: false,
  change: 'added', prev_shares: 4200000, share_change: 49800000, value_delta_usd: 8770349040, source_accession: null, first_disclosed_at: null, suspect_units: null, split: null, prev_shares_as_filed: null,
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

**Versioning policy.** \`schema_version\` is a date and changes only on a breaking change. Not breaking (no new version, listed in /v1/changelog): new endpoints, new optional query parameters, new response fields, new values in enums documented as growing (\`type\`, \`status\`), new error codes for new situations. Breaking: removing or renaming a field, changing a field's type, unit or meaning, removing an endpoint or parameter, changing an existing error code. Breaking changes are announced in /v1/changelog and by email to key owners at least 90 days before they take effect, and responses affected carry \`Deprecation\` and \`Sunset\` headers; during that window the old shape stays available to clients that pin it by sending \`Copybook-Schema-Version: <date>\` (an unknown version returns 400 bad_request). Data corrections (a restated filing, a better CUSIP-to-ticker map) are not schema changes; they show up as a new \`build_id\`.

**Weight.** \`weight\` is value_usd over the filing's total reported value, all rows, options included, as a 0-1 fraction. **On Mon Feb 8, 2027 it becomes the equity-only weight** (announced Nov 9, 2026 with 90 days' notice; holdings responses carry \`Deprecation\` and \`Sunset\` headers until then). \`weight_equity\` is the equity-only weight now and after (value_usd over the summed value of SH rows without put/call; null for options and PRN rows). \`weight_incl_options\` is today's definition, an explicit alias of \`weight\` that stays after the switch.

**Non-curated filers.** Holdings of filers outside the curated set carry \`change\`, \`prev_shares\`, \`share_change\` and \`value_delta_usd\` only once a prior quarter is on file for them (the data run back-fills one for every filer a member follows, peers and linked books included); until then those fields are null. \`shares_type\` is null until the data run publishes it for them.

**Large files.** JSON responses are always served inline, gzip-compressed when the request sends \`Accept-Encoding: gzip\` (curl \`--compressed\`; \`requests\` and \`fetch\` do by default). Only bulk exports (\`/v1/bulk/{file}\`) and generated CSVs over 1 MB answer \`302\` to a presigned URL on Cloudflare R2 (\`967e13dd88bb23b24662e62cbb6fd84f.r2.cloudflarestorage.com\`), valid 5 minutes, that carries its own authorization; R2 answers 403 once it expires. **Don't send \`Authorization\` to a presigned link:** R2 answers 400. curl, \`requests\` and \`fetch\` drop it on the cross-host redirect; Python's \`urllib\` forwards it, so use a redirect handler that removes it, or read the \`Location\` header and fetch it without the header. Follow redirects: \`curl -L\`.\n\n**Allowlist.** Until the move to api.factordynamics.com, allow \`gene.tail70ba3.ts.net\` (the API) and \`967e13dd88bb23b24662e62cbb6fd84f.r2.cloudflarestorage.com\` (bulk files and CSVs over 1 MB). The public status file is https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/status.json; that copy is canonical, and the API host's own /copybook/status.json may answer 401.\n\n**Webhooks (Copy Pro).** Each alert is POSTed as JSON to the URL set in /account/ (see \`webhooks\` below for the payload). Headers: \`Copybook-Delivery\` (the alert id, stable across retries: use it to deduplicate) and \`Copybook-Signature: t=<unix seconds>,v1=<hex>\`, where v1 is HMAC-SHA256, keyed with your \`whsec_\` secret (the whole string, prefix included), over the bytes \`<t>.<raw body>\`. To verify: split the header on commas, recompute the HMAC over t, a dot and the raw request body exactly as received, compare in constant time, and reject a t more than 5 minutes from your clock (the replay window; each attempt is signed afresh with its own t). Answer 2xx within 10 seconds; anything else is retried after 1, 5, 30, 120 and 720 minutes, then dropped. Rotating the secret in /account/ takes effect on the next delivery. **Copy Fund teams:** the owner's webhook is the team's. Team alerts reach it once, signed with the team secret; seats see that secret read-only in their account and can't save the same URL with a secret of their own (409 already_team_channel).

**Changelog.** ${CHANGELOG.flatMap((c) => c.changes.map((x) => `${c.date} (${c.status}): ${x}`)).join(' ')}`,
    },
    servers: [{ url: 'https://gene.tail70ba3.ts.net/copybook' }],
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
            type: { type: ['string', 'null'], enum: ['hedge_fund', 'long_only', 'index', 'bank', 'insurance', 'wealth', 'pension', 'sovereign', 'other', null], description: 'Filer type, from the data run\'s filer classification (one source for every filer); null until it classifies the filer. long_only was named active before 2026-11-09.' },
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
        HolderRow: {
          type: 'object',
          required: ['filer', 'period', 'kind', 'put_call', 'shares', 'prev_shares', 'share_change', 'value_usd', 'prev_value_usd', 'change', 'weight', 'accession', 'accepted_at'],
          properties: {
            filer: { type: 'object', required: ['cik', 'name', 'slug', 'type', 'curated'], properties: { cik: { type: 'string' }, name: { type: 'string' }, slug: { type: ['string', 'null'] }, type: { type: ['string', 'null'], description: 'hedge_fund, long_only, index, bank, wealth, pension, sovereign, insurance or other.' }, curated: { type: ['boolean', 'null'] } } },
            period: { type: ['string', 'null'], description: 'The filer\'s own latest quarter for this row, e.g. 2026Q3.' },
            kind: { type: 'string', enum: ['equity', 'calls', 'puts'] },
            put_call: { type: ['string', 'null'], enum: ['CALL', 'PUT', null], description: 'As EDGAR writes it; null for shares.' },
            shares: { type: 'integer' },
            prev_shares: { type: ['integer', 'null'], description: 'Null when the filer had no prior quarter on file.' },
            share_change: { type: ['integer', 'null'] },
            value_usd: { type: 'integer', description: 'Whole US dollars, as filed (thousands rescaled).' },
            prev_value_usd: { type: ['integer', 'null'] },
            change: { type: ['string', 'null'], description: 'Versus the filer\'s prior quarter: new, added, trimmed, exited or unchanged; null when there is no prior quarter on file.' },
            weight: { type: ['number', 'null'], description: 'Share of the filer\'s whole 13F book that period, 6 decimals; null when that total isn\'t known.' },
            accession: { type: ['string', 'null'] },
            accepted_at: { type: ['string', 'null'], format: 'date-time', description: 'Filing-level, not per position: the EDGAR acceptance of the filer\'s original 13F-HR for that quarter. A position added later by an amendment carries the original\'s time, so it can look disclosed earlier than it was. Null until gene has fetched it.' },
          },
        },
        Position: {
          type: 'object',
          description: 'One position: info-table rows summed per (CUSIP, put/call).',
          required: ['cusip', 'ticker', 'issuer', 'title_of_class', 'put_call', 'sector', 'shares', 'shares_type', 'value_usd', 'weight', 'weight_incl_options', 'weight_equity', 'value_scale', 'value_as_filed', 'value_adjusted', 'zero_value', 'change', 'prev_shares', 'share_change', 'value_delta_usd', 'source_accession', 'first_disclosed_at', 'suspect_units', 'split', 'prev_shares_as_filed'],
          properties: {
            cusip: { type: 'string', pattern: '^[0-9A-Z]{9}$' },
            ticker: { type: ['string', 'null'], description: 'Mapped from CUSIP; null when unknown' },
            issuer: { type: 'string', description: 'nameOfIssuer exactly as filed (not re-cased)' },
            title_of_class: { type: ['string', 'null'] },
            put_call: { type: ['string', 'null'], enum: ['PUT', 'CALL', null], description: 'Options rows, as EDGAR writes it (PUT or CALL): value_usd is the underlying, as filed' },
            sector: { type: ['string', 'null'], description: 'GICS-style sector, when mapped' },
            shares: { type: 'number', description: 'sshPrnamt as filed: shares (SH) or principal amount (PRN). 0 for exited rows.' },
            shares_type: { type: ['string', 'null'], enum: ['SH', 'PRN', null], description: 'sshPrnamtType as filed: SH (shares) or PRN (principal amount, e.g. convertible notes). Null until the data run publishes it; until then a PRN row is counted in weight like any other.' },
            value_usd: { type: 'integer', description: 'Reported value, whole USD. 0 for exited rows.' },
            weight: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'value_usd / the filing\'s total value over all rows, options included, 0-1. Deprecated meaning: on Mon Feb 8, 2027 this becomes the equity-only weight (weight_equity). Use weight_incl_options to keep this definition. See /v1/changelog 2026-11-09-weight-equity-only.' },
            weight_incl_options: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'value_usd / the filing\'s total value over all rows, options included, 0-1: today\'s `weight`, kept after Feb 8, 2027.' },
            weight_equity: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'Equity-only weight, 0-1: value_usd over the summed value of SH rows without put/call; null for options and PRN rows. Stable; `weight` takes this meaning on Feb 8, 2027. Until shares_type is published, a PRN row without it counts as equity.' },
            value_scale: { type: ['number', 'null'], description: 'Factor applied to the value as filed to get whole USD (1000 for filers that reported in thousands). Null until announced in /v1/changelog (the data run publishes it per row).' },
            value_as_filed: { type: ['number', 'null'], description: 'The value column exactly as filed, before value_scale. Null until announced in /v1/changelog.' },
            value_adjusted: { type: ['boolean', 'null'], description: 'True when value_usd differs from value_as_filed x 1 (a unit fix was applied). Null until announced in /v1/changelog.' },
            zero_value: { type: 'boolean', description: 'True for a held row filed with value 0 (not an exit); weight is 0 for it.' },
            change: { type: ['string', 'null'], enum: ['new', 'added', 'trimmed', 'unchanged', 'exited', 'disclosed_later', null], description: 'vs prev_quarter; null when there is no prior quarter. disclosed_later: a position the filer first disclosed in a later NEW HOLDINGS amendment for this period (typically confidential treatment that expired, such as Berkshire 2025Q1 NUE, LEN and DHI), so it was not public when the original 13F was filed and its change is not comparable to the other rows.' },
            prev_shares: { type: ['number', 'null'], description: 'Shares in prev_quarter (0 for new), adjusted for a split between the two quarters (see split)' },
            split: {
              type: ['object', 'null'],
              description: 'The stock split applied to prev_shares between prev_quarter and this quarter, as in the CSV\'s split_ratio. Null when none applied.',
              required: ['ratio', 'from_quarter', 'to_quarter'],
              properties: { ratio: { type: 'number', description: 'New shares per old share (25 for a 25-for-1 split; 0.1 for a 1-for-10 reverse split)' }, from_quarter: { type: 'string' }, to_quarter: { type: 'string' } },
            },
            prev_shares_as_filed: { type: ['number', 'null'], description: 'prev_quarter\'s share count exactly as filed, before any split adjustment: equal to prev_shares when no split applied. Null when there is no prior (a new position) or the data run hasn\'t published it for this book yet.' },
            share_change: { type: ['number', 'null'], description: 'shares - prev_shares' },
            value_delta_usd: { type: ['integer', 'null'], description: 'Trade size in whole USD at this filing\'s own value per share: +value for new, -prior value for exited, share_change x value/shares otherwise. A price move alone is 0.' },
            source_accession: { type: ['string', 'null'], description: 'Point-in-time: the accession (original 13F-HR or amendment) this row was disclosed in. Null until point-in-time data is published.' },
            first_disclosed_at: { type: ['string', 'null'], format: 'date-time', description: 'The per-row point-in-time key: EDGAR acceptance datetime (UTC) of source_accession, the filing that first disclosed this row (an amendment-added position gets the amendment\'s time). Use it, not the filing\'s accepted_at, to know when a row was public. Null until point-in-time data is published.' },
            suspect_units: { type: ['boolean', 'null'], description: 'Null until ingest\'s cross-filer check has run on the row (implied price inconsistent with other filers, or the filer\'s own prior quarter); then true or false. True when ingest flags the row\'s value as a likely unit error (e.g. reported in dollars where thousands were meant). Such rows are left out of moves and alerts.' },
            row_type: { type: ['string', 'null'], enum: ['holding', 'exited', null], description: '`holding`, or `exited`: sold out this quarter, with `shares` and `value_usd` 0, the old share count in `prev_shares` and the old value as `-value_delta_usd`. Book totals exclude exited rows. Null on rows built before the field.' },
            suspect_units_basis: { type: ['string', 'null'], enum: ['filers', 'own_prior', 'none', null], description: 'What the unit check compared the row against: other filers of the same CUSIP (`filers`), the filer\'s own prior quarter (`own_prior`), or nothing to compare (`none`). Null on rows built before the field.' },
            suspect_reason: { type: ['string', 'null'], enum: ['cross_filer', 'cross_filer_prior', 'own_prior', null], description: 'Why `suspect_units` is true: the price implied differs from other filers this quarter (`cross_filer`) or last quarter (`cross_filer_prior`), or from the filer\'s own prior quarter (`own_prior`). Null when not flagged.' },
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
                      mislabeled_amendment: { type: ['boolean', 'null'], description: 'True for a 13F-HR/A marked NEW HOLDINGS that re-files the whole book (it replaces the book instead of adding to it). Null when the data run has no filing trail for the quarter.' },
                    },
                  },
                },
                amendment_type: { type: ['string', 'null'], enum: ['NEW HOLDINGS', 'RESTATEMENT', null], description: 'The served filing\'s own amendment type (RESTATEMENT when a restatement replaced the original)' },
                mislabeled_amendment: { type: ['boolean', 'null'], description: 'True for a 13F-HR/A marked NEW HOLDINGS that re-files the whole book (it replaces the book instead of adding to it). Null when the data run has no filing trail for the quarter.' },
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
                      mislabeled_amendment: { type: ['boolean', 'null'], description: 'True for a 13F-HR/A marked NEW HOLDINGS that re-files the whole book (it replaces the book instead of adding to it). Null when the data run has no filing trail for the quarter.' },
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
          description: 'Every 13F filer: curated filers first, then all others. ?curated=true or false filters. Paged: `count` is the total, `next_offset` the next page (null on the last).',
          parameters: [
            { name: 'curated', in: 'query', required: false, schema: { type: 'string', enum: ['true', 'false'] } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000, default: 500 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            '200': {
              description: 'Filers',
              content: json(envelope({ type: 'array', items: { $ref: '#/components/schemas/Filer' } }, { count: { type: 'integer' }, next_offset: { type: ['integer', 'null'] } }), {
                ...BUILD,
                data: [
                  { slug: 'warren-buffett', cik: '0001067983', name: 'Berkshire Hathaway Inc', manager: 'Warren Buffett', featured: true, status: 'current', latest_quarter: '2026Q2', latest_report_date: '2026-06-30', latest_filing_date: '2026-08-14', latest_accession: '0001193125-26-352200', total_value_usd: 259000000000, position_count: 41, history_quarters: ['2026Q2', '2026Q1'], curated: true, type: null },
                  { slug: 'whale-rock-capital-management-llc-7322', cik: '0001387322', name: 'Whale Rock Capital Management LLC', manager: null, featured: false, status: null, latest_quarter: '2026Q2', latest_report_date: '2026-06-30', latest_filing_date: '2026-08-14', latest_accession: null, total_value_usd: null, position_count: 35, history_quarters: ['2026Q2'], curated: false, type: null },
                ],
                count: 8964,
                next_offset: 500,
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
              headers: HOLDINGS_HEADERS,
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
              headers: HOLDINGS_HEADERS,
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
          summary: 'Every 13F holder of one issuer, all filers, with each filer\'s change vs its prior quarter',
          description: 'Every 13F filer holding the issuer in its latest full book (about 9,000 filers covered, not only curated), largest first. `period` is that filer\'s own latest quarter, so a fund that has filed its Q3 13F shows Q3 while others still show Q2; `counts.by_period` has the split. Share classes of one issuer (same 6-character CUSIP issuer code) are rolled up; calls and puts are separate rows (`kind`). `weight` is the position\'s share of the filer\'s whole book that period (null when that total isn\'t known). `accession` and `accepted_at` are set for curated funds\' latest 13F. `filer.type` is one of hedge_fund, long_only (still `active` in some rows during ingest\'s rename; the two match each other in `type=`), index, bank, wealth, pension, sovereign, insurance, other. `type=hedge_fund,long_only` (or `hedge_fund,active`) is the stock page\'s hedge funds and active managers lens. **Counts:** `count` is position rows after the filters (a filer\'s shares, calls and puts are separate rows, each with `put_call`); `filers` is distinct filers with a nonzero position among them, so 0-share, $0 options rows never count and have no weight. With the default `current_only=true` only filers whose latest 13F is for the newest ended quarter or the one before are listed, the stock page\'s rule (its holder count); `current_only=false` adds filers whose latest 13F is older. If the full list for an issuer isn\'t in the API yet, the public top 25 is served with `truncated: true`. `build_id`/`data_built_at` name the upload this list came from.',
          parameters: [
            { name: 'stock', in: 'path', required: true, description: 'Ticker (NVDA), 9-character CUSIP or 6-character issuer code.', schema: { type: 'string' } },
            { name: 'type', in: 'query', required: false, description: 'Filer types, comma-separated: hedge_fund, long_only (or active), index, bank, wealth, pension, sovereign, insurance, other. hedge_fund,long_only is the stock page lens.', schema: { type: 'string' } },
            { name: 'current_only', in: 'query', required: false, description: 'true (default): filers whose latest 13F is for the newest ended quarter or the one before, as the stock page counts them. false: every filer.', schema: { type: 'boolean', default: true } },
            { name: 'cohort', in: 'query', required: false, schema: { type: 'string', enum: ['all', 'curated'], default: 'all' } },
            { name: 'quarter', in: 'query', required: false, description: 'Only filers whose latest book is this quarter.', schema: { type: 'string', pattern: '^\\d{4}Q[1-4]$' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            '200': {
              description: 'Holders, largest first. Each row\'s `accepted_at` is filing-level: the EDGAR acceptance of the filer\'s original 13F-HR for that quarter. A position added later by an amendment carries the original\'s time, so it can look disclosed earlier than it was; per-row disclosure times come with `lots[]`. For point-in-time work use the holdings endpoints\' per-row `first_disclosed_at`.',
              content: json(envelope({ type: 'object', required: ['issuer', 'ticker', 'tickers', 'display_name', 'cohort', 'type', 'counts', 'truncated', 'holders'], properties: { issuer: { type: 'string', description: '6-character CUSIP issuer code' }, ticker: { type: ['string', 'null'] }, tickers: { type: 'array', items: { type: 'string' } }, display_name: { type: ['string', 'null'] }, cohort: { type: 'string', enum: ['all', 'curated'] }, type: { type: ['string', 'null'] }, counts: { type: 'object', additionalProperties: true }, truncated: { type: 'boolean' }, holders: { type: 'array', items: { $ref: '#/components/schemas/HolderRow' } } } }, { count: { type: 'integer', description: 'Position rows after the filters.' }, filers: { type: 'integer', description: 'Distinct filers with a nonzero position among those rows.' }, next_offset: { type: ['integer', 'null'] } }), {
                ...BUILD,
                data: { issuer: '829933', ticker: 'SIRI', tickers: ['SIRI'], display_name: 'Sirius XM', cohort: 'all', type: null, counts: { holders: 608, new: 76, added: 153, trimmed: 124, exited: 55, unchanged: 79, no_prior: 176, by_period: { '2026Q3': 64, '2026Q2': 536 } }, truncated: false, holders: [{ filer: { cik: '0001067983', name: 'BERKSHIRE HATHAWAY INC', slug: 'warren-buffett', type: 'long_only', curated: true }, period: '2026Q2', kind: 'equity', put_call: null, shares: 124807117, prev_shares: 124807117, share_change: 0, value_usd: 3686802237, prev_value_usd: 2880548260, change: 'unchanged', weight: 0.0143, accession: '0000950123-26-008377', accepted_at: '2026-08-14T20:05:04Z' }] },
                count: 663,
                filers: 608,
                next_offset: 100,
              }),
            },
            ...errResponses,
          },
        },
      },
      '/v1/events': {
        get: {
          summary: 'Form 4 and Schedule 13D/G filings, newest first, with filters',
          description: 'The same filings the investor pages show: each curated filer\'s Form 4 and 13D/G since its latest 13F, plus every filing the minute poll parsed (followed filers, and any filer\'s 13D/G on members\' names). Each carries EDGAR\'s acceptance time (`accepted_at`), per-class Form 4 holdings (`classes`), the 13D\'s Item 4 excerpt (`purpose`) and the same filer\'s previous Schedule 13D/G on the issuer (`prev`). Details are read from EDGAR hourly, so a filing from the last hour can show null detail fields until then. Top-level `shares`, `shares_after` and `value_usd` sum every share class the filing reports (Lennar Class A and Class B together); `classes` has the per-class figures. `purpose` is set only on Schedule 13D filings and amendments that state or amend Item 4; it is null for 13Gs.\n\n**By stock (`tickers=`, up to 20; `ticker=` works the same):** besides the curated filers\' own filings (`source: "filer"`), the response adds every Form 4 by the company\'s own insiders (directors, officers, 10% owners) and every Schedule 13D/G any filer made on it (`source: "issuer"`), read from the issuer\'s EDGAR feeds, the same data as My book. Lookback: per ticker, every Form 4 where the company is the issuer and every Schedule 13D/G on it accepted since the first day of the quarter whose 13Fs are due next (July 1 until the Nov 16, 2026 deadline, then October 1), and at least the latest 20 and 10, up to 150 Form 4s. `coverage[ticker].from` is that date when the window is complete (null when the 150 cap cut it short); `form4_from` and `schedule13_from` give the oldest acceptance each feed reached. Each Form 4 row carries `transactions[]` (code, shares, price, acquired/disposed, direct/indirect, date), so an option exercise and same-day sale shows as M then S. Feeds are re-read at most every 20 minutes. A ticker not loaded yet in this call is listed in `pending`: call again in a second. Issuer rows carry `insider.ownership`, each ownership line (direct, or indirect with its nature such as "By Jain Foundation Inc.") with its balance after and its open-market trades.\n\n**Form 4 dates:** `event_date` is the first transaction date and `last_transaction_date` the last (the same day for most filings), on every Form 4 row whatever its source.',
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
          'x-status-detail': { 'filer=': 'live', 'ticker= / cusip=': 'live', 'across filers': 'coming' },
          description: 'With filer=: that filer\'s change rows (exact); live. With ticker= or cusip=: every 13F holder\'s change in that stock among filers whose latest book is that quarter (the holder index, as /v1/stocks/{stock}/holders), with cohort=curated or a filer type; live. **Coming, not live yet** (501 not_yet_available until the data run publishes the files; /v1/changelog logs the day it ships): without filer= or ticker=, across all filers.',
          parameters: [
            { $ref: '#/components/parameters/quarter' },
            { name: 'change', in: 'query', required: false, description: 'new, added, trimmed, exited (comma-separated)', schema: { type: 'string' } },
            { name: 'filer', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'ticker', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'cusip', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'cohort', in: 'query', required: false, description: 'all, curated, or a filer type (hedge_fund, active, index, bank, wealth, pension, other)', schema: { type: 'string', default: 'all' } },
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
          description: '**Partial:** gzip CSVs are live for the quarters listed; Parquet is coming. Each file holds exactly the rows /v1 serves for that quarter (per-line unit fixes, exited and zero-value lines, the current version of each filing, so a re-filed book such as First Eagle 2026Q2 totals $60,750,982,695), with per-row `accepted_at`, `source_accession`, `first_disclosed_at` and `change`. The columns are listed on GET /v1/bulk/{file}. Files are rewritten when the data changes: `sha256` (and the response envelope\'s `build_id`) identify a version; old versions are not kept yet. Only files whose stored copy matches its recorded size and SHA-256 are listed.',
          responses: {
            '200': {
              description: 'Available files, newest first',
              content: json(envelope({ type: 'array', items: { type: 'object', required: ['file', 'quarter', 'bytes', 'etag', 'sha256', 'uploaded_at', 'url'], properties: { file: { type: 'string' }, quarter: { type: 'string' }, bytes: { type: 'integer' }, etag: { type: ['string', 'null'] }, sha256: { type: ['string', 'null'], description: 'Hex SHA-256 of the file a download serves; null until recorded' }, uploaded_at: { type: 'string', format: 'date-time' }, url: { type: 'string' } } } }), { ...BUILD, data: [{ file: '2026Q2.csv.gz', quarter: '2026Q2', bytes: 48211933, etag: '3f6d0c2a9b7e41d58c1f0e2a7b9d4c61', sha256: 'c1b4f0e2d9a87365e4f1a0b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6', uploaded_at: '2026-11-09T02:10:00Z', url: 'https://gene.tail70ba3.ts.net/copybook/v1/bulk/2026Q2.csv.gz' }] }),
            },
            ...errResponses,
          },
        },
      },
      '/v1/bulk/{file}': {
        get: {
          summary: 'Download one bulk export (streams the file; not JSON) (partial: .csv.gz live, .parquet returns 501)',
          'x-status': 'partial',
          description: '**Partial:** .csv.gz streams for every quarter GET /v1/bulk lists; .parquet, and any quarter not listed, return 501 not_yet_available. The file holds exactly the rows /v1 serves (per-line unit fixes, exited and zero-value lines). Columns, in order: `cik, filer_name, quarter, report_date, accession, filing_date, cusip, ticker, issuer, title, put_call, shares, shares_type, value, accepted_at, source_accession, first_disclosed_at, change, row_type, prev_shares, prev_value`. `row_type` is `holding` or `exited`; an exited row has `shares` and `value` 0 with the old position in `prev_shares` and `prev_value` (both empty when there is no prior). Book totals exclude exited rows. Money in whole US dollars. The download is a 302 to a presigned link: don\'t send Authorization to it. Check it against the listing\'s `sha256`.',
          parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string', pattern: '^\\d{4}Q[1-4]\\.(csv\\.gz|parquet)$' } }],
          responses: { '200': { description: 'The file, streamed from the API host when no verified R2 copy exists (Content-Length and Repr-Digest set)', content: { 'application/gzip': {}, 'application/vnd.apache.parquet': {} } }, '302': { description: 'Redirect to a presigned R2 link, valid 5 minutes; fetch it without Authorization', headers: { Location: { schema: { type: 'string', format: 'uri' } } } }, '501': { description: 'not_yet_available: not published yet', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, ...errResponses },
        },
      },
      '/v1/changelog': {
        get: {
          summary: 'Changes to /v1, newest first. No API key needed.',
          security: [],
          responses: {
            '200': {
              description: 'Changelog',
              content: json(envelope({ type: 'array', items: { type: 'object', required: ['id', 'date', 'schema_version', 'breaking', 'status', 'changes'], properties: { id: { type: 'string', description: 'Stable id for entries that track a data fix (matches the data changelog), e.g. 2026-11-09-refiled-amendments.' }, date: { type: 'string', format: 'date' }, schema_version: { type: 'string' }, breaking: { type: 'boolean' }, status: { type: 'string', enum: ['shipped', 'announced'], description: 'shipped: live and returning data. announced: coming; not live yet.' }, changes: { type: 'array', items: { type: 'string' } } } } }), { ...BUILD, data: CHANGELOG.slice(0, 1) }),
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
                example: { schema_version: SCHEMA_VERSION, type: '13d', id: '0001193125-26-451979', accession: '0001193125-26-451979', form: 'SCHEDULE 13D/A', accepted_at: '2026-11-06T21:15:32Z', detected_at: '2026-11-06T21:16:01Z', filer: { slug: 'carl-icahn', name: 'Carl Icahn' }, issuer: 'CVR Energy, Inc.', ticker: 'CVI', action: 'stake_update', details_pending: false, followup: false, shares: null, value_usd: null, avg_price: null, classes: null, percent_of_class: 64.1, shares_after: 71201875, prev_percent_of_class: 70.8, prev_shares_after: 71201875, amendment_no: 41, item4: null, insider: null, insiders: null, sec_url: 'https://www.sec.gov/Archives/edgar/data/921669/000119312526451979/0001193125-26-451979-index.html', copybook_url: 'https://copybook.factordynamics.com/investors/carl-icahn' },
              },
            },
          },
          responses: { '200': { description: 'Any 2xx acknowledges the delivery.' } },
        },
      },
    },
  };
}
