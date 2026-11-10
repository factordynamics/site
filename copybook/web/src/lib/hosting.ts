// Where Copybook runs and how member data is protected, in one place for /security/, /privacy/, /for-funds/
// and /speed/. Facts confirmed by the operator on Nov 9, 2026 (copybook/api/HOSTING.md has the mechanics).
// Change a line here when a fact changes, such as the off-site backup's first restore test or the
// operator-read log; every page follows.

export const HOSTING = {
  /** Where the member API runs. */
  api: 'Copybook’s member API runs on a single dedicated machine in the United States operated by Factor Dynamics. It isn’t in a data centre: it’s on a residential connection, reached through Cloudflare Tunnel, with Tailscale as a backup route.',
  /** Everything else: alerts, files, payments. */
  files: 'Filing alerts are sent by a Cloudflare Workers job that checks EDGAR every minute, with that machine as its backup. Paid history files and the public alert-latency log are stored in Cloudflare R2. The website and public 13F data are static files served by GitHub Pages. Payments are handled entirely by Stripe.',
  /** What the two hosts share, and how. */
  sync: 'To keep our two servers in step, member records (email), names (your owned and watched tickers, i.e. your book) and follows, and chat channel settings are copied to a private Cloudflare R2 bucket, encrypted at rest by Cloudflare (AES-256). Channel settings include Slack and Discord webhook URLs, which work as credentials. Public access is off.',
  encryption: 'All traffic to the site and the API uses TLS. The machine’s disk is fully encrypted (LUKS); that protects a powered-off or stolen disk, not a running system. Data in Cloudflare R2 and in Stripe is encrypted at rest by those providers.',
  access: 'Only the operator and the AI agents that maintain Copybook can access member data. There is no public SSH. Copybook is maintained by AI coding agents running on Amp (ampcode.com) under the founder’s accounts. They can change and deploy the API and hold its operating credentials, so they have technical access to member data. Their checks use test members and member counts. Every agent action is recorded in a session log the founder can review. Off-site backups are encrypted, though the agents currently hold the key. Requests sent through Amp’s own model connections run under its Minimal Data Retention (MDR) terms: “Under MDR, model providers retain ordinary prompts and responses only as long as needed to return a response.” The exceptions are safety and abuse monitoring data; “up to 30 days when specified” for certain models or features; cached computational artifacts such as key/value tensors, without the original prompt text; and data required by law, a court order or regulation. Most agent requests currently run through the founder’s personal Anthropic (Claude) subscription linked to Amp, and some may run through a personal SpaceXAI (Grok) subscription. These go under each provider’s consumer terms, not Amp’s MDR. Anthropic retains consumer data for 30 days when training is off and up to 5 years when it’s on. We’ll publish our training setting, with its date, once confirmed. Amp stores the agents’ session logs (prompts, tool output, attachments) on Google Cloud in the US, encrypted at rest, until deleted. MDR doesn’t cover this storage. Amp’s subprocessors are listed at ampcode.com/security.',
  physical: 'The machine is at the operator’s residence, not on a UPS or a second internet link. If our API host goes down, filing alerts continue from a second host (Cloudflare). Member access can be moved to a standby within about 30 minutes, or rebuilt from encrypted backups on new hardware within a few hours. Not yet rehearsed: rehearsals are scheduled this week, and this line will show measured times.',
  deletion: 'Deleted data stays in encrypted backups for up to 30 days, then is gone.',
  backups: 'Nightly encrypted off-site backup to Cloudflare R2, kept 30 days, with weekly restore tests. Hourly local snapshots (unencrypted on the host machine; being changed to encrypted).',
  logging: 'API requests are logged without member identity. Per-member access logging is not yet in place.',
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
  ['The API machine is down for longer', 'Member access can be moved to a standby within about 30 minutes, or rebuilt from encrypted backups on new hardware within a few hours. Not yet rehearsed: rehearsals are scheduled this week, and these times will be replaced with measured ones.'],
  ['Both are down', 'Nothing is sent. Filings found afterwards still go out, marked late, or in the digest under “Earlier filings you may have missed”.'],
]

// Newest first, in UTC. Every incident that made member pages or alerts unavailable or slow.
export const INCIDENTS: [string, string][] = [
  ['Nov 9, 2026 · 05:31–05:33 UTC', 'A failed deploy of the API, rolled back. No alerts were missed.'],
  ['Nov 9, 2026 · 05:01–05:28 UTC', 'Member pages and the API were slow or unavailable: network saturation on the API machine. No alerts were missed.'],
  ['Nov 9, 2026 · 03:54–05:01 UTC', 'Member pages (account, My book) and the API were unavailable: the API hit Cloudflare’s daily request quota. The API moved to a dedicated machine. No alerts were missed.'],
]
