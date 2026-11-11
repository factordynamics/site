# Restoring the member API off gene

gene (Andreas's desktop) runs the copybook-api Worker in workerd via Miniflare. These are its runtime files; the live
copy is `~/copybook-api/ops` on gene. Alerts don't depend on gene: Cloudflare's cron is the primary poller.

Masking rule: agent session logs are kept 30+ days, so these scripts print counts, booleans, opaque ids and
`a***@domain` emails, never raw member rows; checks run only against test members. Keep it that way when editing them.
Hourly local backups (`update.sh`) and nightly R2 backups (`backup.sh`) are both age-encrypted to `backup.pub`. Each
nightly backup has a manifest (`backups/YYYY-MM-DD.manifest.json`: plaintext and ciphertext sha256, counts), checked
weekly without the key by `backup-verify.sh` and monthly with it by `restore-check.sh`;
`setup-service-user.sh` (run once with sudo) moves the service, its state and secrets to a dedicated `copybook` user.

## Option A: fail members over to the Cloudflare Worker (minutes)

Cloudflare's copy already has every secret, and its KV is kept current by the sync through R2 (HOSTING.md), so members,
sessions and follows are there up to about a minute before gene went down. Limit: the free plan's 100k requests/day.

0. One command does step 1 (and pins it so the tunnel watcher leaves it): `failover-a.sh to-worker`; undo with
   `failover-a.sh back`. Use it also when the quick tunnel nears its 200 in-flight limit (`inflight-sampler.sh` emails
   hello@ at 100).
1. Publish `{"api":"https://copybook-api.factordynamics.workers.dev","at":"<iso>"}` to R2 copybook-public `api.json`
   (Cloudflare REST, `CLOUDFLARE_API_TOKEN`). The front ends read it at load. The Worker then serves requests itself
   instead of redirecting (loop guard, 754c32a), within about 60 s. **Never delete `MOVED_TO`:** it is also what makes
   the Worker the `cloudflare` host for the R2 sync and the primary poller.
2. Point Stripe webhook `we_1UZHeoDSKGGzRqYZUz48mjdU` at `https://copybook-api.factordynamics.workers.dev/webhook`
   (same signing secret).

Any Amp thread with Andreas's personal secrets can do this, including an orb.

## Option B: another machine (rehearsed: 7 min scripted, about 30–60 min end to end)

**Rehearsed 2026-11-10 23:47 UTC** with `rehearse-b.sh` (steps 1–4 plus a local boot and the 19-check verify, in an
empty directory on gene, secrets from Amp secrets only, scratch port, no cron or tunnel): 19/19 PASS, total 433 s.

| Step | Measured |
|---|---|
| 1 secrets | 0 s |
| 2 clone, install, build | 6 s (gene's package caches were warm; expect 1–3 min on a new machine) |
| 3a R2 pull (42,747 objects, 3.47 GB) | 282 s |
| 3b R2 import | 139 s |
| 4a decrypt and untar the nightly backup (2026-11-10) | 1 s |
| 4b KV overlay from Cloudflare (333 keys) | 3 s |
| boot to /health | 1 s |
| 19-check verify | 1 s |

Not covered by the rehearsal: getting a machine with an Amp runner (the long pole; minutes for a desktop that already
has one), installing Node 22+, `age` and `cloudflared` there, step 5 (units, tunnel) and step 6 (webhook repoint).
Realistic total with a ready machine: 30–60 min of agent time.

Needs a Linux machine with Node 22+ and outbound internet, reachable by an Amp thread (a runner on another desktop, or
a VM with the Amp CLI). Inbound ports are not needed: the quick tunnel is outbound.

1. Secrets from Amp personal secrets into `~/copybook-api/secrets.env` (mode 600): `SESSION_SECRET` ←
   `COPYBOOK_SESSION_SECRET`, `STRIPE_WEBHOOK_SECRET` ← `COPYBOOK_STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`,
   `RESEND_API_KEY`, `HEALTH_TOKEN` ← `COPYBOOK_HEALTH_TOKEN`, `CF_API_TOKEN` and `CLOUDFLARE_API_TOKEN` ←
   `CLOUDFLARE_API_TOKEN`.
2. Install Node 22+, `age` and `cloudflared` (static binaries in `~/copybook-api/bin`). Sparse-clone factordynamics/site
   (`copybook`, `holdterm/src`, `.github`; the API imports `holdterm/src/names`, and the build fails without it), `npx pnpm@10 install --frozen-lockfile` in `copybook/api`,
   `npx wrangler deploy --dry-run --outdir ~/copybook-api/build`. Copy this directory to `~/copybook-api/ops`, `npm ci`
   there, and `copybook-api.env.example` to `~/copybook-api/copybook-api.env` (fix paths).
3. R2: `node r2-pull.mjs <mirror dir>` (3.5 GB from copybook-history, 5 min measured), then with the service stopped
   `node import.mjs r2 <mirror dir>` (2.5 min measured).
4. KV and Durable Objects: decrypt the newest `backups/*.tar.age` (key `COPYBOOK_BACKUP_AGE_KEY` until Andreas takes the
   key offline per BACKUP-KEY-STEPS.md; after that his passphrase-protected key file, so this step needs him; see
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

## Who can read member data on gene (from Tue Nov 17)

The AI agents that maintain Copybook run as the desktop account `refcell`. From the service-account move
(`setup-service-user.sh`, steps in `TUE17-STEPS.md`), the API, its cron, deployer, backups, R2 push, quick tunnel and
watcher run as the system user `copybook`:

- `/var/lib/copybook` and `/var/lib/copybook/copybook-api` (state: KV, Durable Objects, the private R2 copy; hourly
  backups) are owned by `copybook`, mode 0700; `secrets.env` and the backup key `backup.key` are 0600.
- The token-signing secrets are in that isolated set: `SESSION_SECRET` (signs every member session and every login,
  unsubscribe, keep and resume link; whoever holds it can sign in as any member) and `STRIPE_WEBHOOK_SECRET` (whoever
  holds it can forge a payment event). Both are rotated during the move, because agents held the old values; the
  Worker on Cloudflare gets the same new values.
- Member requests reach the API without passing through `refcell`: the quick tunnel and Funnel's `/copybook` path go
  straight to `127.0.0.1:8787`.
- New code runs there only after Andreas approves its commit (deploy gate in `update.sh`); see "Who can deploy code
  that runs as the service user" below.
- Agents see `/var/lib/copybook-status` (world-readable): shas, unit states, masked job logs, check results, and
  sessions for the comped test members. They maintain Copybook through the masked `/ops/` endpoints (counts and row
  IDs); reading a member's book goes through the logged path (`/ops/access-log`).
- The agents' Cloudflare and Stripe credentials no longer read member data; the session and webhook secrets, the
  backup key, the waitlist decryption key and the Cloudflare, Stripe and Resend account passwords are gone from their
  environment (the passwords are changed). Their Resend key is send-only.

**Acceptance test**, run from the agents' account: `~/copybook-api/ops/acceptance-test.sh`. It tries to read a member
file, the members store, the private R2 copy, the hourly backups, the backup key, the service's secrets, the session
and webhook signing secrets by name, and the API process's environment and memory, and needs `Permission denied` for
each (a missing file doesn't count). It tries to write the deploy approval list, the service's scripts, source,
bundle, node runtime and units, and to reach the service's systemd manager, and needs the same refusal. It checks the
removed credentials and passwords are gone or refused (Cloudflare KV and R2 list, Stripe customers), that a test
member's session signed with the old session secret (saved before the rotation, unexpired) is now refused, and that
`/me` and `/v1` still answer 200 for test members. It prints commands and errors only, never file contents.

Run before the move (Nov 11, negative control against today's layout): every read and write succeeded and every
credential reached member data, so each check reported FAIL with a byte count; the old-secret session got 200 (not
rotated yet); `/me` and `/v1` returned 200. Only the systemd-manager check can't be exercised before the service user
exists.

Output after the move: recorded here on Tue Nov 17.

## Who can deploy code that runs as the service user (from Tue Nov 17)

File isolation stops accidental reads. It doesn't stop code that someone deliberately ships, so this is the list of
ways code gets to run as `copybook`, and who controls each.

| What | Who can change it | How |
|---|---|---|
| The API (`copybook/api`, `holdterm/src` and its npm lockfile) | Andreas | Anyone with push access to factordynamics/site main can push, including the agents (through Andreas's GitHub credentials). The deployer, as `copybook`, fetches every 2 minutes but installs, tests, builds and runs nothing from a new commit until Andreas appends its sha with `echo <sha> \| sudo -u copybook tee -a /var/lib/copybook/copybook-api/deploy.approved`. Approving a sha approves every commit before it, so he reviews `git diff <deployed>..<sha> -- copybook/api holdterm/src` first. Packages come from the lockfile, checked against npm's integrity hashes. |
| The service's scripts and units (`/var/lib/copybook/copybook-api/ops`, `~copybook/.config/systemd/user`) | Andreas (root) | Installed once by `setup-service-user.sh` from the pinned `copybook/selfhost` code. The deployer doesn't update them; a change to `copybook/selfhost` reaches the service only when Andreas installs it with sudo. |
| node, age, cloudflared under `/var/lib/copybook` | Andreas (root) | Installed by the setup script from upstream downloads it checks against pinned sha256s. |
| The operating system, Tailscale, systemd | Andreas (root) | Through sudo, which needs his password; agents don't have it. |

Not code: ingest's uploads (`/ingest/bundle`, archives of JSON and CSV), EDGAR filings and Stripe events are data that
approved code parses; none of it is executed.

Off gene, two places still run deliberately shipped code that reaches member data:
- The Cloudflare Worker (it holds `SESSION_SECRET` and Cloudflare's copy of member data): from the move, only Andreas
  deploys it (`wrangler deploy` as himself); the agents' Cloudflare token has no Workers Scripts permission.
- The Copybook and Holdterm front ends (GitHub Pages): any push to main deploys them without approval, agents
  included, and their code runs in a signed-in member's browser. The move doesn't change this.
