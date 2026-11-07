// Writes a static index.html for every route so GitHub Pages serves deep links directly,
// with per-page titles, plus redirect stubs for the old .html URLs.
// Usage: node scripts/postbuild.mjs <index.json path or URL>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dist = new URL('../dist/', import.meta.url).pathname
const src = process.argv[2] || 'https://refcell.github.io/gust/copybook/data/index.json'
const index = src.startsWith('http') ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, 'utf8'))
const shell = readFileSync(join(dist, 'index.html'), 'utf8')
const SITE = process.env.VITE_SITE || 'https://copybook.factordynamics.com/'

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
function page(path, title, desc) {
  let html = shell
    .replace(/<title>.*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${esc(desc)}`)
    .replace(/(<meta property="og:title" content=")[^"]*/, `$1${esc(title)}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, `$1${esc(desc)}`)
    .replace('<meta property="og:type"', `<link rel="canonical" href="${SITE}${path}" />\n    <meta property="og:type"`)
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

const tc = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()))
page('investors/', 'Investors · Copybook', 'Latest 13F portfolios of legendary value investors, hedge-fund founders, activists and the largest institutions.')
page('consensus/', 'Consensus · Copybook', 'Where great investors agree: one combined book from the latest 13F filings of the superinvestors we follow.')
page('pricing/', 'Pricing · Copybook', 'The latest quarter is free. Copy adds quarter-over-quarter changes, full history, filing alerts and CSV export.')
page('account/', 'Account · Copybook', 'Manage your Copy subscription.')
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
redirect('copycat.html', 'consensus/')
redirect('pricing.html', 'pricing/')
redirect('about.html', 'about/')
writeFileSync(join(dist, '404.html'), shell)
writeFileSync(join(dist, '.nojekyll'), '')
console.log(`wrote ${n} investor pages`)
