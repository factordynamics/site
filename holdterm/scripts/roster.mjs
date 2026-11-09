// Builds Holdterm's roster: the funds that pass the universe screen (scripts/universe.json, made by
// scripts/screen.py from SEC's quarterly Form 13F data sets), matched by CIK to the books in Copybook's
// public data. Funds that pass but have no book there yet are listed as pending.
// Rerun after each data set release and whenever new books are published, then commit the output.
// Usage: node scripts/roster.mjs [data base URL] > src/roster.json
import { readFileSync } from 'node:fs'
const BASE = process.argv[2] || 'https://refcell.github.io/gust/copybook/data/'
const universe = JSON.parse(readFileSync(new URL('./universe.json', import.meta.url)))
const index = await fetch(BASE + 'index.json').then((r) => r.json())
const cik = (c) => String(c).padStart(10, '0')
const byCik = new Map()
for (const m of index.managers) if (m.status !== 'reported_by_other') byCik.set(cik(m.cik), m)
// A filer whose 13F is now filed by another entity: its book carries the quarter-on-quarter changes.
const predecessor = new Map()
for (const m of index.managers) if (m.status === 'reported_by_other' && m.reported_by?.slug) predecessor.set(m.reported_by.slug, m)
const row = (f, m) => {
  const pre = m && predecessor.get(m.slug)
  return { cik: f.cik, slug: m ? (pre && pre.quarter === m.quarter ? pre.slug : m.slug) : null, filer_slug: m?.slug ?? null, firm: f.name, value: f.value, positions: f.positions, top10: f.top10, turnover: f.turnover, predecessor: pre?.slug ?? null }
}
// Data checks on the published book itself, after the screen: a fund that fails one is held back until
// the data is fixed (or, for the share-class test, until it passes).
//  - the book's total must agree with the 13F cover page (within 1.5x),
//  - at most 25% of the book in principal amounts (notes and bonds): a bond book is not a stock portfolio,
//  - the largest position, share classes combined (BH + BH.A), at most the screen's max_weight,
//  - the prior quarter's comparison uses its latest full restatement (no later amendment marked superseded).
const INCUMBENT = new Set(JSON.parse(readFileSync(new URL('./incumbents.json', import.meta.url))).ciks.map(cik))
async function dataChecks(slug, ck) {
  const b = await fetch(`${BASE}${slug}.json`).then((r) => r.json())
  const fails = []
  const total = b.total_value || 0
  if (b.cover_total && (total > 1.5 * b.cover_total || total < b.cover_total / 1.5)) fails.push(`book $${(total / 1e9).toFixed(2)}B disagrees with its 13F cover page ($${(b.cover_total / 1e9).toFixed(2)}B)`)
  if (total && (b.prn_value || 0) / total > 0.25) fails.push(`${Math.round(((b.prn_value || 0) / total) * 100)}% of the 13F is notes and bonds`)
  const by = new Map()
  for (const h of b.holdings) if (!h.put_call && h.value > 0 && h.shares_type !== 'PRN') by.set(h.cusip.slice(0, 6), (by.get(h.cusip.slice(0, 6)) ?? 0) + h.value)
  const eq = [...by.values()].reduce((x, v) => x + v, 0)
  const top = eq ? Math.max(...by.values()) / eq : 0
  if (top > universe.rule.max_top1 * (INCUMBENT.has(ck) ? 1 + universe.rule.incumbent_buffer : 1)) fails.push(`largest position ${Math.round(top * 100)}% with share classes combined`)
  if (b.prev_quarter) {
    const h = await fetch(`${BASE}${slug}-history.json`).then((r) => (r.ok ? r.json() : { history: [] }))
    const prev = h.history.find((r) => r.quarter === b.prev_quarter)
    const base = prev?.filings?.find((f) => f.role === 'base')
    if (base && prev.filings.some((f) => f.role === 'superseded' && f.accepted_at > base.accepted_at && /NEW HOLDINGS/i.test(f.amendment_type ?? ''))) fails.push(`${b.prev_quarter} compares against an amendment that a later full restatement replaced`)
  }
  return fails
}
const funds = [], pending = [], held = []
for (const f of universe.funds) {
  const m = byCik.get(f.cik)
  if (!m?.ok) {
    pending.push(row(f, m))
    continue
  }
  const r = row(f, m)
  const fails = await dataChecks(r.filer_slug, cik(f.cik))
  if (fails.length) held.push({ ...r, fails })
  else funds.push(r)
}
for (const h of held) console.error(`held: ${h.firm}: ${h.fails.join('; ')}`)
process.stdout.write(
  JSON.stringify({ generated_at: new Date().toISOString(), period: universe.period, source: universe.source, rule: universe.rule, screened: universe.screened, funds, pending, held, near_misses: universe.near_misses.slice(0, 25).map((f) => ({ ...row(f, byCik.get(f.cik)), fails: f.fails })) }, null, 1) + '\n',
)
