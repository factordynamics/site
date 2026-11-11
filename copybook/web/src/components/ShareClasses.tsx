import { money } from '../lib/data'

/** One share class of a multi-class row: the stock pages' build (scripts/stocks.mjs: delta_value, class) or ingest's
 *  classes[] as served in fund books (value_delta, unreliable, held_reason). */
export type ShareClass = {
  ticker: string | null
  cusip: string
  class?: string | null
  shares: number
  prev_shares?: number | null
  change?: string | null
  delta_value?: number | null
  value_delta?: number | null
  unreliable?: string | null
  held_reason?: string | null
}
/** The fields a row carries when it covers several share classes (BRK.A and BRK.B, GOOGL and GOOG). */
export type ClassRow = { classes?: ShareClass[] | null; mixed?: boolean | null }

const held = (c: ShareClass) => c.held_reason ?? (c.unreliable ? 'unreliable' : null)
const delta = (c: ShareClass) => (held(c) ? null : (c.delta_value ?? c.value_delta ?? null))
const label = (c: ShareClass) => c.ticker ?? `CUSIP ${c.cusip}`
const signed = (n: number, f: (v: number) => string) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${f(Math.abs(n))}`
const count = (v: number) => v.toLocaleString('en-US')

/** "mixed (A sold, C bought)": the counted classes by their letter (else ticker); untickered sleeves are left to the lines. */
export function mixedLabel(h: ClassRow) {
  const letter = (c: ShareClass) => c.class ?? /\.([A-Z])$/.exec(c.ticker ?? '')?.[1] ?? c.ticker
  const side = (s: number) => [...new Set((h.classes ?? []).filter((c) => c.ticker && !held(c) && Math.sign(c.shares - (c.prev_shares ?? 0)) === s).map(letter))].join(' and ')
  return `mixed (${side(-1)} sold, ${side(1)} bought)`
}

/** "BRK.A −7,574 sh −$5.66B"; a held class shows what was filed and why, never dollars. */
export function classLine(c: ShareClass) {
  const why = held(c)
  if (why) return `${label(c)} ${count(c.shares)} sh · not counted: ${why.replace(/_/g, ' ').replace(/\bcusip\b/i, 'CUSIP')}`
  const d = c.shares - (c.prev_shares ?? 0)
  const usd = delta(c)
  const lead = c.change === 'new' || c.change === 'exited' ? `${c.change} ` : ''
  if (!d && !lead) return `${label(c)} unchanged`
  return `${label(c)} ${lead}${signed(d, count)} sh${usd != null ? ` ${signed(usd, money)}` : ''}`
}

/** The per-class lines under a row, held classes greyed; nothing when the row has no classes[]. */
export function ClassLines({ h, className = '' }: { h: ClassRow; className?: string }) {
  if (!h.classes?.length) return null
  return (
    <span className={`block text-[12px] leading-snug ${className}`}>
      {h.classes.map((c) => (
        <span key={c.cusip} className={`num block ${held(c) ? 'text-ink-3/70' : 'text-ink-3'}`}>
          {classLine(c)}
        </span>
      ))}
    </span>
  )
}
