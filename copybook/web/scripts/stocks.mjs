// Derives stock pages and the filing-season flow from the curated 13F books that copybook/ingest
// publishes (data/{slug}.json). Runs in the Pages build after vite (copybook-pages.yml).
// Usage: node scripts/stocks.mjs <out dir> [data base URL or dir]
// Writes <out>/d/stocks.json (search + directory index), <out>/d/stocks/{TICKER}.json and <out>/d/flow.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getJson } from './getjson.mjs'

const out = process.argv[2] || 'dist'
const base = process.argv[3] || process.env.VITE_DATA_BASE || 'https://refcell.github.io/gust/copybook/data/'
const read = async (f) =>
  base.startsWith('http') ? await getJson(base + f) : JSON.parse(readFileSync(join(base, f), 'utf8'))

const qn = (q) => (q ? Number(q.slice(0, 4)) * 4 + Number(q.slice(5)) - 1 : -1)
const index = await read('index.json')
const live = index.managers.filter((m) => m.ok && (m.total_value ?? 0) > 0 && !['inactive', 'reported_by_other'].includes(m.status))
const newest = Math.max(...live.map((m) => qn(m.quarter)))
// A fund more than two quarters behind the newest filing isn't a current holder of anything.
const current = live.filter((m) => qn(m.quarter) >= newest - 2)

const books = []
for (let i = 0; i < current.length; i += 16) {
  const part = await Promise.all(current.slice(i, i + 16).map((m) => read(`${m.slug}.json`).catch(() => null)))
  books.push(...part.filter(Boolean))
}

// Ingest names some ETF trusts per issuer, not per fund: every "ISHARES TR" CUSIP reads "iShares Core
// S&P 500 ETF". A display name used for more than two tickers is ignored in favour of the issuer name.
{
  const tickersOf = new Map()
  for (const b of books) for (const h of b.holdings) if (h.display_name && h.ticker) (tickersOf.get(h.display_name) ?? tickersOf.set(h.display_name, new Set()).get(h.display_name)).add(h.ticker.split(/[.-]/)[0])
  for (const b of books) for (const h of b.holdings) if (h.display_name && (tickersOf.get(h.display_name)?.size ?? 0) > 2) h.display_name = null
}

const tc = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()))
const baseName = (n) => n.replace(/\s+(Class|Cl)\s+[A-Z]\b.*$/i, '').replace(/\s+(Ordinary Shares|Common Stock|Shs)$/i, '').trim()
const r0 = (x) => Math.round(x)

// One stock per issuer: share classes roll up only when the display name names a class
// ("Alphabet Class A/C") and the CUSIP issuer prefix matches. Everything else stays per CUSIP,
// since ETF trusts share both the prefix and, at times, the display name. Entries that share a ticker merge too, which follows
// CUSIP changes (redomiciles, reorganisations) across quarters.
const parent = new Map()
const find = (k) => {
  while (parent.get(k) !== k) k = parent.get(k)
  return k
}
const union = (a, b) => {
  for (const k of [a, b]) if (!parent.has(k)) parent.set(k, k)
  const ra = find(a)
  const rb = find(b)
  if (ra !== rb) parent.set(rb, ra)
}
const rawKey = (h) => (h.display_name && /\s(Class|Cl)\s+[A-Z]\b/i.test(h.display_name) ? `${h.cusip.slice(0, 6)}|${baseName(h.display_name).toLowerCase()}` : h.cusip)
for (const b of books) for (const h of b.holdings) union(rawKey(h), h.ticker ? `t:${h.ticker}` : rawKey(h))
const issuerKey = (h) => find(rawKey(h))

// issuer key -> stock
const stocks = new Map()
for (const b of books) {
  const who = { slug: b.slug, manager: b.manager, firm: b.name, quarter: b.quarter, filing_date: b.filing_date, featured: Boolean(b.featured) }
  const total = b.total_value || 1
  const per = new Map() // issuer key -> this fund's rolled-up position
  for (const h of b.holdings) {
    const k = issuerKey(h)
    let s = stocks.get(k)
    if (!s) {
      s = { key: k, name: baseName(h.display_name || tc(h.issuer)), sector: h.sector || null, classes: new Map(), holders: [], options: [] }
      stocks.set(k, s)
    }
    if (h.ticker) {
      const c = s.classes.get(h.ticker) ?? { ticker: h.ticker, name: h.display_name || tc(h.issuer), cusip: h.cusip, value: 0 }
      c.value += h.put_call ? 0 : h.value
      s.classes.set(h.ticker, c)
    }
    if (h.put_call) {
      if (h.value > 0) s.options.push({ ...who, put_call: h.put_call, ticker: h.ticker, shares: h.shares, value: r0(h.value), weight: h.value / total })
      continue
    }
    const p = per.get(k) ?? { shares: 0, value: 0, prev_shares: 0, prev_value: 0, delta_value: 0, had_prev: b.prev_quarter != null }
    p.shares += h.shares
    p.value += h.value
    p.prev_shares += h.prev_shares ?? 0
    p.prev_value += h.prev_value ?? 0
    const price = h.shares ? h.value / h.shares : h.prev_shares ? (h.prev_value ?? 0) / h.prev_shares : 0
    p.delta_value += b.prev_quarter != null ? (h.shares - (h.prev_shares ?? 0)) * price : 0
    per.set(k, p)
  }
  // Rank of each position in this fund's share book (1 = largest), for "top 10" crowding counts.
  const rank = new Map([...per.entries()].filter(([, p]) => p.shares > 0).sort((a, z) => z[1].value - a[1].value).map(([k], i) => [k, i + 1]))
  for (const [k, p] of per) {
    const change = !p.had_prev ? null : p.shares === 0 ? 'exited' : p.prev_shares === 0 ? 'new' : p.shares > p.prev_shares ? 'added' : p.shares < p.prev_shares ? 'trimmed' : 'unchanged'
    stocks.get(k).holders.push({ ...who, rank: rank.get(k) ?? null, shares: p.shares, value: r0(p.value), weight: p.value / total, prev_shares: p.prev_shares, prev_value: r0(p.prev_value), delta_value: r0(p.delta_value), change })
  }
}

// Stock splits. Ingest confirms splits (data/splits.json) and multiplies earlier share counts by the
// ratio, so those are "adjusted" and counted normally. Until it covers every case, a stock it hasn't
// confirmed is flagged "excluded" (left out of the rankings and net trades) only when, among at least
// 5 holders in both quarters, the median share ratio is within 25% of a clean factor k (2, 3, 4, 5, 10
// or the inverse) and the median implied price ratio (now / prior) is within 25% of 1/k. ETFs are exempt.
// Every flagged name, with its evidence, goes to d/splits.json for /methodology/.
const confirmed = (await read('splits.json').catch(() => null))?.splits ?? []
const splitLog = []
const FACTORS = [2, 3, 4, 5, 10].flatMap((k) => [k, 1 / k])
const med = (xs) => {
  const a = [...xs].sort((x, y) => x - y)
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
}
const ratioLabel = (k) => (k >= 1 ? `${+k.toFixed(2)}:1` : `1:${+(1 / k).toFixed(2)}`)
for (const st of stocks.values()) {
  const cusips = new Set([...st.classes.values()].map((c) => c.cusip))
  const ticker = [...st.classes.values()].sort((a, b) => b.value - a.value)[0]?.ticker ?? null
  for (const c of confirmed.filter((x) => cusips.has(x.cusip))) {
    ;(st.splits ??= {})[c.to_quarter] = { ratio: ratioLabel(c.ratio), adjusted: true }
    splitLog.push({ ticker: ticker ?? c.ticker, name: st.name, quarter: c.to_quarter, ratio: ratioLabel(c.ratio), treatment: 'adjusted', holders: c.holders, share_ratio: c.ratio, price_ratio: c.price_ratio, xbrl_shares_ratio: c.xbrl_shares_ratio ?? null, source: `Ingest: ${c.confirmed_by}` })
  }
  if (st.sector === 'Funds & ETFs') continue
  const byQ = new Map()
  for (const h of st.holders) if (h.shares > 0 && h.prev_shares > 0 && h.value > 0 && h.prev_value > 0) (byQ.get(h.quarter) ?? byQ.set(h.quarter, []).get(h.quarter)).push({ s: h.shares / h.prev_shares, p: h.value / h.shares / (h.prev_value / h.prev_shares) })
  for (const [q, r] of byQ) {
    if (r.length < 5 || st.splits?.[q]) continue
    const ms = med(r.map((x) => x.s))
    const mp = med(r.map((x) => x.p))
    // The closest clean factor that both medians agree on.
    const k = FACTORS.filter((f) => Math.abs(Math.log(ms / f)) < Math.log(1.25) && Math.abs(mp * f - 1) < 0.25).sort((a, b) => Math.abs(Math.log(ms / a)) - Math.abs(Math.log(ms / b)))[0]
    if (!k || !ticker) continue
    ;(st.splits ??= {})[q] = { ratio: ratioLabel(k), adjusted: false }
    splitLog.push({ ticker, name: st.name, quarter: q, ratio: ratioLabel(k), treatment: 'excluded', holders: r.length, share_ratio: +ms.toFixed(3), price_ratio: +mp.toFixed(3), xbrl_shares_ratio: null, source: 'Copybook holder check' })
  }
}
mkdirSync(join(out, 'd'), { recursive: true })
writeFileSync(join(out, 'd', 'splits.json'), JSON.stringify({ generated_at: index.generated_at, splits: splitLog.sort((a, b) => b.quarter.localeCompare(a.quarter) || (a.ticker ?? '').localeCompare(b.ticker ?? '')) }))

const list = []
const byTicker = {}
mkdirSync(join(out, 'd', 'stocks'), { recursive: true })
for (const s of stocks.values()) {
  if (!s.classes.size) continue // no public ticker: private, bonds, unmapped
  const classes = [...s.classes.values()].sort((a, b) => b.value - a.value)
  const ticker = classes[0].ticker
  if (byTicker[ticker]) continue
  const holders = s.holders.filter((h) => h.shares > 0).sort((a, b) => b.value - a.value)
  const exited = s.holders.filter((h) => h.change === 'exited').sort((a, b) => a.delta_value - b.delta_value)
  const count = (c) => s.holders.filter((h) => h.change === c).length
  const prevHolders = s.holders.filter((h) => h.prev_shares > 0).length
  if (!holders.length && !exited.length && !s.options.length) continue
  const file = {
    ticker,
    name: s.name,
    sector: s.sector,
    classes: classes.map(({ ticker, name, cusip }) => ({ ticker, name, cusip })),
    value: holders.reduce((a, h) => a + h.value, 0),
    holders,
    exited,
    options: s.options.sort((a, b) => b.value - a.value),
    counts: { holders: holders.length, prev_holders: prevHolders, new: count('new'), added: count('added'), trimmed: count('trimmed'), exited: count('exited') },
    quarters: [...new Set(holders.map((h) => h.quarter))].sort().reverse(),
    ...(s.splits ? { splits: s.splits } : {}),
    generated_at: index.generated_at,
  }
  writeFileSync(join(out, 'd', 'stocks', `${ticker}.json`), JSON.stringify(file))
  for (const c of classes) byTicker[c.ticker] = ticker
  list.push({ t: ticker, n: s.name, s: s.sector, h: holders.length, dh: holders.length - prevHolders, v: file.value, a: classes.slice(1).map((c) => c.ticker) })
}
list.sort((a, b) => b.h - a.h || b.v - a.v)
// Coverage figures for copy (pricing, account): every filer with parsed holdings, and the curated set.
{
  const fl = await read('filers.json').catch(() => null)
  writeFileSync(join(out, 'd', 'coverage.json'), JSON.stringify({ filers: fl?.holdings_ok ?? fl?.filers?.filter((f) => f.ok).length ?? 0, curated: index.managers.filter((m) => m.ok).length, generated_at: index.generated_at }))
}
writeFileSync(join(out, 'd', 'stocks.json'), JSON.stringify({ generated_at: index.generated_at, funds: books.length, stocks: list }))

// Form 4 and 13D/G filings since each fund's latest 13F (data/events/{slug}.json), attached to
// the stock they're about so its page can show holdings newer than the 13F.
const byCusip = {}
const byIssuer = {} // first 6 CUSIP digits -> stock pages with a class of that issuer
for (const s of stocks.values())
  for (const c of s.classes.values()) {
    if (!byTicker[c.ticker]) continue
    byCusip[c.cusip] = byTicker[c.ticker]
    ;(byIssuer[c.cusip.slice(0, 6)] ??= new Set()).add(byTicker[c.ticker])
  }
const bookOf = new Map(books.map((b) => [b.slug, b.holdings]))
const since = {}
for (let i = 0; i < books.length; i += 16) {
  const part = await Promise.all(books.slice(i, i + 16).map((b) => read(`events/${b.slug}.json`).catch(() => null)))
  for (const ev of part) {
    if (!ev?.events) continue
    for (const e of ev.events) {
      // Every class's page gets the filing (a Form 4 can trade Class A and B); the page keeps its own class's lines.
      const pages = new Set([(e.ticker && byTicker[e.ticker]) || (e.cusip && byCusip[e.cusip]), ...(e.cusip ? byIssuer[e.cusip.slice(0, 6)] ?? [] : [])].filter(Boolean))
      if (!pages.size) continue
      // The fund's 13F share lines for this issuer, one per CUSIP, so comparisons never mix classes.
      const class_book = e.cusip
        ? (bookOf.get(ev.slug) ?? []).filter((h) => !h.put_call && h.cusip.slice(0, 6) === e.cusip.slice(0, 6)).map(({ cusip, ticker, title, shares }) => ({ cusip, ticker, title, shares }))
        : undefined
      const { transactions, ...rest } = e
      const row = { ...rest, transactions: (transactions ?? []).map(({ date, security, code, code_label, shares, price, acquired, derivative, shares_after }) => ({ date, security, code, code_label, shares, price, acquired, derivative, shares_after })), class_book, manager: ev.manager, slug: ev.slug, quarter: ev.latest_13f_quarter }
      for (const t of pages) (since[t] ??= []).push(row)
    }
  }
}
let withSince = 0
for (const [t, evs] of Object.entries(since)) {
  const f = join(out, 'd', 'stocks', `${t}.json`)
  const file = JSON.parse(readFileSync(f, 'utf8'))
  file.since = evs.sort((a, b) => b.filing_date.localeCompare(a.filing_date)).slice(0, 60)
  writeFileSync(f, JSON.stringify(file))
  withSince++
}
console.log(`since-13F filings on ${withSince} stock pages`)

// Filing-season flow: moves by funds that filed the newest quarter, against their previous filing.
const toQ = (n) => `${Math.floor(n / 4)}Q${(n % 4) + 1}`
let season = newest
if (books.filter((b) => qn(b.quarter) === season).length < 10) season -= 1
const filed = books.filter((b) => qn(b.quarter) === season && b.prev_quarter)
// Two scopes: the featured superinvestors (the "smart money"), and every curated fund, which
// includes banks and market makers whose inventory swings dominate dollar totals.
function flowFor(scope, full = false, q = '') {
  const slugs = new Set(scope.map((b) => b.slug))
  const flows = []
  for (const s of stocks.values()) {
    if (!s.classes.size || s.splits?.[q]?.adjusted === false) continue
    const ticker = [...s.classes.values()].sort((a, b) => b.value - a.value)[0].ticker
    const moves = s.holders.filter((h) => slugs.has(h.slug) && h.change && h.change !== 'unchanged')
    if (!moves.length) continue
    const pick = ({ slug, manager, featured, change, delta_value, weight }) => ({ slug, manager, featured, change, delta_value, weight })
    const buyers = moves.filter((h) => h.change === 'new' || h.change === 'added').sort((a, b) => b.delta_value - a.delta_value)
    const sellers = moves.filter((h) => h.change === 'trimmed' || h.change === 'exited').sort((a, b) => a.delta_value - b.delta_value)
    flows.push({
      ticker,
      name: s.name,
      sector: s.sector,
      // Nobody we follow held it last quarter: usually a spin-off, IPO or listing, not a decision.
      fresh: !s.holders.some((h) => h.prev_shares > 0),
      net_value: moves.reduce((a, h) => a + h.delta_value, 0),
      buy_value: buyers.reduce((a, h) => a + h.delta_value, 0),
      sell_value: sellers.reduce((a, h) => a + h.delta_value, 0),
      buyers: buyers.map(pick),
      sellers: sellers.map(pick),
      new_by: buyers.filter((h) => h.change === 'new').map((h) => h.slug),
    })
  }
  // Members' lists (GET /flow from the API) keep every fund on each side and the top 200 names per
  // ranking; uncapped they come to over 100 MB. The site ships the top 40 with 12 funds a side.
  const n = full ? 200 : 40
  // Ship the counts and the 12 largest funds on each side; the page needs no more than that.
  const trim = (rows) => rows.map((f) => ({ ...f, n_buyers: f.buyers.length, n_sellers: f.sellers.length, buyers: f.buyers.slice(0, 12), sellers: f.sellers.slice(0, 12) }))
  const out = {
    bought: [...flows].filter((f) => f.net_value > 0).sort((a, b) => b.net_value - a.net_value).slice(0, n),
    sold: [...flows].filter((f) => f.net_value < 0).sort((a, b) => a.net_value - b.net_value).slice(0, n),
    most_buyers: [...flows].filter((f) => f.buyers.length).sort((a, b) => b.buyers.length - a.buyers.length || b.buy_value - a.buy_value).slice(0, n),
    most_sellers: [...flows].filter((f) => f.sellers.length).sort((a, b) => b.sellers.length - a.sellers.length || a.sell_value - b.sell_value).slice(0, n),
    new_multi: [...flows].filter((f) => f.new_by.length >= 2 && !f.fresh).sort((a, b) => b.new_by.length - a.new_by.length || b.buy_value - a.buy_value).slice(0, n),
    fresh: [...flows].filter((f) => f.fresh && f.buyers.length >= 2).sort((a, b) => b.buyers.length - a.buyers.length).slice(0, full ? n : 20),
  }
  for (const k of Object.keys(out)) out[k] = full ? out[k].map((f) => ({ ...f, n_buyers: f.buyers.length, n_sellers: f.sellers.length })) : trim(out[k])
  return { funds: scope.length, ...out }
}
// One report period at a time: a fund counts in the period of its latest 13F, compared with its
// filing before. A fund that has already filed the next quarter is in that period, not this one.
const period = (q, full = false) => {
  const filedQ = books.filter((b) => qn(b.quarter) === q && b.prev_quarter)
  const live = books.filter((b) => qn(b.quarter) >= q)
  return {
    quarter: toQ(q),
    funds_filed: filedQ.length,
    funds_total: books.filter((b) => qn(b.quarter) >= season - 1).length,
    featured_filed: filedQ.filter((b) => b.featured).length,
    featured_total: books.filter((b) => b.featured && qn(b.quarter) >= season - 1).length,
    // Funds already past this period (filed the next quarter), so a reader knows who's missing.
    moved_on: live.length - filedQ.length,
    featured_moved_on: live.filter((b) => b.featured).length - filedQ.filter((b) => b.featured).length,
    recent: filedQ
      .map((b) => ({ slug: b.slug, manager: b.manager, firm: b.name, filing_date: b.filing_date, accession: b.accession, featured: Boolean(b.featured), changes: b.changes ?? null }))
      .sort((a, b) => (b.filing_date ?? '').localeCompare(a.filing_date ?? ''))
      .slice(0, 40),
    featured: flowFor(filedQ.filter((b) => b.featured), full, toQ(q)),
    all: flowFor(filedQ, full, toQ(q)),
    // Left out of the rankings above: share changes that look like a split, not trades.
    splits: [...stocks.values()].filter((st) => st.splits?.[toQ(q)]?.adjusted === false && st.classes.size).map((st) => ({ ticker: [...st.classes.values()].sort((a, b) => b.value - a.value)[0].ticker, name: st.name, ratio: st.splits[toQ(q)].ratio })),
  }
}
const periods = [period(season), period(season - 1)]
const flow = { ...periods[0], periods, generated_at: index.generated_at }
writeFileSync(join(out, 'd', 'flow.json'), JSON.stringify(flow))
// The 13F season tracker (/season/): the newest quarter's filing progress, latest curated filings and
// the most bought and sold names so far. Rebuilt with every Pages build (every 20 minutes in the wave).
{
  const q = newest
  const Q = toQ(q)
  const y = Math.floor(q / 4)
  const n = (q % 4) + 1
  // Due 45 days after quarter end, moved past a weekend, at 5:30 pm Eastern (EDT in May and August).
  const due = new Date(Date.UTC(y, n * 3, 0) + 45 * 864e5)
  while (due.getUTCDay() === 0 || due.getUTCDay() === 6) due.setUTCDate(due.getUTCDate() + 1)
  due.setUTCHours(17 + (n <= 2 ? 4 : 5), 30)
  const active = live.filter((m) => qn(m.quarter) >= q - 1)
  const fl = (await read('filers.json').catch(() => null))?.filers?.filter((f) => f.ok) ?? []
  const filedAll = fl.filter((f) => f.quarter === Q)
  const days = {}
  for (const f of filedAll) if (f.filing_date) days[f.filing_date] = (days[f.filing_date] ?? 0) + 1
  const sp = q === season ? periods[0] : period(q)
  const top = (sc) => {
    const cut = (rows) => rows.slice(0, 40).map((f) => ({ ticker: f.ticker, name: f.name, net_value: f.net_value, buy_value: f.buy_value, sell_value: f.sell_value, n_buyers: f.n_buyers, n_sellers: f.n_sellers, buyers: f.buyers.slice(0, 5), sellers: f.sellers.slice(0, 5) }))
    return { funds: sc.funds, bought: cut(sc.bought), sold: cut(sc.sold), most_buyers: cut(sc.most_buyers) }
  }
  const seasonOut = {
    quarter: Q,
    deadline: due.toISOString(),
    curated: { filed: active.filter((m) => qn(m.quarter) === q).length, total: active.length },
    featured: { filed: active.filter((m) => m.featured && qn(m.quarter) === q).length, total: active.filter((m) => m.featured).length },
    filers: { filed: filedAll.length, total: fl.filter((f) => qn(f.quarter) >= q - 1).length },
    by_day: Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
    latest: books
      .filter((b) => qn(b.quarter) === q)
      .map((b) => ({ slug: b.slug, manager: b.manager, firm: b.name, filing_date: b.filing_date, accession: b.accession, featured: Boolean(b.featured), total_value: b.total_value, changes: b.changes ?? null }))
      .sort((a, b) => (b.filing_date ?? '').localeCompare(a.filing_date ?? '') || (b.total_value ?? 0) - (a.total_value ?? 0)),
    splits: sp.splits,
    featured_flow: top(sp.featured),
    all_flow: top(sp.all),
    generated_at: index.generated_at,
  }
  writeFileSync(join(out, 'd', 'season.json'), JSON.stringify(seasonOut))
  console.log(`season ${Q}: ${seasonOut.curated.filed} of ${seasonOut.curated.total} curated, ${seasonOut.filers.filed} of ${seasonOut.filers.total} filers, due ${seasonOut.deadline}`)
}
// FLOW_FULL=<path outside dist>: the untrimmed lists, same shape, for the API's GET /flow.
if (process.env.FLOW_FULL) {
  const fp = [period(season, true), period(season - 1, true)]
  writeFileSync(process.env.FLOW_FULL, JSON.stringify({ ...fp[0], periods: fp, generated_at: index.generated_at }))
  console.log(`full flow: ${process.env.FLOW_FULL}`)
}
console.log(`stocks: ${list.length} pages from ${books.length} funds; flow ${flow.quarter}: ${filed.length} funds filed (${flow.featured_filed} featured), ${periods.map((p) => `${p.quarter} ${p.funds_filed} funds`).join(', ')}`)

// Every 13F filer's latest holdings (data/f/{cik}.json shards), per stock page: the 500 largest
// holders, written to d/h/{TICKER}.json for the "All 13F filers" lens. Loaded only when a reader picks it.
{
  const fl = await read('filers.json').catch(() => null)
  const filers = (fl?.filers ?? []).filter((f) => f.ok)
  const curatedByCik = new Map(index.managers.filter((m) => m.ok).map((m) => [m.cik, m]))
  const pageOf = (h) => (h.cusip && byCusip[h.cusip]) || (h.ticker && byTicker[h.ticker]) || null
  const per = new Map() // page ticker -> rows
  const quarters = new Map() // page ticker -> {quarter: filers}
  // Crowding over every filer, not just the 500 rows shipped: how many hold it in their ten largest
  // share positions, and how many at over 5% of their 13F book.
  const top10 = new Map()
  const over5 = new Map()
  let read_ok = 0
  for (let i = 0; i < filers.length; i += 48) {
    const part = await Promise.all(filers.slice(i, i + 48).map((f) => read(`f/${f.cik}.json`).then((d) => [f, d], () => null)))
    for (const x of part) {
      if (!x || !x[1]?.ok || !Array.isArray(x[1].rows)) continue
      const [f, d] = x
      // Same freshness rule as the curated set: more than two quarters behind isn't a current holder.
      if (qn(d.quarter) < newest - 2) continue
      read_ok++
      const col = Object.fromEntries((d.columns ?? []).map((c, j) => [c, j]))
      const total = d.total_value || 1
      const cur = curatedByCik.get(f.cik)
      const who = cur ? { slug: cur.slug, name: cur.manager, flag: cur.featured ? 2 : 1 } : { slug: f.slug, name: f.name, flag: 0 }
      const mine = new Map() // page -> [shares, value]; classes of one issuer roll up like the curated rows
      for (const r of d.rows) {
        if (r[col.put_call]) continue
        const t = pageOf({ cusip: r[col.cusip], ticker: r[col.ticker] })
        if (!t) continue
        const p = mine.get(t) ?? [0, 0]
        p[0] += r[col.shares] || 0
        p[1] += r[col.value] || 0
        mine.set(t, p)
      }
      const ranked = [...mine.entries()].filter(([, [sh]]) => sh > 0).sort((a, b) => b[1][1] - a[1][1])
      ranked.slice(0, 10).forEach(([t]) => top10.set(t, (top10.get(t) ?? 0) + 1))
      for (const [t, [, value]] of ranked) if (value / total > 0.05) over5.set(t, (over5.get(t) ?? 0) + 1)
      for (const [t, [shares, value]] of mine) {
        if (shares <= 0) continue
        const rows = per.get(t) ?? []
        rows.push([who.slug, who.name, d.quarter, shares, Math.round(value), Number((value / total).toPrecision(4)), who.flag])
        per.set(t, rows)
        const q = quarters.get(t) ?? {}
        q[d.quarter] = (q[d.quarter] ?? 0) + 1
        quarters.set(t, q)
      }
    }
  }
  mkdirSync(join(out, 'd', 'h'), { recursive: true })
  let files = 0
  let rowsOut = 0
  for (const [t, rows] of per) {
    rows.sort((a, b) => b[4] - a[4])
    const top = rows.slice(0, 500)
    rowsOut += top.length
    writeFileSync(
      join(out, 'd', 'h', `${t}.json`),
      JSON.stringify({ ticker: t, filers: rows.length, quarters: quarters.get(t), top10: top10.get(t) ?? 0, over5: over5.get(t) ?? 0, columns: ['slug', 'name', 'quarter', 'shares', 'value', 'weight', 'tier'], rows: top, generated_at: fl?.generated_at ?? index.generated_at }),
    )
    files++
  }
  console.log(`all-filer holders: ${read_ok} filers, ${files} stocks, ${rowsOut} rows (500 largest per stock)`)
}
