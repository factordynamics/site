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
export const isPro = (m?: Member | null) => Boolean(m?.active && (m.plan === 'pro' || m.plan === 'fund'))

export const fetchMe = () => call<{ member: Member }>('/me', { auth: true }).then((r) => r.member)
export const requestLogin = (email: string) => call<{ ok: boolean }>('/login', { body: { email } })
export const openPortal = () => call<{ url: string }>('/portal', { method: 'POST', auth: true }).then((r) => (window.location.href = r.url))
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
export type Latency = {
  season: string
  median_seconds: number | null
  p95_seconds: number | null
  count: number
  alerts: { slug: string; manager: string; quarter: string | null; form: string; accession: string; accepted_at: string; sent_at: string; gap_seconds: number }[]
}
export const loadLatency = () => fetch(`${api}/latency`).then((r) => (r.ok ? (r.json() as Promise<Latency>) : null)).catch(() => null)
/** 100 -> "1m40s", 42 -> "42s". */
export const gapLabel = (s: number) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`)
