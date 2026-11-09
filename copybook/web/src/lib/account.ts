import { useEffect, useState } from 'react'
import { api } from '../config'

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
const setToken = (token: string) => localStorage.setItem(KEY, JSON.stringify({ token, exp: Date.now() + 30 * DAY }))
export const signOut = () => localStorage.removeItem(KEY)

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

export async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  if (init.auth) {
    const t = getToken()
    if (!t) throw new ApiError(401)
    headers.Authorization = `Bearer ${t}`
  }
  const res = await fetch(`${api}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (res.status === 401 && init.auth) signOut()
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
  return res.json() as Promise<T>
}

export async function startSession(body: { checkout_session: string } | { login: string }) {
  const r = await call<{ token: string; member: Member }>('/session', { body })
  setToken(r.token)
  return r.member
}

export const PLAN_NAME: Record<string, string> = { copy: 'Copy', pro: 'Copy Pro', fund: 'Copy Fund' }
/** A free Friday-email account (POST /signup): no paid plan, every paid route answers 402. */
export const isFree = (m?: Member | null) => Boolean(m && !m.active && (m.plan === 'free' || m.status === 'free'))
export const isPro = (m?: Member | null) => Boolean(m?.active && (m.plan === 'pro' || m.plan === 'fund'))

export const fetchMe = () => call<{ member: Member }>('/me', { auth: true }).then((r) => r.member)
export type CancelReason = 'price' | 'value' | 'feature' | 'alerts' | 'temporary' | 'other'
export const pausePlan = (reason?: CancelReason) => call<{ ok: boolean; paused_until: number }>('/pause', { body: reason ? { reason } : {}, auth: true })
export const resumePlan = () => call<{ ok: boolean }>('/pause', { method: 'DELETE', auth: true })
export const sendCancelReason = (reason: CancelReason, note?: string) => call<{ ok: boolean }>('/cancel-reason', { body: { reason, ...(note ? { note } : {}) }, auth: true })
export const requestLogin = (email: string) => call<{ ok: boolean }>('/login', { body: { email } })
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
  accepted_at: string
  accession: string
  url: string
  /** Form 4: every transaction line as filed (P, S, M, F, G, A, ...), derivative lines flagged. */
  transactions?: { code: string; date: string | null; shares: number; price: number | null; acquired_disposed: 'A' | 'D' | null; derivative: boolean }[] | null
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
/** GET /events for up to 50 tickers. A cold call lists what it couldn't load yet in `pending`; ask again for those. */
export async function loadEvents(tickers: string[]) {
  const out = new Map<string, IssuerFeed>()
  let todo = [...new Set(tickers)]
  for (let i = 0; todo.length && i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000))
    const batches = Array.from({ length: Math.ceil(todo.length / 50) }, (_, j) => todo.slice(j * 50, j * 50 + 50))
    const res = await Promise.all(batches.map((b) => call<{ tickers: Record<string, { events: IssuerEvent[]; window?: string | null }>; pending?: string[] }>(`/events?tickers=${b.map(encodeURIComponent).join(',')}&window=quarter`, { auth: true })))
    const pending = new Set(res.flatMap((r) => r.pending ?? []))
    for (const r of res) for (const [t, v] of Object.entries(r.tickers ?? {})) if (!pending.has(t) || v.events.length) out.set(t, Object.assign(v.events, { window: v.window ?? null }))
    todo = todo.filter((t) => pending.has(t))
  }
  return out
}

export const setAlerts = (alerts: Member['alerts']) => call<{ member: Member }>('/alerts', { body: { alerts }, auth: true }).then((r) => r.member)
/** Download an authenticated CSV route ({api}/stocks/{T}/holders.csv, {api}/follows.csv) as a file. */
export async function downloadFile(path: string, filename: string) {
  const t = getToken()
  if (!t) throw new ApiError(401)
  const res = await fetch(`${api}${path}`, { headers: { Authorization: `Bearer ${t}` } })
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
export function useMemberState() {
  const [member, setMember] = useState<Member | null | undefined>(() => (api && getToken() ? undefined : null))
  useEffect(() => {
    if (!api || !getToken()) return
    fetchMe().then(setMember, () => setMember(null))
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
  /** The latest alerts, newest first (the API's `recent`, or its older `alerts`). */
  alerts: { slug: string; manager: string; quarter?: string | null; form: string; accession: string; accepted_at: string; sent_at: string; gap_seconds: number; channel?: string }[]
}
type RawLatency = Omit<Latency, 'alerts'> & { alerts?: Latency['alerts']; recent?: { form: string; manager: string; slug: string; accession: string; accepted_at: string; delivered_at: string; seconds: number; channel: string }[] }
export const loadLatency = () =>
  fetch(`${api}/latency`)
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
