import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TRIAL_DAYS } from '../config'
import { ApiError, useMember } from '../lib/account'
import { money, pricingTo, quarterLabel, useAsync } from '../lib/data'
import { setFollow, useFollows } from '../lib/follows'
import { loadStock, resolveTicker, stockPath, type Stock } from '../lib/stocks'
import { Arrow, Button, Lock, Skeleton } from './ui'

// "My names" for free accounts: up to 5 owned names (the API's free_names cap), each with one public
// fact. The Friday email's fact comes first (/me free_names.facts, this week's superinvestor moves),
// then the stock page's strongest: a superinvestor's Form 4 or 13D since its last 13F, else its largest
// 13F move. The email's locked hook names the biggest thing Copy adds; everything else is Copy too.

const LIMIT = 5

/** One fact a stock page already shows to anyone. */
function fact(s: Stock | null, ticker: string) {
  if (!s) return 'Not in the 13F data yet'
  // A superinvestor's own Form 4 trade or 13D since its last 13F outranks a quarter-old 13F move.
  const ev = (s.since ?? []).filter((e) => (e.kind === 'form4' && (e.action === 'buy' || e.action === 'sell') && e.value_usd) || (e.kind === '13d' && e.percent_of_class))
  const e = ev.sort((a, b) => (b.value_usd ?? Infinity) - (a.value_usd ?? Infinity))[0]
  if (e) {
    const when = new Date(`${e.filing_date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    if (e.kind === 'form4') return `${e.manager} ${e.action === 'buy' ? 'bought' : 'sold'} ${money(e.value_usd ?? 0)} of ${ticker} (Form 4, ${when})`
    return `${e.manager} holds ${e.percent_of_class}% of ${ticker} (13D, ${when})`
  }
  // The newest quarter in which a superinvestor moved (most haven't filed the season under way yet),
  // and its biggest move; a quarter that looks like an unadjusted split has no trades to show.
  const moved = (q: string) => [...s.holders, ...s.exited].filter((h) => h.featured && h.quarter === q && h.change && h.change !== 'unchanged' && h.delta_value)
  const q = [...s.quarters].sort().reverse().find((x) => s.splits?.[x]?.adjusted !== false && moved(x).length) ?? ''
  const m = q ? moved(q).sort((a, b) => Math.abs(b.delta_value) - Math.abs(a.delta_value))[0] : null
  const Q = q ? ` in ${quarterLabel(q)}` : ''
  if (m) {
    const v = money(Math.abs(m.delta_value))
    if (m.change === 'new') return `${m.manager} opened a ${v} position${Q}`
    if (m.change === 'added') return `${m.manager} bought ${v} of ${ticker}${Q}`
    if (m.change === 'trimmed') return `${m.manager} sold ${v} of ${ticker}${Q}`
    return `${m.manager} sold out of ${ticker}${Q} (${v})`
  }
  const supers = s.holders.filter((h) => h.featured).length
  if (supers) return `Held by ${supers} superinvestor${supers === 1 ? '' : 's'}`
  if (s.holders.length) return `Held by ${s.holders.length} fund${s.holders.length === 1 ? '' : 's'} we track closely`
  return 'No fund we track holds it'
}

export function FreeNames({ className = '' }: { className?: string }) {
  const { status, follows } = useFollows()
  const fn = useMember()?.free_names
  const told = new Map((fn?.facts ?? []).map((f) => [f.ticker, f]))
  const names = follows.owned
  const data = useAsync(() => Promise.all(names.map((t) => loadStock(t).catch(() => null))), [names.join(',')])
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<{ t: string; trial?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const full = names.length >= LIMIT
  // One ticker or a pasted list ("MSFT, $GOOGL brk-b"), added one at a time until the free limit.
  const add = async () => {
    const cells = [...new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))]
    if (!cells.length) return
    if (full) return setMsg({ t: `Free accounts can save up to ${LIMIT} names. Copy has no limit.`, trial: true })
    setBusy(true)
    setMsg(null)
    const added: string[] = []
    const have: string[] = []
    const unknown: string[] = []
    let limit: string | null = null
    let failed = false
    for (const c of cells) {
      const t = await resolveTicker(c).catch(() => null)
      if (!t) unknown.push(c)
      else if (names.includes(t) || added.includes(t)) have.push(t)
      else if (limit) continue
      else {
        try {
          await setFollow('owned', t, true)
          added.push(t)
        } catch (e) {
          if (e instanceof ApiError && e.code === 'free_limit') limit = e.detail ?? `Free accounts can save up to ${LIMIT} names. Copy has no limit.`
          else failed = true
        }
      }
    }
    setBusy(false)
    if (added.length) setText('')
    const parts = [added.length ? `Added ${added.join(', ')}` : '', have.length ? `already saved: ${have.join(', ')}` : '', unknown.length ? `not recognized: ${unknown.join(', ')}` : '', failed ? 'some didn’t save, please try again' : ''].filter(Boolean)
    setMsg(limit ? { t: `${parts.length ? `${parts.join(' · ')}. ` : ''}${limit}`, trial: true } : { t: `${parts.join(' · ')}.` })
  }
  return (
    <section className={`rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)] ${className}`} aria-labelledby="free-names-title">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 md:px-6 md:pt-6">
        <div>
          <h2 id="free-names-title" className="text-[15px] font-semibold">
            Your {LIMIT} names: get them in the free Friday email
          </h2>
          <p className="mt-1 text-[13.5px] text-ink-2">Stocks you own. Each Friday’s email opens with what the superinvestors did in them.</p>
        </div>
        <span className="num text-[13px] text-ink-3">
          {names.length} of {LIMIT}
        </span>
      </header>
      {status !== 'ready' ? (
        <div className="space-y-2 px-5 py-4 md:px-6">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {names.map((t, i) => (
            <li key={t} className="flex items-center gap-3 px-5 py-3 md:px-6">
              <Link to={stockPath(t)} className="w-16 shrink-0 font-mono text-[13px] font-semibold hover:text-accent">
                {t}
              </Link>
              <span className="min-w-0 flex-1 text-[13.5px]">
                {told.has(t) ? (
                  <a href={told.get(t)!.url} className="hover:text-accent">
                    {told.get(t)!.text.replace(/, which you own$/, '')}
                  </a>
                ) : data.loading ? (
                  <Skeleton className="h-4 w-2/3" />
                ) : (
                  fact(data.data?.[i] ?? null, t)
                )}
              </span>
              <button type="button" onClick={() => setFollow('owned', t, false).catch(() => null)} className="-my-2 min-h-11 shrink-0 px-1 text-[12.5px] text-ink-3 hover:text-down" aria-label={`Remove ${t}`}>
                Remove
              </button>
            </li>
          ))}
          {!names.length && <li className="px-5 py-4 text-[13.5px] text-ink-3 md:px-6">Add a stock you own to see what the superinvestors did in it.</li>}
        </ul>
      )}
      <form
        className="flex flex-col gap-2 border-t border-line px-5 py-4 sm:flex-row md:px-6"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <label htmlFor="free-name" className="sr-only">
          Ticker
        </label>
        <input
          id="free-name"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={full ? 'Copy keeps unlimited names' : 'Add tickers, e.g. AAPL, MSFT'}
          className="h-11 w-full min-w-0 rounded-full bg-paper px-4 font-mono sm:h-10 sm:flex-1 text-[14px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:font-sans placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
        />
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </form>
      {msg && (
        <p role="status" className="-mt-1 px-5 pb-4 text-[13px] text-ink-2 md:px-6">
          {msg.t}{' '}
          {msg.trial && (
            <Link to={pricingTo()} className="font-medium text-accent hover:text-accent-2">
              Start {TRIAL_DAYS}-day free trial
            </Link>
          )}
        </p>
      )}
      <Link to={pricingTo()} className="flex items-center gap-3 rounded-b-[var(--radius-card)] border-t border-line bg-ink/[0.025] px-5 py-3.5 text-[13.5px] text-ink-2 hover:text-ink md:px-6">
        <Lock />
        <span className="min-w-0 flex-1">
          {fn?.hook ? (
            <>
              <span className="font-medium text-ink">{fn.hook}, with Copy</span>
              {fn.more ? ` · +${fn.more} more in your names` : ''}
            </>
          ) : (
            'Every fund holding your names, their weights, insider trades and an alert when anyone moves: Copy'
          )}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-accent">
          Start {TRIAL_DAYS}-day free trial <Arrow className="size-3" />
        </span>
      </Link>
    </section>
  )
}
