#!/usr/bin/env node
// Builds the small lookup files the Copy API reads instead of parsing multi-megabyte data files
// inside the Worker (free plan: 10 ms CPU per run), and uploads them to its R2 bucket with the
// workflow's GitHub OIDC token. Run hourly by .github/workflows/copybook-api-precompute.yml.
//
//   pre/stock-codes.json     {"NVDA":"67066G",...}   ticker -> 6-char issuer code (stock_holders.json)
//   pre/sec-tickers.json     {"BRK.B":"0001067983"}  ticker -> issuer CIK (SEC company_tickers.json)
//   pre/v1-filers-rest.txt   "<count> <curated ciks>\n[...]"  /v1/filers rows for every non-curated filer
//
// COPYBOOK_DRY_RUN=1 writes the files to ./pre instead of uploading.
import { mkdirSync, writeFileSync } from 'node:fs';

const DATA = process.env.COPYBOOK_DATA_URL ?? 'https://refcell.github.io/gust/copybook/data/';
const API = (process.env.COPYBOOK_API ?? 'https://gene.tail70ba3.ts.net/copybook').replace(/\/+$/, '');
const UA = 'Copybook copybook@factordynamics.com';

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

const quarterEnd = (q) => `${q.slice(0, 4)}-${['03-31', '06-30', '09-30', '12-31'][Number(q[5]) - 1]}`;

const [stocks, sec, filers, index] = await Promise.all([get(`${DATA}stock_holders.json`), get('https://www.sec.gov/files/company_tickers.json'), get(`${DATA}filers.json`), get(`${DATA}index.json`)]);

const codes = {};
for (const s of stocks.stocks ?? []) if (s.ticker && !(s.ticker in codes)) codes[s.ticker] = s.issuer;
const tickers = {};
for (const v of Object.values(sec)) {
  // SEC writes class tickers with a dash (BRK-B); Copybook uses a dot (BRK.B).
  const t = String(v.ticker).replace('-', '.');
  if (!(t in tickers)) tickers[t] = String(v.cik_str).padStart(10, '0');
}
const curated = new Set((index.managers ?? []).filter((m) => m.slug && m.cik).map((m) => String(m.cik).padStart(10, '0')));
const rest = (filers.filers ?? [])
  .filter((f) => f.ok && !curated.has(f.cik))
  .map((f) => ({ slug: f.slug, cik: f.cik, name: f.name, manager: null, featured: false, status: null, latest_quarter: f.quarter, latest_report_date: f.quarter ? quarterEnd(f.quarter) : null, latest_filing_date: f.filing_date, latest_accession: null, total_value_usd: null, position_count: f.position_count, history_quarters: f.quarter ? [f.quarter] : [], curated: false, type: f.type ?? null }));

const files = {
  'pre/stock-codes.json': JSON.stringify(codes),
  'pre/sec-tickers.json': JSON.stringify(tickers),
  // The header names the curated CIKs left out, so the API can drop a filer curated since this run.
  'pre/v1-filers-rest.txt': `${rest.length} ${[...curated].join(',')}\n${JSON.stringify(rest)}`,
};
for (const [k, v] of Object.entries(files)) console.log(`${k}: ${(v.length / 1024).toFixed(0)} KB`);

if (process.env.COPYBOOK_DRY_RUN) {
  mkdirSync('pre', { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(k, v);
  process.exit(0);
}
const tok = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=copybook-api`, { headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } }).then((r) => r.json());
for (const [k, v] of Object.entries(files)) {
  const res = await fetch(`${API}/ingest/${k}`, { method: 'PUT', body: v, headers: { authorization: `Bearer ${tok.value}`, 'content-type': k.endsWith('.json') ? 'application/json' : 'text/plain', 'user-agent': UA } });
  if (!res.ok) throw new Error(`upload ${k}: ${res.status} ${await res.text()}`);
}
console.log('uploaded');
