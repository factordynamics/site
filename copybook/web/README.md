# Copybook web

The Copybook front end: Vite + React + Tailwind, built to static files and served from GitHub Pages at
https://refcell.github.io/gust/copybook/. It reads the JSON that `copybook/ingest` publishes under
`data/` and never writes it.

```bash
npm ci
npm run dev                                                  # data/ is fetched relative to the base path
npm run build && node scripts/postbuild.mjs <index.json>     # one static page per route
```

Deploy: replace everything under `refcell/gust` `public/copybook/` except `data/` with `dist/`, then push
`main`; gust CI deploys Pages.

- `public/sectors.json`: CUSIP → sector, from SEC company tickers and SIC codes (`scripts/sectors.py`).
- `src/config.ts`: Stripe Payment Links, portal link and Copy API base URL. While they are empty, paid
  buttons fall back to the encrypted waitlist (`src/lib/waitlist.ts`).
- Account flow follows `copybook/api/README.md`.
