import { Signup } from '../components/Signup'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ChangeBars } from '../components/charts'
import { CsvButton } from '../components/CsvButton'
import { FollowButton } from '../components/FollowButton'
import { Share } from '../components/Share'
import { PositionLine, rollUp, type Position } from '../components/FundNotes'
import { downloadFile, isPro, loadEvents, loadHolders, useMember, type ApiHolder } from '../lib/account'
import { issuerLatest } from '../lib/insiders'
import { Arrow, Badge, Button, Lock, Monogram, Panel, Skeleton, Stat } from '../components/ui'
import { dateLabel, displayName, money, pct, quarterLabel, sharesFmt, useAsync, useTitle } from '../lib/data'
import { stockTitle } from '../lib/titles.mjs'
import { loadFilerHolders, loadStock, recapPath, resolveTicker, seasonNow, stockPath, type StockHolder } from '../lib/stocks'

const CHANGE: Record<string, { label: string; tone: 'up' | 'down' | 'neutral' }> = {
  new: { label: 'New', tone: 'up' },
  added: { label: 'Added', tone: 'up' },
  trimmed: { label: 'Trimmed', tone: 'down' },
  exited: { label: 'Exited', tone: 'down' },
  unchanged: { label: 'No change', tone: 'neutral' },
}

export function StockPage() {
  const { ticker = '' } = useParams()
  const nav = useNavigate()
  const s = useAsync(() => loadStock(ticker.toUpperCase()), [ticker])
  // The lens lives in the URL (?funds=all) so a view can be shared; superinvestors by default.
  const [params, setParams] = useSearchParams()
  const lens = params.get('funds')
  const view: 'featured' | 'all' | 'hedge' | 'smart' | 'filers' = lens === 'all' || lens === 'filers' || lens === 'smart' || lens === 'hedge' ? lens : 'featured'
  const setView = (k: typeof view) => setParams(k === 'featured' ? {} : { funds: k }, { replace: true })
  // Curated data (moves, exits, options) follows the closest curated lens; "All 13F filers" widens the holder list.
  const scope: 'featured' | 'all' = view === 'featured' ? 'featured' : 'all'
  const member = useMember()
  const [n, setN] = useState(25)
  const d = s.data
  // The same live-number title the build writes into the page (scripts/postbuild.mjs).
  useTitle(d ? (d.title_counts?.filers ? stockTitle({ ticker: d.ticker, superinvestors: d.holders.filter((h) => h.featured).length, hedge: d.title_counts.hedge, filers: d.title_counts.filers, quarter: seasonNow().quarter }) : `${d.ticker} ${d.name}: who owns it · Copybook`) : undefined)

  // GOOG -> GOOGL, lowercase -> uppercase: send other share classes to the issuer's page.
  useEffect(() => {
    if (!s.error) return
    resolveTicker(ticker).then((t) => t && t !== ticker && nav(stockPath(t), { replace: true }))
  }, [s.error, ticker, nav])

  const tracked = useMemo(() => (d?.holders ?? []).filter((h) => scope === 'all' || h.featured), [d, scope])
  const wide = view === 'filers' || view === 'smart' || view === 'hedge'
  const typed = view === 'smart' || view === 'hedge' ? view : null
  const fh = useAsync(() => (wide && d ? loadFilerHolders(d.ticker) : Promise.resolve(null)), [wide, d?.ticker])
  // Hedge funds and active managers: the same filer list, cut to those types.
  const filers = useMemo(() => {
    const x = wide ? fh.data : null
    if (!x || !typed) return x
    const b = x[typed]
    return { ...x, filers: b ? b.current + b.older : 0, quarters: b?.quarters ?? {}, rows: x.rows.filter((r) => r[typed]) }
  }, [wide, view, fh.data])
  const filersLoading = wide && !fh.data && !fh.error
  // Pro and Fund: every holder from the API (1,000 a page), with each filer's change since its previous
  // 13F. Used only once the list is whole: not the public top 25 (truncated), and for the smart-money
  // tab, typed beyond the funds we track (about as many as the public index counts).
  const [pages, setPages] = useState(1)
  useEffect(() => setPages(1), [view, d?.ticker])
  const full = useAsync(async () => {
    if (!wide || !d || !isPro(member)) return null
    const rows: ApiHolder[] = []
    let r = null
    for (let i = 0, off = 0; i < pages; i++) {
      r = await loadHolders(d.ticker, view === 'smart' ? 'hedge_fund,long_only' : view === 'hedge' ? 'hedge_fund' : null, off)
      rows.push(...r.holders)
      if (r.next_offset == null) break
      off = r.next_offset
    }
    return r ? { count: r.filers ?? r.count, truncated: r.truncated, rows, more: r.next_offset != null } : null
  }, [wide, d?.ticker, view, pages, member?.plan, member?.active])
  const lensTotal = typed && fh.data?.[typed] ? fh.data[typed]!.current + fh.data[typed]!.older : 0
  const api = full.data && !full.data.truncated && (!typed || full.data.count >= lensTotal * 0.8) ? full.data : null
  const who = view === 'smart' ? 'hedge funds and long-only managers' : view === 'hedge' ? 'hedge funds' : '13F filers'
  // Every filer's latest position; a fund we track closely keeps its row, with its change since the filing before.
  const holders = useMemo(() => {
    if (!filers) return tracked
    const mine = new Map(tracked.map((h) => [h.slug, h]))
    if (api)
      return api.rows
        .filter((r) => !r.put_call && (r.kind === 'equity' || !r.kind))
        .map((r): StockHolder => {
          const m = mine.get(r.filer.slug)
          return { slug: r.filer.slug, manager: m?.manager ?? displayName(r.filer.name), firm: r.filer.name, quarter: r.period, featured: m?.featured ?? false, shares: r.shares, value: r.value_usd, weight: r.weight ?? 0, prev_shares: r.prev_shares ?? 0, prev_value: r.prev_value_usd ?? 0, delta_value: r.value_usd - (r.prev_value_usd ?? 0), change: r.change }
        })
    return filers.rows.map(
      (r): StockHolder =>
        mine.get(r.slug) ?? { slug: r.slug, manager: r.name, firm: r.name, quarter: r.quarter, featured: r.tier === 2, shares: r.shares, value: r.value, weight: r.weight, prev_shares: 0, prev_value: 0, delta_value: 0, change: null },
    )
  }, [filers, tracked, api])
  const exited = useMemo(() => (d?.exited ?? []).filter((h) => scope === 'all' || h.featured), [d, scope])
  const options = useMemo(() => (d?.options ?? []).filter((o) => scope === 'all' || o.featured), [d, scope])
  const [allMoves, setAllMoves] = useState(false)
  const moves = useMemo(
    () =>
      [...tracked, ...exited]
        .filter((h) => h.change && h.change !== 'unchanged' && h.delta_value)
        .sort((a, b) => Math.abs(b.delta_value) - Math.abs(a.delta_value)),
    [tracked, exited],
  )
  // Hide token moves: under 0.1% of the fund's book or $1M, whichever is larger.
  const bigMoves = useMemo(() => moves.filter((h) => Math.abs(h.delta_value) >= Math.max(1e6, h.weight > 0 ? (h.value / h.weight) * 0.001 : 0)), [moves])
  // Small moves fold away only beside bigger ones: when every move is small, they all show, so the header's
  // Bought and Sold counts are always visible below.
  const shownMoves = allMoves || !bigMoves.length ? moves : bigMoves
  // Header cards follow the lens: counted from the same holders the tables list.
  const c = useMemo(() => {
    if (!d) return null
    const n = (k: string) => tracked.filter((h) => h.change === k).length
    return { holders: tracked.length, prev_holders: tracked.filter((h) => h.change !== 'new').length + exited.length, new: n('new'), added: n('added'), trimmed: n('trimmed'), exited: exited.length }
  }, [d, tracked, exited])
  const multi = Boolean(d && d.quarters.length > 1)

  // Holdings filed since each fund's 13F, one roll-up per fund.
  const since = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof d>['since']>()
    for (const e of d?.since ?? []) groups.set(e.slug, [...(groups.get(e.slug) ?? []), e])
    // Only this page's classes: a Form 4 that trades Class A and B gives a line per class.
    const mine = new Set(d?.classes.map((c) => c.cusip))
    const tickers = new Set(d?.classes.map((c) => c.ticker))
    const rows: { key: string; who: { slug: string; manager: string }; p: Position }[] = []
    for (const [slug, evs] of groups) {
      for (const p of rollUp(evs!)) {
        if (p.cusip ? !mine.has(p.cusip) : !(p.ticker && tickers.has(p.ticker))) continue
        rows.push({ key: `${slug}|${p.key}`, who: { slug, manager: evs![0].manager }, p })
      }
    }
    return rows
  }, [d])
  const featuredSlugs = useMemo(() => new Set([...(d?.holders ?? []), ...(d?.exited ?? [])].filter((h) => h.featured).map((h) => h.slug)), [d])
  const sinceRows = since.filter((x) => scope === 'all' || featuredSlugs.has(x.who.slug))
  // The holder table's shares sum every class, so a newer holding sits under them only on single-class pages.
  const newer = new Map(d && d.classes.length === 1 ? since.filter((x) => x.p.cusip === d.classes[0].cusip && x.p.to != null).map((x) => [x.who.slug, x.p]) : [])
  const paid = Boolean(member?.active)
  // Members: the company's insiders' open-market trades from $100K since the quarter start (Jul 1 while
  // Q3 13Fs are due), largest first, from the issuer's own EDGAR feed (GET /events).
  const ev = useAsync(() => (paid && d ? loadEvents([d.ticker]) : Promise.resolve(null)), [paid, d?.ticker])
  const feed = d ? ev.data?.get(d.ticker) : undefined
  const from = (feed?.window ?? '').slice(0, 10)
  const insiders = (feed ?? [])
    .filter((e) => /^4/.test(e.form) && (e.action === 'buy' || e.action === 'sell') && Math.abs(e.value_usd ?? 0) >= 100_000 && (!from || (e.trade_date ?? e.accepted_at.slice(0, 10)) >= from))
    .sort((a, b) => Math.abs(b.value_usd ?? 0) - Math.abs(a.value_usd ?? 0))
    .slice(0, 5)
    .map(issuerLatest)

  if (s.error)
    return (
      <div className="container-x pt-20">
        <h1 className="text-[32px] font-semibold tracking-[-0.03em]">No investor we follow holds {ticker.toUpperCase()}.</h1>
        <p className="mt-3 text-ink-2">Stock pages cover every ticker in the latest 13F filings of the funds we track.</p>
        <Button to="/investors/" className="mt-6">
          Browse investors <Arrow />
        </Button>
      </div>
    )

  const dh = c ? c.holders - c.prev_holders : 0
  const featuredCount = d?.holders.filter((h) => h.featured).length ?? 0
  // All-filer lens: filers per report quarter, newest first.
  const fq = filers ? Object.entries(filers.quarters).sort((a, b) => b[0].localeCompare(a[0])) : null
  return (
    <div className="container-x pt-10 md:pt-14">
      <nav className="text-[13px] text-ink-3" aria-label="Breadcrumb">
        <Link to="/consensus/" className="hover:text-ink">
          Stocks
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink-2">{d?.ticker ?? ticker.toUpperCase()}</span>
      </nav>

      <header className="mt-6 flex flex-wrap items-start justify-between gap-6">
        {/* Full width on a phone, so the buttons sit under the name whether or not it has loaded. */}
        <div className="min-w-0 basis-full sm:basis-auto">
          <p className="font-mono text-[15px] font-medium text-accent">
            {d ? d.classes.map((x) => x.ticker).join(' · ') : ticker.toUpperCase()}
          </p>
          <h1 className="mt-1 text-[34px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-[44px]">{d?.name ?? '\u00a0'}</h1>
          <p className="mt-2 flex min-h-6 flex-wrap items-center gap-2 text-[15px] text-ink-2">
            {d?.sector && <Badge>{d.sector}</Badge>}
            {d && d.classes.length > 1 && <span className="text-[13.5px] text-ink-3">Share classes combined</span>}
            {d?.splits &&
              Object.entries(d.splits).map(([q, r]) => (
                <Link key={q} to="/methodology/#splits">
                  <Badge tone={r.adjusted ? 'neutral' : 'warn'}>{r.adjusted ? `Split ${r.ratio} in ${quarterLabel(q)}, adjusted` : `Possible ${r.ratio} split in ${quarterLabel(q)}, not counted`}</Badge>
                </Link>
              ))}
          </p>
        </div>
        {/* Rendered before the data arrives (a placeholder for Follow), so nothing below moves when it does. */}
        <div className="flex flex-col items-start gap-3 sm:items-end">
          {d ? <FollowButton kind="stock" id={d.ticker} name={d.ticker} size="md" /> : <Skeleton className="h-10 w-28 rounded-full" />}
          <Share text={`Who owns $${d?.ticker ?? ticker.toUpperCase()}: the superinvestors and funds holding ${d?.name ?? 'it'}, from 13F filings`} />
        </div>
      </header>

      <div className="mt-8 grid grid-cols-2 gap-6 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:grid-cols-4 md:p-6">
        {wide ? (
          <>
            <Stat label={`${who.charAt(0).toUpperCase()}${who.slice(1)} holding it`} value={filers ? filers.filers.toLocaleString('en-US') : '—'} sub={filers && filers.filers > filers.rows.length ? `The ${filers.rows.length} largest are listed below` : 'Latest 13F of each filer'} />
            <Stat
              label={fq ? `Filed ${quarterLabel(fq[0][0])} so far` : 'Filed so far'}
              value={fq ? fq[0][1].toLocaleString('en-US') : '—'}
              sub={fq && filers ? (fq.length > 1 ? `of ${filers.filers.toLocaleString('en-US')}; the rest are on ${fq.slice(1).map(([q]) => quarterLabel(q)).join(' or ')}` : `all ${filers.filers.toLocaleString('en-US')}`) : undefined}
            />
            <Stat label="Superinvestors among them" value={d ? featuredCount : '—'} sub={d ? `${d.holders.length} of the funds we track closely` : undefined} />
            <Stat label="Largest holder" value={holders[0] ? <span className="block truncate text-[20px]">{holders[0].manager}</span> : '—'} sub={holders[0] ? `${sharesFmt(holders[0].shares)} shares · ${quarterLabel(holders[0].quarter)}` : undefined} />
          </>
        ) : (
          <>
        <Stat
          label={scope === 'featured' ? 'Superinvestors holding it' : 'Funds holding it'}
          value={c ? c.holders : '—'}
          sub={d ? (scope === 'featured' ? `${d.holders.length} of all funds we track hold it` : `${featuredCount} of them superinvestors`) : undefined}
        />
        <Stat
          label="Change in holders"
          value={c ? <span className={dh > 0 ? 'text-up' : dh < 0 ? 'text-down' : ''}>{dh > 0 ? `+${dh}` : dh < 0 ? `−${-dh}` : '0'}</span> : '—'}
          sub={c ? `${c.prev_holders} held it the filing before` : undefined}
        />
        <Stat label="Bought" value={c ? c.new + c.added : '—'} sub={c ? `${c.new} new positions` : undefined} />
        <Stat label="Sold" value={c ? c.trimmed + c.exited : '—'} sub={c ? `${c.exited} exited completely` : undefined} />
          </>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-3">
          {wide
            ? fq && filers
              ? fq.length > 1
                ? `Mid-season: ${fq[0][1].toLocaleString('en-US')} of ${filers.filers.toLocaleString('en-US')} ${who} holding it have filed ${quarterLabel(fq[0][0])}; the rest are on ${fq.slice(1).map(([q]) => quarterLabel(q)).join(' or ')}. Each row is labelled with its quarter.`
                : `From each filer’s ${quarterLabel(fq[0][0])} 13F.`
              : ''
            : d
            ? d.quarters.length > 1
              ? `Mid-season: ${holders.filter((h) => h.quarter === d.quarters[0]).length} of ${holders.length} funds shown have filed ${quarterLabel(d.quarters[0])}; the rest are still on ${d.quarters.slice(1).map(quarterLabel).join(' or ')}. Each row is labelled with its quarter, compared with that fund’s filing before.`
              : `From each fund’s ${quarterLabel(d.quarters[0])} 13F, compared with its filing before.`
            : ''}{' '}
          <Link to={recapPath(seasonNow().quarter)} className="font-medium text-accent hover:text-accent-2">
            {quarterLabel(seasonNow().quarter)} recap
          </Link>
        </p>
        <div className="seg rounded-full bg-ink/[0.05] p-0.5 text-[13px] [mask-image:linear-gradient(to_right,#000_88%,transparent)] sm:[mask-image:none]" role="tablist" aria-label="Investors">
          {(
            [
              ['featured', 'Superinvestors', 'Superinvestors'],
              ['hedge', 'Hedge funds', 'Hedge funds'],
              ['smart', 'Hedge funds + long-only', 'HF + long-only'],
              ['filers', 'All 13F filers', 'All'],
              ['all', 'Funds we track', 'Tracked'],
            ] as const
          ).map(([k, l, short]) => (
            <button key={k} role="tab" aria-selected={view === k} aria-label={l} onClick={() => setView(k)} className={`rounded-full px-3 py-1.5 ${view === k ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
              <span className="sm:hidden">{short}</span>
              <span className="hidden sm:inline">{l}</span>
            </button>
          ))}
        </div>
      </div>

      {sinceRows.length > 0 && (
        <Panel className="mt-4" title="Since the latest 13Fs" sub="Holdings filed after each fund’s 13F, on Form 4 and Schedule 13D/G">
          <ul className="divide-y divide-line">
            {(paid ? sinceRows : sinceRows.slice(0, 2)).map(({ key, who, p }) => (
              <PositionLine key={key} p={p} who={who} />
            ))}
          </ul>
          {!paid && sinceRows.length > 2 && (
            <p className="mt-3 flex items-center gap-2 text-[13px] text-accent-2">
              <Lock /> {sinceRows.length - 2} more {sinceRows.length - 2 === 1 ? 'holding' : 'holdings'} filed on {d?.ticker} since the 13Fs.{' '}
              <Link to="/pricing/" className="font-medium underline underline-offset-2">
                See them with Copy
              </Link>
            </p>
          )}
        </Panel>
      )}

      {paid && d && feed && (
        <Panel className="mt-4" title="Company insiders" sub={`Open-market Form 4 trades from $100K${from ? ` since ${new Date(Date.parse(`${from}T12:00:00Z`) - 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : ' in recent filings'}, largest first`}>
          {insiders.length ? (
            <ul className="divide-y divide-line">
              {insiders.map((l) => (
                <li key={l.accession} className="flex items-baseline justify-between gap-3 py-2.5 text-[14px]">
                  <a href={l.url} className="min-w-0 truncate hover:text-accent" title="Open the filing on EDGAR">
                    {l.line}
                  </a>
                  <span className="shrink-0 text-[12.5px] text-ink-3">{dateLabel(l.date)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[14px] text-ink-3">No open-market insider buys or sells of $100K or more in this window.</p>
          )}
        </Panel>
      )}

      <div className="mt-4 grid gap-6 lg:grid-cols-[1.3fr_1fr] [&>*]:min-w-0">
        <Panel
          title="Who bought and sold"
          sub={
            wide
              ? 'Among the funds we track closely, since each one’s previous filing. Buys and sells for every filer come once their prior quarters are on file.'
              : 'Change in shares since each fund’s previous filing, at quarter-end value'
          }
        >
          {!d ? (
            <Skeleton className="h-[300px] w-full" />
          ) : shownMoves.length ? (
            <ChangeBars
              names
              items={shownMoves.slice(0, 14).map((h) => ({
                key: h.slug,
                label: h.manager,
                tag: [quarterLabel(h.quarter), h.change === 'new' || h.change === 'exited' ? CHANGE[h.change].label.toLowerCase() : ''].filter(Boolean).join(' · '),
                delta: h.delta_value,
              }))}
            />
          ) : (
            <p className="text-[14px] text-ink-2">No buying or selling in the latest filings.</p>
          )}
          {d && moves.length > 0 && !bigMoves.length && <p className="mt-3 text-[12.5px] text-ink-3">All small moves: under $1M or 0.1% of each fund’s book.</p>}
          {d && bigMoves.length > 0 && moves.length > bigMoves.length && (
            <button onClick={() => setAllMoves((x) => !x)} className="mt-3 text-[13px] font-medium text-accent hover:text-accent-2">
              {allMoves ? 'Hide small moves' : `Show all ${moves.length} moves (${moves.length - bigMoves.length} under $1M or 0.1% of the fund’s book)`}
            </button>
          )}
        </Panel>
        <Panel title="Largest holders" sub="Value as filed, and weight in each fund’s portfolio">
          {!d || filersLoading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <ul className="divide-y divide-line">
              {holders.slice(0, 8).map((h) => (
                <HolderRow key={h.slug} h={h} fresh={multi && h.quarter === d.quarters[0]} />
              ))}
              {!holders.length && <li className="py-3 text-[14px] text-ink-2">None of the superinvestors hold it right now.</li>}
            </ul>
          )}
        </Panel>
      </div>

      <section className="mt-6 overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">Every holder</h2>
            <p className="text-[13px] text-ink-3">
              {api ? `All ${api.count.toLocaleString('en-US')} ${who}, largest first, each compared with its previous 13F` : filers && filers.filers > holders.length ? `The ${holders.length} largest of ${filers.filers.toLocaleString('en-US')} ${who}` : `${holders.length.toLocaleString('en-US')} funds`} · shares only; options are listed separately below
              {wide && !api && ' · change shows for the funds we track closely until other filers’ prior quarters are on file'}
            </p>
          </div>
          {paid && d && <CsvButton variant="outline" label="Holders CSV" download={() => downloadFile(`/stocks/${encodeURIComponent(d.ticker)}/holders.csv${typed ? `?type=${typed === 'hedge' ? 'hedge_fund' : 'hedge_fund,long_only'}` : ''}`, `copybook-${d.ticker}-holders${typed ? `-${typed === 'hedge' ? 'hedge-funds' : 'hedge-long-only'}` : ''}.csv`)} />}
        </header>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Every holder">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                <th className="px-5 py-2.5 font-medium md:px-6">Investor</th>
                <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Shares</th>
                <th className="px-3 py-2.5 text-right font-medium">Change</th>
                <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Value</th>
                <th className="px-5 py-2.5 text-right font-medium md:px-6">Weight</th>
              </tr>
            </thead>
            <tbody>
              {holders.slice(0, n).map((h) => (
                <tr key={h.slug} className="border-b border-line last:border-0 hover:bg-ink/[0.025]">
                  <td className="px-5 py-2.5 md:px-6">
                    <Link to={`/investors/${h.slug}/`} className="flex min-w-0 items-center gap-2.5 hover:text-accent">
                      <Monogram name={h.manager} size={24} />
                      <span className="min-w-0 max-w-[7.75rem] truncate font-medium sm:max-w-[22rem]">{h.manager}</span>
                      <QuarterTag q={h.quarter} fresh={multi && h.quarter === d!.quarters[0]} />
                    </Link>
                  </td>
                  <td className="num hidden px-3 py-2.5 text-right text-ink-2 sm:table-cell">
                    {sharesFmt(h.shares)}
                    {newer.get(h.slug) && newer.get(h.slug)!.to !== h.shares && (
                      <span className="block whitespace-nowrap text-[11.5px] text-ink-3">
                        {sharesFmt(newer.get(h.slug)!.to)} as of {dateLabel(newer.get(h.slug)!.asOf)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <ChangeCell h={h} />
                  </td>
                  <td className="num hidden px-3 py-2.5 text-right font-medium sm:table-cell">{money(h.value)}</td>
                  <td className="num px-5 py-2.5 text-right md:px-6">{pct(h.weight)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(holders.length > n || api?.more) && (
          <div className="flex items-center justify-between border-t border-line px-6 py-3 text-[13px] text-ink-3">
            <span>
              Showing {Math.min(n, holders.length).toLocaleString('en-US')} of {(api?.count ?? holders.length).toLocaleString('en-US')}
            </span>
            <button
              onClick={() => {
                if (n + 50 > holders.length && api?.more) setPages((p) => p + 1)
                setN((x) => x + 50)
              }}
              disabled={full.loading}
              className="min-h-11 font-medium text-accent hover:text-accent-2 disabled:opacity-60"
            >
              {full.loading ? 'Loading…' : 'Show more'}
            </button>
          </div>
        )}
      </section>

      {d && (exited.length > 0 || options.length > 0) && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          {exited.length > 0 && (
            <Panel title="Sold out completely" sub="Held it in the previous filing, none in the latest">
              <ul className="divide-y divide-line">
                {exited.slice(0, 10).map((h) => (
                    <li key={h.slug} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
                      <span className="flex min-w-0 items-center gap-2">
                        <Link to={`/investors/${h.slug}/`} className="min-w-0 truncate font-medium hover:text-accent">
                          {h.manager}
                        </Link>
                        <QuarterTag q={h.quarter} fresh={multi && h.quarter === d.quarters[0]} />
                      </span>
                      <span className="num shrink-0 text-ink-2">{money(h.prev_value)} sold</span>
                    </li>
                  ))}
              </ul>
            </Panel>
          )}
          {options.length > 0 && (
            <Panel title="Options" sub="Calls and puts as filed. The value is the notional of the underlying shares, not the option’s price.">
              <ul className="divide-y divide-line">
                {options
                  .slice(0, 10)
                  .map((o) => (
                    <li key={o.slug + o.put_call} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
                      <span className="flex min-w-0 items-center gap-2">
                        <Badge tone={o.put_call.toLowerCase() === 'put' ? 'down' : 'up'} className="shrink-0">
                          {o.put_call.toLowerCase() === 'put' ? 'Puts' : 'Calls'}
                        </Badge>
                        <Link to={`/investors/${o.slug}/`} className="truncate font-medium hover:text-accent">
                          {o.manager}
                        </Link>
                        <QuarterTag q={o.quarter} fresh={multi && o.quarter === d.quarters[0]} />
                      </span>
                      <span className="num shrink-0 text-ink-2">{money(o.value)} notional</span>
                    </li>
                  ))}
              </ul>
            </Panel>
          )}
        </div>
      )}

      <Signup source="stock" className="mt-6" />

      <p className="mt-6 text-[13px] leading-relaxed text-ink-3">
        Built from each fund’s latest Form 13F-HR as filed with the SEC. Holder counts include share positions only. 13F filings are quarter-end snapshots filed up to 45 days later. Not investment advice.
      </p>
    </div>
  )
}

/** Every stock-page row says which 13F it comes from; the newest quarter is highlighted mid-season. */
function QuarterTag({ q, fresh }: { q: string; fresh: boolean }) {
  return <span className={`shrink-0 whitespace-nowrap rounded px-1 text-[11.5px] ${fresh ? 'bg-accent-soft text-accent-2' : 'text-ink-3'}`}>{quarterLabel(q)}</span>
}

function HolderRow({ h, fresh }: { h: StockHolder; fresh: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
      <Link to={`/investors/${h.slug}/`} className="flex min-w-0 items-center gap-2.5 hover:text-accent">
        <Monogram name={h.manager} size={26} />
        <span className="min-w-0">
          <span className="block truncate font-medium">{h.manager}</span>
          <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
            <span className="truncate">{pct(h.weight)} of portfolio</span>
            <QuarterTag q={h.quarter} fresh={fresh} />
          </span>
        </span>
      </Link>
      <span className="flex shrink-0 items-center gap-2">
        <ChangeCell h={h} />
        <span className="num w-16 text-right font-medium">{money(h.value)}</span>
      </span>
    </li>
  )
}

function ChangeCell({ h }: { h: StockHolder }) {
  if (!h.change) return <span className="text-[13px] text-ink-3">—</span>
  if (h.change === 'new' || h.change === 'exited') return <Badge tone={CHANGE[h.change].tone}>{CHANGE[h.change].label}</Badge>
  if (h.change === 'unchanged') return <span className="whitespace-nowrap text-[13px] text-ink-3">No change</span>
  const r = h.prev_shares ? (h.shares - h.prev_shares) / h.prev_shares : 0
  return (
    <span className={`num whitespace-nowrap text-[13px] font-medium ${r > 0 ? 'text-up' : 'text-down'}`}>
      {r > 0 ? '+' : '−'}
      {pct(Math.abs(r), 0)}
    </span>
  )
}
