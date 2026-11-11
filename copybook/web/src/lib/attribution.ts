import { apiReady } from '../config'
// Carries the landing UTMs to Stripe so on-site sales are attributed like direct links:
// client_reference_id={source}_{content} (marketing link contract), plus the utm_* fields.
const KEY = 'copybook-utm'
const DAY = 86_400_000
type Touch = { source: string; content?: string; campaign?: string; medium?: string; term?: string; exp: number }

const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 90)

/** Record the latest campaign touch (or external referrer) for 30 days. Call once on load. */
export function captureAttribution() {
  try {
    const q = new URLSearchParams(location.search)
    const source = q.get('utm_source')
    let touch: Touch | null = null
    if (source) {
      touch = { source, content: q.get('utm_content') ?? undefined, campaign: q.get('utm_campaign') ?? undefined, medium: q.get('utm_medium') ?? undefined, term: q.get('utm_term') ?? undefined, exp: Date.now() + 30 * DAY }
    } else if (document.referrer && !localStorage.getItem(KEY)) {
      const host = new URL(document.referrer).hostname.replace(/^www\./, '')
      if (host && host !== location.hostname) touch = { source: host, content: 'referral', exp: Date.now() + 30 * DAY }
    }
    if (touch) localStorage.setItem(KEY, JSON.stringify(touch))
  } catch {
    // Storage blocked: checkout links stay unattributed.
  }
}

/** The landing campaign's utm_* tags (or the external referrer as utm_source), for POST /signup. */
export function utmTags() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Touch | null
    if (!t || Date.now() > t.exp) return {}
    const out: Record<string, string> = { utm_source: t.source }
    if (t.medium) out.utm_medium = t.medium
    if (t.campaign) out.utm_campaign = t.campaign
    if (t.content) out.utm_content = t.content
    if (t.term) out.utm_term = t.term
    return out
  } catch {
    return {}
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
  // A signed-in free or cancelled member checks out with their account's email, so the plan lands on the same account.
  try {
    const last = JSON.parse(localStorage.getItem('copybook-me-last') ?? 'null') as { member?: { email?: string; active?: boolean } } | null
    const email = last?.member?.email && !last.member.active && localStorage.getItem('copybook-session') ? last.member.email : localStorage.getItem('copybook-signup-email')
    if (email) u.searchParams.set('prefilled_email', email)
  } catch {
    /* storage blocked */
  }
  u.searchParams.set('client_reference_id', t ? `${clean(t.source)}_${clean(t.content || 'none')}` : 'direct_site')
  if (t) {
    u.searchParams.set('utm_source', t.source)
    if (t.content) u.searchParams.set('utm_content', t.content)
    if (t.campaign) u.searchParams.set('utm_campaign', t.campaign)
  }
  return u.toString()
}

// Referrals: a shared link (pricing/?ref=CODE) is kept for 30 days, so it survives browsing before
// checkout. While one is kept, paid buttons start a checkout session through the API (POST /checkout),
// which carries the code; without one, the Payment Links stay as they are.
const REF = 'copybook-ref'

export function captureRef() {
  try {
    const code = new URLSearchParams(location.search).get('ref')
    if (code && /^[A-Za-z0-9_-]{2,40}$/.test(code)) localStorage.setItem(REF, JSON.stringify({ code, exp: Date.now() + 30 * DAY }))
  } catch {
    // Storage blocked: the referral applies only if they check out from this page.
  }
}

export function refCode(): string | null {
  try {
    const r = JSON.parse(localStorage.getItem(REF) ?? 'null') as { code: string; exp: number } | null
    return r && Date.now() < r.exp ? r.code : null
  } catch {
    return null
  }
}

/** Whether a referral code is real (GET {api}/ref/{code} answers { valid: true }). Anything else, including
 *  no such route yet, counts as not valid, so the free-month promise never shows for a made-up code. */
export const checkRef = (code: string | null): Promise<boolean> =>
  code
    ? apiReady
        .then((base) => fetch(`${base}/ref/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(5000) }))
        .then((r) => (r.ok ? (r.json() as Promise<{ valid?: boolean }>) : null))
        .then((j) => j?.valid === true)
        .catch(() => false)
    : Promise.resolve(false)

/** Click handler for a paid Payment Link: with a kept referral code, a checkout that carries it instead. */
export function referredCheckout(plan: 'copy' | 'pro' | 'fund', interval: 'monthly' | 'yearly', fallback: string) {
  return (e: { preventDefault: () => void }) => {
    const ref = refCode()
    if (!ref) return
    e.preventDefault()
    const tags = utmTags() as Record<string, string>
    apiReady.then((base) => fetch(`${base}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan, interval, ref, source: tags.utm_source ?? 'referral' }) }))
      .then((r) => (r.ok ? (r.json() as Promise<{ url: string; referral: { applied: boolean } | null }>) : Promise.reject(new Error(String(r.status)))))
      .then((r) => {
        // An unknown code, or an email that already pays: full price, and the code is spent.
        if (r.referral && !r.referral.applied) localStorage.removeItem(REF)
        window.location.href = r.url
      })
      .catch(() => {
        window.location.href = fallback
      })
  }
}
