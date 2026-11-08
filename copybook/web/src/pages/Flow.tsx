import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AvatarStack, Badge, Lock, Monogram, Panel, Skeleton } from '../components/ui'
import { dateLabel, money, quarterLabel, useAsync, useTitle } from '../lib/data'
import { useMember } from '../lib/account'
import { loadFlow, stockPath, type FlowRow, type FlowScope } from '../lib/stocks'

type Tab = 'bought' | 'sold' | 'most_buyers' | 'new_multi'
const TABS: [Tab, string][] = [
  ['bought', 'Bought'],
  ['sold', 'Sold'],
  ['most_buyers', 'Most buyers'],
  ['new_multi', 'New by 2+'],
]
const FREE_ROWS = 5

export function Flow() {
  const f = useAsync(loadFlow, [])
  const member = useMember()
  const paid = Boolean(member?.active)
  const [scope, setScope] = useState<'featured' | 'all'>('all')
  const [tab, setTab] = useState<Tab>('bought')
  useTitle('Smart money flow · Copybook')
  const d = f.data
  const s: FlowScope | undefined = d?.[scope]
  const rows = s?.[tab] ?? []
  const shown = paid ? rows.slice(0, 40) : rows.slice(0, FREE_ROWS)

  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Smart money flow{d ? ` · ${quarterLabel(d.quarter)} filings` : ''}</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">What the best investors bought and sold this season.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          Every 13F that has landed for the latest quarter, compared with the same fund’s filing before. Updated as filings arrive through the deadline.
        </p>
      </header>

      {d && (
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px] text-ink-2">
          <span>
            <span className="num font-semibold text-ink">{d.featured_filed}</span> of {d.featured_total} superinvestors have filed {quarterLabel(d.quarter)}
          </span>
          <span className="hidden text-ink-3 sm:inline">·</span>
          <span>
            <span className="num font-semibold text-ink">{d.funds_filed}</span> funds in total
          </span>
        </div>
      )}

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[1fr_320px] [&>*]:min-w-0">
        <section className="overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
            <div className="inline-flex flex-wrap rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Ranking">
              {TABS.map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-full px-3 py-1.5 ${tab === k ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                  {l}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <span>Investors</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as 'featured' | 'all')} className="h-8 rounded-full bg-paper px-3 text-[13px] shadow-[0_0_0_1px_var(--color-line)] outline-none focus:shadow-[0_0_0_2px_var(--color-accent)]">
                <option value="all">All funds we track</option>
                <option value="featured">Superinvestors only</option>
              </select>
            </label>
          </header>
          <p className="border-b border-line px-5 py-2.5 text-[12.5px] text-ink-3 md:px-6">
            {tab === 'bought' && 'Net shares bought across funds, valued at quarter end.'}
            {tab === 'sold' && 'Net shares sold across funds, valued at quarter end.'}
            {tab === 'most_buyers' && 'Stocks the most funds opened or added to.'}
            {tab === 'new_multi' && 'New positions opened by two or more funds. Spin-offs and fresh listings nobody held before are left out.'}
          </p>
          {!d ? (
            <div className="space-y-2 p-6">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="px-6 py-10 text-[14px] text-ink-2">
              {scope === 'featured' && (d.featured_filed ?? 0) < 3
                ? `Only ${d.featured_filed} superinvestors have filed for ${quarterLabel(d.quarter)} so far. This fills in as the deadline approaches.`
                : 'Nothing here yet for this quarter.'}
            </p>
          ) : (
            <ol>
              {shown.map((r, i) => (
                <FlowItem key={r.ticker} r={r} i={i} tab={tab} />
              ))}
            </ol>
          )}
          {d && !paid && rows.length > FREE_ROWS && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-accent-soft px-5 py-4 md:px-6">
              <p className="flex items-center gap-2 text-[13.5px] text-accent-2">
                <Lock /> {Math.min(rows.length, 40) - FREE_ROWS} more names, plus every fund behind each move, with Copy
              </p>
              <Link to="/pricing/" className="inline-flex h-8 items-center rounded-full bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent-2">
                Start 14-day free trial
              </Link>
            </div>
          )}
        </section>

        <Panel title="Just filed" sub={d ? `${quarterLabel(d.quarter)} 13Fs, newest first` : undefined}>
          {!d ? (
            <Skeleton className="h-[360px] w-full" />
          ) : (
            <ul className="divide-y divide-line">
              {d.recent
                .filter((r) => scope === 'all' || r.featured)
                .slice(0, 12)
                .map((r) => (
                  <li key={r.slug}>
                    <Link to={`/investors/${r.slug}/`} className="flex items-center gap-3 py-2.5 hover:text-accent">
                      <Monogram name={r.manager} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium">{r.manager}</span>
                        <span className="block truncate text-[12px] text-ink-3">
                          Filed {dateLabel(r.filing_date)}
                          {r.changes ? ` · ${r.changes.new} new, ${r.changes.exited} exited` : ''}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </Panel>
      </div>

      <p className="mt-6 text-[13px] leading-relaxed text-ink-3">
        Built from Form 13F-HR filings as filed with the SEC. Each fund is compared with its own previous filing; share changes are valued at the newer filing’s quarter-end value. Options are left out. Not investment advice.
      </p>
    </div>
  )
}

function FlowItem({ r, i, tab }: { r: FlowRow; i: number; tab: Tab }) {
  const sell = tab === 'sold'
  const who = sell ? r.sellers : tab === 'new_multi' ? r.buyers.filter((b) => b.change === 'new') : r.buyers
  const value = tab === 'sold' ? r.net_value : tab === 'bought' ? r.net_value : r.buy_value
  return (
    <li className="border-b border-line last:border-0">
      <Link to={stockPath(r.ticker)} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3 hover:bg-ink/[0.025] md:grid-cols-[2rem_minmax(0,1.3fr)_1fr_7rem] md:px-6">
        <span className="num text-[13px] text-ink-3">{i + 1}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-medium">{r.ticker}</span>
            {tab === 'new_multi' && <Badge tone="up">{r.new_by.length} new</Badge>}
          </span>
          <span className="block truncate text-[13px] text-ink-3">{r.name}</span>
        </span>
        <span className="hidden items-center gap-2 md:flex">
          <AvatarStack names={who.map((w) => ({ slug: w.slug, name: w.manager }))} />
          <span className="truncate text-[12.5px] text-ink-3">
            {r.buyers.length} bought · {r.sellers.length} sold
          </span>
        </span>
        <span className={`num text-right text-[14px] font-medium ${value >= 0 ? 'text-up' : 'text-down'}`}>
          {value >= 0 ? '+' : '−'}
          {money(Math.abs(value))}
        </span>
      </Link>
    </li>
  )
}
