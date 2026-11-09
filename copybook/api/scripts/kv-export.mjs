#!/usr/bin/env node
// Copies the Worker's KV namespace (DB) into a file `wrangler kv bulk put` reads, keeping each key's expiration
// and metadata. Reads through Cloudflare's REST API, so it costs no Worker requests.
//
//   CLOUDFLARE_API_TOKEN=... node scripts/kv-export.mjs kv.json
//   npx wrangler kv bulk put kv.json --binding DB --local --persist-to <dir>
//
// The file holds member records and sessions: keep it private and delete it after the import.
import { writeFileSync } from 'node:fs';

const ACCOUNT = process.env.CF_ACCOUNT_ID ?? '967e13dd88bb23b24662e62cbb6fd84f';
const NS = process.env.KV_NAMESPACE_ID ?? '830e2b3035554fa2865bc523dfcbf2fb';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const out = process.argv[2];
if (!TOKEN || !out) {
  console.error('usage: CLOUDFLARE_API_TOKEN=... node scripts/kv-export.mjs <out.json>');
  process.exit(2);
}
const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NS}`;
const api = async (path, init) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  const body = await res.json();
  if (!body.success) throw new Error(`${path}: ${JSON.stringify(body.errors)}`);
  return body;
};

const keys = [];
let cursor = '';
do {
  const r = await api(`/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  keys.push(...r.result);
  cursor = r.result_info?.cursor ?? '';
} while (cursor);

const rows = [];
const now = Math.floor(Date.now() / 1000);
for (let i = 0; i < keys.length; i += 100) {
  const batch = keys.slice(i, i + 100);
  const r = await api('/bulk/get', { method: 'POST', body: JSON.stringify({ keys: batch.map((k) => k.name), type: 'text', withMetadata: true }) });
  for (const k of batch) {
    const v = r.result.values[k.name];
    if (v == null) continue; // expired or deleted since the listing
    const value = typeof v === 'object' && 'value' in v ? v.value : v;
    if (value == null) continue;
    // Keys about to expire are skipped: the local store would reject an expiration under 60 s away.
    if (k.expiration && k.expiration - now < 60) continue;
    rows.push({ key: k.name, value: typeof value === 'string' ? value : JSON.stringify(value), ...(k.expiration ? { expiration: k.expiration } : {}), ...(k.metadata ? { metadata: k.metadata } : {}) });
  }
}
writeFileSync(out, JSON.stringify(rows), { mode: 0o600 });
console.log(`${rows.length} of ${keys.length} keys written to ${out}`);
