import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { booksProgress } from './data'

// ---------- formatting ----------
export function usd(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return '—'
  const a = Math.abs(v)
  const s = v < 0 ? '−' : ''
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(digits)}T`
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(digits)}B`
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(digits)}M`
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(digits)}K`
  return `${s}$${a.toFixed(0)}`
}
/** Axis labels: no trailing ".0" ($300B, $2.5B). */
export const usdAxis = (v: number) => usd(v, 1).replace(/\.0(?=[KMBT])/, '')
export const price = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const signedUsd = (v: number | null | undefined) => (v == null ? '—' : v > 0 ? `+${usd(v)}` : usd(v))
/** One decimal by default ("45.2%"); a non-zero share too small to show reads "<0.1%", not "0.0%". */
export const pct = (v: number | null | undefined, d = 1) => {
  if (v == null || !isFinite(v)) return '—'
  const f = (v * 100).toFixed(d)
  return v !== 0 && Number(f) === 0 ? `${v < 0 ? '−' : ''}<${(10 ** -d).toFixed(d)}%` : `${f.replace('-', '−')}%`
}
export const num = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-US').replace('-', '−'))
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Nov 6" this year, "Nov 6, 2025" before it. */
export const date = (d: string | null | undefined) => (d ? (d.slice(0, 4) === String(new Date().getUTCFullYear()) ? day(d) : `${day(d)}, ${d.slice(0, 4)}`) : '—')
export const day = (d: string) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`
export const daysAgo = (d: string) => Math.round((Date.now() - Date.parse(d + 'T12:00:00Z')) / 86_400_000)

// ---------- routing (history API, no dependency) ----------
const listeners = new Set<() => void>()
export function navigate(to: string) {
  if (to === location.pathname + location.search) return
  history.pushState(null, '', to)
  window.scrollTo(0, 0)
  listeners.forEach((l) => l())
}
// Guarded so the build can import the formatters (vite.config.ts) outside a browser.
if (typeof window !== 'undefined') window.addEventListener('popstate', () => listeners.forEach((l) => l()))
export function usePath() {
  const [p, set] = useState(location.pathname)
  useEffect(() => {
    const l = () => set(location.pathname)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return p
}
export function A({ to, children, className, title }: { to: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <a
      href={to}
      className={className}
      title={title}
      aria-current={className?.split(' ').includes('on') ? 'page' : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}
export const stockHref = (t: string | null) => (t ? `/s/${encodeURIComponent(t)}` : '')
export function Tick({ t, name, label }: { t: string | null; name?: string; label?: string }) {
  if (!t) return <span className="dim" title={name}>—</span>
  return (
    <A to={stockHref(t)} className="tk" title={label && label !== t ? `${name}: share classes ${label} combined` : name}>
      {label && label !== t ? (
        <>
          <span className="hide-sm">{label}</span>
          <span className="show-sm">{t}</span>
        </>
      ) : (
        t
      )}
    </A>
  )
}

// ---------- async ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string } {
  const [s, set] = useState<{ data?: T; error?: string }>({})
  useEffect(() => {
    let live = true
    set({})
    fn().then(
      (data) => live && set({ data }),
      (e) => live && set({ error: String(e?.message ?? e) }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return s
}
// Column widths for placeholder rows: a name column, then shorter figures, like the real tables.
const SKEL_COLS = [[30, 22, 14, 12], [26, 18, 16, 10], [34, 20, 12, 14], [22, 24, 14, 11]]
/** A placeholder shaped like a table (head plus `rows` rows at real row height), so nothing jumps when the
 * data arrives. `what` is announced to screen readers. */
export function Loading({ what = 'Loading', rows = 8, quiet = false }: { what?: string; rows?: number; quiet?: boolean }) {
  return (
    <div className="loading" role={quiet ? undefined : 'status'} aria-live={quiet ? undefined : 'polite'}>
      {!quiet && <span className="sr">{what}…</span>}
      {!quiet && <SlowNote />}
      <div className="skel-head" aria-hidden>
        {SKEL_COLS[0].map((w, j) => (
          <span key={j} className="skel" style={{ width: `${w * 0.6}%` }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-row" aria-hidden>
          {SKEL_COLS[i % SKEL_COLS.length].map((w, j) => (
            <span key={j} className={`skel${j ? ' num' : ''}`} style={{ width: `${w}%` }} />
          ))}
        </div>
      ))}
    </div>
  )
}
/** For pages built from every investor's 13F: how many have arrived, so a slow connection shows movement. */
export function BooksProgress({ what }: { what: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const on = () => tick((n) => n + 1)
    window.addEventListener('holdterm:books', on)
    return () => window.removeEventListener('holdterm:books', on)
  }, [])
  // After 3 seconds, say why it takes a moment: this page adds up every investor's 13F, all in one download.
  const [long, setLong] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLong(true), 3000)
    return () => clearTimeout(t)
  }, [])
  const { done, total, bytes } = booksProgress
  const mb = (bytes / 1e6).toFixed(1)
  return (
    <div className="books-progress">
      <div className="books-progress-text" aria-hidden>
        <span>{what}</span>
        <span className="dim">{total ? `${done} of ${total} portfolios` : bytes ? `${mb} MB received` : 'Downloading…'}</span>
      </div>
      <div className={`books-progress-bar${total ? '' : ' busy'}`} aria-hidden>
        <i style={total ? { width: `${(done / total) * 100}%` } : undefined} />
      </div>
      {/* Rendered from the start but hidden until 3 seconds, so its space is kept and nothing below it moves. */}
      {!total && (
        <p className="books-progress-note" style={long ? undefined : { visibility: 'hidden' }}>
          This page adds up every investor’s latest 13F, so it downloads all of them at once. On a slow connection that takes several seconds; the table appears as soon as they arrive.
        </p>
      )}
    </div>
  )
}
/** A page's tabs while it loads: their real names, not yet clickable. */
export function TabsSkel({ labels }: { labels: string[] }) {
  return (
    <div className="tabs" aria-hidden inert>
      {labels.map((l, i) => (
        <button key={l} tabIndex={-1} className={i === 0 ? 'on' : ''}>
          {l}
        </button>
      ))}
    </div>
  )
}
const useOffline = () => {
  const [off, set] = useState(typeof navigator !== 'undefined' && navigator.onLine === false)
  useEffect(() => {
    const on = () => set(navigator.onLine === false)
    window.addEventListener('online', on)
    window.addEventListener('offline', on)
    return () => (window.removeEventListener('online', on), window.removeEventListener('offline', on))
  }, [])
  return off
}
/** After 8 seconds of loading, a plain note that it's slow, with a retry, so a page never just sits there. */
function SlowNote({ after = 8000 }: { after?: number }) {
  const [slow, setSlow] = useState(false)
  const offline = useOffline()
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), after)
    return () => clearTimeout(t)
  }, [])
  if (!slow && !offline) return null
  return (
    <div className="slow-note">
      <span>{offline ? 'You’re offline. This will finish loading when your connection is back.' : 'This is taking longer than usual. It’s still loading.'}</span>
      {!offline && (
        <button className="btn ghost" onClick={() => location.reload()}>
          Try again
        </button>
      )}
    </div>
  )
}
/** One skeleton column: its share of the row (`w`, and `pw` on phones), whether it is a number (right-aligned),
 * whether it holds a ticker over a name on phones (two lines), and whether it shows only on phones or wider screens. */
export type SkelCol = { w: number; pw?: number; num?: boolean; two?: boolean; on?: 'wide' | 'phone' }
/** Placeholder rows in the final table's columns, at its row height, so nothing moves when the data arrives. */
function TableSkel({ cols, rows }: { cols: SkelCol[]; rows: number }) {
  const row = (head: boolean, i: number) => (
    <div key={i} className={head ? 'skel-head shaped' : 'skel-row shaped'}>
      {cols.map((c, j) => (
        <span key={j} className={`skel-cell${c.num ? ' num' : ''}${c.on ? ` only-${c.on}` : ''}`} style={{ ['--w' as string]: c.w, ['--pw' as string]: c.pw ?? c.w }}>
          <span className="skel" style={{ width: head ? '60%' : c.num ? `${45 + ((i * 7 + j * 13) % 30)}%` : c.two ? '38%' : `${55 + ((i * 11 + j * 5) % 35)}%` }} />
          {!head && c.two && <span className="skel skel-sub" style={{ width: `${50 + ((i * 13) % 35)}%` }} />}
        </span>
      ))}
    </div>
  )
  return (
    <div className="loading" aria-hidden>
      {row(true, 0)}
      {Array.from({ length: rows }, (_, i) => row(false, i + 1))}
    </div>
  )
}
/** A whole page while its data loads: title, summary, stat cards and a table, in the page's own layout. A page can
 * pass its real heading (`head`), what sits above its table (`before`, such as its tabs), its table's columns
 * (`cols`), and how long its load normally takes before the "taking longer than usual" note (`slowAfter`). */
export function PageLoading({ what = 'Loading', stats = 4, rows = 12, progress, head, before, cols, slowAfter }: { what?: string; stats?: number; rows?: number; progress?: ReactNode; head?: ReactNode; before?: ReactNode; cols?: SkelCol[]; slowAfter?: number }) {
  return (
    <div className="page page-loading" role="status" aria-live="polite">
      <span className="sr">{what}…</span>
      <SlowNote after={slowAfter} />
      {head ?? (
        <div aria-hidden>
          <span className="skel skel-title" />
          <span className="skel skel-line" />
          <span className="skel skel-line short" />
        </div>
      )}
      {progress}
      {stats > 0 && (
        <div className="stats" aria-hidden>
          {Array.from({ length: stats }, (_, i) => (
            <div key={i} className="stat">
              <span className="skel skel-label" />
              <span className="skel skel-value" />
            </div>
          ))}
        </div>
      )}
      {before}
      <section className="panel" aria-hidden>
        <header>
          <span className="skel skel-label" />
        </header>
        <div className="body">{cols ? <TableSkel cols={cols} rows={rows} /> : <Loading rows={rows} quiet />}</div>
      </section>
    </div>
  )
}
/** Nothing to list: what that means in a plain sentence, why it can happen, and where to go next. */
export function Empty({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: [string, string] }) {
  return (
    <div className="empty-state">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden className="empty-icon">
        <rect x="4" y="5" width="16" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 10h8M8 14h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <div>
        <p className="empty-title">{title}</p>
        {hint && <p className="empty-hint">{hint}</p>}
        {action && (
          <A to={action[1]} className="empty-action">
            {action[0]} →
          </A>
        )}
      </div>
    </div>
  )
}
/** A load that failed: what happened in plain words, a retry, and a way on; the technical reason is tucked away. */
export function Failed({ error, what = 'this page' }: { error: string; what?: string }) {
  const offline = useOffline()
  const [still, setStill] = useState(false)
  // Back online: load the page again by itself.
  useEffect(() => {
    const on = () => location.reload()
    window.addEventListener('online', on)
    return () => window.removeEventListener('online', on)
  }, [])
  return (
    <div className="failed" role="alert">
      <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden className="failed-icon">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 7v6M12 16.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div className="failed-text">
        <h2>We couldn’t load {what}</h2>
        <p>
          {offline
            ? 'You’re offline. This page will load by itself as soon as your connection is back.'
            : /^timeout /.test(error)
              ? 'The SEC filing data is taking too long to arrive. The data host may be slow right now; trying again usually works.'
              : 'The SEC filing data didn’t arrive. This is usually a brief network hiccup, and trying again normally fixes it.'}
          {still && offline && <> Still offline.</>}
        </p>
        <div className="failed-actions">
          {/* Offline, a reload would only show the browser's own error page. */}
          <button className="btn" onClick={() => (navigator.onLine === false ? setStill(true) : location.reload())}>
            Try again
          </button>
          <A to="/" className="btn ghost">
            Go to the overview
          </A>
        </div>
        <details>
          <summary>Technical details</summary>
          <code>{error}</code>
        </details>
      </div>
    </div>
  )
}

// ---------- layout ----------
/** Sentence case for labels written in lower case ("holdings" -> "Holdings"; "% of book" is left alone). */
export const cap = <T,>(x: T): T => (typeof x === 'string' ? ((x.charAt(0).toUpperCase() + x.slice(1)) as T) : x)
// A table in a panel takes the panel's heading as its name, so a screen reader says "What it owns, table"
// rather than just "table".
const PanelHeading = createContext<string | undefined>(undefined)
export function Panel({ title, right, children, className = '' }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId()
  return (
    <section className={`panel ${className}`}>
      <header>
        <h2 id={id}>{cap(title)}</h2>
        <span className="right">{right}</span>
      </header>
      <PanelHeading.Provider value={id}>
        <div className="body">{children}</div>
      </PanelHeading.Provider>
    </section>
  )
}
export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'pos' | 'neg' }) {
  return (
    <div className="stat" role="listitem">
      <div className="label">{cap(label)}</div>
      <div className={`value ${tone ?? ''}`}>{value}</div>
      {sub != null && <div className="sub">{sub}</div>}
    </div>
  )
}
export function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label?: string }) {
  // Left and right arrows move between tabs, as screen-reader users expect of a tab list.
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o[0] === value)
    const j = e.key === 'ArrowRight' ? (i + 1) % options.length : e.key === 'ArrowLeft' ? (i - 1 + options.length) % options.length : e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : -1
    if (j < 0) return
    e.preventDefault()
    onChange(options[j][0])
    ;(e.currentTarget.children[j] as HTMLElement | undefined)?.focus()
  }
  // Phones keep the tabs on one row that scrolls sideways: the active tab is scrolled into view, and a fade
  // on either edge shows there are more tabs that way.
  const row = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState('')
  const measure = () => {
    const el = row.current
    if (!el) return
    const l = el.scrollLeft > 2
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    setEdge(l && r ? 'fade-both' : l ? 'fade-left' : r ? 'fade-right' : '')
  }
  useEffect(() => {
    const el = row.current
    const on = el?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (el && on && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, on.offsetLeft - el.offsetLeft - (el.clientWidth - on.offsetWidth) / 2)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [value, options.length])
  return (
    <div ref={row} className={`tabs ${edge}`} role="tablist" aria-label={label} onKeyDown={onKey} onScroll={measure}>
      {options.map(([k, text]) => {
        // "holdings 14" shows its count as a badge.
        const m = text.match(/^(.*\S)\s+(\d[\d,]*)$/)
        return (
          <button key={k} id={`tab-${k}`} role="tab" aria-selected={value === k} aria-controls={value === k ? 'tabpanel' : undefined} tabIndex={value === k ? 0 : -1} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
            {cap(m ? m[1] : text)}
            {m && <span className="count">{m[2]}</span>}
          </button>
        )
      })}
      {/* Phones: when more tabs are off to the right, an arrow at the edge says so and scrolls to them. A pointer
          shortcut only: keyboard users move with the arrow keys, so it stays out of the tab order and the tree. */}
      {(edge === 'fade-right' || edge === 'fade-both') && (
        <span className="tabs-more" aria-hidden onClick={() => row.current?.scrollBy({ left: row.current.clientWidth * 0.6, behavior: 'smooth' })}>
          <svg viewBox="0 0 16 16" width="16" height="16">
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </div>
  )
}

/** What the selected tab shows, so a screen reader names it ("Bought 8, tab panel") and ties it to its tab. */
export function TabPanel({ tab, children }: { tab: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id="tabpanel" aria-labelledby={`tab-${tab}`}>
      {children}
    </div>
  )
}

export const CHANGE_LABEL: Record<string, string> = { new: 'New', added: 'Added', trimmed: 'Trimmed', exited: 'Sold out', unchanged: '' }
/** Why a line is held: its share counts don't fit across filings, so no trade is counted and its numbers are as filed. */
export const HELD_WHY = 'The share counts in this 13F and the one before don’t fit together (often a stock split the filer didn’t adjust for), so no trade is counted and its shares and value are shown as filed.'
/** A held line's shares, value or weight: greyed with a small "as filed" under it, or a dash on phones, where there
 * is no room for the note and a greyed number still reads as a real one. */
export const AsFiled = ({ children }: { children: ReactNode }) => (
  <span className="as-filed" title={HELD_WHY}>
    <span className="hide-sm">
      {children}
      <span className="as-filed-note">as filed</span>
    </span>
    <span className="show-sm">
      —<span className="sr">not counted</span>
    </span>
  </span>
)
export function ChangeTag({ change, share_change, prev_shares, unclear }: { change: string | null; share_change?: number | null; prev_shares?: number | null; unclear?: boolean }) {
  // Share counts that don't fit across filings: no trade is counted, and the row says why instead of "No change".
  // A badge with an info icon, so it reads as a flag rather than a value; phones say it in one word so it doesn't
  // squeeze the investor's name. The title (and the guide's list of tags) gives the reason.
  if (unclear)
    return (
      <span className="tag held" title={HELD_WHY}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 7.2v4M8 4.6v.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span className="hide-sm">Shares don’t match</span>
        <span className="show-sm">Unclear</span>
        <span className="sr"> {HELD_WHY}</span>
      </span>
    )
  if (!change || change === 'unchanged') return <span className="dim">No change</span>
  const tone = change === 'new' || change === 'added' ? 'pos' : 'neg'
  const r = (change === 'added' || change === 'trimmed') && share_change != null && prev_shares ? (share_change / prev_shares) * 100 : null
  // Past +999% a percentage is noise ("+76194.4%"); show the multiple of the old position instead ("×763").
  const rel = r == null ? '' : Math.abs(r) < 0.05 ? ` ${r > 0 ? '+' : '−'}<0.1%` : r > 999 ? ` ×${Math.round(1 + r / 100).toLocaleString('en-US')}` : ` ${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}%`
  return (
    <span className={`tag ${tone}`}>
      {CHANGE_LABEL[change]}
      {rel}
    </span>
  )
}

// ---------- data grid: sortable, rows link to their page ----------
export type Col<R> = {
  key: string
  label: ReactNode
  render: (r: R, i: number) => ReactNode
  sort?: (r: R) => number | string
  num?: boolean
  hideSm?: boolean
  /** Also hidden on narrower desktops and tablets: `lg` at 1100px and below, `md` at 960px and below. */
  hide?: 'lg' | 'md'
  title?: string
  width?: string
  /** Wrap this cell in a real link to the row's href (keyboard, middle-click, copy link). */
  link?: boolean
}
export function Grid<R>({
  cols,
  rows,
  href,
  initial,
  limit,
  rowClass,
  empty = 'Nothing to show yet.',
  rank = false,
}: {
  cols: Col<R>[]
  rows: R[]
  href?: (r: R) => string | null
  initial?: [string, 'asc' | 'desc']
  limit?: number
  rowClass?: (r: R) => string
  empty?: ReactNode
  rank?: boolean
}) {
  const heading = useContext(PanelHeading)
  const [sort, setSort] = useState<[string, 'asc' | 'desc'] | undefined>(initial)
  const [shown, setShown] = useState(limit ?? Infinity)
  const body = useRef<HTMLTableSectionElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [cue, setCue] = useState(false)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const check = () => setCue(el.scrollWidth - el.clientWidth - el.scrollLeft > 4)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    el.addEventListener('scroll', check, { passive: true })
    return () => (ro.disconnect(), el.removeEventListener('scroll', check))
  }, [rows.length])
  const sorted = useMemo(() => {
    if (!sort) return rows
    const c = cols.find((c) => c.key === sort[0])
    if (!c?.sort) return rows
    const f = c.sort
    const dir = sort[1] === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = f(a)
      const y = f(b)
      return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * dir
    })
  }, [rows, sort, cols])
  const visible = sorted.slice(0, shown)
  // A row whose ticker already links to its page keeps one Tab stop: the name link (same page) stays clickable
  // and readable but leaves the Tab order, so keyboard users don't pass every row twice.
  useEffect(() => {
    body.current?.querySelectorAll<HTMLAnchorElement>('a.rowlink').forEach((a) => {
      const twin = [...(a.closest('tr')?.querySelectorAll<HTMLAnchorElement>('a:not(.rowlink)') ?? [])].some((o) => o.getAttribute('href') === a.getAttribute('href'))
      if (twin) a.tabIndex = -1
      else a.removeAttribute('tabindex')
    })
  })

  if (!rows.length) return typeof empty === 'string' ? <Empty title={empty} /> : <>{empty}</>
  return (
    <div className={`grid-outer ${cue ? 'cue' : ''}`}>
    <div className="grid-wrap" ref={wrap}>
      <table className="grid" aria-labelledby={heading}>
        <thead>
          <tr>
            {rank && <th className="num rank">#</th>}
            {cols.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`${c.num ? 'num' : ''} ${c.hideSm ? 'hide-sm' : ''} ${c.hide ? `hide-${c.hide}` : ''}`}
                style={c.width ? { width: c.width } : undefined}
                title={c.title}
                aria-sort={sort?.[0] === c.key ? (sort[1] === 'desc' ? 'descending' : 'ascending') : c.sort ? 'none' : undefined}
              >
                {c.sort ? (
                  <button className="sorter" onClick={() => setSort(sort?.[0] === c.key ? [c.key, sort[1] === 'desc' ? 'asc' : 'desc'] : [c.key, c.num ? 'desc' : 'asc'])}>
                    {cap(c.label)}
                    {sort?.[0] === c.key ? <span className="arrow" aria-hidden>{sort[1] === 'desc' ? '▼' : '▲'}</span> : null}
                  </button>
                ) : (
                  cap(c.label)
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={body}>
          {visible.map((r, i) => {
            const to = href?.(r)
            return (
              <tr
                key={i}
                className={`${to ? 'link' : ''} ${rowClass?.(r) ?? ''}`}
                onClick={(e) => {
                  if (!to || (e.target as HTMLElement).closest('a')) return
                  navigate(to)
                }}
              >
                {rank && <td className="num rank dim">{i + 1}</td>}
                {cols.map((c) => (
                  <td key={c.key} className={`${c.num ? 'num' : ''} ${c.hideSm ? 'hide-sm' : ''} ${c.hide ? `hide-${c.hide}` : ''}`}>
                    {c.link && to ? (
                      <A to={to} className="rowlink">
                        {c.render(r, i)}
                      </A>
                    ) : (
                      c.render(r, i)
                    )}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
      {sorted.length > shown && (
        <button className="more" onClick={() => setShown(Infinity)}>
          Show all {sorted.length}
        </button>
      )}
    </div>
  )
}

// ---------- charts (SVG) ----------
export function Bar({ value, max, tone = 'acc' }: { value: number; max: number; tone?: 'acc' | 'pos' | 'neg' }) {
  const w = max > 0 ? Math.max(0, Math.min(1, Math.abs(value) / max)) : 0
  return (
    <span className="bar">
      <span className={`fill ${tone}`} style={{ width: `${(w * 100).toFixed(1)}%` }} />
    </span>
  )
}

export function StackBar({ parts, height = 10 }: { parts: { label: string; value: number; color: string }[]; height?: number }) {
  const t = parts.reduce((s, p) => s + p.value, 0) || 1
  let x = 0
  return (
    <svg className="stackbar" viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none" style={{ height }} role="img">
      <title>{parts.map((p) => `${p.label} ${((p.value / t) * 100).toFixed(1)}%`).join(', ')}</title>
      {parts.map((p) => {
        const w = (p.value / t) * 1000
        const r = <rect key={p.label} x={x} y={0} width={Math.max(0, w - 2)} height={height} fill={p.color}><title>{`${p.label} ${((p.value / t) * 100).toFixed(1)}%`}</title></rect>
        x += w
        return r
      })}
    </svg>
  )
}

