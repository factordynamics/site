// Shared by the app (src/lib/data.ts) and the build scripts (scripts/cards.mjs), so a fund is named the same everywhere.
const KEEP = new Set(['LP', 'LLC', 'PLC', 'ETF', 'SPDR', 'S&P', 'NV', 'SA', 'AG', 'SE', 'II', 'III', 'IV', 'USA', 'UK', 'AQR', 'GQG', 'HSBC', 'BNP', 'FMR', 'BHP', 'ASML', 'NVIDIA', 'AT&T', 'ADR', 'REIT', 'GE', 'MSCI', 'IBM', 'AMD', 'KLA', 'UBS', 'CVS', 'TJX', 'LLP', 'PDT', 'CPP', 'DE', 'US'])
const SMALL = new Set(['of', 'and', 'the', 'for', 'de', 'du'])

/** EDGAR's ALL-CAPS names as people write them: "AQR CAPITAL MANAGEMENT LLC" -> "AQR Capital Management LLC". */
export function displayName(s) {
  if (!s) return ''
  const trimmed = s.replace(/\\+$/, '').replace(/\s+\/[A-Z]{2,3}\/?$/, '').trim()
  if (/[a-z]/.test(trimmed)) return trimmed
  return trimmed
    .toLowerCase()
    .split(/(\s+|-|\/)/)
    .map((w, i) => {
      const up = w.toUpperCase()
      if (KEEP.has(up.replace(/[.,]/g, ''))) return up
      if (i > 0 && SMALL.has(w)) return w
      if (/^[a-z]\.?$/.test(w) || /^([a-z]\.){2,}$/.test(w)) return up
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join('')
}
