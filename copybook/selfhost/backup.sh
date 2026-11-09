#!/usr/bin/env bash
# Nightly (copybook-api-backup.timer, 03:00 UTC): consistent snapshot of state/kv and state/do, age-encrypted to the
# public key in ../backup.pub, uploaded to R2 copybook-history as backups/YYYY-MM-DD.tar.age; keeps 30 days.
# Plaintext exists only in /dev/shm (RAM) while the tar is built. The private key is not on gene (Amp secret
# COPYBOOK_BACKUP_AGE_KEY); restore with ops/restore-check.sh.
set -euo pipefail
ROOT=$HOME/copybook-api; S=$ROOT/state
export PATH=$HOME/.local/share/mise/installs/node/26.12.1/bin:$ROOT/bin:$PATH
set -a; . "$ROOT/secrets.env"; set +a
work=$(mktemp -d /dev/shm/cbk.XXXXXX); out=$(mktemp /dev/shm/cbk-XXXXXX.age); trap 'rm -rf "$work" "$out"' EXIT
cd "$S"
# Blobs first, then an online SQLite backup of each database, then any blob written meanwhile (blobs are immutable,
# and a replaced value gets a new blob), so every blob the databases reference is in the snapshot.
copy_blobs() { find kv do -type f ! -name '*.sqlite' ! -name '*.sqlite-wal' ! -name '*.sqlite-shm' -print0 | while IFS= read -r -d '' f; do [ -e "$work/$f" ] || { mkdir -p "$work/$(dirname "$f")"; cp -p "$f" "$work/$f"; }; done; }
copy_blobs
find kv do -type f -name '*.sqlite' -print0 | while IFS= read -r -d '' f; do mkdir -p "$work/$(dirname "$f")"; sqlite3 "file:$f?mode=ro" ".backup '$work/$f'"; done
copy_blobs
day=$(date -u +%F)
tar -C "$work" -czf - kv do | age -R "$ROOT/backup.pub" -o "$out"
cd "$ROOT/ops"
node r2obj.mjs put "backups/$day.tar.age" "$out"
node r2obj.mjs prune backups/ 30
echo "backup backups/$day.tar.age $(stat -c %s "$out") bytes, $(find "$work" -type f | wc -l) files"
