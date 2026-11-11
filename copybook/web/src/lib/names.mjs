import NAMES from './display-names.json' with { type: 'json' }
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

// Lead with the firm where the named person no longer runs it (lead, Nov 11): Irving Kahn died in 2015 and the 13F
// is Kahn Brothers Group's; Greg Abel has run Berkshire since Jan 1, 2026; Bridgewater is run without Dalio. Founders
// who still run their firms keep their names. Slugs stay as they are. Ingest's manager list is the source to fix.
// One copy, keyed by slug, shared with the API's emails (display-names.json). The person-named slugs give the
// name ingest's index.json uses ("irving-kahn" -> "Irving Kahn"), so a raw name from any file maps too.
export const BY_SLUG = NAMES
export const RENAME = Object.fromEntries(Object.entries(NAMES).map(([slug, name]) => [slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), name]))
// The best-known superinvestors, most-followed first: who a card or a stock page names first.
export const MARQUEE = ['warren-buffett', 'bill-ackman', 'stanley-druckenmiller', 'david-tepper', 'seth-klarman', 'ray-dalio', 'carl-icahn', 'li-lu', 'howard-marks', 'david-einhorn', 'bill-gates', 'dan-loeb', 'nelson-peltz', 'chase-coleman', 'terry-smith', 'chris-hohn', 'philippe-laffont']

/** Page titles keep the person's name for search: "Kahn Brothers (Irving Kahn’s firm)". */
export const SEO_NAME = { 'Kahn Brothers': 'Kahn Brothers (Irving Kahn’s firm)' }
/** index.json with RENAME applied to each manager, for the build scripts that read it directly. */
export const renamed = (index) => ({ ...index, managers: index.managers.map((m) => (BY_SLUG[m.slug] ? { ...m, manager: BY_SLUG[m.slug] } : m)) })

export function displayName(s) {
  if (!s) return ''
  if (RENAME[s]) return RENAME[s]
  // EDGAR's state or country suffix, with or without a space: "INC/CA", "INC. /MD/".
  const trimmed = s.replace(/\\+$/, '').replace(/\s*\/[A-Za-z]{2,3}\/?$/, '').trim()
  // Mixed case: keep it, but a company suffix left in capitals reads as shouting ("Jensen Investment Management INC").
  if (/[a-z]/.test(trimmed)) return trimmed.split(/(\s+|-|\/)/).map((w) => w.replace(/^(INC|CO|CORP|LTD)([.,]*)$/, (_, x, t) => x.charAt(0) + x.slice(1).toLowerCase() + t)).map(polish).join('')
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

/** "Kahn Brothers’", "Bill Ackman’s": the possessive by how the name ends. */
export const possessive = (name) => {
  // "Berkshire Hathaway (Warren Buffett)" -> "Berkshire Hathaway’s".
  const n = shortName(name)
  return /s$/i.test(n) ? `${n}’` : `${n}’s`
}
/** A name without its parenthetical, for tight spots and running text: "Berkshire Hathaway". */
export const shortName = (name) => (name ?? '').replace(/\s*\([^)]*\)$/, '')
