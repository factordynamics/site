#!/usr/bin/env bash
# Every minute (copybook-tunnel-watch.timer): keeps the front ends' API base on a working entry point.
#  - Current base: the quick tunnel (https://<x>.trycloudflare.com/copybook) when it answers /health; when it has failed
#    for 2+ minutes, Funnel (https://gene.tail70ba3.ts.net/copybook).
#  - Publishes the base to https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/api.json, which the front ends read at load.
#  - When main's copybook/web/api.config.mjs or holdterm/src/config.ts holds a different Funnel or trycloudflare base,
#    rewrites that one value, commits and pushes to factordynamics/site main (build-time fallback for api.json).
#    A base that is neither (e.g. a future named tunnel) is left alone.
#  - Emails CONTACT_EMAIL when the tunnel URL changes, when the tunnel is down for 2+ minutes, and when it recovers.
set -uo pipefail
ROOT=$HOME/copybook-api
FE=$ROOT/fe
FUNNEL=https://gene.tail70ba3.ts.net/copybook
DOWN_SINCE=$ROOT/state.tunnel-down-since
log() { echo "$(date -u +%FT%TZ) $*"; }
set -a; . "$ROOT/secrets.env"; set +a
alert() { # subject, text
  local body
  body=$(python3 -I -c 'import json,sys;print(json.dumps({"from":"Copybook <copybook@factordynamics.com>","to":["hello@factordynamics.com"],"subject":sys.argv[1],"text":sys.argv[2]}))' "$1" "$2")
  curl -sf -m 20 -X POST https://api.resend.com/emails -H "Authorization: Bearer $RESEND_API_KEY" -H 'content-type: application/json' -d "$body" -o /dev/null \
    && log "alert sent: $1" || log "alert FAILED: $1"
}

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
    case "$prev$want" in *trycloudflare*trycloudflare*) alert "Copybook API tunnel URL changed" "cloudflared restarted with a new quick-tunnel URL. api.json and both front-end configs now point at $want (was $prev). Stripe's webhook and links in email stay on $FUNNEL.";; esac
  else log "api.json upload failed"; fi
fi

if [ ! -d "$FE/.git" ]; then
  git clone -q --filter=blob:none --sparse https://github.com/factordynamics/site.git "$FE" && git -C "$FE" sparse-checkout set copybook/web holdterm/src || exit 1
fi
cd "$FE"
for attempt in 1 2 3; do
  git fetch -q origin main && git reset -q --hard origin/main || { log "fetch failed"; exit 0; }
  changed=0
  # api.config.mjs: process.env.VITE_API || '<base>'   holdterm/src/config.ts: export const api = '<base>'
  for f in copybook/web/api.config.mjs holdterm/src/config.ts; do
    cur=$(grep -oE "'https://(gene\.tail70ba3\.ts\.net|[a-z0-9-]+\.trycloudflare\.com)/copybook'" "$f" | head -1 | tr -d "'")
    [ -z "$cur" ] || [ "$cur" = "$want" ] && continue
    sed -i "s|'$cur'|'$want'|" "$f" && changed=1 && log "$f: $cur -> $want"
  done
  [ $changed = 0 ] && exit 0
  if [ "${DRY_RUN:-0}" = 1 ]; then git diff; git reset -q --hard origin/main; exit 0; fi
  git -c user.name=refcell -c user.email=abigger87@gmail.com commit -q -am "copybook, holdterm: API base -> $want (tunnel watcher on gene)

The quick tunnel's URL changes when cloudflared restarts; this keeps both front ends on a working entry point.

Amp-Thread-ID: https://ampcode.com/threads/T-01a1be80-c5ff-7641-b745-6abf1056e5e3"
  if git push -q origin HEAD:main; then log "pushed $(git rev-parse --short HEAD); Pages and Holdterm redeploy"; exit 0; fi
  log "push rejected, retrying"; sleep 5
done
log "gave up after 3 push attempts"
