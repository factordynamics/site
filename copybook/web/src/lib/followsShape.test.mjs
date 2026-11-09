import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFollows } from './followsShape.mjs'

const EMPTY = { investors: [], stocks: [], owned: [] }

test('a free account: the limit at the top level of GET /follows reaches the follows', () => {
  const f = readFollows({ follows: { owned: ['LEN', 'SIRI'] }, limit: 5 }, EMPTY)
  assert.equal(f.limit, 5)
  assert.deepEqual(f.owned, ['LEN', 'SIRI'])
})

test('a write without the limit keeps the one already known', () => {
  assert.equal(readFollows({ follows: { owned: ['LEN'] } }, EMPTY, 5).limit, 5)
})

test('a paid account has no limit', () => {
  assert.equal('limit' in readFollows({ follows: { owned: ['LEN'] } }, EMPTY), false)
})
