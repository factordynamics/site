// 1. holdterm.pages.dev (the production alias only, not preview deploys) redirects to the custom domain.
// 2. Page requests get per-route <title>, description, canonical and og tags in the HTML itself, so link
//    previews and crawlers that don't run JS see the right page; unknown paths get a real 404 status.
import ROSTER from '../src/roster.json'
import { FUNDS, dataSlug, firmName, fundPath } from '../src/names'
import TICKERS from '../src/tickers.json'

const SITE = 'https://holdterm.factordynamics.com'
const SECTIONS: Record<string, [string, string]> = {
  '/': ['What long-term investors buy and sell', 'Every 13F filing, trade, 13D/G and Form 4 from a rule-based roster of concentrated, long-term funds. SEC EDGAR data, no ads.'],
  '/funds': ['Investors', 'The roster: concentrated, long-term 13F filers chosen by a published rule, with each one’s latest 13F.'],
  '/flows': ['Buys and sells', 'What the roster bought and sold, stock by stock, from each fund’s latest 13F.'],
  '/consensus': ['Most owned stocks', 'The stocks the roster owns in common, by number of funds, dollars held and conviction.'],
  '/filings': ['13D, 13G and Form 4 filings', 'Schedule 13D and 13G stakes and Form 4 trades filed by roster funds between 13Fs.'],
  '/alerts': ['Email alerts', 'Email alerts when the funds you follow file a 13F, 13D, 13G or Form 4. $3 a month.'],
  '/account': ['Account', 'Manage Holdterm email alerts.'],
  '/about': ['About', 'How Holdterm chooses its roster and reads SEC filings.'],
  '/terms': ['Terms', 'Holdterm terms of service.'],
  '/privacy': ['Privacy', 'Holdterm privacy policy.'],
}
const MOVED = new Set(['/m', '/activity', '/grand', '/insiders'])
const roster = ROSTER as unknown as { funds: { slug: string; filer_slug: string; firm: string }[] }

/** True when Copybook's derived data has a stock file for the ticker, or the ticker is another class's alias. */
// Tickers Holdterm resolves from a roster fund's CUSIP (src/tickers.json); their pages are built from the books.
const LOCAL = new Set(Object.values(TICKERS as unknown as Record<string, { ticker?: string; listed?: boolean }>).flatMap((o) => (o.listed && o.ticker ? [o.ticker] : [])))
async function stockExists(t: string, origin: string) {
  if (LOCAL.has(t)) return true
  const up = 'https://copybook.factordynamics.com/d/'
  const r = await fetch(`${up}stocks/${encodeURIComponent(t)}.json`, { method: 'HEAD', cf: { cacheTtl: 600, cacheEverything: true } } as RequestInit)
  if (r.ok) return true
  const ix = await fetch(`${up}stocks.json`, { cf: { cacheTtl: 600, cacheEverything: true } } as RequestInit)
  if (!ix.ok) return true // can't tell: let the page decide
  const { stocks } = (await ix.json()) as { stocks: { t: string; a: string[] }[] }
  return stocks.some((x) => x.a.includes(t))
}
async function meta(path: string, origin: string): Promise<[string, string] | null> {
  if (SECTIONS[path]) return SECTIONS[path]
  let m = path.match(/^\/m\/([a-z0-9-]+)$/)
  if (m) {
    const slug = dataSlug(m[1])
    const f = roster.funds.find((x) => x.slug === slug || x.filer_slug === slug)
    // Only roster funds have pages.
    if (!f) return null
    const firm = FUNDS[slug]?.firm ?? firmName(f.slug, f.firm)
    return [`${firm} 13F portfolio`, `${firm}: latest 13F holdings, quarterly buys and sells, and 13D/G and Form 4 filings, from SEC EDGAR.`]
  }
  m = path.match(/^\/s\/([A-Za-z0-9.%-]{1,12})$/)
  if (m) {
    const t = decodeURIComponent(m[1]).toUpperCase()
    if (!(await stockExists(t, origin))) return null
    return [`${t}: which funds own it`, `Which concentrated long-term funds own ${t}, what they bought and sold, and 13D/G and Form 4 filings.`]
  }
  return null
}

export const onRequest = async ({ request, next }: { request: Request; next: () => Promise<Response> }) => {
  const url = new URL(request.url)
  if (url.hostname === 'holdterm.pages.dev') return Response.redirect(`${SITE}${url.pathname}${url.search}`, 301)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (request.method !== 'GET' || /\.[a-z0-9]+$/i.test(path) || path.startsWith('/data/') || path.startsWith('/d/') || path.startsWith('/assets/') || MOVED.has(path)) return next()
  const res = await next()
  if (!(res.headers.get('content-type') ?? '').includes('text/html')) return res
  const m = await meta(path, url.origin)
  const [t, d] = m ?? ['Not found', 'No such page.']
  const title = `${t} · Holdterm`
  const fm = path.match(/^\/m\/([a-z0-9-]+)$/)
  const sm = path.match(/^\/s\/(.+)$/)
  const canonical = SITE + (fm ? fundPath(dataSlug(fm[1])) : sm ? `/s/${encodeURIComponent(decodeURIComponent(sm[1]).toUpperCase())}` : path)
  let rw = new HTMLRewriter()
    .on('title', { element: (e) => void e.setInnerContent(title) })
    .on('meta[name="description"]', { element: (e) => void e.setAttribute('content', d) })
    .on('meta[property="og:title"]', { element: (e) => void e.setAttribute('content', title) })
    .on('meta[property="og:description"]', { element: (e) => void e.setAttribute('content', d) })
    .on('meta[property="og:url"]', { element: (e) => void e.setAttribute('content', canonical) })
  if (m) return rw.on('link[rel="canonical"]', { element: (e) => void e.setAttribute('href', canonical) }).transform(res)
  // A 404 points nowhere and asks not to be indexed.
  rw = rw.on('link[rel="canonical"]', { element: (e) => void e.remove() }).on('meta[property="og:url"]', { element: (e) => void e.remove() }).on('head', { element: (e) => void e.append('<meta name="robots" content="noindex" />', { html: true }) })
  const out = rw.transform(res)
  return new Response(out.body, { status: 404, headers: out.headers })
}
