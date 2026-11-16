// Public SEC EDGAR data published by Copybook's ingest, read straight from its static hosts (GitHub Pages,
// CORS open). Holdterm only reads it; src/data.ts keeps the roster and runs the data checks.
export const DATA = 'https://refcell.github.io/gust/copybook/data/'
// Stock pages derived from the same 13F books (d/stocks/{TICKER}.json, d/stocks.json).
export const DERIVED = 'https://copybook.factordynamics.com/d/'
export const SITE = 'https://holdterm.factordynamics.com'

// Paid email alerts: Stripe Payment Links and the alerts API. While a link is empty the
// subscribe button shows that checkout is opening soon instead of linking anywhere.
export const checkout = {
  monthly: 'https://buy.stripe.com/eVq5kD4pw3Hsf4edrwgjC06',
  yearly: 'https://buy.stripe.com/7sY6oH7BI91M5tEgDIgjC07',
  // Stripe billing portal login (Holdterm's own configuration): manage or cancel without signing in here.
  portal: 'https://billing.stripe.com/p/login/7sYeVd1dkguecW6gDIgjC01',
}
// Shared alerts API (Holdterm members are plan "holdterm": alerts and follows only). Always the Cloudflare Worker's
// stable name, as on Copybook (c5ed8ee): the Worker answers from gene or fails over itself, so no page names a machine
// or tunnel host (the lead, Nov 12) and a quick-tunnel restart needs no redeploy. api.json is the Worker's own routing
// pointer, not read here. A tester can pin one browser with localStorage['holdterm-api'] = 'https://…' (no URL
// parameter, so a link can't send a token elsewhere).
const BUILD_API = 'https://copybook-api.factordynamics.workers.dev'
const apiOverride = (() => {
  try {
    const v = localStorage.getItem('holdterm-api')
    return v && /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(v) ? v.replace(/\/$/, '') : null
  } catch {
    return null
  }
})()
/** The API base in use. */
export const api: string = apiOverride ?? BUILD_API
/** Resolves with the API base (kept so callers that await it need no change). */
export const apiReady: Promise<string> = Promise.resolve(api)
/** After a network-level failure: the base never moves, so there is nothing to re-read. */
export async function rereadApi(): Promise<boolean> {
  return false
}

export const price = { monthly: 3, yearly: 29, trialDays: 7 }
// Delivery channels besides email, switched on as the alerts API ships them for Holdterm members.
export const channels = { chat: false, push: false }
