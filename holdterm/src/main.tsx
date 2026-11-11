import '@fontsource-variable/inter/index.css'
import './styles.css'
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { aggregate, freshness, funds, loadBooks, loadIndex, loadStockIndex, quarterLabel, roster, searchNames, type Agg, type Manager, type StockIndexRow } from './data'
import { A, navigate, usd, usePath } from './lib'
import { dataSlug, firmName, fundPath, issuerName, publicSlug } from './names'
import { price as PRICE } from './config'
import { About, Account, Alerts, CONTACT, Consensus, Filings, Flows, Fund, Funds, Guide, Home, NotFound, reportError, Privacy, Stock, Terms } from './pages'
/** The short commit this build comes from (vite.config.ts), shown in preview builds' footers. */
declare const __COMMIT__: string

// [path, label, g-key]; alerts is the header's button, not a nav tab.
const NAV: [string, string, string][] = [
  ['/', 'Overview', 'h'],
  ['/funds', 'Investors', 'm'],
  ['/flows', 'Buys & sells', 'f'],
  ['/consensus', 'Most owned', 'c'],
  ['/filings', 'Stakes', 'd'],
  ['/alerts', 'Alerts', 'e'],
]
const TABS = NAV.filter((n) => n[0] !== '/alerts')
// Phone tab bar: the same sections with an icon and a one-word label each.
const BAR: Record<string, [string, string]> = {
  '/': ['Overview', 'M3.5 10.5 10 4l6.5 6.5M5.5 9v7h3.5v-4.5h2V16h3.5V9'],
  '/funds': ['Investors', 'M7 9.2a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4Zm-4.5 7c0-2.6 2-4.4 4.5-4.4s4.5 1.8 4.5 4.4M13.5 9a2.3 2.3 0 1 0 0-4.6M14.5 11.9c1.8.3 3 1.8 3 4.3'],
  '/flows': ['Buys & sells', 'M4 7h11l-3-3M16 13H5l3 3'],
  '/consensus': ['Most owned', 'M3.5 16.5h13M5.5 16.5V10M10 16.5V5M14.5 16.5v-8'],
  '/filings': ['Stakes', 'M6 3h6l3.5 3.5V17H6V3Zm6 0v3.5h3.5M8.5 10h4.5M8.5 13h4.5'],
}

// Light by default; the choice is kept. index.html applies it before the first paint.
const THEME_KEY = 'holdterm-theme'
function useTheme(): [string, () => void] {
  const [t, set] = useState(() => document.documentElement.dataset.theme || 'light')
  const toggle = () => {
    const next = t === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', next === 'dark' ? '#151b23' : '#ffffff')
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {}
    set(next)
  }
  return [t, toggle]
}
// Old paths keep working.
const MOVED: Record<string, string> = { '/m': '/funds', '/activity': '/flows', '/grand': '/consensus', '/insiders': '/filings' }

function route(path: string) {
  const p = path.replace(/\/+$/, '') || '/'
  let m: RegExpMatchArray | null
  if (MOVED[p]) {
    history.replaceState(null, '', MOVED[p])
    return route(MOVED[p])
  }
  if (p === '/') return <Home />
  if (p === '/funds') return <Funds />
  if ((m = p.match(/^\/m\/([a-z0-9-]+)$/))) {
    const slug = dataSlug(m[1])
    if (publicSlug(slug) !== m[1]) history.replaceState(null, '', fundPath(slug))
    return <Fund slug={slug} />
  }
  if ((m = p.match(/^\/s\/([^/]+)$/))) {
    const t = decodeURIComponent(m[1]).toUpperCase()
    if (`/s/${encodeURIComponent(t)}` !== p) history.replaceState(null, '', `/s/${encodeURIComponent(t)}`)
    return <Stock ticker={t} />
  }
  if (p === '/consensus') return <Consensus />
  if (p === '/flows') return <Flows />
  if (p === '/filings') return <Filings />
  if (p === '/alerts') return <Alerts />
  if (p === '/account') return <Account />
  if (p === '/about') return <About />
  if (p === '/guide') return <Guide />
  if (p === '/terms') return <Terms />
  if (p === '/privacy') return <Privacy />
  return <NotFound />
}

/** Wordmark: a ranked-weights glyph (a 13F book, largest position first) and the name. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden className="mark">
      <rect width="20" height="20" rx="5" fill="var(--brand)" />
      <rect x="4" y="4.5" width="12" height="2.2" rx="1.1" fill="#14161a" />
      <rect x="4" y="8.9" width="8.5" height="2.2" rx="1.1" fill="#14161a" />
      <rect x="4" y="13.3" width="5" height="2.2" rx="1.1" fill="#14161a" />
    </svg>
  )
}

function Glass() {
  return (
    <svg className="glass" viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

type Hit = { kind: 'stock' | 'investor'; label: string; sub: string; badge: string; to: string; score: number }

const initials = (firm: string) =>
  firm
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(and|of|the|llc|inc|lp|co)$/i.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
const owners = (n: number | undefined) => (n === undefined ? 'Stock' : n ? `Held by ${n} ${n === 1 ? 'investor' : 'investors'} we follow` : 'Not held by the investors we follow')
const investorHit = (m: Manager, score = 0): Hit => ({
  kind: 'investor',
  label: m.firm,
  badge: initials(m.firm),
  sub: [m.pm && `Managed by ${m.pm}`, `${usd(m.total_value)} in ${m.position_count} stocks`].filter(Boolean).join(' · '),
  to: fundPath(m.slug),
  score,
})

/** Names people search by that aren't in the company's SEC name. */
const ALIAS: Record<string, string> = { google: 'GOOGL', facebook: 'META', tsmc: 'TSM', amex: 'AXP' }
/** Letters and digits only, so "coca cola" finds Coca-Cola and "jp morgan" finds JPMorgan Chase. */
const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
const pctWord = (x: number) => `${Math.round(x * 100)}%`
/** A well-known 13F filer Holdterm doesn't follow, with what the screen found (scripts/not-followed.py). */
type NotFollowed = { c: string; s: string | null; n: string; p?: string; f?: string[]; h?: string[]; last?: string; v?: number; k?: number; t10?: number; t1?: number; etf?: number; to?: number; kind?: string; x?: string }
type NotFollowedFile = { period: string; filers: NotFollowed[] }
// The kind of filer a name says it is (screen.py's type test), as a noun.
const KIND: [RegExp, string][] = [
  [/bank|banco|bancorp|trust co|national association/, 'a bank'],
  [/securities|capital markets/, 'a broker'],
  [/insurance|assurance|life/, 'an insurer'],
  [/pension|retirement|teachers/, 'a pension'],
  [/university|regents|college|endowment/, 'an endowment'],
  [/foundation/, 'a foundation'],
  [/sovereign|investment board/, 'a state investment fund'],
  [/wealth/, 'a wealth manager'],
  [/family office/, 'a family office'],
]
/** Why a fund isn't followed, in the published rule's own terms and the numbers the screen found (at most two reasons). */
function whyNot(c: NotFollowed, period: string) {
  const r = roster.rule
  if (c.h) return c.h.join(', and ')
  if (c.last) return `its latest 13F is for ${quarterLabel(c.last)}, and the rule last screened ${quarterLabel(period)} filings`
  const why: Record<string, string | undefined> = {
    size: c.v != null ? `its US stocks were worth ${usd(c.v)} in its ${quarterLabel(period)} 13F, and the rule asks for at least ${usd(r.min_value, 0)}` : undefined,
    positions: c.k != null ? `it held ${c.k.toLocaleString('en-US')} stocks, and the rule asks for ${r.min_positions} to ${r.max_positions}` : undefined,
    top10: c.t10 != null ? `its ten largest holdings are ${pctWord(c.t10)} of its portfolio, and the rule asks for at least ${pctWord(r.min_top10)}` : undefined,
    top1: c.t1 != null ? `its largest position is ${pctWord(c.t1)} of its portfolio, and the rule allows up to ${pctWord(r.max_top1)}` : undefined,
    etf: c.etf != null ? `${pctWord(c.etf)} of its portfolio is in ETFs and index funds, and the rule allows up to ${pctWord(r.max_etf)}` : undefined,
    turnover: c.to != null ? `it traded ${pctWord(c.to)} of its portfolio last quarter, and the rule allows up to ${pctWord(r.max_turnover)}` : undefined,
    type: c.x ? `the rule leaves it out as a ${c.x}` : c.kind ? `it’s ${KIND.find(([re]) => re.test(c.kind!))?.[1] ?? 'a kind of filer'}, which the rule leaves out` : undefined,
    // Only on its own: a late filing can land outside the data the screen reads, so other reasons are surer.
    history: (c.f ?? []).length === 1 ? `the screen found no 13F from it for the quarter before or two years earlier, and the rule asks for at least ${r.min_years} years of filings` : undefined,
  }
  return (c.f ?? []).map((f) => why[f]).filter(Boolean).slice(0, 2).join('. Also, ')
}
let notFollowedP: Promise<NotFollowedFile> | undefined
const loadNotFollowed = () => (notFollowedP ??= import('./not-followed.json').then((m) => m.default as NotFollowedFile))

/** `initial`: what the box opens with (a page that wasn't found passes the ticker or name it was given). */
function Search({ open, setOpen, initial = '' }: { open: boolean; setOpen: (b: boolean) => void; initial?: string }) {
  const [q, setQ] = useState('')
  const [cur, setCur] = useState(0)
  const [stocks, setStocks] = useState<StockIndexRow[]>([])
  const [mgrs, setMgrs] = useState<Manager[]>([])
  const [held, setHeld] = useState<Agg[]>([])
  const [nf, setNf] = useState<NotFollowedFile | null>(null)
  const input = useRef<HTMLInputElement>(null)
  // Escape, Cancel or a click outside puts focus back where it was, not at the top of the page.
  const back = useRef<HTMLElement | null>(null)
  const close = () => {
    setOpen(false)
    back.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    back.current = document.activeElement as HTMLElement | null
    setQ(initial)
    setCur(0)
    input.current?.focus()
    if (!stocks.length) loadStockIndex().then((d) => setStocks(d.stocks)).catch(() => {})
    if (!mgrs.length) loadIndex().then((ix) => setMgrs(funds(ix))).catch(() => {})
    // The same counts as the stock pages and Most owned: share classes combined, followed investors only.
    if (!held.length) loadBooks().then((b) => setHeld(aggregate(b).rows)).catch(() => {})
    if (!nf) loadNotFollowed().then(setNf).catch(() => {})
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const owned = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of held) for (const t of a.classes ?? [a.ticker]) if (t) m.set(t, Math.max(m.get(t) ?? 0, a.holders.length))
    return m
  }, [held])
  const ready = held.length > 0
  // Stock names as the pages show them ("Liberty Live Holdings Series C", not the index's "Com Shs Ser C").
  const named = useMemo(() => stocks.map((r) => ({ r, name: issuerName(r.n), nf: flat(issuerName(r.n)) })), [stocks])
  const stockHit = (t: string, n: string, score = 0): Hit => ({
    kind: 'stock',
    label: n,
    badge: t,
    sub: owners(ready ? owned.get(t) ?? 0 : undefined),
    to: `/s/${encodeURIComponent(t)}`,
    score,
  })
  const groups = useMemo<[string, Hit[]][]>(() => {
    const s = q.trim().toLowerCase()
    if (!s) {
      // Before typing: the largest investors and the most widely owned stocks.
      const inv = [...mgrs].sort((a, b) => b.total_value - a.total_value).slice(0, 3).map((m) => investorHit(m))
      const st = held
        .filter((a) => !a.fund && a.ticker)
        .sort((a, b) => b.holders.length - a.holders.length)
        .slice(0, 3)
        .map((a) => stockHit(a.ticker!, a.name))
      return [
        ['Largest investors', inv],
        ['Most owned stocks', st],
      ]
    }
    const inv: Hit[] = []
    for (const m of mgrs) {
      const hay = searchNames(m).toLowerCase()
      if (hay.includes(s)) inv.push(investorHit(m, m.firm.toLowerCase().startsWith(s) ? 4.5 : hay.split(/[ |]+/).some((w) => w.startsWith(s)) ? 3 : 1))
    }
    const st: Hit[] = []
    const fs = flat(s)
    for (const { r, name, nf } of named) {
      const n = name.toLowerCase()
      // Tickers compare without punctuation, so BRKB, BRK-B, BRK/B and BRK B all find BRK.B, and a company's other
      // classes (the index's aliases: GOOG, BRK.A, BF.A) match exactly too, showing and opening the class typed.
      const exact = fs ? [r.t, ...r.a].find((t) => flat(t) === fs) : undefined
      const tier = exact ? 10 : ALIAS[s] === r.t ? 8 : fs && [r.t, ...r.a].some((t) => flat(t).startsWith(fs)) ? 5 : n.startsWith(s) || (fs.length > 3 && nf.startsWith(fs)) ? 4 : n.includes(s) || (fs.length > 3 && nf.includes(fs)) ? 1 : 0
      if (!tier) continue
      const t = exact ?? r.t
      // Within a tier, the most widely held by the investors Holdterm follows first (then by holders across all
      // 13F filers), so the common stock beats a levered ETF named after it ("Direxion … BRKB Bull 2X").
      st.push(stockHit(t, name, tier + ((owned.get(t) ?? owned.get(r.t) ?? 0) + Math.min(r.h, 9999) / 10000) / 1000))
    }
    const top = (xs: Hit[]) => xs.sort((a, b) => b.score - a.score).slice(0, 6)
    const g: [string, Hit[]][] = [
      ['Investors', top(inv)],
      ['Stocks', top(st)],
    ]
    return (g[1][1][0]?.score ?? 0) > (g[0][1][0]?.score ?? 0) ? [g[1], g[0]] : g
  }, [q, named, mgrs, owned, held]) // eslint-disable-line react-hooks/exhaustive-deps
  const hits = groups.flatMap(([, h]) => h)
  // A fund the rule screened out (say, Fundsmith) gets a plain reason instead of silence.
  const s0 = q.trim().toLowerCase()
  // Searched by firm or by the person it's known for: "michael burry", "druckenmiller", "fundsmith".
  const missed = useMemo(() => {
    if (!nf || s0.length < 3) return undefined
    const fs = flat(s0)
    const hay = (c: NotFollowed) => [firmName(c.s ?? '', c.n), c.n, c.p ?? '', (c.s ?? '').replace(/-/g, ' ')].join(' | ').toLowerCase()
    // The file is from the last screen; a fund the roster has taken on since (a roster run) is followed now.
    const on = new Set(roster.funds.flatMap((f) => [f.cik, f.predecessor]))
    // Held-back reasons come from the roster in use, so a roster run that doesn't rerun the screen (it holds back
    // or takes on funds by data checks) still reads right.
    const held = new Map(roster.held.map((h) => [h.cik, h]))
    const list: NotFollowed[] = [
      ...nf.filers.map((c) => (held.has(c.c) ? { ...c, h: held.get(c.c)!.fails } : c)),
      ...roster.held.filter((h) => !nf.filers.some((c) => c.c === h.cik)).map((h) => ({ c: h.cik, s: h.slug, n: h.firm, h: h.fails })),
    ]
    const m = list.filter((c) => !on.has(c.c) && (hay(c).includes(s0) || (fs.length > 3 && flat(hay(c)).includes(fs))))
    // A whole-word start beats a match inside a word ("smith": Terry Smith before Smithfield).
    return m.find((c) => hay(c).split(/[ |]+/).some((w) => w.startsWith(s0.split(' ')[0]))) ?? m[0]
  }, [nf, s0])
  const why = missed && nf ? whyNot(missed, nf.period) : ''
  const toRule = (e: React.MouseEvent) => {
    e.preventDefault()
    setOpen(false)
    navigate('/about#roster')
  }
  // Say how many results there are once typing pauses, so a screen reader user knows whether to arrow down.
  const count = (kind: Hit['kind']) => {
    const n = hits.filter((h) => h.kind === kind).length
    return n ? `${n} ${n === 1 ? kind : kind + 's'}` : ''
  }
  const found = !q.trim() ? '' : hits.length ? `${[count('investor'), count('stock')].filter(Boolean).join(' and ')}. Use the arrow keys to choose.` : `Nothing matches “${q.trim()}”.`
  const [said, setSaid] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSaid(found), 500)
    return () => clearTimeout(t)
  }, [found])
  if (!open) return null
  const go = (h?: Hit) => {
    if (!h) return
    setOpen(false)
    navigate(h.to)
  }
  let i = -1
  return (
    <div className="overlay" onClick={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="palette" role="dialog" aria-label="Search" onClick={(e) => e.stopPropagation()}>
        <div className="prompt">
          <Glass />
          <input
            ref={input}
            value={q}
            placeholder="Search investors or stocks"
            aria-label="Search investors, companies or tickers"
            aria-controls="search-results"
            aria-activedescendant={hits[cur] ? `sr-${cur}` : undefined}
            role="combobox"
            aria-expanded="true"
            onChange={(e) => {
              setQ(e.target.value)
              setCur(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setCur((c) => Math.min(hits.length - 1, c + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setCur((c) => Math.max(0, c - 1)))
              else if (e.key === 'Enter') go(hits[cur])
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="button" className="palette-close" onClick={close}>
            Cancel
          </button>
        </div>
        <div className="sr" role="status">
          {said}
        </div>
        <div className="results" id="search-results" role="listbox" aria-label="Search results">
          {groups
            .filter(([, h]) => h.length)
            .map(([title, hs]) => (
              <div className="group" key={title} role="group" aria-label={title}>
                <div className="group-title" aria-hidden="true">
                  {title}
                </div>
                {hs.map((h) => {
                  i++
                  const n = i
                  return (
                    <div key={h.to} id={`sr-${n}`} role="option" aria-selected={n === cur} className={`hit${n === cur ? ' cur' : ''}`} onMouseEnter={() => setCur(n)} onClick={() => go(h)}>
                      <span className={`badge-${h.kind}`} aria-hidden="true">
                        {h.badge}
                      </span>
                      <span className="hit-text">
                        <span className="lbl">{h.label}</span>
                        <span className="sub">{h.sub}</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
        </div>
        {!q.trim() && !hits.length && <div className="no-hits">Loading suggestions…</div>}
          {q.trim() && !hits.length && !why && (
            <div className="no-hits">
              <b>Nothing matches “{q.trim()}”</b>
              <span>Try a company name such as Apple, a ticker such as MSFT, or an investor such as Berkshire Hathaway.</span>
              {(
                <span>
                  Holdterm follows {roster.funds.length} investors chosen by a published rule, so a fund you know may not be one of them.{' '}
                  <a href="/about#roster" onClick={toRule}>
                    How investors are chosen
                  </a>
                </span>
              )}
            </div>
          )}
        {missed && why && (
          <p className="search-why">
            {firmName(missed.s ?? '', missed.n)}{missed.p && !firmName(missed.s ?? '', missed.n).includes(missed.p) ? ` (${missed.p})` : ''} isn’t one of the investors Holdterm follows: {why}.{' '}
            <a href="/about#roster" onClick={toRule}>
              How investors are chosen
            </a>
          </p>
        )}
      </div>
    </div>
  )
}

/** After an in-app navigation, move focus to the new page and say its name, as a full page load would: without
 * this, keyboard focus stays on the link that was used and a screen reader hears nothing. The title is read once
 * the page sets it (pages that load data set it when the data arrives) and it has settled, or after 3 seconds. */
/** Minutes since this EDGAR session opened (weekdays 6:00 to 22:00 New York time), or null outside it. */
function edgarMinutes(now: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]))
  const m = (Number(parts.hour) - 6) * 60 + Number(parts.minute)
  return ['Sat', 'Sun'].includes(parts.weekday) || m < 0 || m >= 16 * 60 ? null : m
}
const STALE_MIN = 180
/** "SEC data updated 20 minutes ago": when Copybook last wrote the SEC data this page loaded (freshness in data.ts),
 * kept current each minute. Nothing until a page has loaded some data. While EDGAR is taking filings, data more than
 * 3 hours old (and not refreshed since the session opened 3 hours ago) is shown as a warning: new filings may be
 * missing. Outside those hours an old timestamp is normal and stays plain. */
function Fresh() {
  const [, tick] = useState(0)
  useEffect(() => {
    const on = () => tick((n) => n + 1)
    window.addEventListener('holdterm:fresh', on)
    const t = setInterval(on, 60_000)
    return () => (window.removeEventListener('holdterm:fresh', on), clearInterval(t))
  }, [])
  if (!freshness.at) return null
  const now = new Date()
  const m = Math.max(0, Math.round((now.getTime() - freshness.at) / 60_000))
  const ago = m < 1 ? 'just now' : m < 60 ? `${m} minute${m === 1 ? '' : 's'} ago` : m < 48 * 60 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'} ago` : `${Math.round(m / 1440)} days ago`
  const session = edgarMinutes(now)
  const stale = session != null && session >= STALE_MIN && m > STALE_MIN
  const at = new Date(freshness.at)
  return (
    <p className={`fresh${stale ? ' stale' : ''}`}>
      SEC data updated{' '}
      <time dateTime={at.toISOString()} title={at.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}>
        {ago}
      </time>
      {stale && <>, later than usual. Filings made since then may not show yet.</>}
    </p>
  )
}

function useRouteAnnouncer(path: string) {
  const [said, setSaid] = useState('')
  const first = useRef(true)
  useEffect(() => {
    if (first.current) return void (first.current = false)
    const was = document.title
    document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true })
    const say = () => setSaid(document.title.replace(/ · Holdterm$/, ''))
    // A page may set its title twice (a first guess, then the full name once data arrives): wait for it to settle.
    let t = setTimeout(() => (mo.disconnect(), say()), document.title !== was ? 400 : 3000)
    const mo = new MutationObserver(() => (clearTimeout(t), (t = setTimeout(() => (mo.disconnect(), say()), 400))))
    const el = document.querySelector('title')
    if (el) mo.observe(el, { childList: true, characterData: true, subtree: true })
    return () => (mo.disconnect(), clearTimeout(t))
  }, [path])
  return said
}

function App() {
  const path = usePath()
  const said = useRouteAnnouncer(path)
  const [search, setSearch] = useState(false)
  const [q0, setQ0] = useState('')
  const [theme, toggleTheme] = useTheme()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setQ0('')
        setSearch(true)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.target as HTMLElement).closest('input,textarea,select')) return
      if (e.key === 'Escape') return void setSearch(false)
      if (e.key === '/') return void (e.preventDefault(), setQ0(''), setSearch(true))
    }
    // A page can open the search with a query, as the event's detail (NotFound's search box does).
    const open = (e: Event) => (setQ0(typeof (e as CustomEvent).detail === 'string' ? (e as CustomEvent<string>).detail : ''), setSearch(true))
    window.addEventListener('keydown', onKey)
    window.addEventListener('holdterm:search', open)
    return () => (window.removeEventListener('keydown', onKey), window.removeEventListener('holdterm:search', open))
  }, [])
  const section = '/' + (path.split('/')[1] ?? '')
  const isOn = (to: string) => (to === '/' ? path === '/' : section === to || (to === '/funds' && section === '/m') || (to === '/consensus' && section === '/s'))
  return (
    <>
      <a
        href="#main"
        className="skip"
        onClick={(e) => {
          e.preventDefault()
          document.querySelector<HTMLElement>('main')?.focus()
        }}
      >
        Skip to content
      </a>
      <header className="top">
        <div className="top-in">
          <A to="/" className="brand" title="Holdterm home">
            <Mark />
            <span className="word">Holdterm</span>
          </A>
          <nav aria-label="sections">
            {TABS.map(([to, label]) => (
              <A key={to} to={to} className={isOn(to) ? 'on' : ''}>
                {label}
              </A>
            ))}
          </nav>
          <div className="top-right">
            <button className="search-btn" onClick={() => (setQ0(''), setSearch(true))} aria-label="Search stocks or investors">
              <Glass />
              <span className="label">Search stocks or investors</span>
            </button>
            <button className="icon-btn" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
              {theme === 'dark' ? (
                <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
                  <circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
                  <path d="M16.5 12.3A7 7 0 0 1 7.7 3.5a7 7 0 1 0 8.8 8.8Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            <A to="/alerts" className={`btn ${section === '/alerts' || section === '/account' ? 'ghost' : ''}`}>
              <span className="hide-sm hide-md-nav">Get alerts</span>
              <span className="show-sm show-md-nav">Alerts</span>
            </A>
          </div>
        </div>
      </header>
      {/* Phones: the sections as a tab bar along the bottom, always in reach (the top strip is hidden there). */}
      <nav className="tabbar" aria-label="sections">
        {TABS.map(([to]) => (
          <A key={to} to={to} className={isOn(to) ? 'on' : ''}>
            <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden>
              <path d={BAR[to][1]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{BAR[to][0]}</span>
          </A>
        ))}
      </nav>
      <div className="sr" role="status" aria-live="polite" aria-atomic="true">
        {said}
      </div>
      <main id="main" key={path} tabIndex={-1}>
        {route(path)}
      </main>
      <footer className="foot">
        <div className="foot-in">
          <div>
            <A to="/" className="brand" title="Holdterm home">
              <Mark size={20} />
              <span className="word">Holdterm</span>
            </A>
            <p className="tagline">What concentrated, long-term investors own and trade, from their filings with the SEC. No ads. Not investment advice.</p>
            <Fresh />
            {location.hostname !== 'holdterm.factordynamics.com' && <p className="build">Preview build {__COMMIT__}</p>}
          </div>
          <nav aria-label="footer">
            <A to="/guide">How to read Holdterm</A>
            <A to="/about">About</A>
            <A to="/alerts">Alerts, ${PRICE.monthly}/mo</A>
            <A to="/account">Account</A>
            <A to="/terms">Terms</A>
            <A to="/privacy">Privacy</A>
            <a href={`mailto:${CONTACT}`}>Contact</a>
            <a href={reportError(path)}>Report a data error</a>
          </nav>
        </div>
      </footer>
      <Search open={search} setOpen={setSearch} initial={q0} />
    </>
  )
}

// Only for Holdterm's own offline page on a reload without a connection (public/sw.js); nothing else is cached.
// VITE_HOLDTERM_SW=off builds the kill switch instead (scripts/sw-kill.js) and registers nothing.
if (import.meta.env.PROD && import.meta.env.VITE_HOLDTERM_SW !== 'off' && 'serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
