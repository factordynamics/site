import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { loadIndex, money, useAsync } from '../lib/data'
import { fetchMe, type Member } from '../lib/account'
import { saveFollows, toggle, useFollows } from '../lib/follows'
import { loadStockIndex, stockPath, tickerText } from '../lib/stocks'
import { Button, Check, Monogram, Skeleton } from './ui'

/** First-run setup for members: whom to follow, and which stocks they own. */
// Investor styles for the picker. Editorial grouping; any slug missing from the index is skipped.
const GROUPS = [
  ['Value', ['warren-buffett', 'seth-klarman', 'li-lu', 'mason-hawkins', 'francois-rochon', 'tweedy-browne', 'bill-nygren', 'ruane-cunniff', 'terry-smith', 'howard-marks', 'david-abrams', 'david-einhorn', 'richard-pzena']],
  ['Activist', ['carl-icahn', 'bill-ackman', 'nelson-peltz', 'dan-loeb', 'mason-morfit', 'chris-hohn', 'elliott-investment-management-l-p', 'starboard-value-lp', 'jana-partners-management-lp', 'sachem-head-capital-management-lp']],
  ['Tiger cubs & growth', ['chase-coleman', 'stephen-mandel', 'andreas-halvorsen', 'philippe-laffont', 'dan-sundheim', 'maverick-capital-ltd']],
  ['Macro & multi-strategy', ['stanley-druckenmiller', 'david-tepper', 'ray-dalio', 'soros-fund-management-llc', 'tudor-investment-corp-et-al']],
  ['Largest', []],
] as const

export function Onboarding({ onDone }: { onDone?: (member?: Member) => void }) {
  const idx = useAsync(loadIndex, [])
  const { follows } = useFollows()
  const [investors, setInvestors] = useState<string[]>(follows.investors)
  const [owned, setOwned] = useState<string[]>(follows.owned)
  const [watched, setWatched] = useState<string[]>(follows.stocks.filter((t) => !follows.owned.includes(t)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [group, setGroup] = useState<(typeof GROUPS)[number][0]>('Value')
  const bySlug = new Map((idx.data?.managers ?? []).map((m) => [m.slug, m]))
  const pick = GROUPS.find(([g]) => g === group)![1]
  const featured = (pick.length ? pick.map((sl) => bySlug.get(sl)).filter((m) => m !== undefined) : (idx.data?.featured ?? []).slice(0, 18))

  const finish = async (skip = false) => {
    setBusy(true)
    setError(false)
    try {
      await saveFollows(skip ? { onboarded: true } : { investors, owned, stocks: [...new Set([...watched, ...owned])], onboarded: true })
      // The API moves a member who never picked an alert scope to followed funds when follows are saved.
      onDone?.(await fetchMe().catch(() => undefined))
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[18px] bg-card p-6 shadow-[var(--shadow-card)] md:p-8" aria-labelledby="onb-title">
      <p className="text-[13px] font-medium text-accent">Set up Copy · 1 minute</p>
      <h2 id="onb-title" className="mt-2 text-[26px] font-semibold tracking-[-0.03em]">
        Whom do you want to follow?
      </h2>
      <p className="mt-1.5 text-[15px] text-ink-2">We’ll email you minutes after they file, with their biggest buys and sells in it.</p>
      <div className="mt-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Investor style">
        {GROUPS.map(([g, slugs]) => {
          const n = slugs.filter((sl) => investors.includes(sl)).length
          return (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={group === g}
              onClick={() => setGroup(g)}
              className={`rounded-full px-3 py-1.5 text-[13px] ${group === g ? 'bg-ink font-medium text-white' : 'bg-ink/[0.05] text-ink-2 hover:bg-ink/[0.08]'}`}
            >
              {g}
              {n > 0 && <span className={`ml-1.5 text-[12px] ${group === g ? 'text-white/70' : 'text-accent'}`}>{n}</span>}
            </button>
          )
        })}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {!idx.data &&
          Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        {featured.map((m) => {
          const on = investors.includes(m.slug)
          return (
            <button
              key={m.slug}
              type="button"
              aria-pressed={on}
              onClick={() => setInvestors((l) => toggle(l, m.slug))}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-shadow ${on ? 'bg-accent-soft shadow-[0_0_0_1.5px_var(--color-accent)]' : 'bg-paper shadow-[0_0_0_1px_var(--color-line)] hover:shadow-[0_0_0_1px_var(--color-ink-3)]'}`}
            >
              <Monogram name={m.manager} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{m.manager}</span>
                <span className="block truncate text-[12px] text-ink-3">{m.name !== m.manager ? m.name : money(m.total_value)}</span>
              </span>
              <span className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full ${on ? 'bg-accent text-white' : 'shadow-[0_0_0_1px_var(--color-line-2)]'}`}>{on && <Check className="size-3.5" />}</span>
            </button>
          )
        })}
      </div>

      <h2 className="mt-10 text-[22px] font-semibold tracking-[-0.03em]">Which stocks do you own?</h2>
      <p className="mt-1.5 text-[15px] text-ink-2">We’ll email you when a fund buys or sells them, and tag them in every alert. Only you see this list.</p>
      <TickerPicker value={owned} onChange={setOwned} />

      <h2 className="mt-10 text-[22px] font-semibold tracking-[-0.03em]">Any smaller companies you watch?</h2>
      <p className="mt-1.5 text-[15px] text-ink-2">
        Insider and 13D alerts work best on smaller companies you watch, where an insider buy or an activist stake moves the stock far more than in a mega cap.
      </p>
      <TickerPicker value={watched} onChange={(v) => setWatched(v.filter((t) => !owned.includes(t)))} id="watch-input" label="Add a ticker you watch" placeholder="Add a ticker to watch, e.g. ALAB" />

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Button onClick={() => finish()} disabled={busy}>
          {busy ? 'Saving…' : `Save${investors.length || owned.length || watched.length ? ` · ${investors.length} ${investors.length === 1 ? 'investor' : 'investors'}, ${owned.length + watched.length} ${owned.length + watched.length === 1 ? 'stock' : 'stocks'}` : ''}`}
        </Button>
        <Button variant="ghost" onClick={() => finish(true)} disabled={busy}>
          Skip for now
        </Button>
        {error && (
          <p role="alert" className="text-[13.5px] text-down">
            That didn’t save. Please try again.
          </p>
        )}
      </div>
    </section>
  )
}

/** Ticker input with suggestions from the stock index; shows chosen tickers as removable chips. */
export function TickerPicker({ value, onChange, id = 'owned-input', label = 'Add a ticker you own', placeholder = 'Add a ticker, e.g. NVDA' }: { value: string[]; onChange: (v: string[]) => void; id?: string; label?: string; placeholder?: string }) {
  const idx = useAsync(loadStockIndex, [])
  const [q, setQ] = useState('')
  const hits = useMemo(() => {
    const up = tickerText(q)
    if (!up || !idx.data) return []
    const low = up.toLowerCase()
    return idx.data.stocks
      .filter((s) => !value.includes(s.t) && (s.t.startsWith(up) || s.a.includes(up) || (low.length >= 3 && s.n.toLowerCase().includes(low))))
      .sort((a, b) => Number(b.t === up) - Number(a.t === up) || b.h - a.h)
      .slice(0, 6)
  }, [q, idx.data, value])
  const add = (t: string) => {
    onChange([...value, t])
    setQ('')
  }
  return (
    <div className="mt-4">
      <div className="relative max-w-md">
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <input
          id={id}
          value={q}
          autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) {
              e.preventDefault()
              add(hits[0].t)
            }
          }}
          placeholder={placeholder}
          className="h-11 w-full rounded-full bg-paper px-4 text-[15px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
        />
        {hits.length > 0 && (
          <ul className="absolute z-40 mt-2 w-full rounded-2xl bg-card p-1.5 shadow-[0_0_0_1px_rgb(12_14_19/0.08),0_18px_50px_-12px_rgb(12_14_19/0.3)]">
            {hits.map((s) => (
              <li key={s.t}>
                <button type="button" onClick={() => add(s.t)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-ink/[0.05]">
                  <span className="w-14 font-mono text-[13px] font-medium">{s.t}</span>
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink-2">{s.n}</span>
                  <span className="num shrink-0 text-[12px] text-ink-3">{s.h} funds</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {value.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {value.map((t) => (
            <li key={t} className="inline-flex items-center gap-1 rounded-full bg-paper py-1 pl-3 pr-1 text-[13px] shadow-[0_0_0_1px_var(--color-line)]">
              <Link to={stockPath(t)} className="font-mono font-medium hover:text-accent">
                {t}
              </Link>
              <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))} className="inline-flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-ink/5 hover:text-ink">
                <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                  <path d="M2 2l6 6M8 2 2 8" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
