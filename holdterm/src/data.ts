import { DATA, DERIVED } from './config'
import { firmName, issuerName, pmName, FUNDS } from './names'
import ROSTER from './roster.json'
import TICKERS from './tickers.json'
import CORRECTIONS from './corrections.json'
import ETFS from './etfs.json'

export type Change = 'new' | 'added' | 'trimmed' | 'exited' | 'unchanged' | null
export type Holding = {
  issuer: string
  title: string
  cusip: string
  ticker: string | null
  /** Former ticker of a company no longer listed (src/tickers.json). */
  former?: string
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
  /** Holdterm display: firm first, current PM if any. */
  firm: string
  pm: string | null
}
export type Book = Manager & {
  holdings: Holding[]
  prev_quarter?: string | null
  prev_total_value?: number | null
  changes?: Record<string, number>
  /** Long stock book (no option lines): the book Holdterm shows everywhere. */
  long_value: number
  prev_long_value: number | null
  /** Put and call notional, shown separately and never counted as buying or selling. */
  options_value: number
  long_count: number
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
  cusip?: string | null
  former?: string
  sector?: string | null
  shares: number | null
  value_usd: number | null
  avg_price: number | null
  shares_after: number | null
  percent_of_class: number | null
  change_vs_13f: number | null
}
export type HistoryRow = { quarter: string; report_date: string; filing_date: string; total_value: number; long_value?: number; position_count: number; status: string; sec_url: string }
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

const OVERRIDE = TICKERS as unknown as Record<string, { ticker: string; listed: boolean }>
/** Fills tickers Copybook hasn't mapped from src/tickers.json (each entry cites its SEC source). */
export function fillTicker<T extends { cusip?: string | null; ticker: string | null; former?: string }>(h: T): T {
  const o = !h.ticker && h.cusip ? OVERRIDE[h.cusip] : undefined
  if (o) {
    if (o.listed) h.ticker = o.ticker
    else h.former = o.ticker
  }
  return h
}
function name(m: Manager) {
  m.firm = firmName(m.slug, m.name)
  m.pm = pmName(m.slug)
  m.top?.forEach(fillTicker)
  return m
}
/** One sector per issuer: share classes (same 6-character CUSIP prefix) take the sector of the largest classified line. */
function normalise(hs: Holding[]) {
  const by = new Map<string, { sector: string; value: number }>()
  for (const h of hs) {
    if (!h.sector || h.sector === 'Unclassified') continue
    const k = h.cusip.slice(0, 6)
    const cur = by.get(k)
    if (!cur || h.value > cur.value) by.set(k, { sector: h.sector, value: h.value })
  }
  for (const h of hs) {
    fillTicker(h)
    const s = by.get(h.cusip.slice(0, 6))
    if (s) h.sector = s.sector
    h.display_name = issuerName(h.display_name || h.issuer)
    if (isFundLike(h)) {
      h.sector = 'Funds & ETFs'
      h.display_name = etfName(h)
    }
  }
  return hs
}
let ixP: Promise<Index> | null = null
export const loadIndex = () =>
  (ixP ??= get<Index>(DATA + 'index.json').then((ix) => {
    ix.managers.forEach(name)
    return ix
  }))
type Correction = {
  prev_quarter?: string
  prev_add?: { cusip: string; shares: number; value: number; source: string }[]
  history_add?: Record<string, number>
  history_source?: Record<string, string>
}
const FIX = CORRECTIONS as unknown as Record<string, Correction>
/** Adds lines a second filer reported for the prior quarter (src/corrections.json) and re-derives the changes.
 * Idempotent: a line whose source accession the upstream book already cites is skipped
 * (scripts/check-corrections.mjs also fails the build when that happens). */
function correct(b: Book) {
  const c = FIX[b.slug]
  if (!c?.prev_add || b.prev_quarter !== c.prev_quarter || b.prev_total_value == null) return b
  const upstream = JSON.stringify({ ...b, holdings: undefined })
  const todo = c.prev_add.filter((a) => !upstream.includes(a.source))
  if (!todo.length) return b
  for (const a of todo) {
    const h = b.holdings.find((x) => x.cusip === a.cusip && !x.put_call)
    if (!h) continue
    h.prev_shares = (h.prev_shares ?? 0) + a.shares
    h.prev_value = (h.prev_value ?? 0) + a.value
    h.share_change = h.shares - h.prev_shares
    h.value_delta = h.shares ? h.share_change * (h.value / h.shares) : -h.prev_value
    h.pct_of_book = b.total_value ? h.value_delta / b.total_value : null
    h.change = h.share_change > 0 ? 'added' : h.share_change < 0 ? (h.shares ? 'trimmed' : 'exited') : 'unchanged'
    b.prev_total_value += a.value
  }
  for (const h of b.holdings) h.prev_weight = h.prev_value != null ? h.prev_value / b.prev_total_value : h.prev_weight
  const changes: Record<string, number> = {}
  for (const h of b.holdings) if (h.change) changes[h.change] = (changes[h.change] ?? 0) + 1
  b.changes = changes
  return b
}
/** 13F value includes put and call notional; the book is the long stock lines only. */
function longBook(b: Book) {
  const longs = b.holdings.filter((h) => !h.put_call)
  b.long_value = longs.reduce((t, h) => t + h.value, 0)
  b.long_count = longs.filter((h) => h.value > 0).length
  b.options_value = b.total_value - b.long_value
  b.prev_long_value = b.prev_total_value == null ? null : longs.reduce((t, h) => t + (h.prev_value ?? 0), 0)
  return b
}
const books = new Map<string, Promise<Book>>()
export const loadBook = (slug: string) => {
  let p = books.get(slug)
  if (!p) {
    p = get<Book>(`${DATA}${slug}.json`).then((b) => (normalise(b.holdings), longBook(correct(name(b) as Book))))
    books.set(slug, p)
  }
  return p
}
export const loadHistory = (slug: string) =>
  get<{ history: HistoryRow[] }>(`${DATA}${slug}-history.json`).then((d) => {
    const c = FIX[slug]
    const add = c?.history_add ?? {}
    // Skip a quarter whose upstream row already cites the second filing.
    return { history: d.history.map((r) => (add[r.quarter] && !JSON.stringify(r).includes(c?.history_source?.[r.quarter] ?? '\u0000') ? { ...r, total_value: r.total_value + add[r.quarter] } : r)) }
  })
export const loadEvents = () => get<{ updated_at: string; window_days: number; events: Event[] }>(DATA + 'events.json').then((d) => (d.events.forEach(fillTicker), d))
export const loadFundEvents = (slug: string) => get<{ events: Event[] }>(`${DATA}events/${slug}.json`).catch(() => ({ events: [] as Event[] }))
export const loadInsiders = () => get<{ updated_at: string; rows: Insider[] } | Insider[]>(DATA + 'insiders.json').then((d) => (Array.isArray(d) ? d : d.rows ?? [])).catch(() => null)
export const loadStock = (t: string) => get<StockFile>(`${DERIVED}stocks/${encodeURIComponent(t)}.json`)
export const loadStockIndex = () => get<{ stocks: StockIndexRow[] }>(DERIVED + 'stocks.json')

const qn = (q: string) => (q ? Number(q.slice(0, 4)) * 4 + Number(q.slice(5)) - 1 : -1)

export type RosterFund = { cik: string; slug: string; filer_slug: string; firm: string; value: number; positions: number; top10: number; turnover: number; predecessor: string | null }
type Candidate = Omit<RosterFund, 'slug' | 'filer_slug'> & { slug: string | null; filer_slug: string | null; fails: string[] }
export const roster = ROSTER as unknown as { generated_at: string; period: string; rule: Record<string, number>; screened: number; funds: RosterFund[]; pending: Candidate[]; near_misses: Candidate[] }
export const ROSTER_SLUGS = new Set(roster.funds.flatMap((f) => [f.slug, f.filer_slug]))
export const inRoster = (slug: string) => ROSTER_SLUGS.has(slug)
export const searchNames = (m: Manager) => [m.firm, m.pm, m.name, m.manager, ...(FUNDS[m.slug]?.aka ?? [])].filter(Boolean).join(' | ')
const newestQ = (ms: Manager[]) => Math.max(...ms.map((m) => qn(m.quarter)))
/** Stale: the fund's latest usable 13F is older than the newest quarter any fund has filed, by more than one quarter. */
export const isStale = (m: Manager, all: Manager[]) => qn(m.quarter) < newestQ(all) - 1 || ['stale', 'empty_latest', 'unreadable_latest', 'inactive'].includes(m.status)

/** The Holdterm roster (rule in src/roster.json, reconstituted quarterly), in index order by value. */
export function funds(ix: Index): Manager[] {
  const by = new Map(ix.managers.map((m) => [m.slug, m]))
  return roster.funds.map((f) => by.get(f.slug)).filter((m): m is Manager => Boolean(m && m.ok)).sort((a, b) => b.total_value - a.total_value)
}

/** Every roster fund's latest full book. */
export async function loadBooks(): Promise<Book[]> {
  const ms = funds(await loadIndex())
  const books = await Promise.all(ms.map((m) => loadBook(m.slug).catch(() => null)))
  return books.filter((b): b is Book => Boolean(b))
}

export type Who = { slug: string; manager: string; weight: number; change: Change; delta: number; quarter: string }
export type Agg = {
  key: string
  ticker: string | null
  /** An ETF, index or T-bill fund (isFundLike). */
  fund?: boolean
  /** "GOOGL+GOOG" when several share classes are combined. */
  label?: string
  former?: string
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

/** ETFs, index and T-bill funds: shown in holdings, but kept out of "largest positions" and trade lists. */
export const isFundLike = (h: Pick<Holding, 'sector' | 'issuer' | 'title'>) =>
  h.sector === 'Funds & ETFs' || /\b(ETF|ETFS|EXCHANGE TRADED|ISHARES|SPDR|VANGUARD|INVESCO QQQ|PROSHARES|WISDOMTREE|DIREXION|INDEX|TREASURY|T-BILL|SELECT SECTOR|S&P ?500|TR UNIT)\b/i.test(`${h.issuer} ${h.title}`)
const ETF_NAMES = ETFS as unknown as Record<string, string>
/** A 13F names the sponsor's trust ("ISHARES TR"); show the fund instead (src/etfs.json), else brand + class title. */
function etfName(h: Holding) {
  if (h.ticker && ETF_NAMES[h.ticker]) return ETF_NAMES[h.ticker]
  const brand = issuerName(h.issuer.replace(/\s+(ETF\s+)?(TR|TRUST|FD T|FDS?|EXCH TRADED FD TR.*|EXCHANGE TRADED FD.*|SER(IES)? TR.*|INC)\b.*$/i, '')).replace(/^Ishares\b/, 'iShares')
  const cls = h.title.replace(/\bETF\b/i, '').trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
  return `${brand} ${cls} ETF`.replace(/\s+/g, ' ')
}
/** Rolls the latest books up by company: share classes of one issuer (same 6-character CUSIP prefix,
 * e.g. GOOGL and GOOG) count as one stock, shown under its most-held ticker. Options are excluded. */
export function aggregate(books: Book[]): { rows: Agg[]; total: number } {
  const m = new Map<string, Agg>()
  const classValue = new Map<string, Map<string, number>>()
  let total = 0
  for (const b of books) {
    for (const h of b.holdings) {
      if (h.put_call) continue
      const key = h.cusip ? h.cusip.slice(0, 6) : h.ticker || h.issuer
      let a = m.get(key)
      if (!a) {
        a = { key, fund: isFundLike(h), ticker: h.ticker, former: h.former, name: h.display_name || issuerName(h.issuer), sector: h.sector || 'Unclassified', value: 0, holders: [], buyers: [], sellers: [], newBuyers: 0, net: 0, buy: 0, sell: 0, maxWeight: 0 }
        m.set(key, a)
        classValue.set(key, new Map())
      }
      if (h.ticker) {
        const cv = classValue.get(key)!
        cv.set(h.ticker, (cv.get(h.ticker) ?? 0) + h.value)
        const ranked = [...cv.entries()].sort((x, y) => y[1] - x[1]).map((e) => e[0])
        a.ticker = ranked[0]
        a.label = ranked.join('+')
        if (ranked.length > 1) a.name = a.name.replace(/\s+(class|cl\.?|series|ser)\s+[a-z]\b.*$/i, '')
      }
      const d = h.value_delta ?? 0
      const who: Who = { slug: b.slug, manager: b.firm, weight: h.weight, change: h.change, delta: d, quarter: b.quarter }
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
