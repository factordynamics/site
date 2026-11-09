// Mirrors R2 bucket copybook-history to <dir>/objects/<key> plus <dir>/meta/<key>.json, via R2's S3 API.
// Skips objects whose local etag already matches, so reruns only fetch new or changed objects.
import { AwsClient } from 'aws4fetch';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const [dir, prefix = ''] = process.argv.slice(2);
const tok = process.env.CLOUDFLARE_API_TOKEN;
const aws = new AwsClient({ accessKeyId: '236933ca969ca886ba15c68941c8b23c', secretAccessKey: createHash('sha256').update(tok).digest('hex'), service: 's3', region: 'auto', retries: 5 });
const base = 'https://967e13dd88bb23b24662e62cbb6fd84f.r2.cloudflarestorage.com/copybook-history';
const enc = (k) => k.split('/').map(encodeURIComponent).join('/');
const keys = [];
let token = '';
do {
  const r = await aws.fetch(`${base}?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`);
  const x = await r.text();
  for (const m of x.matchAll(/<Contents><Key>(.*?)<\/Key>.*?<ETag>(.*?)<\/ETag>/g)) keys.push({ key: m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"), etag: m[2].replace(/&quot;/g, '') });
  token = /<IsTruncated>true<\/IsTruncated>/.test(x) ? (x.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1] ?? '') : '';
} while (token);
console.log(`listed ${keys.length}`);
let done = 0, skipped = 0, failed = 0, bytes = 0;
async function one({ key, etag }) {
  const mp = join(dir, 'meta', key + '.json');
  try { if (JSON.parse(await readFile(mp, 'utf8')).etag === etag) { skipped++; return; } } catch {}
  for (let i = 0; i < 5; i++) {
    try {
      const r = await aws.fetch(`${base}/${enc(key)}`);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const custom = {};
      for (const [k, v] of r.headers) if (k.startsWith('x-amz-meta-')) custom[k.slice(11)] = v;
      const op = join(dir, 'objects', key);
      await mkdir(dirname(op), { recursive: true });
      await mkdir(dirname(mp), { recursive: true });
      await writeFile(op, buf);
      await writeFile(mp, JSON.stringify({ key, etag, size: buf.length, contentType: r.headers.get('content-type'), lastModified: r.headers.get('last-modified'), customMetadata: custom }));
      done++; bytes += buf.length;
      return;
    } catch (e) { if (i === 4) { failed++; console.error(`FAIL ${key}: ${e.message}`); } else await new Promise((s) => setTimeout(s, 1000 * 2 ** i)); }
  }
}
let i = 0;
const t0 = Date.now();
const tick = setInterval(() => console.log(`${done} fetched, ${skipped} unchanged, ${failed} failed, ${(bytes / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)}s`), 15000);
await Promise.all(Array.from({ length: 48 }, async () => { while (i < keys.length) await one(keys[i++]); }));
clearInterval(tick);
console.log(`DONE ${done} fetched, ${skipped} unchanged, ${failed} failed, ${(bytes / 1e6).toFixed(0)} MB`);
