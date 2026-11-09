// Loads data into the self-hosted store (run while copybook-api.service is stopped; same env as the service).
//   node import.mjs kv <kv.json>      rows from site/copybook/api/scripts/kv-export.mjs (key, value, expiration, metadata)
//   node import.mjs r2 <mirror dir>   objects from r2-pull.mjs; skips objects whose local etag already matches
import { makeMiniflare } from './mf.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const [what, src] = process.argv.slice(2);
const mf = makeMiniflare();
await mf.ready;

if (what === 'kv') {
  const kv = await mf.getKVNamespace('DB');
  const rows = JSON.parse(await readFile(src, 'utf8'));
  const now = Date.now() / 1000;
  let n = 0;
  for (const r of rows) {
    if (r.expiration && r.expiration - now < 60) continue;
    await kv.put(r.key, r.value, { ...(r.expiration ? { expiration: r.expiration } : {}), ...(r.metadata ? { metadata: r.metadata } : {}) });
    n++;
  }
  // Make the local namespace an exact copy: drop local keys the export doesn't have.
  const keep = new Set(rows.map((r) => r.key));
  let dropped = 0, cursor;
  do {
    const l = await kv.list({ cursor });
    for (const k of l.keys) if (!keep.has(k.name)) { await kv.delete(k.name); dropped++; }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  console.log(`kv: ${n} of ${rows.length} keys written, ${dropped} local-only keys dropped`);
} else if (what === 'r2') {
  const r2 = await mf.getR2Bucket('HIST');
  const metaRoot = join(src, 'meta');
  const files = (await readdir(metaRoot, { recursive: true })).filter((f) => f.endsWith('.json'));
  let put = 0, same = 0, i = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (i < files.length) {
      const m = JSON.parse(await readFile(join(metaRoot, files[i++]), 'utf8'));
      const head = await r2.head(m.key);
      if (head?.etag === m.etag) { same++; continue; }
      const body = await readFile(join(src, 'objects', m.key));
      await r2.put(m.key, body, { httpMetadata: m.contentType ? { contentType: m.contentType } : undefined, customMetadata: m.customMetadata ?? {} });
      if (++put % 2000 === 0) console.log(`r2: ${put} written`);
    }
  }));
  console.log(`r2: ${put} written, ${same} unchanged, ${files.length} in mirror`);
} else {
  console.error('usage: node import.mjs kv <kv.json> | r2 <mirror dir>');
  process.exitCode = 2;
}
await mf.dispose();
