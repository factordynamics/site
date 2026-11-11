// Paid plan wiring (contract: factordynamics/site copybook/api/README.md).
// checkout.*: Stripe Payment Link URLs. portal: Stripe customer portal login page (fallback).
// api: Copybook API base URL (api.config.mjs).
// While the checkout links are empty, paid buttons say checkout is briefly unavailable (the waitlist is retired).
export const checkout = {
  monthly: 'https://buy.stripe.com/aFa7sL1dk2Do5tE2MSgjC00',
  yearly: 'https://buy.stripe.com/7sYeVd1dkguecW6gDIgjC01',
  portal: 'https://billing.stripe.com/p/login/aFa7sL1dk2Do5tE2MSgjC00',
}
// The API base. The build value (api.config.mjs) is the fallback; at load the site reads the current base
// from api.json on R2, which the API host rewrites when its tunnel URL changes, and remembers the last one
// it read. Only https bases on hosts we run are accepted (quick tunnels change name on restart, so
// trycloudflare.com stays a wildcard until the API has its own hostname; the others are pinned), since a member's session token is sent there.
// A tester can pin one browser to another API with localStorage['copybook-api'] = 'https://…' (there is
// deliberately no URL parameter for it, since a link could then send a session token elsewhere).
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
  const v = stored('copybook-api')
  return v && /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(v) ? v.replace(/\/$/, '') : null
})()
/** The API base in use now. A live binding: it changes once api.json answers, so read it at request time. */
export let api: string = apiOverride ?? okBase(stored('copybook-api-base')) ?? import.meta.env.VITE_API
const readBase = (init?: RequestInit) =>
  fetch(`${import.meta.env.VITE_API_JSON_URL}?m=${Math.floor(Date.now() / 60_000)}`, { ...init, signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok ? (r.json() as Promise<{ api?: string; api_base?: string }>) : null))
    .then((j) => {
      const v = okBase(j?.api_base ?? j?.api)
      if (v) {
        api = v
        try {
          localStorage.setItem('copybook-api-base', v)
        } catch {
          /* private mode */
        }
      }
      return api
    })
    .catch(() => api)
/** Resolves with the current API base: api.json's within 2.5 s, else the last known or build value. */
export const apiReady: Promise<string> = apiOverride ? Promise.resolve(api) : readBase()
let rereadAt = 0
/** After a failed API call: read api.json again, bypassing caches, at most every 20 s (so a page left open
 *  across a failover follows the move). True when the base changed. */
export async function rereadApi(): Promise<boolean> {
  if (apiOverride || Date.now() - rereadAt < 20_000) return false
  rereadAt = Date.now()
  const before = api
  return (await readBase({ cache: 'no-store' })) !== before
}
// Free weekly email box (POST {api}/signup). On once the API route is live.
export const signupLive = true

// Cloudflare Web Analytics beacon token (public; empty = no analytics).
export const analytics = { cloudflare: '' }

export const prices = { monthly: 9, yearly: 79 }

// The three paid products (Stripe Payment Links, 14-day trial, card up front). Upgrades go through the portal.
export type PlanId = 'copy' | 'pro' | 'fund'
export const plans: Record<PlanId, { name: string; monthly: number; yearly: number; links: { monthly: string; yearly: string } }> = {
  copy: { name: 'Copy', monthly: 9, yearly: 79, links: { monthly: checkout.monthly, yearly: checkout.yearly } },
  pro: {
    name: 'Copy Pro',
    monthly: 39,
    yearly: 390,
    links: { monthly: 'https://buy.stripe.com/9B69AT5tA0vg9JUfzEgjC02', yearly: 'https://buy.stripe.com/9B67sL1dk91Me0agDIgjC03' },
  },
  fund: {
    name: 'Copy Fund',
    monthly: 199,
    yearly: 1990,
    links: { monthly: 'https://buy.stripe.com/fZu5kD1dk91M4pAevAgjC04', yearly: 'https://buy.stripe.com/3cIfZhbRY1zk9JUafkgjC05' },
  },
}
const planOf = (id?: string) => plans[(id as PlanId) in plans ? (id as PlanId) : 'copy']
export const trialTerms = (id?: string) =>
  planOf(id) === plans.copy
    ? `With a card on file, Copy continues at $${plans.copy.monthly}/month or $${plans.copy.yearly}/year until you cancel; without one, the trial simply ends and nothing is charged. Add a card any time before day 15.`
    : `Free for 14 days, then $${planOf(id).monthly.toLocaleString('en-US')}/month or $${planOf(id).yearly.toLocaleString('en-US')}/year until you cancel. Cancel any time from Manage billing before the trial ends and you won’t be charged.`
export const renewalTerms = (id?: string) =>
  `${planOf(id).name} renews automatically at $${planOf(id).monthly.toLocaleString('en-US')}/month or $${planOf(id).yearly.toLocaleString('en-US')}/year until you cancel. Cancel any time from Manage billing; you keep access until the end of the period you paid for.`

export const checkoutEnabled = () => Boolean(checkout.monthly || checkout.yearly)

export const TRIAL_DAYS = 14
/** Under every Copy trial button (Copy trials take no card since Nov 11; Pro and Fund still do). */
export const TRIAL_LINE = `${TRIAL_DAYS} days free, no card needed. Then $${prices.monthly}/month or $${prices.yearly}/year.`
export const TRIAL_TERMS = trialTerms('copy')
// A referral takes one month of the monthly price off the first charge after the trial, on either
// interval (the API's coupon: amount_off = a month, duration once). Monthly: that month is free.
const usd = (n: number) => `$${n.toLocaleString('en-US')}`
export const referredDeal = (id: string | undefined, interval: 'monthly' | 'yearly') =>
  interval === 'monthly' ? `${TRIAL_DAYS} days free, then your first month free` : `${TRIAL_DAYS} days free, then ${usd(planOf(id).yearly - planOf(id).monthly)} for your first year`
export const referredTerms = (id: string | undefined, interval: 'monthly' | 'yearly') =>
  `${referredDeal(id, interval)}. After that, ${interval === 'monthly' ? `${usd(planOf(id).monthly)}/month` : `${usd(planOf(id).yearly)}/year`} until you cancel. Cancel any time from Manage billing before the trial ends and you won’t be charged.`
export const DATA_TERMS = 'SEC EDGAR 13F filings as filed. Not investment advice.'

// My book by plan. One wording on pricing, /account/ and the My book upgrade panel.
export const BOOK_LITE = { t: 'My book lite', d: 'Who among the superinvestors holds your names, their season moves, and the latest Form 4 or 13D.' }
/** Why a team buys Fund rather than several Pro seats (shown under Fund on /pricing/ and /for-funds/). */
export const FUND_WHY = 'Why not separate Pro seats? Pro seats don’t share a book, peers or watchlist, so each analyst rebuilds the same list, and alerts arrive once per seat in Slack instead of once. Net-30 invoicing is for Fund; Pro is paid by card, with a full invoice.'
/** Copy Fund's seat cap (the API's /seats max wins when it answers). */
export const FUND_SEATS = 10
/** Measured alert-speed figures outside /speed/ (marketing pages). Off until the lead clears speed claims after Nov 16. */
export const SPEED_CLAIMS = false
export const BOOK_PRO = { t: 'Full My book', d: 'Your names against every 13F filer (holders, crowding, peers), 13F linking, CSV and API. New, exited and net trades are for tracked funds today; all filers by Nov 20.' }
