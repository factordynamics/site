// R2 copybook-history over the S3 API, with S3 credentials derived from CF_API_TOKEN (key id = token id, secret = sha256(token)).
//   node r2obj.mjs put <key> <file> | get <key> <file> | list <prefix> | prune <prefix> <days>
import { AwsClient } from 'aws4fetch';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const tok = process.env.CF_API_TOKEN;
// Retried: a busy home link sometimes drops the first connection.
let id;
for (let i = 0; !id; i++) {
  try { id = (await (await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(15000) })).json()).result.id; }
  catch (e) { if (i === 4) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
}
const aws = new AwsClient({ accessKeyId: id, secretAccessKey: createHash('sha256').update(tok).digest('hex'), service: 's3', region: 'auto', retries: 5 });
const B = 'https://967e13dd88bb23b24662e62cbb6fd84f.r2.cloudflarestorage.com/copybook-history';
// Masking rule (agent session logs are kept 30+ days): never print raw member data; emails in key names show as a***@domain.
const mask = (s) => String(s).replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@(?=[A-Za-z0-9-]+\.)/g, '$1***@');
const enc = (k) => k.split('/').map(encodeURIComponent).join('/');
const list = async (prefix) => {
  const out = []; let t = '';
  do {
    const x = await (await aws.fetch(`${B}?list-type=2&prefix=${encodeURIComponent(prefix)}${t ? `&continuation-token=${encodeURIComponent(t)}` : ''}`)).text();
    // Field order inside <Contents> differs between S3 implementations (R2 puts Size before LastModified).
    for (const [, c] of x.matchAll(/<Contents>(.*?)<\/Contents>/g)) out.push({ key: c.match(/<Key>(.*?)<\/Key>/)[1], modified: c.match(/<LastModified>(.*?)<\/LastModified>/)[1], size: +c.match(/<Size>(\d+)<\/Size>/)[1] });
    t = /<IsTruncated>true/.test(x) ? x.match(/<NextContinuationToken>(.*?)</)?.[1] ?? '' : '';
  } while (t);
  return out;
};
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'put') {
  const r = await aws.fetch(`${B}/${enc(a)}`, { method: 'PUT', body: await readFile(b), headers: { 'content-type': 'application/octet-stream' } });
  if (!r.ok) throw new Error(`put ${a}: ${r.status} ${await r.text()}`);
  console.log(mask(`put ${a}`));
} else if (cmd === 'get') {
  const r = await aws.fetch(`${B}/${enc(a)}`);
  if (!r.ok) throw new Error(`get ${a}: ${r.status}`);
  await writeFile(b, Buffer.from(await r.arrayBuffer()), { mode: 0o600 });
  console.log(mask(`got ${a}`));
} else if (cmd === 'list') {
  for (const o of await list(a)) console.log(mask(o.key), o.size, o.modified);
} else if (cmd === 'prune') {
  const cutoff = Date.now() - Number(b) * 86400_000;
  // Age by the date in the name (backups/YYYY-MM-DD.*), so re-uploading an old backup doesn't extend its retention.
  for (const o of await list(a)) if (Date.parse(o.key.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? o.modified) < cutoff) { await aws.fetch(`${B}/${enc(o.key)}`, { method: 'DELETE' }); console.log(mask(`pruned ${o.key}`)); }
} else if (cmd === 'del') {
  const r = await aws.fetch(`${B}/${enc(a)}`, { method: 'DELETE' });
  console.log(mask(`deleted ${a} ${r.status}`));
} else { console.error('usage: put|get|list|prune|del'); process.exitCode = 2; }
