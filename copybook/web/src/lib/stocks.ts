import type { Ev } from '../components/FundNotes'
import { BASE, displayName, getJSON, type Change } from './data'

// Derived at build time by scripts/stocks.mjs from the curated 13F books, served from the site host.
const D = `${BASE}d/`

export type StockHolder = {
  slug: string
  manager: string
  firm: string
  quarter: string
  filing_date?: string
  featured: boolean
  /** Position's rank in the fund's share book, 1 = largest (null for exits). */
  rank?: number | null
  shares: number
  value: number
  weight: number
  prev_shares: number
  prev_value: number
  delta_value: number
  change: Change | null
}
export type StockOption = { slug: string; manager: string; firm: string; quarter: string; featured: boolean; put_call: string; ticker: string | null; shares: number; value: number; weight: number }
export type Stock = {
  ticker: string
  name: string
  sector: string | null
  classes: { ticker: string; name: string; cusip: string }[]
  value: number
  holders: StockHolder[]
  exited: StockHolder[]
  options: StockOption[]
  counts: { holders: number; prev_holders: number; new: number; added: number; trimmed: number; exited: number }
  quarters: string[]
  generated_at: string
  /** Form 4 and 13D/G filings since each fund's latest 13F (scripts/stocks.mjs). */
  since?: (Ev & { slug: string; manager: string; quarter?: string })[]
}
/** t ticker, n name, s sector, h holders, dh holder change, v combined value, a other share-class tickers. */
export type StockRef = { t: string; n: string; s: string | null; h: number; dh: number; v: number; a: string[] }

export type FlowMove = { slug: string; manager: string; featured: boolean; change: Change; delta_value: number; weight: number }
export type FlowRow = {
  ticker: string
  name: string
  sector: string | null
  fresh: boolean
  net_value: number
  buy_value: number
  sell_value: number
  buyers: FlowMove[]
  sellers: FlowMove[]
  new_by: string[]
  n_buyers?: number
  n_sellers?: number
}
export type FlowScope = { funds: number; bought: FlowRow[]; sold: FlowRow[]; most_buyers: FlowRow[]; most_sellers: FlowRow[]; new_multi: FlowRow[]; fresh: FlowRow[] }
export type FlowPeriod = {
  quarter: string
  funds_filed: number
  funds_total: number
  featured_filed: number
  featured_total: number
  moved_on?: number
  featured_moved_on?: number
  recent: Flow['recent']
  featured: FlowScope
  all: FlowScope
}
export type Flow = {
  periods?: FlowPeriod[]
  quarter: string
  funds_filed: number
  funds_total: number
  featured_filed: number
  featured_total: number
  recent: { slug: string; manager: string; firm: string; filing_date?: string; accession?: string; featured: boolean; changes: Record<string, number> | null }[]
  featured: FlowScope
  all: FlowScope
  generated_at: string
}

export const loadStockIndex = () => getJSON<{ funds: number; stocks: StockRef[] }>(`${D}stocks.json`)
const named = <T extends { manager: string }>(x: T) => ({ ...x, manager: displayName(x.manager) })
export const loadStock = (t: string) =>
  getJSON<Stock>(`${D}stocks/${encodeURIComponent(t)}.json`).then((s) => ({ ...s, holders: s.holders.map(named), exited: s.exited.map(named), options: s.options.map(named) }))
export const loadFlow = () =>
  getJSON<Flow>(`${D}flow.json`).then((f) => {
    const scope = (s: FlowScope): FlowScope => {
      const fix = (rows: FlowRow[]) => rows.map((r) => ({ ...r, buyers: r.buyers.map(named), sellers: r.sellers.map(named) }))
      return { ...s, bought: fix(s.bought), sold: fix(s.sold), most_buyers: fix(s.most_buyers), most_sellers: fix(s.most_sellers), new_multi: fix(s.new_multi), fresh: fix(s.fresh) }
    }
    const fix = <P extends FlowPeriod>(p: P): P => ({ ...p, recent: p.recent.map(named), featured: scope(p.featured), all: scope(p.all) })
    return { ...fix(f as FlowPeriod & Flow), periods: (f.periods ?? [f as FlowPeriod]).map(fix) }
  })

/** The page ticker for any share-class ticker (GOOG -> GOOGL). */
/** "$tsla" -> "TSLA", "BRK-B" -> "BRK.B": how people type tickers, to how 13F data spells them. */
export const tickerText = (s: string) =>
  s
    .trim()
    .replace(/^\$/, '')
    .toUpperCase()
    .replace(/^([A-Z]{1,5})[-/]([A-Z])$/, '$1.$2')

export async function resolveTicker(t: string) {
  const up = tickerText(t)
  const idx = await loadStockIndex()
  return idx.stocks.find((s) => s.t === up || s.a.includes(up))?.t ?? null
}

export const stockPath = (t: string) => `/stocks/${encodeURIComponent(t)}/`

/** Coverage for copy: filers with a parsed latest 13F, and the managers we track closely. */
export const loadCoverage = () => getJSON<{ filers: number; curated: number }>(`${D}coverage.json`).catch(() => ({ filers: 8900, curated: 199 }))
/** 8,964 -> "8,900+": never overstate coverage. */
export const aboutCount = (n: number) => (n >= 1000 ? `${(Math.floor(n / 100) * 100).toLocaleString('en-US')}+` : n.toLocaleString('en-US'))

/** Every 13F filer's latest position in a stock (scripts/stocks.mjs, d/h/{TICKER}.json): the 200 largest, plus counts. */
export type FilerHolder = { slug: string; name: string; quarter: string; shares: number; value: number; weight: number; tier: 0 | 1 | 2 }
export const loadFilerHolders = (t: string) =>
  getJSON<{ filers: number; quarters: Record<string, number>; rows: [string, string, string, number, number, number, 0 | 1 | 2][] }>(`${D}h/${encodeURIComponent(t)}.json`).then((d) => ({
    filers: d.filers,
    quarters: d.quarters,
    rows: d.rows.map(([slug, name, quarter, shares, value, weight, tier]): FilerHolder => ({ slug, name: displayName(name), quarter, shares, value, weight, tier })),
  }))

/** Public filing cards built this deploy (scripts/cards.mjs): slug -> latest card accession. */
export const loadCards = () =>
  getJSON<{ cards: { accession: string; slug: string }[] }>(`${D}f/index.json`)
    .then((d) => new Map(d.cards.map((c) => [c.slug, c.accession])))
    .catch(() => new Map<string, string>())
