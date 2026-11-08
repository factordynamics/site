import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Donut, foldSlices, Legend, Treemap, WeightBars } from '../components/charts'
import { mapPlan, treemapItems, useBook } from '../components/Portfolio'
import { SearchBox } from '../components/Search'
import { Arrow, AvatarStack, Button, Check, Monogram, Panel, Skeleton, Ticker } from '../components/ui'
import { useTitle, dateLabel, loadIndex, loadManager, loadSuperBook, money, pct, quarterLabel, sectorMix, useAsync, type Manager } from '../lib/data'

const DEMO = ['warren-buffett', 'bill-ackman', 'stanley-druckenmiller', 'david-tepper']

export function Home() {
  const idx = useAsync(loadIndex, [])
  useTitle('Copybook: see what the world’s best investors own')
  return (
    <>
      <Hero managers={idx.data?.managers} />
      <ProofStrip total={idx.data?.totalValue} filers={idx.data?.filerCount} updated={idx.data?.generated_at} />
      <ConsensusSection featured={idx.data?.featured} />
      <FeaturedSection featured={idx.data?.featured} />
      <HowSection />
      <CTABand />
    </>
  )
}

function Hero({ managers }: { managers?: Manager[] }) {
  const [slug, setSlug] = useState(DEMO[0])
  const demo = DEMO.map((s) => managers?.find((m) => m.slug === s)).filter(Boolean) as Manager[]
  return (
    <section className="relative overflow-hidden">
      <div className="grid-bg pointer-events-none absolute inset-0 -top-16" aria-hidden="true" />
      <div className="container-x relative pb-16 pt-10 md:pt-16">
        <div className="relative z-20 grid items-end gap-12 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rise max-w-3xl">
          <Link to="/investors/warren-buffett/" className="inline-flex items-center gap-2 rounded-full bg-card py-1 pl-1 pr-3 text-[13px] text-ink-2 shadow-[var(--shadow-card)] hover:text-ink">
            <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent-2">New</span>
            Q3 2026 13Fs are due Nov 16. See Berkshire’s latest book
            <Arrow />
          </Link>
          <h1 className="mt-6 text-[42px] font-semibold leading-[1.02] tracking-[-0.045em] sm:text-[54px] lg:text-[64px]">
            See what the world’s best investors own,{' '}
            <span className="font-serif font-normal italic tracking-[-0.025em] text-accent">straight from the filing.</span>
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-2 md:text-[18px]">
            Copybook turns SEC 13F filings into clear portfolios: top positions, sector mix and conviction, for the managers worth following.
          </p>
          <div className="mt-7 max-w-xl">
            <SearchBox size="lg" placeholder="Search an investor or a ticker" />
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3">
              Popular:
              {['warren-buffett', 'bill-ackman', 'seth-klarman', 'chris-hohn'].map((s) => {
                const m = managers?.find((x) => x.slug === s)
                return m ? (
                  <Link key={s} to={`/investors/${s}/`} className="font-medium text-ink-2 underline decoration-line-2 underline-offset-4 hover:text-ink hover:decoration-ink">
                    {m.manager}
                  </Link>
                ) : null
              })}
            </p>
          </div>
        </div>
        <LatestFilings managers={managers} />
        </div>

        <div className="rise mt-12 md:mt-14" style={{ animationDelay: '120ms' }}>
          <ProductFrame slug={slug} demo={demo} onPick={setSlug} />
        </div>
      </div>
    </section>
  )
}

function LatestFilings({ managers }: { managers?: Manager[] }) {
  const recent = (managers ?? [])
    .filter((m) => m.featured && m.filing_date)
    .sort((a, b) => (b.filing_date ?? '').localeCompare(a.filing_date ?? ''))
    .slice(0, 5)
  return (
    <aside className="rise hidden rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] xl:block" style={{ animationDelay: '60ms' }} aria-label="Latest filings">
      <div className="flex items-center justify-between">
        <p className="text-[14px] font-semibold">Latest filings</p>
        <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
          <span className="size-1.5 rounded-full bg-up" /> From SEC EDGAR
        </span>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {recent.length === 0 && Array.from({ length: 5 }, (_, i) => <li key={i} className="py-2.5"><Skeleton className="h-8 w-full" /></li>)}
        {recent.map((m) => (
          <li key={m.slug}>
            <Link to={`/investors/${m.slug}/`} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-ink/[0.035]">
              <Monogram name={m.manager} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{m.manager}</span>
                <span className="block truncate text-[12.5px] text-ink-3">
                  {quarterLabel(m.quarter)} 13F · filed {dateLabel(m.filing_date)}
                </span>
              </span>
              <span className="num text-[13px] font-medium">{money(m.total_value)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  )
}

function ProductFrame({ slug, demo, onPick }: { slug: string; demo: Manager[]; onPick: (s: string) => void }) {
  const m = useAsync(() => loadManager(slug), [slug])
  const book = useBook(m.data?.holdings)
  const f = m.data
  const plan = mapPlan(book.rows, 14)
  const slices = foldSlices(book.sectors, 6)
  return (
    <div className="overflow-hidden rounded-[18px] bg-card shadow-[var(--shadow-frame)]">
      <div className="flex items-center gap-3 border-b border-line bg-paper-2/70 px-4 py-2.5">
        <div className="hidden gap-1.5 sm:flex" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-ink/15" />
          <span className="size-2.5 rounded-full bg-ink/15" />
          <span className="size-2.5 rounded-full bg-ink/15" />
        </div>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [mask-image:linear-gradient(to_right,#000_85%,transparent)] [scrollbar-width:none] sm:[mask-image:none]" role="tablist" aria-label="Example portfolios">
          {demo.map((d) => (
            <button
              key={d.slug}
              role="tab"
              aria-selected={d.slug === slug}
              onClick={() => onPick(d.slug)}
              className={`shrink-0 rounded-lg px-3 py-1 text-[13px] transition-colors ${d.slug === slug ? 'bg-card font-medium text-ink shadow-[var(--shadow-card)]' : 'text-ink-3 hover:text-ink'}`}
            >
              <span className="sm:hidden">{d.manager.split(' ').slice(-1)[0]}</span>
              <span className="hidden sm:inline">{d.manager}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1.55fr_1fr]">
        <div className="border-b border-line p-5 md:p-7 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {f ? <Monogram name={f.manager} size={44} /> : <Skeleton className="size-11 rounded-full" />}
              <div>
                <p className="text-[17px] font-semibold tracking-[-0.02em]">{f?.manager ?? '\u00a0'}</p>
                <p className="text-[13px] text-ink-3">{f ? `${f.name} · ${quarterLabel(f.quarter)} 13F` : '\u00a0'}</p>
              </div>
            </div>
            <dl className="flex gap-7">
              <MiniStat label="Portfolio" value={f ? money(f.total_value) : '—'} />
              <MiniStat label="Positions" value={f ? book.rows.length.toLocaleString('en-US') : '—'} />
              <MiniStat label="Top 10" value={f ? pct(book.top10, 0) : '—'} />
            </dl>
          </div>
          <div className="mt-6">{f ? <Treemap items={treemapItems(book.rows, plan.n, 'rank', !plan.broad)} height={300} /> : <Skeleton className="h-[300px] w-full" />}</div>
        </div>
        <div className="p-5 md:p-7">
          <p className="text-[13px] font-medium text-ink-2">Sector mix</p>
          <div className="mt-4 flex items-center gap-6">
            {f ? <Donut slices={slices} size={132} thickness={20} center={{ value: slices[0] ? pct(slices[0].share, 0) : '', label: slices[0]?.name ?? '' }} /> : <Skeleton className="size-[132px] rounded-full" />}
            <div className="min-w-0 flex-1">{f && <Legend slices={slices} limit={6} cols={1} />}</div>
          </div>
          <p className="mt-7 text-[13px] font-medium text-ink-2">Largest positions</p>
          <div className="mt-3">
            {f ? (
              <WeightBars items={book.rows.slice(0, 5).map((h) => ({ key: h.key, label: h.ticker || h.issuer.split(' ').slice(0, 2).join(' '), isTicker: Boolean(h.ticker), sub: h.ticker ? h.issuer : undefined, value: h.value, weight: h.weight }))} />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </div>
          <Link to={`/investors/${slug}/`} className="mt-5 inline-flex items-center gap-1.5 text-[14px] font-medium text-accent hover:text-accent-2">
            Open full portfolio <Arrow />
          </Link>
        </div>
      </div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="num text-[17px] font-semibold tracking-[-0.02em]">{value}</dd>
    </div>
  )
}

function ProofStrip({ total, filers, updated }: { total?: number; filers?: number; updated?: string }) {
  const items = [
    { k: 'Source', v: 'SEC EDGAR Form 13F-HR' },
    { k: 'Holdings tracked', v: total ? `${money(total, 0)} disclosed` : '—' },
    { k: 'Directory', v: filers ? `Every 13F filer, ${filers.toLocaleString('en-US')} firms` : 'Every 13F filer' },
    { k: 'Last refresh', v: updated ? dateLabel(updated) : '—' },
  ]
  return (
    <section className="border-y border-line bg-card/60">
      <div className="container-x grid grid-cols-2 gap-6 py-7 md:grid-cols-4">
        {items.map((i) => (
          <div key={i.k}>
            <p className="text-[12.5px] text-ink-3">{i.k}</p>
            <p className="mt-1 text-[15px] font-medium tracking-[-0.01em]">{i.v}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function ConsensusSection({ featured }: { featured?: Manager[] }) {
  const book = useAsync(() => (featured ? loadSuperBook(featured) : Promise.resolve(null)), [featured?.length])
  const rows = book.data?.rows.slice(0, 8) ?? []
  const max = rows[0]?.holders.length ?? 1
  const mix = book.data ? foldSlices(sectorMix(book.data.rows), 8) : []
  return (
    <section className="container-x mt-24 md:mt-32">
      <div className="grid gap-12 lg:grid-cols-[0.9fr_1.4fr] lg:gap-16">
        <div>
          <p className="text-[13px] font-medium text-accent">Consensus</p>
          <h2 className="mt-3 text-[32px] font-semibold leading-[1.08] tracking-[-0.035em] md:text-h2">Where great investors agree.</h2>
          <p className="mt-4 text-[16px] leading-relaxed text-ink-2">
            The stocks owned by the most legendary value investors, hedge-fund founders and activists we follow, ranked by how many hold them.
          </p>
          <ul className="mt-6 space-y-2.5 text-[15px] text-ink-2">
            {['Weighted by what each fund actually filed', 'No price feeds, no estimates', 'One click to every holder'].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <Check className="text-accent" /> {t}
              </li>
            ))}
          </ul>
          {mix.length > 0 && (
            <div className="mt-8">
              <p className="mb-3 text-[13px] text-ink-3">Combined sector mix</p>
              <div className="flex items-center gap-5">
                <Donut slices={mix} size={112} thickness={16} center={{ value: pct(mix[0].share, 0), label: mix[0].name }} />
                <Legend slices={mix} limit={8} cols={1} />
              </div>
            </div>
          )}
          <Button to="/consensus/" variant="outline" className="mt-8">
            See the full consensus book <Arrow />
          </Button>
        </div>
        <Panel title="Most widely held" sub="Number of followed investors with a position, latest filings">
          {!book.data ? (
            <Skeleton className="h-[380px] w-full" />
          ) : (
            <ol className="divide-y divide-line">
              {rows.map((r, i) => (
                <li key={r.key} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 py-3 sm:grid-cols-[1.25rem_minmax(0,11rem)_1fr_auto]">
                  <span className="num text-[13px] text-ink-3">{i + 1}</span>
                  <div className="min-w-0">
                    {r.ticker ? <Ticker t={r.ticker} /> : <p className="truncate text-[14px] font-medium">{r.issuer}</p>}
                    {r.ticker && <p className="truncate text-[13px] text-ink-3">{r.issuer}</p>}
                  </div>
                  <div className="hidden h-2 rounded-full bg-ink/[0.05] sm:block">
                    <div className="h-2 rounded-full bg-accent" style={{ width: `${(r.holders.length / max) * 100}%`, opacity: 1 - i * 0.07, animationDelay: `${i * 40}ms` }} />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="hidden md:flex">
                      <AvatarStack names={r.holders} />
                    </span>
                    <span className="num w-[5.5rem] text-right text-[13px] font-medium">{r.holders.length} investors</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </section>
  )
}

function FeaturedSection({ featured }: { featured?: Manager[] }) {
  const list = (featured ?? []).slice(0, 9)
  return (
    <section className="container-x mt-24 md:mt-32">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-[13px] font-medium text-accent">Investors</p>
          <h2 className="mt-3 text-[32px] font-semibold leading-[1.08] tracking-[-0.035em] md:text-h2">Follow the managers you read about.</h2>
        </div>
        <Button to="/investors/" variant="ghost">
          Browse all investors <Arrow />
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {list.length === 0 && Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[188px] rounded-[var(--radius-card)]" />)}
        {list.map((m) => (
          <ManagerCard key={m.slug} m={m} />
        ))}
      </div>
    </section>
  )
}

export function ManagerCard({ m }: { m: Manager }) {
  const top = (m.top || []).slice(0, 3)
  const topW = top.reduce((s, h) => s + h.weight, 0)
  return (
    <Link to={`/investors/${m.slug}/`} className="group flex flex-col rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] transition-shadow hover:shadow-[0_0_0_1px_var(--color-line-2),0_12px_30px_-14px_rgb(12_14_19/0.25)]">
      <div className="flex items-center gap-3">
        <Monogram name={m.manager} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15.5px] font-semibold tracking-[-0.015em]">{m.manager}</p>
          <p className="truncate text-[13px] text-ink-3">{m.name !== m.manager ? m.name : `${(m.position_count ?? 0).toLocaleString('en-US')} positions`}</p>
        </div>
        <Arrow className="text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
      </div>
      <div className="mt-5 flex items-baseline justify-between">
        <span className="num text-[22px] font-semibold tracking-[-0.03em]">{money(m.total_value)}</span>
        <span className="text-[12.5px] text-ink-3">{quarterLabel(m.quarter)}</span>
      </div>
      <div className="mt-3 flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full bg-ink/[0.05]">
        {top.map((h, i) => (
          <div key={h.cusip + i} style={{ width: `${h.weight * 100}%`, background: ['#1d2f9c', '#3e5be6', '#8a9ff1'][i] }} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-ink-2">
        {top.map((h, i) => (
          <span key={h.cusip + i} className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: ['#1d2f9c', '#3e5be6', '#8a9ff1'][i] }} />
            {h.ticker ? <span className="font-mono text-[12px] text-ink">{h.ticker}</span> : <span className="max-w-[7rem] truncate text-ink">{h.issuer.split(' ').slice(0, 2).join(' ')}</span>}
            <span className="num">{pct(h.weight, 0)}</span>
          </span>
        ))}
        {top.length > 0 && <span className="text-ink-3">· top 3 = {pct(topW, 0)}</span>}
      </div>
    </Link>
  )
}

function HowSection() {
  const items = [
    {
      t: 'Read a portfolio in seconds',
      d: 'Treemaps, sector mix and concentration replace the CUSIP dump. See what matters to a manager before you scroll.',
      v: <MiniTreemapArt />,
    },
    {
      t: 'Straight from SEC EDGAR',
      d: 'Every number is the value the fund reported in its 13F-HR, linked to the original filing. Nothing is estimated or re-priced.',
      v: <FilingArt />,
    },
    {
      t: 'Know what changed',
      d: 'New buys, exits and size changes quarter over quarter, with an email the moment a fund you follow files. Included with Copy.',
      v: <ChangeArt />,
    },
  ]
  return (
    <section className="container-x mt-24 md:mt-32">
      <div className="mb-10 max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Why Copybook</p>
        <h2 className="mt-3 text-[32px] font-semibold leading-[1.08] tracking-[-0.035em] md:text-h2">The filing, made readable.</h2>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {items.map((i) => (
          <div key={i.t} className="flex flex-col rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
            <div className="flex h-36 items-center justify-center rounded-xl bg-paper-2">{i.v}</div>
            <h3 className="mt-6 text-[17px] font-semibold tracking-[-0.02em]">{i.t}</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">{i.d}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function MiniTreemapArt() {
  return (
    <svg width="200" height="104" viewBox="0 0 200 104" aria-hidden="true">
      <rect x="0" y="0" width="92" height="104" rx="6" fill="#1d2f9c" />
      <rect x="95" y="0" width="60" height="62" rx="6" fill="#2b44d6" />
      <rect x="158" y="0" width="42" height="62" rx="6" fill="#5873ea" />
      <rect x="95" y="65" width="40" height="39" rx="6" fill="#8a9ff1" />
      <rect x="138" y="65" width="32" height="39" rx="6" fill="#a1b2f3" />
      <rect x="173" y="65" width="27" height="39" rx="6" fill="#c9c4b8" />
      <text x="10" y="22" fill="#fff" fontSize="13" fontFamily="Geist Mono Variable, monospace" fontWeight="600">AAPL</text>
      <text x="10" y="38" fill="#fff" fillOpacity=".8" fontSize="11" fontFamily="Geist Variable, sans-serif">22.0%</text>
    </svg>
  )
}

function FilingArt() {
  return (
    <div className="w-[210px] rounded-lg bg-card p-3 text-[11px] shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <span className="font-mono font-medium">13F-HR</span>
        <span className="rounded bg-up/10 px-1.5 text-up">Filed</span>
      </div>
      {[['AAPL', '65.95B'], ['AXP', '51.28B'], ['KO', '28.00B']].map(([t, v]) => (
        <div key={t} className="mt-1.5 flex justify-between border-t border-line pt-1.5">
          <span className="font-mono">{t}</span>
          <span className="num text-ink-2">${v}</span>
        </div>
      ))}
    </div>
  )
}

function ChangeArt() {
  const rows: [string, number][] = [['OXY', 0.8], ['CB', 0.55], ['AAPL', -0.7], ['BAC', -0.45]]
  return (
    <div className="w-[210px] space-y-2">
      {rows.map(([t, d]) => (
        <div key={t} className="grid grid-cols-[2.5rem_1fr_1fr] items-center gap-1 text-[11px]">
          <span className="font-mono">{t}</span>
          <div className="flex justify-end">{d < 0 && <div className="h-2 rounded-l-full bg-down/80" style={{ width: `${-d * 100}%` }} />}</div>
          <div className="flex border-l border-line-2">{d > 0 && <div className="h-2 rounded-r-full bg-up/80" style={{ width: `${d * 100}%` }} />}</div>
        </div>
      ))}
    </div>
  )
}

function CTABand() {
  return (
    <section className="container-x mt-24 md:mt-32">
      <div className="relative overflow-hidden rounded-[22px] bg-night px-6 py-14 text-white md:px-14 md:py-16">
        <div className="pointer-events-none absolute -right-24 -top-24 size-[420px] rounded-full bg-accent/30 blur-[100px]" aria-hidden="true" />
        <div className="relative grid items-center gap-10 md:grid-cols-[1.4fr_1fr]">
          <div>
            <h2 className="text-[32px] font-semibold leading-[1.08] tracking-[-0.035em] md:text-[44px]">
              Be first to see <span className="font-serif font-normal italic text-[#9fb0ff]">every new filing.</span>
            </h2>
            <p className="mt-4 max-w-lg text-[16px] leading-relaxed text-white/70">
              Copy adds quarter-over-quarter changes, 8 quarters of 13F history with CSV export, and an email minutes after a fund you follow files.
            </p>
          </div>
          <div className="flex flex-col items-start gap-3 md:items-end">
            <Button to="/pricing/" size="lg" className="w-full md:w-auto">
              Get Copy for $9/month
            </Button>
            <p className="text-[13px] text-white/60">Or $79 a year. The latest quarter stays free.</p>
          </div>
        </div>
      </div>
    </section>
  )
}
