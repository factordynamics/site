import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

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
export const date = (d: string | null | undefined) => (d ? `${d.slice(8, 10)} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}` : '—')
export const daysAgo = (d: string) => Math.round((Date.now() - Date.parse(d + 'T12:00:00Z')) / 86_400_000)

// ---------- routing (history API, no dependency) ----------
const listeners = new Set<() => void>()
export function navigate(to: string) {
  if (to === location.pathname + location.search) return
  history.pushState(null, '', to)
  window.scrollTo(0, 0)
  listeners.forEach((l) => l())
}
window.addEventListener('popstate', () => listeners.forEach((l) => l()))
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
export function Tick({ t, name }: { t: string | null; name?: string }) {
  if (!t) return <span className="dim" title={name}>—</span>
  return (
    <A to={stockHref(t)} className="tk" title={name}>
      {t}
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
export function Loading({ what = 'loading' }: { what?: string }) {
  return (
    <div className="loading">
      <span className="dim">{what}</span>
      <span className="cursor" />
    </div>
  )
}
export function Failed({ error }: { error: string }) {
  return <div className="loading neg">ERR {error}</div>
}

// ---------- layout ----------
export function Panel({ title, right, children, className = '', keys }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string; keys?: string }) {
  return (
    <section className={`panel ${className}`}>
      <header>
        <h2>{title}</h2>
        <span className="right">
          {right}
          {keys && <kbd>{keys}</kbd>}
        </span>
      </header>
      <div className="body">{children}</div>
    </section>
  )
}
export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'pos' | 'neg' }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ''}`}>{value}</div>
      {sub != null && <div className="sub">{sub}</div>}
    </div>
  )
}
export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input,textarea,select')) return
      const i = Number(e.key) - 1
      if (i >= 0 && i < options.length) onChange(options[i][0])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [options, onChange])
  return (
    <div className="tabs" role="tablist">
      {options.map(([k, label], i) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          <span className="dim">{i + 1}</span>
          {label}
        </button>
      ))}
    </div>
  )
}

export const CHANGE_LABEL: Record<string, string> = { new: 'NEW', added: 'ADD', trimmed: 'TRIM', exited: 'SOLD', unchanged: '' }
export function ChangeTag({ change, share_change, prev_shares }: { change: string | null; share_change?: number | null; prev_shares?: number | null }) {
  if (!change || change === 'unchanged') return <span className="dim">·</span>
  const tone = change === 'new' || change === 'added' ? 'pos' : 'neg'
  const rel = (change === 'added' || change === 'trimmed') && share_change != null && prev_shares ? ` ${share_change > 0 ? '+' : ''}${((share_change / prev_shares) * 100).toFixed(1)}%` : ''
  return (
    <span className={`tag ${tone}`}>
      {CHANGE_LABEL[change]}
      {rel}
    </span>
  )
}

// ---------- data grid: sortable, j/k + Enter keyboard navigation ----------
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
let activeGrid: symbol | null = null
export function Grid<R>({
  cols,
  rows,
  href,
  initial,
  limit,
  rowClass,
  empty = 'no rows',
  keyboard = false,
  rank = false,
}: {
  cols: Col<R>[]
  rows: R[]
  href?: (r: R) => string | null
  initial?: [string, 'asc' | 'desc']
  limit?: number
  rowClass?: (r: R) => string
  empty?: string
  keyboard?: boolean
  rank?: boolean
}) {
  const [sort, setSort] = useState<[string, 'asc' | 'desc'] | undefined>(initial)
  const [cur, setCur] = useState(-1)
  const [shown, setShown] = useState(limit ?? Infinity)
  const id = useRef(Symbol('grid'))
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

  useEffect(() => {
    if (!keyboard) return
    activeGrid = id.current
    const onKey = (e: KeyboardEvent) => {
      if (activeGrid !== id.current || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t.closest('input,textarea,select')) return
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault()
        setCur((c) => Math.max(0, Math.min(visible.length - 1, c + (e.key === 'j' ? 1 : -1))))
      } else if (e.key === 'Enter' && cur >= 0 && href) {
        const to = href(visible[cur])
        if (to) navigate(to)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboard, visible, cur, href])
  useEffect(() => {
    if (cur < 0) return
    body.current?.children[cur]?.scrollIntoView({ block: 'nearest' })
  }, [cur])

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
                    {c.label}
                    {sort?.[0] === c.key ? <span className="arrow" aria-hidden>{sort[1] === 'desc' ? '▼' : '▲'}</span> : null}
                  </button>
                ) : (
                  c.label
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
                className={`${i === cur ? 'cur' : ''} ${to ? 'link' : ''} ${rowClass?.(r) ?? ''}`}
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
          show all {sorted.length} rows ↓
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

