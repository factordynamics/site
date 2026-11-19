// The Factor Dynamics Catalog (umbrella ticket UMB-1): a static preview of factordynamics.com's home, Products menu,
// product pages, pricing and API hub, deployed to a *.pages.dev address only. No DNS, nothing links to it, no
// Functions and no requests at runtime. Prices and counts are today's, as Copybook and Holdterm state them; SEC
// EDGAR data only. Usage: node catalog/build.mjs  (writes catalog/dist/)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = new URL('./dist/', import.meta.url).pathname
const COPYBOOK = 'https://copybook.factordynamics.com/'
const HOLDTERM = 'https://holdterm.factordynamics.com/'
const CONTACT = 'hello@factordynamics.com'

/** The catalog, grouped by job. Live products link out; Coming ones have no price and no sign-up yet. */
const PRODUCTS = [
  {
    group: 'Follow investors',
    items: [
      { slug: 'copybook', name: 'Copybook', state: 'Live', line: 'Every 13F from about 9,000 funds, with alerts', url: COPYBOOK, price: 'Free to browse; Copy from $9 a month' },
      { slug: 'holdterm', name: 'Holdterm', state: 'Live', line: 'Simple alerts for the investors you follow', url: HOLDTERM, price: 'Free to browse; alerts $3 a month' },
    ],
  },
  {
    group: 'Research companies',
    items: [
      { slug: 'insiders', name: 'Insiders', state: 'Coming', line: 'Every insider buy and sell, and new 5% stakes' },
      { slug: 'filings', name: 'Filings', state: 'Coming', line: '8-Ks by event, IPO filings and keyword alerts' },
    ],
  },
  {
    group: 'Build',
    items: [{ slug: 'copybook-api', name: 'Copybook API', state: 'Live', line: '13F, Form 4 and 13D/G by API', href: '/api/', price: 'With Copybook Pro, $39 a month' }],
  },
]

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const tag = (state) => `<span class="tag tag-${state.toLowerCase()}">${state}</span>`
const href = (p) => p.href ?? `/products/${p.slug}/`

const menu = `<details class="menu">
      <summary>Products</summary>
      <div class="menu-panel">
        ${PRODUCTS.map((g) => `<div><p class="menu-group">${g.group}</p>${g.items.map((p) => `<a class="menu-item" href="${href(p)}"><b>${p.name}</b> ${p.state !== 'Live' ? tag(p.state) : ''}<span>${esc(p.line)}</span></a>`).join('')}</div>`).join('\n        ')}
        <p class="menu-foot">Each product is sold on its own. <a href="/pricing/">See pricing</a></p>
      </div>
    </details>`

function page(path, title, desc, body, product = null) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <aside class="preview" aria-label="Preview notice">Preview. Not linked from anywhere yet; prices and products as of Nov 19, 2026.</aside>
  <header class="top wrap">
    <a class="logo" href="/">Factor Dynamics</a>${product ? ` <span class="crumb">/ ${product}</span>` : ''}
    <nav aria-label="Main">
      ${menu}
      <a href="/pricing/">Pricing</a>
      <a href="/api/">API</a>
    </nav>
  </header>
  <main class="wrap">
${body}
  </main>
  <footer class="wrap foot">
    <nav aria-label="Footer"><a href="/">Products</a> <a href="/pricing/">Pricing</a> <a href="/api/">API</a> <a href="${COPYBOOK}status/">Status</a> <a href="${COPYBOOK}terms/">Copybook terms</a> <a href="${COPYBOOK}privacy/">Privacy</a> <a href="mailto:${CONTACT}">Contact</a></nav>
    <p>Data from SEC EDGAR filings, as filed. Not investment advice.</p>
  </footer>
  <script>
    // Close the Products menu on Escape or a click outside it.
    const m = document.querySelector('.menu')
    document.addEventListener('click', (e) => { if (m.open && !m.contains(e.target)) m.open = false })
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && m.open) { m.open = false; m.querySelector('summary').focus() } })
  </script>
</body>
</html>
`
  mkdirSync(join(out, path), { recursive: true })
  writeFileSync(join(out, path, 'index.html'), html)
}

const card = (p) => `<a class="card" href="${href(p)}">
        <p class="card-head"><b>${p.name}</b> ${tag(p.state)}</p>
        <p>${esc(p.line)}.</p>
        <p class="dim">${p.price ? esc(p.price) : 'Launch date to be announced.'}</p>
      </a>`

rmSync(out, { recursive: true, force: true })

page(
  '',
  'Factor Dynamics · Investing tools built on SEC filings',
  'Separate tools for following investors and, soon, tracking insiders and reading filings. Every number links to its SEC source.',
  `    <section class="hero">
      <h1>Investing tools built on what companies and investors file with the SEC.</h1>
      <p class="lede">Follow superinvestors today; track insiders and read every 8-K soon. Each tool stands on its own, with its own free tier and price. Every number links to the filing it came from.</p>
      <p class="actions"><a class="btn" href="#products">Explore products</a> <a class="btn btn-2" href="/pricing/">See pricing</a></p>
      <p class="dim small">Free to start. No market prices; just what was filed.</p>
    </section>
    <section id="products">
${PRODUCTS.map((g) => `      <h2>${g.group}</h2>\n      <div class="grid">\n      ${g.items.map(card).join('\n      ')}\n      </div>`).join('\n')}
    </section>
    <section class="why">
      <div><h3>Primary sources</h3><p>Every row links to the filing on SEC EDGAR.</p></div>
      <div><h3>As filed</h3><p>We show what was reported, on the day it was filed.</p></div>
      <div><h3>Fast</h3><p>Copybook reads EDGAR every minute.</p></div>
    </section>`,
)

page(
  'products/copybook',
  'Copybook · Factor Dynamics',
  'Every 13F from about 9,000 funds, with alerts as they are filed.',
  `    <section class="hero">
      <p>${tag('Live')}</p>
      <h1>Copybook</h1>
      <p class="lede">Every 13F from about 9,000 funds, with an alert when the funds you follow file. Form 4 and Schedule 13D/G moves from the investors it tracks closely, a season tracker on deadline weeks, and every alert timed in public on its speed page.</p>
      <p class="actions"><a class="btn" href="${COPYBOOK}">Open Copybook</a> <a class="btn btn-2" href="${COPYBOOK}pricing/">Copybook pricing</a></p>
    </section>
    <section>
      <h2>Plans</h2>
      <ul class="plain">
        <li><b>Free:</b> browse every 13F filer, stock and season page.</li>
        <li><b>Copy:</b> $9 a month or $79 a year, founding price through Jan 31, 2027; from Feb 1, new members pay $12 or $99. 14 days free, no card needed.</li>
        <li><b>Pro:</b> $39 a month or $390 a year, with API keys, bulk files and the full My book.</li>
        <li><b>Fund:</b> $199 a month or $1,990 a year, for up to 10 seats.</li>
      </ul>
    </section>`,
  'Copybook',
)

page(
  'products/holdterm',
  'Holdterm · Factor Dynamics',
  'What 185 concentrated, long-term investors own, buy and sell, with an email when they move.',
  `    <section class="hero">
      <p>${tag('Live')}</p>
      <h1>Holdterm</h1>
      <p class="lede">See what 185 concentrated, long-term investors own, buy and sell, from the reports they file with the SEC, and get an email when the ones you pick make a move. No ads.</p>
      <p class="actions"><a class="btn" href="${HOLDTERM}">Open Holdterm</a> <a class="btn btn-2" href="${HOLDTERM}alerts">Holdterm alerts</a></p>
    </section>
    <section>
      <h2>Plans</h2>
      <ul class="plain">
        <li><b>Free:</b> every investor, stock and portfolio page.</li>
        <li><b>Alerts:</b> $29 a year or $3 a month, after a 7-day free trial.</li>
      </ul>
    </section>`,
  'Holdterm',
)

for (const [slug, name, line] of [
  ['insiders', 'Insiders', 'Every insider purchase and sale, planned sales from Form 144, and new 5% stakes, for every company.'],
  ['filings', 'Filings', 'Every 8-K sorted by what happened, IPOs from first S-1 to final prospectus, and alerts on the words you watch.'],
])
  page(
    `products/${slug}`,
    `${name} · Factor Dynamics`,
    line,
    `    <section class="hero">
      <p>${tag('Coming')}</p>
      <h1>${name}</h1>
      <p class="lede">${line}</p>
      <p class="dim">Not available yet, and no launch date or price is set. It will read SEC EDGAR filings only.</p>
    </section>`,
    name,
  )

page(
  'pricing',
  'Pricing · Factor Dynamics',
  'Each product has its own free tier and price.',
  `    <section class="hero">
      <h1>Pay for the products you use.</h1>
      <p class="lede">Each product has its own free tier and price, and each subscription is separate: cancel one and keep the rest.</p>
    </section>
    <section>
      <div class="table">
        <table>
          <thead><tr><th>Product</th><th>Free</th><th>Paid</th></tr></thead>
          <tbody>
            <tr><td><a href="/products/copybook/">Copybook</a></td><td>Browse every 13F</td><td><ul class="plans"><li><b>Copy</b> $9/mo or $79/yr, founding price through Jan 31, 2027; then $12/mo or $99/yr for new members</li><li><b>Pro</b> $39/mo or $390/yr</li><li><b>Fund</b> $199/mo or $1,990/yr, up to 10 seats</li></ul></td></tr>
            <tr><td><a href="/products/holdterm/">Holdterm</a></td><td>Browse the investors</td><td>Holdterm alerts $3/mo or $29/yr, 7-day free trial</td></tr>
            <tr><td><a href="/products/insiders/">Insiders</a> ${tag('Coming')}</td><td>Not yet available</td><td>Not set</td></tr>
            <tr><td><a href="/products/filings/">Filings</a> ${tag('Coming')}</td><td>Not yet available</td><td>Not set</td></tr>
          </tbody>
        </table>
      </div>
      <p class="dim small">Prices exclude applicable taxes. Checkout happens on each product's own site.</p>
    </section>`,
)

page(
  'api',
  'API · Factor Dynamics',
  'The Copybook API: 13F holdings, holders, Form 4 and 13D/G filings by API.',
  `    <section class="hero">
      <h1>API</h1>
      <p class="lede">One API today, from Copybook.</p>
    </section>
    <section class="grid">
      <a class="card" href="${COPYBOOK}api/">
        <p class="card-head"><b>Copybook API</b> ${tag('Live')}</p>
        <p>13F holdings and holders for every filer, filing history, Form 4 and Schedule 13D/G events, bulk CSV files and signed webhooks, all from SEC EDGAR.</p>
        <p class="dim">With Copybook Pro, $39 a month. Base URL <code>https://copybook-api.factordynamics.workers.dev</code>. Read the docs.</p>
      </a>
    </section>`,
)

writeFileSync(
  join(out, 'style.css'),
  `:root{--paper:#fbfaf7;--paper-2:#f4f2ed;--card:#fff;--ink:#0c0e13;--ink-2:#393e49;--ink-3:#5f6572;--line:#e6e3dc;--accent:#2b44d6;--accent-2:#1f33a8;--accent-soft:#e9ecfc}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}a:hover{color:var(--accent-2)}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.preview{display:block;margin:0;background:var(--ink);color:#fff;text-align:center;font-size:12.5px;padding:6px 12px}
.top{display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px;padding-top:16px;padding-bottom:16px;border-bottom:1px solid var(--line)}
.logo{font-weight:700;color:var(--ink);text-decoration:none;letter-spacing:-.01em}
.crumb{color:var(--ink-3)}
.top nav{margin-left:auto;display:flex;align-items:center;gap:18px;font-size:15px}
.top nav>a{color:var(--ink-2);text-decoration:none}.top nav>a:hover{color:var(--ink)}
.menu{position:relative}
.menu summary{cursor:pointer;list-style:none;color:var(--ink-2);font-size:15px}
.menu summary::-webkit-details-marker{display:none}
.menu summary::after{content:" ▾"}
.menu[open] summary{color:var(--ink)}
.menu-panel{position:absolute;right:-120px;top:calc(100% + 12px);z-index:10;width:min(640px,calc(100vw - 24px));display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:18px;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 32px rgb(12 14 19/.12)}
.menu-group{margin:0 0 6px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-3)}
.menu-item{display:block;padding:8px;margin:0 -8px;border-radius:8px;color:var(--ink);text-decoration:none;font-size:14px}
.menu-item:hover{background:var(--paper-2);color:var(--ink)}
.menu-item span:last-child{display:block;color:var(--ink-3);font-size:13px;line-height:1.4}
.menu-foot{grid-column:1/-1;margin:0;padding-top:12px;border-top:1px solid var(--line);font-size:13px;color:var(--ink-2)}
.hero{padding:56px 0 24px;max-width:720px}
h1{font-size:clamp(30px,5vw,46px);line-height:1.1;letter-spacing:-.025em;margin:0 0 16px}
h2{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3);margin:36px 0 12px}
h3{font-size:16px;margin:0 0 4px}
.lede{font-size:18px;color:var(--ink-2);margin:0 0 20px}
.dim{color:var(--ink-3)}.small{font-size:13px}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 12px}
.btn{display:inline-block;padding:10px 16px;border-radius:10px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;font-size:15px}
.btn:hover{background:var(--accent-2);color:#fff}
.btn-2{background:var(--card);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}.btn-2:hover{background:var(--paper-2);color:var(--ink)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{display:block;padding:18px;background:var(--card);border:1px solid var(--line);border-radius:14px;color:var(--ink);text-decoration:none}
.card:hover{border-color:var(--accent);color:var(--ink)}
.card p{margin:0 0 6px}.card .dim{margin:0;font-size:14px}
.card-head{display:flex;align-items:center;gap:8px;font-size:17px}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;vertical-align:1px}
.tag-live{background:#e3f4e8;color:#1c6b37}.tag-coming{background:var(--paper-2);color:var(--ink-3);box-shadow:inset 0 0 0 1px var(--line)}
.why{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;margin:48px 0 0;padding:24px 0;border-top:1px solid var(--line)}
.why p{margin:0;color:var(--ink-2);font-size:15px}
.plain{padding-left:20px;color:var(--ink-2)}.plain li{margin:6px 0}
.plans{list-style:none;margin:0;padding:0}.plans li+li{margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)}
.table{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:14px}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{text-align:left;vertical-align:top;padding:12px 14px;border-bottom:1px solid var(--line)}
th{font-size:13px;color:var(--ink-3);font-weight:600}
tr:last-child td{border-bottom:0}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.foot{margin-top:64px;padding-top:20px;padding-bottom:32px;border-top:1px solid var(--line);font-size:14px;color:var(--ink-3)}
.foot nav{display:flex;flex-wrap:wrap;gap:6px 16px}.foot nav a{color:var(--ink-2);text-decoration:none}
@media (max-width:640px){
  .top nav{margin-left:0;width:100%;gap:16px}
  .menu{position:static}
  .top{position:relative}
  .menu-panel{left:12px;right:12px;width:auto;grid-template-columns:1fr;gap:6px;box-shadow:0 16px 40px rgb(12 14 19/.25)}
  /* Open on a phone: dim the page behind the panel so it reads as a menu, not as page content. */
  .menu[open] summary::before{content:"";position:fixed;inset:0;z-index:9;background:rgb(12 14 19/.5);cursor:default}
  .hero{padding-top:36px}
  .lede{font-size:16.5px}
}
`,
)
writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n')
writeFileSync(join(out, '404.html'), '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found · Factor Dynamics</title><p style="font:16px system-ui;padding:40px">Page not found. <a href="/">Factor Dynamics</a></p>\n')
console.log('catalog/dist written')
