#!/usr/bin/env bash
# Restore check (needs the private key: $COPYBOOK_BACKUP_AGE_KEY, or AGE_KEY_FILE=<file>; a passphrase-protected key file
# prompts for its passphrase): downloads backups/<day>.tar.age (default: newest), decrypts it with the age identity in
# $COPYBOOK_BACKUP_AGE_KEY (or the file named by $AGE_KEY_FILE), opens it in a throwaway Miniflare with the running
# bundle, and compares key counts with the live store (read-only SQLite reads; the service keeps running).
#   restore-check.sh [YYYY-MM-DD]
set -euo pipefail
ROOT=$HOME/copybook-api
export PATH=$HOME/.local/share/mise/installs/node/26.12.1/bin:$ROOT/bin:$PATH
cd "$ROOT/ops"; set -a; . ../copybook-api.env; . ../secrets.env; set +a
day=${1:-$(node r2obj.mjs list backups/ | grep '\.tar\.age ' | sort | tail -1 | sed -E 's|backups/([0-9-]+)\.tar\.age.*|\1|')}
tmp=$(mktemp -d /dev/shm/cbr.XXXXXX); trap 'rm -rf "$tmp"' EXIT
key=${AGE_KEY_FILE:-$tmp/key}
[ -n "${AGE_KEY_FILE:-}" ] || { umask 077; printf '%s\n' "$COPYBOOK_BACKUP_AGE_KEY" > "$key"; }
node r2obj.mjs get "backups/$day.tar.age" "$tmp/b.age" >/dev/null
mkdir "$tmp/state"; age -d -i "$key" -o "$tmp/b.tgz" "$tmp/b.age"; tar -C "$tmp/state" -xzf "$tmp/b.tgz"
# Backups from Nov 11 on carry a manifest: the decrypted archive must hash to its plaintext_sha256.
psha=unchecked
if node r2obj.mjs get "backups/$day.manifest.json" "$tmp/m.json" >/dev/null 2>&1; then
  want=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["plaintext_sha256"])' "$tmp/m.json")
  [ "$(sha256sum < "$tmp/b.tgz" | cut -c1-64)" = "$want" ] && psha=match || psha=MISMATCH
fi
live() { sqlite3 "file:$(ls "$ROOT"/state/kv/miniflare-KVNamespaceObject/*.sqlite | grep -v metadata)?mode=ro" "select count(*) from _mf_entries where key like '$1%' and (expiration is null or expiration > $(date +%s%3N))"; }
STATE_DIR=$tmp/state PORT=0 CRON_FLAG=/nonexistent node restore-count.mjs 2>"$tmp/err" | tail -1 > "$tmp/r.json" || { grep -vE "^\s+at " "$tmp/err" | head -20 | sed -E 's/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+\.)/\1***@\2/g'; exit 1; }
echo "backup $day: $(cat "$tmp/r.json") live_members=$(live cus:) live_keys=$(live '') do_files=$(find "$tmp/state/do" -name '*.sqlite' | wc -l) plaintext_sha256=$psha"
[ "$psha" != MISMATCH ]
