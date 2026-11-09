import { useApiDown, useMeUpdating } from '../lib/account'

/** One line while the API answers 429 or 5xx (or can't be reached): what still works and what doesn't. */
export function ApiStatus({ className = '' }: { className?: string }) {
  if (!useApiDown()) return null
  return (
    <p role="status" className={`flex items-start gap-2 rounded-xl bg-[#fff6e5] px-4 py-2.5 text-[13.5px] leading-relaxed text-[#7a4b00] ${className}`}>
      <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#d98a00]" />
      The Copybook API isn’t answering right now. Filing pages still work; account and API requests resume once it’s back.
    </p>
  )
}

/** "Updating…" while a page shows the last-known account and the fresh one hasn't arrived. */
export function Updating({ show, className = '' }: { show?: boolean; className?: string }) {
  const stale = useMeUpdating()
  if (!(show ?? stale)) return null
  return (
    <p role="status" className={`inline-flex items-center gap-2 rounded-full bg-ink/[0.05] px-3 py-1 text-[12.5px] text-ink-2 ${className}`}>
      <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" /> Updating…
    </p>
  )
}
