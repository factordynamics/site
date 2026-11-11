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
  if curl -sf -m 10 -o /dev/null http://127.0.0.1:8787/health; then
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
if git diff --quiet "$cur" "$new" -- copybook/api; then
  git merge -q --ff-only origin/main 2>/dev/null; echo "$new" > "$ROOT/state.deployed-sha"; exit 0
fi
tried=$(cat "$ROOT/state.last-failed" 2>/dev/null || true)
[ "$tried" = "$new" ] && exit 0

echo "deploying $(git log -1 --format='%h %s' "$new" | cut -c1-120)"
git merge -q --ff-only origin/main 2>/dev/null || [ "$(git rev-parse HEAD)" = "$new" ] || { echo "checkout is not a fast-forward of origin/main; not deploying"; echo "$new" > "$ROOT/state.last-failed"; exit 0; }
cd "$API"
if ! git diff --quiet "$cur" "$new" -- pnpm-lock.yaml package.json; then
  npx -y pnpm@10 install --frozen-lockfile >/dev/null 2>&1 || { echo "pnpm install failed"; echo "$new" > "$ROOT/state.last-failed"; exit 0; }
fi
if ! npx vitest run > "$ROOT/last-test.log" 2>&1; then
  echo "tests failed at $new; keeping the running version (see $ROOT/last-test.log)"; echo "$new" > "$ROOT/state.last-failed"; exit 0
fi
rm -rf "$ROOT/build.new"
if ! npx wrangler deploy --dry-run --outdir "$ROOT/build.new" > "$ROOT/last-build.log" 2>&1; then
  echo "build failed at $new (see $ROOT/last-build.log)"; echo "$new" > "$ROOT/state.last-failed"; exit 0
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
echo "$new" > "$ROOT/state.deployed-sha"
echo "deployed $new"
