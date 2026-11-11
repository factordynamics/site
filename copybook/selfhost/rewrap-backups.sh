#!/usr/bin/env bash
# Agent step of the backup-key rotation (needs the OLD key, $COPYBOOK_BACKUP_AGE_KEY, and the new public key in
# ../backup.pub.new from new-backup-key.sh). Re-encrypts every R2 backup (and the local hourly ones) to the new key,
# checking each decrypted archive against its manifest, writes fresh manifests, then makes backup.pub the new key.
# Plaintext only in /dev/shm. Afterwards the old key decrypts nothing that is kept, and Andreas deletes the Amp secret.
#   rewrap-backups.sh                  PREFIX=<other>/ NEWPUB=<file> for a test run (then nothing local is touched)
set -euo pipefail
ROOT=$HOME/copybook-api
export PATH=$HOME/.local/share/mise/installs/node/26.12.1/bin:$ROOT/bin:$PATH
cd "$ROOT/ops"; set -a; . ../copybook-api.env; . ../secrets.env; set +a
PREFIX=${PREFIX:-backups/}
# The new key: from new-backup-key.sh (../backup.pub.new), or made by setup-service-user.sh (status directory).
NEWPUB=${NEWPUB:-$( [ -f "$ROOT/backup.pub.new" ] && echo "$ROOT/backup.pub.new" || echo /var/lib/copybook-status/backup.pub )}
new=$(head -1 "$NEWPUB"); [ -n "${COPYBOOK_BACKUP_AGE_KEY:-}" ] || { echo "old key not in env"; exit 1; }
tmp=$(mktemp -d /dev/shm/cbw.XXXXXX); trap 'rm -rf "$tmp"' EXIT
(umask 077; printf '%s\n' "$COPYBOOK_BACKUP_AGE_KEY" > "$tmp/old")
days=$(node r2obj.mjs list "$PREFIX" | grep -oE "[0-9-]+\.tar\.age " | sed 's/\.tar\.age //' | sort)
n=0
for d in $days; do
  rm -rf "$tmp/s" "$tmp/b"*; mkdir "$tmp/s"
  node r2obj.mjs get "$PREFIX$d.tar.age" "$tmp/b.age" >/dev/null
  age -d -i "$tmp/old" -o "$tmp/b.tgz" "$tmp/b.age"
  if node r2obj.mjs get "$PREFIX$d.manifest.json" "$tmp/m" >/dev/null 2>&1; then
    want=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["plaintext_sha256"])' "$tmp/m")
    [ "$(sha256sum < "$tmp/b.tgz" | cut -c1-64)" = "$want" ] || { echo "FAIL $d: decrypted archive differs from its manifest; stopping"; exit 1; }
  fi
  tar -C "$tmp/s" -xzf "$tmp/b.tgz"
  age -r "$new" -o "$tmp/b.new" "$tmp/b.tgz"
  ./manifest.sh "$d" "$tmp/s" "$tmp/b.tgz" "$tmp/b.new" "$new" > "$tmp/m.new"
  node r2obj.mjs put "$PREFIX$d.tar.age" "$tmp/b.new" >/dev/null
  node r2obj.mjs put "$PREFIX$d.manifest.json" "$tmp/m.new" >/dev/null
  n=$((n + 1))
done
echo "re-encrypted $n backups under $PREFIX"
[ "$PREFIX" = backups/ ] && [ "$NEWPUB" = "$ROOT/backup.pub.new" ] && compgen -G "$ROOT/backups/state-*.tar.age" >/dev/null || exit 0
h=0
for f in "$ROOT"/backups/state-*.tar.age; do
  age -d -i "$tmp/old" "$f" | age -r "$new" -o "$f.new" && mv "$f.new" "$f" && h=$((h + 1))
done
echo "re-encrypted $h local hourly backups"
cp "$ROOT/backup.pub" "$ROOT/backup.pub.old"; mv "$ROOT/backup.pub.new" "$ROOT/backup.pub"
echo "backup.pub is now $new"
