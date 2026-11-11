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
  // Lines ingest held out of a counted row (Crosslink CRM 2026Q3: a $4.44 line beside the real one), shown as filed.
  if (h.held_lines?.length) (p.held_lines ??= []).push(...h.held_lines)
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
  ...(p.held_lines ? { held_lines: p.held_lines } : {}),
})

/** A position over several share classes (BRK.A and BRK.B, GOOGL and GOOG), the way ingest's hl/ rows carry it
 *  (classes[]): one entry per 13F line, each with its own trade at its own price (the line's value_delta). A held
 *  class (flagged) keeps its facts and reason but no dollars; the position counts the clean classes only. Shares add
 *  up only through ingest's filed conversion ratio (`ratio`, CUSIP -> shares of `unit`, e.g. one BRK.A = 1,500 BRK.B),
 *  else they can't be summed. Clean classes moving opposite ways are "mixed" and the change follows the net dollars.
 *  `lines` are the fund's share lines (no options); returns the fields that replace the rolled-up ones. */
export function classPosition(lines, hadPrev, { unit = null, ratio = null } = {}) {
  const letter = (h) => /\bClass\s+([A-Z])\b/.exec(h.display_name ?? '')?.[1] ?? null
  const classes = lines.map((h) => {
    const ps = h.prev_shares ?? 0
    // A line with no shares either quarter (T. Rowe's Alphabet depositary sleeves, value but 0 shares) is held, as ingest holds it.
    const zero = h.shares <= 0 && ps <= 0
    const held = zero || Boolean(h.unreliable || h.suspect_units || h.price_outlier || h.change === 'unknown')
    const price = h.shares ? h.value / h.shares : ps ? (h.prev_value ?? 0) / ps : 0
    const change = !hadPrev ? null : held ? 'unknown' : h.shares <= 0 ? 'exited' : ps <= 0 ? 'new' : h.shares > ps + 0.5 ? 'added' : h.shares < ps - 0.5 ? 'trimmed' : 'unchanged'
    const delta = !hadPrev || held ? null : change === 'unchanged' ? 0 : Math.round(h.value_delta ?? (h.shares - ps) * price)
    return { ticker: h.ticker ?? null, cusip: h.cusip, class: letter(h), shares: h.shares, prev_shares: ps, change, delta_value: delta, held_reason: held ? (zero ? 'zero_shares' : (h.held_reason ?? h.suspect_reason ?? 'unreliable')) : null }
  })
  const clean = classes.filter((c) => !c.held_reason)
  const sum = (k, xs) => xs.reduce((a, c) => a + c[k], 0)
  const units = ratio && lines.every((h) => ratio[h.cusip]) ? (k) => Math.round(lines.reduce((a, h) => a + (h[k] ?? 0) * ratio[h.cusip], 0)) : null
  const out = { classes, classes_held: classes.length - clean.length, shares_unit: units ? unit : null, ...(units ? { shares: units('shares'), prev_shares: units('prev_shares') } : { shares_summable: false }) }
  if (!hadPrev || !clean.length) return out // nothing counted: the rolled-up move (unknown when every class is held) stands
  const delta = sum('delta_value', clean)
  const dirs = new Set(clean.map((c) => (c.shares > c.prev_shares + 0.5 ? 1 : c.shares < c.prev_shares - 0.5 ? -1 : 0)).filter(Boolean))
  const mixed = dirs.size > 1
  const change = sum('prev_shares', clean) <= 0 ? 'new' : sum('shares', clean) <= 0 ? 'exited' : mixed ? (delta > 0 ? 'added' : delta < 0 ? 'trimmed' : 'unchanged') : dirs.has(1) ? 'added' : dirs.has(-1) ? 'trimmed' : 'unchanged'
  return { ...out, change, delta_value: change === 'unchanged' && !mixed ? 0 : delta, ...(mixed ? { mixed: true } : {}) }
}
