#!/usr/bin/env bash
# Weekly backup check WITHOUT the private key (agents hold only the public key, backup.pub):
#  - every backups/YYYY-MM-DD.tar.age in R2 that has a manifest hashes to the manifest's ciphertext_sha256 and size;
#  - each is a well-formed age file (v1 header, one X25519 stanza) encrypted to the current backup.pub recipient
#    (per the manifest; age files don't name their recipient);
#  - the newest backup is under 30 hours old, and its manifest's member and key counts are plausible against the live store.
# What it can't prove: that the archive decrypts. That is the monthly drill with the key holder (restore-check.sh, which
# also checks the decrypted archive against plaintext_sha256). Prints counts only (masking rule). Exit 1 on any failure.
set -uo pipefail
ROOT=$HOME/copybook-api
export PATH=$HOME/.local/share/mise/installs/node/26.12.1/bin:$ROOT/bin:$PATH
cd "$ROOT/ops"; set -a; . ../copybook-api.env; . ../secrets.env; set +a
tmp=$(mktemp -d /dev/shm/cbv.XXXXXX); trap 'rm -rf "$tmp"' EXIT
rcpt=$(head -1 "$ROOT/backup.pub")
node r2obj.mjs list backups/ > "$tmp/list" 2>"$tmp/err" || { echo "FAIL: cannot list R2 backups/: $(grep -m1 -oE '[A-Za-z]*Error[^,]*' "$tmp/err")"; exit 1; }
days=$(grep -oE 'backups/[0-9-]+\.tar\.age ' "$tmp/list" | sed -E 's|backups/([0-9-]+)\.tar\.age |\1|' | sort)
fail=0; ok=0; nomanifest=0
for d in $days; do
  if ! grep -q "backups/$d.manifest.json " "$tmp/list"; then nomanifest=$((nomanifest + 1)); continue; fi
  node r2obj.mjs get "backups/$d.tar.age" "$tmp/b" >/dev/null && node r2obj.mjs get "backups/$d.manifest.json" "$tmp/m" >/dev/null || { echo "FAIL $d: download"; fail=1; continue; }
  read -r csha cbytes mr < <(python3 -I -c 'import json,sys;m=json.load(open(sys.argv[1]));print(m["ciphertext_sha256"],m["ciphertext_bytes"],m["recipient"])' "$tmp/m")
  hdr=$(head -c 400 "$tmp/b" | tr -d '\0')
  if [ "$(sha256sum < "$tmp/b" | cut -c1-64)" != "$csha" ] || [ "$(stat -c %s "$tmp/b")" != "$cbytes" ]; then echo "FAIL $d: ciphertext differs from manifest"; fail=1
  elif [ "$(printf '%s\n' "$hdr" | head -1)" != "age-encryption.org/v1" ] || [ "$(printf '%s\n' "$hdr" | grep -c '^-> X25519 ')" != 1 ]; then echo "FAIL $d: not a one-recipient age file"; fail=1
  elif [ "$mr" != "$rcpt" ]; then echo "FAIL $d: manifest recipient is not the current backup.pub"; fail=1
  else ok=$((ok + 1)); cp "$tmp/m" "$tmp/newest.json"; fi
done
newest=$(echo "$days" | tail -1)
[ -n "$newest" ] || { echo "FAIL: no backups in R2"; exit 1; }
age_h=$(( ( $(date +%s) - $(date -d "$(grep "backups/$newest.tar.age " "$tmp/list" | awk '{print $3}')" +%s) ) / 3600 ))
[ "$age_h" -lt 30 ] || { echo "FAIL newest backup $newest is ${age_h} h old"; fail=1; }
db=$(ls "$ROOT"/state/kv/miniflare-KVNamespaceObject/*.sqlite | grep -v metadata); now=$(date +%s%3N)
live() { sqlite3 "file:$db?mode=ro" "select count(*) from _mf_entries where key like '$1%' and (expiration is null or expiration > $now)"; }
lm=$(live cus:); lk=$(live '')
if [ -f "$tmp/newest.json" ]; then
  read -r nd mm mk < <(python3 -I -c 'import json,sys;m=json.load(open(sys.argv[1]));print(m["day"],m["members"],m["keys"])' "$tmp/newest.json")
  # A manifest with no members, or far fewer keys than live, means an empty or partial snapshot.
  { [ "$mm" -ge 1 ] && [ $((mk * 2)) -ge "$lk" ]; } || { echo "FAIL manifest $nd: members=$mm keys=$mk vs live members=$lm keys=$lk"; fail=1; }
else nd=none; mm=?; mk=?; fi
echo "backups=$(echo "$days" | wc -w) verified=$ok without_manifest=$nomanifest newest=$newest (${age_h} h) manifest_members=$mm manifest_keys=$mk live_members=$lm live_keys=$lk result=$([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
