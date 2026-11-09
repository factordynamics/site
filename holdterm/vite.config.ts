import react from '@vitejs/plugin-react'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { FUNDS, dataSlug, firmName, fundPath, publicSlug } from './src/names'
import roster from './src/roster.json'
import TICKERS from './src/tickers.json'

const SITE = 'https://holdterm.factordynamics.com'
const DERIVED = 'https://copybook.factordynamics.com/d/'
const SECTIONS: Record<string, [string, string]> = {
  '/': ['What long-term investors buy and sell', 'Every 13F filing, trade, 13D/G and Form 4 from a rule-based roster of concentrated, long-term funds. SEC EDGAR data, no ads.'],
  '/funds': ['Investors', 'The roster: concentrated, long-term 13F filers chosen by a published rule, with each one’s latest 13F.'],
  '/flows': ['Buys and sells', 'What the roster bought and sold, stock by stock, from each fund’s latest 13F.'],
  '/consensus': ['Most owned stocks', 'The stocks the roster owns in common, by number of funds, dollars held and conviction.'],
  '/filings': ['13D, 13G and Form 4 filings', 'Schedule 13D and 13G stakes and Form 4 trades filed by roster funds between 13Fs.'],
  '/alerts': ['Email alerts', 'Email alerts when the funds you follow file a 13F, 13D, 13G or Form 4. $3 a month.'],
  '/account': ['Account', 'Manage Holdterm email alerts.'],
  '/about': ['About', 'How Holdterm chooses its roster and reads SEC filings.'],
  '/terms': ['Terms', 'Holdterm terms of service.'],
  '/privacy': ['Privacy', 'Holdterm privacy policy.'],
}
// Old section paths.
const MOVED: Record<string, string> = { '/m': '/funds', '/activity': '/flows', '/grand': '/consensus', '/insiders': '/filings' }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** index.html with a page's own title, description, canonical and og tags; null meta makes the 404 page. */
function page(html: string, path: string, meta: [string, string] | null) {
  const [t, d] = meta ?? ['Not found', 'No such page.']
  const title = esc(`${t} · Holdterm`)
  let out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${esc(d)}`)
    .replace(/(<meta property="og:title" content=")[^"]*/, `$1${title}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, `$1${esc(d)}`)
  if (meta) return out.replace(/(<link rel="canonical" href=")[^"]*/, `$1${SITE}${esc(path)}`).replace(/(<meta property="og:url" content=")[^"]*/, `$1${SITE}${esc(path)}`)
  // A 404 points nowhere and asks not to be indexed.
  return out.replace(/\s*<link rel="canonical"[^>]*>/, '').replace(/\s*<meta property="og:url"[^>]*>/, '').replace('</head>', '    <meta name="robots" content="noindex" />\n  </head>')
}

/**
 * Static pages, so Holdterm needs no Pages Functions (no Workers requests, nothing to run out):
 * - every section, roster fund and stock gets its own HTML file with the right meta tags;
 * - 404.html is the app shell with noindex, so unknown paths return a real 404 and still render the app
 *   (a ticker that appeared after the last deploy shows its page, with a 404 status until the next one);
 * - _redirects keeps old section and fund URLs working;
 * - sitemap.xml lists the sections and fund pages.
 */
const pages = (): Plugin => ({
  name: 'holdterm-pages',
  apply: 'build',
  async closeBundle() {
    const dist = fileURLToPath(new URL('./dist', import.meta.url))
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    const files = new Map<string, string>()
    const add = (path: string, meta: [string, string]) => files.set(path, page(html, path, meta))
    for (const [p, m] of Object.entries(SECTIONS)) if (p !== '/') add(p, m)
    writeFileSync(join(dist, 'index.html'), page(html, '/', SECTIONS['/']))

    const funds = roster.funds as { slug: string; firm: string }[]
    for (const f of funds) {
      const firm = FUNDS[f.slug]?.firm ?? firmName(f.slug, f.firm)
      add(fundPath(f.slug), [`${firm} 13F portfolio`, `${firm}: latest 13F holdings, quarterly buys and sells, and 13D/G and Form 4 filings, from SEC EDGAR.`])
    }

    // Stocks: every ticker in Copybook's derived stock index, its other share classes, and the tickers
    // Holdterm resolves itself from a CUSIP (src/tickers.json).
    const r = await fetch(`${DERIVED}stocks.json`)
    if (!r.ok) throw new Error(`stocks.json: HTTP ${r.status}`)
    const { stocks } = (await r.json()) as { stocks: { t: string; n: string; a?: string[] }[] }
    if (stocks.length < 1000) throw new Error(`stocks.json has only ${stocks.length} stocks`)
    const stock = (t: string, n: string) =>
      /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(t) && add(`/s/${t}`, [`${t}: which funds own it`, `Which concentrated long-term funds own ${n} (${t}), what they bought and sold, and their 13D/G and Form 4 filings, from SEC EDGAR.`])
    for (const s of stocks) for (const t of [s.t, ...(s.a ?? [])]) stock(t, s.n)
    for (const o of Object.values(TICKERS as unknown as Record<string, { ticker?: string; listed?: boolean }>)) if (o?.listed && o.ticker && !files.has(`/s/${o.ticker}`)) stock(o.ticker, o.ticker)

    // /about -> dist/about.html, which Pages serves at /about (no trailing slash).
    for (const [p, body] of files) {
      const f = join(dist, `${p}.html`)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, body)
    }
    writeFileSync(join(dist, '404.html'), page(html, '', null))

    const redirects = [
      ...Object.entries(MOVED).map(([a, b]) => `${a} ${b} 301`),
      // Fund URLs by data slug or a person's name (/m/bill-ackman) go to the firm URL.
      ...[...new Set([...funds.map((f) => f.slug), ...Object.keys(FUNDS)])].filter((s) => publicSlug(s) !== s && dataSlug(publicSlug(s)) === s).map((s) => `/m/${s} ${fundPath(s)} 301`),
    ]
    writeFileSync(join(dist, '_redirects'), redirects.join('\n') + '\n')

    const day = new Date().toISOString().slice(0, 10)
    const urls = ['/', ...Object.keys(SECTIONS).filter((p) => p !== '/' && p !== '/account'), ...funds.map((f) => fundPath(f.slug))]
    writeFileSync(join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((p) => `  <url><loc>${SITE}${p}</loc><lastmod>${day}</lastmod></url>`).join('\n')}\n</urlset>\n`)
    console.log(`holdterm-pages: ${files.size + 1} pages, 404.html, ${redirects.length} redirects`)
  },
})

// Holdterm: a static SPA on Cloudflare Pages (project "holdterm"), with no Functions. Data is read in the
// browser straight from Copybook's static hosts.
export default defineConfig({
  base: '/',
  plugins: [react(), pages()],
  build: { target: 'es2022' },
})
