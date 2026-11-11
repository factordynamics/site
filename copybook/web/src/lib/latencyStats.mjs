// Every timed alert this season, for /speed/ and its share card: latency.json's alerts plus the 13F alerts
// whose moves went out late before the Nov 11 fix, which payments lists apart under before_moves_fix.
// Leaving those out would report only the fast ones. Each row is timed from EDGAR acceptance to delivery.
// The one computation behind every figure on /speed/, its share card and home's speed line. Each alert row
// once (latency.json alerts[], plus any pre-fix 13F moves row only listed under before_moves_fix), with:
//   seconds   EDGAR acceptance to the alert that counts: a 13F's moves email (the pre-fix ones by their late
//             moves send), a missed filing's eventual delay, null when it never went out;
//   excluded  replays and tests: listed, never counted;
//   missed    filings that should have alerted and didn't when due: listed and counted on their own line;
//   later     a second send of a filing already counted (payments' in_stats false): listed, not counted;
//   counted   everything else with a time: the rows every median, percentile and total is taken over;
//   preFix    13F moves sent late before the Nov 11 fix.
export function speedRows(l) {
  const late = new Map(
    Object.entries(l?.before_moves_fix ?? {}).flatMap(([form, b]) => (b?.rows ?? []).map((r) => [r.accession, { form, ...r }])),
  )
  const log = l?.log ?? l?.alerts ?? []
  const seen = new Set(log.map((a) => a.accession))
  const all = [...log, ...[...late.values()].filter((r) => !seen.has(r.accession)).map((r) => ({ ...r, gap_seconds: r.seconds, sent_at: r.sent_at }))]
  return all.map((a) => {
    const excluded = Boolean(a.replay || a.test)
    const missed = Boolean(a.missed)
    const seconds = a.never ? null : missed && a.delay_seconds != null ? a.delay_seconds : (late.get(a.accession)?.seconds ?? a.gap_seconds ?? null)
    // Payments' in_stats (from Nov 11) marks each accession's first live send; a later send of the same filing
    // is listed but not counted, so no filing counts twice.
    const later = a.in_stats === false && !excluded && !missed
    return { ...a, seconds, excluded, missed, later, preFix: late.has(a.accession) && !missed, counted: !excluded && !missed && !later && Number.isFinite(seconds) }
  })
}

// Every counted alert's time, for the share card (same rows as /speed/'s "All").
export function seasonGaps(l) {
  return speedRows(l)
    .filter((r) => r.counted)
    .map((r) => ({ form: r.form, accession: r.accession, accepted_at: r.accepted_at, seconds: r.seconds }))
}

// Payments' method, so the numbers match latency.json's: median is the mean of the middle two for an even
// count, 90th percentile is nearest-rank.
export function gapStats(values) {
  const v = [...values].sort((a, b) => a - b)
  const n = v.length
  if (!n) return { count: 0, median_seconds: null, p90_seconds: null }
  return { count: n, median_seconds: n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2, p90_seconds: v[Math.ceil(0.9 * n) - 1] }
}

// Home's speed line: the 13F row of /speed/'s table (speedRows' counted 13F rows, by their `seconds`, through
// gapStats), so home and /speed/ always quote the same median. Null below five such alerts.
export function thirteenFStats(l) {
  const s = speedRows(l)
    .filter((r) => r.counted && r.form?.startsWith('13F'))
    .map((r) => r.seconds)
  return s.length >= 5 ? gapStats(s) : null
}
