import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Peers } from '../components/Peers'
import { useSearch } from '../components/Search'
import { Arrow, Badge, Button, Lock, Panel, Skeleton, Stat } from '../components/ui'
import { ApiError, isPro, useMember } from '../lib/account'
import { quarterLabel, dateLabel, displayName, money, useAsync, useTitle } from '../lib/data'
import { addStocks, importBook, useFollows } from '../lib/follows'
import { loadStock, resolveTicker, stockPath, tickerText, type Stock, type StockHolder } from '../lib/stocks'

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

function rowFor(ticker: string, owned: boolean, stock: Stock | null, season: string): Row {
  const h: StockHolder[] = stock?.holders ?? []
  const ex: StockHolder[] = stock?.exited ?? []
  // Share changes in a quarter that looks like a split aren't trades: kept out of the counts and net.
  const split = stock?.splits?.[season] ?? null
  const filed = [...h, ...ex].filter((x) => x.quarter === season)
  const traded = split && !split.adjusted ? [] : filed
  const ev = stock?.since?.[0]
  return {
    ticker,
    name: stock?.name ?? '',
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
}

const sortVal = (r: Row, k: Key) =>
  k === 'ticker' ? r.ticker : k === 'change' ? r.holders - r.prev : k === 'filed' ? r.filed : k === 'latest' ? (r.latest?.date ?? '') : (r[k] as number)

export function Book() {
  useTitle('My book · Copybook')
  const member = useMember()
  const pro = isPro(member)
  const { status, follows } = useFollows()
  const names = useMemo(() => [...new Set([...follows.owned, ...follows.stocks])], [follows.owned, follows.stocks])
  const data = useAsync(() => (pro && names.length ? Promise.all(names.map((t) => loadStock(t).catch(() => null))) : Promise.resolve([])), [pro, names.join(',')])
  const [sort, setSort] = useState<{ k: Key; desc: boolean }>({ k: 'holders', desc: true })

  // The newest quarter any of these funds has filed: the season under way.
  const season = useMemo(() => {
    const qs = (data.data ?? []).flatMap((s) => s?.quarters ?? [])
    return qs.sort().at(-1) ?? ''
  }, [data.data])
  const rows = useMemo(() => {
    const r = names.map((t, i) => rowFor(t, follows.owned.includes(t), data.data?.[i] ?? null, season))
    const dir = sort.desc ? -1 : 1
    return r.sort((a, b) => {
      const x = sortVal(a, sort.k)
      const y = sortVal(b, sort.k)
      return (x < y ? -1 : x > y ? 1 : 0) * dir || a.ticker.localeCompare(b.ticker)
    })
  }, [names, follows.owned, data.data, season, sort])

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
    const head = ['ticker', 'name', 'owned', 'funds_holding', 'funds_last_13f', 'superinvestors', 'new', 'exited', 'in_top10', 'over_5pct', `filed_${season}`, 'funds_total', 'bought', 'sold', 'net_usd', 'latest_form', 'latest_date', 'latest_filer']
    const q = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
    const body = rows.map((r) => [r.ticker, r.name, r.owned ? 'owned' : 'watched', r.holders, r.prev, r.featured, r.added, r.exited, r.top10, r.over5, r.filed, r.filedOf, r.bought, r.sold, Math.round(r.net), r.latest?.form ?? '', r.latest?.date ?? '', r.latest?.manager ?? ''].map(q).join(','))
    const url = URL.createObjectURL(new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `copybook-my-book-${new Date().toISOString().slice(0, 10)}.csv` })
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="container-x pt-12 md:pt-16">
      <Header right={rows.length > 0 && <Button variant="outline" size="sm" onClick={csv}>Export CSV</Button>} />

      {status === 'ready' && names.length === 0 ? (
        <Panel className="mt-8" title="Add the names you own or watch">
          <p className="text-[14px] text-ink-2">Paste tickers or a CSV below, or press Follow on any stock page.</p>
          <Import />
        </Panel>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 gap-6 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:grid-cols-4 md:p-6">
            <Stat label="Names in your book" value={names.length} sub={`${follows.owned.length} owned, ${names.length - follows.owned.length} watched`} />
            <Stat label={season ? `Filed ${quarterLabel(season)} so far` : 'Filed so far'} value={data.data ? `${fundsFiled} of ${fundsAll}` : '—'} sub="funds that hold your names" />
            <Stat label="Crowded names" value={data.data ? rows.filter((r) => r.top10 >= 3).length : '—'} sub="in 3 or more funds’ top 10" />
            <Stat
              label="Their net trades this season"
              value={data.data ? <span className={moves.length ? (rows.reduce((a, r) => a + r.net, 0) >= 0 ? 'text-up' : 'text-down') : ''}>{signed(rows.reduce((a, r) => a + r.net, 0))}</span> : '—'}
              sub="in your names, at quarter-end value"
            />
          </div>

          <section className="mt-6 overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
            <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
              <div>
                <h2 className="text-[15px] font-semibold">Your names</h2>
                <p className="text-[13px] text-ink-3">Among the funds we track closely, from each one’s latest 13F. Click a column to sort.</p>
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
                          <span aria-hidden="true" className={sort.k === k ? 'text-ink' : 'opacity-0'}>
                            {sort.desc ? '↓' : '↑'}
                          </span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!data.data &&
                    names.slice(0, 6).map((t) => (
                      <tr key={t}>
                        <td colSpan={COLS.length} className="px-6 py-2.5">
                          <Skeleton className="h-6 w-full" />
                        </td>
                      </tr>
                    ))}
                  {data.data &&
                    rows.map((r) => {
                      const d = r.holders - r.prev
                      return (
                        <tr key={r.ticker} className="border-b border-line last:border-0 hover:bg-ink/[0.025]">
                          <td className="px-3 py-2.5 pl-5 md:pl-6">
                            <span className="flex items-center gap-2">
                              <Link to={stockPath(r.ticker)} className="font-mono text-[13px] font-semibold hover:text-accent">
                                {r.ticker}
                              </Link>
                              <span className="max-w-[7rem] truncate text-ink-2" title={r.name}>{r.name}</span>
                              {r.owned ? <Badge tone="accent">Owned</Badge> : <Badge>Watched</Badge>}
                            </span>
                          </td>
                          {r.stock ? (
                            <>
                              <td className="num whitespace-nowrap px-3 py-2.5 text-right font-medium">
                                {r.holders}
                                {r.featured > 0 && <span className="ml-1 text-[12px] font-normal text-ink-3">({r.featured} super)</span>}
                              </td>
                              <td className={`num px-3 py-2.5 text-right ${d > 0 ? 'text-up' : d < 0 ? 'text-down' : 'text-ink-3'}`}>{d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0'}</td>
                              <td className="num px-3 py-2.5 text-right">{r.added || <span className="text-ink-3">0</span>}</td>
                              <td className="num px-3 py-2.5 text-right">{r.exited || <span className="text-ink-3">0</span>}</td>
                              <td className="num px-3 py-2.5 text-right">{r.top10 || <span className="text-ink-3">0</span>}</td>
                              <td className="num px-3 py-2.5 text-right">{r.over5 || <span className="text-ink-3">0</span>}</td>
                              <td className="num px-3 py-2.5 text-right text-ink-2">
                                {r.filed} of {r.filedOf}
                                {r.filed > 0 && (
                                  <span className="block whitespace-nowrap text-[12px] text-ink-3">
                                    {r.split && !r.split.adjusted ? `Possible ${r.split.ratio} split` : `${r.bought} bought · ${r.sold} sold`}
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
            <Panel title={season ? `What they did in your names, ${quarterLabel(season)}` : 'What they did in your names'} sub="Largest moves by funds that have filed this season, valued at quarter-end">
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
            Counts cover the funds we track closely, from each one’s latest 13F; “super” counts the superinvestors among them. “In a top 10” means one of the fund’s ten largest share positions. Your book is private to you and never used in aggregates. Hedge-fund-only counts and % of shares outstanding arrive with the next data release.
          </p>
        </>
      )}
      <Peers names={names} shared={member?.plan === 'fund'} />
    </div>
  )
}

function Header({ right }: { right?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">My book · Copy Pro and Copy Fund</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Who owns what you own.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">Crowding, this season’s buying and selling, and the latest insider and 13D filings in the stocks you own or watch.</p>
      </div>
      {right}
    </header>
  )
}

const signed = (v: number) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`

function Import() {
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
      <LinkFund />
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
        <p className="mt-1 text-[13px] text-ink-2">
          Linked to <span className="font-medium text-ink">{b.name}</span>’s {quarterLabel(b.quarter)} 13F, {b.tickers.length} names. Your owned list follows it each time it files; names you add by hand stay.
        </p>
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
