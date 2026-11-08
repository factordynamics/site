import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { fundPath } from './src/names'
import roster from './src/roster.json'

// sitemap.xml: the section pages and every roster fund page, at their public URLs.
const sitemap = (): Plugin => ({
  name: 'holdterm-sitemap',
  generateBundle() {
    const site = 'https://holdterm.factordynamics.com'
    const paths = ['/', '/flows', '/consensus', '/funds', '/filings', '/alerts', '/about', '/terms', '/privacy', ...roster.funds.map((f) => fundPath(f.slug))]
    const day = new Date().toISOString().slice(0, 10)
    const body = paths.map((p) => `  <url><loc>${site}${p}</loc><lastmod>${day}</lastmod></url>`).join('\n')
    this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n` })
  },
})

// Holdterm: static SPA on Cloudflare Pages (project "holdterm"). Data is read in the browser from
// /data and /d, which Pages Functions (functions/) proxy from Copybook's public SEC EDGAR files.
const proxy = {
  '/data': { target: 'https://refcell.github.io', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/data/, '/gust/copybook/data') },
  '/d/': { target: 'https://copybook.factordynamics.com', changeOrigin: true },
}
export default defineConfig({
  base: '/',
  plugins: [react(), sitemap()],
  server: { proxy },
  preview: { proxy },
  build: { target: 'es2022' },
})
