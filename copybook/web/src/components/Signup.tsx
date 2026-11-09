import { useState } from 'react'
import { Link } from 'react-router-dom'
import { pricingTo } from '../lib/data'
import { signupLive, TRIAL_DAYS } from '../config'
import { ApiError, call, getToken, isFree, isPaying, useMemberState } from '../lib/account'
import { utmTags } from '../lib/attribution'
import { Arrow, Button, Check } from './ui'

// Free weekly email (POST {api}/signup): a free account that gets the week's top moves every Friday,
// never real-time alerts. Shown to signed-out readers only; each placement passes its own source.
// The Copy trial stays the primary action; the free email is the quieter second path.
export function Signup({ source, className = '' }: { source: string; className?: string }) {
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [state, setState] = useState<{ s: 'idle' | 'sending' | 'done' | 'member' | 'error'; msg?: string }>({ s: 'idle' })
  // Hidden only for paying members. Free, cancelled and signed-out readers, and a session whose /me failed,
  // keep the trial button; a free member already gets the Friday email, so the form says so instead.
  const member = useMemberState()
  if (!signupLive || (getToken() && isPaying(member))) return null
  const onFriday = Boolean(getToken() && isFree(member))
  const id = `signup-${source}`
  return (
    <section className={`rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:p-6 ${className}`} aria-labelledby={`${id}-title`}>
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between md:gap-10">
        <div className="min-w-0 max-w-xl">
          <h2 id={`${id}-title`} className="text-[16px] font-semibold tracking-[-0.01em]">
            Get the Friday top moves free
          </h2>
          <p className="mt-1 text-[13.5px] text-ink-2">The week’s five biggest buys and sells by the investors we track, from SEC filings. Or start Copy and get each filing minutes after it lands on EDGAR.</p>
          <Button to={pricingTo()} className="mt-4">
            Start {TRIAL_DAYS}-day free trial <Arrow />
          </Button>
        </div>
        {onFriday ? (
          <p className="shrink-0 text-[13.5px] text-ink-2 md:w-[380px] md:pt-1">You’re on the Friday email. Copy adds each filing from the funds you follow, minutes after it lands.</p>
        ) : state.s === 'done' || state.s === 'member' ? (
          <div role="status" className="shrink-0 md:w-[380px] md:pt-1">
            <p className="flex items-center gap-2 text-[14.5px] font-medium">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-up text-white">
                <Check className="size-3.5" />
              </span>
              {state.s === 'done' ? 'You’re in. The first email arrives Friday.' : 'You already have an account.'}
            </p>
            <p className="mt-1.5 text-[13px] text-ink-2">
              {state.s === 'done' ? 'Check your inbox for a welcome note with your sign-in link.' : (
                <>
                  We’ve emailed your sign-in link, or{' '}
                  <Link to="/account/" className="font-medium text-accent hover:text-accent-2">
                    sign in here
                  </Link>
                  .
                </>
              )}
            </p>
          </div>
        ) : (
          <form
            className="relative w-full shrink-0 md:w-[380px] md:pt-1"
            onSubmit={async (e) => {
              e.preventDefault()
              const v = email.trim()
              if (!/^\S+@\S+\.\S+$/.test(v)) return setState({ s: 'error', msg: 'Check the email address and try again.' })
              setState({ s: 'sending' })
              try {
                const r = await call<{ ok: boolean; created?: boolean }>('/signup', { body: { email: v, source, website, ...utmTags() } })
                setState({ s: r.created || website ? 'done' : 'member' })
              } catch (err) {
                const rate = err instanceof ApiError && err.status === 429
                setState({ s: 'error', msg: rate ? 'Too many tries. Please try again in an hour.' : err instanceof ApiError && err.status === 400 && err.detail ? err.detail : 'That didn’t go through. Please try again.' })
              }
            }}
          >
            <label htmlFor={id} className="text-[12.5px] font-medium text-ink-3">
              Free Friday email
            </label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <input
                id={id}
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  if (state.s === 'error') setState({ s: 'idle' })
                }}
                placeholder="you@example.com"
                className="h-10 min-w-0 flex-1 rounded-full bg-paper px-4 text-[14.5px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
              />
              <Button type="submit" variant="outline" disabled={state.s === 'sending'}>
                {state.s === 'sending' ? 'Signing up…' : 'Get it free'}
              </Button>
            </div>
            {/* Honeypot: people never see or fill it; the API drops signups that do. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor={`${id}-website`}>Website</label>
              <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>
            <p className="mt-1.5 text-[12px] text-ink-3">No card. Unsubscribe in one click.</p>
            {state.s === 'error' && (
              <p role="alert" className="mt-1.5 text-[13px] text-down">
                {state.msg}
              </p>
            )}
          </form>
        )}
      </div>
    </section>
  )
}

/** For a free member who hits a paid feature (a 402): what it is and how to get it, not an error. */
export function CopyFeature({ what, className = '' }: { what?: string; className?: string }) {
  return (
    <span role="status" className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2 ${className}`}>
      <span>{what ? `${what} is a Copy feature` : 'This is a Copy feature'}</span>
      <span aria-hidden="true">·</span>
      <Link to={pricingTo()} className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent-2">
        Start {TRIAL_DAYS}-day free trial <Arrow className="size-3" />
      </Link>
    </span>
  )
}
