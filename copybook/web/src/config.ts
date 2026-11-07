// Paid plan wiring (contract: factordynamics/site copybook/api/README.md).
// checkout.*: Stripe Payment Link URLs. portal: Stripe customer portal login page (fallback).
// api: Copybook API base URL, e.g. https://copybook-api.<sub>.workers.dev.
// While the checkout links are empty, every paid button falls back to the encrypted waitlist.
export const checkout = {
  monthly: '',
  yearly: '',
  portal: '',
}
export const api = ''

export const prices = { monthly: 9, yearly: 79 }

export const checkoutEnabled = () => Boolean(checkout.monthly || checkout.yearly)

export const RENEWAL_TERMS =
  'Copy renews automatically at $9/month or $79/year until you cancel. Cancel any time from Manage billing; you keep access until the end of the period you paid for.'
export const DATA_TERMS = 'SEC EDGAR 13F filings as filed. Not investment advice.'
