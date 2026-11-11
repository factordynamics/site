// Public filing cards: one per curated fund's latest 13F that has a quarter before it to compare with.
// Writes <out>/d/f/{accession}.json (the /f/{accession}/ page's data), <out>/og/f/{accession}.png (the
// 1200x630 share image) and <out>/f/{accession}/index.html with that image in its OG tags.
// Runs in the Pages build after vite and before postbuild (copybook-pages.yml).
// Usage: node scripts/cards.mjs <out dir> [data base URL or dir]
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { displayName, MARQUEE, possessive, renamed } from '../src/lib/names.mjs'
import { dayName, isEdgarDay } from '../src/lib/calendar.mjs'
import { recapFilers, recapTitle } from '../src/lib/titles.mjs'
import { getJson } from './getjson.mjs'
import { gapStats, seasonGaps } from '../src/lib/latencyStats.mjs'
import { buildCard, cardSvg, cut, dLabel, money, qLabel, qn, x } from '../src/lib/filingCard.mjs'
import { API, LATENCY_URL } from '../api.config.mjs'

const out = process.argv[2] || 'dist'
const base = process.argv[3] || process.env.VITE_DATA_BASE || 'https://refcell.github.io/gust/copybook/data/'
const SITE = process.env.VITE_SITE || 'https://copybook.factordynamics.com/'
const read = async (f) =>
  base.startsWith('http') ? await getJson(base + f) : JSON.parse(readFileSync(join(base, f), 'utf8'))

const fonts = new URL('../node_modules/geist/dist/fonts/', import.meta.url).pathname
const fontFiles = [
  ...['Regular', 'Medium', 'SemiBold', 'Bold'].map((w) => join(fonts, 'geist-sans', `Geist-${w}.ttf`)),
  ...['Medium', 'SemiBold'].map((w) => join(fonts, 'geist-mono', `GeistMono-${w}.ttf`)),
]

const index = renamed(await read('index.json'))
const live = index.managers.filter((m) => m.ok && (m.total_value ?? 0) > 0 && !['inactive', 'reported_by_other'].includes(m.status))
const newest = Math.max(...live.map((m) => qn(m.quarter)))
// This filing season and the one before: the filings people are sharing.
const recent = live.filter((m) => qn(m.quarter) >= newest - 1)

const shell = readFileSync(join(out, 'index.html'), 'utf8')
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
mkdirSync(join(out, 'd', 'f'), { recursive: true })
mkdirSync(join(out, 'og', 'f'), { recursive: true })
const list = []
for (let i = 0; i < recent.length; i += 16) {
  const part = await Promise.all(recent.slice(i, i + 16).map((m) => read(`${m.slug}.json`).catch(() => null)))
  for (const b of part) {
    const c = buildCard(b)
    if (!c) continue
    const { moves } = c
    writeFileSync(join(out, 'd', 'f', `${c.accession}.json`), JSON.stringify(c))
    const png = new Resvg(cardSvg(c), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Geist' }, fitTo: { mode: 'width', value: 1200 } }).render().asPng()
    writeFileSync(join(out, 'og', 'f', `${c.accession}.png`), png)
    const title = `${possessive(c.manager)} ${qLabel(c.quarter)} 13F: top moves · Copybook`
    const top = moves.slice(0, 3).map((m) => `${m.change === 'new' ? 'new' : m.change} ${m.ticker || m.name} ${m.value_delta >= 0 ? '+' : '−'}${money(m.value_delta)}`)
    const desc = `${c.manager} filed a ${qLabel(c.quarter)} 13F on ${dLabel(c.filing_date)}: ${top.join(', ')}. Bought ${money(c.bought_usd)}, sold ${money(c.sold_usd)}, from the SEC filing.`
    // A hash of the image bytes, so X and Slack refetch the card when a rebuild changes its numbers.
    const img = `${SITE}og/f/${c.accession}.png?v=${createHash('sha1').update(png).digest('hex').slice(0, 10)}`
    const alt = `${possessive(c.manager)} ${qLabel(c.quarter)} 13F: bought ${money(c.bought_usd)}, sold ${money(c.sold_usd)}${top.length ? `; top moves ${top.join(', ')}` : ''}`
    const html = shell
      // Function replacers only: descriptions hold dollar amounts like "$1.7B", which a replacement
      // string would read as the $1 backreference.
      .replace(/<title>.*?<\/title>/, () => `<title>${esc(title)}</title>`)
      .replace(/(<meta name="description" content=")[^"]*/, (_, p) => p + esc(desc))
      .replace(/(<meta property="og:title" content=")[^"]*/, (_, p) => p + esc(title))
      .replace(/(<meta property="og:description" content=")[^"]*/, (_, p) => p + esc(desc))
      .replaceAll(`${SITE}og.png`, () => img)
      .replace(/(<meta property="og:image:alt" content=")[^"]*/, (_, p) => p + esc(alt))
      .replace('<meta property="og:type"', () => `<link rel="canonical" href="${SITE}f/${c.accession}/" />\n    <meta name="twitter:image:alt" content="${esc(alt)}" />\n    <meta name="twitter:title" content="${esc(title)}" />\n    <meta name="twitter:description" content="${esc(desc)}" />\n    <meta property="og:type"`)
    mkdirSync(join(out, 'f', c.accession), { recursive: true })
    writeFileSync(join(out, 'f', c.accession, 'index.html'), html)
    list.push({ accession: c.accession, slug: c.slug, quarter: c.quarter, filing_date: c.filing_date })
  }
}
// Investor pages and Flow link a fund's card only when it exists.
writeFileSync(join(out, 'd', 'f', 'index.json'), JSON.stringify({ generated_at: index.generated_at, cards: list.sort((a, z) => z.filing_date.localeCompare(a.filing_date)) }))
console.log(`filing cards: ${list.length}`)

// The /season/ share card: superinvestors filed, EDGAR days left, and who files next (or, once ten
// superinvestors have filed, what they bought most). Rebuilt every Pages build; the meta tags carry a
// content hash (?v=) so X and Slack fetch the new image whenever the numbers change.
{
  const s = JSON.parse(readFileSync(join(out, 'd', 'season.json'), 'utf8'))
  const due = new Date(s.deadline)
  const now = new Date()
  const et = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const today = et(now)
  let daysLeft = 0
  for (let t = new Date(`${today}T12:00:00Z`); et(due) >= t.toISOString().slice(0, 10); t.setUTCDate(t.getUTCDate() + 1)) if (isEdgarDay(t.toISOString().slice(0, 10))) daysLeft++
  const passed = now > due
  const clock = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'am' : 'pm'}`
  // A date, never "today": a card is a snapshot that gets reposted.
  const day = (iso) => dayName(iso)
  // Most-followed first; anyone not listed ranks after, in expected order.
  const rank = (slug) => (MARQUEE.includes(slug) ? MARQUEE.indexOf(slug) : MARQUEE.length)
  const bought = s.featured.filed >= 10
  const list = bought
    ? (s.featured_flow?.bought ?? []).filter((r) => !r.etf && r.net_value > 0).slice(0, 3).map((r) => [r.ticker, cut(r.name, 30), `+${money(r.net_value)} · ${r.n_buyers} ${r.n_buyers === 1 ? 'buyer' : 'buyers'}`])
    : (s.expected ?? [])
        // The soonest still to file (Thursday's before Monday's), the best-known first within a day.
        .filter((x) => !x.filed && x.expected_date && x.expected_date >= today)
        .sort((a, b) => a.expected_date.localeCompare(b.expected_date) || rank(a.slug) - rank(b.slug) || a.time_et - b.time_et)
        .slice(0, 3)
        .map((x) => [day(x.expected_date), cut(displayName(x.manager), 30), `usually around ${clock(x.time_et)} ET`])
  const q = qLabel(s.quarter)
  const rows = list
    .map(([a, b, c], i) => {
      const y = 430 + i * 50
      return `<text x="72" y="${y}" font-family="${bought ? 'Geist Mono' : 'Geist'}" font-weight="600" font-size="${bought ? 27 : 24}" fill="#0c0e13">${x(a)}</text>
<text x="${bought ? 200 : 250}" y="${y}" font-family="Geist" font-weight="500" font-size="25" fill="#0c0e13">${x(b)}</text>
<text x="1128" y="${y}" text-anchor="end" font-family="Geist" font-weight="${bought ? 600 : 500}" font-size="23" fill="${bought ? '#126b3c' : '#5f6572'}">${x(c)}</text>`
    })
    .join('\n')
  const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#fbfaf7"/>
<g transform="translate(72 58) scale(1.75)"><rect x="1.5" y="5" width="14" height="17.5" rx="3.2" fill="#0c0e13"/><rect x="8" y="1.5" width="14.5" height="17.5" rx="3.2" fill="#2b44d6" stroke="#fbfaf7" stroke-width="1.4"/><rect x="11" y="6" width="8.5" height="1.8" rx=".9" fill="#fff"/><rect x="11" y="9.6" width="6" height="1.8" rx=".9" fill="#fff" opacity=".85"/><rect x="11" y="13.2" width="3.6" height="1.8" rx=".9" fill="#fff" opacity=".7"/></g>
<text x="124" y="94" font-family="Geist" font-weight="600" font-size="32" letter-spacing="-0.8" fill="#0c0e13">Copybook</text>
<text x="1128" y="92" text-anchor="end" font-family="Geist" font-weight="500" font-size="22" fill="#5f6572">${x(`${q} 13F season · due ${day(et(due))}`)}</text>
<text x="1128" y="122" text-anchor="end" font-family="Geist" font-size="17" fill="#8a8f99">${x(`Updated ${new Date(s.generated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`)}</text>
<text x="72" y="170" font-family="Geist" font-weight="500" font-size="24" fill="#5f6572">Superinvestors filed</text>
<text x="72" y="262" font-family="Geist" font-weight="600" font-size="96" letter-spacing="-4" fill="#0c0e13">${s.featured.filed}<tspan dx="14" font-size="48" fill="#8a8f99" letter-spacing="-1">of ${s.featured.total}</tspan></text>
<rect x="72" y="290" width="560" height="10" rx="5" fill="#ece9e2"/>
<rect x="72" y="290" width="${Math.max(10, Math.round((560 * s.featured.filed) / Math.max(1, s.featured.total)))}" height="10" rx="5" fill="#2b44d6"/>
<rect x="760" y="132" width="368" height="168" rx="20" fill="#0c0e13"/>
<text x="792" y="176" font-family="Geist" font-weight="500" font-size="22" fill="#a9adb6">${passed ? 'Deadline' : 'EDGAR days left'}</text>
<text x="792" y="262" font-family="Geist" font-weight="600" font-size="${passed ? 64 : 88}" letter-spacing="-3" fill="#ffffff">${passed ? 'Passed' : daysLeft}</text>
<path d="M72 340H1128" stroke="#e6e3dc"/>
<text x="72" y="380" font-family="Geist" font-weight="700" font-size="17" letter-spacing="1.6" fill="#2b44d6">${bought ? 'MOST BOUGHT BY SUPERINVESTORS' : 'EXPECTED TO FILE NEXT'}</text>
${rows || `<text x="72" y="430" font-family="Geist" font-size="24" fill="#5f6572">${bought ? 'No buys yet' : 'Every superinvestor with a pattern has filed'}</text>`}
<path d="M72 556H1128" stroke="#e6e3dc"/>
<text x="72" y="596" font-family="Geist" font-weight="500" font-size="22" fill="#393e49">${x(`${s.curated.filed.toLocaleString('en-US')} of ${s.curated.total.toLocaleString('en-US')} tracked funds · ${s.filers.filed.toLocaleString('en-US')} filers so far`)}</text>
<text x="1128" y="596" text-anchor="end" font-family="Geist" font-weight="600" font-size="22" fill="#2b44d6">copybook.factordynamics.com/season</text>
</svg>`
  const v = createHash('sha1').update(card).digest('hex').slice(0, 10)
  mkdirSync(join(out, 'og'), { recursive: true })
  writeFileSync(join(out, 'og', 'season.png'), new Resvg(card, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Geist' }, fitTo: { mode: 'width', value: 1200 } }).render().asPng())
  // postbuild.mjs puts this URL in /season/'s share tags.
  writeFileSync(join(out, 'og', 'season.json'), JSON.stringify({ url: `${SITE}og/season.png?v=${v}`, superinvestors_filed: s.featured.filed, days_left: passed ? 0 : daysLeft, mode: bought ? 'most_bought' : 'expected' }))
  console.log(`season card: ${s.featured.filed} of ${s.featured.total} filed, ${passed ? 'deadline passed' : `${daysLeft} EDGAR days left`}, ${list.length} ${bought ? 'most bought' : 'expected next'} (v=${v})`)
}

// The season recap's share card (/season/{yyyy}q{n}/): top 3 bought and sold by the superinvestors.
{
  const s = JSON.parse(readFileSync(join(out, 'd', 'season.json'), 'utf8'))
  const r = JSON.parse(readFileSync(join(out, 'd', 'recap', `${s.quarter}.json`), 'utf8'))
  const q = qLabel(r.quarter)
  // Who did it, not the company name: "Pzena", or "+3 funds" when several did.
  const FIRMS = new Set(['Tweedy Browne', 'Ruane Cunniff'])
  const short = (n) => (FIRMS.has(n) || n.split(' ').length !== 2 ? n : n.split(' ')[1])
  const who = (people, n) => (n > 1 ? `${n} superinvestors` : short(displayName(people[0]?.manager ?? '')))
  // rows: [ticker, who, value]
  const col = (rows, x0, title, fg) =>
    `<text x="${x0}" y="300" font-family="Geist" font-weight="700" font-size="17" letter-spacing="1.6" fill="${fg}">${title}</text>` +
    (rows.length
      ? rows
          .map(([t, w, v], i) => {
            const y = 352 + i * 56
            return `<text x="${x0}" y="${y}" font-family="Geist Mono" font-weight="600" font-size="27" fill="#0c0e13">${x(t)}</text>
<text x="${x0 + 118}" y="${y}" font-family="Geist" font-size="21" fill="#5f6572">${x(cut(w, 18))}</text>
<text x="${x0 + 490}" y="${y}" text-anchor="end" font-family="Geist" font-weight="600" font-size="24" fill="${fg}">${x(v)}</text>`
          })
          .join('\n')
      : `<text x="${x0}" y="352" font-family="Geist" font-size="22" fill="#8a8f99">Nothing yet</text>`)
  const usd = (f, sold) => [f.ticker, who(sold ? f.sellers : f.buyers, sold ? f.n_sellers : f.n_buyers), `${f.net_value >= 0 ? '+' : '−'}${money(f.net_value)}`]
  const pct = (f) => [f.ticker, who(f.buyers, f.n_buyers), `+${(f.pct * 100).toFixed(1)}% of book`]
  const pctSold = (f) => [f.ticker, who(f.sellers, f.n_sellers), `−${(Math.abs(f.pct) * 100).toFixed(1)}% of book`]
  // Two cards: the page's default, and the "% of book" view (/season/{q}/pct/), so a shared link unfurls what it shows.
  // Until about 10 superinvestors have filed, the recap names them, so it doesn't read as the whole field.
  const filedNames = r.filing.filter((f) => f.filed).map((f) => displayName(f.manager))
  const fewWho = recapFilers({ filed: r.superinvestors.filed, names: filedNames, final: r.final })
  const few = Boolean(fewWho)
  for (const byPct of [false, true]) {
  // After the deadline the card leads with breadth: what the most superinvestors bought.
  const left = byPct
    ? col((r.most_bought_pct ?? []).slice(0, 3).map(pct), 72, 'BIGGEST BUYS, % OF BOOK', '#126b3c')
    : r.final
    ? col(r.most_buyers.slice(0, 3).map((f) => [f.ticker, short(cut(f.name, 18)), `${f.n_buyers} bought`]), 72, 'BOUGHT BY THE MOST', '#126b3c')
    : col(r.most_bought.slice(0, 3).map((f) => usd(f, false)), 72, 'MOST BOUGHT', '#126b3c')
  const right = byPct
    ? col((r.most_sold_pct ?? []).slice(0, 3).map(pctSold), 638, 'BIGGEST SALES, % OF BOOK', '#b4322a')
    : r.final
    ? col((r.most_bought_pct ?? []).slice(0, 3).map(pct), 638, 'BIGGEST BETS, % OF BOOK', '#2b44d6')
    : col(r.most_sold.slice(0, 3).map((f) => usd(f, true)), 638, 'MOST SOLD', '#b4322a')
  const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#fbfaf7"/>
<g transform="translate(72 58) scale(1.75)"><rect x="1.5" y="5" width="14" height="17.5" rx="3.2" fill="#0c0e13"/><rect x="8" y="1.5" width="14.5" height="17.5" rx="3.2" fill="#2b44d6" stroke="#fbfaf7" stroke-width="1.4"/><rect x="11" y="6" width="8.5" height="1.8" rx=".9" fill="#fff"/><rect x="11" y="9.6" width="6" height="1.8" rx=".9" fill="#fff" opacity=".85"/><rect x="11" y="13.2" width="3.6" height="1.8" rx=".9" fill="#fff" opacity=".7"/></g>
<text x="124" y="94" font-family="Geist" font-weight="600" font-size="32" letter-spacing="-0.8" fill="#0c0e13">Copybook</text>
<text x="1128" y="92" text-anchor="end" font-family="Geist" font-weight="500" font-size="22" fill="#5f6572">${x(`${r.superinvestors.filed} of ${r.superinvestors.total} superinvestors ${r.final ? 'filed' : 'filed so far'}`)}</text>
<text x="72" y="196" font-family="Geist" font-weight="600" font-size="54" letter-spacing="-2" fill="#0c0e13">${x(`${q} 13F recap`)}</text>
<text x="72" y="238" font-family="Geist" font-size="24" fill="#5f6572">${x(byPct ? 'Their biggest bets, as a share of each one’s book' : few ? `What ${cut(fewWho, 44)} bought and sold` : 'What the superinvestors bought and sold')}${r.final ? '' : ', so far'}</text>
<path d="M72 262H1128" stroke="#e6e3dc"/>
${left}
${right}
<path d="M600 284V500" stroke="#e6e3dc"/>
<path d="M72 556H1128" stroke="#e6e3dc"/>
<text x="72" y="596" font-family="Geist" font-weight="500" font-size="22" fill="#393e49">${x(`${r.opened_count} new · ${r.exited_count} exits`)}</text>
<text x="1128" y="596" text-anchor="end" font-family="Geist" font-weight="600" font-size="22" fill="#2b44d6">${x(`copybook.factordynamics.com/season/${r.quarter.toLowerCase()}${byPct ? '/pct' : ''}`)}</text>
</svg>`
  const v = createHash('sha1').update(card).digest('hex').slice(0, 10)
  const slug = r.quarter.toLowerCase() + (byPct ? '-pct' : '')
  writeFileSync(join(out, 'og', `season-${slug}.png`), new Resvg(card, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Geist' }, fitTo: { mode: 'width', value: 1200 } }).render().asPng())
  const top = r.most_bought.slice(0, 3).map((f) => f.ticker)
  const tk = (xs) => (xs ?? []).slice(0, 3).map((f) => f.ticker).join(', ')
  // The % view's description names its own ranking, the same names its card shows.
  const ranked = byPct
    ? `${r.most_bought_pct?.length ? ` Biggest buys by % of book: ${tk(r.most_bought_pct)}.` : ''}${r.most_sold_pct?.length ? ` Biggest sales: ${tk(r.most_sold_pct)}.` : ''}`
    : top.length ? ` Most bought: ${top.join(', ')}.` : ''
  writeFileSync(
    join(out, 'og', `season-${slug}.json`),
    JSON.stringify({
      path: `season/${r.quarter.toLowerCase()}/${byPct ? 'pct/' : ''}`,
      url: `${SITE}og/season-${slug}.png?v=${v}`,
      title: byPct ? `${q} 13F recap: the superinvestors' biggest bets by % of book · Copybook` : recapTitle({ quarter: r.quarter, filed: r.superinvestors.filed, total: r.superinvestors.total, names: filedNames, final: r.final }),
      desc: `${r.superinvestors.filed} of ${r.superinvestors.total} superinvestors ${r.final ? 'filed' : 'have filed'} ${q} 13Fs${few ? ` so far: ${fewWho}` : ''}.${ranked} New positions, full exits, the biggest moves and who filed late, from SEC EDGAR.`,
    }),
  )
  console.log(`recap card${byPct ? ' (% of book)' : ''}: ${q}${r.final ? ' final' : ' so far'} (v=${v})`)
  }
}

// /speed/'s share card: this season's median and 90th percentile from EDGAR acceptance to delivery, or
// "Waiting for the first live alert" until there is one. Rebuilt on every build from the public /latency.
{
  // The public R2 copy first (no Worker request), then the API, then the live site's copy, so an outage
  // doesn't blank the card. The build also writes d/latency.json: pages fall back to it if R2 can't be read.
  const json = (u) => fetch(u).then((r) => (r.ok ? r.json() : null), () => null)
  const l = (await json(`${LATENCY_URL}?t=${Date.now()}`)) ?? (await json(`${API}/latency`)) ?? (await json(`${SITE}d/latency.json`))
  if (l) {
    mkdirSync(join(out, 'd'), { recursive: true })
    writeFileSync(join(out, 'd', 'latency.json'), JSON.stringify(l))
  }
  // The API docs page reads the OpenAPI spec from here too, not from the API per visitor.
  const spec = (await fetch(`${API}/v1/openapi.json`).then((r) => (r.ok ? r.text() : null), () => null)) ?? (await fetch(`${SITE}api/openapi.json`).then((r) => (r.ok ? r.text() : null), () => null))
  if (spec) {
    mkdirSync(join(out, 'api'), { recursive: true })
    writeFileSync(join(out, 'api', 'openapi.json'), spec)
  }
  // And the changelog, which /api/ shows when the API isn't answering.
  const changelog = (await fetch(`${API}/v1/changelog`).then((r) => (r.ok ? r.text() : null), () => null)) ?? (await fetch(`${SITE}api/changelog.json`).then((r) => (r.ok ? r.text() : null), () => null))
  if (changelog) {
    mkdirSync(join(out, 'api'), { recursive: true })
    writeFileSync(join(out, 'api', 'changelog.json'), changelog)
  }
  const secs = (s) => (s == null ? '—' : s < 90 ? `${Math.round(s)}s` : `${(s / 60).toFixed(s < 600 ? 1 : 0)} min`)
  // Every timed alert, the late 13F moves before the Nov 11 fix included, as on /speed/.
  const all = gapStats(seasonGaps(l).map((a) => a.seconds))
  const n = all.count
  const body = !l
    ? `<text x="72" y="380" font-family="Geist" font-weight="600" font-size="44" letter-spacing="-1" fill="#0c0e13">Every alert timed, EDGAR to inbox</text>`
    : n
      ? [
          ['MEDIAN', secs(all.median_seconds), '#2b44d6'],
          ['90TH PERCENTILE', secs(all.p90_seconds), '#0c0e13'],
          ['ALERTS TIMED', n.toLocaleString('en-US'), '#0c0e13'],
        ]
          .map(([k, v, fg], i) => {
            const x0 = 72 + i * 372
            return `<text x="${x0}" y="318" font-family="Geist" font-weight="700" font-size="17" letter-spacing="1.6" fill="#5f6572">${k}</text>
<text x="${x0}" y="410" font-family="Geist" font-weight="600" font-size="88" letter-spacing="-3" fill="${fg}">${x(v)}</text>`
          })
          .join('\n')
      : `<text x="72" y="360" font-family="Geist" font-weight="600" font-size="48" letter-spacing="-1.4" fill="#0c0e13">Waiting for the first live alert</text>
<text x="72" y="412" font-family="Geist" font-size="24" fill="#5f6572">Every 13F, Form 4 and 13D/G alert is timed from SEC acceptance to delivery.</text>`
  const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#fbfaf7"/>
<g transform="translate(72 58) scale(1.75)"><rect x="1.5" y="5" width="14" height="17.5" rx="3.2" fill="#0c0e13"/><rect x="8" y="1.5" width="14.5" height="17.5" rx="3.2" fill="#2b44d6" stroke="#fbfaf7" stroke-width="1.4"/><rect x="11" y="6" width="8.5" height="1.8" rx=".9" fill="#fff"/><rect x="11" y="9.6" width="6" height="1.8" rx=".9" fill="#fff" opacity=".85"/><rect x="11" y="13.2" width="3.6" height="1.8" rx=".9" fill="#fff" opacity=".7"/></g>
<text x="124" y="94" font-family="Geist" font-weight="600" font-size="32" letter-spacing="-0.8" fill="#0c0e13">Copybook</text>
<text x="1128" y="92" text-anchor="end" font-family="Geist" font-weight="500" font-size="22" fill="#5f6572">${x(l?.season ? `${qLabel(l.season)} filing season` : 'Alert speed')}</text>
<text x="72" y="196" font-family="Geist" font-weight="600" font-size="54" letter-spacing="-2" fill="#0c0e13">How fast alerts arrive</text>
<text x="72" y="238" font-family="Geist" font-size="24" fill="#5f6572">From EDGAR acceptance to delivery, live alerts only</text>
<path d="M72 262H1128" stroke="#e6e3dc"/>
${body}
<path d="M72 556H1128" stroke="#e6e3dc"/>
<text x="72" y="596" font-family="Geist" font-weight="500" font-size="22" fill="#393e49">13F · Form 4 · 13D/G</text>
<text x="1128" y="596" text-anchor="end" font-family="Geist" font-weight="600" font-size="22" fill="#2b44d6">copybook.factordynamics.com/speed</text>
</svg>`
  const v = createHash('sha1').update(card).digest('hex').slice(0, 10)
  writeFileSync(join(out, 'og', 'speed.png'), new Resvg(card, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Geist' }, fitTo: { mode: 'width', value: 1200 } }).render().asPng())
  writeFileSync(join(out, 'og', 'speed.json'), JSON.stringify({ url: `${SITE}og/speed.png?v=${v}`, count: n, median_seconds: all.median_seconds, p90_seconds: all.p90_seconds }))
  console.log(`speed card: ${l ? (n ? `${n} alerts, median ${secs(all.median_seconds)}` : 'waiting for the first live alert') : 'latency unavailable'} (v=${v})`)
}
