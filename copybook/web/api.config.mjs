// The Copybook API's base URL: the one setting to change when the API moves (no trailing slash).
// Read by the Vite build (as VITE_API), scripts/cards.mjs and the Pages workflow; VITE_API overrides it.
// The fallback when api.json can't load is the Worker, which serves members on failover: never a machine or tunnel host
// on a public page (the lead, Nov 11).
export const API = process.env.VITE_API || 'https://copybook-api.factordynamics.workers.dev'
// The API's latency summary as a public R2 object (same shape as GET /latency plus generated_at, rewritten
// each minute it changes): pages read it instead of the API, so a visitor costs no Worker request.
// The current API base, published by the API host as a public R2 object ({"api": "https://…"}). The site
// reads it at load, so a tunnel URL change needs no redeploy; API above is the fallback when it can't load.
// The /v1 base we publish in docs and examples (the spec's servers entry): a stable name, unlike the
// tunnel above, which can change on restart. Member pages keep reading api.json.
export const API_DOCS_BASE = process.env.VITE_API_DOCS_BASE || 'https://copybook-api.factordynamics.workers.dev'
export const API_JSON_URL = process.env.VITE_API_JSON_URL || 'https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/api.json'
export const LATENCY_URL = process.env.VITE_LATENCY_URL || 'https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/latency.json'
