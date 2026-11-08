import { useSyncExternalStore } from 'react'
import { ApiError, call, getToken } from './account'

// Follows live in the Copy API (GET/PUT {api}/follows). Following is a Copy feature: 401 and 402
// leave the store empty and the Follow buttons show the upgrade prompt.
export type Follows = {
  investors: string[]
  stocks: string[]
  owned: string[]
  /** Funds a Pro or Fund member benchmarks against (peer overlap). */
  peers: string[]
  /** A 13F filer's book linked as the owned list; it refreshes when that filer files again. */
  book?: LinkedBook | null
  onboarded: boolean
  include_13g: boolean
  digest: boolean
  /** Insider and 13D alerts on owned and watched stocks (all paid plans). */
  insider_buys: boolean
  insider_min_usd: number
  cluster_buys: boolean
  any_13d: boolean
}
export type LinkedBook = { cik: string; name: string; quarter: string; tickers: string[] }
/** A follow or unfollow in flight, or one the read-back didn't confirm (key "investors:slug" or "stocks:TICKER"). */
export type Pending = Record<string, { want: boolean; state: 'saving' | 'error' }>
type State = { status: 'idle' | 'loading' | 'ready' | 'guest'; follows: Follows; pending: Pending }

const EMPTY: Follows = { investors: [], stocks: [], owned: [], peers: [], onboarded: false, include_13g: false, digest: false, insider_buys: true, insider_min_usd: 100000, cluster_buys: true, any_13d: true }
let state: State = { status: 'idle', follows: EMPTY, pending: {} }
const subs = new Set<() => void>()
const set = (s: State) => {
  state = s
  subs.forEach((f) => f())
}

function load() {
  if (state.status !== 'idle') return
  if (!getToken()) return set({ status: 'guest', follows: EMPTY, pending: {} })
  set({ ...state, status: 'loading' })
  call<{ follows: Follows }>('/follows', { auth: true }).then(
    (r) => set({ status: 'ready', follows: { ...EMPTY, ...r.follows }, pending: {} }),
    () => set({ status: 'guest', follows: EMPTY, pending: {} }),
  )
}

/** Reset after sign-in or sign-out so the next read refetches. */
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
const readBack = async () => ({ ...EMPTY, ...(await call<{ follows: Follows }>('/follows', { auth: true })).follows })
const withoutKey = (k: string) => Object.fromEntries(Object.entries(state.pending).filter(([x]) => x !== k))

/** Partial update (settings, onboarding), queued behind any follow in flight, then confirmed from the server. */
export function saveFollows(patch: Partial<Follows>) {
  return enqueue(async () => {
    await call('/follows', { method: 'PUT', body: patch, auth: true })
    set({ ...state, status: 'ready', follows: await readBack() })
  })
}

/** Follow or unfollow one investor or stock. Shown as saving until /follows confirms it, else as an error to retry. */
export function setFollow(kind: 'investors' | 'stocks' | 'peers', id: string, want: boolean) {
  const key = `${kind}:${id}`
  set({ ...state, pending: { ...state.pending, [key]: { want, state: 'saving' } } })
  return enqueue(async () => {
    try {
      // One item per request ({api}/follows/{slug}, /follows/stocks/{TICKER}); the server serializes
      // writes and answers with the full follows, which the button renders from.
      const path = kind === 'investors' ? `/follows/${encodeURIComponent(id)}` : `/follows/${kind}/${encodeURIComponent(id)}`
      const r = await call<{ follows: Follows }>(path, { method: want ? 'POST' : 'DELETE', auth: true })
      const f = { ...EMPTY, ...r.follows }
      const ok = f[kind].includes(id) === want
      set({ status: 'ready', follows: f, pending: ok ? withoutKey(key) : { ...state.pending, [key]: { want, state: 'error' } } })
      if (!ok) throw new Error('not_confirmed')
    } catch (e) {
      set({ ...state, pending: isPaywall(e) ? withoutKey(key) : { ...state.pending, [key]: { want, state: 'error' } } })
      throw e
    }
  })
}

export const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

export const isPaywall = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 402)

/** Add many tickers as owned or watched (My book import), one request each, queued behind other follow changes. */
export function addStocks(tickers: string[], owned: boolean) {
  return enqueue(async () => {
    const failed: string[] = []
    for (const t of tickers) {
      try {
        const r = await call<{ follows: Follows }>(`/follows/${owned ? 'owned' : 'stocks'}/${encodeURIComponent(t)}`, { method: 'POST', auth: true })
        set({ ...state, status: 'ready', follows: { ...EMPTY, ...r.follows } })
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
    set({ ...state, status: 'ready', follows: { ...EMPTY, ...r.follows } })
    return { ...r, imported: typeof r.imported === 'number' ? r.imported : r.imported.length }
  })
}
