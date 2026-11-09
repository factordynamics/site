import '@fontsource-variable/inter/index.css'
import '@fontsource/ibm-plex-mono/400.css'
import './styles.css'
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { funds, loadIndex, loadStockIndex, searchNames, type Manager, type StockIndexRow } from './data'
import { A, navigate, usePath } from './lib'
import { dataSlug, fundPath, publicSlug } from './names'
import { price as PRICE } from './config'
import { About, Account, Alerts, CONTACT, Consensus, Filings, Flows, Fund, Funds, Guide, Home, ISSUES, NotFound, Privacy, Stock, Terms } from './pages'

// [path, label, g-key]; alerts is the header's button, not a nav tab.
const NAV: [string, string, string][] = [
  ['/', 'Overview', 'h'],
  ['/funds', 'Investors', 'm'],
  ['/flows', 'Buys & sells', 'f'],
  ['/consensus', 'Most owned', 'c'],
  ['/filings', 'Stakes & insiders', 'd'],
  ['/alerts', 'Alerts', 'e'],
]
const TABS = NAV.filter((n) => n[0] !== '/alerts')

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

type Hit = { kind: 'stock' | 'investor'; label: string; sub: string; to: string; score: number }

function Search({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const [q, setQ] = useState('')
  const [cur, setCur] = useState(0)
  const [stocks, setStocks] = useState<StockIndexRow[]>([])
  const [mgrs, setMgrs] = useState<Manager[]>([])
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    setQ('')
    setCur(0)
    input.current?.focus()
    if (!stocks.length) loadStockIndex().then((d) => setStocks(d.stocks)).catch(() => {})
    if (!mgrs.length) loadIndex().then((ix) => setMgrs(funds(ix))).catch(() => {})
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const hits = useMemo<Hit[]>(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    const out: Hit[] = []
    for (const m of mgrs) {
      const hay = searchNames(m).toLowerCase()
      if (hay.includes(s)) out.push({ kind: 'investor', label: m.firm, sub: m.pm ? `PM ${m.pm}` : 'fund', to: fundPath(m.slug), score: m.firm.toLowerCase().startsWith(s) ? 4 : hay.split(/[ |]+/).some((w) => w.startsWith(s)) ? 3 : 1 })
    }
    for (const r of stocks) {
      const t = r.t.toLowerCase()
      const n = r.n.toLowerCase()
      const sc = t === s ? 10 : t.startsWith(s) ? 5 : n.startsWith(s) ? 4 : n.includes(s) ? 1 : 0
      if (sc) out.push({ kind: 'stock', label: r.t, sub: `${r.n} · ${r.h} holders`, to: `/s/${encodeURIComponent(r.t)}`, score: sc + Math.min(r.h, 200) / 400 })
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 12)
  }, [q, stocks, mgrs])
  if (!open) return null
  const go = (h?: Hit) => {
    const to = h?.to ?? (/^[a-z.]{1,6}$/i.test(q.trim()) ? `/s/${encodeURIComponent(q.trim().toUpperCase())}` : null)
    if (!to) return
    setOpen(false)
    navigate(to)
  }
  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="prompt">
          <Glass />
          <input
            ref={input}
            value={q}
            placeholder="Search a ticker, company, fund or manager"
            aria-label="search tickers, companies, funds and managers"
            onChange={(e) => {
              setQ(e.target.value)
              setCur(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              else if (e.key === 'ArrowDown') (e.preventDefault(), setCur((c) => Math.min(hits.length - 1, c + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setCur((c) => Math.max(0, c - 1)))
              else if (e.key === 'Enter') go(hits[cur])
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd>esc</kbd>
        </div>
        <ul>
          {hits.map((h, i) => (
            <li key={h.to} className={i === cur ? 'cur' : ''} onMouseEnter={() => setCur(i)} onClick={() => go(h)}>
              <span className={`kind ${h.kind}`}>{h.kind === 'stock' ? 'Stock' : 'Investor'}</span>
              <span className="lbl">{h.label}</span>
              <span className="dim sub">{h.sub}</span>
            </li>
          ))}
          {q && !hits.length && <li className="dim">No match{/^[a-z.]{1,6}$/i.test(q.trim()) ? `. Press Enter to try the ticker ${q.trim().toUpperCase()}.` : '.'}</li>}
        </ul>
      </div>
    </div>
  )
}

function Help({ close }: { close: () => void }) {
  const rows: [string, string][] = [
    ['/  or  ⌘K', 'Search tickers and investors'],
    ['g h', 'Overview'],
    ['g m', 'Investors'],
    ['g f', 'Buys and sells'],
    ['g c', 'Most owned stocks'],
    ['g d', '13D, 13G and Form 4 filings'],
    ['g e', 'Email alerts'],
    ['j / k', 'Move down / up a table'],
    ['Enter', 'Open the selected row'],
    ['1-5', 'Switch tabs'],
    ['?', 'This help'],
  ]
  return (
    <div className="overlay" onClick={close}>
      <div className="palette help" onClick={(e) => e.stopPropagation()}>
        <div className="prompt">
          Keyboard shortcuts
        </div>
        <table className="grid">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td className="dim">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function App() {
  const path = usePath()
  const [search, setSearch] = useState(false)
  const [help, setHelp] = useState(false)
  const [theme, toggleTheme] = useTheme()
  useEffect(() => {
    let g = 0
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearch(true)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.target as HTMLElement).closest('input,textarea,select')) return
      if (e.key === 'Escape') return void (setHelp(false), setSearch(false))
      if (e.key === '/') return void (e.preventDefault(), setSearch(true))
      if (e.key === '?') return void setHelp((h) => !h)
      if (e.key === 'g') return void (g = Date.now())
      if (Date.now() - g < 1200) {
        const hit = NAV.find((n) => n[2] === e.key)
        g = 0
        if (hit) navigate(hit[0])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const section = '/' + (path.split('/')[1] ?? '')
  return (
    <>
      <header className="top">
        <div className="top-in">
          <A to="/" className="brand" title="Holdterm home">
            <Mark />
            <span className="word">Holdterm</span>
          </A>
          <nav aria-label="sections">
            {TABS.map(([to, label]) => (
              <A key={to} to={to} className={(to === '/' ? path === '/' : section === to || (to === '/funds' && section === '/m')) ? 'on' : ''}>
                {label}
              </A>
            ))}
          </nav>
          <div className="top-right">
            <button className="search-btn" onClick={() => setSearch(true)} aria-label="Search stocks and investors">
              <Glass />
              <span className="label">Search stocks or investors</span>
              <kbd>/</kbd>
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
              <span className="hide-sm">Get alerts</span>
              <span className="show-sm">Alerts</span>
            </A>
          </div>
        </div>
      </header>
      <main key={path} tabIndex={-1}>
        {route(path)}
      </main>
      <footer className="foot">
        <div className="foot-in">
          <div>
            <A to="/" className="brand" title="Holdterm home">
              <Mark size={20} />
              <span className="word">Holdterm</span>
            </A>
            <p className="tagline">13F, 13D/G and Form 4 filings of concentrated, long-term investors, as filed with the SEC. No ads. Not investment advice.</p>
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
      {help && <Help close={() => setHelp(false)} />}
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
