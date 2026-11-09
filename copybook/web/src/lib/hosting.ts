// Where Copybook runs and how member data is protected, in one place for /security/, /privacy/, /for-funds/
// and /speed/. Facts confirmed by the operator on Nov 9, 2026 (copybook/api/HOSTING.md has the mechanics).
// Change a line here when a fact changes, such as the off-site backup's first restore test or the
// operator-read log; every page follows.

export const HOSTING = {
  /** Where the member API runs. */
  api: 'Copybook’s member API runs on a single dedicated machine in the United States operated by Factor Dynamics. It isn’t in a data centre: it’s on a residential connection, reached through Cloudflare Tunnel, with Tailscale as a backup route.',
  /** Everything else: alerts, files, payments. */
  files: 'Filing alerts are sent by a Cloudflare Workers job that checks EDGAR every minute, with that machine as its backup. Paid history files and the public alert-latency log are stored in Cloudflare R2. The website and public 13F data are static files served by GitHub Pages. Payments are handled entirely by Stripe.',
  encryption: 'All traffic to the site and the API uses TLS. The machine’s disk is fully encrypted (LUKS); that protects a powered-off or stolen disk, not a running system. Data in Cloudflare R2 and in Stripe is encrypted at rest by those providers.',
  access: 'Only the operator and the operator’s own automation tools, which run on that machine, can access member data. There is no public SSH.',
  backups: 'Hourly local snapshots of the API’s data. An encrypted off-site backup is being set up.',
  logging: 'API requests are logged without member identity. Per-member access logging is not yet in place.',
  availability: 'There is no uptime SLA. Alerts are polled from Cloudflare, with the API machine as backup, so they keep going out when the machine is down.',
  soc2: 'We don’t have SOC 2. A security questionnaire is available on request.',
}

/** Every company that processes data for Copybook, and what for. */
export const SUBPROCESSORS: [string, string][] = [
  ['Cloudflare', 'Workers runs the minute-by-minute EDGAR checks and alert sending; R2 stores paid history files, the alert-latency log and the account sync between servers; Cloudflare Tunnel relays traffic to the API machine; Web Analytics counts page views without cookies.'],
  ['GitHub', 'GitHub Pages serves the website and the public 13F data files.'],
  ['Stripe', 'Payments, invoices and the billing portal. Card details go straight to Stripe.'],
  ['Tailscale', 'A backup route to the API machine.'],
  ['Resend', 'Delivers alert, digest and sign-in emails.'],
  ['OpenFIGI', 'Maps CUSIPs to tickers. It receives only security identifiers, never member data.'],
]

/** What happens to alerts and member pages when part of the system is down (HOSTING.md, "What happens when"). */
export const OUTAGES: [string, string][] = [
  ['The API machine restarts, hangs or goes offline', 'Alerts are unaffected: they’re checked and sent from Cloudflare. Member pages and the API come back when the machine does; a restart takes about 10 seconds, and a hung server is restarted automatically within about 4 minutes.'],
  ['Cloudflare’s EDGAR checks stop', 'The API machine starts checking EDGAR 10 minutes after Cloudflare’s last run and hands back within a minute of Cloudflare’s return. Alerts are about 10 minutes late, and never sent twice.'],
  ['Both are down', 'Nothing is sent. Filings found afterwards still go out, marked late, or in the digest under “Earlier filings you may have missed”.'],
]
