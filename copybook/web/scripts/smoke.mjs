// Browser smoke test, run on the built site before every deploy (P0 fixes included): serves dist the way
// GitHub Pages does, opens it in current stable Chrome, clicks from home to Season, Security, Pricing and a
// fund page, presses Back, and exits non-zero on a blank page or any uncaught page error.
// Usage: node scripts/smoke.mjs dist   (SMOKE_CHROME=/path/to/chrome to use a local binary instead of channel chrome)
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const dist = process.argv[2] ?? 'dist'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain' }

// Like Pages: a directory serves its index.html (redirecting to the trailing slash), a missing path gets 404.html.
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = normalize(join(dist, path))
  if (!file.startsWith(normalize(dist))) return res.writeHead(403).end()
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!path.endsWith('/')) return res.writeHead(301, { Location: path + '/' }).end()
    file = join(file, 'index.html')
  }
  const found = existsSync(file) && statSync(file).isFile()
  res.writeHead(found ? 200 : 404, { 'Content-Type': TYPES[extname(found ? file : '.html')] ?? 'application/octet-stream' })
  res.end(readFileSync(found ? file : join(dist, '404.html')))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch(process.env.SMOKE_CHROME ? { executablePath: process.env.SMOKE_CHROME } : { channel: 'chrome' })
console.log(`Chrome ${browser.version()}`)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`))

let failed = false
const fail = (msg) => {
  failed = true
  console.error(`✗ ${msg}`)
}
// The page counts as rendered once the root holds the page's own text, not just the header.
async function check(label, path) {
  try {
    await page.waitForURL((u) => u.pathname.startsWith(path), { timeout: 10000 })
    await page.waitForFunction(() => (document.querySelector('main')?.innerText ?? document.getElementById('root')?.innerText ?? '').trim().length > 200, null, { timeout: 15000 })
  } catch {
    const len = await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? 0).catch(() => 0)
    return fail(`${label}: ${len ? 'page content missing' : 'blank root'} at ${page.url()}`)
  }
  if (errors.length) return fail(`${label}: page error: ${errors.splice(0).join(' | ')}`)
  // A section that threw is caught by its error boundary, so it shows no page error: look for its fallback.
  if (await page.locator('[data-boundary-error]').count()) return fail(`${label}: a section failed to render at ${page.url()}`)
  console.log(`✓ ${label} ${new URL(page.url()).pathname}`)
}
// Click a visible in-site link to the path, as a reader would (header, body or footer).
// With routeIfUnlinked, a missing link (Season outside a 13F season) becomes the same in-app route change.
async function go(label, path, pick = `a[href="${path}"]`, routeIfUnlinked = false) {
  const link = page.locator(pick).filter({ visible: true }).first()
  try {
    await link.waitFor({ timeout: 10000 })
  } catch {
    if (!routeIfUnlinked) return fail(`${label}: no link to ${path} on ${new URL(page.url()).pathname}`)
    await page.evaluate((p) => {
      history.pushState({}, '', p)
      dispatchEvent(new PopStateEvent('popstate'))
    }, path)
    return check(`${label} (no link outside a season; routed in-app)`, path)
  }
  const href = await link.getAttribute('href')
  await link.click()
  await check(label, href)
}

await page.goto(`${origin}/`)
await check('Home', '/')
// The header and home page link Season only while a 13F season is live.
await go('Season', '/season/', undefined, true)
await go('Security', '/security/')
await go('Pricing', '/pricing/')
await go('Investors', '/investors/')
await go('Fund page', '/investors/', 'main a[href^="/investors/"][href$="/"]:not([href="/investors/"])')
for (const path of ['/investors/', '/pricing/', '/security/']) {
  await page.goBack()
  await check('Back', path)
}
// Pages read from d/ files that the links above don't reach (a null in splits.json blanked /methodology/).
for (const path of ['/methodology/', '/api/', '/flow/', '/weekly/']) {
  await page.goto(`${origin}${path}`)
  await check('Direct', path)
}

await browser.close()
server.close()
if (failed) process.exit(1)
console.log('Smoke test passed')
