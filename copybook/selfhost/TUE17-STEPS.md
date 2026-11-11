Tue Nov 17: moving the Copybook API out of the AI maintenance agents' reach (Andreas; about 45 minutes)

Goal: the account the agents run as (refcell) can't read member data, the service's secrets (including the
token-signing secrets) or the backup key, can't change the service's files, and isn't in the member request path.
Builders keep shipping without waiting on you: any commit on main that passes the boot test deploys to gene, as today,
and payments keeps deploying the Worker. Agents keep the masked /ops/ endpoints (counts and row IDs; a book read goes
through the logged path) and the status directory.

Pick a quiet hour (not 11:00–23:00 UTC on a filing day). Members see about 1–2 minutes of errors, and the tunnel URL
changes (api.json and the front ends follow within 2 minutes).

1. Check the script you'll run as root (it sits in a folder the agents can write):
     sha256sum ~/copybook-api/ops/setup-service-user.sh
   It must equal the sha256 the agent gives you for the reviewed commit (and the file at
   https://github.com/factordynamics/site/blob/<commit>/copybook/selfhost/setup-service-user.sh). If it differs, stop.
   Skim it: it's about 230 lines. That one check covers everything else that will run as the service user: the script
   pins node (nodejs.org checksum), age and cloudflared (release checksums) and the code of copybook/selfhost (a hash
   over its files), takes the API from a fresh clone of the deployed commit and rebuilds it, so nothing that runs there
   is copied from the agents' account. Only data (state, encrypted backups) and allow-listed secrets are copied.
   Ask the agent for "DRY_RUN=1 setup-service-user.sh" output from that morning first: it must say the pins match.

2. Mount a USB stick and run, in your own terminal (not inside tmux, whose scrollback other processes of your account
   can read):
     sudo OFFLINE_KEY=/run/media/$USER/<stick>/copybook-backup-key.age ~/copybook-api/ops/setup-service-user.sh
   It first builds and boot-tests the API as the service user while the current one keeps serving (a few minutes);
   any failed check stops it there with nothing changed for members. It makes a new backup key in memory: gene keeps
   only the public key, and the private key goes only to the file on your stick, protected by a passphrase it asks
   for (twice, then once more to check). Save the passphrase in 1Password and copy the .age file to a second offline
   place: without it no backup can be decrypted. If the API
   doesn't come back it rolls back on its own and says so.

3. Tell the Copybook API thread on gene: "service move done". The agent then:
   - saves a 7-day session for the comped test member signed with the current session secret, and checks the API
     takes it (acceptance-test.sh save-session); after step 4a that session must be refused;
   - re-encrypts every R2 backup to the new key (rewrap-backups.sh; it still has the old key at this point), so the
     old key, which agents have held, opens nothing that is kept;
   - checks the status directory (backup_private_keys_on_host must be 0), the tunnel, api.json and the front ends, and runs verify (19 checks).
   Wait for its "re-encrypted, ready for step 4".

4. Rotate the signing secrets and take the credentials agents don't need:
   a. Session secret (rotating it signs every member out once; they sign in again by email link):
        NEW=$(openssl rand -base64 48 | tr -d '\n')
        sudo sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$NEW|" /var/lib/copybook/copybook-api/secrets.env
      Then in the Cloudflare dashboard (yourself, not an agent: whoever sets it sees it): Workers → copybook-api →
      Settings → Variables → SESSION_SECRET → set the same value (print it once with `echo "$NEW"`, paste, then `unset NEW; clear`). Then:
        sudo systemctl --user --machine=copybook@ restart copybook-api
      Stripe's webhook signing secret too (whoever holds it can forge a payment event): Stripe dashboard → Developers →
      Webhooks → endpoint we_1UZHeoDSKGGzRqYZUz48mjdU (…/copybook/webhook; Copybook's only one) → Roll secret
      (expire the old one now), then
        sudo sed -i "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=<new whsec_…>|" /var/lib/copybook/copybook-api/secrets.env
        sudo systemctl --user --machine=copybook@ restart copybook-api
      and set the same value as the Worker's STRIPE_WEBHOOK_SECRET in the dashboard (it keeps a copy for failover; it
      has no endpoint of its own). Payments can send a test event afterwards to confirm gene takes the new secret.
   b. Amp Settings → Secrets: delete COPYBOOK_SESSION_SECRET, COPYBOOK_STRIPE_WEBHOOK_SECRET, COPYBOOK_BACKUP_AGE_KEY,
      COPYBOOK_WAITLIST_PRIVATE_KEY (it decrypts the waitlist's emails; retired: the only entries are three test
      sign-ups from Nov 7), and the
      account passwords CLOUDFLARE_ACCOUNT_PASSWORD, STRIPE_ACCOUNT_PASSWORD and RESEND_ACCOUNT_PASSWORD (each signs in
      to a dashboard that shows member data). Change those three passwords, since agents have held them, and keep
      two-factor sign-in on. COPYBOOK_HEALTH_TOKEN stays: it is the agents' key to the masked /ops/ endpoints.
   c. Cloudflare dashboard → My Profile → API Tokens:
      - create a "copybook service" token with what the service needs (Account: Workers R2 Storage edit, Workers KV
        read, Account Analytics read; the same as today's token) and put it in the service's secrets:
          sudo sed -i -e "s|^CF_API_TOKEN=.*|CF_API_TOKEN=<new>|" -e "s|^CLOUDFLARE_API_TOKEN=.*|CLOUDFLARE_API_TOKEN=<new>|" /var/lib/copybook/copybook-api/secrets.env
          sudo systemctl --user --machine=copybook@ restart copybook-api
      - replace the Amp secret CLOUDFLARE_API_TOKEN with a token that KEEPS Workers Scripts edit (payments deploys the
        Worker) plus only the KV and R2 access payments listed as needed (see "Payments' access" below); everything
        else off.
      - in the Workers dashboard, set copybook-api's CF_API_TOKEN secret to the new service token too (the Worker's cron
        uses it for the R2 sync and latency.json), then roll (re-issue) the old token so no copy of it works.
      - R2 → Manage API tokens: create a token for agents with Object Read & Write on bucket copybook-public ONLY
        (api.json lives there; no member data). Add its access key id and secret as Amp secrets R2_PUBLIC_KEY_ID and
        R2_PUBLIC_SECRET. This keeps the Cloudflare failover (failover-a.sh) runnable by an agent.
      - GitHub → factordynamics/site → Settings → Secrets: any Cloudflare token there must be limited to Pages; agents
        can push workflows that use it.
   d. Stripe dashboard → Developers → API keys: create a restricted key for agents with exactly the scopes payments
      listed (see "Payments' access" below), and replace the Amp secret STRIPE_SECRET_KEY with it. The service keeps
      the full key (it is already in its secrets file).
   e. Restart the Amp runner so its environment drops the removed secrets. Another agent thread works on this
      machine (its long-running processes are separate units and keep running; its shells don't), so: when you start
      (step 1), the agent tells that thread the planned restart time, at
      least 30 minutes ahead, and waits for it to confirm it's safe. Restart only after the agent says "runner restart
      cleared":
        systemctl --user restart amp-runner
      (ends agent shells in progress). Then tell the thread "runner restarted"; the agent tells that thread it's done.

5. Tell the thread "credentials done". The agent runs ~/copybook-api/ops/acceptance-test.sh from its own account:
   every read of member files, the members store, the secrets (SESSION_SECRET and STRIPE_WEBHOOK_SECRET by name) and
   the backup key must fail with "Permission denied", so must every write to code that runs as the service user and to
   the deploy switch; the removed credentials and passwords must be gone; access payments needs is run as
   ACC_KEEP (reported as "kept", a stated residual, not a failure); the unexpired old-secret session must be refused;
   and /me and /v1 must still answer 200. It records the output in RESTORE.md and reports PASS or FAIL.

Payments' access (from payments' reply, Nov 11; the agents' tokens keep exactly this):
- Cloudflare token: Workers Scripts edit (deploys, `wrangler secret put`); Account Analytics read (optional after
  Nov 11); Workers KV: none (dropped; the store moved to R2); R2 copybook-history: none (dropped, lead's decision
  Nov 11; payments audits member objects through the API's logged operator routes).
  copybook-public: through the separate R2 token (R2_PUBLIC_KEY_ID/SECRET, read and write, for failover's api.json).
- Stripe restricted key: Customers write (includes read; test members, delete for cleanup), Subscriptions write,
  Prices read, Products read, Checkout Sessions read, Invoices write, Webhook Endpoints write, Events read, Coupons
  write, Promotion Codes write, Billing Portal configuration read. Nothing else.
- Acceptance run: ACC_KEEP="stripe-customers" (the Cloudflare KV and R2 copybook-history checks must be refused).

From then on:
- Deploys need nothing from you: any commit on main that passes the boot test deploys to gene and is logged with its
  build (/var/lib/copybook-status/deploys.log and /status/). Per-deploy approval exists but is off; to turn it on
  (for example for a tier holding fund shorts or sub-13F names), set DEPLOY_REQUIRE_APPROVAL=1 in
  /var/lib/copybook/copybook-api/copybook-api.env with sudo, then approve each sha with
    echo <full sha> | sudo -u copybook tee -a /var/lib/copybook/copybook-api/deploy.approved
- Backups: the weekly check runs on its own without the private key (Mondays; result in
  /var/lib/copybook-status/backup-checks.log). Once a month, run the real decrypt drill with your stick (about 2 min):
    sudo install -o copybook -g copybook -m 0400 /run/media/$USER/<stick>/copybook-backup-key.age /dev/shm/cbk.age
    sudo -u copybook env HOME=/var/lib/copybook AGE_KEY_FILE=/dev/shm/cbk.age /var/lib/copybook/copybook-api/ops/restore-check.sh
    sudo rm -f /dev/shm/cbk.age
  It asks for the passphrase and prints counts only. Any restore from a backup (on gene or another machine) needs
  you for the same reason.
- Optional, unrelated to Copybook: Funnel also forwards public TCP port 8443 to SSH port 22, where nothing listens
  today. To remove it: sudo tailscale funnel --tcp=8443 off

Who can deploy code that runs as the service user from then on: see RESTORE.md, "Who can deploy code that runs as
the service user". In short: any push to main deploys API code after a boot test; the scripts, units, node and
binaries change only through sudo.

What still isn't closed, stated plainly:
- Code we deploy to the API can read member data, and deploys happen without per-deploy founder review. The same
  holds for the Worker, which payments deploys.
- The front ends deploy on every push, and their code runs in signed-in members' browsers.
- Agents share the machine's main user account, so isolation stops accidental reads, not a deliberately malicious
  agent (one could, for example, capture a sudo password typed in that account). Do the steps above in a plain
  terminal.
- The agents' Stripe key can read customers, which payments' work needs.
- Older agent session logs keep what agents saw then (masked since Nov 11: counts, row IDs, a***@domain).
