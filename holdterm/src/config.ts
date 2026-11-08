// Public SEC EDGAR data published by Copybook's ingest (CORS *). Holdterm only reads it.
export const DATA = 'https://refcell.github.io/gust/copybook/data/'
// Stock pages derived from the same 13F books (d/stocks/{TICKER}.json, d/stocks.json).
export const DERIVED = 'https://copybook.factordynamics.com/d/'

// Paid email alerts: Stripe Payment Links and the alerts API. While a link is empty the
// subscribe button shows that checkout is opening soon instead of linking anywhere.
export const checkout = {
  monthly: 'https://buy.stripe.com/eVq5kD4pw3Hsf4edrwgjC06',
  yearly: 'https://buy.stripe.com/7sY6oH7BI91M5tEgDIgjC07',
  // Stripe billing portal login (Holdterm's own configuration): manage or cancel without signing in here.
  portal: 'https://billing.stripe.com/p/login/7sYeVd1dkguecW6gDIgjC01',
}
// Shared alerts API (Holdterm members are plan "holdterm": alerts and follows only).
export const api = 'https://copybook-api.factordynamics.workers.dev'

export const price = { monthly: 3, yearly: 29, trialDays: 7 }
