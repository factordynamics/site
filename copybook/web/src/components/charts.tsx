import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { money, pct } from '../lib/data'

export const SECTOR_COLORS: Record<string, string> = {
  Technology: '#2b44d6',
  Communication: '#6f86f0',
  Consumer: '#c8643b',
  Staples: '#d9a441',
  'Health care': '#2a9d8f',
  Financials: '#0f3d5e',
  Industrials: '#7a8b99',
  Energy: '#8e5b3f',
  Materials: '#8aa05a',
  Utilities: '#5b7f6a',
  'Real estate': '#a77ba8',
  'Funds & ETFs': '#b9b3a6',
  Other: '#d6d2c9',
}
export const sectorColor = (s: string) => SECTOR_COLORS[s] ?? '#d6d2c9'

/* ---------- Horizontal weight bars ---------- */

type BarItem = { key: string; label: string; sub?: string; value: number; weight: number; href?: string; tag?: string; isTicker?: boolean }

export function WeightBars({ items, max, accentFirst = 1, valueLabel = 'pct' }: { items: BarItem[]; max?: number; accentFirst?: number; valueLabel?: 'pct' | 'money' | 'both' }) {
  const m = max ?? Math.max(...items.map((i) => i.weight), 0.0001)
  return (
    <ol className="space-y-2.5">
      {items.map((it, i) => {
        const row = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className={it.isTicker === false ? 'truncate text-[13px] font-medium text-ink' : 'font-mono text-[12.5px] font-medium text-ink'}>{it.label}</span>
                {it.sub && <span className="truncate text-ink-3">{it.sub}</span>}
                {it.tag && <span className="shrink-0 rounded bg-ink/5 px-1 text-[11px] text-ink-2">{it.tag}</span>}
              </span>
              <span className="num shrink-0 font-medium text-ink">
                {valueLabel === 'money' ? money(it.value) : valueLabel === 'both' ? (
                  <>
                    {pct(it.weight)} <span className="font-normal text-ink-3">· {money(it.value)}</span>
                  </>
                ) : pct(it.weight)}
              </span>
            </div>
            <div className="mt-1.5 h-2 rounded-full bg-ink/[0.05]">
              <div
                className="h-2 rounded-full"
                style={{ width: `${Math.max(1.5, (it.weight / m) * 100)}%`, background: i < accentFirst ? 'var(--color-accent)' : '#9aa3b5', animationDelay: `${i * 35}ms` }}
              />
            </div>
          </>
        )
        return (
          <li key={it.key}>
            {it.href ? (
              <Link to={it.href} className="-mx-2 block rounded-lg px-2 py-1 hover:bg-ink/[0.035]">
                {row}
              </Link>
            ) : (
              <div className="py-1">{row}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/* ---------- Donut ---------- */

type Slice = { name: string; value: number; share: number; color?: string }

/** Keeps the n-1 largest named slices and folds the rest, plus unclassified, into one labeled Other slice. */
export function foldSlices(slices: Slice[], n = 8): Slice[] {
  const named = slices.filter((s) => s.name !== 'Other')
  const head = named.slice(0, n - 1)
  const tail = [...named.slice(n - 1), ...slices.filter((s) => s.name === 'Other')]
  if (!tail.length) return head
  return [...head, { name: 'Other', value: tail.reduce((a, s) => a + s.value, 0), share: tail.reduce((a, s) => a + s.share, 0) }]
}

export function Donut({ slices, size = 180, thickness = 26, center }: { slices: Slice[]; size?: number; thickness?: number; center?: { value: string; label: string } }) {
  const [hover, setHover] = useState<number | null>(null)
  const r = size / 2 - thickness / 2 - 2
  const c = 2 * Math.PI * r
  let acc = 0
  const active = hover !== null ? slices[hover] : null
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={slices.map((s) => `${s.name} ${pct(s.share)}`).join(', ')}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {slices.map((s, i) => {
            const len = Math.max(0, s.share * c - (slices.length > 1 ? 2 : 0))
            const el = (
              <circle
                key={s.name}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color ?? sectorColor(s.name)}
                strokeWidth={hover === i ? thickness + 4 : thickness}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-acc}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                style={{ transition: 'stroke-width 120ms' }}
              />
            )
            acc += s.share * c
            return el
          })}
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="num text-[20px] font-semibold tracking-[-0.03em]">{active ? pct(active.share) : center?.value}</span>
        <span className="max-w-[60%] text-[12px] leading-tight text-ink-3">{active ? active.name : center?.label}</span>
      </div>
    </div>
  )
}

export function Legend({ slices, limit = 8, cols = 2 }: { slices: Slice[]; limit?: number; cols?: 1 | 2 }) {
  const shown = slices.slice(0, limit)
  return (
    <ul className={`grid min-w-0 flex-1 grid-cols-1 gap-x-6 gap-y-2 text-[13px] ${cols === 2 ? 'sm:grid-cols-2' : ''}`}>
      {shown.map((s) => (
        <li key={s.name} className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: s.color ?? sectorColor(s.name) }} />
            <span className="whitespace-nowrap text-ink-2">{s.name}</span>
          </span>
          <span className="num font-medium">{pct(s.share)}</span>
        </li>
      ))}
    </ul>
  )
}

/* ---------- Stacked 100% bar ---------- */

export function StackBar({ slices, height = 10 }: { slices: Slice[]; height?: number }) {
  return (
    <div className="flex w-full gap-[2px] overflow-hidden rounded-full" style={{ height }} role="img" aria-label={slices.map((s) => `${s.name} ${pct(s.share)}`).join(', ')}>
      {slices.filter((s) => s.share > 0.002).map((s) => (
        <div key={s.name} title={`${s.name} ${pct(s.share)}`} style={{ width: `${s.share * 100}%`, background: s.color ?? sectorColor(s.name) }} />
      ))}
    </div>
  )
}

/* ---------- Treemap (squarified) ---------- */

type TItem = { key: string; label: string; sub?: string; value: number; weight: number; color: string; isTicker?: boolean }
type Rect = { x: number; y: number; w: number; h: number; item: TItem }

function squarify(items: TItem[], x: number, y: number, w: number, h: number): Rect[] {
  const out: Rect[] = []
  const total = items.reduce((s, i) => s + i.value, 0)
  if (!total) return out
  const scale = (w * h) / total
  const areas = items.map((i) => ({ item: i, a: i.value * scale }))
  let row: typeof areas = []
  let rest = areas.slice()
  const worst = (r: typeof areas, len: number) => {
    const s = r.reduce((t, i) => t + i.a, 0)
    const mx = Math.max(...r.map((i) => i.a))
    const mn = Math.min(...r.map((i) => i.a))
    return Math.max((len * len * mx) / (s * s), (s * s) / (len * len * mn))
  }
  while (rest.length) {
    const len = Math.min(w, h)
    const next = rest[0]
    if (!row.length || worst([...row, next], len) <= worst(row, len)) {
      row.push(next)
      rest = rest.slice(1)
      if (rest.length) continue
    }
    const s = row.reduce((t, i) => t + i.a, 0)
    if (w >= h) {
      const cw = s / h
      let cy = y
      for (const r of row) {
        const ch = r.a / cw
        out.push({ x, y: cy, w: cw, h: ch, item: r.item })
        cy += ch
      }
      x += cw
      w -= cw
    } else {
      const ch = s / w
      let cx = x
      for (const r of row) {
        const cw = r.a / ch
        out.push({ x: cx, y, w: cw, h: ch, item: r.item })
        cx += cw
      }
      y += ch
      h -= ch
    }
    row = []
  }
  return out
}

export function Treemap({ items, height = 320, ratio = 1.8 }: { items: TItem[]; height?: number; ratio?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [px, setPx] = useState(800)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setPx(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Lay out in the container's real aspect ratio so tiles stay square-ish on phones.
  const r = px / height || ratio
  const rects = useMemo(() => squarify(items.filter((i) => i.value > 0), 0, 0, 100 * r, 100), [items, r])
  return (
    <div ref={ref} className="relative w-full overflow-hidden rounded-xl" style={{ height }} role="img" aria-label={items.slice(0, 10).map((i) => `${i.label} ${pct(i.weight)}`).join(', ')}>
      {rects.map(({ x, y, w, h, item }) => {
        const wpx = (w / (100 * r)) * px
        const hpx = (h / 100) * height
        const big = wpx > 120 && hpx > 76
        // Names without a ticker need more room than a ticker; never show a truncated stub.
        const label = fitLabel(item.label, wpx - 18, big ? 8.6 : 6.8, item.isTicker !== false)
        const mid = Boolean(label) && wpx > 54 && hpx > 40
        const light = isLight(item.color)
        return (
          <div
            key={item.key}
            className={`absolute overflow-hidden border border-white/70 p-2 ${light ? 'text-ink' : 'text-white'}`}
            style={{ left: `${(x / (100 * r)) * 100}%`, top: `${y}%`, width: `${(w / (100 * r)) * 100}%`, height: `${h}%`, background: item.color }}
            title={`${item.label}${item.sub ? ` · ${item.sub}` : ''} · ${pct(item.weight)} · ${money(item.value)}`}
          >
            {mid && (
              <div className="leading-tight">
                <div className={`whitespace-nowrap font-semibold ${item.isTicker === false ? '' : 'font-mono'} ${big ? 'text-[15px]' : 'text-[11.5px]'}`}>{label}</div>
                <div className={`num ${big ? 'text-[13px]' : 'text-[11px]'}`}>{pct(item.weight)}</div>
                {big && item.sub && <div className="mt-0.5 truncate text-[12px]">{item.sub}</div>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Whole words that fit the tile, or '' when not even one does. Tickers are never shortened. */
function fitLabel(text: string, room: number, charPx: number, ticker: boolean) {
  if (text.length * charPx <= room) return text
  if (ticker) return ''
  const words = text.split(' ')
  while (words.length > 1) {
    words.pop()
    const t = words.join(' ')
    if (t.length * charPx <= room) return t
  }
  return ''
}

/** True when white text would fail 4.5:1 on this fill. */
function isLight(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return 1.05 / (L + 0.05) < 4.5
}

/** Shades of the accent by rank: the largest positions read darkest. */
export function rankColor(i: number) {
  const ramp = ['#1d2f9c', '#2b44d6', '#3e5be6', '#5873ea', '#7189ee', '#8a9ff1', '#a1b2f3', '#b6c3f5']
  return ramp[Math.min(i, ramp.length - 1)]
}

/* ---------- Diverging change bars (QoQ) ---------- */

export function ChangeBars({ items, names = false }: { items: { key: string; label: string; sub?: string; delta: number; tag?: string }[]; names?: boolean }) {
  const m = Math.max(...items.map((i) => Math.abs(i.delta)), 1)
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.key} className={`grid ${names ? 'grid-cols-[minmax(0,7.5rem)_1fr_1fr_4.5rem] sm:grid-cols-[minmax(0,16rem)_1fr_1fr_5.5rem]' : 'grid-cols-[minmax(0,9rem)_1fr_1fr_5.5rem]'} items-center gap-2 text-[13px]`}>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={names ? 'truncate font-medium' : 'font-mono text-[12.5px] font-medium'} title={names ? it.label : undefined}>{it.label}</span>
            {it.tag && <span className="min-w-0 truncate text-[11.5px] text-ink-3 sm:shrink-0" title={it.tag}>{it.tag}</span>}
          </span>
          <div className="flex h-2.5 justify-end">
            {it.delta < 0 && <div className="h-2.5 rounded-l-full bg-down/80" style={{ width: `${(Math.abs(it.delta) / m) * 100}%`, transformOrigin: 'right' }} />}
          </div>
          <div className="flex h-2.5 border-l border-line-2">
            {it.delta > 0 && <div className="h-2.5 rounded-r-full bg-up/80" style={{ width: `${(it.delta / m) * 100}%` }} />}
          </div>
          <span className={`num text-right font-medium ${it.delta >= 0 ? 'text-up' : 'text-down'}`}>
            {it.delta >= 0 ? '+' : '−'}
            {money(Math.abs(it.delta))}
          </span>
        </li>
      ))}
    </ul>
  )
}
