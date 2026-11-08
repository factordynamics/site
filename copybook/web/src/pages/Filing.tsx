import { Signup } from '../components/Signup'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { FollowButton } from '../components/FollowButton'
import { Arrow, Badge, Button, Monogram, Panel, Skeleton } from '../components/ui'
import { BASE, dateLabel, getJSON, money, quarterLabel, sharesFmt, useAsync, useTitle } from '../lib/data'
import { stockPath } from '../lib/stocks'

// A public card for one 13F (scripts/cards.mjs): the top five moves, made to be shared. Free, no account.
type Card = {
  accession: string
  slug: string
  manager: string
  firm: string
  quarter: string
  prev_quarter: string
  filing_date: string
  sec_url: string
  total_value: number
  position_count: number
  changes?: { new: number; added: number; trimmed: number; exited: number }
  bought_usd: number
  sold_usd: number
  moves_total: number
  moves: { ticker: string | null; name: string; change: 'new' | 'added' | 'trimmed' | 'exited'; value_delta: number; shares: number; prev_shares: number }[]
}

export const cardPath = (accession: string) => `/f/${accession}/`
export const cardUrl = (accession: string) => `${window.location.origin}${BASE}f/${accession}/`

export function FilingCard() {
  const { accession = '' } = useParams()
  const c = useAsync(() => getJSON<Card>(`${BASE}d/f/${encodeURIComponent(accession)}.json`), [accession])
  const d = c.data
  useTitle(d ? `${d.manager}’s ${quarterLabel(d.quarter)} 13F: top moves · Copybook` : undefined)

  if (c.error)
    return (
      <div className="container-x pt-20">
        <h1 className="text-[32px] font-semibold tracking-[-0.03em]">This filing card isn’t available.</h1>
        <p className="mt-3 text-ink-2">Cards cover the latest 13F of each fund we track closely. Older filings are on each investor’s page.</p>
        <Button to="/flow/" className="mt-6">
          See this season’s filings <Arrow />
        </Button>
      </div>
    )

  const max = Math.max(...(d?.moves ?? []).map((m) => Math.abs(m.value_delta)), 1)
  return (
    <div className="container-x pt-10 md:pt-14">
      <nav className="text-[13px] text-ink-3" aria-label="Breadcrumb">
        <Link to="/flow/" className="hover:text-ink">
          Filings
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink-2">{d ? `${d.manager}, ${quarterLabel(d.quarter)}` : accession}</span>
      </nav>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <article className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)] md:p-8">
          {!d ? (
            <Skeleton className="h-[420px] w-full" />
          ) : (
            <>
              <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3.5">
                  <Monogram name={d.manager} size={52} />
                  <div className="min-w-0">
                    <h1 className="truncate text-[28px] font-semibold leading-tight tracking-[-0.03em] md:text-[34px]">{d.manager}</h1>
                    <p className="truncate text-[14.5px] text-ink-3">{d.manager === d.firm ? 'Form 13F-HR' : d.firm}</p>
                  </div>
                </div>
                <Badge>
                  {quarterLabel(d.quarter)} 13F · filed {dateLabel(d.filing_date)}
                </Badge>
              </header>

              <h2 className="mt-7 text-[13px] font-medium text-ink-3">Top moves since {quarterLabel(d.prev_quarter)}, by dollar size</h2>
              <ol className="mt-3 divide-y divide-line">
                {d.moves.map((m) => {
                  const up = m.value_delta >= 0
                  const r = m.prev_shares > 0 && m.shares > 0 ? m.shares / m.prev_shares - 1 : null
                  return (
                    <li key={(m.ticker ?? m.name) + m.change} className="grid grid-cols-[5.25rem_minmax(0,1fr)_auto] items-center gap-3 py-3 sm:grid-cols-[5.5rem_minmax(0,1fr)_8rem_auto]">
                      <Badge tone={up ? 'up' : 'down'} className="justify-center uppercase tracking-[0.04em]">
                        {m.change}
                      </Badge>
                      <span className="min-w-0">
                        {m.ticker ? (
                          <Link to={stockPath(m.ticker)} className="font-mono text-[15px] font-semibold hover:text-accent">
                            {m.ticker}
                          </Link>
                        ) : null}
                        <span className={`${m.ticker ? 'ml-2 ' : ''}text-[14px] text-ink-2`}>{m.name}</span>
                        <span className="block text-[12.5px] text-ink-3">
                          {m.change === 'exited' ? `Sold all ${sharesFmt(m.prev_shares)} shares` : m.change === 'new' ? `${sharesFmt(m.shares)} shares, a new position` : `${sharesFmt(m.prev_shares)} → ${sharesFmt(m.shares)} shares${r != null ? ` (${r > 0 ? '+' : '−'}${Math.round(Math.abs(r) * 100)}%)` : ''}`}
                        </span>
                      </span>
                      <span className="hidden h-2.5 grid-cols-2 sm:grid" aria-hidden="true">
                        <span className="flex justify-end border-r border-line-2">{!up && <span className="h-2.5 rounded-l-full bg-down/80" style={{ width: `${(Math.abs(m.value_delta) / max) * 100}%` }} />}</span>
                        <span className="flex">{up && <span className="h-2.5 rounded-r-full bg-up/80" style={{ width: `${(m.value_delta / max) * 100}%` }} />}</span>
                      </span>
                      <span className={`num text-right text-[15px] font-semibold ${up ? 'text-up' : 'text-down'}`}>
                        {up ? '+' : '−'}
                        {money(Math.abs(m.value_delta))}
                      </span>
                    </li>
                  )
                })}
              </ol>

              <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-line pt-5 text-[13.5px] sm:grid-cols-4">
                {(
                  [
                    ['Bought', money(d.bought_usd)],
                    ['Sold', money(d.sold_usd)],
                    ['Positions', d.position_count.toLocaleString('en-US')],
                    ['Value as filed', money(d.total_value)],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-ink-3">{k}</dt>
                    <dd className="num mt-0.5 text-[17px] font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-5 text-[12.5px] leading-relaxed text-ink-3">
                From the {quarterLabel(d.quarter)} Form 13F-HR as filed with the SEC, compared with {quarterLabel(d.prev_quarter)}. Moves are share changes valued at the filing’s own quarter-end value; options are left out. Not investment advice.{' '}
                <a href={d.sec_url} className="underline underline-offset-2 hover:text-ink">
                  The filing on EDGAR
                </a>
              </p>
            </>
          )}
        </article>

        <aside className="space-y-6">
          {d && <ShareCard d={d} />}
          {d && (
            <Panel title={`Get ${d.manager}’s next 13F by email`}>
              <p className="text-[14px] leading-relaxed text-ink-2">Follow with Copy and the next filing lands in your inbox minutes after EDGAR accepts it, with every new, added, trimmed and exited position inside.</p>
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <FollowButton kind="investor" id={d.slug} name={d.manager} size="md" />
                <Button to={`/investors/${d.slug}/`} variant="outline">
                  All {d.moves_total} moves <Arrow />
                </Button>
              </div>
            </Panel>
          )}
        </aside>
      </div>
      <Signup source="card" className="mt-8" />
    </div>
  )
}

function ShareCard({ d }: { d: Card }) {
  const [copied, setCopied] = useState(false)
  const url = cardUrl(d.accession)
  const top = d.moves
    .slice(0, 3)
    .map((m) => `${m.change === 'new' ? 'New' : m.change[0].toUpperCase() + m.change.slice(1)} ${m.ticker ? `$${m.ticker}` : m.name} ${m.value_delta >= 0 ? '+' : '−'}${money(Math.abs(m.value_delta))}`)
    .join('\n')
  const text = `${d.manager}’s ${quarterLabel(d.quarter)} 13F is out:\n${top}`
  return (
    <Panel title="Share this filing" sub="The card image is attached automatically on X, LinkedIn, Slack and iMessage">
      <img src={`${BASE}og/f/${d.accession}.png`} alt={`${d.manager}’s ${quarterLabel(d.quarter)} 13F card: top moves`} width={1200} height={630} className="w-full rounded-xl shadow-[0_0_0_1px_var(--color-line)]" />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() =>
            navigator.clipboard.writeText(url).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
          }
        >
          {copied ? 'Link copied' : 'Copy link'}
        </Button>
        <Button size="sm" variant="outline" href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`}>
          Post on X
        </Button>
        <Button size="sm" variant="outline" href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`}>
          LinkedIn
        </Button>
      </div>
    </Panel>
  )
}
