#!/bin/bash
# Boots the Worker in local workerd (no Cloudflare traffic) and checks /health answers.
cd "$(dirname "$0")/.."
WRANGLER_SEND_METRICS=false setsid timeout 90 npx wrangler dev --port 8799 --ip 127.0.0.1 > "${TMPDIR:-/tmp}/copybook-boot.log" 2>&1 &
PID=$!
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8799/health 2>/dev/null)
  [ "$code" != "000" ] && break; sleep 1
done
kill -- -$PID 2>/dev/null; sleep 1
grep -iE "Uncaught|Incorrect type|error" "${TMPDIR:-/tmp}/copybook-boot.log" | head -3
echo "boot: /health $code"
[ "$code" != "000" ] && ! grep -q "Uncaught" "${TMPDIR:-/tmp}/copybook-boot.log"
