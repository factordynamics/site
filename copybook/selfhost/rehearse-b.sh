#!/usr/bin/env bash
# Path B rehearsal (RESTORE.md, Option B): rebuild the member API from scratch in a throwaway directory, as if gene's
# ~/copybook-api were gone, using only GitHub, R2 copybook-history, the nightly backup and Amp secrets. Times each step.
# Leaves the live service, its state and its ports alone; serves on 127.0.0.1:$RPORT with no cron and no tunnel.
#   rehearse-b.sh            (needs COPYBOOK_BACKUP_AGE_KEY, COPYBOOK_SESSION_SECRET, ... in the environment)
set -euo pipefail
export PATH=$HOME/.local/share/mise/installs/node/26.12.1/bin:$HOME/copybook-api/bin:$PATH WRANGLER_SEND_METRICS=false
R=${REHEARSAL_DIR:-$HOME/copybook-api-rehearsal}
RPORT=${RPORT:-8795}
rm -rf "$R"; mkdir -p "$R"; cd "$R"
T0=$(date +%s); last=$T0
step() { local now; now=$(date +%s); printf 'TIME %-28s %4ss  (total %ss)\n' "$1" $((now - last)) $((now - T0)) | tee -a "$R/times.txt"; last=$now; }
echo "start $(date -u +%FT%TZ)" > "$R/times.txt"
SPID=
# The scratch copy holds secrets and member data: keep only the timings and check results (KEEP=1 keeps it all).
LOG=$HOME/copybook-api/rehearsal-b-$(date -u +%Y%m%dT%H%MZ).log
mask() { sed -E 's/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+\.)/\1***@\2/g'; }
cleanup() {
  set +e  # never let a failed log copy skip deleting the scratch copy (it holds secrets)
  [ -n "$SPID" ] && { kill "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null; }
  cat "$R/times.txt" "$R/verify.txt" > "$LOG" 2>/dev/null; tail -20 "$R/server.log" 2>/dev/null | mask >> "$LOG"
  [ "${KEEP:-0}" = 1 ] || rm -rf "$R"
}
trap cleanup EXIT

# 1. Secrets from Amp personal secrets. Amp secrets created after the runner last started are not in its environment
#    yet; for those (and only those) fall back to gene's secrets.env and say so.
for pair in COPYBOOK_SESSION_SECRET:SESSION_SECRET COPYBOOK_STRIPE_WEBHOOK_SECRET:STRIPE_WEBHOOK_SECRET; do
  a=${pair%%:*}; b=${pair#*:}
  if [ -z "${!a:-}" ]; then
    export "$a=$(grep "^$b=" "$HOME/copybook-api/secrets.env" | cut -d= -f2-)"; echo "NOTE $a not in the runner env yet; used gene's copy" | tee -a "$R/times.txt"
  fi
done
umask 077
cat > secrets.env <<EOF
SESSION_SECRET=$COPYBOOK_SESSION_SECRET
STRIPE_WEBHOOK_SECRET=$COPYBOOK_STRIPE_WEBHOOK_SECRET
STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY
RESEND_API_KEY=$RESEND_API_KEY
HEALTH_TOKEN=$COPYBOOK_HEALTH_TOKEN
CF_API_TOKEN=$CLOUDFLARE_API_TOKEN
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN
EOF
printf '%s\n' "$COPYBOOK_BACKUP_AGE_KEY" > age.key
umask 022
step "1 secrets"

# 2. Code: sparse clone, install, build the bundle; runtime files from copybook/selfhost.
git clone -q --filter=blob:none --sparse https://github.com/factordynamics/site.git site
git -C site sparse-checkout set copybook holdterm/src .github
# Tool output goes to build.log; on failure its tail (masked) is printed.
fail() { echo "FAILED: $1"; tail -25 "$R/build.log" | mask; exit 1; }
(cd site/copybook/api && npx -y pnpm@10 install --frozen-lockfile) >> "$R/build.log" 2>&1 || fail "pnpm install"
(cd site/copybook/api && npx wrangler deploy --dry-run --outdir "$R/build") >> "$R/build.log" 2>&1 || fail "wrangler build"
cp -r site/copybook/selfhost ops
(cd ops && npm ci) >> "$R/build.log" 2>&1 || fail "npm ci in selfhost"
cat > copybook-api.env <<EOF
SITE_API_DIR=$R/site/copybook/api
BUILD_DIR=$R/build
STATE_DIR=$R/state
PORT=$RPORT
PUBLIC_API_URL=http://127.0.0.1:$RPORT/
PUBLIC_ORIGIN=http://127.0.0.1:$RPORT
CRON_FLAG=/nonexistent
EOF
step "2 clone+install+build"
set -a; . ./copybook-api.env; . ./secrets.env; set +a

# 3. R2: mirror copybook-history, then load it into the local store.
(cd ops && node r2-pull.mjs "$R/mirror" | grep -E '^(listed|DONE|FAIL)')
step "3a r2 pull"
(cd ops && node import.mjs r2 "$R/mirror" 2>&1 | tail -1)
step "3b r2 import"

# 4. KV and Durable Objects: newest nightly backup, then KV up to the minute from Cloudflare.
day=$(cd ops && node r2obj.mjs list backups/ | sort | tail -1 | sed -E 's|backups/([0-9-]+)\.tar\.age.*|\1|')
(cd ops && node r2obj.mjs get "backups/$day.tar.age" "$R/b.age" >/dev/null)
mkdir -p state; age -d -i age.key b.age | tar -C state -xzf -
echo "backup $day restored"
step "4a backup decrypt+untar"
(cd site/copybook/api && node scripts/kv-export.mjs "$R/kv.json" >/dev/null)
(cd ops && node import.mjs kv "$R/kv.json" 2>&1 | tail -1)
shred -u kv.json
step "4b kv overlay"

# 5. Start and verify (verify.mjs needs SESSION_SECRET, STRIPE_* from the env above).
(cd ops && exec node server.mjs > "$R/server.log" 2>&1) & SPID=$!
for _ in $(seq 120); do curl -sf -m 5 -o /dev/null "http://127.0.0.1:$RPORT/health" && break; sleep 1; done
step "5a boot to /health"
(cd ops && node verify.mjs "http://127.0.0.1:$RPORT") | tee "$R/verify.txt"
step "5b verify"
echo "verify: $(grep -c '^PASS' verify.txt) PASS, $(grep -c '^FAIL' verify.txt) FAIL"
du -sh state mirror | tr '\n' ' '; echo
