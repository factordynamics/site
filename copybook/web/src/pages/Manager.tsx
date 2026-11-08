import { useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { ChangeBars, Donut, foldSlices, Legend, StackBar, Treemap, WeightBars } from '../components/charts'
import { mapPlan, treemapItems, useBook } from '../components/Portfolio'
import { Arrow, Badge, Button, Lock, Monogram, Panel, Skeleton, Stat, Ticker } from '../components/ui'
import { useMember } from '../lib/account'
import { CsvButton } from '../components/CsvButton'
import { FollowButton } from '../components/FollowButton'
import { FundNotice, SinceLast13F, fundStatus } from '../components/FundNotes'
import { stockPath } from '../lib/stocks'
import { CuratedRedirect, useTitle, shortName, dateLabel, loadManager, money, pct, quarterLabel, secFilerUrl, shareClass, sharesFmt, useAsync, type ManagerFile } from '../lib/data'

export function ManagerPage() {
  const { slug = '' } = useParams()
  const m = useAsync(() => loadManager(slug), [slug])
  const book = useBook(m.data?.holdings)
  const [q, setQ] = useState('')
  const [n, setN] = useState(25)
  const [color, setColor] = useState<'rank' | 'sector'>('rank')
  const [view, setView] = useState<'shares' | 'options'>('shares')
  const f = m.data
  const member = useMember()
  useTitle(f ? `${f.manager} portfolio · Copybook` : undefined)
  const plan = mapPlan(book.rows, 20)
  const slices = foldSlices(book.sectors, 10)

  // Trades, not price moves: the change in shares, valued at the filing's own per-share value.
  const changes = useMemo(() => {
    return (f?.holdings || [])
      .filter((h) => !h.put_call && h.change && h.change !== 'unchanged')
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
    const all = view === 'options' ? book.options : book.rows
    return s ? all.filter((h) => `${h.ticker ?? ''} ${h.issuer} ${h.cusip}`.toLowerCase().includes(s)) : all
  }, [book.rows, book.options, view, q])

  if (m.error instanceof CuratedRedirect) return <Navigate to={`/investors/${m.error.slug}/`} replace />
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

  const status = f ? fundStatus(f).status : 'current'
  const stale = !['current', 'reported_by_other', 'notice_pending'].includes(status)
  // An empty or unreadable newest filing still counts as filed: the page shows the last readable quarter.
  const shownLabel = f ? (status === 'empty_latest' || status === 'unreadable_latest' ? `Showing ${quarterLabel(f.quarter)}` : `Last filed ${quarterLabel(f.quarter)}`) : ''
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
              {f && <Badge tone={stale ? 'warn' : 'neutral'}>{stale ? shownLabel : `${quarterLabel(f.quarter)} 13F`}</Badge>}
            </p>
          </div>
        </div>
        {f && (
          <div className="flex flex-wrap gap-2">
            {!f.filer && <FollowButton kind="investor" id={f.slug} name={f.manager} />}
            <Button href={f.sec_url} variant="outline" size="sm">
              View filing on SEC
            </Button>
            {Boolean(f.history_quarters?.length) && (
              <Button to={`/investors/${f.slug}/history/`} variant="outline" size="sm">
                13F history
              </Button>
            )}
            {member?.active && !f.filer && <CsvButton slug={f.slug} variant="outline" />}
          </div>
        )}
      </header>

      {f && <FundNotice f={f} />}

      <div className="mt-8 grid grid-cols-2 gap-6 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:grid-cols-4 md:p-6">
        <Stat
          label={book.options.length ? 'Value in shares' : 'Reported portfolio'}
          value={f ? money(book.options.length ? book.total : f.total_value) : '—'}
          sub={f ? (book.options.length ? `Plus ${money(book.optionsValue)} options notional` : `As of ${dateLabel(f.report_date)}`) : undefined}
        />
        <Stat label="Positions" value={f ? book.rows.length.toLocaleString('en-US') : '—'} sub={f ? (book.options.length ? `${book.options.length.toLocaleString('en-US')} option lines apart` : `Filed ${dateLabel(f.filing_date)}`) : undefined} />
        <Stat label="Top 10 weight" value={f ? pct(book.top10, 0) : '—'} sub="Share of portfolio" />
        <Stat label="Largest position" value={book.top1 ? book.top1.ticker || shortName(book.top1.issuer) : '—'} sub={book.top1 ? `${pct(book.top1.weight)} of portfolio` : undefined} />
      </div>

      {f && !f.filer && <SinceLast13F slug={f.slug} quarter={f.quarter} />}

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
        {f?.filer ? (
          <FilerPanel f={f} />
        ) : (
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
              {paid && f && (
                <Link to={`/investors/${f.slug}/history/`} className="mt-5 inline-flex items-center gap-1.5 text-[13.5px] font-medium text-accent hover:text-accent-2">
                  Every quarter on file <Arrow />
                </Link>
              )}
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
        )}
      </div>


      <section className="mt-6 overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
          <div>
            <h2 className="text-[15px] font-semibold">All holdings</h2>
            <p className="text-[13px] text-ink-3">
              {view === 'options'
                ? `${rows.length.toLocaleString('en-US')} option lines · value is the notional of the underlying shares, as filed`
                : `${rows.length.toLocaleString('en-US')} of ${book.rows.length.toLocaleString('en-US')} share positions${f?.truncated ? ` · the largest of ${f.position_count?.toLocaleString('en-US')} lines in the filing` : ''}`}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {book.options.length > 0 && (
            <div className="inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[12.5px]" role="tablist" aria-label="Holding type">
              {(['shares', 'options'] as const).map((v) => (
                <button key={v} role="tab" aria-selected={view === v} onClick={() => { setView(v); setN(25) }} className={`rounded-full px-2.5 py-1 ${view === v ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                  {v === 'shares' ? 'Shares' : `Options (${book.options.length.toLocaleString('en-US')})`}
                </button>
              ))}
            </div>
          )}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter holdings"
            placeholder="Filter by ticker or company"
            className="h-9 w-full rounded-full bg-paper px-4 text-[14px] shadow-[0_0_0_1px_var(--color-line)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)] sm:w-64"
          />
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                <th className="px-5 py-2.5 font-medium md:px-6">Company</th>
                <th className="hidden px-3 py-2.5 font-medium md:table-cell">Sector</th>
                <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Shares</th>
                <th className="px-3 py-2.5 text-right font-medium">Value</th>
                <th className="w-[28%] px-5 py-2.5 text-right font-medium md:px-6">{view === 'options' ? 'Share of filing' : 'Weight'}</th>
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
                      {h.ticker ? (
                        <Link to={stockPath(h.ticker)} className="w-14 shrink-0 hover:text-accent">
                          <Ticker t={h.ticker} />
                        </Link>
                      ) : (
                        <Ticker t={h.ticker} className="w-14 shrink-0" />
                      )}
                      <span className="min-w-0 truncate text-ink-2">{h.issuer}</span>
                      {h.put_call ? (
                        <Badge tone={h.put_call.toLowerCase() === 'put' ? 'down' : 'up'} className="shrink-0">
                          {h.put_call.toLowerCase() === 'put' ? 'Puts' : 'Calls'}
                        </Badge>
                      ) : (
                        !h.issuer.includes('Class') && shareClass(h.title) && <Badge className="shrink-0">{shareClass(h.title)}</Badge>
                      )}
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 text-ink-2 md:table-cell">{h.sector}</td>
                  <td className="num hidden px-3 py-2.5 text-right text-ink-2 sm:table-cell">{sharesFmt(h.shares)}</td>
                  <td className="num px-3 py-2.5 text-right font-medium">{money(h.value)}</td>
                  <td className="px-5 py-2.5 md:px-6">
                    <div className="flex items-center justify-end gap-3">
                      <div className="hidden h-1.5 w-24 rounded-full bg-ink/[0.05] sm:block">
                        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(2, (h.weight / ((view === 'options' ? book.options[0]?.weight : book.top1?.weight) || 1)) * 100)}%` }} />
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

function FilerPanel({ f }: { f: ManagerFile }) {
  const rows: [string, string][] = [
    ['Period', `Quarter ending ${dateLabel(f.report_date)}`],
    ['Filed with the SEC', dateLabel(f.filing_date)],
    ['Lines in the filing', (f.position_count ?? f.holdings.length).toLocaleString('en-US')],
    ['Reported value', money(f.total_value)],
    ['SEC CIK', f.cik.replace(/^0+/, '')],
  ]
  return (
    <Panel title="About this filing" sub={`${quarterLabel(f.quarter)} Form 13F-HR, as filed`}>
      <dl className="divide-y divide-line text-[14px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-ink-3">{k}</dt>
            <dd className="num text-right font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 rounded-xl bg-accent-soft px-4 py-3.5 text-[13.5px] leading-relaxed text-accent-2">
        <p className="font-medium">Tracking a fund over time?</p>
        <p className="mt-0.5 opacity-90">
          Quarter-over-quarter buys and sells, 8 quarters of history and filing alerts cover the investors we follow closely.{' '}
          <Link to="/investors/" className="font-medium underline underline-offset-2">
            See them
          </Link>
        </p>
      </div>
    </Panel>
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
