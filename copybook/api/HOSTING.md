# Where the Copybook API runs

Two hosts run the same Worker bundle, with one state.

**Cloudflare** (`copybook-api.factordynamics.workers.dev`, free plan) is the **primary poller**.

- Its minute cron runs the EDGAR polls and every scheduled job: digests, revenue emails, the ops digest, webhook retries and `latency.json`.
- Cron invocations don't use the 100k/day request quota.
- `MOVED_TO` is set, so every HTTP request to it 308-redirects to gene. Its cron never fetches its own URL.

**gene** (Andreas's desktop) serves **members, `/v1`, the Stripe webhook and ingest** at `https://gene.tail70ba3.ts.net/copybook/`. It is also the **backup poller**.

- **What runs there:** workerd (Miniflare) as the user systemd service `copybook-api.service`. State lives in `~/copybook-api/state`.
- **Deploys:** pushing to `main` deploys to gene (`copybook-api-update.timer`: fast-forward, vitest, rebuild, restart). Cloudflare needs `npx wrangler deploy`.

## One state, synced through R2 (src/failover.ts, `SYNC = "on"`)

- **What syncs:** each host publishes the KV keys it changed to the `copybook-history` bucket: the values under `sync/{host}/{key}`, plus an index `sync/{host}.json` of key → change time.
  - Cloudflare records what its cron writes.
  - gene diffs its whole KV every minute, because its Durable Objects write KV too.
  - Each minute, each host applies the other's changes, unless it changed the key later itself. Cloudflare applies at most 40 keys a minute, to fit its CPU limit, and carries the rest over.
- **Effect:** a new subscriber, follow, channel or pause on gene reaches Cloudflare's cron within about a minute. The filings the cron handled and sent (handled lists, feeds, the day's digest) reach gene's pages the same way.
- **Not synced:** rate limits, one-use download tokens, caches (`filing:`, `subs13f:`), the job queue, and sync's own state.

## One poller at a time, and never two sends

1. **Heartbeat:** Cloudflare writes `sync/alive-cloudflare.json` every minute.
2. **gene stays backup:** gene polls only when it has read that heartbeat and it is 10 minutes old. If gene can't read it (its link or Cloudflare's API is down), gene stays the backup.
3. **Cloudflare after a gap:** when Cloudflare's own previous run is over 5 minutes old (an outage), it applies gene's changes and skips polling for that minute. Whatever gene sent in the meantime is then marked handled before Cloudflare polls.
4. **One dedupe authority:** before a filing or Form 4 / 13D/G event is sent, the poller claims it. The claim is the R2 object `claims/{accession}` (or `claims/ev/{accession}`), created only if absent (S3 `If-None-Match: *`).
   - The host that loses the claim marks the filing handled and doesn't send it.
   - gene always claims. Cloudflare claims while gene has polled in the last 15 minutes. Otherwise only Cloudflare can be polling, and a claim per filing would use up the free plan's 50 subrequests.
   - If R2 can't be reached, the send goes ahead, because a missed alert is worse than a duplicate.
5. **Tests:** `two pollers` in `test/api.test.ts` covers both pollers seeing the same filing in the same minute (exactly one email), the sync in both directions, gene taking over after 10 minutes and the handback.

**Status:** `/health` shows `poller_host`, `poller_last_run`, `poller_age_s`, `api_host`, `api_up_since` and `api_uptime_s`. The public `latency.json` (`https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/latency.json`) carries `poller_host` and `poller_last_run`, written by whichever host polls.

## What happens when…

| Event | Alerts | Members and /v1 |
| --- | --- | --- |
| gene restarts (deploy, crash) | Unaffected (Cloudflare polls). | Back in about 10 s (systemd). |
| gene hangs | Unaffected. | The watchdog restarts it after two failed `/health` checks, 2 minutes apart. |
| gene reboots, sleeps or loses power | Unaffected. | Down until gene is back. The service starts at boot without a login (linger). Stripe retries webhooks for 3 days. |
| gene loses Funnel or its network | Unaffected. | Unreachable until the link is back. |
| Cloudflare's cron stops | gene starts polling 10 minutes after Cloudflare's last run, and stops within a minute of Cloudflare's return. Alerts are about 10 minutes late, never sent twice. A filing in those minutes still goes out: the poll reads 3 days back, and an old one goes in the digest as an earlier filing. | Unaffected. |
| Both down | Nothing is sent. Filings found later go out marked late, or in the digest's "Earlier filings you may have missed". | Down. |
