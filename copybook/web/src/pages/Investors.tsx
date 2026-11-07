import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Monogram, Skeleton } from '../components/ui'
import { shortName, loadIndex, money, pct, quarterLabel, useAsync, type Manager } from '../lib/data'
import { ManagerCard } from './Home'

type Sort = 'value' | 'name' | 'positions' | 'recent'

export function Investors() {
  const idx = useAsync(loadIndex, [])
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'featured' | 'all'>('featured')
  const [sort, setSort] = useState<Sort>('value')

  const list = useMemo(() => {
    const all = idx.data?.managers ?? []
    const base = tab === 'featured' ? all.filter((m) => m.featured) : all
    const n = q.trim().toLowerCase()
    const hits = n ? base.filter((m) => `${m.manager} ${m.name}`.toLowerCase().includes(n)) : base
    const s = [...hits]
    if (sort === 'name') s.sort((a, b) => a.manager.localeCompare(b.manager))
    else if (sort === 'positions') s.sort((a, b) => (b.position_count ?? 0) - (a.position_count ?? 0))
    else if (sort === 'recent') s.sort((a, b) => (b.filing_date ?? '').localeCompare(a.filing_date ?? ''))
    else s.sort((a, b) => (b.total_value ?? 0) - (a.total_value ?? 0))
    return s
  }, [idx.data, q, tab, sort])

  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Investors</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Portfolios worth following.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          Legendary value investors, hedge-fund founders, activists and the largest institutions, each with their latest 13F portfolio.
        </p>
      </header>

      <div className="sticky top-16 z-30 -mx-5 mt-10 border-b border-line bg-paper/90 px-5 py-3 backdrop-blur-xl md:-mx-8 md:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-full bg-ink/[0.05] p-1" role="tablist" aria-label="Investor set">
            {(['featured', 'all'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-full px-3.5 py-1.5 text-[13.5px] ${tab === t ? 'bg-card font-medium text-ink shadow-[var(--shadow-card)]' : 'text-ink-2 hover:text-ink'}`}
              >
                {t === 'featured' ? 'Superinvestors' : 'All funds'}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor="inv-filter">
            Filter investors
          </label>
          <input
            id="inv-filter"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by name or firm"
            className="h-9 min-w-0 flex-1 rounded-full bg-card px-4 text-[14px] shadow-[0_0_0_1px_var(--color-line)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)] sm:max-w-xs"
          />
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-3">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="h-9 rounded-full bg-card px-3 text-[13.5px] text-ink shadow-[0_0_0_1px_var(--color-line)] outline-none"
            >
              <option value="value">Portfolio size</option>
              <option value="recent">Latest filing</option>
              <option value="positions">Positions</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>
      </div>

      {idx.loading && (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className="h-[188px] rounded-[var(--radius-card)]" />
          ))}
        </div>
      )}
      {idx.error && <p className="mt-8 text-ink-2">We couldn’t load the investor list. Refresh to try again.</p>}

      {!idx.loading && tab === 'featured' && (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((m) => (
            <ManagerCard key={m.slug} m={m} />
          ))}
        </div>
      )}
      {!idx.loading && tab === 'all' && <FundTable list={list} />}
      {!idx.loading && list.length === 0 && <p className="mt-10 text-[15px] text-ink-2">No investors match “{q}”. Try the search at the top for any 13F filer.</p>}
    </div>
  )
}

function FundTable({ list }: { list: Manager[] }) {
  const [n, setN] = useState(60)
  return (
    <div className="mt-6 overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
      <table className="w-full text-[14px]">
        <thead>
          <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
            <th className="px-4 py-3 font-medium md:px-5">Fund</th>
            <th className="hidden px-4 py-3 font-medium md:table-cell">Largest position</th>
            <th className="px-4 py-3 text-right font-medium">Portfolio</th>
            <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">Positions</th>
            <th className="hidden px-4 py-3 text-right font-medium md:table-cell md:pr-5">Quarter</th>
          </tr>
        </thead>
        <tbody>
          {list.slice(0, n).map((m) => {
            const t = m.top?.[0]
            return (
              <tr key={m.slug} className="border-b border-line last:border-0 hover:bg-ink/[0.025]">
                <td className="px-4 py-3 md:px-5">
                  <Link to={`/investors/${m.slug}/`} className="flex items-center gap-3">
                    <Monogram name={m.manager} size={30} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{m.manager}</span>
                      {m.name !== m.manager && <span className="block truncate text-[12.5px] text-ink-3">{m.name}</span>}
                    </span>
                  </Link>
                </td>
                <td className="hidden px-4 py-3 md:table-cell">
                  {t ? (
                    <span className="text-ink-2">
                      <span className="font-mono text-[12.5px] text-ink">{t.ticker || shortName(t.issuer)}</span> <span className="num">{pct(t.weight)}</span>
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="num px-4 py-3 text-right font-medium">{money(m.total_value)}</td>
                <td className="num hidden px-4 py-3 text-right text-ink-2 sm:table-cell">{m.position_count?.toLocaleString('en-US')}</td>
                <td className="hidden px-4 py-3 text-right text-ink-2 md:table-cell md:pr-5">{quarterLabel(m.quarter)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {list.length > n && (
        <div className="flex items-center justify-between border-t border-line px-5 py-3 text-[13px] text-ink-3">
          <span>
            Showing {n} of {list.length}
          </span>
          <button onClick={() => setN((x) => x + 60)} className="font-medium text-accent hover:text-accent-2">
            Show more
          </button>
        </div>
      )}
    </div>
  )
}
