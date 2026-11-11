import { edgarClosed, dayET, loadExpected, shortDay } from '../lib/stocks'
import { useAsync } from '../lib/data'

const clock = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`
const half = (m: number) => (m >= 720 ? 'pm' : 'am')
/** "10:15–11:17 am" from New York minutes after midnight. */
const span = ([a, b]: [number, number]) => (a === b ? `around ${clock(a)} ${half(a)}` : half(a) === half(b) ? `${clock(a)}–${clock(b)} ${half(b)}` : `${clock(a)} ${half(a)}–${clock(b)} ${half(b)}`)

/** On a day EDGAR is closed (a federal holiday on a weekday): when filings resume and who files first.
 *  Gone by itself when EDGAR reopens. Home, /season/ and fund pages. */
export function EdgarClosed({ className = '' }: { className?: string }) {
  const c = edgarClosed()
  const soon = useAsync(() => (c ? loadExpected() : Promise.resolve(null)), [Boolean(c)])
  if (!c) return null
  const first = soon.data?.expected.filter((x) => x.expected_date === c.resume).sort((a, b) => b.total_value - a.total_value)[0]
  const today = dayET() === c.day
  return (
    <p role="note" className={`rounded-xl bg-[#f6ead2] px-4 py-2.5 text-[14px] leading-snug text-[#5c3f0b] ${className}`}>
      <span className="font-medium">{today ? `EDGAR is closed today (${c.name}).` : `EDGAR reopens after ${c.name}.`}</span> Filings resume {today ? shortDay(c.resume) : 'today'} at 6:00 am ET
      {first ? `; ${first.manager} usually files ${span(first.time_range ?? [first.time_et, first.time_et])}.` : '.'}
    </p>
  )
}
