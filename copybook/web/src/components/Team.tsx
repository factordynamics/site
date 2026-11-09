import { useEffect, useState } from 'react'
import { ApiError, call } from '../lib/account'
import { Button } from './ui'

// Copy Fund seats (owner only): GET/POST {api}/seats, DELETE /seats/{email}. Each seat gets its own
// sign-in link by email; follows, watchlist, owned book and peers are shared by the whole team.
type Seats = { max: number; active?: number; seats: { email: string; invited_at?: number | string | null }[] }

const ERR: Record<string, string> = {
  seat_exists: 'That address already has a seat.',
  seat_limit: 'All 5 seats are in use. Remove one to invite someone else.',
  email_taken: 'That address has its own Copybook account, so it can’t join as a seat. Ask them to cancel it first, or use another address.',
}
const when = (t?: number | string | null) => {
  const d = typeof t === 'number' ? new Date(t < 1e12 ? t * 1000 : t) : t ? new Date(t) : null
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null
}

export function Team() {
  const [s, setS] = useState<Seats | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    call<Seats>('/seats', { auth: true }).then(setS, () => setMsg({ text: 'Your team didn’t load. Refresh to try again.', ok: false }))
  }, [])

  const invite = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await call<Seats>('/seats', { body: { email: email.trim() }, auth: true })
      setS(r)
      window.dispatchEvent(new Event('copybook:setup'))
      setMsg({ text: `Invited ${email.trim()}. They’ll get an email with their own sign-in link.`, ok: true })
      setEmail('')
    } catch (e) {
      setMsg({ text: (e instanceof ApiError && ((e.code && ERR[e.code]) || e.detail)) || 'That invite didn’t go out. Please try again.', ok: false })
    } finally {
      setBusy(false)
    }
  }
  const remove = async (who: string) => {
    if (!confirm(`Remove ${who} from your team? They lose access straight away.`)) return
    setMsg(null)
    try {
      setS(await call<Seats>(`/seats/${encodeURIComponent(who)}`, { method: 'DELETE', auth: true }))
      window.dispatchEvent(new Event('copybook:setup'))
    } catch {
      setMsg({ text: `${who} wasn’t removed. Please try again.`, ok: false })
    }
  }

  const used = s ? s.seats.length : 0
  const max = s?.max ?? 5
  return (
    <section id="team" className="mt-5 scroll-mt-24 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">Team</h2>
          <p className="mt-1 text-[14px] text-ink-2">Invite up to {max} colleagues. Each signs in with their own email and keeps their own alert settings and channels; follows, the watchlist, the owned book and peers are shared by the whole team.</p>
        </div>
        {s && (
          <span className="text-[13px] text-ink-3">
            {used} of {max} seats
          </span>
        )}
      </div>

      {!s && !msg ? (
        <div className="mt-4 h-24 animate-pulse rounded-xl bg-ink/[0.04]" />
      ) : (
        s && (
          <ul className="mt-4 divide-y divide-line rounded-xl shadow-[0_0_0_1px_var(--color-line)]">
            {s.seats.length === 0 && <li className="px-4 py-3 text-[14px] text-ink-3">No one else yet.</li>}
            {s.seats.map((x) => (
              <li key={x.email} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[14px]">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{x.email}</span>
                  {when(x.invited_at) && <span className="block text-[12.5px] text-ink-3">Invited {when(x.invited_at)}</span>}
                </span>
                <Button size="sm" variant="ghost" onClick={() => remove(x.email)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )
      )}

      {s && used < max && (
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            invite()
          }}
        >
          <label htmlFor="seat-email" className="sr-only">
            Colleague’s email
          </label>
          <input
            id="seat-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@yourfund.com"
            autoComplete="off"
            className="h-10 min-w-0 flex-1 basis-64 rounded-xl bg-paper px-3.5 text-[14px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
          />
          <Button type="submit" size="sm" className="h-10" disabled={busy}>
            {busy ? 'Inviting…' : 'Invite'}
          </Button>
        </form>
      )}
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} className={`mt-2 text-[13px] ${msg.ok ? 'text-up' : 'text-down'}`}>
          {msg.text}
        </p>
      )}
    </section>
  )
}
