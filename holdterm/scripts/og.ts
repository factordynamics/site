// Social preview cards (1200×630 PNG), drawn as SVG and rasterised with resvg at build time: the site card
// (public/og.png) and one per roster fund (dist/og/m/{slug}.png) with its latest 13F at a glance. Inter is
// bundled under scripts/fonts (SIL Open Font License), so the build needs no system fonts.
import { Resvg } from '@resvg/resvg-js'
import { fileURLToPath } from 'node:url'

const FONTS = ['Regular', 'SemiBold', 'Bold'].map((w) => fileURLToPath(new URL(`./fonts/Inter-${w}.ttf`, import.meta.url)))
const W = 1200
const H = 630
const C = { bg: '#f4f5f7', card: '#ffffff', ink: '#111827', ink2: '#374151', dim: '#5d6573', line: '#e4e7ec', acc: '#2457d0', accSoft: '#eaf0fd', pos: '#0b7a42', neg: '#c22a2a', brand: '#ffb224' }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** Inter's average advance, as a share of the font size; good enough to wrap and shrink headlines. */
const width = (s: string, size: number, bold = true) => [...s].reduce((w, c) => w + (c === ' ' ? 0.27 : /[A-Z0-9$%]/.test(c) ? 0.68 : /[il.,'’:;|!]/.test(c) ? 0.29 : /[mwMW]/.test(c) ? 0.9 : 0.59), 0) * size * (bold ? 1.05 : 1)

/** Up to `lines` lines no wider than `max`, at the largest size from `sizes` that fits. */
function fit(text: string, max: number, sizes: number[], lines = 2): { size: number; rows: string[] } {
  for (const size of sizes) {
    const rows: string[] = []
    for (const word of text.split(/\s+/)) {
      const last = rows[rows.length - 1]
      if (last && width(`${last} ${word}`, size) <= max) rows[rows.length - 1] = `${last} ${word}`
      else rows.push(word)
    }
    if (rows.length <= lines && rows.every((r) => width(r, size) <= max)) return { size, rows }
  }
  const size = sizes[sizes.length - 1]
  const rows = [text]
  while (width(rows[0] + '…', size) > max && rows[0].length > 4) rows[0] = rows[0].slice(0, -1)
  return { size, rows: [rows[0].trimEnd() + (rows[0] === text ? '' : '…')] }
}

const mark = (x: number, y: number, s: number) =>
  `<g transform="translate(${x} ${y}) scale(${s / 20})"><rect width="20" height="20" rx="4.5" fill="${C.brand}"/><rect x="4" y="4.5" width="12" height="2.2" fill="#0b0b0a"/><rect x="4" y="8.9" width="8.5" height="2.2" fill="#0b0b0a"/><rect x="4" y="13.3" width="5" height="2.2" fill="#0b0b0a"/></g>`

function frame(body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="28" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>
${mark(88, 84, 40)}
<text x="142" y="114" font-family="Inter" font-weight="700" font-size="30" fill="${C.ink}">Holdterm</text>
${body}
<text x="88" y="${H - 84}" font-family="Inter" font-size="22" fill="${C.dim}">holdterm.factordynamics.com · From SEC EDGAR filings · No ads</text>
</svg>`
}

export const png = (svg: string) => new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: W } }).render().asPng()

/** The site's own card. */
export function siteCard(funds: number) {
  const head = fit('See what the world’s most patient investors buy and sell', 960, [64, 58], 2)
  return frame(`
${head.rows.map((r, i) => `<text x="88" y="${240 + i * head.size * 1.15}" font-family="Inter" font-weight="700" font-size="${head.size}" fill="${C.ink}" letter-spacing="-1.2">${esc(r)}</text>`).join('\n')}
${fit(`Portfolios, trades and 5% stakes of ${funds} long-term funds, within hours of each filing.`, 960, [28], 2).rows.map((r, i) => `<text x="88" y="${256 + head.rows.length * head.size * 1.15 + i * 40}" font-family="Inter" font-size="28" fill="${C.ink2}">${esc(r)}</text>`).join('\n')}`)
}

export type FundCard = { firm: string; pm: string | null; quarter: string; filed: string; value: string; positions: number; change: { text: string; up: boolean } | null; top: { name: string; weight: number }[] }

/** One fund's latest 13F: name, size, and its three largest holdings as bars. */
export function fundCard(f: FundCard) {
  const name = fit(f.firm, 640, [64, 56, 48, 42], 2)
  const y0 = 236
  const nameRows = name.rows.map((r, i) => `<text x="88" y="${y0 + i * name.size * 1.12}" font-family="Inter" font-weight="700" font-size="${name.size}" fill="${C.ink}" letter-spacing="-1">${esc(r)}</text>`).join('\n')
  const yb = y0 + (name.rows.length - 1) * name.size * 1.12
  const sub = [`${f.quarter} 13F, filed ${f.filed}`, f.pm && `run by ${f.pm}`].filter(Boolean).join(' · ')
  const max = Math.max(...f.top.map((t) => t.weight), 0.01)
  const bars = f.top
    .map((t, i) => {
      const y = 214 + i * 92
      const label = fit(t.name, 252, [24, 22], 1).rows[0]
      return `<text x="770" y="${y}" font-family="Inter" font-weight="600" font-size="${fit(t.name, 252, [24, 22], 1).size}" fill="${C.ink}">${esc(label)}</text>
<text x="1112" y="${y}" text-anchor="end" font-family="Inter" font-weight="600" font-size="24" fill="${C.ink2}">${(t.weight * 100).toFixed(1)}%</text>
<rect x="770" y="${y + 16}" width="342" height="14" rx="7" fill="${C.accSoft}"/>
<rect x="770" y="${y + 16}" width="${Math.max(14, (t.weight / max) * 342).toFixed(1)}" height="14" rx="7" fill="${C.acc}"/>`
    })
    .join('\n')
  return frame(`
<text x="88" y="164" font-family="Inter" font-weight="600" font-size="24" fill="${C.acc}">13F portfolio</text>
${nameRows}
<text x="88" y="${yb + 52}" font-family="Inter" font-size="24" fill="${C.dim}">${esc(fit(sub, 640, [24, 21], 1).rows[0])}</text>
<text x="88" y="${yb + 136}" font-family="Inter" font-weight="700" font-size="72" fill="${C.ink}" letter-spacing="-1.5">${esc(f.value)}</text>
<text x="88" y="${yb + 180}" font-family="Inter" font-size="26" fill="${C.ink2}">in ${f.positions} US-listed stock${f.positions === 1 ? '' : 's'}</text>
${f.change ? `<text x="${88 + width(`in ${f.positions} US-listed stocks`, 26, false) + 16}" y="${yb + 180}" font-family="Inter" font-weight="600" font-size="26" fill="${f.change.up ? C.pos : C.neg}">${esc(f.change.text)}</text>` : ''}
<line x1="730" y1="150" x2="730" y2="470" stroke="${C.line}" stroke-width="2"/>
<text x="770" y="168" font-family="Inter" font-weight="600" font-size="22" fill="${C.dim}">LARGEST HOLDINGS</text>
${bars}`)
}
