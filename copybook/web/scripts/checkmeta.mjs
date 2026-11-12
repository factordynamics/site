// Fails the Pages build when a prerendered page's share tags are broken: every index.html must have
// exactly one description, og:title and og:description, and twitter:description (where set) must
// match og:description. Also fails when any text file (HTML, JS, JSON, CSS, XML, maps) names a machine or tunnel
// host: public assets only ever name the Worker (the lead, Nov 12). Usage: node scripts/checkmeta.mjs <dist dir>
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

// No machine or tunnel host in any public file: quick tunnels, the tailnet, gene's tailnet name.
const HOSTS = /trycloudflare|\.ts\.net\b|tail70ba3/i
const text = readdirSync(dist, { recursive: true }).filter((f) => /\.(html|js|mjs|json|css|xml|txt|map|svg|webmanifest)$/.test(String(f)))
const leaks = []
for (const f of text) {
  const m = readFileSync(join(dist, String(f)), 'utf8').match(HOSTS)
  if (m) leaks.push(`${f}: ${m[0]}`)
}
if (leaks.length) {
  console.error(`machine or tunnel host in ${leaks.length} public files:\n${leaks.slice(0, 20).join('\n')}`)
  process.exit(1)
}
console.log(`no machine or tunnel hosts in ${text.length} files`)
