// Link-preview cards (1200×630) for filer and stock pages, drawn from the page's own data at build time
// with the same fonts and colours as the season and filing cards. Each returns an absolute URL with a
// content hash (?v=), so X and Slack fetch a new image whenever the text changes.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const SITE = process.env.VITE_SITE || 'https://copybook.factordynamics.com/'
const fonts = new URL('../node_modules/geist/dist/fonts/', import.meta.url).pathname
const fontFiles = [
  ...['Regular', 'Medium', 'SemiBold', 'Bold'].map((w) => join(fonts, 'geist-sans', `Geist-${w}.ttf`)),
  ...['Medium', 'SemiBold'].map((w) => join(fonts, 'geist-mono', `GeistMono-${w}.ttf`)),
]
const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const LOGO =
  '<g transform="translate(72 58) scale(1.75)"><rect x="1.5" y="5" width="14" height="17.5" rx="3.2" fill="#0c0e13"/><rect x="8" y="1.5" width="14.5" height="17.5" rx="3.2" fill="#2b44d6" stroke="#fbfaf7" stroke-width="1.4"/><rect x="11" y="6" width="8.5" height="1.8" rx=".9" fill="#fff"/><rect x="11" y="9.6" width="6" height="1.8" rx=".9" fill="#fff" opacity=".85"/><rect x="11" y="13.2" width="3.6" height="1.8" rx=".9" fill="#fff" opacity=".7"/></g>'

// The headline on up to two lines of about 30 characters, split at a word.
function lines(s, n = 30) {
  if (s.length <= n) return [s]
  const i = s.lastIndexOf(' ', n)
  const a = i > 10 ? s.slice(0, i) : s.slice(0, n)
  return [a, cut(s.slice(a.length).trim(), n)]
}

/**
 * Draws a card and writes it to <dist>/og/<name>.png.
 * @param {string} dist the build output directory
 * @param {string} name e.g. "investors/irving-kahn"
 * @param {{ kicker: string, title: string, sub?: string, rows?: [string, string][], cta: string, url: string }} c
 * @returns {string} the image's absolute URL
 */
export function ogCard(dist, name, c) {
  const head = lines(c.title)
  const big = head.length === 1 ? 72 : 60
  const ty = head.length === 1 ? 250 : 222
  const title = head.map((l, i) => `<text x="72" y="${ty + i * (big + 8)}" font-family="Geist" font-weight="600" font-size="${big}" letter-spacing="-2.4" fill="#0c0e13">${x(l)}</text>`).join('\n')
  const subY = ty + (head.length - 1) * (big + 8) + 56
  const rows = (c.rows ?? [])
    .slice(0, 3)
    .map(([a, b], i) => {
      const y = subY + 70 + i * 44
      return `<text x="72" y="${y}" font-family="Geist" font-weight="600" font-size="25" fill="#0c0e13">${x(cut(a, 34))}</text>
<text x="1128" y="${y}" text-anchor="end" font-family="Geist" font-weight="500" font-size="24" fill="#5f6572">${x(cut(b, 40))}</text>`
    })
    .join('\n')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#fbfaf7"/>
${LOGO}
<text x="124" y="94" font-family="Geist" font-weight="600" font-size="32" letter-spacing="-0.8" fill="#0c0e13">Copybook</text>
<text x="1128" y="92" text-anchor="end" font-family="Geist" font-weight="700" font-size="18" letter-spacing="1.6" fill="#2b44d6">${x(c.kicker.toUpperCase())}</text>
${title}
${c.sub ? `<text x="72" y="${subY}" font-family="Geist" font-weight="500" font-size="28" fill="#393e49">${x(cut(c.sub, 70))}</text>` : ''}
${rows}
<path d="M72 548H1128" stroke="#e6e3dc"/>
<rect x="72" y="566" width="${Math.min(560, 40 + c.cta.length * 12.5)}" height="44" rx="22" fill="#0c0e13"/>
<text x="96" y="596" font-family="Geist" font-weight="600" font-size="21" fill="#ffffff">${x(c.cta)}</text>
<text x="1128" y="596" text-anchor="end" font-family="Geist" font-weight="600" font-size="22" fill="#2b44d6">${x(c.url)}</text>
</svg>`
  const png = new Resvg(svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Geist' }, fitTo: { mode: 'width', value: 1200 } }).render().asPng()
  const file = join(dist, 'og', `${name}.png`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, png)
  return `${SITE}og/${name}.png?v=${createHash('sha1').update(png).digest('hex').slice(0, 10)}`
}
