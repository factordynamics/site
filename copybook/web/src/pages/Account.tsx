import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { WaitlistForm } from '../components/Waitlist'
import { Arrow, Badge, Button, Check, Skeleton } from '../components/ui'
import { api, checkout, DATA_TERMS, RENEWAL_TERMS } from '../config'
import { fetchMe, getToken, openPortal, requestLogin, setAlerts, signOut, startSession, type Member } from '../lib/account'

type State = { kind: 'loading' } | { kind: 'in'; member: Member; welcome: boolean } | { kind: 'out'; error?: string } | { kind: 'off' }

export function Account() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const [state, setState] = useState<State>(() => (api ? { kind: 'loading' } : { kind: 'off' }))

  useEffect(() => {
    if (!api) return
    const sid = params.get('session_id')
    const login = params.get('login')
    const welcome = params.get('checkout') === 'success'
    const run = async () => {
      try {
        let member: Member
        if (sid?.startsWith('cs_')) member = await startSession({ checkout_session: sid })
        else if (login) member = await startSession({ login })
        else if (getToken()) member = await fetchMe()
        else return setState({ kind: 'out' })
        setState({ kind: 'in', member, welcome })
      } catch {
        setState({ kind: 'out', error: sid || login ? 'That sign-in link has expired. Enter your email for a new one.' : undefined })
      }
      if (sid || login) nav('/account/', { replace: true })
    }
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="container-x max-w-3xl pt-12 md:pt-16">
      {state.kind === 'loading' && (
        <div className="space-y-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="mt-8 h-40 w-full" />
        </div>
      )}
      {state.kind === 'in' && <SignedIn member={state.member} welcome={state.welcome} onOut={() => setState({ kind: 'out' })} onChange={(member) => setState({ kind: 'in', member, welcome: false })} />}
      {state.kind === 'out' && <SignedOut error={state.error} />}
      {state.kind === 'off' && <NotOpen />}
      <p className="mt-10 text-[13px] leading-relaxed text-ink-3">{DATA_TERMS}</p>
    </div>
  )
}

function SignedIn({ member, welcome, onOut, onChange }: { member: Member; welcome: boolean; onOut: () => void; onChange: (m: Member) => void }) {
  const [busy, setBusy] = useState(false)
  const end = member.period_end ? new Date(typeof member.period_end === 'number' ? member.period_end * 1000 : member.period_end) : null
  const alertsOn = member.alerts !== 'off'
  return (
    <>
      <header>
        {welcome ? (
          <>
            <span className="inline-flex size-11 items-center justify-center rounded-full bg-up text-white">
              <Check />
            </span>
            <h1 className="mt-5 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Welcome to Copy.</h1>
            <p className="mt-3 text-[17px] text-ink-2">Your payment went through. Stripe is emailing your receipt.</p>
          </>
        ) : (
          <>
            <p className="text-[13px] font-medium text-accent">Account</p>
            <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Your Copy subscription.</h1>
          </>
        )}
      </header>
      <div className="mt-10 grid gap-5 md:grid-cols-2">
        <section className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Plan</h2>
            <Badge tone={member.active ? 'up' : 'warn'}>{member.active ? 'Active' : member.status}</Badge>
          </div>
          <p className="mt-3 text-[14px] text-ink-2">{member.email}</p>
          <p className="mt-1 text-[14px] text-ink-2">
            Copy {member.plan === 'yearly' ? 'yearly' : 'monthly'}
            {end && ` · ${member.active ? 'renews' : 'ends'} ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
          </p>
          <Button
            variant="dark"
            className="mt-5"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              openPortal().catch(() => {
                setBusy(false)
                if (checkout.portal) window.location.href = checkout.portal
              })
            }}
          >
            {busy ? 'Opening…' : 'Manage billing'} <Arrow />
          </Button>
          <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">{RENEWAL_TERMS}</p>
        </section>
        <section className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
          <h2 className="text-[15px] font-semibold">Filing alerts</h2>
          <p className="mt-1 text-[14px] text-ink-2">An email the day an investor you follow files a new 13F.</p>
          <label className="mt-5 flex cursor-pointer items-center gap-3 text-[14px]">
            <input
              type="checkbox"
              className="size-4 accent-[var(--color-accent)]"
              checked={alertsOn}
              onChange={(e) => setAlerts(e.target.checked ? 'all' : 'off').then(onChange, () => null)}
            />
            {alertsOn ? (Array.isArray(member.alerts) ? `On for ${member.alerts.length} investors` : 'On for every investor') : 'Off'}
          </label>
        </section>
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button to="/investors/">Browse investors</Button>
        <Button
          variant="ghost"
          onClick={() => {
            signOut()
            onOut()
          }}
        >
          Sign out
        </Button>
      </div>
    </>
  )
}

function SignedOut({ error }: { error?: string }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  return (
    <>
      <header>
        <p className="text-[13px] font-medium text-accent">Account</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Sign in to Copy.</h1>
        <p className="mt-3 text-[17px] text-ink-2">No password. We’ll email you a sign-in link.</p>
      </header>
      {error && <p className="mt-6 rounded-xl bg-[#f6ead2] px-4 py-3 text-[14px] text-[#7a5410]">{error}</p>}
      <section className="mt-8 max-w-lg rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
        {sent ? (
          <p role="status" className="text-[15px]">
            If that address has Copy, a sign-in link is on its way.
          </p>
        ) : (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault()
              requestLogin(email.trim()).finally(() => setSent(true))
            }}
          >
            <label htmlFor="login-email" className="sr-only">
              Email address
            </label>
            <input
              id="login-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="h-11 min-w-0 flex-1 rounded-full bg-paper px-4 text-[15px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
            />
            <Button type="submit" className="h-11">
              Email me a link
            </Button>
          </form>
        )}
      </section>
      <p className="mt-6 text-[14px] text-ink-2">
        Don’t have Copy yet?{' '}
        <Button to="/pricing/" variant="ghost" size="sm">
          See plans <Arrow />
        </Button>
      </p>
    </>
  )
}

function NotOpen() {
  return (
    <>
      <header>
        <p className="text-[13px] font-medium text-accent">Account</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Copy opens with the Q3 filings.</h1>
        <p className="mt-3 text-[17px] text-ink-2">Quarter-over-quarter changes, full history, filing-day alerts and CSV export. Join and we’ll email you the moment it opens.</p>
      </header>
      <div className="mt-8 max-w-lg">
        <WaitlistForm id="wl-account" />
      </div>
    </>
  )
}
