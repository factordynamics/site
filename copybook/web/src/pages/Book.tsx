import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FailingBanner } from '../components/Channels'
import { Peers } from '../components/Peers'
import { UpgradePro } from '../components/UpgradePro'
import { FreeNames } from '../components/FreeNames'
import { TRIAL_DAYS } from '../config'
import { useSearch } from '../components/Search'
import { Arrow, Badge, Button, Lock, Panel, Skeleton, Stat } from '../components/ui'
import { ApiError, isFree, isPro, loadEvents, useMember, type IssuerEvent, type IssuerFeed, type Member } from '../lib/account'
import { quarterLabel, dateLabel, displayName, money, pct, sharesFmt, useAsync, useTitle } from '../lib/data'
import { addStocks, importBook, useFollows } from '../lib/follows'
import { loadFilerHolders, loadStock, resolveTicker, stockPath, type Stock, type StockHolder } from '../lib/stocks'

// My book (Copy Pro and Fund): crowding and filing-season activity in the names a member owns or
// watches, from the curated stock files the site already builds (d/stocks/{TICKER}.json).
type Row = {
  ticker: string
  name: string
  owned: boolean
  stock: Stock | null
  holders: number
  prev: number
  featured: number
  added: number
  exited: number
  top10: number
  over5: number
  filed: number
  filedOf: number
  bought: number
  sold: number
  net: number
  /** The insider line if there is one, else the holder line (sorting and the CSV's latest_* columns). */
  latest: Latest | null
  /** The largest open-market Form 4 trade at or above the threshold in the window (a fund's or a company insider's). */
  insider?: Latest | null
  /** The latest Schedule 13D/G in the window, passive index 13Gs left out. */
  holder?: Latest | null
  /** What an empty Form 4/13D cell means, or 'loading'. */
  empty?: string
  /** Insider Form 4s since the quarter end that aren't open-market trades above the threshold. */
  more?: number
  split: { ratio: string; adjusted: boolean } | null
  /** Counts are across every 13F filer, or its hedge funds and active managers; changes marked * are the tracked funds'. */
  all: boolean
  /** New, exited and the change in holders come from the full-book holder index (exact, no *). */
  exact: boolean
  /** All-filer counts asked for, but the filer index misses many of the funds we track: counts are a lower bound. */
  incomplete: boolean
  /** All 13F filers holding it whose latest filing is older than the previous quarter. */
  older: number
  /** The tracked funds' figures, kept for the CSV whatever the lens. */
  t: { holders: number; prev: number; top10: number; over5: number; filed: number; added: number; exited: number }
  /** Hedge funds and active managers, when loaded. */
  s: { holders: number; older: number; top10: number; over5: number; filed: number } | null
  /** Every filer's new and exited holders, from the full-book index. */
  ix: { new: number; exited: number } | null
  /** The all-filer figures, when loaded. */
  a: { holders: number; older: number; top10: number; over5: number; filed: number; incomplete: boolean } | null
}
type Key = 'ticker' | 'holders' | 'change' | 'added' | 'exited' | 'top10' | 'over5' | 'filed' | 'net' | 'latest'

const COLS: [Key, string, string][] = [
  ['ticker', 'Name', 'left'],
  ['holders', 'Funds', 'right'],
  ['change', 'vs last', 'right'],
  ['added', 'New', 'right'],
  ['exited', 'Exited', 'right'],
  ['top10', 'Top 10', 'right'],
  ['over5', 'Over 5%', 'right'],
  ['filed', 'Filed this season', 'right'],
  ['net', 'Net trades', 'right'],
  ['latest', 'Latest 4 / 13D', 'left'],
]

// smart: hedge funds and active managers (default); all: every 13F filer; tracked: the funds we track
// closely. smart and all read d/h/{TICKER}.json: ingest's full-book counts and crowding from the shards.
type Agg = Awaited<ReturnType<typeof loadFilerHolders>>
type Lens = 'smart' | 'all' | 'tracked'
const LENSES: [Lens, string][] = [
  ['smart', 'Hedge funds and active managers'],
  ['all', 'All 13F filers'],
  ['tracked', 'Funds we track'],
]

function rowFor(ticker: string, owned: boolean, stock: Stock | null, season: string, all: Agg | null = null, lens: Lens = 'all'): Row {
  const h: StockHolder[] = stock?.holders ?? []
  const ex: StockHolder[] = stock?.exited ?? []
  // Share changes in a quarter that looks like a split aren't trades: kept out of the counts and net.
  const split = stock?.splits?.[season] ?? null
  const filed = [...h, ...ex].filter((x) => x.quarter === season)
  const traded = split && !split.adjusted ? [] : filed
  const ev = stock?.since?.[0]
  const base = {
    owned,
    stock,
    holders: h.length,
    prev: h.filter((x) => x.prev_shares > 0).length + ex.length,
    featured: h.filter((x) => x.featured).length,
    added: h.filter((x) => x.change === 'new').length,
    exited: ex.length,
    top10: h.filter((x) => x.rank != null && x.rank <= 10).length,
    over5: h.filter((x) => x.weight > 0.05).length,
    filed: filed.length,
    filedOf: h.length + ex.length,
    bought: traded.filter((x) => x.change === 'new' || x.change === 'added').length,
    sold: traded.filter((x) => x.change === 'trimmed' || x.change === 'exited').length,
    net: traded.reduce((a, x) => a + (x.change && x.change !== 'unchanged' ? x.delta_value : 0), 0),
    split,
    latest: ev ? evLatest(ev) : null,
  }
  const t = { holders: base.holders, prev: base.prev, top10: base.top10, over5: base.over5, filed: base.filed, added: base.added, exited: base.exited }
  // Until ingest's holder index covers small and mid caps, it can miss funds we track that do hold
  // the stock (it was built from each filer's largest positions). Then the tracked counts are shown.
  // When it misses a quarter or more of them, the row shows the tracked counts; a smaller gap is
  // added back to the filer count, since those funds are known holders.
  const missing = all && all.tracked != null ? Math.max(0, h.length - all.tracked) : 0
  // Those tracked funds, by name, when the index shipped every row (otherwise a fund below row 500
  // could be counted twice, so only the count is added and crowding stays the index's).
  const inIndex = new Set(all?.rows.map((r) => r.slug))
  const gone = all && all.rows.length >= all.filers ? h.filter((x) => !inIndex.has(x.slug)) : []
  // The union of the index and the tracked holders: exact where the index is whole, a lower bound where it isn't.
  const a = all
    ? {
        holders: all.current + missing,
        older: all.filers - all.current,
        top10: (all.top10 ?? 0) + gone.filter((x) => x.rank != null && x.rank <= 10).length,
        over5: (all.over5 ?? 0) + gone.filter((x) => x.weight > 0.05).length,
        filed: (all.quarters?.[season] ?? 0) + gone.filter((x) => x.quarter === season).length,
        incomplete: all.current < h.length || missing > Math.max(2, h.length * 0.25),
      }
    : null
  // Ingest's holder index counts every filer's latest full book, so it is exact (its publish gate keeps
  // it at or above the tracked funds): no lower bound, and new and exited across every filer.
  const ix = all?.index
  const a2 = a && ix ? { ...a, holders: ix.holders, older: ix.older, filed: ix.quarters[season] ?? 0, incomplete: false } : a
  const sm = all?.smart
  const view =
    lens === 'smart' && sm
      ? { holders: sm.current, prev: NaN, older: sm.older, top10: sm.top10, over5: sm.over5, filed: sm.quarters[season] ?? 0, filedOf: sm.current, incomplete: false, exact: false }
      : lens === 'all' && a2
        ? { holders: a2.holders, prev: ix ? a2.holders - ix.new + ix.exited : NaN, older: a2.older, top10: a2.top10, over5: a2.over5, filed: a2.filed, filedOf: a2.holders, incomplete: a2.incomplete, exact: Boolean(ix), ...(ix ? { added: ix.new, exited: ix.exited } : {}) }
        : null
  return {
    ticker,
    name: stock?.name ?? '',
    ...base,
    t,
    a: a2,
    s: sm ? { holders: sm.current, older: sm.older, top10: sm.top10, over5: sm.over5, filed: sm.quarters[season] ?? 0 } : null,
    ix: ix ? { new: ix.new, exited: ix.exited } : null,
    all: Boolean(view),
    incomplete: false,
    older: 0,
    exact: false,
    ...(view ?? {}),
  }
}

const sortVal = (r: Row, k: Key) =>
  k === 'ticker' ? r.ticker : k === 'change' ? (Number.isNaN(r.prev) ? 0 : r.holders - r.prev) : k === 'filed' ? r.filed : k === 'latest' ? (r.latest?.date ?? '') : (r[k] as number)

export function Book() {
  useTitle('My book · Copybook')
  const member = useMember()
  const pro = isPro(member)
  const { status, follows } = useFollows()
  const names = useMemo(() => [...new Set([...follows.owned, ...follows.stocks])], [follows.owned, follows.stocks])
  const data = useAsync(() => (pro && names.length ? Promise.all(names.map((t) => loadStock(t).catch(() => null))) : Promise.resolve([])), [pro, names.join(',')])
  // Lens: hedge funds and active managers (default), every 13F filer, or the funds we track closely,
  // in the URL so a view can be shared.
  const [params, setParams] = useSearchParams()
  const lens: Lens = params.get('funds') === 'tracked' ? 'tracked' : params.get('funds') === 'all' ? 'all' : 'smart'
  const setLens = (l: Lens) => setParams(l === 'smart' ? {} : { funds: l }, { replace: true })
  const events = useAsync(() => (names.length ? loadEvents(names) : Promise.resolve(new Map<string, IssuerFeed>())), [names.join(',')])
  // The CSV keeps the all-filer figures whatever the lens, so d/h is loaded once for every lens.
  const agg = useAsync(() => (pro && names.length ? Promise.all(names.map((t) => loadFilerHolders(t).catch(() => null))) : Promise.resolve([])), [pro, names.join(',')])
  const ready = Boolean(data.data && agg.data)
  // Names that came from a linked 13F, as opposed to ones added by hand.
  const linked = useMemo(() => {
    const manual = new Set(follows.owned_manual ?? [])
    return new Set((follows.book?.tickers ?? []).filter((t) => !manual.has(t)))
  }, [follows.book, follows.owned_manual])
  const [sort, setSort] = useState<{ k: Key; desc: boolean }>({ k: 'holders', desc: true })

  // The newest quarter any of these funds has filed: the season under way.
  const season = useMemo(() => {
    const qs = (data.data ?? []).flatMap((s) => s?.quarters ?? [])
    return qs.sort().at(-1) ?? ''
  }, [data.data])
  const rows = useMemo(() => {
    const r = names.map((t, i) => {
      const n = newest(data.data?.[i] ?? null, events.data?.get(t), follows.insider_min_usd, season, events.loading)
      return { ...rowFor(t, follows.owned.includes(t), data.data?.[i] ?? null, season, agg.data?.[i] ?? null, lens), latest: n.latest, insider: n.insider, holder: n.holder, empty: n.empty, more: n.more }
    })
    const dir = sort.desc ? -1 : 1
    return r.sort((a, b) => {
      const x = sortVal(a, sort.k)
      const y = sortVal(b, sort.k)
      return (x < y ? -1 : x > y ? 1 : 0) * dir || a.ticker.localeCompare(b.ticker)
    })
  }, [names, follows.owned, follows.insider_min_usd, data.data, agg.data, events.data, events.loading, lens, season, sort])

  // What the funds that have filed this season did in these names, largest first. Under the smart-money
  // lens: each hedge fund's and active manager's ten largest buys and sells (from its 13F shard).
  const moves = useMemo(() => {
    const ok = (r: Row) => !(r.split && !r.split.adjusted)
    const list =
      lens === 'smart'
        ? rows.flatMap((r) => {
            const sm = ok(r) ? agg.data?.[names.indexOf(r.ticker)]?.smart?.moves : null
            return (sm ?? []).filter((m) => m.quarter === season && m.change !== 'unchanged' && m.delta_value).map((m) => ({ r, x: { slug: m.slug, manager: m.name, change: m.change, delta_value: m.delta_value } }))
          })
        : rows.flatMap((r) => (ok(r) ? [...(r.stock?.holders ?? []), ...(r.stock?.exited ?? [])] : []).filter((x) => x.quarter === season && x.change && x.change !== 'unchanged' && x.delta_value).map((x) => ({ r, x: { slug: x.slug, manager: x.manager, change: x.change!, delta_value: x.delta_value } })))
    return list.sort((a, b) => Math.abs(b.x.delta_value) - Math.abs(a.x.delta_value)).slice(0, 12)
  }, [rows, season, lens, agg.data, names])
  // Every name has the full-book holder index: new and exited are exact across every filer.
  const exactAll = ready && rows.length > 0 && rows.every((r) => !r.stock || r.exact || lens !== 'all')
  const fundsFiled = new Set(rows.flatMap((r) => [...(r.stock?.holders ?? []), ...(r.stock?.exited ?? [])].filter((x) => x.quarter === season).map((x) => x.slug))).size
  const fundsAll = new Set(rows.flatMap((r) => [...(r.stock?.holders ?? []), ...(r.stock?.exited ?? [])].map((x) => x.slug))).size

  // Deep links from the Fund setup list (#book-import, #link-fund, #peers): scroll once the table is in.
  const jumped = useRef(false)
  useEffect(() => {
    const id = location.hash.slice(1)
    if (!id || jumped.current || !(ready || (status === 'ready' && !names.length))) return
    jumped.current = true
    requestAnimationFrame(() => {
      const el = document.getElementById(id)
      el?.scrollIntoView({ block: el.tagName === 'SECTION' ? 'start' : 'center' })
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus({ preventScroll: true })
    })
  }, [ready, status, names.length])

  // Copy members get My book lite: their own names against the superinvestors and tracked funds.
  if (!pro && member?.active && member.plan !== 'holdterm') return <LiteBook member={member} />
  // Free accounts keep 5 names, each with one public fact; the rest of My book is Copy.
  if (isFree(member))
    return (
      <div className="container-x pt-12 md:pt-16">
        <Header eyebrow="My book · Free" sub="Save up to 5 stocks you own and see what the superinvestors did in them. Copy shows every fund holding them, their weights, insider trades and alerts." />
        <FreeNames className="mt-10 max-w-3xl" />
      </div>
    )
  if (!pro)
    return (
      <div className="container-x pt-12 md:pt-16">
        <Header eyebrow="My book · Copy" sub="Which superinvestors hold the stocks you own or watch, what they did this season, and the latest Form 4 and 13D on each." />
        <section className="relative mt-10 overflow-hidden rounded-[var(--radius-card)] bg-card p-8 shadow-[var(--shadow-card)]">
          <div className="pointer-events-none select-none blur-[3px]" aria-hidden="true">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="mt-4 h-64 w-full" />
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-card/60 p-6 text-center">
            <Lock />
            <p className="mt-3 max-w-md text-[16px] font-semibold">{isFree(member) ? 'This is a Copy feature.' : 'My book is part of Copy.'}</p>
            <p className="mt-1.5 max-w-md text-[14px] text-ink-2">See which superinvestors hold the stocks you own or watch, what they did this filing season, and the latest Form 4 and 13D on each. Copy Pro adds every 13F filer, crowding, peers and CSV.</p>
            <Button to="/pricing/" className="mt-5">
              {isFree(member) ? `Start ${TRIAL_DAYS}-day trial` : 'Compare plans'} <Arrow />
            </Button>
          </div>
        </section>
      </div>
    )

  const csv = () => {
    // Every column names whose figures it holds: all 13F filers or the funds we track closely.
    const head = ['ticker', 'name', 'owned', 'holders_all', 'holders_all_min', 'holders_all_older_filings', 'all_filer_count_incomplete', 'top10_all', 'top10_all_min', 'over_5pct_all', 'over_5pct_all_min', `filed_${season}_all`, `filed_${season}_all_min`, 'new_all', 'exited_all', 'holders_smart', 'holders_smart_older_filings', 'top10_smart', 'over_5pct_smart', `filed_${season}_smart`, 'holders_tracked', 'holders_tracked_last_13f', 'superinvestors', 'new_tracked', 'exited_tracked', 'top10_tracked', 'over_5pct_tracked', `filed_${season}_tracked`, 'bought_tracked', 'sold_tracked', 'net_usd_tracked', 'split', 'latest_form', 'latest_date', 'latest_filer', 'latest_action', 'latest_value_usd', 'latest_pct_change', 'latest_accession', 'holder_form', 'holder_date', 'holder_filer', 'holder_line', 'holder_accession']
    const q = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
    const body = rows.map((r) =>
      [
        r.ticker, r.name, r.owned ? 'owned' : 'watched',
        // Incomplete rows leave the exact columns blank and fill only the _min (lower bound) ones, so a sum never undercounts silently.
        ...(r.a ? [r.a.incomplete ? '' : r.a.holders, r.a.holders, r.a.older, r.a.incomplete ? 'true' : 'false', r.a.incomplete ? '' : r.a.top10, r.a.top10, r.a.incomplete ? '' : r.a.over5, r.a.over5, r.a.incomplete ? '' : r.a.filed, r.a.filed] : ['', '', '', '', '', '', '', '', '', '']),
        r.ix?.new ?? '', r.ix?.exited ?? '',
        ...(r.s ? [r.s.holders, r.s.older, r.s.top10, r.s.over5, r.s.filed] : ['', '', '', '', '']),
        r.t.holders, r.t.prev, r.featured, r.t.added, r.t.exited, r.t.top10, r.t.over5, r.t.filed,
        r.split && !r.split.adjusted ? '' : r.bought, r.split && !r.split.adjusted ? '' : r.sold, r.split && !r.split.adjusted ? '' : Math.round(r.net),
        r.split ? `${r.split.ratio} ${r.split.adjusted ? 'adjusted' : 'not counted'}` : '',
        r.latest?.form ?? '', r.latest?.date ?? '', r.latest?.manager ?? '',
        r.latest?.action ?? '', r.latest?.value != null ? Math.round(Math.abs(r.latest.value)) : '', r.latest?.pct != null ? (r.latest.pct * 100).toFixed(2) : '', dashed(r.latest?.accession),
        r.holder?.form ?? '', r.holder?.date ?? '', r.holder?.manager ?? '', r.holder?.line ?? '', dashed(r.holder?.accession),
      ].map(q).join(','),
    )
    const url = URL.createObjectURL(new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `copybook-my-book-${new Date().toISOString().slice(0, 10)}.csv` })
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="container-x pt-12 md:pt-16">
      <Header
        right={
          rows.length > 0 && (
            // The CSV carries the same Form 4/13D column as the page, so it waits for those filings.
            <Button variant="outline" size="sm" onClick={csv} disabled={events.loading || !ready}>
              {events.loading || !ready ? 'Loading filings…' : 'Export CSV'}
            </Button>
          )
        }
      />
      <FailingBanner initial={member?.channels_failing} />

      {status === 'ready' && names.length === 0 ? (
        <Panel className="mt-8" title="Add the names you own or watch">
          <p className="text-[14px] text-ink-2">Paste tickers or a CSV below, or press Follow on any stock page.</p>
          <Import />
        </Panel>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 gap-6 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:grid-cols-4 md:p-6">
            <Stat label="Names in your book" value={names.length} sub={`${follows.owned.length} owned, ${names.length - follows.owned.length} watched`} />
            {lens !== 'tracked' ? (
              <>
                <Stat
                  label={season ? `Filed ${quarterLabel(season)} so far` : 'Filed so far'}
                  value={ready ? `${Math.round((rows.reduce((a, r) => a + r.filed, 0) / Math.max(1, rows.reduce((a, r) => a + r.filedOf, 0))) * 100)}%` : '—'}
                  sub={lens === 'smart' ? 'of the hedge funds and active managers holding your names' : 'of the 13F holders of your names'}
                />
                {(() => {
                  const top = ready ? [...rows].sort((a, b) => b.top10 / Math.max(1, b.holders) - a.top10 / Math.max(1, a.holders))[0] : null
                  return <Stat label="Most crowded name" value={top ? top.ticker : '—'} sub={top ? `in ${top.top10.toLocaleString('en-US')} of its ${top.holders.toLocaleString('en-US')} holders’ top 10` : 'share of holders with it in their top 10'} />
                })()}
              </>
            ) : (
              <>
                <Stat label={season ? `Filed ${quarterLabel(season)} so far` : 'Filed so far'} value={data.data ? `${fundsFiled} of ${fundsAll}` : '—'} sub="funds that hold your names" />
                <Stat label="Crowded names" value={data.data ? rows.filter((r) => r.top10 >= 3).length : '—'} sub="in 3 or more funds’ top 10" />
              </>
            )}
            <Stat
              label="Their net trades this season"
              value={data.data ? <span className={moves.length ? (rows.reduce((a, r) => a + r.net, 0) >= 0 ? 'text-up' : 'text-down') : ''}>{signed(rows.reduce((a, r) => a + r.net, 0))}</span> : '—'}
              sub={lens !== 'tracked' ? 'by the funds we track closely, at quarter-end value' : 'in your names, at quarter-end value'}
            />
          </div>

          <section className="mt-6 overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
            <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
              <div className="max-w-2xl">
                <h2 className="text-[15px] font-semibold">Your names</h2>
                <p className="text-[13px] text-ink-3">
                  {lens === 'smart'
                    ? 'Funds, top 10, over 5% and filed count the hedge funds and active managers among all 13F filers (types from EDGAR filings), whose latest filing is for this quarter or last; older filings are shown apart. Columns marked * (new, exited, bought, sold, net) cover the funds we track closely.'
                    : lens === 'all'
                      ? `Funds, ${exactAll ? 'vs last, new, exited, ' : ''}top 10, over 5% and filed count every 13F filer, from each one’s latest full 13F for this quarter or last; older filings are shown apart. Columns marked * (${exactAll ? '' : 'new, exited, '}bought, sold, net) cover the funds we track closely.`
                      : 'Among the funds we track closely, from each one’s latest 13F.'}{' '}
                  Click a column to sort.
                </p>
              </div>
              <div className="inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Which funds">
                {LENSES.map(([l, label]) => (
                  <button key={l} type="button" role="tab" aria-selected={lens === l} onClick={() => setLens(l)} className={`rounded-full px-3 py-1.5 ${lens === l ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </header>
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Your names">
              <table className="w-full min-w-[960px] text-[13.5px]">
                <thead>
                  <tr className="border-b border-line text-[12.5px] text-ink-3">
                    {COLS.map(([k, l, align]) => (
                      <th key={k} aria-sort={sort.k === k ? (sort.desc ? 'descending' : 'ascending') : 'none'} className={`whitespace-nowrap px-3 py-2.5 font-medium first:pl-5 last:pr-5 md:first:pl-6 md:last:pr-6 ${align === 'right' ? 'text-right' : 'text-left'}`}>
                        <button type="button" onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : k !== 'ticker' }))} className="inline-flex items-center gap-1 hover:text-ink">
                          {k === 'filed' && season ? `Filed ${quarterLabel(season).split(' ')[0]}` : l}
                          {lens !== 'tracked' && (k === 'net' || ((k === 'added' || k === 'exited') && !(lens === 'all' && exactAll))) && '*'}
                          <span aria-hidden="true" className={sort.k === k ? 'text-ink' : 'opacity-0'}>
                            {sort.desc ? '↓' : '↑'}
                          </span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!ready &&
                    names.slice(0, 6).map((t) => (
                      <tr key={t}>
                        <td colSpan={COLS.length} className="px-6 py-2.5">
                          <Skeleton className="h-6 w-full" />
                        </td>
                      </tr>
                    ))}
                  {ready &&
                    rows.map((r) => {
                      const d = r.holders - r.prev
                      return (
                        <tr key={r.ticker} className="border-b border-line last:border-0 hover:bg-ink/[0.025]">
                          <td className="px-3 py-2.5 pl-5 md:pl-6">
                            <span className="flex items-center gap-2">
                              <Link to={stockPath(r.ticker)} className="font-mono text-[13px] font-semibold hover:text-accent">
                                {r.ticker}
                              </Link>
                              <span className="max-w-[6rem] truncate text-ink-2" title={r.name}>{r.name}</span>
                              {r.owned ? <Badge tone="accent" className="whitespace-nowrap">{linked.has(r.ticker) ? 'Owned · 13F' : 'Owned'}</Badge> : <Badge className="whitespace-nowrap">Watched</Badge>}
                            </span>
                          </td>
                          {r.stock || r.all ? (
                            <>
                              <td className="num whitespace-nowrap px-3 py-2.5 text-right font-medium">
                                {r.incomplete && <span title="At least: every filer the index lists, plus the funds we track closely that it misses">≥ </span>}
                                {r.holders.toLocaleString('en-US')}
                                {r.featured > 0 && <span className="block text-[12px] font-normal text-ink-3">{r.featured} super</span>}
                                {r.older > 0 && <span className="block text-[12px] font-normal text-ink-3" title={`${r.older.toLocaleString('en-US')} more filers hold it on a 13F older than last quarter`}>+{r.older.toLocaleString('en-US')} older</span>}
                                {r.incomplete && (
                                  <span className="ml-auto block max-w-[6.5rem] whitespace-normal text-[11.5px] font-normal leading-tight text-[#8a5a0b]" title="The all-filer index misses some funds that hold this stock. Counts are every filer it lists plus the funds we track closely that it misses, so the true numbers can be higher">
                                    All-filer count incomplete
                                  </span>
                                )}
                              </td>
                              <td className={`num px-3 py-2.5 text-right ${d > 0 ? 'text-up' : d < 0 ? 'text-down' : 'text-ink-3'}`} title={Number.isNaN(d) ? 'Needs every filer’s prior quarter' : r.exact ? 'Holders gained minus lost since each filer’s previous 13F' : undefined}>{Number.isNaN(d) ? '—' : d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0'}</td>
                              <td className="num px-3 py-2.5 text-right">{r.added || <span className="text-ink-3">0</span>}</td>
                              <td className="num px-3 py-2.5 text-right">{r.exited || <span className="text-ink-3">0</span>}</td>
                              <td className="num px-3 py-2.5 text-right">{r.top10 ? r.top10.toLocaleString('en-US') : <span className="text-ink-3">0</span>}</td>
                              <td className="num px-3 py-2.5 text-right">{r.over5 ? r.over5.toLocaleString('en-US') : <span className="text-ink-3">0</span>}</td>
                              <td className="num px-3 py-2.5 text-right text-ink-2">
                                {r.filed.toLocaleString('en-US')} of {r.filedOf.toLocaleString('en-US')}
                                {r.filed > 0 && (
                                  <span className="block whitespace-nowrap text-[12px] text-ink-3">
                                    {r.split && !r.split.adjusted ? `Possible ${r.split.ratio} split` : `${r.bought} bought · ${r.sold} sold${r.all ? '*' : ''}`}
                                  </span>
                                )}
                              </td>
                              <td className={`num px-3 py-2.5 text-right font-medium ${r.net > 0 ? 'text-up' : r.net < 0 ? 'text-down' : 'text-ink-3'}`}>{r.split && !r.split.adjusted ? (
                                  <span className="text-[12.5px] font-normal">Not counted</span>
                                ) : (
                                  <>
                                    {r.filed ? signed(r.net) : '—'}
                                    {r.split && <span className="block whitespace-nowrap text-[11.5px] font-normal text-ink-3">Split {r.split.ratio}, adjusted</span>}
                                  </>
                                )}</td>
                              <td className="px-3 py-2.5 pr-5 text-[12.5px] md:pr-6">
                                <EventsCell r={r} w="max-w-[10rem]" />
                              </td>
                            </>
                          ) : (
                            <td colSpan={COLS.length - 1} className="px-3 py-2.5 pr-6 text-[13px] text-ink-3">
                              None of the funds we track closely hold it.{' '}
                              <Link to={`${stockPath(r.ticker)}?funds=filers`} className="font-medium text-accent hover:text-accent-2">
                                See all 13F filers
                              </Link>
                            </td>
                          )}
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <Panel
              title={season ? `What they did in your names, ${quarterLabel(season)}` : 'What they did in your names'}
              sub={lens === 'smart' ? 'Largest moves this season by hedge funds and active managers (each one’s ten largest buys and sells), valued at quarter-end' : lens === 'all' ? 'Largest moves by the funds we track closely that have filed this season, valued at quarter-end. Other filers’ moves appear once their prior quarter is on file.' : 'Largest moves by funds that have filed this season, valued at quarter-end'}
            >
              {!data.data ? (
                <Skeleton className="h-48 w-full" />
              ) : moves.length ? (
                <ul className="divide-y divide-line">
                  {moves.map(({ r, x }) => (
                    <li key={r.ticker + x.slug} className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
                      <span className="flex min-w-0 items-center gap-2">
                        <Badge tone={x.delta_value >= 0 ? 'up' : 'down'}>{x.change}</Badge>
                        <Link to={stockPath(r.ticker)} className="font-mono text-[13px] font-semibold hover:text-accent">
                          {r.ticker}
                        </Link>
                        <Link to={`/investors/${x.slug}/`} className="truncate text-ink-2 hover:text-accent">
                          {x.manager}
                        </Link>
                      </span>
                      <span className={`num shrink-0 font-medium ${x.delta_value >= 0 ? 'text-up' : 'text-down'}`}>{signed(x.delta_value)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[14px] text-ink-2">No fund that has filed {season ? quarterLabel(season) : 'this season'} has traded your names yet.</p>
              )}
            </Panel>
            <Panel title="Add names" sub="Paste tickers, or a broker CSV with a Ticker or Symbol column">
              <Import />
            </Panel>
          </div>
          <p className="mt-6 text-[13px] leading-relaxed text-ink-3">
            {lens === 'smart' ? 'Holder counts cover the hedge funds and active managers among every 13F filer; new, exited and trades cover the funds we track closely' : lens === 'all' ? `Holder counts${exactAll ? ', new and exited' : ''} cover every 13F filer’s latest full filing; ${exactAll ? '' : 'new, exited and '}trades cover the funds we track closely` : 'Counts cover the funds we track closely, from each one’s latest 13F'}; “super” counts the superinvestors among them. {`“In a top 10” means one of the fund’s ten largest share positions. Latest 4 / 13D covers filings since ${windowLabel(windowStart(season))}, the latest 13F period end: open-market Form 4 trades from your insider threshold and Schedule 13D/Gs; passive index 13Gs (BlackRock, Vanguard, State Street and the like) are hidden. Your book is private to you and never used in aggregates. % of shares outstanding arrives with a later data release.`}
          </p>
        </>
      )}
      <Peers names={names} shared={member?.plan === 'fund'} />
    </div>
  )
}

function Header({ right, eyebrow = 'My book · Copy Pro and Copy Fund', sub = 'Crowding, this season’s buying and selling, and the latest insider and 13D filings in the stocks you own or watch.' }: { right?: React.ReactNode; eyebrow?: string; sub?: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">{eyebrow}</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Who owns what you own.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">{sub}</p>
      </div>
      {right}
    </header>
  )
}

// My book lite (Copy): the member's own names against the superinvestors and the funds we track
// closely, from the public stock files. All-filer counts, peers, 13F linking, CSV and the API are Pro.
type LiteLens = 'super' | 'tracked'
function LiteBook({ member }: { member: Member }) {
  const { status, follows } = useFollows()
  const [params, setParams] = useSearchParams()
  const lens: LiteLens = params.get('funds') === 'tracked' ? 'tracked' : 'super'
  const linkedOnly = useMemo(() => {
    const manual = new Set(follows.owned_manual ?? [])
    return new Set((follows.book?.tickers ?? []).filter((t) => !manual.has(t)))
  }, [follows.book, follows.owned_manual])
  // Hand-added names only: a linked 13F book is a Pro feature.
  const names = useMemo(() => [...new Set([...follows.owned, ...follows.stocks])].filter((t) => !linkedOnly.has(t)), [follows.owned, follows.stocks, linkedOnly])
  const data = useAsync(() => (names.length ? Promise.all(names.map((t) => loadStock(t).catch(() => null))) : Promise.resolve([])), [names.join(',')])
  const season = useMemo(() => (data.data ?? []).flatMap((x) => x?.quarters ?? []).sort().at(-1) ?? '', [data.data])
  const events = useAsync(() => (names.length ? loadEvents(names) : Promise.resolve(new Map<string, IssuerFeed>())), [names.join(',')])
  const rows = useMemo(
    () =>
      names
        .map((t, i) => {
          const st = data.data?.[i] ?? null
          const inLens = (x: StockHolder) => lens === 'tracked' || x.featured
          const held = (st?.holders ?? []).filter(inLens).sort((a, b) => b.weight - a.weight)
          const split = st?.splits?.[season] ?? null
          const moves = split && !split.adjusted ? [] : [...(st?.holders ?? []), ...(st?.exited ?? [])].filter((x) => inLens(x) && x.quarter === season && x.change && x.change !== 'unchanged')
          return {
            ticker: t,
            name: st?.name ?? '',
            owned: follows.owned.includes(t),
            stock: st,
            held,
            others: lens === 'super' ? (st?.holders.length ?? 0) - held.length : 0,
            split,
            moves,
            bought: moves.filter((x) => x.change === 'new' || x.change === 'added').length,
            sold: moves.filter((x) => x.change === 'trimmed' || x.change === 'exited').length,
            net: moves.reduce((a, x) => a + x.delta_value, 0),
            ...(() => {
              const n = newest(st, events.data?.get(t), follows.insider_min_usd, season, events.loading)
              return { latest: n.latest, insider: n.insider, holder: n.holder, empty: n.empty, more: n.more }
            })(),
          }
        })
        .sort((a, b) => b.held.length - a.held.length || (b.stock?.holders.length ?? 0) - (a.stock?.holders.length ?? 0) || a.ticker.localeCompare(b.ticker)),
    [names, data.data, events.data, events.loading, lens, season, follows.owned, follows.insider_min_usd],
  )
  const moves = rows
    .flatMap((r) => r.moves.map((x) => ({ r, x })))
    .sort((a, b) => Math.abs(b.x.delta_value) - Math.abs(a.x.delta_value))
    .slice(0, 10)
  const lensName = lens === 'super' ? 'superinvestors' : 'funds we track closely'
  const pro = <UpgradePro member={member} className="mt-6" />

  return (
    <div className="container-x pt-12 md:pt-16">
      <Header eyebrow="My book · Copy" sub="Which superinvestors hold the stocks you own or watch, what they did this season, and their latest Form 4 and 13D filings." />
      <FailingBanner initial={member.channels_failing} />

      {status === 'ready' && names.length === 0 ? (
        <Panel className="mt-8" title="Add the names you own or watch">
          <p className="text-[14px] text-ink-2">Paste tickers below, or press Follow on any stock page.</p>
          <Import link={false} />
        </Panel>
      ) : (
        <>
          <section className="mt-8 rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
              <div className="max-w-2xl">
                <h2 className="text-[15px] font-semibold">Your names</h2>
                <p className="text-[13px] text-ink-3">Who among the {lensName} holds each name, at what weight of their book, and what they did {season ? `in ${quarterLabel(season)}` : 'this season'}. From each fund’s latest 13F.</p>
              </div>
              <div className="inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Which funds">
                {(['super', 'tracked'] as const).map((l) => (
                  <button key={l} type="button" role="tab" aria-selected={lens === l} onClick={() => setParams(l === 'super' ? {} : { funds: l }, { replace: true })} className={`rounded-full px-3 py-1.5 ${lens === l ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                    {l === 'super' ? 'Superinvestors' : 'Funds we track closely'}
                  </button>
                ))}
                <Link to="/upgrade/?plan=pro" aria-describedby="pro-title" title="Part of Copy Pro" className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-ink-3 hover:text-ink-2">
                  <Lock /> All 13F filers
                </Link>
              </div>
            </div>
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Your names">
              <table className="w-full min-w-[860px] text-[13.5px]">
                <thead>
                  <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                    <th className="px-3 py-2.5 pl-5 font-medium md:pl-6">Name</th>
                    <th className="px-3 py-2.5 text-right font-medium">{lens === 'super' ? 'Superinvestors' : 'Funds'}</th>
                    <th className="px-3 py-2.5 font-medium">Largest holders, weight in their book</th>
                    <th className="px-3 py-2.5 font-medium">{season ? quarterLabel(season) : 'This season'}</th>
                    <th className="px-3 py-2.5 pr-5 font-medium md:pr-6">Latest Form 4 / 13D</th>
                  </tr>
                </thead>
                <tbody>
                  {!data.data
                    ? Array.from({ length: Math.min(6, names.length || 4) }, (_, i) => (
                        <tr key={i} className="border-b border-line last:border-0">
                          <td colSpan={5} className="px-5 py-3 md:px-6">
                            <Skeleton className="h-5 w-full" />
                          </td>
                        </tr>
                      ))
                    : rows.map((r) => (
                        <tr key={r.ticker} className="border-b border-line align-top last:border-0 hover:bg-ink/[0.025]">
                          <td className="px-3 py-3 pl-5 md:pl-6">
                            <span className="flex items-center gap-2">
                              <Link to={stockPath(r.ticker)} className="font-mono text-[13px] font-semibold hover:text-accent">
                                {r.ticker}
                              </Link>
                              <span className="max-w-[8rem] truncate text-ink-2" title={r.name}>
                                {r.name}
                              </span>
                              {r.owned ? <Badge tone="accent">Owned</Badge> : <Badge>Watched</Badge>}
                            </span>
                          </td>
                          <td className="num whitespace-nowrap px-3 py-3 text-right font-medium">
                            {r.held.length}
                            {r.others > 0 && <span className="block text-[12px] font-normal text-ink-3">+{r.others} tracked</span>}
                          </td>
                          <td className="px-3 py-3">
                            {r.held.length ? (
                              <span className="flex flex-wrap gap-x-3 gap-y-1">
                                {r.held.slice(0, 3).map((x) => (
                                  <Link key={x.slug} to={`/investors/${x.slug}/`} className="whitespace-nowrap hover:text-accent">
                                    {displayName(x.manager)} <span className="num text-ink-3">{x.weight > 0 && x.weight < 0.0005 ? '<0.1%' : pct(x.weight)}</span>
                                  </Link>
                                ))}
                                {r.held.length > 3 && (
                                  <Link to={stockPath(r.ticker)} className="text-ink-3 hover:text-accent">
                                    +{r.held.length - 3} more
                                  </Link>
                                )}
                              </span>
                            ) : (
                              <span className="text-ink-3">{r.stock ? `None of the ${lensName}` : 'Not held by the funds we track'}</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3">
                            {r.split && !r.split.adjusted ? (
                              <span className="text-[12.5px] text-[#8a5a0b]">Possible {r.split.ratio} split, not counted</span>
                            ) : r.moves.length ? (
                              <>
                                <span className={`num font-medium ${r.net > 0 ? 'text-up' : r.net < 0 ? 'text-down' : 'text-ink-3'}`}>{signed(r.net)}</span>
                                <span className="block text-[12px] text-ink-3">
                                  {r.bought} bought · {r.sold} sold
                                </span>
                              </>
                            ) : (
                              <span className="text-ink-3">No moves yet</span>
                            )}
                          </td>
                          <td className="px-3 py-3 pr-5 text-[12.5px] md:pr-6">
                            <EventsCell r={r} w="max-w-[14rem]" />
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <Panel title={season ? `What the ${lensName} did in your names, ${quarterLabel(season)}` : `What the ${lensName} did in your names`} sub="Largest moves by the funds that have filed this season, valued at quarter-end">
              {!data.data ? (
                <Skeleton className="h-48 w-full" />
              ) : moves.length ? (
                <ul className="divide-y divide-line">
                  {moves.map(({ r, x }) => (
                    <li key={r.ticker + x.slug} className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
                      <span className="flex min-w-0 items-center gap-2">
                        <Badge tone={x.delta_value >= 0 ? 'up' : 'down'}>{x.change}</Badge>
                        <Link to={stockPath(r.ticker)} className="font-mono text-[13px] font-semibold hover:text-accent">
                          {r.ticker}
                        </Link>
                        <Link to={`/investors/${x.slug}/`} className="truncate text-ink-2 hover:text-accent">
                          {displayName(x.manager)}
                        </Link>
                      </span>
                      <span className={`num shrink-0 font-medium ${x.delta_value >= 0 ? 'text-up' : 'text-down'}`}>{signed(x.delta_value)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[14px] text-ink-2">None of the {lensName} that have filed {season ? quarterLabel(season) : 'this season'} traded your names yet.</p>
              )}
            </Panel>
            <Panel title="Add names" sub="Paste tickers, or a broker CSV with a Ticker or Symbol column">
              <Import link={false} />
            </Panel>
          </div>
          {pro}
          <p className="mt-6 text-[13px] leading-relaxed text-ink-3">From each fund’s latest 13F as filed with the SEC, and Form 4 and Schedule 13D/G filings since (passive index 13Gs, such as BlackRock’s and Vanguard’s, are hidden). Weight is the position’s share of that fund’s 13F stock holdings. Your list is private to you and never used in aggregates. Not investment advice.</p>
        </>
      )}
    </div>
  )
}

// The latest fund Form 4 or 13D/G on a name, in a line: "Warren Buffett bought $26.9M (+0.7%)".
type Latest = {
  form: string
  date: string
  manager: string
  line: string
  url: string
  /** For the CSV: bought, sold, traded, 13D or 13G; the dollar size and % change in the holder's shares where known. */
  action: string
  value: number | null
  pct: number | null
  accession: string
}
type StockEv = NonNullable<Stock['since']>[number]
const pctChange = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x) < 0.1 ? (Math.abs(x) * 100).toFixed(1) : Math.round(Math.abs(x) * 100)}%`
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
// Action and amount first, then who: "Sold $5.5M · Hai Ling, CFO", so a narrow cell drops the name, not the number.
function evLatest(e: StockEv): Latest {
  const who = displayName(e.manager)
  const sched = /13G/i.test(e.form) ? '13G' : '13D'
  let what: string
  let pct: number | null = null
  if (e.kind === 'form4') {
    const verb = e.action === 'buy' ? 'bought' : e.action === 'sell' ? 'sold' : 'traded'
    const size = e.value_usd ? money(Math.abs(e.value_usd)) : e.shares ? `${sharesFmt(Math.abs(e.shares))} shares` : ''
    const prev = e.prev_shares_after
    const chg = prev && e.shares_after != null ? e.shares_after / prev - 1 : null
    if (chg != null && Number.isFinite(chg)) pct = chg
    what = `${cap(verb)}${size ? ` ${size}` : ''}${pct != null ? ` (${pctChange(pct)})` : ''}`
  } else {
    const p = e.percent_of_class
    what =
      e.action === 'new_stake'
        ? `New ${p != null ? `${p}% ` : ''}stake`
        : e.action === 'below_threshold'
          ? 'Below 5%'
          : e.prev_percent_of_class != null && p != null
            ? `${e.prev_percent_of_class}% → ${p}%`
            : p != null
              ? `→ ${p}%`
              : 'Amended'
  }
  const action = e.kind === 'form4' ? (e.action === 'buy' ? 'bought' : e.action === 'sell' ? 'sold' : 'traded') : sched
  return { form: e.form, date: e.filing_date, manager: who, line: `${what} · ${who}`, url: e.url, action, value: e.kind === 'form4' ? (e.value_usd ?? null) : null, pct, accession: accNo(e.url) }
}

// Insider names arrive surname-first ("Jain Ajit"); people read first-last. Entities stay as filed.
const ENTITY = /\b(inc|llc|l\.?p|corp|co|ltd|plc|trust|fund|funds|capital|management|partners|group|holdings|hathaway|advisors|bank|n\.?a|sa|ag|se)\b\.?/i
function personName(raw: string) {
  const name = displayName(raw)
  const parts = name.split(/\s+/)
  return ENTITY.test(name) || parts.length < 2 || parts.length > 4 ? name : [...parts.slice(1), parts[0]].join(' ')
}
const VERB: Partial<Record<IssuerEvent['action'], string>> = { buy: 'bought', sell: 'sold', mixed: 'traded', grant: 'granted', option_exercise: 'exercised options on', tax_withholding: 'withheld for tax', gift: 'gifted', conversion: 'converted' }
/** An option exercise (M) and an open-market sale (S) on the same day in one Form 4. */
const exerciseAndSale = (e: IssuerEvent) => {
  const tx = (e.transactions ?? []).filter((t) => !t.derivative)
  return tx.some((m) => m.code === 'M' && tx.some((x) => x.code === 'S' && x.date === m.date))
}
export function issuerLatest(e: IssuerEvent): Latest {
  const lead = e.filer_name.replace(/ and (\d+) others?$/i, '')
  const more = e.filer_name.slice(lead.length)
  const who = (e.role ? personName(lead) : displayName(lead)) + more
  const role = e.role ? `, ${e.role.split(',')[0].trim()}` : ''
  const sched = /13G/i.test(e.form) ? '13G' : '13D'
  let what: string
  let pct: number | null = null
  const f4 = /^4/.test(e.form)
  if (f4) {
    const verb = VERB[e.action] ?? 'filed a Form 4 on'
    const open = e.action === 'buy' || e.action === 'sell' || e.action === 'mixed'
    const size = open && e.value_usd ? money(Math.abs(e.value_usd)) : e.shares ? `${sharesFmt(Math.abs(e.shares))} shares` : ''
    const chg = e.prev_shares_after && e.shares_after != null ? e.shares_after / e.prev_shares_after - 1 : null
    if (open && chg != null && Number.isFinite(chg) && chg !== 0) pct = chg
    what = `${cap(verb)}${size ? ` ${size}` : ''}${pct != null ? ` (${pctChange(pct)})` : ''}${e.action === 'sell' && exerciseAndSale(e) ? ', exercise + sale' : ''}`
  } else {
    const p = e.percent_of_class
    what = e.action === 'new_stake' ? `New ${p != null ? `${p}% ` : ''}stake` : p != null ? `→ ${p}%` : 'Amended'
  }
  const action = f4 ? (e.action === 'buy' ? 'bought' : e.action === 'sell' ? 'sold' : (VERB[e.action] ?? 'other')) : sched
  // EDGAR dates filings in New York time; a 6:30 pm ET acceptance is the next day in UTC.
  return { form: e.form, date: new Date(e.accepted_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), manager: who, line: `${what} · ${who}${role}`, url: e.url, action, value: f4 && (e.action === 'buy' || e.action === 'sell' || e.action === 'mixed') ? e.value_usd : null, pct, accession: accNo(e.accession) }
}
// EDGAR's own form (0001017918-26-000058), so spreadsheets read it as text, not 1.017918e+14.
const dashed = (a?: string) => (a && /^\d{18}$/.test(a) ? `${a.slice(0, 10)}-${a.slice(10, 12)}-${a.slice(12)}` : (a ?? ''))
const accNo = (s: string) => s.match(/\d{10}-?\d{2}-?\d{6}/)?.[0].replace(/-/g, '') ?? s
// GET /events?window=quarter returns every event since the quarter start, up to 150 per ticker.
const EVENTS_PER_TICKER = 150
const QSTART = ['01-01', '04-01', '07-01', '10-01']
/** The latest meaningful filing on a name: open-market buys and sells at or above the member's insider
 *  threshold (Form 4 by a fund or a company insider), and any 13D/G. Grants, option exercises, tax
 *  withholding and gifts are left out. `empty` says what an empty cell means. */
// Passive index managers file a 13G on almost every large company they hold; those say nothing about
// conviction, so the column leaves them out (active 13Gs, such as Capital Research's, stay).
const PASSIVE = /\b(blackrock|vanguard|state street|ssga|geode|northern trust|dimensional fund|charles schwab|schwab asset|invesco)\b/i
const passive13G = (form: string, filer: string | null | undefined) => /13G/i.test(form) && PASSIVE.test(filer ?? '')

/** The column's one window: filings since the latest 13F period end, the start of the quarter now filing
 *  (Jul 1 while Q3 13Fs are due). The API's feed says when it is complete back to it (`window`). */
function windowStart(season: string) {
  if (!season) return ''
  const [y, q] = [Number(season.slice(0, 4)), Number(season.slice(5))]
  return `${y}-${QSTART[q - 1]}`
}
/** "Jun 30": the day before the window starts, the 13F period end. */
const windowLabel = (start: string) => (start ? new Date(Date.parse(`${start}T12:00:00Z`) - 86400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'the 13F')

type Events = { latest: Latest | null; insider: Latest | null; holder: Latest | null; empty: string; more: number }
function newest(stock: Stock | null, issuer: IssuerFeed | undefined, min: number, season: string, loading: boolean): Events {
  // Until the issuer feed is in, every cell waits: a fund's event shown first could be replaced by a newer insider one.
  if (loading) return { latest: null, insider: null, holder: null, empty: 'loading', more: 0 }
  const trade = (action: string, value?: number | null) => (action === 'buy' || action === 'sell' || action === 'mixed') && (value == null || Math.abs(value) >= min)
  const fund = (stock?.since ?? []).filter((e) => (e.kind !== 'form4' || trade(e.action, e.value_usd)) && !passive13G(e.form, e.manager)).map((e) => ({ acc: accNo(e.url), l: evLatest(e) }))
  const seen = new Set((stock?.since ?? []).map((e) => accNo(e.url)))
  const own = (issuer ?? []).filter((e) => !seen.has(accNo(e.accession)) && !passive13G(e.form, e.filer_name) && (!/^4/.test(e.form) || trade(e.action, e.value_usd)))
  // One window on every row: filings since the 13F period end (Jun 30 while Q3 is filing).
  const from = (issuer?.window ?? '').slice(0, 10) || windowStart(season)
  const all = [...fund, ...own.map((e) => ({ acc: accNo(e.accession), l: issuerLatest(e) }))].filter((x) => !from || x.l.date >= from)
  // Two lines, so a CEO's buy is never hidden behind a later 13G: the largest open-market trade in the
  // window (buys beat sells on a tie), and the latest 13D/G.
  const trades = all.filter((x) => /^4/.test(x.l.form))
  const insider = trades.sort((a, b) => Math.abs(b.l.value ?? 0) - Math.abs(a.l.value ?? 0) || Number(b.l.action === 'bought') - Number(a.l.action === 'bought') || b.l.date.localeCompare(a.l.date))[0]?.l ?? null
  const holder = all.filter((x) => !/^4/.test(x.l.form)).sort((a, b) => b.l.date.localeCompare(a.l.date))[0]?.l ?? null
  // Grants, exercises, tax withholding, gifts and trades under the threshold in the window: counted, not shown.
  const more = (issuer ?? []).filter((e) => /^4/.test(e.form) && !own.includes(e) && !seen.has(accNo(e.accession)) && e.accepted_at.slice(0, 10) >= from).length
  // The window is stated only when the feed reaches back to it (the API's window, or every filing there is).
  const oldest = issuer?.at(-1)?.accepted_at.slice(0, 10) ?? ''
  const covered = issuer && (issuer.window || issuer.length < EVENTS_PER_TICKER || (from && oldest <= from))
  const empty = !issuer ? 'Insider filings not loaded yet' : covered ? `No insider buys or sells since ${windowLabel(from)}` : `No insider buys or sells in the last ${issuer.length} Form 4s, back to ${dateLabel(oldest)}`
  return { latest: insider ?? holder, insider, holder, empty: insider ? '' : empty, more }
}

/** The Form 4/13D cell: the insider line (or what its absence means) and the latest 13D/G under it. */
function EventsCell({ r, w }: { r: { ticker: string; insider?: Latest | null; holder?: Latest | null; empty?: string; more?: number }; w: string }) {
  if (r.empty === 'loading') return <Skeleton className="h-4 w-28" />
  const line = (l: Latest) => (
    <span className="block max-w-[14rem]">
      <span className="font-medium">{l.form.replace(/^SCHEDULE /i, '')}</span> · {dateLabel(l.date)}
      <a href={l.url} className={`block ${w} truncate text-ink-2 hover:text-accent`} title={`${l.line}. Open the filing on EDGAR`}>
        {l.line}
      </a>
    </span>
  )
  return (
    <>
      {r.insider ? line(r.insider) : <span className="block max-w-[11rem] text-ink-3">{r.empty}</span>}
      {r.holder && <span className="mt-1.5 block">{line(r.holder)}</span>}
      {(r.more ?? 0) > 0 && <NonTrade n={r.more!} ticker={r.ticker} />}
    </>
  )
}

const NonTrade = ({ n, ticker }: { n: number; ticker: string }) => (
  <Link to={stockPath(ticker)} className="mt-0.5 block text-[11.5px] text-ink-3 hover:text-ink-2" title="Grants, option exercises, tax withholding, gifts and trades under your insider threshold">
    +{n} non-trade {n === 1 ? 'filing' : 'filings'}
  </Link>
)

const signed = (v: number) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`

function Import({ link = true }: { link?: boolean }) {
  const [text, setText] = useState('')
  const [owned, setOwned] = useState(true)
  const [state, setState] = useState<{ busy?: boolean; msg?: string; ok?: boolean }>({})
  const { follows } = useFollows()
  const go = async () => {
    // A CSV's Ticker or Symbol column, else the first column of each line, or every token on a single line: "$NVDA, AAPL BRK-B".
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    const rows = lines.map((l) => l.split(/[,;\t]/).map((c) => c.replace(/"/g, '').trim()))
    const col = rows[0]?.findIndex((c) => /^(ticker|symbol)$/i.test(c)) ?? -1
    // Cells with spaces in them are a broker's totals and cash lines, not tickers.
    const cells = (col >= 0 ? rows.slice(1).map((r) => r[col] ?? '') : lines.length > 1 ? rows.map((r) => r[0]) : lines.join(' ').split(/[\s,;]+/))
      .map((t) => t.replace(/"/g, '').trim())
      .filter((t) => t && !/\s/.test(t) && !/^(ticker|symbol)$/i.test(t))
    if (!cells.length) return setState({ msg: 'No tickers found. Paste one per line, or separated by commas.', ok: false })
    setState({ busy: true })
    const looked = await Promise.all([...new Set(cells)].map(async (c) => [c, /^\$?[A-Za-z][A-Za-z0-9.\-/]{0,7}$/.test(c) ? await resolveTicker(c).catch(() => null) : null] as const))
    const unknown = looked.filter(([, t]) => !t).map(([c]) => c)
    const known = [...new Set(looked.flatMap(([, t]) => (t ? [t] : [])))]
    const have = new Set(owned ? follows.owned : [...follows.owned, ...follows.stocks])
    const already = known.filter((t) => have.has(t))
    const fresh = known.filter((t) => !have.has(t))
    let skipped: string[] = []
    if (fresh.length) {
      if (owned) {
        // Owned names go through the API's importer, which keeps them apart from a linked 13F.
        const r = await importBook({ text: fresh.join(' '), mode: 'merge' }).catch((e) => (e instanceof ApiError ? e : null))
        if (!r || r instanceof ApiError) return setState({ msg: r?.detail ?? 'That didn’t save. Please try again.', ok: false })
        skipped = (r.skipped ?? []).filter((x) => x.trim())
      } else {
        const failed = await addStocks(fresh, false).catch(() => null)
        if (failed === null) return setState({ msg: 'That didn’t save. Please try again.', ok: false })
        skipped = failed
      }
    }
    const added = fresh.filter((t) => !skipped.includes(t))
    setText('')
    const parts = [
      added.length ? `Added ${added.length} (${added.join(', ')})` : 'Nothing new added',
      ...(['owned', 'watched'] as const).map((k) => {
        const xs = already.filter((t) => follows.owned.includes(t) === (k === 'owned'))
        return xs.length ? `already ${k}: ${xs.join(', ')}` : ''
      }),
      unknown.length || skipped.length ? `not recognized: ${[...unknown, ...skipped].slice(0, 10).join(', ')}${unknown.length + skipped.length > 10 ? '…' : ''}` : '',
    ].filter(Boolean)
    setState({ msg: `${parts.join(' · ')}.`, ok: !unknown.length && !skipped.length })
  }
  return (
    <div className="mt-3">
      <label htmlFor="book-import" className="sr-only">
        Tickers to add
      </label>
      <textarea
        id="book-import"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={'NVDA, AAPL, BRK-B\nor paste a CSV'}
        className="w-full rounded-xl bg-paper px-3.5 py-2.5 font-mono text-[13px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="radiogroup" aria-label="Add as">
          {[true, false].map((o) => (
            <button key={String(o)} type="button" role="radio" aria-checked={owned === o} onClick={() => setOwned(o)} className={`rounded-full px-3 py-1 ${owned === o ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
              {o ? 'I own these' : 'I watch these'}
            </button>
          ))}
        </span>
        <Button size="sm" onClick={go} disabled={state.busy || !text.trim()}>
          {state.busy ? 'Adding…' : 'Add to my book'}
        </Button>
      </div>
      {state.msg && (
        <p role={state.ok ? 'status' : 'alert'} className={`mt-2 text-[13px] ${state.ok ? 'text-up' : 'text-down'}`}>
          {state.msg}
        </p>
      )}
      <p className="mt-3 text-[12.5px] text-ink-3">Remove a name with Following on its stock page.</p>
      {link ? (
        <LinkFund />
      ) : (
        <Link to="/upgrade/?plan=pro" className="mt-4 flex items-start gap-2.5 border-t border-line pt-4 text-[13px] text-ink-2 hover:text-accent-2">
          <span className="mt-0.5 shrink-0 text-ink-3">
            <Lock />
          </span>
          <span>
            <span className="font-medium text-ink">Link your fund’s 13F as your book</span> · Copy Pro
          </span>
        </Link>
      )}
    </div>
  )
}

// Link a 13F filer's book (usually the member's own fund) as the owned list, by CIK.
function LinkFund() {
  const { follows } = useFollows()
  const [q, setQ] = useState('')
  const [state, setState] = useState<{ busy?: boolean; msg?: string; ok?: boolean }>({})
  const hits = useSearch(q)
    .flatMap((h) => (h.kind === 'manager' ? [{ cik: h.m.cik, name: h.m.manager }] : h.kind === 'filer' ? [{ cik: h.f.cik, name: h.f.name }] : []))
    .slice(0, 5)
  const link = async (cik: string) => {
    setQ('')
    setState({ busy: true })
    const r = await importBook({ cik: cik.replace(/^0+/, '') }).catch((e) => (e instanceof ApiError ? e : null))
    if (!r || r instanceof ApiError) return setState({ msg: r?.status === 404 ? 'That filer has no 13F holdings on file yet.' : (r?.detail ?? 'That didn’t save. Please try again.'), ok: false })
    // The linked-book line above confirms it, from the server's answer.
    setState({})
  }
  const b = follows.book
  return (
    <div className="mt-5 border-t border-line pt-4">
      <h3 className="text-[14px] font-semibold">Or link your fund’s 13F</h3>
      {b ? (
        <div className="mt-1 space-y-1.5 text-[13px] text-ink-2">
          <p>
            Linked to <span className="font-medium text-ink">{b.name}</span>’s {quarterLabel(b.quarter)} 13F: {b.tickers.length} names, marked “Owned · 13F” in the table. They follow its filings.
          </p>
          {(() => {
            const hand = follows.owned_manual ?? follows.owned.filter((t) => !b.tickers.includes(t))
            return (
              <p>
                Added by hand: {hand.length ? <span className="font-mono text-[12.5px] text-ink">{hand.join(', ')}</span> : 'none'}. These stay if you link a different 13F or unlink.
              </p>
            )
          })()}
        </div>
      ) : (
        <p className="mt-1 text-[13px] text-ink-2">Your owned names become its latest 13F book, largest first, and update each time it files. Names you add by hand stay.</p>
      )}
      <div className="relative mt-3">
        <label htmlFor="link-fund" className="sr-only">
          Find your fund
        </label>
        <input
          id="link-fund"
          value={q}
          disabled={state.busy}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) link(hits[0].cik)
            if (e.key === 'Escape') setQ('')
          }}
          placeholder={b ? 'Link a different fund' : 'Find your fund by name'}
          autoComplete="off"
          className="h-10 w-full rounded-full bg-paper px-4 text-[14px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)] disabled:opacity-60"
        />
        {q && hits.length > 0 && (
          <ul className="absolute inset-x-0 top-12 z-20 overflow-hidden rounded-[14px] bg-card py-1 shadow-[0_12px_32px_rgba(0,0,0,0.12)]" role="listbox" aria-label="Funds">
            {hits.map((h) => (
              <li key={h.cik} role="option" aria-selected="false">
                <button type="button" onClick={() => link(h.cik)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[14px] hover:bg-paper">
                  <span className="truncate">{h.name}</span>
                  <span className="num shrink-0 text-[12px] text-ink-3">CIK {h.cik.replace(/^0+/, '')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {state.busy && <p className="mt-2 text-[13px] text-ink-3">Linking…</p>}
      {state.msg && (
        <p role={state.ok ? 'status' : 'alert'} className={`mt-2 text-[13px] ${state.ok ? 'text-up' : 'text-down'}`}>
          {state.msg}
        </p>
      )}
    </div>
  )
}
