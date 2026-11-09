import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Signup } from '../components/Signup'
import { Arrow, AvatarStack, Badge, Lock, Monogram, Panel, Skeleton } from '../components/ui'
import { useMember } from '../lib/account'
import { dateLabel, money, quarterLabel, useAsync, useTick, useTitle } from '../lib/data'
import { isEdgarDay } from '../lib/calendar.mjs'
import { loadCardSet, loadSeason, recapPath, seasonNow, stockPath, type Expected, type Season as SeasonData, type SeasonRow } from '../lib/stocks'

// /season/: the 13F filing season as it happens. Built from d/season.json, which every Pages build
// writes (every 20 minutes during the filing wave).
const FREE = 5
type Tab = 'bought' | 'sold' | 'most_buyers'
const TABS: [Tab, string][] = [
  ['bought', 'Most bought'],
  ['sold', 'Most sold'],
  ['most_buyers', 'Most buyers'],
]

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

const dueLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })

function left(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d ? `${d}d ${h}h` : `${h}h ${m % 60}m`
}

export function Season() {
  // Re-read every two minutes while the season is live, so an open tab follows each build.
  const tick = useTick(120_000, seasonNow().live)
  const s = useAsync(() => loadSeason(tick ? Date.now() : undefined), [tick])
  const cards = useAsync(loadCardSet, [])
  const member = useMember()
  const paid = Boolean(member?.active)
  const now = useNow()
  const [params, setParams] = useSearchParams()
  const d = s.data
  const Q = d ? quarterLabel(d.quarter) : ''
  useTitle(d ? `${Q} 13F season tracker · Copybook` : '13F season tracker · Copybook')

  // Open on the superinvestors. Until about 10 have filed, dollar rankings are led by a few banks'
  // and index managers' flows, so the default is the names the most of them bought.
  const auto: 'featured' | 'all' = d && d.featured.filed > 0 ? 'featured' : 'all'
  const autoTab: Tab = d && d.featured.filed < 10 ? 'most_buyers' : 'bought'
  const scope = (params.get('funds') as 'featured' | 'all' | null) ?? auto
  const tab: Tab = (TABS.find(([k]) => k === params.get('tab'))?.[0] as Tab) ?? autoTab
  // ETFs and index funds are left out unless asked for: they're allocation, not stock picks.
  const etfs = params.get('etfs') === '1'
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(params)
    if (v == null) n.delete(k)
    else n.set(k, v)
    setParams(n, { replace: true })
  }
  const flow = d ? (scope === 'featured' ? d.featured_flow : d.all_flow) : undefined
  const all = flow?.[tab] ?? []
  const rows = etfs ? all : all.filter((r) => !r.etf)
  const hiddenEtfs = all.length - rows.length
  const shown = paid ? rows : rows.slice(0, FREE)
  const due = d ? new Date(d.deadline).getTime() : 0
  const passed = d && now > due

  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="max-w-2xl">
          <p className="flex items-center gap-2 text-[13px] font-medium text-accent">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-50" />
              <span className="relative inline-flex size-2 rounded-full bg-accent" />
            </span>
            {Q || 'The'} 13F filing season · live
          </p>
          <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Who has filed, and what they bought.</h1>
          <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
            Every manager with $100M or more in 13F securities, mostly US-listed stocks, must file its {Q || 'quarter-end'} holdings with the SEC within 45 days. The funds we track closely are read minutes after EDGAR accepts them; this page refreshes about every 20 minutes.
          </p>
        </div>
        <div className="rounded-[var(--radius-card)] bg-night p-6 text-white shadow-[var(--shadow-card)]">
          <p className="text-[13px] text-white/60">{passed ? 'Deadline passed' : 'Filing deadline'}</p>
          <p className="mt-1 text-[15px] font-medium">{d ? dueLabel(d.deadline) : '\u00a0'}</p>
          <p className="num mt-4 text-[40px] font-semibold leading-none tracking-[-0.03em]">{d ? (passed ? 'Closed' : left(due - now)) : '—'}</p>
          <p className="mt-2 text-[13px] text-white/60">{passed ? 'Late filers and amendments still arrive; they appear here as they do.' : 'left to file'}</p>
          {d && (
            <Link to={recapPath(d.quarter)} className={`mt-4 inline-flex items-center gap-1 text-[13.5px] font-medium ${passed ? 'rounded-full bg-white px-3.5 py-1.5 text-ink hover:bg-white/90' : 'text-white/85 hover:text-white'}`}>
              {passed ? `Read the ${Q} recap` : `${Q} recap so far`} <Arrow className="size-3" />
            </Link>
          )}
        </div>
      </header>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <Progress label="Superinvestors" sub={d ? `updated ${ago(now - Date.parse(d.generated_at))}` : 'legendary investors we feature'} v={d?.featured} />
        <Progress label="Funds we track closely" sub="with alerts, moves and history" v={d?.curated} />
        <Progress label="All 13F filers" sub="of the filers active last quarter" v={d?.filers} />
      </div>

      <Panel className="mt-5" title="13Fs accepted per business day" sub={d ? `All filers, ${Q}. Each bar is one EDGAR business day (weekends and federal holidays left out); dashed slots are the days left before the deadline.` : undefined}>
        {d ? <DayBars d={d} now={now} /> : <Skeleton className="h-44 w-full" />}
      </Panel>

      <div className="mt-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
            <div className="inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Ranking">
              {TABS.map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => set('tab', k === autoTab ? null : k)} className={`rounded-full px-3 py-1.5 ${tab === k ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                  {l}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Funds">
              {(['featured', 'all'] as const).map((k) => (
                <button key={k} role="tab" aria-selected={scope === k} onClick={() => set('funds', k === auto ? null : k)} className={`rounded-full px-3 py-1.5 ${scope === k ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                  {k === 'featured' ? `Superinvestors${d ? ` (${d.featured.filed})` : ''}` : `All tracked${d ? ` (${d.curated.filed})` : ''}`}
                </button>
              ))}
            </div>
          </header>
          {!d ? (
            <Skeleton className="m-6 h-72" />
          ) : rows.length === 0 ? (
            <p className="px-6 py-8 text-[14px] text-ink-2">No moves yet from the funds that have filed. Check back as filings arrive.</p>
          ) : (
            <ol>
              {shown.map((r, i) => (
                <Row key={r.ticker} r={r} i={i} tab={tab} />
              ))}
            </ol>
          )}
          {d && tab !== 'sold' && <SplitNote splits={d.splits} />}
          {d && (hiddenEtfs > 0 || etfs) && (
            <p className="border-t border-line px-5 py-3 text-[13px] text-ink-3 md:px-6">
              {etfs ? 'ETFs and index funds included.' : `${hiddenEtfs} ${hiddenEtfs === 1 ? 'ETF or index fund' : 'ETFs and index funds'} left out: allocation, not stock picks.`}{' '}
              <button type="button" onClick={() => set('etfs', etfs ? null : '1')} className="font-medium text-accent hover:text-accent-2">
                {etfs ? 'Leave them out' : 'Show them'}
              </button>
            </p>
          )}
          {d && !paid && rows.length > FREE && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-accent-soft px-5 py-4 md:px-6">
              <p className="flex items-center gap-2 text-[13.5px] text-accent-2">
                <Lock /> {rows.length - FREE} more names, and an email minutes after each fund you follow files, with Copy
              </p>
              <Link to="/pricing/" className="inline-flex h-8 items-center rounded-full bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent-2">
                Start 14-day free trial
              </Link>
            </div>
          )}
          {d && paid && (
            <div className="border-t border-line px-5 py-3 md:px-6">
              <Link to={`/flow/?q=${d.quarter}${scope === 'all' ? '&funds=all' : ''}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:text-accent-2">
                Every move in Flow <Arrow className="size-3" />
              </Link>
            </div>
          )}
        </section>

        <Panel title="Just filed" sub={d ? `${d.latest.length} of the funds we track have filed ${Q}, newest first` : undefined}>
          {!d ? (
            <Skeleton className="h-[360px] w-full" />
          ) : (
            <ul className="divide-y divide-line">
              {d.latest.slice(0, 14).map((r) => {
                const card = r.accession && cards.data?.has(r.accession) ? `/f/${r.accession}/` : null
                const c = r.changes
                return (
                  <li key={r.slug}>
                    <Link to={card ?? `/investors/${r.slug}/`} className="flex items-center gap-3 py-2.5 hover:text-accent">
                      <Monogram name={r.manager} size={30} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[14px] font-medium">{r.manager}</span>
                          {r.featured && <Badge tone="accent">Superinvestor</Badge>}
                        </span>
                        <span className="block truncate text-[12.5px] text-ink-3">
                          {dateLabel(r.filing_date)}
                          {c ? ` · ${c.new ?? 0} new, ${c.added ?? 0} added, ${c.trimmed ?? 0} trimmed, ${c.exited ?? 0} exited` : ''}
                        </span>
                      </span>
                      {card && <span className="shrink-0 text-[12.5px] font-medium text-accent">Card</span>}
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </div>

      {d?.expected && d.expected.length > 0 && <ExpectedPanel list={d.expected} cards={cards.data} now={now} />}

      <Signup source="season" className="mt-6" />

      <p className="mt-6 text-[13px] leading-relaxed text-ink-3">
        From Form 13F-HR filings as accepted by SEC EDGAR. Each fund is compared with its own previous 13F; changes are valued at quarter-end prices as filed. Filer counts include every 13F-HR with parsed holdings. Not investment advice.{' '}
        <Link to="/methodology/" className="underline underline-offset-2 hover:text-ink">
          Methodology
        </Link>
      </p>
    </div>
  )
}

// "Usually deadline day, after the close", from the filer's last four 13F-HRs.
const dayPhrase = (n: number) => (n === 0 ? 'deadline day' : n === 1 ? 'the business day before the deadline' : n >= 10 ? `about ${Math.round(n / 5)} weeks before the deadline` : `${n} business days before the deadline`)
function usual(x: Expected) {
  const t = x.time_et
  const when = t < 9 * 60 + 30 ? 'before the open' : t < 16 * 60 ? 'during market hours' : 'after the close'
  const at = x.time_range ? `${clock(x.time_range[0])}–${clock(x.time_range[1])} lately` : `around ${clock(t)}`
  if (x.pattern === 'none') return `No fixed day; last filed ${x.days_before === 0 ? 'on deadline day' : dayPhrase(x.days_before)}, ${when} (${at})`
  return `${x.pattern === 'usually' ? 'Usually' : 'Most often'} ${dayPhrase(x.days_before)}, ${when} (${at})`
}
const clock = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'am' : 'pm'}`
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

function ExpectedPanel({ list, cards, now }: { list: Expected[]; cards?: Set<string>; now: number }) {
  const [copied, setCopied] = useState(false)
  // The panel renders after the data loads, so a shared #expected link scrolls here once it exists.
  useEffect(() => {
    if (location.hash === '#expected') document.getElementById('expected')?.scrollIntoView()
  }, [])
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const waiting = list.filter((x) => !x.filed)
  const done = list.filter((x) => x.filed)
  // Group the ones still to file by expected day; a filer whose last 13F was an empty placeholder is
  // listed apart, never as later than usual.
  const dayOf = (x: Expected) => (x.placeholder ? 'empty' : (x.expected_date ?? ''))
  const days = [...new Set(waiting.map(dayOf))].sort((a, b) => (a === 'empty' ? 1 : b === 'empty' ? -1 : 0))
  return (
    <section id="expected" className="mt-5 scroll-mt-24 rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]" aria-labelledby="expected-title">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4 md:px-6">
        <div>
          <h2 id="expected-title" className="text-[15px] font-semibold">
            Expected to file
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-3">When each superinvestor usually files, from the EDGAR acceptance times of their last four 13Fs. New York time.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(`${location.origin}${location.pathname}#expected`)
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          }}
          className="inline-flex h-8 items-center rounded-full bg-card px-3.5 text-[13px] font-medium shadow-[0_0_0_1px_var(--color-line-2)] hover:shadow-[0_0_0_1px_var(--color-ink-3)]"
        >
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      </header>
      <div className="divide-y divide-line">
        {days.map((day) => (
          <div key={day} className="grid grid-cols-1 gap-x-6 gap-y-1 px-5 py-3 md:grid-cols-[9rem_minmax(0,1fr)] md:px-6">
            <p className={`pt-2 text-[13px] font-medium ${day === 'empty' ? 'text-ink-2' : day && day < today ? 'text-[#8a5a0b]' : day === today ? 'text-accent' : 'text-ink-2'}`}>
              {day === 'empty' ? 'Last 13F was empty' : !day ? 'No fixed day' : day === today ? 'Today' : dayLabel(day)}
              {day && day !== 'empty' && day < today && <span className="block text-[12px] font-normal">later than usual</span>}
            </p>
            <ul className="grid min-w-0 grid-cols-1 gap-x-6 sm:grid-cols-2">
              {waiting
                .filter((x) => dayOf(x) === day)
                .map((x) => (
                  <li key={x.slug} className="min-w-0">
                    <Link to={`/investors/${x.slug}/`} className="flex items-start gap-2.5 rounded-lg py-1.5 hover:text-accent">
                      <Monogram name={x.manager} size={26} />
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-medium">{x.manager}</span>
                        <span className="block text-[12.5px] leading-snug text-ink-3" title={x.history.map((h) => `${quarterLabel(h.quarter)}: ${new Date(h.accepted_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}`).join('\n')}>
                          {x.via && <span className="text-ink-2">Files as {x.via.replace(/,?\s+(Inc|LLC|L\.?P|Ltd)\.?$/i, '')}. </span>}
                          {x.placeholder ? `Filed an empty 13F for ${quarterLabel(x.placeholder.quarter)}; showing ${quarterLabel(x.placeholder.showing)}, the latest full book` : usual(x)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
      {done.length > 0 && (
        <p className="border-t border-line px-5 py-3 text-[13px] text-ink-2 md:px-6">
          Already filed:{' '}
          {done.map((x, i) => (
            <span key={x.slug}>
              {i > 0 && ', '}
              <Link to={x.filed?.accession && cards?.has(x.filed.accession) ? `/f/${x.filed.accession}/` : `/investors/${x.slug}/`} className="font-medium text-ink hover:text-accent">
                {x.manager}
              </Link>
            </span>
          ))}
          .
        </p>
      )}
    </section>
  )
}

const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`
}

function Progress({ label, sub, v }: { label: string; sub: string; v?: { filed: number; total: number } }) {
  const p = v && v.total ? v.filed / v.total : 0
  return (
    <div className="rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)]">
      <p className="text-[13px] text-ink-2">{label}</p>
      <p className="num mt-1.5 text-[28px] font-semibold tracking-[-0.03em]">
        {v ? v.filed.toLocaleString('en-US') : '—'}
        <span className="text-[16px] font-normal text-ink-3"> of {v ? v.total.toLocaleString('en-US') : '—'} filed</span>
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink/[0.06]" role="progressbar" aria-label={`${label} filed`} aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(p ? 1.5 : 0, p * 100)}%` }} />
      </div>
      <p className="mt-2 text-[12.5px] text-ink-3">
        {Math.round(p * 100)}% · {sub}
      </p>
    </div>
  )
}

// Business days from the first filing to the deadline; days still ahead show as empty slots.
function DayBars({ d, now }: { d: SeasonData; now: number }) {
  const counts = new Map(d.by_day.map((x) => [x.date, x.count]))
  const days: string[] = []
  const due = d.deadline.slice(0, 10)
  for (let t = new Date(`${d.by_day[0]?.date ?? due}T12:00:00Z`); t.toISOString().slice(0, 10) <= due; t.setUTCDate(t.getUTCDate() + 1)) if (isEdgarDay(t.toISOString().slice(0, 10))) days.push(t.toISOString().slice(0, 10))
  const max = Math.max(1, ...days.map((x) => counts.get(x) ?? 0))
  // EDGAR's day is New York's: in UTC, Sunday evening is already Monday.
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const latest = d.by_day.at(-1)?.date
  return (
    <div>
      <div className="flex h-40 items-end gap-[3px]" role="img" aria-label={`13F filings per business day, ${d.by_day.length} days so far, deadline ${dateLabel(due)}`}>
        {days.map((x) => {
          const c = counts.get(x) ?? 0
          const future = x > today || (x === today && !c)
          return (
            <div key={x} className="group relative flex h-full flex-1 items-end" title={`${dateLabel(x)}: ${c.toLocaleString('en-US')} filed`}>
              {future ? (
                <div className={`w-full rounded-t-[3px] border border-dashed ${x === due ? 'h-full border-accent/60 bg-accent-soft/60' : 'h-3 border-line-2'}`} />
              ) : (
                <div className={`w-full rounded-t-[3px] ${x === latest ? 'bg-accent' : 'bg-accent/35 group-hover:bg-accent/60'}`} style={{ height: `${Math.max(1.5, (c / max) * 100)}%` }} />
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex justify-between text-[12px] text-ink-3">
        <span>{dateLabel(days[0])}</span>
        {latest && (
          <span className="text-ink-2">
            Latest day, {dateLabel(latest)}: <span className="num font-medium text-ink">{(counts.get(latest) ?? 0).toLocaleString('en-US')}</span> filed
          </span>
        )}
        <span className="font-medium text-accent">Deadline {dateLabel(due)}</span>
      </div>
    </div>
  )
}

function Row({ r, i, tab }: { r: SeasonRow; i: number; tab: Tab }) {
  const sell = tab === 'sold'
  const who = sell ? r.sellers : r.buyers
  const value = tab === 'most_buyers' ? r.buy_value : r.net_value
  return (
    <li className="border-b border-line last:border-0">
      <Link to={stockPath(r.ticker)} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3 hover:bg-ink/[0.025] md:grid-cols-[2rem_minmax(0,1.2fr)_1fr_7rem] md:px-6">
        <span className="num text-[13px] text-ink-3">{i + 1}</span>
        <span className="min-w-0">
          <span className="font-mono text-[13px] font-medium">{r.ticker}</span>
          <span className="block truncate text-[13px] text-ink-3">{r.name}</span>
        </span>
        <span className="hidden items-center gap-2 md:flex">
          <AvatarStack names={who.map((w) => ({ slug: w.slug, name: w.manager }))} />
          <span className="truncate text-[12.5px] text-ink-3">
            {r.n_buyers ?? r.buyers.length} bought · {r.n_sellers ?? r.sellers.length} sold
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

export function SplitNote({ splits }: { splits?: { ticker: string; ratio: string }[] }) {
  if (!splits?.length) return null
  const top = splits.slice(0, 4)
  return (
    <p className="border-t border-line px-5 py-3 text-[12.5px] text-ink-3 md:px-6">
      Not ranked, because holders’ share changes look like a stock split rather than trades:{' '}
      {top.map((x, i) => (
        <span key={x.ticker}>
          {i > 0 && ', '}
          <Link to={stockPath(x.ticker)} className="font-mono text-ink-2 hover:text-accent">
            {x.ticker}
          </Link>{' '}
          {x.ratio}
        </span>
      ))}
      {splits.length > top.length && ` and ${splits.length - top.length} more`}.
    </p>
  )
}
