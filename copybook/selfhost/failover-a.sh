#!/usr/bin/env bash
# Path A in one command: move members' API base (api.json, which both front ends read at load) to the Cloudflare
# Worker, or back to gene's quick tunnel. Use when the quick tunnel nears its 200 in-flight limit or is down.
#   failover-a.sh to-worker    pins api.json to workers.dev (tunnel-watch.sh stops republishing while pinned)
#   failover-a.sh back         unpins and republishes the current tunnel base
#   failover-a.sh status
# The Worker serves itself when api.json names its own origin (loop guard, site 754c32a); MOVED_TO stays set.
# Not done here: the Stripe webhook stays on gene (it isn't member traffic and gene is up). The Worker's free quota is
# 100k requests/day; gene's tunnel saw ~2.5k/day on Nov 9–10.
set -euo pipefail
ROOT=$HOME/copybook-api
WD=https://copybook-api.factordynamics.workers.dev
PIN=$ROOT/state.api-pinned
set -a; . "$ROOT/secrets.env"; set +a
put() {
  curl -sf -m 30 -X PUT -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' \
    --data-binary "$(printf '{"api":"%s","at":"%s"}' "$1" "$(date -u +%FT%TZ)")" \
    https://api.cloudflare.com/client/v4/accounts/967e13dd88bb23b24662e62cbb6fd84f/r2/buckets/copybook-public/objects/api.json -o /dev/null
  echo "$(date -u +%FT%TZ) api.json -> $1"
}
case "${1:-status}" in
  to-worker)
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$WD/health")
    case "$code" in 200|308) ;; *) echo "workers.dev /health is $code (429 = daily quota spent); not failing over"; exit 1;; esac
    echo "$WD" > "$PIN"; put "$WD"
    for _ in $(seq 36); do [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$WD/health")" = 200 ] && { echo "Worker serving"; exit 0; }; sleep 5; done
    echo "Worker still redirecting after 3 min; check the loop guard"; exit 1 ;;
  back)
    rm -f "$PIN"; base=$(cat "$ROOT/state.api-published"); put "$base"
    echo "tunnel base $base; /health $(curl -s -m 15 -o /dev/null -w '%{http_code}' "$base/health")" ;;
  status)
    echo "pinned: $(cat "$PIN" 2>/dev/null || echo no)"; curl -s -m 10 https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/api.json; echo ;;
  *) echo "usage: failover-a.sh to-worker|back|status"; exit 2 ;;
esac
