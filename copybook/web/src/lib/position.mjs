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
  // Per share class (full CUSIP): BRK.A and BRK.B, GOOG and GOOGL trade at their own prices and never sum as shares.
  const c = ((p.classes ??= {})[h.cusip ?? ''] ??= { cusip: h.cusip ?? null, ticker: h.ticker ?? null, shares: 0, prev_shares: 0, value: 0, prev_value: 0, delta_value: 0, side: null })
  c.shares += h.shares
  c.value += h.value
  c.prev_shares += h.prev_shares ?? 0
  c.prev_value += h.prev_value ?? 0
  c.delta_value += p.had_prev ? (h.shares - (h.prev_shares ?? 0)) * price : 0
  if (h.suspect_units || h.price_outlier || h.unreliable) c.side = c.side == null || c.side === (h.unreliable ?? 'both') ? (h.unreliable ?? 'both') : 'both'
  if (h.value_basis && h.value_basis !== 'filed') p.value_basis = h.value_basis
  // Lines ingest held out of a counted row (Crosslink CRM 2026Q3: a $4.44 line beside the real one), shown as filed.
  if (h.held_lines?.length) (p.held_lines ??= []).push(...h.held_lines)
  return p
}

// A filed conversion ratio between share classes (Berkshire's 10-K 0001193125-26-083899: one Class A converts into
// 1,500 Class B), as ingest's moves.CLASS_UNITS. Classes without one have no common share unit.
const CLASS_UNITS = { '084670108': ['BRK.B', 1500], '084670702': ['BRK.B', 1] }
const RATIO_SOURCE = { 'BRK.B': '0001193125-26-083899' }

const dir = (c) => (c.shares > c.prev_shares + 0.5 ? 1 : c.shares < c.prev_shares - 0.5 ? -1 : 0)

/** Share classes of the position, or null for one class (or one position re-coded: the same ticker, one CUSIP
 * exited and the other new, which stays one position at net shares). */
function multiClass(p) {
  const cs = Object.values(p.classes ?? {})
  if (cs.length < 2) return null
  const recoded = cs.length === 2 && cs[0].ticker && cs[0].ticker === cs[1].ticker && cs.some((c) => c.shares === 0 && c.prev_shares > 0) && cs.some((c) => c.prev_shares === 0 && c.shares > 0)
  return recoded ? null : cs
}

function classChange(c, hadPrev) {
  if ((c.side === 'shares' || c.side === 'both') && !(c.shares === 0 || c.prev_shares === 0)) return 'unknown'
  if (!hadPrev) return null
  return c.shares === 0 ? 'exited' : c.prev_shares === 0 ? 'new' : ['trimmed', 'unchanged', 'added'][dir(c) + 1]
}

/** A multi-class position (as ingest's hl/ rows): each class's trade at its own price, dollars summed over the
 * classes that are counted; change from the classes ('mixed' when they move opposite ways, with net_direction);
 * shares only through a conversion ratio (shares_unit), else null with the counts in classes[]. FMR 2026Q3 BRK:
 * A -7,574 and B -802,720, about -$6.06B, not -810,294 'shares'. */
function classMove(p, cs) {
  const clean = cs.filter((c) => !c.side)
  const units = cs.map((c) => CLASS_UNITS[c.cusip])
  const unit = units.every(Boolean) && new Set(units.map((u) => u[0])).size === 1 ? units[0][0] : null
  const out = {
    shares: unit ? cs.reduce((a, c) => a + c.shares * CLASS_UNITS[c.cusip][1], 0) : null,
    prev_shares: unit ? cs.reduce((a, c) => a + c.prev_shares * CLASS_UNITS[c.cusip][1], 0) : null,
    ...(unit ? { shares_unit: unit, shares_ratio: Object.fromEntries(cs.map((c) => [c.cusip, CLASS_UNITS[c.cusip][1]])), ratio_source: RATIO_SOURCE[unit] } : {}),
    classes: cs
      .slice()
      .sort((a, z) => z.value - a.value)
      .map((c) => ({ cusip: c.cusip, ticker: c.ticker, shares: c.shares, prev_shares: p.had_prev ? c.prev_shares : null, value: Math.round(c.value), prev_value: p.had_prev ? Math.round(c.prev_value) : null, change: classChange(c, p.had_prev), value_delta: p.had_prev && !c.side ? Math.round(c.delta_value) : null, ...(c.side ? { unreliable: c.side } : {}) })),
    classes_held: cs.length - clean.length,
  }
  if (!p.had_prev) return { change: null, delta_value: Math.round(p.delta_value), ...out }
  if (!clean.length) return { ...positionMove({ ...p, classes: null }), ...out }
  const delta = Math.round(clean.reduce((a, c) => a + c.delta_value, 0))
  const dirs = new Set(clean.map(dir).filter(Boolean))
  const change = clean.every((c) => c.prev_shares === 0) ? 'new' : clean.every((c) => c.shares === 0) ? 'exited' : !dirs.size ? 'unchanged' : dirs.size > 1 ? 'mixed' : dirs.has(1) ? 'added' : 'trimmed'
  return { change, delta_value: change === 'unchanged' ? 0 : delta, value_delta_basis: 'trade', net_direction: delta > 0 ? 'buy' : delta < 0 ? 'sell' : 'flat', ...out }
}

/** The position's change against the prior quarter and the trade in dollars (null when unknown). */
export function positionMove(p) {
  const cs = multiClass(p)
  if (cs) return classMove(p, cs)
  const change = !p.had_prev ? null : p.shares === 0 ? 'exited' : p.prev_shares === 0 ? 'new' : p.shares > p.prev_shares ? 'added' : p.shares < p.prev_shares ? 'trimmed' : 'unchanged'
  if (!(p.had_prev && p.suspect)) return { change, delta_value: Math.round(p.delta_value), ...(p.had_prev ? { value_delta_basis: 'trade' } : {}) }
  if (change === 'new' || change === 'exited' || p.side === 'value') return { change, delta_value: null }
  return { change: 'unknown', delta_value: null, ...(p.side === 'shares' ? { value_change: Math.round(p.value - p.prev_value) } : {}) }
}

/** Ingest's flags, on the row only when set. */
export const positionFlags = (p) => {
  const cs = multiClass(p)
  // A multi-class row counted on its clean classes carries classes_held, not the held class's flags.
  if (cs && cs.some((c) => !c.side)) return { ...(p.held_lines ? { held_lines: p.held_lines } : {}) }
  return flagsOf(p)
}

const flagsOf = (p) => ({
  ...(p.reason ? { suspect_units: true, suspect_reason: p.reason } : {}),
  ...(p.side ? { unreliable: p.side } : {}),
  ...(p.price_outlier ? { price_outlier: true } : {}),
  ...(p.value_basis ? { value_basis: p.value_basis } : {}),
  ...(p.held_lines ? { held_lines: p.held_lines } : {}),
})
