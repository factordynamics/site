import { useEffect, useState } from 'react'
import { api } from './config'
import { A } from './lib'

// Paid alerts account, against the alerts API (POST /session, /login, /portal; GET /me; GET/PUT /follows).
export type Member = { email: string; status: string; active: boolean; plan: string; interval?: 'monthly' | 'yearly' | null; period_end?: number | string | null; cancel_at_period_end?: boolean; /** False when no card is on file (a trial then ends instead of renewing). */ has_payment_method?: boolean | null }
export type Follows = { investors: string[]; stocks: string[] }

const KEY = 'holdterm-session'
export function getToken(): string | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const { token, exp } = JSON.parse(raw) as { token: string; exp: number }
    if (Date.now() > exp) return (localStorage.removeItem(KEY), null)
    return token
  } catch {
    return null
  }
}
export const signOut = () => localStorage.removeItem(KEY)

async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  if (init.auth) {
    const t = getToken()
    if (!t) throw new Error('sign in again')
    headers.Authorization = `Bearer ${t}`
  }
  const r = await fetch(api + path, { method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined }).catch(() => null)
  // Over quota (429), down (5xx) or unreachable: the rest of the site still works; say so in plain words.
  if (!r || r.status === 429 || r.status >= 500) throw new Error(UNAVAILABLE)
  if (r.status === 401 && init.auth) signOut()
  if (!r.ok) throw new Error(r.status === 402 ? 'Your plan is not active.' : `Something went wrong (error ${r.status}).`)
  return r.json() as Promise<T>
}
export const UNAVAILABLE = 'Accounts are briefly unavailable. Your plan and alert settings are safe; please try again in a few hours. Everything else on Holdterm works as usual.'

/** Signs in from a Stripe checkout return (?session_id=cs_...) or an emailed link (?login=...). While the
 * service is unavailable the link stays in the address bar, so reloading later finishes the sign-in. */
export async function startFromUrl(): Promise<Member | null> {
  const p = new URLSearchParams(location.search)
  const sid = p.get('session_id')
  const login = p.get('login')
  const body = sid?.startsWith('cs_') ? { checkout_session: sid } : login ? { login } : null
  if (!body || !api) return null
  const r = await call<{ token: string; member: Member }>('/session', { body }).catch((e: Error) => {
    if (e.message === UNAVAILABLE) throw new Error(sid ? `Your checkout went through, but we couldn’t sign you in just now. Keep this page and reload it in a few hours, or use the sign-in link we email you.` : UNAVAILABLE)
    return null
  })
  history.replaceState(null, '', '/account')
  if (!r) return null
  localStorage.setItem(KEY, JSON.stringify({ token: r.token, exp: Date.now() + 30 * 86_400_000 }))
  return r.member
}
export const requestLogin = (email: string) => call('/login', { body: { email, brand: 'holdterm' } })
export const openPortal = () => call<{ url: string }>('/portal', { method: 'POST', auth: true }).then((r) => (location.href = r.url))
export const follows = () => call<{ follows: Follows }>('/follows', { auth: true }).then((r) => r.follows)
/** One follow per click (POST adds, DELETE removes), so concurrent changes are never lost. */
export const setFollow = (kind: keyof Follows, id: string, on: boolean) =>
  call<{ follows: Follows }>(`/follows/${kind}/${encodeURIComponent(id)}`, { method: on ? 'POST' : 'DELETE', auth: true }).then((r) => r.follows)

export function useMember(): [Member | null, (m: Member | null) => void, string | null] {
  const [m, set] = useState<Member | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!api || !getToken()) return
    call<{ member: Member }>('/me', { auth: true }).then(
      (r) => set(r.member),
      (e) => setErr(String(e.message)),
    )
  }, [])
  return [m, set, err]
}

/** Follow toggle for an investor or stock. Signed-out visitors go to the alerts page. */
export function Follow({ kind, id }: { kind: keyof Follows; id: string }) {
  const [f, setF] = useState<Follows | null>(null)
  const [down, setDown] = useState(false)
  const signedIn = Boolean(api && getToken())
  useEffect(() => {
    if (signedIn) follows().then(setF, () => setDown(true))
  }, [signedIn])
  if (!signedIn)
    return (
      <A to="/alerts" className="btn ghost" title="Get an email when this changes">
        + Alert me
      </A>
    )
  const on = f?.[kind].includes(id) ?? false
  return (
    <button
      className={`btn ${on ? '' : 'ghost'}`}
      disabled={!f}
      title={down ? 'Following is briefly unavailable; try again in a few hours' : undefined}
      onClick={() => f && setFollow(kind, id, !on).then(setF, () => setDown(true))}
    >
      {down ? 'Follow unavailable' : on ? '✓ Following' : '+ Follow'}
    </button>
  )
}
