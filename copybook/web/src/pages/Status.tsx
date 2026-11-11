import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Skeleton } from '../components/ui'
import { apiReady } from '../config'
import { loadLatency, type Latency } from '../lib/account'
import { useAsync, useTick, useTitle } from '../lib/data'
import { HOST_MOVE, HOSTING, INCIDENT_RULE, INCIDENTS } from '../lib/hosting'
import { DATA, displayName } from '../lib/data'
import { loadExpected } from '../lib/stocks'
import { isEdgarDay } from '../lib/calendar.mjs'

// /status/: live state of each part of Copybook, read in the browser from the same public sources the site
// uses (api.json and latency.json on R2, and the API's /health), rechecked every minute. Nothing is typed in
// by hand except the incident list, which /speed/ shares.

type Health = {
  ok?: boolean
  poller_host?: string | null
  poller_last_run?: string | null
  poller_age_s?: number | null
  api_up_since?: string | null
  /** Routes the API reports as slow or failing, once /health lists them. */
  degraded?: (string | { route?: string; path?: string; note?: string; status?: string })[] | null
}
type Probe = { base: string; at: string | null; health: Health | null; ms: number | null }

type Window = { uptime: number | null; checks: number; failed: number }
/** Payments' status.json, written by Cloudflare's cron every minute: 13F alert health and the API probe. */
type StatusFile = {
  generated_at?: string
  alerts_13f?: { state: 'ok' | 'amber'; reasons?: string[]; pending_moves?: number; oldest_pending_seconds?: number | null; reset_queue?: number }
  probe?: { target?: string; interval_seconds?: number; '24h'?: Window; '7d'?: Window; daily?: (Window & { day: string })[] }
  /** Moves still to send for filed 13Fs (payments; field names read loosely until its shape is fixed). */
  moves_queue?: { pending?: number; count?: number; oldest_wait_seconds?: number | null; oldest_seconds?: number | null; oldest_pending_seconds?: number | null } | null
  freshness?: { last_13f?: { manager: string; accepted_at: string } | null }
  restarts?: { unplanned_7d: number; deploys_7d: number; short_unconfirmed_7d: number; rows?: { at: string; down_seconds: number; kind: 'deploy' | 'unplanned' | 'short_unconfirmed'; build?: string | null; prev_build?: string | null; note?: string }[] }
}
const KIND = { deploy: 'Deploy', unplanned: 'Unplanned restart', short_unconfirmed: 'Short restart, cause unconfirmed' } as const
const STATUS_URL = String(import.meta.env.VITE_LATENCY_URL).replace(/latency\.json$/, 'status.json')

const API_JSON = import.meta.env.VITE_API_JSON_URL as string
const POLLER_LATE_S = 5 * 60

async function probe(): Promise<Probe> {
  const base = await apiReady
  const at = await fetch(`${API_JSON}?m=${Math.floor(Date.now() / 60_000)}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ at?: string }>) : null))
    .then((j) => j?.at ?? null)
    .catch(() => null)
  const t0 = performance.now()
  const health = await fetch(`${base}/health`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? (r.json() as Promise<Health>) : null))
    .catch(() => null)
  return { base, at, health, ms: health ? Math.round(performance.now() - t0) : null }
}

const ago = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 90 * 60 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`)
const utc = (t: string) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }) + ' UTC'
const host = (u: string) => {
  try {
    return new URL(u).host
  } catch {
    return u
  }
}
const pct = (v: number) => `${(v <= 1 ? v * 100 : v).toFixed(2)}%`

type Tone = 'up' | 'warn' | 'down' | 'wait' | 'none'
const DOT: Record<Tone, string> = { up: 'bg-up', warn: 'bg-[#d98a00]', down: 'bg-down', wait: 'bg-ink/20 animate-pulse', none: 'bg-ink/20' }
const WORD: Record<Tone, string> = { up: 'text-up', warn: 'text-[#7a4b00]', down: 'text-down', wait: 'text-ink-3', none: 'text-ink-2' }

function Row({ name, tone, state, children }: { name: string; tone: Tone; state: string; children?: ReactNode }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-6">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />
        <span className="text-[15px] font-medium">{name}</span>
      </div>
      <div className="text-[14px] leading-relaxed text-ink-2">
        <span className={`font-medium ${WORD[tone]}`}>{state}</span>
        {children && <span className="block text-ink-3">{children}</span>}
      </div>
    </div>
  )
}

export function Status() {
  useTitle('Status · Copybook')
  const tick = useTick(60_000, true)
  const p = useAsync(probe, [tick])
  const lat = useAsync(loadLatency, [tick])
  const st = useAsync(() => fetch(`${STATUS_URL}?m=${Math.floor(Date.now() / 60_000)}`).then((r) => (r.ok ? (r.json() as Promise<StatusFile>) : null)).catch(() => null), [tick])
  // Re-render the "N s ago" lines between checks.
  const [, setNow] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  const pr = p.data
  // Data: freshness from the last data build, and ingest's corrections and incidents (data/changelog.json).
  const fresh = useAsync(loadExpected, [tick])
  const log = useAsync(() => fetch(`${DATA}changelog.json`).then((r) => (r.ok ? (r.json() as Promise<{ entries: { id: string; date: string; kind: string; title: string }[] }>) : null)), [])
  const builtAt = fresh.data?.generated_at ? Date.parse(fresh.data.generated_at) : null
  const lagS = builtAt ? (Date.now() - builtAt) / 1000 : null
  const filingDay = isEdgarDay(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }))
  const dataTone: Tone = lagS == null ? (fresh.loading ? 'wait' : 'warn') : filingDay && lagS > 2 * 3600 ? 'warn' : 'up'
  // The newest 13F by EDGAR acceptance: payments' status.json once it has read a build, else the site build's.
  const newest13f = st.data?.freshness?.last_13f
    ? { manager: st.data.freshness.last_13f.manager, at: `accepted ${utc(st.data.freshness.last_13f.accepted_at)}` }
    : fresh.data?.latest_13f
      ? { manager: fresh.data.latest_13f.manager, at: fresh.data.latest_13f.accepted_at ? `accepted ${utc(fresh.data.latest_13f.accepted_at)}` : `filed ${new Date(`${fresh.data.latest_13f.filing_date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}` }
      : null
  const dataIssues = (log.data?.entries ?? []).filter((e) => e.kind === 'correction' || e.kind === 'incident')
  const l = lat.data as Latency | null | undefined
  const h = pr?.health ?? null
  const checking = !pr

  // The poller's latest run, from whichever source saw it most recently.
  const runs = [h?.poller_last_run, l?.poller_last_run].filter((x): x is string => Boolean(x)).map((x) => ({ x, t: Date.parse(x) }))
  const last = runs.sort((a, b) => b.t - a.t)[0]
  const pollerHost = (last && (last.x === h?.poller_last_run ? h?.poller_host : l?.poller_host)) ?? h?.poller_host ?? l?.poller_host
  const pollerAge = last ? (Date.now() - last.t) / 1000 : null
  const pollerTone: Tone = pollerAge == null ? (lat.loading && checking ? 'wait' : 'warn') : pollerAge < POLLER_LATE_S ? 'up' : 'down'
  // Payments' 13F health signal: amber while a 13F waits over 10 minutes for its moves or alert email is held.
  const a13 = st.data?.alerts_13f
  const mq = st.data?.moves_queue
  const pending = mq ? (mq.pending ?? mq.count ?? 0) : (a13?.pending_moves ?? 0)
  const oldest = mq ? (mq.oldest_wait_seconds ?? mq.oldest_seconds ?? mq.oldest_pending_seconds ?? null) : (a13?.oldest_pending_seconds ?? null)
  const late = a13?.state === 'amber' || (pending > 0 && (oldest ?? 0) > 600)
  const alertsTone: Tone = pollerTone === 'up' && late ? 'warn' : pollerTone
  const pr24 = st.data?.probe?.['24h']
  const pr7 = st.data?.probe?.['7d']
  const days = st.data?.probe?.daily ?? []
  // A percentage from a few dozen checks misleads: show one only once about a full day (90% of 1,440 minutes) is measured.
  const rs = st.data?.restarts
  const full24 = (pr24?.checks ?? 0) >= 1296

  const apiTone: Tone = checking ? 'wait' : h ? 'up' : 'down'
  const degraded = (h?.degraded ?? []).map((d) => (typeof d === 'string' ? d : [d.route ?? d.path, d.note ?? d.status].filter(Boolean).join(': ')))

  const overall: { tone: Tone; text: string } = checking
    ? { tone: 'wait', text: 'Checking…' }
    : apiTone === 'down' && pollerTone === 'down'
      ? { tone: 'down', text: 'Alerts and member pages are down' }
      : apiTone === 'down'
        ? { tone: 'down', text: 'Member pages and the API are unavailable. Filing alerts still go out.' }
        : pollerTone === 'down' || alertsTone === 'warn'
          ? { tone: 'warn', text: 'Filing alerts are delayed' }
          : degraded.length
            ? { tone: 'warn', text: 'Some API routes are degraded' }
            : lagS != null && dataTone === 'warn'
              ? { tone: 'warn', text: 'Filing data is behind' }
            : { tone: 'up', text: 'All systems normal' }

  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Status</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Copybook status.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          Checked live from your browser against the same public sources the site uses, and rechecked every minute. Alert timings are on the{' '}
          <Link to="/speed/" className="font-medium text-accent hover:text-accent-2">
            speed page
          </Link>
          .
        </p>
      </header>

      <section className="mt-10 max-w-3xl rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]" aria-live="polite">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4 md:px-6">
          <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${DOT[overall.tone]}`} />
          <p className="text-[17px] font-semibold tracking-[-0.01em]">{overall.text}</p>
        </div>
        <div className="divide-y divide-line px-5 md:px-6">
          {checking ? (
            <div className="space-y-3 py-5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ) : (
            <>
              <Row name="Member API" tone={apiTone} state={h ? `Up · answered in ${pr!.ms} ms` : 'Not answering'}>
                A personal machine, via a temporary Cloudflare quick tunnel · {host(pr!.base)}
                {pr!.at ? ` · address since ${utc(pr!.at)}` : ''}
                {h?.api_up_since ? ` · running since ${utc(h.api_up_since)}` : ''}
              </Row>
              <Row
                name="Filing alerts"
                tone={alertsTone}
                state={pollerAge == null ? 'No recent poller run on record' : `${alertsTone === 'warn' ? '13F alerts delayed · ' : ''}EDGAR poller ${pollerAge < 120 ? 'ran within the last 2 min' : `last ran ${ago(pollerAge)} ago`} · ${pollerHost === 'cloudflare' ? 'Cloudflare' : 'backup'}`}
              >
                {(a13 || mq) && (
                  <span className="block">
                    13F alert health: {late ? 'delayed' : 'normal'} · 13F moves pending: {pending}.{' '}
                    {!late
                      ? ''
                      : pending === 1
                        ? `One 13F alert is waiting for its moves${oldest ? ` (${ago(oldest)} so far)` : ''}. `
                        : pending
                          ? `${pending} 13F alerts are waiting for their moves${oldest ? `, the oldest for ${ago(oldest)}` : ''}. `
                          : ''}
                    {a13?.reset_queue ? `${a13.reset_queue} alert ${a13.reset_queue === 1 ? 'email is' : 'emails are'} held until the daily sending limit resets. ` : ''}
                    {late && !pending && !a13?.reset_queue && a13?.reasons?.length ? `${a13.reasons.join('; ')}. ` : ''}
                  </span>
                )}
                {pollerHost === 'cloudflare' || pollerHost == null ? 'Checks EDGAR every minute from Cloudflare, with the API machine as backup.' : 'Cloudflare’s checks paused; the API machine is polling EDGAR as backup.'}
              </Row>
              <Row name="Filing data" tone={dataTone} state={lagS == null ? 'Not known yet' : `Last data build ${ago(lagS)} ago${dataTone === 'warn' ? ', later than usual for a filing day' : ''}`}>
                {newest13f ? `Newest 13F in the data: ${displayName(newest13f.manager)}, ${newest13f.at}. ` : ''}
                Rebuilt about every 20 minutes on filing days; past 2 hours this turns amber.
              </Row>
              <Row name="Filing pages" tone="up" state="Up">
                Stock, fund and filing pages are static files, so they stay up when the member API is down.
              </Row>
              {degraded.length > 0 && (
                <Row name="Degraded routes" tone="warn" state={`${degraded.length} ${degraded.length === 1 ? 'route' : 'routes'}`}>
                  {degraded.join(' · ')}
                </Row>
              )}
              <Row
                name="Member API uptime"
                tone={!full24 ? 'none' : (pr7?.uptime ?? 0) >= 0.999 ? 'up' : 'warn'}
                state={!full24 ? 'Not measured yet' : `${pct(pr24!.uptime ?? 0)} last 24 h (${pr24!.checks.toLocaleString('en-US')} checks) · ${pct(pr7!.uptime ?? 0)} last 7 days (${pr7!.checks.toLocaleString('en-US')} checks)`}
              >
                {full24 && pr7 ? (
                  <>
                    <span className="mt-2 flex items-end gap-1.5" aria-label="Uptime by day, oldest first">
                      {days.map((d) => (
                        <span key={d.day} className="flex w-9 flex-col items-center gap-1">
                          <span
                            title={d.checks ? `${d.day}: ${pct(d.uptime ?? 0)} of ${d.checks} checks` : `${d.day}: not measured`}
                            className={`h-7 w-full rounded-[5px] ${!d.checks ? 'bg-ink/10' : (d.uptime ?? 0) >= 0.999 ? 'bg-up/80' : (d.uptime ?? 0) >= 0.99 ? 'bg-[#d98a00]/80' : 'bg-down/80'}`}
                          />
                          <span className="num text-[11px] text-ink-3">{new Date(`${d.day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}</span>
                        </span>
                      ))}
                    </span>
                    <span className="mt-2 block">
                      Checked every minute from Cloudflare against the API’s /health since {new Date(`${days.find((d) => d.checks)?.day ?? st.data!.generated_at!.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}; {pr7.failed} of {pr7.checks.toLocaleString('en-US')} checks failed. Grey days weren’t measured. There is no uptime SLA.
                    </span>
                  </>
                ) : (
                  `Checked every minute from Cloudflare against the API’s /health${pr24?.checks ? `: ${pr24.checks.toLocaleString('en-US')} checks so far` : ''}. Figures appear once a full 24 hours is measured. There is no uptime SLA.`
                )}
              </Row>
            </>
          )}
        </div>
      </section>

      <section className="mt-10 max-w-3xl">
        <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Incidents</h2>
        <p className="mt-1.5 text-[13.5px] text-ink-3">{INCIDENT_RULE}</p>
        <ol className="mt-3 divide-y divide-line rounded-[var(--radius-card)] bg-card px-5 shadow-[var(--shadow-card)]">
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
        {rs && (
          <>
            <h3 className="mt-6 text-[15px] font-semibold">Restarts, last 7 days</h3>
            <p className="mt-1 text-[13.5px] text-ink-3">
              {rs.deploys_7d} {rs.deploys_7d === 1 ? 'deploy' : 'deploys'} · {rs.unplanned_7d} unplanned · {rs.short_unconfirmed_7d} short, cause unconfirmed. A deploy is a new build back up in under 60 seconds.
            </p>
            {rs.rows?.length ? (
              <ol className="mt-2 divide-y divide-line rounded-[var(--radius-card)] bg-card px-5 shadow-[var(--shadow-card)]">
                {rs.rows.map((r) => (
                  <li key={r.at} className="grid gap-x-4 py-2.5 text-[13.5px] sm:grid-cols-[9.5rem_minmax(0,1fr)_auto]">
                    <span className="num text-ink-3">{utc(r.at)}</span>
                    <span className="min-w-0 text-ink-2">
                      {KIND[r.kind] ?? r.kind}
                      {r.build ? (
                        <span className="font-mono text-[12.5px] text-ink-3">
                          {' '}
                          {r.prev_build ? `${r.prev_build.slice(0, 7)} → ` : ''}
                          {r.build.slice(0, 7)}
                        </span>
                      ) : null}
                    </span>
                    <span className={`num ${r.down_seconds ? 'text-ink-2' : 'text-ink-3'}`}>{r.down_seconds ? `${r.down_seconds} s down` : 'no downtime'}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        )}
        <p className="mt-4 text-[14px] leading-relaxed text-ink-2">{HOSTING.shared}</p>
        <p className="mt-3 text-[14px] leading-relaxed text-ink-2">{HOST_MOVE}</p>
        <p className="mt-4 text-[14px] leading-relaxed text-ink-2">
          What happens to alerts during each kind of outage is on the{' '}
          <Link to="/speed/#availability" className="font-medium text-accent hover:text-accent-2">
            speed page
          </Link>
          ; how the API host is run and protected is on{' '}
          <Link to="/security/" className="font-medium text-accent hover:text-accent-2">
            security
          </Link>
          .
        </p>
        <p className="mt-2 text-[13px] text-ink-3">
          Sources:{' '}
          <a href={API_JSON} className="font-mono text-accent hover:text-accent-2">
            api.json
          </a>
          ,{' '}
          <a href={import.meta.env.VITE_LATENCY_URL} className="font-mono text-accent hover:text-accent-2">
            latency.json
          </a>{' '}
          ,{' '}
          <a href={STATUS_URL} className="font-mono text-accent hover:text-accent-2">
            status.json
          </a>{' '}
          and the API’s <code className="font-mono">/health</code>.
        </p>
      </section>

      <section className="mt-10 max-w-3xl" aria-labelledby="data">
        <h2 id="data" className="text-[22px] font-semibold tracking-[-0.02em]">
          Data
        </h2>
        <p className="mt-1.5 text-[13.5px] text-ink-3">Errors in the filing data and how they were fixed, newest first. Each links to its entry in the methodology changelog.</p>
        {log.loading ? (
          <Skeleton className="mt-3 h-24 w-full" />
        ) : dataIssues.length ? (
          <ol className="mt-3 divide-y divide-line rounded-[var(--radius-card)] bg-card px-5 shadow-[var(--shadow-card)]">
            {dataIssues.map((e) => (
              <li key={e.id} className="py-3 text-[14px] leading-relaxed">
                <span className="num block text-[12.5px] text-ink-3">
                  {new Date(`${e.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} · {e.kind === 'incident' ? 'Incident' : 'Correction'}
                </span>
                <Link to={`/methodology/#${e.id}`} className="text-ink-2 hover:text-accent">
                  {e.title}
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 text-[14px] text-ink-2">The methodology changelog didn’t load. It’s on the <Link to="/methodology/" className="font-medium text-accent hover:text-accent-2">methodology page</Link>.</p>
        )}
      </section>
    </div>
  )
}
