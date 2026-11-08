# Holdterm

A terminal-style superinvestor tracker (https://holdterm.pages.dev/, later https://holdterm.factordynamics.com/).
It covers superinvestor portfolios, buys and sells, a grand portfolio, 13D/G and Form 4 activity, and per-stock ownership.
There are no ads. The only thing it sells is email alerts ($3/month or $29/year, 7-day trial).

- Static Vite + React SPA with no router or UI dependencies. All data loads in the browser from Copybook's public
  SEC EDGAR files (`src/config.ts`: `DATA`, `DERIVED`). Nothing paid from Copybook is used.
- SEC filings only, with no market prices. "Reported price" means the filing's value divided by its shares.
- Paid alerts: `src/config.ts` holds the Stripe Payment Links and the alerts API base. While those are empty,
  the alerts page shows that checkout opens soon. Account flow: `src/account.tsx`.
- Hosting: Cloudflare Pages project `holdterm`. This repo's GitHub Pages already serves copybook.factordynamics.com,
  and a repo can have only one Pages site.

```bash
npm ci
npm run dev
npm run deploy   # build + wrangler pages deploy (needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)
```

`.github/workflows/holdterm.yml` builds on every push. It also deploys when the repo has a
`CLOUDFLARE_API_TOKEN` secret.

Keys: `/` search, `g` then `h m a p i e` to jump, `j`/`k` + `enter` in tables, `1`-`5` tabs, `?` help.
