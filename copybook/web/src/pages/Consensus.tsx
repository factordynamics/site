import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Donut, foldSlices, Legend, WeightBars } from '../components/charts'
import { AvatarStack, Monogram, Panel, Skeleton } from '../components/ui'
import { useTitle, shortName, loadIndex, loadSuperBook, money, pct, sectorMix, sectorOf, useAsync } from '../lib/data'

type Sort = 'holders' | 'value' | 'conviction'

export function Consensus() {
  const book = useAsync(async () => {
    const idx = await loadIndex()
    return loadSuperBook(idx.featured)
  }, [])
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>('holders')
  const [n, setN] = useState(50)
  const [open, setOpen] = useState<string | null>(null)

  const all = useMemo(() => book.data?.rows ?? [], [book.data])
  const mix = useMemo(() => foldSlices(sectorMix(all), 10), [all])
  useTitle('Consensus · Copybook')
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    const hits = s ? all.filter((r) => `${r.ticker ?? ''} ${r.issuer}`.toLowerCase().includes(s)) : all
    const out = [...hits]
    if (sort === 'value') out.sort((a, b) => b.value - a.value)
    else if (sort === 'conviction') out.sort((a, b) => b.avgWeight - a.avgWeight)
    return out
  }, [all, q, sort])
  const byValue = useMemo(() => [...all].sort((a, b) => b.value - a.value).slice(0, 10), [all])

  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Consensus</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Where great investors agree.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          One combined book built from the latest filings of the superinvestors we follow. Rank by how many own a stock, by combined dollars, or by how big a bet it is for the funds that hold it.
        </p>
      </header>

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <Panel title="Largest combined positions" sub="Share of the combined reported value">
          {book.data ? (
            <WeightBars accentFirst={3} valueLabel="both" items={byValue.map((r) => ({ key: r.key, label: r.ticker || shortName(r.issuer), isTicker: Boolean(r.ticker), sub: r.ticker ? r.issuer : undefined, value: r.value, weight: r.weight }))} />
          ) : (
            <Skeleton className="h-[360px] w-full" />
          )}
        </Panel>
        <Panel title="Sector mix" sub="Combined book, by reported value">
          {book.data ? (
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
              <Donut slices={mix} size={180} thickness={26} center={{ value: pct(mix[0]?.share ?? 0, 0), label: mix[0]?.name ?? '' }} />
              <Legend slices={mix} limit={10} cols={1} />
            </div>
          ) : (
            <Skeleton className="h-[360px] w-full" />
          )}
        </Panel>
      </div>

      <section className="mt-6 overflow-hidden rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 md:px-6">
          <div className="mr-auto">
            <h2 className="text-[15px] font-semibold">The full book</h2>
            <p className="text-[13px] text-ink-3">{book.data ? `${rows.length.toLocaleString('en-US')} stocks from the investors we follow` : 'Loading…'}</p>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Find a stock"
            placeholder="Find a stock, e.g. NVDA"
            className="h-9 w-full rounded-full bg-paper px-4 text-[14px] shadow-[0_0_0_1px_var(--color-line)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)] sm:w-60"
          />
          <div className="inline-flex rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Rank by">
            {([
              ['holders', 'Most held'],
              ['value', 'Most dollars'],
              ['conviction', 'Biggest bets'],
            ] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={sort === k} onClick={() => setSort(k)} className={`rounded-full px-3 py-1.5 ${sort === k ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                {l}
              </button>
            ))}
          </div>
        </header>
        <ol>
          {!book.data &&
            Array.from({ length: 8 }, (_, i) => (
              <li key={i} className="px-6 py-2">
                <Skeleton className="h-8 w-full" />
              </li>
            ))}
          {rows.slice(0, n).map((r, i) => (
            <li key={r.key} className="border-b border-line last:border-0">
              <button onClick={() => setOpen(open === r.key ? null : r.key)} aria-expanded={open === r.key} className="grid w-full grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3 text-left hover:bg-ink/[0.025] md:grid-cols-[2rem_minmax(0,1.4fr)_8rem_1fr_6rem_6rem] md:px-6">
                <span className="num text-[13px] text-ink-3">{i + 1}</span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    {r.ticker ? <span className="font-mono text-[12.5px] font-medium text-ink">{r.ticker}</span> : <span className="truncate text-[14px] font-medium text-ink">{r.issuer}</span>}
                    {r.put_call && <span className="rounded bg-ink/5 px-1 text-[11px] text-ink-2">{r.put_call}</span>}
                  </span>
                  {r.ticker && <span className="block truncate text-[13px] text-ink-3">{r.issuer}</span>}
                </span>
                <span className="hidden text-[13px] text-ink-2 md:block">{sectorOf(r.cusip, r.sector)}</span>
                <span className="hidden items-center gap-2 md:flex">
                  <AvatarStack names={r.holders} />
                  <span className="num text-[13px] text-ink-2">{r.holders.length} {r.holders.length === 1 ? 'investor' : 'investors'}</span>
                </span>
                <span className="num hidden text-right text-[13px] text-ink-2 md:block" title="Average weight in the portfolios that hold it">
                  {pct(r.avgWeight)} avg
                </span>
                <span className="num text-right text-[14px] font-medium">
                  <span className="md:hidden text-[12.5px] font-normal text-ink-3">{r.holders.length} · </span>
                  {money(r.value)}
                </span>
              </button>
              {open === r.key && (
                <div className="bg-paper-2/60 px-5 py-4 md:px-6 md:pl-[4.5rem]">
                  <p className="mb-3 text-[12.5px] text-ink-3">Held by, with weight in each portfolio</p>
                  <ul className="flex flex-wrap gap-2">
                    {r.holders.map((h) => (
                      <li key={h.slug}>
                        <Link to={`/investors/${h.slug}/`} className="inline-flex items-center gap-2 rounded-full bg-card py-1 pl-1 pr-3 text-[13px] shadow-[var(--shadow-card)] hover:shadow-[0_0_0_1px_var(--color-ink-3)]">
                          <Monogram name={h.name} size={22} />
                          {h.name}
                          <span className="num text-ink-3">{pct(h.weight)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ol>
        {rows.length > n && (
          <div className="flex items-center justify-between border-t border-line px-6 py-3 text-[13px] text-ink-3">
            <span>
              Showing {n} of {rows.length.toLocaleString('en-US')}
            </span>
            <button onClick={() => setN((x) => x + 100)} className="font-medium text-accent hover:text-accent-2">
              Show more
            </button>
          </div>
        )}
        {book.data && rows.length === 0 && <p className="px-6 py-8 text-[14px] text-ink-2">None of the investors we follow hold “{q}” in their latest filing.</p>}
      </section>
      <p className="mt-6 text-[13px] text-ink-3">Combined from each investor’s latest Form 13F-HR. Values are as reported at quarter end; each class of shares and each option is its own line, as filed.</p>
    </div>
  )
}
