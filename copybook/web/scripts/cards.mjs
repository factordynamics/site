// Public filing cards: one per curated fund's latest 13F that has a quarter before it to compare with.
// Writes <out>/d/f/{accession}.json (the /f/{accession}/ page's data), <out>/og/f/{accession}.png (the
// 1200x630 share image) and <out>/f/{accession}/index.html with that image in its OG tags.
// Runs in the Pages build after vite and before postbuild (copybook-pages.yml).
// Usage: node scripts/cards.mjs <out dir> [data base URL or dir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const out = process.argv[2] || 'dist'
const base = process.argv[3] || process.env.VITE_DATA_BASE || 'https://refcell.github.io/gust/copybook/data/'
const SITE = process.env.VITE_SITE || 'https://copybook.factordynamics.com/'
const read = async (f) =>
  base.startsWith('http') ? await fetch(base + f).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${f}`)))) : JSON.parse(readFileSync(join(base, f), 'utf8'))

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
const tc = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()))

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
    const all = ['new', 'added', 'trimmed', 'exited'].flatMap((k) => (b.moves[k] ?? []).filter((h) => !h.put_call && h.value_delta).map((h) => ({ ...h, change: k })))
    if (!all.length) continue
    const moves = all
      .sort((a, z) => Math.abs(z.value_delta) - Math.abs(a.value_delta))
      .slice(0, 5)
      .map((h) => ({ ticker: h.ticker, name: h.display_name || tc(h.issuer), cusip: h.cusip, change: h.change, value_delta: Math.round(h.value_delta), shares: h.shares, prev_shares: h.prev_shares, weight: h.weight }))
    const c = {
      accession: b.accession,
      slug: b.slug,
      manager: b.manager,
      firm: tc(b.name),
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
      .replace(/<title>.*?<\/title>/, `<title>${esc(title)}</title>`)
      .replace(/(<meta name="description" content=")[^"]*/, `$1${esc(desc)}`)
      .replace(/(<meta property="og:title" content=")[^"]*/, `$1${esc(title)}`)
      .replace(/(<meta property="og:description" content=")[^"]*/, `$1${esc(desc)}`)
      .replaceAll(`${SITE}og.png`, img)
      .replace('<meta property="og:type"', `<link rel="canonical" href="${SITE}f/${c.accession}/" />\n    <meta name="twitter:title" content="${esc(title)}" />\n    <meta name="twitter:description" content="${esc(desc)}" />\n    <meta property="og:type"`)
    mkdirSync(join(out, 'f', c.accession), { recursive: true })
    writeFileSync(join(out, 'f', c.accession, 'index.html'), html)
    list.push({ accession: c.accession, slug: c.slug, quarter: c.quarter, filing_date: c.filing_date })
  }
}
// Investor pages and Flow link a fund's card only when it exists.
writeFileSync(join(out, 'd', 'f', 'index.json'), JSON.stringify({ generated_at: index.generated_at, cards: list.sort((a, z) => z.filing_date.localeCompare(a.filing_date)) }))
console.log(`filing cards: ${list.length}`)
