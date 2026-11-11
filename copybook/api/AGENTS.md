# copybook/api

## Member data in agent sessions

Agent sessions are logged and kept for 30+ days, so anything printed ends up in a thread.

- Never print or paste member rows: emails, holdings, watchlists, follows, owned names, channel or webhook URLs.
- Debug with counts and row IDs only (`cus_…`, `free_…`), never tickers or hashes of them. Emails show as `a***@domain` (`maskEmail` in src/env.ts).
- Test members (the `test` flag, `copybook-test-` and `copybook-gate-` inboxes, `@fldubai.com`) can be shown in full.
- New operator routes (`/ops/…`) and logs follow the same rule: return counts (`followCounts`) and row IDs.

## Before every push

gene's deployer refuses a build that workerd can't boot and keeps serving the old one. Run `pnpm typecheck`, `npx vitest run` and `scripts/bootcheck.sh` (boots the Worker in local workerd, no Cloudflare traffic; fails on boot errors such as a non-function export from src/index.ts). Batch pushes: each one restarts gene. No restarting pushes Thu, Fri or Mon 13:00-24:00 UTC in filing weeks except P0 fixes.
