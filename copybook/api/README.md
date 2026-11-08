# Copybook API

Paid "Copy" plan backend for the static Copybook site: a Cloudflare Worker (free plan) with one KV namespace.

- Stripe Payment Links sell Copy ($9/mo, $79/yr). The Stripe webhook grants and revokes access per customer.
- Sign-in has no passwords: right after checkout the site trades the Checkout Session id for a 30-day session token, and later sign-ins use an emailed magic link (7 days).
- Paid data: per-manager 13F history (JSON) and CSV, built from the published `data/{slug}-history.json`.
- An hourly cron diffs each manager's latest 13F accession in `data/index.json` and emails active members who track that manager. Seen-state is the latest `report_date` alerted per manager (KV `alerts:periods`) and only moves forward, so amendments and re-parses of old periods never alert; first sightings only record state. 13F-HR and 13F-HR/A rows record the period (13F-NT does not); only an original `13F-HR` filed within 3 days sends (`MAX_ALERT_AGE_DAYS`). A filing reported under two slugs is listed once per email.
- Billing (cancel, switch plan, card, invoices) is the Stripe customer portal.

Paid history lives in the private R2 bucket `copybook-history` (`h/{slug}/{quarter}.json|csv`); the latest quarter and the 50-row previews stay public on Pages. A missing object falls back to the public `DATA_URL` copy.

Source data is SEC EDGAR 13F-HR only.

## API

All responses are JSON. Authenticated routes take `Authorization: Bearer <session token>`; the session token is never accepted from a URL. For a plain download link, `POST /csv-link/{slug}` returns a URL with a single-use token valid for 60 s for that one file.

| Method | Path | Body / response |
| --- | --- | --- |
| POST | `/session` | `{checkout_session: "cs_..."}` or `{login: "<token from email>"}` → `{token, member}` |
| POST | `/login` | `{email}` → `{ok: true}` always; emails a sign-in link if the address has an active plan |
| POST | `/csv-link/{slug}` | → `{url}`: `/csv/{slug}.csv?dl=…`, single use, 60 s, that file only |
| POST | `/handoff` | → `{login}`: a 2-minute sign-in token to carry a session across origins (exchange with `POST /session {login}`) |
| GET | `/me` | → `{member: {email, status, active, plan, period_end, alerts}}` |
| POST | `/portal` | → `{url}` of a Stripe customer portal session |
| POST | `/alerts` | `{alerts: "all" \| "off" \| ["warren-buffett", ...]}` → `{member}` |
| GET | `/history/{slug}` | → same shape as `data/{slug}-history.json` |
| GET | `/holdings/{slug}/{YYYYQn}` | → one full quarter (`{..., holdings: [...]}`) from the private bucket |
| GET | `/csv/{slug}.csv` | → CSV of every quarter, full book. `csv_url` shards are piped natively (Citadel, 19.7 MB / 106k rows: 8 ms CPU); `holdings_url` or inline `holdings` are converted in JS |
| POST | `/webhook` | Stripe only (signature checked) |
| PUT | `/ingest/h/{slug}/{YYYYQn}.json\|csv` | Data workflow only: body is the file. Auth is the workflow's GitHub OIDC token (`aud=copybook-api`, `workflow_ref` must equal `INGEST_WORKFLOW`) |
| GET | `/health` | `{ok: true}` |

401 means sign in again; 402 means the plan is not active (cancelled or unpaid).

## Deploy

```sh
cd copybook/api && pnpm i
npx wrangler login
npx wrangler kv namespace create DB         # paste the id into wrangler.toml
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
printf '%s' "$STRIPE_SECRET_KEY" | npx wrangler secret put STRIPE_SECRET_KEY
printf '%s' "$RESEND_API_KEY"    | npx wrangler secret put RESEND_API_KEY
pnpm run deploy                             # prints https://copybook-api.<sub>.workers.dev
STRIPE_SECRET_KEY=... node scripts/stripe-setup.mjs --api https://copybook-api.<sub>.workers.dev --out /tmp/stripe.json
jq -r .webhook_secret /tmp/stripe.json | npx wrangler secret put STRIPE_WEBHOOK_SECRET
# set PORTAL_CONFIGURATION in wrangler.toml to portal_configuration, then pnpm run deploy again
```

Live: `https://copybook-api.factordynamics.workers.dev` (Cloudflare account of abigger87@gmail.com, KV `copybook-api-DB`). Payment Links, portal configuration and webhook were created by `stripe-setup.mjs` in live mode.

`stripe-setup.mjs` is idempotent (it finds its objects by metadata and price lookup keys) and works for test and live keys. It recreates the webhook endpoint each run so it can print a fresh signing secret.

Email goes through Resend from `copybook@factordynamics.com` (domain verified in Resend; DNS in Squarespace).

```sh
pnpm test && pnpm typecheck
```
