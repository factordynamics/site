import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { API, API_DOCS_BASE, API_JSON_URL, LATENCY_URL } from './api.config.mjs'

// Served at https://copybook.factordynamics.com/ (GitHub Pages, .github/workflows/copybook-pages.yml).
// Data is published by copybook/ingest to refcell/gust and read cross-origin (Pages sends CORS *).
// COPYBOOK_BASE, VITE_SITE and VITE_DATA_BASE override these for another host.
process.env.VITE_SITE ||= 'https://copybook.factordynamics.com/'
process.env.VITE_DATA_BASE ||= 'https://refcell.github.io/gust/copybook/data/'
process.env.VITE_API = API
// The footer's build stamp: the commit this build came from.
// The newest commit that changed the site (copybook/web), not main's head, which is often an API or ingest commit.
process.env.VITE_BUILD = (process.env.COPYBOOK_BUILD_SHA ?? (() => { try { return execSync('git log -1 --format=%H -- .').toString() || 'local' } catch { return 'local' } })()).trim().slice(0, 7)
process.env.VITE_LATENCY_URL = LATENCY_URL
process.env.VITE_API_JSON_URL = API_JSON_URL
process.env.VITE_API_DOCS_BASE = API_DOCS_BASE
// Preload the Latin web fonts the first screen uses, so headlines don't reflow when they swap in (layout
// shift), and open the connection to the data host early.
const preload = (): Plugin => ({
  name: 'copybook-preload',
  apply: 'build',
  transformIndexHtml(html, ctx) {
    const fonts = Object.keys(ctx.bundle ?? {}).filter((f) => /\/(geist-latin-wght-normal|newsreader-latin-wght-italic)-[^/]+\.woff2$/.test(f))
    const tags = [
      // The deployed commit, readable without running the bundle (curl the page, grep copybook-build).
      { tag: 'meta', attrs: { name: 'copybook-build', content: process.env.VITE_BUILD! }, injectTo: 'head' as const },
      { tag: 'link', attrs: { rel: 'preconnect', href: new URL(process.env.VITE_DATA_BASE!).origin, crossorigin: '' }, injectTo: 'head' as const },
      ...fonts.map((f) => ({ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `${process.env.COPYBOOK_BASE || '/'}${f}`, crossorigin: '' }, injectTo: 'head' as const })),
    ]
    return { html, tags }
  },
})

export default defineConfig({
  base: process.env.COPYBOOK_BASE || '/',
  plugins: [react(), tailwindcss(), preload()],
  build: { target: 'es2022', assetsInlineLimit: 0 },
})
