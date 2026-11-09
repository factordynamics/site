// EDGAR's business days: weekdays other than US federal holidays, when EDGAR doesn't accept filings
// as of that day. A holiday on a Saturday is observed on the Friday, one on a Sunday on the Monday.
// Shared by the build (the 13F deadline in scripts/stocks.mjs) and the /season/ day chart.

const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10)
// The nth given weekday of a month (n = -1 for the last one).
function nth(y, m, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay()
    return iso(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7)
  }
  const lastDay = new Date(Date.UTC(y, m + 1, 0))
  return iso(y, m, lastDay.getUTCDate() - ((lastDay.getUTCDay() - weekday + 7) % 7))
}
function observed(y, m, d) {
  const w = new Date(Date.UTC(y, m, d)).getUTCDay()
  return iso(y, m, d + (w === 6 ? -1 : w === 0 ? 1 : 0))
}

const cache = new Map()
/** Federal holidays (as observed) in a year, as YYYY-MM-DD. */
export function holidays(y) {
  if (!cache.has(y))
    cache.set(
      y,
      new Set([
        observed(y, 0, 1), // New Year's Day
        nth(y, 0, 1, 3), // Martin Luther King Jr. Day
        nth(y, 1, 1, 3), // Washington's Birthday
        nth(y, 4, 1, -1), // Memorial Day
        observed(y, 5, 19), // Juneteenth
        observed(y, 6, 4), // Independence Day
        nth(y, 8, 1, 1), // Labor Day
        nth(y, 9, 1, 2), // Columbus Day
        observed(y, 10, 11), // Veterans Day
        nth(y, 10, 4, 4), // Thanksgiving
        observed(y, 11, 25), // Christmas
        observed(y + 1, 0, 1), // next New Year's Day, observed on Dec 31 when Jan 1 is a Saturday
      ]),
    )
  return cache.get(y)
}

/** True when EDGAR is open on that date (YYYY-MM-DD). */
export function isEdgarDay(day) {
  const w = new Date(`${day}T12:00:00Z`).getUTCDay()
  return w !== 0 && w !== 6 && !holidays(+day.slice(0, 4)).has(day)
}

/** "Mon Nov 16", or "today" / "tomorrow" when `today` (New York's date, YYYY-MM-DD) makes that true.
 *  A bare weekday ("expected Mon") reads as this week's, so the date always goes with it. */
export function dayName(iso, today) {
  if (today && iso === today) return 'today'
  if (today) {
    const t = new Date(`${today}T12:00:00Z`)
    t.setUTCDate(t.getUTCDate() + 1)
    if (iso === t.toISOString().slice(0, 10)) return 'tomorrow'
  }
  const d = new Date(`${iso}T12:00:00Z`)
  const part = (o) => d.toLocaleDateString('en-US', { ...o, timeZone: 'UTC' })
  return `${part({ weekday: 'short' })} ${part({ month: 'short' })} ${part({ day: 'numeric' })}`
}
