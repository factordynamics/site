// Derives stock pages and the filing-season flow from the curated 13F books that copybook/ingest
// publishes (data/{slug}.json). Runs in the Pages build after vite (copybook-pages.yml).
// Usage: node scripts/stocks.mjs <out dir> [data base URL or dir]
// Writes <out>/d/stocks.json (search + directory index), <out>/d/stocks/{TICKER}.json and <out>/d/flow.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] || 'dist'
const base = process.argv[3] || process.env.VITE_DATA_BASE || 'https://refcell.github.io/gust/copybook/data/'
const read = async (f) =>
  base.startsWith('http') ? (await fetch(base + f).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${f}`))))) : JSON.parse(readFileSync(join(base, f), 'utf8'))

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
function flowFor(scope) {
  const slugs = new Set(scope.map((b) => b.slug))
  const flows = []
  for (const s of stocks.values()) {
    if (!s.classes.size) continue
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
  const n = 40
  // Ship the counts and the 12 largest funds on each side; the page needs no more than that.
  const trim = (rows) => rows.map((f) => ({ ...f, n_buyers: f.buyers.length, n_sellers: f.sellers.length, buyers: f.buyers.slice(0, 12), sellers: f.sellers.slice(0, 12) }))
  const out = {
    bought: [...flows].filter((f) => f.net_value > 0).sort((a, b) => b.net_value - a.net_value).slice(0, n),
    sold: [...flows].filter((f) => f.net_value < 0).sort((a, b) => a.net_value - b.net_value).slice(0, n),
    most_buyers: [...flows].filter((f) => f.buyers.length).sort((a, b) => b.buyers.length - a.buyers.length || b.buy_value - a.buy_value).slice(0, n),
    most_sellers: [...flows].filter((f) => f.sellers.length).sort((a, b) => b.sellers.length - a.sellers.length || a.sell_value - b.sell_value).slice(0, n),
    new_multi: [...flows].filter((f) => f.new_by.length >= 2 && !f.fresh).sort((a, b) => b.new_by.length - a.new_by.length || b.buy_value - a.buy_value).slice(0, n),
    fresh: [...flows].filter((f) => f.fresh && f.buyers.length >= 2).sort((a, b) => b.buyers.length - a.buyers.length).slice(0, 20),
  }
  for (const k of Object.keys(out)) out[k] = trim(out[k])
  return { funds: scope.length, ...out }
}
// One report period at a time: a fund counts in the period of its latest 13F, compared with its
// filing before. A fund that has already filed the next quarter is in that period, not this one.
const period = (q) => {
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
    featured: flowFor(filedQ.filter((b) => b.featured)),
    all: flowFor(filedQ),
  }
}
const periods = [period(season), period(season - 1)]
const flow = { ...periods[0], periods, generated_at: index.generated_at }
writeFileSync(join(out, 'd', 'flow.json'), JSON.stringify(flow))
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
      JSON.stringify({ ticker: t, filers: rows.length, quarters: quarters.get(t), columns: ['slug', 'name', 'quarter', 'shares', 'value', 'weight', 'tier'], rows: top, generated_at: fl?.generated_at ?? index.generated_at }),
    )
    files++
  }
  console.log(`all-filer holders: ${read_ok} filers, ${files} stocks, ${rowsOut} rows (500 largest per stock)`)
}
