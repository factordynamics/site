import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { pricingTo } from '../lib/data'
import { ApiError, getToken, lastMe, needsVerify, pendingEmail } from '../lib/account'
import { ConfirmEmail, ResendLink } from './ConfirmEmail'
import { isCap, isPaywall, setFollow, useFollows } from '../lib/follows'
import { track } from '../lib/track'
import { CAP_MSG, FollowSignup } from './FollowSignup'

type Props = { kind: 'investor' | 'stock'; id: string; name: string; size?: 'sm' | 'md'; className?: string; /** Resend under the toggle, for a narrow table cell. */ stack?: boolean }

/** Follow an investor or a stock. Members toggle in place; everyone else gets a short upsell. */
export function FollowButton({ kind, id, name, size = 'sm', className = '', stack = false }: Props) {
  const { status, follows, pending } = useFollows()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const list = kind === 'investor' ? follows.investors : follows.stocks
  const p = pending[`${kind === 'investor' ? 'investors' : 'stocks'}:${id}`]
  // "Following" only once the server's list has it; a save in flight reads as saving.
  const on = list.includes(id)
  const saving = p?.state === 'saving'
  const owned = kind === 'stock' && follows.owned.includes(id)
  // A free account (GET /follows carries its 5-name limit) keeps stocks as "my names", not follows.
  const free = status === 'ready' && follows.limit != null
  const [freeMsg, setFreeMsg] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  // A free member past the follow cap (402 cap_reached) sees the cap, not the Copy pitch.
  const [capped, setCapped] = useState(false)
  // Fresh from checkout, delivery waits for the emailed link: a saved follow stays on and says so; a follow the
  // API holds for the link says that instead. Never a toggle that silently reverts (trader, Nov 11).
  const [confirm, setConfirm] = useState<'saved' | 'follow' | null>(null)
  const pend = pendingEmail(lastMe())
  // The "Saved…" note is a toast that leaves on its own (it covered the card below at 390); the toggle itself keeps
  // saying alerts wait for the email ("Following · confirm email" and Resend) until the link is opened (trader, Nov 11).
  useEffect(() => {
    if (confirm !== 'saved') return
    const t = setTimeout(() => setConfirm(null), 6000)
    return () => clearTimeout(t)
  }, [confirm])
  const save = (want: boolean) =>
    setFollow(kind === 'investor' ? 'investors' : 'stocks', id, want).then(() => setConfirm(want && pendingEmail(lastMe()) ? 'saved' : null)).catch((e) => {
      if (needsVerify(e) && pendingEmail(lastMe())) return setConfirm('follow')
      // The cap shows the cap message; only a real paywall shows the Copy pitch; anything else is the Retry line.
      setCapped(isCap(e))
      if (isCap(e) || isPaywall(e)) setOpen(true)
    })
  const click = () => (status !== 'ready' ? setOpen((o) => !o) : save(!on))

  // A signed-in reader who still hits the paywall is on the free Friday email (or lapsed).
  const signedIn = Boolean(getToken())
  if (free && kind === 'stock') {
    const ps = pending[`owned:${id}`]
    const busy = ps?.state === 'saving'
    const hb = size === 'sm' ? 'h-8 px-3.5 text-[13px]' : 'h-10 px-4.5 text-sm'
    return (
      <div className={`relative inline-flex ${className}`}>
        <button
          type="button"
          disabled={busy}
          aria-pressed={owned}
          aria-label={busy ? undefined : `Add ${name} to my names`}
          onClick={() =>
            setFollow('owned', id, !owned).then(
              () => setFreeMsg(null),
              (e) => setFreeMsg(e instanceof ApiError && e.code === 'free_limit' ? (e.detail ?? `Free accounts can save up to ${follows.limit} names. Copy has no limit.`) : 'That didn’t save. Please try again.'),
            )
          }
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background,box-shadow,color] duration-150 active:scale-[0.98] disabled:opacity-60 ${hb} ${
            owned ? 'bg-accent-soft text-accent-2 shadow-[0_0_0_1px_rgb(43_68_214/0.25)] hover:bg-[#dfe4fb]' : 'bg-accent text-white hover:bg-accent-2'
          }`}
        >
          {busy ? <Spinner /> : owned ? <CheckIcon /> : <PlusIcon />}
          {busy ? 'Saving…' : owned ? 'In my names' : `Add to my names (free, ${follows.limit} max)`}
        </button>
        {freeMsg && (
          <span role="status" className="absolute right-0 top-full z-10 mt-1.5 w-[280px] rounded-lg bg-card px-3 py-2 text-[12.5px] text-ink-2 shadow-[0_0_0_1px_var(--color-line),0_6px_16px_-6px_rgb(12_14_19/0.2)]">
            {freeMsg}{' '}
            <Link to={pricingTo()} className="font-medium text-accent hover:text-accent-2">
              Start 14-day trial
            </Link>
          </span>
        )}
      </div>
    )
  }

  const h = size === 'sm' ? 'h-8 px-3.5 text-[13px]' : 'h-10 px-4.5 text-sm'
  return (
    <div ref={wrap} className={`relative inline-flex ${stack ? 'flex-col items-end gap-1' : 'items-center gap-2'} ${className}`}>
      <button
        type="button"
        onClick={click}
        disabled={saving || status === 'loading'}
        aria-pressed={status === 'ready' ? on : undefined}
        aria-expanded={status !== 'ready' ? open : undefined}
        aria-label={saving ? undefined : `Follow ${name}`}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background,box-shadow,color] duration-150 active:scale-[0.98] disabled:opacity-60 ${h} ${
          on ? 'bg-accent-soft text-accent-2 shadow-[0_0_0_1px_rgb(43_68_214/0.25)] hover:bg-[#dfe4fb]' : 'bg-accent text-white hover:bg-accent-2'
        }`}
      >
        {saving ? <Spinner /> : on ? <CheckIcon /> : <PlusIcon />}
        {saving ? (p.want ? 'Saving…' : 'Removing…') : on ? (owned ? 'You own this' : pend ? 'Following · confirm email' : 'Following') : 'Follow'}
      </button>
      {on && pend && !saving &&
        <ResendLink email={pend} />}
      {/* At 390 a fixed note covered the next heading (trader, Nov 11): on phones the toggle itself carries "confirm email" and Resend. */}
      {confirm && pend && <ConfirmEmail email={pend} kind={confirm} className={`absolute right-0 top-full z-10 mt-1.5 w-[300px] shadow-[0_6px_16px_-6px_rgb(12_14_19/0.2)] ${confirm === 'saved' ? 'max-sm:hidden' : 'max-sm:fixed max-sm:inset-x-3 max-sm:bottom-3 max-sm:top-auto max-sm:z-50 max-sm:w-auto'}`} />}
      {p?.state === 'error' && (
        <span role="alert" className={`absolute right-0 top-full z-10 mt-1.5 flex items-center gap-1.5 ${p.note ? 'w-[280px] whitespace-normal max-sm:fixed max-sm:inset-x-3 max-sm:bottom-3 max-sm:top-auto max-sm:z-50 max-sm:w-auto max-sm:px-3.5 max-sm:py-3' : 'whitespace-nowrap'} rounded-lg bg-card px-2.5 py-1.5 text-[12.5px] text-down shadow-[0_0_0_1px_var(--color-line),0_6px_16px_-6px_rgb(12_14_19/0.2)]`}>
          {p.note ?? (p.want ? 'Follow didn’t save.' : 'Unfollow didn’t save.')}
          <button type="button" onClick={() => save(p.want)} className="font-medium text-accent underline underline-offset-2 hover:text-accent-2">
            Retry
          </button>
        </span>
      )}
      {open && <div aria-hidden className="fixed inset-0 z-40 bg-ink/30 sm:hidden" onClick={() => setOpen(false)} />}
      {open && (
        <div role="dialog" aria-label={`Follow ${name}`} className="absolute right-0 top-full z-50 mt-2 w-[300px] max-sm:fixed max-sm:inset-x-3 max-sm:bottom-3 max-sm:top-auto max-sm:mt-0 max-sm:w-auto rounded-2xl bg-card p-4 text-left shadow-[0_0_0_1px_rgb(12_14_19/0.08),0_18px_50px_-12px_rgb(12_14_19/0.3)]">
          {!signedIn ? (
            <>
              <p className="text-[14.5px] font-semibold">Follow {name} free</p>
              {!joined && <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                {kind === 'investor' ? 'Their moves land in Friday’s email.' : 'Superinvestor moves in it land in Friday’s email.'}
              </p>}
              <FollowSignup people={[{ slug: id, name }]} kind={kind} label="Your email" className="mt-2.5" onDone={() => setJoined(true)} />
              {!joined && <p className="mt-3 border-t border-line pt-3 text-[13px] leading-relaxed text-ink-2">
                Or get each 13F as it’s filed, with Copy. We check EDGAR every minute.{' '}
                <Link to={pricingTo()} onClick={() => track('trial_click')} className="font-medium text-accent hover:text-accent-2">
                  Start 14-day free trial
                </Link>{' '}
                (no card needed).
              </p>}
              <p className="mt-2 text-[12.5px] text-ink-3">
                Have an account?{' '}
                <Link to="/account/" className="font-medium text-accent hover:text-accent-2">
                  Sign in
                </Link>
              </p>
            </>
          ) : (
          <>
          <p className="text-[14.5px] font-semibold">{capped ? 'You’re following 10 investors' : signedIn ? 'Following is a Copy feature' : `Follow ${name} with Copy`}</p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
            {capped ? CAP_MSG : kind === 'investor'
              ? 'Get an email when they file a new 13F, with their biggest buys and sells in it.'
              : 'Get an email when a fund you track buys or sells it, and see who holds it each filing season.'}
          </p>
          <div className="mt-3.5 flex items-center gap-2">
            <Link to={pricingTo()} onClick={() => track('trial_click')} className="inline-flex h-8 items-center rounded-full bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent-2">
              Start 14-day free trial
            </Link>
            {(!signedIn || capped) && (
              <Link to="/account/" className="inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-ink/5 hover:text-ink">
                {capped ? 'Manage follows' : 'Sign in'}
              </Link>
            )}
          </div>
          </>
          )}
        </div>
      )}
    </div>
  )
}

const Spinner = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="animate-spin" aria-hidden="true">
    <path d="M12 7a5 5 0 1 1-5-5" />
  </svg>
)
const PlusIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M7 2.5v9M2.5 7h9" />
  </svg>
)
const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m2.5 7.5 3 3 6-7" />
  </svg>
)
