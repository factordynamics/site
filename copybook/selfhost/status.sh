#!/usr/bin/env bash
# copybook-status.timer (every 5 min, runs as the copybook service user): writes what maintainers may see to
# $STATUS_DIR (/var/lib/copybook-status, world-readable). The service's own directory is 0700, so this is the only view
# the maintainers' account has: shas, unit states, masked job logs, the current API base, and short-lived sessions for
# the comped TEST members (never a real member). Nothing here carries member rows, emails (masked) or secrets.
set -uo pipefail
ROOT=$HOME/copybook-api
export PATH=$HOME/.local/share/mise/installs/node/26.12.1/bin:$PATH
cd "$ROOT/ops"; set -a; . ../copybook-api.env; . ../secrets.env; set +a
S=${STATUS_DIR:?}; umask 022
mask() { sed -E 's/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+\.)/\1***@\2/g; s/(Bearer |token=|dl=|whsec_|sk_live_|rk_live_)[A-Za-z0-9._-]+/\1<redacted>/g'; }
w() { cat > "$S/.$1.tmp" && mv "$S/.$1.tmp" "$S/$1"; }
{
  echo "at $(date -u +%FT%TZ)"
  echo "deployed $(cat ../state.deployed-sha 2>/dev/null)"; echo "build $(cat ../build/BUILD_SHA 2>/dev/null)"
  echo "last_failed $(cat ../state.last-failed 2>/dev/null)"; echo "pending_approval $(cat ../state.pending 2>/dev/null)"
  echo "api_base $(cat ../state.api-published 2>/dev/null)"; echo "cron_enabled $([ -e "$CRON_FLAG" ] && echo yes || echo no)"
  echo "health $(curl -s -m 10 'http://127.0.0.1:8787/health?probe=1')"
  # The backup private key must not be on gene (it is offline with Andreas): count files holding an age secret key.
  echo "backup_private_keys_on_host $(grep -rlsIE 'AGE-SECRET-KEY-1[0-9A-Z]{50,}' --exclude-dir=state --exclude-dir=node_modules --exclude-dir=site --exclude-dir=build --exclude-dir=build.prev --exclude-dir=backups --exclude-dir=.local --exclude-dir=.npm --exclude-dir=.cache "$HOME" | wc -l)"
  systemctl --user list-units --all --no-legend 'copybook*' | awk '{print "unit", $1, $3, $4}'
} | w state.txt
cp ../state.api-published "$S/api-published" 2>/dev/null
for f in last-test.log last-build.log last-smoke.log; do tail -60 "../$f" 2>/dev/null | mask | w "$f"; done
journalctl --user -u copybook-api-update -u copybook-api-backup -u copybook-r2-push -u copybook-tunnel-watch -u copybook-checks-verify -u copybook-checks-backup \
  --since -24h --no-pager -o short-iso | grep -vE 'Starting|Finished|Consumed|Deactivated|^\s+at ' | tail -120 | mask | w jobs.log
journalctl --user -u copybook-api --since -2h --no-pager -o short-iso | grep -E 'cron|failed|rror|Started|Stopped|listening' | tail -80 | mask | w api.log
journalctl --user -u copybook-tunnel -n 400 --no-pager -o cat | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 | w tunnel-url
# Sessions for the comped test members (Copy and Pro), valid 2 h: for checks run from the maintainers' account.
tok() { node -e "const {createHmac}=require('node:crypto');const b=Buffer.from(JSON.stringify({k:'session',c:process.argv[1],x:Math.floor(Date.now()/1000+7200)})).toString('base64url');console.log(b+'.'+createHmac('sha256',process.env.SESSION_SECRET).update(b).digest('base64url'))" "$1"; }
printf 'TEST_COPY_SESSION=%s\nTEST_PRO_SESSION=%s\n' "$(tok cus_VanPqWjIrbVUMU)" "$(tok cus_VanP6vPTeg2lHw)" | w test-sessions.env
