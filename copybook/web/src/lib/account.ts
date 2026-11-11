import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, apiReady, rereadApi } from '../config'

export type Member = {
  email: string
  status: string
  active: boolean
  /** False on a Copy trial started without a card (payments, Nov 11): it ends unless one is added. */
  has_payment_method?: boolean
  /** "pending_email_confirmation" until the emailed link is opened: follows and channels save, nothing is delivered. */
  delivery?: 'pending_email_confirmation' | 'active'
  /** A Copy subscription from before Feb 1, 2027: $9/$79, kept while subscribed (a pause keeps it). */
  founding_price?: boolean
  /** Yearly Copy, Pro or Fund: history back to 2013 from Dec 31. */
  yearly_perks?: boolean
  /** The product: copy, pro or fund. Older records read as copy. */
  plan: 'copy' | 'pro' | 'fund' | string
  interval?: 'monthly' | 'yearly' | 'unknown'
  /** `send_invoice` when the plan is billed by invoice (Net 30) instead of a card. */
  collection?: 'charge_automatically' | 'send_invoice' | null
  /** A Copy Fund trial billed by invoice: when the invoice comes, when it's due, and what prints on it. */
  invoice_trial?: { invoice_on: string; due_on: string; amount?: number | null; currency?: string; po?: string | null; ap_email?: string | null; invoice_to?: string | null } | null
  trial_end?: number | null
  period_end?: number | string | null
  /** Cancelled in the billing portal: access continues until cancel_at (unix seconds). */
  cancel_at_period_end?: boolean
  cancel_at?: number | null
  alerts: 'all' | 'off' | string[]
  /** A Copy Fund seat: billing and the team belong to the owner. */
  seat?: boolean
  /** Chat or webhook destinations that stopped delivering, by destination. */
  channels_failing?: Partial<Record<'discord' | 'slack' | 'telegram' | 'webhook', { reason: string; since: string }>>
  /** The Fund owner's email, when the API sends it to a seat. */
  owner?: string | null
  /** Paying members' referral link and counts; null for seats, Holdterm and free members. */
  referral?: { code: string; url: string; signups: number; paid: number; months_earned: number } | null
  /** Paying monthly members who aren't paused: "Pause until the next season" (until is a date or unix seconds). */
  pause_offer?: { until: string | number; quarter?: string; deadline?: string | number; starts?: string | number; note?: string } | null
  /** A pause scheduled for the end of the trial (unix seconds): everything stays on until `from`. */
  pause_after_trial?: { from: number; until: number } | null
  /** While paused (unix seconds): access is off, follows and settings are kept. */
  paused_until?: number | null
  /** The weekly "Your names this week" digest is sending; only then do pause screens promise it. */
  digest_live?: boolean
  /** Free accounts: saved names and the Friday email's "In your names" block (facts only for names a superinvestor moved this week). */
  free_names?: { names: string[]; limit: number; facts?: { ticker: string; text: string; url: string }[]; hook?: string | null; more?: number } | null
}

const KEY = 'copybook-session'
const DAY = 86_400_000

export function getToken(): string | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const { token, exp } = JSON.parse(raw) as { token: string; exp: number }
    if (Date.now() > exp) {
      localStorage.removeItem(KEY)
      return null
    }
    return token
  } catch {
    return null
  }
}
// `prov`: a provisional session's address (a checkout or signup hand-off, not yet proven by the emailed link). Any
// other session, or signing out, clears it.
const setToken = (token: string, prov: string | null = null) => {
  localStorage.setItem(KEY, JSON.stringify({ token, exp: Date.now() + 30 * DAY, ...(prov ? { prov } : {}) }))
  sessionStorage.removeItem(REAUTH)
}
/** A session from before `prov` was kept answered 403 verify_email: it's provisional, for the member's address. */
function markProvisional() {
  const token = getToken()
  const email = lastMe()?.email
  if (token && email && !provisionalEmail()) setToken(token, email)
}
/** The address the sign-in link went to while this device's session is provisional: alerts, channels, tests and
 *  keys wait for that link (the API's 403 verify_email). Null for a full session or none. */
export function provisionalEmail(): string | null {
  try {
    return getToken() ? ((JSON.parse(localStorage.getItem(KEY) ?? 'null') as { prov?: string } | null)?.prov ?? null) : null
  } catch {
    return null
  }
}
// Set when the API confirms a stored session is invalid (401), such as a session from before the server move: the
// account page and My book then ask the member to sign in again instead of treating them as a visitor.
const REAUTH = 'copybook-reauth'
export const needsReauth = () => !getToken() && sessionStorage.getItem(REAUTH) === '1'
export const signOut = () => {
  localStorage.removeItem(KEY)
  forgetMe()
  try {
    localStorage.removeItem(ME_LAST)
    localStorage.removeItem('copybook-follows-last')
    localStorage.removeItem('copybook-channels-last')
    localStorage.removeItem(EV_LAST)
  } catch {
    // Storage blocked.
  }
}

// /me is read on most signed-in pages. This tab keeps it for 60 seconds (for this session token only) and
// drops it after any write through the API and before leaving for Stripe, so a page view usually costs no
// /me request. useMemberState revalidates on focus once it's older than that.
const ME = 'copybook-me'
const ME_TTL = 60_000
function cachedMe(): Member | null {
  try {
    const c = JSON.parse(sessionStorage.getItem(ME) ?? 'null') as { token: string; at: number; member: Member } | null
    return c && c.token === getToken() && Date.now() - c.at < ME_TTL ? c.member : null
  } catch {
    return null
  }
}
// The last /me this browser saw for this session, of any age: pages render from it at once, marked
// "Updating…", so a slow or failing API never means a blank page; the fresh answer replaces it.
const ME_LAST = 'copybook-me-last'
export function lastMe(): Member | null {
  try {
    const c = JSON.parse(localStorage.getItem(ME_LAST) ?? 'null') as { token: string; member: Member } | null
    return c && c.token === getToken() ? c.member : null
  } catch {
    return null
  }
}
/** Whether this tab holds a /me fresh enough to use without asking (60 s). */
export const cachedFresh = () => cachedMe() != null
export function forgetMe() {
  try {
    sessionStorage.removeItem(ME)
  } catch {
    // Storage blocked: nothing cached.
  }
}

export const VERIFY_MSG = 'Open the sign-in link we emailed you to do this.'
/** 403 verify_email: the session is provisional until the emailed link is opened. */
export const needsVerify = (e: unknown) => e instanceof ApiError && e.code === 'verify_email'
/** The error to show next to a control: the API's verify_email text, else the control's own fallback. */
export const errText = (e: unknown, fallback: string) => (needsVerify(e) ? ((e as ApiError).detail ?? VERIFY_MSG) : fallback)

export class ApiError extends Error {
  status: number
  /** The API's error code and readable message, when the response carried them. */
  code?: string
  detail?: string
  /** A 429's wait, from the body (retry_after, or retry_after_seconds / retry_at as payments may name them). */
  retryAt?: number
  /** /signup's already_member or already_sent: when the last sign-in email went. */
  sentAt?: string
  /** A /signup 429 for an email that already has an account. */
  alreadyMember?: boolean
  constructor(status: number, body?: { code?: string; error?: string; retry_after?: number; retry_after_seconds?: number; retry_at?: string; sent_at?: string; sign_in_sent_at?: string; already_member?: boolean } | null) {
    super(`api ${status}`)
    this.status = status
    this.code = body?.code
    this.detail = body?.error
    const wait = body?.retry_after_seconds ?? body?.retry_after
    this.retryAt = body?.retry_at ? Date.parse(body.retry_at) : typeof wait === 'number' ? Date.now() + wait * 1000 : undefined
    this.sentAt = body?.sign_in_sent_at ?? body?.sent_at
    this.alreadyMember = body?.already_member === true
    // A provisional session (signup or checkout hand-off) refused a control: every page shows the reason once.
    if (body?.code === 'verify_email' && typeof window !== 'undefined') {
      markProvisional()
      window.dispatchEvent(new CustomEvent('copybook:verify', { detail: body.error ?? VERIFY_MSG }))
    }
  }
}

// Set when the API answers 429 or 5xx, or can't be reached: pages then say the account is temporarily
// unavailable instead of treating the member as signed out. Nothing retries on its own.
let down = false
export const apiDown = () => down
const downSubs = new Set<() => void>()
const setDown = (v: boolean) => {
  if (v === down) return
  down = v
  downSubs.forEach((f) => f())
}
/** Re-renders when the API starts or stops answering 429/5xx (the status banner). */
export const useApiDown = () => useSyncExternalStore((f) => (downSubs.add(f), () => downSubs.delete(f)), apiDown)
/** The API base for display (docs, curl examples), re-rendered once api.json has answered. */
export function useApiBase() {
  const [b, setB] = useState(api)
  useEffect(() => {
    apiReady.then(setB)
  }, [])
  return b
}

/** fetch against the current API base. A failed call (network error, or a gateway 5xx from a host that's down)
 *  re-reads api.json, and the request is retried once if the base moved: a page open across a failover follows
 *  member access to the backup without a reload. */
async function apiFetch(path: string, init?: RequestInit) {
  await apiReady
  let res: Response
  try {
    res = await fetch(`${api}${path}`, init)
  } catch (e) {
    if (await rereadApi()) return fetch(`${api}${path}`, init)
    throw e
  }
  if ([502, 503, 504, 521, 522, 523, 524, 530].includes(res.status) && (await rereadApi())) return fetch(`${api}${path}`, init)
  return res
}

/** A public GET that should also drive the status banner (the /api/ page's changelog). */
export async function probe<T>(path: string): Promise<T> {
  const res = await apiFetch(path).catch((e) => {
    setDown(true)
    throw e
  })
  setDown(res.status === 429 || res.status >= 500)
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
  return res.json() as Promise<T>
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/**
 * True only when the API confirms the session is invalid. A 401 that isn't the API's JSON member answer (a
 * proxy or tunnel during a restart, another host) never signs a member out; only code 'invalid_session' does
 * (forged, expired or revoked). A host without codes yet: its bare "sign in required" is confirmed by one more
 * /me read 1.5 s later.
 */
async function sessionInvalid(res: Response, token: string): Promise<boolean> {
  const body = (await res.clone().json().catch(() => null)) as { code?: string; error?: string } | null
  if (body?.code) return body.code === 'invalid_session' // member_unavailable (failover lag), no_session, link codes: keep it
  if (body?.error !== 'sign in required') return false
  await wait(1500)
  const again = await apiFetch('/me', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => null)
  if (again?.status !== 401) return false
  const b = (await again.json().catch(() => null)) as { code?: string; error?: string } | null
  return b?.code ? b.code === 'invalid_session' : b?.error === 'sign in required'
}
/** Signs out after a confirmed invalid session, unless this tab already holds a newer one. True if it signed out. */
async function onUnauthorized(res: Response, token: string) {
  if (!(await sessionInvalid(res, token)) || getToken() !== token) return false
  sessionStorage.setItem(REAUTH, '1')
  signOut()
  return true
}

export async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean; cache?: RequestCache; timeout?: number } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET')
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const token = init.auth ? getToken() : null
  if (init.auth) {
    if (!token) throw new ApiError(401)
    headers.Authorization = `Bearer ${token}`
  }
  const send = () =>
    apiFetch(path, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: init.cache,
      signal: init.timeout ? AbortSignal.timeout(init.timeout) : undefined,
    })
  // A read that meets a dropped connection or a 5xx (an API restart) is retried once after a short wait;
  // writes aren't, so nothing is sent twice. Neither ever clears the stored session.
  let res = await send().catch(async (e) => {
    if (method !== 'GET') throw e
    await wait(1500)
    return send()
  }).catch((e) => {
    setDown(true)
    throw e
  })
  if (method === 'GET' && res.status >= 500) {
    await wait(1500)
    res = await send().catch(() => res)
  }
  setDown(res.status === 429 || res.status >= 500)
  // An unconfirmed 401 keeps the session, and a read is asked once more.
  if (res.status === 401 && token && !(await onUnauthorized(res, token)) && method === 'GET') res = await send().catch(() => res)
  if (res.ok && init.auth && method !== 'GET') {
    forgetMe()
    shared.clear()
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
  return res.json() as Promise<T>
}

// GETs that several components on one page make (the setup checklist and the channels panel both read
// /channels): one request, shared for 10 seconds or until the next write.
const shared = new Map<string, { at: number; p: Promise<unknown> }>()
export function sharedGet<T>(path: string): Promise<T> {
  const hit = shared.get(path)
  if (hit && Date.now() - hit.at < 10_000) return hit.p as Promise<T>
  const p = call<T>(path, { auth: true })
  p.catch(() => shared.delete(path))
  shared.set(path, { at: Date.now(), p })
  return p
}

/** A new free account's provisional session (POST /signup 201 `token`): this device is signed in at once, until
 *  the emailed link or a subscription replaces it. Pages mounted after this read it; nothing cached is kept. */
export function adoptSession(token: string) {
  setToken(token)
  forgetMe()
}

/** Null when the checkout's address already had an account (code existing_account): no token comes back, so
 *  the browser keeps the session it has, and the member signs in with the emailed link. */
export async function startSession(body: { checkout_session: string } | { login: string }) {
  const r = await call<{ token?: string; member: Member | null; code?: string; session?: string; error?: string }>('/session', { body })
  // A repeat trial: payments cancelled the new $0 subscription at completion (one free trial per person).
  if (r.code === 'trial_used') throw new ApiError(409, { code: r.code, error: r.error })
  if (!r.token) return null
  setToken(r.token, r.session === 'provisional' ? (r.member?.email ?? null) : null)
  return r.member
}

export const PLAN_NAME: Record<string, string> = { copy: 'Copy', pro: 'Copy Pro', fund: 'Copy Fund' }
/** A free Friday-email account (POST /signup): no paid plan, every paid route answers 402. */
export const isFree = (m?: Member | null) => Boolean(m && !m.active && (m.plan === 'free' || m.status === 'free'))
/** Active, trialing or paused on Copy or above. Every other state (signed out, free, cancelled, /me failing) sees the trial CTAs. */
export const isPaying = (m?: Member | null) => Boolean(m && ['copy', 'pro', 'fund'].includes(m.plan) && (m.active || (m.paused_until ?? 0) * 1000 > Date.now()))
export const isPro = (m?: Member | null) => Boolean(m?.active && (m.plan === 'pro' || m.plan === 'fund'))

// Components that mount together (header, follow and share buttons) share one in-flight /me request.
let meInFlight: Promise<Member> | null = null
/** GET /me from the API (after a write, or to revalidate), past the browser's HTTP cache (/me sends
 *  max-age=30); the result refreshes this tab's cache. */
export const fetchMe = () =>
  (meInFlight ??= call<{ member: Member }>('/me', { auth: true, cache: 'no-store', timeout: 20_000 })
    .then((r) => {
      try {
        sessionStorage.setItem(ME, JSON.stringify({ token: getToken(), at: Date.now(), member: r.member }))
        localStorage.setItem(ME_LAST, JSON.stringify({ token: getToken(), member: r.member }))
      } catch {
        // Storage blocked: no cache, every page asks.
      }
      return r.member
    })
    .finally(() => (meInFlight = null)))
/** /me from this tab's 60-second cache, else the API. */
export const readMe = () => {
  const c = cachedMe()
  return c ? Promise.resolve(c) : fetchMe()
}
export type CancelReason = 'seasonal' | 'price' | 'value' | 'feature' | 'alerts' | 'temporary' | 'other'
// A pause or resume changes /me: the tab's cached copy is dropped so the next read asks the API.
export const pausePlan = (reason?: CancelReason) => call<{ ok: boolean; paused_until: number }>('/pause', { body: reason ? { reason } : {}, auth: true }).finally(forgetMe)
/** Ends every session of this member, copied ones included, and keeps this browser signed in with the new one. */
export async function signOutEverywhere() {
  const r = await call<{ ok: boolean; token: string }>('/me/sessions/revoke', { method: 'POST', auth: true })
  setToken(r.token)
  forgetMe()
}
export const resumePlan = () => call<{ ok: boolean }>('/pause', { method: 'DELETE', auth: true }).finally(forgetMe)
export const sendCancelReason = (reason: CancelReason, note?: string) => call<{ ok: boolean }>('/cancel-reason', { body: { reason, ...(note ? { note } : {}) }, auth: true })
/** Throws when the sign-in email can't be queued (a 5xx or no answer in 15 s), so the form can say so. */
export const requestLogin = (email: string) => call<{ ok: boolean }>('/login', { body: { email }, timeout: 15_000 })
/** Stripe's confirm page for the same subscription at the yearly price (POST /yearly); it returns to /account/?kept=yearly. */
export const switchYearly = () => call<{ url: string }>('/yearly', { method: 'POST', auth: true }).then((r) => (window.location.href = r.url))
/** Stripe's add-a-card form (POST /portal/card); it returns to /account/?card=added. With a plan, a trial moves to
 *  that price first (its end date unchanged). */
export const addCard = (plan?: 'monthly' | 'yearly') => call<{ url: string }>('/portal/card', { method: 'POST', auth: true, ...(plan ? { body: { plan } } : {}) }).then((r) => (window.location.href = r.url))
/** The address waiting on its sign-in link: /me's delivery, else this device's provisional session. */
export const pendingEmail = (m?: Member | null) => (m?.delivery === 'pending_email_confirmation' ? m.email : null) ?? provisionalEmail()
export const openPortal = () => call<{ url: string }>('/portal', { method: 'POST', auth: true }).then((r) => (window.location.href = r.url))
/**
 * Move an existing subscription to a higher plan: POST {api}/upgrade returns a billing-portal page that
 * confirms the swap, prorated, on the member's own interval and the founding price. A new checkout
 * would start a second subscription. Errors are thrown: /upgrade/ shows them or falls back to the portal.
 */
export async function upgradeTo(plan: 'pro' | 'fund') {
  window.location.href = (await call<{ url: string }>('/upgrade', { body: { plan }, auth: true })).url
}
/** An issuer's own EDGAR feed: Form 4s by its insiders and Schedule 13D/G by any filer on it. */
export type IssuerEvent = {
  ticker: string
  form: string
  filer_name: string
  role: string | null
  action: 'buy' | 'sell' | 'mixed' | 'grant' | 'option_exercise' | 'tax_withholding' | 'gift' | 'conversion' | 'other' | 'new_stake' | 'stake_update'
  shares: number | null
  price: number | null
  value_usd: number | null
  shares_after: number | null
  prev_shares_after: number | null
  percent_of_class: number | null
  event_date: string | null
  /** Form 4: the open-market trade's date (the window is on it). */
  trade_date?: string | null
  /** The EDGAR filing date (New York acceptance date). */
  filed_date?: string | null
  /** (P − S shares) ÷ the holding just before those trades, in percent; null without open-market trades. */
  pct_change?: number | null
  /** An option exercise (M/X) and a sale on the same date. */
  exercise_and_sale?: boolean
  /** Form 4: codes other than P/S on the traded class (J: a distribution, as DASH's founders' sales). */
  has_other_codes?: string[]
  accepted_at: string
  accession: string
  url: string
  /** Form 4: every transaction line as filed (P, S, M, F, G, A, ...), derivative lines flagged. */
  transactions?: { code: string; date: string | null; shares: number; price: number | null; acquired_disposed: 'A' | 'D' | null; derivative: boolean; security?: string }[] | null
}
/** One row of GET /stocks/{T}/holders (Pro and Fund): every 13F filer holding the issuer in its latest full book. */
export type ApiHolder = {
  filer: { cik: string; name: string; slug: string; type: string | null; curated: boolean }
  period: string
  kind: string
  shares: number
  prev_shares: number | null
  value_usd: number
  prev_value_usd: number | null
  change: 'new' | 'added' | 'trimmed' | 'exited' | 'unchanged' | 'unknown' | null
  weight: number | null
  put_call?: string | null
  suspect_units?: boolean
  suspect_reason?: string | null
  unreliable?: 'value' | 'shares' | 'both' | null
}
/** A page of up to 1,000 holders, largest first; `truncated` while only the public top 25 is on the server. */
export const loadHolders = (t: string, type: string | null, offset: number) =>
  call<{ count: number; filers?: number; truncated: boolean; holders: ApiHolder[]; next_offset: number | null }>(`/stocks/${encodeURIComponent(t)}/holders?cohort=all&limit=1000&offset=${offset}${type ? `&type=${type}` : ''}`, { auth: true })
/** One ticker's issuer feed; `window` is where it is complete back to (the quarter start, e.g. Jul 1), null when it isn't. */
export type IssuerFeed = IssuerEvent[] & { window?: string | null }
/** GET /events, one request per 50 tickers. A cold call lists what it couldn't load yet in `pending`; those are
 *  asked for once more, 2 seconds later (each request counts against the API's daily quota). */
export async function loadEvents(tickers: string[], timeout = 30_000) {
  const out = new Map<string, IssuerFeed>()
  let todo = [...new Set(tickers)]
  // One batch, tried up to 3 times (2 s then 6 s apart) when the API is slow or failing.
  const get = async (b: string[]) => {
    for (let k = 0; ; k++) {
      try {
        return await call<{ tickers: Record<string, { events: IssuerEvent[]; window?: string | null }>; pending?: string[] }>(`/events?tickers=${b.map(encodeURIComponent).join(',')}&window=quarter`, { auth: true, timeout })
      } catch (e) {
        if (k >= 2 || (e instanceof ApiError && e.status < 500 && e.status !== 429)) throw e
        await new Promise((r) => setTimeout(r, k ? 6000 : 2000))
      }
    }
  }
  for (let i = 0; todo.length && i < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000))
    const batches = Array.from({ length: Math.ceil(todo.length / 50) }, (_, j) => todo.slice(j * 50, j * 50 + 50))
    const res = await Promise.all(batches.map(get))
    const pending = new Set(res.flatMap((r) => r.pending ?? []))
    for (const r of res) for (const [t, v] of Object.entries(r.tickers ?? {})) if (!pending.has(t) || v.events.length) out.set(t, Object.assign(v.events, { window: v.window ?? null }))
    todo = todo.filter((t) => pending.has(t))
  }
  try {
    const c = readEvCache()
    for (const [t, v] of out) c[t] = { events: [...v], window: v.window ?? null }
    localStorage.setItem(EV_LAST, JSON.stringify({ token: getToken(), tickers: c }))
  } catch {
    // Storage blocked or full: no cache.
  }
  return out
}
// The last /events answer per ticker for this session: My book renders from it at once and refreshes.
const EV_LAST = 'copybook-events-last'
function readEvCache(): Record<string, { events: IssuerEvent[]; window: string | null }> {
  try {
    const c = JSON.parse(localStorage.getItem(EV_LAST) ?? 'null') as { token: string; tickers: Record<string, { events: IssuerEvent[]; window: string | null }> } | null
    return c && c.token === getToken() ? c.tickers : {}
  } catch {
    return {}
  }
}
/** The cached feeds for whichever of these tickers have one. */
export function lastEvents(tickers: string[]): Map<string, IssuerFeed> {
  const c = readEvCache()
  return new Map(tickers.filter((t) => c[t]).map((t) => [t, Object.assign([...c[t].events], { window: c[t].window })]))
}

export const setAlerts = (alerts: Member['alerts']) => call<{ member: Member }>('/alerts', { body: { alerts }, auth: true }).then((r) => r.member)
/** Download an authenticated CSV route ({api}/stocks/{T}/holders.csv, {api}/follows.csv) as a file. */
export async function downloadFile(path: string, filename: string) {
  const t = getToken()
  if (!t) throw new ApiError(401)
  const res = await apiFetch(path, { headers: { Authorization: `Bearer ${t}` } })
  if (res.status === 401) await onUnauthorized(res, t)
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
/** Download a fund's CSV. The API mints a single-use 60-second link on click; session tokens never go in a URL. */
export async function downloadCsv(slug: string) {
  const { url } = await call<{ url: string }>(`/csv-link/${slug}`, { method: 'POST', auth: true })
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** undefined while checking, null when signed out or not a member. Calls the API only when a token exists. */
/** True while a page shows the last-known /me and the fresh one hasn't arrived ("Updating…"). */
let meStale = false
const staleSubs = new Set<() => void>()
const setStale = (v: boolean) => {
  if (v === meStale) return
  meStale = v
  staleSubs.forEach((f) => f())
}
export const useMeUpdating = () => useSyncExternalStore((f) => (staleSubs.add(f), () => staleSubs.delete(f)), () => meStale)

export function useMemberState() {
  // Fresh from this tab's cache, else the last-known member (shown at once, marked updating), else loading.
  const [member, setMember] = useState<Member | null | undefined>(() => (api && getToken() ? (cachedMe() ?? lastMe() ?? undefined) : null))
  useEffect(() => {
    if (!api || !getToken()) return
    if (!cachedMe() && lastMe()) setStale(true)
    readMe().then(
      (m) => {
        setStale(false)
        setMember(m)
      },
      // A failing API keeps the last-known member (the status banner says why); a 401 has signed out.
      () => {
        setStale(false)
        setMember(getToken() ? (lastMe() ?? null) : null)
      },
    )
    // Back in the tab after the cache has expired: one fresh read.
    const onFocus = () => document.visibilityState === 'visible' && getToken() && !cachedMe() && fetchMe().then(setMember, () => null)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])
  return member
}

/** Signed-in member, or null. */
export const useMember = () => useMemberState() ?? null

/** Public alert latency for the filing season ({api}/latency): EDGAR acceptance to email sent. Empty until live alerts go out. */
export type LatencyStat = { count: number; median_seconds: number | null; p90_seconds: number | null }
export type Latency = {
  season: string
  since?: string
  median_seconds: number | null
  p90_seconds?: number | null
  p95_seconds: number | null
  count: number
  /** Keyed 13F, Form 4, 13D, 13G; and email, slack, discord, telegram, webhook, feed. */
  by_form?: Record<string, LatencyStat>
  by_channel?: Record<string, LatencyStat>
  /** When the EDGAR poller last ran (ISO) and on which host, once the latency file carries them. */
  poller_last_run?: string | null
  poller_host?: string | null
  /** The latest alerts, newest first (the API's `recent`, or its older `alerts`). */
  alerts: { slug: string; manager: string; quarter?: string | null; form: string; accession: string; accepted_at: string; sent_at: string; gap_seconds: number; channel?: string }[]
  /** Every live alert this season (the API's `alerts`), for /speed/'s figures; `alerts` above may be only the latest. */
  log?: Latency['alerts']
}
type RawLatency = Omit<Latency, 'alerts'> & { alerts?: Latency['alerts']; recent?: { form: string; manager: string; slug: string; accession: string; accepted_at: string; delivered_at: string; seconds: number; channel: string }[] }
// The latency log from static files, never the API: the public R2 copy (api.config.mjs, rewritten each
// minute), else the copy the last Pages build wrote (scripts/cards.mjs). The cache-buster changes each minute.
export const loadLatency = () =>
  fetch(`${import.meta.env.VITE_LATENCY_URL}?m=${Math.floor(Date.now() / 60_000)}`)
    .then((r) => (r.ok ? r : Promise.reject(new Error(String(r.status)))))
    .catch(() => fetch(`${import.meta.env.BASE_URL}d/latency.json`))
    .then((r) => (r.ok ? (r.json() as Promise<RawLatency>) : null))
    .then((d): Latency | null =>
      d && {
        ...d,
        alerts: d.recent?.length ? d.recent.map((x) => ({ ...x, sent_at: x.delivered_at, gap_seconds: x.seconds })) : (d.alerts ?? []),
        log: d.alerts ?? [],
      },
    )
    .catch(() => null)
/** 100 -> "1m40s", 42 -> "42s". */
export const gapLabel = (s: number) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`)
