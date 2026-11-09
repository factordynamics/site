// Shared by the app (src/lib/data.ts) and the build scripts (scripts/cards.mjs), so a fund is named the same everywhere.
const KEEP = new Set(['LP', 'LLC', 'PLC', 'ETF', 'SPDR', 'S&P', 'NV', 'SA', 'AG', 'SE', 'II', 'III', 'IV', 'USA', 'UK', 'AQR', 'GQG', 'HSBC', 'BNP', 'FMR', 'BHP', 'ASML', 'NVIDIA', 'AT&T', 'ADR', 'REIT', 'GE', 'MSCI', 'IBM', 'AMD', 'KLA', 'UBS', 'CVS', 'TJX', 'LLP', 'PDT', 'CPP', 'DE', 'US'])
const SMALL = new Set(['of', 'and', 'the', 'for', 'de', 'du'])

/** EDGAR's ALL-CAPS names as people write them: "AQR CAPITAL MANAGEMENT LLC" -> "AQR Capital Management LLC". */
// Brand casings a word-by-word rule can't guess, and "Mc" names (McDonald, McLennan).
const FIX = { blackrock: 'BlackRock', jpmorgan: 'JPMorgan', pimco: 'PIMCO', ishares: 'iShares', proshares: 'ProShares', wisdomtree: 'WisdomTree', vaneck: 'VanEck', mckinsey: 'McKinsey' }
const polish = (w) => {
  const [, base, tail] = w.match(/^(.*?)([.,]*)$/)
  const fixed = FIX[base.toLowerCase()] ?? (/^mc[a-z]{2,}$/i.test(base) ? `Mc${base.charAt(2).toUpperCase()}${base.slice(3).toLowerCase()}` : null)
  return fixed ? fixed + tail : w
}

export function displayName(s) {
  if (!s) return ''
  // EDGAR's state or country suffix, with or without a space: "INC/CA", "INC. /MD/".
  const trimmed = s.replace(/\\+$/, '').replace(/\s*\/[A-Za-z]{2,3}\/?$/, '').trim()
  if (/[a-z]/.test(trimmed)) return trimmed.split(/(\s+|-|\/)/).map(polish).join('')
  return trimmed
    .toLowerCase()
    .split(/(\s+|-|\/)/)
    .map((w, i) => {
      const up = w.toUpperCase()
      if (KEEP.has(up.replace(/[.,]/g, ''))) return up
      // A short code in parentheses: "(HK)", "(UK)".
      if (/^\([a-z]{2,3}\)$/.test(w)) return up
      if (polish(w) !== w) return polish(w)
      if (i > 0 && SMALL.has(w)) return w
      if (/^[a-z]\.?$/.test(w) || /^([a-z]\.){2,}$/.test(w)) return up
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join('')
}
