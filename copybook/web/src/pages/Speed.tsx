import { Link } from 'react-router-dom'
import { Signup } from '../components/Signup'
import { Badge, Panel, Skeleton } from '../components/ui'
import { api } from '../config'
import { gapLabel, loadLatency, type Latency, type LatencyStat } from '../lib/account'
import { quarterLabel, useAsync, useTick, useTitle } from '../lib/data'
import { seasonNow } from '../lib/stocks'

// /speed/: the public alert latency log (GET {api}/latency). Every live alert this season, from EDGAR
// acceptance to delivery, with medians and 90th percentiles per form type and, once the delivery log
// records them, per channel. Re-read every minute while open. Nothing is hand-picked.

type Alert = Latency['alerts'][number]
const FORMS: [string, string][] = [
  ['13F', '13F'],
  ['Form 4', 'Form 4'],
  ['13D', 'Schedule 13D'],
  ['13G', 'Schedule 13G'],
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
  const alerts = (d?.alerts ?? []) as Alert[]
  const gaps = alerts.map((a) => a.gap_seconds)
  const median = d?.median_seconds ?? null
  const p90 = d?.p90_seconds ?? null
  const season = d?.season ?? seasonNow().quarter
  const loading = lat.loading && !d
  const empty = !loading && !d?.count
  const stat = (m: Record<string, LatencyStat> | undefined, k: string): LatencyStat => m?.[k] ?? { count: 0, median_seconds: null, p90_seconds: null }

  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Speed</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">From EDGAR to you, timed.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          Every live alert this filing season: when EDGAR accepted the filing, when we delivered it, and the gap in seconds. Nothing is picked out; the raw log is public at{' '}
          <a href={`${api}/latency`} className="font-mono text-[15px] text-accent hover:text-accent-2">
            /latency
          </a>
          .
        </p>
      </header>

      <section className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-card)] bg-line shadow-[var(--shadow-card)] md:grid-cols-4" aria-label="Season summary">
        {(
          [
            ['Median', median != null ? gapLabel(median) : '—', 'EDGAR acceptance to delivery'],
            ['90th percentile', p90 != null ? gapLabel(p90) : '—', '9 in 10 alerts arrive within this'],
            ['Alerts timed', (d?.count ?? 0).toLocaleString('en-US'), `${quarterLabel(season)} season so far`],
            ['How often we check', 'Every minute', 'EDGAR’s latest-filings feed'],
          ] as const
        ).map(([k, v, s]) => (
          <div key={k} className="bg-card p-5 md:p-6">
            <p className="text-[12.5px] text-ink-3">{k}</p>
            {loading ? <Skeleton className="mt-2 h-8 w-24" /> : <p className="num mt-1.5 text-[30px] font-semibold leading-none tracking-[-0.03em]">{v}</p>}
            <p className="mt-2 text-[12.5px] text-ink-3">{s}</p>
          </div>
        ))}
      </section>

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
          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            <Panel title="By form type" sub="Median and 90th percentile this season">
              <Rows rows={FORMS.map(([k, label]) => [k, label, stat(d?.by_form, k)])} />
            </Panel>
            <Panel title="By channel" sub="Email to the mailer handoff; chat, webhook and feed to the first successful post">
              <Rows rows={CHANNELS.map(([k, label]) => [k, label, stat(d?.by_channel, k)])} />
            </Panel>
            <Panel title="Distribution" sub={`The latest ${alerts.length} alerts by time from EDGAR acceptance`} className="lg:col-span-2">
              <Histogram gaps={gaps} />
            </Panel>
          </div>
        )
      )}

      {!empty && !loading && (
        <section className="mt-6">
          <h2 className="text-[15px] font-semibold">Latest alerts</h2>
          <p className="mt-1 text-[13px] text-ink-3">The 20 most recent, New York time.</p>
          <div className="mt-3 overflow-x-auto rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]" tabIndex={0} role="region" aria-label="Latest alerts and their latency">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  <th className="px-5 py-2.5 font-medium">Filer</th>
                  <th className="px-3 py-2.5 font-medium">Form</th>
                  <th className="px-3 py-2.5 font-medium">Channel</th>
                  <th className="px-3 py-2.5 font-medium">EDGAR accepted</th>
                  <th className="px-3 py-2.5 font-medium">Delivered</th>
                  <th className="px-5 py-2.5 text-right font-medium">Seconds</th>
                </tr>
              </thead>
              <tbody>
                {alerts.slice(0, 20).map((a) => (
                  <tr key={a.accession + a.sent_at} className="border-b border-line last:border-0">
                    <td className="px-5 py-2.5">
                      <Link to={`/investors/${a.slug}/`} className="font-medium hover:text-accent">
                        {a.manager}
                      </Link>
                      {a.quarter && <span className="ml-1.5 text-[11.5px] text-ink-3">{quarterLabel(a.quarter)}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-2">{a.form}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-2">{CHANNELS.find(([k]) => k === (a.channel ?? 'email'))?.[1] ?? a.channel}</td>
                    <td className="num whitespace-nowrap px-3 py-2.5 text-ink-2">{time(a.accepted_at)}</td>
                    <td className="num whitespace-nowrap px-3 py-2.5 text-ink-2">{time(a.sent_at)}</td>
                    <td className="num px-5 py-2.5 text-right font-medium" title={gapLabel(a.gap_seconds)}>
                      {Math.round(a.gap_seconds).toLocaleString('en-US')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mt-10 max-w-3xl">
        <h2 className="text-[15px] font-semibold">How we measure</h2>
        <ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-ink-2">
          <li>
            <span className="font-medium text-ink">Start:</span> EDGAR’s acceptance time on the filing itself, not when we noticed it.
          </li>
          <li>
            <span className="font-medium text-ink">End:</span> when the alert left us for its destination (for email, when our mail provider accepted it). Your inbox or chat app can add a few seconds.
          </li>
          <li>
            <span className="font-medium text-ink">Counted:</span> live alerts only. Replays, backfills and test messages are left out, and slow alerts stay in.
          </li>
          <li>
            <span className="font-medium text-ink">Coverage:</span> 13F alerts for the managers we track closely, and Form 4 and 13D/G alerts on the names members follow. How the data is built is on the{' '}
            <Link to="/methodology/" className="font-medium text-accent hover:text-accent-2">
              methodology page
            </Link>
            .
          </li>
        </ul>
      </section>

      <Signup source="speed" className="mt-10" />
    </div>
  )
}

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
