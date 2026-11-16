#!/usr/bin/env bash
# Prints the JSON manifest for one backup, so it can be checked later without the private key:
#   manifest.sh <day> <unpacked state dir (kv/, do/)> <plaintext .tgz> <encrypted .tar.age> <age recipient>
# Counts only (masking rule): members = unexpired cus: keys, keys = all unexpired KV keys.
set -euo pipefail
day=$1 st=$2 plain=$3 enc=$4 rcpt=$5
# The DB binding's file by name: since the OPS_KV split (680bd59f…) a glob also matches OPS_KV, which holds no members.
db="$st/kv/miniflare-KVNamespaceObject/86c782669b53e48b3b2e014f8f25bbf476c6fb00e489386ae2ddb90d794963fc.sqlite"
now=$(date +%s%3N)
cnt() { sqlite3 "file:$db?mode=ro" "select count(*) from _mf_entries where key like '$1%' and (expiration is null or expiration > $now)"; }
printf '{"day":"%s","at":"%s","recipient":"%s","plaintext_sha256":"%s","plaintext_bytes":%s,"ciphertext_sha256":"%s","ciphertext_bytes":%s,"files":%s,"members":%s,"keys":%s,"do_files":%s}\n' \
  "$day" "$(date -u +%FT%TZ)" "$rcpt" "$(sha256sum < "$plain" | cut -c1-64)" "$(stat -c %s "$plain")" \
  "$(sha256sum < "$enc" | cut -c1-64)" "$(stat -c %s "$enc")" "$(find "$st" -type f | wc -l)" "$(cnt cus:)" "$(cnt '')" \
  "$(find "$st/do" -name '*.sqlite' | wc -l)"
