// Paid plan wiring (contract: factordynamics/site copybook/api/README.md).
// checkout.*: Stripe Payment Link URLs. portal: Stripe customer portal login page (fallback).
// api: Copybook API base URL (api.config.mjs).
// While the checkout links are empty, paid buttons say checkout is briefly unavailable (the waitlist is retired).
export const checkout = {
  monthly: 'https://buy.stripe.com/aFa7sL1dk2Do5tE2MSgjC00',
  yearly: 'https://buy.stripe.com/7sYeVd1dkguecW6gDIgjC01',
  portal: 'https://billing.stripe.com/p/login/aFa7sL1dk2Do5tE2MSgjC00',
}
// The API base: the Worker (api.config.mjs), always. Public pages and assets never name a machine or tunnel host
// (the lead, Nov 12), so the site no longer reads api.json's base; the Worker serves members itself and follows
// gene or a failover behind it. A tester can pin one browser to another API with
// localStorage['copybook-api'] = 'https://…' (deliberately no URL parameter, since a link could then send a
// session token elsewhere).
const apiOverride = (() => {
  try {
    localStorage.removeItem('copybook-api-base') // a tunnel base remembered by an earlier build
    const v = localStorage.getItem('copybook-api')
    return v && /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(v) ? v.replace(/\/$/, '') : null
  } catch {
    return null
  }
})()
/** The API base in use. */
export const api: string = apiOverride ?? import.meta.env.VITE_API
/** Resolves with the API base (kept as a promise for its callers). */
export const apiReady: Promise<string> = Promise.resolve(api)
/** After a failed API call: the base never moves now, so there is nothing to re-read. */
export async function rereadApi(): Promise<boolean> {
  return false
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
export const TRIAL_LINE = `${TRIAL_DAYS} days free, no card needed. Keep it for $${prices.monthly}/month or $${prices.yearly}/year.`
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
export const BOOK_PRO = { t: 'Full My book', d: 'Your names against every 13F filer (holders, crowding, peers), 13F linking and CSV; the same holder data through the API’s holders endpoint. New, exited and net trades are for tracked funds today; hedge funds and long-only managers by Nov 20.' }
