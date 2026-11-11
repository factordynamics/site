/**
 * A served book written before ingest linked a reissued CUSIP reads the new code as `new` and the old one as
 * `exited` (FMR's Gates, G39108108 -> G39104107). Moves are keyed by the canonical CUSIP, so the two share a key:
 * pair them back into one position and re-diff its shares. `exited.prevShares` must already be in the new
 * code's units (a linked split's ratio applied).
 *
 * @template {{ key: string, change: string, h: { shares: number, value: number }, delta: number, shares: number, prevShares: number }} M
 * @param {M[]} moves
 * @returns {M[]}
 */
export function pairReissues(moves) {
  /** @type {Map<string, { new?: M, exited?: M }>} */
  const byKey = new Map()
  for (const m of moves) {
    if (m.change !== 'new' && m.change !== 'exited') continue
    const g = byKey.get(m.key) ?? {}
    g[m.change] = m
    byKey.set(m.key, g)
  }
  const drop = new Set()
  const add = []
  for (const [key, g] of byKey) {
    if (!g.new || !g.exited) continue
    drop.add(g.new).add(g.exited)
    const h = g.new.h
    const ds = h.shares - g.exited.prevShares
    if (Math.abs(ds) < 0.5) continue // kept the shares: no trade
    const per = h.shares ? h.value / h.shares : 0
    add.push({ ...g.new, key, change: ds > 0 ? 'added' : 'trimmed', delta: ds * per, shares: h.shares, prevShares: g.exited.prevShares })
  }
  return [...moves.filter((m) => !drop.has(m)), ...add]
}
