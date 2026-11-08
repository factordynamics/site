// Fetch JSON from the data host. GitHub Pages answers 429 under bursts (every build reads
// thousands of files), so retry 429 and 5xx with backoff, honouring Retry-After.
export async function getJson(url) {
  for (let i = 0; ; i++) {
    const r = await fetch(url)
    if (r.ok) return r.json()
    if (i >= 6 || !(r.status === 429 || r.status >= 500)) throw new Error(`${r.status} ${url}`)
    const wait = Number(r.headers.get('retry-after')) || 2 ** i
    await new Promise((res) => setTimeout(res, Math.min(wait, 60) * 1000))
  }
}
