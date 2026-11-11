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
  /** SH (shares) or PRN (principal amount: a note or bond). */
  shares_type?: string
  principal_amount?: number | null
  weight: number
  prev_shares: number | null
  prev_value: number | null
  prev_weight?: number | null
  change: Change
  share_change: number | null
  value_delta: number | null
  suspect_units?: boolean
  pct_of_book: number | null
  /** Share counts break between this filing and the last; the trade is the change in reported value. */
  shares_break?: boolean
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
  /** Notes, bonds and untickered preferreds, shown separately like options. */
  notes_value: number
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
  accepted_at?: string
  amendment_no?: number | null
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
  /** The same investor's previous 13D/G stake in this company and its share count, from the events file (set by loadEvents). */
  prev_percent?: number
  prev_shares?: number | null
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
  prev_value?: number | null
  delta_value?: number | null
  change: Change
  put_call?: string
  /** The share counts don't fit across filings (the book's suspect_units), so no trade is counted. */
  unclear?: boolean
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
/** `onBytes`, when given, hears how many bytes of the (uncompressed) body have arrived so far. */
function get<T>(url: string, onBytes?: (n: number) => void): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined
  if (!p) {
    // A host that never answers would leave the page loading for good: give up after 20 seconds without a
    // response, so the page can say so and offer a retry. (Only the wait for the response is timed, not the
    // download, so a large file on a slow connection still arrives.)
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 20_000)
    p = fetch(url, { signal: ac.signal })
      .catch((e) => Promise.reject(ac.signal.aborted ? new Error(`timeout ${url}`) : e))
      .finally(() => clearTimeout(t))
      .then((r) => (!r.ok ? Promise.reject(new Error(`${r.status} ${url}`)) : onBytes && r.body ? readCounting<T>(r.body, onBytes) : (r.json() as Promise<T>)))
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

async function readCounting<T>(body: ReadableStream<Uint8Array>, onBytes: (n: number) => void): Promise<T> {
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    onBytes((n += value.length))
  }
  const all = new Uint8Array(n)
  let at = 0
  for (const p of parts) all.set(p, (at += p.length) - p.length)
  return JSON.parse(new TextDecoder().decode(all)) as T
}

// \`filers\`: a common-stock line filed under an option CUSIP (90 or 95) with no put or call, by these funds. Copybook's
// stock file leaves it out, so the stock page reads those funds' books for it (loadStock).
const OVERRIDE = TICKERS as unknown as Record<string, { ticker: string; listed: boolean; name?: string; same_as?: string; filers?: string[] }>
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
type KeyLine = { cusip: string; ticker: string | null; issuer: string; title?: string; sector?: string | null }
const isWarrant = (h: KeyLine) => /^\*?W\b|\bWTS?\b|WARRANT/i.test(h.title ?? '')
/** Preferreds, convertibles and notes are not the common stock, though they share its CUSIP prefix. */
const isSenior = (h: KeyLine) => /\b(PFD|PREF|PREFERRED|CONV|CNV|CUM|NOTES?|BONDS?|DEBS?)\b|%/i.test(h.title ?? '')
/** A note, bond or untickered preferred: not stock. Like options it stays out of the book, its trades and the
 * cross-fund views, and has its own section on the fund page. A tickered preferred (Itaú's ADR, ITUB) is the
 * company's listed stock and stays in. */
export const isNoteOrPref = (h: KeyLine & { put_call?: string | null; shares_type?: string }) => !h.put_call && (h.shares_type === 'PRN' || (!h.ticker && isSenior(h)))
/** A stock line: not an option, note or preferred. */
export const isStockLine = (h: KeyLine & { put_call?: string | null; shares_type?: string }) => !h.put_call && !isNoteOrPref(h)
// A ticker seen on two CUSIP prefixes (Exxon's 30231G and 30233Q, an old CUSIP a filer still uses) is one issuer.
const TICKER_KEY = new Map<string, string>()
/** The issuer a line belongs to: 6-character CUSIP prefix, joined across prefixes by ticker. Warrants, ETFs
 * (one trust issues many funds) and preferreds or notes keep their full CUSIP. */
export function issuerKey(h: KeyLine & { put_call?: string | null }) {
  if (!h.cusip) return h.ticker || h.issuer
  // Issue numbers 90 and 95 are option CUSIPs (calls and puts); untickered lines filed under one are not the stock.
  const optionCusip = !h.ticker && /^(90|95)$/.test(h.cusip.slice(6, 8))
  if (optionCusip || isWarrant(h) || isFundLike({ sector: h.sector, issuer: h.issuer, title: h.title ?? '' }) || isSenior(h)) return h.cusip
  const base = OVERRIDE[h.cusip]?.same_as ?? h.cusip.slice(0, 6)
  if (!h.ticker) return base
  const k = TICKER_KEY.get(h.ticker)
  if (!k) TICKER_KEY.set(h.ticker, base)
  return k ?? base
}
function name(m: Manager) {
  m.firm = firmName(m.slug, m.name)
  m.pm = pmName(m.slug)
  m.top?.forEach((h) => ((fillTicker(h), (h.sector = sectorOf(h.ticker || h.former, h.sector, h.cusip)))))
  return m
}
/** One sector per issuer: share classes (same 6-character CUSIP prefix) take the sector of the largest classified line. */
const SECTOR_BY_TICKER = SECTOR_FIX as unknown as Record<string, string>
/** Sector override by ticker (src/sectors.json), else the data's own. */
export const sectorOf = (ticker: string | null | undefined, s: string | null | undefined, cusip?: string | null) => (ticker && SECTOR_BY_TICKER[ticker]) || (cusip && SECTOR_BY_TICKER[cusip]) || s || null
/** True when a line's trade is bigger than its position could allow: share counts that break between
 * filings (an unadjusted split, a misfiled count) make share change × price many times the position. */
export const tradeBreak = (delta: number, value: number, prevValue: number) => Math.abs(delta) > 1.5 * Math.max(value, prevValue)
function normalise(hs: Holding[]) {
  const by = new Map<string, { sector: string; value: number }>()
  for (const h of hs) {
    // Copybook flags a line whose share counts don't fit across filings (suspect_units: Guardcap's BKNG, 646,216 then
    // 1,304 shares). There is no reliable trade, so every page counts none: no trade value, not a buyer or seller,
    // and the row says the shares don't match rather than "No change". Stock pages apply it too (loadStock).
    if (h.suspect_units && !h.put_call) {
      h.value_delta = 0
      h.share_change = null
      h.change = 'unchanged'
    }
    // Such a trade is shown as the change in reported value, which is bounded by the two positions.
    if (h.value_delta != null && !h.put_call && tradeBreak(h.value_delta, h.value, h.prev_value ?? 0)) {
      h.value_delta = h.value - (h.prev_value ?? 0)
      h.share_change = null
      h.shares_break = true
      if (h.value > 0 && (h.prev_value ?? 0) > 0) h.change = h.value_delta >= 0 ? 'added' : 'trimmed'
    }
    fillTicker(h)
    // Delisted lines (JHG†) keep their sector through the former ticker.
    const t = h.ticker || h.former
    const fixed = (t && SECTOR_BY_TICKER[t]) || SECTOR_BY_TICKER[h.cusip]
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
// The data is Copybook's public SEC EDGAR data, read straight from its static hosts (GitHub Pages, CORS open,
// 10-minute cache), so a page view costs no Cloudflare Function calls. Holdterm keeps only its roster, and the
// same data checks as scripts/roster.mjs run on every load: a book whose total disagrees with its 13F cover page,
// or that is mostly notes and bonds, is not shown until the data is fixed.
export const failsData = (b: { total_value?: number | null; cover_total?: number | null; prn_value?: number | null }) => {
  const total = b.total_value ?? 0
  const cover = b.cover_total ?? 0
  return (cover > 0 && (total > 1.5 * cover || total < cover / 1.5)) || (total > 0 && (b.prn_value ?? 0) / total > 0.25)
}
/** When Copybook last wrote the data this page has loaded (the newest of index.json, events.json and books.json),
 * for the footer's "updated 20 minutes ago". Only files a page loads anyway count, so it costs no download. */
export const freshness = { at: 0 }
const seen = (ts: string | undefined) => {
  const t = ts ? Date.parse(ts) : NaN
  if (!(t > freshness.at) || typeof window === 'undefined') return
  freshness.at = t
  window.dispatchEvent(new Event('holdterm:fresh'))
}
let ixP: Promise<Index> | null = null
export const loadIndex = () =>
  (ixP ??= get<Index>(DATA + 'index.json').then((ix) => {
    seen(ix.generated_at)
    ix.managers = ix.managers.filter((m) => inRoster(m.slug) && !failsData(m as never))
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
/** 13F value includes put and call notional and notes; the book is the long stock lines only. */
function longBook(b: Book) {
  const longs = b.holdings.filter(isStockLine)
  b.long_value = longs.reduce((t, h) => t + h.value, 0)
  b.long_count = longs.filter((h) => h.value > 0).length
  b.notes_value = b.holdings.filter(isNoteOrPref).reduce((t, h) => t + h.value, 0)
  b.options_value = b.holdings.filter((h) => h.put_call).reduce((t, h) => t + h.value, 0)
  b.prev_long_value = b.prev_total_value == null ? null : longs.reduce((t, h) => t + (h.prev_value ?? 0), 0)
  // "Of portfolio" is the trade over the 13F's total; Copybook's pct_of_book is the position's weight.
  for (const h of b.holdings) h.pct_of_book = h.value_delta != null && b.total_value ? h.value_delta / b.total_value : null
  return b
}
const bookCache = new Map<string, Promise<Book>>()
/** A raw {slug}.json object through the same checks and corrections, wherever it came from. */
const prepare = (slug: string, raw: Promise<Book>) =>
  raw.then((b) => {
    if (failsData(b as never)) throw new Error(`held: ${slug} fails the data checks`)
    return (normalise(b.holdings), longBook(correct(name(b) as Book)))
  })
export const loadBook = (slug: string) => {
  let p = bookCache.get(slug)
  if (!p) {
    p = prepare(slug, inRoster(slug) ? get<Book>(`${DATA}${slug}.json`) : Promise.reject(new Error(`404 ${slug}`)))
    bookCache.set(slug, p)
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
export const loadEvents = () => get<{ updated_at: string; window_days: number; events: Event[] }>(DATA + 'events.json').then((d) => (seen(d.updated_at), (d.events = d.events.filter((e) => inRoster(e.slug))), d.events.forEach((e) => (fillTicker(e), (e.sector = sectorOf(e.ticker || e.former, e.sector, e.cusip)))), prevStakes(d.events), d))
/** Each 13D/G stake update gets the investor's previous stake in the same company, when the file has it, so a
 * page can say "Cut from 70.8%" instead of "Stake update". */
function prevStakes(events: Event[]) {
  // Oldest first. Two amendments can share a filing day (T. Rowe filed CABA's 5th and 6th on Nov 6), so the SEC's
  // acceptance time, then the amendment number, decides which came first.
  const at = (e: Event) => e.accepted_at || e.filing_date
  const stakes = events
    .filter((e) => e.kind !== 'form4' && e.percent_of_class != null && (e.cusip || e.ticker))
    .sort((a, b) => at(a).localeCompare(at(b)) || (a.amendment_no ?? 0) - (b.amendment_no ?? 0))
  const last = new Map<string, Event>()
  for (const e of stakes) {
    const k = `${e.slug}|${e.cusip || e.ticker}`
    const p = last.get(k)
    if (p && p.percent_of_class !== e.percent_of_class) (e.prev_percent = p.percent_of_class!), (e.prev_shares = p.shares_after)
    last.set(k, e)
  }
}
export const loadFundEvents = (slug: string) => get<{ events: Event[] }>(`${DATA}events/${slug}.json`).catch(() => ({ events: [] as Event[] }))
export const loadInsiders = () => get<{ updated_at: string; rows: Insider[] } | Insider[]>(DATA + 'insiders.json').then((d) => (Array.isArray(d) ? d : d.rows ?? [])).catch(() => null)
/** Tickers Holdterm fills from src/tickers.json, each with every CUSIP of its issuer group (classes, and a
 * redomiciled predecessor via same_as). Copybook has no stock file, or an incomplete one, for these. */
const LOCAL = new Map<string, { cusip: string; ticker: string }[]>()
{
  const groups = new Map<string, { cusip: string; ticker: string }[]>()
  for (const [cusip, o] of Object.entries(OVERRIDE)) {
    if (typeof o !== 'object' || !o.listed || o.filers) continue
    const k = o.same_as ?? cusip.slice(0, 6)
    groups.set(k, [...(groups.get(k) ?? []), { cusip, ticker: o.ticker }])
  }
  for (const g of groups.values()) for (const c of g) LOCAL.set(c.ticker, g)
}
/** A stock-page holder row from a fund's own book lines, as /consensus counts them. */
const bookRow = (b: Book, ls: Holding[]): StockHolder => {
  const shares = ls.reduce((x, h) => x + h.shares, 0)
  const unclear = ls.some((h) => h.suspect_units)
  const prev = unclear || ls.some((h) => h.shares_break) ? null : ls.some((h) => h.prev_shares != null) ? ls.reduce((x, h) => x + (h.prev_shares ?? 0), 0) : null
  const change = unclear ? 'unchanged' : ls.length === 1 ? ls[0].change : changeOf(shares, prev)
  return { slug: b.slug, manager: b.firm, firm: b.firm, quarter: b.quarter, filing_date: b.filing_date, featured: false, shares, value: ls.reduce((x, h) => x + h.value, 0), weight: ls.reduce((x, h) => x + h.weight, 0), prev_shares: prev, delta_value: ls.reduce((x, h) => x + (h.value_delta ?? 0), 0), change, put_call: ls[0].put_call ?? undefined, unclear }
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
      const row = (ls: Holding[]) => bookRow(b, ls)
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
const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b)
  return v.length ? v[Math.floor(v.length / 2)] : NaN
}
export async function loadStock(t: string): Promise<StockFile> {
  const d = await mergeClasses(t)
  const tickers = new Set(d.classes.map((c) => c.ticker))
  // Common stock filed under an option CUSIP (tickers.json \`filers\`): read from those funds' books, as /consensus
  // counts it, until Copybook's stock file includes it.
  const misfiled = Object.entries(OVERRIDE).filter(([, o]) => typeof o === 'object' && o.filers && tickers.has(o.ticker))
  const cus = new Set([...d.classes.map((c) => c.cusip), ...misfiled.map(([c]) => c)])
  let holders = [...d.holders]
  let exited = [...d.exited]
  for (const [c, o] of misfiled)
    for (const slug of o.filers!) {
      const b = await loadBook(slug).catch(() => null)
      const ls = b?.holdings.filter((h) => h.cusip === c && !h.put_call)
      if (!b || !ls?.length) continue
      const row = bookRow(b, ls)
      const same = [...holders, ...exited].find((h) => h.slug === b.slug)
      holders = holders.filter((h) => h !== same)
      exited = exited.filter((h) => h !== same)
      const all = same ? holderSum([same, row]) : row
      ;(all.value > 0 ? holders : exited).push(all)
    }
  // Copybook's per-holder Δ is share change × price, and its stock file doesn't carry the books' suspect_units flag.
  // A row whose price (value ÷ shares), now or last quarter, is more than twice off the median of the same
  // quarter's filers, or whose Δ is bigger than the position allows, is checked against the fund's own book: a
  // suspect line counts no trade (as on every other page), and a broken share count takes the book's bounded figure.
  const price = (v: number | null | undefined, s: number | null | undefined) => (v && s && v > 0 && s > 0 ? v / s : null)
  const byQ = (f: (h: StockHolder) => number | null) => {
    const m = new Map<string, number[]>()
    for (const h of holders) {
      const p = f(h)
      if (p != null) m.set(h.quarter, [...(m.get(h.quarter) ?? []), p])
    }
    return new Map([...m].filter(([, v]) => v.length >= 3).map(([q, v]) => [q, median(v)]))
  }
  const nowMed = byQ((h) => price(h.value, h.shares))
  const prevMed = byQ((h) => price(h.prev_value, h.prev_shares))
  const off = (p: number | null, m: number | undefined) => p != null && m != null && (p > 2 * m || m > 2 * p)
  const check = (h: StockHolder) =>
    off(price(h.value, h.shares), nowMed.get(h.quarter)) || off(price(h.prev_value, h.prev_shares), prevMed.get(h.quarter)) || (h.delta_value != null && Math.abs(h.delta_value) > 1.5 * Math.max(h.value, h.prev_value ?? 0))
  const fixed = await Promise.all(
    holders.map(async (h) => {
      if (!check(h)) return h
      const b = await loadBook(h.slug).catch(() => null)
      const ls = b?.holdings.filter((x) => cus.has(x.cusip) && !x.put_call)
      if (!b || !ls?.length || !ls.some((l) => l.suspect_units || l.shares_break)) return h
      return { ...h, ...bookRow(b, ls), featured: h.featured, manager: h.manager, firm: h.firm }
    }),
  )
  return { ...d, holders: fixed, exited }
}
async function mergeClasses(t: string): Promise<StockFile> {
  // The index of every stock is fetched alongside the stock's own file rather than after it: most stock pages
  // need it to find the company's other share classes, and it is the larger download.
  if (!ETF_NAMES[t]) loadStockIndex().catch(() => {})
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
export const roster = ROSTER as unknown as { generated_at: string; period: string; rule: Record<string, number>; screened: number; funds: RosterFund[]; pending: Candidate[]; held: (Candidate & { fails: string[] })[]; near_misses: Candidate[] }
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
/** How many of the investors' 13F books have arrived, for pages that need all of them (see BooksProgress). */
export const booksProgress = { done: 0, total: 0, bytes: 0 }
/** Every roster fund's {slug}.json in one file (Copybook ingest's data/books.json, written last in each data run).
 * Used only when it is at least as new as index.json; otherwise, or when it's missing, null and the per-fund
 * files load instead. */
let combinedP: Promise<Record<string, Book> | null> | null = null
// Fetched alongside index.json, not after it (both are preloaded by index.html on the pages that need them).
const loadCombined = () =>
  (combinedP ??= Promise.all([
    get<{ generated_at: string; books: Record<string, Book> }>(DATA + 'books.json', (n) => {
      // At most every 100 KB, for the loading page's "2.4 MB received".
      if (n - booksProgress.bytes < 1e5 || typeof window === 'undefined') return
      booksProgress.bytes = n
      window.dispatchEvent(new Event('holdterm:books'))
    }),
    loadIndex(),
  ])
    .then(([c, ix]) => (seen(c.generated_at), c.generated_at >= ix.generated_at && c.books ? c.books : null))
    .catch(() => null))
/** loadBooks for a page that already shows something from the index: the books start once it has arrived. */
export const loadBooksAfterIndex = () => loadIndex().then(loadBooks)
export async function loadBooks(): Promise<Book[]> {
  const pending = loadCombined()
  const ms = funds(await loadIndex())
  const combined = await pending
  if (combined) for (const m of ms) if (combined[m.slug] && !bookCache.has(m.slug)) bookCache.set(m.slug, prepare(m.slug, Promise.resolve(combined[m.slug])))
  let done = 0
  const tick = () => {
    booksProgress.done = ++done
    booksProgress.total = ms.length
    window.dispatchEvent(new Event('holdterm:books'))
  }
  const books = await Promise.all(ms.map((m) => loadBook(m.slug).catch(() => null).finally(tick)))
  return books.filter((b): b is Book => Boolean(b))
}

export type Who = { slug: string; manager: string; weight: number; value: number; change: Change; delta: number; quarter: string }
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
  // An issuer that is already an ETF keeps its own name: "Jensen Quality Growth ETF", not "… ETF Jensen Quality ETF".
  return `${brand} ${cls} ETF`.replace(/\s+/g, ' ').replace(/^(.+?\bETF)\s+.+\bETF$/, '$1')
}
/** Rolls the latest books up by company: share classes of one issuer (same 6-character CUSIP prefix,
 * e.g. GOOGL and GOOG) count as one stock, shown under its most-held ticker. Options are excluded.
 * `rank` (default: `books`) decides which class is most held, so a filtered subset keeps the site-wide label. */
export function aggregate(books: Book[], rank: Book[] = books): { rows: Agg[]; total: number } {
  const m = new Map<string, Agg>()
  const classValue = new Map<string, Map<string, number>>()
  for (const b of rank)
    for (const h of b.holdings) {
      if (!isStockLine(h) || !h.ticker || !h.cusip) continue
      const key = issuerKey(h)
      const cv = classValue.get(key) ?? new Map<string, number>()
      classValue.set(key, cv.set(h.ticker, (cv.get(h.ticker) ?? 0) + h.value))
    }
  let total = 0
  for (const b of books) {
    // One position per fund and issuer: classes, managers and a CUSIP change (old line exited, new line
    // "new") net into a single holding, so a fund is never both a buyer and a seller of one stock.
    const pos = new Map<string, Holding[]>()
    for (const h of b.holdings) if (isStockLine(h)) pos.set(issuerKey(h), [...(pos.get(issuerKey(h)) ?? []), h])
    for (const [key, ls] of pos) {
      const h = [...ls].sort((x, y) => y.value - x.value)[0]
      let a = m.get(key)
      if (!a) {
        a = { key, fund: isFundLike(h), ticker: h.ticker, former: h.former, name: h.display_name || issuerName(h.issuer), sector: h.sector || 'Unclassified', value: 0, holders: [], buyers: [], sellers: [], newBuyers: 0, net: 0, buy: 0, sell: 0, maxWeight: 0 }
        m.set(key, a)
        a.classes = new Set()
      }
      for (const l of ls) if (l.ticker) a.classes!.add(l.ticker)
      if (a.classes!.size) {
        const cv = classValue.get(key)
        const ranked = [...a.classes!].sort((x, y) => (cv?.get(y) ?? 0) - (cv?.get(x) ?? 0))
        a.ticker = ranked[0]
        a.label = ranked.join('+')
        if (ranked.length > 1) a.name = a.name.replace(/\s+(class|cl\.?|series|ser)\s+[a-z]\b.*$/i, '')
      }
      if (a.sector === 'Unclassified' && h.sector) a.sector = h.sector
      const value = ls.reduce((x, l) => x + l.value, 0)
      const weight = ls.reduce((x, l) => x + l.weight, 0)
      const d = ls.reduce((x, l) => x + (l.value_delta ?? 0), 0)
      const change: Change = value <= 0 ? 'exited' : ls.every((l) => l.change === 'new') ? 'new' : d > 0 ? 'added' : d < 0 ? 'trimmed' : 'unchanged'
      const who: Who = { slug: b.slug, manager: b.firm, weight, value, change, delta: d, quarter: b.quarter }
      if (value > 0) {
        a.value += value
        total += value
        a.holders.push(who)
        a.maxWeight = Math.max(a.maxWeight, weight)
      }
      if (d > 0) {
        a.buy += d
        a.buyers.push(who)
        if (change === 'new') a.newBuyers++
      } else if (d < 0) {
        a.sell += d
        a.sellers.push(who)
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
// Short sector names for table cells.
export const SECTOR_SHORT: Record<string, string> = {
  'Information Technology': 'Tech',
  Financials: 'Financials',
  'Communication Services': 'Comm. services',
  'Consumer Discretionary': 'Cons. discretionary',
  'Health Care': 'Health care',
  Industrials: 'Industrials',
  Energy: 'Energy',
  'Consumer Staples': 'Cons. staples',
  Materials: 'Materials',
  'Real Estate': 'Real estate',
  Utilities: 'Utilities',
  'Funds & ETFs': 'Funds & ETFs',
  Unclassified: 'Other',
}
// A categorical palette that reads on light and dark surfaces.
export const SECTOR_COLOR: Record<string, string> = {
  'Information Technology': '#4e79a7',
  Financials: '#f28e2b',
  'Communication Services': '#b07aa1',
  'Consumer Discretionary': '#e15759',
  'Health Care': '#59a14f',
  Industrials: '#76b7b2',
  Energy: '#9c755f',
  'Consumer Staples': '#edc948',
  Materials: '#ff9da7',
  'Real Estate': '#5778c9',
  Utilities: '#499894',
  'Funds & ETFs': '#d4a6c8',
  Unclassified: '#bab0ac',
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
