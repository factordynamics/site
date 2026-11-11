import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { FUNDS, dataSlug, firmName, fundPath, publicSlug, shortFirm } from './src/names'
import roster from './src/roster.json'
import TICKERS from './src/tickers.json'
import { aggregate, type Agg, type Book, isStockLine, issuerKey, loadBook, quarterLabel } from './src/data'
import { issuerName } from './src/names'
import { usd } from './src/lib'
import { fundCard, png, siteCard, stockCard } from './scripts/og'

const SITE = 'https://holdterm.factordynamics.com'
const DERIVED = 'https://copybook.factordynamics.com/d/'
const SECTIONS: Record<string, [string, string]> = {
  '/': ['What long-term investors buy and sell', 'See what concentrated, long-term investors own, buy and sell, from their 13F, 13D/G and Form 4 filings with the SEC. Free to read, no ads.'],
  '/funds': ['Investors', 'The concentrated, long-term investors Holdterm follows, chosen by a published rule, with each one’s latest 13F.'],
  '/flows': ['Buys and sells', 'What long-term investors bought and sold last quarter, stock by stock, from their latest 13F filings.'],
  '/consensus': ['Most owned stocks', 'The stocks long-term investors own in common, ranked by how many own them, dollars held and the biggest single bets.'],
  '/filings': ['Stakes and insider trades', 'New 5% stakes (Schedule 13D and 13G) and insider trades (Form 4) filed by long-term investors between their quarterly 13Fs.'],
  '/alerts': ['Alerts', 'Know within hours when the investors you follow file a 13F, 13D, 13G or Form 4. 7 days free, then $3 a month.'],
  '/account': ['Account', 'Manage Holdterm email alerts.'],
  '/guide': ['How to read Holdterm', 'What 13F, 13D/G and Form 4 filings show, how current they are, and how to read a fund or stock page on Holdterm.'],
  '/about': ['About', 'How Holdterm chooses the investors it follows and reads their SEC filings.'],
  '/terms': ['Terms', 'Holdterm terms of service.'],
  '/privacy': ['Privacy', 'Holdterm privacy policy.'],
}
// Old section paths.
const MOVED: Record<string, string> = { '/m': '/funds', '/activity': '/flows', '/grand': '/consensus', '/insiders': '/filings' }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** index.html with a page's own title, description, canonical, og tags and (optionally) its own social card;
 * null meta makes the 404 page. */
function page(html: string, path: string, meta: [string, string] | null, image?: string) {
  const [t, d] = meta ?? ['Not found', 'No such page.']
  const title = esc(`${t} · Holdterm`)
  let out = html
    .replace(/(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*/g, (_, p1) => p1 + `${SITE}${image ?? '/og.png'}`)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, (_, p1) => p1 + `${esc(d)}`)
    .replace(/(<meta property="og:title" content=")[^"]*/, (_, p1) => p1 + `${title}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, (_, p1) => p1 + `${esc(d)}`)
  if (meta) return out.replace(/(<link rel="canonical" href=")[^"]*/, (_, p1) => p1 + `${SITE}${esc(path)}`).replace(/(<meta property="og:url" content=")[^"]*/, (_, p1) => p1 + `${SITE}${esc(path)}`)
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
const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
/** A fund card's numbers and a one-sentence lead, from the book as the fund page shows it. */
function fundFacts(b: Book) {
  const live = b.holdings.filter((h) => h.value > 0 && isStockLine(h))
  if (!live.length || !b.long_value) return null
  // Share classes of one company count once (GOOGL and GOOG).
  const by = new Map<string, { name: string; weight: number }>()
  for (const h of live) {
    const k = issuerKey(h)
    const cur = by.get(k)
    if (cur) cur.weight += h.weight
    else by.set(k, { name: issuerName(h.display_name || h.issuer).replace(/\s+(class|cl\.?)\s+[a-z]\b.*$/i, ''), weight: h.weight })
  }
  const top = [...by.values()].sort((x, y) => y.weight - x.weight).slice(0, 3)
  const d = b.prev_long_value ? b.long_value / b.prev_long_value - 1 : null
  const prevQ = b.prev_quarter ? quarterLabel(b.prev_quarter).split(' ')[0] : 'prior quarter'
  const lead = `Largest holdings: ${top.map((t) => `${t.name} (${(t.weight * 100).toFixed(1)}%)`).join(', ').replace(/, ([^,]*)$/, ' and $1')}.`
  return {
    lead,
    card: { pm: b.pm, quarter: quarterLabel(b.quarter), filed: fmtDay(b.filing_date), value: usd(b.long_value), positions: live.length, change: d == null || !isFinite(d) ? null : { text: `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1)}% vs ${prevQ}`, up: d >= 0 }, top },
  }
}

/** The offline page and the service worker that serves it (public/sw.js): the shell it caches is this build's
 * script, stylesheet and Latin fonts, and its cache version is a hash of those names and the offline page, so a
 * deploy that changes either replaces the cache. Served at /offline (Pages drops the .html). */
function offline(dist: string, html: string) {
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1])
  const css = assets.find((a) => a.endsWith('.css'))!
  const fonts = [...readFileSync(join(dist, css), 'utf8').matchAll(/url\((\/assets\/inter-latin(?:-ext)?-wght-normal-[^)]+\.woff2)\)/g)].map((m) => m[1])
  const shell = [...new Set([...assets, ...fonts, '/favicon.svg'])]
  if (assets.length < 2 || fonts.length < 2) throw new Error(`offline: shell incomplete (${shell.join(', ')})`)
  const theme = html.match(/<script>\s*if \(location\.hostname[\s\S]*?<\/script>/)?.[0] ?? ''
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#ffffff" />
    <meta name="robots" content="noindex" />
    ${theme}
    <title>You’re offline · Holdterm</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="${css}" />
  </head>
  <body>
    <header class="top">
      <div class="top-in">
        <a href="/" class="brand" title="Holdterm home">
          <svg width="24" height="24" viewBox="0 0 20 20" aria-hidden="true" class="mark"><rect width="20" height="20" rx="5" fill="var(--brand)" /><rect x="4" y="4.5" width="12" height="2.2" rx="1.1" fill="#14161a" /><rect x="4" y="8.9" width="8.5" height="2.2" rx="1.1" fill="#14161a" /><rect x="4" y="13.3" width="5" height="2.2" rx="1.1" fill="#14161a" /></svg>
          <span class="word">Holdterm</span>
        </a>
      </div>
    </header>
    <main id="main">
      <div class="page narrow">
        <div class="failed" role="alert">
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" class="failed-icon"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M12 7v6M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
          <div class="failed-text">
            <h1 style="font-size: 18px; margin: 0 0 6px">You’re offline</h1>
            <p>Holdterm needs a connection to load the latest SEC filings. This page will reload by itself as soon as your connection is back.</p>
            <p id="still" hidden>Still offline.</p>
            <div class="failed-actions"><button class="btn" id="retry">Try again</button></div>
          </div>
        </div>
      </div>
    </main>
    <script>
      addEventListener('online', function () { location.reload() })
      document.getElementById('retry').onclick = function () {
        if (navigator.onLine === false) document.getElementById('still').hidden = false
        else location.reload()
      }
    </script>
  </body>
</html>
`
  writeFileSync(join(dist, 'offline.html'), page)
  const version = createHash('sha256').update(shell.join('\n') + page).digest('hex').slice(0, 12)
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8').replace('__VERSION__', version).replace('__SHELL__', JSON.stringify(shell))
  if (sw.includes('__')) throw new Error('offline: sw.js placeholders left')
  writeFileSync(join(dist, 'sw.js'), sw)
  console.log(`holdterm-pages: offline page and sw.js (cache ${version}, ${shell.length} shell files)`)
}

const pages = (): Plugin => ({
  name: 'holdterm-pages',
  apply: 'build',
  async closeBundle() {
    const dist = fileURLToPath(new URL('./dist', import.meta.url))
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    const files = new Map<string, string>()
    const add = (path: string, meta: [string, string], image?: string) => files.set(path, page(html, path, meta, image))
    for (const [p, m] of Object.entries(SECTIONS)) if (p !== '/') add(p, m)
    writeFileSync(join(dist, 'index.html'), page(html, '/', SECTIONS['/']))

    const funds = roster.funds as { slug: string; firm: string }[]
    writeFileSync(join(dist, 'og.png'), png(siteCard(funds.length)))
    // Each fund's card and description come from its latest book, read and checked exactly as the page reads
    // it (src/data.ts). A fund whose book can't be read keeps the site card and a generic description.
    mkdirSync(join(dist, 'og', 'm'), { recursive: true })
    const books = new Map<string, Book>()
    for (let i = 0; i < funds.length; i += 12) await Promise.all(funds.slice(i, i + 12).map((f) => loadBook(f.slug).then((b) => void books.set(f.slug, b), () => undefined)))
    for (const f of funds) {
      const firm = FUNDS[f.slug]?.firm ?? firmName(f.slug, f.firm)
      const b = books.get(f.slug)
      const card = b && fundFacts(b)
      if (!card) {
        add(fundPath(f.slug), [`${firm} 13F portfolio`, `${firm}: latest 13F holdings, quarterly buys and sells, and 13D/G and Form 4 filings, from SEC EDGAR.`])
        continue
      }
      const img = `/og/m/${fundPath(f.slug).slice(3)}.png`
      writeFileSync(join(dist, img), png(fundCard({ ...card.card, firm })))
      add(fundPath(f.slug), [`${firm} 13F portfolio`, `${firm}’s ${card.card.quarter} 13F: ${card.card.value} in ${card.card.positions} US-listed stocks. ${card.lead} See every holding, what it bought and sold, and its 13D, 13G and Form 4 filings.`], img)
    }
    console.log(`holdterm-pages: ${books.size} of ${funds.length} fund cards`)

    // A stock the investors hold gets a description with its numbers, from the same aggregate as Most owned and
    // search (share classes combined, each investor's latest 13F); one held by 3 or more also gets its own card.
    const held = new Map<string, Agg>()
    for (const a of aggregate([...books.values()]).rows) if (!a.fund && a.holders.length) for (const t of a.classes ?? [a.ticker]) if (t) held.set(t, a)
    mkdirSync(join(dist, 'og', 's'), { recursive: true })
    let cards = 0
    const drawn = new Map<string, string>()
    const facts = (t: string, label: string): [string, string | undefined] | null => {
      const a = held.get(t)
      if (!a) return null
      const name = a.name
      const bets = [...a.holders].sort((x, y) => y.weight - x.weight).slice(0, 3).map((b) => ({ ...b, manager: shortFirm(b.manager) }))
      const list = (xs: string[]) => xs.join(', ').replace(/, ([^,]*)$/, ' and $1')
      const bought = a.buyers.length
      const sold = a.sellers.length
      const d = `${label} is held by ${a.holders.length} of the ${funds.length} long-term investors Holdterm follows, ${usd(a.value)} in all. Biggest bets on it: ${list(bets.map((b) => `${b.manager} (${(b.weight * 100).toFixed(1)}%)`))}. In their latest 13Fs, ${bought} bought more and ${sold} sold some or all.`
      if (a.holders.length < 3) return [d, undefined]
      // One card per company, shared by its share classes.
      let img = drawn.get(a.key)
      if (!img) {
        img = `/og/s/${a.ticker}.png`
        writeFileSync(join(dist, img), png(stockCard({ name, ticker: a.label?.replace('+', ' · ') ?? t, holders: a.holders.length, of: funds.length, value: usd(a.value), bought, sold, top: bets.map((b) => ({ name: b.manager, weight: b.weight })) })))
        drawn.set(a.key, img)
        cards++
      }
      return [d, img]
    }

    // Stocks: every ticker in Copybook's derived stock index, its other share classes, and the tickers
    // Holdterm resolves itself from a CUSIP (src/tickers.json).
    const r = await fetch(`${DERIVED}stocks.json`)
    if (!r.ok) throw new Error(`stocks.json: HTTP ${r.status}`)
    const { stocks } = (await r.json()) as { stocks: { t: string; n: string; a?: string[] }[] }
    if (stocks.length < 1000) throw new Error(`stocks.json has only ${stocks.length} stocks`)
    const stock = (t: string, n: string) => {
      if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(t)) return
      const label = n && n !== t ? `${n} (${t})` : t
      const f = facts(t, label)
      add(`/s/${t}`, [`${label}: who owns it`, f ? f[0] : `Which long-term investors own ${label}, what they bought and sold last quarter, and their 5% stakes and insider trades, from SEC EDGAR filings.`], f?.[1])
    }
    for (const s of stocks) for (const t of [s.t, ...(s.a ?? [])]) stock(t, s.n)
    for (const o of Object.values(TICKERS as unknown as Record<string, { ticker?: string; listed?: boolean }>)) if (o?.listed && o.ticker && !files.has(`/s/${o.ticker}`)) stock(o.ticker, o.ticker)

    // /about -> dist/about.html, which Pages serves at /about (no trailing slash).
    for (const [p, body] of files) {
      const f = join(dist, `${p}.html`)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, body)
    }
    writeFileSync(join(dist, '404.html'), page(html, '', null))
    offline(dist, html)

    const redirects = [
      ...Object.entries(MOVED).map(([a, b]) => `${a} ${b} 301`),
      // Fund URLs by data slug or a person's name (/m/bill-ackman) go to the firm URL.
      ...[...new Set([...funds.map((f) => f.slug), ...Object.keys(FUNDS)])].filter((s) => publicSlug(s) !== s && dataSlug(publicSlug(s)) === s).map((s) => `/m/${s} ${fundPath(s)} 301`),
    ]
    writeFileSync(join(dist, '_redirects'), redirects.join('\n') + '\n')

    const day = new Date().toISOString().slice(0, 10)
    const urls = ['/', ...Object.keys(SECTIONS).filter((p) => p !== '/' && p !== '/account'), ...funds.map((f) => fundPath(f.slug))]
    writeFileSync(join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((p) => `  <url><loc>${SITE}${p}</loc><lastmod>${day}</lastmod></url>`).join('\n')}\n</urlset>\n`)
    console.log(`holdterm-pages: ${held.size} stocks with numbers, ${cards} stock cards`)
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
