// Copies objects from gene's local Miniflare R2 (copybook-history) to Cloudflare's copybook-history over R2's S3 API
// (no Worker requests). Reads the live store read-only (SQLite index + immutable blobs), so the service keeps running.
//   node r2-push.mjs keys <prefix>...      copy every local object under each prefix
//   node r2-push.mjs missing <prefix>      count local objects Cloudflare lacks or holds an older version of
//   node r2-push.mjs missing-copy <prefix> copy those (a newer Cloudflare object is never overwritten)
// Env: CLOUDFLARE_API_TOKEN (S3 key id = token id, secret = sha256(token)), STATE_DIR.
// Optional: MATCH (regex on keys), RATE_KBPS (upload cap; one object at a time when set), PROBE_URL (pause 60 s while
// it answers slower than 2 s or not at all, checked every 20 s), DEADLINE (ISO time: stop there, leave the rest).
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
const RATE = Number(process.env.RATE_KBPS ?? 0) * 1024;
const DEADLINE = process.env.DEADLINE ? Date.parse(process.env.DEADLINE) : Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let probedAt = 0, paused = 0;
async function healthy() {
  if (!process.env.PROBE_URL || Date.now() - probedAt < 20000) return true;
  probedAt = Date.now();
  const t0 = Date.now();
  try { const r = await fetch(process.env.PROBE_URL, { signal: AbortSignal.timeout(5000) }); return r.ok && Date.now() - t0 < 2000; } catch { return false; }
}
async function push(rows) {
  let done = 0, failed = 0, replaced = 0, bytes = 0, i = 0;
  const t0 = Date.now();
  const tick = setInterval(() => console.log(`${done}/${rows.length} copied, ${(bytes / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 60000).toFixed(1)} min, paused ${paused}x`), 300000);
  await Promise.all(Array.from({ length: RATE ? 1 : 8 }, async () => {
    while (i < rows.length) {
      if (Date.now() > DEADLINE) { console.log(`deadline reached; ${rows.length - i} left for the hourly push`); i = rows.length; break; }
      while (!(await healthy())) { paused++; console.log(`${new Date().toISOString()} probe slow or failing; pausing 60 s`); await sleep(60000); probedAt = 0; }
      const o = rows[i++];
      // Ingest may replace the object after the listing (Miniflare then deletes the old blob): skip it; the next run
      // copies the new version.
      let body;
      try { body = await readFile(`${R2}/copybook-history/blobs/${o.blob_id}`); }
      catch (e) { if (e.code !== 'ENOENT') throw e; replaced++; continue; }
      if (body.length !== o.size) { failed++; console.error(`FAIL ${o.key}: blob size ${body.length} != ${o.size}`); continue; }
      const h = { 'content-type': JSON.parse(o.http_metadata).contentType ?? 'application/octet-stream' };
      for (const [k, v] of Object.entries(JSON.parse(o.custom_metadata))) h[`x-amz-meta-${k}`] = String(v);
      const r = await aws.fetch(`${B}/${enc(o.key)}`, { method: 'PUT', body, headers: h }).catch((e) => ({ ok: false, status: String(e) }));
      if (r.ok) { done++; bytes += body.length; } else { failed++; console.error(`FAIL ${o.key}: ${r.status}`); }
      // Rate cap: wait until the average since the start is back under RATE.
      if (RATE) { const ahead = (bytes / RATE) * 1000 - (Date.now() - t0); if (ahead > 0) await sleep(ahead); }
    }
  }));
  clearInterval(tick);
  console.log(`copied ${done}, failed ${failed}, replaced during the run ${replaced}, ${(bytes / 1e6).toFixed(1)} MB`);
}
const [cmd, ...prefixes] = process.argv.slice(2);
if (cmd === 'keys') await push(prefixes.flatMap(local));
else if (cmd === 'missing' || cmd === 'missing-copy') {
  // Missing on Cloudflare, or different there and older than gene's copy (never overwrite a newer Cloudflare object).
  const have = await remoteKeys(prefixes[0]);
  const rx = process.env.MATCH ? new RegExp(process.env.MATCH) : null;
  const rows = local(prefixes[0]).filter((o) => !rx || rx.test(o.key));
  const miss = rows.filter((o) => !have.has(o.key));
  const stale = rows.filter((o) => have.has(o.key) && have.get(o.key).etag !== o.etag && o.uploaded > have.get(o.key).modified);
  const newer = rows.filter((o) => have.has(o.key) && have.get(o.key).etag !== o.etag && o.uploaded <= have.get(o.key).modified);
  console.log(`local ${rows.length}, cloudflare ${have.size}, missing on cloudflare ${miss.length}, older on cloudflare ${stale.length}, newer on cloudflare (left alone) ${newer.length}`);
  for (const o of [...miss, ...stale].slice(0, Number(process.env.SHOW ?? 5))) console.log(`  ${o.key}`);
  if (cmd === 'missing-copy') await push([...miss, ...stale]);
} else { console.error('usage: keys <prefix>... | missing <prefix> | missing-copy <prefix>'); process.exitCode = 2; }
