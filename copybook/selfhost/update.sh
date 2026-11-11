#!/usr/bin/env bash
# Runs every 2 minutes (copybook-api-update.timer):
#  1. Watchdog: restarts copybook-api.service when /health fails twice in a row.
#  2. Deploy: when origin/main changes copybook/api, pulls, runs the tests, rebuilds the bundle and restarts.
#     A failing test or build keeps the running version and logs why; the next commit is tried again.
set -uo pipefail
ROOT=$HOME/copybook-api
SITE=$ROOT/site
API=$SITE/copybook/api
export PATH=$HOME/.local/share/mise/installs/node/26.12.1/bin:$PATH WRANGLER_SEND_METRICS=false

fails_file=$ROOT/state.health-fails
if systemctl --user is-active -q copybook-api.service; then
  # ?probe=1: up, boot time and build, from local state only. Plain /health also fetches status.json from r2.dev
  # (~0.3 s since 4ecebb7), so a slow internet link would read as a hung API.
  if curl -sf -m 10 -o /dev/null 'http://127.0.0.1:8787/health?probe=1'; then
    echo 0 > "$fails_file"
  else
    n=$(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 ))
    echo $n > "$fails_file"
    echo "health check failed ($n)"
    # When the disk is saturated (I/O pressure "full" avg60 >= 40%, e.g. other software on the same machine writing heavily, Nov 9),
    # a restart doesn't help and drops in-flight uploads: wait up to 5 failures (~10 min) before restarting anyway.
    io=$(awk '/^full/{split($3,a,"=");print int(a[2])}' /proc/pressure/io 2>/dev/null || echo 0)
    if [ "$n" -ge 2 ] && { [ "${io:-0}" -lt 40 ] || [ "$n" -ge 5 ]; }; then echo "restarting copybook-api.service (io full avg60 ${io}%)"; systemctl --user restart copybook-api.service; echo 0 > "$fails_file"
    elif [ "$n" -ge 2 ]; then echo "not restarting yet: disk saturated (io full avg60 ${io}%)"; fi
  fi
fi

# Hourly backup of KV and Durable Objects (members, sessions, follows; ~2 MB), last 48 kept, age-encrypted to
# ../backup.pub like the nightly R2 backup: plaintext never touches the disk (tar streams straight into age), and the
# private key is not on gene (Amp secret COPYBOOK_BACKUP_AGE_KEY). Restore: age -d -i <key> f.tar.age | tar -xzf -.
# R2 is not backed up here: Cloudflare still has the bucket and ingest can re-upload.
mkdir -p "$ROOT/backups"
if [ -z "$(find "$ROOT/backups" -name 'state-*.tar.age' -mmin -60 | head -1)" ]; then
  out="$ROOT/backups/state-$(date -u +%Y%m%dT%H%MZ).tar.age"
  # tar exits 1 when a live SQLite file changes while read; the copy is still usable, as before.
  if (umask 077; (tar -czf - -C "$ROOT/state" kv do 2>/dev/null; [ $? -le 1 ]) | "$ROOT/bin/age" -R "$ROOT/backup.pub" -o "$out.tmp"); then
    mv "$out.tmp" "$out"
  else rm -f "$out.tmp"; echo "hourly backup failed"; fi
  ls -1t "$ROOT"/backups/state-*.tar.age | tail -n +49 | xargs -r rm -f
fi

cd "$SITE" || exit 1
git fetch -q origin main || { echo "git fetch failed"; exit 0; }
# Compare with the commit whose bundle is running (state.deployed-sha), not the checkout's HEAD: a pull or commit made
# in this checkout must not hide an undeployed change.
cur=$(cat "$ROOT/state.deployed-sha" 2>/dev/null || git rev-parse HEAD)
new=$(git rev-parse origin/main)
[ "$cur" = "$new" ] && exit 0
# The bundle is built from copybook/api and imports holdterm/src (names): both count as API changes.
if git diff --quiet "$cur" "$new" -- copybook/api holdterm/src; then
  git merge -q --ff-only origin/main 2>/dev/null; echo "$new" > "$ROOT/state.deployed-sha"; exit 0
fi
tried=$(cat "$ROOT/state.last-failed" 2>/dev/null || true)
[ "$tried" = "$new" ] && exit 0
# Optional deploy gate, off by default: any commit on main that passes the tests, the build and the boot test deploys.
# With DEPLOY_REQUIRE_APPROVAL=1 (in copybook-api.env, for a future tier that holds more sensitive data) nothing from a
# new commit runs here (pnpm install, vitest, build, boot) until Andreas approves its sha.
# Approve (reviewing `git diff <deployed>..<sha> -- copybook/api holdterm/src` first):
#   echo <full sha> | sudo -u copybook tee -a /var/lib/copybook/copybook-api/deploy.approved
# Approving a sha approves everything up to it. The pending sha and its diffstat go to the status directory.
if [ "${DEPLOY_REQUIRE_APPROVAL:-0}" = 1 ] && ! grep -qx "$new" "$ROOT/deploy.approved" 2>/dev/null; then
  if [ "$(cat "$ROOT/state.pending" 2>/dev/null)" != "$new" ]; then
    echo "$new" > "$ROOT/state.pending"
    echo "awaiting deploy approval: $(git log -1 --format='%h %s' "$new" | cut -c1-100)"
    [ -n "${STATUS_DIR:-}" ] && { echo "pending $new (deployed $cur)"; git diff --stat "$cur" "$new" -- copybook/api holdterm/src | tail -25; } > "$STATUS_DIR/deploy-pending.txt"
  fi
  exit 0
fi
rm -f "${STATUS_DIR:-/nonexistent}/deploy-pending.txt"

# Restart policy (lead, Nov 11). Only deploy restarts count; the watchdog above still restarts an API that fails health.
#  - Freeze windows (UTC): payments' heartbeat drill Wed 11 16:00–16:30, then Thu 12, Fri 13 and Mon 16 11:00–03:00:
#    no deploy restart.
#  - Between those windows, from Thu 12 11:00 to Tue 17 03:00: at most one (batched) deploy restart per gap.
#  - Otherwise: at most one deploy restart per hour; commits that land meanwhile go out together at the next slot.
#  - A head commit whose subject line starts with [P0] goes out at once, whatever the time. (Not "anywhere in the
#    message": 8873bf4, the commit that documents this policy, mentions "[P0] overrides" and went out at once.)
# A build whose bundle equals the running one restarts nothing and uses no slot (see below).
RESTARTS=$ROOT/state.deploy-restarts   # epoch, sha of each deploy restart
FREEZE="2026-11-11T16:00Z 2026-11-11T16:30Z 2026-11-12T11:00Z 2026-11-13T03:00Z 2026-11-13T11:00Z 2026-11-14T03:00Z 2026-11-16T11:00Z 2026-11-17T03:00Z"
hold_reason() { # now, last deploy restart (epoch) -> prints why a deploy restart must wait, or nothing
  local now=$1 last=$2 gap_start=0 a b
  set -- $FREEZE
  while [ $# -ge 2 ]; do
    a=$(date -ud "$1" +%s); b=$(date -ud "$2" +%s); shift 2
    if [ "$now" -ge "$a" ] && [ "$now" -lt "$b" ]; then echo "freeze window until $(date -ud @"$b" +%FT%H:%MZ)"; return; fi
    [ "$now" -ge "$b" ] && [ "$a" -ge "$(date -ud 2026-11-12T11:00Z +%s)" ] && gap_start=$b
  done
  local fs=$(date -ud 2026-11-12T11:00Z +%s) fe=$(date -ud 2026-11-17T03:00Z +%s)
  if [ "$now" -ge "$fs" ] && [ "$now" -lt "$fe" ]; then
    [ "$gap_start" = 0 ] && gap_start=$fs
    [ "$last" -ge "$gap_start" ] && echo "one batched restart between freeze windows already used ($(date -ud @"$last" +%FT%H:%MZ))"
    return
  fi
  [ $((now - last)) -lt 3600 ] && echo "hourly batching: next slot $(date -ud @$((last + 3600)) +%FT%H:%MZ)"
}
last=$(tail -1 "$RESTARTS" 2>/dev/null | cut -f1); why=$(hold_reason "$(date +%s)" "${last:-0}")
# Operator override for one urgent deploy outside the hourly slot (not inside a freeze window; use [P0] there):
#   echo <sha on main> > ~/copybook-api/state.deploy-now
# That sha, or any later main that contains it, goes out at the next run; the file is removed once it deploys.
now_sha=$(cat "$ROOT/state.deploy-now" 2>/dev/null || true)
if [ -n "$why" ] && [ -n "$now_sha" ] && [ "${why#freeze}" = "$why" ] && git merge-base --is-ancestor "$now_sha" "$new" 2>/dev/null; then
  echo "deploy-now override for $(git rev-parse --short "$now_sha") (was: $why)"; why=
fi
if [ -n "$why" ] && ! git log -1 --format=%s "$new" | grep -q '^\[P0\]'; then
  # Say it once per held head commit, not every 2 minutes.
  [ "$(cat "$ROOT/state.held" 2>/dev/null)" = "$new" ] || { echo "$new" > "$ROOT/state.held"; echo "holding $(git log -1 --format='%h %s' "$new" | cut -c1-90): $why"; }
  exit 0
fi

echo "deploying $(git log -1 --format='%h %s' "$new" | cut -c1-120)"
git merge -q --ff-only origin/main 2>/dev/null || [ "$(git rev-parse HEAD)" = "$new" ] || { echo "checkout is not a fast-forward of origin/main; not deploying"; echo "$new" > "$ROOT/state.last-failed"; exit 0; }
cd "$API"
if ! git diff --quiet "$cur" "$new" -- pnpm-lock.yaml package.json; then
  npx -y pnpm@10 install --frozen-lockfile >/dev/null 2>&1 || { echo "pnpm install failed"; echo "$new" > "$ROOT/state.last-failed"; exit 0; }
fi
rm -rf "$ROOT/build.new"
if ! npx wrangler deploy --dry-run --outdir "$ROOT/build.new" > "$ROOT/last-build.log" 2>&1; then
  echo "build failed at $new (see $ROOT/last-build.log)"; echo "$new" > "$ROOT/state.last-failed"; exit 0
fi
# Only restart when the bundle changes. A holdterm/src or ingest commit often leaves it byte-identical (the bundle only
# imports holdterm/src's names). The source map embeds the output path, so it, BUILD_SHA and README.md are left out.
bundle_hash() { (cd "$1" && find . -type f ! -name '*.map' ! -name BUILD_SHA ! -name README.md | sort | xargs -r sha256sum | sha256sum | cut -c1-64); }
if [ -d "$ROOT/build" ] && [ "$(bundle_hash "$ROOT/build.new")" = "$(bundle_hash "$ROOT/build")" ]; then
  rm -rf "$ROOT/build.new"; echo "$new" > "$ROOT/state.deployed-sha"; rm -f "$ROOT/state.held" "$ROOT/state.deploy-now"
  echo "no change: the bundle at $(git log -1 --format=%h "$new") equals the running one ($(cut -c1-7 "$ROOT/build/BUILD_SHA" 2>/dev/null)); not restarting"
  exit 0
fi
if ! npx vitest run > "$ROOT/last-test.log" 2>&1; then
  echo "tests failed at $new; keeping the running version (see $ROOT/last-test.log)"; echo "$new" > "$ROOT/state.last-failed"; rm -rf "$ROOT/build.new"; exit 0
fi
# Boot the new bundle in workerd on a scratch port with throwaway state before swapping: vitest runs in Node, and
# workerd can still refuse a bundle that passes it (e.g. a non-class value exported from the entry module).
smoke=$(mktemp -d)
( cd "$ROOT/ops"; set -a; . "$ROOT/copybook-api.env"; . "$ROOT/secrets.env"; set +a
  BUILD_DIR="$ROOT/build.new" STATE_DIR="$smoke" PORT=8791 CRON_FLAG=/nonexistent exec timeout 40 node server.mjs ) > "$ROOT/last-smoke.log" 2>&1 &
spid=$!
ok=0
for i in $(seq 1 30); do sleep 1; curl -sf -m 3 -o /dev/null http://127.0.0.1:8791/health && { ok=1; break; }; done
kill -TERM $spid 2>/dev/null; wait $spid 2>/dev/null; rm -rf "$smoke"
if [ $ok != 1 ]; then echo "new bundle failed to boot in workerd at $new; keeping the running version (see $ROOT/last-smoke.log)"; echo "$new" > "$ROOT/state.last-failed"; exit 0; fi
# The bundle carries the commit it was built from (BUILD_SHA -> /health api_build), so a rollback to build.prev or a
# restart after a docs-only commit still names the right build.
echo "$new" > "$ROOT/build.new/BUILD_SHA"
rm -rf "$ROOT/build.prev"; mv "$ROOT/build" "$ROOT/build.prev"; mv "$ROOT/build.new" "$ROOT/build"
systemctl --user restart copybook-api.service
echo "$new" > "$ROOT/state.deployed-sha"; rm -f "$ROOT/state.held" "$ROOT/state.deploy-now"
printf '%s\t%s\n' "$(date +%s)" "$new" >> "$RESTARTS"
echo "deployed $new"
# Every deploy restart (and only those), with its build (the public /status/ log names builds from /health).
printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$new" "$(git -C "$SITE" log -1 --format=%s "$new" | cut -c1-100)" >> "${STATUS_DIR:-$ROOT}/deploys.log"
