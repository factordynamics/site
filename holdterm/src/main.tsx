import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { funds, loadIndex, loadStockIndex, searchNames, type Manager, type StockIndexRow } from './data'
import { A, navigate, usePath } from './lib'
import { About, Account, Alerts, Consensus, Filings, Flows, Fund, Funds, Home, ISSUES, NotFound, Privacy, Stock, Terms } from './pages'

// [path, label, g-key]
const NAV: [string, string, string][] = [
  ['/', 'pulse', 'h'],
  ['/flows', 'flows', 'f'],
  ['/consensus', 'consensus', 'c'],
  ['/funds', 'funds', 'm'],
  ['/filings', '13D·F4', 'd'],
  ['/alerts', 'alerts', 'e'],
]
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
  if ((m = p.match(/^\/m\/([a-z0-9-]+)$/))) return <Fund slug={m[1]} />
  if ((m = p.match(/^\/s\/([^/]+)$/))) return <Stock ticker={decodeURIComponent(m[1]).toUpperCase()} />
  if (p === '/consensus') return <Consensus />
  if (p === '/flows') return <Flows />
  if (p === '/filings') return <Filings />
  if (p === '/alerts') return <Alerts />
  if (p === '/account') return <Account />
  if (p === '/about') return <About />
  if (p === '/terms') return <Terms />
  if (p === '/privacy') return <Privacy />
  return <NotFound />
}

/** Wordmark: a ranked-weights glyph (a 13F book, largest position first) and the name. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden className="mark">
      <rect width="20" height="20" rx="3" fill="var(--acc)" />
      <rect x="4" y="4.5" width="12" height="2.2" fill="#0b0b0a" />
      <rect x="4" y="8.9" width="8.5" height="2.2" fill="#0b0b0a" />
      <rect x="4" y="13.3" width="5" height="2.2" fill="#0b0b0a" />
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
      if (hay.includes(s)) out.push({ kind: 'investor', label: m.firm, sub: m.pm ? `PM ${m.pm}` : 'fund', to: `/m/${m.slug}`, score: m.firm.toLowerCase().startsWith(s) ? 4 : hay.split(/[ |]+/).some((w) => w.startsWith(s)) ? 3 : 1 })
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
          <span className="acc">&gt;</span>
          <input
            ref={input}
            value={q}
            placeholder="ticker, company, fund or manager"
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
              <span className={`kind ${h.kind}`}>{h.kind === 'stock' ? 'stock' : 'fund'}</span>
              <span className="lbl">{h.label}</span>
              <span className="dim sub">{h.sub}</span>
            </li>
          ))}
          {q && !hits.length && <li className="dim">no match{/^[a-z.]{1,6}$/i.test(q.trim()) ? ` · enter tries ticker ${q.trim().toUpperCase()}` : ''}</li>}
        </ul>
      </div>
    </div>
  )
}

function Help({ close }: { close: () => void }) {
  const rows: [string, string][] = [
    ['/  or  ⌘K', 'search tickers and investors'],
    ['g h', 'pulse (home)'],
    ['g f', 'flows: buys and sells'],
    ['g c', 'consensus'],
    ['g m', 'funds'],
    ['g d', '13D, 13G and Form 4'],
    ['g e', 'email alerts'],
    ['j / k', 'move down / up a table'],
    ['enter', 'open the selected row'],
    ['1-5', 'switch tabs'],
    ['?', 'this help'],
  ]
  return (
    <div className="overlay" onClick={close}>
      <div className="palette help" onClick={(e) => e.stopPropagation()}>
        <div className="prompt">
          <span className="acc">?</span> keyboard
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

function Clock() {
  const [t, set] = useState(() => new Date())
  useEffect(() => {
    const i = setInterval(() => set(new Date()), 30_000)
    return () => clearInterval(i)
  }, [])
  return <span className="dim hide-sm">{t.toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
}

function App() {
  const path = usePath()
  const [search, setSearch] = useState(false)
  const [help, setHelp] = useState(false)
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
        <A to="/" className="brand" title="holdterm home">
          <Mark />
          <span className="word">holdterm</span>
        </A>
        <nav>
          {NAV.map(([to, label, k]) => (
            <A key={to} to={to} className={(to === '/' ? path === '/' : section === to || (to === '/funds' && section === '/m')) ? 'on' : ''} title={`g ${k}`}>
              {label}
            </A>
          ))}
        </nav>
        <button className="search-btn" onClick={() => setSearch(true)}>
          <span className="dim">search</span>
          <kbd>/</kbd>
          <svg className="glass" viewBox="0 0 16 16" width="14" height="14" aria-label="search">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      </header>
      <main key={path}>{route(path)}</main>
      <footer className="foot">
        <span>
          holdterm · SEC EDGAR filings as filed · no ads · not investment advice · <A to="/about">about</A> · <A to="/alerts">alerts $3/mo</A> · <A to="/account">account</A> · <A to="/terms">terms</A> · <A to="/privacy">privacy</A> · <a href={ISSUES}>report a data error</a>
        </span>
        <span>
          <Clock /> <button className="linkish" onClick={() => setHelp(true)}>? keys</button>
        </span>
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
