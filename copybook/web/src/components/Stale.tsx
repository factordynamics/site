import { useEffect, useState } from 'react'
import { dateFmt } from '../lib/data'

/** "10:42 ET" today, "Nov 11, 10:42 ET" on another day (New York time, like every time on the site). */
export function asOfLabel(iso: string, now = Date.now()) {
  const t = new Date(iso)
  const ny = (d: Date) => dateFmt({ year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/New_York' }).format(d)
  const time = dateFmt({ hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(t).replace(/\s?([AP])M$/, (_, x: string) => ` ${x.toLowerCase()}m`)
  const day = ny(t) === ny(new Date(now)) ? '' : `${dateFmt({ month: 'short', day: 'numeric', timeZone: 'America/New_York' }).format(t)}, `
  return `${day}${time} ET`
}

/** The API's last good answer, served while it's slow ("stale": true, stale_as_of): said plainly, never shown as fresh,
 *  and asked for again quietly every 30 seconds (up to 10 minutes) until a fresh answer replaces it. */
export function Stale({ asOf, onRetry, className = '' }: { asOf?: string | null; onRetry: () => void; className?: string }) {
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (!asOf || tries >= 20) return
    const t = setTimeout(() => {
      setTries((n) => n + 1)
      onRetry()
    }, 30_000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf, tries])
  if (!asOf) return null
  return (
    <p role="status" className={`flex items-center gap-1.5 text-[12px] text-[#7a4b06] ${className}`}>
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[#c98a1b]" aria-hidden />
      Data as of {asOfLabel(asOf)} · refreshing
    </p>
  )
}
