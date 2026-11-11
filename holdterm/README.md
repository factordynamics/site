# Holdterm

A superinvestor tracker at https://holdterm.factordynamics.com/.
It covers superinvestor portfolios, buys and sells, a grand portfolio, 13D/G and Form 4 activity, and per-stock ownership.
There are no ads. The only thing it sells is email alerts ($3/month or $29/year, 7-day trial).

- Static Vite + React SPA with no router or UI dependencies. All data loads in the browser from Copybook's public
  SEC EDGAR files (`src/config.ts`: `DATA`, `DERIVED`). Nothing paid from Copybook is used.
- SEC filings only, with no market prices. "Reported price" means the filing's value divided by its shares.
- Paid alerts: `src/config.ts` holds the Stripe Payment Links and the alerts API base. While those are empty,
  the alerts page shows that checkout opens soon. Account flow: `src/account.tsx`.
- Hosting: Cloudflare Pages project `holdterm`, static files only (no Pages Functions, so no Workers requests).
  The build (`vite.config.ts`) writes an HTML file with its own title, description and canonical for every
  section, roster fund and stock, a `404.html` app shell with noindex for real 404s, and `_redirects` for old
  URLs. Stock pages come from Copybook's `d/stocks.json` at build time, so redeploy to pick up new tickers; until
  then a new ticker's page still renders, with a 404 status. This repo's GitHub Pages already serves
  copybook.factordynamics.com, and a repo can have only one Pages site.

```bash
npm ci
npm run dev
npm run deploy   # build + wrangler pages deploy (needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)
```

`.github/workflows/holdterm.yml` builds on every push. It also deploys when the repo has a
`CLOUDFLARE_API_TOKEN` secret.

A small service worker (`public/sw.js`) only shows Holdterm's offline page on a reload without a connection. To
remove it from visitors' browsers, don't delete it: build with `VITE_HOLDTERM_SW=off npm run build` and deploy.
That ships the kill switch (`scripts/sw-kill.js`), which clears its caches, unregisters itself and reloads open
tabs once; keep the variable set on later deploys until the worker is wanted again.

## Quarterly roster run

Who Holdterm follows comes from one published rule (About, "How investors are chosen"), applied to the SEC's
quarterly [Form 13F data sets](https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets). When a new
data set is out, run these in order from `holdterm/`, with the three data set folders and periods as in
`scripts/screen.py`'s header, and commit all four outputs together so search's reasons match the screen the
roster came from:

```bash
SCREEN_ALL=/tmp/screen-all.json python3 -I scripts/screen.py DIR_Q DIR_PRIOR_Q DIR_TWO_YEARS_AGO PERIOD PRIOR_PERIOD OLD_PERIOD > scripts/universe.json
node scripts/roster.mjs > /tmp/roster-new.json && cp /tmp/roster-new.json src/roster.json
curl -sf https://refcell.github.io/gust/copybook/data/index.json -o /tmp/index.json
python3 -I scripts/not-followed.py /tmp/screen-all.json /tmp/index.json > src/not-followed.json
npm run build
```

- `scripts/universe.json`: every filer that passes the screen. `SCREEN_ALL` doesn't change it; it also writes every
  13F-HR filer of the period with the tests it fails.
- `src/roster.json`: the funds followed, the ones held back by data checks, and near misses.
- `src/not-followed.json`: why well-known funds aren't followed, for search ("michael burry", "druckenmiller").
  It covers the funds in Copybook's index.json that aren't followed, the near misses and held-back funds, and the
  names in `scripts/well-known.json`. It needs the `SCREEN_ALL` file from the same screen, so regenerate it only
  together with `universe.json`.

A roster run between data sets (only `node scripts/roster.mjs`, when new books are published) doesn't rerun the
screen and leaves `universe.json` and `not-followed.json` as they are. Search reads held-back reasons and the
followed list from `src/roster.json` at run time, so its answers stay right.

Keys: `/` or Ctrl+K opens search and Escape closes it; left and right arrows (and Home, End) move between tabs.
