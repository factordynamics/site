import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addLine, newPosition, positionFlags, positionMove } from './position.mjs'

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

test('share classes trade at their own prices: FMR BRK A and B, Alphabet A and C', () => {
  // FMR 2026Q3 (0000315066-26-002964): BRK.A 14,533 -> 6,959 at $747,005; BRK.B 10,400,007 -> 9,597,287 at $497.95.
  const brk = newPosition(true)
  addLine(brk, line({ cusip: '084670108', ticker: 'BRK.A', shares: 6959, value: 6959 * 747005, prev_shares: 14533, prev_value: 14533 * 700000 }))
  addLine(brk, line({ cusip: '084670702', ticker: 'BRK.B', shares: 9597287, value: 9597287 * 497.95, prev_shares: 10400007, prev_value: 10400007 * 466 }))
  const m = positionMove(brk)
  assert.equal(m.change, 'trimmed')
  assert.equal(m.delta_value, Math.round(-7574 * 747005 - 802720 * 497.95)) // ~-$6.06B, not -810,294 summed shares
  assert.equal(m.shares, 6959 * 1500 + 9597287)
  assert.equal(m.shares_unit, 'BRK.B')
  assert.deepEqual(m.classes.map((c) => [c.ticker, c.shares - c.prev_shares, c.change]), [['BRK.A', -7574, 'trimmed'], ['BRK.B', -802720, 'trimmed']])
  // GOOGL bought, GOOG sold: mixed, net_direction from the dollars; no share unit, so shares null.
  const g = newPosition(true)
  addLine(g, line({ cusip: '02079K305', ticker: 'GOOGL', shares: 1000, value: 344080, prev_shares: 900, prev_value: 300000 }))
  addLine(g, line({ cusip: '02079K107', ticker: 'GOOG', shares: 500, value: 170370, prev_shares: 800, prev_value: 270000 }))
  const gm = positionMove(g)
  assert.deepEqual([gm.change, gm.net_direction, gm.shares, gm.prev_shares], ['mixed', 'sell', null, null])
  // A held class is left out of the dollars and the row's flags.
  const h = newPosition(true)
  addLine(h, line({ cusip: '02079K305', ticker: 'GOOGL', shares: 1000, value: 344080, prev_shares: 900, prev_value: 300000 }))
  addLine(h, line({ cusip: '02079K107', ticker: 'GOOG', shares: 500, value: 9e9, prev_shares: 800, prev_value: 270000, suspect_units: true, unreliable: 'both' }))
  const hm = positionMove(h)
  assert.deepEqual([hm.change, hm.delta_value, hm.classes_held], ['added', Math.round(100 * 344.08), 1])
  assert.deepEqual(positionFlags(h), {})
})
