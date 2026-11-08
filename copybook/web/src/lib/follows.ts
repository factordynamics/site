import { useSyncExternalStore } from 'react'
import { ApiError, call, getToken } from './account'

// Follows live in the Copy API (GET/PUT {api}/follows). Following is a Copy feature: 401 and 402
// leave the store empty and the Follow buttons show the upgrade prompt.
export type Follows = { investors: string[]; stocks: string[]; owned: string[]; onboarded: boolean }
type State = { status: 'idle' | 'loading' | 'ready' | 'guest'; follows: Follows }

const EMPTY: Follows = { investors: [], stocks: [], owned: [], onboarded: false }
let state: State = { status: 'idle', follows: EMPTY }
const subs = new Set<() => void>()
const set = (s: State) => {
  state = s
  subs.forEach((f) => f())
}

function load() {
  if (state.status !== 'idle') return
  if (!getToken()) return set({ status: 'guest', follows: EMPTY })
  set({ ...state, status: 'loading' })
  call<{ follows: Follows }>('/follows', { auth: true }).then(
    (r) => set({ status: 'ready', follows: { ...EMPTY, ...r.follows } }),
    () => set({ status: 'guest', follows: EMPTY }),
  )
}

/** Reset after sign-in or sign-out so the next read refetches. */
export const resetFollows = () => set({ status: 'idle', follows: EMPTY })

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

/** Partial update; applies optimistically and rolls back on failure. */
export async function saveFollows(patch: Partial<Follows>) {
  const before = state
  const next = { ...state.follows, ...patch }
  if (patch.owned) next.stocks = [...new Set([...next.stocks, ...patch.owned])]
  set({ status: 'ready', follows: next })
  try {
    const r = await call<{ follows: Follows }>('/follows', { method: 'PUT', body: patch, auth: true })
    set({ status: 'ready', follows: { ...EMPTY, ...r.follows } })
  } catch (e) {
    set(before)
    throw e
  }
}

export const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

export const isPaywall = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 402)
