import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChangeBars, Donut, foldSlices, Legend, StackBar, Treemap, WeightBars } from '../components/charts'
import { mapPlan, treemapItems, useBook } from '../components/Portfolio'
import { Arrow, Badge, Button, Lock, Monogram, Panel, Skeleton, Stat, Ticker } from '../components/ui'
import { csvUrl, useMember } from '../lib/account'
import { useTitle, shortName, dateLabel, loadManager, money, pct, quarterLabel, secFilerUrl, shareClass, sharesFmt, useAsync } from '../lib/data'

export function ManagerPage() {
  const { slug = '' } = useParams()
  const m = useAsync(() => loadManager(slug), [slug])
  const book = useBook(m.data?.holdings)
  const [q, setQ] = useState('')
  const [n, setN] = useState(25)
  const [color, setColor] = useState<'rank' | 'sector'>('rank')
  const f = m.data
  const member = useMember()
  useTitle(f ? `${f.manager} portfolio · Copybook` : undefined)
  const plan = mapPlan(book.rows, 20)
  const slices = foldSlices(book.sectors, 10)

  // Trades, not price moves: the change in shares, valued at the filing's own per-share value.
  const changes = useMemo(() => {
    return (f?.holdings || [])
      .filter((h) => h.change && h.change !== 'unchanged')
      .map((h) => {
        const per = h.shares ? h.value / h.shares : h.prev_shares ? (h.prev_value || 0) / h.prev_shares : 0
        const delta = h.change === 'exited' ? -(h.prev_value || 0) : ((h.shares || 0) - (h.prev_shares || 0)) * per
        return { key: h.cusip + (h.put_call || ''), label: h.ticker || shortName(h.issuer), tag: h.change ?? '', delta }
      })
      .filter((x) => x.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  }, [f])
  const paid = Boolean(member?.active)

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? book.rows.filter((h) => `${h.ticker ?? ''} ${h.issuer} ${h.cusip}`.toLowerCase().includes(s)) : book.rows
  }, [book.rows, q])

  if (m.error)
    return (
      <div className="container-x pt-20">
        <h1 className="text-[32px] font-semibold tracking-[-0.03em]">We couldn’t find that investor.</h1>
        <p className="mt-3 text-ink-2">The link may be old, or this fund has no recent 13F filing.</p>
        <Button to="/investors/" className="mt-6">
          Browse investors <Arrow />
        </Button>
      </div>
    )

  const stale = f?.quarter && f.quarter < '2026Q1'
  return (
    <div className="container-x pt-10 md:pt-14">
      <nav className="text-[13px] text-ink-3" aria-label="Breadcrumb">
        <Link to="/investors/" className="hover:text-ink">
          Investors
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink-2">{f?.manager ?? '…'}</span>
      </nav>

      <header className="mt-6 flex flex-wrap items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          {f ? <Monogram name={f.manager} size={64} /> : <Skeleton className="size-16 rounded-full" />}
          <div>
            <h1 className="text-[34px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-[44px]">{f?.manager ?? '\u00a0'}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[15px] text-ink-2">
              {f && f.name !== f.manager && <span>{f.name}</span>}
              {f && <Badge tone={stale ? 'warn' : 'neutral'}>{stale ? `Last filed ${quarterLabel(f.quarter)}` : `${quarterLabel(f.quarter)} 13F`}</Badge>}
            </p>
          </div>
        </div>
        {f && (
          <div className="flex gap-2">
            <Button href={f.sec_url} variant="outline" size="sm">
              View filing on SEC
            </Button>
            {member?.active ? (
              <Button href={csvUrl(f.slug)} variant="dark" size="sm">
                Download CSV
              </Button>
            ) : (
              <Button to="/pricing/" variant="dark" size="sm">
                Track changes
              </Button>
            )}
          </div>
        )}
      </header>

      <div className="mt-8 grid grid-cols-2 gap-6 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:grid-cols-4 md:p-6">
        <Stat label="Reported portfolio" value={f ? money(f.total_value) : '—'} sub={f ? `As of ${dateLabel(f.report_date)}` : undefined} />
        <Stat label="Positions" value={f ? book.rows.length.toLocaleString('en-US') : '—'} sub={f ? `Filed ${dateLabel(f.filing_date)}` : undefined} />
        <Stat label="Top 10 weight" value={f ? pct(book.top10, 0) : '—'} sub="Share of portfolio" />
        <Stat label="Largest position" value={book.top1 ? book.top1.ticker || shortName(book.top1.issuer) : '—'} sub={book.top1 ? `${pct(book.top1.weight)} of portfolio` : undefined} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Panel
          title="Portfolio map"
          sub={plan.broad ? `Largest ${plan.n} positions, ${pct(plan.shown, 0)} of the portfolio. Each tile is sized by reported value.` : 'Each tile is sized by reported value'}
          right={
            <div className="inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[12.5px]" role="tablist" aria-label="Color tiles by">
              {(['rank', 'sector'] as const).map((c) => (
                <button key={c} role="tab" aria-selected={color === c} onClick={() => setColor(c)} className={`rounded-full px-2.5 py-1 ${color === c ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                  {c === 'rank' ? 'Size' : 'Sector'}
                </button>
              ))}
            </div>
          }
        >
          {f && plan.broad && <p className="-mt-2 mb-3 text-[12.5px] text-ink-3">{plan.hidden.toLocaleString('en-US')} smaller positions make up the other {pct(1 - plan.shown, 0)}; see All holdings below.</p>}
          {f ? <Treemap items={treemapItems(book.rows, plan.n, color, !plan.broad)} height={360} /> : <Skeleton className="h-[360px] w-full" />}
        </Panel>
        <Panel title="Sector mix" sub="Share of reported value">
          {f ? (
            <>
              <div className="flex justify-center">
                <Donut slices={slices} size={180} thickness={26} center={{ value: pct(slices[0]?.share ?? 0, 0), label: slices[0]?.name ?? '' }} />
              </div>
              <div className="mt-6 flex">
                <Legend slices={slices} limit={10} />
              </div>
            </>
          ) : (
            <Skeleton className="h-[320px] w-full" />
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Top holdings" sub="Weight in the reported portfolio">
          {f ? (
            <WeightBars
              valueLabel="both"
              accentFirst={3}
              items={book.rows.slice(0, 10).map((h) => ({ key: h.key, label: h.ticker || shortName(h.issuer), isTicker: Boolean(h.ticker), sub: h.ticker ? h.issuer : undefined, value: h.value, weight: h.weight, tag: h.put_call || (h.issuer.includes('Class') ? '' : shareClass(h.title)) || undefined }))}
            />
          ) : (
            <Skeleton className="h-[360px] w-full" />
          )}
        </Panel>
        <Panel
          title="Quarter-over-quarter changes"
          sub={f?.prev_quarter ? `${quarterLabel(f.prev_quarter)} to ${quarterLabel(f.quarter)}: shares bought or sold, at quarter-end value` : 'Biggest buys and sells since the prior filing'}
        >
          {f?.changes && (
            <p className="-mt-2 mb-4 flex flex-wrap gap-1.5">
              {(['new', 'added', 'trimmed', 'exited'] as const).map((k) => (
                <Badge key={k} tone={k === 'new' || k === 'added' ? 'up' : 'down'}>
                  {f.changes![k]} {k === 'new' ? 'new' : k}
                </Badge>
              ))}
            </p>
          )}
          {changes.length ? (
            <>
              <ChangeBars items={paid ? changes.slice(0, 12) : changes.slice(0, 4)} />
              {!paid && changes.length > 4 && (
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-accent-soft px-4 py-3">
                  <p className="flex items-center gap-2 text-[13.5px] text-accent-2">
                    <Lock /> {changes.length - 4} more buys and sells, plus 8 quarters of history, with Copy
                  </p>
                  <Button to="/pricing/" size="sm">
                    Get Copy
                  </Button>
                </div>
              )}
            </>
          ) : f?.prev_quarter ? (
            <p className="text-[14px] text-ink-2">No shares bought or sold since {quarterLabel(f.prev_quarter)}.</p>
          ) : (
            <LockedChanges top={book.rows.slice(0, 6).map((h) => h.ticker || shortName(h.issuer))} />
          )}
        </Panel>
      </div>

      <section className="mt-6 overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
          <div>
            <h2 className="text-[15px] font-semibold">All holdings</h2>
            <p className="text-[13px] text-ink-3">
              {rows.length.toLocaleString('en-US')} of {book.rows.length.toLocaleString('en-US')} positions
            </p>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter holdings"
            placeholder="Filter by ticker or company"
            className="h-9 w-full rounded-full bg-paper px-4 text-[14px] shadow-[0_0_0_1px_var(--color-line)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)] sm:w-64"
          />
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                <th className="px-5 py-2.5 font-medium md:px-6">Company</th>
                <th className="hidden px-3 py-2.5 font-medium md:table-cell">Sector</th>
                <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Shares</th>
                <th className="px-3 py-2.5 text-right font-medium">Value</th>
                <th className="w-[28%] px-5 py-2.5 text-right font-medium md:px-6">Weight</th>
              </tr>
            </thead>
            <tbody>
              {!f &&
                Array.from({ length: 8 }, (_, i) => (
                  <tr key={i}>
                    <td colSpan={5} className="px-6 py-2">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))}
              {rows.slice(0, n).map((h) => (
                <tr key={h.key} className="border-b border-line last:border-0 hover:bg-ink/[0.025]">
                  <td className="px-5 py-2.5 md:px-6">
                    <div className="flex items-center gap-2">
                      <Ticker t={h.ticker} className="w-14 shrink-0" />
                      <span className="min-w-0 truncate text-ink-2">{h.issuer}</span>
                      {(h.put_call || (!h.issuer.includes('Class') && shareClass(h.title))) && <Badge className="shrink-0">{h.put_call || shareClass(h.title)}</Badge>}
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 text-ink-2 md:table-cell">{h.sector}</td>
                  <td className="num hidden px-3 py-2.5 text-right text-ink-2 sm:table-cell">{sharesFmt(h.shares)}</td>
                  <td className="num px-3 py-2.5 text-right font-medium">{money(h.value)}</td>
                  <td className="px-5 py-2.5 md:px-6">
                    <div className="flex items-center justify-end gap-3">
                      <div className="hidden h-1.5 w-24 rounded-full bg-ink/[0.05] sm:block">
                        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(2, (h.weight / (book.top1?.weight || 1)) * 100)}%` }} />
                      </div>
                      <span className="num w-14 text-right">{pct(h.weight)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > n && (
          <div className="flex items-center justify-between border-t border-line px-6 py-3 text-[13px] text-ink-3">
            <span>
              Showing {n} of {rows.length.toLocaleString('en-US')}
            </span>
            <button onClick={() => setN((x) => x + 50)} className="font-medium text-accent hover:text-accent-2">
              Show more
            </button>
          </div>
        )}
      </section>

      {f && (
        <p className="mt-6 text-[13px] leading-relaxed text-ink-3">
          Source: {f.name} Form 13F-HR for the period ending {dateLabel(f.report_date)}, filed {dateLabel(f.filing_date)}.{' '}
          <a href={f.sec_url} className="underline underline-offset-2 hover:text-ink">
            Original filing
          </a>{' '}
          ·{' '}
          <a href={secFilerUrl(f.cik)} className="underline underline-offset-2 hover:text-ink">
            All filings for CIK {f.cik.replace(/^0+/, '')}
          </a>
          . Values are as reported by the filer at quarter end. 13F omits short positions and most non-US holdings.
        </p>
      )}
    </div>
  )
}

function LockedChanges({ top }: { top: string[] }) {
  const fake = [0.9, -0.6, 0.45, -0.35, 0.3, -0.2]
  return (
    <div className="relative">
      <div className="pointer-events-none select-none space-y-2.5 blur-[3px]" aria-hidden="true">
        {fake.map((d, i) => (
          <div key={i} className="grid grid-cols-[4rem_1fr_1fr] items-center gap-2 text-[13px]">
            <span className="font-mono">{top[i] ?? 'XYZ'}</span>
            <div className="flex justify-end">{d < 0 && <div className="h-2.5 rounded-l-full bg-down/70" style={{ width: `${-d * 100}%` }} />}</div>
            <div className="flex border-l border-line-2">{d > 0 && <div className="h-2.5 rounded-r-full bg-up/70" style={{ width: `${d * 100}%` }} />}</div>
          </div>
        ))}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-card/70 text-center">
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Lock />
        </span>
        <p className="mt-3 text-[15px] font-semibold">See every buy and sell</p>
        <p className="mt-1 max-w-xs text-[13px] text-ink-2">New positions, exits and size changes against the prior quarter come with Copy.</p>
        <Button to="/pricing/" size="sm" className="mt-4">
          Get Copy
        </Button>
      </div>
    </div>
  )
}

// Used by the consensus page for a compact sector strip.
export { StackBar }
