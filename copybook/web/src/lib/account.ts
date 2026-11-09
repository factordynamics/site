import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, apiReady, rereadApi } from '../config'

export type Member = {
  email: string
  status: string
  active: boolean
  /** The product: copy, pro or fund. Older records read as copy. */
  plan: 'copy' | 'pro' | 'fund' | string
  interval?: 'monthly' | 'yearly' | 'unknown'
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
  pause_offer?: { until: string | number; quarter?: string; deadline?: string | number } | null
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
const setToken = (token: string) => {
  localStorage.setItem(KEY, JSON.stringify({ token, exp: Date.now() + 30 * DAY }))
  sessionStorage.removeItem(REAUTH)
}
// Set when the API rejects a stored session (401), such as a session from before the server move: the
// account page and My book then ask the member to sign in again instead of treating them as a visitor.
const REAUTH = 'copybook-reauth'
export const needsReauth = () => !getToken() && sessionStorage.getItem(REAUTH) === '1'
export const signOut = () => {
  localStorage.removeItem(KEY)
  forgetMe()
  try {
    localStorage.removeItem(ME_LAST)
    localStorage.removeItem('copybook-follows-last')
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

export class ApiError extends Error {
  status: number
  /** The API's error code and readable message, when the response carried them. */
  code?: string
  detail?: string
  constructor(status: number, body?: { code?: string; error?: string } | null) {
    super(`api ${status}`)
    this.status = status
    this.code = body?.code
    this.detail = body?.error
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

/** fetch against the current API base. A network-level failure (a rotated tunnel URL) re-reads api.json
 *  once, and the request is retried if the base moved. */
async function apiFetch(path: string, init?: RequestInit) {
  await apiReady
  try {
    return await fetch(`${api}${path}`, init)
  } catch (e) {
    if (e instanceof TypeError && (await rereadApi())) return fetch(`${api}${path}`, init)
    throw e
  }
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

export async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean; cache?: RequestCache; timeout?: number } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  if (init.auth) {
    const t = getToken()
    if (!t) throw new ApiError(401)
    headers.Authorization = `Bearer ${t}`
  }
  const res = await apiFetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: init.cache,
    signal: init.timeout ? AbortSignal.timeout(init.timeout) : undefined,
  }).catch((e) => {
    setDown(true)
    throw e
  })
  setDown(res.status === 429 || res.status >= 500)
  if (res.status === 401 && init.auth) {
    sessionStorage.setItem(REAUTH, '1')
    signOut()
  }
  if (res.ok && init.auth && (init.method ?? (init.body !== undefined ? 'POST' : 'GET')) !== 'GET') {
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

export async function startSession(body: { checkout_session: string } | { login: string }) {
  const r = await call<{ token: string; member: Member }>('/session', { body })
  setToken(r.token)
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
export const resumePlan = () => call<{ ok: boolean }>('/pause', { method: 'DELETE', auth: true }).finally(forgetMe)
export const sendCancelReason = (reason: CancelReason, note?: string) => call<{ ok: boolean }>('/cancel-reason', { body: { reason, ...(note ? { note } : {}) }, auth: true })
/** Throws when the sign-in email can't be queued (a 5xx or no answer in 15 s), so the form can say so. */
export const requestLogin = (email: string) => call<{ ok: boolean }>('/login', { body: { email }, timeout: 15_000 })
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
  change: 'new' | 'added' | 'trimmed' | 'exited' | 'unchanged' | null
  weight: number | null
  put_call?: string | null
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
  if (res.status === 401) signOut()
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
      },
    )
    .catch(() => null)
/** 100 -> "1m40s", 42 -> "42s". */
export const gapLabel = (s: number) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`)
