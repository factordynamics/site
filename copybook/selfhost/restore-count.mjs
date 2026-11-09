// Opens a restored state dir (STATE_DIR) in a throwaway Miniflare with the running bundle and prints key counts as JSON.
import { makeMiniflare } from './mf.mjs';
const mf = makeMiniflare();
await mf.ready;
const kv = await mf.getKVNamespace('DB');
const count = async (prefix) => {
  let n = 0, cursor;
  do { const l = await kv.list({ prefix, cursor }); n += l.keys.length; cursor = l.list_complete ? undefined : l.cursor; } while (cursor);
  return n;
};
const members = await count('cus:'), all = await count('');
const first = (await kv.list({ prefix: 'cus:' })).keys[0]?.name;
const sample = first ? await kv.get(first) : null;
console.log(JSON.stringify({ restored_members: members, restored_keys: all, sample_member_parses: (() => { try { return !!(sample && JSON.parse(sample).customer); } catch { return false; } })() }));
await mf.dispose();
