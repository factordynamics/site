import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { addLine, classPosition, newPosition, positionFlags, positionMove } from './position.mjs'

const line = (o) => ({ shares: 0, value: 0, prev_shares: 0, prev_value: 0, ...o })

test('a line ingest flags suspect_units is no trade: change unknown, delta_value null', () => {
  // Guardcap BKNG 2026Q3: 1,304 pre-split shares at ~$5,120 against a split-adjusted prior of 646,216 shares.
  const guardcap = addLine(newPosition(true), line({ shares: 1304, value: 6676571, prev_shares: 646216, prev_value: 121636487, suspect_units: true, suspect_reason: 'cross_filer' }))
  assert.deepEqual(positionMove(guardcap), { change: 'unknown', delta_value: null })
  assert.deepEqual(positionFlags(guardcap), { suspect_units: true, suspect_reason: 'cross_filer', unreliable: 'both' })
  // With ingest's side: the filed values are consistent, the share count is off: value_change, no trade.
  const g2 = addLine(newPosition(true), line({ shares: 1304, value: 6676571, prev_shares: 646216, prev_value: 121636487, suspect_units: true, suspect_reason: 'cross_filer', unreliable: 'shares' }))
  assert.deepEqual(positionMove(g2), { change: 'unknown', delta_value: null, value_change: -114959916 })
  // Crosslink CRM 2026Q2: 136,035 -> 2,347,970 shares while the value went $25.4M -> $31.0M ($186 -> $13 a share).
  const crosslink = addLine(newPosition(true), line({ shares: 2347970, value: 31001326, prev_shares: 136035, prev_value: 25393653, suspect_units: true, suspect_reason: 'cross_filer' }))
  assert.deepEqual(positionMove(crosslink), { change: 'unknown', delta_value: null })
})

test('an unflagged line keeps its trade at this filing\u2019s price', () => {
  const p = addLine(newPosition(true), line({ shares: 120, value: 12000, prev_shares: 100, prev_value: 9000, suspect_units: false }))
  assert.deepEqual(positionMove(p), { change: 'added', delta_value: 2000, value_delta_basis: 'trade' })
  assert.deepEqual(positionFlags(p), {})
  // One flagged class makes the whole rolled-up position unknown.
  addLine(p, line({ shares: 10, value: 50000, prev_shares: 10, prev_value: 1000, suspect_units: true, suspect_reason: 'own_prior' }))
  assert.equal(positionMove(p).change, 'unknown')
})

test('a flagged line shows its reliable side: shares for a mis-valued line, the label for a new position', () => {
  // BMO TEVA 2026Q3: ~$4,005 a share filed; the +159,272 shares are real, the $ are not.
  const bmo = addLine(newPosition(true), line({ shares: 1130855, value: 4528837000, prev_shares: 971583, prev_value: 24289575, price_outlier: true, unreliable: 'value' }))
  assert.deepEqual(positionMove(bmo), { change: 'added', delta_value: null })
  assert.deepEqual(positionFlags(bmo), { unreliable: 'value', price_outlier: true })
  const opened = addLine(newPosition(true), line({ shares: 1304, value: 6676571, suspect_units: true, suspect_reason: 'cross_filer', unreliable: 'shares' }))
  assert.deepEqual(positionMove(opened), { change: 'new', delta_value: null })
})

test('lines ingest held out of a counted row stay on it, and the counted trade ignores them', () => {
  // Crosslink CRM 2026Q3: the real line trimmed 860 shares; a $4.44 line of 2,212,795 shares was held out.
  const held = { shares: 2212795, value: 9824810, implied_price: 4.44 }
  const p = addLine(newPosition(true), line({ shares: 135175, value: 21176516, prev_shares: 136035, prev_value: 25393653, held_lines: [held] }))
  assert.equal(positionMove(p).change, 'trimmed')
  assert.deepEqual(positionFlags(p), { held_lines: [held] })
})

// Ingest's holder files for Berkshire (BRK.A/BRK.B, a filed 1:1,500 ratio) and Alphabet (GOOGL/GOOG, no ratio), as
// published Nov 11 with classes[]: each multi-class row rebuilt from its classes must give ingest's own figures.
const fixture = (code) => JSON.parse(readFileSync(new URL(`./fixtures/hl-${code}.json`, import.meta.url)))
test('a multi-class position matches ingest’s hl/ rows: $ per class, shares in the filed unit or not summed, mixed', () => {
  let n = 0
  for (const code of ['084670', '02079K']) {
    const d = fixture(code)
    const rows = d.rows.map((r) => Object.fromEntries(d.columns.map((c, j) => [c, r[j]])))
    for (const r of rows.filter((r) => r.classes && r.change && r.change !== 'unknown')) {
      const lines = r.classes.map((k) => ({ ...k, value_delta: k.value_delta ?? 0, display_name: null }))
      const p = classPosition(lines, true, { unit: r.shares_unit, ratio: r.shares_ratio })
      assert.equal(p.delta_value, r.value_delta, `${code} ${r.name}`)
      assert.equal(Boolean(p.mixed), r.change === 'mixed', `${code} ${r.name}`)
      assert.equal(p.change, r.change === 'mixed' ? { buy: 'added', sell: 'trimmed' }[r.net_direction] : r.change, `${code} ${r.name}`)
      if (r.shares == null) assert.equal(p.shares_summable, false)
      else assert.deepEqual([p.shares, p.shares_unit], [r.shares, 'BRK.B'])
      n++
    }
  }
  assert.ok(n >= 40, `only ${n} rows checked`)
})

test('a held class keeps its facts and reason but no dollars; the position counts the clean classes', () => {
  // FMR 2026Q3 BRK: A -7,574 (~$747K a share) and B -802,720 (~$498): about -$6.06B, not summed shares at a blended price.
  const A = { ticker: 'BRK.A', cusip: '084670108', display_name: 'Berkshire Hathaway Class A', shares: 6959, prev_shares: 14533, value: 5198407795, prev_value: 0, value_delta: -5657815870 }
  const B = { ticker: 'BRK.B', cusip: '084670702', display_name: 'Berkshire Hathaway Class B', shares: 9597287, prev_shares: 10400007, value: 4778969198, prev_value: 0, value_delta: -399714435 }
  const ratio = { '084670108': 1500, '084670702': 1 }
  const both = classPosition([A, B], true, { unit: 'BRK.B', ratio })
  assert.deepEqual([both.change, both.delta_value, both.shares, both.prev_shares, both.mixed], ['trimmed', -6057530305, 6959 * 1500 + 9597287, 14533 * 1500 + 10400007, undefined])
  // B bought while A sold: mixed, signed by the net; a held B leaves A alone counted.
  const mixed = classPosition([A, { ...B, shares: 12000000, value_delta: 1197000000 }], true, { unit: 'BRK.B', ratio })
  assert.deepEqual([mixed.change, mixed.mixed, mixed.delta_value], ['trimmed', true, -5657815870 + 1197000000])
  const held = classPosition([A, { ...B, unreliable: 'shares', held_reason: 'class_swap' }], true)
  assert.deepEqual([held.change, held.delta_value, held.classes_held, held.shares_summable], ['trimmed', -5657815870, 1, false])
  assert.deepEqual(held.classes.map((c) => [c.class, c.delta_value, c.held_reason]), [['A', -5657815870, null], ['B', null, 'class_swap']])
  // A sleeve with value but no shares either quarter is held as zero_shares, never a $43M "exit".
  const sleeve = classPosition([A, { ticker: null, cusip: '02079K404', shares: 0, prev_shares: 0, value: 43390000, value_delta: 43390000 }], true)
  assert.deepEqual([sleeve.delta_value, sleeve.classes[1].held_reason], [-5657815870, 'zero_shares'])
})
