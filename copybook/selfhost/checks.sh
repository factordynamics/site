#!/usr/bin/env bash
# Checks that read member data, so they run as the copybook service user and publish only their result lines (counts,
# PASS/FAIL) to $STATUS_DIR:
#   checks.sh verify   copybook-checks-verify.timer (every 6 h): the 19 end-to-end checks against the public base,
#                      test members only -> verify.txt
#   checks.sh backup   copybook-checks-backup.timer (Mondays 11:30 UTC): backup-verify.sh, without the private key
#                      (which is offline with Andreas): manifests, ciphertext hashes, age headers, recipient, age and
#                      counts -> appended to backup-checks.log. The real decrypt is restore-check.sh, run by Andreas
#                      with his key file (RESTORE.md).
set -uo pipefail
ROOT=$HOME/copybook-api
export PATH=$HOME/.local/share/mise/installs/node/26.12.1/bin:$ROOT/bin:$PATH
cd "$ROOT/ops"; set -a; . ../copybook-api.env; . ../secrets.env; set +a
S=${STATUS_DIR:?}; umask 022
mask() { sed -E 's/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+\.)/\1***@\2/g; s/(dl=)[A-Za-z0-9._-]+/\1<redacted>/g'; }
case "${1:-}" in
  verify)
    { echo "at $(date -u +%FT%TZ) base $(cat ../state.api-published)"; node verify.mjs "$(cat ../state.api-published)" 2>&1 | grep -E '^(PASS|FAIL|NOTE)' | cut -c1-140 | mask; } > "$S/.verify.tmp" && mv "$S/.verify.tmp" "$S/verify.txt" ;;
  backup)
    {
      echo "== $(date -u +%FT%TZ)"
      ./backup-verify.sh 2>&1 | tail -15 | mask
    } >> "$S/backup-checks.log" ;;
  *) echo "usage: checks.sh verify|backup"; exit 2 ;;
esac
