import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { API, LATENCY_URL } from './api.config.mjs'

// Served at https://copybook.factordynamics.com/ (GitHub Pages, .github/workflows/copybook-pages.yml).
// Data is published by copybook/ingest to refcell/gust and read cross-origin (Pages sends CORS *).
// COPYBOOK_BASE, VITE_SITE and VITE_DATA_BASE override these for another host.
process.env.VITE_SITE ||= 'https://copybook.factordynamics.com/'
process.env.VITE_DATA_BASE ||= 'https://refcell.github.io/gust/copybook/data/'
process.env.VITE_API = API
process.env.VITE_LATENCY_URL = LATENCY_URL
// Preload the Latin web fonts the first screen uses, so headlines don't reflow when they swap in (layout
// shift), and open the connection to the data host early.
const preload = (): Plugin => ({
  name: 'copybook-preload',
  apply: 'build',
  transformIndexHtml(html, ctx) {
    const fonts = Object.keys(ctx.bundle ?? {}).filter((f) => /\/(geist-latin-wght-normal|newsreader-latin-wght-italic)-[^/]+\.woff2$/.test(f))
    const tags = [
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
