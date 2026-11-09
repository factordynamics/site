// Paid plan wiring (contract: factordynamics/site copybook/api/README.md).
// checkout.*: Stripe Payment Link URLs. portal: Stripe customer portal login page (fallback).
// api: Copybook API base URL, e.g. https://copybook-api.<sub>.workers.dev.
// While the checkout links are empty, every paid button falls back to the encrypted waitlist.
export const checkout = {
  monthly: 'https://buy.stripe.com/aFa7sL1dk2Do5tE2MSgjC00',
  yearly: 'https://buy.stripe.com/7sYeVd1dkguecW6gDIgjC01',
  portal: 'https://billing.stripe.com/p/login/aFa7sL1dk2Do5tE2MSgjC00',
}
export const api = 'https://copybook-api.factordynamics.workers.dev'
// Free weekly email box (POST {api}/signup). On once the API route is live.
export const signupLive = false

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
  `Free for 14 days, then $${planOf(id).monthly.toLocaleString('en-US')}/month or $${planOf(id).yearly.toLocaleString('en-US')}/year until you cancel. Cancel any time from Manage billing before the trial ends and you won’t be charged.`
export const renewalTerms = (id?: string) =>
  `${planOf(id).name} renews automatically at $${planOf(id).monthly.toLocaleString('en-US')}/month or $${planOf(id).yearly.toLocaleString('en-US')}/year until you cancel. Cancel any time from Manage billing; you keep access until the end of the period you paid for.`

export const checkoutEnabled = () => Boolean(checkout.monthly || checkout.yearly)

export const TRIAL_DAYS = 14
export const TRIAL_TERMS = trialTerms('copy')
export const DATA_TERMS = 'SEC EDGAR 13F filings as filed. Not investment advice.'

// My book by plan. One wording on pricing, /account/ and the My book upgrade panel.
export const BOOK_LITE = { t: 'My book lite', d: 'Who among the superinvestors holds your names, their season moves, and the latest Form 4 or 13D.' }
export const BOOK_PRO = { t: 'Full My book', d: 'Your names against every 13F filer, crowding, peers, 13F linking, CSV and API.' }
