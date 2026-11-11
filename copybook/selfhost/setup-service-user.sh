#!/usr/bin/env bash
# Moves the Copybook API on gene to a dedicated `copybook` service user, so the account AI maintenance agents run as
# (refcell) cannot read member data, the service's secrets (including the token-signing secrets) or the backup key, and
# is out of the member request path.
#
#   sudo OFFLINE_KEY=/run/media/<you>/<stick>/copybook-backup-key.age ~/copybook-api/ops/setup-service-user.sh
#   DRY_RUN=1 ~/copybook-api/ops/setup-service-user.sh       # checks the pins, prints the commands, changes nothing
#
# Read it before running it as root: it lives in a directory the agents can write. Compare its sha256 with the reviewed
# copy first (TUE17-STEPS.md). That one check covers everything else that will run as copybook, because nothing that
# runs there is copied from the agents' account:
#  - node comes from nodejs.org and must match NODE_SHA256; age, age-keygen and cloudflared must match their pins
#    (the upstream release binaries);
#  - the scripts and units (copybook/selfhost) come from a fresh clone of factordynamics/site and must match
#    SELFHOST_CODE_SHA256; their npm dependencies install from the lockfile;
#  - the API is rebuilt as copybook from the deployed commit, from a fresh clone (no hooks or config from the old
#    checkout), and must boot on a scratch port before anything stops;
#  - copybook-api.env is written here; secrets.env keeps only known keys with plain values (it is sourced by shell).
# Only data is copied: the state (KV, Durable Objects, local R2 copy) and the encrypted hourly backups.
#
# Moves to copybook (home /var/lib/copybook, 0700; lingering systemd user units): the API, its cron, the deployer
# (any commit on main that boots deploys, as today, logged with its build; per-deploy approval exists but is off:
# DEPLOY_REQUIRE_APPROVAL=0 in copybook-api.env), the nightly and hourly backups,
# the hourly R2 push, the quick tunnel (now straight to the API, not through the maintainers' proxy) and its watcher,
# plus two new timers: status (masked view for maintainers) and checks (verify, backup restore drill).
# Makes a new backup key as copybook (0600); a passphrase-protected copy goes to OFFLINE_KEY for Andreas.
# Points Funnel's /copybook path straight at the API (Stripe's webhook arrives there).
# Maintainers keep: the front-end config updater, the in-flight sampler, and a read-only status directory
# /var/lib/copybook-status (counts, shas, unit states, masked logs, sessions for the comped test members).
# Safety: everything up to the boot test happens while refcell's API keeps serving; a failed pin, clone, build or boot
# stops here with nothing stopped. refcell's API is stopped before copybook's starts (never two processes on one state
# dir); state is copied; copybook's API must answer /health before refcell's copies are deleted, else it rolls back.
set -euo pipefail
cd /
SRC_USER=${SUDO_USER:-refcell}
SRC=/home/$SRC_USER/copybook-api
SVC=copybook
DST_HOME=/var/lib/copybook
DST=$DST_HOME/copybook-api
STATUS=/var/lib/copybook-status
REPO=https://github.com/factordynamics/site.git
NODE_VER=26.12.1
NODE_REL=.local/share/mise/installs/node/$NODE_VER
UNITS_SRC=/home/$SRC_USER/.config/systemd/user
UNITS_DST=$DST_HOME/.config/systemd/user
DRY=${DRY_RUN:-0}
# Pins (checked Nov 11 against the upstream downloads).
NODE_SHA256=6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd     # node-v26.12.1-linux-x64.tar.xz (nodejs.org SHASUMS256.txt)
AGE_SHA256=eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c      # age v1.3.2 linux-amd64 (github.com/FiloSottile/age)
AGE_KEYGEN_SHA256=0a0009db842259d6717f7eeb30acb6b90d2a2eb924c6acd0a0db0ca1f1537899
CLOUDFLARED_SHA256=1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872 # cloudflared 2026.10.7 linux-amd64 (github.com/cloudflare/cloudflared)
# sha256 of `git ls-tree -r <commit> -- copybook/selfhost` without *.md, backup.pub and this script (code_hash below).
SELFHOST_CODE_SHA256=078b1717f67c7de42229b9e6146df74acc63ec09cf6306c8b3da591aac76a709
SECRET_KEYS='SESSION_SECRET|STRIPE_WEBHOOK_SECRET|STRIPE_SECRET_KEY|RESEND_API_KEY|HEALTH_TOKEN|CLOUDFLARE_API_TOKEN|CF_API_TOKEN'

run() { if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi; }
svc() { run runuser -u "$SVC" -- env -i HOME="$DST_HOME" PATH="$DST_HOME/$NODE_REL/bin:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 "$@"; }
as_src() { run systemctl --user --machine="$SRC_USER@" "$@"; }
as_svc() { run systemctl --user --machine="$SVC@" "$@"; }
write() { if [ "$DRY" = 1 ]; then echo "+ write $1"; cat > /dev/null; else cat > "$1"; fi; }
die() { echo "!! $*"; exit 1; }
sha() { sha256sum < "$1" | cut -c1-64; }
pin() { [ "$(sha "$1")" = "$2" ] || die "$1 does not match its pinned sha256; stopping"; }
code_hash() { git -C "$1" ls-tree -r "$2" -- copybook/selfhost | grep -vE $'\t''copybook/selfhost/(.*\.md|backup\.pub|setup-service-user\.sh)$' | sha256sum | cut -c1-64; }
MOVE_UNITS="copybook-api.service copybook-api-update.service copybook-api-update.timer copybook-api-backup.service
  copybook-api-backup.timer copybook-r2-push.service copybook-r2-push.timer copybook-tunnel.service
  copybook-tunnel-watch.service copybook-tunnel-watch.timer"
SVC_ENABLE="copybook-api.service copybook-tunnel.service copybook-api-update.timer copybook-api-backup.timer
  copybook-r2-push.timer copybook-tunnel-watch.timer copybook-status.timer copybook-checks-verify.timer copybook-checks-backup.timer"

echo "== 0. checks (nothing changes yet)"
[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "run with sudo (or DRY_RUN=1)"
[ -d "$SRC/state" ] || die "no $SRC/state: already migrated?"
[ -z "${OFFLINE_KEY:-}" ] || [ -d "$(dirname "$OFFLINE_KEY")" ] || die "OFFLINE_KEY directory missing (is the stick mounted?)"
[ -n "${OFFLINE_KEY:-}" ] || echo "note: OFFLINE_KEY not set; the new backup key will exist only on the service account"
BASE=$(cat "$SRC/state.deployed-sha"); [[ $BASE =~ ^[0-9a-f]{40}$ ]] || die "state.deployed-sha is not a commit sha"
url() { sed -n -E "s#^$1=(https://[A-Za-z0-9./:_-]+)\$#\\1#p" "$SRC/copybook-api.env" | head -1; }
PUB_API=$(url PUBLIC_API_URL); PUB_ORIGIN=$(url PUBLIC_ORIGIN)
[ -n "$PUB_API" ] && [ -n "$PUB_ORIGIN" ] || die "PUBLIC_API_URL or PUBLIC_ORIGIN missing or not a plain https URL"
API_PUBLISHED=$(grep -xE 'https://[A-Za-z0-9./:_-]+' "$SRC/state.api-published" 2>/dev/null || true)
OLD_PUB=$(grep -xE 'age1[a-z0-9]+' "$SRC/backup.pub") || die "backup.pub is not an age public key"
pin "$SRC/bin/age" "$AGE_SHA256"; pin "$SRC/bin/age-keygen" "$AGE_KEYGEN_SHA256"; pin "$SRC/bin/cloudflared" "$CLOUDFLARED_SHA256"
n_all=$(grep -c . "$SRC/secrets.env"); n_ok=$(grep -cE "^($SECRET_KEYS)=[A-Za-z0-9_+/=.:-]+\$" "$SRC/secrets.env" || true)
for k in SESSION_SECRET STRIPE_WEBHOOK_SECRET STRIPE_SECRET_KEY HEALTH_TOKEN CF_API_TOKEN; do
  grep -qE "^$k=[A-Za-z0-9_+/=.:-]+\$" "$SRC/secrets.env" || die "secrets.env: $k missing or not a plain value"
done
echo "secrets.env: $n_ok of $n_all lines pass the allow-list (names and characters); only those are copied"
[ -z "$(find "$SRC/state" "$SRC/backups" ! -type f ! -type d | head -1)" ] || die "state or backups contain links or special files"
if [ "$DRY" = 1 ]; then
  t=$(mktemp -d); git clone -q --no-checkout "$REPO" "$t/site"
  h=$(code_hash "$t/site" origin/main); rm -rf "$t"
  [ "$h" = "$SELFHOST_CODE_SHA256" ] && echo "selfhost code on origin/main matches the pin" || echo "!! selfhost code on origin/main is $h, not the pin"
fi

echo "== 1. user, home, status directory"
id "$SVC" >/dev/null 2>&1 || run useradd --system --home-dir "$DST_HOME" --shell /usr/bin/nologin --user-group "$SVC"
run install -d -o "$SVC" -g "$SVC" -m 0700 "$DST_HOME" "$DST"
# A run that stopped at a check left code here and nothing else (refcell's state is still at $SRC): start clean.
run rm -rf "$DST/site" "$DST/build" "$DST/ops" "$DST/bin" "$DST/secrets.env" "$DST/copybook-api.env"
run install -d -o "$SVC" -g "$SVC" -m 0755 "$DST/ops" "$DST/bin" "$DST_HOME/.config" "$DST_HOME/.config/systemd" "$UNITS_DST" "$STATUS" \
  "$DST_HOME/.local" "$DST_HOME/.local/share" "$DST_HOME/.local/share/mise" "$DST_HOME/.local/share/mise/installs" "$DST_HOME/$NODE_REL"
run loginctl enable-linger "$SVC"

echo "== 2. runtime and code from verified sources (refcell's API keeps serving)"
if [ "$DRY" = 1 ]; then echo "+ node $NODE_VER from nodejs.org, sha256 $NODE_SHA256 -> $DST_HOME/$NODE_REL"; else
  t=$(mktemp -d); curl -fsSL -o "$t/node.tar.xz" "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.xz"
  pin "$t/node.tar.xz" "$NODE_SHA256"
  tar -xJf "$t/node.tar.xz" --strip-components=1 --no-same-owner -C "$DST_HOME/$NODE_REL"; rm -rf "$t"
  chown -R "$SVC:$SVC" "$DST_HOME/$NODE_REL"
fi
for b in age age-keygen cloudflared; do run install -o "$SVC" -g "$SVC" -m 0755 "$SRC/bin/$b" "$DST/bin/$b"; done
if [ "$DRY" != 1 ]; then pin "$DST/bin/age" "$AGE_SHA256"; pin "$DST/bin/age-keygen" "$AGE_KEYGEN_SHA256"; pin "$DST/bin/cloudflared" "$CLOUDFLARED_SHA256"; fi
svc git clone -q "$REPO" "$DST/site"
svc git -C "$DST/site" merge-base --is-ancestor "$BASE" origin/main || die "deployed commit $BASE is not on origin/main"
svc git -C "$DST/site" reset -q --hard "$BASE"
if [ "$DRY" != 1 ]; then
  h=$(runuser -u "$SVC" -- env -i HOME="$DST_HOME" PATH=/usr/bin:/bin bash -c "$(declare -f code_hash); code_hash '$DST/site' origin/main")
  [ "$h" = "$SELFHOST_CODE_SHA256" ] || die "copybook/selfhost code on origin/main ($h) does not match the reviewed pin; stopping"
fi
svc sh -c "git -C '$DST/site' archive origin/main copybook/selfhost | tar -x --strip-components=2 -C '$DST/ops'"
svc sh -c "cd '$DST/ops' && npm ci --no-audit --no-fund > '$DST/last-ops-install.log' 2>&1"
write "$DST/copybook-api.env" <<EOF
SITE_API_DIR=$DST/site/copybook/api
BUILD_DIR=$DST/build
STATE_DIR=$DST/state
PORT=8787
PUBLIC_API_URL=$PUB_API
PUBLIC_ORIGIN=$PUB_ORIGIN
CRON_FLAG=$DST/cron.enabled
DEPLOY_REQUIRE_APPROVAL=0
STATUS_DIR=$STATUS
EOF
if [ "$DRY" = 1 ]; then echo "+ secrets.env <- the $n_ok allow-listed lines (0600)"; else
  (umask 077; grep -E "^($SECRET_KEYS)=[A-Za-z0-9_+/=.:-]+\$" "$SRC/secrets.env" > "$DST/secrets.env")
fi
run chown "$SVC:$SVC" "$DST/copybook-api.env" "$DST/secrets.env"
run chmod 0600 "$DST/secrets.env"
echo "building the deployed commit ${BASE:0:7} as $SVC (a few minutes)"
svc sh -c "cd '$DST/site/copybook/api' && npx -y pnpm@10 install --frozen-lockfile > '$DST/last-install.log' 2>&1 && WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir '$DST/build' > '$DST/last-build.log' 2>&1 && echo '$BASE' > '$DST/build/BUILD_SHA'" \
  || die "build failed (see $DST/last-install.log, last-build.log); nothing was stopped"
# Boot test on a scratch port with throwaway state, as update.sh does before every deploy.
svc sh -c "cd '$DST/ops' && set -a && . ../copybook-api.env && . ../secrets.env && set +a && s=\$(mktemp -d) &&
  { BUILD_DIR='$DST/build' STATE_DIR=\$s PORT=8792 CRON_FLAG=/nonexistent timeout 90 node server.mjs > '$DST/last-smoke.log' 2>&1 & p=\$!;
    ok=1; for i in \$(seq 60); do sleep 1; curl -sf -m 3 -o /dev/null http://127.0.0.1:8792/health && { ok=0; break; }; done
    kill \$p; wait \$p; rm -rf \$s; exit \$ok; }" \
  || die "the rebuilt API did not boot on port 8792 (see $DST/last-smoke.log); nothing was stopped"
echo "rebuilt API boots"

echo "== 3. stop refcell's Copybook units (members see ~1–2 minutes of errors; the tunnel URL changes)"
as_src disable --now copybook-api-update.timer copybook-api-backup.timer copybook-r2-push.timer copybook-tunnel-watch.timer
as_src stop copybook-api-update.service copybook-api-backup.service copybook-r2-push.service copybook-tunnel-watch.service copybook-api.service copybook-tunnel.service

echo "== 4. copy data (state, encrypted backups) and flags"
run cp -a "$SRC/state" "$DST/state"
run cp -a "$SRC/backups" "$DST/backups"
[ -e "$SRC/cron.enabled" ] && run touch "$DST/cron.enabled"
for f in state.deployed-sha deploy.approved; do echo "$BASE" | write "$DST/$f"; done
[ -n "$API_PUBLISHED" ] && echo "$API_PUBLISHED" | write "$DST/state.api-published"
echo "$OLD_PUB" | write "$DST/backup.pub.old"

echo "== 5. units (from the verified copybook/selfhost/systemd)"
for u in $MOVE_UNITS; do run install -o "$SVC" -g "$SVC" -m 0644 "$DST/ops/systemd/$u" "$UNITS_DST/$u"; done
# The tunnel goes straight to the API (server.mjs accepts the /copybook prefix), not through the maintainers' proxy.
run sed -i -E 's|--url http://127\.0\.0\.1:[0-9]+|--url http://127.0.0.1:8787|' "$UNITS_DST/copybook-tunnel.service"
run sed -i "s|^ExecStart=|Environment=NO_FE=1 STATUS_DIR=$STATUS\nExecStart=|" "$UNITS_DST/copybook-tunnel-watch.service"
unit() { # name, description, exec (relative to ops/), [timer OnCalendar]
  printf '[Unit]\nDescription=%s\n\n[Service]\nType=oneshot\nEnvironment=STATUS_DIR=%s\nExecStart=%%h/copybook-api/ops/%s\n' "$2" "$STATUS" "$3" | write "$UNITS_DST/$1.service"
  printf '[Unit]\nDescription=%s\n\n[Timer]\nOnCalendar=%s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' "$2" "$4" | write "$UNITS_DST/$1.timer"
}
unit copybook-status "Copybook masked status for maintainers ($STATUS)" status.sh '*:0/5'
unit copybook-checks-verify "Copybook end-to-end checks (test members) -> $STATUS/verify.txt" 'checks.sh verify' '*-*-* 0/6:45:00'
unit copybook-checks-backup "Copybook backup checks and decrypt drill -> $STATUS/backup-checks.log" 'checks.sh backup' 'Mon *-*-* 11:30:00 UTC'

echo "== 6. new backup key, held by the service user"
run runuser -u "$SVC" -- sh -c "umask 077; '$DST/bin/age-keygen' -o '$DST/backup.key' 2>/dev/null"
if [ "$DRY" = 1 ]; then echo "+ backup.pub <- age-keygen -y backup.key"; else
  runuser -u "$SVC" -- "$DST/bin/age-keygen" -y "$DST/backup.key" > "$DST/backup.pub"; cp "$DST/backup.pub" "$STATUS/backup.pub"
  echo "new backup public key: $(cat "$DST/backup.pub")"
fi
if [ -n "${OFFLINE_KEY:-}" ]; then
  echo "Offline copy: choose a passphrase for $OFFLINE_KEY (age asks twice) and save it in 1Password."
  if [ "$DRY" = 1 ]; then echo "+ age -p -o $OFFLINE_KEY < backup.key"; else
    runuser -u "$SVC" -- cat "$DST/backup.key" | "$DST/bin/age" -p -o "$OFFLINE_KEY"
    [ "$(printf ok | "$DST/bin/age" -R "$DST/backup.pub" | "$DST/bin/age" -d -i "$OFFLINE_KEY")" = ok ] && echo "offline copy opens with your passphrase" || die "offline copy check failed"
  fi
fi

echo "== 7. ownership and modes"
run chown -R -h "$SVC:$SVC" "$DST_HOME" "$STATUS"
run chmod 0700 "$DST_HOME" "$DST" "$DST/state" "$DST/backups"
run chmod 0600 "$DST/secrets.env" "$DST/backup.key"

echo "== 8. start as copybook and health-check"
for _ in $(seq 20); do [ "$DRY" = 1 ] || [ -d "/run/user/$(id -u "$SVC")" ] && break; sleep 1; done
as_svc daemon-reload
as_svc enable --now $SVC_ENABLE
ok=0
if [ "$DRY" = 1 ]; then ok=1; else
  for _ in $(seq 60); do curl -sf -m 5 -o /dev/null http://127.0.0.1:8787/health && { ok=1; break; }; sleep 2; done
fi
if [ $ok != 1 ]; then
  echo "!! copybook's API did not answer /health in 120 s; rolling back to refcell's units (refcell's state is untouched)"
  as_svc disable --now $SVC_ENABLE
  as_src start copybook-api.service copybook-tunnel.service
  as_src enable --now copybook-api-update.timer copybook-api-backup.timer copybook-r2-push.timer copybook-tunnel-watch.timer
  exit 1
fi
echo "copybook's API answers /health"
as_svc start copybook-status.service copybook-tunnel-watch.service || true

echo "== 9. Funnel: /copybook straight to the API (Stripe's webhook), off the maintainers' proxy"
run tailscale funnel --bg --https=443 --set-path=/copybook http://127.0.0.1:8787
if [ "$DRY" != 1 ]; then
  sleep 3
  if curl -sf -m 20 -o /dev/null https://gene.tail70ba3.ts.net/copybook/health; then echo "Funnel /copybook answers"
  else echo "!! Funnel /copybook does not answer; removing the path handler (the old route through the proxy stays)"; tailscale funnel --https=443 --set-path=/copybook off || true; fi
fi

echo "== 10. remove refcell's copies of member data and service secrets; maintainers' units"
for u in $MOVE_UNITS; do run rm -f "$UNITS_SRC/$u"; done
printf '[Unit]\nDescription=Copybook front-end configs follow the API base (%s/api-published)\n\n[Service]\nType=oneshot\nEnvironment=FE_ONLY=1 STATUS_DIR=%s\nExecStart=%%h/copybook-api/ops/tunnel-watch.sh\n' "$STATUS" "$STATUS" | write "$UNITS_SRC/copybook-fe-config.service"
printf '[Unit]\nDescription=Copybook front-end config follower, every 2 minutes\n\n[Timer]\nOnCalendar=*:0/2\n\n[Install]\nWantedBy=timers.target\n' | write "$UNITS_SRC/copybook-fe-config.timer"
run chown "$SRC_USER:$SRC_USER" "$UNITS_SRC/copybook-fe-config.service" "$UNITS_SRC/copybook-fe-config.timer"
as_src daemon-reload
as_src enable --now copybook-fe-config.timer
run rm -rf "$SRC/state" "$SRC/backups" "$SRC/build" "$SRC/build.prev" "$SRC/build.new" "$SRC/site" "$SRC/migrate" "$SRC/cron.enabled" \
  "$SRC/state.deployed-sha" "$SRC/state.last-failed" "$SRC/state.health-fails" "$SRC/state.api-published" "$SRC/state.pending" \
  "$SRC/state.tunnel-down-since" "$SRC/copybook-api.env" "$SRC/backup.pub" "$SRC/backup.pub.old" "$SRC/backup.pub.new"
# The in-flight sampler's alert email is all the maintainers' account still sends.
if [ "$DRY" = 1 ]; then echo "+ rewrite $SRC/secrets.env to RESEND_API_KEY only"; else
  grep -E '^RESEND_API_KEY=' "$SRC/secrets.env" > "$SRC/secrets.env.new" || true
  chown "$SRC_USER:$SRC_USER" "$SRC/secrets.env.new"; chmod 600 "$SRC/secrets.env.new"; mv "$SRC/secrets.env.new" "$SRC/secrets.env"
fi

cat <<EOF
== done
Next (TUE17-STEPS.md): the agent re-encrypts the R2 backups to the new key; then Andreas rotates the signing secrets,
removes the agents' credentials and account passwords, restarts the Amp runner; then the agent runs
~/copybook-api/ops/acceptance-test.sh.
Deploys: any commit on main that passes the boot test deploys (log: $STATUS/deploys.log). To require per-deploy
approval, set DEPLOY_REQUIRE_APPROVAL=1 in $DST/copybook-api.env (sudo), then approve with
  echo <full sha> | sudo -u copybook tee -a $DST/deploy.approved
Status for agents: $STATUS
EOF
