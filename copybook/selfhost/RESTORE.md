# Restoring the member API off gene

gene (a self-hosted machine) runs the copybook-api Worker in workerd via Miniflare. These are its runtime files; the live
copy is `~/copybook-api/ops` on gene. Alerts don't depend on gene: Cloudflare's cron is the primary poller.

Masking rule: agent session logs are kept 30+ days, so these scripts print counts, booleans, opaque ids and
`a***@domain` emails, never raw member rows; checks run only against test members. Keep it that way when editing them.
Hourly local backups (`update.sh`) and nightly R2 backups (`backup.sh`) are both age-encrypted to `backup.pub`. Each
nightly backup has a manifest (`backups/YYYY-MM-DD.manifest.json`: plaintext and ciphertext sha256, counts), checked
weekly without the key by `backup-verify.sh` and monthly with it by `restore-check.sh`;
`setup-service-user.sh` (run once with sudo) moves the service, its state and secrets to a dedicated `copybook` user.

## Option A: fail members over to the Cloudflare Worker (rehearsed Nov 11: serving in under 25 s)

Automatic since Nov 11: Cloudflare's minute cron does steps 0–1 itself when both of gene's front doors (api.json's base
and Funnel) fail /health on 2 checks in a row, and moves members back after 3 healthy minutes
(`copybook/api/src/autofailover.ts`, state in R2 `status/auto-failover.json`, an email to hello@ on each move). It never
undoes a manual pin. The steps below are for doing it by hand.

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

Rehearsed Wed Nov 11, 16:01–16:08 UTC, by hand with `failover-a.sh`, gene left up, the deployer paused:
- `to-worker` wrote api.json at 16:01:07 (the PUT finished 16:01:21). By 16:01:31, the first check, workers.dev's
  `/health?probe=1` answered from the Worker itself (`api_host cloudflare`, not proxied).
- `verify.mjs` against the Worker: 16 of 17 pass (sign-in, /me, CORS, forged session, login, checkout return, history,
  csv-link on the public base, CSV, single use, a 32 MB CSV, follows, signed webhook replay and a bad signature). The
  Pro API-key check failed with 401 on gene too, so it was not the failover.
- `back` wrote api.json at 16:07:50; by 16:07:53 workers.dev proxied to gene again. Members were on the Worker 6 min 43 s.
- Stripe: a no-op update of the webhook endpoint succeeded (16:06:32), so step 2's call works. It wasn't repointed,
  because gene stayed up.
- Found: while failed over, the Worker didn't honour deletions. A key deleted on gene before the flip, and a seat
  removed on the Worker during it, both kept working there; gene rejected the seat within 27 s of fail-back. (gene's
  deletions leave the old `sync/gene/` copy, and the Worker's read falls back to it.) Payments' fix is 834d8ff; until it
  is live, keep a failover short, because revocations wait for fail-back.

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

Not covered by the rehearsal: getting a machine with an Amp runner (the long pole; minutes for a machine that already
has one), installing Node 22+, `age` and `cloudflared` there, step 5 (units, tunnel) and step 6 (webhook repoint).
Realistic total with a ready machine: 30–60 min of agent time.

Needs a Linux machine with Node 22+ and outbound internet, reachable by an Amp thread (a runner on another machine, or
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
   service-account move on Nov 17; after that only his passphrase-protected key file on his stick, so this step needs
   him; see restore-check.sh) and untar into `~/copybook-api/state`. Then bring KV up to the minute from Cloudflare:
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

The AI agents that maintain Copybook run as the machine's main user account `refcell`. From the service-account move
(`setup-service-user.sh`, steps in `TUE17-STEPS.md`), the API, its cron, deployer, backups, R2 push, quick tunnel and
watcher run as the system user `copybook`:

- `/var/lib/copybook` and `/var/lib/copybook/copybook-api` (state: KV, Durable Objects, the private R2 copy; hourly
  backups) are owned by `copybook`, mode 0700; `secrets.env` is 0600. The backup private key is not on gene at all
  (see "Backups and the backup key" below).
- The token-signing secrets are in that isolated set: `SESSION_SECRET` (signs every member session and every login,
  unsubscribe, keep and resume link; whoever holds it can sign in as any member) and `STRIPE_WEBHOOK_SECRET` (whoever
  holds it can forge a payment event). Both are rotated during the move, because agents held the old values; the
  Worker on Cloudflare gets the same new values.
- `refcell` keeps password sudo (Andreas uses it), but from the move every sudo needs the password with no cached
  credential (`/etc/sudoers.d/zz-copybook-maintainers`, `timestamp_timeout=0`), and its five password-free rules (display,
  DNS, theme, timezone and reboot) read no files. A deliberately malicious agent could
  still capture the password when Andreas types it in that account; a separate admin account would close that.
- Member requests reach the API without passing through `refcell`: the quick tunnel and Funnel's `/copybook` path go
  straight to `127.0.0.1:8787`.
- API code still deploys from main without waiting on anyone; see "Who can deploy code that runs as the service user"
  below.
- Agents see `/var/lib/copybook-status` (world-readable): shas, unit states, masked job logs, check results, and
  sessions for the comped test members. They maintain Copybook through the masked `/ops/` endpoints (counts and row
  IDs); reading a member's book goes through the logged path (`/ops/access-log`).
- The session and webhook secrets, the backup key, the waitlist decryption key and the Cloudflare, Stripe and Resend
  account passwords are gone from the agents' environment (the passwords are changed). Their Resend key is send-only.
  Their Cloudflare token keeps Workers Scripts (payments deploys the Worker), and it and their restricted Stripe key
  keep only the access payments' work needs; any of that which reaches member data is listed as a residual.

**Acceptance test**, run from the agents' account: `~/copybook-api/ops/acceptance-test.sh`. It tries to read a member
file, the members store, the private R2 copy, the hourly backups, the backup key, the service's secrets, the session
and webhook signing secrets by name, and the API process's environment and memory, and needs `Permission denied` for
each (a missing file doesn't count). It tries to write the deploy approval list, the service's scripts, source,
bundle, node runtime and units, and to reach the service's systemd manager, and needs the same refusal. It checks
that `sudo -n` fails (including reading a member file through it), that sudo keeps no cached credential for the
account, and that no NOPASSWD rule names a shell, editor or file tool. It checks the
removed credentials and passwords are gone, that Cloudflare KV and R2 and Stripe customers are refused unless payments
needs them (`ACC_KEEP`, reported as "kept", a stated residual), that a test
member's session signed with the old session secret (saved before the rotation, unexpired) is now refused, and that
`/me` and `/v1` still answer 200 for test members. It prints commands and errors only, never file contents.

Run before the move (Nov 11, negative control against today's layout): every read and write succeeded and every
credential reached member data, so each check reported FAIL with a byte count; the old-secret session got 200 (not
rotated yet); `/me` and `/v1` returned 200. Only the systemd-manager check can't be exercised before the service user
exists.

Output after the move: recorded here on Tue Nov 17.

## Backups and the backup key (from Tue Nov 17)

- Backups (nightly to R2, hourly on gene) are encrypted with age to a public key. The setup script makes the key pair
  in memory: gene keeps only the public key, and the private key is written only to Andreas's USB stick, protected by
  his passphrase (plus a second offline copy he keeps). No file on gene can decrypt a backup, so neither the service
  nor code deployed to it can read a backup. The status directory reports `backup_private_keys_on_host` (files on the
  service account holding an age secret key; must be 0), and the acceptance test checks it.
- **Weekly check, automatic and keyless** (`checks.sh backup` → `backup-verify.sh`, Mondays 11:30 UTC, result in
  `/var/lib/copybook-status/backup-checks.log`): every R2 backup with a manifest must match the manifest's ciphertext
  sha256 and size; it must be a well-formed age file (v1 header, exactly one X25519 recipient stanza) made for the
  current public key; the newest must be under 30 hours old; and the newest manifest's member and key counts, written
  at backup time from the plaintext, must be plausible against the live store. It can't prove a backup decrypts.
- **Decrypt drill, monthly, by Andreas** (TUE17-STEPS.md, "From then on"): with his stick and passphrase,
  `restore-check.sh` decrypts the newest backup, checks it against the manifest's plaintext sha256, opens it in a
  throwaway store and compares counts. It prints counts only.
- What that costs: any restore from a backup, on gene or another machine (Option B), needs Andreas and his stick, or
  the sealed copy he may give a named trustee (TUE17-STEPS.md, optional step 2b).
- If Andreas is unreachable: Cloudflare's poller keeps sending alerts, gene keeps serving members while it is up, and
  if gene goes offline an agent moves members to the Worker with Option A (an orb can do it; no step needs gene or
  Andreas). What waits for him: bringing gene back if it is powered off or broken, and any restore from a backup.
- One honest limit: during a drill, the decrypted key is in the memory of that one run, which runs as `copybook`, for
  about a minute.
- Until Nov 17 the old private key is also an Amp secret, so agents can recover alone during launch week. On Nov 17
  every R2 backup is re-encrypted to the new key and the Amp secret is deleted.

## Who can deploy code that runs as the service user (from Tue Nov 17)

File isolation stops accidental reads. It doesn't stop code that someone deliberately ships, so this is the list of
ways code gets to run as `copybook`, and who controls each. Deliberate-code risk is stated, not gated.

| What | Who can change it | How |
|---|---|---|
| The API (`copybook/api`, `holdterm/src` and its npm lockfile) | Anyone who can push to main, including the agents | API code: any push to main deploys after a boot test; every deploy is logged on /status/ with its build. Per-deploy founder approval exists but is off (`DEPLOY_REQUIRE_APPROVAL=1` in the service's `copybook-api.env`, set with sudo, turns it on; then each sha waits for `echo <sha> \| sudo -u copybook tee -a …/deploy.approved`). Packages come from the lockfile, checked against npm's integrity hashes. |
| The service's scripts and units (`/var/lib/copybook/copybook-api/ops`, `~copybook/.config/systemd/user`) | Andreas (root), and code already running as `copybook` | Installed once by `setup-service-user.sh` from the pinned `copybook/selfhost` code. The deployer doesn't update them, so a change to `copybook/selfhost` reaches the service when Andreas installs it with sudo. They are owned by `copybook`, so deployed API code (which runs as `copybook`) could also change them; that gives it nothing it doesn't already have. |
| node, age, cloudflared under `/var/lib/copybook` | Andreas (root), and code already running as `copybook` | Installed by the setup script from upstream downloads it checks against pinned sha256s; owned by `copybook`, as above. |
| The operating system, Tailscale, systemd | Andreas (root) | Through sudo, which needs his password; agents don't have it. |

Not code: ingest's uploads (`/ingest/bundle`, archives of JSON and CSV), EDGAR filings and Stripe events are data that
approved code parses; none of it is executed.

Off gene, two places still run deliberately shipped code that reaches member data:
- The Cloudflare Worker (it holds `SESSION_SECRET` and Cloudflare's copy of member data): payments deploys it with
  the agents' Cloudflare token, without per-deploy review.
- The Copybook and Holdterm front ends (GitHub Pages): any push to main deploys them without approval, agents
  included, and their code runs in a signed-in member's browser. The move doesn't change this.
