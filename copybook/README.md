# Copybook ingest

SEC 13F-HR holdings, as filed, for the Copybook site (https://refcell.github.io/gust/copybook/).
No prices, no Form 4 / 13D, no third-party holdings data. Tickers come from OpenFIGI's CUSIP mapping,
then SEC `company_tickers.json` name matches for common stock, then `ingest/securities_overrides.json`.
Sectors come from each issuer's SEC SIC code mapped to GICS-style sectors (plus overrides); ETFs are
"Funds & ETFs" and anything unknown is "Unclassified", never blank.

## Where things run

- Code: `factordynamics/site` → `copybook/ingest` (this directory).
- Schedule: `refcell/gust` → `.github/workflows/copybook-data.yml`, every 3 hours. It checks out this
  code, writes `public/copybook/data/**` only, commits, and dispatches gust's Pages deploy (`ci.yml`).
  The front end owns every other file under `public/copybook/`.
- Paid access: `copybook/api` (Cloudflare Worker) serves history, CSV and filing alerts to Copy members
  from the published `data/{slug}-history.json` and `data/index.json`.

## Steps

```bash
python ingest/universe.py      # curated + all-filer directory from EDGAR full-index form.idx
python ingest/build.py         # curated funds: 8 full quarters, QoQ changes, copycat, alerts
python ingest/bulk.py          # every 13F filer: latest quarter, one shard per CIK, incremental
python ingest/figi.py web/data # CUSIP -> ticker cache (OpenFIGI, 25 req/min unauthenticated)
python ingest/securities.py web/data  # ticker, display name, sector per CUSIP (SEC SIC codes)
python ingest/enrich.py        # write ticker/display_name/sector into every published file
python ingest/events.py        # curated funds: Form 4 and Schedule 13D/G since the latest 13F
python ingest/stocks.py        # all filers: holder counts per issuer (share classes rolled up)
python ingest/upload_history.py  # CI only: new/changed h/** to private R2 via the Copy API
python -m unittest discover -s tests -v
```

Env: `COPYBOOK_WEB_DIR` (public tree, data in `$COPYBOOK_WEB_DIR/data`),
`COPYBOOK_CUSIP_MAP`, `COPYBOOK_HISTORY_QUARTERS` (default 8; 2 is enough for QoQ changes),
`COPYBOOK_BULK_BUDGET_S`, `COPYBOOK_BULK_REVERSE`, `COPYBOOK_FIGI_BUDGET_S`, `COPYBOOK_SEC_BUDGET_S`,
`COPYBOOK_EVENTS_BUDGET_S`.

SEC User-Agent: `Copybook factordynamics.com copybook@factordynamics.com`, under 10 req/s.

## Public data (`data/`)

- `index.json`: curated funds that filed. `managers[]` has `slug, cik, name, manager, featured, quarter,
  report_date, filing_date, accession, sec_url, position_count, total_value, history_quarters, top[]`.
- `{slug}.json`: latest quarter for one curated fund, plus `prev_quarter, prev_report_date,
  prev_accession, prev_total_value, changes{new,added,trimmed,exited,unchanged}`. Each `holdings[]` row has
  `issuer, title, cusip, ticker, value, shares, put_call, weight, prev_shares, prev_value, prev_weight, change,
  share_change, value_delta, pct_of_book`. Exited positions are rows with `value: 0` and `change: "exited"`.
  Change fields are null when there is no prior filing. `value_delta` is the trade in dollars at this filing's
  own value per share (new: +value, exited: -prior value), so price moves alone are 0; `pct_of_book` is
  `value_delta / total_value`. `moves` has `bought_usd`, `sold_usd` and the 10 largest `new`, `exited`,
  `added`, `trimmed` rows by `|value_delta|`.
- Fund status on `index.json` rows and `{slug}.json`: `status` (`current`, `stale`, `inactive`, `empty_latest`,
  `unreadable_latest`, `notice_pending`, `reported_by_other`), `status_note`, `skipped_quarters`, and for 13F-NT
  filers `reported_by: {cik, name, slug}`, `notice_accession`, `notice_filing_date`, `notice_note`. History quarters
  carry `status` (`filed`, `notice`, `successor`) and the same notice fields. `status.json` lists every curated
  fund that is not `current` (the staleness monitor).
- `copycat.json`: every name across curated funds. `copycat_lite.json`: top 2,000 with up to 8
  `held_by: [{slug, name}]`, featured funds first.
- `universe.json`: curated directory with `featured`. `filers.json`: every 13F filer with `cik, name, slug,
  filing_date, ok, position_count, quarter`.
- `f/{cik}.json`: latest quarter for any filer. `columns` names the fields of each `rows[]` array
  (`ticker, issuer, title, cusip, put_call, shares, value`); top 500 by value, `truncated` if more,
  `position_count` is the full count.
- `h/{slug}/{quarter}.json`: one quarter's full book for a curated fund (every position), up to 8 quarters.
  Paid data: `ingest/upload_history.py` puts new or changed `h/**` files in the Copy API's private R2
  bucket (GitHub OIDC auth, audience `copybook-api`). They are not published on Pages; the gust workflow
  keeps them in the Actions cache between runs.
  Each quarter has `prev_quarter`, change fields on every row (vs the previous quarter in the history) and
  `exited` (positions sold out since `prev_quarter`). `h/{slug}/index.json` is the full history index for the API.
- `h/{slug}/{quarter}.csv`: the same book as RFC 4180 CSV (CRLF), columns
  `manager,slug,cik,quarter,report_date,filing_date,accession,ticker,issuer,cusip,title,put_call,shares,value_usd,weight,`
  `change,prev_shares,share_change,value_delta_usd,pct_of_book`; exited positions follow with shares 0.
- `{slug}-history.json`: index of those quarters: metadata, `holdings_url` and `csv_url` (relative to `data/`) and a
  50-row `top_holdings` preview. It has no `holdings` key, so nothing reads a partial book by mistake.
- `alerts.json`: `rule`, `new_filings` from the last run, `recent` (rolling, keyed by slug and report_date)
  and `periods` (latest report_date recorded per slug; only moves forward). A filing is new only when it is an
  original 13F-HR for a later period than `periods[slug]`, filed within 7 days. Entries carry `report_date`,
  `previous_report_date`, `form`, `reported_by` and `moves` (top 5 per bucket) for the email body.
- `events/{slug}.json`: Form 4 (manager is a reporting owner) and Schedule 13D/13G filings by the fund filed
  after its latest 13F period: `{slug, manager, cik, updated_at, since_report_date, latest_13f_quarter, truncated,
  events[]}`, newest first. Each event has `id` (accession), `form`, `kind` (`form4`, `13d`, `13g`), `action`
  (`buy`, `sell`, `mixed`, `other`, `new_stake`, `stake_update`, `below_threshold`), `filing_date`, `event_date`,
  `url`, `issuer`, `display_name`, `ticker`, `cusip`, `sector`, `shares` (net open-market shares, Form 4 only),
  `value_usd`, `avg_price`, `shares_after`, `percent_of_class` (13D/G), `shares_in_13f`, `change_vs_13f`
  (null when not in the 13F) and Form 4 `transactions[]`. `events.json` is every event of the last 30 days.
- `stock_holders.json`: every issuer across all filer shards with `equity{holders, shares, value}`,
  `calls{holders, value}`, `puts{holders, value}` and `classes[]`; share classes roll up by 6-character CUSIP.
- Every holding row (and every shard row) carries `ticker`, `display_name` (clean name; raw SEC name stays
  in `issuer`) and `sector`. `copycat_lite.json` has `sectors: [{sector, value, weight}]` summing to 100%.
- `securities.json`: `{cusip: {ticker, name, sector}}`. `issuers.json`: SEC SIC cache by issuer CIK.
- `cusip_map.json`: OpenFIGI CUSIP → ticker cache (`""` = no single US ticker).

Each quarter is built from the original 13F-HR. A 13F-HR/A replaces it only when its cover page says
`RESTATEMENT`; `NEW HOLDINGS` amendments are merged into the original (listed in `amendments`).

Values are USD. A filing whose median implied price per share is under $0.50 was reported in $000s and
is scaled x1000; over $2,500 means an extra x1000 and is scaled down (`unit_fix` records the factor).
Single lines are checked too: a stock line priced about 1000x off the median price other 13F filers report
for that CUSIP and quarter is rescaled (mixed-unit filings).
