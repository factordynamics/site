import { useState } from 'react'
import { Link } from 'react-router-dom'
import { FollowSignup } from '../components/FollowSignup'
import { Skeleton } from '../components/ui'
import { getToken } from '../lib/account'
import { BASE, displayName, getJSON, loadIndex, money, quarterLabel, unreliable, useAsync, useTitle } from '../lib/data'
import { loadExpected } from '../lib/stocks'
import { useTrackVisit } from '../lib/track'

// /weekly/: last week's free Friday email, rebuilt from the filing cards it reads (d/f/), by the email's own
// 13F rules (copybook/api free.ts weeklyMoves): the superinvestors' 13Fs filed in the 7 days to that Friday, at
// most two rows per fund per list, the five biggest buys and sells by dollars. Option, flagged and fund-security
// lines are left out. The email also lists Form 4 trades, which this page doesn't have.

type Card = { accession: string; slug: string; quarter: string; filing_date: string }
type CardMove = { ticker: string | null; name?: string; change?: string; value_delta: number; put_call?: string | null; suspect_units?: boolean; unreliable?: string | null }
type CardFile = { manager?: string; firm?: string; featured?: boolean; quarter: string; total_value?: number; moves?: CardMove[] }
/** `pct`: the trade over the 13F's total value (what payments' email calls delta_pct_of_book), not the position's weight. */
type Row = { slug: string; manager: string; ticker: string; company: string | null; what: string; usd: number; pct: number | null; quarter: string; accession: string }

const LABEL: Record<string, string> = { new: 'new position', added: 'added', trimmed: 'trimmed', exited: 'sold out' }
const FUND_SECURITY = /\b(etf|trust|fund|index|ishares|spdr)\b/i

/** The last Friday edition before today (a Friday's own goes out that evening, so on Friday it's the week before),
 *  and the one going out this Friday, built so far from the filings since the last. */
function editions(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const back = (et.getDay() - 5 + 7) % 7 || 7
  const fri = new Date(Date.UTC(et.getFullYear(), et.getMonth(), et.getDate() - back))
  const day = (d: Date) => d.toISOString().slice(0, 10)
  const next = new Date(fri.getTime() + 7 * 86_400_000)
  return { last: { friday: day(fri), from: day(new Date(fri.getTime() - 7 * 86_400_000)) }, next: { friday: day(next), from: day(fri), today: day(new Date(Date.UTC(et.getFullYear(), et.getMonth(), et.getDate()))) } }
}

type Edition = { friday: string; funds: string[]; buys: Row[]; sells: Row[] }

async function loadWeeks() {
  const e = editions()
  const [idx, cards, soon] = await Promise.all([loadIndex(), getJSON<{ cards: Card[] }>(`${BASE}d/f/index.json`), loadExpected()])
  const featured = new Set(idx.managers.filter((m) => m.featured).map((m) => m.slug))
  const build = async (from: string, to: string, friday: string): Promise<Edition> => {
    // A Friday edition covers the filings after the previous Friday's send: the last one's day belongs to the next.
    const week = cards.cards.filter((c) => c.filing_date >= from && c.filing_date <= to && featured.has(c.slug))
    const files = await Promise.all(week.map((c) => getJSON<CardFile>(`${BASE}d/f/${c.accession}.json`).catch(() => null)))
    const all: Row[] = []
    week.forEach((c, i) => {
      const f = files[i]
      for (const m of f?.moves ?? []) {
        if (!m.ticker || m.put_call || !m.value_delta || !LABEL[m.change ?? ''] || unreliable(m) || FUND_SECURITY.test(m.name ?? '')) continue
        all.push({ slug: c.slug, manager: displayName(f!.manager ?? f!.firm ?? c.slug), ticker: m.ticker, company: m.name && m.name.toUpperCase() !== m.ticker.toUpperCase() ? m.name : null, what: m.change!, usd: m.value_delta, pct: f!.total_value ? m.value_delta / f!.total_value : null, quarter: c.quarter, accession: c.accession })
      }
    })
    const rank = (sign: 1 | -1) => {
      const per = new Map<string, number>()
      return all
        .filter((x) => Math.sign(x.usd) === sign)
        .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))
        .filter((x) => {
          const n = per.get(x.slug) ?? 0
          per.set(x.slug, n + 1)
          return n < 2
        })
        .slice(0, 5)
    }
    const funds = [...new Set(week.map((c, i) => displayName(files[i]?.manager ?? files[i]?.firm ?? c.slug)))]
    return { friday, funds, buys: rank(1), sells: rank(-1) }
  }
  const [last, next] = await Promise.all([build(e.last.from, e.last.friday, e.last.friday), build(e.next.from, e.next.today, e.next.friday)])
  // Superinvestors expected to file before this Friday's email goes out.
  const due = (soon?.expected ?? []).filter((x) => featured.has(x.slug) && x.expected_date && x.expected_date >= e.next.today && x.expected_date <= e.next.friday).map((x) => displayName(x.manager))
  return { last, next, due }
}

/** A trade's size as a share of the fund: "<0.1%" when small, never "0.0%". */
const bookPct = (p: number) => (Math.abs(p) < 0.0005 ? '<0.1%' : `${(Math.abs(p) * 100).toFixed(1)}%`)

const fridayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

function Table({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <>
      <h2 className="mt-6 text-[15px] font-semibold">{title}</h2>
      {rows.length ? (
        <ul className="mt-2 divide-y divide-line text-[14px]">
          {rows.map((x) => (
            <li key={`${x.accession}-${x.ticker}`} className="flex items-baseline justify-between gap-3 py-2">
              <span className="min-w-0">
                <Link to={`/investors/${x.slug}/`} className="font-medium hover:text-accent">
                  {x.manager}
                </Link>
                <span className="block text-ink-2 sm:inline">
                  <span className="hidden sm:inline"> · </span>
                  {LABEL[x.what]} <b className="font-medium text-ink">{x.ticker}</b>
                  {x.company && <span className="text-ink-3"> {x.company}</span>}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end sm:flex-row sm:items-baseline sm:gap-3">
                <span className={`num font-medium ${x.usd > 0 ? 'text-up' : 'text-down'}`}>
                  {x.usd > 0 ? '+' : '−'}
                  {money(Math.abs(x.usd))}
                </span>
                {x.pct != null && <span className="num text-[12.5px] text-ink-3">{bookPct(x.pct)} of portfolio</span>}
                <Link to={`/f/${x.accession}/`} className="hidden text-[12.5px] text-accent hover:text-accent-2 sm:inline">
                  13F {quarterLabel(x.quarter)}
                </Link>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[14px] text-ink-3">None this week.</p>
      )}
    </>
  )
}

export function Weekly() {
  useTitle('The free Friday email: this week’s so far · Copybook')
  useTrackVisit()
  const w = useAsync(loadWeeks, [])
  const [pick, setPick] = useState<'next' | 'last' | null>(null)
  // This Friday's email so far when it has moves yet; else last Friday's.
  const which = pick ?? (w.data && !w.data.next.buys.length && !w.data.next.sells.length ? 'last' : 'next')
  const ed = w.data?.[which]
  const lead = ed && [...ed.buys, ...ed.sells].sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))[0]
  // "From investors you follow" leads each email: shown here as if you followed this edition's biggest mover.
  const followed = lead && ed ? [...ed.buys, ...ed.sells].filter((x) => x.slug === lead.slug).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)).slice(0, 3) : []
  return (
    <div className="container-x max-w-3xl pt-12 md:pt-16">
      <p className="text-[13px] font-medium text-accent">The free Friday email</p>
      <h1 className="mt-3 text-[34px] font-semibold leading-[1.08] tracking-[-0.035em] md:text-[44px]">Every Friday: the week’s biggest superinvestor buys and sells.</h1>
      <p className="mt-4 text-[17px] leading-relaxed text-ink-2">Free, from SEC filings. Each move with the company, the dollars and its size in the fund, and the investors you follow first.</p>

      <div className="seg mt-8 inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Edition">
        {(['next', 'last'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={which === k} onClick={() => setPick(k)} className={`rounded-full px-3 py-1.5 ${which === k ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
            {k === 'next' ? 'This Friday so far' : 'Last Friday'}
          </button>
        ))}
      </div>

      <article className="mt-3 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:p-7">
        {!w.data || !ed ? (
          <Skeleton className="h-[320px] w-full" />
        ) : (
          <>
            {which === 'next' && <p className="mb-3 inline-block rounded-full bg-accent-soft px-2.5 py-0.5 text-[12.5px] font-medium text-accent-2">Preview: this Friday’s email so far</p>}
            <p className="text-[12.5px] text-ink-3">Subject: The week in superinvestor filings{lead ? `: ${lead.manager} ${LABEL[lead.what]} ${lead.ticker}` : ''}</p>
            <p className="mt-3 text-[15px]">Superinvestor filings, the week to {fridayLabel(ed.friday)}.</p>
            {followed.length > 0 && (
              <div className="mt-4 rounded-xl bg-ink/[0.04] px-4 py-3">
                <p className="text-[13px] font-semibold">
                  From investors you follow <span className="font-normal text-ink-3">· example, if you follow {lead!.manager}</span>
                </p>
                {followed.map((x) => (
                  <p key={`f-${x.accession}-${x.ticker}`} className="mt-1 text-[14px] text-ink-2">
                    {x.manager}: {LABEL[x.what]} <b className="font-medium text-ink">{x.ticker}</b>
                    {x.company ? ` (${x.company})` : ''}, <span className={`num font-medium ${x.usd > 0 ? 'text-up' : 'text-down'}`}>{x.usd > 0 ? '+' : '−'}{money(Math.abs(x.usd))}</span>
                    {x.pct != null ? `, ${bookPct(x.pct)} of portfolio` : ''}
                  </p>
                ))}
              </div>
            )}
            <Table title="Biggest buys" rows={ed.buys} />
            <Table title="Biggest sells" rows={ed.sells} />
            {which === 'next' && w.data.due.length > 0 && (
              <p className="mt-5 text-[14px] text-ink-2">
                <span className="font-medium text-ink">Expected before Friday:</span> {w.data.due.slice(0, 8).join(', ')}
                {w.data.due.length > 8 ? ` and ${w.data.due.length - 8} more` : ''}. Their moves join this email as they file.
              </p>
            )}
            <p className="mt-6 border-t border-line pt-4 text-[12.5px] leading-relaxed text-ink-3">
              Rebuilt here from the same filings: the 13F moves of {ed.funds.length ? ed.funds.join(', ') : 'the superinvestors who filed that week'}. “Of portfolio” is the trade’s size against the fund’s whole 13F. The email also lists their Form 4 trades. Not investment advice.
            </p>
          </>
        )}
      </article>

      {!getToken() && (
        <section className="mt-6 rounded-[var(--radius-card)] bg-accent-soft p-5 md:p-6">
          <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Get it every Friday, free</h2>
          <FollowSignup
            people={[
              { slug: 'warren-buffett', name: 'Warren Buffett' },
              { slug: 'bill-ackman', name: 'Bill Ackman' },
              { slug: 'stanley-druckenmiller', name: 'Stanley Druckenmiller' },
              { slug: 'seth-klarman', name: 'Seth Klarman' },
            ]}
            collapsed
            cta="Get it free"
            label="Your email, for the free Friday email"
            quietLabel
            className="mt-3 text-[14.5px]"
          />
        </section>
      )}
    </div>
  )
}
