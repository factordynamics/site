Tue Nov 17: moving the Copybook API out of the AI maintenance agents' reach (Andreas; about 45 minutes)

Goal: the account the agents run as (refcell) can't read member data, the service's secrets (including the
token-signing secrets) or the backup key, can't change code that runs as the service user, isn't in the member request
path, and holds no credential that reads member data elsewhere. Agents keep the masked /ops/
endpoints (counts and row IDs; a book read goes through the logged path) and the status directory.

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
   any failed check stops it there with nothing changed for members. It asks for a passphrase for the offline copy of
   the new backup key: save the passphrase in 1Password and copy the .age file to a second offline place. If the API
   doesn't come back it rolls back on its own and says so.

3. Tell the Copybook API thread on gene: "service move done". The agent then:
   - saves a 7-day session for the comped test member signed with the current session secret, and checks the API
     takes it (acceptance-test.sh save-session); after step 4a that session must be refused;
   - re-encrypts every R2 backup to the new key (rewrap-backups.sh; it still has the old key at this point), so the
     old key, which agents have held, opens nothing that is kept;
   - checks the status directory, the tunnel, api.json and the front ends, and runs verify (19 checks).
   Wait for its "re-encrypted, ready for step 4".

4. Take the credentials that reach member data away from the agents:
   a. Session secret (rotating it signs every member out once; they sign in again by email link):
        NEW=$(openssl rand -base64 48 | tr -d '\n')
        sudo sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$NEW|" /var/lib/copybook/copybook-api/secrets.env
      Then in the Cloudflare dashboard: Workers → copybook-api → Settings → Variables → SESSION_SECRET → set the same
      value (print it once with `echo "$NEW"`, paste, then `unset NEW; clear`). Then:
        sudo systemctl --user --machine=copybook@ restart copybook-api
      Stripe's webhook signing secret too (whoever holds it can forge a payment event): Stripe dashboard → Developers →
      Webhooks → gene's endpoint → Roll secret (expire the old one now), then
        sudo sed -i "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=<new whsec_…>|" /var/lib/copybook/copybook-api/secrets.env
        sudo systemctl --user --machine=copybook@ restart copybook-api
      and, if the Worker's endpoint is a separate one, roll it as well and set the Worker's STRIPE_WEBHOOK_SECRET.
      Payments can send a test event afterwards to confirm gene takes the new secret.
   b. Amp Settings → Secrets: delete COPYBOOK_SESSION_SECRET, COPYBOOK_STRIPE_WEBHOOK_SECRET, COPYBOOK_BACKUP_AGE_KEY,
      COPYBOOK_WAITLIST_PRIVATE_KEY (it decrypts the waitlist's emails; keep it offline if you still need it), and the
      account passwords CLOUDFLARE_ACCOUNT_PASSWORD, STRIPE_ACCOUNT_PASSWORD and RESEND_ACCOUNT_PASSWORD (each signs in
      to a dashboard that shows member data). Change those three passwords, since agents have held them, and keep
      two-factor sign-in on. COPYBOOK_HEALTH_TOKEN stays: it is the agents' key to the masked /ops/ endpoints.
   c. Cloudflare dashboard → My Profile → API Tokens:
      - create a "copybook service" token with what the service needs (Account: Workers R2 Storage edit, Workers KV
        read, Account Analytics read; the same as today's token) and put it in the service's secrets:
          sudo sed -i -e "s|^CF_API_TOKEN=.*|CF_API_TOKEN=<new>|" -e "s|^CLOUDFLARE_API_TOKEN=.*|CLOUDFLARE_API_TOKEN=<new>|" /var/lib/copybook/copybook-api/secrets.env
          sudo systemctl --user --machine=copybook@ restart copybook-api
      - replace the Amp secret CLOUDFLARE_API_TOKEN with a token that has NO Workers Scripts edit, NO Workers KV, NO R2
        (only what agents still need, e.g. Pages and Analytics read), or delete it. From then on you deploy the Worker
        to Cloudflare yourself (npx wrangler deploy, logged in as you), after reviewing the change.
      - in the Workers dashboard, set copybook-api's CF_API_TOKEN secret to the new service token too (the Worker's cron
        uses it for the R2 sync and latency.json), then roll (re-issue) the old token so no copy of it works.
      - R2 → Manage API tokens: create a token for agents with Object Read & Write on bucket copybook-public ONLY
        (api.json lives there; no member data). Add its access key id and secret as Amp secrets R2_PUBLIC_KEY_ID and
        R2_PUBLIC_SECRET. This keeps the Cloudflare failover (failover-a.sh) runnable by an agent.
      - GitHub → factordynamics/site → Settings → Secrets: any Cloudflare token there must be limited to Pages; agents
        can push workflows that use it.
   d. Stripe dashboard → Developers → API keys: create a restricted key for agents without read access to Customers,
      Checkout Sessions, Events, Invoices, Charges, Payment Intents or Subscriptions; replace the Amp secret
      STRIPE_SECRET_KEY with it. The service keeps the full key (it is already in its secrets file).
   e. Restart the Amp runner so its environment drops the removed secrets: systemctl --user restart amp-runner
      (ends agent shells in progress; other software on the machine runs as separate units and keeps running).

5. Tell the thread "credentials done". The agent runs ~/copybook-api/ops/acceptance-test.sh from its own account:
   every read of member files, the members store, the secrets (SESSION_SECRET and STRIPE_WEBHOOK_SECRET by name) and
   the backup key must fail with "Permission denied", so must every write to code that runs as the service user and to
   the deploy approval list; the removed credentials and passwords must be gone or refused; the unexpired old-secret
   session must be refused; and /me and /v1 must still answer 200. It records the output in RESTORE.md and reports
   PASS or FAIL.

From then on:
- Deploys of the API on gene wait for you: review `git diff <deployed>..<sha> -- copybook/api holdterm/src` (the
  pending sha is in /var/lib/copybook-status/state.txt), then
    echo <full sha> | sudo -u copybook tee -a /var/lib/copybook/copybook-api/deploy.approved
  Deploy the same commit to Cloudflare yourself.
- Monthly decrypt drill: automatic, as the service user (Mondays, result in /var/lib/copybook-status/backup-checks.log).
  The offline copy is for rebuilding on another machine.
- Optional, unrelated to Copybook: Funnel also forwards public TCP port 8443 to SSH port 22, where nothing listens
  today. To remove it: sudo tailscale funnel --tcp=8443 off

Who can deploy code that runs as the service user from then on: see RESTORE.md, "Who can deploy code that runs as
the service user". In short, only you: API commits wait for your approval, and the scripts, units, node and binaries
change only through sudo.

What still isn't closed, stated plainly:
- File isolation stops accidental reads, not code someone deliberately ships. Code you approve runs with access to
  member data; review is the control. The front ends (GitHub Pages) still deploy on every push without approval, and
  their code runs in signed-in members' browsers.
- The agents share your desktop account. Anything you type or display in that session (for example in tmux) is
  readable by processes of that account, and they can edit its shell startup files, so a deliberately malicious agent
  could capture the sudo password you type there. Do the steps above in a plain terminal, and treat that account as
  untrusted for anything typed as root.
- What agents saw before Nov 17 stays in their session logs (masked since Nov 11: counts, row IDs, a***@domain).
