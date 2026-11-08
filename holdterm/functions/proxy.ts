// Same-origin, edge-cached copies of the public SEC EDGAR data Holdterm reads, so pages don't depend
// on a third-party host per request. Origins: Copybook's public data and its derived stock files.
export async function proxy(origin: string, path: string, request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 })
  if (!/^[A-Za-z0-9._/-]+\.json$/.test(path) || path.includes('..')) return new Response('not found', { status: 404 })
  const r = await fetch(origin + path, { cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit)
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=120, stale-while-revalidate=600' })
  return new Response(r.ok ? r.body : JSON.stringify({ error: r.status }), { status: r.status, headers: h })
}
