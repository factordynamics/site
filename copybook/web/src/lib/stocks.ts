import type { Ev } from '../components/FundNotes'
import { call } from './account'
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
  /** Splits by quarter: adjusted (ingest confirmed and multiplied earlier share counts) or excluded (looks like a split, left out of counts). */
  splits?: Record<string, { ratio: string; adjusted: boolean }>
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
  /** Stocks left out of the rankings because their share changes look like a split. */
  splits?: { ticker: string; name: string; ratio: string }[]
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

export type SeasonRow = Pick<FlowRow, 'ticker' | 'name' | 'net_value' | 'buy_value' | 'sell_value' | 'n_buyers' | 'n_sellers' | 'buyers' | 'sellers'> & { etf?: boolean }
export type SeasonFlow = { funds: number; bought: SeasonRow[]; sold: SeasonRow[]; most_buyers: SeasonRow[] }
export type Expected = {
  slug: string
  manager: string
  /** Filed through another entity (Ackman: Pershing Square). */
  via?: string
  /** usually: 3+ of the last 4 quarters on the same day; most: 2 of 4; none: no repeat. */
  pattern: 'usually' | 'most' | 'none'
  /** Null when there's no fixed day. */
  expected_date: string | null
  /** EDGAR business days before the deadline (0 = deadline day); the last one when there's no pattern. */
  days_before: number
  /** Minutes after midnight, New York time. */
  time_et: number
  /** The last two times, when they spread out. */
  time_range?: [number, number]
  history: { quarter: string; accepted_at: string; days_before: number }[]
  filed?: { filing_date?: string; accession?: string }
}
export type Season = {
  quarter: string
  deadline: string
  curated: { filed: number; total: number }
  featured: { filed: number; total: number }
  filers: { filed: number; total: number }
  by_day: { date: string; count: number }[]
  latest: { slug: string; manager: string; firm: string; filing_date?: string; accession?: string; featured: boolean; total_value?: number; changes: Record<string, number> | null }[]
  splits?: { ticker: string; name: string; ratio: string }[]
  /** Superinvestors' usual filing day and time, from their last four 13Fs. */
  expected?: Expected[]
  /** Superinvestors with no 13F-HR in the last year. */
  not_filing?: { slug: string; manager: string; last: string | null }[]
  featured_flow: SeasonFlow
  all_flow: SeasonFlow
  generated_at: string
}
// Pages serves JSON with max-age=600, so a page could trail a 20-minute build by half an hour. Season-week
// files carry a two-minute bucket instead: every reader gets a copy at most two minutes old.
const fresh = () => `?v=${Math.floor(Date.now() / 120_000)}`
export const loadSeason = () =>
  getJSON<Season>(`${D}season.json${fresh()}`).then((s) => {
    const fix = (f: SeasonFlow): SeasonFlow => {
      const rows = (r: SeasonRow[]) => r.map((x) => ({ ...x, buyers: x.buyers.map(named), sellers: x.sellers.map(named) }))
      return { ...f, bought: rows(f.bought), sold: rows(f.sold), most_buyers: rows(f.most_buyers) }
    }
    return { ...s, latest: s.latest.map((x) => ({ ...named(x), firm: displayName(x.firm) })), featured_flow: fix(s.featured_flow), all_flow: fix(s.all_flow) }
  })

/** The 13F season under way: the deadline of the quarter that ended last, shown from 3 weeks before it to 4 days after. */
export function seasonNow(now = new Date()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const qEnd = new Date(Date.UTC(y, Math.floor(m / 3) * 3, 0))
  const due = new Date(qEnd.getTime() + 45 * 864e5)
  while (due.getUTCDay() === 0 || due.getUTCDay() === 6) due.setUTCDate(due.getUTCDate() + 1)
  const q = Math.floor(qEnd.getUTCMonth() / 3) + 1
  due.setUTCHours(17 + (q <= 2 ? 4 : 5), 30)
  const t = now.getTime()
  const live = t >= due.getTime() - 21 * 864e5 && t <= due.getTime() + 4 * 864e5
  return { quarter: `${qEnd.getUTCFullYear()}Q${q}`, deadline: due, live }
}

export type SplitLog = { ticker: string; name: string; quarter: string; ratio: string; treatment: 'adjusted' | 'excluded'; holders: number; share_ratio: number; price_ratio: number; xbrl_shares_ratio: number | null; source: string }
export const loadSplitLog = () => getJSON<{ splits: SplitLog[] }>(`${D}splits.json`).then((d) => d.splits)

export const loadStockIndex = () => getJSON<{ funds: number; stocks: StockRef[] }>(`${D}stocks.json`)
const named = <T extends { manager: string }>(x: T) => ({ ...x, manager: displayName(x.manager) })
export const loadStock = (t: string) =>
  getJSON<Stock>(`${D}stocks/${encodeURIComponent(t)}.json`).then((s) => ({ ...s, holders: s.holders.map(named), exited: s.exited.map(named), options: s.options.map(named) }))
/** The site's flow.json (top 40 per list), or for members the API's fuller lists, falling back to the site's. */
export const loadFlow = (member = false) =>
  (member ? call<Flow | { flow: Flow }>('/flow', { auth: true }).then((r) => ('flow' in r ? r.flow : r)).catch(() => getJSON<Flow>(`${D}flow.json${fresh()}`)) : getJSON<Flow>(`${D}flow.json${fresh()}`)).then((f) => {
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
  getJSON<{ filers: number; current?: number; tracked?: number; quarters: Record<string, number>; top10?: number; over5?: number; rows: [string, string, string, number, number, number, 0 | 1 | 2][] }>(`${D}h/${encodeURIComponent(t)}.json`).then((d) => ({
    filers: d.filers,
    /** Filers whose latest 13F is for the newest or previous quarter; the rest are on older filings. */
    current: d.current ?? d.filers,
    /** Funds we track closely that the filer index lists for this stock. */
    tracked: d.tracked ?? null,
    quarters: d.quarters,
    top10: d.top10 ?? null,
    over5: d.over5 ?? null,
    rows: d.rows.map(([slug, name, quarter, shares, value, weight, tier]): FilerHolder => ({ slug, name: displayName(name), quarter, shares, value, weight, tier })),
  }))

/** Public filing cards built this deploy (scripts/cards.mjs): slug -> latest card accession. */
/** Every filing card's accession, to link a filing to its card once one is built. */
export const loadCardSet = () =>
  getJSON<{ cards: { accession: string }[] }>(`${D}f/index.json`)
    .then((d) => new Set(d.cards.map((c) => c.accession)))
    .catch(() => new Set<string>())
export const loadCards = () =>
  getJSON<{ cards: { accession: string; slug: string }[] }>(`${D}f/index.json`)
    .then((d) => new Map(d.cards.map((c) => [c.slug, c.accession])))
    .catch(() => new Map<string, string>())
