import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { isPaywall, setFollow, useFollows } from '../lib/follows'

type Props = { kind: 'investor' | 'stock'; id: string; name: string; size?: 'sm' | 'md'; className?: string }

/** Follow an investor or a stock. Members toggle in place; everyone else gets a short upsell. */
export function FollowButton({ kind, id, name, size = 'sm', className = '' }: Props) {
  const { status, follows, pending } = useFollows()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const list = kind === 'investor' ? follows.investors : follows.stocks
  const p = pending[`${kind === 'investor' ? 'investors' : 'stocks'}:${id}`]
  // "Following" only once the server's list has it; a save in flight reads as saving.
  const on = list.includes(id)
  const saving = p?.state === 'saving'
  const owned = kind === 'stock' && follows.owned.includes(id)

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

  const save = (want: boolean) =>
    setFollow(kind === 'investor' ? 'investors' : 'stocks', id, want).catch((e) => {
      if (isPaywall(e)) setOpen(true)
    })
  const click = () => (status !== 'ready' ? setOpen((o) => !o) : save(!on))

  const h = size === 'sm' ? 'h-8 px-3.5 text-[13px]' : 'h-10 px-4.5 text-sm'
  return (
    <div ref={wrap} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={click}
        disabled={saving || status === 'loading'}
        aria-pressed={status === 'ready' ? on : undefined}
        aria-expanded={status !== 'ready' ? open : undefined}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background,box-shadow,color] duration-150 active:scale-[0.98] disabled:opacity-60 ${h} ${
          on ? 'bg-accent-soft text-accent-2 shadow-[0_0_0_1px_rgb(43_68_214/0.25)] hover:bg-[#dfe4fb]' : 'bg-accent text-white hover:bg-accent-2'
        }`}
      >
        {saving ? <Spinner /> : on ? <CheckIcon /> : <PlusIcon />}
        {saving ? (p.want ? 'Saving…' : 'Removing…') : on ? (owned ? 'You own this' : 'Following') : 'Follow'}
      </button>
      {p?.state === 'error' && (
        <span role="alert" className="absolute right-0 top-full z-10 mt-1.5 flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-card px-2.5 py-1.5 text-[12.5px] text-down shadow-[0_0_0_1px_var(--color-line),0_6px_16px_-6px_rgb(12_14_19/0.2)]">
          {p.want ? 'Follow didn’t save.' : 'Unfollow didn’t save.'}
          <button type="button" onClick={() => save(p.want)} className="font-medium text-accent underline underline-offset-2 hover:text-accent-2">
            Retry
          </button>
        </span>
      )}
      {open && (
        <div role="dialog" aria-label={`Follow ${name}`} className="absolute right-0 top-full z-50 mt-2 w-[300px] rounded-2xl bg-card p-4 text-left shadow-[0_0_0_1px_rgb(12_14_19/0.08),0_18px_50px_-12px_rgb(12_14_19/0.3)]">
          <p className="text-[14.5px] font-semibold">Follow {name} with Copy</p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
            {kind === 'investor'
              ? 'Get an email minutes after they file a new 13F, with their biggest buys and sells in it.'
              : 'Get an email when a fund you track buys or sells it, and see who holds it each filing season.'}
          </p>
          <div className="mt-3.5 flex items-center gap-2">
            <Link to="/pricing/" className="inline-flex h-8 items-center rounded-full bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent-2">
              Start 14-day free trial
            </Link>
            <Link to="/account/" className="inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-ink/5 hover:text-ink">
              Sign in
            </Link>
          </div>
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
