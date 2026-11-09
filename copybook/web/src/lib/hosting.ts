import { api } from '../config'

// Where Copybook runs, in one place for /security/, /privacy/ and /for-funds/. The wording follows the API
// base the site is built with (api.config.mjs), so moving the API back to Cloudflare Workers changes every
// page with the same one-line switch. Location, disk encryption, access and backup details for the
// self-hosted server are added here once they're confirmed, not before.
const selfHosted = !/workers\.dev/.test(api)

export const HOSTING = {
  /** Who runs the member API and where account data is kept. */
  api: selfHosted
    ? 'The member API runs on a dedicated server operated by Factor Dynamics. Traffic to it is relayed by Tailscale (Tailscale Funnel) over TLS. Account data (members, follows, owned and watched stocks, alert settings, API keys) is stored by the API on that server.'
    : 'The member API runs on Cloudflare Workers. Account data (members, follows, owned and watched stocks, alert settings, API keys) is stored in Cloudflare Workers KV.',
  /** Data files: the public site and 13F data, and paid history files. */
  files: 'The website and public 13F data are static files on GitHub Pages. Paid history files and the public alert-latency log are stored in Cloudflare R2. Payments are handled entirely by Stripe.',
  encryption: selfHosted
    ? 'All traffic to the site and the API uses TLS. Data in Cloudflare R2 and in Stripe is encrypted at rest. Details on the API server’s disk encryption, access and backups are available on request while we document them here.'
    : 'All traffic to the site and the API uses TLS. Data in Cloudflare Workers KV and R2, and in Stripe, is encrypted at rest.',
  soc2: 'We don’t have SOC 2. A security questionnaire answer is available on request.',
}

/** Every company that processes member data for Copybook, and what for. */
export const SUBPROCESSORS: [string, string][] = [
  selfHosted ? ['Tailscale', 'Relays traffic to the member API server (TLS).'] : ['Cloudflare Workers', 'Runs the member API and stores account data (Workers KV).'],
  ['Cloudflare', 'R2 storage for paid history files and the alert-latency log.'],
  ['GitHub', 'GitHub Pages hosts the website and the public 13F data files.'],
  ['Stripe', 'Payments, invoices and the billing portal. Card details go straight to Stripe.'],
  ['Resend', 'Delivers alert, digest and sign-in emails.'],
  ['OpenFIGI', 'Maps CUSIPs to tickers. It receives only security identifiers, never member data.'],
]
