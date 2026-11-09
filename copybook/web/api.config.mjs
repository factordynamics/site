// The Copybook API's base URL: the one setting to change when the API moves (no trailing slash).
// Read by the Vite build (as VITE_API), scripts/cards.mjs and the Pages workflow; VITE_API overrides it.
export const API = process.env.VITE_API || 'https://gene.tail70ba3.ts.net/copybook'
// The API's latency summary as a public R2 object (same shape as GET /latency plus generated_at, rewritten
// each minute it changes): pages read it instead of the API, so a visitor costs no Worker request.
// The current API base, published by the API host as a public R2 object ({"api": "https://…"}). The site
// reads it at load, so a tunnel URL change needs no redeploy; API above is the fallback when it can't load.
export const API_JSON_URL = process.env.VITE_API_JSON_URL || 'https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/api.json'
export const LATENCY_URL = process.env.VITE_LATENCY_URL || 'https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/latency.json'
