import { loadIndex, useAsync, useTitle } from '../lib/data'
import { Link } from 'react-router-dom'
import { Onboarding } from '../components/Onboarding'
import { resetFollows, saveFollows, useFollows } from '../lib/follows'
import { stockPath } from '../lib/stocks'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { WaitlistForm } from '../components/Waitlist'
import { Arrow, Badge, Button, Check, Monogram, Skeleton } from '../components/ui'
import { api, checkout, DATA_TERMS, RENEWAL_TERMS, TRIAL_TERMS } from '../config'
import { fetchMe, getToken, openPortal, requestLogin, setAlerts, signOut, startSession, type Member } from '../lib/account'

type State = { kind: 'loading' } | { kind: 'in'; member: Member; welcome: boolean } | { kind: 'out'; error?: string } | { kind: 'off' }

export function Account() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  useTitle('Account · Copybook')
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
        resetFollows()
        setState({ kind: 'in', member, welcome })
      } catch {
        setState({ kind: 'out', error: sid ? 'We couldn’t confirm that checkout. If you were charged, sign in to Stripe billing below or refresh in a minute.' : login ? 'That sign-in link has expired. Enter your email for a new one.' : undefined })
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
  const { status, follows } = useFollows()
  const [editing, setEditing] = useState(false)
  const end = member.period_end ? new Date(typeof member.period_end === 'number' ? member.period_end * 1000 : member.period_end) : null
  const endLabel = end?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const trial = member.status === 'trialing'
  const alertMode = member.alerts === 'off' ? 'off' : Array.isArray(member.alerts) ? 'follows' : 'all'
  const idx = useAsync(loadIndex, [])
  const names = new Map((idx.data?.managers ?? []).map((m) => [m.slug, m.manager]))
  const onboard = member.active && status === 'ready' && (!follows.onboarded || editing)
  return (
    <>
      <header>
        {welcome ? (
          <>
            <span className="inline-flex size-11 items-center justify-center rounded-full bg-up text-white">
              <Check />
            </span>
            <h1 className="mt-5 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Welcome to Copy.</h1>
            <p className="mt-3 text-[17px] text-ink-2">
              {trial ? `Your free trial runs until ${endLabel}. Stripe is emailing your confirmation.` : 'Your payment went through. Stripe is emailing your receipt.'}
            </p>
          </>
        ) : (
          <>
            <p className="text-[13px] font-medium text-accent">Account</p>
            <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Your Copy subscription.</h1>
          </>
        )}
      </header>

      {onboard && (
        <div className="mt-10">
          <Onboarding
            alerts={member.alerts}
            onDone={(m) => {
              setEditing(false)
              if (m) onChange(m)
            }}
          />
        </div>
      )}

      <div className="mt-10 grid gap-5 md:grid-cols-2">
        <section className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Plan</h2>
            <Badge tone={trial ? 'accent' : member.active ? 'up' : 'warn'}>{trial ? 'Free trial' : member.active ? 'Active' : member.status}</Badge>
          </div>
          <p className="mt-3 text-[14px] text-ink-2">{member.email}</p>
          <p className="mt-1 text-[14px] text-ink-2">
            Copy {member.plan === 'yearly' ? 'yearly' : 'monthly'}
            {endLabel && ` · ${trial ? `trial ends ${endLabel}` : member.active ? `renews ${endLabel}` : `ends ${endLabel}`}`}
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
          <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">{trial ? TRIAL_TERMS : RENEWAL_TERMS}</p>
        </section>
        <section className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
          <h2 className="text-[15px] font-semibold">Filing alerts</h2>
          <p className="mt-1 text-[14px] text-ink-2">An email with the moves inside, usually within a couple of minutes of a new 13F on EDGAR. Form 4 and 13D filings by funds you follow arrive within a few hours.</p>
          <fieldset className="mt-4 space-y-2.5 text-[14px]">
            <legend className="sr-only">Send alerts for</legend>
            {(
              [
                ['follows', `Investors I follow${follows.investors.length ? ` (${follows.investors.length})` : ''}`],
                ['all', 'Every investor we track'],
                ['off', 'Off'],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="flex cursor-pointer items-center gap-3">
                <input
                  type="radio"
                  name="alerts"
                  className="size-4 accent-[var(--color-accent)]"
                  checked={alertMode === k}
                  disabled={k === 'follows' && !follows.investors.length}
                  onChange={() => setAlerts(k === 'follows' ? follows.investors : k).then(onChange, () => null)}
                />
                <span className={k === 'follows' && !follows.investors.length ? 'text-ink-3' : ''}>{l}</span>
              </label>
            ))}
          </fieldset>
          {status === 'ready' && (
            <fieldset className="mt-5 space-y-2.5 border-t border-line pt-4 text-[14px]">
              <legend className="sr-only">Alert options</legend>
              {(
                [
                  ['include_13g', 'Also Schedule 13G filings', 'Passive 5% stakes. Big asset managers file many of these.'],
                  ['digest', 'One daily digest', 'A single email after EDGAR closes, about 10:30 pm ET, instead of one per filing.'],
                ] as const
              ).map(([k, l, d]) => (
                <label key={k} className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={follows[k]} onChange={(e) => saveFollows({ [k]: e.target.checked }).catch(() => null)} />
                  <span>
                    <span className="block">{l}</span>
                    <span className="block text-[12.5px] text-ink-3">{d}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </section>
      </div>

      {member.active && status === 'ready' && follows.onboarded && !editing && (
        <section className="mt-5 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold">Following</h2>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
          {follows.investors.length + follows.stocks.length === 0 ? (
            <p className="mt-2 text-[14px] text-ink-2">Nothing yet. Press Follow on any investor or stock page.</p>
          ) : (
            <>
              <ul className="mt-3 flex flex-wrap gap-2">
                {follows.investors.map((slug) => (
                  <li key={slug}>
                    <Link to={`/investors/${slug}/`} className="inline-flex items-center gap-2 rounded-full bg-paper py-1 pl-1 pr-3 text-[13px] shadow-[0_0_0_1px_var(--color-line)] hover:shadow-[0_0_0_1px_var(--color-ink-3)]">
                      <Monogram name={names.get(slug) ?? slug} size={22} />
                      {names.get(slug) ?? slug}
                    </Link>
                  </li>
                ))}
              </ul>
              {follows.stocks.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {follows.stocks.map((t) => (
                    <li key={t}>
                      <Link to={stockPath(t)} className="inline-flex items-center gap-1.5 rounded-full bg-paper px-3 py-1 text-[13px] shadow-[0_0_0_1px_var(--color-line)] hover:shadow-[0_0_0_1px_var(--color-ink-3)]">
                        <span className="font-mono font-medium">{t}</span>
                        {follows.owned.includes(t) && <span className="text-[11.5px] text-ink-3">owned</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-[12.5px] text-ink-3">You’ll get a fund’s 13F email whenever it changes a position in one of these stocks, even if you don’t follow the fund.</p>
            </>
          )}
        </section>
      )}

      <div className="mt-8 flex flex-wrap gap-3">
        <Button to="/flow/">See this season’s flow</Button>
        <Button
          variant="ghost"
          onClick={() => {
            signOut()
            resetFollows()
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
        Need your billing details now?{' '}
        <a href={checkout.portal} className="font-medium text-accent hover:text-accent-2">
          Sign in to Stripe billing
        </a>
        .
      </p>
      <p className="mt-2 text-[14px] text-ink-2">
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
        <p className="mt-3 text-[17px] text-ink-2">Quarter-over-quarter changes, 8 quarters of 13F history and CSV export, and filing-day alerts. Join and we’ll email you the moment it opens.</p>
      </header>
      <div className="mt-8 max-w-lg">
        <WaitlistForm id="wl-account" />
      </div>
    </>
  )
}
