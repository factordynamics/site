// Where Copybook runs and how member data is protected, in one place for /security/, /privacy/, /for-funds/
// and /speed/. Facts confirmed by the operator on Nov 9, 2026 (copybook/api/HOSTING.md has the mechanics).
// Change a line here when a fact changes, such as the off-site backup's first restore test or the
// operator-read log; every page follows.

export const HOSTING = {
  /** Where the member API runs. */
  api: 'Copybook’s member API runs on a single machine in the United States operated by Factor Dynamics. It isn’t in a data centre: it’s on a residential connection, reached through a temporary Cloudflare quick tunnel while we move the API to its own hostname (api.factordynamics.com), with Tailscale as a backup route.',
  /** Everything else: alerts, files, payments. */
  files: 'Filing alerts are sent by a Cloudflare Workers job that checks EDGAR every minute, with that machine as its backup. Paid history files and the public alert-latency log are stored in Cloudflare R2. The website and public 13F data are static files served by GitHub Pages. Payments are handled entirely by Stripe.',
  /** What the two hosts share, and how. */
  sync: 'To keep our two servers in step, member records (email), names (your owned and watched tickers, i.e. your book) and follows, and chat channel settings are copied to a private Cloudflare R2 bucket, encrypted at rest by Cloudflare (AES-256). Channel settings include Slack and Discord webhook URLs, which work as credentials. Public access is off.',
  encryption: 'All traffic to the site and the API uses TLS. The machine’s disk is fully encrypted (LUKS); that protects a powered-off or stolen disk, not a running system. Data in Cloudflare R2 and in Stripe is encrypted at rest by those providers.',
  access: 'Member data is kept out of agent sessions: our maintenance tools show agents counts and row IDs, not member emails, holdings or watchlists, and reads of a member’s book are logged. From Nov 17 the API runs under its own account, and member data will be unreadable to the agents’ account. From Nov 17, member data, secrets and backup keys sit under a separate service account that the maintenance agents’ account can’t read, and the session and payment signing secrets are rotated. Limits we want you to know: code we deploy to the API can read member data, and deploys happen without per-deploy founder review (every deploy is logged on /status/ with its build); the websites deploy on every push; the agents share the machine’s main user account, so isolation stops accidental reads, not a deliberately malicious agent; agent session logs from before Nov 11 keep what agents saw then; and the agents’ payment key can read customer records, which billing support needs. A per-deploy approval switch exists for a future plan that holds non-public positions. The founder has not yet confirmed the model provider’s training setting; until it is published here with a date, assume it may be on. That is why member data stays out of agent sessions. Only the operator and the AI agents that maintain Copybook can access member data. There is no public SSH. Copybook is maintained by AI coding agents running on Amp (ampcode.com) under the founder’s accounts. They can change and deploy the API and hold its operating credentials, so they have technical access to member data. Their checks use test members and member counts. Every agent action is recorded in a session log the founder can review. Backups are encrypted, though the agents currently hold the key. Requests sent through Amp’s own model connections run under its Minimal Data Retention (MDR) terms: “Under MDR, model providers retain ordinary prompts and responses only as long as needed to return a response.” The exceptions are safety and abuse monitoring data; “up to 30 days when specified” for certain models or features; cached computational artifacts such as key/value tensors, without the original prompt text; and data required by law, a court order or regulation. Some models and features are not eligible for MDR. Most agent requests currently run through the founder’s personal Anthropic (Claude) subscription linked to Amp, and some may run through a personal SpaceXAI (Grok) subscription. These go under each provider’s consumer terms, not Amp’s MDR. Anthropic retains consumer data for 30 days when training is off and up to 5 years when it’s on. Amp stores the agents’ session logs (prompts, tool output, attachments) on Google Cloud in the US, encrypted at rest, until deleted. MDR doesn’t cover this storage. Amp’s subprocessors are listed at ampcode.com/security.',
  physical: 'The machine is at the operator’s residence, not on a UPS or a second internet link. If our API host goes down, filing alerts continue from a second host (Cloudflare). Member access can be moved to a standby within about 30 minutes (not yet rehearsed; the rehearsal is scheduled for Nov 11, and this line will then show measured times). Rebuilding the member API on another machine from the nightly encrypted backup was rehearsed on 10 Nov 2026: the restore itself takes about 7 minutes (433 s, all 19 end-to-end checks passed), and about 30–60 minutes end to end once a machine is available.',
  /** What else runs on the API machine. Deliberately generic: no list of the other software (lead, Nov 11). */
  shared: 'The API runs on a personal machine, under an account shared with other software, which can technically read the API’s data files (including member books, peer lists, emails and chat webhook URLs). A dedicated service account is planned for Nov 17.',
  deletion: 'Deleted data stays in encrypted backups for up to 30 days, then is gone.',
  backups: 'Nightly encrypted off-site backup to Cloudflare R2, kept 30 days, with weekly restore tests. Hourly local snapshots, encrypted with the same key as nightly backups (the agents currently hold the key).',
  logging: 'Every operator and /ops/ read of member data is logged with who, when, the route and the row ID; the operator header can’t be spoofed. Not covered until Nov 17: direct reads of the data store from a shell on the machine.',
  availability: 'There is no uptime SLA. Alerts are polled from Cloudflare, with the API machine as backup, so they keep going out when the machine is down. The tunnel to the machine is supervised: restarted on failure, health-checked every minute, and the operator is alerted after 2 minutes down.',
  soc2: 'We don’t have SOC 2. A security questionnaire is available on request.',
}

/** Every company that processes data for Copybook, and what for. */
export const SUBPROCESSORS: [string, string][] = [
  ['Cloudflare', 'Workers runs the minute-by-minute EDGAR checks and alert sending; R2 stores paid history files, the alert-latency log, the account sync between servers and the encrypted nightly backup; Cloudflare Tunnel relays traffic to the API machine; Web Analytics counts page views without cookies.'],
  ['GitHub', 'GitHub Pages serves the website and the public 13F data files.'],
  ['Stripe', 'Payments, invoices and the billing portal. Card details go straight to Stripe.'],
  ['Tailscale', 'A backup route to the API machine.'],
  ['Resend', 'Delivers alert, digest and sign-in emails.'],
  ['OpenFIGI', 'Maps CUSIPs to tickers. It receives only security identifiers, never member data.'],
  ['Amp (AI coding agents, maintenance only) and the model providers listed on ampcode.com/security', 'The agents maintain and deploy the API and hold its operating credentials, so they have technical access to member data. Requests through Amp’s own model connections run under its Minimal Data Retention terms; the exceptions are listed under Who can see member data on the security page.'],
  ['Anthropic and SpaceXAI, via personal subscriptions (consumer terms)', 'Most agent requests currently run through the founder’s personal Anthropic (Claude) subscription linked to Amp, and some may run through a personal SpaceXAI (Grok) subscription. These go under each provider’s consumer terms, not Amp’s MDR.'],
  ['Amp thread storage (Google Cloud, US)', 'Amp stores the agents’ session logs (prompts, tool output, attachments) on Google Cloud in the US, encrypted at rest, until deleted. MDR doesn’t cover this storage.'],
]

/** What happens to alerts and member pages when part of the system is down (HOSTING.md, "What happens when"). */
export const OUTAGES: [string, string][] = [
  ['The API machine restarts, hangs or goes offline', 'Alerts are unaffected: they’re checked and sent from Cloudflare. Member pages and the API come back when the machine does; a restart takes about 10 seconds, and a hung server is restarted automatically within about 4 minutes.'],
  ['Cloudflare’s EDGAR checks stop', 'The API machine starts checking EDGAR 10 minutes after Cloudflare’s last run and hands back within a minute of Cloudflare’s return. Alerts are about 10 minutes late, and never sent twice.'],
  ['The API machine is down for longer', 'Member access can be moved to a standby within about 30 minutes (not yet rehearsed; the rehearsal is scheduled for Nov 11, and this line will then show measured times). Rebuilding the member API on another machine from the nightly encrypted backup was rehearsed on 10 Nov 2026: the restore itself takes about 7 minutes (433 s, all 19 end-to-end checks passed), and about 30–60 minutes end to end once a machine is available.'],
  ['Both are down', 'Nothing is sent. Filings found afterwards still go out, marked late, or in the digest under “Earlier filings you may have missed”.'],
]

// Newest first, in UTC. Every incident that made member pages or alerts unavailable or slow.
/** Where the API host is going (no date until the DNS move). */
export const HOST_MOVE = 'The API host will move to api.factordynamics.com. Key holders get email and a changelog entry at least 7 days before the old host stops working.'
/** What the incident list counts. */
/** /status/ Data section: which alerts each data error reached, by methodology changelog id (payments' records, Nov 11). */
export const DATA_ALERTS_NOTE = 'Alert records start Nov 8 (the daily store) and Nov 9 (per-member delivery); earlier alerts are “not recorded”. No paying members so far: every recipient below is a test or internal member, and no correction email went to anyone.'
export const DATA_ALERTS: Record<string, string> = {
  '2026-11-11-holder-weights': 'None: alerts don’t use holder lists.',
  '2026-11-11-amundi-merged-book': 'None since Nov 8 (no Amundi 13F alert); earlier not recorded.',
  '2026-11-11-split-rows': 'Yes, by a separate bug in the alert email: see “13F alert moves didn’t adjust for stock splits” above.',
  '2026-11-11-all-filer-stall': 'None: alerts read EDGAR directly.',
  '2026-11-09-refiled-amendments': 'No wrong figure found in the Mizuho Securities (Nov 9, 1 test member) and McLennan (Nov 10) alerts. McLennan’s showed XOM and OKE as a new position plus an exit because of CUSIP changes, fixed Nov 11. Not told.',
  '2026-11-09-combined-filers': 'None: Ackman hasn’t filed Q3.',
  '2026-11-09-split-counts': 'None: site Flow only.',
  '2026-11-08-ticker-incident': 'At most a missing ticker, never a wrong figure. Which alerts fell in the window: not recorded.',
  '2026-11-08-stock-splits': 'Fund pages were fixed Nov 8; the alert email kept the error until Nov 11: see “13F alert moves didn’t adjust for stock splits” above.',
  '2026-11-08-successor-baseline': 'None: that quarter predates alerts.',
  '2026-11-08-placeholder-cusips': 'None since Nov 8 (no AGX or Loeb event); earlier not recorded.',
  '2026-11-08-share-class-comparisons': 'None: the Lennar filings predate alerts.',
}
/** Data errors outside ingest's changelog (API bugs), written by hand for /status/'s Data list. */
export const DATA_MANUAL: { id: string; date: string; kind: 'correction' | 'incident'; title: string; body: string; affected: string }[] = [
  {
    id: 'alert-split-factors',
    date: '2026-11-11',
    kind: 'correction',
    title: '13F alert moves didn’t adjust for stock splits',
    body: 'Until Nov 11, the 13F alert email compared a filer’s shares with the prior quarter’s shares as filed. It ignored the split factors that fund pages and /v1 apply, so a name that split in Q3 and was held in both quarters read as a buy, or as a smaller sell. Example: Jensen’s APH (2-for-1) read “added +$36.5M”; it was a trim of 181,834 shares, about −$15.3M. Alerts now use the same split factors as fund pages and /v1 (data/splits.json).',
    affected:
      '10 of the 23 13F alerts sent this season. A wrong row shown: ICICI Prudential (Nov 6) APH +$5.0M, should be +$4.1M, with CRWD in the totals; Mizuho Securities USA (Nov 9) CRWD +$14.6M, should be about +$0.8M, totals off about $24M; FMR (Nov 10) CRWD +$8.55B, should be about +$2.32B, with 11 more split names off the totals by about $13.8B; Jensen (Nov 10) APH “added +$36.5M”, a trim of about −$15.3M. Bought and sold totals only, estimated from the corrected books: Acadian (Nov 9) about $203M, Boston Partners (Nov 10) about $24M, Baillie Gifford (Nov 9) about $5M, Comgest (Nov 9) about $2M, Mizuho Markets Americas (Nov 9) about $0.4M. Also test replays (Fisher twice, FMR once). Recipients: 5 test or internal inboxes, 0 paying members; ICICI’s recipients aren’t recorded. No one was emailed a correction; this entry is the notice.',
  },
]
/** Shown on /status/ while it applies. */
export const DEPLOY_FREEZE = { until: '2026-11-17T03:00:00Z', text: 'Deploy freeze Nov 12–16 during EDGAR hours (6am–10pm ET), except urgent fixes.' }
/** Standing deploy policy, shown on /status/. */
export const DEPLOY_POLICY = 'Every 13F deadline week (Feb, May, Aug, Nov): urgent fixes only, 6am–10pm ET on weekdays. Otherwise deploys are batched.'
export const INCIDENT_RULE = 'Listed: unplanned outages and slowdowns over 1 minute that affected member pages, the API or alerts. Deploy restarts under 60 seconds aren’t listed.'
/** [when, what, optional link to the affected alerts]. */
export const INCIDENTS: [string, string, string?][] = [
  ['Nov 9–10, 2026 · 13F moves delayed by hours', 'For six 13F filings (FMR, Vulcan, Boston Partners, Westwood, Wilkinson and Acadian), alerts with the filing’s moves arrived hours late: median 2h24m after the filing, slowest 9h39m. Members following the fund got an early alert, then its moves late; members matched only through a stock they own or watch got no early alert, so their single alert, with the moves, was late outright. Cause: the holdings tables were too big for the Cloudflare Worker to compare, or the fund’s prior book was missing on Cloudflare. Fixed Nov 11 at 00:01 UTC: the API machine now computes moves automatically. No paying members: Boston Partners went to 3 test members and the internal probe, the rest to the probe only. Not told by email.', '/speed/#before-fix'],
  ['Nov 9, 2026 · 08:15–09:29 UTC', 'The API was slow and briefly unavailable (restarted six times between 08:17 and 08:46) because an unrelated job on the same machine saturated its disk. 12 member and API requests reached the API during the window; requests that arrived during a restart failed and weren’t logged. Alerts were not affected (Cloudflare’s poller sends them). Fix: no bulk disk jobs on the host on deadline days, and the watchdog no longer restarts the API while the disk is saturated.'],
  ['Nov 9, 2026 · 05:41–05:48 UTC', 'Holders and /v1 holders returned 503 “busy” on both hosts. Other pages and alerts were not affected.'],
  ['Nov 9, 2026 · 05:31–05:33 UTC', 'A failed deploy of the API, rolled back. No alerts were missed.'],
  ['Nov 9, 2026 · 05:01–05:28 UTC', 'Member pages and the API were slow or unavailable: network saturation on the API machine. No alerts were missed.'],
  ['Nov 9, 2026 · 03:54–05:01 UTC', 'Member pages (account, My book) and the API were unavailable: the API hit Cloudflare’s daily request quota. The API moved off Cloudflare to the machine it runs on now. No alerts were missed.'],
]
