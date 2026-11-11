// One 13F's public card (/f/{accession}/): its top five moves and its 1200x630 share image as SVG.
// Shared by the Pages build (scripts/cards.mjs, which writes d/f/{accession}.json and the PNG) and the
// browser, which builds the same card from gust's {slug}.json when a filing is newer than the last build.
import { displayName } from './names.mjs'

export const qn = (q) => (q ? Number(q.slice(0, 4)) * 4 + Number(q.slice(5)) - 1 : -1)
export const qLabel = (q) => `Q${q.slice(5)} ${q.slice(0, 4)}`
export const dLabel = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
export const money = (v) => {
  const a = Math.abs(v)
  return a >= 1e9 ? `$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(0)}K` : `$${Math.round(a)}`
}
export const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

// The card for a fund's book file ({slug}.json), or null when it has no earlier quarter or no share moves.
export function buildCard(b) {
  if (!b?.prev_quarter || !b.moves || !b.accession) return null
  // Share positions only: an option's filed value is the underlying's notional, not a trade size.
  // A display name shared by several tickers in one book is ingest naming the trust, not the fund (see stocks.mjs).
  const named = new Map()
  for (const h of b.holdings ?? []) if (h.display_name && h.ticker) (named.get(h.display_name) ?? named.set(h.display_name, new Set()).get(h.display_name)).add(h.ticker.split(/[.-]/)[0])
  const nameOf = (h) => (h.display_name && (named.get(h.display_name)?.size ?? 0) <= 1 ? h.display_name : displayName(h.issuer))
  const all = ['new', 'added', 'trimmed', 'exited'].flatMap((k) => (b.moves[k] ?? []).filter((h) => !h.put_call && h.value_delta).map((h) => ({ ...h, change: k })))
  if (!all.length) return null
  const moves = all
    .sort((a, z) => Math.abs(z.value_delta) - Math.abs(a.value_delta))
    .slice(0, 5)
    .map((h) => ({ ticker: h.ticker, name: nameOf(h), cusip: h.cusip, change: h.change, value_delta: Math.round(h.value_delta), shares: h.shares, prev_shares: h.prev_shares, weight: h.weight }))
  return {
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
}

const TONE = { new: ['NEW', '#e3f1e8', '#126b3c'], added: ['ADDED', '#e3f1e8', '#126b3c'], trimmed: ['TRIMMED', '#f8e5e3', '#b4322a'], exited: ['EXITED', '#f8e5e3', '#b4322a'] }

// The share image. resvg loads the Geist files by these family names; the browser passes the page's own.
export function cardSvg(c, sans = 'Geist', mono = 'Geist Mono') {
  const grid = Array.from({ length: 22 }, (_, i) => `<path d="M${i * 56} 0V630" stroke="#ece9e2"/>`).join('') + Array.from({ length: 12 }, (_, i) => `<path d="M0 ${i * 56}H1200" stroke="#ece9e2"/>`).join('')
  const max = Math.max(...c.moves.map((m) => Math.abs(m.value_delta)), 1)
  const rows = c.moves
    .map((m, i) => {
      const y = 296 + i * 56
      const [label, bg, fg] = TONE[m.change]
      const w = Math.max(8, (Math.abs(m.value_delta) / max) * 125)
      return `<rect x="72" y="${y - 23}" width="112" height="32" rx="8" fill="${bg}"/>
<text x="128" y="${y - 1}" text-anchor="middle" font-family="${sans}" font-weight="700" font-size="15" letter-spacing="1" fill="${fg}">${label}</text>
<text x="206" y="${y + 1}" font-family="${mono}" font-weight="600" font-size="27" fill="#0c0e13">${x(m.ticker || '—')}</text>
<text x="350" y="${y}" font-family="${sans}" font-size="23" fill="#5f6572">${x(cut(m.name, 24))}</text>
<rect x="${m.value_delta >= 0 ? 815 : 815 - w}" y="${y - 14}" width="${w}" height="14" rx="7" fill="${fg}" opacity="0.85"/>
<text x="1128" y="${y}" text-anchor="end" font-family="${sans}" font-weight="600" font-size="26" fill="${fg}">${m.value_delta >= 0 ? '+' : '−'}${money(m.value_delta)}</text>`
    })
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#fbfaf7"/>${grid}
<g transform="translate(72 58) scale(1.75)"><rect x="1.5" y="5" width="14" height="17.5" rx="3.2" fill="#0c0e13"/><rect x="8" y="1.5" width="14.5" height="17.5" rx="3.2" fill="#2b44d6" stroke="#fbfaf7" stroke-width="1.4"/><rect x="11" y="6" width="8.5" height="1.8" rx=".9" fill="#fff"/><rect x="11" y="9.6" width="6" height="1.8" rx=".9" fill="#fff" opacity=".85"/><rect x="11" y="13.2" width="3.6" height="1.8" rx=".9" fill="#fff" opacity=".7"/></g>
<text x="124" y="94" font-family="${sans}" font-weight="600" font-size="32" letter-spacing="-0.8" fill="#0c0e13">Copybook</text>
<text x="1128" y="92" text-anchor="end" font-family="${sans}" font-weight="500" font-size="22" fill="#5f6572">${x(`${qLabel(c.quarter)} 13F · filed ${dLabel(c.filing_date)}`)}</text>
<text x="72" y="186" font-family="${sans}" font-weight="600" font-size="58" letter-spacing="-2" fill="#0c0e13">${x(cut(c.manager, 30))}</text>
<text x="72" y="228" font-family="${sans}" font-size="24" fill="#5f6572">${x(cut(c.manager === c.firm ? `Top moves since ${qLabel(c.prev_quarter)}` : `${c.firm} · top moves since ${qLabel(c.prev_quarter)}`, 70))}</text>
<path d="M72 250H1128" stroke="#e6e3dc"/>
<path d="M815 268V${268 + c.moves.length * 56 - 16}" stroke="#d6d2c9"/>
${rows}
<path d="M72 556H1128" stroke="#e6e3dc"/>
<text x="72" y="596" font-family="${sans}" font-weight="500" font-size="22" fill="#393e49">${x(`Bought ${money(c.bought_usd)} · Sold ${money(c.sold_usd)} · ${c.position_count} positions`)}</text>
<text x="1128" y="596" text-anchor="end" font-family="${sans}" font-weight="600" font-size="22" fill="#2b44d6">copybook.factordynamics.com</text>
</svg>`
}
