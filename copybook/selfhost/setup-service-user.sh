#!/usr/bin/env bash
# Moves the Copybook API on gene to a dedicated `copybook` service user, so the account AI maintenance agents run as
# (refcell) cannot read member data, the service's secrets or the backup key, and is out of the member request path.
#
#   sudo OFFLINE_KEY=/run/media/<you>/<stick>/copybook-backup-key.age ~/copybook-api/ops/setup-service-user.sh
#   DRY_RUN=1 ~/copybook-api/ops/setup-service-user.sh       # prints the commands, changes nothing
#
# Read it before running it as root: it lives in a directory the agents can write. Compare it with the reviewed copy
# (sha256 in TUE17-STEPS.md) first.
#
# Moves to copybook (home /var/lib/copybook, 0700; lingering systemd user units): the API, its cron, the deployer
# (with a deploy gate: nothing from a new commit runs until Andreas approves its sha), the nightly and hourly backups,
# the hourly R2 push, the quick tunnel (now straight to the API, not through the maintainers' proxy) and its watcher,
# plus two new timers: status (masked view for maintainers) and checks (verify, backup restore drill).
# Makes a new backup key as copybook (0600); a passphrase-protected copy goes to OFFLINE_KEY for Andreas.
# Points Funnel's /copybook path straight at the API (Stripe's webhook arrives there).
# Maintainers keep: the front-end config updater, the in-flight sampler, and a read-only status directory
# /var/lib/copybook-status (counts, shas, unit states, masked logs, sessions for the comped test members).
# Safety: refcell's API is stopped before copybook's starts (never two processes on one state dir); state is copied;
# copybook's API must answer /health before refcell's copies are deleted, else everything rolls back.
set -euo pipefail
SRC_USER=${SUDO_USER:-refcell}
SRC=/home/$SRC_USER/copybook-api
SVC=copybook
DST_HOME=/var/lib/copybook
DST=$DST_HOME/copybook-api
STATUS=/var/lib/copybook-status
NODE_REL=.local/share/mise/installs/node/26.12.1
UNITS_SRC=/home/$SRC_USER/.config/systemd/user
UNITS_DST=$DST_HOME/.config/systemd/user
DRY=${DRY_RUN:-0}
run() { if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi; }
as_src() { run systemctl --user --machine="$SRC_USER@" "$@"; }
as_svc() { run systemctl --user --machine="$SVC@" "$@"; }
write() { if [ "$DRY" = 1 ]; then echo "+ write $1"; cat > /dev/null; else cat > "$1"; fi; }
MOVE_UNITS="copybook-api.service copybook-api-update.service copybook-api-update.timer copybook-api-backup.service
  copybook-api-backup.timer copybook-r2-push.service copybook-r2-push.timer copybook-tunnel.service
  copybook-tunnel-watch.service copybook-tunnel-watch.timer"
SVC_ENABLE="copybook-api.service copybook-tunnel.service copybook-api-update.timer copybook-api-backup.timer
  copybook-r2-push.timer copybook-tunnel-watch.timer copybook-status.timer copybook-checks-verify.timer copybook-checks-backup.timer"

[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || { echo "run with sudo (or DRY_RUN=1)"; exit 1; }
[ -d "$SRC/state" ] || { echo "no $SRC/state: already migrated?"; exit 1; }
[ -z "${OFFLINE_KEY:-}" ] || [ -d "$(dirname "$OFFLINE_KEY")" ] || { echo "OFFLINE_KEY directory missing (is the stick mounted?)"; exit 1; }
[ -n "${OFFLINE_KEY:-}" ] || echo "note: OFFLINE_KEY not set; the new backup key will exist only on the service account"

echo "== 1. user, home, status directory"
id "$SVC" >/dev/null 2>&1 || run useradd --system --home-dir "$DST_HOME" --shell /usr/bin/nologin --user-group "$SVC"
run install -d -o "$SVC" -g "$SVC" -m 0700 "$DST_HOME" "$DST"
run install -d -o "$SVC" -g "$SVC" -m 0755 "$DST_HOME/.config" "$DST_HOME/.config/systemd" "$UNITS_DST" "$STATUS"
run loginctl enable-linger "$SVC"

echo "== 2. stop refcell's Copybook units (members see ~1–2 minutes of errors; the tunnel URL changes)"
as_src disable --now copybook-api-update.timer copybook-api-backup.timer copybook-r2-push.timer copybook-tunnel-watch.timer
as_src stop copybook-api-update.service copybook-api-backup.service copybook-r2-push.service copybook-tunnel-watch.service copybook-api.service copybook-tunnel.service

echo "== 3. copy runtime, state and secrets"
run install -d -o "$SVC" -g "$SVC" -m 0755 "$DST_HOME/.local" "$DST_HOME/.local/share" "$DST_HOME/.local/share/mise" "$DST_HOME/.local/share/mise/installs" "$DST_HOME/.local/share/mise/installs/node"
run cp -a "/home/$SRC_USER/$NODE_REL" "$DST_HOME/$NODE_REL"
for p in ops bin build build.prev site state backups copybook-api.env secrets.env cron.enabled state.deployed-sha state.last-failed state.health-fails state.api-published README.md; do
  [ -e "$SRC/$p" ] && run cp -a "$SRC/$p" "$DST/$p"
done
run sed -i "s|/home/$SRC_USER/|$DST_HOME/|g" "$DST/copybook-api.env"
printf 'DEPLOY_APPROVAL=1\nSTATUS_DIR=%s\n' "$STATUS" | write "$DST/copybook-api.env.add"
run sh -c "cat '$DST/copybook-api.env.add' >> '$DST/copybook-api.env' && rm '$DST/copybook-api.env.add'"
# The running build is approved; later commits wait for Andreas.
run cp "$SRC/state.deployed-sha" "$DST/deploy.approved"
rm -f "$DST/state.tunnel-down-since" 2>/dev/null || true

echo "== 4. units"
for u in $MOVE_UNITS; do run cp "$UNITS_SRC/$u" "$UNITS_DST/$u"; done
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

echo "== 5. new backup key, held by the service user"
run cp -a "$SRC/backup.pub" "$DST/backup.pub.old"
run runuser -u "$SVC" -- sh -c "umask 077; '$DST/bin/age-keygen' -o '$DST/backup.key' 2>/dev/null"
if [ "$DRY" = 1 ]; then echo "+ backup.pub <- age-keygen -y backup.key"; else
  runuser -u "$SVC" -- "$DST/bin/age-keygen" -y "$DST/backup.key" > "$DST/backup.pub"; cp "$DST/backup.pub" "$STATUS/backup.pub"
  echo "new backup public key: $(cat "$DST/backup.pub")"
fi
if [ -n "${OFFLINE_KEY:-}" ]; then
  echo "Offline copy: choose a passphrase for $OFFLINE_KEY (age asks twice) and save it in 1Password."
  if [ "$DRY" = 1 ]; then echo "+ age -p -o $OFFLINE_KEY < backup.key"; else
    runuser -u "$SVC" -- cat "$DST/backup.key" | "$DST/bin/age" -p -o "$OFFLINE_KEY"
    [ "$(printf ok | "$DST/bin/age" -R "$DST/backup.pub" | "$DST/bin/age" -d -i "$OFFLINE_KEY")" = ok ] && echo "offline copy opens with your passphrase" || { echo "!! offline copy check failed"; exit 1; }
  fi
fi

echo "== 6. ownership and modes"
run chown -R "$SVC:$SVC" "$DST_HOME" "$STATUS"
run chmod 0700 "$DST_HOME" "$DST" "$DST/state" "$DST/backups"
run chmod 0600 "$DST/secrets.env" "$DST/backup.key"

echo "== 7. start as copybook and health-check"
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

echo "== 8. Funnel: /copybook straight to the API (Stripe's webhook), off the maintainers' proxy"
run tailscale funnel --bg --https=443 --set-path=/copybook http://127.0.0.1:8787
if [ "$DRY" != 1 ]; then
  sleep 3
  if curl -sf -m 20 -o /dev/null https://gene.tail70ba3.ts.net/copybook/health; then echo "Funnel /copybook answers"
  else echo "!! Funnel /copybook does not answer; removing the path handler (the old route through the proxy stays)"; tailscale funnel --https=443 --set-path=/copybook off || true; fi
fi

echo "== 9. remove refcell's copies of member data and service secrets; maintainers' units"
for u in $MOVE_UNITS; do run rm -f "$UNITS_SRC/$u"; done
printf '[Unit]\nDescription=Copybook front-end configs follow the API base (%s/api-published)\n\n[Service]\nType=oneshot\nEnvironment=FE_ONLY=1 STATUS_DIR=%s\nExecStart=%%h/copybook-api/ops/tunnel-watch.sh\n' "$STATUS" "$STATUS" | write "$UNITS_SRC/copybook-fe-config.service"
printf '[Unit]\nDescription=Copybook front-end config follower, every 2 minutes\n\n[Timer]\nOnCalendar=*:0/2\n\n[Install]\nWantedBy=timers.target\n' | write "$UNITS_SRC/copybook-fe-config.timer"
run chown "$SRC_USER:$SRC_USER" "$UNITS_SRC/copybook-fe-config.service" "$UNITS_SRC/copybook-fe-config.timer"
as_src daemon-reload
as_src enable --now copybook-fe-config.timer
run rm -rf "$SRC/state" "$SRC/backups" "$SRC/build" "$SRC/build.prev" "$SRC/site" "$SRC/migrate" "$SRC/cron.enabled" \
  "$SRC/state.deployed-sha" "$SRC/state.last-failed" "$SRC/state.health-fails" "$SRC/state.api-published" "$SRC/state.pending" \
  "$SRC/state.tunnel-down-since" "$SRC/copybook-api.env" "$SRC/backup.pub" "$SRC/backup.pub.old" "$SRC/backup.pub.new"
# The in-flight sampler's alert email is all the maintainers' account still sends.
if [ "$DRY" = 1 ]; then echo "+ rewrite $SRC/secrets.env to RESEND_API_KEY only"; else
  grep -E '^RESEND_API_KEY=' "$SRC/secrets.env" > "$SRC/secrets.env.new" || true
  chown "$SRC_USER:$SRC_USER" "$SRC/secrets.env.new"; chmod 600 "$SRC/secrets.env.new"; mv "$SRC/secrets.env.new" "$SRC/secrets.env"
fi

cat <<EOF
== done
Next (TUE17-STEPS.md): the agent re-encrypts the R2 backups to the new key; then Andreas removes the Amp secrets,
narrows the Cloudflare token and the Stripe key, rotates SESSION_SECRET, restarts the Amp runner; then the agent runs
~/copybook-api/ops/acceptance-test.sh.
Approve a deploy:  echo <full sha> | sudo -u copybook tee -a $DST/deploy.approved
Status for agents: $STATUS
EOF
