import { useState } from 'react'
import { Link } from 'react-router-dom'
import { signupLive } from '../config'
import { ApiError, call, getToken } from '../lib/account'
import { Arrow, Check } from './ui'

// Free weekly email (POST {api}/signup): a free account that gets the week's top moves every Friday,
// never real-time alerts. Shown to signed-out readers only; each placement passes its own source.
export function Signup({ source, className = '' }: { source: string; className?: string }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<{ s: 'idle' | 'sending' | 'done' | 'error'; msg?: string }>({ s: 'idle' })
  if (!signupLive || getToken()) return null
  const id = `signup-${source}`
  return (
    <section className={`rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:p-6 ${className}`} aria-labelledby={`${id}-title`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-8">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-[16px] font-semibold tracking-[-0.01em]">
            Get the week’s biggest superinvestor moves, free, every Friday
          </h2>
          <p className="mt-1 text-[13.5px] text-ink-2">One short email from SEC filings: who bought, who sold, and what was new. Unsubscribe in one click.</p>
        </div>
        {state.s === 'done' ? (
          <div role="status" className="shrink-0 md:max-w-[380px]">
            <p className="flex items-center gap-2 text-[14.5px] font-medium">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-up text-white">
                <Check className="size-3.5" />
              </span>
              You’re in. The first email arrives Friday.
            </p>
            <p className="mt-1.5 text-[13px] text-ink-2">
              Want each filing minutes after it lands?{' '}
              <Link to="/pricing/" className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent-2">
                Try Copy free for 14 days <Arrow className="size-3" />
              </Link>
            </p>
          </div>
        ) : (
          <form
            className="flex w-full shrink-0 flex-col gap-2 sm:flex-row md:w-[400px]"
            onSubmit={async (e) => {
              e.preventDefault()
              const v = email.trim()
              if (!/^\S+@\S+\.\S+$/.test(v)) return setState({ s: 'error', msg: 'Check the email address and try again.' })
              setState({ s: 'sending' })
              try {
                await call('/signup', { body: { email: v, source } })
                setState({ s: 'done' })
              } catch (err) {
                const rate = err instanceof ApiError && err.status === 429
                setState({ s: 'error', msg: rate ? 'Too many tries. Please try again in an hour.' : err instanceof ApiError && err.status === 400 && err.detail ? err.detail : 'That didn’t go through. Please try again.' })
              }
            }}
          >
            <label htmlFor={id} className="sr-only">
              Email address
            </label>
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
            <button type="submit" disabled={state.s === 'sending'} className="h-10 shrink-0 rounded-full bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink/85 disabled:opacity-60">
              {state.s === 'sending' ? 'Signing up…' : 'Get it free'}
            </button>
          </form>
        )}
      </div>
      {state.s === 'error' && (
        <p role="alert" className="mt-2 text-[13px] text-down md:text-right">
          {state.msg}
        </p>
      )}
    </section>
  )
}
