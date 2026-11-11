import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Signup } from '../components/Signup'
import { Badge, Panel, Skeleton } from '../components/ui'
import { gapLabel, loadLatency, type Latency, type LatencyStat } from '../lib/account'
import { displayName } from '../lib/names.mjs'
import { quarterLabel, useAsync, useTick, useTitle } from '../lib/data'
import { INCIDENTS, OUTAGES } from '../lib/hosting'
import { seasonNow } from '../lib/stocks'
import { gapStats, seasonGaps } from '../lib/latencyStats.mjs'

// /speed/: the public alert latency log (the API's latency.json on R2). Every live alert this season, from EDGAR
// acceptance to delivery, with medians and 90th percentiles per form type and, once the delivery log
// records them, per channel. Re-read every minute while open. Every live alert counts, including the 13F alerts
// whose moves went out late before the Nov 11 fix (latency.json before_moves_fix; see lib/latencyStats.mjs).

type Alert = Latency['alerts'][number]
// The summary's order: what members buy first.
const LEAD: [string, string][] = [
  ['13F', '13F'],
  ['13D', 'Schedule 13D'],
  ['13G', 'Schedule 13G'],
  ['Form 4', 'Form 4'],
]
const CHANNELS: [string, string][] = [
  ['email', 'Email'],
  ['slack', 'Slack'],
  ['discord', 'Discord'],
  ['telegram', 'Telegram'],
  ['webhook', 'Webhook'],
  ['feed', 'RSS / JSON feed'],
]
const BUCKETS: [string, number][] = [
  ['Under 1 min', 60],
  ['1–2 min', 120],
  ['2–5 min', 300],
  ['5–15 min', 900],
  ['15 min +', Infinity],
]
const time = (t: string) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' })

export function Speed() {
  useTitle('Alert speed: EDGAR to inbox, every alert logged · Copybook')
  const tick = useTick(60_000, true)
  const lat = useAsync(loadLatency, [tick])
  const d = lat.data
  // Until 13F rows are complete, the histogram leaves them out too.
  const timed = seasonGaps(d).filter((a) => f13Ready(d) || !a.form.startsWith('13F'))
  const gaps = timed.map((a) => a.seconds)
  const overall = gapStats(gaps)
  // 13G alerts are opt-in and outnumber the rest.
  const optIn = timed.filter((a) => /13G/.test(a.form)).length
  const median = overall.median_seconds
  const p90 = overall.p90_seconds
  const season = d?.season ?? seasonNow().quarter
  const loading = lat.loading && !d
  const empty = !loading && !d?.count
  // Once /latency tags each alert curated or any_filer, show the split.
  const cov = (d?.alerts ?? []) as (Alert & { coverage?: 'curated' | 'any_filer' })[]
  const tagged = cov.filter((a) => a.coverage)
  const coverage = tagged.length ? ` Of the latest ${tagged.length}: ${tagged.filter((a) => a.coverage === 'curated').length} for funds we track closely, ${tagged.filter((a) => a.coverage === 'any_filer').length} for other filers.` : ''
  const stat = (m: Record<string, LatencyStat> | undefined, k: string): LatencyStat => m?.[k] ?? { count: 0, median_seconds: null, p90_seconds: null }

  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Speed</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">From EDGAR to you, timed.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          {empty ? 'No live alerts timed yet. Once they go out, every live alert this season appears here' : 'Every live alert this filing season'}: when EDGAR accepted the filing, when we delivered it, and the gap in seconds. Every live alert is counted. The raw log is public at{' '}
          <a href={import.meta.env.VITE_LATENCY_URL} className="font-mono text-[15px] text-accent hover:text-accent-2">
            latency.json
          </a>
          .
        </p>
      </header>

      {/* Per form first: the blend is mostly 13G, so it leads with nothing anyone buys. 13F is timed to the
          first email until the API times it to the email that carries the moves (by_form['13F'].timed_to). */}
      <ThirteenF d={d} loading={loading} />
      <BeforeFix d={d} />
      <section className="mt-6 grid gap-px overflow-hidden rounded-[var(--radius-card)] bg-line shadow-[var(--shadow-card)] sm:grid-cols-3" aria-label="Alert speed by form type">
        {LEAD.filter(([k]) => k !== '13F').map(([k, label]) => {
          const g = stat(d?.by_form, k) as LatencyStat & { timed_to?: string }
          return (
            <div key={k} className="bg-card p-5 md:p-6">
              <p className="text-[12.5px] font-medium text-ink-2">{label}</p>
              {loading ? <Skeleton className="mt-2 h-8 w-24" /> : <p className="num mt-1.5 text-[30px] font-semibold leading-none tracking-[-0.03em]">{g.median_seconds != null ? gapLabel(g.median_seconds) : '—'}</p>}
              <p className="mt-2 text-[12.5px] text-ink-3">
                median{g.p90_seconds != null ? ` · 90th pct ${gapLabel(g.p90_seconds)}` : ''} · {g.count.toLocaleString('en-US')} {g.count === 1 ? 'alert' : 'alerts'}
              </p>
            </div>
          )
        })}
      </section>
      <p className="mt-3 text-[13px] text-ink-3">
        All alert types: median {median != null ? gapLabel(median) : '—'}
        {p90 != null ? `, 90th percentile ${gapLabel(p90)}` : ''}, {overall.count.toLocaleString('en-US')} alerts{optIn ? `, ${optIn.toLocaleString('en-US')} of them opt-in 13G,` : ''} in the {quarterLabel(season)} season so far. We check EDGAR every minute.
      </p>

      {empty ? (
        <section className="mt-6 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)] md:p-8">
          <Badge tone="accent">Waiting for the first live alert</Badge>
          <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.02em]">No live alerts timed yet this season.</h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-2">
            The first one appears here within a minute of going out, with its EDGAR acceptance time, delivery time and gap. Most superinvestors file in the last days before the {quarterLabel(season)} deadline, so expect this log to fill up quickly. Replays and backfills are never counted.
          </p>
          <p className="mt-4 text-[14px] text-ink-2">
            Meanwhile, see who has filed and who’s next on the{' '}
            <Link to="/season/#expected" className="font-medium text-accent hover:text-accent-2">
              season tracker
            </Link>
            .
          </p>
        </section>
      ) : (
        !loading && (
          <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Panel title="By channel" sub="Email to the mailer handoff; chat, webhook and feed to the first successful post">
              <Rows rows={CHANNELS.map(([k, label]) => [k, label, stat(d?.by_channel, k)])} />
            </Panel>
            <Panel title="Distribution" sub={`All ${gaps.length.toLocaleString('en-US')} alerts this season by time from EDGAR acceptance`} >
              <Histogram gaps={gaps} />
            </Panel>
          </div>
        )
      )}

      {!loading && <AlertLog d={d} />}

      <section className="mt-10 max-w-3xl">
        <h2 className="text-[15px] font-semibold">How we measure</h2>
        <ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-ink-2">
          <li>
            <span className="font-medium text-ink">Start:</span> EDGAR’s acceptance time on the filing itself, not when we noticed it.
          </li>
          <li>
            <span className="font-medium text-ink">End:</span> when the alert left us for its destination (for email, when our mail provider accepted it). Your inbox or chat app can add a few seconds. For 13F alerts the clock stops when the email with the filing’s moves is sent, not at a first notice.
          </li>
          <li>
            <span className="font-medium text-ink">Counted:</span> live alerts only. Replays, backfills and test messages are left out, and slow alerts stay in.
          </li>
          <li>
            <span className="font-medium text-ink">Coverage:</span> 13F alerts for the managers we track closely and for any other filer a member follows (peers and linked 13Fs included), and Form 4 and 13D/G alerts on the names members follow. All of them are timed.{coverage} How the data is built is on the{' '}
            <Link to="/methodology/" className="font-medium text-accent hover:text-accent-2">
              methodology page
            </Link>
            .
          </li>
        </ul>
      </section>

      <section className="mt-10 max-w-3xl" aria-labelledby="availability">
        <h2 id="availability" className="text-[22px] font-semibold tracking-[-0.02em]">
          Availability
        </h2>
        {d?.poller_last_run && (
          <p className="mt-2 text-[14px] text-ink-2">
            {Date.now() - Date.parse(d.poller_last_run) < 120_000 ? 'EDGAR checked within the last 2 min' : `EDGAR poller last ran ${ago(Date.now() - Date.parse(d.poller_last_run))} ago`}
            {d.poller_host ? ` · ${d.poller_host === 'cloudflare' ? 'Cloudflare' : 'backup'}` : ''}.
          </p>
        )}
        <h3 className="mt-5 text-[15px] font-semibold">Incidents</h3>
        <ol className="mt-2 divide-y divide-line rounded-[var(--radius-card)] bg-card px-5 shadow-[var(--shadow-card)]">
          {INCIDENTS.map(([when, what, link]) => (
            <li key={when} className="py-3 text-[14px] leading-relaxed">
              <span className="num block text-[12.5px] text-ink-3">{when}</span>
              <span className="text-ink-2">{what}</span>
              {link && (
                <Link to={link} className="ml-1.5 font-medium text-accent hover:text-accent-2">
                  See them
                </Link>
              )}
            </li>
          ))}
        </ol>
        <h3 className="mt-6 text-[15px] font-semibold">What happens to alerts during an outage</h3>
        <dl className="mt-2 divide-y divide-line rounded-[var(--radius-card)] bg-card px-5 shadow-[var(--shadow-card)]">
          {OUTAGES.map(([when, what]) => (
            <div key={when} className="py-3 text-[14px] leading-relaxed">
              <dt className="font-medium text-ink">{when}</dt>
              <dd className="mt-0.5 text-ink-2">{what}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Signup source="speed" className="mt-10" />
    </div>
  )
}

const ago = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`)

function Rows({ rows }: { rows: [string, string, LatencyStat][] }) {
  return (
    <table className="w-full text-[14px]">
      <thead>
        <tr className="text-left text-[12px] text-ink-3">
          <th className="pb-2 font-medium">
            <span className="sr-only">Type</span>
          </th>
          <th className="pb-2 text-right font-medium">Median</th>
          <th className="pb-2 text-right font-medium">90th pct</th>
          <th className="pb-2 text-right font-medium">Alerts</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, label, g]) => (
          <tr key={k} className="border-t border-line">
            <td className="py-2.5">{label}</td>
            <td className="num py-2.5 text-right font-medium">{g.median_seconds != null ? gapLabel(g.median_seconds) : <span className="text-ink-3">—</span>}</td>
            <td className="num py-2.5 text-right">{g.p90_seconds != null ? gapLabel(g.p90_seconds) : <span className="text-ink-3">—</span>}</td>
            <td className="num py-2.5 text-right text-ink-2">{g.count.toLocaleString('en-US')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Histogram({ gaps }: { gaps: number[] }) {
  let lo = 0
  const counts = BUCKETS.map(([label, hi]) => {
    const n = gaps.filter((g) => g >= lo && g < hi).length
    lo = hi
    return [label, n] as const
  })
  const max = Math.max(1, ...counts.map(([, n]) => n))
  return (
    <ul className="space-y-2.5">
      {counts.map(([label, n]) => (
        <li key={label} className="grid grid-cols-[6.5rem_1fr_4.5rem] items-center gap-3 text-[13.5px]">
          <span className="text-ink-2">{label}</span>
          <span className="h-3 overflow-hidden rounded-full bg-ink/[0.05]">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${(n / max) * 100}%` }} />
          </span>
          <span className="num text-right text-ink-2">{gaps.length ? `${Math.round((n / gaps.length) * 100)}%` : '—'}</span>
        </li>
      ))}
    </ul>
  )
}

// 13F timings stay hidden until payments marks its 13F rows complete (by_form['13F'].complete) with at
// least 5 timed alerts: on-time 13F sends weren't being logged, so the rows so far are only the late ones.
const F13_MIN = 5
export const f13Ready = (d: Latency | null | undefined) => {
  const g = d?.by_form?.['13F'] as (LatencyStat & { complete?: boolean }) | undefined
  return Boolean(g?.complete && g.count >= F13_MIN)
}
// 13F: the full season (every 13F alert, the six late ones included) and, apart, the alerts accepted after
// the Nov 11 moves fix. Computed from the rows with payments' method, so they match latency.json's figures.
function ThirteenF({ d, loading }: { d: Latency | null | undefined; loading: boolean }) {
  const ready = f13Ready(d)
  // Payments' split by acceptance time (by_form['13F'].season and .since_fix); computed from the rows the
  // same way when an older latency.json lacks them.
  const f = d?.by_form?.['13F'] as (LatencyStat & { season?: LatencyStat & { over_15m?: number }; since_fix?: LatencyStat }) | undefined
  const rows = seasonGaps(d).filter((a) => a.form.startsWith('13F'))
  const all = f?.season ?? gapStats(rows.map((a) => a.seconds))
  const slow = f?.season?.over_15m ?? rows.filter((a) => a.seconds > 900).length
  const fixAt = (d as { moves_fix_at?: string } | null | undefined)?.moves_fix_at
  const after = f?.since_fix ?? (fixAt ? gapStats(rows.filter((a) => a.accepted_at >= fixAt).map((a) => a.seconds)) : null)
  const day = fixAt ? new Date(fixAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null
  const big = 'num mt-1.5 text-[30px] font-semibold leading-none tracking-[-0.03em]'
  return (
    <section className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-card)] bg-line shadow-[var(--shadow-card)] sm:grid-cols-2" aria-label="13F alert speed">
      <div className="bg-card p-5 md:p-6">
        <p className="text-[12.5px] font-medium text-ink-2">13F, full season</p>
        {loading ? (
          <Skeleton className="mt-2 h-8 w-24" />
        ) : ready ? (
          <>
            <p className={big}>{all.median_seconds != null ? gapLabel(all.median_seconds) : '—'}</p>
            <p className="mt-2 text-[12.5px] text-ink-3">
              median · {all.count.toLocaleString('en-US')} {all.count === 1 ? 'alert' : 'alerts'}
              {all.p90_seconds != null ? ` · 90th percentile ${gapLabel(all.p90_seconds)}` : ''}
              {slow ? ` · ${slow} took over 15 minutes` : ''}
            </p>
          </>
        ) : (
          <p className="mt-2 text-[14px] leading-snug text-ink-2">13F timings are being re-logged after a logging fix; back shortly.</p>
        )}
      </div>
      {after && (
        <div className="bg-card p-5 md:p-6">
          <p className="text-[12.5px] font-medium text-ink-2">13F, since the {day} fix</p>
          {loading ? (
            <Skeleton className="mt-2 h-8 w-24" />
          ) : after.count ? (
            <>
              <p className={big}>{after.median_seconds != null ? gapLabel(after.median_seconds) : '—'}</p>
              <p className="mt-2 text-[12.5px] text-ink-3">
                median · {after.count.toLocaleString('en-US')} {after.count === 1 ? 'alert' : 'alerts'}
                {after.p90_seconds != null ? ` · 90th percentile ${gapLabel(after.p90_seconds)}` : ''}
              </p>
            </>
          ) : (
            <p className="mt-2 text-[14px] leading-snug text-ink-2">No 13F alerts since the fix yet.</p>
          )}
        </div>
      )}
    </section>
  )
}

// Why the 13F season has a slow tail: the six alerts whose moves went out late. They are counted above.
type Before = { count: number; median_seconds: number | null; p90_seconds?: number | null; max_seconds?: number | null; rows?: { manager: string; accepted_at: string; seconds: number }[] }
function BeforeFix({ d }: { d: Latency | null | undefined }) {
  const x = d as (Latency & { moves_fix_at?: string; before_moves_fix?: Record<string, Before> }) | null | undefined
  const b = x?.before_moves_fix?.['13F']
  const [open, setOpen] = useState(() => window.location.hash === '#before-fix')
  useEffect(() => {
    const on = () => window.location.hash === '#before-fix' && setOpen(true)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  if (!b?.count) return null
  const day = x?.moves_fix_at ? new Date(x.moves_fix_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null
  const slow = b.max_seconds != null ? `slowest ${gapLabel(b.max_seconds)}` : b.p90_seconds != null ? `90th percentile ${gapLabel(b.p90_seconds)}` : ''
  return (
    <div id="before-fix" className="mt-3 scroll-mt-24 text-[13px] leading-relaxed text-ink-2">
      {b.count} {b.count === 1 ? 'alert' : 'alerts'} sent {b.count === 1 ? 'its' : 'their'} moves late because of a bug fixed{day ? ` on ${day}` : ''} (median {b.median_seconds != null ? gapLabel(b.median_seconds) : '—'}
      {slow ? `, ${slow}` : ''}).{' '}
      {b.rows?.length ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="font-medium text-accent hover:text-accent-2">
          {open ? 'Hide them' : 'See them'}
        </button>
      ) : (
        <a href={import.meta.env.VITE_LATENCY_URL} className="font-medium text-accent hover:text-accent-2">
          See them in latency.json
        </a>
      )}
      {open && b.rows && (
        <ul className="mt-2 divide-y divide-line rounded-xl bg-card px-4 shadow-[var(--shadow-card)]">
          {b.rows.map((r) => (
            <li key={r.manager + r.accepted_at} className="flex justify-between gap-3 py-2">
              <span className="truncate">{r.manager}</span>
              <span className="num shrink-0 text-ink-3">{gapLabel(r.seconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Every alert this season, newest first, paged: no row is picked or left out (13G, missed filings, replays and
// tests included). Per row: EDGAR acceptance, detection, first email, first team-channel delivery and the poller
// that sent it (payments' latency.json alerts[] fields); a time the log doesn't have reads "not recorded". The
// summaries leave out replays and tests, and count missed filings by their eventual delay.
const PAGE = 50
type LogRow = Alert & {
  host?: string | null
  detected_at?: string | null
  email_accepted_at?: string | null
  team_delivered_at?: string | null
  first_alert_at?: string | null
  moves_sent_at?: string | null
  held?: boolean | null
  released_at?: string | null
  missed?: boolean | null
  delay_seconds?: number | null
  never?: boolean | null
  replay?: boolean | null
  test?: boolean | null
  url?: string | null
}
const POLLER: Record<string, string> = { cloudflare: 'Cloudflare', server: 'Our server' }
const formLabel = (f: string) => (/^4(\/A)?$/.test(f) ? `Form ${f}` : f.replace(/^SCHEDULE\s+/, ''))
const formGroup = (f: string) => (f.startsWith('13F') ? '13F' : /13[DG]/.test(f) ? '13D/G' : /^4/.test(f) ? 'Form 4' : f)
const dayET = (t: string) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
const NR = <span className="text-ink-3">not recorded</span>
const at = (t?: string | null) => (t ? time(t) : NR)
function Summary({ title, rows }: { title: string; rows: { seconds: number | null }[] }) {
  const v = rows.filter((r) => r.seconds != null).map((r) => r.seconds!)
  const st = gapStats(v)
  const never = rows.length - v.length
  return (
    <tr className="border-b border-line last:border-0">
      <td className="py-2 pl-4 pr-2 sm:px-5">{title}</td>
      <td className="num px-2 py-2 text-right sm:px-3">{rows.length.toLocaleString('en-US')}</td>
      <td className="num px-2 py-2 text-right sm:px-3">{st.median_seconds != null ? gapLabel(st.median_seconds) : '—'}</td>
      <td className="num px-2 py-2 text-right sm:px-3">{st.p90_seconds != null ? gapLabel(st.p90_seconds) : '—'}</td>
      <td className="num py-2 pl-2 pr-4 text-right sm:px-5">{never ? `never (${never})` : v.length ? gapLabel(Math.max(...v)) : '—'}</td>
    </tr>
  )
}
function AlertLog({ d }: { d: Latency | null | undefined }) {
  const [page, setPage] = useState(0)
  const x = d as (Latency & { before_moves_fix?: Record<string, { rows?: { accession: string; seconds: number }[] }> }) | null | undefined
  const late = new Map((x?.before_moves_fix?.['13F']?.rows ?? []).map((r) => [r.accession, r.seconds]))
  const rows = ((d?.log?.length ? d.log : (d?.alerts ?? [])) as LogRow[]).slice().sort((a, b) => (b.email_accepted_at ?? b.sent_at ?? b.accepted_at).localeCompare(a.email_accepted_at ?? a.sent_at ?? a.accepted_at))
  // Seconds to the alert that counts: a 13F's moves (the late pre-fix ones by their moves email), a missed
  // filing's eventual delay, null when it never went out.
  const secs = (r: LogRow): number | null => (r.never ? null : r.missed && r.delay_seconds != null ? r.delay_seconds : (late.get(r.accession) ?? r.gap_seconds))
  const counted = rows.filter((r) => !r.replay && !r.test).map((r) => ({ ...r, seconds: secs(r) }))
  const acc = counted.map((r) => r.accepted_at).sort()
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const p = Math.min(page, pages - 1)
  const shown = rows.slice(p * PAGE, p * PAGE + PAGE)
  const flagged = rows.length - counted.length
  const pollers = [...new Set(counted.map((r) => r.host ?? ''))]
  return (
    <section id="alerts" className="mt-6 scroll-mt-24">
      <h2 className="text-[15px] font-semibold">Every alert this season</h2>
      <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-3">
        Timed from EDGAR’s acceptance of the filing, to the second, not from when we noticed it. EDGAR accepts filings from 6 am to 10 pm ET on business days; one accepted after 5:30 pm ET carries the next business day’s filing date, but is still timed from its acceptance.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-[14px] text-ink-2">No live alerts yet this season. Each one is listed here once it goes out.</p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]" tabIndex={0} role="region" aria-label="Alert speed by form and poller">
            <table className="w-full text-[13.5px]">
              <caption className="px-4 pt-3 text-left text-[12.5px] text-ink-3 sm:px-5">
                {counted.length.toLocaleString('en-US')} alerts, EDGAR accepted {dayET(acc[0])}
                {dayET(acc[0]) === dayET(acc[acc.length - 1]) ? '' : ` – ${dayET(acc[acc.length - 1])}`}
                {flagged ? `; ${flagged} ${flagged === 1 ? 'replay or test' : 'replays and tests'} listed below but not counted` : ''}.
              </caption>
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  <th className="py-2.5 pl-4 pr-2 font-medium sm:px-5">Alerts</th>
                  <th className="whitespace-nowrap px-2 py-2.5 sm:px-3 text-right font-medium">Count</th>
                  <th className="whitespace-nowrap px-2 py-2.5 sm:px-3 text-right font-medium">Median</th>
                  <th className="whitespace-nowrap px-2 py-2.5 sm:px-3 text-right font-medium">90th pct</th>
                  <th className="py-2.5 pl-2 pr-4 text-right font-medium sm:px-5">Slowest</th>
                </tr>
              </thead>
              <tbody>
                <Summary title="All" rows={counted} />
                {['13F', '13D/G', 'Form 4'].map((g) => {
                  const r = counted.filter((a) => formGroup(a.form) === g)
                  return r.length ? <Summary key={g} title={g} rows={r} /> : null
                })}
                {pollers.map((h) => (
                  <Summary key={h || 'none'} title={h === 'cloudflare' ? 'Sent by Cloudflare' : h === 'server' ? 'Sent by our server' : h ? 'Sent by another poller' : 'Poller not recorded'} rows={counted.filter((a) => (a.host ?? '') === h)} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 overflow-x-auto rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]" tabIndex={0} role="region" aria-label="Every alert this season and its latency">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  <th className="py-2.5 pl-4 pr-2 font-medium sm:px-5">Filer</th>
                  <th className="px-3 py-2.5 font-medium">Form</th>
                  <th className="hidden px-3 py-2.5 font-medium lg:table-cell">EDGAR accepted (ET)</th>
                  <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Detected</th>
                  <th className="hidden px-3 py-2.5 font-medium lg:table-cell">First email</th>
                  <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Team channel</th>
                  <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Poller</th>
                  <th className="py-2.5 pl-2 pr-4 text-right font-medium sm:px-5">Seconds</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const sec = secs(a)
                  const f13 = a.form.startsWith('13F')
                  const moves = f13 && (a.moves_sent_at || late.has(a.accession)) ? (a.moves_sent_at ? time(a.moves_sent_at) : `${gapLabel(late.get(a.accession)!)} after acceptance`) : null
                  return (
                    <tr key={a.accession + (a.sent_at ?? '')} className={`border-b border-line last:border-0 ${a.replay || a.test ? 'text-ink-3' : ''}`}>
                      <td className="py-2.5 pl-4 pr-2 align-top sm:px-5">
                        <Link to={`/investors/${a.slug}/`} className="font-medium hover:text-accent">
                          {displayName(a.manager)}
                        </Link>
                        {a.quarter && (
                          <>
                            {' '}
                            <span className="ml-0.5 whitespace-nowrap text-[11.5px] text-ink-3">{quarterLabel(a.quarter)}</span>
                          </>
                        )}
                        {a.missed && (
                          <>
                            {' '}
                            <span className="ml-0.5 inline-block whitespace-nowrap rounded-full bg-[#fde2e2] px-2 py-0.5 text-[11.5px] font-medium text-[#8a1c1c]">{a.never ? 'missed, never sent' : 'missed, sent late'}</span>
                          </>
                        )}
                        {(a.replay || a.test) && (
                          <>
                            {' '}
                            <span className="ml-0.5 inline-block whitespace-nowrap rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11.5px] font-medium text-ink-2">{a.replay ? 'replay' : 'test'}, not counted</span>
                          </>
                        )}
                        {late.has(a.accession) && (
                          <>
                            {' '}
                            <a href="#before-fix" className="ml-0.5 inline-block whitespace-nowrap rounded-full bg-[#fbecd3] px-2 py-0.5 text-[11.5px] font-medium text-[#7a4b00] hover:underline">
                              moves late, fixed Nov 11
                            </a>
                          </>
                        )}
                        <span className="num block text-[11.5px] text-ink-3">
                          {a.url ? (
                            <a href={a.url} className="hover:text-accent">
                              {a.accession}
                            </a>
                          ) : f13 ? (
                            <Link to={`/f/${a.accession}/`} className="hover:text-accent">
                              {a.accession}
                            </Link>
                          ) : (
                            a.accession
                          )}
                        </span>
                        {f13 && (
                          <span className="num block text-[11.5px] text-ink-3">
                            first alert {a.first_alert_at ? time(a.first_alert_at) : 'not recorded'} · moves {a.held ? `pending check, released ${a.released_at ? time(a.released_at) : 'not yet'}` : (moves ?? 'not recorded')}
                          </span>
                        )}
                        <span className="num block text-[11.5px] text-ink-3 lg:hidden">
                          accepted {time(a.accepted_at)} · emailed {a.email_accepted_at || a.sent_at ? time((a.email_accepted_at ?? a.sent_at)!) : 'not recorded'} · {a.host ? POLLER[a.host] ?? a.host : 'poller not recorded'}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 align-top text-ink-2">{formLabel(a.form)}</td>
                      <td className="num hidden whitespace-nowrap px-3 py-2.5 align-top text-ink-2 lg:table-cell">{time(a.accepted_at)}</td>
                      <td className="num hidden whitespace-nowrap px-3 py-2.5 align-top text-ink-2 lg:table-cell">{at(a.detected_at)}</td>
                      <td className="num hidden whitespace-nowrap px-3 py-2.5 align-top text-ink-2 lg:table-cell">{a.never ? 'never' : at(a.email_accepted_at ?? a.sent_at)}</td>
                      <td className="num hidden whitespace-nowrap px-3 py-2.5 align-top text-ink-2 lg:table-cell">{at(a.team_delivered_at)}</td>
                      <td className="hidden whitespace-nowrap px-3 py-2.5 align-top text-ink-2 lg:table-cell">{a.host ? POLLER[a.host] ?? a.host : NR}</td>
                      <td className="num py-2.5 pl-2 pr-4 text-right align-top font-medium sm:px-5" title={sec != null ? gapLabel(sec) : 'never sent'}>
                        {sec != null ? Math.round(sec).toLocaleString('en-US') : 'never'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-3">
            <span className="num">
              {(p * PAGE + 1).toLocaleString('en-US')}–{(p * PAGE + shown.length).toLocaleString('en-US')} of {rows.length.toLocaleString('en-US')}, newest first. The same rows are in{' '}
              <a href={import.meta.env.VITE_LATENCY_URL} className="font-medium text-accent hover:text-accent-2">
                latency.json
              </a>
              .
            </span>
            {pages > 1 && (
              <span className="flex gap-2">
                <button type="button" disabled={p === 0} onClick={() => setPage(p - 1)} className="rounded-full px-3 py-1 font-medium text-accent hover:bg-ink/5 disabled:text-ink-3 disabled:hover:bg-transparent">
                  Newer
                </button>
                <button type="button" disabled={p >= pages - 1} onClick={() => setPage(p + 1)} className="rounded-full px-3 py-1 font-medium text-accent hover:bg-ink/5 disabled:text-ink-3 disabled:hover:bg-transparent">
                  Older
                </button>
              </span>
            )}
          </div>
        </>
      )}
    </section>
  )
}
