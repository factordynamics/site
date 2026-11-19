import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { apiReady } from '../config'
import { getToken } from './account'
import { utmTags } from './attribution'

// Launch-week funnel counts for signed-out readers on the pages X posts land on (filer pages, /season/,
// /f/ cards): visits, free signups shown, and trial clicks, by page and utm_source (POST {api}/track).
// Counting only: no identifiers are sent (of the referrer, only its host, such as www.bing.com), a visit counts once per page per browser session, and a failure is ignored.
// signup_focus (first focus on a signup's email field) and signup_submit count once per page per session, like a visit.
type Kind = 'visit' | 'signup_view' | 'signup_focus' | 'signup_submit' | 'trial_click'

export function track(kind: Kind, page = location.pathname) {
  if (getToken()) return
  if (kind !== 'trial_click') {
    try {
      const k = `copybook-${kind}:${page}`
      if (sessionStorage.getItem(k)) return
      sessionStorage.setItem(k, '1')
    } catch {
      /* storage blocked: count it anyway */
    }
  }
  const tags = utmTags() as Record<string, string>
  const ref_host = refHost()
  apiReady
    .then((base) =>
      fetch(`${base}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, page, utm_source: tags.utm_source ?? null, utm_content: tags.utm_content ?? null, ...(ref_host ? { ref_host } : {}) }),
        keepalive: true,
      }),
    )
    .catch(() => undefined)
}

/** The referring site's host only, never its path or query; none when there's no referrer or it's this site. */
function refHost() {
  try {
    const h = document.referrer ? new URL(document.referrer).hostname : ''
    return h && h !== location.hostname ? h : null
  } catch {
    return null
  }
}

/** Counts a signed-out visit to this page, once per session. */
export function useTrackVisit() {
  const { pathname } = useLocation()
  useEffect(() => track('visit', pathname), [pathname])
}
