import type { Ev } from '../components/FundNotes'
import { call } from './account'
import { BASE, displayName, flagNote, flagOf, getJSON, unreliable, type Change, type Flag } from './data'

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
  /** A line ingest flags (loadStock): which figures can't be trusted, and the line shown for it. It has no dollar
   *  move and counts toward no dollar total; NEW and EXITED keep their labels. */
  flag?: Flag
  note?: string | null
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
  // All-filer and hedge-fund holder counts for the tab title (scripts/stocks.mjs).
  title_counts?: { filers: number; hedge: number; quarter?: string | null }
  quarters: string[]
  /** Splits by quarter: adjusted (ingest confirmed and multiplied earlier share counts) or excluded (looks like a split, left out of counts). */
  splits?: Record<string, { ratio: string; adjusted: boolean }>
  generated_at: string
  /** Form 4 and 13D/G filings since each fund's latest 13F (scripts/stocks.mjs). */
  since?: (Ev & { slug: string; manager: string; quarter?: string })[]
  /** Exited rows with an unreliable share count, kept out of the exited list and its count (loadStock). */
  not_counted?: StockHolder[]
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
  /** The latest 13F had an empty (placeholder) table: which quarter, and the full book shown instead. */
  placeholder?: { quarter: string; showing: string }
}
/** d/expected.json: superinvestors still to file this quarter (scripts/stocks.mjs). */
export type ExpectedSoon = Pick<Expected, 'slug' | 'manager' | 'pattern' | 'expected_date' | 'time_et' | 'time_range'> & { total_value: number }
export const loadExpected = () => getJSON<{ quarter: string; generated_at?: string; latest_13f?: { manager: string; filing_date?: string; accepted_at?: string | null } | null; expected: ExpectedSoon[] }>(`${D}expected.json${fresh()}`).catch(() => null)
const hr = (m: number) => ({ h: ((Math.floor(m / 60) + 11) % 12) + 1, pm: m >= 720 })
/** "Thu Nov 12" for an ISO date. */
export const shortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '')
/** "usually 10–11 am ET" from the last filings' times (New York minutes after midnight). */
export function usualTime(x: Pick<Expected, 'pattern' | 'time_et' | 'time_range'>) {
  const [a, b] = x.time_range ?? [x.time_et, x.time_et]
  const s = hr(a)
  const e = hr(b)
  const word = x.pattern === 'usually' ? 'usually' : 'often'
  if (s.h === e.h && s.pm === e.pm) return `${word} around ${s.h} ${s.pm ? 'pm' : 'am'} ET`
  return `${word} ${s.h}${s.pm === e.pm ? '' : s.pm ? ' pm' : ' am'}–${e.h} ${e.pm ? 'pm' : 'am'} ET`
}
/** The next two filing days' largest superinvestors, up to four a day (books within a few percent of each other are effectively tied). */
export function nextUp(list: ExpectedSoon[], today: string, perDay = 4) {
  const days = [...new Set(list.filter((x) => x.expected_date! >= today).map((x) => x.expected_date!))].sort().slice(0, 2)
  const groups = days.map((d) => ({
    d,
    people: list
      .filter((x) => x.expected_date === d)
      .sort((a, b) => b.total_value - a.total_value)
      .slice(0, perDay),
  }))
  const text = groups
    .map(({ d, people }) => {
      const names = people.map((x) => x.manager)
      return `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} ${shortDay(d).split(' ')[0]}`
    })
    .join(', ')
  return { text, people: groups.flatMap((g) => g.people.map((x) => ({ slug: x.slug, name: x.manager }))) }
}

export type Season = {
  quarter: string
  deadline: string
  curated: { filed: number; total: number }
  /** `stopped`: featured superinvestors no longer filing (index.json inactive), left out of `total`. */
  featured: { filed: number; total: number; stopped?: { slug: string; manager: string; note: string | null }[] }
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
// Pages serves JSON with max-age=600 and its CDN ignores the query string, so the CDN copy can trail a build by
// up to 10 minutes. Season-week files carry a two-minute bucket so the browser doesn't add its own 10 on top.
// A re-read (the 2-minute poll or returning to the tab) passes its own stamp, so it never hits the bucket it already has.
const fresh = (v?: number) => `?v=${v ?? Math.floor(Date.now() / 120_000)}`
export const loadSeason = (v?: number) =>
  getJSON<Season>(`${D}season.json${fresh(v)}`).then((s) => {
    const fix = (f: SeasonFlow): SeasonFlow => {
      const rows = (r: SeasonRow[]) => r.map((x) => ({ ...x, buyers: x.buyers.map(named), sellers: x.sellers.map(named) }))
      return { ...f, bought: rows(f.bought), sold: rows(f.sold), most_buyers: rows(f.most_buyers) }
    }
    return { ...s, latest: s.latest.map((x) => ({ ...named(x), firm: displayName(x.firm) })), featured_flow: fix(s.featured_flow), all_flow: fix(s.all_flow) }
  })

export type PctRow = { ticker: string; name: string; pct: number; n_buyers: number; n_sellers: number; buyers: { slug: string; manager: string; pct: number }[]; sellers: { slug: string; manager: string; pct: number }[] }
export type RecapMove = { ticker: string; name: string; etf?: boolean; slug: string; manager: string; change: 'new' | 'added' | 'trimmed' | 'exited'; delta_value: number; weight: number | null }
export type Recap = {
  quarter: string
  deadline: string
  final: boolean
  superinvestors: { filed: number; total: number }
  bought_usd: number
  sold_usd: number
  opened_count: number
  exited_count: number
  most_bought: SeasonRow[]
  most_sold: SeasonRow[]
  most_buyers: SeasonRow[]
  /** Each superinvestor's trade as a share of its 13F book, summed per stock. */
  most_bought_pct?: PctRow[]
  most_sold_pct?: PctRow[]
  opened: RecapMove[]
  exited: RecapMove[]
  biggest: RecapMove[]
  filing: { slug: string; manager: string; via?: string; placeholder?: { quarter: string; showing: string }; filed: boolean; filing_date: string | null; accepted_at: string | null; accession: string | null; late: boolean; expected_date: string | null }[]
  not_filing: { slug: string; manager: string; last: string | null }[]
  splits: { ticker: string; name: string; ratio: string }[]
  generated_at: string
}
/** A season recap (d/recap/{2026Q3}.json), rebuilt every build so late filers flow in. */
export const loadRecap = (q: string, v?: number) =>
  getJSON<Recap>(`${D}recap/${q}.json${fresh(v)}`).then((r) => {
    const rows = (x: SeasonRow[]) => x.map((f) => ({ ...f, buyers: f.buyers.map(named), sellers: f.sellers.map(named) }))
    return { ...r, most_bought: rows(r.most_bought), most_sold: rows(r.most_sold), most_buyers: rows(r.most_buyers) }
  })
/** "2026Q3" -> "2026q3", the recap's URL segment. */
export const recapPath = (q: string) => `/season/${q.toLowerCase()}/`

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

/** "5d 14h" (or "3h 20m" on the last day) to a time: home's season pill and /season/'s countdown. */
export function timeLeft(to: Date | number, now = Date.now()) {
  const m = Math.max(0, Math.floor((+to - now) / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d ? `${d}d ${h}h` : `${h}h ${m % 60}m`
}

/** New York's date (YYYY-MM-DD) for a time. */
export const dayET = (t: Date | number = Date.now()) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

/** Where a tracked fund stands this season, for every "Q3 …" line (fund pages, /account/'s follows):
 *  filed when index.json's latest book is the season's quarter, else its usual day from d/expected.json,
 *  else due by the deadline. Null once the deadline has passed. */
export function seasonStatus(m: { quarter?: string; filing_date?: string; status?: string } | undefined, e: Pick<ExpectedSoon, 'expected_date'> | undefined, now = new Date()) {
  const sn = seasonNow(now)
  // A filer that has stopped filing (status inactive) isn't due anything.
  if (m?.status === 'inactive') return null
  const Q = `Q${sn.quarter.slice(-1)}`
  if (m?.quarter === sn.quarter && m.filing_date) return { kind: 'filed' as const, day: m.filing_date, text: `${Q} filed ${shortDay(m.filing_date)}` }
  if (now > sn.deadline) return null
  if (e?.expected_date && e.expected_date >= dayET(now)) return { kind: 'expected' as const, day: e.expected_date, text: `${Q} expected ${shortDay(e.expected_date)}` }
  const due = dayET(sn.deadline)
  return { kind: 'due' as const, day: due, text: `${Q} due by ${shortDay(due)}` }
}

/** The free Friday email that carries a filing made on `day` (YYYY-MM-DD): it goes out Fridays at 9 pm ET. */
export function fridayAfter(day: string) {
  const t = new Date(`${day}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + ((5 - t.getUTCDay() + 7) % 7))
  const fri = t.toISOString().slice(0, 10)
  return { day: fri, days: Math.round((t.getTime() - Date.parse(`${day}T12:00:00Z`)) / 864e5) }
}

/** EDGAR closures announced on the site, each shown until EDGAR reopens (`until`, 6:00 am ET). */
const CLOSED = [{ day: '2026-11-11', name: 'Veterans Day', until: '2026-11-12T11:00:00Z', resume: '2026-11-12' }]
export function edgarClosed(now = Date.now()) {
  return CLOSED.find((c) => now >= Date.parse(`${c.day}T05:00:00Z`) && now < Date.parse(c.until)) ?? null
}

export type SplitLog = { ticker: string; name: string; quarter: string; ratio: string; treatment: 'adjusted' | 'excluded' | 'not treated'; holders: number | null; share_ratio: number | null; price_ratio: number | null; xbrl_shares_ratio: number | null; source: string }
export const loadSplitLog = () => getJSON<{ splits: SplitLog[] }>(`${D}splits.json`).then((d) => d.splits)

export const loadStockIndex = () => getJSON<{ funds: number; stocks: StockRef[] }>(`${D}stocks.json`)
const named = <T extends { manager: string }>(x: T) => ({ ...x, manager: displayName(x.manager) })
// A flagged row keeps its holding but no dollar move, so no total or biggest-moves list counts it. Its change label
// stays when the flag leaves it known: NEW and EXITED always; added or trimmed when only the value ("value") or only
// the share counts ("shares", change from filed values) are off. A gone position whose change is unknown leaves the
// exited list for not_counted.
const settle = (h: StockHolder): StockHolder => {
  const f = flagOf(h)
  if (!f) return named(h)
  const known = h.change === 'new' || h.change === 'exited' || (f !== 'both' && h.change !== ('unknown' as string))
  return { ...named(h), flag: f, note: flagNote(h), change: known ? h.change : null, delta_value: 0 }
}
export const loadStock = (t: string) =>
  getJSON<Stock>(`${D}stocks/${encodeURIComponent(t)}.json${fresh()}`).then((s) => {
    const gone = (h: StockHolder) => (h.change as string) === 'unknown'
    return { ...s, holders: s.holders.map(settle), exited: s.exited.filter((h) => !gone(h)).map(settle), not_counted: s.exited.filter(gone).map(settle), options: s.options.map(named) }
  })
/** The site's flow.json (top 40 per list), or for members the API's fuller lists, falling back to the site's. */
export const loadFlow = (member = false, v?: number) =>
  (member ? call<Flow | { flow: Flow }>('/flow', { auth: true }).then((r) => ('flow' in r ? r.flow : r)).catch(() => getJSON<Flow>(`${D}flow.json${fresh(v)}`)) : getJSON<Flow>(`${D}flow.json${fresh(v)}`)).then((f) => {
    const scope = (s: FlowScope): FlowScope => {
      const ok = (m: FlowMove) => !unreliable(m) && m.delta_value != null
      const fix = (rows: FlowRow[]) => rows.map((r) => ({ ...r, buyers: r.buyers.filter(ok).map(named), sellers: r.sellers.filter(ok).map(named) }))
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
/** d/coverage.json. in_api: every fund we track closely, as /v1 serves them; curated: those with a current 13F (/season/). */
export const loadCoverage = () => getJSON<{ filers: number; curated: number; in_api?: number; superinvestors?: number }>(`${D}coverage.json`).catch(() => null)
/** "the 355 managers we track closely", or without a number until coverage.json loads. */
export const trackedPhrase = (c: { curated: number; in_api?: number } | null | undefined) => `the ${c ? `${(c.in_api ?? c.curated).toLocaleString('en-US')} ` : ''}managers we track closely`

/** Exact 13F history depth today (from ingest's counts, Nov 11). */
export const HISTORY_EXACT = '341 of the 355 managers we track closely have 8 quarters (2024Q3–2026Q2) and 14 have 3–7; every other 13F filer has 1–3, mostly 2026Q1–Q3. History back to 2013Q2 comes by Dec 31.'

/** Every 13F filer's latest position in a stock (scripts/stocks.mjs, d/h/{TICKER}.json): the 500 largest, plus counts. */
export type FilerHolder = { slug: string; name: string; quarter: string; shares: number; value: number; weight: number; tier: 0 | 1 | 2; smart: boolean; hedge: boolean }
/** Ingest's full-book holder index (hl/): every filer's latest 13F, current holders (this quarter or last) and older ones apart. */
export type HolderIndex = { holders: number; older: number; quarters: Record<string, number>; new: number; added: number; trimmed: number; exited: number; unchanged: number; no_prior: number }
/** A lens's counts (hedge funds, or hedge funds and long-only managers), from the shards; moves are each fund's ten largest buys and sells. */
export type SmartCounts = { current: number; older: number; top10: number; over5: number; quarters: Record<string, number>; moves: { slug: string; name: string; quarter: string; change: Change; delta_value: number }[] }
type HRaw = {
  filers: number
  current?: number
  tracked?: number
  quarters: Record<string, number>
  top10?: number
  over5?: number
  index?: HolderIndex
  smart?: Omit<SmartCounts, 'moves'> & { moves: [string, string, string, Change, number][] }
  hedge?: Omit<SmartCounts, 'moves'> & { moves: [string, string, string, Change, number][] }
  rows: [string, string, string, number, number, number, 0 | 1 | 2, number?][]
}
const lensBlock = (x: HRaw['smart']): SmartCounts | null => (x ? { ...x, moves: x.moves.filter((m) => !unreliable({ change: m[3] }) && m[4] != null).map(([slug, name, quarter, change, delta_value]) => ({ slug, name: displayName(name), quarter, change, delta_value })) } : null)
export const loadFilerHolders = (t: string) =>
  getJSON<HRaw>(`${D}h/${encodeURIComponent(t)}.json${fresh()}`).then((d) => ({
    /** Every filer holding it: exact from ingest's full-book index when present (the shards undercount large books). */
    filers: d.index ? d.index.holders + d.index.older : d.filers,
    /** Filers whose latest 13F is for the newest or previous quarter; the rest are on older filings. */
    current: d.current ?? d.filers,
    /** Funds we track closely that the filer index lists for this stock. */
    tracked: d.tracked ?? null,
    quarters: d.index?.quarters ?? d.quarters,
    top10: d.top10 ?? null,
    over5: d.over5 ?? null,
    index: d.index ?? null,
    smart: lensBlock(d.smart),
    hedge: lensBlock(d.hedge),
    // lens bits: 1 hedge funds and long-only managers, 2 hedge funds.
    rows: d.rows.map(([slug, name, quarter, shares, value, weight, tier, lens = 0]): FilerHolder => ({ slug, name: displayName(name), quarter, shares, value, weight, tier, smart: (lens & 1) > 0, hedge: (lens & 2) > 0 })),
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
