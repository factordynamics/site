#!/usr/bin/env bash
# Every minute (copybook-tunnel-watch.timer): keeps the front ends' API base on a working entry point.
#  - Current base: the quick tunnel (https://<x>.trycloudflare.com/copybook) when it answers /health; when it has failed
#    for 2+ minutes, Funnel (https://gene.tail70ba3.ts.net/copybook).
#  - Publishes the base to https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/api.json, which the Cloudflare Worker reads
#    to find gene (src/index.ts movedBase). Neither front end reads it or names a tunnel: both call the Worker's stable
#    name (Copybook c5ed8ee, Holdterm 2026-11-16), so nothing here commits to main any more.
#  - Emails CONTACT_EMAIL when anything listens on port 22 (a rule; Funnel tcp 8443 forwards there), when the tunnel URL changes, when the tunnel is down for 2+ minutes, and when it recovers.
set -uo pipefail
ROOT=$HOME/copybook-api
FUNNEL=https://gene.tail70ba3.ts.net/copybook
DOWN_SINCE=$ROOT/state.tunnel-down-since
log() { echo "$(date -u +%FT%TZ) $*"; }
set -a; . "$ROOT/secrets.env"; set +a
# After the service-account move it runs twice: as the service user with NO_FE=1 (health, api.json, alerts, and the
# current base copied to $STATUS_DIR), and as the maintainers' account with FE_ONLY=1, which used to rewrite the
# front-end configs on main and now does nothing.
if [ "${FE_ONLY:-0}" = 1 ]; then
  exit 0   # the front ends no longer carry an API host to rewrite
else
alert() { # subject, text
  local body
  body=$(python3 -I -c 'import json,sys;print(json.dumps({"from":"Copybook <copybook@factordynamics.com>","to":["hello@factordynamics.com"],"subject":sys.argv[1],"text":sys.argv[2]}))' "$1" "$2")
  curl -sf -m 20 -X POST https://api.resend.com/emails -H "Authorization: Bearer $RESEND_API_KEY" -H 'content-type: application/json' -d "$body" -o /dev/null \
    && log "alert sent: $1" || { log "alert FAILED: $1"; return 1; }   # nonzero, so a once-only alert retries
}

# Rule (decisions thread, Nov 19): nothing may ever listen on gene's port 22. Funnel's tcp://gene.tail70ba3.ts.net:8443
# forwards there, so a listener would be reachable from the internet. Alerts once per occurrence, and again when clear.
P22=$ROOT/state.port22-alerted
l22=$(ss -Hltn "sport = :22" 2>/dev/null | awk '{print $4}' | tr '\n' ' ')
if [ -n "$l22" ]; then
  log "port 22 has a listener: $l22"
  [ -e "$P22" ] || { alert "gene: something listens on port 22" "Rule: nothing may ever listen on gene's port 22. Listening now: $l22. Tailscale Funnel forwards tcp://gene.tail70ba3.ts.net:8443 to localhost:22, so it is reachable from the internet. Stop that listener (root), or turn the forward off: sudo tailscale funnel --tcp=8443 off. See ~/copybook-api/ops/ROOT-STEPS.md." && touch "$P22"; }
elif [ -e "$P22" ]; then
  rm -f "$P22"; log "port 22 clear again"; alert "gene: port 22 clear again" "Nothing listens on gene's port 22 any more."
fi

url=$(journalctl --user -u copybook-tunnel -n 400 --no-pager -o cat | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
now=$(date +%s)
if [ -n "$url" ] && systemctl --user is-active -q copybook-tunnel && curl -sf -m 15 -o /dev/null "$url/copybook/health"; then
  if [ -f "$DOWN_SINCE" ]; then
    read -r since alerted < "$DOWN_SINCE"; rm -f "$DOWN_SINCE"
    [ "$alerted" = 1 ] && alert "Copybook API tunnel recovered" "The quick tunnel answers again at $url/copybook after $(( (now - since) / 60 )) min down. Front ends and api.json follow automatically."
  fi
  want=$url/copybook
else
  [ -f "$DOWN_SINCE" ] || echo "$now 0" > "$DOWN_SINCE"
  read -r since alerted < "$DOWN_SINCE"
  log "tunnel check failed for $(( now - since )) s, url=${url:-none}"
  [ $(( now - since )) -lt 120 ] && exit 0
  if [ "$alerted" != 1 ]; then
    echo "$since 1" > "$DOWN_SINCE"
    alert "Copybook API tunnel down for 2+ minutes" "The quick tunnel (${url:-no URL}) has failed health checks since $(date -u -d @$since +%FT%TZ). Members now fall back to Funnel ($FUNNEL), which is slow. On gene: systemctl --user status copybook-tunnel; journalctl --user -u copybook-tunnel -n 50."
  fi
  # Funnel goes through the same API (and uplink): publish it only when it answers. Otherwise leave api.json alone;
  # Cloudflare's cron moves members to the Worker when both front doors are down (copybook/api/src/autofailover.ts).
  if ! curl -sf -m 15 -o /dev/null "$FUNNEL/health"; then log "Funnel down too; api.json left to Cloudflare's auto-failover"; exit 0; fi
  want=$FUNNEL
fi

# Public pointer the front ends read at load: {"api": "<base>", "at": "<iso>"} in R2 copybook-public (r2.dev URL).
prev=$(cat "$ROOT/state.api-published" 2>/dev/null)
# ops/failover-a.sh to-worker pins api.json to the Cloudflare Worker; leave it alone until failover-a.sh back.
if [ -f "$ROOT/state.api-pinned" ]; then log "api.json pinned to $(cat "$ROOT/state.api-pinned"); tunnel base $want not published"
elif [ "$prev" != "$want" ]; then
  body=$(printf '{"api":"%s","at":"%s"}' "$want" "$(date -u +%FT%TZ)")
  if curl -sf -m 30 -X PUT -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' --data-binary "$body" \
      "https://api.cloudflare.com/client/v4/accounts/967e13dd88bb23b24662e62cbb6fd84f/r2/buckets/copybook-public/objects/api.json" -o /dev/null; then
    echo "$want" > "$ROOT/state.api-published"; log "api.json -> $want"
    case "$prev$want" in *trycloudflare*trycloudflare*) alert "Copybook API tunnel URL changed" "cloudflared restarted with a new quick-tunnel URL. api.json, which the Worker follows, now points at $want (was $prev). Stripe's webhook and links in email stay on $FUNNEL.";; esac
  else log "api.json upload failed"; fi
fi

fi
if [ -n "${STATUS_DIR:-}" ] && [ "${FE_ONLY:-0}" != 1 ]; then cp "$ROOT/state.api-published" "$STATUS_DIR/api-published" 2>/dev/null; fi
