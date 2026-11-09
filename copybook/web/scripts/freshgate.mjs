// Refuse to publish data older than what's live. The build reads the data repo's head, and a late push
// there can carry an older snapshot (Nov 9: a 00:50 UTC snapshot pushed after the 01:01 one), which made
// /season/'s "updated" time go backwards. Compares each built file's generated_at with the live copy;
// FORCE_DATA=1 publishes anyway. A file that isn't live yet, or can't be read, doesn't block.
// Usage: node scripts/freshgate.mjs <out dir>
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] || 'dist'
const SITE = process.env.VITE_SITE || 'https://copybook.factordynamics.com/'
const FILES = ['d/coverage.json', 'd/season.json', 'd/flow.json', 'd/stocks.json', 'd/splits.json']
const older = []
for (const f of FILES) {
  const p = join(out, f)
  if (!existsSync(p)) continue
  const built = JSON.parse(readFileSync(p, 'utf8')).generated_at
  const live = await fetch(`${SITE}${f}?t=${Date.now()}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => d?.generated_at ?? null)
    .catch(() => null)
  console.log(`${f}: built ${built}, live ${live ?? 'n/a'}`)
  if (built && live && Date.parse(built) < Date.parse(live)) older.push(`${f} (built ${built} < live ${live})`)
}
if (older.length && process.env.FORCE_DATA !== '1') {
  console.error(`::error::Older data than the live site: ${older.join('; ')}. Not publishing; rerun with force_data to override.`)
  process.exit(1)
}
if (older.length) console.log(`::warning::Publishing older data (forced): ${older.join('; ')}`)
