import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addLine, newPosition, positionFlags, positionMove } from './position.mjs'

const line = (o) => ({ shares: 0, value: 0, prev_shares: 0, prev_value: 0, ...o })

test('a line ingest flags suspect_units is no trade: change unknown, delta_value null', () => {
  // Guardcap BKNG 2026Q3: 1,304 pre-split shares at ~$5,120 against a split-adjusted prior of 646,216 shares.
  const guardcap = addLine(newPosition(true), line({ shares: 1304, value: 6676571, prev_shares: 646216, prev_value: 121636487, suspect_units: true, suspect_reason: 'cross_filer' }))
  assert.deepEqual(positionMove(guardcap), { change: 'unknown', delta_value: null })
  assert.deepEqual(positionFlags(guardcap), { suspect_units: true, suspect_reason: 'cross_filer' })
  // Crosslink CRM 2026Q2: 136,035 -> 2,347,970 shares while the value went $25.4M -> $31.0M ($186 -> $13 a share).
  const crosslink = addLine(newPosition(true), line({ shares: 2347970, value: 31001326, prev_shares: 136035, prev_value: 25393653, suspect_units: true, suspect_reason: 'cross_filer' }))
  assert.deepEqual(positionMove(crosslink), { change: 'unknown', delta_value: null })
})

test('an unflagged line keeps its trade at this filing\u2019s price', () => {
  const p = addLine(newPosition(true), line({ shares: 120, value: 12000, prev_shares: 100, prev_value: 9000, suspect_units: false }))
  assert.deepEqual(positionMove(p), { change: 'added', delta_value: 2000 })
  assert.deepEqual(positionFlags(p), {})
  // One flagged class makes the whole rolled-up position unknown.
  addLine(p, line({ shares: 10, value: 50000, prev_shares: 10, prev_value: 1000, suspect_units: true, suspect_reason: 'own_prior' }))
  assert.equal(positionMove(p).change, 'unknown')
})
