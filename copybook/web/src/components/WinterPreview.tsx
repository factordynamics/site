import { useEffect, useState } from 'react'
import { readWinter } from '../lib/meShape.mjs'
import { Link } from 'react-router-dom'
import { call } from '../lib/account'
import { dateFmt, money } from '../lib/data'
import { stockPath } from '../lib/stocks'

/** payments' winterPreview (api stockevents.ts): last winter (Dec 2025–Jan 2026) in the member's followed funds and stocks.
 *  `events` holds insider buys, then new stakes, strongest first; amendments are only counted. `names` counts stocks. */
type WinterEvent = {
  ticker: string
  kind: 'insider_buy' | 'schedule_13dg'
  form: string
  filed: string
  date: string | null
  who: string
  role: string | null
  value_usd: number | null
  action: string | null
  accession: string
  url: string
  company?: string | null
}
type Winter = {
  names: number
  insider_buys: number
  schedule_13dg: number
  amendments: number
  amendments_followed: boolean
  events: WinterEvent[]
  pending: string[]
}

const day = (d: string) => dateFmt({ month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T12:00:00Z`))
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const form = (f: string) => f.replace(/^(SC|SCHEDULE) /, '')
const owner = (r: string | null) => (!r || r === 'officer' ? 'an officer' : r === 'director' ? 'a director' : `the ${r}`)

/** "a director's $25.0M CRM buy", or "Carl Icahn's new stake in Chewy" */
function strongest(e: WinterEvent) {
  if (e.kind === 'insider_buy') return `${owner(e.role)}’s ${e.value_usd ? `${money(e.value_usd)} ` : ''}${e.ticker} buy`
  return `${e.who}’s ${e.action === 'new_stake' ? 'new stake' : '13D/G'} in ${e.company || e.ticker || 'a company'}`
}

/** The one line above the plan choice, and a fold-out list with each filing on EDGAR. Day 12's case for keeping Copy. */
export function WinterPreview({ className = '' }: { className?: string }) {
  const [w, setW] = useState<Winter | null | undefined>(undefined)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    let off = false
    call<{ member?: { winter_preview?: Winter | null } }>('/me?include=winter', {
      auth: true,
      cache: 'no-store',
      timeout: 20_000,
    })
      .then((r) => !off && setW(readWinter<Winter>(r)))
      .catch(() => null)
    return () => {
      off = true
    }
  }, [tries])
  // payments fills a newly followed name within a minute or two: ask again while any are pending, for up to 10 minutes.
  const pending = w?.pending.length ?? 0
  useEffect(() => {
    if (!pending || tries >= 20) return
    const t = setTimeout(() => setTries((n) => n + 1), 30_000)
    return () => clearTimeout(t)
  }, [pending, tries])

  if (w === undefined) return null // still loading, or the API is down: the plan choice stands alone
  const box = `border-y border-accent/20 py-2.5 text-[13.5px] text-ink ${className}`
  const total = w ? w.insider_buys + w.schedule_13dg : 0
  if (!w || (!total && !pending && !w.names)) {
    return (
      <p className={box}>
        <Link to="/investors/" className="font-medium text-accent underline underline-offset-2">
          Follow a few funds or stocks
        </Link>{' '}
        to see what last winter would have sent you.
      </p>
    )
  }
  if (pending) {
    return (
      <p className={`${box} flex items-center gap-2`} role="status">
        <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />
        Checking {plural(pending, 'name')} on EDGAR…
      </p>
    )
  }
  if (!total) {
    return <p className={box}>Last winter (Dec 2025–Jan 2026) was quiet for your names: no insider buys of $100K or more and no 13D/G filings.</p>
  }
  const top = w.events[0]
  return (
    <div className={box}>
      <p>
        Last winter, your funds and stocks would have sent you <b className="font-semibold">{plural(total, 'alert')}</b>
        {top ? <>, including {strongest(top)}.</> : '.'}
      </p>
      <details className="group mt-1.5">
        <summary className="cursor-pointer list-none text-[12.5px] font-medium text-accent [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">See all {total} →</span>
          <span className="hidden group-open:inline">Hide the list</span>
        </summary>
        <ul className="mt-2 divide-y divide-line text-[13px]">
          {w.events.map((e) => (
            <li key={e.accession} className="py-1.5">
              <span className="block [overflow-wrap:anywhere]">
                {e.kind === 'insider_buy' ? (
                  <>
                    <Link to={stockPath(e.ticker)} className="font-semibold text-ink hover:text-accent">
                      {e.ticker}
                    </Link>{' '}
                    {e.role || 'insider'} bought {e.value_usd ? money(e.value_usd) : 'shares'}
                  </>
                ) : (
                  <>
                    <span className="font-semibold">{e.who}</span> {e.action === 'new_stake' ? 'new stake in' : 'filed on'}{' '}
                    {e.ticker ? (
                      <Link to={stockPath(e.ticker)} className="font-medium text-ink hover:text-accent">
                        {e.company || e.ticker}
                      </Link>
                    ) : (
                      e.company || 'a company'
                    )}
                  </>
                )}
              </span>
              <span className="mt-0.5 block text-[12px] text-ink-3 tabular-nums">
                {e.kind === 'insider_buy' ? 'Form 4' : `Schedule ${form(e.form)}`} · {day(e.date ?? e.filed)}
                {e.url && (
                  <>
                    {' · '}
                    <a href={e.url} target="_blank" rel="noopener" className="font-medium text-accent hover:text-accent-2">
                      EDGAR ↗
                    </a>
                  </>
                )}
              </span>
            </li>
          ))}
          {w.amendments > 0 && (
            <li className="py-1.5 text-ink-3">
              + {plural(w.amendments, 'amendment')}
              {w.amendments_followed ? ' by funds you follow' : ''} ·{' '}
              <Link to="/winter-2025-26/#filings-13dg" className="font-medium text-accent hover:text-accent-2">
                see them
              </Link>
            </li>
          )}
        </ul>
      </details>
    </div>
  )
}
