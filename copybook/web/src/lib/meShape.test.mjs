import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readWinter } from './meShape.mjs'

// The shape GET /me?include=winter answers (api/src/index.ts): { ok, member: { ...publicView, winter_preview } }.
const ME = { ok: true, member: { email: 'a@example.com', winter_preview: { names: 3, insider_buys: 4, schedule_13dg: 11 } } }

test('the winter preview is read from member, where /me puts it', () => {
  assert.deepEqual(readWinter(ME), { names: 3, insider_buys: 4, schedule_13dg: 11 })
})

test('a preview at the top level is not the API shape and is ignored', () => {
  assert.equal(readWinter({ ok: true, member: {}, winter_preview: { names: 3 } }), null)
})
