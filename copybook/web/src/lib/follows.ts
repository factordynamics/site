import { useSyncExternalStore } from 'react'
import { ApiError, call, getToken } from './account'

// Follows live in the Copy API (GET/PUT {api}/follows). Following is a Copy feature: 401 and 402
// leave the store empty and the Follow buttons show the upgrade prompt.
export type Follows = {
  investors: string[]
  stocks: string[]
  owned: string[]
  onboarded: boolean
  include_13g: boolean
  digest: boolean
  /** Insider and 13D alerts on owned and watched stocks (all paid plans). */
  insider_buys: boolean
  insider_min_usd: number
  cluster_buys: boolean
  any_13d: boolean
}
/** A follow or unfollow in flight, or one the read-back didn't confirm (key "investors:slug" or "stocks:TICKER"). */
export type Pending = Record<string, { want: boolean; state: 'saving' | 'error' }>
type State = { status: 'idle' | 'loading' | 'ready' | 'guest'; follows: Follows; pending: Pending }

const EMPTY: Follows = { investors: [], stocks: [], owned: [], onboarded: false, include_13g: false, digest: false, insider_buys: true, insider_min_usd: 100000, cluster_buys: true, any_13d: true }
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

// Saves run one at a time and each one reads /follows back, so a quick second click can't
// overwrite the first and the page never claims a follow the server doesn't have.
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
export function setFollow(kind: 'investors' | 'stocks', id: string, want: boolean) {
  const key = `${kind}:${id}`
  set({ ...state, pending: { ...state.pending, [key]: { want, state: 'saving' } } })
  return enqueue(async () => {
    try {
      const cur = state.follows
      const list = want ? [...new Set([...cur[kind], id])] : cur[kind].filter((x) => x !== id)
      // Unwatching a stock also drops it from owned.
      const patch: Partial<Follows> = kind === 'stocks' && !want ? { stocks: list, owned: cur.owned.filter((x) => x !== id) } : { [kind]: list }
      await call('/follows', { method: 'PUT', body: patch, auth: true })
      const f = await readBack()
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
