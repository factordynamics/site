// What GET /me returns that pages read: the API nests everything under `member` (api/src/index.ts /me). Kept in a
// plain module with a test, so a page can't read a field from the wrong level again (winter_preview, Nov 12).

/** /me?include=winter's preview: member.winter_preview, null when absent. */
export const readWinter = (r) => r?.member?.winter_preview ?? null
