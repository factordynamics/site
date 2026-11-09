// fetch + JSON with retries: 429 and 5xx back off (honouring retry-after), and a request that hangs for
// 30 s or fails on the network is retried too, so one slow file can't stall a build.
export async function getJson(url) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch((e) => {
      if (i >= 4) throw e
      return null
    })
    if (r?.ok) return r.json()
    if (r && (i >= 6 || !(r.status === 429 || r.status >= 500))) throw new Error(`${r.status} ${url}`)
    const wait = Number(r?.headers.get('retry-after')) || 2 ** i
    await new Promise((res) => setTimeout(res, Math.min(wait, 60) * 1000))
  }
}

/** Results of fn over list, as each settles, with at most n in flight (a slow item holds one slot, not a batch). */
export async function* pooled(list, n, fn) {
  const running = new Map()
  let next = 0
  const start = () => {
    const k = next++
    running.set(k, Promise.resolve(fn(list[k])).then((v) => [k, v]))
  }
  while (next < list.length && running.size < n) start()
  while (running.size) {
    const [k, v] = await Promise.race(running.values())
    running.delete(k)
    if (next < list.length) start()
    yield v
  }
}
