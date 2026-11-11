#!/usr/bin/env bash
# Step 1 of the agent-access package: run the Copybook API, its cron, deployer and backups as a dedicated `copybook`
# user, so the account Amp agents run as (refcell) cannot read member data at rest (KV, Durable Objects, local R2 copy,
# hourly backups) or the service-only secrets without sudo.
#
#   sudo ~/copybook-api/ops/setup-service-user.sh            # Andreas, once
#   DRY_RUN=1 ~/copybook-api/ops/setup-service-user.sh       # prints the commands, changes nothing
#
# What moves to copybook (home /var/lib/copybook, mode 0700; lingering systemd *user* units, so every script's
# `systemctl --user` keeps working unchanged): copybook-api.service, copybook-api-update.timer (watchdog, auto-deploy,
# encrypted hourly backups), copybook-api-backup.timer (nightly encrypted R2 backup), and the state, bundle, deployer
# checkout and full secrets.env (0600).
# What stays with refcell: gene's local proxy (forwards /copybook/ to 127.0.0.1:8787), Tailscale Funnel,
# copybook-tunnel and copybook-tunnel-watch. refcell's secrets.env shrinks to the two keys the watcher needs:
# CF_API_TOKEN (api.json) and RESEND_API_KEY (send-only).
# Safety: refcell's service is stopped (never two processes on one state dir), state is copied, the copy is started
# and health-checked, and only then are refcell's copies deleted. On a failed health check it rolls back.
#
# Not closed by this script (see the package a–f): agents can still push to main, which the deployer runs; the Cloudflare
# token in refcell's secrets.env and Amp secrets still reads Cloudflare's KV copy until Andreas narrows it; the session
# secret, backup age key and Stripe key are still Amp personal secrets until he deletes them there.
set -euo pipefail
SRC_USER=${SUDO_USER:-refcell}
SRC=/home/$SRC_USER/copybook-api
SVC=copybook
DST_HOME=/var/lib/copybook
DST=$DST_HOME/copybook-api
NODE_REL=.local/share/mise/installs/node/26.12.1
DRY=${DRY_RUN:-0}
run() { if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi; }
as_src() { run systemctl --user --machine="$SRC_USER@" "$@"; }
as_svc() { run systemctl --user --machine="$SVC@" "$@"; }
API_UNITS="copybook-api.service copybook-api-update.service copybook-api-update.timer copybook-api-backup.service copybook-api-backup.timer"

[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || { echo "run with sudo (or DRY_RUN=1)"; exit 1; }
[ -d "$SRC/state" ] || { echo "no $SRC/state: already migrated?"; exit 1; }

echo "== 1. user and home"
id "$SVC" >/dev/null 2>&1 || run useradd --system --home-dir "$DST_HOME" --shell /usr/bin/nologin --user-group "$SVC"
run install -d -o "$SVC" -g "$SVC" -m 0700 "$DST_HOME" "$DST" "$DST_HOME/.config" "$DST_HOME/.config/systemd" "$DST_HOME/.config/systemd/user"
run loginctl enable-linger "$SVC"
# Masked service logs stay readable to the operator account (journal only; no state or secrets).
run usermod -aG systemd-journal "$SRC_USER"

echo "== 2. stop refcell's API units (the tunnel, its watcher and the proxy keep running)"
as_src disable --now copybook-api-update.timer copybook-api-backup.timer
as_src stop copybook-api-update.service copybook-api-backup.service copybook-api.service

echo "== 3. copy runtime, state and secrets"
run install -d -o "$SVC" -g "$SVC" -m 0755 "$DST_HOME/.local" "$DST_HOME/.local/share" "$DST_HOME/.local/share/mise" "$DST_HOME/.local/share/mise/installs" "$DST_HOME/.local/share/mise/installs/node"
run cp -a "/home/$SRC_USER/$NODE_REL" "$DST_HOME/$NODE_REL"
for p in ops bin build build.prev site state backups backup.pub copybook-api.env secrets.env cron.enabled state.deployed-sha state.last-failed state.health-fails README.md; do
  [ -e "$SRC/$p" ] && run cp -a "$SRC/$p" "$DST/$p"
done
run sed -i "s|/home/$SRC_USER/|$DST_HOME/|g" "$DST/copybook-api.env"
for u in $API_UNITS; do run cp "/home/$SRC_USER/.config/systemd/user/$u" "$DST_HOME/.config/systemd/user/$u"; done
run chown -R "$SVC:$SVC" "$DST_HOME"
run chmod 0700 "$DST" "$DST/state" "$DST/backups"
run chmod 0600 "$DST/secrets.env"

echo "== 4. start as copybook and health-check"
for _ in $(seq 20); do [ "$DRY" = 1 ] || [ -d "/run/user/$(id -u "$SVC")" ] && break; sleep 1; done
as_svc daemon-reload
as_svc enable --now copybook-api.service copybook-api-update.timer copybook-api-backup.timer
ok=0
if [ "$DRY" = 1 ]; then ok=1; else
  for _ in $(seq 60); do curl -sf -m 5 -o /dev/null http://127.0.0.1:8787/health && { ok=1; break; }; sleep 2; done
fi
if [ $ok != 1 ]; then
  echo "!! copybook's API did not answer /health in 120 s; rolling back to refcell's units (its state is untouched)"
  as_svc disable --now copybook-api.service copybook-api-update.timer copybook-api-backup.timer
  as_src start copybook-api.service
  as_src enable --now copybook-api-update.timer copybook-api-backup.timer
  exit 1
fi
echo "copybook's API answers /health"

echo "== 5. remove refcell's copies of member data and service-only secrets"
as_src disable copybook-api.service
for u in $API_UNITS; do run rm -f "/home/$SRC_USER/.config/systemd/user/$u"; done
as_src daemon-reload
run rm -rf "$SRC/state" "$SRC/backups" "$SRC/build" "$SRC/build.prev" "$SRC/site" "$SRC/cron.enabled" "$SRC/state.deployed-sha" "$SRC/state.last-failed" "$SRC/state.health-fails" "$SRC/copybook-api.env"
# The tunnel watcher (refcell) needs only these two: api.json and the alert email.
if [ "$DRY" = 1 ]; then echo "+ rewrite $SRC/secrets.env to CF_API_TOKEN and RESEND_API_KEY only"; else
  grep -E '^(CF_API_TOKEN|RESEND_API_KEY)=' "$SRC/secrets.env" > "$SRC/secrets.env.new"
  chown "$SRC_USER:$SRC_USER" "$SRC/secrets.env.new"; chmod 600 "$SRC/secrets.env.new"; mv "$SRC/secrets.env.new" "$SRC/secrets.env"
fi

cat <<EOF
== done
Check:   curl -s http://127.0.0.1:8787/health; sudo ls -ld $DST/state   (refcell: ls $DST -> Permission denied)
Logs:    journalctl _UID=$(id -u "$SVC" 2>/dev/null || echo '<copybook uid>') -n 50   (refcell, after re-login for the systemd-journal group)
Next for Andreas (the rest of the package):
 - Amp settings: delete the personal secrets COPYBOOK_SESSION_SECRET, COPYBOOK_STRIPE_WEBHOOK_SECRET, COPYBOOK_BACKUP_AGE_KEY
   and the full STRIPE_SECRET_KEY after saving them offline; give agents a narrowed Cloudflare token and a restricted Stripe key.
 - Weekly restore check: put the age key in $DST/secrets.env as COPYBOOK_BACKUP_AGE_KEY and run restore-check.sh as copybook.
EOF
