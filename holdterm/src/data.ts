import { DATA, DERIVED } from './config'
import { firmName, issuerName, pmName, FUNDS } from './names'
import ROSTER from './roster.json'
import TICKERS from './tickers.json'
import CORRECTIONS from './corrections.json'
import ETFS from './etfs.json'
import SECTOR_FIX from './sectors.json'

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
export type HistoryRow = { quarter: string; report_date: string; filing_date: string; total_value: number; long_value?: number; equity_value?: number; position_count: number; status: string; sec_url: string }
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

const OVERRIDE = TICKERS as unknown as Record<string, { ticker: string; listed: boolean; name?: string; same_as?: string }>
/** Fills tickers Copybook hasn't mapped from src/tickers.json (each entry cites its SEC source). */
export function fillTicker<T extends { cusip?: string | null; ticker: string | null; former?: string; display_name?: string }>(h: T): T {
  const o = !h.ticker && h.cusip ? OVERRIDE[h.cusip] : undefined
  if (o) {
    if (o.listed) h.ticker = o.ticker
    else h.former = o.ticker
    if (o.name) h.display_name = o.name
  }
  return h
}
/** The issuer key: 6-character CUSIP prefix, or the successor's when a redomiciled line (old Ferguson plc) is mapped onto it. */
// Warrants and ETFs keep their full CUSIP: a warrant is not the stock, and one ETF trust (Invesco's 46137V) issues many funds.
const isWarrant = (h: { title: string }) => /^\*?W\b|\bWTS?\b|WARRANT/i.test(h.title)
const issuerKey = (h: Holding) => (!h.cusip ? h.ticker || h.issuer : isWarrant(h) || isFundLike(h) ? h.cusip : OVERRIDE[h.cusip]?.same_as ?? h.cusip.slice(0, 6))
function name(m: Manager) {
  m.firm = firmName(m.slug, m.name)
  m.pm = pmName(m.slug)
  m.top?.forEach((h) => ((fillTicker(h), (h.sector = sectorOf(h.ticker || h.former, h.sector)))))
  return m
}
/** One sector per issuer: share classes (same 6-character CUSIP prefix) take the sector of the largest classified line. */
const SECTOR_BY_TICKER = SECTOR_FIX as unknown as Record<string, string>
/** Sector override by ticker (src/sectors.json), else the data's own. */
export const sectorOf = (ticker: string | null | undefined, s: string | null | undefined) => (ticker && SECTOR_BY_TICKER[ticker]) || s || null
function normalise(hs: Holding[]) {
  const by = new Map<string, { sector: string; value: number }>()
  for (const h of hs) {
    fillTicker(h)
    // Delisted lines (JHG†) keep their sector through the former ticker.
    const t = h.ticker || h.former
    const fixed = t ? SECTOR_BY_TICKER[t] : undefined
    if (fixed) h.sector = fixed
    if (!h.sector || h.sector === 'Unclassified') continue
    const k = h.cusip.slice(0, 6)
    const cur = by.get(k)
    // An override wins over any other class's sector; otherwise the largest classified line does.
    const value = fixed ? Infinity : h.value
    if (!cur || value > cur.value) by.set(k, { sector: h.sector, value })
  }
  for (const h of hs) {
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
    return { history: d.history.map((r) => (add[r.quarter] && !JSON.stringify(r).includes(c?.history_source?.[r.quarter] ?? '\u0000') ? { ...r, total_value: r.total_value + add[r.quarter], equity_value: r.equity_value == null ? undefined : r.equity_value + add[r.quarter] } : r)) }
  })
export const loadEvents = () => get<{ updated_at: string; window_days: number; events: Event[] }>(DATA + 'events.json').then((d) => (d.events.forEach((e) => (fillTicker(e), (e.sector = sectorOf(e.ticker || e.former, e.sector)))), d))
export const loadFundEvents = (slug: string) => get<{ events: Event[] }>(`${DATA}events/${slug}.json`).catch(() => ({ events: [] as Event[] }))
export const loadInsiders = () => get<{ updated_at: string; rows: Insider[] } | Insider[]>(DATA + 'insiders.json').then((d) => (Array.isArray(d) ? d : d.rows ?? [])).catch(() => null)
/** Tickers Holdterm fills from src/tickers.json, each with every CUSIP of its issuer group (classes, and a
 * redomiciled predecessor via same_as). Copybook has no stock file, or an incomplete one, for these. */
const LOCAL = new Map<string, { cusip: string; ticker: string }[]>()
{
  const groups = new Map<string, { cusip: string; ticker: string }[]>()
  for (const [cusip, o] of Object.entries(OVERRIDE)) {
    if (typeof o !== 'object' || !o.listed) continue
    const k = o.same_as ?? cusip.slice(0, 6)
    groups.set(k, [...(groups.get(k) ?? []), { cusip, ticker: o.ticker }])
  }
  for (const g of groups.values()) for (const c of g) LOCAL.set(c.ticker, g)
}
const changeOf = (shares: number, prev: number | null): Change => (prev == null ? 'new' : shares > prev ? (prev ? 'added' : 'new') : shares < prev ? (shares ? 'trimmed' : 'exited') : 'unchanged')
/** A stock's holders: Copybook's stock file, plus roster lines whose ticker Holdterm resolves from the CUSIP
 * (src/tickers.json), read from the same books /consensus uses, so both pages count the same funds. */
async function loadOneStock(t: string): Promise<StockFile> {
  const group = LOCAL.get(t)
  const file = get<StockFile>(`${DERIVED}stocks/${encodeURIComponent(t)}.json`).catch((e) => {
    if (!group) throw e
    return null
  })
  const up = await file
  // Read every roster book only when Copybook's file is missing or lacks one of the issuer's CUSIPs.
  const books = group && (!up || group.some((c) => !up.classes.some((x) => x.cusip === c.cusip))) ? await loadBooks() : null
  let d = up && { ...up, holders: [...up.holders], exited: [...up.exited], options: [...(up.options ?? [])], classes: [...up.classes] }
  if (group && books) {
    const cus = new Map(group.map((c) => [c.cusip, c.ticker]))
    const has = new Set(d ? [...d.holders, ...d.exited, ...d.options].map((h) => h.slug) : [])
    for (const b of books) {
      if (has.has(b.slug)) continue
      const lines = b.holdings.filter((h) => cus.has(h.cusip))
      if (!lines.length) continue
      if (!d) d = { ticker: t, name: lines[0].display_name || lines[0].issuer, sector: sectorOf(t, lines[0].sector), value: 0, classes: [], holders: [], exited: [], options: [], counts: undefined as unknown as StockFile['counts'], quarters: [] }
      const row = (ls: Holding[]): StockHolder => {
        const shares = ls.reduce((x, h) => x + h.shares, 0)
        const prev = ls.some((h) => h.prev_shares != null) ? ls.reduce((x, h) => x + (h.prev_shares ?? 0), 0) : null
        return { slug: b.slug, manager: b.firm, firm: b.firm, quarter: b.quarter, filing_date: b.filing_date, featured: false, shares, value: ls.reduce((x, h) => x + h.value, 0), weight: ls.reduce((x, h) => x + h.weight, 0), prev_shares: prev, delta_value: ls.reduce((x, h) => x + (h.value_delta ?? 0), 0), change: ls.length === 1 ? ls[0].change : changeOf(shares, prev), put_call: ls[0].put_call ?? undefined }
      }
      const stock = lines.filter((h) => !h.put_call)
      if (stock.length) {
        const r = row(stock)
        ;(r.change === 'exited' ? d.exited : d.holders).push(r)
        if (r.change !== 'exited') d.value += r.value
      }
      for (const pc of ['PUT', 'CALL']) {
        const o = lines.filter((h) => h.put_call?.toUpperCase() === pc)
        if (o.length) d.options.push(row(o))
      }
    }
    if (!d) throw new Error(`404 ${t}`)
    for (const c of group) if (!d.classes.some((x) => x.cusip === c.cusip)) d.classes.push({ ticker: c.ticker, name: d.name, cusip: c.cusip })
  }
  if (!d) throw new Error(`404 ${t}`)
  return { ...d, sector: sectorOf(d.ticker, d.sector) ?? sectorOf(d.classes[0]?.ticker, null) }
}
/** Share classes Copybook files separately (LEN and LEN.B, Z and ZG): candidates share a name or ticker root
 * in the stock index, and merge only when their CUSIP prefix matches. Warrants and ETFs never merge. */
const root = (t: string) => t.replace(/(\.[A-Z]|[A-Z])$/, '') || t
const holderSum = (rows: StockHolder[]): StockHolder => {
  if (rows.length === 1) return rows[0]
  const shares = rows.reduce((x, h) => x + h.shares, 0)
  const prev = rows.some((h) => h.prev_shares != null) ? rows.reduce((x, h) => x + (h.prev_shares ?? 0), 0) : null
  return { ...rows[0], shares, value: rows.reduce((x, h) => x + h.value, 0), weight: rows.reduce((x, h) => x + h.weight, 0), prev_shares: prev, delta_value: rows.reduce((x, h) => x + (h.delta_value ?? 0), 0), change: changeOf(shares, prev) }
}
export async function loadStock(t: string): Promise<StockFile> {
  const d = await loadOneStock(t)
  const own = new Set(d.classes.map((c) => c.ticker))
  const prefix = d.classes[0]?.cusip.slice(0, 6)
  if (ETF_NAMES[t]) return { ...d, name: ETF_NAMES[t] }
  if (!prefix || d.sector === 'Funds & ETFs' || /WW$|\.WS$/.test(t)) return d
  const ix = await loadStockIndex().catch(() => ({ stocks: [] as StockIndexRow[] }))
  const name = ix.stocks.find((r) => r.t === t)?.n
  const cands = ix.stocks.filter((r) => !own.has(r.t) && !/WW$|\.WS$/.test(r.t) && ((name && r.n === name) || root(r.t) === root(t) || r.t === root(t) || root(r.t) === t))
  const sibs = (await Promise.all(cands.map((r) => loadOneStock(r.t).catch(() => null)))).filter((x): x is StockFile => Boolean(x && x.classes.every((c) => c.cusip.slice(0, 6) === prefix)))
  if (!sibs.length) return d
  const files = [d, ...sibs]
  const classValue = (f: StockFile) => f.holders.reduce((x, h) => x + h.value, 0)
  files.sort((a, b) => classValue(b) - classValue(a))
  const by = new Map<string, StockHolder[]>()
  for (const f of files) for (const h of [...f.holders, ...f.exited]) by.set(h.slug, [...(by.get(h.slug) ?? []), h])
  const rows = [...by.values()].map(holderSum)
  const holders = rows.filter((h) => h.shares > 0)
  return { ...d, ticker: files[0].ticker, name: files[0].name, classes: files.flatMap((f) => f.classes), holders, exited: rows.filter((h) => h.shares <= 0), options: files.flatMap((f) => f.options ?? []), value: files.reduce((x, f) => x + f.value, 0) }
}
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
  classes?: Set<string>
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
 * e.g. GOOGL and GOOG) count as one stock, shown under its most-held ticker. Options are excluded.
 * `rank` (default: `books`) decides which class is most held, so a filtered subset keeps the site-wide label. */
export function aggregate(books: Book[], rank: Book[] = books): { rows: Agg[]; total: number } {
  const m = new Map<string, Agg>()
  const classValue = new Map<string, Map<string, number>>()
  for (const b of rank)
    for (const h of b.holdings) {
      if (h.put_call || !h.ticker || !h.cusip) continue
      const key = issuerKey(h)
      const cv = classValue.get(key) ?? new Map<string, number>()
      classValue.set(key, cv.set(h.ticker, (cv.get(h.ticker) ?? 0) + h.value))
    }
  let total = 0
  for (const b of books) {
    for (const h of b.holdings) {
      if (h.put_call) continue
      const key = issuerKey(h)
      let a = m.get(key)
      if (!a) {
        a = { key, fund: isFundLike(h), ticker: h.ticker, former: h.former, name: h.display_name || issuerName(h.issuer), sector: h.sector || 'Unclassified', value: 0, holders: [], buyers: [], sellers: [], newBuyers: 0, net: 0, buy: 0, sell: 0, maxWeight: 0 }
        m.set(key, a)
        a.classes = new Set()
      }
      if (h.ticker) {
        a.classes!.add(h.ticker)
        const cv = classValue.get(key)
        const ranked = [...a.classes!].sort((x, y) => (cv?.get(y) ?? 0) - (cv?.get(x) ?? 0))
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
  'Real Estate': 'RE',
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
