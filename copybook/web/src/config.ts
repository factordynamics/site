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

// Cloudflare Web Analytics beacon token (public; empty = no analytics).
export const analytics = { cloudflare: '' }

export const prices = { monthly: 9, yearly: 79 }

export const checkoutEnabled = () => Boolean(checkout.monthly || checkout.yearly)

export const RENEWAL_TERMS =
  'Copy renews automatically at $9/month or $79/year until you cancel. Cancel any time from Manage billing; you keep access until the end of the period you paid for.'
export const DATA_TERMS = 'SEC EDGAR 13F filings as filed. Not investment advice.'
