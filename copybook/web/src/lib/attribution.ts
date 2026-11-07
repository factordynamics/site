// Carries the landing UTMs to Stripe so on-site sales are attributed like direct links:
// client_reference_id={source}_{content} (marketing link contract), plus the utm_* fields.
const KEY = 'copybook-utm'
const DAY = 86_400_000
type Touch = { source: string; content?: string; campaign?: string; exp: number }

const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 90)

/** Record the latest campaign touch (or external referrer) for 30 days. Call once on load. */
export function captureAttribution() {
  try {
    const q = new URLSearchParams(location.search)
    const source = q.get('utm_source')
    let touch: Touch | null = null
    if (source) {
      touch = { source, content: q.get('utm_content') ?? undefined, campaign: q.get('utm_campaign') ?? undefined, exp: Date.now() + 30 * DAY }
    } else if (document.referrer && !localStorage.getItem(KEY)) {
      const host = new URL(document.referrer).hostname.replace(/^www\./, '')
      if (host && host !== location.hostname) touch = { source: host, content: 'referral', exp: Date.now() + 30 * DAY }
    }
    if (touch) localStorage.setItem(KEY, JSON.stringify(touch))
  } catch {
    // Storage blocked: checkout links stay unattributed.
  }
}

/** A Stripe Payment Link with the visitor's attribution attached. */
export function attributed(link: string) {
  let t: Touch | null = null
  try {
    t = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Touch | null
    if (t && Date.now() > t.exp) t = null
  } catch {
    t = null
  }
  const u = new URL(link)
  u.searchParams.set('client_reference_id', t ? `${clean(t.source)}_${clean(t.content || 'none')}` : 'direct_site')
  if (t) {
    u.searchParams.set('utm_source', t.source)
    if (t.content) u.searchParams.set('utm_content', t.content)
    if (t.campaign) u.searchParams.set('utm_campaign', t.campaign)
  }
  return u.toString()
}
