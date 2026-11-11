import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { booksProgress } from './data'

// ---------- formatting ----------
export function usd(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return '—'
  const a = Math.abs(v)
  const s = v < 0 ? '-' : ''
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
export const pct = (v: number | null | undefined, d = 2) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`)
export const num = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'))
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
          <span className="show-sm">{t}+</span>
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
  const { done, total } = booksProgress
  return (
    <div className="books-progress" aria-hidden>
      <div className="books-progress-text">
        <span>{what}</span>
        <span className="dim">{total ? `${done} of ${total} portfolios` : 'Starting…'}</span>
      </div>
      <div className="books-progress-bar">
        <i style={{ width: `${total ? (done / total) * 100 : 2}%` }} />
      </div>
    </div>
  )
}
/** A whole page while its data loads: title, summary, stat cards and a table, in the page's own layout. */
export function PageLoading({ what = 'Loading', stats = 4, rows = 12, progress }: { what?: string; stats?: number; rows?: number; progress?: ReactNode }) {
  return (
    <div className="page page-loading" role="status" aria-live="polite">
      <span className="sr">{what}…</span>
      <div aria-hidden>
        <span className="skel skel-title" />
        <span className="skel skel-line" />
        <span className="skel skel-line short" />
      </div>
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
      <section className="panel" aria-hidden>
        <header>
          <span className="skel skel-label" />
        </header>
        <div className="body">
          <Loading rows={rows} quiet />
        </div>
      </section>
    </div>
  )
}
/** A load that failed: what happened in plain words, a retry, and a way on; the technical reason is tucked away. */
export function Failed({ error, what = 'this page' }: { error: string; what?: string }) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
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
            ? 'You seem to be offline. Check your connection, then try again.'
            : 'The SEC filing data didn’t arrive. This is usually a brief network hiccup, and trying again normally fixes it.'}
        </p>
        <div className="failed-actions">
          <button className="btn" onClick={() => location.reload()}>
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
export function Panel({ title, right, children, className = '' }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <header>
        <h2>{cap(title)}</h2>
        <span className="right">{right}</span>
      </header>
      <div className="body">{children}</div>
    </section>
  )
}
export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'pos' | 'neg' }) {
  return (
    <div className="stat">
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
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
      {options.map(([k, text]) => {
        // "holdings 14" shows its count as a badge.
        const m = text.match(/^(.*\S)\s+(\d[\d,]*)$/)
        return (
          <button key={k} role="tab" aria-selected={value === k} tabIndex={value === k ? 0 : -1} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
            {cap(m ? m[1] : text)}
            {m && <span className="count">{m[2]}</span>}
          </button>
        )
      })}
    </div>
  )
}

export const CHANGE_LABEL: Record<string, string> = { new: 'New', added: 'Added', trimmed: 'Trimmed', exited: 'Sold out', unchanged: '' }
export function ChangeTag({ change, share_change, prev_shares }: { change: string | null; share_change?: number | null; prev_shares?: number | null }) {
  if (!change || change === 'unchanged') return <span className="dim">·</span>
  const tone = change === 'new' || change === 'added' ? 'pos' : 'neg'
  const r = (change === 'added' || change === 'trimmed') && share_change != null && prev_shares ? (share_change / prev_shares) * 100 : null
  // Past +999% a percentage is noise ("+76194.4%"); show the multiple of the old position instead ("×763").
  const rel = r == null ? '' : Math.abs(r) < 0.05 ? ` ${r > 0 ? '+' : '−'}<0.1%` : r > 999 ? ` ×${Math.round(1 + r / 100).toLocaleString('en-US')}` : ` ${r > 0 ? '+' : ''}${r.toFixed(1)}%`
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
  empty?: string
  rank?: boolean
}) {
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

  if (!rows.length) return <div className="empty dim">{empty}</div>
  return (
    <div className={`grid-outer ${cue ? 'cue' : ''}`}>
    <div className="grid-wrap" ref={wrap}>
      <table className="grid">
        <thead>
          <tr>
            {rank && <th className="num rank">#</th>}
            {cols.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`${c.num ? 'num' : ''} ${c.hideSm ? 'hide-sm' : ''}`}
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
                  <td key={c.key} className={`${c.num ? 'num' : ''} ${c.hideSm ? 'hide-sm' : ''}`}>
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

