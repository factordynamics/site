// Public SEC EDGAR data published by Copybook's ingest (CORS *). Holdterm only reads it.
export const DATA = 'https://refcell.github.io/gust/copybook/data/'
// Stock pages derived from the same 13F books (d/stocks/{TICKER}.json, d/stocks.json).
export const DERIVED = 'https://copybook.factordynamics.com/d/'

// Paid email alerts: Stripe Payment Links and the alerts API. While a link is empty the
// subscribe button shows that checkout is opening soon instead of linking anywhere.
export const checkout = {
  monthly: '',
  yearly: '',
  portal: '',
}
export const api = ''
export const price = { monthly: 3, yearly: 29, trialDays: 7 }
