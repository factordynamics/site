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
// Shared alerts API (Holdterm members are plan "holdterm": alerts and follows only).
// The build value below is only the fallback (gene's tunnel watcher rewrites it in place). At load the site reads
// the current base from api.json, which the API host rewrites when its tunnel URL changes and failover-a.sh pins
// to the Worker, and remembers the last one it read; the same contract as copybook/web/src/config.ts. Only https
// bases on hosts we run are accepted, since a member's session token is sent there. A tester can pin one browser
// with localStorage['holdterm-api'] = 'https://…' (no URL parameter, so a link can't send a token elsewhere).
const BUILD_API = 'https://solid-amanda-dir-fiction.trycloudflare.com/copybook'
export const API_JSON_URL = 'https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/api.json'
const okBase = (v: unknown): string | null =>
  typeof v === 'string' && /^https:\/\/(([a-z0-9-]+\.)+(trycloudflare\.com|factordynamics\.com)|gene\.tail70ba3\.ts\.net|copybook-api\.factordynamics\.workers\.dev)(\/[^\s?#]*)?$/i.test(v) ? v.replace(/\/$/, '') : null
const stored = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const apiOverride = (() => {
  const v = stored('holdterm-api')
  return v && /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(v) ? v.replace(/\/$/, '') : null
})()
/** The API base in use now. A live binding that changes once api.json answers, so read it at request time. */
export let api: string = apiOverride ?? okBase(stored('holdterm-api-base')) ?? BUILD_API
const readBase = (init?: RequestInit) =>
  fetch(`${API_JSON_URL}?m=${Math.floor(Date.now() / 60_000)}`, { ...init, signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok ? (r.json() as Promise<{ api?: string; api_base?: string }>) : null))
    .then((j) => {
      const v = okBase(j?.api_base ?? j?.api)
      if (v) {
        api = v
        try {
          localStorage.setItem('holdterm-api-base', v)
        } catch {}
      }
      return api
    })
    .catch(() => api)
/** Resolves with the current API base: api.json's within 2.5 s, else the last known or build value. */
export const apiReady: Promise<string> = apiOverride ? Promise.resolve(api) : readBase()
let reread = false
/** After a network-level failure: read api.json once more, bypassing caches. True when the base changed. */
export async function rereadApi(): Promise<boolean> {
  if (apiOverride || reread) return false
  reread = true
  const before = api
  return (await readBase({ cache: 'no-store' })) !== before
}

export const price = { monthly: 3, yearly: 29, trialDays: 7 }
// Delivery channels besides email, switched on as the alerts API ships them for Holdterm members.
export const channels = { chat: false, push: false }
