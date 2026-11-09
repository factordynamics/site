import { useEffect, useState } from 'react'
import { BASE } from '../lib/data'

// A tab left open for days keeps running the bundle it loaded. Every 30 minutes, and when the tab
// comes back into view, compare the entry script in the live index.html with ours. The entry file's
// name carries a content hash, so data-only rebuilds don't count as a new version.
const entry = (html: string) => html.match(/<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1] ?? null
const mine = () => (document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null)?.getAttribute('src') ?? null

export function UpdatePrompt() {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    const ours = mine()
    if (!ours) return // dev server
    let last = Date.now()
    const check = async () => {
      last = Date.now()
      try {
        const live = entry(await (await fetch(`${BASE}index.html?v=${last}`, { cache: 'no-store' })).text())
        if (live && live !== ours) setStale(true)
      } catch {
        // Offline: try again next time.
      }
    }
    const t = setInterval(check, 30 * 60_000)
    // On return to the tab, at most once every 5 minutes.
    const back = () => document.visibilityState === 'visible' && Date.now() - last > 5 * 60_000 && check()
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', back)
      window.removeEventListener('focus', back)
    }
  }, [])
  if (!stale) return null
  return (
    <div role="status" className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-full bg-night py-2 pl-4 pr-2 text-[13.5px] text-white shadow-[0_12px_40px_-12px_rgb(12_14_19/0.5)]">
        <span>A new version of Copybook is out.</span>
        <button type="button" onClick={() => location.reload()} className="rounded-full bg-white px-3 py-1 font-medium text-ink hover:bg-white/90">
          Reload
        </button>
        <button type="button" aria-label="Dismiss" onClick={() => setStale(false)} className="inline-flex size-7 items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white">
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M2 2l6 6M8 2 2 8" />
          </svg>
        </button>
      </div>
    </div>
  )
}
