import { useEffect, useState } from 'react'
import { api } from '../config'

export type Member = {
  email: string
  status: string
  active: boolean
  plan: string
  period_end?: number | string | null
  alerts: 'all' | 'off' | string[]
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
  constructor(status: number) {
    super(`api ${status}`)
    this.status = status
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
  if (!res.ok) throw new ApiError(res.status)
  return res.json() as Promise<T>
}

export async function startSession(body: { checkout_session: string } | { login: string }) {
  const r = await call<{ token: string; member: Member }>('/session', { body })
  setToken(r.token)
  return r.member
}

export const fetchMe = () => call<{ member: Member }>('/me', { auth: true }).then((r) => r.member)
export const requestLogin = (email: string) => call<{ ok: boolean }>('/login', { body: { email } })
export const openPortal = () => call<{ url: string }>('/portal', { method: 'POST', auth: true }).then((r) => (window.location.href = r.url))
export const setAlerts = (alerts: Member['alerts']) => call<{ member: Member }>('/alerts', { body: { alerts }, auth: true }).then((r) => r.member)
export const csvUrl = (slug: string) => `${api}/csv/${slug}.csv?token=${encodeURIComponent(getToken() ?? '')}`

/** Signed-in member, or null. Only calls the API when it is configured and a token exists. */
export function useMember() {
  const [member, setMember] = useState<Member | null>(null)
  useEffect(() => {
    if (!api || !getToken()) return
    fetchMe().then(setMember, () => setMember(null))
  }, [])
  return member
}
