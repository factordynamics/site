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
const funds = [], pending = []
for (const f of universe.funds) {
  const m = byCik.get(f.cik)
  ;(m?.ok ? funds : pending).push(row(f, m))
}
process.stdout.write(
  JSON.stringify({ generated_at: new Date().toISOString(), period: universe.period, source: universe.source, rule: universe.rule, screened: universe.screened, funds, pending, near_misses: universe.near_misses.slice(0, 25).map((f) => ({ ...row(f, byCik.get(f.cik)), fails: f.fails })) }, null, 1) + '\n',
)
