import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FailingBanner } from '../components/Channels'
import { Peers } from '../components/Peers'
import { useSearch } from '../components/Search'
import { Arrow, Badge, Button, Lock, Panel, Skeleton, Stat } from '../components/ui'
import { ApiError, isPro, useMember, type Member } from '../lib/account'
import { quarterLabel, dateLabel, displayName, money, pct, useAsync, useTitle } from '../lib/data'
import { addStocks, importBook, useFollows } from '../lib/follows'
import { loadFilerHolders, loadStock, resolveTicker, stockPath, tickerText, type Stock, type StockHolder } from '../lib/stocks'

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
  latest: { form: string; date: string; manager: string } | null
  split: { ratio: string; adjusted: boolean } | null
  /** Counts are across every 13F filer; changes are the tracked funds'. */
  all: boolean
  /** All-filer counts asked for, but the filer index misses many of the funds we track: tracked counts shown. */
  incomplete: boolean
  /** All 13F filers holding it whose latest filing is older than the previous quarter. */
  older: number
  /** The tracked funds' figures, kept for the CSV whatever the lens. */
  t: { holders: number; prev: number; top10: number; over5: number; filed: number }
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

// all: crowding across every 13F filer (d/h/{TICKER}.json); changes stay with the tracked funds.
type Agg = Awaited<ReturnType<typeof loadFilerHolders>>

function rowFor(ticker: string, owned: boolean, stock: Stock | null, season: string, all: Agg | null = null): Row {
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
    latest: ev ? { form: ev.form, date: ev.filing_date, manager: displayName(ev.manager) } : null,
  }
  const t = { holders: base.holders, prev: base.prev, top10: base.top10, over5: base.over5, filed: base.filed }
  // Until ingest's holder index covers small and mid caps, it can miss funds we track that do hold
  // the stock (it was built from each filer's largest positions). Then the tracked counts are shown.
  // When it misses a quarter or more of them, the row shows the tracked counts; a smaller gap is
  // added back to the filer count, since those funds are known holders.
  const missing = all && all.tracked != null ? Math.max(0, h.length - all.tracked) : 0
  const a = all
    ? { holders: all.current + missing, older: all.filers - all.current, top10: all.top10 ?? 0, over5: all.over5 ?? 0, filed: all.quarters?.[season] ?? 0, incomplete: all.current < h.length || missing > Math.max(2, h.length * 0.25) }
    : null
  const useAll = Boolean(a && !a.incomplete)
  return {
    ticker,
    name: stock?.name ?? '',
    ...base,
    t,
    a,
    all: useAll,
    incomplete: Boolean(a?.incomplete),
    older: useAll ? a!.older : 0,
    ...(useAll ? { holders: a!.holders, prev: NaN, top10: a!.top10, over5: a!.over5, filed: a!.filed, filedOf: a!.holders } : {}),
  }
}

const sortVal = (r: Row, k: Key) =>
  k === 'ticker' ? r.ticker : k === 'change' ? (r.all ? 0 : r.holders - r.prev) : k === 'filed' ? r.filed : k === 'latest' ? (r.latest?.date ?? '') : (r[k] as number)

export function Book() {
  useTitle('My book · Copybook')
  const member = useMember()
  const pro = isPro(member)
  const { status, follows } = useFollows()
  const names = useMemo(() => [...new Set([...follows.owned, ...follows.stocks])], [follows.owned, follows.stocks])
  const data = useAsync(() => (pro && names.length ? Promise.all(names.map((t) => loadStock(t).catch(() => null))) : Promise.resolve([])), [pro, names.join(',')])
  // Lens: every 13F filer (default) or the funds we track closely, in the URL so a view can be shared.
  const [params, setParams] = useSearchParams()
  const lens: 'all' | 'tracked' = params.get('funds') === 'tracked' ? 'tracked' : 'all'
  const setLens = (l: 'all' | 'tracked') => setParams(l === 'all' ? {} : { funds: l }, { replace: true })
  const agg = useAsync(() => (pro && names.length && lens === 'all' ? Promise.all(names.map((t) => loadFilerHolders(t).catch(() => null))) : Promise.resolve([])), [pro, names.join(','), lens])
  const ready = Boolean(data.data && (lens === 'tracked' || agg.data))
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
    const r = names.map((t, i) => rowFor(t, follows.owned.includes(t), data.data?.[i] ?? null, season, lens === 'all' ? (agg.data?.[i] ?? null) : null))
    const dir = sort.desc ? -1 : 1
    return r.sort((a, b) => {
      const x = sortVal(a, sort.k)
      const y = sortVal(b, sort.k)
      return (x < y ? -1 : x > y ? 1 : 0) * dir || a.ticker.localeCompare(b.ticker)
    })
  }, [names, follows.owned, data.data, agg.data, lens, season, sort])

  // What the funds that have filed this season did in these names, largest first.
  const moves = useMemo(
    () =>
      rows
        .flatMap((r) => (r.split && !r.split.adjusted ? [] : [...(r.stock?.holders ?? []), ...(r.stock?.exited ?? [])]).filter((x) => x.quarter === season && x.change && x.change !== 'unchanged' && x.delta_value).map((x) => ({ r, x })))
        .sort((a, b) => Math.abs(b.x.delta_value) - Math.abs(a.x.delta_value))
        .slice(0, 12),
    [rows, season],
  )
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
  if (!pro)
    return (
      <div className="container-x pt-12 md:pt-16">
        <Header />
        <section className="relative mt-10 overflow-hidden rounded-[var(--radius-card)] bg-card p-8 shadow-[var(--shadow-card)]">
          <div className="pointer-events-none select-none blur-[3px]" aria-hidden="true">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="mt-4 h-64 w-full" />
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-card/60 p-6 text-center">
            <Lock />
            <p className="mt-3 max-w-md text-[16px] font-semibold">My book is part of Copy Pro and Copy Fund.</p>
            <p className="mt-1.5 max-w-md text-[14px] text-ink-2">See how crowded your names are, who’s buying and selling them this filing season, and every Form 4 and 13D, in one sortable table with CSV.</p>
            <Button to="/pricing/" className="mt-5">
              Compare plans <Arrow />
            </Button>
          </div>
        </section>
      </div>
    )

  const csv = () => {
    // Every column names whose figures it holds: all 13F filers or the funds we track closely.
    const head = ['ticker', 'name', 'owned', 'holders_all', 'holders_all_older_filings', 'all_filer_count_incomplete', 'top10_all', 'over_5pct_all', `filed_${season}_all`, 'holders_tracked', 'holders_tracked_last_13f', 'superinvestors', 'new_tracked', 'exited_tracked', 'top10_tracked', 'over_5pct_tracked', `filed_${season}_tracked`, 'bought_tracked', 'sold_tracked', 'net_usd_tracked', 'split', 'latest_form', 'latest_date', 'latest_filer']
    const q = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
    const body = rows.map((r) =>
      [
        r.ticker, r.name, r.owned ? 'owned' : 'watched',
        r.a?.holders ?? '', r.a?.older ?? '', r.a ? (r.a.incomplete ? 'true' : 'false') : '', r.a?.top10 ?? '', r.a?.over5 ?? '', r.a?.filed ?? '',
        r.t.holders, r.t.prev, r.featured, r.added, r.exited, r.t.top10, r.t.over5, r.t.filed,
        r.split && !r.split.adjusted ? '' : r.bought, r.split && !r.split.adjusted ? '' : r.sold, r.split && !r.split.adjusted ? '' : Math.round(r.net),
        r.split ? `${r.split.ratio} ${r.split.adjusted ? 'adjusted' : 'not counted'}` : '',
        r.latest?.form ?? '', r.latest?.date ?? '', r.latest?.manager ?? '',
      ].map(q).join(','),
    )
    const url = URL.createObjectURL(new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `copybook-my-book-${new Date().toISOString().slice(0, 10)}.csv` })
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="container-x pt-12 md:pt-16">
      <Header right={rows.length > 0 && <Button variant="outline" size="sm" onClick={csv}>Export CSV</Button>} />
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
            {lens === 'all' ? (
              <>
                <Stat
                  label={season ? `Filed ${quarterLabel(season)} so far` : 'Filed so far'}
                  value={ready ? `${Math.round((rows.reduce((a, r) => a + r.filed, 0) / Math.max(1, rows.reduce((a, r) => a + r.filedOf, 0))) * 100)}%` : '—'}
                  sub="of the 13F holders of your names"
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
              sub={lens === 'all' ? 'by the funds we track closely, at quarter-end value' : 'in your names, at quarter-end value'}
            />
          </div>

          <section className="mt-6 overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
            <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
              <div className="max-w-2xl">
                <h2 className="text-[15px] font-semibold">Your names</h2>
                <p className="text-[13px] text-ink-3">
                  {lens === 'all'
                    ? 'Funds, top 10, over 5% and filed count every 13F filer whose latest filing is for this quarter or last; older filings are shown apart. Columns marked * (new, exited, bought, sold, net) cover the funds we track closely until every filer’s prior quarter is on file. Where the all-filer index is incomplete for a name, its row shows the funds we track closely.'
                    : 'Among the funds we track closely, from each one’s latest 13F.'}{' '}
                  Click a column to sort.
                </p>
              </div>
              <div className="inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Which funds">
                {(['all', 'tracked'] as const).map((l) => (
                  <button key={l} type="button" role="tab" aria-selected={lens === l} onClick={() => setLens(l)} className={`rounded-full px-3 py-1.5 ${lens === l ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                    {l === 'all' ? 'All 13F filers' : 'Funds we track closely'}
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
                          {lens === 'all' && (k === 'added' || k === 'exited' || k === 'net') && '*'}
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
                                {r.holders.toLocaleString('en-US')}
                                {r.featured > 0 && <span className="block text-[12px] font-normal text-ink-3">{r.featured} super</span>}
                                {r.older > 0 && <span className="block text-[12px] font-normal text-ink-3" title={`${r.older.toLocaleString('en-US')} more filers hold it on a 13F older than last quarter`}>+{r.older.toLocaleString('en-US')} older</span>}
                                {r.incomplete && (
                                  <span className="ml-auto block max-w-[6.5rem] whitespace-normal text-[11.5px] font-normal leading-tight text-[#8a5a0b]" title="The all-filer index misses some funds that hold this stock, so these are the funds we track closely">
                                    All-filer count incomplete
                                  </span>
                                )}
                              </td>
                              <td className={`num px-3 py-2.5 text-right ${d > 0 ? 'text-up' : d < 0 ? 'text-down' : 'text-ink-3'}`} title={r.all ? 'Needs every filer’s prior quarter' : undefined}>{r.all ? '—' : d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0'}</td>
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
                                {r.latest ? (
                                  <span className="block max-w-[14rem]">
                                    <span className="font-medium">{r.latest.form.replace(/^SCHEDULE /i, '')}</span> · {dateLabel(r.latest.date)}
                                    <span className="block max-w-[9rem] truncate text-ink-3" title={r.latest.manager}>{r.latest.manager}</span>
                                  </span>
                                ) : (
                                  <span className="text-ink-3">None since the 13Fs</span>
                                )}
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
              sub={lens === 'all' ? 'Largest moves by the funds we track closely that have filed this season, valued at quarter-end. Other filers’ moves appear once their prior quarter is on file.' : 'Largest moves by funds that have filed this season, valued at quarter-end'}
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
            {lens === 'all' ? 'Holder counts cover every 13F filer’s latest filing; new, exited and trades cover the funds we track closely' : 'Counts cover the funds we track closely, from each one’s latest 13F'}; “super” counts the superinvestors among them. “In a top 10” means one of the fund’s ten largest share positions. Your book is private to you and never used in aggregates. Hedge-fund-only counts and % of shares outstanding arrive with the next data release.
          </p>
        </>
      )}
      <Peers names={names} shared={member?.plan === 'fund'} />
    </div>
  )
}

function Header({ right, eyebrow = 'My book · Copy Pro and Copy Fund' }: { right?: React.ReactNode; eyebrow?: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">{eyebrow}</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Who owns what you own.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">Crowding, this season’s buying and selling, and the latest insider and 13D filings in the stocks you own or watch.</p>
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
  const [proNote, setProNote] = useState(false)
  const linkedOnly = useMemo(() => {
    const manual = new Set(follows.owned_manual ?? [])
    return new Set((follows.book?.tickers ?? []).filter((t) => !manual.has(t)))
  }, [follows.book, follows.owned_manual])
  // Hand-added names only: a linked 13F book is a Pro feature.
  const names = useMemo(() => [...new Set([...follows.owned, ...follows.stocks])].filter((t) => !linkedOnly.has(t)), [follows.owned, follows.stocks, linkedOnly])
  const data = useAsync(() => (names.length ? Promise.all(names.map((t) => loadStock(t).catch(() => null))) : Promise.resolve([])), [names.join(',')])
  const season = useMemo(() => (data.data ?? []).flatMap((x) => x?.quarters ?? []).sort().at(-1) ?? '', [data.data])
  const rows = useMemo(
    () =>
      names
        .map((t, i) => {
          const st = data.data?.[i] ?? null
          const inLens = (x: StockHolder) => lens === 'tracked' || x.featured
          const held = (st?.holders ?? []).filter(inLens).sort((a, b) => b.weight - a.weight)
          const split = st?.splits?.[season] ?? null
          const moves = split && !split.adjusted ? [] : [...(st?.holders ?? []), ...(st?.exited ?? [])].filter((x) => inLens(x) && x.quarter === season && x.change && x.change !== 'unchanged')
          const ev = st?.since?.[0]
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
            latest: ev ? { form: ev.form, date: ev.filing_date, manager: displayName(ev.manager) } : null,
          }
        })
        .sort((a, b) => b.held.length - a.held.length || (b.stock?.holders.length ?? 0) - (a.stock?.holders.length ?? 0) || a.ticker.localeCompare(b.ticker)),
    [names, data.data, lens, season, follows.owned],
  )
  const moves = rows
    .flatMap((r) => r.moves.map((x) => ({ r, x })))
    .sort((a, b) => Math.abs(b.x.delta_value) - Math.abs(a.x.delta_value))
    .slice(0, 10)
  const lensName = lens === 'super' ? 'superinvestors' : 'funds we track closely'
  const pro = (
    <section id="pro" className="mt-6 scroll-mt-24 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:p-6" aria-labelledby="pro-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 id="pro-title" className="flex items-center gap-2 text-[15px] font-semibold">
            <Lock /> More in Copy Pro
          </h2>
          <p className="mt-1 text-[14px] text-ink-2">Your names against every 13F filer, not just the funds we follow, and the tools to work with them.</p>
        </div>
        <Button to="/pricing/">
          Upgrade to Pro <Arrow />
        </Button>
      </div>
      <ul className="mt-4 grid gap-x-6 gap-y-2.5 text-[13.5px] sm:grid-cols-2 lg:grid-cols-3">
        {(
          [
            ['All 13F filers', 'Holder counts across all 8,900+ filers, not only the funds we track'],
            ['Crowding', 'How many filers hold each name in their top 10, and at over 5% of their book'],
            ['Peer overlap', 'Up to 12 benchmark funds: shared names and what each did in yours'],
            ['Link your 13F', 'Your fund’s own 13F as the owned book, updated each time it files'],
            ['CSV export', 'The whole table, with every column, in one file'],
            ['API', 'Holdings, Form 4 and 13D/G as JSON, for every filer'],
          ] as const
        ).map(([t, d]) => (
          <li key={t} className="flex gap-2.5">
            <span className="mt-0.5 shrink-0 text-ink-3">
              <Lock />
            </span>
            <span>
              <span className="font-medium">{t}</span>
              <span className="block text-[12.5px] text-ink-3">{d}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )

  return (
    <div className="container-x pt-12 md:pt-16">
      <Header eyebrow="My book · Copy" />
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
                <button
                  type="button"
                  aria-describedby="pro-title"
                  onClick={() => {
                    setProNote(true)
                    document.getElementById('pro')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-ink-3 hover:text-ink-2"
                >
                  <Lock /> All 13F filers
                </button>
              </div>
            </div>
            {proNote && <p className="border-b border-line bg-accent-soft px-5 py-2.5 text-[13px] text-accent-2 md:px-6">Counts across every 13F filer are part of Copy Pro. See below.</p>}
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
                            {r.latest ? (
                              <span className="block max-w-[14rem]">
                                <span className="font-medium">{r.latest.form.replace(/^SCHEDULE /i, '')}</span> · {dateLabel(r.latest.date)}
                                <span className="block max-w-[11rem] truncate text-ink-3" title={r.latest.manager}>
                                  {r.latest.manager}
                                </span>
                              </span>
                            ) : (
                              <span className="text-ink-3">None since the 13Fs</span>
                            )}
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
          <p className="mt-6 text-[13px] leading-relaxed text-ink-3">From each fund’s latest 13F as filed with the SEC, and Form 4 and Schedule 13D/G filings since. Weight is the position’s share of that fund’s 13F stock holdings. Your list is private to you and never used in aggregates. Not investment advice.</p>
        </>
      )}
    </div>
  )
}

const signed = (v: number) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`

function Import({ link = true }: { link?: boolean }) {
  const [text, setText] = useState('')
  const [owned, setOwned] = useState(true)
  const [state, setState] = useState<{ busy?: boolean; msg?: string; ok?: boolean }>({})
  const go = async () => {
    // A CSV's Ticker or Symbol column, else the first column of each line, or every token on a single line: "$NVDA, AAPL BRK-B".
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    const rows = lines.map((l) => l.split(/[,;\t]/).map((c) => c.replace(/"/g, '').trim()))
    const col = rows[0]?.findIndex((c) => /^(ticker|symbol)$/i.test(c)) ?? -1
    const raw = (col >= 0 ? rows.slice(1).map((r) => r[col] ?? '') : lines.length > 1 ? rows.map((r) => r[0]) : lines.join(' ').split(/[\s,;]+/)).map((t) => tickerText(t.replace(/"/g, ''))).filter((t) => /^[A-Z][A-Z0-9.]{0,6}$/.test(t) && t !== 'TICKER' && t !== 'SYMBOL')
    if (!raw.length) return setState({ msg: 'No tickers found. Paste one per line, or separated by commas.', ok: false })
    setState({ busy: true })
    if (owned) {
      // Owned names go through the API's importer, which also skips broker totals and cash lines.
      const r = await importBook({ ...(lines.length > 1 ? { csv: text } : { text }), mode: 'merge' }).catch((e) => (e instanceof ApiError ? e : null))
      if (!r || r instanceof ApiError) return setState({ msg: r?.detail ?? 'That didn’t save. Please try again.', ok: false })
      setText('')
      const sk = (r.skipped ?? []).filter((x) => x.trim())
      return setState({ msg: `Added ${r.imported} ${r.imported === 1 ? 'name' : 'names'} you own${sk.length ? `. Skipped: ${sk.slice(0, 8).join(', ')}${sk.length > 8 ? '…' : ''}` : ''}.`, ok: true })
    }
    const resolved = await Promise.all([...new Set(raw)].map(async (t) => [t, (await resolveTicker(t).catch(() => null)) ?? t] as const))
    const failed = await addStocks([...new Set(resolved.map(([, t]) => t))], owned).catch(() => null)
    if (failed === null) return setState({ msg: 'That didn’t save. Please try again.', ok: false })
    setText('')
    setState({ msg: `Added ${resolved.length - failed.length} ${resolved.length - failed.length === 1 ? 'name' : 'names'} you watch${failed.length ? `. Not recognised: ${failed.join(', ')}` : ''}.`, ok: !failed.length })
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
      {link && <LinkFund />}
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
