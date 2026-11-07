# Copybook web

The Copybook front end: Vite + React + Tailwind, built to static files and served from GitHub Pages at
https://copybook.factordynamics.com/. It reads the JSON that `copybook/ingest` publishes to
`refcell/gust` under `public/copybook/data/` (cross-origin) and never writes it.

```bash
npm ci
npm run dev                                                  # data comes from VITE_DATA_BASE (gust)
npm run build && node scripts/postbuild.mjs <index.json>     # one static page per route
```

Deploy: push `main`. `.github/workflows/copybook-pages.yml` builds, runs `postbuild.mjs` and `sitemap.mjs`
against the live data index, and deploys Pages; it also reruns every 3 hours to refresh the sitemap and
per-investor pages. The old `refcell.github.io/gust/copybook/` pages redirect here (path, query and hash
kept; a stored sign-in passes in `#handoff`).

- `public/sectors.json`: CUSIP → sector, from SEC company tickers and SIC codes (`scripts/sectors.py`).
- `src/config.ts`: Stripe Payment Links, portal link and Copy API base URL. While they are empty, paid
  buttons fall back to the encrypted waitlist (`src/lib/waitlist.ts`).
- Account flow follows `copybook/api/README.md`.
