# Copybook ingest

SEC 13F-HR holdings, as filed, for the Copybook site (https://refcell.github.io/gust/copybook/).
No prices, no Form 4 / 13D, no third-party holdings data. Tickers come from OpenFIGI's
CUSIP mapping (identifiers only); a CUSIP without a single US listing shows no ticker.

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
python ingest/build.py         # curated funds: 8 quarters, QoQ changes, copycat, alerts
python ingest/bulk.py          # every 13F filer: latest quarter, one shard per CIK, incremental
python ingest/figi.py web/data # CUSIP -> ticker cache (OpenFIGI, 25 req/min unauthenticated)
python ingest/reticker.py      # re-apply the ticker cache to published JSON
python -m unittest discover -s tests -v
```

Env: `COPYBOOK_WEB_DIR` (public tree, data in `$COPYBOOK_WEB_DIR/data`),
`COPYBOOK_CUSIP_MAP`, `COPYBOOK_HISTORY_QUARTERS` (default 8; 2 is enough for QoQ changes),
`COPYBOOK_BULK_BUDGET_S`, `COPYBOOK_BULK_REVERSE`, `COPYBOOK_FIGI_BUDGET_S`.

SEC User-Agent: `Copybook factordynamics.com copybook@factordynamics.com`, under 10 req/s.

## Public data (`data/`)

- `index.json`: curated funds that filed. `managers[]` has `slug, cik, name, manager, featured, quarter,
  report_date, filing_date, accession, sec_url, position_count, total_value, history_quarters, top[]`.
- `{slug}.json`: latest quarter for one curated fund, plus `prev_quarter, prev_report_date,
  prev_accession, prev_total_value, changes{new,added,trimmed,exited,unchanged}`. Each `holdings[]` row has
  `issuer, title, cusip, ticker, value, shares, put_call, weight, prev_shares, prev_value, change`.
  Exited positions are rows with `value: 0` and `change: "exited"`. `change` is null when there is no prior filing.
- `copycat.json`: every name across curated funds. `copycat_lite.json`: top 2,000 with up to 8
  `held_by: [{slug, name}]`, featured funds first.
- `universe.json`: curated directory with `featured`. `filers.json`: every 13F filer with `cik, name, slug,
  filing_date, ok, position_count, quarter`.
- `f/{cik}.json`: latest quarter for any filer. `columns` names the fields of each `rows[]` array
  (`ticker, issuer, title, cusip, put_call, shares, value`); top 500 by value, `truncated` if more,
  `position_count` is the full count.
- `{slug}-history.json`: up to 8 quarters of holdings per curated fund (read by the Copy API).
- `alerts.json`: `new_filings` from the last run and `recent` (rolling, by accession) for the alert mailer.
- `cusip_map.json`: CUSIP → ticker cache (`""` = no single US ticker).

Values are USD as filed; filings still reported in thousands are scaled.
