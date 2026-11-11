import { readFollows } from './followsShape.mjs'
import { useSyncExternalStore } from 'react'
import { ApiError, call, getToken, needsVerify } from './account'

// Follows live in the Copy API (GET/PUT {api}/follows). Following is a Copy feature: 401 and 402
// leave the store empty and the Follow buttons show the upgrade prompt.
export type Follows = {
  investors: string[]
  stocks: string[]
  owned: string[]
  /** Owned names the member added by hand (owned = these plus the linked 13F book's tickers). */
  owned_manual?: string[]
  /** Funds a Pro or Fund member benchmarks against (peer overlap). */
  peers: string[]
  /** A 13F filer's book linked as the owned list; it refreshes when that filer files again. */
  book?: LinkedBook | null
  onboarded: boolean
  include_13g: boolean
  digest: boolean
  /** The weekly "Your names this week" email (paid plans); absent means on. */
  weekly_digest?: boolean
  /** Insider and 13D alerts on owned and watched stocks (all paid plans). */
  insider_buys: boolean
  insider_min_usd: number
  cluster_buys: boolean
  any_13d: boolean
  /** Free accounts only: how many owned names they may keep (5). */
  limit?: number
}
export type LinkedBook = { cik: string; name: string; quarter: string; tickers: string[] }
/** A follow or unfollow in flight, or one the read-back didn't confirm (key "investors:slug" or "stocks:TICKER"). */
/** `note`: the server's reason, shown instead of the generic retry line (the backup's read-only answer). */
export type Pending = Record<string, { want: boolean; state: 'saving' | 'error'; note?: string }>
type State = { status: 'idle' | 'loading' | 'ready' | 'guest'; follows: Follows; pending: Pending }

const EMPTY: Follows = { investors: [], stocks: [], owned: [], peers: [], onboarded: false, include_13g: false, digest: false, insider_buys: true, insider_min_usd: 100000, cluster_buys: true, any_13d: true }
// A free account's limit comes at the top level of GET /follows; readFollows carries it into the follows.
type Res = { follows: Follows; limit?: number }
const shape = (r: Res): Follows => readFollows(r, EMPTY, state?.follows?.limit) as Follows
let state: State = { status: 'idle', follows: EMPTY, pending: {} }
const subs = new Set<() => void>()
// Like /me (lib/account), GET /follows is kept for 60 seconds in this tab, for this session token; every
// confirmed state (a load, or a save's server answer) refreshes it.
const CACHE = 'copybook-follows'
// The last confirmed follows for this session, of any age: a slow or failing API shows them (read-only
// until it answers) rather than an empty book.
const LAST = 'copybook-follows-last'
const set = (s: State, confirmed = true) => {
  state = s
  if (s.status === 'ready' && confirmed)
    try {
      sessionStorage.setItem(CACHE, JSON.stringify({ token: getToken(), at: Date.now(), follows: s.follows }))
      localStorage.setItem(LAST, JSON.stringify({ token: getToken(), follows: s.follows }))
    } catch {
      // Storage blocked: no cache.
    }
  subs.forEach((f) => f())
}
function lastFollows(): Follows | null {
  try {
    const c = JSON.parse(localStorage.getItem(LAST) ?? 'null') as { token: string; follows: Follows } | null
    return c && c.token === getToken() ? c.follows : null
  } catch {
    return null
  }
}
function cached(): Follows | null {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE) ?? 'null') as { token: string; at: number; follows: Follows } | null
    return c && c.token === getToken() && Date.now() - c.at < 60_000 ? c.follows : null
  } catch {
    return null
  }
}

function load() {
  if (state.status !== 'idle') return
  if (!getToken()) return set({ status: 'guest', follows: EMPTY, pending: {} })
  const hit = cached()
  if (hit) return set({ status: 'ready', follows: hit, pending: {} })
  const last = lastFollows()
  if (last) set({ status: 'ready', follows: last, pending: {} }, false)
  else set({ ...state, status: 'loading' })
  call<Res>('/follows', { auth: true, timeout: 20_000 }).then(
    (r) => set({ status: 'ready', follows: shape(r), pending: {} }),
    () => set(last && getToken() ? { status: 'ready', follows: last, pending: {} } : { status: 'guest', follows: EMPTY, pending: {} }, false),
  )
}

/** Re-read GET /follows now (the account page on load): the caches only stand in while it answers or if it fails. */
export function refreshFollows() {
  if (!getToken()) return
  return call<Res>('/follows', { auth: true, timeout: 20_000, cache: 'no-store' }).then(
    (r) => set({ status: 'ready', follows: shape(r), pending: state.pending }),
    () => null,
  )
}

/** Reset after sign-in or sign-out so the next read refetches. */
// The tab cache is keyed by session token, so a new sign-in never reads another session's follows.
export const resetFollows = () => set({ status: 'idle', follows: EMPTY, pending: {} })

export function useFollows() {
  const s = useSyncExternalStore(
    (f) => {
      subs.add(f)
      load()
      return () => subs.delete(f)
    },
    () => state,
  )
  return s
}

// Saves run one at a time and render from the server's answer, so the page never claims a follow
// the server doesn't have.
let queue: Promise<unknown> = Promise.resolve()
const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const run = queue.then(job, job)
  queue = run.catch(() => null)
  return run
}
const readBack = async () => shape(await call<Res>('/follows', { auth: true }))
const withoutKey = (k: string) => Object.fromEntries(Object.entries(state.pending).filter(([x]) => x !== k))

/** Partial update (settings, onboarding), queued behind any follow in flight, then confirmed from the server. */
export function saveFollows(patch: Partial<Follows>) {
  return enqueue(async () => {
    await call('/follows', { method: 'PUT', body: patch, auth: true })
    set({ ...state, status: 'ready', follows: await readBack() })
  })
}

/** Follow or unfollow one investor or stock. Shown as saving until /follows confirms it, else as an error to retry. */
export function setFollow(kind: 'investors' | 'stocks' | 'peers' | 'owned', id: string, want: boolean) {
  const key = `${kind}:${id}`
  set({ ...state, pending: { ...state.pending, [key]: { want, state: 'saving' } } })
  return enqueue(async () => {
    try {
      // One item per request, with the session (/follows/investors/{slug}, /follows/stocks/{TICKER}); the server serializes
      // writes and answers with the full follows, which the button renders from.
      const path = `/follows/${kind}/${encodeURIComponent(id)}`
      const r = await call<Res>(path, { method: want ? 'POST' : 'DELETE', auth: true })
      // follows.limit is the free owned-names limit (5); investor and stock writes answer with the 10-follow cap instead.
      const f = shape(kind === 'owned' ? r : { follows: r.follows })
      const ok = f[kind].includes(id) === want
      set({ status: 'ready', follows: f, pending: ok ? withoutKey(key) : { ...state.pending, [key]: { want, state: 'error' } } })
      if (!ok) throw new Error('not_confirmed')
    } catch (e) {
      const note = isReadOnly(e) ? 'Follows can’t be changed while we’re on the backup. Try again in a few minutes.' : undefined
      // A follow that waits for the emailed link (403 verify_email) isn't a failed save: its button says why.
      set({ ...state, pending: isPaywall(e) || isCap(e) || needsVerify(e) ? withoutKey(key) : { ...state.pending, [key]: { want, state: 'error', note } } })
      throw e
    }
  })
}

export const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

/** The free follow cap (402 with code cap_reached): not a paywall, the member can remove one. */
export const isCap = (e: unknown) => e instanceof ApiError && e.code === 'cap_reached'
/** Running on the backup, where follows are read-only (503 read_only, Retry-After 300): not the cap, not a paywall. */
export const isReadOnly = (e: unknown) => e instanceof ApiError && e.code === 'read_only'
/** Copy required (401, or a 402 that isn't the free cap). */
export const isPaywall = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 402) && !isCap(e)

/** Add many tickers as owned or watched (My book import), one request each, queued behind other follow changes. */
export function addStocks(tickers: string[], owned: boolean) {
  return enqueue(async () => {
    const failed: string[] = []
    for (const t of tickers) {
      try {
        const r = await call<Res>(`/follows/${owned ? 'owned' : 'stocks'}/${encodeURIComponent(t)}`, { method: 'POST', auth: true })
        set({ ...state, status: 'ready', follows: shape(r) })
      } catch (e) {
        if (isPaywall(e)) throw e
        failed.push(t)
      }
    }
    return failed
  })
}

/** Import owned names ({api}/book/import): pasted text, a broker CSV, or a 13F filer's book by CIK. */
export function importBook(body: { text?: string; csv?: string; cik?: string; mode?: 'replace' | 'merge' }) {
  return enqueue(async () => {
    const r = await call<{ follows: Follows; imported: number | string[]; skipped?: string[]; source?: { cik: string; name: string; quarter: string } | null }>('/book/import', { method: 'POST', body, auth: true })
    set({ ...state, status: 'ready', follows: shape(r) })
    return { ...r, imported: typeof r.imported === 'number' ? r.imported : r.imported.length }
  })
}
