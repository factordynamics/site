#!/usr/bin/env bash
# External latency probe. Funnel: curl pinned to Funnel's public ingress IP (out to the internet, through Tailscale's
# ingress and relay, back to gene). Tunnel: the Cloudflare quick tunnel. 20 runs of each path, then a 10-way /me burst.
#   extprobe.sh funnel|tunnel <tunnel base, e.g. https://x.trycloudflare.com>
set -u
mode=$1; TUN=${2:-}
cd "$(dirname "$0")"; set -a; . ../secrets.env; set +a
if [ "$mode" = funnel ]; then
  IP=$(curl -s -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=gene.tail70ba3.ts.net&type=A" | python3 -c "import json,sys;print(json.load(sys.stdin)['Answer'][0]['data'])")
  B=https://gene.tail70ba3.ts.net/copybook; R=(--resolve "gene.tail70ba3.ts.net:443:$IP")
else
  B=$TUN/copybook; R=()
fi
tok() { node -e "const {createHmac}=require('node:crypto');const b=Buffer.from(JSON.stringify({k:'session',c:process.argv[1],x:Math.floor(Date.now()/1000+900)})).toString('base64url');console.log(b+'.'+createHmac('sha256',process.env.SESSION_SECRET).update(b).digest('base64url'))" "$1"; }
T=$(tok cus_VanPqWjIrbVUMU); P=$(tok cus_VanP6vPTeg2lHw)
O='origin: https://copybook.factordynamics.com'
KEY=$(curl -s "${R[@]}" -m 60 -X POST "$B/keys" -H "Authorization: Bearer $P" -H "$O" -H 'content-type: application/json' -d '{"name":"latency-probe"}')
K=$(echo "$KEY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('key') or d.get('secret') or '')"); KID=$(echo "$KEY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id') or d.get('key_id') or '')")
run() { # name, then curl args
  local name=$1; shift
  for i in $(seq 1 20); do curl -s "${R[@]}" -m 60 -o /dev/null -w "%{http_code} %{time_connect} %{time_appconnect} %{time_total}\n" "$@"; done |
    python3 -c "
import sys
rows=[l.split() for l in sys.stdin if l.strip()]
ok=sum(r[0].startswith('2') for r in rows)
def q(col):
    v=sorted(float(r[col]) for r in rows); n=len(v)
    return 'p50 %.2f p95 %.2f max %.2f'%(v[n//2], v[min(n-1,int(n*0.95))], v[-1])
print('%-26s ok %d/%d | connect %s | tls %s | total %s'%('$name',ok,len(rows),q(1),q(2),q(3)))"
}
echo "== $mode $B"
run health "$B/health"
run me "$B/me" -H "Authorization: Bearer $T" -H "$O"
run follows "$B/follows" -H "Authorization: Bearer $T" -H "$O"
run "v1 me" "$B/v1/me" -H "Authorization: Bearer $K"
run "v1 T.Rowe holdings latest" "$B/v1/filers/price-t-rowe-associates-inc-md/holdings/latest" -H "Authorization: Bearer $K"
echo "-- 10-way concurrent /me"
for i in $(seq 1 10); do curl -s "${R[@]}" -m 60 -o /dev/null -w "%{http_code} %{time_appconnect} %{time_total}\n" "$B/me" -H "Authorization: Bearer $T" -H "$O" & done | sort -k3 -n | awk '{s=s" "$3"s"} END{print "burst totals:"s}'
wait
[ -n "$KID" ] && curl -s "${R[@]}" -m 60 -o /dev/null -X DELETE "$B/keys/$KID" -H "Authorization: Bearer $P" -H "$O"
