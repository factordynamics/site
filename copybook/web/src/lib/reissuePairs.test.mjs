import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pairReissues } from './reissuePairs.mjs'

// FMR 2026Q3 as a book built before the Gates link: GTES (G39104107) new, Gates (G39108108) exited, both on the
// new code's canonical key. FMR trimmed 58,791 shares.
const key = 'G39104107|'
const gtesNew = { key, change: 'new', h: { cusip: 'G39104107', ticker: 'GTES', shares: 10_000_000, value: 511_900_000 }, delta: 511_900_000, shares: 10_000_000, prevShares: 0 }
const gatesExit = { key, change: 'exited', h: { cusip: 'G39108108', ticker: null, shares: 10_058_791, value: 548_100_000 }, delta: -548_100_000, shares: 0, prevShares: 10_058_791 }

test('GTES: a new line and an exit on one reissued position read as one trim of the shares sold', () => {
  const out = pairReissues([gtesNew, gatesExit])
  assert.equal(out.length, 1)
  assert.equal(out[0].change, 'trimmed')
  assert.equal(out[0].prevShares - out[0].shares, 58_791)
  assert.ok(Math.abs(out[0].delta - -58_791 * 51.19) < 1)
  assert.equal(out[0].h.ticker, 'GTES')
})

test('kept shares across the reissue: no move at all', () => {
  assert.deepEqual(pairReissues([gtesNew, { ...gatesExit, prevShares: 10_000_000 }]), [])
})

test('a put on the new code and an exited stock line are different positions', () => {
  const put = { ...gtesNew, key: 'G39104107|Put', h: { ...gtesNew.h, put_call: 'Put' } }
  const out = pairReissues([put, gatesExit])
  assert.deepEqual(out.map((m) => m.change).sort(), ['exited', 'new'])
})
