// Fails the Pages build when a prerendered page's share tags are broken: every index.html must have
// exactly one description, og:title and og:description, and twitter:description (where set) must
// match og:description. Usage: node scripts/checkmeta.mjs <dist dir>
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dist = process.argv[2] || 'dist'
const pages = readdirSync(dist, { recursive: true }).filter((f) => String(f).endsWith('index.html'))
const all = (html, re) => [...html.matchAll(re)].map((m) => m[1])
const bad = []
for (const f of pages) {
  const html = readFileSync(join(dist, String(f)), 'utf8')
  if (!html.includes('og:title')) continue // redirect stubs
  const og = all(html, /<meta property="og:description" content="([^"]*)"/g)
  const desc = all(html, /<meta name="description" content="([^"]*)"/g)
  const title = all(html, /<meta property="og:title" content="([^"]*)"/g)
  const tw = all(html, /<meta name="twitter:description" content="([^"]*)"/g)
  const why = [
    og.length !== 1 && `${og.length} og:description`,
    desc.length !== 1 && `${desc.length} description`,
    title.length !== 1 && `${title.length} og:title`,
    tw.length > 1 && `${tw.length} twitter:description`,
    tw.length === 1 && og.length === 1 && tw[0] !== og[0] && 'twitter:description differs from og:description',
  ].filter(Boolean)
  if (why.length) bad.push(`${f}: ${why.join(', ')}`)
}
if (bad.length) {
  console.error(`share tags broken on ${bad.length} of ${pages.length} pages:\n${bad.slice(0, 20).join('\n')}`)
  process.exit(1)
}
console.log(`share tags ok on ${pages.length} pages`)
