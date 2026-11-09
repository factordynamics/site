// Page titles with live numbers, shared by the build (scripts/postbuild.mjs, scripts/cards.mjs), which
// writes them into each page's HTML for search and link previews, and by the pages, which keep the same
// title in the tab once their data has loaded.

const num = (v) => Number(v ?? 0).toLocaleString('en-US')
const usd = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`)
export const qLabel = (q) => (q ? q.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1') : 'latest')

/** "Who owns SIRI? 3 superinvestors, 15 hedge funds, 600 13F filers · Q3 2026": the page's default lens first. */
export function stockTitle({ ticker, superinvestors, hedge, filers, quarter }) {
  const parts = [superinvestors ? `${num(superinvestors)} superinvestor${superinvestors === 1 ? '' : 's'}` : null, hedge ? `${num(hedge)} hedge fund${hedge === 1 ? '' : 's'}` : null, filers ? `${num(filers)} 13F filers` : null].filter(Boolean)
  return parts.length ? `Who owns ${ticker}? ${parts.join(', ')} · ${qLabel(quarter)}` : `Who owns ${ticker}? · Copybook`
}

/** "Warren Buffett 13F portfolio, Q2 2026: $299.3B in 29 positions" (share positions, as the page counts them). */
export function investorTitle({ who, quarter, value, positions }) {
  return value ? `${who} 13F portfolio, ${qLabel(quarter)}: ${usd(value)} in ${num(positions)} positions` : `${who} portfolio · Copybook`
}

/** "Q3 2026 13F filing season: 2 of 40 superinvestors filed · live tracker". */
export function seasonTitle({ quarter, filed, total }) {
  return `${qLabel(quarter)} 13F filing season: ${filed} of ${total} superinvestors filed · live tracker`
}

/** Until about 10 superinvestors have filed, the recap names them, so it doesn't read as the whole field:
 *  "Q3 2026 so far: what Pzena and Tweedy bought and sold · 2 of 40 superinvestors filed". */
export function recapTitle({ quarter, filed, total, names = [], final = false }) {
  const Q = qLabel(quarter)
  if (!final && filed > 0 && filed < 10 && names.length) {
    const who = names.length <= 3 ? names.join(names.length === 2 ? ' and ' : ', ').replace(/, ([^,]+)$/, ' and $1') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
    return `${Q} so far: what ${who} bought and sold · ${filed} of ${total} superinvestors filed`
  }
  return `${Q} 13F recap: what the superinvestors bought and sold · Copybook`
}
