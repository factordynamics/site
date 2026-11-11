#!/usr/bin/env bash
# Acceptance test for the service-account move, run FROM THE MAINTAINERS' ACCOUNT (refcell, which AI agents use):
#  1. every read of member data, the members store, the service's secrets and the backup key fails (permission denied);
#  2. the maintainers' credentials no longer reach member data elsewhere (Cloudflare KV and R2, Stripe customers), and
#     the removed secrets are gone from the environment;
#  3. the API still serves /me and /v1 (test members only).
# Prints each command and its error, or only a byte count if a read unexpectedly succeeds, never file contents.
# Exit 0 only if everything holds.
set -u
D=${ACC_DIR:-/var/lib/copybook/copybook-api}
S=${STATUS_DIR:-/var/lib/copybook-status}
fail=0
denied() { # label, command...
  local label=$1; shift
  local err bytes
  bytes=$("$@" 2>/tmp/acc.err | wc -c); err=$(head -1 /tmp/acc.err)
  # Only a real refusal counts: "No such file" proves nothing.
  if [ "$bytes" = 0 ] && printf '%s' "$err" | grep -qE 'Permission denied|password is required|unable to open database'; then echo "ok    $label: \$ $* -> $err"; else echo "FAIL  $label: \$ $* -> read $bytes bytes"; fail=1; fi
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
pid=$(pgrep -u copybook -f 'node server.mjs' | head -1)
denied "API process environment (secrets)" cat "/proc/${pid:-0}/environ"
denied "API process memory"      head -c 1 "/proc/${pid:-0}/mem"
denied "root via sudo"           sudo -n true
echo "== credentials held by this account"
for v in COPYBOOK_SESSION_SECRET COPYBOOK_BACKUP_AGE_KEY COPYBOOK_STRIPE_WEBHOOK_SECRET; do
  if [ -n "${!v:-}" ]; then echo "FAIL  $v is still in this environment"; fail=1; else echo "ok    $v not in this environment"; fi
done
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
echo "== the API still serves members (test members only)"
. "$S/test-sessions.env"
B=$(cat "$S/api-published")
O=https://copybook.factordynamics.com
code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@"; }
c=$(code -H "origin: $O" -H "authorization: Bearer $TEST_COPY_SESSION" "$B/me"); echo "$([ "$c" = 200 ] && echo ok || { fail=1; echo FAIL; })    GET $B/me (test member) -> $c"
k=$(curl -s -m 20 -X POST -H "origin: $O" -H 'content-type: application/json' -H "authorization: Bearer $TEST_PRO_SESSION" -d '{"name":"acceptance-test"}' "$B/keys")
key=$(printf '%s' "$k" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d.get("key") or d.get("secret") or "")' 2>/dev/null)
kid=$(printf '%s' "$k" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d.get("id") or d.get("key_id") or "")' 2>/dev/null)
c=$(code -H "authorization: Bearer $key" "$B/v1/filers/warren-buffett/holdings/latest"); echo "$([ "$c" = 200 ] && echo ok || { fail=1; echo FAIL; })    GET $B/v1/filers/warren-buffett/holdings/latest (test member's key) -> $c"
[ -n "$kid" ] && code -X DELETE -H "origin: $O" -H "authorization: Bearer $TEST_PRO_SESSION" "$B/keys/$kid" >/dev/null
rm -f /tmp/acc.err
echo "== result: $([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
