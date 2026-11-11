import '@fontsource-variable/inter/index.css'
import './styles.css'
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { aggregate, funds, loadBooks, loadIndex, loadStockIndex, searchNames, type Agg, type Manager, type StockIndexRow } from './data'
import { A, navigate, usd, usePath } from './lib'
import { dataSlug, fundPath, issuerName, publicSlug } from './names'
import { price as PRICE } from './config'
import { About, Account, Alerts, CONTACT, Consensus, Filings, Flows, Fund, Funds, Guide, Home, ISSUES, NotFound, Privacy, Stock, Terms } from './pages'

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

function Search({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const [q, setQ] = useState('')
  const [cur, setCur] = useState(0)
  const [stocks, setStocks] = useState<StockIndexRow[]>([])
  const [mgrs, setMgrs] = useState<Manager[]>([])
  const [held, setHeld] = useState<Agg[]>([])
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
    setQ('')
    setCur(0)
    input.current?.focus()
    if (!stocks.length) loadStockIndex().then((d) => setStocks(d.stocks)).catch(() => {})
    if (!mgrs.length) loadIndex().then((ix) => setMgrs(funds(ix))).catch(() => {})
    // The same counts as the stock pages and Most owned: share classes combined, followed investors only.
    if (!held.length) loadBooks().then((b) => setHeld(aggregate(b).rows)).catch(() => {})
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const owned = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of held) for (const t of a.classes ?? [a.ticker]) if (t) m.set(t, Math.max(m.get(t) ?? 0, a.holders.length))
    return m
  }, [held])
  const ready = held.length > 0
  // Stock names as the pages show them ("Liberty Live Holdings Series C", not the index's "Com Shs Ser C").
  const named = useMemo(() => stocks.map((r) => ({ r, name: issuerName(r.n) })), [stocks])
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
    for (const { r, name } of named) {
      const t = r.t.toLowerCase()
      const n = name.toLowerCase()
      const sc = t === s ? 10 : t.startsWith(s) ? 5 : n.startsWith(s) ? 4 : n.includes(s) ? 1 : 0
      if (sc) st.push(stockHit(r.t, name, sc + Math.min(owned.get(r.t) ?? 0, 100) / 100))
    }
    const top = (xs: Hit[]) => xs.sort((a, b) => b.score - a.score).slice(0, 6)
    const g: [string, Hit[]][] = [
      ['Investors', top(inv)],
      ['Stocks', top(st)],
    ]
    return (g[1][1][0]?.score ?? 0) > (g[0][1][0]?.score ?? 0) ? [g[1], g[0]] : g
  }, [q, named, mgrs, owned, held]) // eslint-disable-line react-hooks/exhaustive-deps
  const hits = groups.flatMap(([, h]) => h)
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
          {q.trim() && !hits.length && (
            <div className="no-hits">
              <b>Nothing matches “{q.trim()}”</b>
              <span>Try a company name such as Apple, a ticker such as MSFT, or an investor such as Berkshire Hathaway.</span>
            </div>
          )}
          {!q.trim() && !hits.length && <div className="no-hits">Loading suggestions…</div>}
        </div>
      </div>
    </div>
  )
}

/** After an in-app navigation, move focus to the new page and say its name, as a full page load would: without
 * this, keyboard focus stays on the link that was used and a screen reader hears nothing. The title is read once
 * the page sets it (pages that load data set it when the data arrives) and it has settled, or after 3 seconds. */
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
  const [theme, toggleTheme] = useTheme()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearch(true)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.target as HTMLElement).closest('input,textarea,select')) return
      if (e.key === 'Escape') return void setSearch(false)
      if (e.key === '/') return void (e.preventDefault(), setSearch(true))
    }
    const open = () => setSearch(true)
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
            <button className="search-btn" onClick={() => setSearch(true)} aria-label="Search stocks and investors">
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
          </div>
          <nav aria-label="footer">
            <A to="/guide">How to read Holdterm</A>
            <A to="/about">About</A>
            <A to="/alerts">Alerts, ${PRICE.monthly}/mo</A>
            <A to="/account">Account</A>
            <A to="/terms">Terms</A>
            <A to="/privacy">Privacy</A>
            <a href={`mailto:${CONTACT}`}>Contact</a>
            <a href={ISSUES}>Report a data error</a>
          </nav>
        </div>
      </footer>
      <Search open={search} setOpen={setSearch} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
