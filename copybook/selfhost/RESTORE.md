# Restoring the member API off gene

gene (Andreas's desktop) runs the copybook-api Worker in workerd via Miniflare. These are its runtime files; the live
copy is `~/copybook-api/ops` on gene. Alerts don't depend on gene: Cloudflare's cron is the primary poller.

Masking rule: agent session logs are kept 30+ days, so these scripts print counts, booleans, opaque ids and
`a***@domain` emails, never raw member rows; checks run only against test members. Keep it that way when editing them.
Hourly local backups (`update.sh`) and nightly R2 backups (`backup.sh`) are both age-encrypted to `backup.pub`;
`setup-service-user.sh` (run once with sudo) moves the service, its state and secrets to a dedicated `copybook` user.

## Option A: fail members over to the Cloudflare Worker (minutes)

Cloudflare's copy already has every secret, and its KV is kept current by the sync through R2 (HOSTING.md), so members,
sessions and follows are there up to about a minute before gene went down. Limit: the free plan's 100k requests/day.

1. Publish `{"api":"https://copybook-api.factordynamics.workers.dev","at":"<iso>"}` to R2 copybook-public `api.json`
   (Cloudflare REST, `CLOUDFLARE_API_TOKEN`). The front ends read it at load. The Worker then serves requests itself
   instead of redirecting (loop guard, 754c32a), within about 60 s. **Never delete `MOVED_TO`:** it is also what makes
   the Worker the `cloudflare` host for the R2 sync and the primary poller.
2. Point Stripe webhook `we_1UZHeoDSKGGzRqYZUz48mjdU` at `https://copybook-api.factordynamics.workers.dev/webhook`
   (same signing secret).

Any Amp thread with Andreas's personal secrets can do this, including an orb.

## Option B: another machine (about 1–2 hours of agent time)

Needs a Linux machine with Node 22+ and outbound internet, reachable by an Amp thread (a runner on another desktop, or
a VM with the Amp CLI). Inbound ports are not needed: the quick tunnel is outbound.

1. Secrets from Amp personal secrets into `~/copybook-api/secrets.env` (mode 600): `SESSION_SECRET` ←
   `COPYBOOK_SESSION_SECRET`, `STRIPE_WEBHOOK_SECRET` ← `COPYBOOK_STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`,
   `RESEND_API_KEY`, `HEALTH_TOKEN` ← `COPYBOOK_HEALTH_TOKEN`, `CF_API_TOKEN` and `CLOUDFLARE_API_TOKEN` ←
   `CLOUDFLARE_API_TOKEN`.
2. Sparse-clone factordynamics/site (`copybook`, `.github`), `npx pnpm@10 install --frozen-lockfile` in `copybook/api`,
   `npx wrangler deploy --dry-run --outdir ~/copybook-api/build`. Copy this directory to `~/copybook-api/ops`, `npm ci`
   there, and `copybook-api.env.example` to `~/copybook-api/copybook-api.env` (fix paths).
3. R2: `node r2-pull.mjs <mirror dir>` (3.5 GB from copybook-history, ~5–15 min), then with the service stopped
   `node import.mjs r2 <mirror dir>` (~5 min).
4. KV and Durable Objects: decrypt the newest `backups/*.tar.age` (key `COPYBOOK_BACKUP_AGE_KEY`; see
   restore-check.sh) and untar into `~/copybook-api/state`. Then bring KV up to the minute from Cloudflare:
   `node ../site/copybook/api/scripts/kv-export.mjs kv.json && node import.mjs kv kv.json && shred -u kv.json`.
5. Install the units in `systemd/` (change `copybook-tunnel.service` to `--url http://127.0.0.1:8787`; server.mjs
   accepts the `/copybook` prefix itself), `loginctl enable-linger`, start `copybook-api`, `copybook-tunnel`,
   `copybook-tunnel-watch.timer`, `copybook-api-update.timer`, `copybook-api-backup.timer`. Leave `cron.enabled` absent
   unless Cloudflare's cron is off.
6. The watcher publishes api.json and the front-end configs. Repoint the Stripe webhook to `<tunnel>/copybook/webhook`.
   `node verify.mjs <tunnel>/copybook` must pass.

Links already sent in email point at gene's Funnel URL (`API_URL`) and stay broken until gene or
`https://copybook.factordynamics.com/api/` is back.
