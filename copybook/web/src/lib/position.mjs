// One fund's position in one stock on the stock pages (scripts/stocks.mjs), rolled up from its 13F lines.
// A line ingest flags suspect_units has a share count or value off scale (Guardcap BKNG 2026Q3: 1,304 pre-split
// shares at $5,120, against a prior of 646,216 post-split shares), so the position's trade is unknown: change
// 'unknown' and delta_value null, never 'trimmed' or 'added', and no total counts it.

export const newPosition = (hadPrev) => ({ shares: 0, value: 0, prev_shares: 0, prev_value: 0, delta_value: 0, had_prev: hadPrev, suspect: false, reason: null, price_outlier: false, value_basis: null })

/** Adds one 13F line (a share line, no options) to the position. */
export function addLine(p, h) {
  p.shares += h.shares
  p.value += h.value
  p.prev_shares += h.prev_shares ?? 0
  p.prev_value += h.prev_value ?? 0
  const price = h.shares ? h.value / h.shares : h.prev_shares ? (h.prev_value ?? 0) / h.prev_shares : 0
  p.delta_value += p.had_prev ? (h.shares - (h.prev_shares ?? 0)) * price : 0
  if (h.suspect_units) {
    p.suspect = true
    p.reason ??= h.suspect_reason ?? null
  }
  if (h.price_outlier) p.price_outlier = true
  if (h.value_basis && h.value_basis !== 'filed') p.value_basis = h.value_basis
  return p
}

/** The position's change against the prior quarter and the trade in dollars (null when unknown). */
export function positionMove(p) {
  if (p.had_prev && p.suspect) return { change: 'unknown', delta_value: null }
  const change = !p.had_prev ? null : p.shares === 0 ? 'exited' : p.prev_shares === 0 ? 'new' : p.shares > p.prev_shares ? 'added' : p.shares < p.prev_shares ? 'trimmed' : 'unchanged'
  return { change, delta_value: Math.round(p.delta_value) }
}

/** Ingest's flags, on the row only when set. */
export const positionFlags = (p) => ({
  ...(p.suspect ? { suspect_units: true, suspect_reason: p.reason } : {}),
  ...(p.price_outlier ? { price_outlier: true } : {}),
  ...(p.value_basis ? { value_basis: p.value_basis } : {}),
})
