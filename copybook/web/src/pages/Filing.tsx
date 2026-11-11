import { getToken } from '../lib/account'
import { track, useTrackVisit } from '../lib/track'
import { possessive } from '../lib/names.mjs'
import { FollowSignup } from '../components/FollowSignup'
import { useEffect, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { FollowButton } from '../components/FollowButton'
import { Share } from '../components/Share'
import { Signup } from '../components/Signup'
import { Arrow, Badge, Button, Monogram, Panel, Skeleton } from '../components/ui'
import { buildCard, cardSvg, type FilingCard as FilingCardData } from '../lib/filingCard.mjs'
import { BASE, DATA, dateLabel, pricingTo, getJSON, loadManager, money, quarterLabel, sharesFmt, useAsync, useTitle } from '../lib/data'
import { useFollows } from '../lib/follows'
import { loadStockIndex, stockPath, tickerText } from '../lib/stocks'

// A public card for one 13F (scripts/cards.mjs): the top five moves, made to be shared. Free, no account.
type Card = FilingCardData

// A 13F newer than the last site build has no static card yet (a build takes 30–40 min after
// acceptance; ingest publishes the fund's book in 15–25). 404.html then renders this page, and the card is
// built here from gust's runtime index.json and {slug}.json with the same code as the build's.
async function loadCard(accession: string): Promise<{ card: Card; live: boolean }> {
  const card = await getJSON<Card>(`${BASE}d/f/${encodeURIComponent(accession)}.json`).catch(() => null)
  if (card) return { card, live: false }
  // Revalidate, so a reader who arrives minutes after the filing doesn't get the copy cached before it.
  const fresh = async <T,>(url: string) => {
    const r = await fetch(url, { cache: 'no-cache' })
    if (!r.ok) throw new Error(`${r.status} ${url}`)
    return (await r.json()) as T
  }
  const idx = await fresh<{ managers: { slug: string; accession?: string; filing_accessions?: string[] }[] }>(`${DATA}index.json`)
  // Every filing behind the fund's latest book (original, amendments, superseded), so an amendment's URL resolves too.
  const m = idx.managers.find((m) => m.filing_accessions?.includes(accession)) ?? idx.managers.find((m) => m.accession === accession)
  if (!m) throw new Error(`no card for ${accession}`)
  // index.json and {slug}.json ship in one deploy, but the CDN can serve the old book for a minute: retry once.
  let built = buildCard(await fresh(`${DATA}${m.slug}.json`))
  const same = (b: Card | null) => Boolean(b && (b.accession === accession || m.filing_accessions?.includes(b.accession)))
  if (!same(built)) built = await new Promise((r) => setTimeout(r, 4000)).then(async () => buildCard(await fresh(`${DATA}${m.slug}.json?r=${Date.now()}`)))
  if (!built || !same(built)) throw new Error(`no card for ${accession}`)
  return { card: built, live: true }
}

export const cardPath = (accession: string) => `/f/${accession}/`
export const cardUrl = (accession: string) => `${window.location.origin}${BASE}f/${accession}/`

export function FilingCard() {
  const { accession = '' } = useParams()
  useTrackVisit()
  const c = useAsync(() => loadCard(accession), [accession])
  const d = c.data?.card
  // Signed-in members: tag the names they own or watch, and list their other names this 13F moved.
  // Client-side only; the static page and its share tags stay the same for everyone.
  const { follows } = useFollows()
  // Share classes count as one name, as in My book: watching GOOGL tags GOOG too (BRK.A/B, LEN/LEN.B).
  const idx = useAsync(() => (follows.stocks.length || follows.owned.length ? loadStockIndex() : Promise.resolve(null)), [follows.stocks.length + follows.owned.length > 0])
  const tag = useMemo(() => {
    const classes = new Map<string, string[]>()
    for (const st of idx.data?.stocks ?? []) for (const t of [st.t, ...st.a]) classes.set(t, [st.t, ...st.a])
    const m = new Map<string, 'Owned' | 'Watched'>()
    const put = (t: string, v: 'Owned' | 'Watched') => (classes.get(tickerText(t)) ?? [tickerText(t)]).forEach((x) => m.set(x, v))
    for (const t of follows.stocks) put(t, 'Watched')
    for (const t of follows.owned) put(t, 'Owned')
    return m
  }, [follows.owned, follows.stocks, idx.data])
  const book = useAsync(() => (d && tag.size ? loadManager(d.slug).catch(() => null) : Promise.resolve(null)), [d?.slug, tag.size > 0])
  const yours = useMemo(() => {
    const f = book.data
    if (!d || !f || f.quarter !== d.quarter) return []
    const top = new Set(d.moves.map((m) => m.ticker && tickerText(m.ticker)))
    return f.holdings
      .filter((h) => h.ticker && !h.put_call && tag.has(tickerText(h.ticker)) && !top.has(tickerText(h.ticker)) && h.change && h.change !== 'unchanged')
      .map((h) => ({ h, delta: (h as { value_delta?: number }).value_delta ?? (h.shares ? (h.shares - (h.prev_shares ?? 0)) * (h.value / h.shares) : -(h.prev_value ?? 0)) }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  }, [book.data, d, tag])
  useTitle(d ? `${possessive(d.manager)} ${quarterLabel(d.quarter)} 13F: top moves · Copybook` : undefined)
  // A just-filed card is served by 404.html with the site's generic tags. Link crawlers don't run
  // scripts, so this helps only readers and search engines; the build writes the real tags and image.
  useEffect(() => {
    if (!d || !c.data?.live) return
    const title = `${possessive(d.manager)} ${quarterLabel(d.quarter)} 13F: top moves · Copybook`
    const desc = `${d.manager} filed a ${quarterLabel(d.quarter)} 13F on ${dateLabel(d.filing_date)}: bought ${money(d.bought_usd)}, sold ${money(d.sold_usd)}, from the SEC filing.`
    const set = (sel: string, v: string) => document.head.querySelector(sel)?.setAttribute('content', v)
    for (const sel of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) set(sel, title)
    for (const sel of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) set(sel, desc)
  }, [d, c.data?.live])

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

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
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
                        {m.ticker && tag.get(tickerText(m.ticker)) && (
                          <Badge tone={tag.get(tickerText(m.ticker)) === 'Owned' ? 'accent' : 'neutral'} className="ml-2 whitespace-nowrap align-[1px]">
                            {tag.get(tickerText(m.ticker))}
                          </Badge>
                        )}
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

              {yours.length > 0 && (
                <section className="mt-5 rounded-xl bg-paper px-4 py-3.5" aria-labelledby="yours-title">
                  <h2 id="yours-title" className="text-[13px] font-medium text-ink-3">
                    Also in your names
                  </h2>
                  <ul className="mt-2 grid gap-x-8 gap-y-2 sm:grid-cols-2">
                    {yours.slice(0, 8).map(({ h, delta }) => {
                      const t = tag.get(tickerText(h.ticker!))
                      return (
                        <li key={h.cusip} className="flex items-center gap-2 text-[13.5px]">
                          <Link to={stockPath(h.ticker!)} className="w-12 shrink-0 font-mono font-semibold hover:text-accent">
                            {h.ticker}
                          </Link>
                          <span className="min-w-0 flex-1 truncate text-ink-2">{h.change === 'new' ? 'New' : h.change![0].toUpperCase() + h.change!.slice(1)}</span>
                          <span className={`num w-[4.75rem] shrink-0 text-right font-medium ${delta >= 0 ? 'text-up' : 'text-down'}`}>
                            {delta >= 0 ? '+' : '−'}
                            {money(Math.abs(delta))}
                          </span>
                          <Badge tone={t === 'Owned' ? 'accent' : 'neutral'} className="w-[4.5rem] justify-center">
                            {t}
                          </Badge>
                        </li>
                      )
                    })}
                  </ul>
                  {yours.length > 8 && (
                    <Link to={`/investors/${d.slug}/`} className="mt-2 inline-block text-[13px] text-accent hover:text-accent-2">
                      {yours.length - 8} more of your names on {possessive(d.manager)} page
                    </Link>
                  )}
                </section>
              )}

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
          {d && <ShareCard d={d} live={c.data!.live} />}
          {d && (
            <Panel title={getToken() ? `Get ${possessive(d.manager)} next 13F by email` : `Get ${possessive(d.manager)} moves in Friday’s free email`}>
              {getToken() ? (
                <p className="text-[14px] leading-relaxed text-ink-2">Follow with Copy and the next filing lands in your inbox, checked on EDGAR every minute, with every new, added, trimmed and exited position inside.</p>
              ) : (
                <>
                  <FollowSignup people={[{ slug: d.slug, name: d.manager }]} />
                  <p className="mt-4 border-t border-line pt-4 text-[13.5px] leading-relaxed text-ink-2">Want each 13F by email as it’s filed? That’s Copy. We check EDGAR every minute.</p>
                  <Button to={pricingTo()} onClick={() => track('trial_click')} className="mt-3">
                    Start 14-day free trial <Arrow />
                  </Button>
                  <p className="mt-1.5 text-[12px] text-ink-3">Card required · charged on day 15 unless you cancel</p>
                </>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                {getToken() && <FollowButton kind="investor" id={d.slug} name={d.manager} size="md" />}
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

function ShareCard({ d, live }: { d: Card; live: boolean }) {
  const url = cardUrl(d.accession)
  const top = d.moves
    .slice(0, 3)
    .map((m) => `${m.change === 'new' ? 'New' : m.change[0].toUpperCase() + m.change.slice(1)} ${m.ticker ? `$${m.ticker}` : m.name} ${m.value_delta >= 0 ? '+' : '−'}${money(Math.abs(m.value_delta))}`)
    .join('\n')
  const text = `${possessive(d.manager)} ${quarterLabel(d.quarter)} 13F is out:\n${top}`
  return (
    <Panel
      title="Share this filing"
      sub={live ? 'Just filed. X, LinkedIn and Slack show this image once the page is published, within about 40 minutes of the filing' : 'The card image is attached automatically on X, LinkedIn, Slack and iMessage'}
    >
      {live ? (
        // Escaped by cardSvg; drawn with the page's own Geist faces until the build's PNG exists.
        <div
          role="img"
          aria-label={`${possessive(d.manager)} ${quarterLabel(d.quarter)} 13F card: top moves`}
          className="overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--color-line)] [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: cardSvg(d, 'Geist Variable', 'Geist Mono Variable') }}
        />
      ) : (
        <img src={`${BASE}og/f/${d.accession}.png`} alt={`${possessive(d.manager)} ${quarterLabel(d.quarter)} 13F card: top moves`} width={1200} height={630} className="w-full rounded-xl shadow-[0_0_0_1px_var(--color-line)]" />
      )}
      <Share className="mt-4" url={url} text={text} linkedin />
    </Panel>
  )
}
