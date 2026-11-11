import { Link } from 'react-router-dom'
import { FollowSignup } from '../components/FollowSignup'
import { Skeleton } from '../components/ui'
import { getToken } from '../lib/account'
import { BASE, displayName, getJSON, loadIndex, money, quarterLabel, unreliable, useAsync, useTitle } from '../lib/data'
import { useTrackVisit } from '../lib/track'

// /weekly/: last week's free Friday email, rebuilt from the filing cards it reads (d/f/), by the email's own
// 13F rules (copybook/api free.ts weeklyMoves): the superinvestors' 13Fs filed in the 7 days to that Friday, at
// most two rows per fund per list, the five biggest buys and sells by dollars. Option, flagged and fund-security
// lines are left out. The email also lists Form 4 trades, which this page doesn't have.

type Card = { accession: string; slug: string; quarter: string; filing_date: string }
type CardMove = { ticker: string | null; name?: string; change?: string; value_delta: number; put_call?: string | null; suspect_units?: boolean; unreliable?: string | null }
type CardFile = { manager?: string; firm?: string; featured?: boolean; quarter: string; moves?: CardMove[] }
type Row = { slug: string; manager: string; ticker: string; what: string; usd: number; quarter: string; accession: string }

const LABEL: Record<string, string> = { new: 'new position', added: 'added', trimmed: 'trimmed', exited: 'sold out' }
const FUND_SECURITY = /\b(etf|trust|fund|index|ishares|spdr)\b/i

/** The last Friday edition before today (a Friday's own goes out that evening, so on Friday it's the week before). */
function edition(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const back = (et.getDay() - 5 + 7) % 7 || 7
  const fri = new Date(Date.UTC(et.getFullYear(), et.getMonth(), et.getDate() - back))
  const from = new Date(fri.getTime() - 7 * 86_400_000)
  const day = (d: Date) => d.toISOString().slice(0, 10)
  return { friday: day(fri), from: day(from) }
}

async function loadWeek() {
  const { friday, from } = edition()
  const [idx, cards] = await Promise.all([loadIndex(), getJSON<{ cards: Card[] }>(`${BASE}d/f/index.json`)])
  const featured = new Set(idx.managers.filter((m) => m.featured).map((m) => m.slug))
  const week = cards.cards.filter((c) => c.filing_date >= from && c.filing_date <= friday && featured.has(c.slug))
  const files = await Promise.all(week.map((c) => getJSON<CardFile>(`${BASE}d/f/${c.accession}.json`).catch(() => null)))
  const all: Row[] = []
  week.forEach((c, i) => {
    const f = files[i]
    for (const m of f?.moves ?? []) {
      if (!m.ticker || m.put_call || !m.value_delta || !LABEL[m.change ?? ''] || unreliable(m) || FUND_SECURITY.test(m.name ?? '')) continue
      all.push({ slug: c.slug, manager: displayName(f!.manager ?? f!.firm ?? c.slug), ticker: m.ticker, what: m.change!, usd: m.value_delta, quarter: c.quarter, accession: c.accession })
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
  return { friday, funds: new Set(week.map((c) => c.slug)).size, buys: rank(1), sells: rank(-1) }
}

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
                <span className="text-ink-2">
                  {' '}
                  · <b className="font-medium text-ink">{x.ticker}</b> {LABEL[x.what]}
                </span>
              </span>
              <span className="flex shrink-0 items-baseline gap-3">
                <span className={`num font-medium ${x.usd > 0 ? 'text-up' : 'text-down'}`}>
                  {x.usd > 0 ? '+' : '−'}
                  {money(Math.abs(x.usd))}
                </span>
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
  useTitle('The free Friday email: last week’s edition · Copybook')
  useTrackVisit()
  const w = useAsync(loadWeek, [])
  return (
    <div className="container-x max-w-3xl pt-12 md:pt-16">
      <p className="text-[13px] font-medium text-accent">The free Friday email</p>
      <h1 className="mt-3 text-[34px] font-semibold leading-[1.08] tracking-[-0.035em] md:text-[44px]">Every Friday: the week’s biggest superinvestor buys and sells.</h1>
      <p className="mt-4 text-[17px] leading-relaxed text-ink-2">Free, from SEC filings. Here is last week’s edition.</p>

      <article className="mt-8 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:p-7">
        {!w.data ? (
          <Skeleton className="h-[320px] w-full" />
        ) : (
          <>
            <p className="text-[12.5px] text-ink-3">Subject: The week in superinvestor filings{w.data.buys[0] ? `: ${w.data.buys[0].manager} ${LABEL[w.data.buys[0].what]} ${w.data.buys[0].ticker}` : ''}</p>
            <p className="mt-3 text-[15px]">Superinvestor filings, the week to {fridayLabel(w.data.friday)}.</p>
            <Table title="Biggest buys" rows={w.data.buys} />
            <Table title="Biggest sells" rows={w.data.sells} />
            <p className="mt-6 border-t border-line pt-4 text-[12.5px] leading-relaxed text-ink-3">
              Rebuilt here from the same filings: the 13F moves of the {w.data.funds} {w.data.funds === 1 ? 'superinvestor' : 'superinvestors'} who filed that week. The email also lists their Form 4 trades, and leads with the investors you follow. Not investment advice.
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
