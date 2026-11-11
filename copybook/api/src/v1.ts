import { linkBase, type Env } from './env';
import { authKey, type KeyAuth, limitHeaders, meter, type MeterResult, type ApiKey } from './keys';
import { secBudget } from './edgar';

/** Bumped on any breaking change to a /v1 response shape. Every response carries it. */
export const SCHEMA_VERSION = '2026-11-09';
/** info.version: the spec's own revision, bumped on any change to it (additive ones too); schema_version only on breaking ones. */
export const SPEC_REVISION = '2026-11-11.10';
/** Versions a client may pin with the Copybook-Schema-Version header (the current one, plus any in a notice window). */
export const SCHEMA_VERSIONS = [SCHEMA_VERSION];

/** Changes to /v1, newest first. Served at /v1/changelog and summarised in the spec. */
export const CHANGELOG: { id: string; date: string; shipped_at?: string; schema_version: string; breaking: boolean; status: 'shipped' | 'announced'; changes: string[] }[] = [
  {
    id: '2026-11-11-held-lines-in-alerts',
    date: '2026-11-11',
    shipped_at: '2026-11-11T18:51:00Z',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'Webhook 13F payloads (77e8b62, a5599cb, 6bae423): a line that isn\'t counted is only in `moves.not_counted[]`, never in new, added, trimmed or exited, and never in bought_usd, sold_usd or a headline. Such a line\'s filed figures don\'t reconcile (share counts, values, an option line without a reliable side) or it may be a CUSIP change (an exit and a new line under one issuer prefix in one filing). Each not_counted row has `counted: false`, `value_delta: null` and `delta_pct_of_book: null`, and `change: "unknown"` where it would have read added or trimmed (new and exited stand). Its filed `value` and `prev_value` stay; there is no `value_change` field. Sum value_delta over new, added, trimmed and exited only. Alerts stored before this render the same way.',
      'Webhook 13F payloads (1941459): a line whose shares reconcile but whose filed value doesn\'t (`unreliable: "value"`, e.g. a price far off every other filer\'s) is a real trade. It stays in added, trimmed, new or exited with its `change`, and has `counted: false`, `value_delta: null` and `delta_pct_of_book: null`; it is outside bought_usd and sold_usd. Rows marked "shares" or "both", and a possible CUSIP change (now including lines already marked, and any line ingest flags `cusip_mismatch`), are only in not_counted[].',
      'Alert emails and feed items show the same lines on one "Not counted:" line with their filed facts, never a $ trade. A "value" or "both" line never shows a filed $ value: its shares, plus "filed value implausible (≈$X/sh vs ~$Y)" against other filers\' median. Only a "shares" line keeps "value as filed". "share count looks pre-split" appears only where ingest\'s held_reason says so.',
      'GET /v1/filers/{filer}/holdings/{quarter}: `total_value_counted_usd`, the book without lines whose filed value is unreliable, when the data run carries it (total_value_usd stays as filed). Option lines reported in contracts already carry `shares_basis: "contracts"`.',
      'GET /v1/filers/{filer}/holdings/{quarter}: a malformed as_of returns 400 bad_request (a well-formed one still returns 501 not_yet_available until Nov 30, 2026).',
    ],
  },
  {
    id: '2026-11-11-as-of-refused',
    date: '2026-11-11',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'as_of on any /v1 endpoint other than GET /v1/filers/{filer}/holdings/{quarter} now returns 400 `as_of_not_supported`. It was silently ignored, so a request such as /v1/stocks/{stock}/holders?as_of=2025-06-01 got today\'s holders. GET /v1/filers/{filer}/holdings/{quarter}?as_of= keeps returning 501 `not_yet_available` until point-in-time books ship. Point-in-time books (as_of, per-row lots[], point-in-time bulk) are due Nov 30, 2026 on holdings and bulk; holders and changes by Dec 14, 2026.',
    ],
  },
  {
    id: '2026-11-11-value-delta-basis',
    date: '2026-11-11',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'Webhook 13F payloads: a line that isn\'t counted (its share counts or values don\'t reconcile, an option line without a reliable side, or a possible CUSIP change) is only in `moves.not_counted`, never in new, added, trimmed or exited, with `value_delta` and `delta_pct_of_book` null, `counted: false`, and `change` \"unknown\" where it would have read added or trimmed (new and exited stand, as on hl/ held rows); its filed `value` and `prev_value` stay, with no computed difference. Sum `value_delta` over new, added, trimmed and exited only.',
      'GET /v1/stocks/{stock}/holders and /v1/changes rows: `value_delta_basis` (`trade`: shares traded x this filing\'s value per share; `filed_value`: the change in reported value), as the data run publishes it, so a trade and a filed-value change are no longer mixed unlabelled. Null on rows from earlier builds. Webhook 13F alert rows carry the same field.',
      'GET /v1/stocks/{stock}/holders `counts.value_delta_source`: `hl` when the rows carry the data run\'s per-line value_delta (they sum to `net`), `implied` when the holder index was published without it (rows fall back to shares traded x price and do not sum to `net`). `trade_usd_implied` is null on a flagged or withheld line (`unreliable`, `price_outlier`, `suspect_units`).',
      'Option lines a filer reported in contracts carry `shares_basis: "contracts"`: the data run multiplied their shares by 100 and they count normally. Option lines from non-standard filers are `unreliable: "both"`: value_delta_usd null, held, not in net.',
    ],
  },
  {
    id: '2026-11-11-cusip-links-quarter',
    date: '2026-11-11',
    shipped_at: '2026-11-11T14:30:00Z',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'cusip_links.json (public data file): `quarter` now means the first quarter in which filers report the new CUSIP (equal to `units_check.to_quarter`, e.g. DD and HON 2026Q2). It previously held the quarter of the run that detected the link (2026Q3 on every link). The SEC list\'s quarter stays in `list_quarter`. Each link now also carries `old`, `ratio`, `units_basis` (split_confirmed or holders_1to1), `units_check` with its evidence, and `list_url`, and the file has `generated` and a `held` array.',
      'GET /v1/filers/{filer}/holdings/{quarter}: `prev_quarter_status` (confidential_omitted or empty) and `prev_quarter_accession` when the prior quarter\'s 13F-HR was filed with no holdings; each position\'s `prev_reason` (prior_confidential or prior_empty) where `change` is null for that reason. Null otherwise.',
      'GET /v1/stocks/{stock}/holders: counts follow current_only (by default the current filers `holders[]` lists, so `count` = `counts.holders`), with `holders_all` and `not_current`; `net`, `net_quarter` and `net_by_period` are the data run\'s, as published (`net_source`: hl; computed when this API merged a reissue at read time), with `net_build`, the holder index\'s build, and `changes_build`, the build /v1/changes?ticker= serves for the issuer (it reads the same index, so they match). `net` is the sum of the rows\' `value_delta_usd` for `net_quarter` (put_call null): each row serves the data run\'s per-line value_delta, null when unknown or when the line is flagged (`unreliable`: value, shares or both, with `value_change_usd` the filed-value change); `trade_usd_implied` (shares traded x this filing\'s value per share) is for reference and not summed into net. A quarter ticker views refuse (any but the latest a holder reports) is null in `net_by_period` and listed in `net_by_period_incomplete`: it would cover only filers whose latest 13F is that quarter. `count` is top level, not in `counts`. Rows may carry `price_outlier`, `value_basis`, `suspect_reason` (reissue_ratio_not_applied) and a boolean `suspect_duplicate` from the data run.',
      'GET /v1/events?tickers=: a ticker whose feeds were not re-read within the call is served from its last read and listed in `pending`; the read finishes after the response, so the next call serves it. After a 503 `busy`, retry after Retry-After.',
    ],
  },
  {
    id: '2026-11-11-past-quarters-by-ticker',
    date: '2026-11-11',
    shipped_at: '2026-11-11T13:40:00Z',
    schema_version: SCHEMA_VERSION,
    breaking: true,
    status: 'shipped',
    changes: [
      'Incident (Nov 9 to Nov 11 13:30 UTC): GET /v1/changes/{quarter}?ticker= (or cusip=) for a past quarter, and GET /v1/stocks/{stock}/holders?quarter= for one, listed only filers whose latest 13F is that quarter: everyone who has filed since (FMR\'s 2026Q2 XOM trim among them; XOM\'s 2026Q2 listed 1,305 rows) was left out, so flows walked by quarter were wrong. Both now take only the latest quarter any filer reports (today 2026Q3); another returns 400 quarter_incomplete_by_ticker. For past quarters use GET /v1/bulk/{quarter} or per-filer /v1/changes/{quarter}?filer=. Full past-quarter coverage by ticker, from every filing for that quarter, is due Nov 23, 2026.',
      'Holders `counts.net` is the shares traded in USD (shares bought or sold x each filing\'s price) over `counts.net_quarter`, the latest quarter (or ?quarter=, the same latest quarter), and equals that quarter\'s /v1/changes?ticker= sum. `counts.net_by_period` sums the same by each filer\'s latest filing period: not quarterly flow for any quarter but the latest.',
      'Holder rows add `suspect_duplicate` {cusip, shares, value} when the same quarter\'s book also lists the security under a reissue\'s other CUSIP (IFP Advisors\' TEVA): one position is kept on the new code, and the stale line is out of every sum. Present only when the holder index carries such a line.',
      'Holders of a reissue merged at read time (TEVA until the data run publishes its merged index): a prior-quarter holder whose filer has since filed a newer 13F, and is in neither CUSIP\'s current rows, is listed apart in `data.pending[]` with `reason: "filed_newer_not_indexed"` and `counts.pending`, out of holders, the counts and net; `counts.exits_pending` stays true meanwhile. `counts.holders` counts share positions only, like `count`; calls and puts are `counts.option_rows`.',
      'Rate limits are per account (Copy Pro: 60 a minute and 20,000 a day across all its API keys; Copy Fund: the same per seat, the owner being one seat), not per key; a 429 says which (`scope`: account or seat) with `retry_after_seconds`. A bulk file download isn\'t metered, only the listing. Limits were briefly per key (each of up to 10 keys had its own); no member was affected.',
    ],
  },
  {
    id: '2026-11-11-original-accession-reissues',
    date: '2026-11-11',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'Additive: `original_accession` on HolderRow (/v1/stocks/{stock}/holders), Holdings.filing and BulkRow: the filer\'s original 13F-HR for the period, the filing `accepted_at` times. It equals `accession` when there was no refile. `accepted_at` keeps its values; it is now defined as the original\'s acceptance, not `accession`\'s when they differ (First Eagle 2026Q2: accession -000033, the 13F-HR/A; accepted_at 2026-08-05T19:22:03Z, the original -000020). For when a row became public, use first_disclosed_at. Bulk appends the column after prev_cusip from ingest\'s full run 43012508141.',
      'Additive: `prev_cusip` on Position and as a bulk column after suspect_reason: the old CUSIP on a position linked through a reissue the SEC\'s Official 13(f) List confirms (XOM 30231G102 -> 30233Q108, TEVA 881624209 -> M8769Q102). Null or empty otherwise.',
      'Fix: a reissued security\'s ticker resolves to its current issuer on /v1/stocks/{stock}/holders, /v1/changes?ticker= and the CSV routes (XOM read the stale 30231G book: 447 exits, net -$9.24B). Asked for by the old issuer code or CUSIP, the response serves the current issuer with `superseded_by` (additive).',
      'Wording: BulkRow `accession` is "the 13F-HR or 13F-HR/A whose book the row belongs to". The webhook payload\'s `accepted_at` is its own filing\'s acceptance (an amendment\'s, for a 13F-HR/A), and its `schema_version` now matches /v1\'s (it said 2026-11-08). info.version is the spec revision (2026-11-11.2); schema_version stays 2026-11-09, since none of these changes is breaking.',
      'Earlier today, all additive and listed in the entries below: BulkRow, Position.`prev_value_usd`, and the exited wording (holdings[] current positions only, exited[] the sold-out ones, both with row_type).',
    ],
  },
  {
    id: '2026-11-11-bulk-row-schema',
    date: '2026-11-11',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'The spec adds components.schemas.BulkRow: every bulk CSV column\'s type, nullability, enum and units, the file format (UTF-8, RFC 4180, one header row, empty field = null), sort order, uniqueness of (cik, cusip, put_call), and which filing version each filer has in the file.',
      'Holdings: `holdings[]` holds current positions only and `exited[]` the positions sold out this quarter, both with `row_type` set (`holding` / `exited`), whichever way a data run shapes the book. Some builds served exits inside holdings[] with exited[] empty.',
      'Positions add `prev_value_usd` (the bulk CSV\'s prev_value): an exited row\'s old value no longer has to be read as -value_delta_usd. Bulk `value`, `title` and `prev_value` are Position\'s value_usd, title_of_class and prev_value_usd; names are unchanged in this version.',
      'Announced: bulk CSVs append value_scale, value_as_filed, value_adjusted, zero_value, suspect_units, suspect_units_basis and suspect_reason after prev_value from ingest\'s next full run; `row_type` is non-null in bulk from that run and in /v1 positions by Nov 30, 2026. Read columns by header name.',
    ],
  },
  {
    id: '2026-11-11-bulk-file-and-filers-paging',
    date: '2026-11-11',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'Fix: GET /v1/bulk/{file} downloads served an older copy of each export (from Nov 9 01:17 UTC) while GET /v1/bulk listed the newer one; the 2026Q2 file still counted First Eagle\'s book twice. A download now serves exactly the listed file: its link is handed out only when the stored copy has the listed size and sha256, otherwise the file streams from the API.',
      'Incident (breaking, Nov 11 07:23 to 11:48 UTC): from about 07:23 UTC on Nov 11, GET /v1/filers without `limit` returned only the first 500 filers (of about 8,970), with `next_offset`; it used to return every filer, so a client that loads the list once silently got 5.6% of it. Reverted at 11:48 UTC (gene by 11:55): no `limit` returns every filer again, with no `next_offset`. Paging is opt-in: `limit` (1 to 1000) with `offset`, and `next_offset` only then. If you loaded /v1/filers in that window without paging, load it again.',
      'JSON responses are served inline again on every host, gzip-compressed when the request sends Accept-Encoding: gzip; only bulk exports and CSVs over 1 MB redirect to a presigned R2 link. Python urllib forwarded Authorization on the redirect, which R2 refuses (400). Never send Authorization to a presigned link.',
      'Positions add `row_type` (`holding` or `exited`; exited rows have shares and value 0), `suspect_units_basis` (`filers`, `own_prior`, `none`) and `suspect_reason` (`cross_filer`, `cross_filer_prior`, `own_prior`), each null until the data run fills it. Bulk CSVs add `row_type`, `prev_shares` and `prev_value` at the end from the next full data run (about 10:00 UTC Nov 11), and hold exactly the rows /v1 serves.',
      'Added `etag` and `sha256` to each GET /v1/bulk entry, read from the stored object. Check a download with sha256sum; `sha256` is null for a file whose digest isn\'t recorded yet, until its next check.',
    ],
  },
  {
    id: '2026-11-11-mislabeled-amendment',
    date: '2026-11-11',
    schema_version: SCHEMA_VERSION,
    breaking: false,
    status: 'shipped',
    changes: [
      'Added `mislabeled_amendment` (boolean or null) to filing, filing.amendments[] and filing.versions[]: true for a 13F-HR/A marked NEW HOLDINGS that re-files the whole book, which replaces the book instead of adding to it. Null when the data run has no filing trail for the quarter.',
      'Position.`value_scale` is filled for rows the data run rescaled (value_usd over value_as_filed, with value_adjusted true); still null on rows it did not mark.',
      'Added Position.`split` ({ ratio, from_quarter, to_quarter } or null) and Position.`prev_shares_as_filed`, as in the CSV: set when a stock split adjusted prev_shares, null otherwise.',
      'Later the same day: `prev_shares_as_filed` is set on every row with a prior (equal to prev_shares when no split applied), as each book is rebuilt. `mislabeled_amendment` is now true on a NEW HOLDINGS refile the lineage serves in place of the original (McLennan 2026Q2 0001325447-26-000033, HSBC 2025Q4 0000873630-26-000002).',
    ],
  },
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
    status: 'shipped',
    changes: [
      'Re-filed 13F amendments no longer double a fund\'s book. A 13F-HR/A marked NEW HOLDINGS that re-files the whole book (more than half its positions, or a total within 20% with at least half its positions) replaces the book: it gets role base with mislabeled_amendment: true, and the original becomes superseded (its book in versions[]). Corrected, against each filing\'s cover-page total: First Eagle (Matthew McLennan) 2026Q2 $120.67B to $60.75B; Mizuho Securities USA 2026Q2 $10.44B to $6.20B; JPMorgan Chase 2025Q3 $3,338B to $1,669B; HSBC 2025Q4 $372.1B to $196.2B; T. Rowe Price Investment Management 2025Q4 $252.8B to $158.4B; Mason Morfit 2024Q3 $8.31B to $4.37B; also Brookfield 2024Q4 and 2025Q1, Check Capital 2026Q2, Heard Capital 2025Q3, Lingotto 2025Q3 and UC Regents 2025Q2 to 2025Q4. /v1 holdings, changes and bulk serve the fixed books.',
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
  rate_limited: 'Rate limit reached for this account (Copy Fund: this seat), across all its API keys; see the RateLimit headers and retry_after_seconds.',
  not_found: 'No such resource.',
  bad_request: 'A parameter is missing or invalid.',
  not_yet_available: 'This option is documented but not served yet.',
  as_of_not_supported: 'as_of is not supported on this endpoint yet; it would be ignored, so the request is refused.',
  server_error: 'Something went wrong on our side.',
  busy: 'The API is busy; retry after the Retry-After seconds.',
  quarter_incomplete_by_ticker: "Past quarters by ticker aren't complete yet; use /v1/bulk/{quarter} or per-filer /v1/changes. Full coverage is due Nov 23, 2026.",
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
    const data = CHANGELOG;
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
  const dl = await import('./download');
  const auth: KeyAuth = await authKey(env, req.headers.get('authorization'));
  if (!auth.ok) return v1error(auth.code as ErrorCode, auth.status, auth.message);
  // Limits are per account (Copy Pro: every key together) or per seat (Copy Fund: the owner is one seat), never per key;
  // each key still counts its own use for the keys list. A bulk file download (its redirect to R2) isn't metered: only
  // the listing is.
  const scope = auth.member.plan === 'fund' ? 'seat' : 'account';
  const metered = !/^\/v1\/bulk\/[^/]+$/.test(path);
  const r: MeterResult | null = metered ? await meter(env, `acct:${auth.member.customer}`).hit() : null;
  const limits = r ? limitHeaders(r) : {};
  if (r && !r.allowed) {
    const w = r.minute.remaining === 0 ? 'minute' : 'day';
    const secs = r[w].reset;
    return v1json({ error: { code: 'rate_limited', message: `Rate limit reached for this ${scope}: ${r[w].limit} requests a ${w}, across all its API keys. Retry after ${secs} s.`, scope, window: w, limit: r[w].limit, retry_after_seconds: secs, retry_at: new Date(Date.now() + secs * 1000).toISOString().replace(/\.\d+Z$/, 'Z') } }, 429, { ...limits, 'Retry-After': String(secs) });
  }
  if (metered) await meter(env, auth.key.id).count?.();
  // JSON is always served inline (gzip for clients that ask; Python's urllib forwards Authorization on a redirect and R2
  // then answers 400). On the Funnel name a generated CSV over 1 MB answers 302 to presigned R2 (served here if R2
  // can't take it); bulk files redirect to presigned R2 on every host (their route).
  const funnel = req.method === 'GET' && dl.viaFunnel(env, req, url);
  for (const [method, re, handler] of ROUTES) {
    const m = path.match(re);
    if (!m) continue;
    if (req.method !== method) return v1error('bad_request', 405, `Use ${method}.`, limits);
    // as_of comes to one filer's book first (/v1/filers/{filer}/holdings/{quarter}). Anywhere else it would be silently
    // ignored and a client would take today's answer for a point-in-time one, so it is refused.
    if (url.searchParams.has('as_of') && !/^\/v1\/filers\/[^/]+\/holdings\/[^/]+$/.test(path)) {
      return v1error('as_of_not_supported', 400, 'as_of is served only on GET /v1/filers/{filer}/holdings/{quarter} (from Nov 30, 2026); holders and changes follow by Dec 14, 2026. See /v1/changelog.', limits);
    }
    let res = await handler({ env, req, url, key: auth.key }, m.slice(1));
    // Text only: a gzip bulk file served here (R2 signing unset) must stay bytes.
    if (funnel && res.ok && res.body && /csv/.test(res.headers.get('content-type') ?? '')) {
      const body = await res.text();
      const go = body.length > dl.LARGE_BYTES ? await dl.toR2(env, body, res) : null;
      if (go) {
        for (const [k, v] of Object.entries(limits)) go.headers.set(k, v);
        return go;
      }
      res = new Response(body, res);
    }
    for (const [k, v] of Object.entries(limits)) res.headers.set(k, v);
    // `weight` in positions turns equity-only on Feb 8, 2027 (RFC 9745 Deprecation, RFC 8594 Sunset).
    if (/\/holdings/.test(path) && res.status === 200) for (const [k, v] of Object.entries(WEIGHT_DEPRECATION(linkBase(env, req, url)))) res.headers.set(k, v);
    return res;
  }
  return v1error('not_found', 404, undefined, limits);
}
