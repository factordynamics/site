// Same-origin, edge-cached copies of the public SEC EDGAR data Holdterm reads (Copybook's public data
// and its derived stock files). Only Holdterm's roster is served: other filers' files 404, and manager
// lists drop Copybook's person names and "featured" flags, so the Holdterm domain carries nothing but
// the rule-based roster.
import ROSTER from '../src/roster.json'

type R = { funds: { cik: string; slug: string; filer_slug: string }[]; pending: { cik: string; slug: string | null; filer_slug: string | null }[] }
const roster = ROSTER as unknown as R
const SLUGS = new Set([...roster.funds, ...roster.pending].flatMap((f) => [f.slug, f.filer_slug]).filter(Boolean) as string[])
const CIKS = new Set([...roster.funds, ...roster.pending].map((f) => f.cik.replace(/^0+/, '')))
const allowed = (slug: string) => SLUGS.has(slug)

type Obj = Record<string, unknown>
const person = (o: Obj) => {
  delete o.featured
  if ('manager' in o) o.manager = (o.firm as string) || (o.name as string) || ''
  return o
}
/** Returns the JSON to serve for a data path, or null for 404. */
function shape(kind: 'data' | 'd', path: string, j: Obj): Obj | null {
  if (kind === 'd') {
    if (path === 'stocks.json') return j
    const m = path.match(/^stocks\/[^/]+\.json$/)
    if (!m) return null
    for (const k of ['holders', 'exited', 'options']) if (Array.isArray(j[k])) j[k] = (j[k] as Obj[]).filter((h) => allowed(h.slug as string)).map(person)
    delete j.counts
    return j
  }
  if (path === 'index.json') {
    j.managers = (j.managers as Obj[]).filter((m) => allowed(m.slug as string) || CIKS.has(String(m.cik).replace(/^0+/, ''))).map(person)
    for (const k of Object.keys(j)) if (k.startsWith('copycat')) delete j[k]
    const ms = j.managers as Obj[]
    j.manager_count = ms.length
    j.filed_count = ms.filter((m) => m.ok).length
    return j
  }
  if (path === 'events.json') {
    j.events = (j.events as Obj[]).filter((e) => allowed(e.slug as string)).map((e) => ((e.manager = ''), e))
    return j
  }
  if (path === 'insiders.json') return j
  const m = path.match(/^(?:events\/)?([a-z0-9-]+?)(?:-history)?\.json$/)
  if (!m || !allowed(m[1])) return null
  if (Array.isArray(j.events)) j.events = (j.events as Obj[]).map((e) => ((e.manager = ''), e))
  return person(j)
}

export async function proxy(origin: string, path: string, request: Request, kind: 'data' | 'd' = 'data'): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 })
  const notFound = () => new Response(JSON.stringify({ error: 404 }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } })
  if (!/^[A-Za-z0-9._/-]+\.json$/.test(path) || path.includes('..')) return notFound()
  // Cache the shaped response per colo, so JSON is reshaped at most once per 2 minutes per file.
  const cache = (caches as unknown as { default: Cache }).default
  const key = new Request(new URL(request.url).origin + `/__shaped/v2/${kind}/${path}`)
  const hit = await cache.match(key)
  if (hit) return hit
  const r = await fetch(origin + path, { cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit)
  if (!r.ok) return r.status === 404 ? notFound() : new Response(JSON.stringify({ error: r.status }), { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8' } })
  const out = shape(kind, path, (await r.json()) as Obj)
  if (!out) return notFound()
  const res = new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=120, stale-while-revalidate=600' } })
  await cache.put(key, res.clone())
  return res
}
