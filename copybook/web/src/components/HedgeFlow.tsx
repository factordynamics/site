import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { DATA, dateLabel, getJSON, money, typesAsOfLabel, useAsync } from '../lib/data'
import { stockPath } from '../lib/stocks'
import { Badge, Panel, Skeleton } from './ui'

// The hedge-fund view on /season/ and Flow, from ingest's data/hedge_flow.json: every 13F filer typed
// hedge_fund (filer_types.json), per report period, counting only funds that filed the period and the one
// before. Ranked by how many funds moved (breadth, holder change), with dollars second, because on dollars
// alone the list is just MSFT, AMZN and NVDA.
//
// Dark until ingest adds `basis` (what $ means). Fields (ingest, Nov 11): top level types_as_of, types_sig,
// newest_filing, basis; per period filed_value_share and largest_unfiled; per stock etf, acquired_delisted,
// excluded_lines, top_buyers, top_sellers, top_buyer_share, top_seller_share.

/** A fund in top_buyers / top_sellers / largest_unfiled (slug: its /investors/ page, or null). */
type Fund = { name: string; cik?: string | number; slug?: string | null; accession?: string; usd?: number; prev_value?: number }
type Raw = Record<string, unknown> & {
  ticker: string
  name: string
  buyers: number
  sellers: number
  breadth: number
  new_count: number
  exited_count: number
  holders: number
  holders_prev: number
  holder_change: number
  bought_usd: number
  sold_usd: number
  net_usd: number
  gross_usd: number
  filed_of_prev_holders?: [number, number]
}
type RawPeriod = Record<string, unknown> & { quarter: string; prev_quarter: string; funds_filed: number; funds_total: number; stocks: Record<string, Raw> }
type HedgeFile = Record<string, unknown> & { generated_at: string; types_sig?: string; types_as_of?: string | null; basis?: string; periods: RawPeriod[] }

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const funds = (x: unknown): Fund[] => (Array.isArray(x) ? (x as Fund[]) : [])

/** One stock row, with ingest's new fields read in one place. */
function hf(r: Raw) {
  const [filed, prev] = r.filed_of_prev_holders ?? [0, 0]
  return {
    ...r,
    filed,
    prev,
    early: prev > 0 && filed / prev < 0.5,
    etf: Boolean(r.etf),
    delisted: Boolean(r.acquired_delisted),
    topBuyShare: num(r.top_buyer_share),
    topSellShare: num(r.top_seller_share),
    topBuyers: funds(r.top_buyers),
    topSellers: funds(r.top_sellers),
    excluded: num(r.excluded_lines),
  }
}
type Row = ReturnType<typeof hf>

export const loadHedgeFlow = () => getJSON<HedgeFile>(`${DATA}hedge_flow.json?v=${Math.floor(Date.now() / 120_000)}`)

type Sort = 'breadth' | 'holders' | 'usd'
const SORTS: [Sort, string][] = [
  ['breadth', 'Most funds buying'],
  ['holders', 'Holders gained'],
  ['usd', 'Net $'],
]

const filingHref = (f: { cik?: string | number; accession?: string }) => (f.cik && f.accession ? `https://www.sec.gov/Archives/edgar/data/${Number(f.cik)}/${f.accession.replace(/-/g, '')}/` : null)
const et = (t: string) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'
const pctLabel = (x: number) => `${Math.round(x * 100)}%`

export function HedgeFlow({ quarter, typesAsOf, rows: limit = 25, id, className = '' }: { quarter?: string; typesAsOf?: string | null; rows?: number; id?: string; className?: string }) {
  const f = useAsync(() => loadHedgeFlow().catch(() => null), [])
  const [sort, setSort] = useState<Sort>('breadth')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [etfs, setEtfs] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const d = f.data
  const p = d?.periods.find((x) => x.quarter === quarter) ?? d?.periods[0]
  const all = useMemo(() => (p ? Object.values(p.stocks).map(hf) : []), [p])
  const rows = useMemo(() => {
    const sign = side === 'buy' ? 1 : -1
    const key = (r: Row) => (sort === 'breadth' ? r.breadth : sort === 'holders' ? r.holder_change : r.net_usd)
    // Tie-break by the other count, then by dollars moved.
    const tie = (r: Row) => (sort === 'breadth' ? r.holder_change : r.breadth)
    return all
      .filter((r) => etfs || !r.etf)
      // An acquired or delisted stock "sells" to zero: kept out of the sell rankings, shown in the buy side with its label.
      .filter((r) => side === 'buy' || !r.delisted)
      .filter((r) => sign * key(r) > 0)
      .sort((a, b) => sign * (key(b) - key(a)) || sign * (tie(b) - tie(a)) || b.gross_usd - a.gross_usd)
      .slice(0, limit)
  }, [all, sort, side, etfs, limit])

  if (f.loading) return <Skeleton className="h-64 w-full" />
  // Dark until ingest's new fields land: `basis` defines $ on the page, which the view must show.
  if (!d || !p || typeof d.basis !== 'string') return null

  const cover = num(p.filed_value_share)
  const notYet = funds(p.largest_unfiled).slice(0, 10)
  const newest = d.newest_filing as { manager?: string; slug?: string | null; cik?: string | number; accession?: string; accepted_at?: string } | undefined
  // Don't hide on a type-set mismatch: show the file with an amber note saying which types it used.
  const mismatch = Boolean(typesAsOf && d.types_as_of && d.types_as_of.slice(0, 10) !== typesAsOf.slice(0, 10))

  return (
    <section id={id} className={`scroll-mt-24 ${className}`}>
      <Panel
        title={`Hedge funds, ${p.quarter.slice(0, 4)} Q${p.quarter.slice(5)}`}
        sub={
          <>
            <span className="num font-medium text-ink">{p.funds_filed.toLocaleString('en-US')}</span> of {p.funds_total.toLocaleString('en-US')} hedge funds filed
            {cover != null ? <> = <span className="num font-medium text-ink">{pctLabel(cover)}</span> of last quarter’s hedge-fund 13F value</> : null}.
          </>
        }
      >
        <div className="space-y-1 text-[12.5px] text-ink-3">
          {newest?.manager && newest.accepted_at && (
            <p>
              Newest filing included:{' '}
              {filingHref(newest) ? (
                <a href={filingHref(newest)!} target="_blank" rel="noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-ink">
                  {newest.manager}
                </a>
              ) : (
                newest.manager
              )}
              , EDGAR accepted {et(newest.accepted_at)}. Built {et(d.generated_at)}.
            </p>
          )}
          <p className={mismatch ? 'inline-block rounded-md bg-[#f6ead2] px-2 py-0.5 font-medium text-[#7a5410]' : ''}>
            {d.types_as_of ? typesAsOfLabel(d.types_as_of) : 'Fund types as of the last reclassification'}
            {mismatch ? `; data as of ${dateLabel(d.generated_at)}` : ''}.
          </p>
          <p>
            <span className="font-medium text-ink-2">$</span> means {d.basis}
          </p>
        </div>

        {notYet.length > 0 && (
          <details className="mt-3 text-[13px]">
            <summary className="cursor-pointer font-medium text-ink-2">The {notYet.length} largest hedge funds not yet filed, by last quarter’s 13F value</summary>
            <ol className="mt-2 grid gap-x-6 gap-y-1 text-ink-2 sm:grid-cols-2">
              {notYet.map((x, i) => (
                <li key={x.name} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {i + 1}.{' '}
                    {x.slug ? (
                      <Link to={`/investors/${x.slug}/`} className="underline decoration-line-2 underline-offset-2 hover:text-ink">
                        {x.name}
                      </Link>
                    ) : (
                      x.name
                    )}
                  </span>
                  {x.prev_value != null && <span className="num shrink-0 text-ink-3">{money(x.prev_value)}</span>}
                </li>
              ))}
            </ol>
          </details>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="seg rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Rank by">
            {SORTS.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={sort === k} onClick={() => setSort(k)} className={`rounded-full px-3 py-1.5 ${sort === k ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                {side === 'sell' ? l.replace('buying', 'selling').replace('gained', 'lost') : l}
              </button>
            ))}
          </div>
          <div className="seg rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Side">
            {(['buy', 'sell'] as const).map((k) => (
              <button key={k} role="tab" aria-selected={side === k} onClick={() => setSide(k)} className={`rounded-full px-3 py-1.5 ${side === k ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                {k === 'buy' ? 'Buying' : 'Selling'}
              </button>
            ))}
          </div>
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={etfs} onChange={(e) => setEtfs(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
            Include ETFs
          </label>
        </div>

        <ol className="mt-3 divide-y divide-line">
          {rows.map((r) => {
            const isOpen = open === r.ticker
            const top = side === 'buy' ? r.topBuyers : r.topSellers
            const share = side === 'buy' ? r.topBuyShare : r.topSellShare
            return (
              <li key={r.ticker} className="py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link to={stockPath(r.ticker)} className="font-semibold text-ink hover:text-accent">
                    {r.ticker}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-2">{r.name}</span>
                  {r.delisted && <Badge tone="warn">Acquired or delisted</Badge>}
                  {r.etf && <Badge>ETF</Badge>}
                  <span className="num text-[13.5px] text-ink">
                    {r.buyers} buying · {r.sellers} selling
                  </span>
                </div>
                <div className="num mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12.5px] text-ink-3">
                  <span>
                    Holders {r.holders_prev} → {r.holders} ({r.holder_change > 0 ? '+' : ''}
                    {r.holder_change})
                  </span>
                  <span>
                    {r.new_count} new · {r.exited_count} exited
                  </span>
                  <span>
                    {money(r.bought_usd)} bought · {money(Math.abs(r.sold_usd))} sold
                    {share != null ? ` · top fund ${pctLabel(share)} of $ ${side === 'buy' ? 'bought' : 'sold'}` : ''}
                  </span>
                  {r.prev > 0 ? (
                    <span className={r.early ? 'font-medium text-[#7a5410]' : ''}>
                      {r.filed} of {r.prev} last-quarter holders filed{r.early ? ' · early' : ''}
                    </span>
                  ) : (
                    <span>No hedge-fund holders last quarter</span>
                  )}
                  {r.excluded ? <span>{r.excluded} {r.excluded === 1 ? 'line' : 'lines'} excluded</span> : null}
                </div>
                {top.length > 0 && (
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.ticker)} className="mt-1.5 text-[12.5px] font-medium text-accent hover:text-accent-2">
                    {isOpen ? 'Hide' : `Top ${Math.min(5, top.length)} ${side === 'buy' ? 'buyers' : 'sellers'}`}
                  </button>
                )}
                {isOpen && (
                  <ol className="mt-1.5 space-y-0.5 text-[12.5px] text-ink-2">
                    {top.slice(0, 5).map((x) => {
                      const href = filingHref(x)
                      return (
                        <li key={x.name} className="flex justify-between gap-3">
                          {href ? (
                            <a href={href} target="_blank" rel="noreferrer" className="min-w-0 truncate underline decoration-line-2 underline-offset-2 hover:text-ink">
                              {x.name}
                            </a>
                          ) : (
                            <span className="min-w-0 truncate">{x.name}</span>
                          )}
                          {x.usd != null && <span className="num text-ink-3">{money(Math.abs(x.usd))}</span>}
                        </li>
                      )
                    })}
                  </ol>
                )}
              </li>
            )
          })}
          {rows.length === 0 && <li className="py-6 text-[14px] text-ink-2">No stocks on this side yet.</li>}
        </ol>
      </Panel>
    </section>
  )
}
