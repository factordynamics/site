import { useCallback, useEffect, useState } from 'react'
import { ApiError, call, downloadFile, errText } from '../lib/account'
import { Badge, Button } from './ui'

// The access log (payments' GET /team/access for a Fund owner, GET /me/access for every member): sign-ins, API keys,
// changes, downloads and every operator access, the last 90 days of a year-long, append-only log, plus `use[]`: one
// row per hour, seat, key or session, network (/24) and class. Country comes from Cloudflare; the network is a /24
// (IPv6 /48), never the IP. Before the API serves these routes (404), neither panel shows.

type Key = { id: string; name: string; prefix: string; created: string | null; last_used_at: string | null }
type Ev = { at: string; seat?: string; kind: string; by: 'self' | 'owner' | 'operator'; country: string | null; ip24?: string | null; detail?: string | null; key?: { id: string; name: string } | null; reason?: string | null }
type Seat = { email: string; role: 'owner' | 'seat'; status: 'owner' | 'invited' | 'active' | 'revoked' | 'removed'; invited_at: string | null; removed_at: string | null; last_sign_in: string | null; last_api_use: string | null; key_count: number; keys: Key[] }
type Use = { hour: string; seat?: string; via: 'key' | 'session' | 'feed'; key: { id: string; name: string } | null; ip24: string | null; class: 'bulk' | 'api' | 'feed' | 'account'; count: number }
type TeamAccessData = { shown_days: number; seats: Seat[]; events: Ev[]; use?: Use[] }
type MyAccessData = { shown_days: number; last_sign_in: string | null; last_api_use: string | null; keys: Key[]; events: Ev[]; use?: Use[]; operator: { at: string; detail: string; reason: string | null }[] }

const KIND: Record<string, string> = {
  invite: 'Invited',
  sign_in: 'Signed in',
  key_created: 'API key made',
  key_deleted: 'API key deleted',
  revoke: 'Signed out everywhere',
  removal: 'Seat removed',
  channel_change: 'Alert channels changed',
  webhook_change: 'Webhook changed',
  csv_download: 'CSV downloaded',
  bulk_download: 'Bulk file downloaded',
  operator: 'Operator access',
}
const BY: Record<Ev['by'], string> = { self: '', owner: 'by the plan owner', operator: 'by Copybook support' }
const STATUS: Record<Seat['status'], { label: string; tone: 'up' | 'accent' | 'down' | 'neutral' }> = {
  owner: { label: 'Owner', tone: 'accent' },
  invited: { label: 'Invited', tone: 'neutral' },
  active: { label: 'Active', tone: 'up' },
  revoked: { label: 'Signed out everywhere', tone: 'down' },
  removed: { label: 'Removed', tone: 'neutral' },
}
const CLASS: Record<Use['class'], string> = { bulk: 'Bulk files', api: 'API', feed: 'Feed', account: 'Account' }
const RULES = 'Entries are kept for a year and shown here for 90 days. The log is append-only: nothing edits or deletes an entry. It is erased with the account.'
const NET = 'Country comes from the network, and we keep only the network block (a /24), never the full IP address.'

const region = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()
const place = (c: string | null) => (c ? (region?.of(c.toUpperCase()) ?? c.toUpperCase()) : null)
const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never')
const hourLabel = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'never')

/** Loads one access route; `null` data with no error means the route isn't served yet, and the panel stays hidden. */
function useAccess<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  const [hidden, setHidden] = useState(false)
  const load = useCallback(() => {
    call<T>(path, { auth: true }).then(
      (d) => {
        setData(d)
        setErr('')
      },
      (e) => {
        if (e instanceof ApiError && (e.status === 404 || e.code === 'seat' || e.code === 'fund_required')) setHidden(true)
        else setErr(errText(e, 'The access log didn’t load. Refresh to try again.'))
      },
    )
  }, [path])
  useEffect(load, [load])
  return { data, err, hidden, load }
}

function EventList({ events, team }: { events: Ev[]; team?: boolean }) {
  const [all, setAll] = useState(false)
  if (!events.length) return <p className="mt-3 text-[13.5px] text-ink-3">Nothing in the last 90 days.</p>
  const shown = all ? events : events.slice(0, 12)
  return (
    <>
      <ol className="mt-3 divide-y divide-line text-[13.5px]">
        {shown.map((e, i) => (
          <li key={`${e.at}-${i}`} className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
            <span className="num text-[12.5px] text-ink-3">{at(e.at)}</span>
            <span className="min-w-0">
              <span className="font-medium text-ink">{KIND[e.kind] ?? e.kind}</span>
              {e.key && <span className="text-ink-2"> · key “{e.key.name}”</span>}
              {e.detail && <span className="text-ink-2"> · {e.detail}</span>}
              <span className="block text-[12.5px] text-ink-3">
                {[team && e.seat, BY[e.by], [place(e.country), e.ip24].filter(Boolean).join(', '), e.reason && `reason: ${e.reason}`].filter(Boolean).join(' · ')}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {events.length > 12 && (
        <button type="button" onClick={() => setAll((x) => !x)} className="mt-2 text-[13px] font-medium text-accent hover:text-accent-2">
          {all ? 'Show fewer' : `Show all ${events.length}`}
        </button>
      )}
    </>
  )
}

/** `use[]`: who used the account, the API or a feed, hour by hour, through which key and from which network. */
function UseList({ use, team }: { use: Use[]; team?: boolean }) {
  const [all, setAll] = useState(false)
  if (!use.length) return <p className="mt-3 text-[13.5px] text-ink-3">No use in the last 90 days.</p>
  const shown = all ? use : use.slice(0, 12)
  return (
    <>
      <ol className="mt-3 divide-y divide-line text-[13.5px]">
        {shown.map((u, i) => (
          <li key={`${u.hour}-${i}`} className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[9.5rem_minmax(0,1fr)_auto]">
            <span className="num text-[12.5px] text-ink-3">{hourLabel(u.hour)}</span>
            <span className="min-w-0">
              <span className="font-medium text-ink">{team && u.seat ? u.seat : CLASS[u.class]}</span>
              <span className="text-ink-2"> · {u.via === 'key' ? (u.key ? `key “${u.key.name}”` : 'API key') : u.via === 'feed' ? 'feed link' : 'signed-in session'}</span>
              <span className="block text-[12.5px] text-ink-3">{[team && u.seat && CLASS[u.class], u.ip24 ?? 'network not recorded'].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="num text-[12.5px] text-ink-2 sm:text-right">
              {u.count.toLocaleString('en-US')} {u.count === 1 ? 'request' : 'requests'}
            </span>
          </li>
        ))}
      </ol>
      {use.length > 12 && (
        <button type="button" onClick={() => setAll((x) => !x)} className="mt-2 text-[13px] font-medium text-accent hover:text-accent-2">
          {all ? 'Show fewer' : `Show all ${use.length} hours`}
        </button>
      )}
    </>
  )
}

/** Every member: their own sign-ins, keys, changes and downloads, and each time the operator looked, with why. */
export function MyAccess() {
  const a = useAccess<MyAccessData>('/me/access')
  if (a.hidden || (!a.data && !a.err)) return null
  return (
    <section id="access" className="mt-5 scroll-mt-24 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
      <h2 className="text-[15px] font-semibold">Access to your account</h2>
      <p className="mt-1 text-[14px] text-ink-2">Every sign-in, API key, change and download on your account, and every time Copybook support opened it, with the reason.</p>
      {a.err ? (
        <p role="alert" className="mt-3 text-[13.5px] text-down">
          {a.err}
        </p>
      ) : (
        a.data && (
          <>
            <dl className="mt-4 grid gap-3 text-[13.5px] sm:grid-cols-3">
              {(
                [
                  ['Last sign-in', at(a.data.last_sign_in)],
                  ['Last API use', at(a.data.last_api_use)],
                  ['API keys', String(a.data.keys.length)],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-xl bg-ink/[0.03] px-3.5 py-2.5">
                  <dt className="text-[12px] text-ink-3">{k}</dt>
                  <dd className="num mt-0.5 font-medium text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            <h3 className="mt-5 text-[13px] font-medium text-ink-2">Operator access</h3>
            {a.data.operator.length ? (
              <ul className="mt-2 divide-y divide-line text-[13.5px]">
                {a.data.operator.map((o, i) => (
                  <li key={`${o.at}-${i}`} className="grid gap-x-4 py-2 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
                    <span className="num text-[12.5px] text-ink-3">{at(o.at)}</span>
                    <span className="text-ink-2">
                      <span className="font-mono text-[12.5px]">{o.detail}</span>
                      {o.reason && <span> · {o.reason}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13.5px] text-ink-3">Copybook support hasn’t opened your account in the last {a.data.shown_days} days.</p>
            )}
            {a.data.use && (
              <>
                <h3 className="mt-5 text-[13px] font-medium text-ink-2">Use by hour, last {a.data.shown_days} days</h3>
                <UseList use={a.data.use} />
              </>
            )}
            <h3 className="mt-5 text-[13px] font-medium text-ink-2">Activity, last {a.data.shown_days} days</h3>
            <EventList events={a.data.events.filter((e) => e.by !== 'operator')} />
            <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">
              {RULES} {NET}
            </p>
          </>
        )
      )}
    </section>
  )
}

/** Fund owner: each seat's sign-ins, last API use and keys (any of which the owner can delete), and the team's log. */
export function TeamAccess() {
  const [seat, setSeat] = useState('')
  const a = useAccess<TeamAccessData>(`/team/access${seat ? `?seat=${encodeURIComponent(seat)}` : ''}`)
  const [seats, setSeats] = useState<Seat[]>([])
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState('')
  // The seat list stays the whole team's while the log is filtered to one seat.
  useEffect(() => {
    if (a.data && !seat) setSeats(a.data.seats)
  }, [a.data, seat])
  if (a.hidden || (!a.data && !a.err)) return null

  const delKey = async (k: Key, owner: string) => {
    if (!confirm(`Delete the API key “${k.name}” (${k.prefix}…) of ${owner}? Anything using it stops working at once.`)) return
    setBusy(k.id)
    setMsg(null)
    try {
      await call(`/team/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE', auth: true })
      setMsg({ text: `Deleted “${k.name}” of ${owner}.`, ok: true })
      setSeats((all) => all.map((x) => (x.email === owner ? { ...x, keys: x.keys.filter((y) => y.id !== k.id), key_count: Math.max(0, x.key_count - 1) } : x)))
      if (seat) setSeat('')
      a.load()
    } catch (e) {
      setMsg({ text: errText(e, e instanceof ApiError && e.detail ? e.detail : 'That key wasn’t deleted. Please try again.'), ok: false })
    } finally {
      setBusy('')
    }
  }
  const csv = (part?: 'events') =>
    downloadFile(`/team/access?format=csv${part ? `&part=${part}` : ''}${seat ? `&seat=${encodeURIComponent(seat)}` : ''}`, part ? 'copybook-team-events.csv' : 'copybook-team-access.csv').catch((e) =>
      setMsg({ text: errText(e, 'The CSV didn’t download. Please try again.'), ok: false }),
    )
  const seatPicker = seats.length > 1 && (
    <label className="flex items-center gap-2 text-[13px] text-ink-2">
      Seat
      <select value={seat} onChange={(e) => setSeat(e.target.value)} className="h-9 max-w-[14rem] rounded-lg bg-paper px-2.5 text-[13px] shadow-[0_0_0_1px_var(--color-line-2)]">
        <option value="">Everyone</option>
        {seats.map((s) => (
          <option key={s.email} value={s.email}>
            {s.email}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <section id="team-access" className="mt-5 scroll-mt-24 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="text-[15px] font-semibold">Team access</h2>
          <p className="mt-1 text-[14px] text-ink-2">Who on your team used Copybook and the API, and when: hour by hour, by seat, key and network. You can delete any key on the team.</p>
        </div>
      </div>
      {a.err && (
        <p role="alert" className="mt-3 text-[13.5px] text-down">
          {a.err}
        </p>
      )}
      {a.data?.use && (
        <>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[13px] font-medium text-ink-2">Use by hour{seat ? `, ${seat}` : ''}, last {a.data.shown_days} days</h3>
            <div className="flex flex-wrap items-center gap-3">
              {seatPicker}
              <Button variant="outline" size="sm" onClick={() => csv()}>
                Download CSV
              </Button>
            </div>
          </div>
          <UseList use={a.data.use} team={!seat} />
        </>
      )}
      <h3 className="mt-6 text-[13px] font-medium text-ink-2">Seats and API keys</h3>
      {seats.length > 0 && (
        <ul className="mt-2 divide-y divide-line">
          {seats.map((s) => (
            <li key={s.email} className="py-3">
              <p className="flex flex-wrap items-center gap-2 text-[14px]">
                <span className="min-w-0 truncate font-medium text-ink">{s.email}</span>
                <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
              </p>
              <p className="num mt-1 text-[12.5px] text-ink-3">
                {s.status === 'invited' ? `Invited ${day(s.invited_at)}` : s.status === 'removed' ? `Removed ${day(s.removed_at)}` : `Last sign-in ${at(s.last_sign_in)}`} · last API use {at(s.last_api_use)} · {s.key_count} {s.key_count === 1 ? 'key' : 'keys'}
              </p>
              {s.keys.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {s.keys.map((k) => (
                    <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-ink/[0.03] px-3 py-2 text-[13px]">
                      <span className="font-medium text-ink">{k.name}</span>
                      <code className="font-mono text-[12px] text-ink-3">{k.prefix}…</code>
                      <span className="num text-[12.5px] text-ink-3">
                        made {day(k.created)} · last used {at(k.last_used_at)}
                      </span>
                      <button type="button" disabled={busy === k.id} onClick={() => delKey(k, s.email)} className="ml-auto text-[12.5px] font-medium text-ink-2 hover:text-down">
                        {busy === k.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} className={`mt-3 text-[13.5px] ${msg.ok ? 'text-up' : 'text-down'}`}>
          {msg.text}
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[13px] font-medium text-ink-2">Activity{seat ? `, ${seat}` : ''}, last {a.data?.shown_days ?? 90} days</h3>
        <div className="flex flex-wrap items-center gap-3">
          {!a.data?.use && seatPicker}
          <Button variant="outline" size="sm" onClick={() => csv(a.data?.use ? 'events' : undefined)}>
            Download CSV
          </Button>
        </div>
      </div>
      {a.data && <EventList events={a.data.events} team={!seat} />}
      <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">
        {RULES} {NET}
      </p>
    </section>
  )
}
