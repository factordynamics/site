import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChangeBars } from '../components/charts'
import { Arrow, Badge, Button, Check, Lock, Monogram, NotCounted, Panel, Skeleton, Stat, Ticker } from '../components/ui'
import { needsVerify, ApiError, isFree, openPortal, useMemberState } from '../lib/account'
import { CsvButton } from '../components/CsvButton'
import { dateLabel, loadIndex, money, pct, quarterLabel, sharesFmt, shortName, useAsync, useTitle, withOption, unreliable, type Holding } from '../lib/data'
import { stockPath } from '../lib/stocks'
import { diff, heldReissue, holdingKey, loadHistory, type Quarter } from '../lib/history'
import { checkout, TRIAL_DAYS } from '../config'

export function History() {
  const { slug = '' } = useParams()
  const idx = useAsync(loadIndex, [])
  const m = idx.data?.managers.find((x) => x.slug === slug)
  const member = useMemberState()
  const active = Boolean(member?.active)
  const hist = useAsync(() => (active ? loadHistory(slug) : Promise.resolve(null)), [slug, active])
  const name = m?.manager ?? ''
  useTitle(name ? `${name} 13F history · Copybook` : undefined)
  const status = hist.error instanceof ApiError ? hist.error.status : 0

  return (
    <div className="container-x pt-10 md:pt-14">
      <nav className="text-[13px] text-ink-3" aria-label="Breadcrumb">
        <Link to="/investors/" className="hover:text-ink">
          Investors
        </Link>
        <span className="mx-2">/</span>
        <Link to={`/investors/${slug}/`} className="hover:text-ink">
          {name || '…'}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink-2">History</span>
      </nav>

      <header className="mt-6 flex flex-wrap items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          {name ? <Monogram name={name} size={64} /> : <Skeleton className="size-16 rounded-full" />}
          <div>
            <h1 className="text-[34px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-[44px]">{name || '\u00a0'}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[15px] text-ink-2">
              <span>13F history</span>
              <Badge tone="accent">Copy</Badge>
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button to={`/investors/${slug}/`} variant="outline" size="sm">
            Latest portfolio
          </Button>
          {active && (
            <>
              <CsvButton slug={slug} />
              <Link to="/methodology/#csv" className="self-center text-[13px] text-ink-3 underline-offset-2 hover:text-ink hover:underline">
                What’s in the CSV
              </Link>
            </>
          )}
        </div>
      </header>

      <div className="mt-8">
        {(member === undefined || (active && hist.loading)) && (
          <div className="space-y-6">
            <Skeleton className="h-[260px] w-full rounded-[var(--radius-card)]" />
            <Skeleton className="h-[420px] w-full rounded-[var(--radius-card)]" />
          </div>
        )}
        {member !== undefined && !active && <Paywall name={name} quarters={m?.history_quarters} kind={isFree(member) ? 'free' : member ? 'inactive' : 'guest'} />}
        {active && status === 402 && <Paywall name={name} quarters={m?.history_quarters} kind="inactive" />}
        {active && status === 401 && <Paywall name={name} quarters={m?.history_quarters} kind="guest" />}
        {active && hist.error && !status && <p className="text-[15px] text-ink-2">We couldn’t load this history. Refresh to try again.</p>}
        {active && hist.data && hist.data.quarters.length > 0 && <HistoryBody slug={slug} quarters={hist.data.quarters} />}
        {active && hist.data && hist.data.quarters.length === 0 && <p className="text-[15px] text-ink-2">No earlier 13F filings are on file for this investor yet.</p>}
      </div>
    </div>
  )
}

const qShort = (q: string) => {
  const m = /^(\d{4})Q(\d)$/.exec(q)
  return m ? `Q${m[2]} ’${m[1].slice(2)}` : q
}

function HistoryBody({ slug, quarters }: { slug: string; quarters: Quarter[] }) {
  const [sel, setSel] = useState(0)
  const [query, setQuery] = useState('')
  const [n, setN] = useState(25)
  const q = quarters[sel]
  const prev = quarters[sel + 1]
  const moves = useMemo(() => (prev ? diff(q, prev) : []), [q, prev])
  const count = (c: string) => moves.filter((x) => x.change === c).length
  const prevMap = useMemo(() => new Map((prev?.holdings ?? []).map((h) => [holdingKey(h), h])), [prev])
  const rows = useMemo(() => {
    const s = query.trim().toLowerCase()
    const all = [...q.holdings].sort((a, b) => b.value - a.value)
    return s ? all.filter((h) => `${h.ticker ?? ''} ${h.issuer} ${h.cusip}`.toLowerCase().includes(s)) : all
  }, [q, query])
  const oldestFirst = [...quarters].reverse()
  const maxV = Math.max(...quarters.map((x) => x.total_value), 1)
  const growth = prev?.total_value ? q.total_value / prev.total_value - 1 : null

  return (
    <div className="space-y-6">
      <Panel title="Reported portfolio by quarter" sub="Select a quarter to see its book and what changed">
        <div className="flex h-[200px] items-end gap-2 sm:gap-3" role="tablist" aria-label="Quarter">
          {oldestFirst.map((x) => {
            const i = quarters.indexOf(x)
            const on = i === sel
            return (
              <button
                key={x.quarter}
                role="tab"
                aria-selected={on}
                onClick={() => {
                  setSel(i)
                  setN(25)
                }}
                className="group flex h-full min-w-0 flex-1 flex-col justify-end text-center"
              >
                <span className={`num mb-1.5 block whitespace-nowrap text-[12.5px] ${on ? 'font-medium text-ink' : 'text-ink-3 max-sm:invisible'}`}>{money(x.total_value, 0)}</span>
                <span
                  className={`block w-full rounded-t-md transition-colors ${on ? 'bg-accent' : 'bg-[#c9d0ec] group-hover:bg-[#a9b5e6]'}`}
                  style={{ height: `${Math.max(4, (x.total_value / maxV) * 140)}px` }}
                />
                <span className={`mt-2 block text-[12px] leading-tight ${on ? 'font-medium text-ink' : 'text-ink-3'}`}>
                  <span className="sm:hidden">
                    {x.quarter.slice(4)}
                    <br />’{x.quarter.slice(2, 4)}
                  </span>
                  <span className="max-sm:hidden">{qShort(x.quarter)}</span>
                </span>
              </button>
            )
          })}
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-6 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:grid-cols-4 md:p-6">
        <Stat
          label={`Portfolio, ${quarterLabel(q.quarter)}`}
          value={money(q.total_value)}
          sub={growth === null ? `Filed ${dateLabel(q.filing_date)}` : `${growth >= 0 ? '+' : '−'}${pct(Math.abs(growth))} vs ${quarterLabel(prev!.quarter)}`}
        />
        <Stat label="Positions" value={(q.position_count ?? q.holdings.length).toLocaleString('en-US')} sub={`As of ${dateLabel(q.report_date)}`} />
        <Stat label="New positions" value={prev ? count('new') : '—'} sub={prev ? `${count('added')} added to` : 'First filing on file'} />
        <Stat label="Exited" value={prev ? (q.partial ? '—' : count('exited')) : '—'} sub={prev ? `${count('trimmed')} trimmed` : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Panel
          title="Biggest buys and sells"
          sub={prev ? `${quarterLabel(prev.quarter)} to ${quarterLabel(q.quarter)}: shares bought or sold, at quarter-end value` : 'This is the earliest filing on file'}
        >
          {moves.length ? (
            <ChangeBars items={moves.slice(0, 12).map((x) => ({ key: x.key, label: withOption(x.h.ticker || shortName(x.h.issuer), x.h.put_call), tag: x.change, delta: x.delta }))} />
          ) : (
            <p className="text-[14px] text-ink-2">{prev ? `No shares bought or sold since ${quarterLabel(prev.quarter)}.` : 'Pick a later quarter to compare.'}</p>
          )}
          {prev && <NotCounted n={q.holdings.filter((h) => !h.put_call && unreliable(h)).length} />}
        </Panel>
        <Panel title="Opened and closed" sub={prev ? `New and exited positions in ${quarterLabel(q.quarter)}` : undefined}>
          <MoveList title="New" tone="up" items={moves.filter((x) => x.change === 'new')} />
          {!q.partial && <MoveList title="Exited" tone="down" items={moves.filter((x) => x.change === 'exited')} />}
        </Panel>
      </div>

      <PositionMatrix quarters={quarters} sel={sel} />

      <section className="overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
          <div>
            <h2 className="text-[15px] font-semibold">Holdings, {quarterLabel(q.quarter)}</h2>
            <p className="text-[13px] text-ink-3">
              {q.partial ? `Top ${q.holdings.length.toLocaleString('en-US')} positions shown · ` : ''}
              Filed {dateLabel(q.filing_date)}
              {q.sec_url && (
                <>
                  {' · '}
                  <a href={q.sec_url} className="underline underline-offset-2 hover:text-ink">
                    Original filing
                  </a>
                </>
              )}
            </p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter holdings"
              placeholder="Filter by ticker or company"
              className="h-9 min-w-0 flex-1 rounded-full bg-paper px-4 text-[14px] shadow-[0_0_0_1px_var(--color-line)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)] sm:w-60"
            />
            <CsvButton slug={slug} label="CSV" variant="outline" className="shrink-0" />
          </div>
        </header>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`Holdings, ${quarterLabel(q.quarter)}`}>
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                <th className="px-5 py-2.5 font-medium md:px-6">Company</th>
                <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Shares</th>
                <th className="px-3 py-2.5 text-right font-medium">Change</th>
                <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Value</th>
                <th className="px-5 py-2.5 text-right font-medium md:px-6">Weight</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, n).map((h) => {
                const p = prevMap.get(holdingKey(h))
                const ds = p ? h.shares - p.shares : 0
                return (
                  <tr key={`${holdingKey(h)}|${h.cusip}`} className="border-b border-line last:border-0 hover:bg-ink/[0.025]">
                    <td className="px-5 py-2.5 md:px-6">
                      <div className="flex min-w-0 items-center gap-2">
                        <Ticker t={h.ticker} className="w-14 shrink-0" />
                        <span className="min-w-0 truncate text-ink-2" title={h.filed}>
                          {h.issuer}
                        </span>
                        {h.put_call && <Badge className="shrink-0">{h.put_call}</Badge>}
                      </div>
                    </td>
                    <td className="num hidden px-3 py-2.5 text-right text-ink-2 sm:table-cell">{sharesFmt(h.shares)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {!prev ? (
                        <span className="text-ink-3">—</span>
                      ) : !p ? (
                        <Badge tone="up">New</Badge>
                      ) : ds === 0 ? (
                        <span className="whitespace-nowrap text-[13px] text-ink-3">No change</span>
                      ) : (
                        <span className={`num text-[13px] font-medium ${ds > 0 ? 'text-up' : 'text-down'}`}>
                          {ds > 0 ? '+' : '−'}
                          {pct(Math.abs(ds) / (p.shares || 1), 0)}
                        </span>
                      )}
                    </td>
                    <td className="num hidden px-3 py-2.5 text-right font-medium sm:table-cell">{money(h.value)}</td>
                    <td className="num px-5 py-2.5 text-right md:px-6">{pct(h.weight)}</td>
                  </tr>
                )
              })}
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
      <p className="text-[13px] leading-relaxed text-ink-3">
        Every quarter is the Form 13F-HR as filed with the SEC. Changes compare share counts between consecutive filings and are valued at the newer filing’s quarter-end value.
      </p>
    </div>
  )
}

function MoveList({ title, tone, items }: { title: string; tone: 'up' | 'down'; items: ReturnType<typeof diff> }) {
  return (
    <div className="mb-5 last:mb-0">
      <p className="mb-2 flex items-center gap-2 text-[13px] font-medium text-ink-2">
        {title} <Badge tone={tone}>{items.length}</Badge>
      </p>
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-3">None this quarter.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.slice(0, 6).map((x) => (
            <li key={x.key} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
              <span className="flex min-w-0 items-baseline gap-2">
                {x.h.ticker && <span className="font-mono text-[12.5px] font-medium">{x.h.ticker}</span>}
                <span className="truncate text-ink-2">{withOption(x.h.issuer, x.h.put_call)}</span>
              </span>
              <span className="num shrink-0 font-medium">{money(Math.abs(x.delta))}</span>
            </li>
          ))}
          {items.length > 6 && <li className="py-2 text-[12.5px] text-ink-3">and {items.length - 6} more in the table below</li>}
        </ul>
      )}
    </div>
  )
}

type GridSort = 'now' | 'first' | 'held' | 'name'

/** Every position held in any quarter on file: shares or weight per quarter, when it was first held and for how long. */
function PositionMatrix({ quarters, sel }: { quarters: Quarter[]; sel: number }) {
  const [mode, setMode] = useState<'weight' | 'shares'>('weight')
  const [sort, setSort] = useState<GridSort>('now')
  const [filter, setFilter] = useState('')
  const [n, setN] = useState(25)
  const cols = useMemo(() => [...quarters].reverse(), [quarters])
  const partial = cols.some((c) => c.partial)
  const rows = useMemo(() => {
    const maps = cols.map((c) => new Map(c.holdings.map((h) => [holdingKey(h), h])))
    const keys = new Map<string, Holding>()
    for (const c of [...cols].reverse()) for (const h of c.holdings) if (!keys.has(holdingKey(h))) keys.set(holdingKey(h), h)
    const selCol = cols.indexOf(quarters[sel])
    return [...keys].map(([k, h]) => {
      const cells = maps.map((mp) => mp.get(k) ?? null)
      const first = cells.findIndex(Boolean)
      const held = cells.filter(Boolean).length
      const now = cells[selCol]
      // Held through the end of the window and not in the selected quarter: exited by then.
      const lastHeld = cells.map(Boolean).lastIndexOf(true)
      return { k, h, cells, first, held, now, exited: !now && lastHeld < selCol && lastHeld >= 0 && !heldReissue(h.cusip), max: Math.max(...cells.map((c) => (mode === 'weight' ? c?.weight : c?.shares) ?? 0), 0) }
    })
  }, [cols, quarters, sel, mode])
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q ? rows.filter((r) => `${r.h.ticker ?? ''} ${r.h.issuer} ${r.h.cusip}`.toLowerCase().includes(q)) : rows
    const by: Record<GridSort, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
      now: (a, b) => (b.now?.value ?? 0) - (a.now?.value ?? 0) || Number(b.exited) - Number(a.exited) || b.held - a.held,
      first: (a, b) => a.first - b.first || (b.now?.value ?? 0) - (a.now?.value ?? 0),
      held: (a, b) => b.held - a.held || (b.now?.value ?? 0) - (a.now?.value ?? 0),
      name: (a, b) => (a.h.ticker || a.h.issuer).localeCompare(b.h.ticker || b.h.issuer),
    }
    return [...list].sort(by[sort])
  }, [rows, filter, sort])
  const firstLabel = (i: number) => (i === 0 && !partial ? `${qShort(cols[0].quarter)} or earlier` : qShort(cols[i].quarter))
  return (
    <Panel
      title="Position history"
      sub={`All ${rows.length.toLocaleString('en-US')} positions held in any of the last ${cols.length} quarters, by CUSIP and share class`}
      right={
        <div className="seg rounded-full bg-ink/[0.05] p-0.5 text-[12.5px]" role="tablist" aria-label="Show">
          {(['weight', 'shares'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`rounded-full px-2.5 py-1 ${mode === m ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
              {m === 'weight' ? 'Weight' : 'Shares'}
            </button>
          ))}
        </div>
      }
    >
      <div className="-mt-1 mb-3 flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setN(25)
          }}
          aria-label="Filter positions"
          placeholder="Filter by ticker or company"
          className="h-8 min-w-0 flex-1 rounded-full bg-paper px-3.5 text-[13px] shadow-[0_0_0_1px_var(--color-line)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)] sm:max-w-64"
        />
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as GridSort)} className="h-8 rounded-full bg-paper px-3 text-[12.5px] shadow-[0_0_0_1px_var(--color-line)] outline-none focus:shadow-[0_0_0_2px_var(--color-accent)]">
            <option value="now">Size in {qShort(quarters[sel].quarter)}</option>
            <option value="first">First held</option>
            <option value="held">Quarters held</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
      <div className="-mx-1 overflow-x-auto px-1" tabIndex={0} role="region" aria-label={`Position ${mode} by quarter`}>
        <table className="w-full min-w-[760px] border-separate border-spacing-[3px] text-[12.5px]">
          <thead>
            <tr>
              <th className="w-[10rem] pb-1 text-left font-medium text-ink-3">Position</th>
              <th className="w-[6.5rem] pb-1 text-left font-medium text-ink-3">First held</th>
              <th className="w-[3.5rem] pb-1 text-center font-medium text-ink-3">Held</th>
              {cols.map((c) => (
                <th key={c.quarter} className={`pb-1 text-center font-medium ${c === quarters[sel] ? 'text-ink' : 'text-ink-3'}`}>
                  {qShort(c.quarter)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, n).map((r) => (
              <tr key={r.k}>
                <td className="max-w-[10rem] truncate pr-2">
                  {r.h.ticker ? (
                    <Link to={stockPath(r.h.ticker)} className="font-mono font-medium hover:text-accent">
                      {r.h.ticker}
                    </Link>
                  ) : (
                    <span className="font-medium">{shortName(r.h.issuer)}</span>
                  )}
                  {r.h.put_call && <span className="ml-1 text-ink-3">{r.h.put_call.toLowerCase() === 'put' ? 'puts' : 'calls'}</span>}
                  {r.exited && <Badge tone="down" className="ml-1.5">Exited</Badge>}
                </td>
                <td className="whitespace-nowrap text-ink-2">{firstLabel(r.first)}</td>
                <td className="num text-center text-ink-2">
                  {r.held}/{cols.length}
                </td>
                {r.cells.map((c, i) => {
                  const v = (mode === 'weight' ? c?.weight : c?.shares) ?? 0
                  // Dark text up to 0.74 alpha, white from 0.8; nothing in between passes 4.5:1 with either.
                  let a = v ? 0.1 + 0.85 * (v / (r.max || 1)) : 0
                  if (a > 0.74 && a < 0.8) a = 0.8
                  return (
                    <td
                      key={cols[i].quarter}
                      className={`num h-8 rounded-md px-1 text-center ${a >= 0.8 ? 'text-white' : v ? 'text-ink' : 'text-ink-3'}`}
                      style={{ background: v ? `rgb(43 68 214 / ${a})` : 'rgb(12 14 19 / 0.03)' }}
                      title={c ? `${quarterLabel(cols[i].quarter)}: ${sharesFmt(c.shares)} shares, ${money(c.value)}, ${pct(c.weight)} of the book` : `Not held in ${quarterLabel(cols[i].quarter)}`}
                    >
                      {c ? (mode === 'weight' ? pct(c.weight, 1) : sharesFmt(c.shares)) : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-3">
        <span>
          Showing {Math.min(n, shown.length).toLocaleString('en-US')} of {shown.length.toLocaleString('en-US')}. Shading is relative to each position’s own largest quarter.
        </span>
        {shown.length > n && (
          <button onClick={() => setN((x) => x + 50)} className="font-medium text-accent hover:text-accent-2">
            Show more
          </button>
        )}
      </div>
    </Panel>
  )
}

function Paywall({ name, quarters, kind }: { name: string; quarters?: string[]; kind: 'guest' | 'inactive' | 'free' }) {
  const qs = [...(quarters ?? [])].sort()
  const span = qs.length > 1 ? `${quarterLabel(qs[0])} to ${quarterLabel(qs[qs.length - 1])}` : ''
  const fake = [52, 61, 58, 70, 66, 78, 84, 92]
  return (
    <div className="relative overflow-hidden rounded-[18px] bg-card shadow-[var(--shadow-card)]">
      <div className="pointer-events-none select-none p-6 blur-[4px] md:p-8" aria-hidden="true">
        <div className="flex h-[180px] items-end gap-3">
          {fake.map((v, i) => (
            <div key={i} className="flex-1 rounded-t-md bg-[#c9d0ec]" style={{ height: `${v}%`, background: i === 7 ? '#2b44d6' : undefined }} />
          ))}
        </div>
        <div className="mt-8 grid grid-cols-8 gap-1">
          {Array.from({ length: 48 }, (_, i) => (
            <div key={i} className="h-7 rounded-md" style={{ background: `rgb(43 68 214 / ${0.1 + ((i * 37) % 70) / 100})` }} />
          ))}
        </div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-card/70 p-6">
        <div className="max-w-md text-center">
          <span className="inline-flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Lock />
          </span>
          <h2 className="mt-4 text-[24px] font-semibold tracking-[-0.03em]">
            {kind === 'inactive' ? 'Your Copy plan isn’t active.' : kind === 'free' ? 'This is a Copy feature.' : `Every quarter of ${name || 'this'}’s book.`}
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
            {kind === 'inactive'
              ? 'Renew Copy to see quarter-by-quarter history, every buy and sell, and CSV export.'
              : kind === 'free'
                ? `You’re on the free Friday email. Start a ${TRIAL_DAYS}-day Copy trial to see ${name ? `${name}’s` : 'the'} book quarter by quarter, every buy and sell, and download it as CSV.`
              : `${qs.length > 1 ? `${qs.length} quarters on file, ${span}. ` : ''}See how the portfolio changed quarter by quarter, every buy and sell, and download it as CSV.`}
          </p>
          <ul className="mx-auto mt-4 inline-grid gap-1.5 text-left text-[14px] text-ink-2">
            {['Portfolio value and positions by quarter', 'New, added, trimmed and exited positions', 'CSV export of every quarter'].map((t) => (
              <li key={t} className="flex gap-2">
                <Check className="mt-0.5 shrink-0 text-accent" /> {t}
              </li>
            ))}
          </ul>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {kind === 'inactive' ? (
              <Button
                onClick={() =>
                  openPortal().catch((e) => {
                    if (checkout.portal && !needsVerify(e)) window.location.href = checkout.portal
                  })
                }
              >
                Manage billing <Arrow />
              </Button>
            ) : (
              <Button to="/pricing/">
                {kind === 'free' ? `Start ${TRIAL_DAYS}-day free trial` : 'Start 14-day free trial'} <Arrow />
              </Button>
            )}
            {kind !== 'free' && (
              <Button to="/account/" variant="outline">
                {kind === 'inactive' ? 'Account' : 'Sign in'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
