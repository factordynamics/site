#!/usr/bin/env bash
# copybook-inflight.service: samples cloudflared's in-flight request gauge for the quick tunnel every 2 s and writes one
# line per UTC minute to ~/copybook-api/inflight.tsv: <minute> <max in-flight> <requests> <502s> <503s> <429s from origin>.
# Cloudflare limits a quick tunnel to 200 in-flight requests (more get 429 at the edge, which never reaches gene), so the
# gauge is the early warning. At >= 100 (half the limit) it emails hello@ once per UTC day; the failover is
# ops/failover-a.sh to-worker (members to the Cloudflare Worker through api.json).
set -uo pipefail
ROOT=$HOME/copybook-api
OUT=$ROOT/inflight.tsv
WARN=${WARN:-100}
# cloudflared's metrics address (fixed to 20241 in the unit from its next restart; read from its log until then).
port() { journalctl --user -u copybook-tunnel -n 2000 --no-pager -o cat | grep -oE 'metrics server on [0-9.]+:[0-9]+' | tail -1 | awk '{print $4}'; }
M=http://$(port)/metrics
set -a; . "$ROOT/secrets.env"; set +a
get() { curl -s -m 2 "$M" | awk -v k="$1" '$1==k{print int($2); f=1} END{if(!f) print 0}'; }
code() { curl -s -m 2 "$M" | awk -v c="$1" 'index($1,"status_code=\""c"\"")>0{print int($2); f=1} END{if(!f) print 0}'; }
alert() {
  local day; day=$(date -u +%F); [ -f "$ROOT/state.inflight-alerted" ] && [ "$(cat "$ROOT/state.inflight-alerted")" = "$day" ] && return
  echo "$day" > "$ROOT/state.inflight-alerted"
  body=$(python3 -I -c 'import json,sys;print(json.dumps({"from":"Copybook <copybook@factordynamics.com>","to":["hello@factordynamics.com"],"subject":sys.argv[1],"text":sys.argv[2]}))' \
    "Copybook API tunnel at $1 in-flight requests (limit 200)" \
    "cloudflared on gene saw $1 concurrent requests at $2 UTC. Cloudflare quick tunnels return 429 above 200 in flight. To move members to the Cloudflare Worker: ~/copybook-api/ops/failover-a.sh to-worker (back: failover-a.sh back). Per-minute log: ~/copybook-api/inflight.tsv.")
  curl -sf -m 20 -X POST https://api.resend.com/emails -H "Authorization: Bearer $RESEND_API_KEY" -H 'content-type: application/json' -d "$body" -o /dev/null
}
min=$(date -u +%FT%H:%MZ); mx=0
t0=$(get cloudflared_tunnel_total_requests); b0=$(code 502); s0=$(code 503); q0=$(code 429)
while :; do
  n=$(get cloudflared_tunnel_concurrent_requests_per_tunnel); [ "${n:-0}" -gt "$mx" ] && mx=$n
  now=$(date -u +%FT%H:%MZ)
  if [ "$now" != "$min" ]; then
    M=http://$(port)/metrics
    t=$(get cloudflared_tunnel_total_requests); b=$(code 502); s=$(code 503); q=$(code 429)
    # Counters reset when cloudflared restarts: count from zero then.
    d() { [ "$1" -ge "$2" ] && echo $(( $1 - $2 )) || echo "$1"; }
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$min" "$mx" "$(d "$t" "$t0")" "$(d "$b" "$b0")" "$(d "$s" "$s0")" "$(d "$q" "$q0")" >> "$OUT"
    [ "$mx" -ge "$WARN" ] && alert "$mx" "$min"
    t0=$t; b0=$b; s0=$s; q0=$q; min=$now; mx=0
    [ "$(wc -l < "$OUT")" -gt 20000 ] && { tail -10080 "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"; }
  fi
  sleep 2
done
