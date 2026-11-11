// Derives stock pages and the filing-season flow from the curated 13F books that copybook/ingest
// publishes (data/{slug}.json). Runs in the Pages build after vite (copybook-pages.yml).
// Usage: node scripts/stocks.mjs <out dir> [data base URL or dir]
// Writes <out>/d/stocks.json (search + directory index), <out>/d/stocks/{TICKER}.json and <out>/d/flow.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { getJson, pooled } from './getjson.mjs'
import { ETF_NAMES } from './etfs.mjs'
import { isEdgarDay } from '../src/lib/calendar.mjs'
import { displayName } from '../src/lib/names.mjs'

const out = process.argv[2] || 'dist'
const base = process.argv[3] || process.env.VITE_DATA_BASE || 'https://refcell.github.io/gust/copybook/data/'
const read = async (f) =>
  base.startsWith('http') ? await getJson(base + f) : JSON.parse(readFileSync(join(base, f), 'utf8'))

// Every filer's book: ingest's combined parts (fall/, 4 gzip files of {shards: {cik: book}}) one part at a
// time, so only a quarter of the books is in memory at once; any filer missing from them, or all of them
// when fall/index.json isn't there, from its own f/{cik}.json. Yields [filer, book], or null for a failed read.
async function* filerBooks(filers) {
  const left = new Map(filers.map((f) => [String(f.cik).padStart(10, '0'), f]))
  const fall = await read('fall/index.json').catch(() => null)
  for (const part of fall?.parts ?? []) {
    let shards = null
    for (let i = 0; i < 3 && !shards; i++) {
      try {
        const bytes = base.startsWith('http') ? Buffer.from(await (await fetch(`${base}fall/${part.file}`).then((r) => (r.ok ? r : Promise.reject(new Error(String(r.status)))))).arrayBuffer()) : readFileSync(join(base, 'fall', part.file))
        shards = JSON.parse(gunzipSync(bytes).toString('utf8')).shards
      } catch (e) {
        if (i === 2) console.warn(`fall/${part.file}: ${e.message}; those filers come from f/`)
      }
    }
    for (const [cik, d] of Object.entries(shards ?? {})) {
      const f = left.get(cik)
      if (!f) continue
      left.delete(cik)
      yield [f, d]
    }
  }
  if (fall) console.log(`filer books: ${filers.length - left.size} from fall/, ${left.size} from f/`)
  yield* pooled([...left.values()], 48, (f) => read(`f/${f.cik}.json`).then((d) => [f, d], () => null))
}

const qn = (q) => (q ? Number(q.slice(0, 4)) * 4 + Number(q.slice(5)) - 1 : -1)
const index = await read('index.json')
const live = index.managers.filter((m) => m.ok && (m.total_value ?? 0) > 0 && !['inactive', 'reported_by_other'].includes(m.status))
const newest = Math.max(...live.map((m) => qn(m.quarter)))
// A fund more than two quarters behind the newest filing isn't a current holder of anything.
const current = live.filter((m) => qn(m.quarter) >= newest - 2)
// The superinvestors /season/, Flow and the docs count: every featured manager that isn't inactive,
// including those whose 13F another entity files (Ackman).
const SUPER_TOTAL = index.managers.filter((x) => x.featured && x.ok !== false && x.status !== 'inactive').length

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
  // One weight everywhere: % of the equity (SH) book, without option notional or PRN (ingest's pct_of_book).
  const total = b.equity_value || b.total_value || 1
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

// Fund names for ETFs: 13F filings carry only the trust's name ("ISHARES TR").
for (const st of stocks.values())
  for (const c of st.classes.values())
    if (ETF_NAMES[c.ticker]) {
      c.name = ETF_NAMES[c.ticker]
      if (c.ticker === [...st.classes.values()].sort((a, b) => b.value - a.value)[0].ticker) st.name = ETF_NAMES[c.ticker]
    }

// Stock splits. Ingest's data/splits.json is the source of truth: it confirms splits and multiplies
// earlier share counts by the ratio, so those are "adjusted" and counted normally, and a candidate it
// checked and turned down is not a split. One case it can't see stays ours: a split whose CUSIP changed
// (DD's 1:3), so a stock ingest never checked is adjusted here only on strong evidence (10+ holders in
// both quarters, median share ratio within 5% of a clean factor k, median price ratio within 10% of 1/k).
// Weaker patterns are logged but treated as trades ("not treated"). ETFs are exempt. Every candidate,
// with its evidence, goes to d/splits.json for /methodology/.
const splitsJson = await read('splits.json').catch(() => null)
const confirmed = splitsJson?.splits ?? []
const checked = splitsJson?.checked ?? {}
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
    if (r.length < 5 || st.splits?.[q] || [...cusips].some((c) => checked[`${c}:${q}`])) continue
    const ms = med(r.map((x) => x.s))
    const mp = med(r.map((x) => x.p))
    // The closest clean factor that both medians agree on.
    const k = FACTORS.filter((f) => Math.abs(Math.log(ms / f)) < Math.log(1.25) && Math.abs(mp * f - 1) < 0.25).sort((a, b) => Math.abs(Math.log(ms / a)) - Math.abs(Math.log(ms / b)))[0]
    if (!k || !ticker) continue
    // Strong evidence (10+ holders, share ratio within 5% of k, price ratio within 10% of 1/k): adjust
    // here the way ingest does, multiplying the earlier shares by k, so the real trades count. Weaker
    // evidence is left out of the rankings and net trades instead.
    const strong = r.length >= 10 && Math.abs(ms / k - 1) < 0.05 && Math.abs(mp * k - 1) < 0.1
    if (strong)
      for (const h of st.holders) {
        if (h.quarter !== q || !h.change || !h.prev_shares) continue
        h.prev_shares *= k
        const price = h.shares ? h.value / h.shares : h.prev_value / h.prev_shares
        h.delta_value = r0((h.shares - h.prev_shares) * price)
        h.change = h.shares === 0 ? 'exited' : h.shares > h.prev_shares ? 'added' : h.shares < h.prev_shares ? 'trimmed' : 'unchanged'
      }
    if (strong) (st.splits ??= {})[q] = { ratio: ratioLabel(k), adjusted: true }
    splitLog.push({ ticker, name: st.name, quarter: q, ratio: ratioLabel(k), treatment: strong ? 'adjusted' : 'not treated', holders: r.length, share_ratio: +ms.toFixed(3), price_ratio: +mp.toFixed(3), xbrl_shares_ratio: null, source: strong ? 'Copybook holder check (CUSIP changed; not in ingest’s splits.json)' : 'Copybook holder check; not in ingest’s splits.json, so counted as trades' })
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
// Coverage figures for copy (pricing, /api/, /for-quants/): counted the way GET /v1/filers counts them
// (every curated manager plus every other filer with parsed holdings), so the site and the API agree.
{
  const fl = await read('filers.json').catch(() => null)
  const cik = (c) => String(c).replace(/^0+/, '')
  const all = new Set([...(fl?.filers ?? []).filter((f) => f.ok).map((f) => cik(f.cik)), ...index.managers.map((m) => cik(m.cik))])
  // Funds we track: the ones /season/ and Flow count, with a 13F for the newest quarter or the one before.
  // Ingest's own counts (index.json counts) once published, so every page shows one number; this build's
  // figures, computed the same way, only until then.
  const c = index.counts
  writeFileSync(
    join(out, 'd', 'coverage.json'),
    JSON.stringify({
      filers: c?.filers ?? all.size,
      curated: c?.tracked ?? live.filter((m) => qn(m.quarter) >= newest - 1).length,
      superinvestors: c?.superinvestors ?? SUPER_TOTAL,
      ...(c?.definitions ? { definitions: c.definitions } : {}),
      generated_at: index.generated_at,
    }),
  )
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
    featured_total: SUPER_TOTAL,
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
  // Due 45 days after quarter end, moved past weekends and federal holidays, at 5:30 pm Eastern (EDT in May and August).
  const due = new Date(Date.UTC(y, n * 3, 0) + 45 * 864e5)
  while (!isEdgarDay(due.toISOString().slice(0, 10))) due.setUTCDate(due.getUTCDate() + 1)
  due.setUTCHours(17 + (n <= 2 ? 4 : 5), 30)
  const active = live.filter((m) => qn(m.quarter) >= q - 1)
  const fl = (await read('filers.json').catch(() => null))?.filers?.filter((f) => f.ok) ?? []
  const filedAll = fl.filter((f) => f.quarter === Q)
  const days = {}
  for (const f of filedAll) if (f.filing_date) days[f.filing_date] = (days[f.filing_date] ?? 0) + 1
  const sp = q === season ? periods[0] : period(q)
  const top = (sc) => {
    const cut = (rows) => rows.slice(0, 40).map((f) => ({ ticker: f.ticker, name: f.name, ...(f.sector === 'Funds & ETFs' ? { etf: true } : {}), net_value: f.net_value, buy_value: f.buy_value, sell_value: f.sell_value, n_buyers: f.n_buyers, n_sellers: f.n_sellers, buyers: f.buyers.slice(0, 5), sellers: f.sellers.slice(0, 5) }))
    return { funds: sc.funds, bought: cut(sc.bought), sold: cut(sc.sold), most_buyers: cut(sc.most_buyers) }
  }
  // Expected to file: each superinvestor's last four original 13Fs, as EDGAR business days before
  // that quarter's deadline and New York time of acceptance, give a usual day and time this season.
  const deadlineDay = (qq) => {
    const yy = Math.floor(qq / 4)
    const nn = (qq % 4) + 1
    const d = new Date(Date.UTC(yy, nn * 3, 0) + 45 * 864e5)
    while (!isEdgarDay(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  }
  const nyDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const nyMinutes = (iso) => {
    const [h, m] = new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).split(':').map(Number)
    return (h % 24) * 60 + m
  }
  // EDGAR days from a date to a later deadline (0 = deadline day); negative when filed late.
  const edgarDaysBefore = (day, due) => {
    let n = 0
    const t = new Date(`${day}T12:00:00Z`)
    if (day > due) return -1
    while (t.toISOString().slice(0, 10) < due) {
      t.setUTCDate(t.getUTCDate() + 1)
      if (isEdgarDay(t.toISOString().slice(0, 10))) n++
    }
    return n
  }
  const shiftBack = (due, n) => {
    const t = new Date(`${due}T12:00:00Z`)
    while (n > 0) {
      t.setUTCDate(t.getUTCDate() - 1)
      if (isEdgarDay(t.toISOString().slice(0, 10))) n--
    }
    return t.toISOString().slice(0, 10)
  }
  const median = (xs) => {
    const a = [...xs].sort((x, y) => x - y)
    return a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2)
  }
  const expected = []
  const notFiling = []
  // The quarter's original 13F-HR acceptance (an amendment may head the quarter now).
  const origAccepted = (x) => (x?.filings ?? []).filter((f) => f.form === '13F-HR' && f.accepted_at).sort((a, z) => a.accepted_at.localeCompare(z.accepted_at))[0]?.accepted_at ?? (x?.form === '13F-HR' ? x.accepted_at : null)
  // Every superinvestor, including those whose 13F is filed by another entity (Ackman by Pershing
  // Square Inc.): their timing comes from the entity that files. 13F-NT quarters (holdings reported
  // elsewhere) and amendments say nothing about when the 13F-HR goes in, so they are skipped.
  for (const m of index.managers.filter((x) => x.featured && x.ok !== false && x.status !== 'inactive')) {
    const via = m.status === 'reported_by_other' && m.reported_by?.slug && m.reported_by.slug !== m.slug ? m.reported_by : null
    const src = via?.slug ?? m.slug
    const h = await read(`${src}-history.json`).catch(() => null)
    // Each quarter's original 13F-HR, not the amendment that may now head the quarter.
    const past = (h?.history ?? [])
      .filter((x) => qn(x.quarter) < q)
      .map((x) => {
        const orig = (x.filings ?? []).filter((f) => f.form === '13F-HR' && f.accepted_at).sort((a, z) => a.accepted_at.localeCompare(z.accepted_at))[0]
        return { quarter: x.quarter, accepted_at: orig?.accepted_at ?? (x.form === '13F-HR' ? x.accepted_at : null) }
      })
      .filter((x) => x.accepted_at)
      .sort((x, y) => y.quarter.localeCompare(x.quarter))
      .slice(0, 4)
    if (!past.length || qn(past[0].quarter) < q - 4) {
      notFiling.push({ slug: m.slug, manager: m.manager, last: past[0]?.quarter ?? m.quarter ?? null })
      continue
    }
    // Most recent first.
    const hist = past.map((x) => ({ quarter: x.quarter, accepted_at: x.accepted_at, days_before: edgarDaysBefore(nyDay(x.accepted_at), deadlineDay(qn(x.quarter))) }))
    // The usual day: the value at least 2 of the last 4 share; a tie goes to the most recent quarters.
    const counts = new Map()
    for (const x of hist) counts.set(Math.max(0, x.days_before), (counts.get(Math.max(0, x.days_before)) ?? 0) + 1)
    const best = Math.max(...counts.values())
    const days = hist.map((x) => Math.max(0, x.days_before)).find((d) => counts.get(d) === best)
    const pattern = best >= 3 ? 'usually' : best === 2 ? 'most' : 'none'
    // Time of day: the median of the last four when they agree within 30 minutes, else the last two.
    const mins = past.map((x) => nyMinutes(x.accepted_at))
    const spread = (xs) => Math.max(...xs) - Math.min(...xs)
    const recent = mins.slice(0, 2)
    const wide = recent.length === 2 && spread(recent) > 30
    const time_et = spread(mins) <= 30 ? median(mins) : wide ? recent[0] : median(recent)
    const time_range = spread(mins) > 30 && wide ? [Math.min(...recent), Math.max(...recent)] : null
    // Filed this quarter: from the filing entity's own history when another entity files (Ackman via
    // Pershing Square Inc.), so a stale book under the person's name doesn't hide the new filing.
    const books_ = via ? null : books.find((b) => b.slug === m.slug)
    const viaNow = via ? h?.history?.find((x) => x.quarter === Q && x.form !== '13F-NT') : null
    const filedNow = Boolean(viaNow || (books_ && qn(books_.quarter) === q))
    // A latest 13F with an empty (placeholder) table: the filer did file, so it isn't late or missing;
    // the page says which quarter it left empty and which full book it shows.
    const empty = m.status === 'empty_latest' ? (m.skipped_quarters ?? []).filter((x) => x.reason === 'empty').sort((a, z) => z.quarter.localeCompare(a.quarter))[0] : null
    expected.push({
      slug: m.slug,
      manager: m.manager,
      ...(via ? { via: displayName(via.name ?? '') } : {}),
      ...(empty ? { placeholder: { quarter: empty.quarter, showing: m.quarter } } : {}),
      pattern,
      expected_date: pattern === 'none' ? null : shiftBack(due.toISOString().slice(0, 10), days),
      days_before: pattern === 'none' ? Math.max(0, hist[0].days_before) : days,
      time_et,
      ...(time_range ? { time_range } : {}),
      history: hist,
      ...(filedNow ? { filed: { filing_date: (viaNow ?? books_).filing_date, accession: (viaNow ?? books_).accession, accepted_at: origAccepted(h?.history?.find((x) => x.quarter === Q)) ?? (viaNow ?? books_).accepted_at ?? null } } : {}),
    })
  }
  expected.sort((a, b) => (a.expected_date ?? '9').localeCompare(b.expected_date ?? '9') || a.time_et - b.time_et)
  const seasonOut = {
    quarter: Q,
    expected,
    not_filing: notFiling,
    deadline: due.toISOString(),
    curated: { filed: active.filter((m) => qn(m.quarter) === q).length, total: index.counts?.tracked ?? active.length },
    // Every superinvestor on the expected list, so filed + still to file always equals the total.
    featured: { filed: expected.filter((x) => x.filed).length, total: expected.length },
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
  // A small file for filer pages and /season/'s "Next up" line: superinvestors still to file this quarter,
  // with their usual day and time and book size (for ranking), so a filer page doesn't load all of season.json.
  const aum = new Map(index.managers.map((m) => [m.slug, m.total_value ?? 0]))
  writeFileSync(
    join(out, 'd', 'expected.json'),
    JSON.stringify({
      quarter: Q,
      generated_at: index.generated_at,
      // The newest 13F in the data by EDGAR acceptance time, for /status/'s freshness line.
      latest_13f: (({ manager, filing_date, accepted_at } = {}) => (manager ? { manager, filing_date, accepted_at: accepted_at ?? null } : null))(
        books.filter((b) => qn(b.quarter) === q).sort((a, z) => (z.accepted_at ?? z.filing_date ?? '').localeCompare(a.accepted_at ?? a.filing_date ?? ''))[0],
      ),
      expected: expected
        .filter((x) => !x.filed && !x.placeholder && x.expected_date)
        .map(({ slug, manager, pattern, expected_date, time_et, time_range }) => ({ slug, manager, pattern, expected_date, time_et, time_range, total_value: aum.get(slug) ?? 0 })),
    }),
  )

  // The season recap (/season/{yyyy}q{n}/): what the superinvestors bought, sold, opened and exited,
  // their biggest single moves, and who filed late or not at all. Rebuilt every build, so late filers
  // flow in after the deadline. Names that look like an unadjusted split are left out, as on /season/.
  {
    const supers = books.filter((b) => b.featured && qn(b.quarter) === q && b.prev_quarter)
    const slugs = new Set(supers.map((b) => b.slug))
    const moves = []
    for (const st of stocks.values()) {
      if (!st.classes.size || st.splits?.[Q]?.adjusted === false) continue
      const ticker = [...st.classes.values()].sort((a, b) => b.value - a.value)[0].ticker
      const etf = st.sector === 'Funds & ETFs'
      for (const h of st.holders) {
        if (!slugs.has(h.slug) || !h.change || h.change === 'unchanged' || !h.delta_value) continue
        moves.push({ ticker, name: st.name, ...(etf ? { etf: true } : {}), slug: h.slug, manager: displayName(h.manager), change: h.change, delta_value: Math.round(h.delta_value), weight: h.weight ?? null })
      }
    }
    const stock = moves.filter((m) => !m.etf)
    // By % of book: each superinvestor's trade as a share of its 13F book, summed per stock, so a
    // small fund's conviction counts as much as a big book's dollars.
    const bookOf = new Map(supers.map((b) => [b.slug, b.equity_value || b.total_value || 0]))
    const byStock = new Map()
    for (const m of stock) {
      const tot = bookOf.get(m.slug)
      if (!tot) continue
      const r = byStock.get(m.ticker) ?? { ticker: m.ticker, name: m.name, pct: 0, buyers: [], sellers: [] }
      r.pct += m.delta_value / tot
      ;(m.delta_value > 0 ? r.buyers : r.sellers).push({ slug: m.slug, manager: m.manager, pct: m.delta_value / tot })
      byStock.set(m.ticker, r)
    }
    const pctRows = [...byStock.values()].map((r) => ({ ...r, pct: Number(r.pct.toFixed(5)), n_buyers: r.buyers.length, n_sellers: r.sellers.length, buyers: r.buyers.sort((a, b) => b.pct - a.pct).slice(0, 5), sellers: r.sellers.sort((a, b) => a.pct - b.pct).slice(0, 5) }))
    const by = (f, cmp, n = 50) => stock.filter(f).sort(cmp).slice(0, n)
    const dueMs = due.getTime()
    const status = expected.map((x) => {
      const at = x.filed?.accepted_at ?? null
      return { slug: x.slug, manager: displayName(x.manager), ...(x.via ? { via: x.via } : {}), ...(x.placeholder ? { placeholder: x.placeholder } : {}), filed: Boolean(x.filed), filing_date: x.filed?.filing_date ?? null, accepted_at: at, accession: x.filed?.accession ?? null, late: Boolean(at && Date.parse(at) > dueMs), expected_date: x.expected_date }
    })
    const recap = {
      quarter: Q,
      deadline: due.toISOString(),
      final: Date.now() > dueMs,
      superinvestors: seasonOut.featured,
      bought_usd: stock.filter((m) => m.delta_value > 0).reduce((a, m) => a + m.delta_value, 0),
      sold_usd: stock.filter((m) => m.delta_value < 0).reduce((a, m) => a + m.delta_value, 0),
      opened_count: stock.filter((m) => m.change === 'new').length,
      exited_count: stock.filter((m) => m.change === 'exited').length,
      // Rankings by name come from the same flow as /season/ and /flow/ (ETFs and index funds left out).
      most_bought: seasonOut.featured_flow.bought.filter((r) => !r.etf).slice(0, 25),
      most_sold: seasonOut.featured_flow.sold.filter((r) => !r.etf).slice(0, 25),
      most_buyers: seasonOut.featured_flow.most_buyers.filter((r) => !r.etf).slice(0, 25),
      most_bought_pct: pctRows.filter((r) => r.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 25),
      most_sold_pct: pctRows.filter((r) => r.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 25),
      opened: by((m) => m.change === 'new', (a, b) => b.delta_value - a.delta_value),
      exited: by((m) => m.change === 'exited', (a, b) => a.delta_value - b.delta_value),
      biggest: by(() => true, (a, b) => Math.abs(b.delta_value) - Math.abs(a.delta_value)),
      filing: status,
      not_filing: notFiling,
      splits: sp.splits,
      generated_at: index.generated_at,
    }
    mkdirSync(join(out, 'd', 'recap'), { recursive: true })
    writeFileSync(join(out, 'd', 'recap', `${Q}.json`), JSON.stringify(recap))
    console.log(`recap ${Q}: ${recap.superinvestors.filed} of ${recap.superinvestors.total} superinvestors, ${moves.length} moves${recap.final ? ', final' : ''}`)
  }
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
// holders, written to d/h/{TICKER}.json for the "All 13F filers" and "Hedge funds" lenses. Loaded only
// when a reader picks one. Holder counts and changes come from ingest's holder index (hl/{issuer6}.json,
// every filer's latest full book), which the shards undercount; crowding (top 10, over 5%) and the
// "smart money" figures (hedge funds and active managers, filer_types.json) come from the shards.
{
  const fl = await read('filers.json').catch(() => null)
  const filers = (fl?.filers ?? []).filter((f) => f.ok)
  const ft = await read('filer_types.json').catch(() => null)
  // Two lenses: hedge funds alone, and hedge funds plus long-only managers (ingest's smart_money;
  // "active" until its long_only type lands).
  const SMART = new Set([...(ft?.smart_money ?? ['hedge_fund', 'active']), 'hedge_fund', 'long_only'])
  // filer_types.json first (the set index.json's types_as_of dates, and /v1's source); a fall/ book's stamped
  // type lags it until the next moves.py run.
  const typeOf = (cik, own) => ft?.filers?.[cik]?.type ?? own ?? null
  const lenses = { smart: new Map(), hedge: new Map() } // page -> {current, older, top10, over5, quarters, moves}
  const lensOf = (k, t) => lenses[k].get(t) ?? lenses[k].set(t, { current: 0, older: 0, top10: 0, over5: 0, quarters: {}, moves: [] }).get(t)
  const curatedByCik = new Map(index.managers.filter((m) => m.ok).map((m) => [m.cik, m]))
  const pageOf = (h) => (h.cusip && byCusip[h.cusip]) || (h.ticker && byTicker[h.ticker]) || null
  const per = new Map() // page ticker -> rows
  const quarters = new Map() // page ticker -> {quarter: filers}
  // Crowding over every filer, not just the 500 rows shipped: how many hold it in their ten largest
  // share positions, and how many at over 5% of their 13F book.
  const top10 = new Map()
  const over5 = new Map()
  const current = new Map()
  const tracked = new Map()
  let read_ok = 0
  for await (const x of filerBooks(filers)) {
    {
      if (!x || !x[1]?.ok || !Array.isArray(x[1].rows)) continue
      const [f, d] = x
      // Same freshness rule as the curated set: more than two quarters behind isn't a current holder.
      if (qn(d.quarter) < newest - 2) continue
      read_ok++
      const col = Object.fromEntries((d.columns ?? []).map((c, j) => [c, j]))
      // Equity book: shards carry no equity_value, so take the option notional they list out of the total.
      const optionValue = d.rows.reduce((a, r) => a + (r[col.put_call] ? r[col.value] || 0 : 0), 0)
      const total = d.equity_value || d.total_value - optionValue || d.total_value || 1
      const cur = curatedByCik.get(f.cik)
      const who = cur ? { slug: cur.slug, name: cur.manager, flag: cur.featured ? 2 : 1 } : { slug: f.slug, name: f.name, flag: 0 }
      const ty = typeOf(f.cik, d.type ?? f.type ?? cur?.type)
      const smart = SMART.has(ty)
      const hedge = ty === 'hedge_fund'
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
      // Crowding counts only filers whose latest 13F is for the newest or previous quarter; older
      // filings are counted apart ("+N on older filings").
      const fresh = qn(d.quarter) >= newest - 1
      const ranked = [...mine.entries()].filter(([, [sh]]) => sh > 0).sort((a, b) => b[1][1] - a[1][1])
      if (fresh) {
        ranked.slice(0, 10).forEach(([t]) => top10.set(t, (top10.get(t) ?? 0) + 1))
        for (const [t, [, value]] of ranked) if (value / total > 0.05) over5.set(t, (over5.get(t) ?? 0) + 1)
      }
      for (const [lens, on] of [['smart', smart], ['hedge', hedge]]) {
        if (!on) continue
        ranked.forEach(([t, [, value]], i) => {
          const x = lensOf(lens, t)
          if (!fresh) return void x.older++
          x.current++
          x.quarters[d.quarter] = (x.quarters[d.quarter] ?? 0) + 1
          if (i < 10) x.top10++
          if (value / total > 0.05) x.over5++
        })
        // The fund's ten largest buys and sells against its prior quarter (the shard keeps those).
        const mc = Object.fromEntries((d.moves?.columns ?? []).map((c, j) => [c, j]))
        if (fresh && d.prev_quarter)
          for (const m of [...(d.moves?.bought ?? []), ...(d.moves?.sold ?? [])]) {
            if (m[mc.put_call]) continue
            const t = pageOf({ cusip: m[mc.cusip], ticker: m[mc.ticker] })
            if (t) lensOf(lens, t).moves.push([who.slug, who.name, d.quarter, m[mc.change], Math.round(m[mc.value_delta] || 0)])
          }
      }
      for (const [t] of ranked) {
        if (fresh) current.set(t, (current.get(t) ?? 0) + 1)
        // Funds we track closely that the filer index lists for this stock, to spot an incomplete index.
        if (who.flag) tracked.set(t, (tracked.get(t) ?? 0) + 1)
      }
      for (const [t, [shares, value]] of mine) {
        if (shares <= 0) continue
        const rows = per.get(t) ?? []
        rows.push([who.slug, who.name, d.quarter, shares, Math.round(value), Number((value / total).toPrecision(4)), who.flag, (smart ? 1 : 0) | (hedge ? 2 : 0)])
        per.set(t, rows)
        const q = quarters.get(t) ?? {}
        q[d.quarter] = (q[d.quarter] ?? 0) + 1
        quarters.set(t, q)
      }
    }
  }
  // Ingest's holder index: counts over every filer's latest full book. A page whose issuer it covers
  // gets exact holder counts and all-filer changes; ingest's publish gate keeps them >= the tracked funds.
  const hlIdx = (await read('hl/index.json').catch(() => null))?.tickers ?? {}
  const issuers = new Map() // issuer6 -> pages
  for (const t of per.keys()) {
    const code = hlIdx[t]
    if (code) (issuers.get(code) ?? issuers.set(code, []).get(code)).push(t)
  }
  const hlOf = new Map()
  const codes = [...issuers.keys()]
  for (let i = 0; i < codes.length; i += 48) {
    const part = await Promise.all(codes.slice(i, i + 48).map((c) => read(`hl/${c}.json`).then((d) => [c, d], () => null)))
    for (const x of part) if (x?.[1]?.counts) for (const t of issuers.get(x[0])) hlOf.set(t, x[1])
  }
  mkdirSync(join(out, 'd', 'h'), { recursive: true })
  // Titles name the newest quarter only once most filers have filed it; until then "latest 13Fs".
  const recent = filers.filter((f) => qn(f.quarter) >= newest - 1)
  const titleQuarter = recent.filter((f) => qn(f.quarter) === newest).length > recent.length / 2 ? toQ(newest) : null
  let files = 0
  let rowsOut = 0
  let exact = 0
  for (const [t, rows] of per) {
    rows.sort((a, b) => b[4] - a[4])
    const top = rows.slice(0, 500)
    rowsOut += top.length
    const h = hlOf.get(t)
    let hlc = null
    if (h) {
      const bp = h.counts.by_period ?? {}
      const cur = Object.entries(bp).filter(([q]) => qn(q) >= newest - 1).reduce((a, [, n]) => a + n, 0)
      const { new: nw, added, trimmed, exited, unchanged, no_prior } = h.counts
      hlc = { holders: cur, older: h.counts.holders - cur, quarters: bp, new: nw, added, trimmed, exited, unchanged, no_prior }
      exact++
    }
    const block = (x) => (x ? { current: x.current, older: x.older, top10: x.top10, over5: x.over5, quarters: x.quarters, moves: x.moves.sort((a, b) => Math.abs(b[4]) - Math.abs(a[4])).slice(0, 25) } : { current: 0, older: 0, top10: 0, over5: 0, quarters: {}, moves: [] })
    writeFileSync(
      join(out, 'd', 'h', `${t}.json`),
      JSON.stringify({
        ticker: t,
        filers: rows.length,
        current: current.get(t) ?? 0,
        tracked: tracked.get(t) ?? 0,
        quarters: quarters.get(t),
        top10: top10.get(t) ?? 0,
        over5: over5.get(t) ?? 0,
        ...(hlc ? { index: hlc } : {}),
        smart: block(lenses.smart.get(t)),
        hedge: block(lenses.hedge.get(t)),
        // lens: 1 hedge funds and long-only managers, 2 hedge funds (bits).
        columns: ['slug', 'name', 'quarter', 'shares', 'value', 'weight', 'tier', 'lens'],
        rows: top,
        generated_at: fl?.generated_at ?? index.generated_at,
      }),
    )
    files++
    // The page's tab title needs the same all-filer and hedge-fund counts as the prerendered title
    // (postbuild.mjs), without loading this file: copy them into the stock file.
    const sf = join(out, 'd', 'stocks', `${t}.json`)
    try {
      const s = JSON.parse(readFileSync(sf, 'utf8'))
      // The title leads with the superinvestors, so it names the quarter only once most of them have filed it
      // (GOOGL with 2 of 26 filed, or AAPL with 0 of 8, stays on "latest 13Fs").
      const sup = (s.holders ?? []).filter((h) => h.featured)
      const quarter = titleQuarter && (!sup.length || sup.filter((h) => h.quarter === titleQuarter).length > sup.length / 2) ? titleQuarter : null
      s.title_counts = { filers: hlc?.holders ?? current.get(t) ?? 0, hedge: lenses.hedge.get(t)?.current ?? 0, quarter }
      writeFileSync(sf, JSON.stringify(s))
    } catch {}
  }
  console.log(`all-filer holders: ${read_ok} filers, ${files} stocks (${exact} with full-book counts), ${rowsOut} rows (500 largest per stock); hedge funds and long-only hold ${lenses.smart.size} stocks, hedge funds ${lenses.hedge.size}`)
}
