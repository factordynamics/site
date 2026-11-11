#!/usr/bin/env bash
# copybook-r2-push.timer (hourly) and one-off backfills: copies h/ objects that Cloudflare's copybook-history lacks, or
# holds an older version of, from gene's local R2 (ingest uploads to gene only). Never deletes, never overwrites a newer
# Cloudflare object. Capped at 2.5 MB/s (about half gene's uplink), pauses while the member tunnel is slow, and only
# one run at a time (a run in progress makes the next one skip).
set -uo pipefail
ROOT=$HOME/copybook-api
export PATH=$HOME/.local/share/mise/installs/node/26.12.1/bin:$PATH
cd "$ROOT/ops"; set -a; . ../copybook-api.env; . ../secrets.env; set +a
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/copybook-r2-push.lock"
flock -n 9 || { echo "another r2 push is running; skipping"; exit 0; }
RATE_KBPS=${RATE_KBPS:-2500} PROBE_URL="$(cat ../state.api-published)/health?probe=1" exec node --no-warnings r2-push.mjs missing-copy "${1:-h/}"
