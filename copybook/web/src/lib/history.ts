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

// Reissued CUSIPs (ingest's data/cusip_links.json, keyed by the old CUSIP): the old and new count as one position,
// so a fund that kept its Exxon shares across 30231G102 -> 30233Q108 shows no exit and no new position.
const canon = new Map<string, string>()
let linksLoaded: Promise<void> | null = null
const loadLinks = () =>
  (linksLoaded ??= getJSON<{ links: Record<string, { new: string }> }>(`${DATA}cusip_links.json`).then(
    (f) => Object.entries(f.links ?? {}).forEach(([old, l]) => l?.new && canon.set(old, l.new)),
    () => {
      linksLoaded = null // not published yet: try again on the next page
    },
  ))

/** Every quarter, newest first, each with its full book. */
export async function loadHistory(slug: string) {
  const [idx] = await Promise.all([getJSON<HistoryIndex>(`${DATA}${slug}-history.json`), loadLinks()])
  const quarters = await Promise.all(idx.history.map((q) => loadQuarter(slug, q)))
  quarters.sort((a, b) => b.quarter.localeCompare(a.quarter))
  return { manager: idx.manager, cik: idx.cik, quarters }
}

async function loadQuarter(slug: string, q: HistoryQuarter): Promise<Quarter> {
  let rows: Holding[] | undefined
  try {
    rows = (await call<{ holdings: Holding[] }>(`/holdings/${slug}/${q.quarter}`, { auth: true })).holdings
  } catch (e) {
    // A missing quarter falls back to the public preview; sign-in and plan errors reach the paywall.
    if (!(e instanceof ApiError) || e.status !== 404) throw e
  }
  const partial = !rows && (q.top_holdings?.length ?? 0) < (q.position_count ?? 0)
  return { ...q, holdings: (rows ?? q.top_holdings ?? []).filter((h) => h.value > 0).map(cleanHolding), partial }
}

/**
 * One fund's book for an earlier quarter, shaped like its latest file: each holding carries its change
 * against the quarter before, and exits are rows with no shares. Null when that quarter isn't on file.
 */
export async function loadQuarterBook(slug: string, quarter: string) {
  const [idx] = await Promise.all([getJSON<HistoryIndex>(`${DATA}${slug}-history.json`).catch(() => null), loadLinks()])
  const at = idx?.history.find((q) => q.quarter === quarter)
  if (!idx || !at) return null
  const before = idx.history.filter((q) => q.quarter < quarter).sort((a, b) => b.quarter.localeCompare(a.quarter))[0]
  const [cur, prev] = await Promise.all([loadQuarter(slug, at), before ? loadQuarter(slug, before) : null])
  const moves = new Map((prev ? diff(cur, prev) : []).map((m) => [m.key, m]))
  const total = cur.holdings.reduce((s, h) => s + h.value, 0) || 1
  const holdings: Holding[] = [
    ...cur.holdings.map((h) => ({ ...h, weight: h.weight ?? h.value / total, change: moves.get(holdingKey(h))?.change ?? (prev ? ('unchanged' as const) : null) })),
    ...[...moves.values()].filter((m) => m.change === 'exited').map((m) => ({ ...m.h, shares: 0, value: 0, weight: 0, change: 'exited' as const })),
  ]
  return { quarter, prev_quarter: prev?.quarter ?? null, holdings }
}

export const holdingKey = (h: Holding) => `${canon.get(h.cusip) ?? h.cusip}|${h.put_call || ''}`
// A book by position: a filing that reports both an old and a reissued CUSIP adds them together.
const byKey = (hs: Holding[]) => {
  const m = new Map<string, Holding>()
  for (const h of hs) {
    const k = holdingKey(h)
    const x = m.get(k)
    m.set(k, x ? { ...h, shares: x.shares + h.shares, value: x.value + h.value } : h)
  }
  return m
}

export type Move = { key: string; h: Holding; change: 'new' | 'added' | 'trimmed' | 'exited'; delta: number; shares: number; prevShares: number }

/** Trades between two filings: share changes valued at the newer filing's per-share value. */
export function diff(curr: Quarter, prev: Quarter): Move[] {
  const before = byKey(prev.holdings)
  const after = byKey(curr.holdings)
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
