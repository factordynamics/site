import { ApiError, call } from './account'
import { cleanHolding, DATA, getJSON, type Holding } from './data'

// Public quarter index: data/{slug}-history.json (newest first, 50-row top_holdings preview).
// Full quarters come from the Copy API, GET {api}/holdings/{slug}/{quarter} (Bearer; 401/402 = paywall).
export type HistoryQuarter = {
  quarter: string
  report_date?: string
  filing_date?: string
  sec_url?: string
  position_count?: number
  total_value: number
  top_holdings?: Holding[]
}
type HistoryIndex = { slug: string; manager: string; cik: string; history: HistoryQuarter[] }

export type Quarter = HistoryQuarter & { holdings: Holding[]; partial: boolean }

/** Every quarter, newest first, each with its full book. */
export async function loadHistory(slug: string) {
  const idx = await getJSON<HistoryIndex>(`${DATA}${slug}-history.json`)
  const quarters = await Promise.all(
    idx.history.map(async (q): Promise<Quarter> => {
      let rows: Holding[] | undefined
      try {
        rows = (await call<{ holdings: Holding[] }>(`/holdings/${slug}/${q.quarter}`, { auth: true })).holdings
      } catch (e) {
        // A missing quarter falls back to the public preview; sign-in and plan errors reach the paywall.
        if (!(e instanceof ApiError) || e.status !== 404) throw e
      }
      const partial = !rows && (q.top_holdings?.length ?? 0) < (q.position_count ?? 0)
      return { ...q, holdings: (rows ?? q.top_holdings ?? []).filter((h) => h.value > 0).map(cleanHolding), partial }
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
