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
// Structured data for search: one JSON-LD block per page (`<` escaped so a name can't close the script).
const ld = (o) => `\n    <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...o }).replace(/</g, '\\u003c')}</script>`
const ORG = { '@type': 'Organization', name: 'Copybook', url: SITE, logo: `${SITE}apple-touch-icon.png` }
const EDGAR = { '@type': 'CreativeWork', name: 'SEC EDGAR Form 13F filings', url: 'https://www.sec.gov/edgar/search/' }
const crumbs = (...items) => ({ '@type': 'BreadcrumbList', itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE}${path}` })) })
const usd = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`)
const qLabel = (q) => (q ? q.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1') : 'latest')
const dayLabel = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const num = (v) => Number(v ?? 0).toLocaleString('en-US')
const readDist = (...p) => {
  try {
    return JSON.parse(readFileSync(join(dist, ...p), 'utf8'))
  } catch {
    return null
  }
}
const seasonData = readDist('d', 'season.json')
const built = seasonData?.generated_at ?? index.generated_at ?? new Date().toISOString()

function redirect(file, to) {
  writeFileSync(
    join(dist, file),
    `<!doctype html><meta charset="utf-8"><title>Copybook</title><link rel="canonical" href="${SITE}${to}"><meta http-equiv="refresh" content="0; url=${SITE}${to}"><script>location.replace(${JSON.stringify(SITE + to)})</script>`,
  )
}

page(
  '',
  'Copybook: see what the world’s best investors own',
  'Portfolios of the world’s great investors, read straight from their SEC 13F filings. Top positions, sector mix and where they agree.',
  ld({ '@graph': [ORG, { '@type': 'WebSite', name: 'Copybook', url: SITE, description: 'Superinvestor and hedge fund portfolios from SEC 13F filings.', publisher: { '@type': 'Organization', name: 'Copybook' } }] }),
)
const tc = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(Llc|Lp|Llp|Plc|Etf|Ag|Sa|Nv|Se|Ii|Iii|Usa)\b/g, (w) => w.toUpperCase()))
page('investors/', 'Investors · Copybook', 'Latest 13F portfolios of legendary value investors, hedge-fund founders, activists and the largest institutions.')
page('consensus/', 'Consensus · Copybook', 'Where great investors agree: one combined book from the latest 13F filings of the superinvestors we follow.')
page('pricing/', 'Pricing · Copybook', 'The latest quarter is free. Copy adds quarter-over-quarter changes, full history, filing alerts and CSV export.')
page('account/', 'Account · Copybook', 'Manage your Copy subscription.')
{
  // /speed/'s share card (scripts/cards.mjs): the season's median and p90, or the waiting state.
  let sp = null
  try {
    sp = JSON.parse(readFileSync(join(dist, 'og', 'speed.json'), 'utf8'))
  } catch {}
  page('speed/', 'Alert speed: EDGAR to inbox, every alert timed · Copybook', 'How fast Copybook alerts arrive: the median and 90th percentile from SEC EDGAR acceptance to delivery for 13F, Form 4 and 13D/G filings, and every live alert this season.', '', sp?.url)
}
page('upgrade/', 'Upgrade · Copybook', 'Switch your Copy plan to Copy Pro or Copy Fund, prorated, on the same billing interval.')
{
  // The season tracker's share card (scripts/cards.mjs), with its cache-busting URL.
  let season = null
  try {
    season = JSON.parse(readFileSync(join(dist, 'og', 'season.json'), 'utf8'))
  } catch {}
  // The season recap, with its own title and share card (scripts/cards.mjs).
  try {
    const rq = index.managers.filter((m) => m.ok && m.quarter).map((m) => m.quarter).sort().at(-1).toLowerCase()
    for (const k of [rq, `${rq}-pct`]) {
      const r = JSON.parse(readFileSync(join(dist, 'og', `season-${k}.json`), 'utf8'))
      page(r.path, r.title, r.desc, ld({ '@type': 'Article', headline: r.title.replace(/ · Copybook$/, ''), description: r.desc, image: r.url, url: `${SITE}${r.path}`, dateModified: built, publisher: ORG, author: ORG, isBasedOn: EDGAR, mainEntityOfPage: `${SITE}${r.path}` }), r.url)
    }
  } catch {}
  // The season tracker's title names the quarter now filing, for search during filing week.
  const qs = index.managers.filter((m) => m.ok && m.quarter).map((m) => m.quarter).sort()
  const q = qs.at(-1)?.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1') ?? 'Quarterly'
  // The tracker's title and description carry this build's counts (rebuilt every 20 minutes in filing week).
  const sd = seasonData
  const sq = sd ? qLabel(sd.quarter) : q
  const title = sd ? `${sq} 13F filing season: ${sd.featured.filed} of ${sd.featured.total} superinvestors filed · live tracker` : `${q} 13F filing season tracker: who has filed and what they bought · Copybook`
  const desc = sd
    ? `Live through the ${dayLabel(sd.deadline)} deadline: ${num(sd.filers.filed)} of about ${num(sd.filers.total)} 13F filers and ${sd.featured.filed} of ${sd.featured.total} superinvestors have filed ${sq} 13Fs. Who filed, who is next, and the most bought and sold stocks so far, from SEC EDGAR.`
    : `Live through the 13F deadline: how many superinvestors and filers have filed ${q} 13Fs, the latest filings, and the most bought and sold stocks so far. From SEC EDGAR.`
  page('season/', title, desc, ld({ '@type': 'Article', headline: title, description: desc, image: season?.url, url: `${SITE}season/`, dateModified: built, publisher: ORG, author: ORG, isBasedOn: EDGAR, mainEntityOfPage: `${SITE}season/` }), season?.url)
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
  // Live numbers in the title and description: the quarter, book size, position count and top holdings.
  const total = m.long_value ?? m.equity_value ?? m.total_value
  const count = m.position_count ?? m.long_positions
  const top = (m.top ?? [])
    .filter((h) => !h.put_call)
    .slice(0, 3)
    .map((h) => `${h.display_name ?? tc(h.issuer)} ${((h.weight ?? 0) * 100).toFixed(1)}%`)
  const title = total ? `${who} 13F portfolio, ${qLabel(m.quarter)}: ${usd(total)} in ${num(count)} positions` : `${who} portfolio · Copybook`
  const desc = `${firm !== who ? `${who} (${firm})` : who}: the ${qLabel(m.quarter)} 13F${m.filing_date ? `, filed ${dayLabel(m.filing_date)}` : ''}${total ? `, ${usd(total)} across ${num(count)} positions` : ''}.${top.length ? ` Top holdings: ${top.join(', ')}.` : ''} Buys, sells and sector mix, straight from the SEC filing.`
  page(
    `investors/${m.slug}/`,
    title,
    desc,
    ld({ '@graph': [{ '@type': 'Dataset', name: `${who} 13F holdings, ${qLabel(m.quarter)}`, description: desc, url: `${SITE}investors/${m.slug}/`, creator: ORG, isBasedOn: m.sec_url ?? EDGAR.url, dateModified: m.filing_date ?? built, temporalCoverage: m.report_date ?? undefined, about: { '@type': 'Organization', name: firm }, isAccessibleForFree: true }, crumbs(['Investors', 'investors/'], [who, `investors/${m.slug}/`])] }),
  )
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
  for (const f of filers) {
    if (!f.ok || !f.slug) continue
    const to = curated.get(f.cik.replace(/^0+/, ''))
    if (to) {
      // A filer that became a curated fund under the same slug (Akre) keeps its investor page; a redirect
      // to itself would reload forever.
      if (to !== f.slug) {
        mkdirSync(join(dist, 'investors', f.slug), { recursive: true })
        redirect(`investors/${f.slug}/index.html`, `investors/${to}/`)
      }
      continue
    }
    const who = tc(f.name)
    const q = f.quarter ? `Q${f.quarter.slice(5)} ${f.quarter.slice(0, 4)}` : 'latest'
    page(
      `investors/${f.slug}/`,
      `${who} 13F holdings · Copybook`,
      `${who}: ${q} 13F portfolio, ${f.position_count?.toLocaleString('en-US') ?? ''} positions${f.total_value ? ` worth ${usd(f.total_value)}` : ''}, with top holdings and sector mix, straight from the SEC filing.`,
      `\n    <meta name="cb-filer" content="${f.slug}:${f.cik}" />` +
        ld({ '@type': 'Dataset', name: `${who} 13F holdings, ${q}`, description: `${who}: ${q} 13F portfolio from SEC EDGAR.`, url: `${SITE}investors/${f.slug}/`, creator: ORG, isBasedOn: EDGAR.url, dateModified: f.filing_date ?? built, about: { '@type': 'Organization', name: who }, isAccessibleForFree: true }),
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
  const seasonQ = qLabel(seasonData?.quarter ?? index.managers.map((m) => m.quarter).filter(Boolean).sort().at(-1))
  for (const s of stocks) {
    if (s.h < 2) continue
    // "Who owns CRWD? 2,626 13F filers, 48 hedge funds": the counts the page opens with (d/h, scripts/stocks.mjs).
    const h = readDist('d', 'h', `${s.t}.json`)
    const all = h?.index?.holders ?? h?.current
    const hedge = h?.hedge?.current ?? 0
    const smart = h?.smart?.current ?? 0
    const title = all ? `Who owns ${s.t}? ${num(all)} 13F filers${hedge ? `, ${num(hedge)} hedge funds` : ''} · ${seasonQ}` : `${s.t} ${s.n}: who owns it · Copybook`
    const desc = all
      ? `${s.n} (${s.t}) is held by ${num(all)} 13F filers, including ${num(hedge)} hedge funds, ${num(smart)} hedge funds and long-only managers, and ${num(s.h)} of the funds we track closely.${h?.index ? ` In their latest 13Fs, ${num(h.index.new)} opened a position and ${num(h.index.exited)} sold out.` : ''} Largest holders and who bought and sold, from SEC EDGAR.`
      : `${s.n} (${s.t}): which of the investors we track hold it, who bought and sold it in the latest 13F filings, and how the holder count changed.`
    page(
      `stocks/${s.t}/`,
      title,
      desc,
      ld({ '@graph': [{ '@type': 'Dataset', name: `${s.n} (${s.t}) 13F holders`, description: desc, url: `${SITE}stocks/${s.t}/`, creator: ORG, isBasedOn: EDGAR.url, dateModified: h?.generated_at ?? built, about: { '@type': 'Corporation', name: s.n, tickerSymbol: s.t }, variableMeasured: ['13F holders', 'hedge fund holders', 'shares held', 'value held'], isAccessibleForFree: true }, crumbs(['Stocks', 'consensus/'], [s.t, `stocks/${s.t}/`])] }),
    )
    st++
  }
} catch {
  // No stock index: build without stock pages.
}
console.log(`wrote ${st} stock pages`)
redirect('copycat.html', 'consensus/')
redirect('pricing.html', 'pricing/')
mkdirSync(join(dist, 'latency'), { recursive: true })
redirect('latency/index.html', 'speed/')
redirect('about.html', 'about/')
writeFileSync(join(dist, '404.html'), shell)
writeFileSync(join(dist, '.nojekyll'), '')
console.log(`wrote ${n} investor pages`)
