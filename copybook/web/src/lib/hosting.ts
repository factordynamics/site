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
  /** Who can see member data, in the four parts /security/ shows as subsections (one tense each). */
  accessParts: [
    ['Today', 'Member data is kept out of agent sessions: our maintenance tools show agents counts and row IDs, not member emails, holdings or watchlists, and reads of a member’s book are logged. Only the operator and the AI agents that maintain Copybook can access member data. There is no public SSH. Copybook is maintained by AI coding agents running on Amp (ampcode.com) under the founder’s accounts. They can change and deploy the API and hold its operating credentials, so they have technical access to member data. Their checks use test members and member counts. Every agent action is recorded in a session log the founder can review. Backups are encrypted, though the agents currently hold the key.'],
    ['From Nov 17', 'The API will run under its own service account. Member data and secrets will sit under it, where the maintenance agents’ account can’t read them, and the session and payment signing secrets will be rotated. The agents’ payment key will be a restricted key scoped to billing support. The maintenance agents will run under the machine’s main user account, which will be able to act as administrator only with the founder’s password, typed for each use with nothing cached; the commands it may run without a password read no files.'],
    ['Limits', 'Code we deploy to the API can read member data, and deploys happen without per-deploy founder review (every deploy is logged on /status/ with its build); the websites deploy on every push; agent session logs from before Nov 11 keep what agents saw then; and the agents’ payment key can read customer records, which billing support needs. A per-deploy approval switch exists for a future plan that holds non-public positions. A deliberately malicious agent could capture the founder’s administrator password as it is typed, so the account isolation protects against accidental access, not against a deliberately malicious agent. If the founder is unreachable for a week: Cloudflare keeps checking EDGAR and sending alerts, and the API keeps serving members from our self-hosted machine while it is up. If that machine goes offline, our AI agents can move members to the Cloudflare backup within minutes, with accounts as of about a minute before (up to 100,000 requests a day); no step needs him. What waits for him: bringing the machine back if it is powered off or broken, and any restore from a backup, because from Nov 17 only he holds the backup key.'],
    ['AI providers', 'The founder has not yet confirmed the model provider’s training setting; until it is published here with a date, assume it may be on. That is why member data stays out of agent sessions. Requests sent through Amp’s own model connections run under its Minimal Data Retention (MDR) terms: “Under MDR, model providers retain ordinary prompts and responses only as long as needed to return a response.” The exceptions are safety and abuse monitoring data; “up to 30 days when specified” for certain models or features; cached computational artifacts such as key/value tensors, without the original prompt text; and data required by law, a court order or regulation. Some models and features are not eligible for MDR. Most agent requests currently run through the founder’s personal Anthropic (Claude) subscription linked to Amp, and some may run through a personal SpaceXAI (Grok) subscription. These go under each provider’s consumer terms, not Amp’s MDR. Anthropic retains consumer data for 30 days when training is off and up to 5 years when it’s on. Amp stores the agents’ session logs (prompts, tool output, attachments) on Google Cloud in the US, encrypted at rest, until deleted. MDR doesn’t cover this storage. Amp’s subprocessors are listed at ampcode.com/security.'],
  ] as [string, string][],
  physical: 'The machine is at the operator’s residence, not on a UPS or a second internet link. If our API host goes down, filing alerts continue from a second host (Cloudflare). Member access can be moved to a standby within about 30 minutes (not yet rehearsed; the rehearsal is scheduled for Nov 11, and this line will then show measured times). Rebuilding the member API on another machine from the nightly encrypted backup was rehearsed on 10 Nov 2026: the restore itself takes about 7 minutes (433 s, all 19 end-to-end checks passed), and about 30–60 minutes end to end once a machine is available. From Nov 17 a restore from backup needs the founder, who alone holds the backup key.',
  /** What else runs on the API machine. Deliberately generic: no list of the other software (lead, Nov 11). */
  shared: 'The API runs on a personal machine, under an account shared with other software, which can technically read the API’s data files (including member books, peer lists, emails and chat webhook URLs). A dedicated service account is planned for Nov 17.',
  deletion: 'Deleted data stays in encrypted backups for up to 30 days, then is gone.',
  backups: 'Nightly encrypted off-site backup to Cloudflare R2, kept 30 days. Hourly local snapshots, encrypted with the same key as nightly backups. From November 17, backups are encrypted to a key whose private half is kept offline by the founder, on a passphrase-protected USB drive, not on our server. The server holds only the public key, so neither the Copybook service nor code deployed to it can decrypt a backup. Every week an automated check confirms each backup without the key: its checksum and size match the record made when it was taken, it is a correctly formed encrypted file for the current key, the newest is under 30 hours old, and its member and record counts are plausible. Once a month the founder decrypts the newest backup in a test restore, so for about a minute during that test the key is in memory on the server. Restoring from a backup always needs the founder. Until November 17 the maintenance agents also hold the backup key, so they can recover the service on their own during launch week.',
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
  ['The API machine is down for longer', 'Member access can be moved to a standby within about 30 minutes (not yet rehearsed; the rehearsal is scheduled for Nov 11, and this line will then show measured times). Rebuilding the member API on another machine from the nightly encrypted backup was rehearsed on 10 Nov 2026: the restore itself takes about 7 minutes (433 s, all 19 end-to-end checks passed), and about 30–60 minutes end to end once a machine is available. From Nov 17 a restore from backup needs the founder, who alone holds the backup key.'],
  ['Both are down', 'Nothing is sent. Filings found afterwards still go out, marked late, or in the digest under “Earlier filings you may have missed”.'],
]

// Newest first, in UTC. Every incident that made member pages or alerts unavailable or slow.
/** Where the API host is going (no date until the DNS move). */
export const HOST_MOVE = 'The API host will move to api.factordynamics.com. Key holders get email and a changelog entry at least 7 days before the old host stops working.'
/** What the incident list counts. */
/** /status/ Data section: which alerts each data error reached, by methodology changelog id (payments' records, Nov 11).
 *  A methodology entry listed here (a reclassification) also shows in the Data list. */
export const DATA_ALERTS_NOTE = 'Alert records start Nov 8 (the daily store) and Nov 9 (per-member delivery); earlier alerts are “not recorded”. Every recipient so far was a test or internal inbox, and no correction email went to anyone.'
export const DATA_ALERTS: Record<string, string> = {
  '2026-11-11-wealth-shape-published': 'None so far (no 13F has been accepted since the change). From now on, 3 tracked funds retyped from long-only to wealth (Gabelli & Co Investment Advisers, Robert Olstein, Advent Capital) alert only their followers, not members who just watch a stock they trade.',
  '2026-11-11-filer-types-without-adv': 'None: EDGAR accepted no 13F between 03:45 and 06:36 UTC on Nov 11 (it doesn’t accept filings from 22:00 to 06:00 ET), so no alert was decided on the misread types. Every type in use when the next 13F arrives comes from the corrected data.',
  '2026-11-11-hedge-fund-adv': 'None: EDGAR accepted no 13F between the reclass (02:31 UTC Nov 11) and its check. From now on, a filer moved from hedge_fund to wealth or other alerts only its followers, like every wealth and other filer.',
  '2026-11-11-row-provenance-suspect-units': 'None: alerts don’t read these fields.',
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
    id: 'alert-long-only-stock-match',
    date: '2026-11-11',
    kind: 'correction',
    title: 'Long-only funds’ 13Fs didn’t alert members watching their stocks',
    body: 'Nov 9 – Nov 11, 06:36 UTC: 16 long-only funds’ Q3 13Fs (e.g. Baillie Gifford, FMR, First Eagle, Davis) didn’t alert members who watch a stock they traded without following the fund. A data field was renamed (active → long_only) and the alert filter still read the old name. Fixed Nov 11; a contract check now blocks deploys and data publishes if a field alerts depend on is renamed or missing.',
    affected: 'Yes: those 16 filings’ alerts to members who watch a traded stock without following the fund. Members who follow those funds were unaffected. Only test inboxes were affected; the alerts weren’t re-sent, and the filings appear in Friday’s email.',
  },
  {
    id: 'alert-bond-priors',
    date: '2026-11-11',
    kind: 'correction',
    title: 'Advent’s 13F alert sized bond lines from zero',
    body: 'Two 13F alerts showed wrong figures; this is the first. Advent Capital Management’s Q3 13F (0001140361-26-042650, Nov 10): five convertible-bond rows were sized as if bought from zero, because the prior quarter stores bonds by principal with a share count of 0. A bond shown as “added +$141.2M” was really +$1.1M, and one shown as “added +$119.7M” was really a trim of −$15.0M. Fixed Nov 11: a bond’s prior count is now its principal, and alerts from then on are checked against the published data within 15 minutes.',
    affected: 'Yes: this one alert, sent before Nov 11 05:00 UTC, so no correction email; this entry is the notice. Every recipient was a test or internal inbox.',
  },
  {
    id: 'alert-option-case',
    date: '2026-11-11',
    kind: 'correction',
    title: 'Mizuho Markets Americas’ SPY options read as exits',
    body: 'Two 13F alerts showed wrong figures; this is the second. Mizuho Markets Americas’ Q3 13F (0001062993-26-005826, Nov 9): the SPY call and put lines said “exited” (−$610.5M and −$63.2M), but both were trimmed (−$58.0M and −$5.9M). EDGAR writes “Call” and the stored prior wrote “CALL”, so the lines didn’t match. Separately, the filer’s own Q2 13F lists the same share count on its stock, call and put SPY lines, so the prior on those lines is the filer’s error. Fixed Nov 11: put and call are matched regardless of case, and alerts from then on are checked against the published data within 15 minutes.',
    affected: 'Yes: this one alert, sent before Nov 11 05:00 UTC, so no correction email; this entry is the notice. Every recipient was a test or internal inbox.',
  },
  {
    id: 'alert-split-factors',
    date: '2026-11-11',
    kind: 'correction',
    title: '13F alert moves didn’t adjust for stock splits',
    body: 'Until Nov 11, the 13F alert email compared a filer’s shares with the prior quarter’s shares as filed. It ignored the split factors that fund pages and /v1 apply, so a name that split in Q3 and was held in both quarters read as a buy, or as a smaller sell. Example: Jensen’s APH (2-for-1) read “added +$36.5M”; it was a trim of 181,834 shares, about −$15.3M. Fixed Nov 11 at 03:33 UTC: alerts now use ingest’s split factors, the same as fund pages and /v1 (data/splits.json).',
    affected:
      'Yes: 9 of the 23 13F alerts sent this season used an unadjusted prior quarter. In 4 the wrong row was in the email: ICICI Prudential (Nov 6) APH +$5.0M, should be +$4.1M, with CRWD in the totals; Mizuho Securities USA (Nov 9) CRWD +$14.6M, should be about +$0.8M, totals off about $24M; FMR (Nov 10) CRWD +$8.55B, should be about +$2.32B, with 11 more split names off the totals by about $13.8B; Jensen (Nov 10) APH “added +$36.5M”, a trim of about −$15.3M. In the other 5 only the bought and sold totals were off, estimated from the corrected books: Acadian (Nov 9) about $203M, Boston Partners (Nov 10) about $24M, Baillie Gifford (Nov 9) about $5M, Comgest (Nov 9) about $2M, Mizuho Markets Americas (Nov 9) about $0.4M. Also test replays (Fisher twice, FMR once). Recipients: 5 test or internal inboxes; ICICI’s recipients aren’t recorded. No one was emailed a correction; this entry is the notice.',
  },
]
/** The API's restart policy, shown above /status/'s restart list. */
export const RESTART_POLICY = 'From Nov 11 03:40 UTC: at most one API restart per hour, and only when its code changes; during the freeze, urgent fixes only.'
/** Shown on /status/ while it applies. */
export const DEPLOY_FREEZE = { until: '2026-11-17T03:00:00Z', text: 'Deploy freeze Nov 12–16 during EDGAR hours (6am–10pm ET), except urgent fixes.' }
/** Standing deploy policy, shown on /status/. */
export const DEPLOY_POLICY = 'Every 13F deadline week (Feb, May, Aug, Nov): urgent fixes only, 6am–10pm ET on weekdays. Otherwise deploys are batched.'
export const INCIDENT_RULE = 'Listed: unplanned outages and slowdowns over 1 minute that affected member pages, the API or alerts. Deploy restarts under 60 seconds aren’t listed.'
/** [when, what, optional link to the affected alerts]. */
export const INCIDENTS: [string, string, string?][] = [
  ['Nov 10 23:48 – Nov 11 04:44 UTC', 'On current Chrome, clicking an in-site link showed a blank page until reload; first loads and older browsers were fine. Cause: the 23:48 site update treated the browser’s answer to “scroll to the top” as a cleanup step, and current Chrome answers with something that isn’t one, so the next page change crashed. Fixed Nov 11 at 04:44 UTC; every site deploy now opens the site in current Chrome, clicks through Season, Security, Pricing and a fund page and back, and stops on a blank page or page error. Alerts affected: none.'],
  ['Nov 9–10, 2026 · 13F moves delayed by hours', 'For six 13F filings (FMR, Vulcan, Boston Partners, Westwood, Wilkinson and Acadian), alerts with the filing’s moves arrived hours late: median 2h24m after the filing, slowest 9h39m. Members following the fund got an early alert, then its moves late; members matched only through a stock they own or watch got no early alert, so their single alert, with the moves, was late outright. Cause: the holdings tables were too big for the Cloudflare Worker to compare, or the fund’s prior book was missing on Cloudflare. Fixed Nov 11 at 00:01 UTC: the API machine now computes moves automatically. Every recipient was a test or internal inbox: Boston Partners went to 3 test members and the internal probe, the rest to the probe only. Not told by email.', '/speed/#before-fix'],
  ['Nov 9, 2026 · 08:15–09:29 UTC', 'The API was slow and briefly unavailable (restarted six times between 08:17 and 08:46) because an unrelated job on the same machine saturated its disk. 12 member and API requests reached the API during the window; requests that arrived during a restart failed and weren’t logged. Alerts were not affected (Cloudflare’s poller sends them). Fix: no bulk disk jobs on the host on deadline days, and the watchdog no longer restarts the API while the disk is saturated.'],
  ['Nov 9, 2026 · 05:41–05:48 UTC', 'Holders and /v1 holders returned 503 “busy” on both hosts. Other pages and alerts were not affected.'],
  ['Nov 9, 2026 · 05:31–05:33 UTC', 'A failed deploy of the API, rolled back. No alerts were missed.'],
  ['Nov 9, 2026 · 05:01–05:28 UTC', 'Member pages and the API were slow or unavailable: network saturation on the API machine. No alerts were missed.'],
  ['Nov 9, 2026 · 03:54–05:01 UTC', 'Member pages (account, My book) and the API were unavailable: the API hit Cloudflare’s daily request quota. The API moved off Cloudflare to the machine it runs on now. No alerts were missed.'],
]
