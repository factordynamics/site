import { DATA, DERIVED } from './config'

export type Change = 'new' | 'added' | 'trimmed' | 'exited' | 'unchanged' | null
export type Holding = {
  issuer: string
  title: string
  cusip: string
  ticker: string | null
  display_name?: string
  sector?: string | null
  value: number
  shares: number
  put_call: string | null
  weight: number
  prev_shares: number | null
  prev_value: number | null
  prev_weight?: number | null
  change: Change
  share_change: number | null
  value_delta: number | null
  pct_of_book: number | null
}
export type Manager = {
  slug: string
  cik: string
  name: string
  manager: string
  featured: boolean
  ok: boolean
  quarter: string
  report_date: string
  filing_date: string
  accession: string
  sec_url: string
  position_count: number
  total_value: number
  status: string
  top: Holding[]
}
export type Book = Manager & {
  holdings: Holding[]
  prev_quarter?: string | null
  prev_total_value?: number | null
  changes?: Record<string, number>
}
export type Index = { generated_at: string; managers: Manager[] }
export type Event = {
  id: string
  slug: string
  manager: string
  form: string
  kind: 'form4' | '13d' | '13g'
  action: string
  filing_date: string
  event_date: string | null
  url: string
  issuer: string
  display_name?: string
  ticker: string | null
  sector?: string | null
  shares: number | null
  value_usd: number | null
  avg_price: number | null
  shares_after: number | null
  percent_of_class: number | null
  change_vs_13f: number | null
}
export type HistoryRow = { quarter: string; report_date: string; filing_date: string; total_value: number; position_count: number; status: string; sec_url: string }
export type StockHolder = {
  slug: string
  manager: string
  firm: string
  quarter: string
  filing_date: string
  featured: boolean
  shares: number
  value: number
  weight: number
  prev_shares?: number | null
  delta_value?: number | null
  change: Change
  put_call?: string
}
export type StockFile = {
  ticker: string
  name: string
  sector: string | null
  value: number
  classes: { ticker: string; name: string; cusip: string }[]
  holders: StockHolder[]
  exited: StockHolder[]
  options: StockHolder[]
  counts: { holders: number; prev_holders: number; new: number; added: number; trimmed: number; exited: number }
  quarters: string[]
}
export type StockIndexRow = { t: string; n: string; s: string | null; h: number; dh: number; v: number; a: string[] }
export type Insider = {
  accession: string
  filing_date: string
  trade_date: string
  issuer: string
  ticker: string | null
  owner: string
  relationship: string
  code: 'P' | 'S'
  shares: number
  price: number
  value_usd: number
  shares_after: number | null
  url: string
}

const cache = new Map<string, Promise<unknown>>()
function get<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined
  if (!p) {
    p = fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`${r.status} ${url}`))))
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

export const loadIndex = () => get<Index>(DATA + 'index.json')
export const loadBook = (slug: string) => get<Book>(`${DATA}${slug}.json`)
export const loadHistory = (slug: string) => get<{ history: HistoryRow[] }>(`${DATA}${slug}-history.json`)
export const loadEvents = () => get<{ updated_at: string; window_days: number; events: Event[] }>(DATA + 'events.json')
export const loadFundEvents = (slug: string) => get<{ events: Event[] }>(`${DATA}events/${slug}.json`).catch(() => ({ events: [] as Event[] }))
export const loadInsiders = () => get<{ updated_at: string; rows: Insider[] } | Insider[]>(DATA + 'insiders.json').then((d) => (Array.isArray(d) ? d : d.rows ?? [])).catch(() => null)
export const loadStock = (t: string) => get<StockFile>(`${DERIVED}stocks/${encodeURIComponent(t)}.json`)
export const loadStockIndex = () => get<{ stocks: StockIndexRow[] }>(DERIVED + 'stocks.json')

const qn = (q: string) => (q ? Number(q.slice(0, 4)) * 4 + Number(q.slice(5)) - 1 : -1)

/** Featured investors with a usable, reasonably current filing: the "superinvestor" universe. */
export function superinvestors(ix: Index): Manager[] {
  const live = ix.managers.filter((m) => m.ok && m.total_value > 0 && !['inactive', 'reported_by_other'].includes(m.status))
  const newest = Math.max(...live.map((m) => qn(m.quarter)))
  return live.filter((m) => m.featured && qn(m.quarter) >= newest - 2)
}

/** Every superinvestor's latest full book (about 380 KB gzipped for ~40 funds). */
export async function loadBooks(): Promise<Book[]> {
  const ms = superinvestors(await loadIndex())
  const books = await Promise.all(ms.map((m) => loadBook(m.slug).catch(() => null)))
  return books.filter((b): b is Book => Boolean(b))
}

export type Who = { slug: string; manager: string; weight: number; change: Change; delta: number; quarter: string }
export type Agg = {
  key: string
  ticker: string | null
  name: string
  sector: string
  value: number
  holders: Who[]
  buyers: Who[]
  sellers: Who[]
  newBuyers: number
  net: number
  buy: number
  sell: number
  maxWeight: number
}

/** Rolls the latest books up by stock: common stock and ADRs only (options excluded). */
export function aggregate(books: Book[]): { rows: Agg[]; total: number } {
  const m = new Map<string, Agg>()
  let total = 0
  for (const b of books) {
    for (const h of b.holdings) {
      if (h.put_call) continue
      const key = h.ticker || h.cusip
      let a = m.get(key)
      if (!a) {
        a = { key, ticker: h.ticker, name: h.display_name || h.issuer, sector: h.sector || 'Unclassified', value: 0, holders: [], buyers: [], sellers: [], newBuyers: 0, net: 0, buy: 0, sell: 0, maxWeight: 0 }
        m.set(key, a)
      }
      const d = h.value_delta ?? 0
      const who: Who = { slug: b.slug, manager: b.manager, weight: h.weight, change: h.change, delta: d, quarter: b.quarter }
      if (h.value > 0) {
        a.value += h.value
        total += h.value
        // A fund can list a stock on several lines (classes, managers); count it once.
        const prev = a.holders.find((x) => x.slug === b.slug)
        if (prev) prev.weight += h.weight
        else a.holders.push(who)
        a.maxWeight = Math.max(a.maxWeight, prev ? prev.weight : h.weight)
      }
      if (d > 0) {
        a.buy += d
        if (!a.buyers.some((x) => x.slug === b.slug)) a.buyers.push(who)
        if (h.change === 'new') a.newBuyers++
      } else if (d < 0) {
        a.sell += d
        if (!a.sellers.some((x) => x.slug === b.slug)) a.sellers.push(who)
      }
      a.net += d
    }
  }
  return { rows: [...m.values()], total }
}

export const SECTORS = [
  'Information Technology',
  'Financials',
  'Communication Services',
  'Consumer Discretionary',
  'Health Care',
  'Industrials',
  'Energy',
  'Consumer Staples',
  'Materials',
  'Real Estate',
  'Utilities',
  'Funds & ETFs',
  'Unclassified',
]
export const SECTOR_SHORT: Record<string, string> = {
  'Information Technology': 'TECH',
  Financials: 'FIN',
  'Communication Services': 'COMM',
  'Consumer Discretionary': 'DISC',
  'Health Care': 'HLTH',
  Industrials: 'INDU',
  Energy: 'ENGY',
  'Consumer Staples': 'STPL',
  Materials: 'MATR',
  'Real Estate': 'REIT',
  Utilities: 'UTIL',
  'Funds & ETFs': 'ETF',
  Unclassified: 'OTHR',
}
export const SECTOR_COLOR: Record<string, string> = {
  'Information Technology': '#ffb224',
  Financials: '#4cc9f0',
  'Communication Services': '#b388ff',
  'Consumer Discretionary': '#ff6b6b',
  'Health Care': '#3fd68b',
  Industrials: '#9aa5b1',
  Energy: '#ff8f3f',
  'Consumer Staples': '#f2e94e',
  Materials: '#c08552',
  'Real Estate': '#5c7cfa',
  Utilities: '#63e6be',
  'Funds & ETFs': '#e599f7',
  Unclassified: '#555',
}

export function sectorMix(items: { sector?: string | null; value: number }[]) {
  const by = new Map<string, number>()
  let t = 0
  for (const i of items) {
    if (i.value <= 0) continue
    const s = i.sector || 'Unclassified'
    by.set(s, (by.get(s) ?? 0) + i.value)
    t += i.value
  }
  return [...by.entries()].map(([sector, value]) => ({ sector, value, weight: t ? value / t : 0 })).sort((a, b) => b.value - a.value)
}

export const quarterLabel = (q: string) => (q ? `${q.slice(4)} ${q.slice(0, 4)}` : '')
