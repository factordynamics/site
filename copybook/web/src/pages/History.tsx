import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChangeBars } from '../components/charts'
import { Arrow, Badge, Button, Check, Lock, Monogram, Panel, Skeleton, Stat, Ticker } from '../components/ui'
import { ApiError, csvUrl, openPortal, useMemberState } from '../lib/account'
import { dateLabel, loadIndex, money, pct, quarterLabel, sharesFmt, shortName, useAsync, useTitle } from '../lib/data'
import { diff, holdingKey, loadHistory, type Quarter } from '../lib/history'
import { checkout } from '../config'

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
            <Button href={csvUrl(slug)} variant="dark" size="sm">
              Download CSV
            </Button>
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
        {member !== undefined && !active && <Paywall name={name} quarters={m?.history_quarters} kind={member ? 'inactive' : 'guest'} />}
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
            <ChangeBars items={moves.slice(0, 12).map((x) => ({ key: x.key, label: x.h.ticker || shortName(x.h.issuer), tag: x.change, delta: x.delta }))} />
          ) : (
            <p className="text-[14px] text-ink-2">{prev ? `No shares bought or sold since ${quarterLabel(prev.quarter)}.` : 'Pick a later quarter to compare.'}</p>
          )}
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
            <Button href={csvUrl(slug)} variant="outline" size="sm" className="shrink-0">
              CSV
            </Button>
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
                  <tr key={holdingKey(h)} className="border-b border-line last:border-0 hover:bg-ink/[0.025]">
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
                <span className="truncate text-ink-2">{x.h.issuer}</span>
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

/** Weight of the selected quarter's largest positions in every quarter on file. */
function PositionMatrix({ quarters, sel }: { quarters: Quarter[]; sel: number }) {
  const cols = [...quarters].reverse()
  const maps = cols.map((c) => new Map(c.holdings.map((h) => [holdingKey(h), h])))
  const top = [...quarters[sel].holdings].sort((a, b) => b.value - a.value).slice(0, 12)
  const max = Math.max(...top.flatMap((h) => maps.map((mp) => mp.get(holdingKey(h))?.weight ?? 0)), 0.0001)
  return (
    <Panel title="Position history" sub={`Weight of the ${quarterLabel(quarters[sel].quarter)} top positions in each quarter`}>
      <div className="-mx-1 overflow-x-auto px-1" tabIndex={0} role="region" aria-label="Position weights by quarter">
        <table className="w-full min-w-[560px] border-separate border-spacing-[3px] text-[12.5px]">
          <thead>
            <tr>
              <th className="w-[9rem] pb-1 text-left font-medium text-ink-3">Position</th>
              {cols.map((c) => (
                <th key={c.quarter} className={`pb-1 text-center font-medium ${c === quarters[sel] ? 'text-ink' : 'text-ink-3'}`}>
                  {qShort(c.quarter)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {top.map((h) => (
              <tr key={holdingKey(h)}>
                <td className="truncate pr-2">
                  {h.ticker ? <span className="font-mono font-medium">{h.ticker}</span> : <span className="font-medium">{shortName(h.issuer)}</span>}
                </td>
                {maps.map((mp, i) => {
                  const w = mp.get(holdingKey(h))?.weight ?? 0
                  // Dark text up to 0.74 alpha, white from 0.8; nothing in between passes 4.5:1 with either.
                  let a = w ? 0.1 + 0.85 * (w / max) : 0
                  if (a > 0.74 && a < 0.8) a = 0.8
                  return (
                    <td
                      key={cols[i].quarter}
                      className={`num h-8 rounded-md text-center ${a >= 0.8 ? 'text-white' : w ? 'text-ink' : 'text-ink-3'}`}
                      style={{ background: w ? `rgb(43 68 214 / ${a})` : 'rgb(12 14 19 / 0.03)' }}
                      title={w ? `${pct(w)} in ${quarterLabel(cols[i].quarter)}` : `Not held in ${quarterLabel(cols[i].quarter)}`}
                    >
                      {w ? pct(w, 1) : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function Paywall({ name, quarters, kind }: { name: string; quarters?: string[]; kind: 'guest' | 'inactive' }) {
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
            {kind === 'inactive' ? 'Your Copy plan isn’t active.' : `Every quarter of ${name || 'this'}’s book.`}
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
            {kind === 'inactive'
              ? 'Renew Copy to see quarter-by-quarter history, every buy and sell, and CSV export.'
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
                  openPortal().catch(() => {
                    if (checkout.portal) window.location.href = checkout.portal
                  })
                }
              >
                Manage billing <Arrow />
              </Button>
            ) : (
              <Button to="/pricing/">
                Get Copy <Arrow />
              </Button>
            )}
            <Button to="/account/" variant="outline">
              {kind === 'inactive' ? 'Account' : 'Sign in'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
