import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ChangeBars } from '../components/charts'
import { FollowButton } from '../components/FollowButton'
import { PositionLine, rollUp, type Position } from '../components/FundNotes'
import { useMember } from '../lib/account'
import { Arrow, Badge, Button, Lock, Monogram, Panel, Skeleton, Stat } from '../components/ui'
import { dateLabel, money, pct, quarterLabel, sharesFmt, useAsync, useTitle } from '../lib/data'
import { loadStock, resolveTicker, stockPath, type StockHolder } from '../lib/stocks'

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
  const scope: 'featured' | 'all' = params.get('funds') === 'all' ? 'all' : 'featured'
  const setScope = (k: 'featured' | 'all') => setParams(k === 'all' ? { funds: 'all' } : {}, { replace: true })
  const member = useMember()
  const [n, setN] = useState(25)
  const d = s.data
  useTitle(d ? `${d.ticker} · ${d.name}: who owns it · Copybook` : undefined)

  // GOOG -> GOOGL, lowercase -> uppercase: send other share classes to the issuer's page.
  useEffect(() => {
    if (!s.error) return
    resolveTicker(ticker).then((t) => t && t !== ticker && nav(stockPath(t), { replace: true }))
  }, [s.error, ticker, nav])

  const holders = useMemo(() => (d?.holders ?? []).filter((h) => scope === 'all' || h.featured), [d, scope])
  const moves = useMemo(
    () =>
      [...(d?.holders ?? []), ...(d?.exited ?? [])]
        .filter((h) => (scope === 'all' || h.featured) && h.change && h.change !== 'unchanged' && h.delta_value)
        .sort((a, b) => Math.abs(b.delta_value) - Math.abs(a.delta_value)),
    [d, scope],
  )

  // Holdings filed since each fund's 13F, one roll-up per fund.
  const since = useMemo(() => {
    const per = new Map<string, { who: { slug: string; manager: string }; p: Position }>()
    const groups = new Map<string, NonNullable<typeof d>['since']>()
    for (const e of d?.since ?? []) groups.set(e.slug, [...(groups.get(e.slug) ?? []), e])
    for (const [slug, evs] of groups) {
      const p = rollUp(evs!)[0]
      if (p) per.set(slug, { who: { slug, manager: evs![0].manager }, p })
    }
    return per
  }, [d])
  const featuredSlugs = useMemo(() => new Set([...(d?.holders ?? []), ...(d?.exited ?? [])].filter((h) => h.featured).map((h) => h.slug)), [d])
  const sinceRows = [...since.values()].filter((x) => scope === 'all' || featuredSlugs.has(x.who.slug))
  const paid = Boolean(member?.active)

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

  const c = d?.counts
  const dh = c ? c.holders - c.prev_holders : 0
  const featuredCount = d?.holders.filter((h) => h.featured).length ?? 0
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
        <div className="min-w-0">
          <p className="font-mono text-[15px] font-medium text-accent">
            {d ? d.classes.map((x) => x.ticker).join(' · ') : ticker.toUpperCase()}
          </p>
          <h1 className="mt-1 text-[34px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-[44px]">{d?.name ?? '\u00a0'}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[15px] text-ink-2">
            {d?.sector && <Badge>{d.sector}</Badge>}
            {d && d.classes.length > 1 && <span className="text-[13.5px] text-ink-3">Share classes combined</span>}
          </p>
        </div>
        {d && <FollowButton kind="stock" id={d.ticker} name={d.ticker} size="md" />}
      </header>

      <div className="mt-8 grid grid-cols-2 gap-6 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:grid-cols-4 md:p-6">
        <Stat label="Funds holding it" value={c ? c.holders : '—'} sub={c ? `${featuredCount} of them superinvestors` : undefined} />
        <Stat
          label="Change in holders"
          value={c ? <span className={dh > 0 ? 'text-up' : dh < 0 ? 'text-down' : ''}>{dh > 0 ? `+${dh}` : dh < 0 ? `−${-dh}` : '0'}</span> : '—'}
          sub={c ? `${c.prev_holders} held it the filing before` : undefined}
        />
        <Stat label="Bought" value={c ? c.new + c.added : '—'} sub={c ? `${c.new} new positions` : undefined} />
        <Stat label="Sold" value={c ? c.trimmed + c.exited : '—'} sub={c ? `${c.exited} exited completely` : undefined} />
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-3">
          {d
            ? d.quarters.length > 1
              ? `Mid-season: ${holders.filter((h) => h.quarter === d.quarters[0]).length} of ${holders.length} funds shown have filed ${quarterLabel(d.quarters[0])}; the rest are still on ${d.quarters.slice(1).map(quarterLabel).join(' or ')}. Each row is labelled with its quarter, compared with that fund’s filing before.`
              : `From each fund’s ${quarterLabel(d.quarters[0])} 13F, compared with its filing before.`
            : ''}
        </p>
        <div className="inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Investors">
          {(
            [
              ['featured', 'Superinvestors'],
              ['all', 'All funds we track'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={scope === k} onClick={() => setScope(k)} className={`rounded-full px-3 py-1.5 ${scope === k ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {sinceRows.length > 0 && (
        <Panel className="mt-4" title="Since the latest 13Fs" sub="Holdings filed after each fund’s 13F, on Form 4 and Schedule 13D/G">
          <ul className="divide-y divide-line">
            {(paid ? sinceRows : sinceRows.slice(0, 2)).map(({ who, p }) => (
              <PositionLine key={who.slug} p={p} who={who} />
            ))}
          </ul>
          {!paid && sinceRows.length > 2 && (
            <p className="mt-3 flex items-center gap-2 text-[13px] text-accent-2">
              <Lock /> {sinceRows.length - 2} more funds filed on {d?.ticker} since their 13F.{' '}
              <Link to="/pricing/" className="font-medium underline underline-offset-2">
                See them with Copy
              </Link>
            </p>
          )}
        </Panel>
      )}

      <div className="mt-4 grid gap-6 lg:grid-cols-[1.3fr_1fr] [&>*]:min-w-0">
        <Panel title="Who bought and sold" sub="Change in shares since each fund’s previous filing, at quarter-end value">
          {!d ? (
            <Skeleton className="h-[300px] w-full" />
          ) : moves.length ? (
            <ChangeBars names items={moves.slice(0, 14).map((h) => ({ key: h.slug, label: h.manager, tag: h.change === 'new' || h.change === 'exited' ? CHANGE[h.change].label.toLowerCase() : undefined, delta: h.delta_value }))} />
          ) : (
            <p className="text-[14px] text-ink-2">No buying or selling in the latest filings.</p>
          )}
        </Panel>
        <Panel title="Largest holders" sub="Value as filed, and weight in each fund’s portfolio">
          {!d ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <ul className="divide-y divide-line">
              {holders.slice(0, 8).map((h) => (
                <HolderRow key={h.slug} h={h} />
              ))}
              {!holders.length && <li className="py-3 text-[14px] text-ink-2">None of the superinvestors hold it right now.</li>}
            </ul>
          )}
        </Panel>
      </div>

      <section className="mt-6 overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
        <header className="border-b border-line px-5 py-4 md:px-6">
          <h2 className="text-[15px] font-semibold">Every holder</h2>
          <p className="text-[13px] text-ink-3">{holders.length.toLocaleString('en-US')} funds · shares only; options are listed separately below</p>
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
                      <span className={`shrink-0 rounded px-1 text-[11.5px] ${d && d.quarters.length > 1 && h.quarter === d.quarters[0] ? 'bg-accent-soft text-accent-2' : 'text-ink-3'}`}>{quarterLabel(h.quarter)}</span>
                    </Link>
                  </td>
                  <td className="num hidden px-3 py-2.5 text-right text-ink-2 sm:table-cell">
                    {sharesFmt(h.shares)}
                    {since.get(h.slug)?.p.to != null && since.get(h.slug)!.p.to !== h.shares && (
                      <span className="block whitespace-nowrap text-[11.5px] text-ink-3">
                        {sharesFmt(since.get(h.slug)!.p.to)} as of {dateLabel(since.get(h.slug)!.p.asOf)}
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
        {holders.length > n && (
          <div className="flex items-center justify-between border-t border-line px-6 py-3 text-[13px] text-ink-3">
            <span>
              Showing {n} of {holders.length.toLocaleString('en-US')}
            </span>
            <button onClick={() => setN((x) => x + 50)} className="font-medium text-accent hover:text-accent-2">
              Show more
            </button>
          </div>
        )}
      </section>

      {d && (d.exited.length > 0 || d.options.length > 0) && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          {d.exited.length > 0 && (
            <Panel title="Sold out completely" sub="Held it in the previous filing, none in the latest">
              <ul className="divide-y divide-line">
                {d.exited
                  .filter((h) => scope === 'all' || h.featured)
                  .slice(0, 10)
                  .map((h) => (
                    <li key={h.slug} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
                      <Link to={`/investors/${h.slug}/`} className="min-w-0 truncate font-medium hover:text-accent">
                        {h.manager}
                      </Link>
                      <span className="num shrink-0 text-ink-2">{money(h.prev_value)} sold</span>
                    </li>
                  ))}
              </ul>
            </Panel>
          )}
          {d.options.length > 0 && (
            <Panel title="Options" sub="Calls and puts as filed. The value is the notional of the underlying shares, not the option’s price.">
              <ul className="divide-y divide-line">
                {d.options
                  .filter((o) => scope === 'all' || o.featured)
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
                      </span>
                      <span className="num shrink-0 text-ink-2">{money(o.value)} notional</span>
                    </li>
                  ))}
              </ul>
            </Panel>
          )}
        </div>
      )}

      <p className="mt-6 text-[13px] leading-relaxed text-ink-3">
        Built from each fund’s latest Form 13F-HR as filed with the SEC. Holder counts include share positions only. 13F filings are quarter-end snapshots filed up to 45 days later. Not investment advice.
      </p>
    </div>
  )
}

function HolderRow({ h }: { h: StockHolder }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
      <Link to={`/investors/${h.slug}/`} className="flex min-w-0 items-center gap-2.5 hover:text-accent">
        <Monogram name={h.manager} size={26} />
        <span className="min-w-0">
          <span className="block truncate font-medium">{h.manager}</span>
          <span className="block truncate text-[12px] text-ink-3">{pct(h.weight)} of portfolio</span>
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
