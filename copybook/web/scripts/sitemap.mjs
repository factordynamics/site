// Writes sitemap.xml and robots.txt for Copybook from the live data index.
// Runs in every Pages build (copybook-pages.yml, also every 3 hours), so each investor's lastmod
// tracks its latest filing.
// Usage: node sitemap.mjs <output dir> [index.json path or URL, default <output dir>/data/index.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || 'dist/copybook'
const SITE = process.env.VITE_SITE || 'https://copybook.factordynamics.com/'
const src = process.argv[3] || join(dir, 'data', 'index.json')
const index = src.startsWith('http') ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, 'utf8'))
const managers = index.managers.filter((m) => m.ok)
const newest = managers.map((m) => m.filing_date).filter(Boolean).sort().pop()

const urls = [
  ['', newest],
  ['investors/', newest],
  ['consensus/', newest],
  ['pricing/'],
  ['about/'],
  ...managers.map((m) => [`investors/${m.slug}/`, m.filing_date]),
]
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([p, d]) => `  <url><loc>${SITE}${p}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`
writeFileSync(join(dir, 'sitemap.xml'), xml)
writeFileSync(join(dir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`)
console.log(`sitemap.xml: ${urls.length} urls`)
