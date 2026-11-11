// Copies objects from gene's local Miniflare R2 (copybook-history) to Cloudflare's copybook-history over R2's S3 API
// (no Worker requests). Reads the live store read-only (SQLite index + immutable blobs), so the service keeps running.
//   node r2-push.mjs keys <prefix>...      copy every local object under each prefix
//   node r2-push.mjs missing <prefix>      count local objects Cloudflare lacks or holds an older version of
//   node r2-push.mjs missing-copy <prefix> copy those (a newer Cloudflare object is never overwritten)
// Env: CLOUDFLARE_API_TOKEN (S3 key id = token id, secret = sha256(token)), STATE_DIR.
import { AwsClient } from 'aws4fetch';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
const tok = process.env.CLOUDFLARE_API_TOKEN;
let id;
for (let i = 0; !id; i++) {
  try { id = (await (await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(15000) })).json()).result.id; }
  catch (e) { if (i === 4) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
}
const aws = new AwsClient({ accessKeyId: id, secretAccessKey: createHash('sha256').update(tok).digest('hex'), service: 's3', region: 'auto', retries: 5 });
const B = 'https://967e13dd88bb23b24662e62cbb6fd84f.r2.cloudflarestorage.com/copybook-history';
const enc = (k) => k.split('/').map(encodeURIComponent).join('/');
const R2 = `${process.env.STATE_DIR}/r2`;
const dbf = (await readdir(`${R2}/miniflare-R2BucketObject`)).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
const db = new DatabaseSync(`${R2}/miniflare-R2BucketObject/${dbf}`, { readOnly: true });
const local = (prefix) => db.prepare('select key, blob_id, size, etag, uploaded, http_metadata, custom_metadata from _mf_objects where key >= ? and key < ? order by key').all(prefix, prefix + '\uffff');
async function remoteKeys(prefix) {
  const out = new Map(); let t = '';
  do {
    const x = await (await aws.fetch(`${B}?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}${t ? `&continuation-token=${encodeURIComponent(t)}` : ''}`)).text();
    for (const [, c] of x.matchAll(/<Contents>(.*?)<\/Contents>/g)) out.set(c.match(/<Key>(.*?)<\/Key>/)[1].replace(/&amp;/g, '&'), { etag: c.match(/<ETag>(.*?)<\/ETag>/)[1].replace(/&quot;|"/g, ''), modified: Date.parse(c.match(/<LastModified>(.*?)<\/LastModified>/)[1]) });
    t = /<IsTruncated>true/.test(x) ? x.match(/<NextContinuationToken>(.*?)</)?.[1] ?? '' : '';
  } while (t);
  return out;
}
async function push(rows) {
  let done = 0, failed = 0, bytes = 0, i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < rows.length) {
      const o = rows[i++];
      const body = await readFile(`${R2}/copybook-history/blobs/${o.blob_id}`);
      if (body.length !== o.size) { failed++; console.error(`FAIL ${o.key}: blob size ${body.length} != ${o.size}`); continue; }
      const h = { 'content-type': JSON.parse(o.http_metadata).contentType ?? 'application/octet-stream' };
      for (const [k, v] of Object.entries(JSON.parse(o.custom_metadata))) h[`x-amz-meta-${k}`] = String(v);
      const r = await aws.fetch(`${B}/${enc(o.key)}`, { method: 'PUT', body, headers: h });
      if (r.ok) { done++; bytes += body.length; } else { failed++; console.error(`FAIL ${o.key}: ${r.status}`); }
    }
  }));
  console.log(`copied ${done}, failed ${failed}, ${(bytes / 1e6).toFixed(1)} MB`);
}
const [cmd, ...prefixes] = process.argv.slice(2);
if (cmd === 'keys') await push(prefixes.flatMap(local));
else if (cmd === 'missing' || cmd === 'missing-copy') {
  // Missing on Cloudflare, or different there and older than gene's copy (never overwrite a newer Cloudflare object).
  const have = await remoteKeys(prefixes[0]);
  const rows = local(prefixes[0]);
  const miss = rows.filter((o) => !have.has(o.key));
  const stale = rows.filter((o) => have.has(o.key) && have.get(o.key).etag !== o.etag && o.uploaded > have.get(o.key).modified);
  const newer = rows.filter((o) => have.has(o.key) && have.get(o.key).etag !== o.etag && o.uploaded <= have.get(o.key).modified);
  console.log(`local ${rows.length}, cloudflare ${have.size}, missing on cloudflare ${miss.length}, older on cloudflare ${stale.length}, newer on cloudflare (left alone) ${newer.length}`);
  for (const o of [...miss, ...stale].slice(0, Number(process.env.SHOW ?? 10))) console.log(`  ${o.key}`);
  if (cmd === 'missing-copy') await push([...miss, ...stale]);
} else { console.error('usage: keys <prefix>... | missing <prefix> | missing-copy <prefix>'); process.exitCode = 2; }
