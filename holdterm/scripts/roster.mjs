// Builds Holdterm's fund roster from an objective rule applied to every curated 13F filer in
// Copybook's public data. Rerun after each 13F deadline (quarterly reconstitution) and commit the output.
// Usage: node scripts/roster.mjs [data base URL] > src/roster.json
const BASE = process.argv[2] || 'https://refcell.github.io/gust/copybook/data/'
export const RULE = {
  min_value: 1e9, // 13F book of at least $1B
  max_positions: 100, // a stock picker's book, not an index
  min_quarters: 8, // two years of 13F filings (a predecessor filer counts)
  min_top10: 0.5, // top 10 positions are at least half the book
  max_turnover: 0.25, // latest quarter: (bought + sold) / 2 / average book
  // Independent investment managers only: no banks, brokers, insurers, pensions, endowments,
  // foundations, sovereign funds or private-equity sponsors (their 13Fs are mostly strategic stakes).
  excluded_types: 'bank|broker|insurer|pension|endowment|foundation|sovereign|private equity',
}
const EXCLUDE_NAME = /\b(bank|banco|securities|insurance|assurance|life|financial (inc|group|corp)|national financial|pension|retirement|teachers|university|regents|college|endowment|management co inc|foundation|trust (ltd|co)|wellcome|permanent (fund|capital)|sovereign|investment board|morgan stanley|mizuho|nomura|carlyle|silver lake|thoma bravo|apollo|blackstone|kkr|brookfield|tpg|vista equity|warburg)\b/i
const EXCLUDE_CIK = new Set([]) // filer CIKs whose type the name doesn't reveal
const get = (f) => fetch(BASE + f).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${f}`))))
const index = await get('index.json')
const all = index.managers
// A filer whose 13F is now filed by another entity hands its history to the successor.
const predecessor = new Map()
for (const m of all) if (m.status === 'reported_by_other' && m.reported_by?.slug) predecessor.set(m.reported_by.slug, m)
const quarters = (m) => new Set([...(m.history_quarters ?? []), ...(predecessor.get(m.slug)?.history_quarters ?? [])]).size
const cands = all.filter((m) => !EXCLUDE_NAME.test(m.name) && !EXCLUDE_CIK.has(m.cik) && m.ok && m.status === 'current' && m.total_value >= RULE.min_value && m.position_count <= RULE.max_positions && quarters(m) >= RULE.min_quarters)
const rows = []
for (const m of cands) {
  // A successor's first full filing reads as all-new; the predecessor's book for the same quarter
  // carries the real quarter-on-quarter changes.
  const pre = predecessor.get(m.slug)
  const bookSlug = pre && pre.quarter === m.quarter ? pre.slug : m.slug
  const b = await get(`${bookSlug}.json`)
  const live = b.holdings.filter((h) => h.value > 0)
  const top10 = [...live].sort((a, c) => c.weight - a.weight).slice(0, 10).reduce((s, h) => s + h.weight, 0)
  const traded = b.holdings.reduce((s, h) => s + Math.abs(h.value_delta ?? 0), 0)
  const avg = ((b.total_value || 0) + (b.prev_total_value || b.total_value || 0)) / 2
  const turnover = b.prev_total_value ? traded / 2 / avg : null
  const ok = top10 >= RULE.min_top10 && turnover != null && turnover <= RULE.max_turnover
  rows.push({ slug: bookSlug, filer_slug: m.slug, cik: m.cik, firm: m.name, value: m.total_value, positions: m.position_count, quarters: quarters(m), top10: +top10.toFixed(4), turnover: turnover == null ? null : +turnover.toFixed(4), predecessor: predecessor.get(m.slug)?.slug ?? null, in: ok })
}
rows.sort((a, b) => b.value - a.value)
process.stdout.write(
  JSON.stringify({ generated_at: new Date().toISOString(), source: BASE, rule: RULE, universe: all.length, screened: cands.length, funds: rows.filter((r) => r.in).map(({ in: _, ...r }) => r), near_misses: rows.filter((r) => !r.in).map(({ in: _, ...r }) => r) }, null, 1) + '\n',
)
