import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import './styles.css'
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { loadIndex, loadStockIndex, superinvestors, type Manager, type StockIndexRow } from './data'
import { A, navigate, usePath } from './lib'
import { About, Account, Activity, Alerts, Grand, Home, Insiders, Investor, Investors, NotFound, Stock } from './pages'

const NAV: [string, string, string][] = [
  ['/', 'home', 'h'],
  ['/m', 'investors', 'm'],
  ['/activity', 'activity', 'a'],
  ['/grand', 'grand', 'p'],
  ['/insiders', 'insiders', 'i'],
  ['/alerts', 'alerts', 'e'],
]

function route(path: string) {
  const p = path.replace(/\/+$/, '') || '/'
  let m: RegExpMatchArray | null
  if (p === '/') return <Home />
  if (p === '/m') return <Investors />
  if ((m = p.match(/^\/m\/([a-z0-9-]+)$/))) return <Investor slug={m[1]} />
  if ((m = p.match(/^\/s\/([^/]+)$/))) return <Stock ticker={decodeURIComponent(m[1]).toUpperCase()} />
  if (p === '/grand') return <Grand />
  if (p === '/activity') return <Activity />
  if (p === '/insiders') return <Insiders />
  if (p === '/alerts') return <Alerts />
  if (p === '/account') return <Account />
  if (p === '/about') return <About />
  return <NotFound />
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
    if (!mgrs.length) loadIndex().then((ix) => setMgrs(superinvestors(ix))).catch(() => {})
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const hits = useMemo<Hit[]>(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    const out: Hit[] = []
    for (const m of mgrs) {
      const a = m.manager.toLowerCase()
      const b = m.name.toLowerCase()
      if (a.includes(s) || b.includes(s)) out.push({ kind: 'investor', label: m.manager, sub: m.name, to: `/m/${m.slug}`, score: a.startsWith(s) ? 3 : 1 })
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
    const to = h?.to ?? (q.trim() ? `/s/${encodeURIComponent(q.trim().toUpperCase())}` : null)
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
            placeholder="ticker, company or investor"
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
              <span className={`kind ${h.kind}`}>{h.kind === 'stock' ? 'STK' : 'INV'}</span>
              <span className="lbl">{h.label}</span>
              <span className="dim sub">{h.sub}</span>
            </li>
          ))}
          {q && !hits.length && <li className="dim">no match · enter opens /s/{q.trim().toUpperCase()}</li>}
        </ul>
      </div>
    </div>
  )
}

function Help({ close }: { close: () => void }) {
  const rows: [string, string][] = [
    ['/  or  ⌘K', 'search tickers and investors'],
    ['g h', 'home'],
    ['g m', 'superinvestors'],
    ['g a', 'activity: buys and sells'],
    ['g p', 'grand portfolio'],
    ['g i', 'insiders, 13D/G'],
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
        <A to="/" className="brand">
          <span className="mark">H</span>
          <span>holdterm</span>
          <span className="cursor" />
        </A>
        <nav>
          {NAV.map(([to, label, k]) => (
            <A key={to} to={to} className={(to === '/' ? path === '/' : section === to || (to === '/m' && section === '/m')) ? 'on' : ''} title={`g ${k}`}>
              {label}
            </A>
          ))}
        </nav>
        <button className="search-btn" onClick={() => setSearch(true)}>
          <span className="dim">search</span>
          <kbd>/</kbd>
        </button>
      </header>
      <main key={path}>{route(path)}</main>
      <footer className="foot">
        <span>
          holdterm · SEC EDGAR 13F, Form 4, 13D/G as filed · no ads · <A to="/about">about</A> · <A to="/alerts">alerts $3/mo</A> · <A to="/account">account</A>
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
