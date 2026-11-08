import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { loadManager, pct, quarterLabel, useAsync, type Holding, type ManagerFile } from '../lib/data'
import { setFollow, useFollows } from '../lib/follows'
import { loadStockIndex, stockPath, tickerText } from '../lib/stocks'
import { useSearch } from './Search'
import { Badge, Monogram, Panel, Skeleton } from './ui'

// Peer overlap (Copy Pro and Fund): the funds a member benchmarks against, stored in follows.peers,
// compared on their latest 13F books. Equity positions only; options and exited rows are left out.
const MAX = 12
const live = (h: Holding) => h.shares > 0 && !h.put_call
// The CUSIP's first six characters name the issuer, so share classes (GOOG, GOOGL) count as one stock.
const issuer = (h: Holding) => h.cusip.slice(0, 6)

export function Peers({ names, shared }: { names: string[]; shared?: boolean }) {
  const { follows, pending } = useFollows()
  const peers = follows.peers
  const files = useAsync(() => Promise.all(peers.map((s) => loadManager(s).catch(() => null))), [peers.join(',')])
  const books = useMemo(() => (files.data ?? []).filter((f): f is ManagerFile => f !== null), [files.data])
  const idx = useAsync(loadStockIndex, [])
  // Your tickers plus their other share classes from the stock index (BRK.B also matches BRK.A).
  const mine = useMemo(() => {
    const set = new Set(names.map(tickerText))
    for (const s of idx.data?.stocks ?? []) if (set.has(s.t) || s.a.some((a) => set.has(a))) [s.t, ...s.a].forEach((t) => set.add(t))
    return set
  }, [names, idx.data])
  const count = names.length

  // Σ min(weight) over shared positions: the share of each book the two have in common.
  const matrix = useMemo(() => {
    const w = books.map((b) => {
      const m = new Map<string, number>()
      for (const h of b.holdings) if (live(h)) m.set(issuer(h), (m.get(issuer(h)) ?? 0) + h.weight)
      return m
    })
    return w.map((a) => w.map((b) => (a === b ? null : [...a].reduce((s, [k, x]) => s + Math.min(x, b.get(k) ?? 0), 0))))
  }, [books])
  const top = Math.max(0.0001, ...matrix.flat().map((x) => x ?? 0))

  const inMine = useMemo(
    () =>
      books.map((b) => {
        const hs = b.holdings.filter((h) => h.ticker && mine.has(tickerText(h.ticker)) && !h.put_call)
        const held = hs.filter((h) => h.shares > 0)
        return {
          b,
          held: held.sort((x, y) => y.weight - x.weight),
          weight: held.reduce((s, h) => s + h.weight, 0),
          adding: held.filter((h) => h.change === 'new' || h.change === 'added'),
          trimming: held.filter((h) => h.change === 'trimmed'),
          exited: hs.filter((h) => h.change === 'exited'),
        }
      }),
    [books, mine],
  )

  const sharedNames = useMemo(() => {
    const m = new Map<string, { h: Holding; n: number; w: number; by: Set<string> }>()
    for (const b of books)
      for (const h of b.holdings)
        if (live(h)) {
          const x = m.get(issuer(h)) ?? { h, n: 0, w: 0, by: new Set<string>() }
          if (!x.by.has(b.slug)) x.n += 1
          x.by.add(b.slug)
          x.w += h.weight
          m.set(issuer(h), x)
        }
    return [...m.values()].filter((x) => x.n >= 2).sort((a, b) => b.n - a.n || b.w - a.w).slice(0, 15)
  }, [books])

  const failed = Object.entries(pending).flatMap(([k, v]) => (k.startsWith('peers:') && v.state === 'error' ? [{ slug: k.slice(6), want: v.want }] : []))

  return (
    <section className="mt-10" aria-labelledby="peers-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id="peers-title" className="flex items-center gap-2 text-[22px] font-semibold tracking-[-0.02em]">
            Peer overlap
            {shared && <Badge tone="accent">Shared with your team</Badge>}
          </h2>
          <p className="mt-1 text-[14px] text-ink-2">Pick up to {MAX} funds you benchmark against. See how much of their books they share, the names they hold in common, and what they did in yours.</p>
        </div>
      </div>

      <div className="mt-4 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:p-6">
        <PeerPicker peers={peers} names={new Map(books.map((b) => [b.slug, b.manager]))} />
        {failed.length > 0 && (
          <p className="mt-3 text-[13px] text-down" role="alert">
            {failed.length === 1 ? 'That change' : `${failed.length} changes`} didn’t save.{' '}
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => failed.forEach((f) => setFollow('peers', f.slug, f.want).catch(() => null))}>
              Retry
            </button>
          </p>
        )}
      </div>

      {peers.length > 0 && !files.data && <Skeleton className="mt-5 h-64 w-full" />}

      {books.length > 0 && (
        <>
          <Panel className="mt-5" title="What your peers did in your names" sub="From each fund’s latest 13F; the quarter is on each row">
            {count === 0 ? (
              <p className="text-[14px] text-ink-2">Add the stocks you own or watch above to see which peers hold them.</p>
            ) : (
              <div className="-mx-5 overflow-x-auto md:-mx-6" tabIndex={0} role="region" aria-label="Your names in your peers’ books">
                <table className="w-full min-w-[720px] text-[13.5px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                      <th className="px-5 py-2.5 font-medium md:px-6">Fund</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">Your names held</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">Share of their book</th>
                      <th className="px-3 py-2.5 font-medium">Largest of yours</th>
                      <th className="px-5 py-2.5 font-medium md:px-6">This quarter</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {inMine
                      .sort((a, b) => b.weight - a.weight)
                      .map(({ b, held, weight, adding, trimming, exited }) => (
                        <tr key={b.slug} className="align-top">
                          <td className="px-5 py-3 md:px-6">
                            <Link to={`/investors/${b.slug}/`} className="flex items-center gap-2 font-medium hover:text-accent">
                              <Monogram name={b.manager} size={24} />
                              <span className="truncate">{b.manager}</span>
                            </Link>
                            {b.quarter && <span className="ml-8 block text-[12px] text-ink-3">{quarterLabel(b.quarter)}</span>}
                          </td>
                          <td className="num px-3 py-3 text-right">
                            {new Set(held.map(issuer)).size} <span className="text-ink-3">of {count}</span>
                          </td>
                          <td className="num px-3 py-3 text-right">{held.length ? pct(weight) : <span className="text-ink-3">0%</span>}</td>
                          <td className="px-3 py-3">
                            {held.length ? (
                              <span className="flex flex-wrap gap-x-3 gap-y-1">
                                {held.slice(0, 4).map((h) => (
                                  <Link key={h.cusip} to={stockPath(h.ticker!)} className="whitespace-nowrap hover:text-accent">
                                    <span className="font-mono text-[12.5px] font-semibold">{h.ticker}</span> <span className="num text-ink-3">{pct(h.weight)}</span>
                                  </Link>
                                ))}
                              </span>
                            ) : (
                              <span className="text-ink-3">None</span>
                            )}
                          </td>
                          <td className="px-5 py-3 text-[13px] md:px-6">
                            {b.prev_quarter === undefined && b.filer ? (
                              <span className="text-ink-3">Changes show once two quarters are on file</span>
                            ) : adding.length + trimming.length + exited.length === 0 ? (
                              <span className="text-ink-3">No change in your names</span>
                            ) : (
                              <span className="flex flex-col gap-0.5">
                                {adding.length > 0 && <Moves label="Bought" tone="text-up" hs={adding} />}
                                {trimming.length > 0 && <Moves label="Trimmed" tone="text-down" hs={trimming} />}
                                {exited.length > 0 && <Moves label="Exited" tone="text-down" hs={exited} />}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <Panel title="Book overlap" sub="Share of the two books in the same stocks, at the smaller weight in each">
              {books.length < 2 ? (
                <p className="text-[14px] text-ink-2">Add a second peer to compare their books.</p>
              ) : (
                <div className="-mx-1 overflow-x-auto" tabIndex={0} role="region" aria-label="Book overlap between peers">
                  <table className="text-[12.5px]">
                    <thead>
                      <tr>
                        <th />
                        {books.map((b, j) => (
                          <th key={b.slug} scope="col" className="px-1 pb-2 font-medium text-ink-3" title={b.manager}>
                            <span className="sr-only">{b.manager}</span>
                            <span aria-hidden="true" className="inline-flex size-6 items-center justify-center rounded-full bg-paper num">
                              {j + 1}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {books.map((b, i) => (
                        <tr key={b.slug}>
                          <th scope="row" className="max-w-[120px] truncate py-0.5 pr-2 text-left font-normal text-ink-2 sm:max-w-[200px] sm:pr-3">
                            <span className="num mr-2 text-ink-3">{i + 1}</span>
                            {b.manager}
                          </th>
                          {matrix[i].map((x, j) => (
                            <td key={j} className="p-0.5">
                              <span
                                className={`num flex h-8 w-10 items-center justify-center rounded-md sm:w-12 ${x === null ? 'text-ink-3' : (x ?? 0) / top > 0.55 ? 'font-medium text-white' : 'text-ink'}`}
                                style={{ background: x === null ? 'var(--color-paper)' : `color-mix(in oklab, var(--color-accent) ${Math.round(8 + ((x ?? 0) / top) * 80)}%, var(--color-card))` }}
                                title={x === null ? undefined : `${b.manager} and ${books[j].manager}: ${pct(x)}`}
                              >
                                {x === null ? '—' : x > 0 && x < 0.0005 ? '<0.1%' : pct(x)}
                              </span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel title="Names they share" sub={books.length < 2 ? undefined : `Held by two or more of your ${books.length} peers`}>
              {books.length < 2 ? (
                <p className="text-[14px] text-ink-2">Add a second peer to see the names they hold in common.</p>
              ) : sharedNames.length === 0 ? (
                <p className="text-[14px] text-ink-2">Your peers hold no stocks in common.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {sharedNames.map(({ h, n, w }) => (
                    <li key={h.cusip} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
                      <span className="flex min-w-0 items-center gap-2">
                        {h.ticker ? (
                          <Link to={stockPath(h.ticker)} className="font-mono text-[13px] font-semibold hover:text-accent">
                            {h.ticker}
                          </Link>
                        ) : null}
                        <span className="truncate text-ink-2">{h.display_name ?? h.issuer}</span>
                        {h.ticker && mine.has(tickerText(h.ticker)) && <Badge tone="accent">Yours</Badge>}
                      </span>
                      <span className="num shrink-0 text-ink-2">
                        {n} of {books.length} <span className="text-ink-3">· avg {pct(w / n)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </section>
  )
}

function Moves({ label, tone, hs }: { label: string; tone: string; hs: Holding[] }) {
  return (
    <span>
      <span className={`font-medium ${tone}`}>{label}</span> {hs.map((h, i) => (
        <span key={h.cusip}>
          {i > 0 && ', '}
          <span className="font-mono text-[12.5px]">{h.ticker}</span>
        </span>
      ))}
    </span>
  )
}

function PeerPicker({ peers, names }: { peers: string[]; names: Map<string, string> }) {
  const [q, setQ] = useState('')
  const hits = useSearch(q)
    .flatMap((h) => (h.kind === 'manager' ? [{ slug: h.m.slug, name: h.m.manager }] : h.kind === 'filer' ? [{ slug: h.f.slug, name: h.f.name }] : []))
    .filter((h) => !peers.includes(h.slug))
    .slice(0, 6)
  const full = peers.length >= MAX
  const add = (slug: string) => {
    setQ('')
    setFollow('peers', slug, true).catch(() => null)
  }
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {peers.map((s) => (
          <span key={s} className="inline-flex items-center gap-2 rounded-full bg-paper py-1 pl-1 pr-1.5 text-[13px] shadow-[0_0_0_1px_var(--color-line)]">
            <Monogram name={names.get(s) ?? s} size={22} />
            <Link to={`/investors/${s}/`} className="hover:text-accent">
              {names.get(s) ?? s}
            </Link>
            <button type="button" aria-label={`Remove ${names.get(s) ?? s}`} onClick={() => setFollow('peers', s, false).catch(() => null)} className="inline-flex size-5 items-center justify-center rounded-full text-ink-3 hover:bg-line hover:text-ink">
              <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M2 2l6 6M8 2 2 8" />
              </svg>
            </button>
          </span>
        ))}
        {peers.length === 0 && <span className="text-[14px] text-ink-2">No peers yet. Search for a fund to add it.</span>}
      </div>
      <div className="relative mt-3 max-w-md">
        <label htmlFor="peer-search" className="sr-only">
          Add a peer fund
        </label>
        <input
          id="peer-search"
          value={q}
          disabled={full}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) add(hits[0].slug)
            if (e.key === 'Escape') setQ('')
          }}
          placeholder={full ? `${MAX} peers is the limit; remove one to add another` : 'Add a fund: Pershing Square, Situational Awareness…'}
          autoComplete="off"
          className="h-10 w-full rounded-full bg-paper px-4 text-[14px] shadow-[0_0_0_1px_var(--color-line)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)] disabled:opacity-60"
        />
        {q && hits.length > 0 && (
          <ul className="absolute inset-x-0 top-12 z-20 overflow-hidden rounded-[14px] bg-card py-1 shadow-[var(--shadow-pop,0_12px_32px_rgba(0,0,0,0.12))]" role="listbox" aria-label="Funds">
            {hits.map((h) => (
              <li key={h.slug} role="option" aria-selected="false">
                <button type="button" onClick={() => add(h.slug)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] hover:bg-paper">
                  <Monogram name={h.name} size={22} />
                  <span className="truncate">{h.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
