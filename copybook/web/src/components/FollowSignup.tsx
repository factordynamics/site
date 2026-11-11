import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { TRIAL_DAYS } from '../config'
import { ApiError, call } from '../lib/account'
import { utmTags } from '../lib/attribution'
import { pricingTo } from '../lib/data'
import { possessive } from '../lib/names.mjs'
import { track } from '../lib/track'
import { Button, Check } from './ui'

// One-field free signup for signed-out readers: their email, then a follow of the investor(s) on the page
// (POST {api}/signup with `follow`). The confirmation promises a fund's moves only when the API says it
// saved the follow (`following: true`). A free follow puts that investor's moves in the Friday email, not a
// per-filing email; that is Copy, which the trial link offers.
export function FollowSignup({ people, kind = 'investor', label, className = '', onDone }: { people: { slug: string; name: string }[]; kind?: 'investor' | 'stock'; label?: string; className?: string; onDone?: () => void }) {
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [state, setState] = useState<{ s: 'idle' | 'sending' | 'done' | 'error'; following?: boolean; msg?: string }>({ s: 'idle' })
  const [slow, setSlow] = useState(false)
  useEffect(() => track('signup_view'), [])
  const who = people.length === 1 ? possessive(people[0].name) : 'their'
  const got = kind === 'stock' ? `You’ll get superinvestor moves in ${people[0].name} in Friday’s email.` : `You’ll get ${who} moves in Friday’s email.`
  const id = `follow-${people.map((p) => p.slug).join('-').slice(0, 60)}`

  if (state.s === 'done')
    return (
      <div role="status" className={className}>
        <p className="flex items-start gap-2 text-[14.5px] font-medium leading-snug text-ink">
          <span className="mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-up text-white">
            <Check className="size-3" />
          </span>
          {state.following ? got : 'You’re in: the free Friday email has the week’s biggest superinvestor moves.'}
        </p>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
          Want each 13F as it’s filed?{' '}
          <Link to={pricingTo()} onClick={() => track('trial_click')} className="font-medium text-accent hover:text-accent-2">
            Try Copy free for {TRIAL_DAYS} days
          </Link>{' '}
          (card required).
        </p>
      </div>
    )

  return (
    <form
      className={className}
      onSubmit={async (e) => {
        e.preventDefault()
        const v = email.trim()
        if (!/^\S+@\S+\.\S+$/.test(v)) return setState({ s: 'error', msg: 'Check the email address and try again.' })
        setState({ s: 'sending' })
        const t = setTimeout(() => setSlow(true), 1000)
        try {
          const r = await call<{ ok: boolean; created?: boolean; following?: boolean }>('/signup', {
            body: { email: v, website, source: `follow:${location.pathname}`, follow: people.map((p) => ({ kind, id: p.slug })), ...utmTags() },
          })
          setState({ s: 'done', following: r.following === true })
          onDone?.()
          try {
            localStorage.setItem('copybook-signup-email', v)
          } catch {
            /* storage blocked */
          }
        } catch (err) {
          const rate = err instanceof ApiError && err.status === 429
          setState({ s: 'error', msg: rate ? 'Too many tries. Please try again in an hour.' : err instanceof ApiError && err.status === 400 && err.detail ? err.detail : 'That didn’t go through. Please try again.' })
        } finally {
          clearTimeout(t)
          setSlow(false)
        }
      }}
    >
      <label htmlFor={id} className="text-[12.5px] font-medium text-ink-3">
        {label ?? `Follow ${people.length === 1 ? people[0].name : 'them'} free`}
      </label>
      <div className="mt-1.5 flex gap-2">
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
          className="h-10 min-w-0 flex-1 rounded-full bg-paper px-4 text-[14.5px] text-ink shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
        />
        <Button type="submit" disabled={state.s === 'sending'} className="shrink-0">
          {state.s === 'sending' ? 'Following…' : 'Follow free'}
        </Button>
      </div>
      {/* A field people never see; bots that fill it get a quiet success. */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} className="hidden" aria-hidden />
      {state.s === 'sending' && slow && <p className="mt-2 text-[12.5px] text-ink-3">Creating your free account…</p>}
      {state.s === 'error' && (
        <p role="alert" className="mt-2 text-[12.5px] text-down">
          {state.msg}
        </p>
      )}
      <p className="mt-2 text-[12px] text-ink-3">Free, no card. Unsubscribe from any email.</p>
    </form>
  )
}
