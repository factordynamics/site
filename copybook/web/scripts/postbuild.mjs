// Writes a static index.html for every route so GitHub Pages serves deep links directly,
// with per-page titles, plus redirect stubs for the old .html URLs.
// Usage: node scripts/postbuild.mjs <index.json path or URL>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getJson } from './getjson.mjs'
import { ogCard } from './ogcard.mjs'
import { displayName, renamed } from '../src/lib/names.mjs'
import { X_LINKS } from './xlinks.mjs'
import { API } from '../api.config.mjs'
import { dueLead, investorTitle, seasonTitle, stockTitle } from '../src/lib/titles.mjs'

const dist = new URL('../dist/', import.meta.url).pathname
const src = process.argv[2] || 'https://refcell.github.io/gust/copybook/data/index.json'
const index = renamed(src.startsWith('http') ? await getJson(src) : JSON.parse(readFileSync(src, 'utf8')))
// Static content for crawlers and link previews that don't run JavaScript (prerendered into #root
// below); a browser running the app replaces it, and never shows it in the meantime.
const shell = readFileSync(join(dist, 'index.html'), 'utf8').replace('</head>', () => `  <script>document.documentElement.classList.add('js')</script>\n    <style>.js #pre{display:none}#pre{max-width:1200px;margin:0 auto;padding:48px 20px;font:16px/1.55 system-ui,sans-serif}#pre table{border-collapse:collapse;margin:12px 0 28px}#pre td,#pre th{padding:6px 14px 6px 0;text-align:left}</style>\n  </head>`)
const SITE = process.env.VITE_SITE || 'https://copybook.factordynamics.com/'

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
function page(path, title, desc, extra = '', image = null, body = '', alt = null) {
  let html = shell
    .replaceAll(`${SITE}og.png`, () => image ?? `${SITE}og.png`)
    // A page's own preview card says what it shows, for screen readers on X and Slack.
    .replace(/(<meta property="og:image:alt" content=")[^"]*/, (m, p) => (alt ? p + esc(alt) : m))
    .replace('<meta property="og:image:alt"', (m) => (alt ? `<meta name="twitter:image:alt" content="${esc(alt)}" />\n    ${m}` : m))
    // Function replacers only: a replacement string reads "$1.7B" in a description as the $1 backreference.
    .replace(/<title>.*?<\/title>/, () => `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, (_, p) => p + esc(desc))
    .replace(/(<meta property="og:title" content=")[^"]*/, (_, p) => p + esc(title))
    .replace(/(<meta property="og:description" content=")[^"]*/, (_, p) => p + esc(desc))
    .replace('<meta property="og:type"', () => `<link rel="canonical" href="${SITE}${path}" />${extra}\n    <meta property="og:type"`)
    .replace('<div id="root"></div>', () => `<div id="root">${body ? `<div id="pre">${body}</div>` : ''}</div>`)
  const dir = join(dist, path)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html)
}
// Structured data for search: one JSON-LD block per page (`<` escaped so a name can't close the script).
const ld = (o) => `\n    <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...o }).replace(/</g, '\\u003c')}</script>`
const ORG = { '@type': 'Organization', name: 'Copybook', url: SITE, logo: `${SITE}apple-touch-icon.png` }
// Prerendered page bodies: the h1, the summary line, and up to 10 rows, as plain HTML.
const ht = (v) => esc(String(v ?? ''))
const link = (path, text) => `<a href="${SITE}${path}">${ht(text)}</a>`
const table = (cols, rows) => (rows.length ? `<table><thead><tr>${cols.map((c) => `<th>${ht(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '')
const pre = (h1, summary, ...parts) => `<h1>${ht(h1)}</h1><p>${ht(summary)}</p>${parts.join('')}`
const pct1 = (v) => `${(v * 100).toFixed(1)}%`
const CHANGE = { new: 'New', added: 'Added', trimmed: 'Trimmed', exited: 'Exited', unchanged: 'Unchanged' }
const EDGAR = { '@type': 'CreativeWork', name: 'SEC EDGAR Form 13F filings', url: 'https://www.sec.gov/edgar/search/' }
const crumbs = (...items) => ({ '@type': 'BreadcrumbList', itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE}${path}` })) })
const usd = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`)
const qLabel = (q) => (q ? q.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1') : 'latest')
const dayLabel = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const num = (v) => Number(v ?? 0).toLocaleString('en-US')
// "often 10–11 am ET" from a superinvestor's last filing times (New York minutes after midnight), as the page says it.
const hour = (m) => ({ h: ((Math.floor(m / 60) + 11) % 12) + 1, pm: m >= 720 })
function usualTime(e) {
  const [a, b] = e.time_range ?? [e.time_et, e.time_et]
  const s = hour(a)
  const t = hour(b)
  const word = e.pattern === 'usually' ? 'usually' : 'often'
  if (s.h === t.h && s.pm === t.pm) return `${word} around ${s.h} ${s.pm ? 'pm' : 'am'} ET`
  return `${word} ${s.h}${s.pm === t.pm ? '' : s.pm ? ' pm' : ' am'}–${t.h} ${t.pm ? 'pm' : 'am'} ET`
}
const shortDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '')
let cardsDrawn = 0
// "Flagstar Bank, National Association" -> "Flagstar Bank" for a card row.
const shortCo = (n) => { let s = String(n); for (let i = 0; i < 3; i++) s = s.replace(/,?\s+(National Association|Spons(ored)? ADR|ADR|Inc\.?|Corp(oration)?\.?|Co\.?|Ltd\.?|PLC|AG|N\.?V\.?|S\.?A\.?|Holdings?|Group)$/i, ''); return s.trim() }
// Stocks with their own preview card, at most this many per build (memory and build time).
const STOCK_CARDS = 150
let stockCards = 0
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
const tc = displayName
page('investors/', 'Investors · Copybook', 'Latest 13F portfolios of legendary value investors, hedge-fund founders, activists and the largest institutions.')
page('pricing/', 'Pricing · Copybook', 'The latest quarter is free. Copy adds quarter-over-quarter changes, the last 8 quarters of history, filing alerts and CSV export.')
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
page('resume/', 'Keep your plan · Copybook', 'Resume a paused or cancelled Copybook plan.', '\n    <meta name="robots" content="noindex" />')
page('unsubscribe/', 'Unsubscribe · Copybook', 'Unsubscribe from Copybook’s weekly email and tips.', '\n    <meta name="robots" content="noindex" />')
page('data-quality/', 'Data quality: the gates every publish passes · Copybook', 'The publish gates every Copybook data run passes, the 13F lines held as unreliable by reason, and the build each part of the data comes from.')
page('status/', 'Status · Copybook', 'Live status of Copybook’s member API, EDGAR poller and filing pages, and the incident log.')
page('weekly/', 'The free Friday email: last week’s edition · Copybook', 'Every Friday: the week’s biggest superinvestor buys and sells from SEC filings. Free. Here is last week’s edition.')
page('why/', 'Why you cancelled · Copybook', 'Tell us why you cancelled Copybook.', '\n    <meta name="robots" content="noindex" />')
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
      const rec = readDist('d', 'recap', `${rq.toUpperCase()}.json`)
      const pctView = k.endsWith('-pct')
      const rows = (list, f) => (list ?? []).slice(0, 10).map((x) => [link(`stocks/${x.ticker}/`, x.ticker), ht(x.name), f(x)])
      const body = rec
        ? pre(
            r.title.replace(/ · Copybook$/, ''),
            r.desc,
            `<h2>Most bought</h2>`,
            table(['Stock', 'Company', pctView ? 'Top buy, % of book' : 'Net bought'], rows(pctView ? rec.most_bought_pct : rec.most_bought, (x) => (pctView ? ht(x.pct != null ? pct1(x.pct) : '') : usd(Math.abs(x.net_value))))),
            `<h2>Most sold</h2>`,
            table(['Stock', 'Company', pctView ? 'Top sale, % of book' : 'Net sold'], rows(pctView ? rec.most_sold_pct : rec.most_sold, (x) => (pctView ? ht(x.pct != null ? pct1(Math.abs(x.pct)) : '') : usd(Math.abs(x.net_value))))),
            `<p>${link('season/', 'Live season tracker')} · ${link('flow/', 'Smart money flow')} · ${link('investors/', 'All investors')}</p>`,
          )
        : ''
      page(r.path, r.title, r.desc, ld({ '@type': 'Article', headline: r.title.replace(/ · Copybook$/, ''), description: r.desc, image: r.url, url: `${SITE}${r.path}`, dateModified: built, publisher: ORG, author: ORG, isBasedOn: EDGAR, mainEntityOfPage: `${SITE}${r.path}` }), r.url, body)
    }
  } catch {}
  // The season tracker's title names the quarter now filing, for search during filing week.
  const qs = index.managers.filter((m) => m.ok && m.quarter).map((m) => m.quarter).sort()
  const q = qs.at(-1)?.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1') ?? 'Quarterly'
  // The tracker's title and description carry this build's counts (rebuilt every 20 minutes in filing week).
  const sd = seasonData
  const sq = sd ? qLabel(sd.quarter) : q
  const title = sd ? seasonTitle({ quarter: sd.quarter, filed: sd.featured.filed, total: sd.featured.total }) : `${q} 13F filing season tracker: who has filed and what they bought · Copybook`
  const desc = sd
    ? `Live through the ${dayLabel(sd.deadline)} deadline: ${num(sd.filers.filed)} of the ${num(sd.filers.total)} 13F filers active last quarter and ${sd.featured.filed} of ${sd.featured.total} superinvestors have filed ${sq} 13Fs. Who filed, who is next, and the most bought and sold stocks so far, from SEC EDGAR.`
    : `Live through the 13F deadline: how many superinvestors and filers have filed ${q} 13Fs, the latest filings, and the most bought and sold stocks so far. From SEC EDGAR.`
  const flowS = sd ? (sd.featured.filed ? sd.featured_flow : sd.all_flow) : null
  const body = sd
    ? pre(
        title,
        desc,
        `<h2>Most bought so far${sd.featured.filed ? ' by the superinvestors' : ''}</h2>`,
        table(['Stock', 'Company', 'Net bought'], (flowS?.bought ?? []).slice(0, 10).map((r) => [link(`stocks/${r.ticker}/`, r.ticker), ht(r.name), usd(r.net_value)])),
        `<h2>Expected next</h2>`,
        table(['Investor', 'Usually files'], sd.expected.filter((x) => !x.filed && x.expected_date).slice(0, 10).map((x) => [link(`investors/${x.slug}/`, x.manager), ht(dayLabel(x.expected_date))])),
        `<p>${link(`season/${sd.quarter.toLowerCase()}/`, `${sq} 13F recap`)} · ${link('flow/', 'Smart money flow')} · ${link('investors/', 'All investors')}</p>`,
      )
    : ''
  page('season/', title, desc, ld({ '@type': 'Article', headline: title, description: desc, image: season?.url, url: `${SITE}season/`, dateModified: built, publisher: ORG, author: ORG, isBasedOn: EDGAR, mainEntityOfPage: `${SITE}season/` }), season?.url, body)
}
page('for-funds/', 'Copybook for investment teams: My book, peer overlap and 13F alerts · Copy Fund', 'See who owns what you own across every 13F filer, compare your book with your peers, and get filings in Slack, checked on EDGAR every minute. Ten seats, invoiced annually.')
page('for-quants/', 'Copybook API for quants: 13F, Form 4 and 13D/G as JSON · Copy Pro', 'Every 13F filer’s latest holdings as JSON, with the EDGAR accession and acceptance time of every filing; holders by stock, Form 4 and 13D/G events and bulk CSV files. From $39/month.')
page('my-book/', 'My book · Copybook', 'Your stocks through the eyes of every 13F filer: who holds them, who bought and sold this season, and every Form 4 and 13D.')
page('methodology/', 'Methodology · Copybook', 'How Copybook reads SEC 13F, Form 4 and Schedule 13D/G filings: amendments, unit fixes, options, tickers, refresh cadence, and a changelog of every data correction.')
page('winter-2025-26/', 'Last winter between 13F seasons: the filings · Copybook', 'The 19 Schedule 13D/G filings by superinvestors and 14 insider buys of $100K or more in their top stocks, Dec 1, 2025 to Jan 31, 2026, each linked to SEC EDGAR.')
page('api/', 'API · Copybook', 'The Copybook API: 13F, Form 4 and Schedule 13D/G data from SEC EDGAR as JSON, for Copy Pro and Copy Fund.')
page('contact/', 'Contact · Copybook', 'Request Copy Fund access for your team, ask a question, or ask us to delete your data.')
page('terms/', 'Terms of use · Copybook', 'The terms for using Copybook, its paid plans and its API.')
page('privacy/', 'Privacy · Copybook', 'What Copybook stores about you, why, and how to have it deleted. We never sell your data.')
page('security/', 'Security · Copybook', 'Where Copybook keeps data and how it is protected.')
page('security/questionnaire/', 'Security questionnaire · Copybook', 'A vendor security questionnaire for Copybook, filled in: data held, access, encryption, backups, failover, subprocessors and what we don’t have.')
page('about/', 'About · Copybook', 'Portfolios, as filed. How Copybook reads SEC 13F filings, and what it won’t do.')
let n = 0
mkdirSync(join(dist, 'managers'), { recursive: true })
// Each tracked fund's book (from the data host), for the position counts in titles.
const dataBase = src.replace(/index\.json$/, '')
const books = new Map()
{
  const ok = index.managers.filter((m) => m.ok)
  for (let i = 0; i < ok.length; i += 32)
    for (const [slug, b] of await Promise.all(
      ok.slice(i, i + 32).map(async (m) => {
        try {
          return [m.slug, dataBase.startsWith('http') ? await getJson(`${dataBase}${m.slug}.json`) : JSON.parse(readFileSync(`${dataBase}${m.slug}.json`, 'utf8'))]
        } catch {
          return [m.slug, null]
        }
      }),
    ))
      if (b) books.set(slug, b)
}
// /consensus/'s link preview: the stocks most superinvestors hold, ranked as the page ranks them (holders, then value).
{
  const rows = new Map()
  for (const m of index.managers.filter((x) => x.ok && x.featured)) {
    for (const h of books.get(m.slug)?.holdings ?? []) {
      if (!h.value || h.put_call) continue
      const r = rows.get(h.cusip) ?? { h, n: 0, value: 0 }
      r.n++
      r.value += h.value
      rows.set(h.cusip, r)
    }
  }
  const top = [...rows.values()].sort((a, b) => b.n - a.n || b.value - a.value).slice(0, 3)
  const image = top.length
    ? ogCard(dist, 'consensus', {
        kicker: 'Consensus',
        title: 'Where great investors agree',
        sub: 'The stocks the most superinvestors own, from their latest 13Fs',
        rows: top.map(({ h, n }) => [`${h.ticker ? `${h.ticker} · ` : ''}${shortCo(h.display_name ?? displayName(h.issuer))}`, `held by ${n} superinvestors`]),
        cta: 'See the list',
        url: 'copybook.factordynamics.com',
      })
    : null
  if (image) cardsDrawn++
  page('consensus/', 'Consensus · Copybook', 'Where great investors agree: one combined book from the latest 13F filings of the superinvestors we follow.', '', image, '', top.length ? `Most held by superinvestors: ${top.map(({ h, n }) => `${h.ticker || shortCo(h.issuer)} (${n})`).join(', ')}.` : null)
}
for (const m of index.managers) {
  if (!m.ok) continue
  const who = tc(m.manager)
  const firm = tc(m.name)
  // Live numbers in the title and description: the quarter, book size, position count and top holdings.
  // Share positions with a value, and their total, exactly as the page counts them (options and exited
  // zero lines apart); the index's counts include those.
  const book = books.get(m.slug)
  const longs = book?.holdings?.filter((x) => !x.put_call && x.value > 0)
  const total = longs ? longs.reduce((a, x) => a + x.value, 0) : (m.long_value ?? m.equity_value ?? m.total_value)
  const count = longs ? longs.length : (m.long_positions ?? m.position_count)
  const top = (m.top ?? [])
    .filter((h) => !h.put_call)
    .slice(0, 3)
    .map((h) => `${h.display_name ?? tc(h.issuer)} ${((h.weight ?? 0) * 100).toFixed(1)}%`)
  const title = investorTitle({ who, quarter: m.quarter, value: total, positions: count })
  const topRows = (longs ?? [])
    .slice()
    .sort((x, y) => y.value - x.value)
    .slice(0, 10)
    .map((x) => [x.ticker ? link(`stocks/${x.ticker}/`, x.ticker) : '', ht(x.display_name ?? tc(x.issuer)), usd(x.value), ht(total ? pct1(x.value / total) : ''), ht(CHANGE[x.change] ?? '')])
  const desc = `${firm !== who ? `${who} (${firm})` : who}: the ${qLabel(m.quarter)} 13F${m.filing_date ? `, filed ${dayLabel(m.filing_date)}` : ''}${total ? `, ${usd(total)} across ${num(count)} positions` : ''}.${top.length ? ` Top holdings: ${top.join(', ')}.` : ''} Buys, sells and sector mix, straight from the SEC filing.`
  // Its link preview: when a superinvestor still has to file this quarter, the day it's expected and the
  // free follow; otherwise its latest 13F's size and top holdings.
  const exp = seasonData?.expected?.find((e) => e.slug === m.slug && !e.filed && !e.placeholder && e.expected_date)
  const sq = seasonData ? qLabel(seasonData.quarter).split(' ')[0] : ''
  const topH = (longs ?? []).slice().sort((p, q) => q.value - p.value).slice(0, 3).map((h) => [`${h.ticker ? `${h.ticker} · ` : ''}${shortCo(h.display_name ?? tc(h.issuer))}`, total ? `${pct1(h.value / total)} of the book` : usd(h.value)])
  const cardAlt = exp ? `${sq} 13F expected ${shortDay(exp.expected_date)}, ${usualTime(exp)}. Follow free.` : `${qLabel(m.quarter)} 13F: ${total ? usd(total) : ''} across ${num(count)} positions.`
  // Featured superinvestors only: each render loads the fonts natively, and a few hundred in one loop run the build out of memory.
  const card = !m.featured ? null : ogCard(dist, `investors/${m.slug}`, {
    kicker: exp ? `${sq} 13F expected` : `${qLabel(m.quarter)} 13F`,
    title: who,
    sub: exp ? `Expected ${shortDay(exp.expected_date)}, ${usualTime(exp)}` : `${total ? `${usd(total)} across ` : ''}${num(count)} positions${m.filing_date ? `, filed ${dayLabel(m.filing_date)}` : ''}`,
    rows: topH,
    cta: 'Follow free',
    url: 'copybook.factordynamics.com',
  })
  if (card) cardsDrawn++
  page(
    `investors/${m.slug}/`,
    title,
    desc,
    ld({ '@graph': [{ '@type': 'Dataset', name: `${who} 13F holdings, ${qLabel(m.quarter)}`, description: desc, url: `${SITE}investors/${m.slug}/`, creator: ORG, isBasedOn: m.sec_url ?? EDGAR.url, dateModified: m.filing_date ?? built, temporalCoverage: m.report_date ?? undefined, about: { '@type': 'Organization', name: firm }, isAccessibleForFree: true }, crumbs(['Investors', 'investors/'], [who, `investors/${m.slug}/`])] }),
    card,
    pre(`${who}’s 13F portfolio`, desc, `<h2>Top holdings, ${qLabel(m.quarter)}</h2>`, table(['Stock', 'Company', 'Value', 'Weight', 'Change'], topRows), `<p>${link(`investors/${m.slug}/history/`, `${who}’s 13F history`)} · ${link('season/', 'This 13F season')} · ${link('investors/', 'All investors')}</p>`),
    card && `${who}: ${cardAlt}`
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
const holderRow = (x) => [link(`investors/${x.slug}/`, displayName(x.manager)), ht(qLabel(x.quarter)), ht(num(x.shares)), usd(x.value), ht(CHANGE[x.change] ?? '')]
// "Warren Buffett bought $26.9M (Form 4, Nov 3, 2026)", newest first, linked to the filing.
const sinceLines = (since) =>
  since
    .slice()
    .sort((a, b) => b.filing_date.localeCompare(a.filing_date))
    .slice(0, 5)
    .map((e) => {
      const who = displayName(e.manager)
      const what = e.kind === 'form4' ? `${e.action === 'buy' ? 'bought' : e.action === 'sell' ? 'sold' : 'traded'}${e.value_usd ? ` ${usd(Math.abs(e.value_usd))}` : ''}` : e.percent_of_class != null ? `reported a ${e.percent_of_class}% stake` : 'filed a stake update'
      const form = e.kind === 'form4' ? 'Form 4' : String(e.form).replace(/^SCHEDULE /i, '')
      return `${ht(who)} ${ht(what)} (<a href="${ht(e.url)}">${ht(form)}</a>, ${ht(dayLabel(e.filing_date))})`
    })
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
    // The page opens on the superinvestors, so the title leads with them (the same function titles the tab).
    const sf = readDist('d', 'stocks', `${s.t}.json`)
    const sup = sf?.holders?.filter((x) => x.featured).length ?? 0
    const tc2 = sf?.title_counts
    const title = tc2?.filers ? stockTitle({ ticker: s.t, superinvestors: sup, hedge: tc2.hedge, filers: tc2.filers, quarter: tc2.quarter }) : `${s.t} ${s.n}: who owns it · Copybook`
    // No superinvestor has filed this season's quarter and none has Form 4 or 13D/G news: lead with who files next.
    const supH = (sf?.holders ?? []).filter((x) => x.featured).sort((a, b) => b.value - a.value)
    const due = seasonData && supH.length && !supH.some((x) => x.quarter === seasonData.quarter) && !(sf?.since ?? []).length ? dueLead({ quarter: seasonData.quarter, deadline: seasonData.deadline, names: supH.map((x) => x.manager) }) : null
    const desc = all
      ? `${due ? `${due}${due.endsWith('…') ? '' : '.'} ` : ''}${s.n} (${s.t}): ${sup ? `${num(sup)} of the superinvestors we follow ${sup === 1 ? 'holds' : 'hold'} it, ` : ''}with ${num(hedge)} hedge funds and ${num(all)} 13F filers in all.${h?.index ? ` Across all ${num(all)} filers' latest 13Fs, ${num(h.index.new)} opened a position and ${num(h.index.exited)} sold out.` : ''} Largest holders and who bought and sold, from SEC EDGAR.`
      : `${s.n} (${s.t}): which of the investors we track hold it, who bought and sold it in the latest 13F filings, and how the holder count changed.`
    // A link preview for the stocks people share: three or more superinvestors hold it, or a fund filed a
    // Form 4 or 13D/G since the 13Fs. The rest keep the site's card.
    const since = sf?.since ?? []
    let card = null
    if (stockCards < STOCK_CARDS && (supH.length >= 5 || (since.length && supH.length >= 2))) {
      stockCards++
      const moveRow = (e) => [
        displayName(e.manager),
        e.kind === 'form4' ? `${e.action === 'buy' ? 'bought' : e.action === 'sell' ? 'sold' : 'traded'}${e.value_usd ? ` ${usd(Math.abs(e.value_usd))}` : ''} · Form 4` : e.percent_of_class != null ? `${Number(e.percent_of_class).toFixed(1)}% stake · ${String(e.form).replace(/^SCHEDULE /i, '')}` : String(e.form),
      ]
      const rows = [...since.slice().sort((a, b) => b.filing_date.localeCompare(a.filing_date)).slice(0, 2).map(moveRow), ...supH.slice(0, 3).map((x) => [displayName(x.manager), `holds ${usd(x.value)}`])].slice(0, 3)
      const counts = tc2?.filers ? [sup ? `${num(sup)} superinvestor${sup === 1 ? '' : 's'}` : '', tc2.hedge ? `${num(tc2.hedge)} hedge funds` : '', `${num(tc2.filers)} 13F filers`].filter(Boolean).join(' · ') : s.n
      card = ogCard(dist, `stocks/${s.t}`, { kicker: since.length ? 'Since the latest 13Fs' : 'Who owns it', title: `Who owns ${s.t}?`, sub: counts, rows, cta: `Follow ${s.t} free`, url: 'copybook.factordynamics.com' })
      cardsDrawn++
    }
    page(
      `stocks/${s.t}/`,
      title,
      desc,
      ld({ '@graph': [{ '@type': 'Dataset', name: `${s.n} (${s.t}) 13F holders`, description: desc, url: `${SITE}stocks/${s.t}/`, creator: ORG, isBasedOn: EDGAR.url, dateModified: h?.generated_at ?? built, about: { '@type': 'Corporation', name: s.n, tickerSymbol: s.t }, variableMeasured: ['13F holders', 'hedge fund holders', 'shares held', 'value held'], isAccessibleForFree: true }, crumbs(['Stocks', 'consensus/'], [s.t, `stocks/${s.t}/`])] }),
      card,
      pre(
        `${s.n} (${s.t}): who owns it`,
        desc,
        // What the page leads with: Form 4 and 13D/G filings since the 13Fs, then the superinvestors, then the funds we track.
        (sf?.since ?? []).length ? `<h2>Since the latest 13Fs</h2><ul>${sinceLines(sf.since).map((l) => `<li>${l}</li>`).join('')}</ul>` : '',
        supH.length ? `<h2>Superinvestors holding it</h2>` : '',
        table(['Investor', '13F', 'Shares', 'Value', 'Change'], supH.slice(0, 10).map(holderRow)),
        `<h2>Largest holders among the funds we track</h2>`,
        table(
          ['Investor', '13F', 'Shares', 'Value', 'Change'],
          (sf?.holders ?? [])
            .filter((x) => !x.featured)
            .sort((x, y) => y.value - x.value)
            .slice(0, 10)
            .map(holderRow),
        ),
        h?.rows?.length ? `<h2>Largest 13F filers holding it</h2>` : '',
        table(['Filer', '13F', 'Value'], (h?.rows ?? []).slice(0, 10).map(([slug, name, quarter, , value]) => [link(`investors/${slug}/`, tc(name)), ht(qLabel(quarter)), usd(value)])),
        `<p>${link(`season/${(seasonData?.quarter ?? '').toLowerCase()}/`, `${seasonQ} 13F recap`)} · ${link('season/', 'This 13F season')} · ${link('consensus/', 'Consensus')}</p>`,
      ),
      card && `Who owns ${s.t}? ${s.n} on Copybook`
    )
    st++
  }
} catch {
  // No stock index: build without stock pages.
}
console.log(`wrote ${st} stock pages; ${cardsDrawn} link-preview cards so far`)
redirect('copycat.html', 'consensus/')
redirect('pricing.html', 'pricing/')
mkdirSync(join(dist, 'latency'), { recursive: true })
redirect('latency/index.html', 'speed/')
redirect('about.html', 'about/')
// Links the API hands out as copybook.factordynamics.com/api/… (not a static file here) go on to the API
// (the Worker), keeping the path and query. GitHub Pages can't answer with an HTTP redirect, so this only covers
// links opened in a browser: GET, JavaScript on.
const apiBridge = `<script>(function(){var p=location.pathname;if(!/^\\/api\\/./.test(p))return;document.documentElement.style.visibility='hidden';location.replace(${JSON.stringify(API.replace(/\/$/, ''))}+p.slice(4)+location.search+location.hash)})()</script>`
writeFileSync(join(dist, '404.html'), shell.replace('<head>', () => `<head>\n    ${apiBridge}`))
// The home page: its h1 and intro for crawlers and link previews, like every other page.
writeFileSync(
  join(dist, 'index.html'),
  shell.replace('<div id="root"></div>', () =>
    `<div id="root"><div id="pre">${pre(
      'See what the world’s best investors own, straight from the filing.',
      'Copybook turns SEC 13F filings into clear portfolios: top positions, sector mix and conviction, for the managers worth following.',
      `<p>${link('season/', 'This 13F season')} · ${link('flow/', 'Smart money flow')} · ${link('investors/', 'Investors')} · ${link('consensus/', 'Consensus')} · ${link('pricing/', 'Pricing')}</p>`,
    )}</div></div>`,
  ),
)
writeFileSync(join(dist, '.nojekyll'), '')
// /x/{slug}/: the target's own page, sent on to it with the post's UTM tags (scripts/xlinks.mjs).
for (const [slug, to] of Object.entries(X_LINKS)) {
  const url = `${SITE}${to}${to.includes('?') ? '&' : '?'}utm_source=x&utm_content=${encodeURIComponent(slug)}`
  const html = readFileSync(join(dist, to.split('?')[0], 'index.html'), 'utf8').replace(
    '<head>',
    () => `<head>\n    <meta name="robots" content="noindex" />\n    <script>location.replace(${JSON.stringify(url)}+location.hash)</script>`,
  )
  mkdirSync(join(dist, 'x', slug), { recursive: true })
  writeFileSync(join(dist, 'x', slug, 'index.html'), html)
}
console.log(`wrote ${n} investor pages`)
