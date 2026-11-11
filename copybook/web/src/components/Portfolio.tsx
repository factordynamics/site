import { useMemo } from 'react'
import { concentration, sectorMix, sectorOf, type Holding } from '../lib/data'
import { rankColor, sectorColor } from './charts'

export type Agg = Holding & { sector: string; key: string }

/** Share positions, sorted by value, with weights against the share book. Options (calls and puts,
 * filed at the underlying's notional) are split out so they never count as shares. */
export function useBook(holdings: Holding[] | undefined) {
  return useMemo(() => {
    const hs = (holdings || []).filter((h) => h.value > 0).map((h, i) => ({ ...h, sector: sectorOf(h.cusip, h.sector), key: `${h.cusip}-${h.put_call || ''}-${i}` }))
    const shares = hs.filter((h) => !h.put_call)
    const total = shares.reduce((s, h) => s + h.value, 0)
    const rows: Agg[] = shares.map((h) => ({ ...h, weight: total ? h.value / total : 0 })).sort((a, b) => b.value - a.value)
    const opts = hs.filter((h) => h.put_call)
    const optionsValue = opts.reduce((s, h) => s + h.value, 0)
    // "Share of filing": each option line over the whole filing (shares + option notional), computed here so a small
    // line reads "<0.1%" rather than a stored weight rounded to 0.
    const options: Agg[] = opts.map((h) => ({ ...h, weight: total + optionsValue ? h.value / (total + optionsValue) : 0 })).sort((a, b) => b.value - a.value)
    const sectors = sectorMix(rows)
    return { rows, total, options, optionsValue, sectors, top10: concentration(rows, 10), top1: rows[0] }
  }, [holdings])
}

export function treemapItems(rows: Agg[], n = 18, by: 'rank' | 'sector' = 'rank', withRest = true) {
  const head = rows.slice(0, n)
  const rest = rows.slice(n)
  const items = head.map((h, i) => ({
    key: h.key,
    label: h.ticker || shortIssuer(h.issuer),
    isTicker: Boolean(h.ticker),
    sub: h.issuer,
    value: h.value,
    weight: h.weight,
    color: by === 'sector' ? sectorColor(h.sector) : rankColor(i),
  }))
  if (rest.length && withRest) {
    const v = rest.reduce((s, h) => s + h.value, 0)
    items.push({ key: 'rest', isTicker: false, label: `+${rest.length} more`, sub: 'Smaller positions', value: v, weight: rest.reduce((s, h) => s + h.weight, 0), color: '#c9c4b8' })
  }
  return items
}

/** Broad books: draw the top positions only and say what is left out, instead of one giant remainder tile. */
export function mapPlan(rows: Agg[], n: number) {
  const restShare = rows.slice(n).reduce((s, h) => s + h.weight, 0)
  const broad = restShare > 0.25
  return { broad, n: broad ? 25 : n, shown: rows.slice(0, broad ? 25 : n).reduce((s, h) => s + h.weight, 0), hidden: Math.max(0, rows.length - (broad ? 25 : n)) }
}

export function shortIssuer(s: string) {
  return s.split(/\s+/).slice(0, 2).join(' ')
}
