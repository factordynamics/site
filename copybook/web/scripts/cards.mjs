// Public filing cards: one per curated fund's latest 13F that has a quarter before it to compare with.
// Writes <out>/d/f/{accession}.json (the /f/{accession}/ page's data), <out>/og/f/{accession}.png (the
// 1200x630 share image) and <out>/f/{accession}/index.html with that image in its OG tags.
// Runs in the Pages build after vite and before postbuild (copybook-pages.yml).
// Usage: node scripts/cards.mjs <out dir> [data base URL or dir]
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { displayName } from '../src/lib/names.mjs'
import { isEdgarDay } from '../src/lib/calendar.mjs'
import { getJson } from './getjson.mjs'

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

const qn = (q) => (q ? Number(q.slice(0, 4)) * 4 + Number(q.slice(5)) - 1 : -1)
const qLabel = (q) => `Q${q.slice(5)} ${q.slice(0, 4)}`
const dLabel = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const money = (v) => {
  const a = Math.abs(v)
  return a >= 1e9 ? `$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(0)}K` : `$${Math.round(a)}`
}
const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

const index = await read('index.json')
const live = index.managers.filter((m) => m.ok && (m.total_value ?? 0) > 0 && !['inactive', 'reported_by_other'].includes(m.status))
const newest = Math.max(...live.map((m) => qn(m.quarter)))
// This filing season and the one before: the filings people are sharing.
const recent = live.filter((m) => qn(m.quarter) >= newest - 1)

const TONE = { new: ['NEW', '#e3f1e8', '#126b3c'], added: ['ADDED', '#e3f1e8', '#126b3c'], trimmed: ['TRIMMED', '#f8e5e3', '#b4322a'], exited: ['EXITED', '#f8e5e3', '#b4322a'] }

function svg(c) {
  const grid = Array.from({ length: 22 }, (_, i) => `<path d="M${i * 56} 0V630" stroke="#ece9e2"/>`).join('') + Array.from({ length: 12 }, (_, i) => `<path d="M0 ${i * 56}H1200" stroke="#ece9e2"/>`).join('')
  const max = Math.max(...c.moves.map((m) => Math.abs(m.value_delta)), 1)
  const rows = c.moves
    .map((m, i) => {
      const y = 296 + i * 56
      const [label, bg, fg] = TONE[m.change]
      const w = Math.max(8, (Math.abs(m.value_delta) / max) * 125)
      return `<rect x="72" y="${y - 23}" width="112" height="32" rx="8" fill="${bg}"/>
<text x="128" y="${y - 1}" text-anchor="middle" font-family="Geist" font-weight="700" font-size="15" letter-spacing="1" fill="${fg}">${label}</text>
<text x="206" y="${y + 1}" font-family="Geist Mono" font-weight="600" font-size="27" fill="#0c0e13">${x(m.ticker || '—')}</text>
<text x="350" y="${y}" font-family="Geist" font-size="23" fill="#5f6572">${x(cut(m.name, 24))}</text>
<rect x="${m.value_delta >= 0 ? 815 : 815 - w}" y="${y - 14}" width="${w}" height="14" rx="7" fill="${fg}" opacity="0.85"/>
<text x="1128" y="${y}" text-anchor="end" font-family="Geist" font-weight="600" font-size="26" fill="${fg}">${m.value_delta >= 0 ? '+' : '−'}${money(m.value_delta)}</text>`
    })
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#fbfaf7"/>${grid}
<g transform="translate(72 58) scale(1.75)"><rect x="1.5" y="5" width="14" height="17.5" rx="3.2" fill="#0c0e13"/><rect x="8" y="1.5" width="14.5" height="17.5" rx="3.2" fill="#2b44d6" stroke="#fbfaf7" stroke-width="1.4"/><rect x="11" y="6" width="8.5" height="1.8" rx=".9" fill="#fff"/><rect x="11" y="9.6" width="6" height="1.8" rx=".9" fill="#fff" opacity=".85"/><rect x="11" y="13.2" width="3.6" height="1.8" rx=".9" fill="#fff" opacity=".7"/></g>
<text x="124" y="94" font-family="Geist" font-weight="600" font-size="32" letter-spacing="-0.8" fill="#0c0e13">Copybook</text>
<text x="1128" y="92" text-anchor="end" font-family="Geist" font-weight="500" font-size="22" fill="#5f6572">${x(`${qLabel(c.quarter)} 13F · filed ${dLabel(c.filing_date)}`)}</text>
<text x="72" y="186" font-family="Geist" font-weight="600" font-size="58" letter-spacing="-2" fill="#0c0e13">${x(cut(c.manager, 30))}</text>
<text x="72" y="228" font-family="Geist" font-size="24" fill="#5f6572">${x(cut(c.manager === c.firm ? `Top moves since ${qLabel(c.prev_quarter)}` : `${c.firm} · top moves since ${qLabel(c.prev_quarter)}`, 70))}</text>
<path d="M72 250H1128" stroke="#e6e3dc"/>
<path d="M815 268V${268 + c.moves.length * 56 - 16}" stroke="#d6d2c9"/>
${rows}
<path d="M72 556H1128" stroke="#e6e3dc"/>
<text x="72" y="596" font-family="Geist" font-weight="500" font-size="22" fill="#393e49">${x(`Bought ${money(c.bought_usd)} · Sold ${money(c.sold_usd)} · ${c.position_count} positions`)}</text>
<text x="1128" y="596" text-anchor="end" font-family="Geist" font-weight="600" font-size="22" fill="#2b44d6">copybook.factordynamics.com</text>
</svg>`
}

const shell = readFileSync(join(out, 'index.html'), 'utf8')
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
mkdirSync(join(out, 'd', 'f'), { recursive: true })
mkdirSync(join(out, 'og', 'f'), { recursive: true })
const list = []
for (let i = 0; i < recent.length; i += 16) {
  const part = await Promise.all(recent.slice(i, i + 16).map((m) => read(`${m.slug}.json`).catch(() => null)))
  for (const b of part) {
    if (!b?.prev_quarter || !b.moves || !b.accession) continue
    // Share positions only: an option's filed value is the underlying's notional, not a trade size.
    // A display name shared by several tickers in one book is ingest naming the trust, not the fund (see stocks.mjs).
    const named = new Map()
    for (const h of b.holdings ?? []) if (h.display_name && h.ticker) (named.get(h.display_name) ?? named.set(h.display_name, new Set()).get(h.display_name)).add(h.ticker.split(/[.-]/)[0])
    const nameOf = (h) => (h.display_name && (named.get(h.display_name)?.size ?? 0) <= 1 ? h.display_name : displayName(h.issuer))
    const all = ['new', 'added', 'trimmed', 'exited'].flatMap((k) => (b.moves[k] ?? []).filter((h) => !h.put_call && h.value_delta).map((h) => ({ ...h, change: k })))
    if (!all.length) continue
    const moves = all
      .sort((a, z) => Math.abs(z.value_delta) - Math.abs(a.value_delta))
      .slice(0, 5)
      .map((h) => ({ ticker: h.ticker, name: nameOf(h), cusip: h.cusip, change: h.change, value_delta: Math.round(h.value_delta), shares: h.shares, prev_shares: h.prev_shares, weight: h.weight }))
    const c = {
      accession: b.accession,
      slug: b.slug,
      manager: displayName(b.manager),
      firm: displayName(b.name),
      featured: Boolean(b.featured),
      quarter: b.quarter,
      prev_quarter: b.prev_quarter,
      report_date: b.report_date,
      filing_date: b.filing_date,
      sec_url: b.sec_url,
      total_value: Math.round(b.total_value),
      position_count: b.position_count,
      changes: b.changes,
      bought_usd: Math.round(b.moves.bought_usd ?? 0),
      sold_usd: Math.round(b.moves.sold_usd ?? 0),
      moves_total: all.length,
      moves,
    }
    writeFileSync(join(out, 'd', 'f', `${c.accession}.json`), JSON.stringify(c))
    writeFileSync(join(out, 'og', 'f', `${c.accession}.png`), new Resvg(svg(c), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Geist' }, fitTo: { mode: 'width', value: 1200 } }).render().asPng())
    const title = `${c.manager}’s ${qLabel(c.quarter)} 13F: top moves · Copybook`
    const top = moves.slice(0, 3).map((m) => `${m.change === 'new' ? 'new' : m.change} ${m.ticker || m.name} ${m.value_delta >= 0 ? '+' : '−'}${money(m.value_delta)}`)
    const desc = `${c.manager} filed a ${qLabel(c.quarter)} 13F on ${dLabel(c.filing_date)}: ${top.join(', ')}. Bought ${money(c.bought_usd)}, sold ${money(c.sold_usd)}, from the SEC filing.`
    const img = `${SITE}og/f/${c.accession}.png`
    const html = shell
      // Function replacers only: descriptions hold dollar amounts like "$1.7B", which a replacement
      // string would read as the $1 backreference.
      .replace(/<title>.*?<\/title>/, () => `<title>${esc(title)}</title>`)
      .replace(/(<meta name="description" content=")[^"]*/, (_, p) => p + esc(desc))
      .replace(/(<meta property="og:title" content=")[^"]*/, (_, p) => p + esc(title))
      .replace(/(<meta property="og:description" content=")[^"]*/, (_, p) => p + esc(desc))
      .replaceAll(`${SITE}og.png`, () => img)
      .replace('<meta property="og:type"', () => `<link rel="canonical" href="${SITE}f/${c.accession}/" />\n    <meta name="twitter:title" content="${esc(title)}" />\n    <meta name="twitter:description" content="${esc(desc)}" />\n    <meta property="og:type"`)
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
  const day = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
  // Most-followed first; anyone not listed ranks after, in expected order.
  const MARQUEE = ['warren-buffett', 'bill-ackman', 'stanley-druckenmiller', 'david-tepper', 'seth-klarman', 'ray-dalio', 'carl-icahn', 'li-lu', 'howard-marks', 'david-einhorn', 'bill-gates', 'dan-loeb', 'nelson-peltz', 'chase-coleman', 'terry-smith', 'chris-hohn', 'philippe-laffont']
  const rank = (slug) => (MARQUEE.includes(slug) ? MARQUEE.indexOf(slug) : MARQUEE.length)
  const bought = s.featured.filed >= 10
  const list = bought
    ? (s.featured_flow?.bought ?? []).filter((r) => !r.etf && r.net_value > 0).slice(0, 3).map((r) => [r.ticker, cut(r.name, 30), `+${money(r.net_value)} · ${r.n_buyers} ${r.n_buyers === 1 ? 'buyer' : 'buyers'}`])
    : (s.expected ?? [])
        // The names people share: the best-known superinvestors still to file, not simply the soonest.
        .filter((x) => !x.filed && x.expected_date && x.expected_date >= today)
        .sort((a, b) => rank(a.slug) - rank(b.slug) || a.expected_date.localeCompare(b.expected_date) || a.time_et - b.time_et)
        .slice(0, 3)
        .sort((a, b) => a.expected_date.localeCompare(b.expected_date) || a.time_et - b.time_et)
        .map((x) => [day(x.expected_date), cut(displayName(x.manager), 30), x.time_range ? `lately ${clock(x.time_range[0])}–${clock(x.time_range[1])} ET` : `around ${clock(x.time_et)} ET`])
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
