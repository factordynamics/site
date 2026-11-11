// Every timed alert this season, for /speed/ and its share card: latency.json's alerts plus the 13F alerts
// whose moves went out late before the Nov 11 fix, which payments lists apart under before_moves_fix.
// Leaving those out would report only the fast ones. Each row is timed from EDGAR acceptance to delivery.
export function seasonGaps(l) {
  const late = Object.entries(l?.before_moves_fix ?? {}).flatMap(([form, b]) =>
    (b?.rows ?? []).map((r) => ({ form, accession: r.accession, accepted_at: r.accepted_at, seconds: r.seconds })),
  )
  const lateIds = new Set(late.map((r) => r.accession))
  return [
    // The site's loadLatency keeps the full log as `log`; latency.json itself has it as `alerts`.
    ...(l?.log ?? l?.alerts ?? []).filter((a) => !lateIds.has(a.accession)).map((a) => ({ form: a.form, accession: a.accession, accepted_at: a.accepted_at, seconds: a.gap_seconds })),
    ...late,
  ]
}

// Payments' method, so the numbers match latency.json's: median is the mean of the middle two for an even
// count, 90th percentile is nearest-rank.
export function gapStats(values) {
  const v = [...values].sort((a, b) => a - b)
  const n = v.length
  if (!n) return { count: 0, median_seconds: null, p90_seconds: null }
  return { count: n, median_seconds: n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2, p90_seconds: v[Math.ceil(0.9 * n) - 1] }
}

// Home's season figure: the median seconds from EDGAR acceptance to each 13F's first alert this season,
// replays and tests left out and a missed filing counted by its eventual delay, as /speed/ counts them.
// Null below five such alerts, so the hero never quotes a median of one or two.
export function firstAlertMedian(l) {
  const s = (l?.log ?? l?.alerts ?? [])
    .filter((a) => a.form?.startsWith('13F') && !a.replay && !a.test && !a.never)
    .map((a) => (a.missed && a.delay_seconds != null ? a.delay_seconds : a.first_alert_at ? (Date.parse(a.first_alert_at) - Date.parse(a.accepted_at)) / 1000 : a.gap_seconds))
    .filter((x) => Number.isFinite(x) && x >= 0)
  return s.length >= 5 ? gapStats(s) : null
}
