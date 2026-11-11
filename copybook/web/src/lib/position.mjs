// One fund's position in one stock on the stock pages (scripts/stocks.mjs), rolled up from its 13F lines.
// A line ingest flags suspect_units has a share count or value off scale (Guardcap BKNG 2026Q3: 1,304 pre-split
// shares at $5,120, against a prior of 646,216 post-split shares), so the position's trade is unknown: change
// 'unknown' and delta_value null, never 'trimmed' or 'added', and no total counts it. Ingest names the unreliable
// side of a flagged line (unreliable): 'value' (BMO TEVA filed at ~$4,005 a share, a real +159,272 shares) keeps
// the share change; 'shares' (Guardcap BKNG, Mizuho SPY calls) shows value_change, the filed value against the prior's;
// 'both' (or a flag with no side, from an older book) is unknown. A new or exited position keeps its label. No
// flagged position has a delta_value, so no $ total counts it.

export const newPosition = (hadPrev) => ({ shares: 0, value: 0, prev_shares: 0, prev_value: 0, delta_value: 0, had_prev: hadPrev, suspect: false, reason: null, side: null, price_outlier: false, value_basis: null })

/** Adds one 13F line (a share line, no options) to the position. */
export function addLine(p, h) {
  p.shares += h.shares
  p.value += h.value
  p.prev_shares += h.prev_shares ?? 0
  p.prev_value += h.prev_value ?? 0
  const price = h.shares ? h.value / h.shares : h.prev_shares ? (h.prev_value ?? 0) / h.prev_shares : 0
  p.delta_value += p.had_prev ? (h.shares - (h.prev_shares ?? 0)) * price : 0
  if (h.suspect_units || h.price_outlier || h.unreliable) {
    const side = h.unreliable ?? 'both'
    p.suspect = true
    p.side = p.side == null || p.side === side ? side : 'both'
    if (h.suspect_units) p.reason ??= h.suspect_reason ?? null
  }
  if (h.price_outlier) p.price_outlier = true
  if (h.value_basis && h.value_basis !== 'filed') p.value_basis = h.value_basis
  return p
}

/** The position's change against the prior quarter and the trade in dollars (null when unknown). */
export function positionMove(p) {
  const change = !p.had_prev ? null : p.shares === 0 ? 'exited' : p.prev_shares === 0 ? 'new' : p.shares > p.prev_shares ? 'added' : p.shares < p.prev_shares ? 'trimmed' : 'unchanged'
  if (!(p.had_prev && p.suspect)) return { change, delta_value: Math.round(p.delta_value), ...(p.had_prev ? { value_delta_basis: 'trade' } : {}) }
  if (change === 'new' || change === 'exited' || p.side === 'value') return { change, delta_value: null }
  return { change: 'unknown', delta_value: null, ...(p.side === 'shares' ? { value_change: Math.round(p.value - p.prev_value) } : {}) }
}

/** Ingest's flags, on the row only when set. */
export const positionFlags = (p) => ({
  ...(p.reason ? { suspect_units: true, suspect_reason: p.reason } : {}),
  ...(p.side ? { unreliable: p.side } : {}),
  ...(p.price_outlier ? { price_outlier: true } : {}),
  ...(p.value_basis ? { value_basis: p.value_basis } : {}),
})
