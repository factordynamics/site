import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { isPaywall, saveFollows, toggle, useFollows } from '../lib/follows'

type Props = { kind: 'investor' | 'stock'; id: string; name: string; size?: 'sm' | 'md'; className?: string }

/** Follow an investor or a stock. Members toggle in place; everyone else gets a short upsell. */
export function FollowButton({ kind, id, name, size = 'sm', className = '' }: Props) {
  const { status, follows } = useFollows()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const list = kind === 'investor' ? follows.investors : follows.stocks
  const on = list.includes(id)
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

  const click = async () => {
    if (status !== 'ready') return setOpen((o) => !o)
    setBusy(true)
    try {
      if (kind === 'investor') await saveFollows({ investors: toggle(follows.investors, id) })
      else await saveFollows({ stocks: toggle(follows.stocks, id), ...(on && owned ? { owned: follows.owned.filter((x) => x !== id) } : {}) })
    } catch (e) {
      if (isPaywall(e)) setOpen(true)
    } finally {
      setBusy(false)
    }
  }

  const h = size === 'sm' ? 'h-8 px-3.5 text-[13px]' : 'h-10 px-4.5 text-sm'
  return (
    <div ref={wrap} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={click}
        disabled={busy || status === 'loading'}
        aria-pressed={status === 'ready' ? on : undefined}
        aria-expanded={status !== 'ready' ? open : undefined}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background,box-shadow,color] duration-150 active:scale-[0.98] disabled:opacity-60 ${h} ${
          on ? 'bg-accent-soft text-accent-2 shadow-[0_0_0_1px_rgb(43_68_214/0.25)] hover:bg-[#dfe4fb]' : 'bg-accent text-white hover:bg-accent-2'
        }`}
      >
        {on ? <CheckIcon /> : <PlusIcon />}
        {on ? (owned ? 'You own this' : 'Following') : 'Follow'}
      </button>
      {open && (
        <div role="dialog" aria-label={`Follow ${name}`} className="absolute right-0 top-full z-50 mt-2 w-[300px] rounded-2xl bg-card p-4 text-left shadow-[0_0_0_1px_rgb(12_14_19/0.08),0_18px_50px_-12px_rgb(12_14_19/0.3)]">
          <p className="text-[14.5px] font-semibold">Follow {name} with Copy</p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
            {kind === 'investor'
              ? 'Get an email when they file a new 13F, usually within the hour, and every buy and sell in it.'
              : 'Save it to your watchlist and see which investors buy and sell it each filing season.'}
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
