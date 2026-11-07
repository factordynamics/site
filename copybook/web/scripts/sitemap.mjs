// Writes sitemap.xml and robots.txt for Copybook from the live data index.
// Runs in gust's Pages build (as scripts/copybook-sitemap.mjs) after every data refresh,
// so each investor page's lastmod tracks its latest 13F filing date.
// Usage: node sitemap.mjs <copybook dir containing data/index.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || 'dist/copybook'
const SITE = 'https://refcell.github.io/gust/copybook/'
const index = JSON.parse(readFileSync(join(dir, 'data', 'index.json'), 'utf8'))
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
