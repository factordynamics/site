import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleRequest } from '../src/index';
import type { Env, KV, R2 } from '../src/env';
import { MeterLogic } from '../src/keys';
import { getFollows, MemberFollows } from '../src/members';
import { resolveFollowedFilers, runDigest } from '../src/alerts';
import { alertMail } from '../src/email';
import { hmacHex } from '../src/tokens';
import form4Len from './fixtures/form4-len.xml?raw';
import durableQ2 from './fixtures/durable-q2-shard.json';
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
  async list({ prefix }: { prefix: string }) {
    return { objects: [...this.m].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length, uploaded: new Date(0) })) };
  }
}

const SITE = 'https://refcell.github.io/gust/copybook/';
const now = () => Math.floor(Date.now() / 1000);

function sub(id: string, customer: string, status: string, interval = 'month', lookup_key = `copy_${interval}ly`) {
  return { id, customer, status, items: { data: [{ price: { lookup_key, recurring: { interval } }, current_period_end: now() + 30 * 86400 }] } };
}

let env: Env;
let hist: MemR2;
let stockPages: Record<string, unknown> = {};
const WORKFLOW = 'refcell/gust/.github/workflows/copybook-data.yml@refs/heads/main';
let sent: { from?: string; to: string[]; subject: string; text: string; html?: string }[];
let stripeObjects: Record<string, unknown>;
let index: unknown;
let secFiles: Record<string, string>;
let filers: Record<string, unknown>[];
let posts: { url: string; body: string; headers: Record<string, string> }[];
let hookStatus: number;
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

/** One MemberFollows per member, with in-memory storage, as the FOLLOWS namespace. */
function memFollows() {
  const objs = new Map<string, MemberFollows>();
  return {
    idFromName: (n: string) => n,
    get: (id: unknown) => {
      const n = String(id);
      if (!objs.has(n)) {
        const store = new Map<string, unknown>();
        objs.set(n, new MemberFollows({ storage: { get: async <T,>(k: string) => { const v = structuredClone(store.get(k)) as T | undefined; await new Promise((r) => setTimeout(r, 5)); return v; }, put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)), delete: async (k: string) => store.delete(k) } }, env));
      }
      return { fetch: (u: string, init?: RequestInit) => objs.get(n)!.fetch(new Request(u, init)) };
    },
  };
}

beforeEach(async () => {
  hist = new MemR2();
  env = { DB: new MemKV(), HIST: hist, INGEST_WORKFLOW: WORKFLOW, SITE_URL: SITE, DATA_URL: `${SITE}data/`, EMAIL_FROM: 'Copybook <a@b.c>', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', SESSION_SECRET: 'session-secret', RESEND_API_KEY: 're_x', METER: memMeters(), FOLLOWS: undefined as never };
  // 2026Q1 lives only in the private bucket; 2026Q2 still falls back to the public copy.
  hist.m.set('h/warren-buffett/2026Q1.csv', new TextEncoder().encode('manager,slug,cik,quarter,report_date,filing_date,accession,ticker,issuer,cusip,title,put_call,shares,value_usd,weight,change,prev_shares,share_change,value_delta_usd,pct_of_book\r\nWarren Buffett,warren-buffett,0001067983,2026Q1,2026-03-31,2026-05-15,A1,BAC,"BANK, ""OF"" AMERICA",060505104,COM,,5,100,0.1,new,,5,100,0.1\r\n'));
  env.FOLLOWS = memFollows();
  sent = [];
  stripeObjects = {};
  index = { managers: [] };
  secFiles = {};
  posts = [];
  hookStatus = 200;
  filers = [{ cik: '0002045724', name: 'Situational Awareness LP', slug: 'situational-awareness-lp-5724', ok: true, position_count: 2, quarter: '2026Q2', error: null }];
  shards = {};
  stockPages = {};
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
      await new Promise((r) => setTimeout(r, 10)); // slow enough for concurrent webhooks to overlap
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
    if (/^https:\/\/(hooks\.slack\.com|discord\.com|api\.telegram\.org|hooks\.example\.com)\//.test(url)) {
      const hd: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => void (hd[k] = v));
      posts.push({ url, body: String(init?.body), headers: hd });
      return new Response('ok', { status: url.startsWith('https://hooks.example.com') ? hookStatus : 200 });
    }
    if (url === `${SITE}data/index.json`) return Response.json(index);
    if (url.startsWith(`${SITE}d/stocks/`)) { const k = url.slice(`${SITE}d/stocks/`.length).replace('.json', ''); return stockPages[k] ? Response.json(stockPages[k]) : new Response('not found', { status: 404 }); }
    if (url === `${SITE}d/f/index.json`) return Response.json({ cards: [{ accession: '0000950123-26-011111', slug: 'warren-buffett' }] });
    if (url === `${SITE}data/filers.json`) return new Response(JSON.stringify({ count: filers.length, filers }, null, 1));
    if (url.startsWith(`${SITE}data/f/`)) return shards[url.slice(`${SITE}data/f/`.length)] ? Response.json(shards[url.slice(`${SITE}data/f/`.length)]) : new Response('not found', { status: 404 });
    if (url === `${SITE}data/stock_holders.json`) return new Response('{"stocks":[{"issuer":"67066G","ticker":"NVDA","display_name":"NVIDIA"},{"issuer":"037833","ticker":"AAPL"}]}');
    if (url === `${SITE}data/alerts.json`) return Response.json({ recent: recentMoves });
    if (url === `${SITE}data/events.json`) return Response.json({ events });
    if (url === `${SITE}data/securities.json`) return new Response('{"037833100":{"ticker":"AAPL","name":"Apple"},"23331A109":{"ticker":"DHI","name":"D.R. Horton","sector":"Consumer Discretionary"}}');
    if (url.startsWith('https://data.sec.gov/submissions/')) return url.slice('https://data.sec.gov/'.length) in secFiles ? new Response(secFiles[url.slice('https://data.sec.gov/'.length)]) : new Response('not found', { status: 404 });
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
    expect((await (await call('/follows', { token: t })).json()).follows).toEqual({ investors: ['warren-buffett'], stocks: [], owned: [], peers: [], onboarded: false, include_13g: false, digest: false, insider_buys: true, insider_min_usd: 100000, cluster_buys: true, any_13d: true });

    for (const bad of [{ investors: ['Not A Slug'] }, { stocks: ['$AAPL'] }, { owned: 'AAPL' }, { onboarded: 'yes' }, { digest: 1 }, { insider_min_usd: -1 }, { insider_min_usd: '100k' }, { cluster_buys: 'no' }, { stocks: Array.from({ length: 501 }, (_, i) => `T${i}`) }]) {
      expect((await put(bad)).status).toBe(400);
    }
    const r = await (await put({ stocks: ['aapl', 'BRK.B'], owned: ['googl'], onboarded: true, include_13g: true })).json();
    expect(r.follows).toEqual({ investors: ['warren-buffett'], stocks: ['AAPL', 'BRK.B', 'GOOGL'], owned: ['GOOGL'], peers: [], onboarded: true, include_13g: true, digest: false, insider_buys: true, insider_min_usd: 100000, cluster_buys: true, any_13d: true });

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

  it('minute poll: a NEW HOLDINGS 13F-HR/A is sent as a reveal to followers and owners of the name; restatements are not', async () => {
    const today = new Date().toISOString().slice(0, 10);
    index = { managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: false, form: '13F-HR', accession: 'q2', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }] };
    // Not featured: a watchlist alone doesn't get its moves, but owning a revealed name does.
    await cron(17);
    await putMember('f', 'follows@example.com', 'active', ['warren-buffett']);
    await putFollows('f', { investors: ['warren-buffett'] });
    await putMember('o', 'owner@example.com', 'active', []);
    await putFollows('o', { stocks: ['DHI'], owned: ['DHI'] });
    await putMember('w', 'watcher@example.com', 'active', []);
    await putFollows('w', { stocks: ['DHI'] });
    // The served Q2 book: $25.6B, not yet merged with the amendment.
    hist.m.set('h/warren-buffett/2026Q2.json', new TextEncoder().encode(JSON.stringify({ quarter: '2026Q2', total_value: 25_600_000_000, amendments: [] })));
    const NEWH = '0000950123-26-055555', REST = '0000950123-26-066666';
    const entry = (a: string) => `<entry><title>13F-HR/A - BERKSHIRE (0001067983) (Filer)</title><updated>${today}T16:05:00-05:00</updated><category term="13F-HR/A"/><id>urn:tag:sec.gov,2008:accession-number=${a}</id></entry>`;
    secFiles.feed = `<feed>${entry(NEWH)}${entry(REST)}</feed>`;
    const amend = (a: string, type: string, conf: boolean) => {
      const dir = `Archives/edgar/data/1067983/${a.replace(/-/g, '')}/`;
      const stamp = `${today.replace(/-/g, '')}160500`;
      secFiles[`${dir}${a}-index-headers.html`] = `<ACCEPTANCE-DATETIME>${stamp}\n<TYPE>13F-HR/A\n<FILING-DATE>${today.replace(/-/g, '')}\n`;
      secFiles[`${dir}primary_doc.xml`] = `<periodOfReport>06-30-2026</periodOfReport><isAmendment>true</isAmendment><amendmentNo>1</amendmentNo><amendmentType>${type}</amendmentType><confDeniedExpired>${conf}</confDeniedExpired>`;
      secFiles[`${dir}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '900' }, { name: 'info.xml', size: '700' }] } });
      secFiles[`${dir}info.xml`] = '<infoTable><nameOfIssuer>D R HORTON INC</nameOfIssuer><cusip>23331A109</cusip><value>6000000000</value><sshPrnamt>40000000</sshPrnamt></infoTable>';
    };
    amend(NEWH, 'NEW HOLDINGS', true);
    amend(REST, 'RESTATEMENT', false);

    await cron(30);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['follows@example.com', 'owner@example.com']);
    const mail = sent.find((m) => m.to[0] === 'owner@example.com')!;
    // $6.0B of a $31.6B amended book.
    expect(mail.subject).toBe('Buffett revealed DHI ($6.0B, 19.0% of book), previously confidential');
    expect(mail.text).toContain('Q2 2026 13F amendment no. 1 (new holdings)');
    expect(mail.text).toContain('Positions held at 2026-06-30 that were kept confidential until now:');
    expect(mail.text).toContain('DHI 40,000,000 sh, $6.0B (19.0% of book) [you own]');
    expect(mail.text).toContain(`Accession ${NEWH}, accepted by EDGAR`);
    expect(mail.text).not.toContain(REST);
    expect(mail.html).toMatch(/<td[^>]*><b>DHI<\/b> \[you own\]<\/td><td[^>]*>40,000,000<\/td><td[^>]*>\$6\.0B<\/td><td[^>]*>19\.0%<\/td>/);
    const lat = JSON.parse((await env.DB.get('alerts:latency'))!);
    expect(lat[0]).toMatchObject({ accession: NEWH, form: '13F-HR/A' });

    // Handled once: the next minute sends nothing.
    sent = [];
    await cron(31);
    expect(sent).toHaveLength(0);
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
    expect(mail.subject).toBe('Buffett Q3: NEW DHI · EXIT BAC · AAPL -$4K');
    // The HTML part lays the moves out as a table, with how much of the position was sold.
    expect(mail.html).toMatch(/<table[^>]*>.*<th[^>]*>Move<\/th>.*<td[^>]*>Trimmed<\/td><td[^>]*><b>AAPL<\/b><\/td><td[^>]*>-\$4K<\/td><td[^>]*>sold 20%<\/td>/);
    expect(mail.html).toContain('Accession 0000950123-26-011111, accepted by EDGAR');
    // Total book 20,500: DHI +4,000 is 19.5%; the AAPL trim is 20 shares at $200 = -4,000; BAC exits at its prior $2,000.
    expect(mail.text).toContain('Bought $5K, sold $6K this quarter.');
    expect(mail.text).toContain('New: DHI +$4K (19.5% of book) [you own], AAPL calls +$1K (2.4% of book)');
    expect(mail.text).toContain('Trimmed: AAPL -$4K (sold 20% of the position, 19.5% of book)');
    expect(mail.text).toContain('Exited: BAC -$2K (9.8% of book)');
    expect(mail.text).toContain('Of the positions that changed, 1 is a stock you own.');
    // Buffett's filing has a public card; Loeb's doesn't yet, so it links the investor page.
    expect(mail.text).toContain('Copybook: https://refcell.github.io/gust/copybook/f/0000950123-26-011111/');
    expect(mail.html).toContain('>Filing card</a>');
    expect(loeb.text).toContain('Copybook: https://refcell.github.io/gust/copybook/investors/dan-loeb');
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

  it('13F alert dollars at real scale: Berkshire Q2 2026 GOOGL add of $8,770,349,040 reads +$8.8B', () => {
    const row = (ticker: string, shares: number, prev_shares: number, value: number, value_delta: number, d: number) => ({ ticker, display_name: null, issuer: ticker, cusip: ticker, put_call: null, shares, prev_shares, value, value_delta, delta_pct_of_book: d });
    // From EDGAR 0001193125-26-352200 vs 0001193125-26-226661.
    const moves = { bought_usd: 19.2e9, sold_usd: 4.1e9, new: [row('DHI', 3564, 0, 580504, 580504, 0.0000019)], added: [row('GOOGL', 78791167, 54249798, 28157599351, 8770349040, 0.0293)], trimmed: [row('BAC', 1, 2, 1, -1.7e9, -0.006), row('COF', 5, 12, 5, -832.6e6, -0.003)], exited: [row('STZ', 0, 1, 0, -94.9e6, -0.0003)] };
    const a = { slug: 'warren-buffett', slugs: ['warren-buffett'], manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', accession: '0001193125-26-352200', sec_url: 'https://www.sec.gov/x', accepted: '2026-08-14T20:05:04Z', moves, tickers: [] };
    const m = alertMail(env, 'x@example.com', [a], [], { investors: [], stocks: [], owned: [], peers: [], onboarded: true, include_13g: false, digest: false, insider_buys: true, insider_min_usd: 100_000, cluster_buys: true, any_13d: true });
    expect(m.subject).toBe('Buffett Q2: NEW DHI · EXIT STZ · GOOGL +$8.8B');
    expect(m.text).toContain('Bought $19.2B, sold $4.1B this quarter.');
    expect(m.text).toContain('Added: GOOGL +$8.8B (+45% shares, 2.9% of book)');
    expect(m.text).toContain('New: DHI +$581K (<0.1% of book)');
    // The trader owns GOOGL; the retail critic owns COF and DHI and watches BAC: tagged in text and HTML.
    const f = { investors: [], stocks: ['GOOGL', 'COF', 'DHI', 'BAC'], owned: ['GOOGL', 'COF', 'DHI'], peers: [], onboarded: true, include_13g: false, digest: false, insider_buys: true, insider_min_usd: 100_000, cluster_buys: true, any_13d: true };
    const tagged = alertMail(env, 'x@example.com', [a], [], f);
    for (const t of ['GOOGL', 'COF', 'DHI']) {
      expect(tagged.text).toMatch(new RegExp(`${t} [+-]\\$[^[]*\\[you own\\]`));
      expect(tagged.html).toContain(`<b>${t}</b> [you own]`);
    }
    expect(tagged.html).toContain('<b>BAC</b> [watchlist]');
    expect(tagged.html).not.toContain('<b>STZ</b> [');
  });

  it('insider buys on owned and watched stocks: code P by officers, directors and 10% owners above the member threshold; 3 insiders in 30 days is a cluster, once', async () => {
    index = { managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, form: '13F-HR', accession: 'q2', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }] };
    await cron(17);
    await putMember('o', 'owner@example.com', 'active', []);
    await putFollows('o', { stocks: ['KMX'], owned: ['KMX'] });
    await putMember('h', 'high@example.com', 'active', []);
    await putFollows('h', { stocks: ['KMX'], insider_min_usd: 500_000, cluster_buys: true });
    await putMember('n', 'noinsider@example.com', 'active', []);
    await putFollows('n', { stocks: ['KMX'], insider_buys: false, cluster_buys: false });
    secFiles['files/company_tickers.json'] = JSON.stringify({ 0: { cik_str: 1170010, ticker: 'KMX' } });
    await cron(52);
    secFiles['feed:4'] = '<feed></feed>';
    await cron(3); // seeds the event poll
    sent = [];

    const at = new Date(Date.now() - 3 * 60_000).toISOString();
    const entry = (cik: string, acc: string, name: string, role: string) => `<entry><title>4 - ${name} (${cik}) (${role})</title><updated>${at}</updated><category scheme="https://www.sec.gov/" label="form type" term="4"/><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
    const form4 = (owner: string, name: string, rel: string, code: string, shares: number, price: number) =>
      `<ownershipDocument><issuer><issuerCik>0001170010</issuerCik><issuerName>CARMAX INC</issuerName><issuerTradingSymbol>KMX</issuerTradingSymbol></issuer><reportingOwner><reportingOwnerId><rptOwnerCik>${owner}</rptOwnerCik><rptOwnerName>${name}</rptOwnerName></reportingOwnerId><reportingOwnerRelationship>${rel}</reportingOwnerRelationship></reportingOwner><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>${code === 'S' ? 'D' : 'A'}</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>${shares * 2}</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;
    const filings: [string, string, string, string, string, number, number][] = [
      ['0000000101', '0000000101-26-000001', 'SMITH JOHN A', '<isOfficer>1</isOfficer><officerTitle>Chief Executive Officer</officerTitle>', 'P', 5000, 60],  // $300K
      ['0000000102', '0000000102-26-000001', 'DOE JANE', '<isDirector>1</isDirector>', 'P', 1000, 60],  // $60K: under every default
      ['0000000103', '0000000103-26-000001', 'ROE RICHARD', '<isOfficer>1</isOfficer><officerTitle>CFO</officerTitle>', 'S', 9000, 60],  // a sale
      ['0000000104', '0000000104-26-000001', 'BIG HOLDER LP', '<isTenPercentOwner>1</isTenPercentOwner>', 'P', 10000, 60],  // $600K
    ];
    for (const [cik, acc, name, rel, code, sh, px] of filings) {
      const dir = `Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/`;
      secFiles[`${dir}index.json`] = JSON.stringify({ directory: { item: [{ name: 'f4.xml' }] } });
      secFiles[`${dir}f4.xml`] = form4(cik, name, rel, code, sh, px);
    }
    secFiles['feed:4'] = `<feed>${filings.map(([cik, acc, name]) => `${entry(cik, acc, name, 'Reporting')}${entry('0001170010', acc, 'CARMAX', 'Issuer')}`).join('')}</feed>`;
    await cron(5);
    const to = (a: string) => sent.filter((m) => m.to[0] === a);
    const o = to('owner@example.com').map((m) => m.text).join('\n');
    expect(o).toContain('John A Smith (Chief Executive Officer of CARMAX INC) bought 5,000 shares of KMX ($300K, avg $60.00)');
    expect(o).toContain('Big Holder LP (10% owner of CARMAX INC) bought 10,000 shares');
    expect(o).not.toContain('Jane Doe (Director of'); // $60K, under the $100K default
    expect(o).not.toContain('Roe'); // a sale never alerts
    // Three distinct insiders bought (Doe counts toward the cluster even under the threshold).
    expect(o).toMatch(/Cluster buy: KMX: 3 insiders bought \$960K in 30 days/);
    expect(to('owner@example.com')[0].subject).toMatch(/^KMX insider buy: Chief Executive Officer John A Smith bought \$300K \+ 2 more$/);
    const hi = to('high@example.com').map((m) => m.text).join('\n');
    expect(hi).toContain('Big Holder LP');
    expect(hi).not.toContain('John A Smith (Chief Executive Officer of'); // $300K, under this member's $500K
    expect(to('noinsider@example.com')).toHaveLength(0);

    // A fourth buyer within 30 days alerts on its own but doesn't repeat the cluster.
    sent = [];
    const acc5 = '0000000105-26-000001';
    const dir5 = `Archives/edgar/data/105/${acc5.replace(/-/g, '')}/`;
    secFiles[`${dir5}index.json`] = JSON.stringify({ directory: { item: [{ name: 'f4.xml' }] } });
    secFiles[`${dir5}f4.xml`] = form4('0000000105', 'NEW DIRECTOR', '<isDirector>1</isDirector>', 'P', 5000, 60);
    secFiles['feed:4'] = secFiles['feed:4'].replace('</feed>', `${entry('0000000105', acc5, 'NEW DIRECTOR', 'Reporting')}${entry('0001170010', acc5, 'CARMAX', 'Issuer')}</feed>`);
    await cron(6);
    const again = sent.map((m) => m.text).join('\n');
    expect(again).toContain('Director New (Director of CARMAX INC)');
    expect(again).not.toContain('Cluster buy');
    expect(again).not.toContain('John A Smith');
  });

  it('single-item follows: Follow clicks a second apart both land, a settings save never undoes them, owned implies watched', async () => {
    stripeObjects['checkout/sessions/cs_test_c'] = { id: 'cs_test_c', status: 'complete', created: now(), subscription: 'sub_c', customer_details: { email: 'c@example.com' } };
    stripeObjects['subscriptions/sub_c'] = sub('sub_c', 'cus_c', 'active');
    const t = (await (await call('/session', { body: { checkout_session: 'cs_test_c' } })).json()).token;
    filers.push({ cik: '0001798849', name: 'Durable Capital Partners LP', slug: 'durable-capital-partners-lp-8849', ok: true, quarter: '2026Q2' }, { cik: '0001541617', name: 'Altimeter Capital Management, LP', slug: 'altimeter-capital-management-lp-1617', ok: true, quarter: '2026Q2' });
    const req = (method: string, path: string, b?: unknown) => handleRequest(new Request(`https://api.test${path}`, { method, body: b ? JSON.stringify(b) : undefined, headers: { origin: 'https://refcell.github.io', authorization: `Bearer ${t}` } }), env);
    // Two clicks in flight together, plus a settings save that doesn't touch investors.
    const rs = await Promise.all([req('POST', '/follows/durable-capital-partners-lp-8849'), req('POST', '/follows/altimeter-capital-management-lp-1617'), req('PUT', '/follows', { digest: true }), req('POST', '/follows/owned/cof')]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const f = (await (await req('GET', '/follows')).json()).follows;
    expect(f.investors.sort()).toEqual(['altimeter-capital-management-lp-1617', 'durable-capital-partners-lp-8849']);
    expect(f).toMatchObject({ digest: true, owned: ['COF'], stocks: ['COF'] });
    // The alert jobs read KV: it carries the same follows.
    expect(JSON.parse((await env.DB.get('follows:cus_c'))!).investors.sort()).toEqual(f.investors);
    expect((await req('POST', '/follows/no-such-filer-1')).status).toBe(400);
    await Promise.all([req('DELETE', '/follows/durable-capital-partners-lp-8849'), req('DELETE', '/follows/stocks/COF')]);
    expect((await (await req('GET', '/follows')).json()).follows).toMatchObject({ investors: ['altimeter-capital-management-lp-1617'], stocks: [], owned: [] });
  });

  it("a followed non-curated filer's Q3 email has moves against its Q2 book, snapshotted at follow time even after the data run moves its shard to Q3", async () => {
    const today = new Date().toISOString().slice(0, 10);
    index = { managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, form: '13F-HR', accession: 'q2', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }] };
    await cron(17);
    filers.push({ cik: '0001798849', name: 'Durable Capital Partners LP', slug: 'durable-capital-partners-lp-8849', ok: true, quarter: '2026Q2' });
    // Durable's real Q2 2026 shard, as the data run publishes it today.
    shards['0001798849.json'] = durableQ2;
    expect(await resolveFollowedFilers(env, ['durable-capital-partners-lp-8849'])).toEqual([]);
    await putMember('d', 'durable@example.com', 'active', ['durable-capital-partners-lp-8849']);
    await putFollows('d', { investors: ['durable-capital-partners-lp-8849'], owned: ['DASH'], stocks: ['DASH'] });
    // The data run tells the ingest which CIKs to back-fill; only its workflow may read the list.
    expect(JSON.parse(new TextDecoder().decode(hist.m.get('followed/ciks.json')))).toMatchObject({ ciks: ['0001798849'] });
    expect((await call('/ingest/followed.json')).status).toBe(401);
    // Then the data run replaces the shard with something else before Durable's Q3 13F arrives.
    shards['0001798849.json'] = { ...durableQ2, report_date: '2026-09-30', quarter: '2026Q3', rows: [] };

    // Q3: RBC sold out, DASH +50%, Q (Qnity) -40%, a new position; the rest unchanged.
    type Row = [string, string, string, string, string | null, number, number];
    const rows = (durableQ2.rows as unknown as Row[]).filter((r) => r[0] !== 'RBC').map((r): Row => (r[0] === 'DASH' ? [...r.slice(0, 5), Math.round(r[5] * 1.5), Math.round(r[6] * 1.5)] as Row : r[0] === 'Q' ? [...r.slice(0, 5), Math.round(r[5] * 0.6), Math.round(r[6] * 0.6)] as Row : r));
    rows.push(['NEWCO', 'NEWCO HOLDINGS INC', 'COM', '99999X109', null, 100000, 50_000_000]);
    const acc = '0001798849-26-000011';
    const dir = `Archives/edgar/data/1798849/${acc.replace(/-/g, '')}/`;
    secFiles[`${dir}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '5000' }, { name: 'info.xml', size: '9000' }] } });
    secFiles[`${dir}primary_doc.xml`] = '<edgarSubmission><periodOfReport>09-30-2026</periodOfReport></edgarSubmission>';
    secFiles[`${dir}info.xml`] = `<informationTable>${rows.map((r) => `<infoTable><nameOfIssuer>${r[1]}</nameOfIssuer><cusip>${r[3]}</cusip><value>${r[6]}</value><shrsOrPrnAmt><sshPrnamt>${r[5]}</sshPrnamt></shrsOrPrnAmt>${r[4] ? `<putCall>${r[4]}</putCall>` : ''}</infoTable>`).join('')}</informationTable>`;
    secFiles.feed = `<feed><entry><title>13F-HR - Durable Capital Partners LP (0001798849) (Filer)</title><updated>${today}T16:05:00-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="13F-HR"/><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry></feed>`;
    sent = [];
    await cron(5);
    expect(sent.map((m) => m.to[0])).toEqual(['durable@example.com']);
    const { text, html, subject } = sent[0];
    expect(subject).toMatch(/^Durable Capital Partners Q3: NEW NEWCO HOLDINGS INC · EXIT RBC · DASH \+\$383\.3M/);
    expect(text).toMatch(/Added: DASH \+\$383\.3M \(\+50% shares, [\d.]+% of book\) \[you own\]/);
    expect(text).toMatch(/Trimmed: Q -\$297\.4M \(sold 40% of the position/);
    expect(text).toMatch(/Exited: RBC -\$1\.1B/);
    expect(html).toMatch(/<b>DASH<\/b> \[you own\]/);
    // The Q3 book is kept as the Q4 baseline.
    expect(hist.m.has('b/0001798849/2026-09-30.json')).toBe(true);
  });

  it('Holdterm members: alerts settings only, 402 everywhere else, Holdterm portal, no Copybook email', async () => {
    stripeObjects['checkout/sessions/cs_live_ht'] = { id: 'cs_live_ht', status: 'complete', created: now(), subscription: 'sub_ht', customer_details: { email: 'ht@example.com' } };
    stripeObjects['subscriptions/sub_ht'] = { ...sub('sub_ht', 'cus_ht', 'trialing'), items: { data: [{ price: { id: 'price_ht', lookup_key: 'holdterm_monthly', metadata: { copybook: 'holdterm' }, recurring: { interval: 'month' } } }] } };
    stripeObjects['customers/cus_ht'] = { id: 'cus_ht', email: 'ht@example.com' };
    env.HOLDTERM_SITE_URL = 'https://holdterm.pages.dev/';
    env.ALLOWED_ORIGINS = 'https://holdterm.pages.dev'; // as in wrangler.toml
    env.HOLDTERM_PORTAL_CONFIGURATION = 'bpc_ht';
    // Checkout's return and its two webhooks arrive together: still one welcome.
    const [s] = await Promise.all([
      handleRequest(new Request('https://api.test/session', { method: 'POST', body: JSON.stringify({ checkout_session: 'cs_live_ht' }), headers: { origin: 'https://holdterm.pages.dev' } }), env),
      webhook({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_ht', customer_details: { email: 'ht@example.com' } } } }),
      webhook({ type: 'customer.subscription.created', data: { object: stripeObjects['subscriptions/sub_ht'] } }),
    ]);
    expect(s.status).toBe(200);
    expect(s.headers.get('access-control-allow-origin')).toBe('https://holdterm.pages.dev');
    const { token, member } = await s.json();
    expect(member).toMatchObject({ plan: 'holdterm', active: true });
    // The welcome comes from Holdterm, with a Holdterm sign-in link, and never names Copybook.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'Holdterm <holdterm@factordynamics.com>', subject: 'Holdterm alerts are on' });
    expect(sent[0].text).toContain('https://holdterm.pages.dev/account?login=');
    expect(JSON.stringify(sent[0])).not.toMatch(/copybook/i);
    const ht = (method: string, path: string, b?: unknown) => handleRequest(new Request(`https://api.test${path}`, { method, body: b ? JSON.stringify(b) : undefined, headers: { origin: 'https://holdterm.pages.dev', authorization: `Bearer ${token}` } }), env);
    expect((await (await ht('GET', '/me')).json()).member).toMatchObject({ cancel_at_period_end: false, cancel_at: null });
    // A portal cancel shows on /me as a pending end, so the site can say "ends" instead of "renews".
    await webhook({ type: 'customer.subscription.updated', data: { object: { ...(stripeObjects['subscriptions/sub_ht'] as object), status: 'active', cancel_at_period_end: true, cancel_at: 1796774400 } } });
    expect((await (await ht('GET', '/me')).json()).member).toMatchObject({ active: true, cancel_at_period_end: true, cancel_at: 1796774400 });
    expect((await ht('GET', '/follows')).status).toBe(200);
    expect((await ht('POST', '/follows/warren-buffett')).status).toBe(200);
    for (const [m, p] of [['GET', '/history/warren-buffett'], ['POST', '/csv-link/warren-buffett'], ['GET', '/keys'], ['POST', '/keys']]) {
      const r = await ht(m, p, m === 'POST' ? { name: 'k' } : undefined);
      expect([p, r.status]).toEqual([p, 402]);
    }
    let portalBody = '';
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u).includes('billing_portal/sessions')) portalBody = String(init?.body);
      return orig(u, init);
    });
    await ht('POST', '/portal');
    expect(portalBody).toContain('configuration=bpc_ht');
    expect(decodeURIComponent(portalBody)).toContain('return_url=https://holdterm.pages.dev/account/');

    // Sign-in from Holdterm: a Holdterm link.
    sent = [];
    await handleRequest(new Request('https://api.test/login', { method: 'POST', body: JSON.stringify({ email: 'ht@example.com', brand: 'holdterm' }), headers: { origin: 'https://holdterm.pages.dev' } }), env);
    expect(sent.map((m) => [m.from, m.subject])).toEqual([['Holdterm <holdterm@factordynamics.com>', 'Your Holdterm sign-in link']]);

    // Alerts: following nobody means every featured investor; a followed stock brings any filer's event on it.
    await ht('DELETE', '/follows/warren-buffett');
    await ht('POST', '/follows/stocks/NVDA');
    const today = new Date().toISOString().slice(0, 10);
    const ev = (id: string, slug: string, ticker: string, kind = 'form4') => ({ id, slug, manager: slug === 'warren-buffett' ? 'Warren Buffett' : slug, form: kind === 'form4' ? '4' : 'SCHEDULE 13G', kind, action: kind === 'form4' ? 'buy' : 'new_stake', filing_date: today, url: `https://www.sec.gov/${id}`, issuer: ticker, display_name: ticker, ticker, shares: 1000, value_usd: 25000, avg_price: 25, shares_after: null, percent_of_class: kind === 'form4' ? null : 6.1 });
    events = [ev('seed', 'warren-buffett', 'SIRI')];
    await cron(47);
    sent = [];
    events = [ev('seed', 'warren-buffett', 'SIRI'), ev('HT1', 'warren-buffett', 'SIRI'), ev('HT2', 'some-bank', 'NVDA', '13g'), ev('HT3', 'some-bank', 'AAPL'), ev('HT4', 'warren-buffett', 'NVDA')];
    await cron(47);
    // One email, Holdterm's: a featured filer's move in a followed stock would also match Copybook's rules.
    expect(sent.filter((m) => m.to[0] === 'ht@example.com').map((m) => m.from)).toEqual(['Holdterm <holdterm@factordynamics.com>']);
    const mail = sent.find((m) => m.to[0] === 'ht@example.com')!;
    expect(mail.from).toBe('Holdterm <holdterm@factordynamics.com>');
    expect(mail.text).toContain('https://holdterm.pages.dev/s/SIRI');
    expect(mail.text).toContain('https://holdterm.pages.dev/s/NVDA');
    expect(mail.text).not.toContain('HT3');
    expect(mail.text).toContain('Manage alerts: https://holdterm.pages.dev/account/ · SEC EDGAR data, not investment advice.');
    expect(mail.html).toContain('<pre style="font:13px/1.45 ui-monospace');
    expect(JSON.stringify(mail)).not.toMatch(/copybook/i);
  });

  it('delivery channels: Discord, Slack, Telegram and a revocable private feed for Copy; signed webhooks with retry for Pro', async () => {
    const session = async (id: string, plan?: string) => {
      stripeObjects[`checkout/sessions/cs_test_${id}`] = { id: `cs_test_${id}`, status: 'complete', created: now(), subscription: `sub_${id}`, customer_details: { email: `${id}@example.com` } };
      stripeObjects[`subscriptions/sub_${id}`] = plan ? sub(`sub_${id}`, `cus_${id}`, 'active', 'month', plan) : sub(`sub_${id}`, `cus_${id}`, 'active');
      return (await (await call('/session', { body: { checkout_session: `cs_test_${id}` } })).json()).token as string;
    };
    const copy = await session('chan');
    const pro = await session('hook', 'pro_monthly');
    const req = (t: string, method: string, path: string, b?: unknown) => handleRequest(new Request(`https://api.test${path}`, { method, body: b ? JSON.stringify(b) : undefined, headers: { origin: 'https://refcell.github.io', authorization: `Bearer ${t}` } }), env);
    const slack = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop';
    const discord = 'https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz';
    for (const bad of [{ slack: 'https://evil.example.com/x' }, { discord: slack }, { telegram: { bot_token: 'x', chat_id: '1' } }, { webhook: 'https://hooks.example.com/cb' }]) {
      expect((await req(copy, 'PUT', '/channels', bad)).status).toBe(bad.webhook ? 403 : 400); // webhooks are Pro
    }
    const set = await (await req(copy, 'PUT', '/channels', { slack, discord, telegram: { bot_token: '123456789:AAbbccddeeffgghhiijjkkllmmnnoopp', chat_id: '-1001234' } })).json();
    expect(set.channels).toMatchObject({ slack: 'https://hooks.slack.com/…mnop', telegram: { chat_id: '-1001234' }, webhook: null, webhook_available: false });
    const feedUrls = (await (await req(copy, 'POST', '/channels/feed')).json()).channels.feed;
    expect(feedUrls.json_url).toMatch(/^https:\/\/api\.test\/feed\/[\w-]{30,}\.json$/);
    const hook = await (await req(pro, 'PUT', '/channels', { webhook: 'https://hooks.example.com/cb' })).json();
    const secret = hook.channels.webhook.secret as string;
    expect(secret).toMatch(/^whsec_/);
    await putFollows('cus_chan', { investors: ['warren-buffett'] });
    await putFollows('cus_hook', { investors: ['warren-buffett'] });

    const today = new Date().toISOString().slice(0, 10);
    const ev = (id: string) => ({ id, slug: 'warren-buffett', manager: 'Warren Buffett', form: '4', kind: 'form4', action: 'buy', filing_date: today, url: `https://www.sec.gov/${id}`, issuer: 'SIRIUS XM', display_name: null, ticker: 'SIRI', shares: 1000, value_usd: 25000, avg_price: 25, shares_after: null, percent_of_class: null });
    events = [ev('seed')];
    await cron(47);
    hookStatus = 500; // the Pro endpoint is down at first
    events = [ev('seed'), ev('C1')];
    await cron(47);
    const by = (host: string) => posts.filter((p) => p.url.includes(host));
    expect(JSON.parse(by('hooks.slack.com')[0].body).text).toContain('Buffett SIRI Form 4: bought $25K');
    expect(JSON.parse(by('discord.com')[0].body).content).toContain('https://www.sec.gov/C1');
    expect(by('api.telegram.org')[0].url).toBe('https://api.telegram.org/bot123456789:AAbbccddeeffgghhiijjkkllmmnnoopp/sendMessage');
    expect(JSON.parse(by('api.telegram.org')[0].body)).toMatchObject({ chat_id: '-1001234' });
    // The webhook is signed: t=<seconds>,v1=HMAC(secret, "<t>.<body>").
    const first = by('hooks.example.com')[0];
    const [, t, v1] = first.headers['copybook-signature'].match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    expect(v1).toBe(await hmacHex(secret, `${t}.${first.body}`));
    expect(JSON.parse(first.body)).toMatchObject({ type: 'form4', accession: 'C1', filer: { slug: 'warren-buffett' }, ticker: 'SIRI' });
    expect(JSON.parse(first.body).detected_at).toBeTruthy();
    // Failed: retried after a minute, then delivered.
    hookStatus = 200;
    posts = [];
    await cron(47); // the same minute: not due yet
    expect(by('hooks.example.com')).toHaveLength(0);
    await cron(48); // a minute later
    expect(by('hooks.example.com')).toHaveLength(1);
    expect(await env.DB.get('webhooks:retry')).toBeNull();

    // The private feed has the alert as JSON Feed and RSS; a rotated token stops working.
    const jf = await (await handleRequest(new Request(feedUrls.json_url), env)).json();
    expect(jf.items[0]).toMatchObject({ id: 'C1', title: 'Buffett SIRI Form 4: bought $25K' });
    const rss = await (await handleRequest(new Request(feedUrls.rss_url), env)).text();
    expect(rss).toContain('<title>Buffett SIRI Form 4: bought $25K</title>');
    await req(copy, 'DELETE', '/channels/feed');
    expect((await handleRequest(new Request(feedUrls.json_url), env)).status).toBe(404);
  });

  it('minute event poll: Form 4 per class from a curated filer, any filer\'s 13D/A on an owned stock with the change, unread filings alerted at once and completed later', async () => {
    const today = new Date().toISOString().slice(0, 10);
    index = { managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, form: '13F-HR', accession: 'q2', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }, { ok: true, slug: 'carl-icahn', cik: '0000921669', manager: 'Carl Icahn', name: 'Icahn Carl C', featured: true, form: '13F-HR', accession: 'q2i', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }] };
    // Already in the feed when the poll first runs (with the CIK map): recorded, never sent.
    const old = '0001193125-26-300000';
    secFiles['feed:4'] = `<feed><entry><title>4 - BERKSHIRE (0001067983) (Reporting)</title><updated>${new Date(Date.now() - 60 * 60_000).toISOString()}</updated><category scheme="https://www.sec.gov/" label="form type" term="4"/><id>urn:tag:sec.gov,2008:accession-number=${old}</id></entry></feed>`;
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
    const e = (form: string, cik: string, acc: string, name: string, role: string, at = before(4)) =>
      `<entry><title>${form} - ${name} (${cik}) (${role})</title><updated>${at}</updated><category scheme="https://www.sec.gov/" label="form type" term="${form}"/><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
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
    // A reviewer's TEST submission is stored but not counted.
    expect((await post({ ...ok, email: 'copybook-test-pm@x.example', name: 'TEST PM critic' }, '8.8.8.8')).status).toBe(200);
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

  it('Copy Fund seats: invites with their own sign-in, a shared book and peers, per-seat alert settings, billing stays with the owner', async () => {
    stripeObjects['checkout/sessions/cs_test_fund'] = { id: 'cs_test_fund', status: 'complete', created: now(), subscription: 'sub_fund', customer_details: { email: 'pm@fund.example' } };
    stripeObjects['subscriptions/sub_fund'] = sub('sub_fund', 'cus_fund', 'active', 'year', 'fund_yearly');
    const owner = (await (await call('/session', { body: { checkout_session: 'cs_test_fund' } })).json()).token;
    await call('/follows/warren-buffett', { method: 'POST', token: owner });
    await call('/follows/owned/NVDA', { method: 'POST', token: owner });
    sent = [];

    expect((await call('/seats', { body: { email: 'pm@fund.example' }, token: owner })).status).toBe(409);
    const inv = await call('/seats', { body: { email: 'Analyst@Fund.example' }, token: owner });
    expect(inv.status).toBe(201);
    expect((await inv.json()).seats).toEqual([{ email: 'analyst@fund.example', invited_at: expect.any(String) }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['analyst@fund.example'], subject: 'You have a Copy Fund seat on Copybook' });
    const login = decodeURIComponent(sent[0].text.match(/\?login=([^\s]+)/)![1]);
    const seat = (await (await call('/session', { body: { login } })).json()).token;
    expect((await (await call('/me', { token: seat })).json()).member).toMatchObject({ email: 'analyst@fund.example', plan: 'fund', active: true, seat: true });

    // The book, follows and peers are the team's; alert settings are the seat's own.
    expect((await (await call('/follows', { token: seat })).json()).follows).toMatchObject({ investors: ['warren-buffett'], owned: ['NVDA'], peers: [] });
    await call('/follows/peers/whale-rock-capital-management-llc-7322', { method: 'POST', token: seat });
    const put = (token: string, b: unknown) => handleRequest(new Request('https://api.test/follows', { method: 'PUT', body: JSON.stringify(b), headers: { authorization: `Bearer ${token}` } }), env);
    expect((await (await put(seat, { digest: true, owned: ['NVDA', 'AAPL'] })).json()).follows).toMatchObject({ digest: true, owned: ['NVDA', 'AAPL'] });
    const mine = (await (await call('/follows', { token: owner })).json()).follows;
    expect(mine).toMatchObject({ investors: ['warren-buffett'], owned: ['NVDA', 'AAPL'], peers: ['whale-rock-capital-management-llc-7322'], digest: false });
    expect((await (await call('/follows', { token: seat })).json()).follows).toMatchObject({ owned: ['NVDA', 'AAPL'], digest: true });
    // Alert runs read the seat's follows the same way: the team's lists, the seat's settings.
    const seatMember = JSON.parse((await env.DB.get(`cus:${await env.DB.get('email:analyst@fund.example')}`))!);
    expect(await getFollows(env, seatMember)).toMatchObject({ investors: ['warren-buffett'], owned: ['NVDA', 'AAPL'], peers: ['whale-rock-capital-management-llc-7322'], digest: true });

    // Billing and seats belong to the owner; a seat has its own API keys.
    expect((await call('/portal', { method: 'POST', token: seat })).status).toBe(403);
    expect((await call('/seats', { token: seat })).status).toBe(403);
    expect((await call('/keys', { body: { name: 'seat key' }, token: seat })).status).toBe(201);

    // Five seats at most.
    for (const n of [2, 3, 4, 5]) expect((await call('/seats', { body: { email: `s${n}@fund.example` }, token: owner })).status).toBe(201);
    expect((await call('/seats', { body: { email: 's6@fund.example' }, token: owner })).status).toBe(409);

    // A removed seat is gone; when the Fund ends, every remaining seat ends with it.
    const s5 = await env.DB.get('email:s5@fund.example');
    expect((await call('/seats/s5%40fund.example', { method: 'DELETE', token: owner })).status).toBe(200);
    expect(await env.DB.get('email:s5@fund.example')).toBeNull();
    expect(await env.DB.get(`cus:${s5}`)).toBeNull();
    await webhook({ type: 'customer.subscription.deleted', data: { object: { ...sub('sub_fund', 'cus_fund', 'canceled', 'year', 'fund_yearly') } } });
    expect((await (await call('/me', { token: seat })).json()).member).toMatchObject({ active: false, status: 'canceled' });
    expect((await call('/follows', { token: seat })).status).toBe(402);
  });

  it('/v1 every filer: the all-filer list, books from the public shard then the full R2 book, ranges, stock holders', async () => {
    index = { generated_at: '2026-11-08T21:29:01Z', managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, status: 'current', form: '13F-HR', accession: 'A2', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', total_value: 2000, position_count: 1, history_quarters: ['2026Q2'] }] };
    await cron(17);
    stripeObjects['checkout/sessions/cs_test_af'] = { id: 'cs_test_af', status: 'complete', created: now(), subscription: 'sub_af', customer_details: { email: 'af@example.com' } };
    stripeObjects['subscriptions/sub_af'] = sub('sub_af', 'cus_af', 'active', 'month', 'pro_monthly');
    const t = (await (await call('/session', { body: { checkout_session: 'cs_test_af' } })).json()).token;
    const key = (await (await call('/keys', { body: { name: 'k' }, token: t })).json()).key;
    const v1 = async (path: string) => {
      const r = await handleRequest(new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${key}` } }), env);
      return { status: r.status, body: await r.json() };
    };
    const cols = ['ticker', 'issuer', 'title', 'cusip', 'put_call', 'shares', 'value', 'display_name', 'sector'];
    const nvda = ['NVDA', 'NVIDIA CORP', 'COM', '67066G104', null, 100, 18000, 'Nvidia', null];
    const be = ['BE', 'BLOOM ENERGY CORP', 'COM CL A', '093712107', null, 50, 5000, 'Bloom Energy', null];
    const small = ['XYZ', 'XYZ CORP', 'COM', '98422D105', null, 7, 700, 'Xyz', null];
    // The public shard keeps the top rows only: 2 of 3 positions.
    shards['0002045724.json'] = { ok: true, cik: '0002045724', quarter: '2026Q2', report_date: '2026-06-30', form: '13F-HR', accession: '0002045724-26-000003', filing_date: '2026-08-14', sec_url: 'https://www.sec.gov/Archives/edgar/data/2045724/000204572426000003/x-index.html', position_count: 3, total_value: 23700, columns: cols, rows: [nvda, be] };

    const all = await v1('/v1/filers');
    expect(all.body.count).toBe(2);
    expect(all.body.data.map((f: { slug: string; curated: boolean }) => [f.slug, f.curated])).toEqual([['warren-buffett', true], ['situational-awareness-lp-5724', false]]);
    expect((await v1('/v1/filers?curated=false')).body.data).toHaveLength(1);

    const shard = await v1('/v1/filers/situational-awareness-lp-5724/holdings/latest');
    expect(shard.status).toBe(200);
    expect(shard.body.data).toMatchObject({ filer: { cik: '0002045724', curated: false, manager: null }, quarter: '2026Q2', position_count: 3, truncated: true, filing: { accession: '0002045724-26-000003', filer_cik: '0002045724' } });
    expect(shard.body.data.holdings.map((h: { ticker: string; value_usd: number }) => [h.ticker, h.value_usd])).toEqual([['NVDA', 18000], ['BE', 5000]]);
    expect((await v1('/v1/filers/2045724/holdings/2026Q2')).body).toEqual(shard.body);
    expect((await v1('/v1/filers/2045724/holdings/2026Q1')).status).toBe(404);
    expect((await v1('/v1/filers/0009999999/holdings/latest')).status).toBe(404);

    // The full book, once in R2, wins over the shard: all 3 rows, weights over the whole equity book.
    hist.m.set('fb/2026Q2/0002045724.json', new TextEncoder().encode(JSON.stringify({ ...(shards['0002045724.json'] as object), rows: [nvda, be, small] })));
    const full = (await v1('/v1/filers/2045724/holdings/2026Q2')).body.data;
    expect(full.truncated).toBe(false);
    expect(full.holdings).toHaveLength(3);
    expect(full.holdings[2]).toMatchObject({ ticker: 'XYZ', value_usd: 700, weight_equity: 700 / 23700 });

    const range = (await v1('/v1/filers/2045724/holdings?from=2025Q4&to=2026Q2')).body;
    expect(range.data.map((b: { quarter: string }) => b.quarter)).toEqual(['2026Q2']);
    expect(range.missing).toEqual(['2025Q4', '2026Q1']);
    expect(range.next_from).toBeNull();
    const long = (await v1('/v1/filers/2045724/holdings?from=2024Q1&to=2026Q2')).body;
    expect(long.missing).toHaveLength(8);
    expect(long.next_from).toBe('2026Q1');
    expect((await v1('/v1/filers/2045724/holdings?from=2026Q2&to=2026Q1')).status).toBe(400);

    // Holders of one stock, by ticker or CUSIP, from the paid per-issuer list.
    expect((await v1('/v1/stocks/NVDA/holders')).status).toBe(501);
    hist.m.set('s/67066G.json', new TextEncoder().encode(JSON.stringify({
      issuer: '67066G', ticker: 'NVDA', display_name: 'NVIDIA', period: '2026Q2', prev_period: '2026Q1',
      columns: ['cik', 'name', 'slug', 'kind', 'shares', 'prev_shares', 'value', 'prev_value', 'change'],
      holders: [['0002045724', 'Situational Awareness LP', 'situational-awareness-lp-5724', 'equity', 100, 40, 18000, 6000, 'added'], ['0001067983', 'Berkshire Hathaway Inc', 'warren-buffett', 'equity', 10, 0, 1800, 0, 'new']],
    })));
    const h = (await v1('/v1/stocks/NVDA/holders')).body;
    expect(h.data).toMatchObject({ issuer: '67066G', ticker: 'NVDA', quarter: '2026Q2', prev_quarter: '2026Q1', cohort: 'all' });
    expect(h.data.holders[0]).toMatchObject({ filer: { cik: '0002045724' }, shares: 100, prev_shares: 40, share_change: 60, value_usd: 18000, change: 'added' });
    expect((await v1('/v1/stocks/67066G104/holders')).body.data).toEqual(h.data);
    expect((await v1('/v1/stocks/NVDA/holders?cohort=curated')).body.data.holders.map((x: { filer: { cik: string } }) => x.filer.cik)).toEqual(['0001067983']);
    expect((await v1('/v1/stocks/NVDA/holders?quarter=2026Q1')).status).toBe(404);
    expect((await v1('/v1/stocks/ZZZZ/holders')).status).toBe(404);

    // Bulk exports: listed, then streamed as uploaded.
    expect((await v1('/v1/bulk/2026Q2.csv.gz')).status).toBe(404);
    hist.m.set('bulk/2026Q2.csv.gz', new Uint8Array([31, 139, 8, 0, 1, 2, 3]));
    expect((await v1('/v1/bulk')).body.data).toEqual([{ file: '2026Q2.csv.gz', quarter: '2026Q2', bytes: 7, uploaded_at: '1970-01-01T00:00:00.000Z', url: 'https://api.test/v1/bulk/2026Q2.csv.gz' }]);
    const gz = await handleRequest(new Request('https://api.test/v1/bulk/2026Q2.csv.gz', { headers: { authorization: `Bearer ${key}` } }), env);
    expect(gz.headers.get('content-disposition')).toBe('attachment; filename="copybook-13f-2026Q2.csv.gz"');
    expect([...new Uint8Array(await gz.arrayBuffer())]).toEqual([31, 139, 8, 0, 1, 2, 3]);
  });

  it('Copy paid data: the full Flow from R2, a per-stock holder CSV, one CSV across followed funds', async () => {
    index = { generated_at: '2026-11-08T21:29:01Z', managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, status: 'current', form: '13F-HR', accession: 'A2', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', total_value: 2000, position_count: 1, history_quarters: ['2026Q2', '2026Q1'] }] };
    await cron(17);
    stripeObjects['checkout/sessions/cs_test_pd'] = { id: 'cs_test_pd', status: 'complete', created: now(), subscription: 'sub_pd', customer_details: { email: 'pd@example.com' } };
    stripeObjects['subscriptions/sub_pd'] = sub('sub_pd', 'cus_pd', 'active');
    const t = (await (await call('/session', { body: { checkout_session: 'cs_test_pd' } })).json()).token;
    expect((await call('/flow')).status).toBe(401);

    expect((await call('/flow', { token: t })).status).toBe(404);
    hist.m.set('flow/full.json', new TextEncoder().encode('{"periods":[{"quarter":"2026Q2","featured":{"bought":[{"ticker":"NVDA","n_buyers":31}]}}]}'));
    expect((await (await call('/flow', { token: t })).json()).periods[0].featured.bought[0].n_buyers).toBe(31);

    // Every 13F holder once published: share change computed, names with commas quoted.
    stockPages['NVDA'] = { classes: [{ cusip: '67066G104' }], holders: [{ slug: 'warren-buffett', manager: 'Warren Buffett', quarter: '2026Q2', shares: 10, prev_shares: 0, value: 1800, change: 'new', weight: 0.9 }] };
    let csv = await call('/stocks/nvda/holders.csv', { token: t });
    expect(csv.headers.get('x-copybook-coverage')).toBe('curated');
    expect((await csv.text()).split('\r\n')[1]).toBe(',Warren Buffett,warren-buffett,equity,2026Q2,10,0,10,1800,,new,0.9,,');
    hist.m.set('s/67066G.json', new TextEncoder().encode(JSON.stringify({ issuer: '67066G', period: '2026Q2', columns: ['cik', 'name', 'slug', 'kind', 'shares', 'prev_shares', 'value', 'prev_value', 'change'], holders: [['0001387322', 'Whale Rock, LLC', null, 'equity', 100, 140, 18000, 20000, 'trimmed']] })));
    csv = await call('/stocks/NVDA/holders.csv', { token: t });
    expect(csv.headers.get('x-copybook-coverage')).toBe('all-filers');
    expect((await csv.text()).split('\r\n')[1]).toBe('0001387322,"Whale Rock, LLC",,equity,2026Q2,100,140,-40,18000,20000,trimmed,,,');
    expect((await call('/stocks/ZZZZ/holders.csv', { token: t })).status).toBe(404);

    // The followed funds' latest books in one file, one row per position with its fund.
    await call('/follows/warren-buffett', { method: 'POST', token: t });
    const all = await call('/follows.csv', { token: t });
    expect(all.headers.get('x-copybook-funds')).toBe('1');
    const lines = (await all.text()).trim().split('\r\n');
    expect(lines[0]).toMatch(/^manager,slug,cik,quarter/);
    expect(lines[1]).toMatch(/^Warren Buffett,warren-buffett,0001067983,2026Q2,2026-06-30,2026-08-14,A2,AAPL,APPLE INC,037833100/);
  });

  it('book import: pasted list, broker CSV, and a 13F filer by CIK that follows its newest quarter', async () => {
    stripeObjects['checkout/sessions/cs_test_bk'] = { id: 'cs_test_bk', status: 'complete', created: now(), subscription: 'sub_bk', customer_details: { email: 'bk@example.com' } };
    stripeObjects['subscriptions/sub_bk'] = sub('sub_bk', 'cus_bk', 'active');
    const t = (await (await call('/session', { body: { checkout_session: 'cs_test_bk' } })).json()).token;
    const imp = async (b: unknown) => (await call('/book/import', { body: b, token: t })).json();

    let r = await imp({ text: '$aapl, BRK-B\nmsft  googl 12345' });
    expect(r).toMatchObject({ ok: true, imported: 4, skipped: ['12345'] });
    expect(r.follows.owned).toEqual(['AAPL', 'BRK.B', 'MSFT', 'GOOGL']);
    // A broker CSV: the Symbol column, not the first; quoted names with commas; a totals line.
    r = await imp({ csv: 'Account,Symbol,Description,Quantity\n"X-1",NVDA,"NVIDIA, Corp",10\n"X-1",cof,"Capital One",5\nTotal,,,\n' });
    expect(r).toMatchObject({ ok: true, imported: 2 });
    expect(r.follows.owned).toEqual(['NVDA', 'COF']);
    expect(r.follows.stocks).toEqual(['NVDA', 'COF']); // replace: the old book left the watchlist too
    await call('/follows/stocks/TSLA', { method: 'POST', token: t });

    // A 13F filer's book: tickers largest first, options left out; hand-added owned names survive a refresh.
    const cols = ['ticker', 'issuer', 'title', 'cusip', 'put_call', 'shares', 'value', 'display_name', 'sector'];
    shards['0002045724.json'] = { ok: true, name: 'Situational Awareness LP', quarter: '2026Q2', columns: cols, rows: [['BE', 'BLOOM', 'COM', '093712107', null, 1, 500, null, null], ['NVDA', 'NVIDIA', 'COM', '67066G104', null, 1, 900, null, null], ['TSM', 'TSMC', 'ADR', '874039100', 'Call', 1, 2000, null, null]] };
    r = await imp({ cik: '2045724' });
    expect(r).toMatchObject({ ok: true, imported: 2, source: { cik: '0002045724', quarter: '2026Q2' } });
    expect(r.follows.owned).toEqual(['NVDA', 'BE']);
    expect(r.follows.stocks).toEqual(['NVDA', 'TSLA', 'BE']);
    await call('/follows/owned/AMD', { method: 'POST', token: t });

    shards['0002045724.json'] = { ...(shards['0002045724.json'] as object), quarter: '2026Q3', rows: [['NVDA', 'NVIDIA', 'COM', '67066G104', null, 1, 900, null, null], ['INTC', 'INTEL', 'COM', '458140100', null, 1, 100, null, null]] };
    await cron(52);
    const f = (await (await call('/follows', { token: t })).json()).follows;
    expect(f.owned).toEqual(['NVDA', 'AMD', 'INTC']);
    expect(f.stocks).toEqual(['NVDA', 'TSLA', 'AMD', 'INTC']);
    expect(f.book).toMatchObject({ cik: '0002045724', quarter: '2026Q3', tickers: ['NVDA', 'INTC'] });

    expect((await call('/book/import', { body: { cik: '0009999999' }, token: t })).status).toBe(404);
    expect((await call('/book/import', { body: { text: '!!! ???' }, token: t })).status).toBe(400);
  });

  it('/v1 restatement lineage: versions[] oldest first with status, every amendment attached, ?version= serves the book as originally filed', async () => {
    index = { generated_at: '2026-11-08T21:29:01Z', managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, status: 'current', form: '13F-HR/A', accession: 'R', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-09-02', total_value: 3000, position_count: 1, history_quarters: ['2026Q2'] }] };
    await cron(17);
    const ORIG = '0001104659-26-097200', REST = '0001104659-26-104387', NEWH = '0001104659-26-110001';
    // The data run serves the restatement and merged nothing; a later NEW HOLDINGS amendment isn't in it.
    hist.m.set('h/warren-buffett/2026Q2.json', new TextEncoder().encode(JSON.stringify({
      quarter: '2026Q2', report_date: '2026-06-30', accession: REST, form: '13F-HR/A', filing_date: '2026-09-02', sec_url: 'https://www.sec.gov/Archives/edgar/data/1067983/x-index.html', amendments: [], prev_quarter: '2026Q1', total_value: 3000, position_count: 1,
      holdings: [{ cusip: '037833100', ticker: 'AAPL', issuer: 'APPLE INC', title: 'COM', put_call: null, shares: 15, value: 3000, weight: 1, change: 'added', prev_shares: 10, share_change: 5, value_delta: 1000 }],
    })));
    secFiles['submissions/CIK0001067983.json'] = JSON.stringify({ filings: { recent: {
      accessionNumber: [NEWH, REST, ORIG, '0001104659-26-062477'], form: ['13F-HR/A', '13F-HR/A', '13F-HR', '13F-HR'], reportDate: ['2026-06-30', '2026-06-30', '2026-06-30', '2026-03-31'],
    } } });
    const dir = (a: string) => `Archives/edgar/data/1067983/${a.replace(/-/g, '')}/`;
    secFiles[`${dir(ORIG)}${ORIG}-index-headers.html`] = '<ACCEPTANCE-DATETIME>20260814161847\n<TYPE>13F-HR\n<FILING-DATE>20260814\n';
    secFiles[`${dir(REST)}${REST}-index-headers.html`] = '<ACCEPTANCE-DATETIME>20260901181400\n<TYPE>13F-HR/A\n<FILING-DATE>20260902\n';
    secFiles[`${dir(REST)}primary_doc.xml`] = '<isAmendment>true</isAmendment><amendmentNo>1</amendmentNo><amendmentType>RESTATEMENT</amendmentType>';
    secFiles[`${dir(NEWH)}${NEWH}-index-headers.html`] = '<ACCEPTANCE-DATETIME>20261002090000\n<TYPE>13F-HR/A\n<FILING-DATE>20261002\n';
    secFiles[`${dir(NEWH)}primary_doc.xml`] = '<isAmendment>true</isAmendment><amendmentNo>2</amendmentNo><amendmentType>NEW HOLDINGS</amendmentType><confDeniedExpired>false</confDeniedExpired>';
    // The original as filed on EDGAR: 10 AAPL and 20 BAC.
    secFiles[`${dir(ORIG)}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '900' }, { name: 'infotable.xml', size: '700' }] } });
    secFiles[`${dir(ORIG)}primary_doc.xml`] = '<periodOfReport>06-30-2026</periodOfReport>';
    secFiles[`${dir(ORIG)}infotable.xml`] = '<infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>037833100</cusip><value>2000</value><sshPrnamt>10</sshPrnamt></infoTable><infoTable><nameOfIssuer>BANK OF AMERICA</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>060505104</cusip><value>800</value><sshPrnamt>20</sshPrnamt></infoTable>';

    stripeObjects['checkout/sessions/cs_test_ver'] = { id: 'cs_test_ver', status: 'complete', created: now(), subscription: 'sub_ver', customer_details: { email: 'ver@example.com' } };
    stripeObjects['subscriptions/sub_ver'] = sub('sub_ver', 'cus_ver', 'active', 'month', 'pro_monthly');
    const t = (await (await call('/session', { body: { checkout_session: 'cs_test_ver' } })).json()).token;
    const key = (await (await call('/keys', { body: { name: 'k' }, token: t })).json()).key;
    const v1 = async (path: string) => {
      const r = await handleRequest(new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${key}` } }), env);
      return { status: r.status, body: await r.json() };
    };

    const cur = (await v1('/v1/filers/warren-buffett/holdings/2026Q2')).body.data;
    expect(cur.filing).toMatchObject({ accession: REST, accepted_at: '2026-09-01T22:14:00.000Z', amendment_type: 'RESTATEMENT' });
    expect(cur.filing.versions.map((v: { accession: string; status: string; accepted_at: string }) => [v.accession, v.status, v.accepted_at])).toEqual([
      [ORIG, 'superseded', '2026-08-14T20:18:47.000Z'],
      [REST, 'current', '2026-09-01T22:14:00.000Z'],
      [NEWH, 'not_merged', '2026-10-02T13:00:00.000Z'],
    ]);
    // Amendments come from EDGAR, not only the ones the data run merged.
    expect(cur.filing.amendments.map((a: { accession: string; amendment_type: string }) => [a.accession, a.amendment_type])).toEqual([[REST, 'RESTATEMENT'], [NEWH, 'NEW HOLDINGS']]);

    const orig = await v1('/v1/filers/warren-buffett/holdings/2026Q2?version=original');
    expect(orig.status).toBe(200);
    expect(orig.body.data).toMatchObject({ version: ORIG, total_value_usd: 2800, position_count: 2, filing: { accession: ORIG, form: '13F-HR', accepted_at: '2026-08-14T20:18:47.000Z', amendment_type: null, filing_date: '2026-08-14' } });
    expect(orig.body.data.holdings.map((h: { ticker: string; shares: number; value_usd: number; change: string | null }) => [h.ticker, h.shares, h.value_usd, h.change])).toEqual([['AAPL', 10, 2000, null], [null, 20, 800, null]]);
    expect((await v1(`/v1/filers/1067983/holdings/2026Q2?version=${ORIG}`)).body.data.version).toBe(ORIG);
    expect((await v1(`/v1/filers/warren-buffett/holdings/2026Q2?version=${REST}`)).body.data).toMatchObject({ version: REST, total_value_usd: 3000 });
    expect((await v1('/v1/filers/warren-buffett/holdings/2026Q2?version=0000000000-26-000000')).status).toBe(404);
    expect((await v1('/v1/filers/warren-buffett/holdings/2026Q2?version=first')).status).toBe(400);
  });

  it('/v1 filers and holdings: by slug or CIK, every field the OpenAPI schema requires, as_of not served yet', async () => {
    index = { generated_at: '2026-11-08T21:29:01Z', managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, status: 'current', form: '13F-HR', accession: 'A2', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', total_value: 2000, position_count: 1, history_quarters: ['2026Q2', '2025Q1'] }] };
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
    expect(fl.body.data[0]).toMatchObject({ curated: true, type: null }); // null until classified
    // Cached after the first read: EDGAR is not asked again.
    delete secFiles[`${dir('0000950123-25-008361')}0000950123-25-008361-index-headers.html`];
    expect((await v1('/v1/filers/warren-buffett/holdings/2025Q1')).body.data.filing.amendments[0].amendment_type).toBe('NEW HOLDINGS');
    expect(d.holdings[0]).toMatchObject({ ticker: 'NUE', issuer: 'NUCOR CORP', shares_type: null, value_usd: 1000, weight: 1, change: 'new', value_delta_usd: 1000, source_accession: null, first_disclosed_at: null });
    expect(d.exited[0]).toMatchObject({ ticker: 'AAPL', shares: 0, value_delta_usd: -500 });
    // Freshness on every response, and exited rows are not zero-value holdings.
    expect(bySlug.body).toMatchObject({ data_built_at: '2026-11-08T21:29:01Z', build_id: '20261108T212901Z' });
    expect(d.holdings[0]).toMatchObject({ weight_equity: 1, zero_value: false });
    expect(d.exited[0]).toMatchObject({ zero_value: false });
    expect(d.filing.filer_cik).toBe('0001067983');
    // Once the data run publishes its equity-book weight (with delta_pct_of_book), weight is that,
    // at once; weight_equity is the alias. An option row gets null.
    hist.m.set('h/warren-buffett/2025Q2.json', new TextEncoder().encode(JSON.stringify({
      quarter: '2025Q2', report_date: '2025-06-30', accession: '0000950123-25-005701', form: '13F-HR', filing_date: '2025-08-14', sec_url: 'https://www.sec.gov/x', prev_quarter: '2025Q1', total_value: 1500,
      holdings: [
        { cusip: '670346105', ticker: 'NUE', issuer: 'NUCOR CORP', shares: 10, value: 1000, weight: 0.6667, pct_of_book: 1, delta_pct_of_book: 0 },
        { cusip: '670346105', ticker: 'NUE', issuer: 'NUCOR CORP', put_call: 'Call', shares: 5, value: 500, weight: 0.3333, pct_of_book: null, delta_pct_of_book: 0.33 },
      ],
    })));
    const w = (await v1('/v1/filers/warren-buffett/holdings/2025Q2')).body.data.holdings;
    expect(w.map((r: { weight: number | null; weight_equity: number | null }) => [r.weight, r.weight_equity])).toEqual([[1, 1], [null, null]]);
    for (const k of spec.components.schemas.Error.required) expect((await v1('/v1/filers/warren-buffett/holdings/2025Q9')).body).toHaveProperty(k);
    expect((await handleRequest(new Request('https://api.test/v1/changelog'), env)).status).toBe(200); // no key needed
    expect((await handleRequest(new Request('https://api.test/v1/filers', { headers: { authorization: `Bearer ${key}`, 'copybook-schema-version': '1999-01-01' } }), env)).status).toBe(400);
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
