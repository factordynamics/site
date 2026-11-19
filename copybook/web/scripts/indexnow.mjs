// IndexNow for Copybook: after each Pages deploy, tell Bing, Yandex and the other IndexNow engines which pages changed.
// The key is public by design (IndexNow checks it at https://copybook.factordynamics.com/<key>.txt); the
// only <32 hex>.txt in public/ is it. Nothing here may fail a build or a deploy: every error is logged and exits 0.
//
//   node scripts/indexnow.mjs prep dist <urls file>   Before deploy. Hashes each sitemap page's HTML (minus the
//       build's asset names and build tag, which change on every code deploy) into dist/indexnow.json, diffs it with the
//       live site's copy and writes the changed page URLs to <urls file>. If the live copy can't be read, or this
//       is the first run, it writes none: only changed pages are ever sent.
//   node scripts/indexnow.mjs submit <urls file>      After deploy. POSTs the URLs to api.indexnow.org in batches of 10,000.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SITE = process.env.VITE_SITE || 'https://copybook.factordynamics.com/'
const BATCH = 10_000 // IndexNow's limit per request
const pub = new URL('../public/', import.meta.url).pathname
const KEY = readdirSync(pub).find((f) => /^[0-9a-f]{32}\.txt$/.test(f))?.slice(0, -4)

/** What a crawler reads on the page, without what every code deploy changes. */
export const fingerprint = (html) =>
  createHash('sha256')
    .update(html.replace(/\/assets\/[^"'\s)]+/g, '').replace(/<meta name="copybook-build"[^>]*>/, ''))
    .digest('base64url')
    .slice(0, 12)

async function prep(dist, out) {
  writeFileSync(out, '')
  const urls = [...readFileSync(join(dist, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
  const now = {}
  for (const u of urls) {
    const f = join(dist, u.slice(SITE.length), 'index.html')
    if (existsSync(f)) now[u.slice(SITE.length)] = fingerprint(readFileSync(f, 'utf8'))
  }
  writeFileSync(join(dist, 'indexnow.json'), JSON.stringify(now))
  let prev = null
  try {
    const r = await fetch(`${SITE}indexnow.json?t=${Date.now()}`, { signal: AbortSignal.timeout(20_000) })
    if (r.status === 404) return console.log('indexnow: first run, no live indexnow.json; baseline written, nothing submitted')
    if (r.ok) prev = await r.json()
    else throw new Error(`HTTP ${r.status}`)
  } catch (e) {
    console.log(`indexnow: live indexnow.json unreadable (${e.message}); submitting nothing this run`)
    return
  }
  const changed = Object.keys(now).filter((p) => prev[p] !== now[p])
  writeFileSync(out, changed.map((p) => SITE + p).join('\n'))
  console.log(`indexnow: ${Object.keys(now).length} pages, ${changed.length} changed since the live deploy`)
}

async function submit(file) {
  if (!KEY) return console.log('indexnow: no key file in public/; nothing sent')
  const urls = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  if (!urls.length) return console.log('indexnow: no changed pages')
  const host = new URL(SITE).host
  for (let i = 0; i < urls.length; i += BATCH) {
    const urlList = urls.slice(i, i + BATCH)
    const r = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key: KEY, keyLocation: `${SITE}${KEY}.txt`, urlList }),
      signal: AbortSignal.timeout(30_000),
    })
    // 200 and 202 are accepted; anything else is logged, never fatal.
    console.log(`indexnow: sent ${urlList.length} URLs, HTTP ${r.status}${r.ok ? '' : ` ${(await r.text()).slice(0, 200)}`}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, a, b] = process.argv.slice(2)
  try {
    await (mode === 'prep' ? prep(a, b) : submit(a))
  } catch (e) {
    console.log(`indexnow: skipped (${e.message})`)
  }
  process.exit(0)
}
