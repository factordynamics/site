import { Link } from 'react-router-dom'
import { Badge, LoadFailed, Panel, Skeleton } from '../components/ui'
import { DATA, money, useAsync, useTitle } from '../lib/data'

/**
 * /data-quality/: the publish gates and what they hold back, for Pro and Fund buyers. Every figure comes from ingest's
 * published files (quality.json, meta/builds.json, gates.json, the stores' own stamps); nothing is computed here.
 * A section whose file or field isn't published yet is left out, or (gates) falls back to the plain rule text.
 */

type Reason = { rows: number; filers: number; options?: number; usd?: number | null }
type Quality = {
  generated?: string
  build?: string
  held?: { rows: number; filers: number; usd?: number | null }
  by_reason?: Record<string, Reason>
  parity?: { quarter?: string; issuers: number; matched: number; checked_at?: string }
}
type Build = { store?: string; name?: string; build?: string; published_at?: string; quarters?: string[] | string }
type Gate = { id: string; name: string; fails_when: string; stays_live: string; result?: string; checked_at?: string; detail?: string }

/** A published file, or null when it isn't published yet (404). A network failure throws. */
const opt = <T,>(path: string): Promise<T | null> =>
  fetch(`${DATA}${path}?m=${Math.floor(Date.now() / 300_000)}`).then((r) => {
    if (r.ok) return r.json() as Promise<T>
    if (r.status === 404) return null
    throw new Error(`${path}: ${r.status}`)
  })

const REASON: Record<string, [string, string]> = {
  class_swap: ['Share classes swapped', 'One share class’s line filed under another class, so the class can’t be compared quarter to quarter.'],
  zero_shares: ['Zero-share class lines', 'A share-class line filed with no shares, so there is no count to compare.'],
  option_cusip_no_putcall: ['Option CUSIP without put or call', 'An option’s CUSIP filed with no put or call, so it can’t be told apart from stock.'],
  cusip_check_digit: ['CUSIP fails its check digit', 'The filed CUSIP doesn’t validate, so the security it names isn’t certain.'],
  possible_cusip_change: ['Possible CUSIP change', 'A position that may have moved to a new CUSIP between quarters; held until it’s confirmed.'],
  different_security: ['Different security, not compared', 'A note and the same issuer’s common stock: each reads as its own line, never as one trade.'],
  price_outlier: ['Value far off the filed price', 'The filed value implies a price far from the security’s other filings, so the units are suspect.'],
  reissue_ratio_not_applied: ['Pre-split share counts', 'Shares filed before a split or reissue ratio was applied.'],
  unreliable_both: ['Shares and value both unreliable', 'Neither side reconciles, so the change is unknown.'],
  unreliable_shares: ['Share counts that don’t reconcile', 'The value change from filed values shows instead of a share trade.'],
  value_rescale_rejected: ['Value units that don’t reconcile', 'The value fits neither dollars nor thousands.'],
}
const reasonLabel = (k: string) => REASON[k]?.[0] ?? k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ')

/** The gates' rules in plain words, shown until ingest publishes gates.json with each gate's last result. */
const GATE_RULES: Omit<Gate, 'id'>[] = [
  { name: 'Ticker coverage', fails_when: 'the share of 13F value with a ticker falls, or one of the largest securities that had a ticker loses it.', stays_live: 'The last published data stays live; nothing from the run is written.' },
  { name: 'Book weights', fails_when: 'a fund’s equity weights don’t add up to its whole book.', stays_live: 'The last published books stay live.' },
  { name: 'Book totals', fails_when: 'a quarter’s book comes out larger than the filings it was built from, as when an amendment is added on top of the original instead of replacing it, or another filer’s 13F is merged into a book.', stays_live: 'The last published books stay live.' },
  { name: 'Behind EDGAR', fails_when: 'a tracked fund has a newer 13F on EDGAR than the one loaded.', stays_live: 'The last published data stays live until the newer filing is in.' },
  { name: 'Holders by stock', fails_when: 'a stock’s count of all holders comes out lower than the tracked funds holding it, or its share classes don’t add up.', stays_live: 'The holder index on stock pages stays as published. Its two halves are written together from one build, or not at all.' },
  { name: 'Splits', fails_when: 'a split isn’t applied to a fund’s share counts.', stays_live: 'The last published data stays live.' },
  { name: 'Filer types', fails_when: 'the count of any filer type moves sharply without a reviewed reclassification, or a reviewed case changes type.', stays_live: 'The published types, and the pages sorted by them, stay live.' },
  { name: 'Provenance', fails_when: 'a tracked fund’s line is missing its EDGAR acceptance time, or any book has no source filing on any line.', stays_live: 'The last published data stays live.' },
  { name: 'Alert routing', fails_when: 'a field that alerts depend on is missing or unexpected.', stays_live: 'Data and alerts keep running on the last good file.' },
  { name: 'Site build', fails_when: 'a stock page’s holders disagree with the holder index they came from.', stays_live: 'The site isn’t deployed; the last deployed pages stay live.' },
]

const when = (t?: string) =>
  t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }) + ' UTC' : null
const n = (x: number) => x.toLocaleString('en-US')

export function DataQuality() {
  useTitle('Data quality: the gates every publish passes · Copybook')
  const q = useAsync(() => opt<Quality>('quality.json'), [])
  const builds = useAsync(() => opt<{ stores?: Record<string, Build> | Build[] } | Build[]>('meta/builds.json').catch(() => null), [])
  const gates = useAsync(() => opt<{ generated?: string; gates?: Gate[] }>('gates.json').catch(() => null), [])
  // Until meta/builds.json is published: the stamps the stores carry themselves.
  const stamps = useAsync(async () => {
    if (builds.loading || builds.data) return null
    const [idx, hlr] = await Promise.all([opt<{ build_id?: string; data_built_at?: string; generated_at?: string }>('index.json').catch(() => null), opt<{ generated_at?: string }>('hlr/index.json').catch(() => null)])
    return { idx, hlr }
  }, [builds.loading, builds.data])

  const reasons = Object.entries(q.data?.by_reason ?? {})
    .filter(([, r]) => r.rows > 0)
    .sort((a, b) => b[1].rows - a[1].rows)
  const hasUsd = reasons.some(([, r]) => r.usd != null)
  const parity = q.data?.parity

  const rawBuilds = builds.data ? (Array.isArray(builds.data) ? builds.data : builds.data.stores) : null
  const storeRows: { store: string; build?: string; at?: string; quarters?: string }[] = rawBuilds
    ? (Array.isArray(rawBuilds) ? rawBuilds.map((b) => [b.store ?? b.name ?? '', b] as const) : Object.entries(rawBuilds)).map(([store, b]) => ({
        store: STORE[store] ?? store,
        build: b.build,
        at: b.published_at,
        quarters: Array.isArray(b.quarters) ? (b.quarters.length > 1 ? `${b.quarters[0]}–${b.quarters[b.quarters.length - 1]}` : b.quarters[0]) : b.quarters,
      }))
    : [
        ...(stamps.data?.idx ? [{ store: 'Fund books', build: stamps.data.idx.build_id, at: stamps.data.idx.data_built_at ?? stamps.data.idx.generated_at }] : []),
        ...(stamps.data?.hlr?.generated_at ? [{ store: 'Holders by stock', at: stamps.data.hlr.generated_at }] : []),
        ...(q.data?.generated ? [{ store: 'Unreliable-line check', build: q.data.build, at: q.data.generated }] : []),
      ]
  const gateRows: (Omit<Gate, 'id'> & { id?: string })[] = gates.data?.gates?.length ? gates.data.gates : GATE_RULES

  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Data quality</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Every publish passes the gates, or nothing changes.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          Each data run is checked before it goes live. A run that fails a gate isn’t published, and the last good data stays up. 13F lines we can’t read with confidence are held: they show on fund and stock pages marked “not counted” and never count toward a trade or a $ total. Everything on this page is read from the files we publish.
        </p>
      </header>

      <section className="mt-12">
        <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Held lines, by reason</h2>
        <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-ink-3">
          {q.data?.generated ? `From the check of every 13F filer’s latest book, ${when(q.data.generated)}${q.data.build ? ` (build ${q.data.build})` : ''}.` : 'From the check of every 13F filer’s latest book.'}{' '}
          <Link to="/methodology/#unreliable" className="font-medium text-accent hover:text-accent-2">
            How we decide
          </Link>
        </p>
        {q.loading ? (
          <Skeleton className="mt-4 h-64 w-full" />
        ) : q.error ? (
          <LoadFailed what="the data-quality file" onRetry={q.retry} className="mt-4" />
        ) : !q.data || reasons.length === 0 ? (
          <p className="mt-4 text-[14px] text-ink-2">The check hasn’t published its counts yet.</p>
        ) : (
          <>
            {q.data.held && (
              <p className="num mt-4 text-[15px] font-medium text-ink">
                {n(q.data.held.rows)} lines from {n(q.data.held.filers)} filers held{q.data.held.usd != null ? `, ${money(q.data.held.usd)} as filed` : ''}
              </p>
            )}
            <div className="mt-3 overflow-x-auto rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                    <th className="px-4 py-3 font-medium sm:px-5">Reason</th>
                    <th className="px-3 py-3 text-right font-medium">Lines</th>
                    <th className="px-3 py-3 text-right font-medium">Filers</th>
                    {hasUsd && <th className="px-5 py-3 text-right font-medium">$ as filed</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {reasons.map(([k, r]) => (
                    <tr key={k} className="align-top">
                      <td className="px-4 py-3 sm:px-5">
                        <span className="block font-medium text-ink">{reasonLabel(k)}</span>
                        {REASON[k] && <span className="mt-0.5 block text-[13px] leading-snug text-ink-3">{REASON[k][1]}</span>}
                        {!!r.options && <span className="mt-0.5 block text-[12.5px] text-ink-3">{n(r.options)} of them option lines</span>}
                      </td>
                      <td className="num px-3 py-3 text-right">{n(r.rows)}</td>
                      <td className="num px-3 py-3 text-right">{n(r.filers)}</td>
                      {hasUsd && <td className="num px-5 py-3 text-right">{r.usd != null ? money(r.usd) : '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {parity && (
          <p className="num mt-4 text-[14px] text-ink-2">
            <span className="font-medium text-ink">Holders by stock reconcile:</span> each stock’s net change equals the sum of its counted fund changes for {n(parity.matched)} of {n(parity.issuers)} issuers
            {parity.quarter ? ` (${parity.quarter}` : ''}
            {parity.checked_at ? `${parity.quarter ? ', ' : ' ('}checked ${when(parity.checked_at)})` : parity.quarter ? ')' : ''}.
          </p>
        )}
      </section>

      <section className="mt-12">
        <h2 className="text-[22px] font-semibold tracking-[-0.02em]">What’s live now</h2>
        <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-ink-3">The build each part of the data comes from. Live freshness and incidents are on the <Link to="/status/" className="font-medium text-accent hover:text-accent-2">status page</Link>.</p>
        {builds.loading || stamps.loading ? (
          <Skeleton className="mt-4 h-28 w-full" />
        ) : storeRows.length === 0 ? (
          <p className="mt-4 text-[14px] text-ink-2">Build stamps aren’t published yet.</p>
        ) : (
          <div className="mt-4 grid gap-px overflow-hidden rounded-[var(--radius-card)] bg-line shadow-[var(--shadow-card)] sm:grid-cols-3">
            {storeRows.map((s) => (
              <div key={s.store} className="bg-card p-5">
                <p className="text-[12.5px] font-medium text-ink-2">{s.store}</p>
                <p className="num mt-1.5 text-[17px] font-semibold tracking-[-0.01em]">{when(s.at) ?? '—'}</p>
                <p className="mt-1 break-all font-mono text-[12px] text-ink-3">{[s.build, s.quarters].filter(Boolean).join(' · ') || ' '}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-12">
        <h2 className="text-[22px] font-semibold tracking-[-0.02em]">The gates</h2>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-3">
          A run that fails any of these isn’t published.{gates.data?.generated ? ` Last checked ${when(gates.data.generated)}.` : ''}
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2 [&>*]:h-full">
          {gateRows.map((g) => (
            <Panel key={g.id ?? g.name}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[15.5px] font-semibold">{g.name}</h3>
                {g.result && <Badge tone={/^pass/i.test(g.result) ? 'up' : /^fail|refus/i.test(g.result) ? 'down' : 'neutral'}>{g.result}{g.checked_at ? ` · ${when(g.checked_at)}` : ''}</Badge>}
              </div>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">
                Fails when {g.fails_when.replace(/^fails when /i, '')} {g.stays_live}
                {g.detail ? ` ${g.detail}` : ''}
              </p>
            </Panel>
          ))}
        </div>
      </section>

      <p className="mt-10 text-[14px] text-ink-3">
        How the data is built is on the{' '}
        <Link to="/methodology/" className="font-medium text-accent hover:text-accent-2">
          methodology page
        </Link>
        ; the same data is in the <Link to="/api/" className="font-medium text-accent hover:text-accent-2">API</Link> and bulk files.
      </p>
    </div>
  )
}

const STORE: Record<string, string> = { hl: 'Holders by stock', hlr: 'Holders by stock', changes: 'Quarter changes', filer_view: 'Fund books', h: 'Fund books', quality: 'Unreliable-line check' }
