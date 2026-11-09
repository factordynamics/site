#!/usr/bin/env -S npx tsx
// Builds pre/events.json for GET /v1/events: every Form 4 and Schedule 13D/G the investor pages show
// (the data run's events.json plus each curated filer's events/{slug}.json), with what the pages and
// the minute poll know that the data files don't: EDGAR's acceptance time, the 13D's Item 4, per-class
// Form 4 holdings, and the same filer's previous stake in the issuer. Parsed with the Worker's own
// EDGAR code (src/edgar.ts) and uploaded with the workflow's OIDC token. Run hourly by
// .github/workflows/copybook-api-precompute.yml; details already fetched are kept in
// COPYBOOK_EVENTS_CACHE (an Actions cache) so each run only reads new filings from EDGAR.
//
// COPYBOOK_DRY_RUN=1 writes pre/events.json instead of uploading.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchFilingMeta, fetchForm4, fetchSchedule13 } from '../src/edgar';

const DATA = process.env.COPYBOOK_DATA_URL ?? 'https://refcell.github.io/gust/copybook/data/';
const API = (process.env.COPYBOOK_API ?? 'https://gene.tail70ba3.ts.net/copybook').replace(/\/+$/, '');
const CACHE = process.env.COPYBOOK_EVENTS_CACHE ?? '.cache/events-detail.json';
/** SEC asks for at most 10 requests a second; each filing takes 2 or 3. */
const MAX_FILINGS = Number(process.env.COPYBOOK_EVENTS_MAX ?? 900);
const UA = 'Copybook copybook@factordynamics.com';

type Ev = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Detail = { v?: number; event_date?: string | null; last_transaction_date?: string | null; accepted_at: string | null; amendment_no?: number | null; item4?: string | null; percent_of_class?: number | null; shares_after?: number | null; classes?: unknown; ten_percent_owner?: boolean | null };

const get = async (url: string) => {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  return res.ok ? res.json() : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const index = await get(`${DATA}index.json`);
const slugs: string[] = (index?.managers ?? []).filter((m: Ev) => m.slug).map((m: Ev) => m.slug);
const recent: Ev[] = (await get(`${DATA}events.json`))?.events ?? [];
const perFiler: Ev[] = [];
for (let i = 0; i < slugs.length; i += 10) {
  const got = await Promise.all(slugs.slice(i, i + 10).map((s) => get(`${DATA}events/${s}.json`)));
  for (const g of got) perFiler.push(...(g?.events ?? []));
}
const byKey = new Map<string, Ev>();
for (const e of [...perFiler, ...recent]) byKey.set(`${e.id}|${e.slug}`, { ...byKey.get(`${e.id}|${e.slug}`), ...e });
// Newest first, so a capped run fills in the filings people look at first.
const events = [...byKey.values()].sort((a, b) => String(b.filing_date).localeCompare(String(a.filing_date)));

const cache: Record<string, Detail> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const filerCik = (e: Ev) => e.url?.match(/\/edgar\/data\/(\d+)\//)?.[1] ?? null;
let fetched = 0;
for (const e of events) {
  // v2: Item 4 is cleaned (no amendment preamble, sentence cut); re-read 13Ds cached before that.
  // v3: Form 4 transaction dates and direct/indirect holdings; re-read Form 4s cached before that.
  const c = cache[e.id];
  if ((c && ((c.v ?? 0) >= 3 || (e.kind !== 'form4' && (c.v === 2 || !c.item4)))) || fetched >= MAX_FILINGS) continue;
  const cik = filerCik(e);
  if (!cik) continue;
  try {
    const meta = await fetchFilingMeta(cik, e.id);
    await sleep(120);
    const d: Detail = { v: 3, accepted_at: meta?.accepted_at ?? null, amendment_no: meta?.amendment_no ?? null };
    if (e.kind === 'form4') {
      const f4 = await fetchForm4(cik, e.id);
      await sleep(240);
      if (f4) Object.assign(d, { classes: f4.classes, ten_percent_owner: f4.ten_percent_owner, event_date: f4.event_date, last_transaction_date: f4.last_transaction_date });
    } else {
      const s = await fetchSchedule13(cik, e.id);
      await sleep(120);
      if (s) Object.assign(d, { item4: s.item4, percent_of_class: s.percent_of_class, shares_after: s.shares, amendment_no: s.amendment_no ?? d.amendment_no });
    }
    if (meta) cache[e.id] = d; // an EDGAR hiccup is retried next run
    fetched++;
  } catch (err) {
    console.log(`${e.id}: ${(err as Error).message}`);
  }
}

// The same filer's previous Schedule 13D/G on the issuer, as the investor page pairs them.
const issuerKey = (e: Ev) => e.issuer_cik || e.cusip || e.issuer;
const when = (e: Ev) => cache[e.id]?.accepted_at ?? `${e.filing_date}T23:59:59Z`;
const out = events
  .map((e) => {
    const d = cache[e.id] ?? { accepted_at: null };
    // Form 4 dates: the first transaction date is event_date (one rule with the minute poll and /events).
    const dates = e.kind === 'form4' && d.event_date ? { event_date: d.event_date, last_transaction_date: d.last_transaction_date ?? null } : {};
    return { ...e, ...dates, accepted: e.accepted ?? d.accepted_at, item4: e.item4 ?? d.item4 ?? null, classes: d.classes ?? e.classes ?? null, ten_percent_owner: e.ten_percent_owner ?? d.ten_percent_owner ?? null, amendment_no: e.amendment_no ?? d.amendment_no ?? null, percent_of_class: e.percent_of_class ?? d.percent_of_class ?? null, shares_after: e.shares_after ?? d.shares_after ?? null, transactions: undefined, sector: undefined };
  })
  .sort((a, b) => when(b).localeCompare(when(a)) || String(b.id).localeCompare(String(a.id)));
for (const [i, e] of out.entries()) {
  if (e.kind === 'form4' || e.prev_percent_of_class != null) continue;
  const p = out.slice(i + 1).find((x) => x.kind !== 'form4' && x.slug === e.slug && issuerKey(x) === issuerKey(e));
  if (p) Object.assign(e, { prev_accession: p.id, prev_form: p.form, prev_percent_of_class: p.percent_of_class, prev_shares_after: p.shares_after });
}
const body = JSON.stringify({ built_at: new Date().toISOString(), count: out.length, events: out });
console.log(`pre/events.json: ${out.length} events, ${fetched} read from EDGAR, ${(body.length / 1024).toFixed(0)} KB, ${out.filter((e) => !e.accepted).length} without acceptance`);

mkdirSync(dirname(CACHE), { recursive: true });
writeFileSync(CACHE, JSON.stringify(cache));
if (process.env.COPYBOOK_DRY_RUN) {
  mkdirSync('pre', { recursive: true });
  writeFileSync('pre/events.json', body);
  process.exit(0);
}
const tok = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=copybook-api`, { headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } }).then((r) => r.json());
const res = await fetch(`${API}/ingest/pre/events.json`, { method: 'PUT', body, headers: { authorization: `Bearer ${tok.value}`, 'content-type': 'application/json', 'user-agent': UA } });
if (!res.ok) throw new Error(`upload pre/events.json: ${res.status} ${await res.text()}`);
console.log('uploaded');
