import { ApiError, call } from './account'
import { cleanHolding, DATA, getJSON, live, type Holding } from './data'
import { pairReissues } from './reissuePairs.mjs'

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

/** `served`: rows from the API carry ingest's own change against `prev_quarter`, with sold-out lines in `exited`. */
export type Quarter = HistoryQuarter & { holdings: Holding[]; partial: boolean; served?: boolean; prev_quarter?: string | null; exited?: Holding[] }

// Reissued CUSIPs (ingest's data/cusip_links.json, keyed by the old CUSIP): the old and new count as one position,
// so a fund that kept its Exxon shares across 30231G102 -> 30233Q108 shows no exit and no new position. Only `links`
// merge; `held` pairs stay apart, as filed, and moving between their two CUSIPs isn't a buy or a sale. A link's
// `ratio` (new shares per old; 0.5 for a 1-for-2 reverse split) scales the old CUSIP's shares to the new units.
const canon = new Map<string, string>()
const oldFactor = new Map<string, number>()
const heldCusips = new Set<string>()
let linksLoaded: Promise<void> | null = null
type Link = { new: string; ratio?: number | null }
const loadLinks = () =>
  (linksLoaded ??= getJSON<{ links?: Record<string, Link>; held?: Record<string, Link> }>(`${DATA}cusip_links.json`).then(
    (f) => {
      Object.entries(f.held ?? {}).forEach(([old, l]) => l?.new && heldCusips.add(old).add(l.new))
      Object.entries(f.links ?? {}).forEach(([old, l]) => {
        if (!l?.new || f.held?.[old]) return
        canon.set(old, l.new)
        if (l.ratio && l.ratio !== 1) oldFactor.set(old, l.ratio)
      })
    },
    () => {
      linksLoaded = null // not published yet: try again on the next page
    },
  ))

/** Every quarter, newest first, each with its full book. */
export async function loadHistory(slug: string) {
  const [idx] = await Promise.all([getJSON<HistoryIndex>(live(`${slug}-history.json`)), loadLinks()])
  const quarters = await Promise.all(idx.history.map((q) => loadQuarter(slug, q)))
  quarters.sort((a, b) => b.quarter.localeCompare(a.quarter))
  return { manager: idx.manager, cik: idx.cik, quarters }
}

async function loadQuarter(slug: string, q: HistoryQuarter): Promise<Quarter> {
  let rows: Holding[] | undefined
  let book: { holdings: Holding[]; exited?: Holding[]; prev_quarter?: string | null } | undefined
  try {
    book = await call<{ holdings: Holding[]; exited?: Holding[]; prev_quarter?: string | null }>(`/holdings/${slug}/${q.quarter}`, { auth: true })
    rows = book.holdings
  } catch (e) {
    // A missing quarter falls back to the public preview; sign-in and plan errors reach the paywall.
    if (!(e instanceof ApiError) || e.status !== 404) throw e
  }
  const partial = !rows && (q.top_holdings?.length ?? 0) < (q.position_count ?? 0)
  const served = Boolean(rows?.some((h) => h.change !== undefined))
  const exited = served ? [...(book?.exited ?? []), ...rows!.filter((h) => h.change === 'exited')].map(cleanHolding) : undefined
  return { ...q, holdings: (rows ?? q.top_holdings ?? []).filter((h) => h.value > 0).map(cleanHolding), partial, served, prev_quarter: book?.prev_quarter ?? null, exited }
}

// Ingest's own change on a served row; a stale duplicate or mis-scaled line is no trade.
const trade = (h: Holding) => !h.suspect_duplicate && !h.suspect_units

/**
 * One fund's book for an earlier quarter, shaped like its latest file: each holding carries its change
 * against the quarter before, and exits are rows with no shares. Null when that quarter isn't on file.
 */
export async function loadQuarterBook(slug: string, quarter: string) {
  const [idx] = await Promise.all([getJSON<HistoryIndex>(live(`${slug}-history.json`)).catch(() => null), loadLinks()])
  const at = idx?.history.find((q) => q.quarter === quarter)
  if (!idx || !at) return null
  const before = idx.history.filter((q) => q.quarter < quarter).sort((a, b) => b.quarter.localeCompare(a.quarter))[0]
  const [cur, prev] = await Promise.all([loadQuarter(slug, at), before ? loadQuarter(slug, before) : null])
  const moves = new Map((prev ? diff(cur, prev) : []).map((m) => [m.key, m]))
  const total = cur.holdings.reduce((s, h) => s + h.value, 0) || 1
  const holdings: Holding[] = [
    ...cur.holdings.map((h) => ({
      ...h,
      weight: h.weight ?? h.value / total,
      change: servedBy(cur, prev)
        ? trade(h)
          ? (moves.get(holdingKey(h))?.change ?? (h.change === 'new' || h.change === 'added' || h.change === 'trimmed' ? 'unchanged' : (h.change ?? null)))
          : null
        : (moves.get(holdingKey(h))?.change ?? (prev && !heldCusips.has(h.cusip) ? ('unchanged' as const) : null)),
    })),
    ...[...moves.values()].filter((m) => m.change === 'exited').map((m) => ({ ...m.h, shares: 0, value: 0, weight: 0, change: 'exited' as const })),
  ]
  return { quarter, prev_quarter: prev?.quarter ?? null, holdings }
}

/** One side of a held reissue (HON): shown as filed, never as a buy, sale or exit. */
export const heldReissue = (cusip: string) => heldCusips.has(cusip)
export const holdingKey = (h: Holding) => `${canon.get(h.cusip) ?? h.cusip}|${h.put_call || ''}`
// A book by position: a filing that reports both an old and a reissued CUSIP adds them together.
const byKey = (hs: Holding[]) => {
  const m = new Map<string, Holding>()
  for (const h of hs) {
    const k = holdingKey(h)
    const x = m.get(k)
    const shares = h.shares * (oldFactor.get(h.cusip) ?? 1)
    m.set(k, x ? { ...h, shares: x.shares + shares, value: x.value + h.value } : { ...h, shares })
  }
  return m
}

export type Move = { key: string; h: Holding; change: 'new' | 'added' | 'trimmed' | 'exited'; delta: number; shares: number; prevShares: number }

const servedBy = (curr: Quarter, prev: Quarter | null): boolean => Boolean(prev && curr.served && curr.prev_quarter === prev.quarter)
const MOVE = new Set(['new', 'added', 'trimmed'])

/**
 * Trades between two filings. A served book carries ingest's change on every row (reissues and splits applied,
 * exits in `exited`), so it is read as is; the public top-holdings preview is diffed here instead: share changes
 * valued at the newer filing's per-share value.
 */
export function diff(curr: Quarter, prev: Quarter): Move[] {
  if (servedBy(curr, prev)) {
    const out: Move[] = []
    for (const h of curr.holdings) {
      if (!trade(h) || !h.change || !MOVE.has(h.change)) continue
      const per = h.shares ? h.value / h.shares : 0
      out.push({ key: holdingKey(h), h, change: h.change as Move['change'], delta: h.value_delta ?? (h.change === 'new' ? h.value : (h.shares - (h.prev_shares ?? 0)) * per), shares: h.shares, prevShares: h.prev_shares ?? 0 })
    }
    for (const p of curr.exited ?? []) {
      if (!trade(p)) continue
      const prevShares = (p.prev_shares ?? 0) * (oldFactor.get(p.cusip) ?? 1)
      out.push({ key: holdingKey(p), h: { ...p, shares: p.prev_shares ?? 0, value: p.prev_value ?? 0 }, change: 'exited', delta: p.value_delta ?? -(p.prev_value ?? 0), shares: 0, prevShares })
    }
    // A book written before a reissue link reads the new code as new and the old as exited: one position.
    return pairReissues(out).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  }
  const before = byKey(prev.holdings)
  const after = byKey(curr.holdings)
  const out: Move[] = []
  for (const [k, h] of after) {
    const p = before.get(k)
    if (!p) {
      // Same rule in reverse: a line missing from a capped older book may just sit below the cap.
      if (prev.partial || heldCusips.has(h.cusip)) continue
      out.push({ key: k, h, change: 'new', delta: h.value, shares: h.shares, prevShares: 0 })
      continue
    }
    const ds = h.shares - p.shares
    if (Math.abs(ds) < 0.5) continue // split-adjusted share counts are not always whole
    const per = h.shares ? h.value / h.shares : 0
    out.push({ key: k, h, change: ds > 0 ? 'added' : 'trimmed', delta: ds * per, shares: h.shares, prevShares: p.shares })
  }
  // An exit only counts when the older book is complete enough to have the line in it.
  if (!curr.partial) {
    for (const [k, p] of before) {
      if (!after.has(k) && !heldCusips.has(p.cusip)) out.push({ key: k, h: p, change: 'exited', delta: -p.value, shares: 0, prevShares: p.shares })
    }
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}
