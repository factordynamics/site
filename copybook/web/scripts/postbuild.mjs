// Writes a static index.html for every route so GitHub Pages serves deep links directly,
// with per-page titles, plus redirect stubs for the old .html URLs.
// Usage: node scripts/postbuild.mjs <index.json path or URL>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getJson } from './getjson.mjs'

const dist = new URL('../dist/', import.meta.url).pathname
const src = process.argv[2] || 'https://refcell.github.io/gust/copybook/data/index.json'
const index = src.startsWith('http') ? await getJson(src) : JSON.parse(readFileSync(src, 'utf8'))
const shell = readFileSync(join(dist, 'index.html'), 'utf8')
const SITE = process.env.VITE_SITE || 'https://copybook.factordynamics.com/'

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
function page(path, title, desc, extra = '', image = null) {
  let html = shell
    .replaceAll(`${SITE}og.png`, () => image ?? `${SITE}og.png`)
    // Function replacers only: a replacement string reads "$1.7B" in a description as the $1 backreference.
    .replace(/<title>.*?<\/title>/, () => `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, (_, p) => p + esc(desc))
    .replace(/(<meta property="og:title" content=")[^"]*/, (_, p) => p + esc(title))
    .replace(/(<meta property="og:description" content=")[^"]*/, (_, p) => p + esc(desc))
    .replace('<meta property="og:type"', () => `<link rel="canonical" href="${SITE}${path}" />${extra}\n    <meta property="og:type"`)
  const dir = join(dist, path)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html)
}
function redirect(file, to) {
  writeFileSync(
    join(dist, file),
    `<!doctype html><meta charset="utf-8"><title>Copybook</title><link rel="canonical" href="${SITE}${to}"><meta http-equiv="refresh" content="0; url=${SITE}${to}"><script>location.replace(${JSON.stringify(SITE + to)})</script>`,
  )
}

const tc = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(Llc|Lp|Llp|Plc|Etf|Ag|Sa|Nv|Se|Ii|Iii|Usa)\b/g, (w) => w.toUpperCase()))
page('investors/', 'Investors · Copybook', 'Latest 13F portfolios of legendary value investors, hedge-fund founders, activists and the largest institutions.')
page('consensus/', 'Consensus · Copybook', 'Where great investors agree: one combined book from the latest 13F filings of the superinvestors we follow.')
page('pricing/', 'Pricing · Copybook', 'The latest quarter is free. Copy adds quarter-over-quarter changes, full history, filing alerts and CSV export.')
page('account/', 'Account · Copybook', 'Manage your Copy subscription.')
page('speed/', 'Alert speed: EDGAR to inbox, every alert timed · Copybook', 'How fast Copybook alerts arrive: the median and 90th percentile from SEC EDGAR acceptance to delivery for 13F, Form 4 and 13D/G filings, and every live alert this season.')
page('upgrade/', 'Upgrade · Copybook', 'Switch your Copy plan to Copy Pro or Copy Fund, prorated, on the same billing interval.')
{
  // The season tracker's share card (scripts/cards.mjs), with its cache-busting URL.
  let season = null
  try {
    season = JSON.parse(readFileSync(join(dist, 'og', 'season.json'), 'utf8'))
  } catch {}
  // The season tracker's title names the quarter now filing, for search during filing week.
  const qs = index.managers.filter((m) => m.ok && m.quarter).map((m) => m.quarter).sort()
  const q = qs.at(-1)?.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1') ?? 'Quarterly'
  page('season/', `${q} 13F filing season tracker: who has filed and what they bought · Copybook`, `Live through the 13F deadline: how many superinvestors and filers have filed ${q} 13Fs, the latest filings, and the most bought and sold stocks so far. From SEC EDGAR.`, '', season?.url)
}
page('for-funds/', 'Copybook for investment teams: My book, peer overlap and 13F alerts · Copy Fund', 'See who owns what you own across every 13F filer, compare your book with your peers, and get filings in Slack minutes after EDGAR. Five seats, invoiced annually.')
page('for-quants/', 'Copybook API for quants: 13F, Form 4 and 13D/G as JSON · Copy Pro', 'Every 13F filer’s latest holdings as JSON, with EDGAR accession and acceptance time on every filing. Point-in-time amendments, audited against EDGAR, from $39/month.')
page('my-book/', 'My book · Copybook', 'Your stocks through the eyes of every 13F filer: who holds them, who bought and sold this season, and every Form 4 and 13D.')
page('methodology/', 'Methodology · Copybook', 'How Copybook reads SEC 13F, Form 4 and Schedule 13D/G filings: amendments, unit fixes, options, tickers, refresh cadence, and a changelog of every data correction.')
page('api/', 'API · Copybook', 'The Copybook API: 13F, Form 4 and Schedule 13D/G data from SEC EDGAR as JSON, for Copy Pro and Copy Fund.')
page('contact/', 'Contact · Copybook', 'Request Copy Fund access for your team, ask a question, or ask us to delete your data.')
page('terms/', 'Terms of use · Copybook', 'The terms for using Copybook, its paid plans and its API.')
page('privacy/', 'Privacy · Copybook', 'What Copybook stores about you, why, and how to have it deleted. We never sell your data.')
page('security/', 'Security · Copybook', 'Where Copybook keeps data and how it is protected.')
page('about/', 'About · Copybook', 'Portfolios, as filed. How Copybook reads SEC 13F filings, and what it won’t do.')
let n = 0
mkdirSync(join(dist, 'managers'), { recursive: true })
for (const m of index.managers) {
  if (!m.ok) continue
  const who = tc(m.manager)
  const firm = tc(m.name)
  page(`investors/${m.slug}/`, `${who} portfolio · Copybook`, `${who}${firm !== who ? ` (${firm})` : ''}: latest 13F holdings, top positions and sector mix, straight from the SEC filing.`)
  page(`investors/${m.slug}/history/`, `${who} 13F history · Copybook`, `${who}: eight quarters of 13F holdings, buys and sells across quarters, with CSV export.`)
  redirect(`managers/${m.slug}.html`, `investors/${m.slug}/`)
  n++
}
// Every other 13F filer (data/filers.json): one shell per filer, holdings load from data/f/{cik}.json.
// A filer that is also a curated fund redirects to the curated page.
let fn = 0
try {
  const filersSrc = src.replace(/index\.json$/, 'filers.json')
  const filers = (filersSrc.startsWith('http') ? await getJson(filersSrc) : JSON.parse(readFileSync(filersSrc, 'utf8'))).filers
  const curated = new Map(index.managers.filter((m) => m.ok).map((m) => [m.cik.replace(/^0+/, ''), m.slug]))
  const usd = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`)
  for (const f of filers) {
    if (!f.ok || !f.slug) continue
    const to = curated.get(f.cik.replace(/^0+/, ''))
    if (to) {
      mkdirSync(join(dist, 'investors', f.slug), { recursive: true })
      redirect(`investors/${f.slug}/index.html`, `investors/${to}/`)
      continue
    }
    const who = tc(f.name)
    const q = f.quarter ? `Q${f.quarter.slice(5)} ${f.quarter.slice(0, 4)}` : 'latest'
    page(
      `investors/${f.slug}/`,
      `${who} 13F holdings · Copybook`,
      `${who}: ${q} 13F portfolio, ${f.position_count?.toLocaleString('en-US') ?? ''} positions${f.total_value ? ` worth ${usd(f.total_value)}` : ''}, with top holdings and sector mix, straight from the SEC filing.`,
      `\n    <meta name="cb-filer" content="${f.slug}:${f.cik}" />`,
    )
    fn++
  }
} catch (e) {
  console.warn(`filer pages skipped: ${e.message}`)
}
console.log(`wrote ${fn} filer pages`)
page('flow/', 'Smart money flow · Copybook', 'What the best investors bought and sold this 13F season: most bought, most sold, and new positions opened by two or more funds.')
// Stock pages (scripts/stocks.mjs runs first): prerender tickers held by 2+ funds; the rest render from 404.html.
let st = 0
try {
  const stocks = JSON.parse(readFileSync(join(dist, 'd', 'stocks.json'), 'utf8')).stocks
  for (const s of stocks) {
    if (s.h < 2) continue
    page(`stocks/${s.t}/`, `${s.t} ${s.n}: who owns it · Copybook`, `${s.n} (${s.t}): which of the investors we track hold it, who bought and sold it in the latest 13F filings, and how the holder count changed.`)
    st++
  }
} catch {
  // No stock index: build without stock pages.
}
console.log(`wrote ${st} stock pages`)
redirect('copycat.html', 'consensus/')
redirect('pricing.html', 'pricing/')
mkdirSync(join(dist, 'latency'), { recursive: true })
redirect('latency/index.html', 'methodology/#latency')
redirect('about.html', 'about/')
writeFileSync(join(dist, '404.html'), shell)
writeFileSync(join(dist, '.nojekyll'), '')
console.log(`wrote ${n} investor pages`)
