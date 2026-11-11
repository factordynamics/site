import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { TRIAL_DAYS } from '../config'
import { adoptSession, ApiError, call, getToken } from '../lib/account'
import { utmTags } from '../lib/attribution'
import { pricingTo } from '../lib/data'
import { possessive } from '../lib/names.mjs'
import { track } from '../lib/track'
import { Button, Check } from './ui'

// One-field free signup for signed-out readers: their email, then a follow of the investor(s) on the page
// (POST {api}/signup with `follow`). The confirmation promises a fund's moves only when the API says it
// saved the follow (`following: true`). A free follow puts that investor's moves in the Friday email, not a
// per-filing email; that is Copy, which the trial link offers. `extra` sits beside the Follow free button
// (a trial button) and `secondary` makes Follow free the quieter button; `quietLabel` keeps the field's label for screen readers only, where the box already says it.
export const CAP_MSG = 'Free accounts follow up to 10 investors. Remove one, or start Copy for unlimited follows.'

// Account mail Resend refused (payments sends it after the 00:00 UTC reset).
const queuedLine = (at?: string) => `Your sign-in link arrives after ${at ? localTime(at) : '00:00 UTC (7 pm ET)'}.`
// What /signup emails, by subject as payments sends them (copybook/api free.ts), so a reader knows what to look for.
const SUBJECT = { first: "You're on the Copybook weekly", follow: 'Follow saved. Your Copybook sign-in link', link: 'Your Copybook sign-in link' }
// The reader's own clock, with its zone ("6:37 AM EST").
const localTime = (t: number | string) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
export const inboxLine = (subject: string) => `Check your inbox: your sign-in link is in the email “${subject}”.`
export const alreadyLine = (at?: string) => `You’re already signed up. Your sign-in link is in the email we sent ${at ? `at ${localTime(at)}` : 'within the last hour'}.`
type SignupRes = { ok: boolean; created?: boolean; code?: string; sent_at?: string; sign_in_sent_at?: string; welcome?: 'sent' | 'queued' | 'test_inbox' | 'not_sent'; send_at?: string; token?: string; session?: string; following?: boolean; follow?: 'added' | 'already' | 'cap_reached' | 'sign_in'; sign_in_email?: 'not_needed' | 'sent' | 'rate_limited' | 'already_sent' | 'queued' | 'test_inbox' | 'not_sent' | 'sent_if_member' }
/** After a successful /signup: keeps a new account's provisional session (so this device is signed in at once),
 *  and returns the line saying which email holds the sign-in link, when it comes, or that one went out already. */
export function signupDone(r: SignupRes): string | null {
  const signedIn = Boolean(r.created && r.token)
  if (signedIn) adoptSession(r.token!)
  const here = signedIn ? ' You’re signed in on this device now.' : ''
  const mail = r.created ? r.welcome : r.sign_in_email
  if (mail === 'queued') return `${queuedLine(r.send_at)}${here}`
  if (mail === 'test_inbox') return `A test address: the email went to the test inbox.${here}`
  if (mail === 'not_sent') return signedIn ? `The email didn’t go out, but you’re signed in on this device now.` : 'The sign-in email didn’t go out. Please try again in a few minutes.'
  if (mail === 'sent_if_member') return 'Check your inbox. If this address already has an account, we’ve sent it a sign-in link.'
  if (r.created) return `${inboxLine(SUBJECT.first)}${here}`
  if (r.code === 'already_member' || r.code === 'already_sent' || r.sign_in_email === 'already_sent' || r.sign_in_email === 'rate_limited') return alreadyLine(r.sign_in_sent_at ?? r.sent_at)
  if (r.sign_in_email === 'sent') return inboxLine(r.follow === 'added' ? SUBJECT.follow : SUBJECT.link)
  return null
}
/** A failed /signup in plain words: the server's own wait on a 429, never a fixed "an hour". */
export function signupError(err: unknown): string {
  if (err instanceof ApiError && (err.code === 'already_member' || err.code === 'already_sent')) return alreadyLine(err.sentAt)
  if (err instanceof ApiError && err.status === 429) {
    if (err.alreadyMember) return `You’re already signed up; use the link we emailed.${err.retryAt ? ` Lost it? Request a new link after ${localTime(err.retryAt)}.` : ''}`
    if (!err.retryAt) return err.detail ?? 'Too many tries. Please try again a little later.'
    const m = Math.max(1, Math.ceil((err.retryAt - Date.now()) / 60_000))
    return `Too many tries. Try again in ${m} minute${m === 1 ? '' : 's'} (after ${localTime(err.retryAt)}).`
  }
  return err instanceof ApiError && err.status === 400 && err.detail ? err.detail : 'That didn’t go through. Please try again.'
}
export function FollowSignup({ people, kind = 'investor', label, className = '', onDone, extra, quietLabel = false, secondary = false }: { people: { slug: string; name: string }[]; kind?: 'investor' | 'stock'; label?: string; className?: string; onDone?: () => void; extra?: ReactNode; quietLabel?: boolean; secondary?: boolean }) {
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [state, setState] = useState<{ s: 'idle' | 'sending' | 'done' | 'error'; following?: boolean; capped?: boolean; note?: string | null; msg?: string }>({ s: 'idle' })
  // Several people (/season/'s next filers): each one a checkbox, all ticked, so the reader sees and picks who they follow.
  const [off, setOff] = useState<string[]>([])
  const chosen = people.filter((p) => !off.includes(p.slug))
  const many = people.length > 1
  const [slow, setSlow] = useState(false)
  useEffect(() => track('signup_view'), [])
  const who = chosen.length === 1 ? possessive(chosen[0].name) : 'their'
  const got = kind === 'stock' ? `You’ll get superinvestor moves in ${people[0].name} in Friday’s email.` : `You’ll get ${who} moves in Friday’s email.`
  const id = `follow-${people.map((p) => p.slug).join('-').slice(0, 60)}`

  if (state.s === 'done')
    return (
      <div role="status" className={className}>
        <p className="flex items-start gap-2 text-[14.5px] font-medium leading-snug text-ink">
          <span className="mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-up text-white">
            <Check className="size-3" />
          </span>
          {state.capped ? (state.following ? 'Saved the follows that fit.' : 'You’re already following 10 investors.') : state.following ? got : 'You’re in: the free Friday email has the week’s biggest superinvestor moves.'}
        </p>
        {state.capped && (
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
            {CAP_MSG}{' '}
            <Link to="/account/" className="font-medium text-accent hover:text-accent-2">
              Manage follows
            </Link>
          </p>
        )}
        {state.note && <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{state.note}</p>}
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
        if (!chosen.length) return setState({ s: 'error', msg: 'Tick at least one investor to follow.' })
        setState({ s: 'sending' })
        const t = setTimeout(() => setSlow(true), 1000)
        try {
          const r = await call<SignupRes>('/signup', {
            body: { email: v, website, source: `follow:${location.pathname}`, follow: chosen.map((p) => ({ kind, id: p.slug })), ...utmTags() },
            auth: Boolean(getToken()),
          })
          setState({ s: 'done', following: r.following === true, capped: r.follow === 'cap_reached', note: signupDone(r) })
          onDone?.()
          try {
            localStorage.setItem('copybook-signup-email', v)
          } catch {
            /* storage blocked */
          }
        } catch (err) {
          setState({ s: 'error', msg: signupError(err) })
        } finally {
          clearTimeout(t)
          setSlow(false)
        }
      }}
    >
      {many && (
        <fieldset className="mb-2.5">
          <legend className="text-[12.5px] font-medium text-ink-3">Follow free</legend>
          <div className="mt-0.5 flex flex-wrap gap-x-4">
            {people.map((p) => (
              <label key={p.slug} className="inline-flex min-h-11 cursor-pointer items-center gap-2 pr-1 text-[14px] text-ink">
                <input
                  type="checkbox"
                  checked={!off.includes(p.slug)}
                  onChange={(e) => setOff((o) => (e.target.checked ? o.filter((x) => x !== p.slug) : [...o, p.slug]))}
                  className="size-4 accent-[var(--color-accent)]"
                />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label htmlFor={id} className={quietLabel ? 'sr-only' : 'text-[12.5px] font-medium text-ink-3'}>
        {label ?? `Follow ${people.length === 1 ? people[0].name : 'them'} free`}
      </label>
      <div className={`flex flex-wrap gap-2 ${quietLabel ? '' : 'mt-1.5'}`}>
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
          className="h-10 min-w-[11rem] flex-1 rounded-full bg-paper px-4 text-[14.5px] text-ink shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
        />
        <Button type="submit" variant={extra || secondary ? 'outline' : 'primary'} disabled={state.s === 'sending' || !chosen.length} className="shrink-0">
          {state.s === 'sending' ? 'Following…' : many && chosen.length ? `Follow ${chosen.length} free` : 'Follow free'}
        </Button>
        {extra}
      </div>
      {/* A field people never see; bots that fill it get a quiet success. */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} className="hidden" aria-hidden />
      {many && !chosen.length && <p className="mt-2 text-[12.5px] text-ink-2">Pick at least one investor</p>}
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
