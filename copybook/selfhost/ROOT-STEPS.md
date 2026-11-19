# Copybook self-host: steps that need root or a dashboard login

Owner: the Copybook self-host thread (https://ampcode.com/threads/T-01a1be80-c5ff-7641-b745-6abf1056e5e3).
Decisions: roadmap rev 44 (decisions thread T-01a1f1ed-9808-7773-a457-611c1fab06d8, Nov 19).

Nobody waits on this file and nobody is pinged about it. No one with root or dashboard access is available, so
everything below is open. Copybook runs without any of it: the Cloudflare Worker serves members whenever gene is
down, and gene keeps serving through workers.dev, Funnel and the quick tunnel. Each step says what it closes. Do them
in this order if someone ever can; each one stands alone, except that step 2 makes step 1 unnecessary.

Run root steps in a plain terminal on gene, not inside tmux or an agent shell (other processes of the refcell
account can read a multiplexer's scrollback, and could capture a sudo password typed there).

## 1. Guard timer for the user manager (root, about 1 minute)

Why: on Nov 13 18:03Z a desktop logout made refcell's systemd user manager exit ("Exit the Session"). Every user unit
stopped with it, including copybook-api, its tunnel and its timers, for 58 h until the next login on Nov 16 04:21Z.
Linger=yes only starts the manager at boot, so nothing brings it back after a logout. A reboot is fine; a logout or
a desktop crash is not. While it is missing, the Worker serves members alone; precompute uploads, gene's backup
polling, the Stripe webhook and emailed links on Funnel fail until someone logs in.

    sudo bash ~/copybook-api/user-manager-guard.sh

It writes /etc/systemd/system/refcell-user-manager-guard.{service,timer}: every minute, `systemctl start
user@1000.service`, which does nothing when the manager is already running. Check:

    systemctl list-timers --no-pager refcell-user-manager-guard.timer

Undo: `sudo systemctl disable --now refcell-user-manager-guard.timer` and remove the two files.
Not needed after step 2 (the API then runs under its own lingering `copybook` user, which no desktop session owns).

## 2. The Nov 17 security session, "TUE17" (root and dashboards, about 45 minutes; postponed indefinitely)

Full text: ~/copybook-api/ops/TUE17-STEPS.md. Pick a quiet hour outside 11:00–23:00 UTC on a filing day. Members see
1–2 minutes of errors. Summary, in order:

a. Ask the self-host thread for that morning's `DRY_RUN=1 OFFLINE_KEY=/dev/shm/x.age setup-service-user.sh` output
   (it must say the pins match) and the binding sha256. Then compare:

       sha256sum ~/copybook-api/ops/setup-service-user.sh

   It must equal the copy on factordynamics/site main (copybook/selfhost/setup-service-user.sh). On Nov 19 after
   site 08fbc0c that is 42995606073982bd1b358040100d300db738e11941cf557f2212be008ec4ddc7 (Nov 18's dry run passed
   on 0aea8676…1a03; any later change to copybook/selfhost changes it again). If it differs, stop.

b. Service account and offline backup key (root, USB stick mounted):

       sudo OFFLINE_KEY=/run/media/$USER/<stick>/copybook-backup-key.age ~/copybook-api/ops/setup-service-user.sh

   Why: today the agents' account (refcell) can read member data, the service's secrets (including the token-signing
   secret) and can change the service's code. This moves the API to a `copybook` system user, makes a new backup key
   whose private half exists only on the stick (behind a passphrase), and makes every sudo from refcell ask for the
   password. Save the passphrase in a password manager and copy the .age file to a second offline place. It rolls
   back by itself if the API doesn't come back. Optional 2b in TUE17-STEPS.md: a sealed copy for a trustee.

c. Tell the self-host thread "service move done". It saves a test session, re-encrypts every R2 backup to the new key
   (rewrap-backups.sh) and checks the status directory. Wait for "re-encrypted, ready for step 4".

d. Rotate secrets and narrow credentials (dashboards plus sudo). Rotating before (b) gains nothing, because agents
   could read the new values in secrets.env.
   - SESSION_SECRET: new value on gene (`sudo sed` into /var/lib/copybook/copybook-api/secrets.env) and the same in
     Cloudflare → Workers → copybook-api → Settings → Variables; restart. Signs every member out once.
   - Stripe webhook signing secret: Stripe → Developers → Webhooks → we_1UZHeoDSKGGzRqYZUz48mjdU → Roll secret, expire
     now; set it on gene and as the Worker's STRIPE_WEBHOOK_SECRET. Whoever holds it can forge payment events.
   - Cloudflare: a "copybook service" token (R2 edit, KV read, Analytics read) for the service and the Worker's
     CF_API_TOKEN; replace the Amp secret CLOUDFLARE_API_TOKEN with one that keeps only Workers Scripts edit; an R2
     token for bucket copybook-public only, as Amp secrets R2_PUBLIC_KEY_ID / R2_PUBLIC_SECRET; then roll the old
     account-wide token. Note: that old token (CF_API_TOKEN in ~/copybook-api/secrets.env) is also what Holdterm's
     hand deploys use today; after the roll, Holdterm deploys need step 4's Pages token or a person.
   - Stripe restricted key for agents (Stripe → Developers → API keys), with exactly the scopes in TUE17-STEPS.md
     "Payments' access"; replace the Amp secret STRIPE_SECRET_KEY. Only the dashboard can create it.
   - Amp Settings → Secrets: delete COPYBOOK_SESSION_SECRET, COPYBOOK_STRIPE_WEBHOOK_SECRET, COPYBOOK_BACKUP_AGE_KEY,
     COPYBOOK_WAITLIST_PRIVATE_KEY, CLOUDFLARE_ACCOUNT_PASSWORD, STRIPE_ACCOUNT_PASSWORD, RESEND_ACCOUNT_PASSWORD;
     change those three passwords (agents have held them). Keep COPYBOOK_HEALTH_TOKEN.
   - Restart the Amp runner (`systemctl --user restart amp-runner`) only after the self-host thread has warned the
     other threads on gene at least 30 minutes ahead and says "runner restart cleared".

e. Tell the self-host thread "credentials done". It runs acceptance-test.sh: every read of member files, secrets and
   the backup key from refcell must fail with Permission denied ("logged shell reads": after the move, direct reads
   fail; member-book reads go through the API's logged /ops/access-log path). Logging shell reads before the move
   would need auditd, which is root too, and is not planned.

After (b): once a month, the decrypt drill in TUE17-STEPS.md ("Monthly decrypt drill") on a machine of the key
holder's own, never on gene. The weekly backup check asks the decisions thread for it.

## 3. MFA on the admin accounts (dashboards, about 10 minutes; unconfirmed)

Why: the PM's vendor questionnaire asks for MFA on GitHub, Cloudflare, Stripe and Amp. /security/questionnaire/ says
"not confirmed" because only the account holder can check. Check or turn on two-factor sign-in in each:
- GitHub: Settings → Password and authentication → Two-factor authentication (and the factordynamics org →
  Settings → Authentication security → Require two-factor authentication).
- Cloudflare: My Profile → Authentication → Two-Factor Authentication.
- Stripe: Settings → Personal details (User settings) → Two-step authentication.
- Amp: account settings, or the sign-in provider's MFA if Amp signs in through Google or GitHub.
Then tell the decisions thread "MFA on for all four" (or which aren't), so the questionnaire can say so.

## 4. Pages-only Cloudflare token for Holdterm's workflow (dashboards, about 5 minutes; dropped)

Why: .github/workflows/holdterm.yml builds on every push to holdterm/** but skips deploying, because the repo has no
CLOUDFLARE_API_TOKEN secret. Holdterm deploys by hand from gene with the account-wide token (decision: keep doing
that). To automate it: Cloudflare → My Profile → API Tokens → Create token, account 967e13dd88bb23b24662e62cbb6fd84f,
permission Cloudflare Pages: Edit and nothing else; then GitHub → factordynamics/site → Settings → Secrets and
variables → Actions → New repository secret CLOUDFLARE_API_TOKEN. Pages-only matters because agents can push workflow
changes, so any token in the repo is usable by them.

## 5. Funnel tcp 8443 (root or a Tailscale operator; leave it on)

Decision: leave it on. Tailscale Funnel forwards public tcp://gene.tail70ba3.ts.net:8443 to localhost:22, where
nothing listens (checked Nov 19: no listener on port 22, and no Funnel or serve entry points anywhere else). Rule: nothing may
ever listen on gene's port 22. The tunnel watcher checks every minute and emails hello@ once when a listener appears
(site 08fbc0c). If one ever appears, stop it (root), or close the forward:

    sudo tailscale funnel --tcp=8443 off

Never run `tailscale set --operator=<user>` for the agents' account: agents must not control Funnel.

## 6. DNS sittings (registrar login; cancelled)

Cancelled with the Dec 5 api.factordynamics.com move: the API stays on copybook-api.factordynamics.workers.dev, and
gene's second way in stays the quick tunnel, never named in public assets. For the record: the registrar is
Squarespace Domains (RDAP), factordynamics.com expires 2027-11-25 (renewed Nov 11). The plan was sitting 1
(nameservers to Cloudflare, every record DNS-only, DNSSEC off, a test sign-in email) and sitting 2 (named tunnel
`gene-api` for api.factordynamics.com with CF_TUNNEL_TOKEN, R2 custom domain data.factordynamics.com). Nothing to do.

## 7. factordynamics.com and www → Copybook (Squarespace or Vercel login, about 15 minutes; open)

Why: the superapp plan sends the company's own name to the app. Today (checked Nov 19):
- `https://factordynamics.com/<path>` answers 307 → `https://www.factordynamics.com/<path>` (server: Vercel), and www
  serves an old web3 app from a Vercel project no agent can deploy.
- DNS is at Squarespace (registrar Squarespace Domains; nameservers ns-cloud-c1…c4.googledomains.com). Records: apex A
  216.198.79.1 (Vercel), www CNAME 606ea4ad487356fa.vercel-dns-017.com (Vercel), copybook CNAME
  factordynamics.github.io (the Copybook site, GitHub Pages; leave it alone).

Goal: both names answer 301 (or 308) to `https://copybook.factordynamics.com/` with the path kept, for example
`https://www.factordynamics.com/pricing/` → `https://copybook.factordynamics.com/pricing/`. Do one of the two, not both.

Option A, Squarespace domain forwarding (needs only the Squarespace login; preferred):
1. Squarespace → Domains → factordynamics.com → DNS (or "DNS settings").
2. Delete exactly two records: the `@` A record 216.198.79.1 and the `www` CNAME to …vercel-dns-017.com. Do not touch
   anything else: `copybook` CNAME, MX, TXT (SPF, DKIM, domain verifications) and any `resend`/`send` records carry
   the site and the sign-in and alert emails.
3. Domains → factordynamics.com → Domain forwarding → Add rule: subdomain `@`, destination
   `https://copybook.factordynamics.com`, redirect type Permanent (301), "Forward path" (or "Path forwarding") on.
   Save. Add a second rule the same way for subdomain `www`.
4. Squarespace provisions HTTPS for the forwarded names by itself; https can take a few hours to answer after http.

Option B, the Vercel project (needs the Vercel login of the account that owns the old app):
1. Vercel → that project → Settings → Domains. If "Edit" on factordynamics.com and www.factordynamics.com offers a
   redirect to `https://copybook.factordynamics.com` with 301 or 308, set it on both and stop. Vercel's domain
   redirect may only offer domains of the same project; if it does, Option A is the way.
2. If it doesn't, the old app's repository can serve the redirect: a `vercel.json` with
   `{"redirects":[{"source":"/:path*","destination":"https://copybook.factordynamics.com/:path*","permanent":true}]}`
   (permanent = 308), deployed to production. That needs the repository too.

Check (anyone, no login):

    for u in https://factordynamics.com/pricing/ https://www.factordynamics.com/pricing/ http://factordynamics.com/; do
      curl -sI -m 15 "$u" | grep -iE '^(HTTP|location)'; done

Pass: each says 301 or 308 with `location: https://copybook.factordynamics.com/pricing/` (or `/` for the last); and
`curl -sI https://copybook.factordynamics.com/` still says 200. Then tell the Copy product lead's thread. If the
Vercel project is no longer used for anything, remove both domains from it afterwards so it can't serve them again.

Later: if the zone ever moves to Cloudflare, this flips. The app moves to the apex and `copybook.factordynamics.com`
redirects to it. Nobody waits on this step.

## Ruled out (do not do)

- Throttling the other software's disk I/O (io.max, ionice) to help Copybook's p99: the lead ruled never.
- Anything listening on port 22; a Tailscale operator for agents.
