// The Copybook API's base URL: the one setting to change when the API moves (no trailing slash).
// Read by the Vite build (as VITE_API), scripts/cards.mjs and the Pages workflow; VITE_API overrides it.
export const API = process.env.VITE_API || 'https://solid-amanda-dir-fiction.trycloudflare.com/copybook'
// The API's latency summary as a public R2 object (same shape as GET /latency plus generated_at, rewritten
// each minute it changes): pages read it instead of the API, so a visitor costs no Worker request.
export const LATENCY_URL = process.env.VITE_LATENCY_URL || 'https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/latency.json'
