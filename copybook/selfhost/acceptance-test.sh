#!/usr/bin/env bash
# Acceptance test for the service-account move, run FROM THE MAINTAINERS' ACCOUNT (refcell, which AI agents use):
#  1. every read of member data, the members store, the service's secrets (each token-signing secret by name) and the
#     backup key fails (permission denied), and so does every write to code that runs as the service user and to the
#     deploy approval list;
#  2. the maintainers' credentials no longer reach member data elsewhere (Cloudflare KV and R2, Stripe customers), the
#     removed secrets and account passwords are gone from the environment, and a session signed with the old session
#     secret is refused;
#  3. the API still serves /me and /v1 (test members only).
# Prints each command and its error, or only a byte count if a read unexpectedly succeeds, never file contents.
# Exit 0 only if everything holds.
#   acceptance-test.sh save-session   TUE17 step 3, before SESSION_SECRET is rotated: signs a 7-day session for the comped
#                                     test member with the old secret (still in this environment), checks the API takes
#                                     it, and saves it; the full run then needs that unexpired session to be refused.
set -u
D=${ACC_DIR:-/var/lib/copybook/copybook-api}
S=${STATUS_DIR:-/var/lib/copybook-status}
P=$HOME/copybook-api/pre-rotation-session
B=$(cat "$S/api-published")
O=https://copybook.factordynamics.com
code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@"; }
if [ "${1:-}" = save-session ]; then
  [ -n "${COPYBOOK_SESSION_SECRET:-}" ] || { echo "the old session secret is not in this environment"; exit 1; }
  t=$(SESSION_SECRET=$COPYBOOK_SESSION_SECRET "$HOME/.local/share/mise/installs/node/26.12.1/bin/node" -e "const {createHmac}=require('node:crypto');const b=Buffer.from(JSON.stringify({k:'session',c:'cus_VanPqWjIrbVUMU',x:Math.floor(Date.now()/1000+7*86400)})).toString('base64url');console.log(b+'.'+createHmac('sha256',process.env.SESSION_SECRET).update(b).digest('base64url'))")
  c=$(code -H "origin: $O" -H "authorization: Bearer $t" "$B/me")
  [ "$c" = 200 ] || { echo "GET $B/me with the old-secret session (test member) -> $c, expected 200; not saved"; exit 1; }
  (umask 077; printf '%s' "$t" > "$P"); echo "saved: GET $B/me with the old-secret session (test member) -> 200 before rotation"; exit 0
fi
fail=0
denied() { # label, command...
  local label=$1; shift
  local err bytes
  bytes=$("$@" 2>/tmp/acc.err | wc -c); err=$(head -1 /tmp/acc.err)
  # Only a real refusal counts: "No such file" proves nothing.
  if [ "$bytes" = 0 ] && printf '%s' "$err" | grep -qE 'Permission denied|password is required|unable to open database|Access denied|authentication required'; then echo "ok    $label: \$ $* -> $err"; else echo "FAIL  $label: \$ $* -> read $bytes bytes"; fail=1; fi
}
echo "== as $(id -un) (uid $(id -u)) on $(hostname) at $(date -u +%FT%TZ)"
denied "service home"            ls "$(dirname "$D")"
denied "service directory"       ls "$D"
denied "a member file (follows)" cat "$D/state/do/copybook-api-MemberFollows/133104051df00a7a702eadc1f79f55003875e39d2071a774bb1a0e1adb9d7f33.sqlite"
denied "members store (KV)"      cat "$D/state/kv/miniflare-KVNamespaceObject/86c782669b53e48b3b2e014f8f25bbf476c6fb00e489386ae2ddb90d794963fc.sqlite"
denied "members store via sqlite" sqlite3 "file:$D/state/kv/miniflare-KVNamespaceObject/86c782669b53e48b3b2e014f8f25bbf476c6fb00e489386ae2ddb90d794963fc.sqlite?mode=ro" "select count(*) from _mf_entries"
denied "private R2 copy"         cat "$D/state/r2/copybook-history/blobs/000034135f1fb8759c50c9070b7850d8198f25c1bd66dc8fb28bceec60960864000001a1be90d66b"
denied "hourly backups"          ls "$D/backups"
denied "backup key"              cat "$D/backup.key"
denied "service secrets"         cat "$D/secrets.env"
# The token-signing secrets: SESSION_SECRET signs every member session, login, unsubscribe, keep and resume link (whoever
# holds it can sign in as any member); STRIPE_WEBHOOK_SECRET authenticates Stripe's events (whoever holds it can forge
# a payment). grep -q prints nothing even when it can read the file, so only the error decides.
denied "session-signing secret (SESSION_SECRET)"        grep -q '^SESSION_SECRET=' "$D/secrets.env"
denied "webhook-signing secret (STRIPE_WEBHOOK_SECRET)" grep -q '^STRIPE_WEBHOOK_SECRET=' "$D/secrets.env"
pid=$(pgrep -u copybook -f 'node server.mjs' | head -1)
denied "API process environment (secrets)" cat "/proc/${pid:-0}/environ"
denied "API process memory"      head -c 1 "/proc/${pid:-0}/mem"
denied "root via sudo"           sudo -n true
echo "== code that runs as the service user (writes)"
denied "deploy approval list"    sh -c ': >> "$1"' sh "$D/deploy.approved"
denied "service scripts"         touch "$D/ops/update.sh"
denied "API source checkout"     touch "$D/site/copybook/api/src/index.ts"
denied "API bundle"              touch "$D/build/BUILD_SHA"
denied "service's node runtime"  touch "$(dirname "$D")/.local/share/mise/installs/node/26.12.1/bin/node"
denied "service's units"         touch "$(dirname "$D")/.config/systemd/user/copybook-api.service"
denied "service manager"         systemctl --user --machine=copybook@ show-environment
echo "== credentials held by this account"
for v in COPYBOOK_SESSION_SECRET COPYBOOK_BACKUP_AGE_KEY COPYBOOK_STRIPE_WEBHOOK_SECRET COPYBOOK_WAITLIST_PRIVATE_KEY \
  SESSION_SECRET STRIPE_WEBHOOK_SECRET CLOUDFLARE_ACCOUNT_PASSWORD STRIPE_ACCOUNT_PASSWORD RESEND_ACCOUNT_PASSWORD; do
  if [ -n "${!v:-}" ]; then echo "FAIL  $v is still in this environment"; fail=1; else echo "ok    $v not in this environment"; fi
done
n=$(grep -cvE '^(RESEND_API_KEY=|$)' "$HOME/copybook-api/secrets.env" 2>/dev/null || true)
if [ "${n:-0}" = 0 ]; then echo "ok    ~/copybook-api/secrets.env holds only the send-only email key"; else echo "FAIL  ~/copybook-api/secrets.env holds $n other lines"; fail=1; fi
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  c=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/967e13dd88bb23b24662e62cbb6fd84f/storage/kv/namespaces?per_page=1")
  case $c in 401|403) echo "ok    Cloudflare token cannot list KV (HTTP $c)";; *) echo "FAIL  Cloudflare token can list KV (HTTP $c)"; fail=1;; esac
  c=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/967e13dd88bb23b24662e62cbb6fd84f/r2/buckets/copybook-history/objects?per_page=1")
  case $c in 401|403) echo "ok    Cloudflare token cannot read R2 copybook-history (HTTP $c)";; *) echo "FAIL  Cloudflare token can read R2 copybook-history (HTTP $c)"; fail=1;; esac
else echo "ok    no Cloudflare token in this environment"; fi
if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
  c=$(curl -s -o /dev/null -w '%{http_code}' -u "$STRIPE_SECRET_KEY:" 'https://api.stripe.com/v1/customers?limit=1')
  case $c in 401|403) echo "ok    Stripe key cannot read customers (HTTP $c)";; *) echo "FAIL  Stripe key can read customers (HTTP $c)"; fail=1;; esac
else echo "ok    no Stripe key in this environment"; fi
# The test member's session signed with the old secret (save-session, TUE17 step 3) took 200 then; still unexpired,
# it must be refused now, which only the rotation explains.
if [ -s "$P" ]; then
  x=$(python3 -I -c 'import sys,json,base64;b=open(sys.argv[1]).read().split(".")[0];print(json.loads(base64.urlsafe_b64decode(b+"="*(-len(b)%4)))["x"])' "$P")
  c=$(code -H "origin: $O" -H "authorization: Bearer $(cat "$P")" "$B/me")
  if [ "$x" -le "$(date +%s)" ]; then echo "FAIL  the saved old-secret session has expired; inconclusive (save a new one before rotating)"; fail=1
  else case $c in 401|403) echo "ok    GET $B/me with an unexpired session signed by the old secret (test member) -> $c";; *) echo "FAIL  GET $B/me with an unexpired session signed by the old secret (test member) -> $c"; fail=1;; esac; fi
else echo "FAIL  no old-secret session saved at $P (TUE17 step 3: acceptance-test.sh save-session)"; fail=1; fi
echo "== the API still serves members (test members only)"
. "$S/test-sessions.env"
c=$(code -H "origin: $O" -H "authorization: Bearer $TEST_COPY_SESSION" "$B/me"); echo "$([ "$c" = 200 ] && echo ok || { fail=1; echo FAIL; })    GET $B/me (test member) -> $c"
k=$(curl -s -m 20 -X POST -H "origin: $O" -H 'content-type: application/json' -H "authorization: Bearer $TEST_PRO_SESSION" -d '{"name":"acceptance-test"}' "$B/keys")
key=$(printf '%s' "$k" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d.get("key") or d.get("secret") or "")' 2>/dev/null)
kid=$(printf '%s' "$k" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d.get("id") or d.get("key_id") or "")' 2>/dev/null)
c=$(code -H "authorization: Bearer $key" "$B/v1/filers/warren-buffett/holdings/latest"); echo "$([ "$c" = 200 ] && echo ok || { fail=1; echo FAIL; })    GET $B/v1/filers/warren-buffett/holdings/latest (test member's key) -> $c"
[ -n "$kid" ] && code -X DELETE -H "origin: $O" -H "authorization: Bearer $TEST_PRO_SESSION" "$B/keys/$kid" >/dev/null
rm -f /tmp/acc.err
echo "== result: $([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
