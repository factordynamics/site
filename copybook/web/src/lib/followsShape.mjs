// The follows a page renders, from any /follows response. GET /follows puts a free account's name
// limit at the top level ({follows, limit: 5}); single-item writes may leave it out, so the last known
// limit carries over. Used by follows.ts; tested with node --test.

/**
 * @param {{ follows?: object, limit?: number } | null | undefined} res
 * @param {object} empty the defaults every field starts from
 * @param {number | undefined} prevLimit the limit already known, if any
 */
export function readFollows(res, empty, prevLimit) {
  const f = { ...empty, ...(res?.follows ?? {}) }
  const limit = res?.limit ?? res?.follows?.limit ?? prevLimit
  if (limit != null) f.limit = limit
  else delete f.limit
  return f
}
