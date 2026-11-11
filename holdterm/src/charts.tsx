import { useEffect, useRef, useState, type ReactNode } from 'react'
import { A, usd, usdAxis, signedUsd } from './lib'

/** Measures a container so SVG text stays at real pixel sizes at every width (no viewBox scaling). */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}
function niceStep(raw: number) {
  if (raw <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p
}

/** Portfolio value by quarter: columns on a labelled dollar axis, the quarter and its change from the quarter
 * before under each, and a hover/focus readout. Axis titles say what both axes measure. */
export function ValueHistory({ data, title }: { data: { label: string; value: number }[]; title: string }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 228
  const pad = { l: 62, r: 6, t: 22, b: 62 }
  const max = Math.max(...data.map((d) => d.value), 1)
  const step = niceStep(max / 4)
  const iw = Math.max(0, W - pad.l - pad.r)
  const ih = H - pad.t - pad.b
  // Leave room above the tallest column for its value label, so it never sits on the top gridline and its label.
  let top = Math.ceil(max / step) * step
  if ((1 - max / top) * ih < 18) top += step
  const bw = data.length ? iw / data.length : 0
  const ticks: number[] = []
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v)
  const showLabels = bw >= 44
  const sel = hover ?? data.length - 1
  const d0 = data[sel]
  const p0 = data[sel - 1]?.value
  return (
    <div ref={ref} className="chart-box value-chart">
      {d0 && (
        <p className="chart-readout" aria-live="polite">
          <b>{d0.label.replace(/'(\d\d)$/, '20$1')}</b>: {usd(d0.value)}
          {p0 ? (
            <span className={d0.value >= p0 ? 'pos' : 'neg'}>
              {' '}
              ({d0.value >= p0 ? 'up' : 'down'} {Math.abs((d0.value / p0 - 1) * 100).toFixed(1)}% from the quarter before)
            </span>
          ) : null}
        </p>
      )}
      {W > 0 && (
        <svg width={W} height={H} role="img" aria-label={title}>
          <title>{title}</title>
          <text x={12} y={pad.t + ih / 2} textAnchor="middle" transform={`rotate(-90 12 ${pad.t + ih / 2})`} className="axis-title">
            Portfolio value
          </text>
          {ticks.map((v) => {
            const y = Math.round(pad.t + ih - (v / top) * ih) + 0.5
            return (
              <g key={v}>
                <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className={v === 0 ? 'gridline strong' : 'gridline'} />
                <text x={pad.l - 8} y={y + 4} textAnchor="end" className="axis">
                  {usdAxis(v)}
                </text>
              </g>
            )
          })}
          {data.map((d, i) => {
            const h = (d.value / top) * ih
            const x = pad.l + i * bw + bw * 0.18
            const cw = bw * 0.64
            const prev = data[i - 1]?.value
            const delta = prev ? d.value / prev - 1 : null
            const on = i === sel
            return (
              <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${d.label}: ${usd(d.value)}${delta != null ? `, ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta * 100).toFixed(1)}%` : ''}`}>
                <rect x={pad.l + i * bw} y={pad.t} width={bw} height={ih} fill="transparent" />
                <rect x={x} y={pad.t + ih - h} width={cw} height={h} rx={3} className={on ? 'col on' : 'col'} />
                {(showLabels || on) && (
                  <text x={x + cw / 2} y={pad.t + ih - h - 6} textAnchor="middle" className="vlabel">
                    {usd(d.value, d.value >= 1e11 ? 0 : 1)}
                  </text>
                )}
                <text x={x + cw / 2} y={pad.t + ih + 17} textAnchor="middle" className="axis">
                  {bw < 52 ? d.label.replace(/^Q(\d) '(\d\d)$/, '$1Q$2') : d.label}
                </text>
                {delta != null && (showLabels || on) && (
                  <text x={x + cw / 2} y={pad.t + ih + 33} textAnchor="middle" className={`axis ${delta >= 0 ? 'pos' : 'neg'}`}>
                    {delta >= 0 ? '+' : '−'}
                    {Math.abs(delta * 100).toFixed(0)}%
                  </text>
                )}
              </g>
            )
          })}
          <text x={pad.l + iw / 2} y={H - 4} textAnchor="middle" className="axis-title">
            Quarter, with the change from the quarter before
          </text>
        </svg>
      )}
    </div>
  )
}

/** Horizontal bars, diverging around zero when values are signed. Each row can link. */
export function HBars({ rows, fmt = signedUsd, title, labelWidth = 150, inline = false }: { rows: { label: ReactNode; sub?: ReactNode; value: number; href?: string | null; key: string }[]; fmt?: (v: number) => string; title: string; labelWidth?: number; inline?: boolean }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1)
  const signed = rows.some((r) => r.value < 0) && rows.some((r) => r.value > 0)
  return (
    <ul className={`hbars ${inline ? 'inline' : ''}`} aria-label={title} style={{ ['--lw' as string]: `${labelWidth}px` }}>
      {rows.map((r) => {
        const w = (Math.abs(r.value) / max) * (signed ? 50 : 100)
        const inner = (
          <>
            <span className="hb-label">
              {r.label}
              {r.sub && <span className="hb-sub">{r.sub}</span>}
            </span>
            <span className="hb-track">
              {signed && <i className="hb-zero" />}
              <i className={`hb-fill ${!signed ? 'acc' : r.value >= 0 ? 'pos' : 'neg'}`} style={signed ? (r.value >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }) : { left: 0, width: `${w}%` }} />
            </span>
            <span className={`hb-val ${!signed ? '' : r.value > 0 ? 'pos' : r.value < 0 ? 'neg' : 'dim'}`}>{fmt(r.value)}</span>
          </>
        )
        return <li key={r.key}>{r.href ? <A to={r.href} className="hb-row">{inner}</A> : <div className="hb-row">{inner}</div>}</li>
      })}
    </ul>
  )
}

/** Filing season: one tick per fund on a date axis from quarter end to the 45-day deadline; unfiled funds listed as due. */
export function SeasonChart({ start, deadline, filed, title }: { start: string; deadline: string; filed: { key: string; date: string; label: string }[]; title: string }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const t0 = Date.parse(start)
  const t1 = Date.parse(deadline)
  const now = Date.now()
  const H = 86
  const pad = { l: 8, r: 8 }
  const x = (t: number) => pad.l + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (W - pad.l - pad.r)
  // Stack ticks that land on the same day.
  const days = new Map<string, number>()
  const marks = filed.map((f) => {
    const n = days.get(f.date) ?? 0
    days.set(f.date, n + 1)
    return { ...f, n }
  })
  const months: number[] = []
  for (let d = new Date(t0); d.getTime() <= t1; d.setUTCDate(d.getUTCDate() + 1)) if (d.getTime() === t0 || (d.getUTCDate() === 1 && d.getTime() - t0 > 7 * 86_400_000 && t1 - d.getTime() > 9 * 86_400_000)) months.push(d.getTime())
  return (
    <div ref={ref} className="chart-box">
      {W > 0 && (
        <svg width={W} height={H} role="img" aria-label={title}>
          <title>{title}</title>
          <line x1={pad.l} x2={W - pad.r} y1={62.5} y2={62.5} className="gridline strong" />
          {now < t1 && <rect x={x(now)} y={4} width={Math.max(0, x(t1) - x(now))} height={58} className="future" />}
          {months.map((t) => (
            <g key={t}>
              <line x1={Math.round(x(t)) + 0.5} x2={Math.round(x(t)) + 0.5} y1={62} y2={67} className="gridline strong" />
              <text x={x(t)} y={80} textAnchor={t === t0 ? 'start' : 'middle'} className="axis">
                {new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
              </text>
            </g>
          ))}
          <text x={W - pad.r} y={80} textAnchor="end" className="axis acc">
            deadline {new Date(t1).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
          </text>
          {now < t1 && (
            <line x1={Math.round(x(now)) + 0.5} x2={Math.round(x(now)) + 0.5} y1={2} y2={66} className="today" />
          )}
          {marks.map((m) => (
            <rect key={m.key} x={x(Date.parse(m.date)) - 3} y={54 - m.n * 10} width={6} height={8} rx={1} className="tick">
              <title>{`${m.label} · filed ${m.date}`}</title>
            </rect>
          ))}
        </svg>
      )}
    </div>
  )
}
