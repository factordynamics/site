// Fails the build when Copybook's public data already carries a correction in src/corrections.json,
// so a fix made upstream is never applied twice. Run before every build (npm run build does).
import { readFileSync } from 'node:fs'
const BASE = 'https://refcell.github.io/gust/copybook/data/'
const fixes = JSON.parse(readFileSync(new URL('../src/corrections.json', import.meta.url)))
const errors = []
for (const [slug, c] of Object.entries(fixes)) {
  if (slug.startsWith('_')) continue
  const book = await fetch(`${BASE}${slug}.json`).then((r) => r.json())
  const head = JSON.stringify({ ...book, holdings: undefined })
  for (const a of c.prev_add ?? []) if (head.includes(a.source)) errors.push(`${slug}: upstream book already cites ${a.source}; remove that prev_add entry`)
  if (c.prev_add?.length && book.prev_quarter === c.prev_quarter) {
    for (const a of c.prev_add) {
      const h = book.holdings.find((x) => x.cusip === a.cusip && !x.put_call)
      if (h && h.prev_shares != null && h.prev_shares >= a.shares && h.prev_shares === h.shares && h.change === 'unchanged') errors.push(`${slug}: upstream ${a.cusip} is already unchanged; check prev_add`)
    }
  }
  const hist = await fetch(`${BASE}${slug}-history.json`).then((r) => r.json())
  for (const [q, src] of Object.entries(c.history_source ?? {})) {
    const row = hist.history.find((r) => r.quarter === q)
    if (row && JSON.stringify(row).includes(src)) errors.push(`${slug}: upstream history ${q} already cites ${src}; remove that history_add entry`)
    if (row && q === book.prev_quarter && book.prev_total_value != null && Math.abs(row.total_value - book.prev_total_value) < 1) errors.push(`${slug}: upstream history ${q} already equals the combined prior book; remove that history_add entry`)
  }
}
if (errors.length) {
  console.error('corrections already upstream:\n  ' + errors.join('\n  '))
  process.exit(1)
}
console.log(`corrections: ${Object.keys(fixes).filter((k) => !k.startsWith('_')).length} checked, none upstream yet`)
