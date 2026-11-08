import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleRequest } from '../src/index';
import type { Env, KV, R2 } from '../src/env';
import { MeterLogic } from '../src/keys';
import { resolveFollowedFilers, runDigest } from '../src/alerts';
import { hmacHex } from '../src/tokens';
import form4Len from './fixtures/form4-len.xml?raw';
import sc13dCvi from './fixtures/sc13da-cvi.xml?raw';

class MemKV implements KV {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
  async list({ prefix }: { prefix: string }) {
    return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

class MemR2 implements R2 {
  m = new Map<string, Uint8Array>();
  async get(k: string) {
    const v = this.m.get(k);
    if (!v) return null;
    // Deliver in two chunks with the header line split, as R2 may.
    return { body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(v.subarray(0, 20)); c.enqueue(v.subarray(20)); c.close(); } }) };
  }
  async put(k: string, v: ReadableStream | ArrayBuffer | string | null) {
    this.m.set(k, new Uint8Array(await new Response(v).arrayBuffer()));
  }
}

const SITE = 'https://refcell.github.io/gust/copybook/';
const now = () => Math.floor(Date.now() / 1000);

function sub(id: string, customer: string, status: string, interval = 'month', lookup_key = `copy_${interval}ly`) {
  return { id, customer, status, items: { data: [{ price: { lookup_key, recurring: { interval } }, current_period_end: now() + 30 * 86400 }] } };
}

let env: Env;
let hist: MemR2;
const WORKFLOW = 'refcell/gust/.github/workflows/copybook-data.yml@refs/heads/main';
let sent: { to: string[]; subject: string; text: string; html?: string }[];
let stripeObjects: Record<string, unknown>;
let index: unknown;
let secFiles: Record<string, string>;
let filers: Record<string, unknown>[];
let shards: Record<string, unknown>;
let events: unknown[];
let recentMoves: unknown[];
let gh: { method: string; url: string; body?: string }[];
let ghQueued: number;
let jwks: unknown = { keys: [] };

/** Durable Object namespace stand-in: one MeterLogic per key id, with in-memory storage. */
function memMeters(now: () => number = Date.now) {
  const meters = new Map<string, MeterLogic>();
  return {
    idFromName: (n: string) => n,
    get: (id: unknown) => {
      const n = String(id);
      if (!meters.has(n)) {
        const store = new Map<string, unknown>();
        meters.set(n, new MeterLogic({ get: async <T,>(k: string) => store.get(k) as T | undefined, put: async (k: string, v: unknown) => void store.set(k, v) }, now));
      }
      const m = meters.get(n)!;
      return { fetch: async (u: string) => Response.json(u.includes('/hit') ? await m.hit() : await m.usage(Number(new URL(u).searchParams.get('days')) || 30)) };
    },
  };
}

beforeEach(async () => {
  hist = new MemR2();
  env = { DB: new MemKV(), HIST: hist, INGEST_WORKFLOW: WORKFLOW, SITE_URL: SITE, DATA_URL: `${SITE}data/`, EMAIL_FROM: 'Copybook <a@b.c>', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', SESSION_SECRET: 'session-secret', RESEND_API_KEY: 're_x', METER: memMeters() };
  // 2026Q1 lives only in the private bucket; 2026Q2 still falls back to the public copy.
  hist.m.set('h/warren-buffett/2026Q1.csv', new TextEncoder().encode('manager,slug,cik,quarter,report_date,filing_date,accession,ticker,issuer,cusip,title,put_call,shares,value_usd,weight,change,prev_shares,share_change,value_delta_usd,pct_of_book\r\nWarren Buffett,warren-buffett,0001067983,2026Q1,2026-03-31,2026-05-15,A1,BAC,"BANK, ""OF"" AMERICA",060505104,COM,,5,100,0.1,new,,5,100,0.1\r\n'));
  sent = [];
  stripeObjects = {};
  index = { managers: [] };
  secFiles = {};
  filers = [{ cik: '0002045724', name: 'Situational Awareness LP', slug: 'situational-awareness-lp-5724', ok: true, position_count: 2, quarter: '2026Q2', error: null }];
  shards = {};
  // The curated managers the tests follow, as the hourly run maps them from index.json.
  await env.DB.put('alerts:ciks', JSON.stringify(Object.fromEntries([['0001067983', 'warren-buffett'], ['0001040273', 'dan-loeb'], ['0001336528', 'bill-ackman'], ['0001061768', 'seth-klarman']].map(([cik, slug]) => [cik, [{ slug, manager: slug, name: slug, cik, featured: true }]]))));
  events = [];
  recentMoves = [];
  gh = [];
  ghQueued = 0;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.resend.com/emails/batch') {
      sent.push(...JSON.parse(String(init?.body)));
      return new Response('{"data":[]}', { status: 200 });
    }
    if (url.startsWith('https://api.stripe.com/v1/')) {
      const path = url.slice('https://api.stripe.com/v1/'.length).split('?')[0];
      if (path === 'billing_portal/sessions') return Response.json({ url: 'https://billing.stripe.com/p/session/test_1' });
      const obj = stripeObjects[path];
      return obj ? Response.json(obj) : Response.json({ error: { message: 'No such object' } }, { status: 404 });
    }
    if (url === 'https://token.actions.githubusercontent.com/.well-known/jwks') return Response.json(jwks);
    if (url.startsWith('https://api.github.com/repos/refcell/gust/actions/workflows/copybook-data.yml')) {
      gh.push({ method: init?.method ?? 'GET', url, body: init?.body ? String(init.body) : undefined });
      if (url.includes('/runs?status=queued')) return Response.json({ total_count: ghQueued });
      if (url.includes('/runs?')) return Response.json({ total_count: 0 });
      return new Response(null, { status: 204 });
    }
    if (url === `${SITE}data/index.json`) return Response.json(index);
    if (url === `${SITE}data/filers.json`) return new Response(JSON.stringify({ count: filers.length, filers }, null, 1));
    if (url.startsWith(`${SITE}data/f/`)) return shards[url.slice(`${SITE}data/f/`.length)] ? Response.json(shards[url.slice(`${SITE}data/f/`.length)]) : new Response('not found', { status: 404 });
    if (url === `${SITE}data/alerts.json`) return Response.json({ recent: recentMoves });
    if (url === `${SITE}data/events.json`) return Response.json({ events });
    if (url === `${SITE}data/securities.json`) return new Response('{"037833100":{"ticker":"AAPL","name":"Apple"},"23331A109":{"ticker":"DHI","name":"D.R. Horton","sector":"Consumer Discretionary"}}');
    if (url.startsWith('https://www.sec.gov/')) {
      const u = new URL(url);
      const key = url.startsWith('https://www.sec.gov/cgi-bin/browse-edgar')
        ? u.searchParams.get('action') === 'getcompany'
          ? `company:${u.searchParams.get('CIK')}`
          : `feed${Number(u.searchParams.get('start')) ? `@${u.searchParams.get('start')}` : ''}`
        : url.slice('https://www.sec.gov/'.length);
      const typed = `${key}:${u.searchParams.get('type')}`;
      if (key.startsWith('feed') && u.searchParams.get('type') !== '13F-HR') return new Response(secFiles[typed] ?? '<feed></feed>');
      if (key.startsWith('company:') || key.startsWith('feed@')) return new Response(secFiles[key] ?? '<feed></feed>');
      return key in secFiles ? new Response(secFiles[key]) : new Response(key === 'feed' ? '<feed></feed>' : 'not found', { status: key === 'feed' ? 200 : 404 });
    }
    if (url === `${SITE}data/warren-buffett-history.json`) {
      return Response.json({
        slug: 'warren-buffett', manager: 'Warren Buffett', cik: '0001067983', history_quarters: ['2026Q2', '2026Q1'],
        history: [
          { quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', accession: 'A2', holdings_url: 'h/warren-buffett/2026Q2.json', top_holdings: [] },
          { quarter: '2026Q1', report_date: '2026-03-31', filing_date: '2026-05-15', accession: 'A1', csv_url: 'h/warren-buffett/2026Q1.csv', top_holdings: [] },
        ],
      });
    }
    if (url === `${SITE}data/h/warren-buffett/2026Q2.json`) {
      return Response.json({
        quarter: '2026Q2',
        holdings: [{ issuer: 'APPLE INC', ticker: 'AAPL', cusip: '037833100', title: 'COM', shares: 10, value: 2000, weight: 0.5, put_call: null, change: 'added', prev_shares: 4, share_change: 6, value_delta: 1200, pct_of_book: 0.3 }],
        exited: [{ issuer: 'BANK OF AMERICA', ticker: 'BAC', cusip: '060505104', title: 'COM', shares: 0, value: 0, weight: 0, put_call: null, change: 'exited', prev_shares: 5, share_change: -5, value_delta: -100, pct_of_book: -0.025 }],
      });
    }
    return new Response('not found', { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function webhook(event: unknown, secret = 'whsec_test') {
  const body = JSON.stringify(event);
  const t = now();
  const sig = await hmacHex(secret, `${t}.${body}`);
  return handleRequest(new Request('https://api.test/webhook', { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${sig}` } }), env);
}

function call(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  return handleRequest(
    new Request(`https://api.test${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      headers: { origin: 'https://refcell.github.io', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    }),
    env,
  );
}

function loginTokenFrom(text: string): string {
  return decodeURIComponent(text.match(/account\/\?login=([^\s]+)/)![1]);
}

/** Runs the minute cron as if at hh:mm UTC today (hour 3 is the digest hour, so avoided by default), or at a given time. */
async function cron(minute: number, at?: number) {
  const t = new Date(at ?? Date.now());
  if (at === undefined) t.setUTCHours(t.getUTCHours() === 3 ? 4 : t.getUTCHours(), minute, 0, 0);
  let pending: Promise<unknown> = Promise.resolve();
  await worker.scheduled({ scheduledTime: t.getTime() }, env, { waitUntil: (p) => (pending = p) });
  return pending;
}

const putMember = (c: string, email: string, status: string, alerts: unknown) =>
  env.DB.put(`cus:${c}`, JSON.stringify({ customer: c, email, status, plan: 'monthly', period_end: 0, subscription: `sub_${c}`, alerts, welcomed: true }));
const putFollows = (c: string, f: Record<string, unknown>) => env.DB.put(`follows:${c}`, JSON.stringify({ investors: [], stocks: [], owned: [], onboarded: true, ...f }));

describe('copybook api', () => {
  it('rejects webhooks signed with the wrong secret and grants nothing', async () => {
    const res = await webhook({ type: 'customer.subscription.created', data: { object: sub('sub_1', 'cus_1', 'active') } }, 'whsec_wrong');
    expect(res.status).toBe(400);
    expect(await env.DB.get('cus:cus_1')).toBeNull();
  });

  it('checkout -> welcome email -> sign in -> paid history and CSV -> cancel revokes', async () => {
    stripeObjects['subscriptions/sub_1'] = sub('sub_1', 'cus_1', 'active', 'year');
    const res = await webhook({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', customer_details: { email: 'Buyer@Example.com' } } } });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['buyer@example.com']);

    // Stripe retries and follow-up events must not send a second welcome.
    await webhook({ type: 'customer.subscription.updated', data: { object: sub('sub_1', 'cus_1', 'active', 'year') } });
    expect(sent).toHaveLength(1);

    const session = await (await call('/session', { body: { login: loginTokenFrom(sent[0].text) } })).json();
    expect(session.member).toMatchObject({ email: 'buyer@example.com', active: true, plan: 'copy', interval: 'yearly' });

    expect((await call('/history/warren-buffett')).status).toBe(401);
    const history = await (await call('/history/warren-buffett', { token: session.token })).json();
    expect(history.history_quarters).toEqual(['2026Q2', '2026Q1']);
    // Once the private index is in R2 it wins over the public file.
    hist.m.set('h/warren-buffett/index.json', new TextEncoder().encode(JSON.stringify({ slug: 'warren-buffett', history_quarters: ['2026Q2'], history: [] })));
    expect((await (await call('/history/warren-buffett', { token: session.token })).json()).history_quarters).toEqual(['2026Q2']);
    hist.m.delete('h/warren-buffett/index.json');

    const csv = await (await call('/csv/warren-buffett.csv', { token: session.token })).text();
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0].split(',')).toHaveLength(20);
    expect(lines[1]).toBe('Warren Buffett,warren-buffett,0001067983,2026Q2,2026-06-30,2026-08-14,A2,AAPL,APPLE INC,037833100,COM,,10,2000,0.5,added,4,6,1200,0.3');
    expect(lines[2]).toBe('Warren Buffett,warren-buffett,0001067983,2026Q2,2026-06-30,2026-08-14,A2,BAC,BANK OF AMERICA,060505104,COM,,0,0,0,exited,5,-5,-100,-0.025');
    expect(lines[3]).toBe('Warren Buffett,warren-buffett,0001067983,2026Q1,2026-03-31,2026-05-15,A1,BAC,"BANK, ""OF"" AMERICA",060505104,COM,,5,100,0.1,new,,5,100,0.1');
    expect(csv.match(/^manager,/gm)).toHaveLength(1);

    // The session token is never accepted from a URL.
    expect((await call(`/csv/warren-buffett.csv?token=${session.token}`)).status).toBe(401);
    expect((await call(`/me?token=${session.token}`)).status).toBe(401);

    // Download links: single use, one file, no session token in the URL.
    const link = (await (await call('/csv-link/warren-buffett', { method: 'POST', token: session.token })).json()).url as string;
    expect(link).toMatch(/^https:\/\/api\.test\/csv\/warren-buffett\.csv\?dl=/);
    expect(link).not.toContain(session.token);
    const dlPath = link.slice('https://api.test'.length);
    expect((await call(dlPath.replace('/warren-buffett.csv', '/bill-ackman.csv'))).status).toBe(401);
    expect(await (await call(dlPath)).text()).toBe(csv);
    expect((await call(dlPath)).status).toBe(401);
    const forged = dlPath.replace(/\.[^.]+$/, '.AAAA');
    expect((await call(forged)).status).toBe(401);

    // Handoff tokens sign in on another origin but are not session tokens.
    const handoff = (await (await call('/handoff', { method: 'POST', token: session.token })).json()).login as string;
    expect((await call('/me', { token: handoff })).status).toBe(401);
    expect((await (await call('/session', { body: { login: handoff } })).json()).member.email).toBe('buyer@example.com');

    const unusedLink = (await (await call('/csv-link/warren-buffett', { method: 'POST', token: session.token })).json()).url as string;

    const portal = await (await call('/portal', { method: 'POST', token: session.token })).json();
    expect(portal.url).toMatch(/^https:\/\/billing\.stripe\.com\//);

    await webhook({ type: 'customer.subscription.deleted', data: { object: sub('sub_1', 'cus_1', 'canceled', 'year') } });
    expect((await call('/csv/warren-buffett.csv', { token: session.token })).status).toBe(402);
    // A link minted before cancelling stops working once the plan ends.
    expect((await call(unusedLink.slice('https://api.test'.length))).status).toBe(402);
    expect((await call('/csv-link/warren-buffett', { method: 'POST', token: session.token })).status).toBe(402);
    // Billing stays reachable after cancelling, so they can resubscribe or fetch invoices.
    expect((await call('/portal', { method: 'POST', token: session.token })).status).toBe(200);
  });

  it('exchanges a completed checkout session for a session token right after redirect', async () => {
    stripeObjects['checkout/sessions/cs_test_abc'] = { id: 'cs_test_abc', status: 'complete', created: now() - 30, subscription: 'sub_2', customer_details: { email: 'fast@example.com' } };
    stripeObjects['subscriptions/sub_2'] = sub('sub_2', 'cus_2', 'active');
    const r = await (await call('/session', { body: { checkout_session: 'cs_test_abc' } })).json();
    expect(r.member).toMatchObject({ email: 'fast@example.com', active: true, plan: 'copy', interval: 'monthly' });
    expect((await call('/me', { token: r.token })).status).toBe(200);

    stripeObjects['checkout/sessions/cs_test_open'] = { id: 'cs_test_open', status: 'open', created: now(), subscription: null };
    expect((await call('/session', { body: { checkout_session: 'cs_test_open' } })).status).toBe(409);
  });

  it('login emails only active members but always answers ok', async () => {
    // subscription.created can arrive before checkout.session.completed: the email comes from the customer.
    stripeObjects['customers/cus_1'] = { id: 'cus_1', email: 'a@example.com' };
    await webhook({ type: 'customer.subscription.created', data: { object: sub('sub_1', 'cus_1', 'active') } });
    expect(sent.map((m) => m.to[0])).toEqual(['a@example.com']);
    sent = [];
    expect((await call('/login', { body: { email: 'nobody@example.com' } })).status).toBe(200);
    expect(sent).toHaveLength(0);
    expect((await call('/login', { body: { email: 'A@example.com' } })).status).toBe(200);
    expect(sent.map((m) => m.to[0])).toEqual(['a@example.com']);
  });

  it('cron alerts once per new reporting period, never on amendments, notices, stale or first-seen filings', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const Q2 = '2026-06-30';
    const Q3 = '2026-09-30';
    const mk = (slug: string, acc: string, report_date: string, extra: Record<string, unknown> = {}) => ({ ok: true, slug, accession: acc, manager: slug, name: `${slug} LP`, quarter: 'q', report_date, form: '13F-HR', filing_date: today, sec_url: `https://www.sec.gov/${acc}`, ...extra });
    await putMember('c1', 'all@example.com', 'active', 'all');
    await putMember('c2', 'ackman@example.com', 'active', ['bill-ackman']);
    await putMember('c3', 'off@example.com', 'active', 'off');
    await putMember('c4', 'gone@example.com', 'canceled', 'all');
    const run = () => cron(17);

    index = { managers: ['warren-buffett', 'bill-ackman', 'pershing-square-inc', 'dan-loeb', 'seth-klarman', 'david-tepper', 'chase-coleman'].map((s) => mk(s, `${s}-2`, Q2)) };
    await run();
    expect(sent).toHaveLength(0);

    const later = [
      mk('warren-buffett', 'A3', Q3), // new period: alert
      mk('bill-ackman', 'P3', Q3, { reported_by: 'pershing-square-inc' }), // one filing under two slugs: listed once
      mk('pershing-square-inc', 'P3', Q3), // the same filing as above
      mk('dan-loeb', 'L2b', Q2), // accession flip on an old period (amendment): no alert
      mk('seth-klarman', 'K3', Q3, { filing_date: '2026-08-01' }), // new period filed long ago: no alert
      mk('david-tepper', 'T3', Q3, { form: '13F-NT' }), // notice, not holdings: no alert, period not advanced
      mk('howard-marks', 'M3', Q3), // first seen: no alert
      mk('chase-coleman', 'C3', Q3, { form: '13F-HR/A' }), // amendment form: records the period, no alert
    ];
    index = { managers: later };
    await run();
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['ackman@example.com', 'all@example.com']);
    const all = sent.find((m) => m.to[0] === 'all@example.com')!.text;
    expect(all).toContain('warren-buffett LP');
    expect(all.match(/sec\.gov\/P3/g)).toHaveLength(1);
    for (const s of ['dan-loeb', 'seth-klarman', 'david-tepper', 'howard-marks', 'chase-coleman']) expect(all).not.toContain(s);
    const ackman = sent.find((m) => m.to[0] === 'ackman@example.com')!.text;
    expect(ackman).toContain('sec.gov/P3');
    expect(ackman).not.toContain('warren-buffett');

    // Tepper's real 13F-HR for Q3 arrives: alert. Buffett rolls back to Q2 and returns: no alert either way.
    sent = [];
    index = { managers: later.map((f) => (f.slug === 'david-tepper' ? mk('david-tepper', 'T3b', Q3) : f.slug === 'warren-buffett' ? mk('warren-buffett', 'A2', Q2) : f)) };
    await run();
    expect(sent.map((m) => m.to[0])).toEqual(['all@example.com']);
    expect(sent[0].text).toContain('david-tepper LP');
    expect(sent[0].text).not.toContain('warren-buffett');

    sent = [];
    index = { managers: later };
    await run();
    expect(sent).toHaveLength(0);
  });

  it('accepts history uploads only from the data workflow, and serves quarters only to members', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    jwks = { keys: [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'test-kid', alg: 'RS256' }] };
    const b64bytes = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const b64 = (v: unknown) => b64bytes(new TextEncoder().encode(JSON.stringify(v)));
    const jwt = async (claims: Record<string, unknown>, key = pair.privateKey) => {
      const head = `${b64({ alg: 'RS256', kid: 'test-kid' })}.${b64({ iss: 'https://token.actions.githubusercontent.com', aud: 'copybook-api', exp: now() + 300, workflow_ref: WORKFLOW, ...claims })}`;
      return `${head}.${b64bytes(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head))))}`;
    };
    const put = async (key: string, token: string) =>
      (await handleRequest(new Request(`https://api.test/ingest/${key}`, { method: 'PUT', body: '{"holdings":[]}', headers: { authorization: `Bearer ${token}` } }), env)).status;

    const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign'])) as CryptoKeyPair;
    expect(await put('h/bill-ackman/2026Q2.json', '')).toBe(401);
    expect(await put('h/bill-ackman/2026Q2.json', await jwt({}, other.privateKey))).toBe(401); // forged signature
    expect(await put('h/bill-ackman/2026Q2.json', await jwt({ workflow_ref: 'someone/fork/.github/workflows/copybook-data.yml@refs/heads/main' }))).toBe(401);
    expect(await put('h/bill-ackman/2026Q2.json', await jwt({ aud: 'https://github.com/refcell' }))).toBe(401);
    expect(await put('h/bill-ackman/2026Q2.json', await jwt({ exp: now() - 10 }))).toBe(401);
    expect(await put('index.json', await jwt({}))).toBe(400);
    expect(await put('h/bill-ackman/index.jsonx', await jwt({}))).toBe(400);
    expect(await put('h/bill-ackman/index.json', await jwt({}))).toBe(200);
    expect(await put('h/bill-ackman/2026Q2.v1.json', await jwt({}))).toBe(200);
    expect(await put('h/bill-ackman/2026Q2.v2.json', await jwt({}))).toBe(400);
    expect(await put('h/bill-ackman/2026Q2.v1.csv', await jwt({}))).toBe(400);
    expect(hist.m.has('h/bill-ackman/2026Q2.json')).toBe(false);
    expect(await put('h/bill-ackman/2026Q2.json', await jwt({}))).toBe(200);
    expect(new TextDecoder().decode(hist.m.get('h/bill-ackman/2026Q2.json'))).toBe('{"holdings":[]}');

    const token = (await (await call('/session', { body: { checkout_session: 'cs_test_q' } })).json()).token;
    expect(token).toBeUndefined(); // no session yet: /holdings must refuse
    expect((await call('/holdings/bill-ackman/2026Q2')).status).toBe(401);
    stripeObjects['checkout/sessions/cs_test_q'] = { id: 'cs_test_q', status: 'complete', created: now(), subscription: 'sub_q', customer_details: { email: 'q@example.com' } };
    stripeObjects['subscriptions/sub_q'] = sub('sub_q', 'cus_q', 'active');
    const s = await (await call('/session', { body: { checkout_session: 'cs_test_q' } })).json();
    const res = await call('/holdings/bill-ackman/2026Q2', { token: s.token });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"holdings":[]}');
    expect((await call('/holdings/nobody/2026Q2', { token: s.token })).status).toBe(404);
    await webhook({ type: 'customer.subscription.deleted', data: { object: sub('sub_q', 'cus_q', 'canceled') } });
    expect((await call('/holdings/bill-ackman/2026Q2', { token: s.token })).status).toBe(402);
  });

  it('follows: seeds from alerts, validates, keeps owned on the watchlist, drives alert targets, and is members-only', async () => {
    stripeObjects['checkout/sessions/cs_test_f'] = { id: 'cs_test_f', status: 'complete', created: now(), subscription: 'sub_f', customer_details: { email: 'f@example.com' } };
    stripeObjects['subscriptions/sub_f'] = sub('sub_f', 'cus_f', 'active');
    const t = (await (await call('/session', { body: { checkout_session: 'cs_test_f' } })).json()).token;
    const put = (b: unknown) => handleRequest(new Request('https://api.test/follows', { method: 'PUT', body: JSON.stringify(b), headers: { origin: 'https://refcell.github.io', authorization: `Bearer ${t}` } }), env);

    expect((await call('/follows')).status).toBe(401);
    await call('/alerts', { body: { alerts: ['warren-buffett'] }, token: t });
    expect((await (await call('/follows', { token: t })).json()).follows).toEqual({ investors: ['warren-buffett'], stocks: [], owned: [], onboarded: false, include_13g: false, digest: false });

    for (const bad of [{ investors: ['Not A Slug'] }, { stocks: ['$AAPL'] }, { owned: 'AAPL' }, { onboarded: 'yes' }, { digest: 1 }, { stocks: Array.from({ length: 501 }, (_, i) => `T${i}`) }]) {
      expect((await put(bad)).status).toBe(400);
    }
    const r = await (await put({ stocks: ['aapl', 'BRK.B'], owned: ['googl'], onboarded: true, include_13g: true })).json();
    expect(r.follows).toEqual({ investors: ['warren-buffett'], stocks: ['AAPL', 'BRK.B', 'GOOGL'], owned: ['GOOGL'], onboarded: true, include_13g: true, digest: false });

    // Any 13F filer can be followed, not only curated funds; a slug that is no filer is refused.
    const unknown = await put({ investors: ['warren-buffett', 'no-such-filer-1234'] });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).code).toBe('unknown_investor');
    expect((await put({ investors: ['warren-buffett', 'situational-awareness-lp-5724'] })).status).toBe(200);
    expect(JSON.parse((await env.DB.get('alerts:extra'))!)['0002045724'][0]).toMatchObject({ slug: 'situational-awareness-lp-5724', report_date: '2026-06-30', extra: true });

    // Followed investors become the alert targets while alerts is a list.
    await put({ investors: ['bill-ackman', 'dan-loeb'] });
    expect((await (await call('/me', { token: t })).json()).member.alerts).toEqual(['bill-ackman', 'dan-loeb']);
    // "all" stays the master switch.
    await call('/alerts', { body: { alerts: 'all' }, token: t });
    await put({ investors: ['seth-klarman'] });
    expect((await (await call('/me', { token: t })).json()).member.alerts).toBe('all');

    await webhook({ type: 'customer.subscription.deleted', data: { object: sub('sub_f', 'cus_f', 'canceled') } });
    expect((await call('/follows', { token: t })).status).toBe(402);
  });

  it('minute poll: emails a curated 13F within the minute with its moves, targeted by follows and watchlist, once', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const row = (slug: string, cik: string, extra: Record<string, unknown> = {}) => ({ ok: true, slug, cik, manager: slug === 'warren-buffett' ? 'Warren Buffett' : slug, name: 'Berkshire Hathaway Inc', featured: true, form: '13F-HR', accession: `${slug}-q2`, report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2', ...extra });
    index = { managers: [row('warren-buffett', '0001067983'), row('dan-loeb', '0001040273')] };
    await cron(17); // seeds periods and the CIK map
    expect(sent).toHaveLength(0);

    await putMember('f', 'follows@example.com', 'active', ['warren-buffett']);
    await putFollows('f', { investors: ['warren-buffett'], stocks: ['DHI'], owned: ['DHI'] });
    await putMember('w', 'watcher@example.com', 'active', []);
    await putFollows('w', { stocks: ['BAC'] });
    await putMember('n', 'nobody@example.com', 'active', []);
    await putFollows('n', { investors: ['dan-loeb'], stocks: ['MSFT'] });

    const acc = '0000950123-26-011111';
    const entry = (form: string, cik: string, a: string, name: string) =>
      `<entry><title>${form} - ${name} (${cik}) (Filer)</title><updated>${today}T16:05:00-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="${form}"/><id>urn:tag:sec.gov,2008:accession-number=${a}</id></entry>`;
    // Dan Loeb's book is too big to diff in the Worker: alerted at once, moves follow from the data run.
    const big = '0000950123-26-044444';
    const bigDir = `Archives/edgar/data/1040273/${big.replace(/-/g, '')}/`;
    secFiles[`${bigDir}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '5000' }, { name: 'table.xml', size: '900000' }] } });
    secFiles[`${bigDir}primary_doc.xml`] = '<periodOfReport>09-30-2026</periodOfReport>';
    secFiles.feed = `<feed>${entry('13F-HR', '0001040273', big, 'THIRD POINT')}${entry('13F-HR', '0001067983', acc, 'BERKSHIRE')}${entry('13F-HR/A', '0001067983', '0000950123-26-022222', 'BERKSHIRE')}${entry('13F-HR', '0009999999', '0000950123-26-033333', 'SOMEONE ELSE')}</feed>`;
    const dir = `Archives/edgar/data/1067983/${acc.replace(/-/g, '')}/`;
    secFiles[`${dir}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '5000' }, { name: '9999.xml', size: '4000' }] } });
    secFiles[`${dir}primary_doc.xml`] = '<edgarSubmission><periodOfReport>09-30-2026</periodOfReport></edgarSubmission>';
    const it = (name: string, cusip: string, value: number, shares: number, pc = '') =>
      `<ns1:infoTable><ns1:nameOfIssuer>${name}</ns1:nameOfIssuer><ns1:cusip>${cusip}</ns1:cusip><ns1:value>${value}</ns1:value><ns1:shrsOrPrnAmt><ns1:sshPrnamt>${shares}</ns1:sshPrnamt></ns1:shrsOrPrnAmt>${pc && `<ns1:putCall>${pc}</ns1:putCall>`}</ns1:infoTable>`;
    // AAPL trimmed 100 -> 80 shares; DHI new, filed on two lines; an AAPL call is a separate new position; BAC exited.
    secFiles[`${dir}9999.xml`] = `<ns1:informationTable>${it('APPLE INC', '037833100', 16000, 80)}${it('D R HORTON INC', '23331A109', 3000, 30)}${it('D R HORTON INC', '23331a109', 1000, 10)}${it('APPLE INC', '037833100', 500, 10, 'CALL')}</ns1:informationTable>`;
    hist.m.set('h/warren-buffett/2026Q2.json', new TextEncoder().encode(JSON.stringify({ holdings: [{ cusip: '037833100', put_call: null, issuer: 'APPLE INC', ticker: 'AAPL', shares: 100, value: 20000 }, { cusip: '060505104', put_call: null, issuer: 'BANK OF AMERICA', ticker: 'BAC', shares: 50, value: 2000 }] })));

    await cron(5);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['follows@example.com', 'nobody@example.com', 'watcher@example.com']);
    expect((await (await call('/health')).json()).alert_latency).toHaveLength(2);
    const loeb = sent.find((m) => m.to[0] === 'nobody@example.com')!;
    expect(loeb.text).toContain('A second email with its position changes follows');
    expect(loeb.text).not.toContain('warren-buffett');
    const mail = sent.find((m) => m.to[0] === 'follows@example.com')!;
    expect(mail.subject).toBe('Buffett Q3: NEW DHI · AAPL -$4K · EXIT BAC');
    // The HTML part lays the moves out as a table, with how much of the position was sold.
    expect(mail.html).toMatch(/<table[^>]*>.*<th[^>]*>Move<\/th>.*<td[^>]*>Trimmed<\/td><td[^>]*><b>AAPL<\/b><\/td><td[^>]*>-\$4K<\/td><td[^>]*>sold 20%<\/td>/);
    expect(mail.html).toContain('Accession 0000950123-26-011111, accepted by EDGAR');
    // Total book 20,500: DHI +4,000 is 19.5%; the AAPL trim is 20 shares at $200 = -4,000; BAC exits at its prior $2,000.
    expect(mail.text).toContain('Bought $5K, sold $6K this quarter.');
    expect(mail.text).toContain('New: DHI +$4K (19.5% of book) [you own], AAPL calls +$1K (2.4% of book)');
    expect(mail.text).toContain('Trimmed: AAPL -$4K (sold 20% of the position, 19.5% of book)');
    expect(mail.text).toContain('Exited: BAC -$2K (9.8% of book)');
    expect(mail.text).toContain('Of the positions that changed, 1 is a stock you own.');
    expect(mail.text).toContain('https://refcell.github.io/gust/copybook/investors/warren-buffett');
    expect(sent.find((m) => m.to[0] === 'watcher@example.com')!.text).toContain('Exited: BAC -$2K (9.8% of book) [watchlist]');
    const latency = JSON.parse((await env.DB.get('alerts:latency'))!);
    expect(latency.map((l: { slug: string }) => l.slug).sort()).toEqual(['dan-loeb', 'warren-buffett']);

    // Still in the feed next minute, and then in the data run's index: never sent twice.
    sent = [];
    await cron(6);
    index = { managers: [row('warren-buffett', '0001067983', { accession: acc, report_date: '2026-09-30', filing_date: today, quarter: '2026Q3' }), row('dan-loeb', '0001040273', { accession: big, report_date: '2026-09-30', filing_date: today, quarter: '2026Q3' })] };
    await cron(17);
    expect(sent).toHaveLength(0); // the data run has no moves for Loeb yet

    const mv = (ticker: string, value_delta: number) => ({ ticker, display_name: null, issuer: ticker, cusip: 'X', put_call: null, shares: 1, prev_shares: 0, value: value_delta, value_delta, pct_of_book: 0.012 });
    recentMoves = [{ accession: big, moves: { bought_usd: 3e8, sold_usd: 0, new: [mv('MSFT', 3e8)], added: [], trimmed: [], exited: [] } }];
    await cron(17);
    expect(sent.map((m) => m.to[0])).toEqual(['nobody@example.com']);
    expect(sent[0].subject).toBe('dan-loeb Q3 changes: NEW MSFT');
    expect(sent[0].text).toContain('New: MSFT +$300.0M (1.2% of book) [watchlist]');
    sent = [];
    await cron(17);
    expect(sent).toHaveLength(0);
  });

  it('between-quarter alerts: Form 4 buys/sells and 13D by default, 13G opt-in, fresh only, digest members get one email at night', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
    const ev = (id: string, kind: string, action: string, extra: Record<string, unknown> = {}) => ({ id, slug: 'warren-buffett', manager: 'Warren Buffett', form: kind === 'form4' ? '4' : kind === '13d' ? 'SCHEDULE 13D/A' : 'SCHEDULE 13G', kind, action, filing_date: today, url: `https://www.sec.gov/${id}`, issuer: 'SIRIUS XM', display_name: 'Sirius XM', ticker: 'SIRI', shares: 1000, value_usd: 25000, avg_price: 25, shares_after: null, percent_of_class: null, ...extra });
    events = [ev('seed', 'form4', 'buy')];
    await cron(47); // first run only records
    await putMember('a', 'a@example.com', 'active', ['warren-buffett']);
    await putFollows('a', { investors: ['warren-buffett'] });
    await putMember('g', 'g@example.com', 'active', ['warren-buffett']);
    await putFollows('g', { investors: ['warren-buffett'], include_13g: true });
    await putMember('d', 'd@example.com', 'active', ['warren-buffett']);
    await putFollows('d', { investors: ['warren-buffett'], digest: true });
    events = [ev('seed', 'form4', 'buy'), ev('F4', 'form4', 'buy'), ev('G1', '13g', 'new_stake', { percent_of_class: 5.2 }), ev('D1', '13d', 'stake_update', { filing_date: old }), ev('X1', 'form4', 'other')];
    await cron(47);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['a@example.com', 'g@example.com']);
    const a = sent.find((m) => m.to[0] === 'a@example.com')!.text;
    expect(a).toContain('Form 4: Warren Buffett bought 1,000 shares of SIRI ($25K, avg $25.00)');
    for (const no of ['sec.gov/G1', 'sec.gov/D1', 'sec.gov/X1', 'sec.gov/seed']) expect(a).not.toContain(no);
    expect(sent.find((m) => m.to[0] === 'g@example.com')!.text).toContain('Schedule 13G: Warren Buffett disclosed a new stake in SIRI, 5.2% of the class');

    sent = [];
    await cron(47);
    expect(sent).toHaveLength(0);
    // 03:32 UTC after this ET day ends, once EDGAR has closed: the digest.
    const day = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
    await cron(32, Date.parse(`${day}T03:32:00Z`) + 86400_000);
    expect(sent.map((m) => m.to[0])).toEqual(['d@example.com']);
    expect(sent[0].subject).toMatch(/^Copybook daily digest for \d{4}-\d{2}-\d{2}: 1 Form 4\/13D\/G$/);
  });

  it('Copy Pro: keys only for Pro, shown once, /v1 needs an active Pro key, rate limits with standard headers, revoke works', async () => {
    let clock = Date.parse('2026-11-09T15:00:10Z');
    env.METER = memMeters(() => clock);
    const session = async (c: string, lookup: string, interval = 'month') => {
      stripeObjects[`checkout/sessions/cs_test_${c}`] = { id: `cs_test_${c}`, status: 'complete', created: now(), subscription: `sub_${c}`, customer_details: { email: `${c}@example.com` } };
      stripeObjects[`subscriptions/sub_${c}`] = sub(`sub_${c}`, `cus_${c}`, 'active', interval, lookup);
      return (await (await call('/session', { body: { checkout_session: `cs_test_${c}` } })).json()) as { token: string; member: { plan: string } };
    };
    const copy = await session('copy1', 'copy_monthly');
    const pro = await session('pro1', 'pro_yearly', 'year');
    const fund = await session('fund1', 'fund_monthly');
    expect([copy.member.plan, pro.member.plan, fund.member.plan]).toEqual(['copy', 'pro', 'fund']);

    expect((await call('/keys', { method: 'POST', body: { name: 'x' }, token: copy.token })).status).toBe(403);
    const made = await (await call('/keys', { body: { name: 'research box' }, token: pro.token })).json();
    expect(made.key).toMatch(/^cbk_live_[A-Za-z0-9_-]{43}$/);
    const listed = await (await call('/keys', { token: pro.token })).json();
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0].last_used_at).toBeNull();
    expect(JSON.stringify(listed)).not.toContain(made.key); // the secret is never shown again
    expect(JSON.stringify([...(env.DB as unknown as { m: Map<string, string> }).m.values()])).not.toContain(made.key); // nor stored
    expect((await call('/keys', { body: {}, token: fund.token })).status).toBe(201); // Fund includes Pro

    const v1 = (path: string, key?: string) => handleRequest(new Request(`https://api.test${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }), env);
    const noKey = await v1('/v1/me');
    expect(noKey.status).toBe(401);
    expect(await noKey.json()).toMatchObject({ schema_version: expect.any(String), error: { code: 'unauthorized' } });
    expect((await (await v1('/v1/me', 'cbk_live_' + 'x'.repeat(43))).json()).error.code).toBe('invalid_key');
    expect((await (await v1('/v1/me', made.key)).json()).error).toBeUndefined();
    // A session token is not an API key.
    expect((await (await v1('/v1/me', pro.token)).json()).error.code).toBe('invalid_key');

    // 60 a minute per key: the 2nd call above was #1, so 59 more pass, then 429 with Retry-After until the minute rolls.
    for (let i = 0; i < 58; i++) expect((await v1('/v1/me', made.key)).status).toBe(200);
    const last = await v1('/v1/me', made.key);
    expect(last.headers.get('RateLimit-Limit')).toBe('60');
    expect(last.headers.get('RateLimit-Remaining')).toBe('0');
    const limited = await v1('/v1/me', made.key);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe('rate_limited');
    expect(limited.headers.get('Retry-After')).toBe('50');
    clock += 60_000;
    const next = await v1('/v1/me', made.key);
    expect(next.status).toBe(200);
    const nextBody = await next.json();
    expect(nextBody.data.usage[0]).toEqual({ day: '2026-11-09', requests: 61 }); // only allowed requests count
    expect(nextBody.data.key.last_used_at).toBe('2026-11-09T15:01:10.000Z');
    expect((await (await call('/keys', { token: pro.token })).json()).keys.find((k: { id: string }) => k.id === made.id).last_used_at).toBe('2026-11-09T15:01:10.000Z');

    const spec = await (await v1('/v1/openapi.json')).json();
    expect(spec.openapi).toBe('3.1.0');

    expect((await call(`/keys/${made.id}`, { method: 'DELETE', token: pro.token })).status).toBe(200);
    expect((await (await v1('/v1/me', made.key)).json()).error.code).toBe('invalid_key');

    // Downgrade to Copy: Pro keys stop working.
    const k2 = (await (await call('/keys', { body: {}, token: pro.token })).json()).key;
    await webhook({ type: 'customer.subscription.updated', data: { object: sub('sub_pro1', 'cus_pro1', 'active', 'month', 'copy_monthly') } });
    expect((await (await v1('/v1/me', k2)).json()).error.code).toBe('pro_required');
  });

  it('stock alerts only through active managers; follows without a chosen scope move "all" to followed funds once, with a note', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const row = (slug: string, cik: string, featured: boolean, type?: string) => ({ ok: true, slug, cik, manager: slug, name: slug, featured, type, form: '13F-HR', accession: `${slug}-q2`, report_date: '2026-06-30', filing_date: '2026-08-14' });
    index = { managers: [row('warren-buffett', '1', true), row('big-bank', '2', false, 'bank'), row('dan-loeb', '3', true), row('quiet-hf', '4', false, 'hedge_fund')] };
    events = [];
    await cron(17); // CIK map with featured flags and types
    await cron(47); // seed event state

    await putMember('w', 'watcher@example.com', 'active', []);
    await putFollows('w', { stocks: ['NVDA'] });
    await putMember('m', 'migrate@example.com', 'active', 'all');
    await putFollows('m', { investors: ['dan-loeb'] });
    await putMember('c', 'chosen@example.com', 'active', 'all');
    await env.DB.put('cus:c', JSON.stringify({ ...JSON.parse((await env.DB.get('cus:c'))!), alerts_chosen: true }));
    await putFollows('c', { investors: ['dan-loeb'] });

    const ev = (id: string, slug: string, ticker: string) => ({ id, slug, manager: slug, form: '4', kind: 'form4', action: 'buy', filing_date: today, url: `https://www.sec.gov/${id}`, issuer: ticker, display_name: ticker, ticker, shares: 10, value_usd: 1000, avg_price: 100, shares_after: 20, percent_of_class: null });
    events = [ev('B1', 'big-bank', 'NVDA'), ev('W1', 'warren-buffett', 'NVDA'), ev('Q1', 'quiet-hf', 'NVDA'), ev('L1', 'dan-loeb', 'AGX')];
    await cron(47);
    const to = (e: string) => sent.find((m) => m.to[0] === e)?.text ?? '';
    // A watched stock alerts through Buffett (featured) and a hedge fund, never through a bank.
    expect(to('watcher@example.com')).toContain('sec.gov/W1');
    expect(to('watcher@example.com')).toContain('sec.gov/Q1');
    expect(to('watcher@example.com')).not.toContain('sec.gov/B1');
    // "all" with follows and no chosen scope -> followed funds only, said once.
    expect(to('migrate@example.com')).toContain('sec.gov/L1');
    expect(to('migrate@example.com')).not.toContain('sec.gov/W1');
    expect(to('migrate@example.com')).toContain('you now get alerts only for the 1 fund you follow');
    expect(JSON.parse((await env.DB.get('cus:m'))!)).toMatchObject({ alerts: ['dan-loeb'] });
    // A member who chose "all" keeps it.
    expect(to('chosen@example.com')).toContain('sec.gov/B1');

    sent = [];
    events = [...events, ev('L2', 'dan-loeb', 'AGX')];
    await cron(47);
    expect(to('migrate@example.com')).toContain('sec.gov/L2');
    expect(to('migrate@example.com')).not.toContain('you now get alerts only');
  });

  it('follows of any 13F filer alert within the minute: moves against its prior quarter, else its largest holdings; never to "every investor"', async () => {
    const today = new Date().toISOString().slice(0, 10);
    index = { managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, form: '13F-HR', accession: 'q2', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }] };
    await cron(17);
    filers.push({ cik: '0001541617', name: 'Altimeter Capital Management, LP', slug: 'altimeter-capital-management-lp-1617', ok: true, quarter: '2026Q2' });
    expect(await resolveFollowedFilers(env, ['situational-awareness-lp-5724', 'altimeter-capital-management-lp-1617'])).toEqual([]);
    await putMember('s', 'sa@example.com', 'active', ['situational-awareness-lp-5724', 'altimeter-capital-management-lp-1617']);
    await putFollows('s', { investors: ['situational-awareness-lp-5724', 'altimeter-capital-management-lp-1617'] });
    await putMember('all', 'all@example.com', 'active', 'all');
    // Its Q2 book from the all-filer shard is the baseline: NVDA trimmed 100 -> 60, BE exited, MU new.
    shards['0002045724.json'] = { report_date: '2026-06-30', columns: ['ticker', 'issuer', 'title', 'cusip', 'put_call', 'shares', 'value', 'display_name', 'sector'], rows: [['NVDA', 'NVIDIA CORP', 'COM', '67066G104', null, 100, 18000, 'Nvidia', null], ['BE', 'BLOOM ENERGY CORP', 'COM CL A', '093712107', null, 50, 5000, 'Bloom Energy', null]] };
    const sa = '0000935836-26-000555';
    const alt = '0001541617-26-000009';
    const e = (cik: string, a: string, name: string) => `<entry><title>13F-HR - ${name} (${cik}) (Filer)</title><updated>${today}T16:05:00-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="13F-HR"/><id>urn:tag:sec.gov,2008:accession-number=${a}</id></entry>`;
    // A Berkshire filing that throws while being read must not hold back the others.
    const bad = '0000950123-26-099999';
    secFiles[`Archives/edgar/data/1067983/${bad.replace(/-/g, '')}/index.json`] = 'not json';
    secFiles.feed = `<feed>${e('0001067983', bad, 'BERKSHIRE')}${e('0002045724', sa, 'Situational Awareness LP')}${e('0001541617', alt, 'Altimeter')}</feed>`;
    const it = (name: string, cusip: string, value: number, shares: number) => `<infoTable><nameOfIssuer>${name}</nameOfIssuer><cusip>${cusip}</cusip><value>${value}</value><shrsOrPrnAmt><sshPrnamt>${shares}</sshPrnamt></shrsOrPrnAmt></infoTable>`;
    for (const [cik, a, table] of [
      ['2045724', sa, `${it('NVIDIA CORP', '67066G104', 12000, 60)}${it('MICRON TECHNOLOGY INC', '595112103', 9000, 40)}`],
      ['1541617', alt, `${it('SNOWFLAKE INC', '833445109', 70000, 300)}${it('NVIDIA CORP', '67066G104', 90000, 450)}`],
    ]) {
      const dir = `Archives/edgar/data/${cik}/${a.replace(/-/g, '')}/`;
      secFiles[`${dir}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '5000' }, { name: 'info.xml', size: '4000' }] } });
      secFiles[`${dir}primary_doc.xml`] = '<edgarSubmission><periodOfReport>09-30-2026</periodOfReport></edgarSubmission>';
      secFiles[`${dir}info.xml`] = `<informationTable>${table}</informationTable>`;
    }
    sent = [];
    await cron(5);
    expect(sent.map((m) => m.to[0])).toEqual(['sa@example.com']);
    const t = sent[0].text;
    expect(t).toMatch(/Situational Awareness LP[^\n]*Q3 2026 13F/);
    expect(t).toMatch(/New: MICRON[^\n]*\+\$9K/);
    expect(t).toMatch(/Trimmed: NVDA -\$8K/); // 40 shares sold at this quarter's $200
    expect(t).toMatch(/Exited: BE -\$5K/);
    expect(t).toContain('investors/situational-awareness-lp-5724');
    // No earlier quarter for Altimeter: its largest holdings, NVDA first.
    expect(t).toMatch(/Largest holdings:\n\s+NVIDIA CORP \$90K, SNOWFLAKE INC \$70K/);
    const handled = JSON.parse((await env.DB.get('alerts:handled'))!) as string[];
    expect(handled).toEqual(expect.arrayContaining([sa, alt]));
    expect(handled).not.toContain(bad); // retried next minute
    sent = [];
    await cron(6);
    expect(sent).toHaveLength(0);
  });

  it('minute event poll: Form 4 per class from a curated filer, any filer\'s 13D/A on an owned stock with the change, unread filings alerted at once and completed later', async () => {
    const today = new Date().toISOString().slice(0, 10);
    index = { managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, form: '13F-HR', accession: 'q2', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }, { ok: true, slug: 'carl-icahn', cik: '0000921669', manager: 'Carl Icahn', name: 'Icahn Carl C', featured: true, form: '13F-HR', accession: 'q2i', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }] };
    await cron(17); // CIK map
    await putMember('b', 'buffett@example.com', 'active', ['warren-buffett']);
    await putFollows('b', { investors: ['warren-buffett'] });
    await putMember('o', 'owner@example.com', 'active', []);
    await putFollows('o', { stocks: ['CVI'], owned: ['CVI'] });
    await putMember('x', 'other@example.com', 'active', []);
    await putFollows('x', { stocks: ['MSFT'] });
    secFiles['files/company_tickers.json'] = JSON.stringify({ 0: { cik_str: 1376139, ticker: 'CVI' }, 1: { cik_str: 789019, ticker: 'MSFT' } });
    await cron(52); // watch map: CVR Energy -> CVI
    // The poll's first run only records what is already in the feeds.
    const before = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const old = '0001193125-26-300000';
    const e = (form: string, cik: string, acc: string, name: string, role: string, at = before(4)) =>
      `<entry><title>${form} - ${name} (${cik}) (${role})</title><updated>${at}</updated><category scheme="https://www.sec.gov/" label="form type" term="${form}"/><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
    secFiles['feed:4'] = `<feed>${e('4', '0001067983', old, 'BERKSHIRE', 'Reporting', before(60))}</feed>`;
    await cron(4);
    expect(sent).toHaveLength(0);
    sent = [];
    const len = '0001193125-26-400001';
    const unread = '0001193125-26-400002';
    const cvi = '0001193125-26-451979';
    const prev = '0001193125-26-445965';
    // A Form 4 accepted 2 days ago (new to the poll, say after an outage) is not news: digest only.
    const stale = '0001193125-26-300001';
    secFiles['feed:4'] = `<feed>${e('4', '0001067983', stale, 'BERKSHIRE', 'Reporting', before(48 * 60))}${e('4', '0001067983', len, 'BERKSHIRE', 'Reporting')}${e('4', '0000920760', len, 'LENNAR', 'Issuer')}${e('4', '0001067983', unread, 'BERKSHIRE', 'Reporting')}${e('4', '0000111111', '0001193125-26-400003', 'SOMEONE', 'Reporting')}</feed>`;
    secFiles['feed:SCHEDULE 13'] = `<feed>${e('SCHEDULE 13D/A', '0000921669', cvi, 'ICAHN CARL C', 'Filed by')}${e('SCHEDULE 13D/A', '0001376139', cvi, 'CVR ENERGY', 'Subject')}${e('SCHEDULE 13G', '0000222222', '0001193125-26-400004', 'OTHER', 'Filed by')}${e('SCHEDULE 13G', '0000333333', '0001193125-26-400004', 'UNWATCHED CO', 'Subject')}</feed>`;
    const dir = (cik: string, acc: string) => `Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/`;
    secFiles[`${dir('0001067983', len)}index.json`] = JSON.stringify({ directory: { item: [{ name: 'wk-form4.xml' }] } });
    secFiles[`${dir('0001067983', len)}wk-form4.xml`] = form4Len;
    const cur = sc13dCvi;
    secFiles[`${dir('0000921669', cvi)}primary_doc.xml`] = cur;
    // The previous amendment held the same 71,201,875 shares at 70.8%: diluted, nothing sold.
    secFiles[`${dir('0001376139', prev)}primary_doc.xml`] = cur.replace(/64\.1/g, '70.8').replace(/<amendmentNo>41/, '<amendmentNo>40');
    secFiles['company:0001376139'] = `<feed>${e('SCHEDULE 13D/A', '0001376139', cvi, 'CVR', 'Subject')}${e('SCHEDULE 13D/A', '0001376139', prev, 'CVR', 'Subject')}</feed>`;

    await cron(5);
    const to = (a: string) => sent.filter((m) => m.to[0] === a).map((m) => m.text).join('\n');
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['buffett@example.com', 'owner@example.com']);
    const b = to('buffett@example.com');
    // Class A and Class B are reported separately, never summed.
    expect(b).toMatch(/Class A[^\n]*26\.03M → 28\.44M shares/);
    expect(b).toMatch(/Class B[^\n]*553\.0K → 568\.0K shares/);
    expect(b).not.toContain('29,006,073');
    expect(b).toContain(`Form 4: Warren Buffett. Details follow`); // unread: alerted with what the feed says
    expect(b).not.toContain('CVI');
    expect(b).not.toContain(stale);
    expect(b).not.toContain(old);
    const o = to('owner@example.com');
    expect(o).toContain('Schedule 13D/A (amendment 41)');
    expect(o).toContain('70.8% → 64.1% of the class; 71,201,875 shares (unchanged) (diluted, no shares sold)');
    expect(o).toContain(cvi);
    expect(o).not.toContain('its stake');
    expect(sent.find((m) => m.to[0] === 'owner@example.com')!.subject).toBe('Icahn CVI 13D/A: 70.8% → 64.1% (diluted, no shares sold)');
    expect(sent.find((m) => m.to[0] === 'buffett@example.com')!.subject).toBe('Buffett LEN Form 4: bought $192.6M + 1 more');
    expect(sent.find((m) => m.to[0] === 'buffett@example.com')!.html).toMatch(/Class A Common Stock<\/td><td[^>]*>2\.40M<\/td><td[^>]*>—<\/td><td[^>]*>26\.03M<\/td><td[^>]*>28\.44M<\/td>/);

    // Next minute: nothing is sent twice.
    sent = [];
    await cron(6);
    expect(sent).toHaveLength(0);
    // Tonight the stale one reaches the member as an earlier filing they may have missed.
    await runDigest(env, Date.now());
    expect(sent.map((m) => m.to[0])).toEqual(['buffett@example.com']);
    expect(sent[0].subject).toBe('Copybook: 1 earlier filing you may have missed');
    expect(sent[0].text).toContain(stale);
    expect(sent[0].text).not.toContain(len);
    expect(JSON.parse((await env.DB.get('alerts:latency'))!).map((l: { accession: string }) => l.accession)).not.toContain(stale);
    sent = [];

    // The data run later carries the unread filing: a follow-up goes out; the LEN one is not repeated.
    const ev = (id: string) => ({ id, slug: 'warren-buffett', manager: 'Warren Buffett', form: '4', kind: 'form4', action: 'buy', filing_date: today, url: `https://www.sec.gov/${id}`, issuer: 'SIRIUS XM', display_name: null, ticker: 'SIRI', shares: 1000, value_usd: 25000, avg_price: 25, shares_after: null, percent_of_class: null });
    events = [ev('seed')];
    await cron(47);
    events = [ev('seed'), ev(len), ev(unread)];
    await cron(47);
    expect(sent.map((m) => m.to[0])).toEqual(['buffett@example.com']);
    expect(sent[0].text).toContain(unread);
    expect(sent[0].text).not.toContain(len);
    expect(sent[0].text).toContain('bought 1,000 shares of SIRI');
  });

  it('fund requests: public, validated, honeypot, rate-limited, stored and acknowledged; /latency reports the season without replays', async () => {
    const post = (b: unknown, ip = '1.2.3.4') => handleRequest(new Request('https://api.test/fund-request', { method: 'POST', body: JSON.stringify(b), headers: { origin: 'https://refcell.github.io', 'cf-connecting-ip': ip } }), env);
    const ok = { topic: 'fund', name: 'Pat', email: 'Pat@Fund.example', fund: 'Pat Capital', seats: 5, invoice: true, plan_interval: 'yearly', message: 'Annual please', page: '/pricing/' };
    for (const bad of [{ ...ok, email: 'nope' }, { ...ok, topic: 'sales' }, { ...ok, seats: 0 }, { ...ok, seats: 2.5 }, { ...ok, invoice: 'yes' }]) expect((await post(bad)).status).toBe(400);
    const r = await post(ok);
    expect(r.status).toBe(200);
    const leads = (await env.DB.list({ prefix: 'lead:' })).keys;
    expect(leads).toHaveLength(1);
    expect(JSON.parse((await env.DB.get(leads[0].name))!)).toMatchObject({ topic: 'fund', email: 'pat@fund.example', seats: 5, invoice: true, plan_interval: 'yearly', message: 'Annual please' });
    expect(sent.map((m) => m.to[0])).toEqual(['pat@fund.example']);
    expect(sent[0].text).toContain('annual invoice quote');
    // A bot filling the hidden field gets a quiet 200 and nothing is stored or sent.
    sent = [];
    expect((await post({ ...ok, email: 'bot@x.example', website: 'http://spam' })).status).toBe(200);
    expect((await env.DB.list({ prefix: 'lead:' })).keys).toHaveLength(1);
    expect(sent).toHaveLength(0);
    // Three per address an hour.
    await post(ok, '5.5.5.5');
    await post(ok, '6.6.6.6');
    expect((await post(ok, '7.7.7.7')).status).toBe(429);
    expect((await (await call('/health')).json()).fund_requests).toBe(3);

    const t = Date.now();
    const row = (acc: string, seconds: number, extra: Record<string, unknown> = {}) => ({ slug: 'warren-buffett', manager: 'Warren Buffett', quarter: '2026Q3', kind: '13f', accession: acc, accepted: new Date(t - seconds * 1000).toISOString(), sent: new Date(t).toISOString(), seconds, ...extra });
    // Newest first, as logged; one replay; one from last season.
    await env.DB.put('alerts:latency', JSON.stringify([row('A1', 40), row('R1', 163146, { replay: true }), row('A2', 100, { kind: 'form4', form: '4' }), row('A3', 60), row('OLD', 5, { sent: '2025-01-02T00:00:00Z' })]));
    const lat = await (await call('/latency')).json();
    expect(lat).toMatchObject({ count: 3, median_seconds: 60, p95_seconds: 100 });
    expect(lat.alerts.map((a: { accession: string }) => a.accession)).toEqual(['A1', 'A2', 'A3']);
    expect(lat.alerts[1]).toMatchObject({ form: '4', gap_seconds: 100, manager: 'Warren Buffett' });
    expect(lat.alerts[0].form).toBe('13F-HR');
  });

  it('deadline-day coverage: pages back through a burst, finds a missed filing in its filer feed; replays never count in /health; new members default to follows', async () => {
    const row = (slug: string, cik: string, featured = true) => ({ ok: true, slug, cik, manager: slug, name: slug, featured, form: '13F-HR', accession: `${slug}-q2`, report_date: '2026-06-30', filing_date: '2026-08-14' });
    index = { managers: [row('warren-buffett', '0001067983'), row('dan-loeb', '0001040273')] };
    await cron(17);
    await putMember('a', 'all@example.com', 'active', 'all');
    await env.DB.put('cus:a', JSON.stringify({ ...JSON.parse((await env.DB.get('cus:a'))!), alerts_chosen: true }));

    const t = new Date();
    t.setUTCHours(t.getUTCHours() === 3 ? 4 : t.getUTCHours(), 30, 0, 0);
    const at = (minAgo: number) => new Date(t.getTime() - minAgo * 60_000).toISOString();
    const entry = (cik: string, acc: string, accepted: string, name = 'X') =>
      `<entry><title>13F-HR - ${name} (${cik}) (Filer)</title><updated>${accepted}</updated><category term="13F-HR"/><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
    const filing = (cik: string, acc: string) => {
      const dir = `Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/`;
      secFiles[`${dir}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '5000' }, { name: 't.xml', size: '900000' }] } });
      secFiles[`${dir}primary_doc.xml`] = '<periodOfReport>09-30-2026</periodOfReport>';
    };
    // A burst: page 1 is 100 unrelated filings from the last 2 minutes; Buffett's is on page 2.
    const noise = (start: number) => Array.from({ length: 100 }, (_, i) => entry('0009' + String(start + i).padStart(6, '0'), `0009999999-26-${String(start + i).padStart(6, '0')}`, at(1))).join('');
    secFiles.feed = `<feed>${noise(0)}</feed>`;
    secFiles['feed@100'] = `<feed>${entry('0001067983', '0000950123-26-000001', at(3), 'BERKSHIRE')}${noise(100).slice(0, 2000)}</feed>`;
    filing('0001067983', '0000950123-26-000001');
    // Loeb's filing never shows in the paged window (a failed poll long ago); only its company feed has it.
    filing('0001040273', '0000950123-26-000002');
    for (const cik of ['0001040273']) secFiles[`company:${cik}`] = `<feed>${entry(cik, '0000950123-26-000002', at(40))}</feed>`;
    await env.DB.put('alerts:replays', JSON.stringify(['0000950123-26-000002']));

    await cron(30, t.getTime());
    const text = sent.map((m) => m.text).join('\n');
    expect(text).toContain('0000950123-26-000001'.replace(/-/g, '')); // paged
    expect(text).toContain('0000950123-26-000002'.replace(/-/g, '')); // company-feed backstop
    const health = await (await call('/health')).json();
    expect(health.alert_latency.map((l: { slug: string }) => l.slug)).toEqual(['warren-buffett']);
    expect(health.replays_excluded).toBe(1);
    expect(health.alert_latency_summary.count).toBe(1);

    // A brand-new subscriber starts on followed funds (an empty list), not every fund.
    stripeObjects['checkout/sessions/cs_test_new'] = { id: 'cs_test_new', status: 'complete', created: now(), subscription: 'sub_new', customer_details: { email: 'new@example.com' } };
    stripeObjects['subscriptions/sub_new'] = sub('sub_new', 'cus_new', 'active');
    const s = await (await call('/session', { body: { checkout_session: 'cs_test_new' } })).json();
    expect(s.member.alerts).toEqual([]);
  });

  it('rotation reaches every curated filer and featured ones more often', async () => {
    const { rotation } = await import('../src/alerts');
    const ciks = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i).padStart(10, '0'), [{ slug: `s${i}`, manager: '', name: '', cik: '', featured: i < 4 }]]));
    const seen = new Map<string, number>();
    for (let m = 0; m < 7; m++) for (const c of rotation(ciks, m)) seen.set(c, (seen.get(c) ?? 0) + 1);
    expect(seen.size).toBe(20);
    expect(seen.get('0000000000')!).toBeGreaterThan(seen.get('0000000019')!);
  });

  it('data refresh: a curated filing dispatches a curated run, at most every 20 minutes, never onto a queued run; none without a token', async () => {
    const t0 = Date.parse('2026-11-16T15:01:00Z');
    const { dispatchRefresh } = await import('../src/alerts');
    expect(await dispatchRefresh(env, 'curated', 'x', t0)).toBe('no token');
    env.GITHUB_DISPATCH_TOKEN = 'ghp_test';
    expect(await dispatchRefresh(env, 'curated', 'filing by warren-buffett', t0, 'A1')).toBe('dispatched');
    expect(JSON.parse(gh.find((c) => c.method === 'POST')!.body!)).toEqual({ ref: 'main', inputs: { scope: 'curated', reason: 'filing by warren-buffett', accession: 'A1' } });
    // 5 minutes later another filer files: held, then sent by the minute cron once 20 minutes have passed.
    expect(await dispatchRefresh(env, 'curated', 'filing by dan-loeb', t0 + 5 * 60_000, 'A2')).toBe('spaced');
    gh = [];
    await cron(10, t0 + 10 * 60_000);
    expect(gh.filter((c) => c.method === 'POST')).toHaveLength(0);
    await cron(21, t0 + 20 * 60_000);
    expect(JSON.parse(gh.find((c) => c.method === 'POST')!.body!).inputs.accession).toBe('A2');
    expect(await env.DB.get('dispatch:pending')).toBeNull();
    // A run already queued: skipped and kept pending.
    ghQueued = 1;
    expect(await dispatchRefresh(env, 'curated', 'later', t0 + 60 * 60_000)).toBe('skipped: run queued');
    expect(await env.DB.get('dispatch:pending')).not.toBeNull();
  });

  it('/v1 filers and holdings: by slug or CIK, every field the OpenAPI schema requires, as_of not served yet', async () => {
    index = { managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, status: 'current', form: '13F-HR', accession: 'A2', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', total_value: 2000, position_count: 1, history_quarters: ['2026Q2', '2025Q1'] }] };
    await cron(17);
    hist.m.set('h/warren-buffett/2025Q1.json', new TextEncoder().encode(JSON.stringify({
      quarter: '2025Q1', report_date: '2025-03-31', accession: '0000950123-25-005701', form: '13F-HR', filing_date: '2025-05-15', sec_url: 'https://www.sec.gov/x', amendments: ['0000950123-25-008361'], prev_quarter: '2024Q4', total_value: 1000, position_count: 1,
      holdings: [{ cusip: '670346105', ticker: 'NUE', issuer: 'NUCOR CORP', display_name: 'Nucor', title: 'COM', put_call: null, sector: 'Materials', shares: 10, value: 1000, weight: 1, change: 'new', prev_shares: 0, share_change: 10, value_delta: 1000, pct_of_book: 1 }],
      exited: [{ cusip: '037833100', ticker: 'AAPL', issuer: 'APPLE INC', title: 'COM', put_call: null, shares: 0, value: 0, weight: 0, change: 'exited', prev_shares: 5, share_change: -5, value_delta: -500 }],
    })));
    // EDGAR index headers (acceptance in ET) and the amendment's cover page.
    const dir = (a: string) => `Archives/edgar/data/1067983/${a.replace(/-/g, '')}/`;
    secFiles[`${dir('0000950123-25-005701')}0000950123-25-005701-index-headers.html`] = '<ACCEPTANCE-DATETIME>20250515160512\n<TYPE>13F-HR\n<FILING-DATE>20250515\n';
    secFiles[`${dir('0000950123-25-008361')}0000950123-25-008361-index-headers.html`] = '<ACCEPTANCE-DATETIME>20250814161002\n<TYPE>13F-HR/A\n<FILING-DATE>20250814\n';
    secFiles[`${dir('0000950123-25-008361')}primary_doc.xml`] = '<isAmendment>true</isAmendment><amendmentNo>1</amendmentNo><amendmentType>NEW HOLDINGS</amendmentType><confDeniedExpired>true</confDeniedExpired>';
    stripeObjects['checkout/sessions/cs_test_v'] = { id: 'cs_test_v', status: 'complete', created: now(), subscription: 'sub_v', customer_details: { email: 'v@example.com' } };
    stripeObjects['subscriptions/sub_v'] = sub('sub_v', 'cus_v', 'active', 'month', 'pro_monthly');
    const t = (await (await call('/session', { body: { checkout_session: 'cs_test_v' } })).json()).token;
    const key = (await (await call('/keys', { body: { name: 'k' }, token: t })).json()).key;
    const v1 = async (path: string) => {
      const r = await handleRequest(new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${key}` } }), env);
      return { status: r.status, body: await r.json() };
    };
    const spec = (await v1('/v1/openapi.json')).body;

    const fl = await v1('/v1/filers');
    expect(fl.body.data[0]).toMatchObject({ slug: 'warren-buffett', cik: '0001067983', latest_quarter: '2026Q2', history_quarters: ['2026Q2', '2025Q1'] });
    for (const k of spec.components.schemas.Filer.required) expect(fl.body.data[0]).toHaveProperty(k);

    const bySlug = await v1('/v1/filers/warren-buffett/holdings/2025Q1');
    const byCik = await v1('/v1/filers/1067983/holdings/2025Q1');
    expect(bySlug.status).toBe(200);
    expect(byCik.body).toEqual(bySlug.body);
    const d = bySlug.body.data;
    // Both are EDT (UTC-4): 16:05:12 and 16:10:02 ET.
    expect(d.filing.accepted_at).toBe('2025-05-15T20:05:12.000Z');
    expect(d.filing.amendments).toEqual([{ accession: '0000950123-25-008361', filed_on: '2025-08-14', accepted_at: '2025-08-14T20:10:02.000Z', amendment_type: 'NEW HOLDINGS', amendment_no: 1, confidential_treatment_expired: true }]);
    for (const k of spec.components.schemas.Holdings.properties.filing.required) expect(d.filing).toHaveProperty(k);
    expect(fl.body.data[0]).not.toHaveProperty('type'); // omitted until classified
    // Cached after the first read: EDGAR is not asked again.
    delete secFiles[`${dir('0000950123-25-008361')}0000950123-25-008361-index-headers.html`];
    expect((await v1('/v1/filers/warren-buffett/holdings/2025Q1')).body.data.filing.amendments[0].amendment_type).toBe('NEW HOLDINGS');
    expect(d.holdings[0]).toMatchObject({ ticker: 'NUE', issuer: 'NUCOR CORP', shares_type: null, value_usd: 1000, weight: 1, change: 'new', value_delta_usd: 1000, source_accession: null, first_disclosed_at: null });
    expect(d.exited[0]).toMatchObject({ ticker: 'AAPL', shares: 0, value_delta_usd: -500 });
    for (const k of spec.components.schemas.Holdings.required) expect(d).toHaveProperty(k);
    for (const row of [...d.holdings, ...d.exited]) {
      for (const k of spec.components.schemas.Position.required) expect(row).toHaveProperty(k);
      expect(Object.keys(row).sort()).toEqual(Object.keys(spec.components.schemas.Position.properties).sort()); // nothing undocumented
    }

    expect((await v1('/v1/filers/warren-buffett/holdings/2025Q1?as_of=2025-05-20')).body.error.code).toBe('not_yet_available');
    expect((await v1('/v1/filers/warren-buffett/holdings/2019Q1')).status).toBe(404);
    expect((await v1('/v1/filers/warren-buffett/holdings/Q1')).body.error.code).toBe('bad_request');
    expect((await v1('/v1/filers/nobody/holdings/2025Q1')).status).toBe(404);
    for (const p of ['/v1/me', '/v1/filers', '/v1/filers/{filer}/holdings/{quarter}']) expect(spec.paths[p].get.responses['200'].content).toBeDefined();
  });

  it('EDGAR Eastern timestamps convert to UTC on both sides of the DST switches', async () => {
    const { easternToUtc } = await import('../src/edgar');
    expect(easternToUtc('20260106120000')).toBe('2026-01-06T17:00:00.000Z'); // EST
    expect(easternToUtc('20260308015959')).toBe('2026-03-08T06:59:59.000Z'); // just before DST starts
    expect(easternToUtc('20260308030000')).toBe('2026-03-08T07:00:00.000Z'); // just after
    expect(easternToUtc('20261031235900')).toBe('2026-11-01T03:59:00.000Z'); // EDT
    expect(easternToUtc('20261102000000')).toBe('2026-11-02T05:00:00.000Z'); // EST again
  });
});
