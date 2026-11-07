import { call } from './account'
import { BASE, cleanHolding, getJSON, type Holding } from './data'

// Shape of GET {api}/history/{slug}. Ingest is moving from inline `holdings` per quarter to an index
// with `holdings_url` (relative to data/) plus a `top_holdings` preview; both are read here.
export type HistoryQuarter = {
  quarter: string
  report_date?: string
  filing_date?: string
  sec_url?: string
  position_count?: number
  total_value: number
  holdings?: Holding[]
  holdings_url?: string
  top_holdings?: Holding[]
  truncated?: boolean
}
type HistoryIndex = { slug: string; manager: string; cik: string; history: HistoryQuarter[] }

export type Quarter = Omit<HistoryQuarter, 'holdings'> & { holdings: Holding[]; partial: boolean }

const url = (u: string) => (/^https?:/.test(u) ? u : `${BASE}data/${u.replace(/^\.?\//, '')}`)

/** Every quarter, newest first, each with its full book. */
export async function loadHistory(slug: string) {
  const idx = await call<HistoryIndex>(`/history/${slug}`, { auth: true })
  const quarters = await Promise.all(
    idx.history.map(async (q): Promise<Quarter> => {
      let rows = q.holdings
      let partial = Boolean(q.truncated)
      if (!rows && q.holdings_url) rows = await getJSON<{ holdings: Holding[] }>(url(q.holdings_url)).then((d) => d.holdings, () => undefined)
      if (!rows) {
        rows = q.top_holdings ?? []
        partial = rows.length < (q.position_count ?? 0)
      }
      return { ...q, holdings: rows.filter((h) => h.value > 0).map(cleanHolding), partial }
    }),
  )
  quarters.sort((a, b) => b.quarter.localeCompare(a.quarter))
  return { manager: idx.manager, cik: idx.cik, quarters }
}

export const holdingKey = (h: Holding) => `${h.cusip}|${h.put_call || ''}`

export type Move = { key: string; h: Holding; change: 'new' | 'added' | 'trimmed' | 'exited'; delta: number; shares: number; prevShares: number }

/** Trades between two filings: share changes valued at the newer filing's per-share value. */
export function diff(curr: Quarter, prev: Quarter): Move[] {
  const before = new Map(prev.holdings.map((h) => [holdingKey(h), h]))
  const after = new Map(curr.holdings.map((h) => [holdingKey(h), h]))
  const out: Move[] = []
  for (const [k, h] of after) {
    const p = before.get(k)
    if (!p) {
      // Same rule in reverse: a line missing from a capped older book may just sit below the cap.
      if (prev.partial) continue
      out.push({ key: k, h, change: 'new', delta: h.value, shares: h.shares, prevShares: 0 })
      continue
    }
    const ds = h.shares - p.shares
    if (!ds) continue
    const per = h.shares ? h.value / h.shares : 0
    out.push({ key: k, h, change: ds > 0 ? 'added' : 'trimmed', delta: ds * per, shares: h.shares, prevShares: p.shares })
  }
  // An exit only counts when the older book is complete enough to have the line in it.
  if (!curr.partial) {
    for (const [k, p] of before) {
      if (!after.has(k)) out.push({ key: k, h: p, change: 'exited', delta: -p.value, shares: 0, prevShares: p.shares })
    }
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}
