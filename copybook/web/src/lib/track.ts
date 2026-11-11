import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { apiReady } from '../config'
import { getToken } from './account'
import { utmTags } from './attribution'

// Launch-week funnel counts for signed-out readers on the pages X posts land on (filer pages, /season/,
// /f/ cards): visits, free signups shown, and trial clicks, by page and utm_source (POST {api}/track).
// Counting only: no identifiers are sent, a visit counts once per page per browser session, and a failure is ignored.
type Kind = 'visit' | 'signup_view' | 'trial_click'

export function track(kind: Kind, page = location.pathname) {
  if (getToken()) return
  if (kind === 'visit') {
    try {
      const k = `copybook-seen:${page}`
      if (sessionStorage.getItem(k)) return
      sessionStorage.setItem(k, '1')
    } catch {
      /* storage blocked: count it anyway */
    }
  }
  const tags = utmTags() as Record<string, string>
  apiReady
    .then((base) =>
      fetch(`${base}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, page, utm_source: tags.utm_source ?? null }),
        keepalive: true,
      }),
    )
    .catch(() => undefined)
}

/** Counts a signed-out visit to this page, once per session. */
export function useTrackVisit() {
  const { pathname } = useLocation()
  useEffect(() => track('visit', pathname), [pathname])
}
