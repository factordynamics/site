import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The site's display-name overrides: empty for the fixture tests (their slugs, like warren-buffett, stand for any filer);
// the display-names test loads the real shared file.
const names = vi.hoisted(() => ({ map: {} as Record<string, string> }));
vi.mock('../src/names', () => ({
  siteName: (slug: string | null | undefined) => (slug ? (names.map[slug] ?? null) : null),
  siteFirm: (slug: string | null | undefined) => (slug && names.map[slug] ? names.map[slug].replace(/\s*\([^)]*\)$/, '') : null),
}));
import worker, { handleRequest } from '../src/index';
import { isActive, isPaused, type Env, type KV, type R2 } from '../src/env';
import { MeterLogic } from '../src/keys';
import { getFollows, MemberFollows } from '../src/members';
import { guardDataRun, resolveFollowedFilers, runDigest } from '../src/alerts';
import { alertMail } from '../src/email';
import { webhookPayloads } from '../src/channels';
import { hmacHex } from '../src/tokens';
import form4Len from './fixtures/form4-len.xml?raw';
import durableQ2 from './fixtures/durable-q2-shard.json';
import sc13dCvi from './fixtures/sc13da-cvi.xml?raw';
import cvi41 from './fixtures/cvi-13da-41-primary.xml?raw';
import form4Jain from './fixtures/form4-brk-jain.txt?raw';
import sc13gSiri from './fixtures/sc13ga-siri-vanguard.xml?raw';
import form4BuffettGift from './fixtures/form4-brk-buffett-gift.txt?raw';
import sc13dBrkA from './fixtures/sc13da-brk-class-a.xml?raw';
import { quarterStart } from '../src/seasons';
import { computeMoves, displayCase, gateMoves, movesOf, unreliableSide } from '../src/edgar';
import { forMember } from '../src/alerts';
import { runSeasonal } from '../src/revenue';
import { signToken } from '../src/tokens';
import { pauseResumesAt, deadlineMs, deadlineLabel } from '../src/seasons';
import form4Csgp from './fixtures/form4-csgp-florance-buy.txt?raw';
import form4Googl from './fixtures/form4-googl-walker.txt?raw';
import form4Dash from './fixtures/form4-dash-tang.txt?raw';
import { withTrade, type StockEvent } from '../src/stockevents';
import { cleanItem4, parseSchedule13 } from '../src/edgar';

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
  meta = new Map<string, Record<string, string>>();
  /** Upload order, as R2's `uploaded` (a counter: two puts in one millisecond still order); only where a test asks. */
  up = new Map<string, number>();
  seq = 0;
  uploads = false;
  async get(k: string) {
    const v = this.m.get(k);
    if (!v) return null;
    // Deliver in two chunks with the header line split, as R2 may.
    return { size: v.length, ...(this.uploads ? { uploaded: new Date(this.up.get(k) ?? 0) } : {}), customMetadata: this.meta.get(k), body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(v.subarray(0, 20)); c.enqueue(v.subarray(20)); c.close(); } }) };
  }
  async put(k: string, v: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, opts?: { customMetadata?: Record<string, string> }) {
    this.m.set(k, new Uint8Array(await new Response(v as BodyInit).arrayBuffer()));
    this.up.set(k, ++this.seq);
    if (opts?.customMetadata) this.meta.set(k, opts.customMetadata);
    else this.meta.delete(k);
  }
  async list({ prefix }: { prefix: string }) {
    return { objects: [...this.m].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length, uploaded: new Date(0), customMetadata: this.meta.get(key) })) };
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
let sent: { from?: string; to: string[]; subject: string; text: string; html?: string; reply_to?: string }[];
let stripeObjects: Record<string, unknown>;
let index: unknown;
let secFiles: Record<string, string>;
let filers: Record<string, unknown>[];
let posts: { url: string; body: string; headers: Record<string, string> }[];
let hookStatus: number;
/** Queued answers per chat host (discord.com, hooks.slack.com, api.telegram.org); 200 once empty. */
let chatReplies: Record<string, { status: number; body?: unknown }[]>;
let shards: Record<string, unknown>;
let events: unknown[];
let recentMoves: unknown[];
let consensusQ: Record<string, Record<string, number>>;
let resendUsed = 0;
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
      return { fetch: async (u: string) => Response.json(u.includes('/hit') ? await m.hit() : u.includes('/count') ? await m.count().then(() => ({ ok: true })) : await m.usage(Number(new URL(u).searchParams.get('days')) || 30)) };
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
  env = { DB: new MemKV(), HIST: hist, INGEST_WORKFLOW: WORKFLOW, SITE_URL: SITE, DATA_URL: `${SITE}data/`, EMAIL_FROM: 'Copybook <a@b.c>', CONTACT_EMAIL: 'hello@example.com', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', SESSION_SECRET: 'session-secret', RESEND_API_KEY: 're_x', TEST_MAIL_SINK: 'off', METER: memMeters(), FOLLOWS: undefined as never };
  env.HEALTH_TOKEN = 'health_test_token';
  // The fixture indexes carry only the fields each test needs; the routing contract has its own test (contract.test.ts).
  await env.DB.put('index:contract', JSON.stringify({ ok: false, build: null, problems: ['fixture'] }));
  // 2026Q1 lives only in the private bucket; 2026Q2 still falls back to the public copy.
  hist.m.set('h/warren-buffett/2026Q1.csv', new TextEncoder().encode('manager,slug,cik,quarter,report_date,filing_date,accession,ticker,issuer,cusip,title,put_call,shares,value_usd,weight,change,prev_shares,share_change,value_delta_usd,pct_of_book\r\nWarren Buffett,warren-buffett,0001067983,2026Q1,2026-03-31,2026-05-15,A1,BAC,"BANK, ""OF"" AMERICA",060505104,COM,,5,100,0.1,new,,5,100,0.1\r\n'));
  env.FOLLOWS = memFollows();
  sent = [];
  stripeObjects = {};
  index = { managers: [] };
  secFiles = {};
  posts = [];
  hookStatus = 200;
  chatReplies = {};
  filers = [{ cik: '0002045724', name: 'Situational Awareness LP', slug: 'situational-awareness-lp-5724', ok: true, position_count: 2, quarter: '2026Q2', error: null }];
  shards = {};
  stockPages = {};
  // The curated managers the tests follow, as the hourly run maps them from index.json.
  await env.DB.put('alerts:ciks', JSON.stringify(Object.fromEntries([['0001067983', 'warren-buffett'], ['0001040273', 'dan-loeb'], ['0001336528', 'bill-ackman'], ['0001061768', 'seth-klarman']].map(([cik, slug]) => [cik, [{ slug, manager: slug, name: slug, cik, featured: true }]]))));
  events = [];
  recentMoves = [];
  consensusQ = {};
  resendUsed = 0;
  (await import('../src/email')).mailQuota.day = '';
  gh = [];
  ghQueued = 0;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.resend.com/emails/batch') {
      // Resend's daily quota: refuses everything once `resendUsed` reaches 100.
      const batch = JSON.parse(String(init?.body)) as unknown[];
      if (resendUsed + batch.length > 100) return Response.json({ name: 'daily_quota_exceeded' }, { status: 429, headers: { 'x-resend-daily-quota': String(resendUsed) } });
      resendUsed += batch.length;
      sent.push(...(batch as typeof sent));
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
      const next = chatReplies[new URL(url).hostname]?.shift();
      if (next) return Response.json(next.body ?? {}, { status: next.status });
      return new Response('ok', { status: url.startsWith('https://hooks.example.com') ? hookStatus : 200 });
    }
    if (url === `${SITE}data/index.json`) return Response.json(index);
    if (url.startsWith(`${SITE}d/stocks/`)) { const k = url.slice(`${SITE}d/stocks/`.length).replace('.json', ''); return stockPages[k] ? Response.json(stockPages[k]) : new Response('not found', { status: 404 }); }
    if (url === `${SITE}d/f/index.json`) return Response.json({ cards: [{ accession: '0000950123-26-011111', slug: 'warren-buffett' }] });
    if (url === `${SITE}data/filers.json`) return new Response(JSON.stringify({ count: filers.length, filers }, null, 1));
    if (url.startsWith(`${SITE}data/f/`)) return shards[url.slice(`${SITE}data/f/`.length)] ? Response.json(shards[url.slice(`${SITE}data/f/`.length)]) : new Response('not found', { status: 404 });
    // Ingest's per-CIK filer types (every 13F filer, not only curated ones).
    if (url === `${SITE}data/filer_types.json`) return Response.json({ types: ['hedge_fund'], filers: { '0001423053': { type: 'hedge_fund', basis: 'name' } } });
    if (url === `${SITE}data/stock_holders.json`) return new Response('{"stocks":[{"issuer":"67066G","ticker":"NVDA","display_name":"NVIDIA"},{"issuer":"037833","ticker":"AAPL"}]}');
    if (url === `${SITE}data/alerts.json`) return Response.json({ recent: recentMoves });
    if (url === `${SITE}data/consensus.json`) return Response.json({ quarters: consensusQ });
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
      if (key.startsWith('company:') || key.startsWith('feed@')) return new Response(secFiles[typed] ?? secFiles[key] ?? '<feed></feed>');
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

/** A subscriber back from checkout (a provisional session), then signed in by the welcome email's link: a full session. */
async function fullCheckout(cs: string): Promise<Response> {
  const r = await call('/session', { body: { checkout_session: cs } });
  if (r.status !== 200) return r;
  const o = stripeObjects as Record<string, { subscription?: string; customer?: string | { id: string } }>;
  const sub = o[`subscriptions/${o[`checkout/sessions/${cs}`].subscription}`];
  return call('/session', { body: { login: await signToken(env.SESSION_SECRET, 'login', typeof sub.customer === 'string' ? sub.customer : sub.customer!.id, 3600) } });
}
const privateHealth = () => handleRequest(new Request('https://api.test/health', { headers: { authorization: 'Bearer health_test_token' } }), env);

function loginTokenFrom(text: string): string {
  return decodeURIComponent(text.match(/account\/\?login=([^\s]+)/)![1]);
}

/** Each member's 2-minute email window from an earlier run has ended (tests run polls back to back). */
async function windowsEnded() {
  for (const k of (await env.DB.list({ prefix: 'mailwin:' })).keys) await env.DB.delete(k.name);
  await env.DB.delete('mail:held');
}

/** Runs the minute cron as if at hh:mm UTC today (hour 3 is the digest hour, so avoided by default), or at a given time. */
async function cron(minute: number, at?: number) {
  const t = new Date(at ?? Date.now());
  if (at === undefined) t.setUTCHours(t.getUTCHours() === 3 ? 4 : t.getUTCHours(), minute, 0, 0);
  await windowsEnded();
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
    // A sign-in link works once: the same link again (cleared storage, a forwarded email) is refused.
    const again = await call('/session', { body: { login: loginTokenFrom(sent[0].text) } });
    expect([again.status, (await again.json()).code]).toEqual([401, 'link_used']);
    // A link the member asks for lasts 15 minutes, and says so.
    sent = [];
    await call('/login', { body: { email: 'buyer@example.com' } });
    const asked = JSON.parse(atob(loginTokenFrom(sent[0].text).split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    expect([asked.x - Math.floor(Date.now() / 1000) <= 15 * 60, sent[0].text.includes('works once, for 15 minutes')]).toEqual([true, true]);

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
    // Every row has exactly the header's fields (the follows CSV once had 20 header fields and 33 per row).
    const head = lines[0].split(',');
    expect(head).toHaveLength(33);
    const parse = (l: string) => {
      const out = [''];
      let q = false;
      for (let i = 0; i < l.length; i++) {
        if (q && l[i] === '"' && l[i + 1] === '"') (out[out.length - 1] += '"'), i++;
        else if (l[i] === '"') q = !q;
        else if (l[i] === ',' && !q) out.push('');
        else out[out.length - 1] += l[i];
      }
      return out;
    };
    const rec = (l: string) => Object.fromEntries(head.map((k, i) => [k, parse(l)[i]]));
    for (const l of lines.slice(1)) expect(parse(l)).toHaveLength(head.length);
    expect(rec(lines[1])).toMatchObject({ quarter: '2026Q2', accession: 'A2', ticker: 'AAPL', shares: '10', value_usd: '2000', weight: '0.5', change: 'added', prev_shares: '4', share_change: '6', value_delta_usd: '1200', pct_of_book: '0.3' });
    expect(rec(lines[2])).toMatchObject({ ticker: 'BAC', shares: '0', change: 'exited', value_delta_usd: '-100', pct_of_book: '-0.025' });
    expect(rec(lines[3])).toMatchObject({ quarter: '2026Q1', accession: 'A1', issuer: 'BANK, "OF" AMERICA', change: 'new', value_delta_usd: '100', pct_of_book: '0.1' });
    expect(csv.match(/^manager,/gm)).toHaveLength(1);

    // The session token is never accepted from a URL.
    expect((await call(`/csv/warren-buffett.csv?token=${session.token}`)).status).toBe(401);
    expect((await call(`/me?token=${session.token}`)).status).toBe(401);

    // Download links: single use, one file, no session token in the URL.
    const link = (await (await call('/csv-link/warren-buffett', { method: 'POST', token: session.token })).json()).url as string;
    expect(link).toMatch(/^https:\/\/api\.test\/csv\/warren-buffett\.csv\?dl=/);
    expect(link).not.toContain(session.token);
    // Behind a proxy under a path (self-hosted), links use API_URL, not the request's origin.
    const proxied = (await (await handleRequest(new Request('http://127.0.0.1:8787/csv-link/warren-buffett', { method: 'POST', headers: { authorization: `Bearer ${session.token}` } }), { ...env, API_URL: 'https://host.test/copybook/' })).json()).url as string;
    expect(proxied).toMatch(/^https:\/\/host\.test\/copybook\/csv\/warren-buffett\.csv\?dl=/);
    // A short-lived link follows the entry point the self-hosted front door reports; a base it didn't set is ignored.
    const via = async (base: string) => (await (await handleRequest(new Request('http://127.0.0.1:8787/csv-link/warren-buffett', { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'x-copybook-public-base': base } }), { ...env, API_URL: 'https://host.test/copybook/' })).json()).url as string;
    expect(await via('https://solid-amanda-dir-fiction.trycloudflare.com/copybook')).toMatch(/^https:\/\/solid-amanda-dir-fiction\.trycloudflare\.com\/copybook\/csv\/warren-buffett\.csv\?dl=/);
    expect(await via('https://evil.example/copybook')).toMatch(/^https:\/\/host\.test\/copybook\/csv\//);
    // A feed's self link too: readers follow feed_url, so it must keep the /copybook prefix.
    await env.DB.put('feedtok:feedtoken-proxied-0123456789', 'cus_feedself');
    const feed = await (await handleRequest(new Request('http://127.0.0.1:8787/feed/feedtoken-proxied-0123456789.json'), { ...env, API_URL: 'https://host.test/copybook/' })).json();
    expect(feed.feed_url).toBe('https://host.test/copybook/feed/feedtoken-proxied-0123456789.json');
    // On the Funnel name a small CSV is served from here (only one over 1 MB goes to presigned R2).
    {
      const fp = ((await (await call('/csv-link/warren-buffett', { method: 'POST', token: session.token })).json()).url as string).slice('https://api.test'.length);
      const r = await handleRequest(new Request(`https://api.test${fp}`, { headers: { 'x-copybook-public-base': 'https://gene.tail70ba3.ts.net/copybook' } }), env);
      expect([r.status, await r.text()]).toEqual([200, csv]);
    }
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

    const meY = (await (await call('/me', { token: session.token })).json()).member;
    expect([meY.founding_price, meY.yearly_perks]).toEqual([true, true]);
    await webhook({ type: 'customer.subscription.deleted', data: { object: sub('sub_1', 'cus_1', 'canceled', 'year') } });
    // A cancellation drops the founding price.
    const meC = (await (await call('/me', { token: session.token })).json()).member;
    expect([meC.founding_price, meC.yearly_perks]).toEqual([false, false]);
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
    stripeObjects['subscriptions/sub_2'] = sub('sub_2', 'cus_2', 'trialing');
    const r = await (await call('/session', { body: { checkout_session: 'cs_test_abc' } })).json();
    expect(r.member).toMatchObject({ email: 'fast@example.com', active: true, plan: 'copy', interval: 'monthly' });
    // A new subscriber is signed in on this device provisionally (anyone can type an address at checkout): on an
    // active trial it reads /me and follows; keys, channels and webhooks, billing, seats, a handoff and sign-out-
    // everywhere (which would mint a full session) answer a provisional-specific 403 until the emailed link is used.
    expect(r.session).toBe('provisional');
    expect((await call('/me', { token: r.token })).status).toBe(200);
    // Settings save at once and say delivery waits for the emailed link (the lead, Nov 11): follows, channels, the alert
    // scope and adding a card. Nothing is delivered until then.
    const fo = await (await call('/follows/investors/bill-ackman', { method: 'POST', token: r.token })).json();
    const ch = await call('/channels', { method: 'PUT', body: { email: false }, token: r.token });
    const me0 = await (await call('/me', { token: r.token })).json();
    const card = await (await call('/portal/card', { method: 'POST', token: r.token })).json();
    // Reads answer before the link (the lead, Nov 11): insider events, history; nothing is delivered until it's opened.
    secFiles['company:0000723125:4'] = '<feed></feed>';
    const ev = await call('/events?tickers=MU&window=quarter', { token: r.token });
    const hi = await call('/history/warren-buffett', { token: r.token });
    expect([ev.status, hi.status === 403]).toEqual([200, false]);
    const ackman = { slug: 'bill-ackman', slugs: ['bill-ackman'], manager: 'Bill Ackman', name: 'Pershing Square', quarter: '2026Q3', report_date: '2026-09-30', filing_date: new Date().toISOString().slice(0, 10), accession: '0001336528-26-000099', sec_url: 'https://www.sec.gov/x', accepted: new Date().toISOString(), moves: { bought_usd: 5e6, sold_usd: 0, new: [], added: [{ ticker: 'HHH', display_name: null, issuer: 'HHH', cusip: '44267T102', put_call: null, shares: 10, prev_shares: 5, value: 1e7, value_delta: 5e6, change: 'added' }], trimmed: [], exited: [] } };
    const before = sent.length;
    await (await import('../src/alerts')).deliver(env, [ackman as never], [], Date.now());
    expect(sent.slice(before).filter((x) => x.to.includes('fast@example.com'))).toEqual([]);
    // A pasted book saves too (the trader, Nov 11); linking a 13F filer waits for the link.
    const bk = await call('/book/import', { method: 'POST', body: { text: 'CRM, MU' }, token: r.token });
    const bkc = await call('/book/import', { method: 'POST', body: { cik: '0001067983' }, token: r.token });
    expect([bk.status, (await bkc.json()).code]).toEqual([200, 'verify_email']);
    // A Copy subscription from before Feb 1, 2027 holds the founding price; a monthly one has no yearly perks.
    expect([me0.member.founding_price, me0.member.yearly_perks]).toEqual([true, false]);
    expect([r.delivery, fo.ok, fo.delivery, ch.status, (await ch.json()).delivery, me0.member?.delivery ?? me0.delivery, /^https:\/\/billing\.stripe\.com\//.test(card.url)]).toEqual(['pending_email_confirmation', true, 'pending_email_confirmation', 200, 'pending_email_confirmation', 'pending_email_confirmation', true]);
    for (const [method, path, body] of [['GET', '/keys'], ['POST', '/keys', { name: 'x' }], ['POST', '/channels/test'], ['POST', '/portal'], ['GET', '/seats'], ['POST', '/handoff'], ['POST', '/me/sessions/revoke']] as [string, string, unknown?][]) {
      const res = await call(path, { method, body, token: r.token });
      expect([path, res.status, (await res.json()).code]).toEqual([path, 403, 'verify_email']);
    }
    // The welcome's link proves the address: a full session, and the provisional one ends.
    const welcome = sent.find((m) => m.to[0] === 'fast@example.com')!;
    expect(welcome.text).toContain('Open this link to confirm your address: it turns on alert channels, API keys and billing, and signs you in on any other device');
    const full = await (await call('/session', { body: { login: loginTokenFrom(welcome.text) } })).json();
    const meFull = await (await call('/me', { token: full.token })).json();
    expect([(await call('/channels', { token: full.token })).status, (await call('/me', { token: r.token })).status, meFull.member?.delivery ?? meFull.delivery]).toEqual([200, 401, 'active']);
    // A checkout that types the address of an account made before it never hands off a session to that account.
    await putMember('cus_old', 'taken@example.com', 'active', []);
    await env.DB.put('email:taken@example.com', 'cus_old');
    stripeObjects['checkout/sessions/cs_test_taken'] = { id: 'cs_test_taken', status: 'complete', created: now() - 30, subscription: 'sub_tk', customer_details: { email: 'taken@example.com' } };
    stripeObjects['subscriptions/sub_tk'] = sub('sub_tk', 'cus_tk', 'trialing');
    const taken = await (await call('/session', { body: { checkout_session: 'cs_test_taken' } })).json();
    // That address already had a subscription, so this second trial is cancelled at once ($0) and never a member.
    expect([taken.ok, taken.code, taken.token, await env.DB.get('cus:cus_tk')]).toEqual([true, 'trial_used', undefined, null]);
    // The same at checkout.session.completed (the visitor typed the email at Stripe, any case): blocked, counted, and
    // the earlier account and its follows are the member.
    await putMember('cus_rp', 'rp@example.com', 'canceled', []);
    await env.DB.put('email:rp@example.com', 'cus_rp');
    await putFollows('cus_rp', { investors: ['irving-kahn'] });
    stripeObjects['subscriptions/sub_rp2'] = sub('sub_rp2', 'cus_rp2', 'trialing');
    const blocked0 = Number((await env.DB.get('ops:trial_repeat_blocked')) ?? 0);
    await webhook({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_rp2', customer: 'cus_rp2', customer_details: { email: 'RP@Example.com' } } } });
    await webhook({ type: 'customer.subscription.created', data: { object: { ...(stripeObjects['subscriptions/sub_rp2'] as object), metadata: { trial_repeat_blocked: 'true' } } } });
    expect([await env.DB.get('cus:cus_rp2'), await env.DB.get('email:rp@example.com'), Number(await env.DB.get('ops:trial_repeat_blocked')) - blocked0, JSON.parse((await env.DB.get('follows:cus_rp'))!).investors]).toEqual([null, 'cus_rp', 1, ['irving-kahn']]);
    // A test address keeps its repeat trial (critics walk it again) but still merges into one account: the new record
    // takes the earlier one's follows, and the earlier one opens it.
    await putMember('cus_tm1', 'copybook-test-merge@example.com', 'trialing', ['irving-kahn']);
    await env.DB.put('email:copybook-test-merge@example.com', 'cus_tm1');
    await putFollows('cus_tm1', { investors: ['irving-kahn'] });
    stripeObjects['customers/cus_tm2'] = { id: 'cus_tm2', email: 'copybook-test-merge@example.com' };
    await webhook({ type: 'customer.subscription.created', data: { object: sub('sub_tm2', 'cus_tm2', 'trialing') } });
    const { getMember: gm } = await import('../src/members');
    expect([(await gm(env, 'cus_tm2'))?.status, JSON.parse((await env.DB.get('follows:cus_tm2'))!).investors, (await gm(env, 'cus_tm1'))?.customer, await env.DB.get('email:copybook-test-merge@example.com')]).toEqual(['trialing', ['irving-kahn'], 'cus_tm2', 'cus_tm2']);
    // A repeat checkout by a welcomed address (the trader, 20:17 and 20:52): one welcome, then "You're signed back in"
    // with a sign-in link for the new subscription, once however many events arrive.
    stripeObjects['customers/cus_bk1'] = { id: 'cus_bk1', email: 'back@example.com' };
    stripeObjects['customers/cus_bk2'] = { id: 'cus_bk2', email: 'back@example.com' };
    await webhook({ type: 'customer.subscription.created', data: { object: { ...sub('sub_bk1', 'cus_bk1', 'active'), created: now() - 60 } } });
    for (let i = 0; i < 2; i++) await webhook({ type: 'customer.subscription.updated', data: { object: { ...sub('sub_bk2', 'cus_bk2', 'active'), created: now() } } });
    expect(sent.filter((x) => x.to.includes('back@example.com')).map((x) => x.subject)).toEqual(['Welcome to Copy: three steps to your first alert', "You're signed back in to Copy"]);
    expect(sent.at(-1)!.text).toMatch(/account\/\?login=/);

    // subscription's webhook arriving before the return: still that account, so no hand-off (gene, 11:31: one was given).
    expect((await call('/signup', { body: { email: 'conv@example.com' } })).status).toBe(201);
    stripeObjects['checkout/sessions/cs_test_conv'] = { id: 'cs_test_conv', status: 'complete', created: now() + 5, subscription: 'sub_cv', customer: 'cus_cv', customer_details: { email: 'conv@example.com' } };
    stripeObjects['subscriptions/sub_cv'] = sub('sub_cv', 'cus_cv', 'trialing');
    stripeObjects['customers/cus_cv'] = { id: 'cus_cv', email: 'conv@example.com' };
    await webhook({ type: 'customer.subscription.created', data: { object: stripeObjects['subscriptions/sub_cv'] } });
    const conv = await (await call('/session', { body: { checkout_session: 'cs_test_conv' } })).json();
    expect([conv.ok, conv.code, conv.token]).toEqual([true, 'existing_account', undefined]);

    stripeObjects['checkout/sessions/cs_test_open'] = { id: 'cs_test_open', status: 'open', created: now(), subscription: null };
    expect((await fullCheckout('cs_test_open')).status).toBe(409);
  });

  it('alert rows are named from the ticker map, exits and held lines too; the filer\'s name only without a map entry', async () => {
    const { nameRows } = await import('../src/alerts');
    const row = (cusip: string, issuer: string, value_delta: number) => ({ cusip, issuer, ticker: null, display_name: null, put_call: null, shares: 0, prev_shares: 10, value: 0, value_delta });
    const moves = { bought_usd: 0, sold_usd: 0, new: [], added: [], trimmed: [], exited: [row('23331A109', 'D R HORTON IN', -9e6)], not_counted: [row('999999999', 'UNMAPPED AC', -1e6)] };
    const held = [row('037833100', 'APPLE IN', -5e6)];
    await nameRows(env, moves as never, held);
    expect([moves.exited[0].ticker, held[0].ticker, moves.not_counted[0].ticker, moves.not_counted[0].display_name]).toEqual(['DHI', 'AAPL', null, null]);
  });

  it("Kahn day: unconfirmed trials with follows get their confirmation link once; confirmed or follow-less ones don't", async () => {
    const tm = (c: string, extra: Record<string, unknown> = {}) => env.DB.put(`cus:${c}`, JSON.stringify({ customer: c, email: `${c}@reader.test`, status: 'trialing', plan: 'copy', interval: 'monthly', period_end: 0, subscription: `sub_${c}`, alerts: [], welcomed: true, email_pending: true, ...extra }));
    await tm('kc1');
    await putFollows('kc1', { investors: ['irving-kahn'] });
    await tm('kc2');
    await putFollows('kc2', {});
    await tm('kc3', { email_pending: undefined });
    await putFollows('kc3', { stocks: ['AAPL'] });
    const { runKahnConfirm } = await import('../src/revenue');
    expect(await runKahnConfirm(env, Date.UTC(2026, 10, 12, 10))).toEqual({ status: 'sent', sent: 1 });
    expect(sent.map((x) => [x.to[0] ?? x.to, x.subject])).toEqual([['kc1@reader.test', 'Kahn Brothers files today: confirm your email']]);
    // The link signs the member in, which confirms the address.
    const login = decodeURIComponent(sent[0].text.match(/login=([^\s]+)/)![1]);
    expect((await handleRequest(new Request('https://api.test/session', { method: 'POST', body: JSON.stringify({ login }) }), env)).status).toBe(200);
    expect(JSON.parse((await env.DB.get('cus:kc1'))!).email_pending).toBeUndefined();
    expect(await runKahnConfirm(env, Date.UTC(2026, 10, 12, 10, 5))).toEqual({ status: 'already done' });
    expect(sent).toHaveLength(1);
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
    expect(sent.map((m) => [m.to[0], m.subject])).toEqual([['a@example.com', 'Your Copybook sign-in link']]);
    // Unconfirmed with follows waiting: the link is titled and opened as the confirmation; without follows, plain.
    await env.DB.put('cus:cus_up', JSON.stringify({ customer: 'cus_up', email: 'up@example.com', status: 'trialing', plan: 'copy', interval: 'monthly', period_end: 0, subscription: 'sub_up', alerts: [], welcomed: true, email_pending: true }));
    await env.DB.put('email:up@example.com', 'cus_up');
    sent = [];
    await call('/login', { body: { email: 'up@example.com' } });
    await env.DB.delete('rl:up@example.com');
    await putFollows('cus_up', { stocks: ['CRM'] });
    await call('/login', { body: { email: 'up@example.com' } });
    expect(sent.map((m) => m.subject)).toEqual(['Your Copybook sign-in link', 'Confirm your email to start alerts']);
    expect(sent[1].text).toMatch(/^Your Copybook alerts start once you open this link/);
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
    // The uploading build is kept on the object, and the holder index is an accepted key.
    const tok = await jwt({});
    const st = await handleRequest(new Request('https://api.test/ingest/hl/829933.json', { method: 'PUT', body: '{}', headers: { authorization: `Bearer ${tok}`, 'x-copybook-build-id': 'gust-3a8c773b', 'x-copybook-built-at': '2026-11-09T02:30:00Z' } }), env);
    expect([st.status, hist.meta.get('hl/829933.json')]).toEqual([200, { build_id: 'gust-3a8c773b', built_at: '2026-11-09T02:30:00Z' }]);
    expect(await put('hl/82993.json', tok)).toBe(400);
    // Past quarters by ticker (ingest's hq/, Nov 23): one file per issuer per quarter, and the quarter's ticker index.
    expect([await put('hq/2025Q1/084670.json', tok), await put('hq/2025Q1/index.json', tok), await put('hq/2025Q5/084670.json', tok)]).toEqual([200, 200, 400]);
    // Many objects in one request: a manifest line, then their bytes back to back, each with its build.
    const batch = (objects: { key: string; body: string; build_id?: string }[], token = tok, sizes?: number[]) => {
      const enc = new TextEncoder();
      const parts = objects.map((o) => enc.encode(o.body));
      const head = enc.encode(`${JSON.stringify({ built_at: '2026-11-09T05:00:00Z', objects: objects.map((o, i) => ({ key: o.key, size: sizes?.[i] ?? parts[i].length, ...(o.build_id ? { build_id: o.build_id } : {}) })) })}\n`);
      const all = new Uint8Array(head.length + parts.reduce((t, p) => t + p.length, 0));
      let at = 0;
      for (const p of [head, ...parts]) all.set(p, (at += p.length) - p.length);
      return handleRequest(new Request('https://api.test/ingest-batch', { method: 'POST', body: all, headers: { authorization: `Bearer ${token}` } }), env);
    };
    const ok = await batch([{ key: 'hl/AAAAAA.json', body: '{"a":"é"}', build_id: 'gust-b1' }, { key: 'fb/2026Q3/0001067983.json', body: '{"rows":[]}' }, { key: 'hl/BBBBBB.json', body: '' }]);
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true, written: 3, refused: [] }]);
    expect(new TextDecoder().decode(hist.m.get('hl/AAAAAA.json'))).toBe('{"a":"é"}'); // multi-byte UTF-8 sliced by bytes
    expect(new TextDecoder().decode(hist.m.get('fb/2026Q3/0001067983.json'))).toBe('{"rows":[]}');
    expect([hist.meta.get('hl/AAAAAA.json'), hist.meta.get('fb/2026Q3/0001067983.json')]).toEqual([{ built_at: '2026-11-09T05:00:00Z', build_id: 'gust-b1' }, { built_at: '2026-11-09T05:00:00Z' }]);
    // Sizes that don't add up, or a foreign token, write nothing.
    expect((await batch([{ key: 'hl/CCCCCC.json', body: '{}' }], tok, [5])).status).toBe(400);
    expect((await batch([{ key: 'hl/CCCCCC.json', body: '{}' }], await jwt({}, other.privateKey))).status).toBe(401);
    expect(hist.m.has('hl/CCCCCC.json')).toBe(false);
    // The same as an uncompressed tar (Python's tarfile, ustar), headers applied to every object; a bad key is refused, the rest written.
    const tar = (files: [string, string][]) => {
      const enc = new TextEncoder();
      const blocks: Uint8Array[] = [];
      for (const [name, body] of files) {
        const h = new Uint8Array(512);
        const b = enc.encode(body);
        h.set(enc.encode(name), 0);
        h.set(enc.encode('0000644\0'), 100);
        h.set(enc.encode(`${b.length.toString(8).padStart(11, '0')}\0`), 124);
        h.set(enc.encode('0'), 156);
        h.set(enc.encode('ustar\x0000'), 257);
        h.set(enc.encode('        '), 148);
        h.set(enc.encode(`${h.reduce((t, x) => t + x, 0).toString(8).padStart(6, '0')}\0 `), 148);
        blocks.push(h, b, new Uint8Array((512 - (b.length % 512)) % 512));
      }
      blocks.push(new Uint8Array(1024));
      const out = new Uint8Array(blocks.reduce((t, x) => t + x.length, 0));
      let at = 0;
      for (const x of blocks) out.set(x, (at += x.length) - x.length);
      return out;
    };
    const big = '{"rows":"' + 'x'.repeat(700) + '"}'; // spans two blocks
    const tr = await handleRequest(new Request('https://api.test/ingest/bundle', { method: 'PUT', body: tar([['hl/EEEEEE.json', big], ['index.json', '{}'], ['changes/2026Q3.json', '{"q":3}']]), headers: { authorization: `Bearer ${tok}`, 'x-copybook-build-id': 'gust-tar', 'x-copybook-built-at': '2026-11-09T06:00:00Z' } }), env);
    expect([tr.status, await tr.json()]).toMatchObject([200, { ok: true, written: 2, refused: ['index.json'] }]);
    expect([new TextDecoder().decode(hist.m.get('hl/EEEEEE.json')), new TextDecoder().decode(hist.m.get('changes/2026Q3.json')), hist.meta.get('changes/2026Q3.json')]).toEqual([big, '{"q":3}', { build_id: 'gust-tar', built_at: '2026-11-09T06:00:00Z' }]);
    // The same tar gzipped (content-encoding: gzip) is unpacked before the entries are written.
    const gz = new Uint8Array(await new Response(new Blob([tar([['hl/FFFFFF.json', big]])]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const tg = await handleRequest(new Request('https://api.test/ingest/bundle', { method: 'PUT', body: gz, headers: { authorization: `Bearer ${tok}`, 'content-encoding': 'gzip' } }), env);
    expect([tg.status, await tg.json(), new TextDecoder().decode(hist.m.get('hl/FFFFFF.json'))]).toMatchObject([200, { ok: true, written: 1 }, big]);
    // Single uploads are capped per minute (per location, in the Cache API): the 121st is refused before any work.
    const cache = new Map<string, string>();
    (globalThis as { caches?: unknown }).caches = { default: { match: async (k: string) => (cache.has(k) ? new Response(cache.get(k)) : undefined), put: async (k: string, r: Response) => void cache.set(k, await r.text()) } };
    const codes: number[] = [];
    for (let i = 0; i < 121; i++) codes.push(await put('hl/DDDDDD.json', tok));
    delete (globalThis as { caches?: unknown }).caches;
    expect([codes.slice(0, 120).every((c) => c === 200), codes[120]]).toEqual([true, 429]);


    const token = (await (await fullCheckout('cs_test_q')).json()).token;
    expect(token).toBeUndefined(); // no session yet: /holdings must refuse
    expect((await call('/holdings/bill-ackman/2026Q2')).status).toBe(401);
    stripeObjects['checkout/sessions/cs_test_q'] = { id: 'cs_test_q', status: 'complete', created: now(), subscription: 'sub_q', customer_details: { email: 'q@example.com' } };
    stripeObjects['subscriptions/sub_q'] = sub('sub_q', 'cus_q', 'active');
    const s = await (await fullCheckout('cs_test_q')).json();
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
    const t = (await (await fullCheckout('cs_test_f')).json()).token;
    const put = (b: unknown) => handleRequest(new Request('https://api.test/follows', { method: 'PUT', body: JSON.stringify(b), headers: { origin: 'https://refcell.github.io', authorization: `Bearer ${t}` } }), env);

    expect((await call('/follows')).status).toBe(401);
    await call('/alerts', { body: { alerts: ['warren-buffett'] }, token: t });
    expect((await (await call('/follows', { token: t })).json()).follows).toEqual({ investors: ['warren-buffett'], stocks: [], owned: [], owned_manual: [], peers: [], onboarded: false, include_13g: false, digest: false, insider_buys: true, insider_min_usd: 100000, cluster_buys: true, any_13d: true, weekly_digest: true });

    for (const bad of [{ investors: ['Not A Slug'] }, { stocks: ['$AAPL'] }, { owned: 'AAPL' }, { onboarded: 'yes' }, { digest: 1 }, { insider_min_usd: -1 }, { insider_min_usd: '100k' }, { cluster_buys: 'no' }, { stocks: Array.from({ length: 501 }, (_, i) => `T${i}`) }]) {
      expect((await put(bad)).status).toBe(400);
    }
    // weekly_digest: the opt-out from Saturday's "Your names this week".
    const r = await (await put({ stocks: ['aapl', 'BRK.B'], owned: ['googl'], onboarded: true, include_13g: true, weekly_digest: false })).json();
    expect(r.follows).toEqual({ investors: ['warren-buffett'], stocks: ['AAPL', 'BRK.B', 'GOOGL'], owned: ['GOOGL'], owned_manual: ['GOOGL'], peers: [], onboarded: true, include_13g: true, digest: false, insider_buys: true, insider_min_usd: 100000, cluster_buys: true, any_13d: true, weekly_digest: false });

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
    expect(lat[0]).toMatchObject({ host: 'server', accession: NEWH, form: '13F-HR/A', coverage: 'curated' }); // this copy isn't the Cloudflare one

    // Handled once: the next minute sends nothing.
    sent = [];
    await cron(31);
    expect(sent).toHaveLength(0);
  });

  it('minute poll: a watcher of a held row gets the alert with the row pending check, and /status/ turns amber after 30 minutes', async () => {
    const today = new Date().toISOString().slice(0, 10);
    index = { managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, form: '13F-HR', accession: 'b-q2', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }] };
    await cron(17);
    // Watches APH only, doesn't follow Buffett: APH's row is held (an unlisted 2:1 split read as a buy), AAPL's goes out.
    await putMember('w', 'watcher@example.com', 'active', []);
    await putFollows('w', { stocks: ['APH'] });
    const acc = '0000950123-26-077777';
    secFiles.feed = `<feed><entry><title>13F-HR - BERKSHIRE (0001067983) (Filer)</title><updated>${today}T16:05:00-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="13F-HR"/><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry></feed>`;
    const dir = `Archives/edgar/data/1067983/${acc.replace(/-/g, '')}/`;
    secFiles[`${dir}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '5000' }, { name: '9999.xml', size: '4000' }] } });
    secFiles[`${dir}primary_doc.xml`] = '<edgarSubmission><periodOfReport>09-30-2026</periodOfReport></edgarSubmission>';
    const it = (name: string, cusip: string, value: number, shares: number) => `<ns1:infoTable><ns1:nameOfIssuer>${name}</ns1:nameOfIssuer><ns1:cusip>${cusip}</ns1:cusip><ns1:value>${value}</ns1:value><ns1:shrsOrPrnAmt><ns1:sshPrnamt>${shares}</ns1:sshPrnamt></ns1:shrsOrPrnAmt></ns1:infoTable>`;
    secFiles[`${dir}9999.xml`] = `<ns1:informationTable>${it('AMPHENOL CORP', '032095101', 88_303_070, 1_047_486)}${it('APPLE INC', '037833100', 160_000_000, 800_000)}</ns1:informationTable>`;
    hist.m.set('h/warren-buffett/2026Q2.json', new TextEncoder().encode(JSON.stringify({ holdings: [{ cusip: '032095101', put_call: null, issuer: 'AMPHENOL CORP', ticker: 'APH', shares: 614_660, value: 108_376_851 }, { cusip: '037833100', put_call: null, issuer: 'APPLE INC', ticker: 'AAPL', shares: 1_000_000, value: 200_000_000 }] })));
    await cron(5);
    const mail = sent.find((m) => m.to[0] === 'watcher@example.com')!;
    expect(mail.subject).toBe('Buffett Q3: AAPL -$40.0M +1 pending check');
    expect(mail.text).toContain('APH (added): move pending check');
    expect(mail.text).not.toMatch(/APH [+-]\$/);
    // Held over 30 minutes: the 13F path on /status/ is amber.
    const { alertHealth } = await import('../src/status');
    const at = Date.parse(`${today}T16:05:00-05:00`);
    const later = await alertHealth(env, at + 31 * 60_000);
    expect([later.state, later.held_rows, later.reasons]).toEqual(['amber', 1, ['a 13F move held by the publish gate has waited over 30 minutes for its check']]);
    expect((await alertHealth(env, at + 29 * 60_000)).state).toBe('ok');
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
    // Loeb's book can't be diffed here: its email says the moves follow, and it isn't timed until they do.
    expect((await (await call('/health')).json()).alert_latency).toHaveLength(1);
    const loeb = sent.find((m) => m.to[0] === 'nobody@example.com')!;
    expect(loeb.text).toContain('Position changes follow in a second email within minutes.');
    expect(loeb.text).not.toContain('warren-buffett');
    const mail = sent.find((m) => m.to[0] === 'follows@example.com')!;
    expect(mail.subject).toBe('Buffett Q3: NEW DHI · EXIT BAC · AAPL -$4K');
    // The HTML part lays the moves out as a table, with how much of the position was sold.
    expect(mail.html).toMatch(/<table[^>]*>.*<th[^>]*>Move<\/th>.*<td[^>]*>Trimmed<\/td><td[^>]*><b>AAPL<\/b><\/td><td[^>]*>-\$4K<\/td><td[^>]*><span style="white-space:nowrap">sold 20%<\/span><\/td>/);
    expect(mail.html).toContain('Accession 0000950123-26-011111, accepted by EDGAR');
    // Total book 20,500: DHI +4,000 is 19.5%; the AAPL trim is 20 shares at $200 = -4,000; BAC exits at its prior $2,000.
    expect(mail.text).toContain('Bought $5K, sold $6K this quarter.');
    expect(mail.text).toContain('New: DHI +$4K (18.2% of book) [you own], AAPL calls +$1K (2.3% of book)'); // of the larger (prior) book
    expect(mail.text).toContain('Trimmed: AAPL -$4K (sold 20% of the position, 18.2% of book)');
    expect(mail.text).toContain('Exited: BAC -$2K (9.1% of book)');
    // Every move in the member's names is named and tagged (here DHI, which the member owns).
    expect(mail.text).toContain('In your names: DHI new +$4K, 40 sh (you own)');
    // Buffett's filing has a public card; Loeb's doesn't yet, so it links the investor page.
    expect(mail.text).toContain('Copybook: https://refcell.github.io/gust/copybook/f/0000950123-26-011111/');
    expect(mail.html).toContain('>Filing card</a>');
    expect(loeb.text).toContain('Copybook: https://refcell.github.io/gust/copybook/investors/dan-loeb');
    expect(sent.find((m) => m.to[0] === 'watcher@example.com')!.text).toContain('Exited: BAC -$2K (9.1% of book) [watchlist]');
    const latency = JSON.parse((await env.DB.get('alerts:latency'))!);
    expect(latency.map((l: { slug: string }) => l.slug)).toEqual(['warren-buffett']);
    // The minute poll's on-time 13F send is a row in /latency's 13F figures (timed by the email with its moves).
    expect(latency[0]).toMatchObject({ accession: acc, moves: true });
    expect((await (await call('/latency')).json()).by_form['13F'].count).toBe(1);

    // Still in the feed next minute, and then in the data run's index: never sent twice.
    sent = [];
    await cron(6);
    index = { managers: [row('warren-buffett', '0001067983', { accession: acc, report_date: '2026-09-30', filing_date: today, quarter: '2026Q3' }), row('dan-loeb', '0001040273', { accession: big, report_date: '2026-09-30', filing_date: today, quarter: '2026Q3' })] };
    await cron(17);
    expect(sent).toHaveLength(0); // the data run has no moves for Loeb yet

    const mv = (ticker: string, value_delta: number) => ({ ticker, display_name: null, issuer: ticker, cusip: 'X', put_call: null, shares: 1, prev_shares: 0, value: value_delta, value_delta, delta_pct_of_book: 0.012 });
    recentMoves = [{ accession: big, moves: { bought_usd: 3e8, sold_usd: 0, new: [mv('MSFT', 3e8)], added: [], trimmed: [], exited: [] } }];
    await cron(17);
    expect(sent.map((m) => m.to[0])).toEqual(['nobody@example.com']);
    expect(sent[0].subject).toBe('dan-loeb Q3 changes: NEW MSFT');
    expect(sent[0].text).toContain('New: MSFT +$300.0M (1.2% of book) [watchlist]');
    // Timed by the email that carries the moves.
    const timed = JSON.parse((await env.DB.get('alerts:latency'))!);
    expect(timed.find((l: { slug: string }) => l.slug === 'dan-loeb')?.moves).toBe(true);
    sent = [];
    await cron(17);
    expect(sent).toHaveLength(0);
  });

  it('a 13F too big for the Worker, with no prior book in R2: gene computes its moves from EDGAR and sends them once', async () => {
    const today = new Date().toISOString().slice(0, 10);
    index = { managers: [{ ok: true, slug: 'dan-loeb', cik: '0001040273', manager: 'Dan Loeb', name: 'Third Point', featured: true, form: '13F-HR', accession: 'dan-loeb-q2', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }] };
    await cron(17);
    await putMember('n', 'loeb@example.com', 'active', ['dan-loeb']);
    await putFollows('n', { investors: ['dan-loeb'], stocks: ['AAPL'] });
    const it13 = (name: string, cusip: string, value: number, shares: number) => `<infoTable><nameOfIssuer>${name}</nameOfIssuer><cusip>${cusip}</cusip><value>${value}</value><sshPrnamt>${shares}</sshPrnamt></infoTable>`;
    const big = '0000950123-26-044444';
    const prev = '0000950123-26-000777';
    const dir = (a: string) => `Archives/edgar/data/1040273/${a.replace(/-/g, '')}/`;
    secFiles[`${dir(big)}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '5000' }, { name: 'table.xml', size: '900000' }] } });
    secFiles[`${dir(big)}primary_doc.xml`] = '<periodOfReport>09-30-2026</periodOfReport>';
    secFiles[`${dir(big)}table.xml`] = `<informationTable>${it13('MICROSOFT CORP', '594918104', 300000000, 600000)}${it13('APPLE INC', '037833100', 75000000, 300000)}</informationTable>`;
    // Q2 is not in R2 under h/dan-loeb: it comes from Loeb's original Q2 13F-HR on EDGAR.
    secFiles['submissions/CIK0001040273.json'] = JSON.stringify({ filings: { recent: { accessionNumber: [big, prev], form: ['13F-HR', '13F-HR'], reportDate: ['2026-09-30', '2026-06-30'] } } });
    secFiles[`${dir(prev)}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '5000' }, { name: 't.xml', size: '4000' }] } });
    secFiles[`${dir(prev)}primary_doc.xml`] = '<periodOfReport>06-30-2026</periodOfReport>';
    secFiles[`${dir(prev)}t.xml`] = `<informationTable>${it13('APPLE INC', '037833100', 50000000, 200000)}</informationTable>`;
    secFiles.feed = `<feed><entry><title>13F-HR - THIRD POINT (0001040273) (Filer)</title><updated>${today}T16:05:00-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="13F-HR"/><id>urn:tag:sec.gov,2008:accession-number=${big}</id></entry></feed>`;
    await cron(5);
    expect(sent.map((m) => m.text.includes('Position changes follow in a second email within minutes.'))).toEqual([true]);
    sent = [];

    const { geneMoves } = await import('../src/alerts');
    await geneMoves(env, Date.now());
    expect(sent.map((m) => m.to[0])).toEqual(['loeb@example.com']);
    expect(sent[0].text).toContain('New: MICROSOFT CORP +$300.0M');
    // EDGAR's table has no tickers: the added AAPL is looked up, so it's named as the member's watched stock.
    expect(sent[0].text).toMatch(/In your names: AAPL added \+\$25\.0M, bought 100,000 sh \(\+50%\), holds 300K \(watchlist\)/);
    expect(JSON.parse((await env.DB.get('alerts:latency'))!).find((l: { slug: string }) => l.slug === 'dan-loeb')?.moves).toBe(true);
    // Done: neither gene's next minute nor the data run's moves send it again.
    sent = [];
    await geneMoves(env, Date.now());
    recentMoves = [{ accession: big, moves: { bought_usd: 3e8, sold_usd: 0, new: [], added: [], trimmed: [], exited: [] } }];
    await cron(17);
    expect(sent).toHaveLength(0);

    // The operator's hand-off replay (FMR's): test members only, to them alone, timed apart from live latency.
    // The test member needn't follow the filer: a replay counts it as followed, by email only.
    await putMember('t', 'copybook-test-replay@fldubai.com', 'active', []);
    await putFollows('t', { investors: [], stocks: [] });
    const rq = (b: Record<string, unknown>) => handleRequest(new Request('https://api.test/ops/moves-requeue', { method: 'POST', body: JSON.stringify(b), headers: { authorization: `Bearer ${env.HEALTH_TOKEN}` } }), env);
    expect((await rq({ accessions: [big], replay_to: ['n'] })).status).toBe(400);
    expect(await (await rq({ accessions: [big], replay_to: ['t'] })).json()).toMatchObject({ ok: true, queued: [big] });
    const logged = JSON.parse((await env.DB.get('alerts:latency'))!).length;
    await geneMoves(env, Date.now());
    expect(sent.map((m) => [m.to[0], m.subject.startsWith('Replay (test): ')])).toEqual([['copybook-test-replay@fldubai.com', true]]);
    expect(sent[0].text).toContain('New: MICROSOFT CORP +$300.0M');
    expect(JSON.parse((await env.DB.get('alerts:latency'))!).length).toBe(logged);
    const rp = await (await handleRequest(new Request('https://api.test/ops/moves-replays', { headers: { authorization: `Bearer ${env.HEALTH_TOKEN}` } }), env)).json();
    expect(rp.replays).toMatchObject([{ accession: big, members: 1, emails: 1 }]);
    sent = [];
    await geneMoves(env, Date.now());
    expect(sent).toHaveLength(0);
  });

  it('two pollers: Cloudflare polls, gene backs it up; member changes and handled filings sync both ways; a filing both see is sent once', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const row = (slug: string, cik: string, name: string) => ({ ok: true, slug, cik, manager: slug, name, featured: true, form: '13F-HR', accession: `${slug}-q2`, report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' });
    index = { managers: [row('dan-loeb', '0001040273', 'Third Point'), row('bill-ackman', '0001336528', 'Pershing Square')] };
    await cron(17);
    await putMember('n', 'member@example.com', 'active', ['dan-loeb']);
    await putFollows('n', { investors: ['dan-loeb'] });
    // gene serves members (its KV is the test's); Cloudflare's copy polls, with its own KV (empty here) and the real R2.
    const r2 = new MemR2();
    const gene = { ...env, SYNC: 'on', CF_API_TOKEN: 'cf', CF_ACCOUNT_ID: 'acct', BUILD_SHA: 'aaaaaaaaaaaabbbb' };
    const cf = { ...env, DB: new MemKV(), HIST: r2, MOVED_TO: 'https://gene.test/copybook/', SYNC: 'on', CF_API_TOKEN: 'cf', CF_ACCOUNT_ID: 'acct', BUILD_SHA: 'cccccccccccc1111' };
    // Cloudflare's cron keeps its state in R2 (kv/), reading through to its KV namespace: KV writes cost the free plan's 1,000 a day.
    const { r2kv } = await import('../src/failover');
    const cfStore = r2kv(r2, cf.DB);
    await cf.DB.put('legacy:k', 'from kv');
    expect(await cfStore.get('legacy:k')).toBe('from kv'); // read through to KV until written
    await cfStore.delete('legacy:k');
    expect([await cfStore.get('legacy:k'), (await cfStore.list({ prefix: 'legacy:' })).keys]).toEqual([null, []]); // a tombstone: KV's value doesn't come back
    await cf.DB.delete('legacy:k');
    // A request Cloudflare answers itself during failover reads the newer of its own copy and gene's published one, a
    // tombstone included: a seat's API key deleted on gene (applied here as a tombstone; gene's old copy stays in
    // sync/gene/) is revoked here too, and a key gene re-creates after the tombstone reads as live.
    const { writeThrough } = await import('../src/failover');
    const readCf = (k: string) => writeThrough(cf as Env, (e) => e.DB.get(k));
    r2.uploads = true;
    await r2.put('sync/gene/apikey:seat', '{"customer":"seat_x"}');
    await cfStore.delete('apikey:seat');
    expect(await readCf('apikey:seat')).toBe(null);
    await r2.put('sync/gene/apikey:seat', '{"customer":"seat_y"}');
    expect(await readCf('apikey:seat')).toBe('{"customer":"seat_y"}');
    r2.uploads = false;
    let geneBlind = false; // gene can't reach Cloudflare's R2 (its link, or Cloudflare's API)
    let geneRace = false; // gene read Cloudflare's heartbeat and changes just before Cloudflare's minute wrote them
    const base = globalThis.fetch;
    const text = (k: string) => (r2.m.has(k) ? new TextDecoder().decode(r2.m.get(k)) : null);
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = String(input);
      const rest = url.match(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acct\/r2\/buckets\/copybook-history\/objects\/(.+)$/);
      if (rest) {
        const k = decodeURIComponent(rest[1]);
        if (init?.method === 'PUT') return void r2.m.set(k, new TextEncoder().encode(String(init.body))), new Response('{}');
        if (geneBlind && (k === 'sync/alive-cloudflare.json' || k === 'sync/cloudflare.json')) return new Response('down', { status: 500 });
        if (geneRace && k === 'sync/alive-cloudflare.json') return new Response(JSON.stringify({ last_run_at: new Date(min(-30)).toISOString() }));
        if (geneRace && k === 'sync/cloudflare.json') return new Response(JSON.stringify({ at: 0, keys: {} }));
        return text(k) === null ? new Response('{}', { status: 404 }) : new Response(text(k));
      }
      if (url === 'https://api.cloudflare.com/client/v4/user/tokens/verify') return Response.json({ result: { id: 'tok' } });
      const s3 = url.match(/^https:\/\/acct\.r2\.cloudflarestorage\.com\/copybook-history\/(.+)$/);
      if (s3) {
        const k = decodeURIComponent(s3[1]);
        if (init?.method === 'PUT') {
          if (new Headers(init.headers).get('if-none-match') === '*' && r2.m.has(k)) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
          return void r2.m.set(k, new TextEncoder().encode(String(init.body))), new Response('');
        }
        return text(k) === null ? new Response('', { status: 404 }) : new Response(text(k));
      }
      return base(input, init);
    });
    const { runScheduled } = await import('../src/alerts');
    const run = (e: Env, at: number) => runScheduled(e, at);
    const t0 = Date.parse(`${today}T14:20:00Z`);
    const min = (m: number) => t0 + m * 60_000;
    const toMember = () => sent.filter((m) => m.to[0] === 'member@example.com');
    const filing = (cik: string, acc: string, name: string) => {
      const dir = `Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/`;
      secFiles[`${dir}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '5000' }, { name: 'table.xml', size: '900000' }] } });
      secFiles[`${dir}primary_doc.xml`] = '<periodOfReport>09-30-2026</periodOfReport>';
      return `<entry><title>13F-HR - ${name} (${cik}) (Filer)</title><updated>${today}T00:05:00-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="13F-HR"/><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
    };

    // No Cloudflare heartbeat yet: gene polls and publishes its whole state. Cloudflare's first minute imports it
    // and waits a minute; from then on Cloudflare polls and gene only syncs.
    expect(await run(gene, min(0))).toMatchObject({ poller: 'gene polls (cloudflare silent)' });
    expect(await run(cf, min(1))).toMatchObject({ poller: 'resuming: polls from next minute' });
    expect(JSON.parse((await cfStore.get('cus:n'))!).email).toBe('member@example.com');
    await run(cf, min(2));
    expect(await run(gene, min(2))).toMatchObject({ poller: 'backup (cloudflare polls)' });
    // An operator's hold (the poller drill): Cloudflare neither polls nor beats until it lapses.
    const alive0 = text('sync/alive-cloudflare.json');
    r2.m.set('sync/hold-cloudflare.json', new TextEncoder().encode(JSON.stringify({ until: new Date(min(2) + 30_000).toISOString() })));
    expect(await run(cf, min(2))).toMatchObject({ poller: `held until ${new Date(min(2) + 30_000).toISOString()}` });
    expect(text('sync/alive-cloudflare.json')).toBe(alive0);
    r2.m.delete('sync/hold-cloudflare.json');
    expect((await (await handleRequest(new Request('https://api.test/health'), gene)).json())).toMatchObject({ poller_host: 'cloudflare', poller_last_run: new Date(min(2)).toISOString().replace('.000', ''), api_host: 'gene', poller_builds: { cloudflare: 'cccccccccccc', server: 'aaaaaaaaaaaa' } });

    // A member follows Ackman on gene: Cloudflare's cron has it a minute later.
    await putFollows('n', { investors: ['dan-loeb', 'bill-ackman'] });
    await run(gene, min(3));
    await run(cf, min(3));
    expect(JSON.parse((await cfStore.get('follows:n'))!).investors).toEqual(['dan-loeb', 'bill-ackman']);

    // A revocation on gene (a member ends every session) is published at once, not at gene's next minute: the backup
    // refuses the old session within seconds if members are on it (the drill: a seat removed on gene took 31 s).
    const { signToken: st } = await import('../src/tokens');
    const oldSess = await st(env.SESSION_SECRET, 'session', 'n', 3600);
    const idx0 = JSON.parse(text('sync/gene.json') ?? '{"keys":{}}').keys['cus:n'] ?? 0;
    vi.useFakeTimers({ toFake: ['Date'], now: min(3) + 20_000 });
    expect((await worker.fetch(new Request('https://api.test/me/sessions/revoke', { method: 'POST', headers: { authorization: `Bearer ${oldSess}` } }), gene as Env)).status).toBe(200);
    vi.useRealTimers();
    expect(JSON.parse(text('sync/gene.json')!).keys['cus:n']).toBeGreaterThan(idx0);
    expect(JSON.parse(text('sync/gene/cus:n')!).sessions_after).toBeGreaterThan(0);
    // gene can't reach Cloudflare's R2: it stays the backup (it can't tell whether Cloudflare polls).
    geneBlind = true;
    expect(await run(gene, min(3))).toMatchObject({ poller: 'backup (cloudflare heartbeat unreadable)' });
    geneBlind = false;

    // Pershing Square files and both pollers see it in the same minute: Cloudflare sends it; gene, whose read of
    // Cloudflare's heartbeat and changes raced Cloudflare's writes, polls too and finds the filing unhandled. The
    // claim Cloudflare took first stands: exactly one email, and gene records the filing as handled.
    const ackman = '0000950123-26-055555';
    secFiles.feed = `<feed>${filing('0001336528', ackman, 'PERSHING SQUARE')}</feed>`;
    await run(cf, min(4));
    expect(toMember()).toHaveLength(1);
    geneRace = true;
    expect(await run(gene, min(4))).toMatchObject({ poller: 'gene polls (cloudflare silent)' });
    geneRace = false;
    expect(toMember()).toHaveLength(1);
    expect(JSON.parse((await gene.DB.get('alerts:handled'))!)).toContain(ackman);

    // Cloudflare goes quiet (last heartbeat min(4)). A minute on, gene still backs up; two minutes on (past 90 s), gene
    // polls, sends Third Point's filing and records the takeover (120 s) for /status/. Cloudflare, back late the same
    // minute and the next, applies gene's handled filings first and never sends it again: one email while both run.
    const loeb = '0000950123-26-044444';
    secFiles.feed = `<feed>${filing('0001040273', loeb, 'THIRD POINT')}${filing('0001336528', ackman, 'PERSHING SQUARE')}</feed>`;
    expect(await run(gene, min(5))).toMatchObject({ poller: 'backup (cloudflare polls)' });
    expect(await run(gene, min(6))).toMatchObject({ poller: 'gene polls (cloudflare silent)', takeover: { seconds: 120 } });
    expect(JSON.parse(text('sync/takeover-gene.json')!).seconds).toBe(120);
    expect(toMember()).toHaveLength(2);
    expect(await run(cf, min(6) + 20_000)).toMatchObject({ poller: 'resuming: polls from next minute' });
    expect(await run(gene, min(7))).toMatchObject({ poller: 'backup (cloudflare polls)' });
    expect((await run(gene, min(7))).takeover).toBeUndefined();
    await run(cf, min(7) + 20_000);
    await run(cf, min(8));
    expect(toMember().map((m) => m.subject)).toHaveLength(2);
    expect(JSON.parse((await cfStore.get('alerts:handled'))!)).toEqual(expect.arrayContaining([ackman, loeb]));

    // gene publishes a stale copy of the handled events (an echo from an overlapping minute, stamped later than
    // Cloudflare's write): Cloudflare merges it instead of taking it, so the event it handled since is never re-sent.
    await cfStore.put('events:handled', JSON.stringify(['ev-old', 'ev-new']));
    await gene.DB.put('events:handled', JSON.stringify(['ev-gene', 'ev-old']));
    await run(gene, min(19));
    await run(cf, min(19));
    expect(JSON.parse((await cfStore.get('events:handled'))!)).toEqual(['ev-gene', 'ev-old', 'ev-new']);
    expect((await cf.DB.list({ prefix: '' })).keys).toEqual([]); // not one KV write on Cloudflare
  });

  it("email budget: Mailgun takes over past Resend's cap; a member's later alerts within 2 minutes (20 when email is short) go as one email; test members get 5 a day and no 13G email", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const T = Date.parse(`${today}T15:00:00Z`);
    const ev = (id: string) => ({ id, slug: 'warren-buffett', manager: 'Warren Buffett', form: '4', kind: 'form4', action: 'buy', filing_date: today, accepted: new Date(T - 60_000).toISOString(), url: `https://www.sec.gov/${id}`, issuer: 'SIRIUS XM', display_name: 'Sirius XM', ticker: 'SIRI', shares: 1000, value_usd: 25000, avg_price: 25, shares_after: null, percent_of_class: null });
    const { deliver, flushHeld } = await import('../src/alerts');
    const at = (id: string, min: number) => deliver(env, [], [ev(id) as never], T + min * 60_000);
    await putMember('r', 'real@example.com', 'active', ['warren-buffett']);
    await putFollows('r', { investors: ['warren-buffett'] });
    await putMember('t', 'copybook-test-x@fldubai.com', 'active', ['warren-buffett']);
    await putFollows('t', { investors: ['warren-buffett'] });
    const mg: { to: string; from: string; subject: string; text: string }[] = [];
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u) === 'https://mg.test/v3/factordynamics.com/messages') {
        const b = new URLSearchParams(String(init?.body));
        mg.push({ to: b.get('to')!, from: b.get('from')!, subject: b.get('subject')!, text: b.get('text')! });
        return Response.json({ id: 'x' });
      }
      return orig(u, init);
    });
    Object.assign(env, { MAILGUN_API_KEY: 'k', MAILGUN_BASE: 'https://mg.test' });
    const got = () => [...sent.map((m) => ({ to: m.to[0], text: m.text })), ...mg].filter((m) => m.to !== env.CONTACT_EMAIL).map((m) => [m.to, (m.text.match(/sec\.gov\/F\d/g) ?? []).join(' ')]); // not the 80% note

    // Resend has hit its cap (429): the alerts go through Mailgun, from the same address.
    resendUsed = 100;
    await at('F1', 1);
    expect(got().sort()).toEqual([['copybook-test-x@fldubai.com', 'sec.gov/F1'], ['real@example.com', 'sec.gov/F1']]);
    expect(mg[0].from).toBe(env.EMAIL_FROM);

    // Within 2 minutes of a member's last alert email, the next alert waits for the window's end.
    mg.length = 0;
    await at('F8', 2);
    expect(got()).toEqual([]);
    await flushHeld(env, T + 3 * 60_000);
    expect(got().sort()).toEqual([['copybook-test-x@fldubai.com', 'sec.gov/F8'], ['real@example.com', 'sec.gov/F8']]);
    await env.DB.put(`mailn:t:${today}`, '1');

    // Email runs short (the last two hours' rate would use more than is left today): the window is 20 minutes.
    // Each member's first alert goes at once; the next two wait and go as one email when the 20 minutes end.
    await env.DB.put('stats:sent', JSON.stringify([[Math.floor(T / 3600_000), 400]]));
    mg.length = 0;
    await at('F2', 4);
    expect(got().sort()).toEqual([['copybook-test-x@fldubai.com', 'sec.gov/F2'], ['real@example.com', 'sec.gov/F2']]);
    mg.length = 0;
    await at('F3', 5);
    await at('F4', 7);
    expect(got()).toEqual([]); // chat, feed and webhook would still have had them at once
    await flushHeld(env, T + 25 * 60_000);
    expect(got().sort()).toEqual([['copybook-test-x@fldubai.com', 'sec.gov/F3 sec.gov/F4'], ['real@example.com', 'sec.gov/F3 sec.gov/F4']]);
    // Timed as they went: F3 at about 21 minutes, tagged coalesced.
    const f3 = JSON.parse((await env.DB.get('alerts:latency'))!).filter((l: { accession: string }) => l.accession === 'F3');
    expect(f3.some((l: { coalesced?: boolean }) => l.coalesced)).toBe(true);

    // Email is no longer short: at once. A test member's 3rd alert email today goes; past 3, no more email.
    await env.DB.put('stats:sent', '[]');
    await env.DB.put(`mailn:t:${today}`, '2');
    mg.length = 0;
    await at('F5', 26);
    expect(got().sort()).toEqual([['copybook-test-x@fldubai.com', 'sec.gov/F5'], ['real@example.com', 'sec.gov/F5']]);
    mg.length = 0;
    await at('F6', 29);
    expect(got()).toEqual([['real@example.com', 'sec.gov/F6']]);
    // The same alert delivered again (a handled list lost in a host hand-off, as Nov 10's 13G at 14:01 and 14:02):
    // nobody gets it twice.
    mg.length = 0;
    sent = [];
    await at('F6', 32);
    expect(got()).toEqual([]);
    // Counted for the quant's audit: /health and the status probe carry it.
    const hj = await (await handleRequest(new Request('https://api.test/health'), env)).json();
    expect(hj.dupes_blocked).toMatchObject({ total: 1, last_7d: 1 });
    // The moves queue in status.json's shape.
    expect(Object.keys(hj.moves_queue)).toEqual(['pending', 'oldest_wait_seconds', 'last_fallback_send_at']);
    expect((await (await handleRequest(new Request('https://api.test/health?probe=1'), env)).json()).dupes_blocked).toEqual({ total: 1, last_7d: 1 });
    // A 13G or 13G/A never goes to a test member by email (feed only), and doesn't use up its 3.
    await env.DB.put(`mailn:t:${today}`, '0');
    for (const c of ['r', 't']) await putFollows(c, { investors: ['warren-buffett'], include_13g: true });
    mg.length = 0;
    await deliver(env, [], [{ ...ev('F7'), form: 'SCHEDULE 13G/A', kind: '13g', action: 'stake_update', percent_of_class: 5.2 } as never], T + 35 * 60_000);
    expect(got()).toEqual([['real@example.com', 'sec.gov/F7']]);
    expect(await env.DB.get(`mailn:t:${today}`)).toBe('0');
    // Previews, replays and samples: at most 10 a day; the 11th and 12th wait for the reset. The probe and status.json
    // count today's sends by kind (test includes previews).
    const em = await import('../src/email');
    const before = { ...em.mailQuota.kinds! };
    mg.length = 0;
    sent = [];
    const pv = Array.from({ length: 12 }, (_, i) => ({ to: 'copybook-test-x@fldubai.com', subject: `preview ${i}`, text: 'x' }));
    await em.sendMail(env, pv.slice(0, 10 - before.preview), { preview: true });
    expect(await em.sendMail(env, pv.slice(10), { preview: true })).toBe('delayed');
    expect(em.mailQuota.kinds).toMatchObject({ preview: 10, test: before.test + 10 - before.preview, real: before.real });
    expect(JSON.parse((await env.DB.get('host:mail-delayed'))!).filter((m: { subject: string }) => /preview 1[01]$/.test(m.subject))).toHaveLength(2);
    const probe = await (await handleRequest(new Request('https://api.test/health?probe=1'), env)).json();
    expect(Object.keys(probe.mail_kinds)).toEqual(['day', 'used', 'real', 'test', 'account', 'preview', 'since', 'used_at_since', 'queued', 'waiting_now']);
    // The day's Resend count splits into parts that add up to it: what came before the counters started, then by kind.
    const v = em.kindsView(probe.mail_kinds.used, probe.mail_kinds);
    expect([v.before_since + v.real + v.test + v.account + v.other, v.since]).toEqual([probe.mail_kinds.used, probe.mail_kinds.since]);
    vi.stubGlobal('fetch', orig);
  });

  it("the entry module exports only functions and the handler (workerd refuses to boot on any other export, as gene's deployer did for 1e2f84a)", async () => {
    const mod = await import('../src/index');
    expect(Object.entries(mod).filter(([k, v]) => k !== 'default' && typeof v !== 'function').map(([k]) => k)).toEqual([]);
  });

  it('portal cancel and renew on a comped test member: record and both emails; a missed renew is fixed by reconciliation, mailed once', async () => {
    const base = { ...sub('sub_rt', 'cus_rt', 'active'), metadata: { test_member: 'true' } };
    stripeObjects['customers/cus_rt'] = { id: 'cus_rt', email: 'copybook-test-rt@fldubai.com' };
    stripeObjects['subscriptions/sub_rt'] = base;
    await webhook({ type: 'customer.subscription.created', data: { object: base } });
    // A pause reason from earlier the same day (retail's 00:26 pause check) isn't a cancel reason: the email still asks.
    await env.DB.put('why:cus_rt', JSON.stringify({ reason: 'seasonal', via: 'pause', at: new Date(Date.now() - 3600_000).toISOString() }));
    sent = [];
    // Portal cancel (Nov 11, 01:01:39): cancel_at_period_end and cancel_at.
    const cancelled = { ...base, cancel_at_period_end: true, cancel_at: now() + 27 * 86400, canceled_at: now() };
    await webhook({ type: 'customer.subscription.updated', data: { object: cancelled, previous_attributes: { cancel_at_period_end: false } } });
    expect(JSON.parse((await env.DB.get('cus:cus_rt'))!).cancel_at_period_end).toBe(true);
    expect(sent.map((m) => m.subject)).toEqual([expect.stringMatching(/^Your Copy plan ends /)]);
    expect(sent[0].text).toContain('One question: what was the main reason?');
    expect(sent[0].text.match(/\/why\/\?t=/g)).toHaveLength(7);
    // The HTML part links instead of pasting URLs.
    expect(sent[0].html).toMatch(/<a href="[^"]+\/resume\/\?t=[^"]+"[^>]*>Resume your plan<\/a>/);
    expect(sent[0].html).toMatch(/<a href="[^"]+\/why\/\?t=[^"]+r=other">Tell us why<\/a>/);
    expect(sent[0].html).not.toMatch(/>https?:/);
    // Portal renew (01:12:09): the record is active again and the member is told.
    sent = [];
    await webhook({ type: 'customer.subscription.updated', data: { object: base, previous_attributes: { cancel_at_period_end: true } } });
    expect(JSON.parse((await env.DB.get('cus:cus_rt'))!).cancel_at_period_end).toBe(false);
    expect(sent.map((m) => m.subject)).toEqual(["You've resumed Copy"]);
    expect(sent[0].html).toMatch(/<a href="[^"]+\/account\/">Your account<\/a>/);
    // The renew webhook missed: the record still says cancelled until reconciliation re-reads Stripe, which mails once.
    await webhook({ type: 'customer.subscription.updated', data: { object: cancelled } });
    sent = [];
    const { reconcileMembers } = await import('../src/members');
    expect(await reconcileMembers(env)).toMatchObject({ fixed: 1, errors: 0 });
    expect(JSON.parse((await env.DB.get('cus:cus_rt'))!).cancel_at_period_end).toBe(false);
    expect(sent.map((m) => m.subject)).toEqual(["You've resumed Copy"]);
    sent = [];
    expect(await reconcileMembers(env)).toMatchObject({ fixed: 0 });
    expect(sent).toHaveLength(0);
  });

  it('/status/ data: probe uptime and daily bars, restarts told apart (deploy, unplanned, unconfirmed), 13F amber, freshness', async () => {
    const { recordProbe, buildStatus } = await import('../src/status');
    const t0 = Date.UTC(2026, 10, 11, 10, 0);
    const min = (i: number) => t0 + i * 60_000;
    const up = (since: string, build: string | null) => ({ ok: true, ms: 120, up_since: since, build });
    const down = { ok: false, ms: 10_000, up_since: null, build: null };
    let s = { hours: {}, restarts: [] } as Parameters<typeof recordProbe>[0];
    s = recordProbe(s, min(0), up('2026-11-11T09:00:00Z', 'aaa'));
    // A deploy: new build, back within the minute (no check failed).
    s = recordProbe(s, min(1), up('2026-11-11T10:00:40Z', 'bbb'));
    // A watchdog restart: same build, 3 checks failed (the gap from the first failure to the boot is 150 s).
    s = recordProbe(s, min(2), down);
    s = recordProbe(s, min(3), down);
    s = recordProbe(s, min(4), down);
    s = recordProbe(s, min(5), up('2026-11-11T10:04:30Z', 'bbb'));
    // A new build that took 90 s still counts as unplanned; a short restart with no build named is unconfirmed.
    s = recordProbe(s, min(6), down);
    s = recordProbe(s, min(7), up('2026-11-11T10:07:30Z', 'ccc'));
    s = recordProbe(s, min(8), up('2026-11-11T10:07:50Z', null));
    // A failover: gene stops, the Worker answers (not a restart), gene comes back on a new boot (one restart, against
    // gene's own previous boot, down for the members' outage), and access moves back.
    let f = { hours: {}, restarts: [] } as Parameters<typeof recordProbe>[0];
    const on = (host: string, since: string, build: string) => ({ ...up(since, build), host });
    f = recordProbe(f, min(0), on('gene', '2026-11-11T08:40:00Z', 'g1'));
    f = recordProbe(f, min(1), down);
    f = recordProbe(f, min(2), down);
    f = recordProbe(f, min(3), on('cloudflare', '2026-11-11T10:02:50Z', 'w1'));
    f = recordProbe(f, min(4), on('cloudflare', '2026-11-11T10:04:10Z', 'w1'));
    f = recordProbe(f, min(5), on('gene', '2026-11-11T10:03:30Z', 'g1'));
    expect(f.restarts).toEqual([{ at: '2026-11-11T10:03:30Z', prev_up_since: '2026-11-11T08:40:00Z', down_seconds: 120, kind: 'unplanned', build: 'g1', prev_build: 'g1' }]);
    expect(f.failures?.map((x) => x.at)).toEqual([new Date(min(2)).toISOString().replace(/\.\d{3}Z$/, 'Z'), new Date(min(1)).toISOString().replace(/\.\d{3}Z$/, 'Z')]);
    expect(s.restarts.map((r) => [r.at, r.kind, r.down_seconds])).toEqual([
      ['2026-11-11T10:07:50Z', 'short_unconfirmed', 0],
      ['2026-11-11T10:07:30Z', 'unplanned', 90],
      ['2026-11-11T10:04:30Z', 'unplanned', 150],
      ['2026-11-11T10:00:40Z', 'deploy', 0],
    ]);
    // Yesterday noon's checks count in 24 h and 7 d, and in yesterday's bar, not today's.
    s.hours['2026-11-10T12'] = [50, 60];
    await env.DB.put('alerts:pending-moves', JSON.stringify([{ accession: 'a', accepted: new Date(min(8) - 11 * 60_000).toISOString() }]));
    await env.DB.put('status:fresh', JSON.stringify({ data_built_at: '2026-11-11T09:30:00Z', build_id: 'gh-1', last_13f: { slug: 'x', manager: 'X', accession: '0000000000-26-000001', accepted_at: '2026-11-11T09:10:00Z' } }));
    const st = await buildStatus(env, min(8), s);
    expect(st.probe['24h']).toEqual({ uptime: Math.round((55 / 69) * 1e5) / 1e5, checks: 69, failed: 14 });
    expect(st.probe['7d'].checks).toBe(69);
    expect(st.probe.daily.slice(-2)).toEqual([{ day: '2026-11-10', uptime: 0.83333, checks: 60, failed: 10 }, { day: '2026-11-11', uptime: 0.55556, checks: 9, failed: 4 }]);
    expect(st.restarts).toMatchObject({ unplanned_7d: 2, deploys_7d: 1, short_unconfirmed_7d: 1, api_up_since: '2026-11-11T10:07:50Z' });
    expect(st.alerts_13f).toMatchObject({ state: 'amber', pending_moves: 1, oldest_pending_seconds: 660, reset_queue: 0 });
    expect(st.freshness).toMatchObject({ data_built_at: '2026-11-11T09:30:00Z', last_13f_lag_seconds: 1200 });
    await env.DB.put('alerts:pending-moves', '[]');
    expect((await buildStatus(env, min(8), s)).alerts_13f.state).toBe('ok');
    // Drills and incidents that weren't restarts are listed too (the 16:01 backup revocation, with its fix).
    expect(st.restarts.events.map((e: { kind: string; started_at: string }) => `${e.kind} ${e.started_at.slice(11, 16)}`)).toEqual(['planned 16:48', 'incident 16:01', 'planned 16:01', 'incident 15:06']);
  });

  it("Friday email: 'Your follows' leads (a followed 13F in the alert's format, its 10 largest rows; else the expected date); the welcome names the follow; weekend budget", async () => {
    const realFetch = globalThis.fetch;
    const mg: string[] = [];
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u) === `${SITE}d/expected.json`) return Response.json({ quarter: '2026Q3', expected: [{ slug: 'seth-klarman', manager: 'Seth Klarman', expected_date: '2026-11-13' }] });
      if (String(u) === 'https://mg.test/v3/factordynamics.com/messages') {
        mg.push(new URLSearchParams(String(init?.body)).get('to')!);
        return Response.json({ id: 'x' });
      }
      return realFetch(u, init);
    });
    // Kahn's Q3 13F went out with 12 changed rows: the Friday email keeps the 10 largest (K2 to K11).
    const row = (t: string, change: string, v: number) => ({ ticker: t, display_name: null, issuer: t, cusip: `${t}00X100`, put_call: null, shares: 10, prev_shares: 5, value: Math.abs(v), value_delta: v, change });
    const changed = Array.from({ length: 12 }, (_, i) => row(`K${i}`, i % 2 ? 'added' : 'trimmed', (i % 2 ? 1 : -1) * (i + 1) * 1e6));
    const kahn = { slug: 'irving-kahn', slugs: ['irving-kahn'], manager: 'Irving Kahn', name: 'Kahn Brothers', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-12', accession: '0001039565-26-000005', sec_url: 'https://www.sec.gov/k', accepted: new Date(Date.now() - 86400_000).toISOString(), tickers: [], changed,
      moves: { bought_usd: 36e6, sold_usd: 42e6, new: [], added: changed.filter((r) => r.change === 'added').slice(-5), trimmed: changed.filter((r) => r.change === 'trimmed').slice(-5), exited: [] } };
    const { deliver } = await import('../src/alerts');
    await deliver(env, [kahn as never], [], Date.now());
    const { followsSection } = await import('../src/free');
    const sec = (await followsSection(env, { investors: ['irving-kahn', 'seth-klarman', 'bill-ackman'], stocks: [], owned: [], watched: [] } as never, Date.now()))!;
    expect(sec.text).toMatch(/^Your follows:\nIrving Kahn \(Kahn Brothers\): Q3 2026 13F, filed 2026-11-12\n/);
    expect(['K2', 'K11'].every((t) => new RegExp(`\\b${t}\\b`).test(sec.text)) && !/\bK[01]\b/.test(sec.text)).toBe(true);
    expect(sec.text).toContain('  Seth Klarman: not filed yet · expected Fri Nov 13\n');
    expect(sec.text).toContain('  Bill Ackman: not filed yet\n');
    expect(sec.html).toContain('<h3 style="font-size:16px;margin:0 0 4px">Your follows</h3>');
    // The free welcome names what they followed and when it comes.
    sent = [];
    await handleRequest(new Request('https://api.test/signup', { method: 'POST', body: JSON.stringify({ email: 'copybook-test-follow@fldubai.com', follow: [{ kind: 'investor', id: 'seth-klarman' }] }), headers: { origin: 'https://refcell.github.io', 'cf-connecting-ip': '7.7.7.7' } }), env);
    expect(sent[0].text).toMatch(/^You follow Seth Klarman: the Q3 13F is expected Fri Nov 13, and its moves come in Friday's email\.\n/);

    // The budget for the Friday email (low priority), 200 of them. Weekday: Resend less 15 + 50 for alerts and account
    // mail, never Mailgun. Saturday: each provider keeps 10 for account mail; the rest waits for Sunday's reset.
    Object.assign(env, { MAILGUN_API_KEY: 'k', MAILGUN_BASE: 'https://mg.test' });
    const email = await import('../src/email');
    const batch = Array.from({ length: 200 }, (_, i) => ({ to: `reader${i}@example.com`, subject: 'The week', text: 'x' }));
    const run = async (iso: string) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(iso));
      email.mailQuota.day = '';
      await env.DB.delete('host:mail-meter');
      await env.DB.delete('host:mail-delayed');
      sent = [];
      mg.length = 0;
      resendUsed = 0;
      await email.sendMail(env, batch, { tier: 'low' });
      const delayed = JSON.parse((await env.DB.get('host:mail-delayed')) ?? '[]').length;
      vi.useRealTimers();
      return [sent.filter((m) => m.to[0].startsWith('reader')).length, mg.length, delayed];
    };
    expect(await run('2026-11-11T15:00:00Z')).toEqual([35, 0, 165]); // Wednesday
    expect(await run('2026-11-14T02:00:00Z')).toEqual([90, 90, 20]); // Saturday 02:00 UTC
    Object.assign(env, { MAILGUN_API_KEY: undefined });
    vi.stubGlobal('fetch', realFetch);
  });

  it("Email 2: once, through Mailgun, to real free signups only; follows lead (never an empty state), no speed figures or clock times, a trial button; skipped without a postal address or under 10", async () => {
    const realFetch = globalThis.fetch;
    const mg: URLSearchParams[] = [];
    // Deadline night: Mon Nov 16, 9:30pm ET.
    const now = Date.parse('2026-11-17T02:30:00Z');
    index = { managers: [{ slug: 'matthew-mclennan', manager: 'Matthew McLennan', name: 'First Eagle Investment Management LLC', total_value: 50e9 }, { slug: 'irving-kahn', manager: 'Irving Kahn', name: 'Kahn Brothers Group Inc', total_value: 800e6 }] } as never;
    // The latency log: First Eagle's moves email went 2 minutes after acceptance; Kahn's took 400 s, too slow to quote.
    await env.DB.put('alerts:latency', JSON.stringify([
      { slug: 'matthew-mclennan', accession: 'M', accepted: '2026-11-16T17:09:00Z', sent: '2026-11-16T17:11:00Z', seconds: 120, kind: '13f', moves: true },
      { slug: 'irving-kahn', accession: 'K', accepted: '2026-11-16T18:00:00Z', sent: '2026-11-16T18:06:40Z', seconds: 400, kind: '13f', moves: true },
    ]));
    const day = new Date(now - 5 * 3600_000).toISOString().slice(0, 10);
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u) === `${SITE}d/expected.json`) return Response.json({ quarter: '2026Q3', expected: [{ slug: 'seth-klarman', manager: 'Seth Klarman', expected_date: '2026-11-20' }] });
      if (String(u) === `${SITE}d/recap/2026Q3.json`)
        return Response.json({
          filing: [{ slug: 'irving-kahn', filing_date: day }, { slug: 'matthew-mclennan', filing_date: day }, { slug: 'david-tepper', filing_date: day }, { slug: 'howard-marks', filing_date: day }, { slug: 'bill-ackman', filing_date: '2026-11-03' }],
          biggest: [{ slug: 'bill-ackman', manager: 'Bill Ackman', ticker: 'UBER', change: 'new', delta_value: 2e9 }, { slug: 'matthew-mclennan', manager: 'Matthew McLennan', ticker: 'CHRW', change: 'exited', delta_value: -686e6 }, { slug: 'matthew-mclennan', manager: 'Matthew McLennan', ticker: 'EXPD', change: 'exited', delta_value: -329.4e6 }, { slug: 'irving-kahn', manager: 'Irving Kahn', ticker: 'TRIM', change: 'trimmed', delta_value: -8e6 }, { slug: 'matthew-mclennan', manager: 'Matthew McLennan', ticker: 'NVR', change: 'new', delta_value: 400.1e6 },
            { slug: 'david-tepper', manager: 'David Tepper', ticker: 'TS1', change: 'exited', delta_value: -500e6 }, { slug: 'david-tepper', manager: 'David Tepper', ticker: 'TS2', change: 'trimmed', delta_value: -450e6 },
            { slug: 'howard-marks', manager: 'Howard Marks', ticker: 'HM1', change: 'trimmed', delta_value: -300e6 }, { slug: 'howard-marks', manager: 'Howard Marks', ticker: 'HM2', change: 'trimmed', delta_value: -280e6 },
            { slug: 'irving-kahn', manager: 'Irving Kahn', ticker: 'ADDS', change: 'added', delta_value: 5e6 }],
        });
      // Pzena filed Q3 on Oct 30, before this week's alert records: its card has the top moves.
      if (String(u) === `${SITE}d/f/0001027796-26-000065.json`) return Response.json({ bought_usd: 4e8, sold_usd: 9e8, moves: [{ ticker: 'GL', change: 'added', value_delta: 351721663 }, { ticker: 'UBS', change: 'trimmed', value_delta: -293362928 }, { ticker: 'HUM', change: 'trimmed', value_delta: -287623650 }, { ticker: 'MGA', change: 'trimmed', value_delta: -240117000 }] });
      if (String(u) === 'https://mg.test/v3/factordynamics.com/messages') {
        mg.push(new URLSearchParams(String(init?.body)));
        return Response.json({ id: 'x' });
      }
      return realFetch(u, init);
    });
    const { runEmail2 } = await import('../src/free');
    // Kahn filed today: 4 changed rows, of which Email 2 shows the 3 largest.
    const row = (t: string, change: string, v: number) => ({ ticker: t, display_name: null, issuer: t, cusip: `${t}00X100`, put_call: null, shares: 10, prev_shares: 5, value: Math.abs(v), value_delta: v, change, delta_pct_of_book: v / 800e6 });
    const kahn = { slug: 'irving-kahn', slugs: ['irving-kahn'], manager: 'Irving Kahn', name: 'Kahn Brothers', quarter: '2026Q3', report_date: '2026-09-30', filing_date: day, accession: '0001039565-26-000005', sec_url: 'https://www.sec.gov/k', accepted: new Date(now).toISOString(),
      moves: { bought_usd: 9e6, sold_usd: 8e6, new: [row('NEWB', 'new', 4e6)], added: [row('ADDS', 'added', 5e6)], trimmed: [row('TRIM', 'trimmed', -8e6)], exited: [row('GONE', 'exited', -1e6)] } };
    const { deliver } = await import('../src/alerts');
    await deliver(env, [kahn as never], [], now);
    // The data run's index says Pzena's latest 13F is Q3 (filed Oct 30).
    await env.DB.put('v1:filers', JSON.stringify([{ slug: 'richard-pzena', cik: '0001027796', name: 'Pzena Investment Management LLC', manager: 'Richard Pzena', featured: true, latest_quarter: '2026Q3', latest_report_date: '2026-09-30', latest_filing_date: '2026-10-30', latest_accession: '0001027796-26-000065' }]));
    // Nine real free signups (five follow Kahn, one Pzena) and two test signups.
    const signup = (email: string, i: number, follow: string) =>
      handleRequest(new Request('https://api.test/signup', { method: 'POST', body: JSON.stringify({ email, follow: [{ kind: 'investor', id: follow }] }), headers: { origin: 'https://refcell.github.io', 'cf-connecting-ip': `8.8.${i}.1` } }), env);
    for (let i = 0; i < 9; i++) await signup(`reader${i}@reader.test`, i, i < 5 ? 'irving-kahn' : i === 6 ? 'richard-pzena' : 'seth-klarman');
    await signup('copybook-test-e2@fldubai.com', 20, 'irving-kahn');
    await signup('copybook-kahn-e2@fldubai.com', 21, 'irving-kahn');

    // No postal address: skipped for good (no Copy ask can go out without one).
    expect(await runEmail2(env, now)).toEqual({ status: 'skipped', why: 'no postal address' });
    expect(JSON.parse((await env.DB.get('e2:done'))!).skipped).toBe('no postal address');
    await env.DB.delete('e2:done');
    // Its preview still goes (through Resend, with a marked placeholder) to test inboxes only.
    sent = [];
    await runEmail2(env, now, ['copybook-test-e2@fldubai.com', 'reader1@reader.test']);
    expect(sent.map((m) => [m.to[0], m.text.endsWith('[postal address: not configured yet]')])).toEqual([['copybook-test-e2@fldubai.com', true]]);
    expect(await env.DB.get('e2:done')).toBeNull();
    Object.assign(env, { POSTAL_ADDRESS: '1 Test St, Testville', MAILGUN_API_KEY: 'k', MAILGUN_BASE: 'https://mg.test' });
    // Nine real signups: under 10, skipped; the test signups don't count.
    expect(await runEmail2(env, now)).toEqual({ status: 'skipped', why: '9 real free signups, under 10' });
    expect(mg).toHaveLength(0);
    await env.DB.delete('e2:done');

    // A preview reaches our inbox and test inboxes only, marked [Preview], and never marks Email 2 done.
    await runEmail2(env, now, ['hello@factordynamics.com', 'reader0@reader.test', 'copybook-kahn-e2@fldubai.com']);
    expect(mg.map((b) => b.get('to'))).toEqual(['hello@factordynamics.com', 'copybook-kahn-e2@fldubai.com']);
    expect(mg.every((b) => b.get('subject')!.startsWith('[Preview] '))).toBe(true);
    expect(await env.DB.get('e2:done')).toBeNull();

    // Ten real signups: one Mailgun batch to exactly them.
    await signup('reader9@reader.test', 9, 'seth-klarman');
    mg.length = 0;
    sent = [];
    const r = await runEmail2(env, now);
    expect(r).toMatchObject({ sent: 10, filed_today: 4, biggest: 6 });
    expect(mg.map((b) => b.get('to')).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `reader${i}@reader.test`));
    expect(sent).toHaveLength(0);
    const k = mg.find((b) => b.get('to') === 'reader0@reader.test')!;
    const text = k.get('text')!;
    // The date of the send; a Kahn follower's email opens on Kahn's filing (his 3 largest moves, not GONE, person and
    // fund, % of fund), one Copy line for every row, the speed line, then the trial button on the first screen.
    const pricingUrl = 'https://refcell.github.io/gust/copybook/pricing/?from=e2&utm_source=email&utm_medium=email&utm_campaign=e2&utm_content=e2-paid&client_reference_id=email_e2-paid';
    expect(text.startsWith(`13F deadline night, Monday, November 16.\n\nYour follows:\n  Irving Kahn (Kahn Brothers) filed its Q3 13F today: trimmed TRIM −$8.0M (1.0% of fund); added ADDS +$5.0M (0.6% of fund); new position in NEWB +$4.0M (0.5% of fund)\n    https://refcell.github.io/gust/copybook/f/0001039565-26-000005/?utm_source=email&utm_medium=email&utm_campaign=e2&utm_content=e2-follows\n\nGet each 13F as it's filed, with Copy · 14 days free · no card needed: ${pricingUrl}\n\n`)).toBe(true);
    expect(text).not.toMatch(/median|minutes after/);
    expect(text).not.toContain('GONE');
    // No speed figures or clock times (the lead's rule for Email 2): the trial button follows the follows directly.
    for (const part of [text, k.get('html')!]) expect(part).not.toMatch(/\d:\d\d [ap]m|Copy members had|Preview example/);
    expect(k.get('html')).toMatch(/<\/div><p[^>]*><a [^>]*>Get each 13F as it's filed, with Copy<\/a><\/p><p[^>]*>14 days free · no card needed</);
    // Below: each manager's top sell and top buy (exits count), managers by their largest move.
    expect(text).toContain("The day's biggest moves:\n  Matthew McLennan (First Eagle): sold out of CHRW −$686.0M (1.4% of fund)\n  Matthew McLennan (First Eagle): new position in NVR +$400.1M (0.8% of fund)\n  David Tepper: sold out of TS1 −$500.0M\n  Howard Marks: trimmed HM1 −$300.0M\n");
    expect(text).not.toMatch(/UBER|EXPD|HM2|TS2/);
    // Member email links: the site and the Worker, never gene's host; one-click unsubscribe goes to the Worker.
    for (const part of [text, k.get('html')!]) expect(part).not.toMatch(/ts\.net|trycloudflare|🔒/);
    expect(text).toMatch(/You get this because you follow investors on Copybook\. Unsubscribe: https:\/\/copybook-api\.factordynamics\.workers\.dev\/unsubscribe\?t=\S+[\s\S]*1 Test St, Testville$/);
    expect(k.get('h:List-Unsubscribe')).toMatch(/^<https:\/\/copybook-api\.factordynamics\.workers\.dev\/unsubscribe\?t=/);
    expect(k.get('h:List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
    // Subject from the night's data: the followed fund's top move (no follow still due). Preheader: who is still due.
    expect(k.get('subject')).toBe('Kahn Brothers trimmed $8M of TRIM');
    expect(k.get('html')).toMatch(/^<div style="display:none[^>]*>Klarman due by Mon Nov 16</);
    // A Klarman follower: one row, expected (never "none filed" or "still due"); the subject is the night's top manager.
    const s5 = mg.find((b) => b.get('to') === 'reader5@reader.test')!;
    expect(s5.get('text')).toContain("Your follows:\n  Seth Klarman: expected by Fri Nov 20\n\nGet each 13F as it's filed, with Copy");
    expect(s5.get('text')).not.toMatch(/none filed|still due/i);
    expect(s5.get('subject')).toBe('First Eagle bought $400M of NVR, sold out of CHRW');
    // Pzena filed Q3 on Oct 30 (before this week's records): his top moves, never "still due".
    const pz = mg.find((b) => b.get('to') === 'reader6@reader.test')!;
    expect(pz.get('text')).toContain('Your follows:\n  Richard Pzena filed its Q3 13F Fri Oct 30: added GL +$351.7M; trimmed UBS −$293.4M; trimmed HUM −$287.6M\n');
    expect(pz.get('text')).not.toMatch(/still due|expected/);
    // A followed manager that filed earlier in the season still leads the subject (retail's v5 review).
    expect(pz.get('subject')).toBe('Pzena added $352M of GL'); // $351.7M rounds, not truncates
    // Once only.
    expect(await runEmail2(env, now)).toEqual({ status: 'already done' });
    // A preview carries no clock times either.
    mg.length = 0;
    await runEmail2(env, Date.parse('2026-11-11T15:00:00Z'), ['copybook-kahn-e2@fldubai.com']);
    expect(mg[0].get('text')).not.toMatch(/\d:\d\d [ap]m|Copy members had/);
    Object.assign(env, { POSTAL_ADDRESS: undefined, MAILGUN_API_KEY: undefined });
    vi.stubGlobal('fetch', realFetch);
  });

  it('"Your names this week": paying members (paused too) get the week\'s alerts in their names once, by Saturday; opt-out, free and Holdterm skipped; digest_live after the first real send', async () => {
    const now = Date.now();
    const day = (d: number) => new Date(now - 5 * 3600_000 - d * 86_400_000).toISOString().slice(0, 10);
    const row = (t: string, change: string, v: number) => ({ ticker: t, display_name: null, issuer: t, cusip: t, put_call: null, shares: 10, prev_shares: 5, value: Math.abs(v), value_delta: v, change });
    const brk = { slug: 'warren-buffett', slugs: ['warren-buffett'], tickers: ['AAPL', 'BAC', 'OXY', 'KO'], manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', quarter: '2026Q3', report_date: '2026-09-30', filing_date: day(2), accession: '0000950123-26-000001', sec_url: 'https://www.sec.gov/b', accepted: new Date(now - 2 * 86_400_000).toISOString() };
    // The 13F first went out without its moves (stored two days ago), then with them; Buffett's Form 4 yesterday.
    await env.DB.put(`digest:${day(2)}`, JSON.stringify({ filings: [{ ...brk, moves_pending: true }, { ...brk, followup: true, moves: { bought_usd: 25e8, sold_usd: 31e8, new: [row('OXY', 'new', 5e8)], added: [row('AAPL', 'added', 2e9)], trimmed: [row('BAC', 'trimmed', -3e9)], exited: [row('KO', 'exited', -1e8)] } }], events: [] }));
    await env.DB.put(`digest:${day(1)}`, JSON.stringify({ filings: [], events: [{ id: 'siri1', slug: 'warren-buffett', manager: 'Warren Buffett', form: '4', kind: 'form4', action: 'buy', filing_date: day(1), accepted: new Date(now - 86_400_000).toISOString(), url: 'https://www.sec.gov/siri1', issuer: 'SIRIUS XM', display_name: 'Sirius XM', ticker: 'SIRI', shares: 1000, value_usd: 25000 }] }));
    const pm = (c: string, email: string, extra: Record<string, unknown> = {}) => env.DB.put(`cus:${c}`, JSON.stringify({ customer: c, email, status: 'active', plan: 'copy', interval: 'monthly', period_end: 0, subscription: `sub_${c}`, alerts: ['warren-buffett'], welcomed: true, ...extra }));
    await pm('cus_n1', 'n1@reader.test');
    await putFollows('cus_n1', { investors: ['warren-buffett'] });
    // Paused: alerts off, the summary still comes and says when alerts resume.
    await pm('cus_n2', 'n2@reader.test', { alerts: 'off', paused_until: Math.floor(now / 1000) + 20 * 86400 });
    await putFollows('cus_n2', { investors: ['warren-buffett'] });
    await pm('cus_n3', 'n3@reader.test', { alerts: ['seth-klarman'] });
    await putFollows('cus_n3', { investors: ['seth-klarman'] });
    await pm('cus_n4', 'n4@reader.test');
    await putFollows('cus_n4', { investors: ['warren-buffett'], weekly_digest: false });
    await pm('cus_n5', 'n5@reader.test', { plan: 'free', status: 'free' });
    await pm('cus_n6', 'n6@reader.test', { plan: 'holdterm' });
    await pm('cus_n7', 'n7@reader.test', { status: 'canceled' });
    const { runWeeklyNames } = await import('../src/alerts');
    sent = [];
    expect(await runWeeklyNames(env, now)).toEqual({ emails: 3, status: '200' });
    const by = Object.fromEntries(sent.map((m) => [m.to[0], m]));
    expect(Object.keys(by).sort()).toEqual(['n1@reader.test', 'n2@reader.test', 'n3@reader.test']);
    const t1 = by['n1@reader.test'].text;
    expect(by['n1@reader.test'].subject).toBe('Your names this week: 1 13F, 1 Form 4/13D/G');
    // The 13F once, in its version with moves: the three largest trades, largest first.
    expect(t1.match(/Berkshire Hathaway/g)?.length).toBe(1);
    expect(t1).toMatch(/trimmed BAC [^,]+, added AAPL [^,]+, new OXY [^\n]+\n/);
    expect(t1).not.toContain('KO');
    expect(t1).toContain('https://www.sec.gov/siri1');
    expect(by['n2@reader.test'].text).toMatch(/Your plan is paused; alerts resume \w+ \d+\. This weekly summary keeps coming meanwhile\./);
    expect(by['n2@reader.test'].text).toContain('BAC');
    expect(by['n3@reader.test'].subject).toBe('Your names this week: a quiet week');
    // Once a week; /me says the digest is live.
    expect(await runWeeklyNames(env, now)).toEqual({ emails: 0, status: 'already sent' });
    expect(await env.DB.get('names-weekly:live')).toBe(day(0));

    // The operator audit of one alert: its stored copy and who got it, row IDs only, each read logged.
    await env.DB.put('delivered:cus_n1', JSON.stringify([{ day: day(2), ids: [brk.accession, `${brk.accession}:moves`] }]));
    const audit = (id: string) => handleRequest(new Request(`https://api.test/ops/delivery?id=${id}`, { headers: { authorization: `Bearer ${env.HEALTH_TOKEN}`, 'x-copybook-operator': 'audit-test' } }), env);
    const rec = await (await audit(brk.accession)).json();
    expect([rec.alert.versions, rec.recipients, rec.counts]).toEqual([2, [{ customer: 'cus_n1', test: false, day: day(2), parts: [brk.accession, `${brk.accession}:moves`] }], { members: 1, real: 1 }]);
    expect(JSON.stringify(rec)).not.toContain('n1@reader.test');
    expect((await env.DB.get('access:cus_n1')) ?? '').toContain('audit-test');
    expect((await audit('x')).status).toBe(400);
  });

  it('net-30 Fund order: a yearly Fund subscription billed by invoice, the order terms as memo and footer, emailed at once', async () => {
    const calls: { method: string; path: string; body: URLSearchParams }[] = [];
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (!url.startsWith('https://api.stripe.com/v1/')) return orig(u, init);
      const path = url.slice('https://api.stripe.com/v1/'.length).split('?')[0];
      calls.push({ method: init?.method ?? 'GET', path, body: new URLSearchParams(String(init?.body ?? '')) });
      if (path === 'customers' && init?.method !== 'POST') return Response.json({ data: [] });
      if (path === 'customers') return Response.json({ id: 'cus_fund' });
      if (path === 'prices') return Response.json({ data: [{ id: 'price_fund_yearly' }] });
      if (path === 'subscriptions') return Response.json({ id: 'sub_fund', customer: 'cus_fund', created: Math.floor(Date.now() / 1000), metadata: { founding: 'true' }, latest_invoice: 'in_fund' });
      if (path === 'invoices/in_fund' && init?.method !== 'POST') return Response.json({ id: 'in_fund', status: 'draft' });
      if (path === 'invoices/in_fund/send') return Response.json({ id: 'in_fund', status: 'open', number: 'CB-0001', due_date: 1765497600, hosted_invoice_url: 'https://invoice.stripe.com/i/x' });
      return Response.json({ id: 'in_fund', status: 'open' });
    });
    const go = (b: unknown, token = env.HEALTH_TOKEN) => handleRequest(new Request('https://api.test/ops/fund-invoice', { method: 'POST', body: JSON.stringify(b), headers: { authorization: `Bearer ${token}` } }), env);
    expect((await go({ email: 'pm@fund.test' }, 'wrong')).status).toBe(404);
    expect((await go({ email: 'nope' })).status).toBe(400);
    const r = await (await go({ email: 'PM@fund.test', name: 'Example Capital', po: 'PO-7781' })).json();
    expect(r).toMatchObject({ ok: true, customer: 'cus_fund', subscription: 'sub_fund', invoice: 'in_fund', number: 'CB-0001', due_date: '2025-12-12', hosted_invoice_url: 'https://invoice.stripe.com/i/x' });
    const posted = (p: string) => calls.find((c) => c.method === 'POST' && c.path === p)!.body;
    const footer = posted('customers').get('invoice_settings[footer]')!;
    // The order terms: the seats, the locked founding price, renewal and cancellation, net 30, and /terms/.
    for (const s of ['Copy Fund, up to 10 seats', 'Founding price $1,990 a year for up to 10 seats, whatever number are used, locked for as long as this subscription stays active', 'Terms in force on the invoice date', 'Renews each year at that price until cancelled', 'Cancel any time from Manage billing', 'If we discontinue the plan during a prepaid period, we refund the unused part pro rata.', 'payable within 30 days', `${SITE}terms/`]) expect(footer).toContain(s);
    expect(posted('customers').get('email')).toBe('pm@fund.test');
    expect(Object.fromEntries(['customer', 'items[0][price]', 'collection_method', 'days_until_due', 'metadata[copybook]'].map((k) => [k, posted('subscriptions').get(k)]))).toEqual({ customer: 'cus_fund', 'items[0][price]': 'price_fund_yearly', collection_method: 'send_invoice', days_until_due: '30', 'metadata[copybook]': 'fund' });
    // The memo points to the order terms in the footer (Stripe refuses a memo over 500 characters); the footer adds the tax position.
    const memo = posted('invoices/in_fund').get('description')!;
    expect([memo.length <= 500, posted('subscriptions').get('description')!.length <= 500, memo]).toEqual([true, true, expect.stringContaining('Full order terms below')]);
    expect(footer).toMatch(/payable within 30 days\. Terms in force on the invoice date: \S+ Prices exclude applicable taxes\. Copybook does not currently collect sales tax\.$/);
    expect(posted('invoices/in_fund').get('footer')).toBe(footer);
    // The founding price, the company and the customer's PO print on the invoice (and on the customer's later ones).
    expect([0, 1, 2].map((i) => [posted('invoices/in_fund').get(`custom_fields[${i}][name]`), posted('invoices/in_fund').get(`custom_fields[${i}][value]`)])).toEqual([['Price', 'Founding price, kept while subscribed'], ['PO', 'PO-7781'], ['Company', 'Example Capital']]);
    expect(posted('subscriptions').get('metadata[founding]')).toBe('true');
    expect(calls.map((c) => `${c.method} ${c.path}`).slice(-3)).toEqual(['POST invoices/in_fund', 'POST invoices/in_fund/finalize', 'POST invoices/in_fund/send']);
    vi.stubGlobal('fetch', orig);
  });

  it('Fund trial by invoice: a work email, company and billing address start a 14-day trial billed Net 30, no card; one per domain; paused when overdue', async () => {
    const calls: { method: string; path: string; body: URLSearchParams }[] = [];
    const orig = globalThis.fetch;
    let n = 0;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (!url.startsWith('https://api.stripe.com/v1/')) return orig(u, init);
      const path = url.slice('https://api.stripe.com/v1/'.length).split('?')[0];
      const body = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ method: init?.method ?? 'GET', path, body });
      if (path === 'customers' && init?.method === 'POST') return Response.json({ id: `cus_it${++n}` });
      if (path.startsWith('customers/')) return Response.json({ id: path.slice(10), invoice_settings: {} });
      if (path === 'prices') return Response.json({ data: [{ id: 'price_fund_yearly' }] });
      if (path === 'subscriptions' && init?.method === 'POST') {
        const t = Math.floor(Date.now() / 1000);
        return Response.json({ id: `sub_it${n}`, customer: body.get('customer'), status: 'trialing', trial_end: t + 14 * 86400, created: t, collection_method: 'send_invoice', days_until_due: 30, current_period_end: t + 14 * 86400, metadata: { copybook: 'fund', ...(body.get('metadata[po]') ? { po: body.get('metadata[po]') } : {}), ...(body.get('metadata[ap_email]') ? { ap_email: body.get('metadata[ap_email]') } : {}) }, items: { data: [{ price: { id: 'price_fund_yearly', lookup_key: 'fund_yearly', unit_amount: 199000, recurring: { interval: 'year' } } }] } });
      }
      return Response.json({ id: 'x' });
    });
    const go = (b: Record<string, unknown>, ip = '7.7.7.1') => handleRequest(new Request('https://api.test/fund-request', { method: 'POST', body: JSON.stringify({ topic: 'fund', invoice_trial: true, ...b }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip } }), env);
    const address = { line1: '1 Main St', city: 'Boston', state: 'MA', postal_code: '02110', country: 'us' };
    // Freemail and missing fields are refused before anything is created.
    const free = await go({ email: 'coo@gmail.com', fund: 'Acme Capital', billing_address: address }, '7.7.7.2');
    expect([free.status, (await free.json()).code]).toEqual([400, 'freemail']);
    const miss = await (await go({ email: 'coo@acme-cap.test', billing_address: { line1: '1 Main St' } }, '7.7.7.3')).json();
    expect([miss.code, miss.fields]).toEqual(['bad_request', ['fund', 'billing_address.city', 'billing_address.postal_code', 'billing_address.country']]);
    // A bad value: the field as a bare path (the form highlights it), the hint in error.
    const bad = await (await go({ email: 'coo@acme-cap.test', fund: 'Acme Capital', billing_address: { ...address, country: 'USA' } }, '7.7.7.4')).json();
    expect([bad.code, bad.fields, bad.error.includes('2 letters, e.g. US')]).toEqual(['bad_request', ['billing_address.country'], true]);
    // A string "true" is refused, never a plain lead past the freemail check (the PM: it became one).
    const str = await go({ email: 'coo@gmail.com', fund: 'Acme Capital', billing_address: address, invoice_trial: 'true' }, '7.7.7.5');
    expect([str.status, (await str.json()).fields]).toEqual([400, ['invoice_trial']]);
    // A disposable domain (mail.tm's fldubai.com passed), and a subdomain of one.
    for (const e of ['coo@fldubai.com', 'coo@x.mailinator.com']) {
      const d = await go({ email: e, fund: 'Acme Capital', billing_address: address }, '7.7.7.6');
      expect([e, d.status, (await d.json()).code]).toEqual([e, 400, 'disposable']);
    }
    expect(calls).toEqual([]);
    // Started: no card, trial 14 days, send_invoice Net 30; the owner is a member at once and gets the sign-in link.
    const before = sent.length;
    const r = await go({ email: 'COO@acme-cap.test', fund: 'Acme Capital', billing_address: address, po: 'PO-55', ap_email: 'ap@acme-cap.test' });
    const j = await r.json();
    expect([j.po, j.ap_email]).toEqual(['PO-55', 'ap@acme-cap.test']);
    expect([r.status, j.trial, j.sign_in_email, j.invoice_on, j.due_on]).toEqual([200, 'started', 'sent', new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10), new Date(Date.now() + 44 * 86400_000).toISOString().slice(0, 10)]);
    const post = (p: string) => calls.find((c) => c.method === 'POST' && c.path === p)!.body;
    expect(Object.fromEntries(['trial_period_days', 'collection_method', 'days_until_due', 'metadata[invoice_trial]'].map((k) => [k, post('subscriptions').get(k)]))).toEqual({ trial_period_days: '14', collection_method: 'send_invoice', days_until_due: '30', 'metadata[invoice_trial]': 'true' });
    expect([post('customers').get('name'), post('customers').get('address[country]'), post('customers').get('address[postal_code]'), post('subscriptions').has('default_payment_method')]).toEqual(['Acme Capital', 'US', '02110', false]);
    // The invoice prints the PO and the AP email.
    const fields = calls.filter((c) => c.method === 'POST' && c.path === 'customers/cus_it1').map((c) => {
      const out: string[] = [];
      c.body.forEach((v, k) => k.includes('custom_fields') && out.push(v));
      return out;
    }).flat();
    expect(fields).toEqual(expect.arrayContaining(['PO', 'PO-55', 'AP email', 'ap@acme-cap.test', 'Payment terms', 'Net 30']));
    const { getMember } = await import('../src/members');
    const m = (await getMember(env, 'cus_it1'))!;
    expect([m.email, m.plan, m.status, m.collection, isActive(m)]).toEqual(['coo@acme-cap.test', 'fund', 'trialing', 'send_invoice', true]);
    const welcome = sent.slice(before).filter((x) => x.to[0] === 'coo@acme-cap.test');
    expect(welcome.length).toBe(1);
    // The welcome says what the invoice will be and who gets it, and starts with the team; no card wording.
    const inv1 = new Date((Date.now() / 1000 + 14 * 86400) * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
    expect([welcome[0].text.includes('$1,990'), welcome[0].text.includes('stays Net 30 even if you add a card'), welcome[0].text.includes('PO PO-55'), welcome[0].text.includes('a copy to ap@acme-cap.test'), welcome[0].text.includes(`Cancel before ${inv1} and nothing is owed`), /1\. Invite your team \(up to 10\)/.test(welcome[0].text), /not charged|subscribed from/.test(welcome[0].text)]).toEqual([true, true, true, true, true, true, false]);
    // /me: the invoice trial as /account/ shows it (amount in cents).
    const { publicView } = await import('../src/members');
    expect(publicView(m).invoice_trial).toEqual({ invoice_on: new Date(m.trial_end! * 1000).toISOString().slice(0, 10), due_on: new Date((m.trial_end! + 30 * 86400) * 1000).toISOString().slice(0, 10), amount: 199000, currency: 'usd', po: 'PO-55', ap_email: 'ap@acme-cap.test', invoice_to: 'coo@acme-cap.test' });
    // Day 14: the finalized invoice's copy goes to AP once, with its links; a $0 invoice gets none.
    const revA = await import('../src/revenue');
    const apBefore = sent.length;
    const fin = { id: 'in_ap1', customer: 'cus_it1', number: 'CB-0042', amount_due: 199000, due_date: Math.floor(Date.now() / 1000) + 30 * 86400, hosted_invoice_url: 'https://invoice.stripe.com/i/ap', invoice_pdf: 'https://pay.stripe.com/invoice/ap/pdf' };
    expect([await revA.apCopy(env, fin), await revA.apCopy(env, fin), await revA.apCopy(env, { ...fin, id: 'in_zero', amount_due: 0 })]).toEqual([expect.stringMatching(/^sent/), 'already', 'nothing due']);
    expect(sent.slice(apBefore).map((x) => [x.to[0], x.subject.includes('$1,990.00'), x.text.includes('https://invoice.stripe.com/i/ap'), x.text.includes('PO: PO-55')])).toEqual([['ap@acme-cap.test', true, true, true]]);
    // One invoice trial per company domain.
    const again = await go({ email: 'cfo@acme-cap.test', fund: 'Acme Capital', billing_address: address }, '7.7.7.4');
    expect([again.status, (await again.json()).code]).toEqual([409, 'trial_used']);
    // Day 44 unpaid: access pauses, the owner is told; paid: back.
    const rev = await import('../src/revenue');
    const mailsBefore = sent.length;
    expect(await rev.markOverdue(env, 'cus_it1', { number: 'CB-0042', amount_due: 199000, due_date: Math.floor(Date.now() / 1000) - 86400, hosted_invoice_url: 'https://invoice.stripe.com/i/y' })).toMatch(/^paused/);
    expect(isActive(await getMember(env, 'cus_it1'))).toBe(false);
    expect(sent.slice(mailsBefore).map((x) => [x.to[0], /past due/.test(x.subject), x.text.includes('$1,990')])).toEqual([['coo@acme-cap.test', true, true]]);
    expect(await rev.clearOverdue(env, 'cus_it1')).toBe('resumed');
    expect(isActive(await getMember(env, 'cus_it1'))).toBe(true);
    // A card trial switches to invoice in the account; monthly stays card-only.
    expect(await rev.switchToInvoice(env, { ...m, interval: 'monthly' } as never)).toMatchObject({ ok: false, code: 'monthly_card_only' });
    vi.stubGlobal('fetch', orig);
  });

  it("a CUSIP change nets into one share-based move (Fisher's Q3 XOM: +$75.7M, not +$894.9M)", async () => {
    const { computeMoves, netRenamed } = await import('../src/edgar');
    const other = { cusip: '037833100', put_call: null, issuer: 'APPLE INC', ticker: 'AAPL', shares: 1e6, value: 2e8 };
    const prev = [{ cusip: '30231G102', put_call: null, issuer: 'EXXON MOBIL CORP', ticker: 'XOM', shares: 31468114, value: 4302320615 }, other];
    const cur = [{ cusip: '30233Q108', put_call: null, issuer: 'EXXONMOBIL HOLDINGS CORPORATIO', shares: 31933523, value: 5197180970 }, other];
    const raw = computeMoves(cur as never, prev as never);
    raw.changed.find((x) => x.cusip === '30233Q108')!.ticker = 'XOM'; // as lookupTickers maps the new CUSIP
    const r = netRenamed(raw);
    expect(r.changed.map((x) => [x.change, x.ticker, x.shares - x.prev_shares, x.value_delta])).toEqual([['added', 'XOM', 465409, 75745316]]);
    expect([r.moves.new, r.moves.exited, r.moves.bought_usd]).toEqual([[], [], 75745316]);

    // The reissued CUSIP is linked before the diff, with no ticker on the new CUSIP (a small holder's row outside the
    // minute poll's ticker lookups): no exit, no new position, through the price gate too.
    const linked = computeMoves(cur as never, prev as never);
    expect(linked.changed.map((x) => [x.change, x.cusip, x.shares - x.prev_shares])).toEqual([['added', '30233Q108', 465409]]);
    const { gateMoves } = await import('../src/edgar');
    const g = gateMoves(linked, prev as never, new Map(), new Map());
    expect([g.moves.exited, g.moves.new, g.held, g.changed.map((x) => x.change)]).toEqual([[], [], [], ['added']]);
    // Same shares under the new CUSIP: no move at all.
    const same = computeMoves([{ ...cur[0], shares: 31468114 }, other] as never, prev as never);
    expect(same.changed).toEqual([]);
    // Moves already stored as an exit plus a new row (alerts sent before the link), the new CUSIP without a ticker: netted.
    const stored = [{ change: 'exited', cusip: '30231G102', ticker: 'XOM', put_call: null, shares: 0, prev_shares: 31468114, value: 0, value_delta: -4302320615 }, { change: 'new', cusip: '30233Q108', ticker: null, put_call: null, shares: 31933523, prev_shares: 0, value: 5197180970, value_delta: 5197180970 }];
    expect(netRenamed({ moves: {} as never, changed: stored as never }).changed.map((x) => [x.change, x.shares - x.prev_shares])).toEqual([['added', 465409]]);
    // A filer still holding the old CUSIP alongside the new one isn't relinked: the old row stays its own position.
    expect(computeMoves([...cur, { ...prev[0] }] as never, prev as never).changed.map((x) => [x.change, x.cusip])).toEqual([['new', '30233Q108']]);
    // Every SEC-confirmed reissue, ours and ingest's (cusip_links.json, sec_13f_list only), links in the alert path: a
    // filer that held either CUSIP last quarter never reads as an exit or a new position (the quant: FMR's TEVA ADS ->
    // ordinary read as a $1.03B exit plus a new buy). Detection-only links (SPAC units to shares) are never used.
    const ed = await import('../src/edgar');
    const { compareToBuild } = await import('../src/alerts');
    const real1 = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => String(u).endsWith('cusip_links.json')
      ? Response.json({
          links: {
            '12345A101': { new: '12345B107', ticker: 'NEWCO', basis: 'sec_13f_list', ratio: 1, units_basis: 'holders_1to1', units_check: { split_ratio: null, exact_at_1: 0.98 } },
            // SEC-listed but no units result (the 11:49 file): a COM -> COM NEW reverse split would net 1:1 into a huge trim.
            '68232V801': { new: '68232V900', ticker: 'ONCY', basis: 'sec_13f_list' },
            '68232V802': { new: '68232V901', ticker: 'ONC2', basis: 'sec_13f_list', units_check: { split_ratio: null } },
            '55555A101': { new: '55555A200', ticker: 'RSPL', basis: 'sec_13f_list', ratio: 0.1, units_basis: 'split_confirmed' },
            '99999U107': { new: '99999S104', ticker: 'SPAC', basis: 'detected', ratio: 1, units_basis: 'holders_1to1' },
          },
          held: [{ old: '438516106', new: '438516205', ticker: 'HON', basis: 'sec_13f_list', units_reason: '0.5x shares, price 0.99x' }],
        })
      : real1(u, init));
    await ed.loadReissues(env, Date.now() + 10 * 86400_000);
    vi.stubGlobal('fetch', real1);
    expect([ed.REISSUED['12345A101']?.to, ed.REISSUED['68232V801'], ed.REISSUED['68232V802'], ed.REISSUED['99999U107'], ed.REISSUED['55555A101']?.ratio]).toEqual(['12345B107', undefined, undefined, undefined, 0.1]);
    // Held (HON, NVRI) never link; DD links as its 1-for-3 split.
    expect([ed.REISSUED['438516106'], ed.REISSUED['415864107'], ed.HELD['438516106']?.to, ed.HELD['415864107']?.to, ed.REISSUED['26614N102']?.ratio]).toEqual([undefined, undefined, '438516205', '29390K102', 1 / 3]);
    for (const [old, { to, ticker, ratio }] of Object.entries(ed.REISSUED)) {
      const was = [{ cusip: old, put_call: null, issuer: ticker, shares: 30258016, value: 1_030_000_000 }, other];
      const now = [{ cusip: to, put_call: null, issuer: ticker, shares: Math.round(25784696 * (ratio ?? 1)), value: 900_000_000 }, other];
      const ch = computeMoves(now as never, was as never).changed;
      expect([ticker, ch.map((x) => x.change)]).toEqual([ticker, ['trimmed']]);
      // A build that left the pair unlinked (an exit plus a new line, no tickers) never corrects the trim.
      const build = new Map([[`${to}|`, { cusip: to, ticker: null, change: 'new', value_delta: 900_000_000 }], [`${old}|`, { cusip: old, ticker: null, change: 'exited', value_delta: -1_030_000_000 }]]);
      expect(compareToBuild(new Map([[`${to}|`, { ...ch[0], ticker: null }]]), build as never)).toEqual([]);
    }
    // DD (26614N102 -> 26614N201, 1-for-3): 3,000 old shares are 1,000 new; holding 1,000 is no trade, 1,200 an add of 200.
    const dd = (n: number) => computeMoves([{ cusip: '26614N201', put_call: null, issuer: 'DD', shares: n, value: n * 95 }] as never, [{ cusip: '26614N102', put_call: null, issuer: 'DD', shares: 3000, value: 90000 }] as never).changed.map((x) => [x.change, x.prev_shares, x.shares]);
    expect([dd(1000), dd(1200)]).toEqual([[], [['added', 1000, 1200]]]);
    // HON (held: 0.5x the shares at the same price): one exchange line, no dollars in bought, sold or net; a real exit
    // (old code gone, no new) stays an exit.
    const hon = computeMoves([{ cusip: '438516205', put_call: null, issuer: 'HON', ticker: 'HON', shares: 500, value: 200000 }, other] as never, [{ cusip: '438516106', put_call: null, issuer: 'HON', ticker: 'HON', shares: 1000, value: 200000 }, other] as never);
    expect([hon.changed.map((x) => [x.change, x.value_delta]), hon.moves.bought_usd, hon.moves.sold_usd, hon.moves.exchanged?.map(ed.exchangeLine)]).toEqual([[['exchanged', 0]], 0, 0, ['HON: CUSIP exchanged (438516106 → 438516205), not a trade']]);
    expect(netRenamed(hon).changed.map((x) => x.change)).toEqual(['exchanged']);
    const honStored = [{ change: 'exited', cusip: '438516106', ticker: 'HON', put_call: null, shares: 0, prev_shares: 1000, value: 0, value_delta: -200000 }, { change: 'new', cusip: '438516205', ticker: 'HON', put_call: null, shares: 500, prev_shares: 0, value: 200000, value_delta: 200000 }];
    expect(netRenamed({ moves: {} as never, changed: honStored as never }).changed.map((x) => x.change)).toEqual(['exited', 'new']);
    expect(computeMoves([other] as never, [{ cusip: '438516106', put_call: null, issuer: 'HON', shares: 1000, value: 200000 }, other] as never).changed.map((x) => x.change)).toEqual(['exited']);
    // DD in reconciliation: the build's prior in old units (3,000) against the alert's 1,000 is the same position, no
    // correction; a build with other shares is one, judged on split-adjusted shares.
    const ddRow = { cusip: '26614N201', ticker: 'DD', put_call: null, change: 'added', shares: 1200, prev_shares: 1000, value_delta: 19000 };
    const ddBuild = (shares: number) => new Map([['26614N201|', { cusip: '26614N201', ticker: 'DD', change: 'added', shares, prev_shares: 3000, value_delta: 9 }]]);
    expect(compareToBuild(new Map([['26614N201|', ddRow]]) as never, ddBuild(1200) as never)).toEqual([]);
    expect(compareToBuild(new Map([['26614N201|', ddRow]]) as never, ddBuild(900) as never).map((x) => x.v1.change)).toEqual(['trimmed']);
    // The loader: ratio and units_basis both; a link the next file drops is dropped; a failed read retries in 5 minutes.
    const fileWith = (links: Record<string, unknown>) => async (u: string, init?: RequestInit) => (String(u).endsWith('cusip_links.json') ? Response.json({ links, held: [] }) : real1(u, init));
    const t1 = Date.now() + 20 * 86400_000;
    vi.stubGlobal('fetch', fileWith({ '12345A101': { new: '12345B107', ticker: 'NEWCO', basis: 'sec_13f_list', units_basis: 'holders_1to1' }, '77777A101': { new: '77777A200', ticker: 'KEEP', basis: 'sec_13f_list', ratio: 1, units_basis: 'holders_1to1' } }));
    await ed.loadReissues(env, t1);
    expect([ed.REISSUED['12345A101'], ed.REISSUED['77777A101']?.to, ed.REISSUED['881624209']?.to]).toEqual([undefined, '77777A200', 'M8769Q102']);
    vi.stubGlobal('fetch', async () => { throw new Error('down'); });
    await ed.loadReissues(env, t1 + 3600_000);
    vi.stubGlobal('fetch', fileWith({}));
    await ed.loadReissues(env, t1 + 3600_000 + 240_000);
    expect(ed.REISSUED['77777A101']?.to).toBe('77777A200');
    await ed.loadReissues(env, t1 + 3600_000 + 310_000);
    expect(ed.REISSUED['77777A101']).toBeUndefined();
    vi.stubGlobal('fetch', real1);
    // A one-for-one linked pair the build lists as one position is checked like any row: a wrong trim is corrected.
    const xomRow = { cusip: '30233Q108', ticker: 'XOM', put_call: null, change: 'trimmed', shares: 900, prev_shares: 1000, value_delta: -10000 };
    const xomBuild = (change: string, value_delta: number) => new Map([['30233Q108|', { cusip: '30233Q108', ticker: 'XOM', change, shares: 1100, prev_shares: 1000, value_delta }]]);
    expect(compareToBuild(new Map([['30233Q108|', xomRow]]) as never, xomBuild('added', 10000) as never).map((x) => x.v1.change)).toEqual(['added']);
    expect(compareToBuild(new Map([['30233Q108|', xomRow]]) as never, xomBuild('trimmed', -10000) as never)).toEqual([]);
    // Ingest's ratios, any size: NVRI linked at 1/3 leaves HELD; RBKB's 1.3978 (above 1) scales the prior up. A null
    // entry is skipped, and a file that fails to parse leaves the maps as they were.
    vi.stubGlobal('fetch', fileWith({ '415864107': { new: '29390K102', ticker: 'NVRI', basis: 'sec_13f_list', ratio: 1 / 3, units_basis: 'split_confirmed', quarter: '2026Q3', units_check: { to_quarter: '2026Q2' } }, '26614N102': { new: '26614N201', ticker: 'DD', basis: 'sec_13f_list', ratio: 0.333333, units_basis: 'split_confirmed', quarter: '2026Q3', units_check: { to_quarter: '2026Q2' } }, '75689M101': { new: '75689M200', ticker: 'RBKB', basis: 'sec_13f_list', ratio: 1.3978, units_basis: 'split_confirmed' }, '00000A101': null }));
    await ed.loadReissues(env, t1 + 8_000_000);
    expect([ed.HELD['415864107'], ed.REISSUED['415864107']?.ratio, ed.REISSUED['75689M101']?.ratio, !!ed.HELD['438516106']]).toEqual([undefined, 1 / 3, 1.3978, true]);
    // A link's quarter is the first filed under the new CUSIP (the units check's to_quarter), not the list's (DD filed 26614N201 from Q2).
    expect([ed.REISSUED['415864107']?.quarter, ed.REISSUED['26614N102']?.quarter, ed.REISSUED['75689M101']?.quarter]).toEqual(['2026Q2', '2026Q2', undefined]);
    expect(computeMoves([{ cusip: '75689M200', put_call: null, issuer: 'RBKB', shares: 1398, value: 13980 }] as never, [{ cusip: '75689M101', put_call: null, issuer: 'RBKB', shares: 1000, value: 10000 }] as never).changed).toEqual([]);
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => (String(u).endsWith('cusip_links.json') ? new Response('{"links": {"x": ') : real1(u, init)));
    await ed.loadReissues(env, t1 + 12_000_000);
    expect(ed.REISSUED['75689M101']?.ratio).toBe(1.3978);
    vi.stubGlobal('fetch', real1);
    // A detection-only pair stays an exit plus a new position.
    expect(computeMoves([{ cusip: '99999S104', put_call: null, issuer: 'S', shares: 10, value: 100 }] as never, [{ cusip: '99999U107', put_call: null, issuer: 'U', shares: 10, value: 100 }] as never).changed.map((x) => x.change).sort()).toEqual(['exited', 'new']);
    // By ticker or the old issuer code, XOM and TEVA resolve to the current issuer (the quant: XOM read the stale 30231G
    // book, 447 false exits; TEVA the old ADS code); HON kept its issuer code, so nothing moves.
    const { issuerCode } = await import('../src/v1data');
    hist.m.set('pre/stock-codes.json', new TextEncoder().encode('{"XOM":"30231G","TEVA":"881624","HON":"438516"}'));
    expect(await issuerCode(env, 'XOM')).toEqual({ code: '30233Q', ticker: 'XOM' });
    expect(await issuerCode(env, 'teva')).toEqual({ code: 'M8769Q', ticker: 'TEVA' });
    expect(await issuerCode(env, '30231G')).toEqual({ code: '30233Q', ticker: 'XOM', superseded_by: '30233Q' });
    expect(await issuerCode(env, '881624209')).toEqual({ code: 'M8769Q', ticker: 'TEVA', superseded_by: 'M8769Q' });
    expect(await issuerCode(env, 'HON')).toEqual({ code: '438516', ticker: 'HON' });
    hist.m.delete('pre/stock-codes.json');
    // A member watching XOM gets a featured fund's 13F whose only XOM line is the new CUSIP, still without a ticker.
    const filing = { slug: 'pz', slugs: ['pz'], accession: 'A-XOM', tickers: ['AAPL'], changed: [{ cusip: '30233Q108', ticker: null, change: 'added' }] };
    const f = { investors: [], stocks: ['XOM'], owned: [] };
    expect(forMember({ alerts: 'followed' } as never, f as never, [filing as never], [], { pz: { featured: true } } as never).filings).toHaveLength(1);
    expect(forMember({ alerts: 'followed' } as never, { ...f, stocks: ['CVX'] } as never, [filing as never], [], { pz: { featured: true } } as never).filings).toHaveLength(0);
    // Stored pairs net only through a link with a units result: an unlinked COM -> COM NEW pair under one ticker (a reverse
    // split) stays an exit plus a new line; RBKB's link (1.3978) scales the prior, so 1,000 old shares held as 1,398 is no trade.
    const pair = (o: string, n: string, t: string, prev: number, sh: number) => [{ change: 'exited', cusip: o, ticker: t, put_call: null, shares: 0, prev_shares: prev, value: 0, value_delta: -prev * 10 }, { change: 'new', cusip: n, ticker: t, put_call: null, shares: sh, prev_shares: 0, value: sh * 10, value_delta: sh * 10 }];
    expect(netRenamed({ moves: {} as never, changed: pair('68232V801', '68232V900', 'ONCY', 30000, 1000) as never }).changed.map((x) => x.change)).toEqual(['exited', 'new']);
    expect(netRenamed({ moves: {} as never, changed: pair('75689M101', '75689M200', 'RBKB', 1000, 1398) as never }).changed).toEqual([]);
    expect(netRenamed({ moves: {} as never, changed: pair('75689M101', '75689M200', 'RBKB', 1000, 1500) as never }).changed.map((x) => [x.change, x.prev_shares, x.split])).toEqual([['added', 1398, 1.3978]]);

    // FMR's Nov 10 feed item, as stored (0000315066-26-002964): CRWD sent before its 4-for-1 split was on file (+$8.55B;
    // the build has +$2.32B), XOM and GTES as exits plus new lines. Once splits.json and the GTES link are on file, the
    // feed reads like the build: CRWD +8,753,191 sh x $264.75, XOM and GTES one move each. The email stays as sent.
    const { restateFeeds, etDay } = await import('../src/alerts');
    const tR = t1 + 20_000_000;
    vi.useFakeTimers({ toFake: ['Date'], now: tR });
    const mv = (change: string, ticker: string | null, cusip: string, shares: number, prev_shares: number, value: number, value_delta: number) => ({ change, ticker, display_name: null, issuer: ticker ?? cusip, cusip, put_call: null, shares, prev_shares, value, value_delta, delta_pct_of_book: null });
    const fmr = {
      slug: 'fmr-llc', slugs: ['fmr-llc'], manager: 'FMR LLC', name: 'FMR LLC', quarter: '2026Q3', report_date: '2026-09-30', filing_date: etDay(tR), accession: '0000315066-26-002964', sec_url: 'https://www.sec.gov/Archives/edgar/data/315066/000031506626002964/0000315066-26-002964-index.html', tickers: [], followup: true,
      moves: {
        bought_usd: 1, sold_usd: 1,
        new: [mv('new', 'XOM', '30233Q108', 145933748, 0, 23750717533, 23750717533), mv('new', 'GTES', 'G39104107', 19537900, 0, 511892996, 511892996)],
        added: [mv('added', 'CRWD', '22788C105', 40141659, 7847117, 10627504388, 8549980129)],
        trimmed: [],
        exited: [mv('exited', 'XOM', '30231G102', 0, 137736841, 0, -18831380835), mv('exited', null, 'G39108108', 0, 19596691, 0, -548119448)],
      },
      corrected: { at: '2026-11-11T04:36:00Z', rows: [{ cusip: '22788C105', ticker: 'CRWD', name: 'CrowdStrike', put_call: null, emailed: { change: 'added', value_delta: 8549980129 }, v1: { change: 'added', value_delta: 2317407354 } }] },
    };
    // Mizuho Markets' Q3 (0001062993-26-005826): gene's feed item froze a render netting the Q2 "CALL" line (479,831) with
    // the Q3 "Call" line (19,152 at $552.5M) into "SPY calls -$13.3B (sold 96% of the position, 194.7% of book)". The day
    // store keeps the lines apart, with the correction: the feed item is rendered from those.
    const opt = (change: string, put_call: string, shares: number, prev_shares: number, value: number, value_delta: number, pct: number) => ({ ...mv(change, 'SPY', '78462F103', shares, prev_shares, value, value_delta), put_call, delta_pct_of_book: pct });
    const miz = {
      slug: 'mizuho-markets-americas-llc', slugs: ['mizuho-markets-americas-llc'], manager: 'Mizuho Markets Americas LLC', name: 'MIZUHO MARKETS AMERICAS LLC', quarter: '2026Q3', report_date: '2026-09-30', filing_date: etDay(tR), accession: '0001062993-26-005826', sec_url: 'https://www.sec.gov/x', tickers: [],
      moves: { bought_usd: 1086185072, sold_usd: 673643034, new: [opt('new', 'Call', 19152, 0, 552460839, 552460839, 0.081), opt('new', 'Put', 44518, 0, 57215045, 57215045, 0.008)], added: [{ ...mv('added', 'MRVL', '573874104', 5_000_000, 1_130_000, 615_000_000, 476_109_188), delta_pct_of_book: 0.07 }], trimmed: [], exited: [opt('exited', 'CALL', 0, 479831, 0, -610478402, -0.089), opt('exited', 'PUT', 0, 479831, 0, -63164632, -0.0092)] },
      corrected: { at: '2026-11-11T04:36:00Z', rows: [{ cusip: '78462F103', ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', put_call: 'CALL', emailed: { change: 'exited', value_delta: -610478402 }, v1: { change: 'trimmed', value_delta: -58017563 } }] },
    };
    await env.DB.put(`digest:${etDay(tR)}`, JSON.stringify({ filings: [fmr, miz], events: [] }));
    await putMember('cus_fd', 'fd@example.com', 'active', []);
    await env.DB.put('feed:cus_fd', JSON.stringify([{ id: '0000315066-26-002964:moves', title: 'as sent', text: 'as sent', url: 'x', published: '2026-11-10T21:00:00Z' }, { id: '0001062993-26-005826', title: 'Corrected · Mizuho Markets Americas Q3: NEW WYNN · EXIT COR · SPY calls -$13.3B', text: '  Trimmed: SPY calls -$13.3B (sold 96% of the position, 194.7% of book)', url: 'x', published: '2026-11-09T20:26:17.000Z' }]));
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) =>
      String(u).endsWith('cusip_links.json') ? Response.json({ links: { G39108108: { new: 'G39104107', ticker: 'GTES', basis: 'sec_13f_list', ratio: 1, units_basis: 'holders_1to1' } }, held: [] })
      : String(u).endsWith('splits.json') ? Response.json({ splits: [{ cusip: '22788C105', ticker: 'CRWD', to_quarter: '2026Q3', ratio: 4 }] })
      : real1(u, init));
    expect(await restateFeeds(env, tR)).toEqual({ feeds: 1, alerts: ['0000315066-26-002964:moves', '0001062993-26-005826'] });
    vi.stubGlobal('fetch', real1);
    vi.useRealTimers();
    const item = (JSON.parse((await env.DB.get('feed:cus_fd'))!) as { text: string }[])[0].text;
    const [body, note] = item.split(/\n\s*Corrected /);
    expect([body.match(/CRWD \+\$[\d.]+[MB]/)?.[0], body.match(/XOM \+\$[\d.]+[MB]/)?.[0], /GTES/.test(body), /EXIT|G39108108|\$8\.5B|\$23\.8B/.test(body)]).toEqual(['CRWD +$2.3B', 'XOM +$1.3B', true, false]);
    expect(note).toMatch(/CRWD was added/);
    const mi = (JSON.parse((await env.DB.get('feed:cus_fd'))!) as { title: string; text: string }[])[1];
    expect([/13\.3B|194\.7%|96% of the position/.test(mi.title + mi.text), /Corrected 2026-11-11: SPY calls not counted \(share counts don't reconcile\)\.$/.test(mi.text)]).toEqual([false, true]);
    // The stored new "Call"/"Put" and exited "CALL"/"PUT" lines are one position each, trimmed by the filed values'
    // change and marked (not a NEW plus an EXIT); the title leads with the largest real move.
    const [miBody] = mi.text.split(/\n\s*Corrected /);
    expect([/^Corrected · Mizuho Markets Americas Q3: MRVL \+\$476\.1M/.test(mi.title), /NEW SPY|EXIT SPY/.test(mi.title), /New:[^\n]*SPY|Exited:[^\n]*SPY/.test(miBody), (/SPY calls [\d.KM]+ → [\d.KM]+ sh as filed \(share counts don't reconcile\)/.test(miBody.match(/Not counted: .*$/m)?.[0] ?? '') && !/610\.5M|552\.5M/.test(miBody) && !/Trimmed:[^\n]*SPY/.test(miBody)), /SPY calls -\$58\.0M|SPY puts -\$5\.9M/.test(miBody)]).toEqual([true, false, false, true, false]);
    // Netted fresh from the filings (Q3 "Call" against Q2 "CALL", case-blind), the trade is the filed values' change,
    // marked: never 19,152 - 479,831 sh x $28,846 = -$13.3B, 194.7% of a $6.8B book.
    const pos = (put_call: string, shares: number, value: number) => ({ cusip: '78462F103', issuer: 'SPDR S&P 500 ETF T', ticker: 'SPY', display_name: null, put_call, shares, value, title: 'SPY' });
    const filler = { cusip: '000000000', issuer: 'BOOK', ticker: 'BK', display_name: null, put_call: null, shares: 1, value: 6_270_000_000, title: 'BK' };
    const cm = computeMoves([pos('Call', 19152, 552460839), filler] as never, [pos('CALL', 479831, 610478402), filler] as never);
    const spy = cm.changed.find((r) => r.cusip === '78462F103')!;
    expect([spy.change, spy.value_delta, spy.unreliable, Math.abs(spy.delta_pct_of_book!) < 0.01]).toEqual(['trimmed', -58017563, 'shares', true]);
    // Nothing more to restate: the feed is left alone.
    expect((await restateFeeds(env, tR)).feeds).toBe(0);
    // Ingest's options rule: Mizuho's non-standard option lines are "both" in its book. Ingest's side wins: the feed holds
    // them (no figure, out of the moves and the title) and the correction note says so; MRVL stays.
    await hist.put('h/mizuho-markets-americas-llc/2026Q3.json', JSON.stringify({ accession: '0001062993-26-005826', holdings: [
      { cusip: '78462F103', put_call: 'CALL', change: 'trimmed', shares: 19152, value: 552460839, value_delta: null, unreliable: 'both' },
      { cusip: '78462F103', put_call: 'PUT', change: 'trimmed', shares: 44518, value: 57215045, value_delta: null, unreliable: 'both' },
      { cusip: '573874104', put_call: null, change: 'added', shares: 5_000_000, value: 615_000_000, value_delta: 476_109_188, value_delta_basis: 'trade' },
    ] }));
    expect((await restateFeeds(env, tR)).feeds).toBe(1);
    const mh = (JSON.parse((await env.DB.get('feed:cus_fd'))!) as { title: string; text: string }[])[1];
    const [mhBody, mhNote] = mh.text.split(/\n\s*Corrected /);
    expect([/SPY/.test(mh.title), /SPY calls -\$|SPY puts -\$/.test(mhBody), /Not counted: SPY calls, SPY puts \(share counts don't reconcile\)\./.test(mhBody), /MRVL \+\$476\.1M/.test(mhBody), /58\.0M/.test(mhNote), /^2026-11-11: SPY calls not counted \(share counts don't reconcile\)\.$/.test(mhNote)]).toEqual([false, false, true, true, false, true]);
    expect((await restateFeeds(env, tR)).feeds).toBe(0);
  });

  it('a marked line past the lists\' top rows is named: "Not counted: SPY calls (share counts don\'t reconcile)."', async () => {
    const { alertMail } = await import('../src/email');
    const { movesOf } = await import('../src/edgar');
    const t = (tk: string, v: number, extra = {}) => ({ change: 'trimmed', ticker: tk, display_name: null, issuer: tk, cusip: tk.padEnd(9, '0'), put_call: null, shares: 1, prev_shares: 2, value: 1, value_delta: v, delta_pct_of_book: null, ...extra });
    const mv = movesOf([t('AA', -9e7), t('BB', -8e7), t('CC', -7e7), t('DD', -6.5e7), t('EE', -6.2e7), t('EF', -6.1e7), t('SPY', -5.8e7, { put_call: 'Call', unreliable: 'shares' })] as never, 5);
    const m = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'w', slugs: ['w'], manager: 'W', name: 'W', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0000000000-26-000008', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-06T21:00:00Z', moves: mv, tickers: [] }], [], { investors: ['w'], stocks: [], owned: [] } as never);
    expect([mv.trimmed.some((r) => r.ticker === 'SPY'), /Not counted: SPY calls [\d.KM]+ → [\d.KM]+ sh as filed \(share counts don't reconcile\)\./.test(m.text) && !/58\.0M/.test(m.text), mv.sold_usd]).toEqual([false, true, 4.28e8]);
  });

  it("display names: the site's shared overrides name the firm in alert subjects, headers, the Friday email and possessives", async () => {
    const real = (await import('../../web/src/lib/display-names.json')).default as Record<string, string>;
    names.map = real;
    try {
      const { weeklyMail } = await import('../src/free');
      const base = { quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-12', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-12T21:00:00Z', tickers: [], moves: null } as const;
      const kahn = { ...base, slug: 'irving-kahn', slugs: ['irving-kahn'], manager: 'Irving Kahn', name: 'KAHN BROTHERS GROUP INC', accession: '0001039565-26-000001' };
      const brk = { ...base, slug: 'warren-buffett', slugs: ['warren-buffett'], manager: 'Warren Buffett', name: 'BERKSHIRE HATHAWAY INC', accession: '0000950123-26-000002' };
      const m = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [kahn, brk] as never, [], { investors: ['irving-kahn', 'warren-buffett'], stocks: [], owned: [] } as never);
      const one = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [kahn] as never, [], { investors: ['irving-kahn'], stocks: [], owned: [] } as never);
      expect([one.subject === 'Kahn Brothers filed its Q3 13F', /Irving Kahn/.test(m.subject + m.text), m.text.includes('Berkshire Hathaway (Warren Buffett): Q3 2026 13F'), /BERKSHIRE HATHAWAY INC/.test(m.text)]).toEqual([true, false, true, false]);
      const mv = (slug: string, manager: string) => ({ manager, slug, ticker: 'AAPL', what: 'sold', usd: -1e9, form: '13F', url: 'https://x' });
      const w = weeklyMail({ ...env, SITE_URL: 'https://site.test/' } as Env, 'r@r.test', { buys: [], sells: [mv('ray-dalio', 'Ray Dalio') as never] }, 'November 13', 'https://u.test');
      expect([w.text.includes('Bridgewater (Ray Dalio): sold AAPL'), w.subject.includes('Bridgewater (Ray Dalio) sold AAPL')]).toEqual([true, true]);
      // A founder still running the firm keeps the name: no override, EDGAR's name as before.
      expect(alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ ...base, slug: 'bill-ackman', slugs: ['bill-ackman'], manager: 'Bill Ackman', name: 'Pershing Square Capital Management, L.P.', accession: '0001336528-26-000003' } as never], [], { investors: ['bill-ackman'], stocks: [], owned: [] } as never).subject).toBe('Ackman filed its Q3 13F');
    } finally {
      names.map = {};
    }
  });

  it('a row with only pct_of_book (the position weight) prints no % of book', async () => {
    const { alertMail } = await import('../src/email');
    const r = { change: 'added', ticker: 'AAPL', display_name: null, issuer: 'AAPL', cusip: '037833100', put_call: null, shares: 20, prev_shares: 10, value: 4000, value_delta: 2000, delta_pct_of_book: null, pct_of_book: 0.42 };
    const m = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'w', slugs: ['w'], manager: 'W', name: 'W', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0000000000-26-000009', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-06T21:00:00Z', moves: { bought_usd: 2000, sold_usd: 0, new: [], added: [r as never], trimmed: [], exited: [] }, tickers: ['AAPL'] }], [], { investors: ['w'], stocks: [], owned: [] } as never);
    expect([/42\.0%/.test(m.text), /AAPL \+\$2K? ?\(\+100% shares\)|AAPL \+\$2\.0K \(\+100% shares\)/.test(m.text)]).toEqual([false, true]);
  });

  it('launch week: test, critic and preview mail goes to the test-inbox sink, never to Resend', async () => {
    const { sendMail, sinkKey } = await import('../src/email');
    env.TEST_MAIL_SINK = undefined;
    sent = [];
    await sendMail(env, [{ to: 'copybook-test-x@fldubai.com', subject: 'Your Copybook sign-in link', text: 'link' }, { to: 'real@example.com', subject: 'Real', text: 'r' }]);
    expect(await sendMail(env, [{ to: 'someone@example.com', subject: 'Preview', text: 'p' }], { preview: true })).toBe('sunk');
    expect(sent.map((m) => m.to[0])).toEqual(['real@example.com']);
    const box = JSON.parse((await env.DB.get(await sinkKey(env, 'copybook-test-x@fldubai.com')))!);
    expect(box.items.map((i: { subject: string }) => i.subject)).toEqual(['Your Copybook sign-in link']);
    // The operator gets each test address's inbox URL; real addresses are refused.
    const r = await (await handleRequest(new Request('https://api.test/ops/test-inbox', { method: 'POST', body: JSON.stringify({ emails: ['copybook-test-x@fldubai.com', 'real@example.com'] }), headers: { authorization: 'Bearer health_test_token' } }), env)).json();
    expect(r.inboxes).toEqual([{ email: 'copybook-test-x@fldubai.com', url: expect.stringMatching(new RegExp(`${await sinkKey(env, 'copybook-test-x@fldubai.com')}$`)) }]);
    // A critic's aliases share the critic's own inbox (the trader's fresh signups land where it already reads).
    expect(await sinkKey(env, 'Copybook-Test-Trader-Signup7@fldubai.com')).toBe(await sinkKey(env, 'copybook-test-trader-f94afc@fldubai.com'));
    expect(await sinkKey(env, 'copybook-test-pmprov-1@fldubai.com')).not.toBe(await sinkKey(env, 'copybook-test-pm-f5f4b5@fldubai.com'));
    // A test team's seat invite goes to the sink under the seat's own address, even a real-looking one.
    const { inviteSeat } = await import('../src/seats');
    const owner = { customer: 'cus_tt', email: 'copybook-test-owner@fldubai.com', status: 'active', plan: 'fund', interval: 'month', period_end: 0, subscription: 'sub_tt', alerts: [] } as never;
    expect((await inviteSeat(env, owner, 'Analyst@RealFund.example')).ok).toBe(true);
    expect(sent.map((m) => m.to[0])).toEqual(['real@example.com']);
    expect(JSON.parse((await env.DB.get(await sinkKey(env, 'analyst@realfund.example')))!).items[0].subject).toBe('You have a Copy Fund seat on Copybook');
    // Every mail ends in one counted state. At Resend's cap: account and alert mail are queued (each once, even when
    // the retry is refused again), test mail sinked; the kinds add up to Resend's count.
    const { mailQuota, retryMail } = await import('../src/email');
    const k0 = { ...mailQuota.kinds! };
    resendUsed = 100;
    await sendMail(env, [{ to: 'member@example.com', subject: 'Your Copybook sign-in link', text: 'l' }]);
    await sendMail(env, [{ to: 'member@example.com', subject: 'Alert', text: 'a' }], { bulk: true, tier: 'alert' });
    await sendMail(env, [{ to: 'copybook-test-y@fldubai.com', subject: 'T', text: 't' }]);
    await retryMail(env);
    const k1 = mailQuota.kinds!;
    expect([k1.queued! - (k0.queued ?? 0), k1.sinked! - (k0.sinked ?? 0), k1.account - k0.account, k1.real - k0.real]).toEqual([2, 1, 0, 0]);
    resendUsed = 0;
    expect((await retryMail(env)).mail_retry).toMatchObject({ n: 1 });
    expect(mailQuota.kinds!.account - k0.account).toBe(1);
    const health = (await (await privateHealth()).json()).mail_quota;
    const kv = health.kinds;
    expect(kv.before_since + kv.real + kv.test + kv.account + kv.other).toBe(health.used);
    expect(health.by_kind).toEqual(kv);
    // Outcomes (never reached Resend) are nested, apart from the parts that sum to used.
    expect(Object.keys(kv.outcomes)).toEqual(['queued', 'sinked', 'dropped_not_sent', 'dropped_why']);
    // With today's status.json readable, /health shows its both-hosts view (one since, one set of labels, its time),
    // and this host's own tally under this_host: the analyst saw account 4 / other 0 there against 1 / 3 here.
    const both = { day: health.day, resend_used: health.used + 3, by_kind: { ...kv, account: kv.account + 3 }, waiting_now: { retry: 0, delayed: 7 } };
    const real0 = globalThis.fetch;
    env.PUBLIC_URL = 'https://pub.test/';
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => (String(u).startsWith('https://pub.test/status.json') ? Response.json({ generated_at: '2026-11-11T11:40:00Z', mail_quota: both }) : real0(u, init)));
    const h2 = (await (await privateHealth()).json()).mail_quota;
    vi.stubGlobal('fetch', real0);
    env.PUBLIC_URL = undefined;
    expect([h2.scope, h2.as_of, h2.used, h2.kinds, h2.by_kind, h2.waiting_now]).toEqual(['both hosts', '2026-11-11T11:40:00Z', both.resend_used, both.by_kind, both.by_kind, both.waiting_now]);
    expect([h2.this_host.scope, h2.this_host.used, h2.this_host.kinds]).toEqual(['this host', health.used, kv]);
    env.TEST_MAIL_SINK = 'off';
  });

  it('latency rows from before the moves tag are re-timed once from the day stores', async () => {
    const day = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
    const at = (s: number) => new Date(Date.parse(`${day}T15:00:00Z`) + s * 1000).toISOString();
    const row = (accession: string, seconds: number, extra = {}) => ({ slug: accession, kind: '13f', accession, accepted: at(0), sent: at(seconds), seconds, ...extra });
    // ONTIME: its first email carried the moves. LATE: the first went without, moves 2 h later. NEVER: no moves sent.
    // BACK: the backlog, already logged again with its moves after the fix (the old row is a duplicate).
    await env.DB.put('alerts:latency', JSON.stringify([row('BACK', 30000, { moves: true }), row('ONTIME', 75), row('LATE', 70), row('NEVER', 60), row('BACK', 65), { ...row('G1', 50), kind: '13g' }]));
    const f = (accession: string, sent: number, extra = {}) => ({ accession, sent_at: at(sent), moves: null, ...extra });
    await env.DB.put(`digest:${day}`, JSON.stringify({ filings: [f('ONTIME', 75, { moves: { new: [] } }), f('LATE', 70), f('LATE', 7200, { followup: true, moves: { new: [] } }), f('NEVER', 60), f('BACK', 65), f('BACK', 30000, { followup: true, moves: { new: [] } })], events: [] }));
    const { retimeLatency } = await import('../src/alerts');
    expect(await retimeLatency(env)).toEqual({ latency_retimed: { kept: 1, retimed: 1, never_moves: 1, dropped_duplicates: 1, tagged_followup: 1 } });
    const by = Object.fromEntries(JSON.parse((await env.DB.get('alerts:latency'))!).map((l: { accession: string }) => [l.accession, l]));
    expect([by.ONTIME.moves, by.ONTIME.seconds, by.LATE.seconds, by.LATE.followup, by.NEVER.never_moves, by.BACK.followup, by.G1.kind]).toEqual([true, 75, 7200, true, true, true, '13g']);
    expect(await retimeLatency(env)).toEqual({}); // once
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

  it('free signup: no card, a weekly of the top moves with card links and one unsubscribe, never alerts; source carried to the trial; trial emails and funnel counts', async () => {
    const signup = (b: Record<string, unknown>, ip = '1.1.1.1') => handleRequest(new Request('https://api.test/signup', { method: 'POST', body: JSON.stringify(b), headers: { origin: 'https://refcell.github.io', 'cf-connecting-ip': ip } }), env);
    expect((await signup({ email: 'nope' })).status).toBe(400);
    expect(await (await signup({ email: 'bot@reader.test', website: 'http://spam' })).json()).toEqual({ ok: true });
    expect(await env.DB.get('email:bot@reader.test')).toBeNull();
    const r = await signup({ email: 'Reader@Reader.test', source: 'home', utm_campaign: 'q3', utm_source: 'x', utm_content: 'kahn-watch' });
    expect(r.status).toBe(201);
    // Signed in on this device at once (a provisional session), whatever the email does.
    const rb = await r.clone().json();
    expect([rb.welcome, rb.sign_in_email, rb.session]).toEqual(['sent', 'sent', 'provisional']);
    expect((await call('/me', { token: rb.token })).status).toBe(200);
    // It reads /me and follows only: everything that could hold on to the account waits for the emailed link.
    for (const [method, path, body] of [['POST', '/handoff'], ['POST', '/me/sessions/revoke'], ['POST', '/keys', { name: 'x' }], ['PUT', '/channels', { email: false }], ['POST', '/portal'], ['GET', '/seats'], ['GET', '/keys']] as [string, string, unknown?][]) {
      const res = await call(path, { method, body, token: rb.token });
      expect([path, res.status, (await res.json()).code]).toEqual([path, 403, 'verify_email']);
    }
    // An address that already has an account (paid, or cancelled) gets no session from the signup form.
    for (const [c, status] of [['cus_pd', 'active'], ['cus_cx', 'canceled']]) {
      await putMember(c, `copybook-test-${c}@reader.test`, status, []);
      await env.DB.put(`email:copybook-test-${c}@reader.test`, c);
      const b = await (await signup({ email: `copybook-test-${c}@reader.test` }, `5.5.5.${c.length}${status.length}`)).json();
      expect([c, b.ok, b.token, b.session]).toEqual([c, true, undefined, undefined]);
    }
    // A paying member's address: the same neutral answer, and one Copy sign-in link (none again within 15 minutes).
    const paidMails = () => sent.filter((m) => m.to[0] === 'copybook-test-cus_pd@reader.test' && m.subject === 'Your Copybook sign-in link').length;
    const pd2 = await (await signup({ email: 'copybook-test-cus_pd@reader.test' }, '5.5.6.1')).json();
    await signup({ email: 'copybook-test-cus_pd@reader.test' }, '5.5.6.2');
    expect([pd2.sign_in_email, pd2.token, paidMails()]).toEqual(['sent_if_member', undefined, 1]);
    sent = sent.filter((m) => !m.to[0].startsWith('copybook-test-cus_'));
    for (const c of ['cus_pd', 'cus_cx']) for (const k of [`cus:${await env.DB.get(`email:copybook-test-${c}@reader.test`)}`, `cus:${c}`, `email:copybook-test-${c}@reader.test`]) await env.DB.delete(k);
    // Resend refusing (its daily quota): the page is told it's queued for after the 00:00 UTC reset, and is still signed in.
    const em0 = await import('../src/email');
    const used0 = em0.mailQuota.used;
    resendUsed = 100;
    const q = await (await signup({ email: 'copybook-test-later@reader.test' }, '9.9.9.9')).json();
    expect([q.welcome, q.send_at?.slice(11), (await call('/me', { token: q.token })).status]).toEqual(['queued', '00:00:00Z', 200]);
    expect((await call('/follows/investors/bill-ackman', { method: 'POST', token: q.token })).status).toBe(200);
    resendUsed = 0;
    em0.mailQuota.used = used0;
    for (const k of [`cus:${await env.DB.get('email:copybook-test-later@reader.test')}`, 'email:copybook-test-later@reader.test', 'host:mail-retry']) await env.DB.delete(k);
    expect(sent.map((m) => [m.to[0], m.subject])).toEqual([['reader@reader.test', "You're on the Copybook weekly"]]);
    const s = await (await call('/session', { body: { login: loginTokenFrom(sent[0].text) } })).json();
    expect(s.member).toMatchObject({ plan: 'free', active: false });
    // Signing in by the emailed link proves the address: the signup's provisional session ends.
    expect((await call('/me', { token: rb.token })).status).toBe(401);
    expect((await call('/history/warren-buffett', { token: s.token })).status).toBe(402);
    // 5 an hour per address, signed out: a repeat sends the sign-in link again (at most one an hour), the 6th is refused.
    // A filer page's one-field signup from the same address adds the follow (a free member's Friday email leads with it).
    // A quick resubmit (the trader's address B, 63 s after its welcome) sends no second email: already_sent, with when.
    const n0 = sent.length;
    const quick = await (await signup({ email: 'reader@reader.test' }, '2.2.2.1')).json();
    expect([quick.sign_in_email, typeof quick.sent_at, sent.length, quick.token]).toEqual(['already_sent', 'string', n0, undefined]);
    await env.DB.delete(`rl:signin-mail:${await env.DB.get('email:reader@reader.test')}`); // an hour later
    expect(await (await signup({ email: 'reader@reader.test', follow: [{ kind: 'investor', id: 'bill-ackman' }, { kind: 'stock', id: 'hhh' }], source: 'follow:/investors/bill-ackman/' }, '2.2.2.2')).json()).toMatchObject({ ok: true, following: true, follow: 'added', sign_in_email: 'sent' });
    // Signed out, a follow's sign-in link says the follow was saved; at most one an hour.
    expect(sent.map((m) => m.subject).at(-1)).toBe('Follow saved. Your Copybook sign-in link');
    for (const ip of ['3.3.3.3', '3.3.3.4']) expect((await signup({ email: 'reader@reader.test' }, ip)).status).toBe(200);
    expect(sent.filter((m) => /sign-in link/.test(m.subject))).toHaveLength(1);
    // Refused tries never extend the window (retail was locked out for good by retrying): 20 minutes on, the wait
    // is 20 minutes shorter, and Retry-After says so. Another address from the same IP still gets in.
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const first = await signup({ email: 'reader@reader.test' }, '4.4.4.4');
    const fb = await first.json();
    expect([first.status, fb.code, fb.already_member, fb.retry_after_seconds === Number(first.headers.get('retry-after')), Math.abs(Date.parse(fb.retry_at) - t0 - fb.retry_after_seconds * 1000) < 1000]).toEqual([429, 'rate_limited', true, true, true]);
    expect(first.headers.get('access-control-expose-headers')).toContain('retry-after');
    vi.setSystemTime(t0 + 20 * 60_000);
    const again = await signup({ email: 'reader@reader.test' }, '4.4.4.4');
    expect(Number(again.headers.get('retry-after'))).toBeLessThanOrEqual(Number(first.headers.get('retry-after')) - 20 * 60);
    expect((await signup({ email: 'copybook-test-other@reader.test' }, '4.4.4.4')).status).toBe(201);
    await env.DB.delete('email:copybook-test-other@reader.test');
    vi.setSystemTime(t0 + 61 * 60_000);
    expect((await signup({ email: 'reader@reader.test' }, '4.4.4.4')).status).toBe(200);
    vi.useRealTimers();
    await putMember('paid', 'paid@reader.test', 'active', 'all'); // paying members never get the weekly
    // Up to 5 owned names on a free account; the 6th is refused with the limit, and /me shows them.
    for (const t of ['GOOGL', 'HHH', 'NVDA', 'AAPL', 'MSFT']) expect((await call(`/follows/owned/${t}`, { method: 'POST', token: s.token })).status).toBe(200);
    const sixth = await call('/follows/owned/TSLA', { method: 'POST', token: s.token });
    expect([sixth.status, (await sixth.json()).limit]).toEqual([402, 5]);
    expect((await call('/follows/owned/AAPL', { method: 'POST', token: s.token })).status).toBe(200); // already saved: fine
    await call('/follows/owned/MSFT', { method: 'DELETE', token: s.token });
    expect((await (await call('/follows', { token: s.token })).json()).follows.stocks).toEqual(['HHH', 'GOOGL', 'NVDA', 'AAPL']); // HHH first: followed from the signup form; the stock page stops saying Following
    expect((await (await call('/me', { token: s.token })).json()).member.free_names).toEqual({ names: ['GOOGL', 'HHH', 'NVDA', 'AAPL'], limit: 5, facts: [], hook: null, more: 0 });
    // Free investor follows cap at 10: one past it is never reported as added (Weitz and Hawkins were dropped silently).
    const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((x) => `fund-${x}`);
    for (const x of nine) expect((await call(`/follows/investors/${x}`, { method: 'POST', token: s.token })).status).toBe(200);
    const signedIn = (b: Record<string, unknown>, ip: string) => handleRequest(new Request('https://api.test/signup', { method: 'POST', body: JSON.stringify(b), headers: { origin: 'https://refcell.github.io', 'cf-connecting-ip': ip, authorization: `Bearer ${s.token}` } }), env);
    sent = [];
    // A repeat (Ackman) next to a new follow past the cap: cap_reached, the dropped one named; signed in, no email.
    const capped = await (await signedIn({ email: 'reader@reader.test', follow: [{ kind: 'investor', id: 'bill-ackman' }, { kind: 'investor', id: 'wally-weitz' }] }, '5.5.5.5')).json();
    expect(capped).toEqual({ ok: true, following: true, follow: 'cap_reached', limit: 10, dropped: [{ kind: 'investor', id: 'wally-weitz' }], sign_in_email: 'not_needed' });
    expect(sent).toHaveLength(0);
    expect((await (await call('/follows', { token: s.token })).json()).follows.investors).not.toContain('wally-weitz');
    // The old Follow button posts /follows/{slug}: the same as /follows/investors/{slug}, so a free member gets the cap,
    // never "Copy subscription required".
    for (const path of ['/follows/wally-weitz', '/follows/investors/wally-weitz']) {
      const eleventh = await call(path, { method: 'POST', token: s.token });
      expect([eleventh.status, await eleventh.json()]).toEqual([402, expect.objectContaining({ follow: 'cap_reached', code: 'cap_reached', limit: 10 })]);
    }
    // Free members unfollow from /account/: then the next follow fits.
    expect(await (await call('/follows/fund-a', { method: 'DELETE', token: s.token })).json()).toMatchObject({ ok: true, follow: 'removed' });
    expect(await (await signedIn({ email: 'reader@reader.test', follow: { kind: 'investor', id: 'wally-weitz' } }, '6.6.6.6')).json()).toMatchObject({ follow: 'added', sign_in_email: 'not_needed' });
    for (const x of [...nine.slice(1), 'wally-weitz']) await call(`/follows/investors/${x}`, { method: 'DELETE', token: s.token });

    // Friday evening ET (02:00 UTC Saturday, 9pm ET Friday): the week's 13F cards, curated filers' Form 4s and 13D/Gs, and company insiders.
    sent = [];
    const sat = Date.UTC(2026, 10, 14, 2, 0);
    const inWeek = (daysAgo: number) => new Date(sat - daysAgo * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    index = { managers: [{ slug: 'warren-buffett', featured: true }, { slug: 'bill-ackman', featured: true }, { slug: 'carl-icahn', featured: true }, { slug: 'icici', featured: false }, { slug: 'vanguard-group', featured: false }] };
    const row = (change: string, ticker: string, value_delta: number, extra = {}) => ({ ticker, name: ticker, cusip: 'x', change, shares: 1, prev_shares: 0, value_delta, ...extra });
    const cardList = [
      { accession: 'ICI-13F', slug: 'icici', quarter: '2026Q3', filing_date: '2026-11-12' },
      { accession: 'VGD-13F', slug: 'vanguard-group', quarter: '2026Q3', filing_date: '2026-11-12' },
      { accession: 'FSH-13F', slug: 'fisher', quarter: '2026Q3', filing_date: '2026-11-11' },
      { accession: 'GRD-13F', slug: 'guardcap', quarter: '2026Q3', filing_date: '2026-11-11' },
      { accession: '0000950123-26-011111', slug: 'warren-buffett', quarter: '2026Q3', filing_date: '2026-11-10' },
      { accession: 'OLD-13F', slug: 'bill-ackman', quarter: '2026Q2', filing_date: '2026-08-14' }, // before the week
    ];
    const cardData: Record<string, unknown> = {
      // Bigger than Buffett's moves, but a tracked fund ranks after the superinvestors, and 2 rows at most.
      'ICI-13F': { manager: 'ICICI Prudential, LLC', firm: 'ICICI Prudential Asset Management Co Ltd', featured: false, changes: { added: 4 }, moves: [row('added', 'IVV', 9.5e10, { name: 'iShares Core S&P 500 ETF' }), row('added', 'X1', 9e10), row('added', 'X2', 8e10), row('added', 'X3', 7e10), row('added', 'AAPL', 1e7)] },
      'FSH-13F': { manager: 'Fisher Asset Management, LLC', featured: false, total_value: 2.5e11, changes: { new: 1, exited: 1 }, moves: [
        // Fisher's real Q3 CUSIP change (30231G102 to 30233Q108): one exit and one new position on XOM net by shares to
        // +$75.7M added (465,409 shares at this quarter's price), not the +$894.9M the two values sum to; on CVX to nothing.
        row('new', 'XOM', 5197180970, { shares: 31933523, prev_shares: 0, weight: 5197180970 / 2.5e11 }), row('exited', 'XOM', -4302320615, { shares: 0, prev_shares: 31468114, weight: 0 }),
        row('new', 'CVX', 3e9, { shares: 30, prev_shares: 0 }), row('exited', 'CVX', -3e9, { shares: 0, prev_shares: 30 }),
      ] },
      // GuardCap's real card: BKNG's shares changed units between quarters (a -$3.3B "trim" on a $1.47B book); CME is flagged by ingest.
      // Its Q2 book in R2 has BKNG at 646,216 shares for $121.6M (~$188 a share against ~$5,120 now): a unit error, dropped.
      'GRD-13F': { manager: 'GUARDCAP ASSET MANAGEMENT Ltd', firm: 'GUARDCAP ASSET MANAGEMENT Ltd', featured: false, total_value: 1465165097, prev_quarter: '2026Q2', changes: { trimmed: 3 }, moves: [
        row('trimmed', 'BKNG', -3301994445, { cusip: '09857L108', shares: 1304, prev_shares: 646216, weight: 0.004557 }),
        row('trimmed', 'CME', -16246874, { shares: 711166, prev_shares: 773225, weight: 0.127072, suspect_units: true }),
        row('trimmed', 'ILMN', -16097356, { shares: 679878, prev_shares: 740132, weight: 0.123969 }),
      ] },
      'VGD-13F': { manager: 'Vanguard Group', firm: 'Vanguard Group Inc', featured: false, changes: { new: 1 }, moves: [row('new', 'VVV', 9e11)] },
      '0000950123-26-011111': { manager: 'Warren Buffett', featured: true, changes: { new: 1, added: 2, trimmed: 1, exited: 1 }, moves: [row('added', 'PUTX', 9e9, { put_call: 'Put' }), row('added', 'GOOGL', 8.8e9), row('new', 'DHI', 2e9), row('trimmed', 'BAC', -1.7e9), row('exited', 'STZ', -1e9)] },
      'OLD-13F': { manager: 'Bill Ackman', featured: true, changes: { new: 1 }, moves: [row('new', 'OLDX', 5e9)] },
    };
    await env.DB.put('v1:filers', JSON.stringify([{ slug: 'guardcap', cik: '0001732008' }]));
    await hist.put('fb/2026Q2/0001732008.json', JSON.stringify({ columns: ['ticker', 'cusip', 'put_call', 'shares', 'value'], rows: [['BKNG', '09857L108', null, 646216, 121636487]] }));
    // Other filers' BKNG after its 25-for-1 split (the holder index): ~$162 a share in Q3, ~$178 in Q2.
    await hist.put('hl/09857L.json', JSON.stringify({ issuer: '09857L', columns: ['cik', 'name', 'period', 'shares', 'prev_shares', 'value', 'prev_value'], rows: [
      ['1', 'Geode', '2026Q3', 21592756, 21923074, 3498026472, 3902307172], ['2', 'Deutsche Bank', '2026Q3', 11111266, 9488249, 1800025092, 1688908322], ['3', 'Sanders', '2026Q3', 7419768, 7414965, 1202002416, 1319863770],
    ] }));
    await hist.put('pre/events.json', JSON.stringify({ events: [
      { id: 'f4', slug: 'bill-ackman', manager: 'Bill Ackman', form: '4', kind: 'form4', action: 'buy', filing_date: '2026-11-12', accepted: inWeek(2), ticker: 'HHH', value_usd: 5e7 },
      { id: 'brk-siri', slug: 'warren-buffett', manager: 'Warren Buffett', form: '4', kind: 'form4', action: 'buy', filing_date: '2026-11-08', accepted: inWeek(6), ticker: 'SIRI', value_usd: 26894245 },
      { id: 'icahn', slug: 'carl-icahn', manager: 'Carl Icahn', form: 'SCHEDULE 13D/A', kind: '13d', action: 'stake_update', filing_date: '2026-11-12', accepted: inWeek(2), ticker: 'CVI', percent_of_class: 64.1, prev_percent_of_class: 70.8 },
      { id: 'stale', slug: 'warren-buffett', manager: 'Warren Buffett', form: '4', kind: 'form4', action: 'buy', filing_date: '2026-10-01', accepted: inWeek(30), ticker: 'GOOGL', value_usd: 7.7e10 },
    ] }));
    // NVIDIA's insiders, as the precompute keeps them: the CEO's sale counts; a gift and a $50K buy never do.
    const ev = (accession: string, extra: Record<string, unknown>) => ({ ticker: 'NVDA', form: '4', filer_name: 'HUANG JEN HSUN', filer_cik: '1', issuer: 'NVIDIA CORP', role: 'President and CEO, Director', action: 'sell', shares: 1, price: 1, value_usd: 18_600_000, shares_after: 1, prev_shares_after: 2, percent_of_class: null, event_date: '2026-11-06', last_transaction_date: null, ownership: [], codes: ['S'], transactions: [], totals: { sold: { shares: 1, value_usd: 18_600_000 } }, open_market: true, accepted_at: inWeek(3), accession, url: 'u', ...extra });
    await hist.put('tev/NVDA.json', JSON.stringify({ v: 3, cik: '0001045810', checked_at: sat, tickers: ['NVDA'], seen: {
      'nv-sale': ev('nv-sale', {}),
      'nv-gift': ev('nv-gift', { action: 'gift', value_usd: null, codes: ['G'], totals: { gifted: { shares: 1, value_usd: null } }, open_market: false }),
      'nv-small': ev('nv-small', { action: 'buy', value_usd: 50_000, totals: { bought: { shares: 1, value_usd: 50_000 } } }),
    } }));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u) === `${SITE}d/f/index.json`) return Response.json({ cards: cardList });
      const card = String(u).match(/\/d\/f\/([\w-]+)\.json$/)?.[1];
      if (card) return cardData[card] ? Response.json(cardData[card]) : new Response('no', { status: 404 });
      return realFetch(u, init);
    });
    await call('/follows/owned/SIRI', { method: 'POST', token: s.token }); // 5th name
    // No mailing address: the Friday email still goes, as a plain newsletter (no Copy paragraph, no /speed/ or /pricing/ link).
    const { runWeekly } = await import('../src/free');
    expect(await runWeekly(env, sat)).toMatchObject({ status: '200' });
    expect(sent.map((m) => m.to[0])).toEqual(['reader@reader.test']);
    expect(sent[0].text).not.toMatch(/Copy emails|pricing\/|speed\//);
    sent = [];
    await env.DB.delete('weekly:last');
    // A second run the same week is refused (no double sends after a partial failure); the test sends again on purpose.
    expect(await runWeekly(env, sat)).toMatchObject({ status: 'already tried' });
    await env.DB.delete('weekly:tried');
    Object.assign(env, { POSTAL_ADDRESS: '1 Example Way, Suite 2, Austin, TX 78701' });
    await cron(42, sat);
    expect(sent.map((m) => m.to[0])).toEqual(['reader@reader.test']);
    const w = sent[0];
    // Only the allowed claims: the season median with /speed/, and history as served (marketing's audit, Nov 11).
    expect(w.text).toContain(`Every Q3 13F so far, and who's due by Monday's 5:30pm ET deadline: ${SITE}season/?utm_source=weekly&utm_medium=email&utm_campaign=13f-q3-2026&utm_content=weekly-season\n\nThis email comes once a week. Copy emails each 13F from the funds you follow as it's filed. Median alert under 2 minutes after the SEC publishes the filing; every alert is timed on the speed page, slow ones included: ${SITE}speed/?utm_source=weekly&utm_medium=email&utm_campaign=13f-q3-2026&utm_content=weekly-speed. History: 8 quarters (from 2024Q3) for the managers we track closely, back to 2013Q2 by Dec 31, and CSV.\n\nBetween seasons Copy keeps going. Last winter (Dec 2025–Jan 2026): 19 Schedule 13D/G filings by the superinvestors we follow (4 new stakes, 15 amendments), and 14 open-market buys of $100K or more by directors and officers in the 100 stocks they hold most by value: ${SITE}winter-2025-26/?utm_source=weekly&utm_medium=email&utm_campaign=13f-q3-2026&utm_content=weekly-winter\n\nFounding price $79/yr, locked. Goes to $99 for new members Feb 1. 14 days free, no card needed. One free trial per person: ${SITE}pricing/?utm_source=weekly&utm_medium=email&utm_campaign=13f-q3-2026&utm_content=weekly-paid\n\nYou get this`);
    // The window it covers, by name (Sat Nov 14 02:00 UTC: Fri Nov 6 to Fri Nov 13, ET).
    expect(w.text.startsWith('Superinvestor filings, November 6–13.')).toBe(true);
    expect(w.subject).toBe('In your names: Warren Buffett added $8.8B of GOOGL');
    // "Your follows" leads: Ackman has no 13F on record this week and isn't on the expected list.
    expect(w.text).toMatch(/^Superinvestor filings, November 6–13\.\n\nYour follows:\n  Bill Ackman: not filed yet\n    https:\/\/\S+\/investors\/bill-ackman\/\?utm_source=weekly&utm_medium=email&utm_campaign=13f-q3-2026&utm_content=weekly-follows\n/);
    expect(w.text).toMatch(/Also this week from your follows:\n(  .*\n    .*\n)*  Bill Ackman: bought HHH/); // and the superinvestor moves in followed stocks (GOOGL)
    // "In your names" first: one public fact per saved name (superinvestors only), then the biggest locked item, named.
    expect(w.text).toContain(
      `In your names:\n  Warren Buffett added $8.8B of GOOGL, which you own.\n    ${SITE}f/0000950123-26-011111/?utm_source=weekly&utm_medium=email&utm_campaign=13f-q3-2026&utm_content=weekly-card\n  Bill Ackman bought $50.0M of HHH, which you own.\n    ${SITE}investors/bill-ackman/?utm_source=weekly&utm_medium=email&utm_campaign=13f-q3-2026&utm_content=weekly-follows\n  Warren Buffett bought $26.9M of SIRI, which you own.\n    ${SITE}investors/warren-buffett/?utm_source=weekly&utm_medium=email&utm_campaign=13f-q3-2026&utm_content=weekly-follows\n  Nvidia's CEO sold $18.6M of NVDA (Nov 6, filed Nov 10), with Copy (+1 more in your names): ${SITE}pricing/?utm_source=weekly&utm_medium=email`,
    );
    expect(w.text.indexOf('In your names')).toBeLessThan(w.text.indexOf('Biggest buys'));
    expect(w.html).toContain('Try Copy · 14 days free · no card needed');
    // The footer says why they get it and carries the mailing address; without the address, the Copy ask is dropped.
    expect(w.text).toContain('You get this because you signed up for the free Copybook weekly.');
    expect(w.text).toContain('\n1 Example Way, Suite 2, Austin, TX 78701');
    const { weeklyMail } = await import('../src/free');
    Object.assign(env, { POSTAL_ADDRESS: '' });
    const plain = weeklyMail(env, 'reader@reader.test', { buys: [], sells: [] }, 'November 7', 'https://u.test', { names: 1, facts: [], hook: 'X', more: 2 });
    expect([plain.text, plain.html ?? ''].some((t) => /pricing\/|with Copy|Copy emails each/.test(t))).toBe(false);
    // The season line is content: it stays in the plain newsletter. Who filed Friday is named; after the deadline the
    // link is the season's own page and the deadline goes.
    expect(plain.text).toContain("\n\nEvery Q3 13F so far, and who's due by Monday's 5:30pm ET deadline: ");
    const fri = weeklyMail(env, 'reader@reader.test', { buys: [], sells: [] }, 'November 13', 'https://u.test', undefined, [], null, ["Seth Klarman's Baupost", "Howard Marks's Oaktree"], Date.UTC(2026, 10, 14, 2));
    expect(fri.text).toContain("Filed Friday: Seth Klarman's Baupost and Howard Marks's Oaktree. Every Q3 13F so far, and who's due by Monday's 5:30pm ET deadline: ");
    const after = weeklyMail(env, 'reader@reader.test', { buys: [], sells: [] }, 'November 20', 'https://u.test', undefined, [], null, [], Date.UTC(2026, 10, 21, 2));
    expect(after.text).toMatch(/\n\nEvery Q3 13F so far: \S+\/season\/2026q3\/\?utm_source=weekly&\S+weekly-season\n/);
    // Filed Friday reads EDGAR's acceptance in New York: Klarman's Fri 4:10pm ET counts, Marks's Thursday doesn't.
    const { filedFriday } = await import('../src/free');
    await env.DB.put('wk13f:seth-klarman', JSON.stringify({ slug: 'seth-klarman', quarter: '2026Q3', filing_date: '2026-11-13', accepted: '2026-11-13T21:10:00Z' }));
    await env.DB.put('wk13f:howard-marks', JSON.stringify({ slug: 'howard-marks', quarter: '2026Q3', filing_date: '2026-11-12', accepted: '2026-11-12T21:10:00Z' }));
    expect(await filedFriday(env, Date.UTC(2026, 10, 14, 2))).toEqual(["Seth Klarman's Baupost"]);
    // No names saved: the My book line is a Copy ask too, so the plain newsletter leaves it out.
    const noNames = weeklyMail(env, 'reader@reader.test', { buys: [], sells: [] }, 'November 7', 'https://u.test', { names: 0, facts: [], hook: null, more: 0 });
    expect([noNames.text, noNames.html ?? ''].some((t) => /my-book|My book/.test(t))).toBe(false);
    // Superinvestors only (ICICI and other filers never), by dollars, 2 rows per fund at most; no ETFs or index flow;
    // nothing older than the week; no options. Every site link is tagged for the funnel.
    const buys = w.text.slice(w.text.indexOf('Biggest buys'), w.text.indexOf('Biggest sells'));
    expect([...buys.matchAll(/^ {2}(\S[^:]*):/gm)].map((m) => m[1])).toEqual(['Warren Buffett', 'Warren Buffett', 'Bill Ackman']);
    expect(buys).toContain(`Warren Buffett: added GOOGL, +$8.8B (13F Q3 2026)\n    ${SITE}f/0000950123-26-011111/?utm_source=weekly&utm_medium=email&utm_campaign=13f-q3-2026&utm_content=weekly-card`);
    // The body only: the unsubscribe token is random base64 and can contain any of these.
    const body = w.text.slice(0, w.text.indexOf('Unsubscribe:'));
    for (const no of ['X3', 'IVV', ', LLC', 'VVV', 'Vanguard', 'OLDX', 'PUTX', '$77.0B', 'gift', '$50.0K']) expect(body).not.toContain(no);
    expect(w.text.indexOf('BAC')).toBeLessThan(w.text.indexOf('STZ'));
    expect(body).not.toMatch(/sold out (XOM|CVX)|CVX/); // netted: an added XOM, and CVX unchanged
    const { weeklyMoves } = await import('../src/free');
    const wk = await weeklyMoves(env, sat);
    expect(wk.all.filter((x) => x.slug === 'fisher').map((x) => [x.what, x.ticker, x.usd])).toEqual([['added', 'XOM', 75745316]]);
    // Impossible and flagged moves never show; an all-caps filer name reads normally.
    expect(wk.all.some((x) => x.manager === 'Guardcap Asset Management' && x.ticker === 'ILMN')).toBe(true);
    expect(w.text).not.toContain('Guardcap'); // a 13F filer, not a superinvestor: not in Biggest buys/sells
    expect(body).not.toMatch(/BKNG|CME|GUARDCAP/);
    vi.stubGlobal('fetch', realFetch);
    const unsub = w.text.match(/Unsubscribe: (\S+)/)![1];
    expect((w as unknown as { headers: Record<string, string> }).headers['List-Unsubscribe']).toBe(`<${unsub}>`);
    sent = [];
    await cron(42, sat + 1000);
    expect(sent).toHaveLength(0); // once a week
    const u = unsub.replace('https://copybook-api.factordynamics.workers.dev/', 'https://api.test/');
    expect(await (await handleRequest(new Request(u), env)).text()).toContain('Unsubscribe reader@reader.test from the Copybook weekly?');
    await handleRequest(new Request(u, { method: 'POST' }), env);
    await cron(42, sat + 7 * 86400_000);
    expect(sent).toHaveLength(0);

    // The reader starts a trial: the paid member keeps the source, gets the three-step welcome; the funnel counts each step once.
    stripeObjects['checkout/sessions/cs_test_rd'] = { id: 'cs_test_rd', status: 'complete', created: now(), subscription: 'sub_rd', customer_details: { email: 'reader@reader.test' } };
    stripeObjects['subscriptions/sub_rd'] = { ...sub('sub_rd', 'cus_rd', 'trialing'), trial_end: now() + 14 * 86400 };
    await fullCheckout('cs_test_rd');
    await webhook({ type: 'customer.subscription.created', data: { object: stripeObjects['subscriptions/sub_rd'] } });
    expect(JSON.parse((await env.DB.get('cus:cus_rd'))!)).toMatchObject({ source: 'home', utm: { utm_campaign: 'q3' }, plan: 'copy' });
    // One account per email: the free browser's session opens the paid member, which kept the free names.
    expect((await (await call('/me', { token: s.token })).json()).member).toMatchObject({ email: 'reader@reader.test', plan: 'copy', active: true });
    expect((await (await call('/follows', { token: s.token })).json()).follows.owned).toEqual(['GOOGL', 'HHH', 'NVDA', 'AAPL', 'SIRI']);
    expect(await env.DB.get('email:reader@reader.test')).toBe('cus_rd');
    expect(sent.map((m) => m.subject)).toEqual(['Welcome to Copy: three steps to your first alert']);
    expect(sent[0].text).toContain(`${SITE}my-book/`);
    await webhook({ type: 'customer.subscription.updated', data: { object: sub('sub_rd', 'cus_rd', 'active') } });
    await webhook({ type: 'customer.subscription.updated', data: { object: sub('sub_rd', 'cus_rd', 'active') } });
    const f = (await (await privateHealth()).json()).business.funnel_7d;
    expect(f).toMatchObject({ signups: 1, trials: 1, trial_to_paid: 1, cancellations: 0, by_source: { signups: { home: 1 }, trials: { home: 1 } }, plan_mix: { 'trials:copy_monthly': 1, 'trial_to_paid:copy_monthly': 1 } });
    // Credited to the post that brought them (utm_source|utm_content), apart from the page's source.
    expect(f.by_utm).toMatchObject({ signups: { 'x|kahn-watch': 1 }, trials: { 'x|kahn-watch': 1 } });
    expect(f.by_source).not.toHaveProperty('utm:signups');
    // The site's page counts, by page, source and post; the ops view totals them by post.
    const track = (b: Record<string, unknown>) => handleRequest(new Request('https://api.test/track', { method: 'POST', body: JSON.stringify(b), headers: { origin: 'https://refcell.github.io', 'cf-connecting-ip': '9.9.9.9' } }), env);
    for (const b of [{ kind: 'visit', page: '/investors/irving-kahn/', utm_source: 'x', utm_content: 'kahn-watch' }, { kind: 'visit', page: '/season/', utm_source: 'x', utm_content: 'seed-season' }, { kind: 'visit', page: '/season/', utm_source: 'x', utm_content: 'seed-season' }, { kind: 'trial_click', page: '/pricing/', utm_source: null }])
      expect(await (await track(b)).json()).toEqual({ ok: true, counted: true });
    // A load test's or our own check's calls (utm_source=opscheck) are kept apart: in no page, source, post or hour count.
    for (const kind of ['visit', 'signup_view']) await track({ kind, page: '/season/', utm_source: 'opscheck', utm_content: 'load' });
    // Client class, never the User-Agent: a page's own fetch (Sec-Fetch-*) is a browser, an unfurler or a prefetch a bot.
    const tr = (headers: Record<string, string>) => handleRequest(new Request('https://api.test/track', { method: 'POST', body: JSON.stringify({ kind: 'trial_click', page: '/pricing/' }), headers: { origin: 'https://refcell.github.io', 'cf-connecting-ip': '9.9.9.8', ...headers } }), env);
    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    await tr({ 'user-agent': chrome, 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' });
    await tr({ 'user-agent': 'Twitterbot/1.0' });
    await tr({ 'user-agent': chrome, 'sec-purpose': 'prefetch', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' });
    await tr({ 'user-agent': chrome });
    const ops = await (await handleRequest(new Request('https://api.test/ops/funnel?days=1', { headers: { authorization: `Bearer ${env.HEALTH_TOKEN}` } }), env)).json();
    expect(ops.track_by_utm_page.visit).toEqual({ 'x|kahn-watch@/investors/irving-kahn/': 1, 'x|seed-season@/season/': 2 });
    expect(ops.track_by_client.trial_click).toMatchObject({ browser: 1, bot: 3, unknown: 1, 'direct|-#browser': 1, 'direct|-#bot': 3 }); // + the earlier call with no User-Agent
    expect(JSON.stringify(ops)).not.toContain('Chrome/130');
    expect(ops.track_by_utm).toEqual({ visit: { 'x|kahn-watch': 1, 'x|seed-season': 2 }, trial_click: { 'direct|-': 5 } });
    expect(Object.values(ops.track)[0]).toMatchObject({ visit: { page: { '/season/': 2 }, source: { x: 3 } } });
    // By UTC hour as well, and the form's focus and submit (the lead): read-outs split before and after a post.
    for (const kind of ['signup_focus', 'signup_submit']) expect((await (await track({ kind, page: '/season/', utm_source: 'x', utm_content: 'seed-season' })).json()).counted).toBe(true);
    const hourly = (await (await handleRequest(new Request('https://api.test/ops/funnel?days=1', { headers: { authorization: `Bearer ${env.HEALTH_TOKEN}` } }), env)).json()).track_hourly;
    const hr = new Date().toISOString();
    expect(hourly[hr.slice(0, 10)][hr.slice(11, 13)]).toMatchObject({ visit: { 'x|seed-season': 2 }, signup_focus: { 'x|seed-season': 1 }, signup_submit: { 'x|seed-season': 1 } });

    // A trial that runs out cancelled: one short note offering monthly, whose link opens a monthly Checkout.
    sent = [];
    await env.DB.put('cus:wb', JSON.stringify({ customer: 'wb', email: 'wb@reader.test', status: 'trialing', plan: 'copy', interval: 'yearly', trial_end: now() - 60, period_end: 0, subscription: 'sub_wb', alerts: [], welcomed: true, cancel_at_period_end: true }));
    await webhook({ type: 'customer.subscription.deleted', data: { object: sub('sub_wb', 'wb', 'canceled', 'year') } });
    await webhook({ type: 'customer.subscription.deleted', data: { object: sub('sub_wb', 'wb', 'canceled', 'year') } });
    expect(sent.map((m) => m.subject)).toEqual(['Your Copy trial ended. Monthly is $9']);
    let checkout = '';
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (x: string, init?: RequestInit) => {
      if (String(x).startsWith('https://api.stripe.com/v1/prices?')) return Response.json({ data: [{ id: `price_${new URL(String(x)).searchParams.get('lookup_keys[]')}` }] });
      if (String(x) === 'https://api.stripe.com/v1/checkout/sessions') return (checkout = decodeURIComponent(String(init?.body))), Response.json({ url: 'https://checkout.stripe.com/c/pay/cs_x' });
      return orig(x, init);
    });
    // The link opens the site's /resume/ page; its button POSTs the token to the API, which starts the Checkout.
    const resume = sent[0].text.match(/(\S+\/resume\/\?t=\S+)/)![1];
    expect(resume.startsWith(`${env.SITE_URL}resume/?t=`)).toBe(true);
    const go = await handleRequest(new Request(`https://api.test/resume${new URL(resume).search}`, { method: 'POST' }), env);
    expect(go.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_x');
    expect(checkout).toContain('customer=wb');
    expect(checkout).toContain('line_items[0][price]=price_copy_monthly');
  });

  it('seasonal churn defense: pause until 2 weeks before the next deadline instead of cancelling, a reminder with last season, a pre-season win-back for lapsed members, failed-payment email', async () => {
    index = { managers: [{ slug: 'warren-buffett', featured: true }] };
    stripeObjects['checkout/sessions/cs_test_pz'] = { id: 'cs_test_pz', status: 'complete', created: now(), subscription: 'sub_pz', customer_details: { email: 'pz@example.com' } };
    stripeObjects['subscriptions/sub_pz'] = sub('sub_pz', 'cus_pz', 'active');
    const { token } = (await (await fullCheckout('cs_test_pz')).json()) as { token: string };
    await call('/follows/owned/SIRI', { method: 'POST', token });
    // Email only ("Keep email"): the channel test sends a test email.
    sent = [];
    expect((await (await call('/channels/test', { method: 'POST', token })).json()).results).toEqual({ email: '200' });
    expect(sent.map((m) => [m.to[0], m.subject])).toEqual([['pz@example.com', 'Copybook test: your alerts will arrive here']]);
    // A sample (illustrative figures) only ever reaches our inbox or a test inbox, never a member's address.
    const { sendMail } = await import('../src/email');
    sent = [];
    expect(await sendMail(env, [{ to: 'pz@example.com', subject: '[Sample] Your Copy trial ends November 11', text: 'x' }])).toBe('blocked');
    await sendMail(env, [{ to: 'pz@example.com', subject: '[sample] x', text: 'x' }, { to: 'copybook-test-pro-1@fldubai.com', subject: '[Sample] x', text: 'x' }, { to: 'hello@factordynamics.com', subject: '[Preview] x', text: 'x' }]);
    expect(sent.map((m) => m.to[0])).toEqual(['copybook-test-pro-1@fldubai.com', 'hello@factordynamics.com']);
    sent = [];
    const r = pauseResumesAt(Date.now());
    const until = new Date(r.at * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    expect(until).toBe(new Date((r.at - 5 * 3600) * 1000).toISOString().slice(0, 10));
    // The offer on /me: when it would end, and the deadline it ends before.
    expect((await (await call('/me', { token })).json()).member.pause_offer).toMatchObject({ until, quarter: r.quarter, deadline: r.deadline, note: 'Monthly plans can pause once a year, for up to 3 months: until 2 weeks before the next 13F deadline.' });
    // A comped monthly member (the critics) can pause too; a yearly one can't, and /me and /pause agree.
    await env.DB.put('cus:cus_comp', JSON.stringify({ customer: 'cus_comp', email: 'comp@example.com', status: 'active', plan: 'copy', interval: 'monthly', comped: true, subscription: 'sub_comp', alerts: [] }));
    await env.DB.put('cus:cus_yr', JSON.stringify({ customer: 'cus_yr', email: 'yr@example.com', status: 'active', plan: 'copy', interval: 'yearly', subscription: 'sub_yr', alerts: [] }));
    const { pauseOffer } = await import('../src/revenue');
    expect(pauseOffer(JSON.parse((await env.DB.get('cus:cus_comp'))!))?.until).toBe(until);
    // Paused on Nov 9, 2026: back on Feb 2, 2027 (22:00 ET, 2 weeks before Tue Feb 16), on New York's calendar, not UTC's Feb 3.
    expect(pauseOffer(JSON.parse((await env.DB.get('cus:cus_comp'))!), Date.parse('2026-11-09T15:00:00Z'))).toMatchObject({ until: '2027-02-02', deadline: '2027-02-16', deadline_label: 'Tue Feb 16, 2027' });
    expect(pauseOffer(JSON.parse((await env.DB.get('cus:cus_yr'))!))).toBeNull();
    // A monthly trial can pause too: from the trial's end (Nov 23) to Feb 2; the trial keeps everything until then.
    const nov9 = Date.parse('2026-11-09T15:00:00Z');
    const trialEnd = Date.parse('2026-11-23T15:00:00Z') / 1000;
    expect(pauseOffer({ customer: 't', email: 't@x', status: 'trialing', plan: 'copy', interval: 'monthly', trial_end: trialEnd, period_end: trialEnd, subscription: 'sub_t', alerts: [] }, nov9)).toMatchObject({ starts: '2026-11-23', until: '2027-02-02', note: expect.stringMatching(/^Pause after your trial/) });
    // Stripe's subscription, paused while trialing: active and signed-in features until the trial ends, then paused.
    await env.DB.put('cus:cus_tp', JSON.stringify({ customer: 'cus_tp', email: 'tp@example.com', status: 'trialing', plan: 'copy', interval: 'monthly', subscription: 'sub_tp', alerts: [], welcomed: true }));
    const tEnd = now() + 10 * 86400;
    await webhook({ type: 'customer.subscription.updated', data: { object: { ...sub('sub_tp', 'cus_tp', 'trialing'), trial_end: tEnd, pause_collection: { behavior: 'void', resumes_at: tEnd + 70 * 86400 } } } });
    const tp = JSON.parse((await env.DB.get('cus:cus_tp'))!);
    expect([isActive(tp), isPaused(tp), isPaused(tp, (tEnd + 60) * 1000), isActive({ ...tp, status: 'active', paused_from: null })]).toEqual([true, false, true, false]);
    expect(pauseOffer(tp)).toBeNull(); // already scheduled
    // Undoing a pause scheduled after a trial: the alerts never stopped, so it says the trial continues, with the end's time.
    const { resumeConfirmMail } = await import('../src/revenue');
    const undo = resumeConfirmMail(env, { ...tp, trial_end: Date.parse('2026-11-25T00:46:00Z') / 1000, interval: 'monthly', has_payment_method: true });
    expect([undo.subject, undo.text.split('\n')[0]]).toEqual(['Pause cancelled: your Copy trial continues', 'Pause cancelled: your Copy trial continues to November 24, 7:46 pm ET, then $9 a month. Your alerts never stopped, and your follows and settings are as they were.']);
    // A cancel replaces the scheduled pause: Stripe's pause is cleared, so resuming later is a plain trial.
    stripeObjects['subscriptions/sub_tp'] = { ...sub('sub_tp', 'cus_tp', 'trialing'), trial_end: tEnd, cancel_at_period_end: true };
    await webhook({ type: 'customer.subscription.updated', data: { object: { ...sub('sub_tp', 'cus_tp', 'trialing'), trial_end: tEnd, cancel_at_period_end: true, pause_collection: { behavior: 'void', resumes_at: tEnd + 70 * 86400 } } } });
    const tc = JSON.parse((await env.DB.get('cus:cus_tp'))!);
    expect([tc.cancel_at_period_end, tc.paused_until, tc.paused_from]).toEqual([true, null, null]);
    await env.DB.delete('cus:cus_comp');
    await env.DB.delete('cus:cus_yr');
    expect(r.at * 1000).toBe(deadlineMs(r.deadline) - 14 * 86400_000);
    // Stripe applies pause_collection to the same subscription; a scheduled cancellation is lifted.
    stripeObjects['subscriptions/sub_pz'] = { ...sub('sub_pz', 'cus_pz', 'active'), cancel_at_period_end: true };
    const posted: string[] = [];
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u) === 'https://api.stripe.com/v1/subscriptions/sub_pz' && init?.method === 'POST') {
        const b = new URLSearchParams(String(init.body));
        posted.push(String(init.body));
        const paused = b.get('pause_collection[behavior]') ? { behavior: b.get('pause_collection[behavior]'), resumes_at: Number(b.get('pause_collection[resumes_at]')) } : null;
        stripeObjects['subscriptions/sub_pz'] = { ...sub('sub_pz', 'cus_pz', 'active'), pause_collection: paused, cancel_at_period_end: b.get('cancel_at_period_end') === 'false' ? false : (stripeObjects['subscriptions/sub_pz'] as { cancel_at_period_end?: boolean }).cancel_at_period_end };
        return Response.json(stripeObjects['subscriptions/sub_pz']);
      }
      return orig(u, init);
    });
    expect((await call('/pause', { body: { reason: 'nope' }, token })).status).toBe(400);
    sent = [];
    const p = await call('/pause', { body: { reason: 'seasonal', note: 'x'.repeat(400) }, token });
    expect([p.status, (await p.json()).paused_until]).toEqual([200, until]);
    // A receipt: until when, no charges, what's kept, and the one-click resume.
    expect(sent.map((m) => m.subject)).toEqual([`Paused until ${deadlineLabel(until)} · no charges until then`]);
    expect(sent[0].text).toContain(`No charges until then; billing resumes on ${deadlineLabel(until)}.`);
    expect(sent[0].text).toContain('Your follows and price ($9 a month) are kept.');
    expect(sent[0].text).toContain(`Resume anytime, one click, same subscription: ${env.SITE_URL}resume/?t=`);
    expect(posted.at(-1)).toContain(`pause_collection%5Bresumes_at%5D=${r.at}`);
    expect(posted.at(-1)).toContain('cancel_at_period_end=false');
    // The seasonal reason, with its free text kept to 300 characters.
    const why = JSON.parse((await env.DB.get('why:cus_pz'))!);
    expect([why.reason, why.via, why.note.length]).toEqual(['seasonal', 'pause', 300]);
    // Paused: the account and follows are kept, paid features and alerts stop until then.
    const me = (await (await call('/me', { token })).json()).member;
    expect([me.status, me.active, me.paused_until, me.pause_offer]).toEqual(['active', false, r.at, null]);
    expect((await call('/history/warren-buffett', { token })).status).toBe(402);
    // Their names and channels stay readable (My book shows them); changing them waits for the resume.
    expect((await (await call('/follows', { token })).json()).follows.owned).toEqual(['SIRI']);
    expect((await call('/channels', { token })).status).toBe(200);
    expect((await call('/follows/owned/DHI', { method: 'POST', token })).status).toBe(402);
    // A member whose only channel is email gets a test email.
    sent = [];
    expect((await call('/channels/test', { method: 'POST', token })).status).toBe(402); // paused: no sends
    expect((await call('/pause', { body: {}, token })).status).toBe(409);
    expect(JSON.parse((await env.DB.get('follows:cus_pz'))!).owned).toEqual(['SIRI']);

    // 3 days before it ends: one reminder, with last season's superinvestor move in their names.
    await hist.put('pre/events.json', JSON.stringify({ events: [{ id: 'brk-siri', slug: 'warren-buffett', manager: 'Warren Buffett', form: '4', kind: 'form4', action: 'buy', filing_date: '2026-11-03', accepted: '2026-11-04T02:30:04Z', ticker: 'SIRI', value_usd: 26894245 }] }));
    sent = [];
    const remindAt = r.at * 1000 - 2 * 86400_000;
    expect(await runSeasonal(env, remindAt)).toMatchObject({ reminders: 1, winbacks: 0 });
    expect(sent.map((m) => m.to[0])).toEqual(['pz@example.com']);
    expect(sent[0].subject).toMatch(/^Your Copybook alerts restart on /);
    expect(sent[0].text).toContain('Last season in your names:\n  - Warren Buffett bought $26.9M of SIRI (Form 4)');
    sent = [];
    await runSeasonal(env, remindAt + 3600_000);
    expect(sent).toHaveLength(0); // once per pause

    // An old \"start again\" link while paused: opening it changes nothing (the site's page, for mail scanners);
    // its button POSTs, which ends the pause on the same subscription; no second checkout.
    const rt = await signToken(env.SESSION_SECRET, 'resume', 'cus_pz', 3600);
    const opened = await handleRequest(new Request(`https://api.test/resume?t=${encodeURIComponent(rt)}`), env);
    expect(opened.headers.get('location')).toBe(`${env.SITE_URL}resume/?t=${encodeURIComponent(rt)}`);
    expect(posted.at(-1)).not.toBe('pause_collection=');
    const go = await handleRequest(new Request(`https://api.test/resume?t=${encodeURIComponent(rt)}`, { method: 'POST' }), env);
    expect(go.status).toBe(303);
    // Lands signed in: the redirect carries a sign-in token that /session exchanges.
    const login = new URL(go.headers.get('location')!).searchParams.get('login')!;
    expect(go.headers.get('location')!.startsWith(`${SITE}account/?resumed=1&login=`)).toBe(true);
    expect((await call('/session', { body: { login } })).status).toBe(200);
    expect(posted.at(-1)).toBe('pause_collection=');
    // Once per 12 months (the lead, Nov 11): a second pause after resuming is refused with when the next one opens.
    const again = await call('/pause', { body: {}, token });
    expect([again.status, (await again.json()).code]).toEqual([409, 'pause_used']);
    // A year on, it can pause again. Back early from /account/: same subscription, no second one.
    const rec = JSON.parse((await env.DB.get('cus:cus_pz'))!);
    await env.DB.put('cus:cus_pz', JSON.stringify({ ...rec, paused_at: rec.paused_at - 366 * 86400 }));
    expect((await call('/pause', { body: {}, token })).status).toBe(200);
    sent = [];
    const back = await call('/pause', { method: 'DELETE', token });
    expect(back.status).toBe(200);
    // A confirmation with the next charge date.
    const nextCharge = (await back.json()).next_charge;
    expect(nextCharge).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.map((m) => m.subject)).toEqual(['Your Copybook alerts are back on']);
    expect(sent[0].text).toContain(`Your next charge is on ${deadlineLabel(nextCharge)}`);
    expect((await (await call('/me', { token })).json()).member).toMatchObject({ active: true, paused_until: null });
    expect(posted.at(-1)).toBe('pause_collection=');
    // Nov 10: alerts used Resend's 100 a day, so the pause receipt was refused and lost. It's now sent again
    // by the minute cron once Resend accepts mail, and bulk mail stops 15 short of the cap to leave room for it.
    const rec2 = JSON.parse((await env.DB.get('cus:cus_pz'))!);
    await env.DB.put('cus:cus_pz', JSON.stringify({ ...rec2, paused_at: null }));
    resendUsed = 100;
    sent = [];
    expect((await call('/pause', { body: {}, token })).status).toBe(200);
    expect(sent).toHaveLength(0);
    resendUsed = 0;
    await cron(7);
    // The 80% note to hello@ is ops mail: with under 50 left it is dropped, never taking alert or account room.
    expect(sent.map((m) => m.subject)).toEqual([`Paused until ${deadlineLabel(until)} · no charges until then`]);
    expect((await import('../src/email')).mailQuota.kinds?.dropped).toBeGreaterThan(0);
    const { sendMail: send, mailQuota, retryMail } = await import('../src/email');
    resendUsed = 82;
    mailQuota.used = 82; // room for 3 more alerts (100 less the 15 kept for account mail)
    sent = [];
    expect(await send(env, [{ to: 'a@example.com', subject: 'alert', text: 'x' }, { to: 'b@example.com', subject: 'alert', text: 'x' }], { bulk: true })).toBe('200');
    // Under 50 left, a test member's alert is dropped (never queued: it can't take tomorrow's room either); the real one goes.
    const dropped0 = mailQuota.kinds?.dropped ?? 0;
    expect(await send(env, [{ to: 't@fldubai.com', subject: 'alert T', text: 'x', test: true, ids: ['acc-t'] }, { to: 'c@example.com', subject: 'alert C', text: 'x', ids: ['acc-c'] }], { bulk: true })).toBe('200');
    expect(mailQuota.kinds?.dropped).toBe(dropped0 + 1);
    // Over the alerts' share (15 kept for account mail): a real member's alert waits for the reset; sign-in mail still goes.
    expect(await send(env, [{ to: 'e@example.com', subject: 'alert E', text: 'x', ids: ['acc-e'] }], { bulk: true })).toBe('delayed');
    expect(await send(env, [{ to: 'd@example.com', subject: 'Sign in', text: 'x' }])).toBe('200');
    expect(sent.map((m) => m.to[0])).toEqual(['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']);
    // After the reset it goes out, marked as delayed.
    const q = JSON.parse((await env.DB.get('host:mail-delayed'))!);
    await env.DB.put('host:mail-delayed', JSON.stringify(q.map((m: object) => ({ ...m, day: '2000-01-01' }))));
    resendUsed = 0;
    mailQuota.used = 0;
    sent = [];
    await retryMail(env);
    expect(sent.map((m) => [m.to[0], m.subject])).toEqual([['e@example.com', '(delayed: email limit) alert E']]);
    expect(JSON.parse((await env.DB.get('host:mail-delayed-ids'))!)).toEqual(['acc-e']);
    resendUsed = 0;
    mailQuota.used = 0;
    vi.stubGlobal('fetch', orig);

    // One cancellation-reason answer from /account/, counted in the business summary.
    expect((await call('/cancel-reason', { body: { reason: 'price', note: 'too much for me' }, token })).status).toBe(200);
    expect(JSON.parse((await env.DB.get('why:cus_pz'))!)).toMatchObject({ reason: 'price', via: 'account', note: 'too much for me' });

    // Pre-season: a lapsed member gets one win-back with a resume link and last season in their names; a paying member doesn't.
    await env.DB.put('cus:cus_gone', JSON.stringify({ customer: 'cus_gone', email: 'gone@example.com', status: 'canceled', plan: 'copy', interval: 'monthly', period_end: Math.floor(r.at - 60 * 86400), subscription: 'sub_gone', alerts: [], welcomed: true }));
    await putFollows('cus_gone', { owned: ['SIRI'] });
    sent = [];
    const winAt = deadlineMs(r.deadline) - 10 * 86400_000;
    expect(await runSeasonal(env, winAt)).toMatchObject({ winbacks: 1 });
    expect(sent.map((m) => m.to[0])).toEqual(['gone@example.com']);
    expect(sent[0].subject).toMatch(/13Fs are due (Mon|Tue|Wed|Thu|Fri) [A-Z][a-z]{2} \d{1,2}, 20\d\d:/);
    expect(sent[0].text).toContain('Warren Buffett bought $26.9M of SIRI (Form 4)');
    expect(sent[0].text).toContain(`Start again: ${env.SITE_URL}resume/?t=`);
    sent = [];
    await runSeasonal(env, winAt + 86400_000);
    expect(sent).toHaveLength(0); // once per season

    // A failed payment: one email with Stripe's hosted page to update the card and pay, once per invoice.
    const inv = { id: 'in_fail', customer: 'cus_pz', lines: { data: [{ price: { lookup_key: 'copy_monthly' } }] }, amount_due: 900, hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/test_fail', next_payment_attempt: now() + 3 * 86400 };
    sent = [];
    await webhook({ type: 'invoice.payment_failed', data: { object: inv } });
    await webhook({ type: 'invoice.payment_failed', data: { object: inv } });
    expect(sent.map((m) => m.subject)).toEqual(["Your Copy payment didn't go through"]);
    expect(sent[0].text).toContain('$9.00');
    expect(sent[0].text).toContain('https://invoice.stripe.com/i/acct_x/test_fail');

    // The account's other prices (the Substack-era $5 newsletter, Creo) never make or change a member, or send email.
    sent = [];
    const legacyPrice = { id: 'monthly5usd', lookup_key: null, metadata: { substack: 'yes' }, recurring: { interval: 'month' } };
    const legacy = { id: 'sub_legacy', customer: 'cus_legacy', status: 'active', items: { data: [{ price: legacyPrice, current_period_end: now() + 30 * 86400 }] } };
    stripeObjects['customers/cus_legacy'] = { id: 'cus_legacy', email: 'reader@substack.example' };
    stripeObjects['subscriptions/sub_legacy'] = legacy;
    stripeObjects['prices/monthly5usd'] = legacyPrice;
    for (const type of ['customer.subscription.created', 'customer.subscription.updated']) expect((await webhook({ type, data: { object: legacy } })).status).toBe(200);
    await webhook({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_legacy', customer: 'cus_legacy', customer_details: { email: 'reader@substack.example' } } } });
    // An existing Copy member's legacy invoice: no Copybook dunning email either (lines carry only the price id).
    const legacyInv = { id: 'in_legacy', customer: 'cus_pz', lines: { data: [{ pricing: { price_details: { price: 'monthly5usd' } } }] }, amount_due: 500, amount_paid: 500, hosted_invoice_url: 'https://invoice.stripe.com/i/x' };
    await webhook({ type: 'invoice.payment_failed', data: { object: legacyInv } });
    await webhook({ type: 'invoice.paid', data: { object: legacyInv } });
    expect([await env.DB.get('cus:cus_legacy'), await env.DB.get('email:reader@substack.example'), sent.length]).toEqual([null, null, 0]);

    // Erasing a member (operator, by email) removes the paid record, its free-signup alias and what they kept; others stay.
    const { freeId } = await import('../src/free');
    const fid = await freeId('gone@example.com');
    await env.DB.put(`cus:${fid}`, JSON.stringify({ customer: fid, email: 'gone@example.com', status: 'free', plan: 'free', converted_to: 'cus_gone' }));
    await env.DB.put('cus:cus_gone', JSON.stringify({ customer: 'cus_gone', email: 'gone@example.com', status: 'active', plan: 'copy', subscription: 'sub_gone', alerts: [] }));
    await env.DB.put('email:gone@example.com', 'cus_gone');
    for (const k of [`follows:${fid}`, 'follows:cus_gone', 'stats:cus_gone', 'delivered:cus_gone:2026-11-09', 'why:cus_gone']) await env.DB.put(k, '{}');
    await env.DB.put('channels:cus_gone', JSON.stringify({ feed_token: 'tok_gone' }));
    await env.DB.put('feedtok:tok_gone', 'cus_gone');
    await env.DB.put('follows:cus_gone2', '{}'); // another member whose id starts the same: kept
    const op = (path: string, b: unknown) => handleRequest(new Request(`https://api.test${path}`, { method: 'POST', body: JSON.stringify(b), headers: { authorization: `Bearer ${env.HEALTH_TOKEN}` } }), env);
    // Operator output: a real member's lists as counts and their row ID, never tickers; a test inbox's in full.
    await putMember('cus_real', 'real@example.com', 'active', []);
    await putFollows('cus_real', { owned: ['AAPL', 'NVDA'], stocks: ['AAPL'] });
    const masked = await (await op('/ops/follows/cus_real', { add: { list: 'stocks', ticker: 'MSFT' } })).text();
    expect(JSON.parse(masked)).toMatchObject({ ok: true, customer: 'cus_real', follows: { owned: 2, investors: 0 } });
    expect(masked).not.toMatch(/AAPL|NVDA|MSFT|real@/);
    // Every operator read of a member is in that member's access log: who, when, route, row ID.
    await handleRequest(new Request('https://api.test/ops/follows/cus_real', { method: 'POST', body: JSON.stringify({ get: true }), headers: { authorization: `Bearer ${env.HEALTH_TOKEN}`, 'x-copybook-operator': 'T-check' } }), env);
    expect((await op('/ops/access-log', { customer: 'cus_real', route: 'POST /session (verify.mjs)', who: 'gene verify.mjs', at: '2026-11-09T07:00:00Z', note: 'plan read' })).status).toBe(200);
    const log = await (await handleRequest(new Request('https://api.test/ops/access-log?customer=cus_real', { headers: { authorization: `Bearer ${env.HEALTH_TOKEN}` } }), env)).json();
    expect(log.entries.map((e: { who: string; route: string; customer: string }) => [e.who, e.route, e.customer])).toEqual([
      ['operator token', 'POST /ops/follows/{customer}', 'cus_real'],
      ['T-check', 'POST /ops/follows/{customer}', 'cus_real'],
      ['gene verify.mjs', 'POST /session (verify.mjs)', 'cus_real'],
    ]);
    expect((await handleRequest(new Request('https://api.test/ops/access-log?customer=cus_real'), env)).status).toBe(404);
    await putMember('cus_tester', 'copybook-test-x@fldubai.com', 'active', []);
    await putFollows('cus_tester', { owned: ['AAPL'] });
    expect((await (await op('/ops/follows/cus_tester', { get: true })).json()).follows.owned).toEqual(['AAPL']);
    const { maskEmail } = await import('../src/env');
    expect([maskEmail('jane.doe@fund.example'), maskEmail('copybook-gate-1@fldubai.com')]).toEqual(['j***@fund.example', 'copybook-gate-1@fldubai.com']);
    expect((await op('/ops/erase-member', { email: 'Gone@Example.com' })).status).toBe(200);
    const left = [];
    for (const p of ['cus:', 'follows:', 'channels:', 'stats:', 'delivered:', 'why:', 'feedtok:', 'email:gone']) left.push(...(await env.DB.list({ prefix: p })).keys.map((k) => k.name).filter((n) => n.includes('gone') || n.includes(fid)));
    expect(left).toEqual(['follows:cus_gone2']);
  });

  it('alert moves: a unit mismatch between quarters is never sent (GuardCap BKNG); real trades are', () => {
    const pos = (ticker: string, cusip: string, shares: number, value: number) => ({ ticker, cusip, issuer: ticker, put_call: null, shares, value });
    // Last quarter's BKNG share count was in the wrong units: 646,216 "shares" worth $6.6M.
    const prev = [pos('BKNG', '09857L108', 646216, 6_600_000), pos('ILMN', '452327109', 740132, 100_000_000), pos('OLD', '000000001', 10, 5_000_000), pos('BIG', '000000002', 1000, 10e9)];
    const cur = [pos('BKNG', '09857L108', 1304, 6_677_000), pos('ILMN', '452327109', 679878, 92_000_000), pos('ISRG', '46120E602', 1000, 4_000_000), pos('BIG', '000000002', 1000, 10e9)];
    // A $10B book: the -$842M BKNG "trim" is under half of it, but 100x the position's value either quarter.
    const { moves } = computeMoves(cur, prev);
    expect([...moves.new, ...moves.added, ...moves.trimmed, ...moves.exited].map((r) => r.ticker).sort()).toEqual(['ILMN', 'ISRG', 'OLD']);
    expect(moves.sold_usd).toBeLessThan(20_000_000);
    expect(displayCase('GUARDCAP ASSET MANAGEMENT Ltd')).toBe('Guardcap Asset Management Ltd');
    expect(displayCase('AQR CAPITAL MANAGEMENT LLC')).toBe('AQR Capital Management LLC');
    expect(displayCase('ICICI Prudential Asset Management')).toBe('ICICI Prudential Asset Management');
  });

  it('alert moves: Scion-size option moves are sent with an unusual-size tag, never dropped; only unit errors are (GuardCap BKNG)', () => {
    const pos = (ticker: string, cusip: string, shares: number, value: number, put_call: string | null = null) => ({ ticker, cusip, issuer: ticker, put_call, shares, value });
    const stocks = (total: number) => [pos('JD', '47215P106', 1, total * 0.6), pos('BABA', '01609W102', 1, total * 0.4)];
    const spy = pos('SPY', '78462F103', 2_000_000, 886_600_000, 'Put');
    const qqq = pos('QQQ', '46090E103', 2_000_000, 738_800_000, 'Put');
    const all = (m: ReturnType<typeof computeMoves>['moves']) => [...m.new, ...m.added, ...m.trimmed, ...m.exited, ...(m.not_counted ?? [])];
    // Scion Q2 2023 (0000905148-23-000689): a $1.737B book, SPY puts $886.6M = 51.0% of it. Sent, tagged.
    const q1 = stocks(46_400_000);
    const q2 = [spy, qqq, ...stocks(111_600_000)];
    const m2 = computeMoves(q2, q1).moves;
    expect(m2.new.map((r) => [r.ticker, r.put_call, r.value_delta, !!r.unusual])).toEqual([['SPY', 'Put', 886_600_000, true], ['QQQ', 'Put', 738_800_000, false]]);
    // Scion Q3 2023 (0000905148-23-001400): the book fell to $99M; both put exits are measured against the larger, prior book.
    const m3 = computeMoves(stocks(99_000_000), q2).moves;
    expect(m3.exited.map((r) => [r.ticker, r.value_delta, !!r.unusual, Math.round(r.delta_pct_of_book! * 1000) / 10])).toEqual([['SPY', -886_600_000, true, -51], ['QQQ', -738_800_000, false, -42.5]]);
    // The same exits from the data run's alerts.json, whose delta_pct_of_book is against the $99M book only.
    const run = (r: (typeof m3.exited)[number]) => ({ ...r, delta_pct_of_book: r.value_delta / 99_000_000, unusual: undefined });
    const g = guardDataRun({ bought_usd: 50_000_000, sold_usd: 1_660_000_000, new: [], added: [], trimmed: [], exited: m3.exited.map(run) });
    expect(g.exited.map((r) => [r.ticker, !!r.unusual])).toEqual([['SPY', true], ['QQQ', false]]);
    const mail = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'michael-burry', slugs: ['michael-burry'], manager: 'Michael Burry', name: 'Scion Asset Management', quarter: '2023Q3', report_date: '2023-09-30', filing_date: '2023-11-14', accession: '0000905148-23-001400', sec_url: 'https://www.sec.gov/x', accepted: '2023-11-14T21:00:00Z', moves: m3, tickers: ['SPY', 'QQQ'] }], [], { investors: ['michael-burry'], stocks: [], owned: [] } as never);
    expect(mail.text).toMatch(/SPY puts -\$886\.6M \([^)]*51\.0% of book\) · Unusual size · check the filing, QQQ puts -\$738\.8M \([^)]*\)(?! ·)/);
    // GuardCap Q3 2026: its BKNG share counts don't reconcile (646,216 -> 1,304 sh, while the filed value went $121.6M ->
    // $6.7M). The trade at this filing's price would be -$3.3B, over 3x the change in filed value and over the whole
    // book, so it is the filed values' change (-$115.0M), marked unreliable "shares" and kept out of the totals.
    const gq2 = [pos('BKNG', '09857L108', 646216, 121_636_487), pos('ILMN', '452327109', 740132, 100_000_000), pos('REST', '000000009', 1, 1_250_000_000)];
    const gq3 = [pos('BKNG', '09857L108', 1304, 6_676_571), pos('ILMN', '452327109', 679878, 92_000_000), pos('REST', '000000009', 1, 1_366_000_000)];
    const med = new Map([['09857L108', { cur: 162, prev: 178 }]]);
    for (const m of [med, undefined]) {
      const gm = computeMoves(gq3, gq2, undefined, undefined, m);
      expect(all(gm.moves).map((r) => [r.ticker, r.value_delta, r.unreliable ?? null])).toEqual([['ILMN', expect.any(Number), null], ['BKNG', 6_676_571 - 121_636_487, 'shares']]); // marked: under not_counted
      expect(gm.moves.sold_usd).toBe(-all(gm.moves).find((r) => r.ticker === 'ILMN')!.value_delta);
    }
    // A real 6x rally that other filers agree with: sent, tagged. 100x or more: a unit error, dropped either way.
    const rq2 = [pos('RALY', '000000005', 1000, 1_000_000), pos('REST', '000000009', 1, 1e9)];
    const rq3 = [pos('RALY', '000000005', 1500, 9_000_000), pos('REST', '000000009', 1, 1e9)];
    expect(all(computeMoves(rq3, rq2, undefined, undefined, new Map([['000000005', { cur: 6000, prev: 1000 }]])).moves).map((r) => [r.ticker, !!r.unusual])).toEqual([['RALY', true]]);
    const uq3 = [pos('RALY', '000000005', 10, 9_000_000), pos('REST', '000000009', 1, 1e9)];
    expect(all(computeMoves(uq3, rq2).moves).map((r) => r.ticker)).toEqual([]);
    // A 10-for-1 split on file is no unit error: the share-count change is kept.
    const sq2 = [pos('SPLT', '000000007', 1000, 50_000_000), pos('REST', '000000009', 1, 1e9)];
    const sq3 = [pos('SPLT', '000000007', 12000, 60_000_000), pos('REST', '000000009', 1, 1e9)];
    expect(all(computeMoves(sq3, sq2).moves).map((r) => [r.ticker, !!r.unusual])).toEqual([['SPLT', true]]); // 10x off: tagged
    expect(all(computeMoves(sq3, sq2, undefined, new Set(['000000007'])).moves).map((r) => [r.ticker, !!r.unusual])).toEqual([['SPLT', false]]);
    // Jensen's Q3 APH (2-for-1), the sent alert's own row (Nov 10): 614,660 to 1,047,486 sh, $88,303,070. It read "added +$36,487,232";
    // against the split-adjusted 1,229,320 it is a trim of 181,834 sh, about -$15.3M.
    const jq2 = [pos('APH', '032095101', 614_660, 108_376_851), pos('REST', '000000009', 1, 1e9)]; // Q2 as filed: $176.32 a share, pre-split
    const jq3 = [pos('APH', '032095101', 1_047_486, 88_303_070), pos('REST', '000000009', 1, 1e9)];
    const aph = all(computeMoves(jq3, jq2, undefined, new Map([['APH', 1], ['032095101', 2]])).moves)[0];
    expect([aph.change, aph.prev_shares, aph.shares - aph.prev_shares]).toEqual(['trimmed', 1_229_320, -181_834]);
    expect(aph.value_delta).toBeCloseTo(-15_328_606, -2);
    // With its ratio (splits.json), the prior is in today's units: 1,000 x 10 = 10,000 to 12,000 is +2,000 sh (+$10M), not +11,000.
    const adj = all(computeMoves(sq3, sq2, undefined, new Map([['000000007', 10]])).moves);
    expect(adj.map((r) => [r.ticker, r.change, r.prev_shares, r.prev_shares_as_filed, r.split, r.value_delta])).toEqual([['SPLT', 'added', 10_000, 1000, 10, 10_000_000]]);
    // A prior already on the post-split basis takes no factor (Amundi's Q2 CRWD: 1,280,592 sh at about $190, Q3 6,281,887 sh
    // at $264.75): +5,001,295 sh, not a trim against 5,122,368.
    const am = all(computeMoves([pos('CRWD', '22788C105', 6_281_887, 1_663_129_587), jq3[1]], [pos('CRWD', '22788C105', 1_280_592, 243_312_480), jq2[1]], undefined, new Map([['22788C105', 4]])).moves)[0];
    expect([am.change, am.prev_shares, am.split]).toEqual(['added', 1_280_592, undefined]);
    // Equal after the split: no move at all.
    expect(all(computeMoves([pos('APH', '032095101', 1_229_320, 103_632_676), jq3[1]], jq2, undefined, new Map([['032095101', 2]])).moves)).toEqual([]);

    // The publish gate on the pre-fix path (the split kept the rows from the unit check, but no ratio was applied): the
    // season's four wrong rows, as filed, are each held by splits.json and ingest's consensus.json prices, with or
    // without the medians; computed with the ratio, they pass.
    const SPL = new Map([['032095101', 2], ['22788C105', 4]]);
    const CONS = new Map([['032095101', { cur: 84.3, prev: 176.32 }], ['22788C105', { cur: 264.75, prev: 763.14 }]]);
    const season: [string, ReturnType<typeof pos>, ReturnType<typeof pos>][] = [
      ['ICICI Prudential APH', pos('APH', '032095101', 11_300, 1_992_416), pos('APH', '032095101', 70_968, 5_982_602)],
      ['Mizuho Securities CRWD', pos('CRWD', '22788C105', 19_927, 15_207_091), pos('CRWD', '22788C105', 83_130, 19_203_030)],
      ['FMR CRWD', pos('CRWD', '22788C105', 7_847_117, 5_988_448_225), pos('CRWD', '22788C105', 40_141_659, 10_627_504_388)],
      ['Jensen APH', jq2[0], jq3[0]],
    ];
    for (const [who, q2, q3] of season) {
      const prev = [q2, jq2[1]];
      const cur = [q3, jq3[1]];
      const old = computeMoves(cur, prev, undefined, new Set([q2.cusip, q2.ticker!]));
      expect([who, all(old.moves).map((r) => r.change)]).toEqual([who, ['added']]); // what was sent: a buy
      for (const medians of [CONS, new Map()]) {
        const g = gateMoves(old, prev, SPL, medians);
        expect([who, g.held.map((h) => [h.ticker, h.change, h.reason]), all(g.moves), g.moves.bought_usd]).toEqual([who, [[q2.ticker, 'added', 'split_basis']], [], 0]);
      }
      expect([who, gateMoves(computeMoves(cur, prev, undefined, SPL), prev, SPL, CONS).held]).toEqual([who, []]);
    }
    // A split not yet in splits.json (how APH went wrong): the 2x price move passes a wide check, so the own-prior
    // check holds it (price down ~2x, shares up ~2x), and so does the 1.25x cross-filer check when filers' prices exist.
    const noSplit = computeMoves(jq3, jq2, undefined, new Map());
    expect(gateMoves(noSplit, jq2, new Map(), new Map()).held.map((h) => [h.ticker, h.reason])).toEqual([['APH', 'own_prior']]);
    expect(gateMoves(noSplit, jq2, new Map(), new Map([['032095101', { cur: 84.3, prev: 176.32 }]])).held.map((h) => [h.ticker, h.reason])).toEqual([['APH', 'own_prior']]);
    // Guardcap's BKNG (0001732008-26-000006): Q2 filed as 646,216 sh for $121.6M (about $188 a share, a unit error ingest
    // flags suspect_units), Q3 1,304 sh for $6.7M. Unflagged, nothing here catches it (27x is under the 100x unit rule,
    // and no filers' prices are on hand) and it reads as a sale. Flagged, on either line or as price_outlier, it is
    // held as not counted: out of the moves and totals, named "share count unreliable in this filing, not counted".
    const gbk2 = [pos('BKNG', '09857L108', 646_216, 121_600_000), pos('REST', '000000009', 1, 1e9)];
    const gbk3 = [pos('BKNG', '09857L108', 1_304, 6_700_000), pos('REST', '000000009', 1, 1e9)];
    const bk = computeMoves(gbk3, gbk2, undefined, new Map());
    expect(gateMoves(bk, gbk2, new Map(), new Map()).changed.map((r) => [r.ticker, r.change])).toEqual([['BKNG', 'trimmed']]);
    // Flagged, it goes by the reliable side (the analyst, Nov 11), never into the totals or the headline:
    // - "shares" (ingest's unreliable field): the change in filed value, $121.6M -> $6.7M, a cut of about $115M;
    // - "both" (suspect_units before ingest's field lands): held, "pre-split count, change not computed".
    const sh = [{ ...gbk2[0], suspect_units: true, unreliable: 'shares' }, gbk2[1]];
    const gs = gateMoves(computeMoves(gbk3, sh as never, undefined, new Map()), sh as never, new Map(), new Map());
    expect([gs.changed.map((r) => [r.ticker, r.change, r.value_delta, r.unreliable]), gs.moves.bought_usd, gs.moves.sold_usd, gs.held]).toEqual([[['BKNG', 'trimmed', -114_900_000, 'shares']], 0, 0, []]);
    const both = [{ ...gbk2[0], suspect_units: true }, gbk2[1]];
    const gb = gateMoves(computeMoves(gbk3, both as never, undefined, new Map()), both as never, new Map(), new Map());
    expect([gb.changed, gb.moves.sold_usd, gb.held.map((h) => [h.ticker, h.reason])]).toEqual([[], 0, [['BKNG', 'unreliable_shares']]]);
    const gsMail = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'guardcap', slugs: ['guardcap'], manager: 'GuardCap Asset Management', name: 'GuardCap Asset Management', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0001732008-26-000006', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-06T21:00:00Z', moves: gs.moves, tickers: ['BKNG'] }], [], { investors: ['guardcap'], stocks: [], owned: [] } as never);
    expect([gsMail.text.includes("Not counted: BKNG value as filed fell from $121.6M to $6.7M (share counts don't reconcile)."), /3\.3B|BKNG/.test(gsMail.subject), /sold \$114|-\$114\.9M/.test(gsMail.text)]).toEqual([true, false, false]);
    // An option line filed in contracts (price 100x its underlying's median: BNP's SPY puts, +$16.0B in a book far larger)
    // passes the size guard, so the 3x band against the underlying's median marks it: shown, never totalled or headlined.
    const bq2 = [pos('SPY', '78462F103', 100_000, 6_660_000_000, 'Put'), pos('REST', '000000009', 1, 500e9)];
    const bq3 = [pos('SPY', '78462F103', 340_000, 22_650_000_000, 'Put'), pos('REST', '000000009', 1, 500e9)];
    const gopt = gateMoves(computeMoves(bq3, bq2, undefined, new Map()), bq2, new Map(), new Map([['78462F103', { cur: 666, prev: 640 }]]));
    // Without ingest's verdict an option outlier has no reliable side ("both", the lead, Nov 11): held, never sized.
    expect([gopt.changed, gopt.moves.bought_usd, gopt.held.map((h) => [h.ticker, h.put_call, h.reason])]).toEqual([[], 0, [['SPY', 'Put', 'unreliable_shares']]]);
    // Ingest's contract filers (BNP: shares x100, shares_basis "contracts", no flag): EDGAR's raw line is still in contracts
    // here, so the band marks it and it never headlines before the x100 is applied.
    const gc = gateMoves(computeMoves(bq3, bq2, undefined, new Map()), bq2.map((p) => (p.put_call ? { ...p, shares_basis: 'contracts' } : p)) as never, new Map(), new Map([['78462F103', { cur: 666, prev: 640 }]]));
    expect([gc.changed, gc.moves.bought_usd, gc.held.length]).toEqual([[], 0, 1]);
    const optMail = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'bnp', slugs: ['bnp'], manager: 'BNP Paribas', name: 'BNP PARIBAS', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0000000000-26-000001', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-06T21:00:00Z', moves: gopt.moves, held: gopt.held, tickers: [] }], [], { investors: ['bnp'], stocks: [], owned: [] } as never);
    expect([/SPY|16\.0B/.test(optMail.subject), optMail.text.includes("Not counted: SPY puts (share counts don't reconcile).") && !/16\.0B|22\.6B/.test(optMail.text), /\+\d+% shares/.test(optMail.text)]).toEqual([false, true, false]);
    // Ingest's own side wins when it gives one; without it, a stock line off its price is "value".
    expect([unreliableSide({ put_call: 'Put', price_outlier: true, unreliable: 'value' }), unreliableSide({ put_call: 'Put', price_outlier: true }), unreliableSide({ put_call: null, price_outlier: true }), unreliableSide({ put_call: 'Put', option_held: 'isolated' })]).toEqual(['value', 'both', 'value', 'both']);
    // Belvedere's EW puts (3.9M contracts at $7,758 each, a value error): a new held line prints no $ trade, is under
    // "Not counted" (not New), and never headlines.
    const ew = movesOf([{ change: 'new', ticker: 'EW', display_name: null, issuer: 'EDWARDS', cusip: '28176E108', put_call: 'Put', shares: 3_900_000, prev_shares: 0, value: 30_200_000_000, value_delta: 30_200_000_000, delta_pct_of_book: null, unreliable: 'both', median_per_share: 78 }, { change: 'added', ticker: 'AAPL', display_name: null, issuer: 'APPLE', cusip: '037833100', put_call: null, shares: 20, prev_shares: 10, value: 4e6, value_delta: 2e6, delta_pct_of_book: null }] as never);
    const ewMail = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'belvedere', slugs: ['belvedere'], manager: 'Belvedere', name: 'Belvedere', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0000000000-26-000011', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-06T21:00:00Z', moves: ew, tickers: [] }], [], { investors: ['belvedere'], stocks: [], owned: [] } as never);
    expect([/\+\$30\.2B/.test(ewMail.text + ewMail.html + ewMail.subject), /New:/.test(ewMail.text), /EW/.test(ewMail.subject), ewMail.text.includes("Not counted: EW puts new, 3.9M sh; shares and value as filed don't reconcile (≈$7,744/sh vs ~$78).") && !/30\.2B/.test(ewMail.text), ew.bought_usd]).toEqual([false, false, false, true, 2e6]);
    // A "both" stock line blames neither figure (the analyst, Nov 11: Mizuho's O, $11.1M plausible, 23.3M sh not); a merged
    // misfiled prior (ingest's cusip_pair merged_misfiled, Mizuho's Q2 Oracle under 68389X204) is a counted add with its note.
    const mz = { slug: 'mizuho', slugs: ['mizuho'], manager: 'Mizuho', name: 'Mizuho', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-09', accession: '0001062993-26-005832', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-09T20:47:57Z', tickers: [], moves: movesOf([
      { change: 'new', ticker: 'O', display_name: null, issuer: 'REALTY INCOME', cusip: '756109104', put_call: null, shares: 23_300_000, prev_shares: 0, value: 11_100_000, value_delta: 11_100_000, delta_pct_of_book: null, unreliable: 'both', median_per_share: 54 },
      { change: 'added', ticker: 'ORCL', display_name: null, issuer: 'ORACLE', cusip: '68389X105', put_call: null, shares: 166_000, prev_shares: 132_918, value: 22e6, value_delta: 4_200_000, delta_pct_of_book: 0.001, cusip_pair: 'merged_misfiled', filed_cusip: '68389X204', filed_price: 146.55, matched_cusip: '68389X105' },
    ] as never) };
    const mzMail = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [mz as never], [], { investors: ['mizuho'], stocks: [], owned: [] } as never);
    expect([mzMail.text.includes("Not counted: O new; 23.3M sh and $11.1M as filed don't reconcile (≈$0.48/sh vs ~$54)."), mzMail.text.includes("ORCL +33,082 sh (+$4.2M): Q2 was filed under 68389X204 at common's price, treated as common"), /possible CUSIP change/.test(mzMail.text), mzMail.html?.includes('Q2 was filed under 68389X204')]).toEqual([true, true, false, true]);
    // An alert stored before this change (marked rows inside the lists) renders the same way.
    const old = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'belvedere', slugs: ['belvedere'], manager: 'Belvedere', name: 'Belvedere', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0000000000-26-000011', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-06T21:00:00Z', moves: { ...ew, new: ew.not_counted!, not_counted: undefined }, tickers: [] }], [], { investors: ['belvedere'], stocks: [], owned: [] } as never);
    expect([/\+\$30\.2B/.test(old.text + old.html), old.text.includes('Not counted: EW puts new'), /EW/.test(old.subject)]).toEqual([false, true, false]);
    // Webhooks: the held line only in not_counted, never summable.
    const hook = JSON.parse(webhookPayloads({ SITE_URL: 'https://site.test/' } as Env, [{ slug: 'belvedere', slugs: ['belvedere'], manager: 'Belvedere', name: 'Belvedere', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0000000000-26-000011', sec_url: 'https://www.sec.gov/x', moves: { ...ew, new: ew.not_counted!, not_counted: undefined }, tickers: [] } as never], [], Date.now())[0].body).moves;
    // A held trim (the PM, Nov 11: the case most likely to regress): change "unknown", value_delta null, not counted, no value_change.
    const trimHook = JSON.parse(webhookPayloads({ SITE_URL: 'https://site.test/' } as Env, [{ slug: 'guardcap', slugs: ['guardcap'], manager: 'GuardCap', name: 'GuardCap', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0001732008-26-000006', sec_url: 'https://www.sec.gov/x', moves: { bought_usd: 0, sold_usd: 0, new: [], added: [], trimmed: [{ change: 'trimmed', ticker: 'BKNG', display_name: null, issuer: 'BOOKING', cusip: '09857L108', put_call: null, shares: 1304, prev_shares: 646216, value: 6_700_000, prev_value: 121_600_000, value_delta: -114_959_916, value_change: -114_959_916, delta_pct_of_book: -0.02, unreliable: 'shares' }], exited: [] }, tickers: [] } as never], [], Date.now())[0].body).moves;
    expect([trimHook.trimmed.length, trimHook.sold_usd, trimHook.not_counted.map((r: Record<string, unknown>) => [r.ticker, r.change, r.value_delta, r.counted, 'value_change' in r, r.value, r.prev_value])]).toEqual([0, 0, [['BKNG', 'unknown', null, false, false, 6_700_000, 121_600_000]]]);
    expect([hook.new.length, hook.not_counted.map((r: { ticker: string; change: string | null; value_delta: number | null; counted: boolean; value_change?: number }) => [r.ticker, r.change, r.value_delta, r.counted, r.value_change])]).toEqual([0, [['EW', 'new', null, false, undefined]]]);
    // Mizuho Securities USA's ORCL: Q2 under 68389X204, Q3 under 68389X105, one issuer prefix. Without ingest's
    // cusip_mismatch it may be one position: both lines held as a possible CUSIP change, never "NEW ORCL".
    const oq2 = [pos('ORCL', '68389X204', 132_845, 19_500_000), pos('REST', '000000009', 1, 6e9)];
    const oq3 = [pos('ORCL', '68389X105', 165_927, 45_000_000), pos('REST', '000000009', 1, 6e9)];
    const om = computeMoves(oq3, oq2);
    const orclMail = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'mizuho', slugs: ['mizuho'], manager: 'Mizuho Securities USA', name: 'Mizuho Securities USA', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0001062993-26-005832', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-06T21:00:00Z', moves: om.moves, tickers: [] }], [], { investors: ['mizuho'], stocks: [], owned: [] } as never);
    expect([om.moves.new.length, om.moves.exited.length, om.moves.bought_usd, om.moves.sold_usd, /ORCL/.test(orclMail.subject), /New:|Exited:/.test(orclMail.text), orclMail.text.includes('Not counted: ORCL 133K → 166K sh: possible CUSIP change (68389X204 → 68389X105).') && !/45\.0M|19\.5M/.test(orclMail.text)]).toEqual([0, 0, 0, 0, false, false, true]);
    // Stored with the Oracle exit already held (in not_counted, "both"): the ORCL new line still pairs with it.
    const oStored = { ...om.moves, new: om.moves.not_counted!.filter((r) => r.change === 'new').map((r) => ({ ...r, unreliable: undefined, cusip_pair: undefined })), not_counted: om.moves.not_counted!.filter((r) => r.change === 'exited').map((r) => ({ ...r, cusip_pair: undefined, unreliable: 'both' as const })) };
    const oMail = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'mizuho', slugs: ['mizuho'], manager: 'Mizuho Securities USA', name: 'Mizuho Securities USA', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0001062993-26-005832', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-06T21:00:00Z', moves: oStored, tickers: [] }], [], { investors: ['mizuho'], stocks: [], owned: [] } as never);
    expect([oStored.new.length, /ORCL/.test(oMail.subject), /New:/.test(oMail.text), oMail.text.includes('Not counted: ORCL 133K → 166K sh: possible CUSIP change (68389X204 → 68389X105).') && !/ORCL new|ORCL sold all/.test(oMail.text)]).toEqual([1, false, false, true]);
    // - "value" (price_outlier: BMO's Q3 TEVA filed at about $4,005 a share): the share change, value unavailable.
    const tq2 = [pos('TEVA', '881624209', 971_583, 26_200_000), gbk2[1]];
    const tq3 = [{ ...pos('TEVA', '881624209', 1_130_855, 4_529_000_000), price_outlier: true }, gbk3[1]];
    const gv = gateMoves(computeMoves(tq3 as never, tq2, undefined, new Map()), tq2, new Map(), new Map());
    expect([gv.changed.map((r) => [r.ticker, r.unreliable, r.shares - r.prev_shares]), gv.moves.bought_usd, gv.held]).toEqual([[['TEVA', 'value', 159_272]], 0, []]);
    const gvMail = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'bmo', slugs: ['bmo'], manager: 'Bank of Montreal', name: 'BANK OF MONTREAL', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-10', accession: 'b1', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-10T21:00:00Z', moves: gv.moves, tickers: ['TEVA'] }], [], { investors: ['bmo'], stocks: [], owned: [] } as never);
    // A \"value\" line is a real trade (the analyst's round 39): listed under Added by shares, no $, out of totals and the
    // subject; its webhook row keeps \"added\" with value_delta null.
    expect([gvMail.text.includes('Added: TEVA +159,272 sh (+16% shares) · value unavailable, not in totals'), /Not counted|4,005|\$4\.5B/.test(gvMail.text)]).toEqual([true, false]);
    const tHook = JSON.parse(webhookPayloads({ SITE_URL: 'https://site.test/' } as Env, [{ slug: 'bmo', slugs: ['bmo'], manager: 'Bank of Montreal', name: 'BANK OF MONTREAL', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-10', accession: 'b1', sec_url: 'https://www.sec.gov/x', moves: gv.moves, tickers: [] } as never], [], Date.now())[0].body).moves;
    expect([tHook.bought_usd, tHook.added.map((r: { ticker: string; change: string; value_delta: number | null }) => [r.ticker, r.change, r.value_delta])]).toEqual([0, [['TEVA', 'added', null]]]);
    expect(/TEVA/.test(gvMail.subject)).toBe(false);
    const gmail = alertMail({ SITE_URL: 'https://site.test/' } as Env, 'x@example.com', [{ slug: 'guardcap', slugs: ['guardcap'], manager: 'GuardCap Asset Management', name: 'GuardCap Asset Management', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-06', accession: '0001732008-26-000006', sec_url: 'https://www.sec.gov/x', accepted: '2026-11-06T21:00:00Z', moves: { bought_usd: 0, sold_usd: 0, new: [], added: [], trimmed: [], exited: [] }, held: [{ cusip: '09857L108', ticker: 'BKNG', issuer: 'BKNG', display_name: null, put_call: null, change: 'trimmed', reason: 'unreliable_shares' }], tickers: ['BKNG'] }], [], { investors: ['guardcap'], stocks: [], owned: [] } as never);
    expect([gmail.text.includes("Not counted: BKNG (share counts don't reconcile)."), /pending check|3\.3B|3,3/.test(`${gmail.subject} ${gmail.text}`)]).toEqual([true, false]);
    // A real 2x price move with the shares unchanged is not held, nor a 20% buy at a price filers agree on.
    const up = [pos('APH', '032095101', 614_660, 216_753_702), jq2[1]];
    expect(gateMoves(computeMoves(up, jq2, undefined, new Map()), jq2, new Map(), new Map()).held).toEqual([]);
    const buy = [pos('APH', '032095101', 737_592, 130_052_221), jq2[1]];
    expect(gateMoves(computeMoves(buy, jq2, undefined, new Map()), jq2, new Map(), new Map([['032095101', { cur: 176.4, prev: 176.32 }]])).held).toEqual([]);
    // A 44% fall a fund bought into 4.6x (Davis's Q3 APP) is a trade, not a split: both ratios must sit near k.
    const appQ2 = [pos('APP', '03831W108', 315_539, 162_720_000), jq2[1]];
    expect(gateMoves(computeMoves([pos('APP', '03831W108', 1_456_542, 423_020_000), jq2[1]], appQ2, undefined, new Map()), appQ2, new Map(), new Map()).held).toEqual([]);
    // Off the other filers' quarter-end price by over 1.25x (a 3:2 split the filer applied to its count only) is held.
    const off = [pos('APH', '032095101', 922_000, 108_376_851), jq2[1]];
    expect(gateMoves(computeMoves(off, jq2, undefined, new Map()), jq2, new Map(), new Map([['032095101', { cur: 176.4, prev: 176.32 }]])).held.map((h) => h.reason)).toEqual(['price_vs_filers']);
    // Stock-match 13F alerts come from every tracked fund whatever ingest types it (Olstein, Gabelli and Advent were
    // retyped long_only -> wealth on Nov 11), except banks, index funds, insurers, pensions and sovereign funds; an
    // untracked filer (not in index.json's meta) alerts only its followers.
    {
      const f = { investors: [], stocks: ['APH'], owned: [], onboarded: true } as never;
      const fl = (slug: string) => ({ slug, slugs: [slug], tickers: ['APH'], accession: slug }) as never;
      const meta = { lo: { type: 'long_only' }, hf: { type: 'hedge_fund' }, wl: { type: 'wealth' }, ot: { type: 'other' }, bk: { type: 'bank' }, ix: { type: 'index' }, fb: { type: 'bank', featured: true } };
      const got = forMember({ alerts: 'followed' } as never, f, ['lo', 'hf', 'wl', 'ot', 'bk', 'ix', 'fb', 'untracked'].map(fl), [], meta);
      expect(got.filings.map((x: { slug: string }) => x.slug)).toEqual(['lo', 'hf', 'wl', 'ot', 'fb']);
    }
    // An inactive filer (index.json status; Olstein's registration ended) alerts nobody, followers and watchers alike.
    {
      const f = { investors: ['gone'], stocks: ['APH'], owned: [], onboarded: true } as never;
      const fl = { slug: 'gone', slugs: ['gone'], tickers: ['APH'], accession: 'g' } as never;
      const ev = { id: 'e', kind: 'form4', slug: 'gone', ticker: 'APH' } as never;
      const got = forMember({ alerts: 'all' } as never, f, [fl], [ev], { gone: { type: 'long_only', featured: true, inactive: true } });
      expect([got.filings.length, got.events.length]).toEqual([0, 0]);
    }
    // A bond line (PRN) whose prior was stored with shares 0 and its principal: Advent's read "added +$141M" from zero.
    const bond = (amt: number, value: number) => ({ ...pos('BOND', '00000BND1', 0, value), shares_type: 'PRN', principal_amount: amt });
    const bp = [bond(140_000_000, 140_150_269), jq2[1]];
    const bc = [{ ...bond(141_000_000, 141_206_378), shares: 141_000_000 }, jq2[1]];
    const [b1] = all(computeMoves(bc, bp, undefined, new Map()).moves);
    expect([b1.change, b1.value_delta > 900_000 && b1.value_delta < 1_100_000]).toEqual(['added', true]); // about $1M of principal, not $141M
  });

  it('alert accuracy: held rows go out once the build confirms them; a sent row that disagrees with the build gets a correction email and a corrected feed copy', async () => {
    const { checkHeld, reconcileAlerts, reconciliation, etDay, RECONCILE_MAIL_FROM } = await import('../src/alerts');
    // Corrections are mailed for alerts accepted from RECONCILE_MAIL_FROM on (earlier ones are logged only).
    const now = Math.max(Date.now(), Date.parse(RECONCILE_MAIL_FROM) + 2 * 3600_000);
    const accepted = new Date(now - 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await putMember('cus_j', 'copybook-test-j@fldubai.com', 'active', ['jensen']);
    await putFollows('cus_j', { investors: ['jensen'] });
    // MSFT's emailed $512.88 a share is 1.28x the $400 other filers report: the after-send check marks it. Two hours on,
    // so other filers' prices are read again (an earlier test cached them for the hour).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    consensusQ = { '2026Q3': { '032095101': 84.3, '594918104': 400 }, '2026Q2': { '032095101': 176.32 } };
    const ACC = '0001171200-26-000023';
    const base = { slug: 'jensen', slugs: ['jensen'], manager: 'Jensen', name: 'Jensen Investment Management', quarter: '2026Q3', report_date: '2026-09-30', filing_date: accepted.slice(0, 10), accession: ACC, sec_url: 'https://www.sec.gov/Archives/edgar/data/1171200/x-index.html', accepted, tickers: [] };
    const row = (ticker: string, cusip: string, change: string, shares: number, prev_shares: number, value: number, value_delta: number) => ({ change, ticker, display_name: null, issuer: ticker, cusip, put_call: null, shares, prev_shares, value, value_delta, delta_pct_of_book: value_delta / 3.2e9 });
    // Ingest's build (h/), as /v1 serves it: APH split-adjusted to a trim, MSFT as sent.
    hist.m.set('h/jensen/2026Q3.json', new TextEncoder().encode(JSON.stringify({ accession: ACC, quarter: '2026Q3', holdings: [
      { ...row('APH', '032095101', 'trimmed', 1_047_486, 1_229_320, 88_303_070, -15_328_606), prev_shares_as_filed: 614_660, prev_value: 108_376_851, split: { ratio: 2, from_quarter: '2026Q2', to_quarter: '2026Q3' } },
      { ...row('MSFT', '594918104', 'added', 519_677, 500_000, 266_542_333, 10_092_000), prev_value: 240_000_000 },
      { ...row('KO', '191216100', 'unchanged', 10, 10, 700, 0) },
      // An option row as the book writes it ("CALL"), and a convertible bond sized from its principal.
      { ...row('SPY', '78462F103', 'added', 2000, 1000, 1_300_000, 650_000), put_call: 'CALL' },
      { ...row('BOND', '00000BND1', 'added', 0, 0, 141_206_378, 1_056_109), shares_type: 'PRN' },
    ], exited: [{ ...row('ORCL', '68389X105', 'exited', 0, 30_000, 0, -5_000_000) }] })));

    // A: the gate held APH. Once the build has it and it passes the same gate, a "checked" follow-up carries it.
    await env.DB.put('alerts:pending-check', JSON.stringify([{ ...base, moves: { bought_usd: 10_092_000, sold_usd: 0, new: [], added: [row('MSFT', '594918104', 'added', 519_677, 500_000, 266_542_333, 10_092_000)], trimmed: [], exited: [] }, held: [{ cusip: '032095101', ticker: 'APH', issuer: 'APH', display_name: null, put_call: null, change: 'added', reason: 'split_basis' }] }]));
    const held = await checkHeld(env, now);
    expect(held).toMatchObject({ checked: [{ accession: ACC, passed: 1, held: 0, dropped: 0 }] });
    expect(sent.map((m) => [m.to[0], m.subject])).toEqual([['copybook-test-j@fldubai.com', 'Jensen Q3 changes: APH -$15.3M']]);
    expect(sent[0].text).toContain('(checked position changes)');
    expect(sent[0].text).toContain('Trimmed: APH -$15.3M');
    expect(await env.DB.get('alerts:pending-check')).toBeNull();
    // A real trade the own-prior check can't tell from an unlisted split (Acadian's CMPX: the price halved, the shares
    // doubled): held while the build agrees and splits.json lists nothing, then sent a day after acceptance.
    const ACA = '0001140361-26-042753';
    hist.m.set('h/acadian/2026Q3.json', new TextEncoder().encode(JSON.stringify({ accession: ACA, quarter: '2026Q3', holdings: [{ ...row('CMPX', '20451W101', 'added', 2_635_682, 1_161_231, 2_734_000, 196_000), prev_value: 2_538_000 }] })));
    const cmpx = { ...base, slug: 'acadian', slugs: ['acadian'], accession: ACA, moves: { bought_usd: 0, sold_usd: 0, new: [], added: [], trimmed: [], exited: [] }, held: [{ cusip: '20451W101', ticker: 'CMPX', issuer: 'CMPX', display_name: null, put_call: null, change: 'added', reason: 'own_prior' }] };
    await env.DB.put('alerts:pending-check', JSON.stringify([cmpx]));
    expect(await checkHeld(env, now)).toMatchObject({ checked: [{ accession: ACA, passed: 0, held: 1 }] });
    expect(await checkHeld(env, now + 24 * 3600_000)).toMatchObject({ checked: [{ accession: ACA, passed: 1, held: 0 }] });
    expect(await env.DB.get('alerts:pending-check')).toBeNull();
    // A row held because the filer's own value looks wrong (Mizuho Securities' GOOG at $150 against filers' $341), on a
    // line the build flags suspect_units: never counted (the lead, Nov 11), a day on as well. It leaves the queue with
    // nothing sent, and the held list says so.
    const MZ = '0001062993-26-005832';
    hist.m.set('h/mizuho/2026Q3.json', new TextEncoder().encode(JSON.stringify({ accession: MZ, quarter: '2026Q3', holdings: [{ ...row('GOOG', '02079K107', 'added', 1_734_262, 829_083, 260_365_000, 165_000_000), prev_value: 294_800_000, suspect_units: true }] })));
    await putFollows('cus_j', { investors: ['jensen', 'mizuho'] });
    const goog = { ...base, slug: 'mizuho', slugs: ['mizuho'], manager: 'Mizuho', name: 'Mizuho Securities USA', accession: MZ, moves: { bought_usd: 0, sold_usd: 0, new: [], added: [], trimmed: [], exited: [] }, held: [{ cusip: '02079K107', ticker: 'GOOG', issuer: 'GOOG', display_name: null, put_call: null, change: 'added', reason: 'price_vs_filers' }] };
    await env.DB.put('alerts:pending-check', JSON.stringify([goog]));
    sent = [];
    // suspect_units without ingest's `unreliable` side reads as "both" (the analyst): it waits, then after 7 days still
    // flagged it is not counted, with nothing sent.
    expect(await checkHeld(env, now)).toMatchObject({ checked: [{ accession: MZ, passed: 0, held: 1 }] });
    const wk = now + 7 * 24 * 3600_000 + 60_000;
    expect(await checkHeld(env, wk)).toMatchObject({ checked: [{ accession: MZ, passed: 0, held: 0 }] });
    expect([sent, await env.DB.get('alerts:pending-check')]).toEqual([[], null]);
    expect((await reconciliation(env)).held).toEqual([
      { accession: MZ, ticker: 'GOOG', cusip: '02079K107', rule: 'price_vs_filers', held_at: accepted, released_at: new Date(wk).toISOString().replace(/\.\d{3}Z$/, 'Z'), outcome: 'not_counted' },
      expect.objectContaining({ accession: ACA, ticker: 'CMPX', rule: 'own_prior', outcome: 'released_after_1d' }),
      expect.objectContaining({ accession: ACC, ticker: 'APH', outcome: 'passed' }),
    ]);
    sent = [];
    // Released on correction: the same held row, once a later build (or a 13F-HR/A) clears the flag and the line
    // passes the gate, goes out in the checked follow-up instead of staying not counted.
    hist.m.set('h/mizuho/2026Q3.json', new TextEncoder().encode(JSON.stringify({ accession: MZ, quarter: '2026Q3', holdings: [{ ...row('GOOG', '02079K107', 'added', 1_734_262, 829_083, 260_365_000, 135_896_000), prev_value: 124_469_000 }] })));
    await env.DB.put('alerts:pending-check', JSON.stringify([goog]));
    sent = [];
    expect(await checkHeld(env, now)).toMatchObject({ checked: [{ accession: MZ, passed: 1, held: 0 }] });
    expect(sent.map((m) => m.subject).join(' ')).toMatch(/Mizuho/);
    // Newport's HON (reissue_ratio_not_applied, "both"): held, never sized.
    hist.m.set('h/mizuho/2026Q3.json', new TextEncoder().encode(JSON.stringify({ accession: MZ, quarter: '2026Q3', holdings: [{ ...row('GOOG', '02079K107', 'added', 1_734_262, 829_083, 260_365_000, 135_896_000), prev_value: 124_469_000, suspect_reason: 'reissue_ratio_not_applied' }] })));
    await env.DB.put('alerts:pending-check', JSON.stringify([goog]));
    sent = [];
    expect(await checkHeld(env, now)).toMatchObject({ checked: [{ accession: MZ, passed: 0, held: 1 }] });
    expect(sent).toEqual([]);
    await env.DB.delete('alerts:pending-check');

    // B: the alert as it went out before the fix (APH "added +$36.5M") reconciles against the build: a correction.
    sent = [];
    const day = etDay(now);
    // The alert as sent: its exit (ORCL) is in the book's exited[]; its option says "Call"; its bond row was sized from shares.
    await env.DB.put(`digest:${day}`, JSON.stringify({ filings: [{ ...base, moves: { bought_usd: 46_579_232, sold_usd: 5_000_000, new: [], added: [row('APH', '032095101', 'added', 1_047_486, 614_660, 88_303_070, 36_487_232), row('MSFT', '594918104', 'added', 519_677, 500_000, 266_542_333, 10_200_000), { ...row('SPY', '78462F103', 'added', 2000, 1000, 1_300_000, 650_000), put_call: 'Call' }, row('BOND', '00000BND1', 'added', 141_206_378, 1, 141_206_378, 141_206_377)], trimmed: [], exited: [row('ORCL', '68389X105', 'exited', 0, 30_000, 0, -5_000_000), row('CHRW', '12541W209', 'exited', 0, 3_642_453, 0, -686_000_000)] } }], events: [] }));
    await env.DB.put('delivered:cus_j', JSON.stringify([{ day, ids: [ACC] }]));
    const r = await reconcileAlerts(env, now);
    // CHRW's exit isn't in the build at all (retail, Nov 11: a build without its exits): unconfirmed, never "corrected"
    // to unchanged. MSFT within 10%, the ORCL exit and the SPY call pass; APH and the bond (sized from a zero prior, as Advent's was) are
    // wrong; the emailed bought total ($46.6M against the build's $11.8M, still off with APH and the bond at its figures) is
    // off too, but this accession's totals are already disclosed on /status/ (the split alerts), so it isn't mailed again.
    expect(r).toEqual({ checked: [{ accession: ACC, result: 'fail', rows: 6, failed: 3, mailed: 1 }], rechecked: [], pending: 0 });
    expect(sent[0]?.text).not.toMatch(/CHRW|unchanged/);
    expect(sent[0]?.text).toContain('BOND');
    expect(sent[0]?.text).not.toContain('Total bought');
    expect(sent.map((m) => m.to[0])).toEqual(['copybook-test-j@fldubai.com']);
    const store = JSON.parse((await env.DB.get(`digest:${day}`))!);
    expect(store.filings[0].corrected.rows.map((x: { ticker: string | null; name: string }) => x.ticker ?? x.name)).toEqual(['BOND', 'APH']);
    // The after-send cross-filer check: MSFT is marked "shown as filed" in the archive, never mailed (it is as filed).
    expect(store.filings[0].moves.added.map((x: { ticker: string; filer_value?: boolean }) => [x.ticker, !!x.filer_value])).toEqual([['APH', false], ['MSFT', true], ['SPY', false], ['BOND', false]]);
    expect(sent[0]?.text).not.toContain('MSFT');
    // Checked once: the next run doesn't mail again; the log feeds latency.json's reconciliation.
    sent = [];
    expect((await reconcileAlerts(env, now)).checked).toEqual([]);
    // The first verdict is frozen: an hour on, a later build that rebased APH (-$15.3M to -$9.0M) is logged as a
    // re-check with both builds and the reason; the verdict, its class and the mail stay as they were.
    const book = JSON.parse(new TextDecoder().decode(hist.m.get('h/jensen/2026Q3.json')));
    book.build_id = 'build-2';
    book.holdings[0].value_delta = -9_000_000;
    hist.m.set('h/jensen/2026Q3.json', new TextEncoder().encode(JSON.stringify(book)));
    expect(await reconcileAlerts(env, now + 3600_000)).toMatchObject({ checked: [], rechecked: [ACC] });
    expect(sent).toHaveLength(0);
    const rc = await reconciliation(env);
    expect([rc.checked, (rc.recent as { anchor: string; class: string; figures: string; disclosed: boolean | null }[]).map((x) => [x.anchor, x.class, x.figures, x.disclosed])]).toEqual([1, [[ACC, 'wrong', 'wrong_rows', false]]]);
    expect(rc.rechecks).toEqual([expect.objectContaining({ accession: ACC, verdict_build: null, build: 'build-2', reason: 'a later build (an amendment or re-base of the filing or its prior)', verdict_class: 'wrong', class_now: 'wrong', rows: [expect.objectContaining({ ticker: 'APH', verdict: { class: 'wrong', build: { change: 'trimmed', value_delta: -15_328_606 } }, now: { class: 'wrong', build: { change: 'trimmed', value_delta: -9_000_000 } } })] })]);
    // Re-checking the same build again logs nothing new.
    await reconcileAlerts(env, now + 2 * 3600_000);
    expect(((await reconciliation(env)).rechecks as unknown[]).length).toBe(1);
    // The operator's dry run reads the same stores: the alert is wrong as sent (APH and the bond), and it sends nothing.
    const { reconcileDry } = await import('../src/alerts');
    const dry = await reconcileDry(env, now);
    expect([dry.total, dry.as_sent]).toEqual([1, { matched: 0, disclosed: 0, disclosed_totals: 0, explained: 0, wrong: 1, wrong_totals: 0, no_rows: 0, other: 0 }]);
    expect((dry.alerts as { as_sent: { failed: { ticker: string | null; cusip: string; class: string }[] } }[])[0].as_sent.failed.map((f) => [f.ticker ?? f.cusip, f.class])).toEqual([['BOND', 'wrong'], ['APH', 'wrong'], ['total:bought', 'disclosed']]);
    expect(sent).toHaveLength(0);
    expect(await reconciliation(env)).toMatchObject({ checked: 1, passed: 0, failed: 1, matched: 0, disclosed: 0, explained: 0, wrong: 1, wrong_disclosed: 0, wrong_undisclosed: 1, totals_disclosed: 0, totals_undisclosed: 0, filer_value_rows: 1, held_pending: 0, recent: [{ accession: ACC, result: 'fail', class: 'wrong', failed_rows: 3, filer_value_rows: 1, corrections_sent: 1 }] });
    vi.useRealTimers();
  });

  it('quota check: one warning a day past 70% of the daily Workers requests, Workers and Pages Functions together', async () => {
    const { runQuotaCheck } = await import('../src/revenue');
    expect(await runQuotaCheck(env, Date.now())).toEqual({ status: 'no analytics token' });
    Object.assign(env, { CF_API_TOKEN: 'cf', CF_ACCOUNT_ID: 'acct' });
    let used = [30_000, 39_000];
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) =>
      String(u) === 'https://api.cloudflare.com/client/v4/graphql' ? Response.json({ data: { viewer: { accounts: [{ w: [{ sum: { requests: used[0] } }], p: [{ sum: { requests: used[1] } }] }] } } }) : orig(u, init));
    sent = [];
    const noon = Date.UTC(2026, 10, 11, 12); // one UTC day for both checks, whatever the clock says
    expect(await runQuotaCheck(env, noon)).toMatchObject({ status: 'ok', total: 69_000 });
    used = [46_913, 79_189];
    await runQuotaCheck(env, noon);
    await runQuotaCheck(env, noon + 3600_000);
    vi.stubGlobal('fetch', orig);
    expect(sent.map((m) => [m.to[0], m.subject])).toEqual([['hello@factordynamics.com', "Copybook: 126% of today's Workers requests used (126,102 of 100,000)"]]);
    expect(sent[0].text).toContain('Pages Functions 79,189');
    // Past 85% (here 126%) the Worker sheds non-member paths: the page counts and anonymous probes get 503 'shed' at
    // once; a member's request, a /health?probe=1 and the webhook are served (here: proxied to gene, unreachable).
    const cfq = { ...env, MOVED_TO: 'https://gene.test/copybook/' } as Env;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) =>
      String(u) === 'https://api.cloudflare.com/client/v4/graphql' ? Response.json({ data: { viewer: { accounts: [{ w: [{ sum: { requests: 88_000 } }], p: [] }] } } }) : orig(u, init));
    expect(await runQuotaCheck(cfq, Date.now())).toMatchObject({ shed: 1 });
    vi.stubGlobal('fetch', async () => { throw new Error('gene down'); });
    // Two minutes back, so the isolate's cached level has lapsed for the tests after this one.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 120_000 });
    const code = async (path: string, init?: RequestInit) => { const r = await worker.fetch(new Request(`https://copybook-api.factordynamics.workers.dev${path}`, init), cfq); return [r.status, ((await r.json()) as { code?: string }).code ?? null]; };
    expect([await code('/track', { method: 'POST', body: '{"kind":"visit"}' }), await code('/health'), await code('/events?tickers=AAPL'), await code('/health?probe=1'), await code('/me', { headers: { authorization: 'Bearer x' } })].map(([st, c]) => `${st} ${c}`)).toEqual(['503 shed', '503 shed', expect.not.stringMatching(/shed/), expect.not.stringMatching(/shed/), expect.not.stringMatching(/shed/)]);
    vi.useRealTimers();
    await cfq.HIST.put('quota/shed.json', JSON.stringify({ day: '2000-01-01', level: 0 }));
    vi.stubGlobal('fetch', orig);
    Object.assign(env, { CF_API_TOKEN: undefined, CF_ACCOUNT_ID: undefined });
  });

  it("Cloudflare's cron moves members to the Worker when both of gene's front doors are down, and back", async () => {
    const { runAutoFailover } = await import('../src/autofailover');
    const W = 'https://copybook-api.factordynamics.workers.dev';
    const TUN = 'https://abc-def.trycloudflare.com/copybook';
    const FUN = 'https://gene.tail70ba3.ts.net/copybook';
    const cf = { ...env, MOVED_TO: `${FUN}/`, PUBLIC_URL: 'https://pub.test/', API_URL: `${W}/`, CF_API_TOKEN: 'cf', CF_ACCOUNT_ID: 'acct', PUBLIC_BUCKET: 'copybook-public' } as Env;
    let api = TUN;
    const up = new Set<string>();
    const writes: string[] = [];
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.startsWith('https://pub.test/api.json')) return Response.json({ api });
      if (url.endsWith('/objects/api.json') && init?.method === 'PUT') {
        api = JSON.parse(String(init.body)).api;
        writes.push(api);
        return Response.json({ success: true });
      }
      if (url.endsWith('/health?probe=1')) return up.has(url.slice(0, -15)) ? Response.json({ ok: true }) : new Response('error code: 1033', { status: 530 });
      if (url.includes('/graphql')) return new Response('no', { status: 500 });
      return orig(u, init);
    });
    const tick = (i: number, probeOk = false) => runAutoFailover(cf, Date.parse('2026-11-12T15:00:00Z') + i * 60_000, probeOk);
    try {
      // The tunnel is down but Funnel answers: gene's own watcher handles that, the Worker does nothing.
      up.add(FUN);
      for (let i = 0; i < 3; i++) await tick(i);
      expect(writes).toEqual([]);
      // Both down: one failed minute isn't enough, the second moves members to the Worker and emails us.
      up.clear();
      expect(await tick(3)).toContain('(1/2)');
      expect(writes).toEqual([]);
      expect(await tick(4)).toBe(`failed over: api.json -> ${W}`);
      expect(writes).toEqual([W]);
      expect(sent.at(-1)?.subject).toContain('members moved to the Cloudflare Worker');
      // Back after three healthy minutes of the base it replaced; a failed minute in between starts the count again.
      up.add(TUN);
      await tick(5);
      await tick(6);
      up.clear();
      await tick(7);
      up.add(TUN);
      await tick(8);
      await tick(9);
      expect(writes).toEqual([W]);
      expect(await tick(10)).toBe(`failed back: api.json -> ${TUN}`);
      expect(writes).toEqual([W, TUN]);
      // A manual pin (failover-a.sh to-worker) is never undone, however healthy gene is.
      api = W;
      for (let i = 11; i < 16; i++) await tick(i);
      expect(writes).toEqual([W, TUN]);
      // During an automatic failover, a base someone else publishes (a new tunnel URL from gene's watcher) wins.
      api = TUN;
      up.clear();
      await tick(16);
      await tick(17);
      expect(api).toBe(W);
      api = 'https://new-url.trycloudflare.com/copybook';
      expect(await tick(18)).toContain('failover ended');
      up.add(TUN);
      for (let i = 19; i < 23; i++) await tick(i, true);
      expect(api).toBe('https://new-url.trycloudflare.com/copybook');
    } finally {
      vi.stubGlobal('fetch', orig);
    }
  });

  it('a retired copy (MOVED_TO) sends every request to the same path on the live host', async () => {
    // It follows the runner's api.json (the current tunnel), so emailed links on this hostname survive a tunnel move.
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => (String(u).split('?')[0] === 'https://pub.test/api.json' ? Response.json({ api: 'https://abc-def.trycloudflare.com/copybook', at: '2026-11-09T05:30:24Z' }) : orig(u, init)));
    // Every API request is answered on this name from the live host, Authorization and body included (the quant: a 307 to
    // the tunnel lost the API key on the hop and leaked the tunnel's name).
    const LIVE = 'https://abc-def.trycloudflare.com/copybook';
    const seen: { url: string; method: string; auth: string | null; proxy: string | null; body: string }[] = [];
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u).split('?')[0] === 'https://pub.test/api.json') return Response.json({ api: LIVE, at: '2026-11-09T05:30:24Z' });
      if (!String(u).startsWith(LIVE)) return orig(u, init);
      const h = new Headers(init?.headers);
      seen.push({ url: String(u), method: init?.method ?? 'GET', auth: h.get('authorization'), proxy: h.get('x-copybook-proxy'), body: init?.body ? await new Response(init.body).text() : '' });
      const path = String(u).slice(LIVE.length);
      if (path.startsWith('/v1/bulk/')) return new Response(null, { status: 302, headers: { location: 'https://r2.example/file.csv.gz?sig=1' } });
      if (path === '/old') return new Response(null, { status: 308, headers: { location: `${LIVE}/new?x=1` } });
      if (path === '/down') throw new Error('connect failed');
      if (path.startsWith('/health')) return Response.json({ ok: true, this_host: 'gene', by_kind: { real: 2 }, proxied: false, api_host: 'gene', api_build: 'gene00000001' }, { headers: { 'content-length': '999' } });
      return Response.json({ ok: true, path }, { headers: { 'x-ratelimit-remaining': '59' } });
    });
    const wenv0 = { ...env, MOVED_TO: 'https://gene.tail70ba3.ts.net/copybook/', PUBLIC_URL: 'https://pub.test/' } as Env;
    const at = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://copybook-api.factordynamics.workers.dev${path}`, { headers: { 'cf-connecting-ip': '203.0.113.7' }, ...init }), wenv0);
    const me = await at('/v1/me', { headers: { authorization: 'Bearer cbk_live_x', 'cf-connecting-ip': '203.0.113.7' } });
    expect([me.status, me.headers.get('location'), (await me.json()).path, me.headers.get('x-ratelimit-remaining'), seen.at(-1)!.auth]).toEqual([200, null, '/v1/me', '59', 'Bearer cbk_live_x']);
    const r = await at('/resume?t=abc', { method: 'POST', body: '{"a":1}', headers: { 'cf-connecting-ip': '203.0.113.7' } });
    expect([r.status, seen.at(-1)!.url, seen.at(-1)!.method, seen.at(-1)!.body]).toEqual([200, `${LIVE}/resume?t=abc`, 'POST', '{"a":1}']);
    // A bulk file's own link passes; the live host's redirect to itself comes back on this name, and never permanent.
    expect((await at('/v1/bulk/holdings.csv.gz')).headers.get('location')).toBe('https://r2.example/file.csv.gz?sig=1');
    const old = await at('/old');
    expect([old.status, old.headers.get('location')]).toEqual([307, 'https://copybook-api.factordynamics.workers.dev/new?x=1']);
    // /health through this Worker names the Worker that answered (the PM: both bodies read the same, gene's), with its
    // own mail tally, and keeps the live host's under upstream.
    for (const hp of ['/health', '/health?probe=1']) {
      const hb = await (await at(hp)).json();
      expect([hb.this_host, hb.proxied, hb.api_host, hb.upstream, hb.by_kind, hb.by_kind_host, typeof hb.proxy_by_kind?.real]).toEqual(['cloudflare', true, 'gene', { this_host: 'gene', by_kind: { real: 2 }, api_build: 'gene00000001' }, { real: 2 }, 'gene', 'number']);
    }
    // api.json moves (to this Worker, then back): within 10 s every request follows it (the drill: isolates kept the
    // old base 61 s, so a revoked key still worked on the host that had stopped serving).
    const live0 = LIVE;
    let api = 'https://copybook-api.factordynamics.workers.dev';
    const proxied = async () => (await (await at('/health')).json()).proxied;
    const fetch1 = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => (String(u).split('?')[0] === 'https://pub.test/api.json' ? Response.json({ api }) : fetch1(u, init)));
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6_000 });
    expect(await proxied()).toBe(false);
    api = live0;
    vi.setSystemTime(Date.now() + 6_000);
    expect(await proxied()).toBe(true);
    vi.useRealTimers();
    vi.stubGlobal('fetch', fetch1);
    // The live host unreachable: 503 with Retry-After, not a redirect.
    const down = await at('/v1/down'.replace('/v1', ''));
    expect([down.status, down.headers.get('retry-after'), down.headers.get('location')]).toEqual([503, '30', null]);
    // On the live host, the Worker's signed client IP counts for rate limits; a forged one is dropped.
    const proof = seen.find((x) => x.url.endsWith('/v1/me'))!.proxy!;
    expect(proof.split(' ')[0]).toBe('203.0.113.7');
    vi.stubGlobal('fetch', orig);
    const { fromProxy } = await import('../src/index');
    const via = async (proxy: string) => {
      const q = await fromProxy(new Request('https://api.test/signup', { headers: { 'x-copybook-proxy': proxy, 'cf-connecting-ip': '198.51.100.1' } }), env);
      return [q.headers.get('cf-connecting-ip'), q.headers.get('x-copybook-public-base'), q.headers.get('x-copybook-proxy')];
    };
    expect(await via(proof)).toEqual(['203.0.113.7', 'https://copybook-api.factordynamics.workers.dev', null]);
    expect(await via('203.0.113.7 forged')).toEqual(['198.51.100.1', null, null]);
    const { hmacHex } = await import('../src/tokens');
    expect(proof.split(' ')[1]).toBe(await hmacHex(env.SESSION_SECRET, `proxy|203.0.113.7|${Math.floor(Date.now() / 60_000)}`));
    // A private feed is fetched from the live host and answered here (200), so readers keep this name.
    const tok = 'feedtok_abcdefghijklmnopqrstu';
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) =>
      String(u).split('?')[0] === 'https://pub.test/api.json' ? Response.json({ api: 'https://abc-def.trycloudflare.com/copybook', at: '2026-11-09T05:30:24Z' })
      : String(u) === `https://abc-def.trycloudflare.com/copybook/feed/${tok}.json` ? Response.json({ version: 'https://jsonfeed.org/version/1.1', items: [] }, { headers: { 'content-type': 'application/feed+json' } })
      : orig(u, init));
    const wenv = { ...env, MOVED_TO: 'https://gene.tail70ba3.ts.net/copybook/', PUBLIC_URL: 'https://pub.test/' } as Env;
    const fr = await worker.fetch(new Request(`https://copybook-api.factordynamics.workers.dev/feed/${tok}.json`), wenv);
    expect([fr.status, fr.headers.get('content-type'), fr.headers.get('location'), (await fr.json()).version]).toEqual([200, 'application/feed+json', null, 'https://jsonfeed.org/version/1.1']);
    // No response from the Worker is a permanent redirect.
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) =>
      String(u).split('?')[0] === 'https://pub.test/api.json' ? Response.json({ api: LIVE }) : String(u).startsWith(LIVE) ? new Response(null, { status: 308, headers: { location: `${LIVE}/x` } }) : orig(u, init));
    for (const [method, path] of [['GET', '/me'], ['POST', '/resume?t=x'], ['GET', '/v1/filers'], ['GET', '/unsubscribe?t=x'], ['HEAD', `/feed/${tok}.rss`], ['GET', '/']]) {
      const res = await worker.fetch(new Request(`https://copybook-api.factordynamics.workers.dev${path}`, { method }), wenv);
      expect([path, [301, 308].includes(res.status)]).toEqual([path, false]);
    }
    vi.stubGlobal('fetch', orig);
    // The feed served by gene names the Worker, never gene's own hosts, in feed_url and in its items' links.
    await env.DB.put(`feedtok:${tok}`, 'cus_feedhost');
    await env.DB.put('feed:cus_feedhost', JSON.stringify([{ id: 'i1', url: 'https://gene.tail70ba3.ts.net/copybook/why?t=1', title: 'T', text: 'See https://abc-def.trycloudflare.com/copybook/why?t=2', published: '2026-11-11T00:00:00Z' }]));
    const gf = await (await handleRequest(new Request(`https://api.test/feed/${tok}.json`), { ...env, FEED_URL: 'https://gene.tail70ba3.ts.net/copybook' } as Env)).json();
    expect([gf.feed_url, gf.items[0].url, gf.items[0].content_text]).toEqual([`https://copybook-api.factordynamics.workers.dev/feed/${tok}.json`, 'https://copybook-api.factordynamics.workers.dev/why?t=1', 'See https://copybook-api.factordynamics.workers.dev/why?t=2']);
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => (String(u).split('?')[0] === 'https://pub.test/api.json' ? Response.json({ api: 'https://abc-def.trycloudflare.com/copybook', at: '2026-11-09T05:30:24Z' }) : orig(u, init)));
    // Failed over to this host (api.json names it, read again after the minute's cache): served here, no 308 to itself.
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => (String(u).split('?')[0] === 'https://pub.test/api.json' ? Response.json({ api: 'https://copybook-api.factordynamics.workers.dev' }) : orig(u, init)));
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    const own = await worker.fetch(new Request('https://copybook-api.factordynamics.workers.dev/health'), { ...env, MOVED_TO: 'https://gene.tail70ba3.ts.net/copybook/', PUBLIC_URL: 'https://pub.test/' } as Env);
    later.mockRestore();
    const ob = await own.json();
    expect([own.status, ob.ok, ob.this_host, ob.proxied, ob.upstream]).toEqual([200, true, 'cloudflare', false, undefined]);
    vi.stubGlobal('fetch', orig);
    const gh = await worker.fetch(new Request('https://api.test/health'), env);
    expect([301, 307, 308]).not.toContain(gh.status);
    const gb = await gh.json();
    expect([gb.this_host, gb.proxied, typeof gb.by_kind]).toEqual(['gene', false, 'object']);
    expect((await (await worker.fetch(new Request('https://api.test/health?probe=1'), env)).json()).this_host).toBe('gene');
    // One-click unsubscribe for a member only gene has so far (just signed up; the minute sync copies 40 keys a minute):
    // the Worker reads gene's published copy, records the unsubscribe, and publishes it for gene.
    const r2 = new MemR2();
    await r2.put('sync/gene/cus:free_gene1', JSON.stringify({ customer: 'free_gene1', email: 'new@reader.test', status: 'free', plan: 'free', interval: 'unknown', period_end: 0, subscription: '' }));
    const cfEnv = { ...env, DB: new MemKV(), HIST: r2, MOVED_TO: 'https://gene.tail70ba3.ts.net/copybook/' } as Env;
    const t = await signToken(env.SESSION_SECRET, 'unsub', 'free_gene1', 600);
    const u = await worker.fetch(new Request(`https://copybook-api.factordynamics.workers.dev/unsubscribe?t=${t}`, { method: 'POST' }), cfEnv);
    expect(await u.text()).toContain("Done: new@reader.test won't get the weekly any more.");
    expect(JSON.parse(new TextDecoder().decode(r2.m.get('kv/cus:free_gene1'))).marketing_off).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(r2.m.get('sync/cloudflare/cus:free_gene1'))).marketing_off).toBe(true);
  });

  it('latency.json: the /latency report written to the public bucket when it changes, not every minute', async () => {
    const { publishLatency } = await import('../src/index');
    expect(await publishLatency(env, Date.now())).toBe('not configured');
    Object.assign(env, { CF_API_TOKEN: 'cf', CF_ACCOUNT_ID: 'acct', PUBLIC_BUCKET: 'copybook-public' });
    const puts: { url: string; body: string; cc: string | null }[] = [];
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u).startsWith('https://api.cloudflare.com/')) return puts.push({ url: String(u), body: String(init?.body), cc: new Headers(init?.headers).get('cache-control') }), Response.json({ success: true });
      return orig(u, init);
    });
    const at = Date.parse('2026-11-12T15:07:00Z');
    await env.DB.put('alerts:latency', JSON.stringify([{ slug: 'warren-buffett', accession: 'A1', accepted: '2026-11-12T15:00:00Z', sent: '2026-11-12T15:00:40Z', seconds: 40, moves: true }]));
    expect(await publishLatency(env, at)).toBe('written');
    expect(await publishLatency(env, at + 60_000)).toBe('unchanged');
    await env.DB.put('alerts:latency', JSON.stringify([{ slug: 'bill-ackman', accession: 'A2', accepted: '2026-11-12T15:08:00Z', sent: '2026-11-12T15:08:20Z', seconds: 20, moves: true }, { slug: 'warren-buffett', accession: 'A1', accepted: '2026-11-12T15:00:00Z', sent: '2026-11-12T15:00:40Z', seconds: 40, moves: true }]));
    expect(await publishLatency(env, at + 120_000)).toBe('written');
    vi.stubGlobal('fetch', orig);
    expect(puts.map((p) => [p.url, p.cc])).toEqual(Array(2).fill(['https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/copybook-public/objects/latency.json', 'public, max-age=60']));
    // The same report /latency serves, plus when it was written.
    const pub = JSON.parse(puts[1].body);
    expect([pub.count, pub.recent.map((r: { accession: string }) => r.accession), pub.generated_at]).toEqual([2, ['A2', 'A1'], '2026-11-12T15:09:00Z']);
    Object.assign(env, { CF_API_TOKEN: undefined, CF_ACCOUNT_ID: undefined, PUBLIC_BUCKET: undefined });
  });

  it('Holdterm alerts skip books that fail the data check and the funds Holdterm holds back', async () => {
    const { bookSuspect } = await import('../src/edgar');
    const { forHoldterm } = await import('../src/alerts');
    const pos = (value: number, prn = false) => ({ cusip: 'X', put_call: null, issuer: 'X', shares: 1, value, ...(prn ? { prn } : {}) });
    // Wilkinson Global: $28.8B in the table against a $1.26B cover page; a book of notes; a clean book.
    expect(bookSuspect([pos(28.8e9)], 1.26e9)).toBe(true);
    expect(bookSuspect([pos(1e9)], 1.6e9)).toBe(true); // under cover / 1.5
    expect(bookSuspect([pos(6e8, true), pos(4e8)], 1e9)).toBe(true);
    expect(bookSuspect([pos(2e8, true), pos(8e8)], 1.4e9)).toBe(false);
    const a = (cik: string, extra = {}) => ({ slug: `s${cik}`, slugs: [`s${cik}`], manager: 'M', name: 'M', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-10', accession: `acc-${cik}`, sec_url: `https://www.sec.gov/Archives/edgar/data/${cik}/x/acc-index.html`, moves: null, tickers: [], ...extra });
    const got = forHoldterm({ investors: ['s1764000', 's1067983', 's555'], stocks: [], owned: [] } as never, [a('1764000'), a('1067983'), a('555', { suspect_book: true })], [], {});
    expect(got.filings.map((x) => x.slug)).toEqual(['s1067983']);
  });

  it('GET /events: every issuer Form 4 since the quarter whose 13Fs are due began, not just the latest 20 (CSGP CEO buy behind 21 grants)', async () => {
    await hist.put('pre/sec-tickers.json', '{"CSGP":"0001057352","GCO":"0000018498"}');
    const since = Date.parse(quarterStart(Date.now()));
    const at = (days: number) => new Date(since + days * 86400_000).toISOString();
    const entry = (a: string, iso: string) => `<entry><category term="4"/><id>urn:tag:sec.gov,2008:accession-number=${a}</id><updated>${iso}</updated></entry>`;
    const acc = (i: number) => `0009999999-26-${String(i).padStart(6, '0')}`;
    // Newest first: 21 grants (the real filing with its code turned into A), Florance's real open-market buy, then a grant before the window.
    const grants = Array.from({ length: 21 }, (_, i) => entry(acc(i), at(40 - i)));
    secFiles['company:0001057352:4'] = `<feed>${grants.join('')}${entry('0001628280-26-052968', at(5))}${entry(acc(99), at(-30))}</feed>`;
    for (const i of [...Array(21).keys(), 99]) secFiles[`Archives/edgar/data/1057352/${acc(i).replace(/-/g, '')}/${acc(i)}.txt`] = form4Csgp.replace('<transactionCode>P</transactionCode>', '<transactionCode>A</transactionCode>');
    secFiles['Archives/edgar/data/1057352/000162828026052968/0001628280-26-052968.txt'] = form4Csgp;
    stripeObjects['checkout/sessions/cs_test_cg'] = { id: 'cs_test_cg', status: 'complete', created: now(), subscription: 'sub_cg', customer_details: { email: 'cg@example.com' } };
    stripeObjects['subscriptions/sub_cg'] = sub('sub_cg', 'cus_cg', 'active');
    const { token } = (await (await fullCheckout('cs_test_cg')).json()) as { token: string };
    const res = await call('/events?tickers=CSGP&limit=10', { token });
    const r = await res.json();
    expect([res.status, r.pending]).toEqual([200, []]);
    const seen = JSON.parse(new TextDecoder().decode(hist.m.get('tev/CSGP.json')!)).seen;
    expect(seen['0001628280-26-052968']).toMatchObject({
      filer_name: 'FLORANCE ANDREW C', action: 'buy', shares: 83300, price: 29.89, value_usd: 2489837, event_date: '2026-08-04', open_market: true, codes: ['P'],
      transactions: [expect.objectContaining({ code: 'P', shares: 83300, acquired_disposed: 'A', ownership: 'direct' })],
    });
    expect(Object.keys(seen)).toHaveLength(22); // the whole window, and nothing from before it
    expect(seen[acc(99)]).toBeUndefined();
    // My book: the open-market trades even when 21 grants are newer, or the whole window at once.
    const om = await (await call('/events?tickers=CSGP&open_market=1', { token })).json();
    expect(om.tickers.CSGP.events.map((e: { accession: string }) => e.accession)).toEqual(['0001628280-26-052968']);
    const wq = await (await call('/events?tickers=CSGP&window=quarter', { token })).json();
    expect([wq.tickers.CSGP.events.length, wq.tickers.CSGP.window]).toEqual([22, quarterStart(Date.now()).replace(/\.\d{3}Z$/, 'Z')]);
    expect((await call('/events?tickers=CSGP&limit=11', { token })).status).toBe(400);
    expect(r.tickers.CSGP.window).toBe(quarterStart(Date.now()).replace(/\.\d{3}Z$/, 'Z'));
    // Last winter (Dec 1, 2025 to Jan 31, 2026 by filing day), for the day-12 email and /me?include=winter: the CEO's
    // code-P buy filed in the window counts with its dollars; a grant in the window and a buy filed before it don't.
    // By transaction date, $100K or more (the lead, Nov 11): the CEO's buy dated Jan 13 counts; the same buy dated in
    // April but filed in the window (MSFT's case), a grant, and a buy filed before the window don't.
    const dated = (d: string) => form4Csgp.replace('<value>2026-08-04</value>', `<value>${d}</value>`);
    secFiles['Archives/edgar/data/1057352/000162828026052968/0001628280-26-052968.txt'] = dated('2026-01-13');
    secFiles[`Archives/edgar/data/1057352/${acc(2).replace(/-/g, '')}/${acc(2)}.txt`] = dated('2025-04-23');
    secFiles['company:0001057352:4'] = `<feed>${entry('0001628280-26-052968', '2026-01-14T21:00:00Z')}${entry(acc(1), '2026-01-10T21:00:00Z')}${entry(acc(2), '2025-12-12T21:00:00Z')}${entry(acc(99), '2025-11-20T21:00:00Z')}</feed>`;
    await env.DB.put('issuers:tickers', JSON.stringify(['CSGP', 'IVV']));
    const { fillWinter, winterPreview } = await import('../src/stockevents');
    for (let i = 0; i < 3; i++) await fillWinter(env, 20);
    const pv = (await winterPreview(env, ['CSGP', 'IVV']))!;
    expect([pv.names, pv.insider_buys, pv.schedule_13dg, pv.pending, pv.events.map((e) => [e.ticker, e.kind, e.value_usd, e.accession])]).toEqual([2, 1, 0, [], [['CSGP', 'insider_buy', 2489837, '0001628280-26-052968']]]);
    const { day12Mail } = await import('../src/revenue');
    const d12 = day12Mail(env, { customer: 'cus_t', email: 't@example.com', plan: 'copy', interval: 'monthly', status: 'trialing', trial_end: Date.UTC(2026, 10, 25, 20) / 1000, has_payment_method: false } as never, 'u', Date.now(), pv);
    expect(d12.text).toMatch(/Your 2 names had 1 insider buy and 0 13D\/G filings last winter, e\.g\. CSGP (director|.+) bought \$2\.5M on Jan 13\./);
    const me = await (await call('/me?include=winter', { token })).json();
    expect(me.member.winter_preview === null || typeof me.member.winter_preview?.names === 'number').toBe(true);
    // A name followed now is read on follow (the lead, Nov 11), not by the 5-minute job filing week starves: queued, then
    // filled each minute after alert polling, at most 3 SEC requests a run, until done.
    {
      const sx = await import('../src/stockevents');
      const { secBudget } = await import('../src/edgar');
      await env.DB.delete('winter:done');
      hist.m.delete('winter/2025-26/CSGP.json');
      await env.DB.put('issuers:tickers', '[]');
      expect((await call('/follows/stocks/CSGP', { method: 'POST', token })).status).toBe(200);
      expect(JSON.parse((await env.DB.get('winter:queue'))!)).toContain('CSGP');
      const spent: number[] = [];
      for (let i = 0; i < 6 && JSON.parse((await env.DB.get('winter:queue'))!).length; i++) {
        secBudget.left = 100;
        await sx.fillWinterFollowed(env);
        spent.push(100 - secBudget.left);
      }
      const fp = (await sx.winterPreview(env, ['CSGP']))!;
      expect([spent, JSON.parse((await env.DB.get('winter:queue'))!), fp.pending, fp.insider_buys]).toEqual([[3, 2], [], [], 1]);
    }
    // A followed investor's own 13D/G last winter (Icahn's, Pzena's) comes from the published winter list, by manager.
    const orig = globalThis.fetch;
    const pub = (env as unknown as { PUBLIC_URL?: string }).PUBLIC_URL;
    (env as unknown as { PUBLIC_URL?: string }).PUBLIC_URL = 'https://pub.test/';
    index = { managers: [{ slug: 'warren-buffett', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc' }] };
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) =>
      String(u) === 'https://pub.test/winter-2025-26.json'
        ? Response.json({ insider_buys: { stocks: ['CSGP'], filings: [{ ticker: 'CSGP', form: '4', filed: '2026-01-14', transaction_date: '2026-01-13', accession: '0001628280-26-052968', owner: 'FLORANCE ANDREW C', roles: ['director'], officer_title: 'CEO', value_usd: 2_000_001 }] }, schedule_13dg: { filings: [{ manager: 'Warren Buffett', form: 'SCHEDULE 13G/A', filed: '2025-12-15', accession: '0000950170-25-000001', subject_company: 'SIRIUS XM HOLDINGS INC.', subject_cik: '0000908937', filer: 'BERKSHIRE HATHAWAY INC' }, { manager: 'Warren Buffett', form: 'SCHEDULE 13D', filed: '2025-12-20', accession: '0000950170-25-000002', subject_company: 'GENESCO INC', subject_cik: '0000018498', filer: 'BERKSHIRE HATHAWAY INC' }, { manager: 'Nobody Followed', form: 'SCHEDULE 13D', filed: '2025-12-16', accession: 'x', subject_company: 'X', subject_cik: '1', filer: 'X' }] } })
        : orig(u, init));
    try {
      const pi = (await winterPreview(env, ['CSGP'], ['warren-buffett']))!;
      // By strength (the lead, Nov 11): insider buys, then new stakes; amendments only counted. A 13D/G names the ticker
      // and the company in normal case; an insider reads first name first.
      expect([pi.insider_buys, pi.schedule_13dg, pi.amendments, pi.amendments_followed, pi.events.map((e) => [e.kind, e.who, e.ticker, e.company, e.action])]).toEqual([1, 2, 1, true, [['insider_buy', 'Andrew C. Florance', 'CSGP', null, null], ['schedule_13dg', 'Warren Buffett', 'GCO', 'Genesco Inc', 'new_stake']]]);
      const { winterLine } = await import('../src/stockevents');
      expect(winterLine(pi.events[1])).toBe('Warren Buffett filed a Schedule 13D on GCO · Genesco Inc on Dec 20');
      const d = day12Mail(env, { customer: 'cus_t', email: 't@example.com', plan: 'copy', interval: 'monthly', status: 'trialing', trial_end: Date.UTC(2026, 10, 25, 20) / 1000, has_payment_method: false } as never, 'u', Date.now(), pi);
      expect(d.text).toContain('Your 1 name had 1 insider buy and 2 13D/G filings last winter, e.g. CSGP director bought $2.5M on Jan 13; Warren Buffett filed a Schedule 13D on GCO · Genesco Inc on Dec 20; + 1 amendment by funds you follow.');
      // An investor alone, no names saved, still has a preview.
      const alone = (await winterPreview(env, [], ['warren-buffett']))!;
      expect([alone.names, alone.insider_buys, alone.schedule_13dg]).toEqual([0, 0, 2]);
      // A top-100 stock not yet read takes its Form 4 verdicts from the published list (no Form 4 is fetched): its buy
      // carries the list's figures, the other filings read 0.
      await env.DB.delete('winter:done');
      hist.m.delete('winter/2025-26/CSGP.json');
      delete secFiles['Archives/edgar/data/1057352/000162828026052968/0001628280-26-052968.txt'];
      await env.DB.put('issuers:tickers', '[]');
      for (let i = 0; i < 2; i++) await fillWinter(env, 20);
      const top = (await winterPreview(env, ['CSGP']))!;
      expect([top.pending, top.events.map((e) => [e.ticker, e.value_usd, e.date, e.url.includes('/1057352/')])]).toEqual([[], [['CSGP', 2_000_001, '2026-01-13', true]]]);
    } finally {
      vi.stubGlobal('fetch', orig);
      (env as unknown as { PUBLIC_URL?: string }).PUBLIC_URL = pub;
    }
  });

  it('GET /events: the window is on the trade date, % change is from P/S lines only (GOOGL: a Jun 29 sale filed Jul 1, gifts into his own trust)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T03:00:00Z')); // the Jul 1 window
    try {
      await hist.put('pre/sec-tickers.json', '{"GOOGL":"0001652044"}');
      secFiles['company:0001652044:4'] = `<feed><entry><category term="4"/><id>urn:tag:sec.gov,2008:accession-number=0001193125-26-292904</id><updated>2026-07-01T16:30:00-04:00</updated></entry></feed>`;
      secFiles['Archives/edgar/data/1652044/000119312526292904/0001193125-26-292904.txt'] = form4Googl;
      stripeObjects['checkout/sessions/cs_test_gg'] = { id: 'cs_test_gg', status: 'complete', created: now(), subscription: 'sub_gg', customer_details: { email: 'gg@example.com' } };
      stripeObjects['subscriptions/sub_gg'] = sub('sub_gg', 'cus_gg', 'active');
      const { token } = (await (await fullCheckout('cs_test_gg')).json()) as { token: string };
      const all = (await (await call('/events?tickers=GOOGL', { token })).json()).tickers.GOOGL.events;
      // Eight S lines in his trust on Jun 29 (8,998 shares), then 8,998 and 1,624 shares gifted from direct into the same trust:
      // -8,998 of the 103,053 Class C shares held before is -8.73%, not the +30% the trust line alone shows.
      expect(all[0]).toMatchObject({ filer_name: 'WALKER JOHN KENT', action: 'sell', trade_date: '2026-06-29', filed_date: '2026-07-01', pct_change: -8.73, exercise_and_sale: false });
      // The sale was before the window (Jul 1), though filed on it: window=quarter leaves it out.
      expect((await (await call('/events?tickers=GOOGL&window=quarter', { token })).json()).tickers.GOOGL.events).toEqual([]);
      // DASH's Tang (0001832614-26-000028): J distributions of 7,828 and 72,367 Class A shares, then 84,526 sold ($19.0M).
      // From the holding before the filing, 50,579, to 46,248 after: -8.56%, not -65%; J is listed so the UI can say "after distribution".
      await hist.put('pre/sec-tickers.json', '{"GOOGL":"0001652044","DASH":"0001792789"}');
      secFiles['company:0001792789:4'] = `<feed><entry><category term="4"/><id>urn:tag:sec.gov,2008:accession-number=0001832614-26-000028</id><updated>2026-08-24T16:05:00-04:00</updated></entry></feed>`;
      secFiles['Archives/edgar/data/1792789/000183261426000028/0001832614-26-000028.txt'] = form4Dash;
      // A 13G is in the window by its filing date: its event date (here Mar 13, the threshold crossing) can be months before.
      secFiles['company:0000908937:SCHEDULE 13'] = `<feed><entry><category term="SCHEDULE 13G/A"/><id>urn:tag:sec.gov,2008:accession-number=0000102909-26-002721</id><updated>2026-08-14T10:00:00-04:00</updated></entry></feed>`;
      secFiles['Archives/edgar/data/908937/000010290926002721/primary_doc.xml'] = sc13gSiri;
      await hist.put('pre/sec-tickers.json', '{"GOOGL":"0001652044","DASH":"0001792789","SIRI":"0000908937"}');
      const g13 = (await (await call('/events?tickers=SIRI&window=quarter', { token })).json()).tickers.SIRI.events;
      expect(g13.map((e: StockEvent) => [e.form, e.event_date, e.filed_date])).toEqual([['SCHEDULE 13G/A', '2026-03-13', '2026-08-14']]);
      const tang = (await (await call('/events?tickers=DASH&window=quarter', { token })).json()).tickers.DASH.events[0];
      expect([tang.filer_name, tang.action, tang.shares, Math.round(tang.value_usd / 1e5) / 10, tang.pct_change, tang.has_other_codes, tang.exercise_and_sale]).toEqual(['Tang Stanley', 'sell', 84526, 19, -8.56, ['J'], false]);
    } finally {
      vi.useRealTimers();
    }
    // An option exercise and a same-day sale (MA's CFO): flagged, and the % is the sale against the holding just before it.
    const l = (code: string, shares: number, ad: 'A' | 'D', derivative = false) => ({ code, security: derivative ? 'Option' : 'Common Stock', date: '2026-08-03', shares, price: 500, acquired_disposed: ad, ownership: 'direct' as const, nature: null, shares_after: null, derivative });
    const ex = withTrade({ form: '4', event_date: '2026-08-03', accepted_at: '2026-08-05T20:00:00Z', ownership: [{ security: 'Common Stock', ownership: 'direct', nature: null, shares_after: 5000, bought: 0, sold: 1000 }], transactions: [l('M', 1000, 'D', true), l('M', 1000, 'A'), l('S', 1000, 'D')] } as unknown as StockEvent);
    expect([ex.exercise_and_sale, ex.pct_change, ex.trade_date]).toEqual([true, -16.67, '2026-08-03']); // 1,000 of the 6,000 held once exercised
    // Exercised one day, sold another: not flagged.
    const apart = withTrade({ form: '4', event_date: '2026-08-03', accepted_at: '2026-08-05T20:00:00Z', ownership: [], transactions: [l('M', 1000, 'A'), { ...l('S', 1000, 'D'), date: '2026-08-04' }] } as unknown as StockEvent);
    expect(apart.exercise_and_sale).toBe(false);
  });

  it("GET /events: a ticker's own insiders' Form 4s and anyone's 13D/G, parsed once; the issuer's own Form 4s on other companies are left out", async () => {
    await hist.put('pre/sec-tickers.json', '{"BRK.A":"0001067983","BRK.B":"0001067983","CVI":"0001376139","SIRI":"0000908937"}');
    const entry = (form: string, a: string, at: string) => `<entry><category term="${form}"/><id>urn:tag:sec.gov,2008:accession-number=${a}</id><updated>${at}</updated></entry>`;
    // Berkshire's feed lists Berkshire's own Form 4 on Lennar (newest) and Ajit Jain's sale of BRK.B.
    secFiles['company:0001067983:4'] = `<feed>${entry('4', '0001193125-26-445930', '2026-11-03T21:30:04-05:00')}${entry('4', '0001728451-26-000004', '2026-09-29T17:16:08-04:00')}${entry('4', '0001193125-26-304843', '2026-07-15T16:05:00-04:00')}</feed>`;
    secFiles['Archives/edgar/data/1067983/000119312526304843/0001193125-26-304843.txt'] = form4BuffettGift;
    // Buffett's 13D/A on Berkshire Class A belongs to BRK.A, not BRK.B.
    secFiles['company:0001067983:SCHEDULE 13'] = `<feed>${entry('SCHEDULE 13D/A', '0001193125-26-304838', '2026-07-15T16:04:00-04:00')}</feed>`;
    secFiles['Archives/edgar/data/1067983/000119312526304838/primary_doc.xml'] = sc13dBrkA;
    secFiles['Archives/edgar/data/1067983/000119312526445930/0001193125-26-445930.txt'] = form4Len;
    secFiles['Archives/edgar/data/1067983/000172845126000004/0001728451-26-000004.txt'] = form4Jain;
    secFiles['company:0001376139:SCHEDULE 13'] = `<feed>${entry('SCHEDULE 13D/A', '0000921669-26-000412', '2026-11-05T16:14:03-05:00')}</feed>`;
    secFiles['Archives/edgar/data/1376139/000092166926000412/primary_doc.xml'] = cvi41;
    // A 13G's cover page uses other tags than a 13D's.
    secFiles['company:0000908937:SCHEDULE 13'] = `<feed>${entry('SCHEDULE 13G/A', '0000102909-26-002721', '2026-03-20T10:00:00-04:00')}</feed>`;
    secFiles['Archives/edgar/data/908937/000010290926002721/primary_doc.xml'] = sc13gSiri;
    let secCalls = 0;
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u).startsWith('https://www.sec.gov/')) secCalls++;
      return orig(u, init);
    });
    stripeObjects['checkout/sessions/cs_test_ev'] = { id: 'cs_test_ev', status: 'complete', created: now(), subscription: 'sub_ev', customer_details: { email: 'ev@example.com' } };
    stripeObjects['subscriptions/sub_ev'] = sub('sub_ev', 'cus_ev', 'active');
    const { token } = (await (await fullCheckout('cs_test_ev')).json()) as { token: string };
    const r = await (await call('/events?tickers=brk.b,CVI,ZZZZ,SIRI,BRK.A', { token })).json();
    expect(r.tickers['BRK.A'].events.filter((e: { form: string }) => e.form.startsWith('SCHEDULE')).map((e: { shares_after: number; percent_of_class: number }) => [e.shares_after, e.percent_of_class])).toEqual([[188290, 38.2]]);
    // Buffett's Jul 14 Form 4: converted 12M Class A-equivalent shares to B, then gave all 12M away. A gift, not a conversion; no price filed, so no value.
    const gift = r.tickers['BRK.B'].events.find((e: { accession: string }) => e.accession === '0001193125-26-304843');
    expect(gift).toMatchObject({ action: 'gift', shares: 12_000_000, value_usd: null, open_market: false, codes: ['C', 'G'], totals: { converted: { shares: 12_000_000, value_usd: null }, gifted: { shares: 12_000_000, value_usd: null } } });
    expect(gift.transactions.filter((l: { derivative: boolean }) => !l.derivative).map((l: { code: string; acquired_disposed: string }) => `${l.code}${l.acquired_disposed}`)).toEqual(['CA', 'GD', 'GD', 'GD', 'GD']);
    expect(r.tickers.SIRI.events).toEqual([expect.objectContaining({ form: 'SCHEDULE 13G/A', filer_name: 'The Vanguard Group', action: 'stake_update', shares_after: 0, percent_of_class: 0, event_date: '2026-03-13' })]);
    expect(r.unknown).toEqual(['ZZZZ']);
    expect(r.pending).toEqual([]);
    expect(r.tickers['BRK.B'].events.filter((e: { form: string }) => e.form.startsWith('SCHEDULE'))).toEqual([]);
    expect(r.tickers['BRK.B'].events.filter((e: { accession: string }) => e.accession !== '0001193125-26-304843')).toEqual([
      {
        ticker: 'BRK.B', form: '4', filer_name: 'Jain Ajit', filer_cik: '0001728451', issuer: 'BERKSHIRE HATHAWAY INC', role: 'Vice Chairman, Director', action: 'sell',
        shares: 39700, price: 503.09, value_usd: 19972776, shares_after: 67925, prev_shares_after: 107625, percent_of_class: null,
        event_date: '2026-09-28', last_transaction_date: '2026-09-28', accepted_at: '2026-09-29T21:16:08Z', accession: '0001728451-26-000004',
        // The sale was the foundation's; 317 shares are held directly.
        ownership: [
          { security: 'Class B Common Stock', ownership: 'indirect', nature: 'By Jain Foundation Inc. (Non-Profit Corporation)', shares_after: 67608, bought: 0, sold: 39700 },
          { security: 'Class B Common Stock', ownership: 'direct', nature: null, shares_after: 317, bought: 0, sold: 0 },
        ],
        codes: ['S'],
        transactions: [{ code: 'S', security: 'Class B Common Stock', date: '2026-09-28', shares: 39700, price: 503.0926, acquired_disposed: 'D', ownership: 'indirect', nature: 'By Jain Foundation Inc. (Non-Profit Corporation)', shares_after: 67608, derivative: false }],
        totals: { sold: { shares: 39700, value_usd: 19972776 } },
        open_market: true,
        // The foundation's 39,700 of the 107,625 shares held before.
        trade_date: '2026-09-28', filed_date: '2026-09-29', pct_change: -36.89, has_other_codes: [], exercise_and_sale: false,
        url: 'https://www.sec.gov/Archives/edgar/data/1067983/000172845126000004/0001728451-26-000004-index.htm',
      },
    ]);
    expect(r.tickers.CVI.events).toEqual([expect.objectContaining({ form: 'SCHEDULE 13D/A', filer_name: 'CARL C ICAHN and 2 others', action: 'stake_update', shares_after: 71201875, percent_of_class: 64.1, event_date: '2026-11-05', accepted_at: '2026-11-05T21:14:03Z' })]);
    // Fresh for 20 minutes: no EDGAR calls; after that only the feeds are re-read, nothing re-parsed.
    const first = secCalls;
    await call('/events?tickers=BRK.B,CVI', { token });
    expect(secCalls).toBe(first);
    const cached = JSON.parse(new TextDecoder().decode(hist.m.get('tev/BRK.B.json')));
    await hist.put('tev/BRK.B.json', JSON.stringify({ ...cached, checked_at: Date.now() - 21 * 60_000 }));
    await call('/events?tickers=BRK.B', { token });
    expect(secCalls).toBe(first + 2);
    expect((await call('/events?tickers=', { token })).status).toBe(400);

    // Pro: /v1/events?tickers= serves the same issuer-side rows next to the filers' own, with the lookback each feed covers.
    stripeObjects['checkout/sessions/cs_test_pv'] = { id: 'cs_test_pv', status: 'complete', created: now(), subscription: 'sub_pv', customer_details: { email: 'pv@example.com' } };
    stripeObjects['subscriptions/sub_pv'] = sub('sub_pv', 'cus_pv', 'active', 'month', 'pro_monthly');
    const pv = ((await (await fullCheckout('cs_test_pv')).json()) as { token: string }).token;
    const { key } = await (await call('/keys', { body: { name: 'q' }, token: pv })).json();
    const v1 = await (await handleRequest(new Request('https://api.test/v1/events?tickers=BRK.B,CVI&form=form4', { headers: { authorization: `Bearer ${key}` } }), env)).json();
    expect(v1.data.map((d: { accession: string }) => d.accession)).toEqual(['0001728451-26-000004', '0001193125-26-304843']);
    expect(v1.data[1].insider).toMatchObject({ codes: ['C', 'G'], open_market: false, totals: { gifted: { shares: 12_000_000, value_usd: null } } });
    expect(v1.data.slice(0, 1)).toEqual([
      expect.objectContaining({
        accession: '0001728451-26-000004', kind: 'form4', source: 'issuer', action: 'sell', event_date: '2026-09-28', last_transaction_date: '2026-09-28', filing_date: '2026-09-29', accepted_at: '2026-09-29T21:16:08Z',
        filer: { slug: null, cik: '0001728451', name: 'Jain Ajit' }, issuer: expect.objectContaining({ ticker: 'BRK.B', cik: '0001067983' }),
        insider: expect.objectContaining({ roles: ['Vice Chairman', 'Director'], ownership: expect.arrayContaining([expect.objectContaining({ ownership: 'indirect', shares_after: 67608, sold: 39700 })]) }),
      }),
    ]);
    // Precomputed: a name someone owns is refreshed on schedule, without anyone opening it.
    await putMember('own', 'own@example.com', 'active', []);
    await putFollows('own', { owned: ['CVI'], stocks: ['CVI'] });
    hist.m.delete('tev/CVI.json');
    await cron(52);
    expect(JSON.parse((await env.DB.get('issuers:tickers'))!)).toContain('CVI');
    await cron(59);
    expect(JSON.parse(new TextDecoder().decode(hist.m.get('tev/CVI.json')!)).seen['0000921669-26-000412']).toMatchObject({ percent_of_class: 64.1 });
    expect(Number(JSON.parse((await env.DB.get('issuers:checked'))!).CVI)).toBeGreaterThan(Date.now() - 60_000);
    expect(v1.coverage['BRK.B']).toMatchObject({ issuer_cik: '0001067983', form4_from: '2026-07-15T20:05:00Z', last_try: { result: 'complete' } });
    expect(v1.pending).toEqual([]);
    // A slow EDGAR (the analyst: 4 of 6 polls were 503 busy): the read passes the call's deadline, so the call answers
    // at once from the cache with the ticker pending; the read finishes after the response and is saved, so the next
    // call, EDGAR still slow, serves it with nothing pending instead of reading it again.
    hist.m.delete('tev/CVI.json');
    const fast = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => (String(u).includes('sec.gov') && (await new Promise((r) => setTimeout(r, 1700))), fast(u, init)));
    const ev = async () => {
      const t = Date.now();
      const r = await handleRequest(new Request('https://api.test/v1/events?tickers=CVI&form=13d', { headers: { authorization: `Bearer ${key}` } }), env);
      return { status: r.status, ms: Date.now() - t, pending: (await r.json()).pending };
    };
    const slow1 = await ev();
    expect([slow1.status, slow1.pending, slow1.ms < 2600]).toEqual([200, ['CVI'], true]);
    for (let i = 0; i < 100 && !hist.m.get('tev/CVI.json'); i++) await new Promise((r) => setTimeout(r, 100));
    const slow2 = await ev();
    vi.stubGlobal('fetch', fast);
    expect([slow2.status, slow2.pending, slow2.ms < 1000]).toEqual([200, [], true]);
  }, 30_000);

  it('referrals: a code per paying member; checkout applies a month free server-side; the referrer is credited a month once, after the slow1 paid invoice', async () => {
    stripeObjects['checkout/sessions/cs_test_rr'] = { id: 'cs_test_rr', status: 'complete', created: now(), subscription: 'sub_rr', customer_details: { email: 'rr@example.com' } };
    stripeObjects['subscriptions/sub_rr'] = sub('sub_rr', 'cus_rr', 'active');
    const rr = ((await (await fullCheckout('cs_test_rr')).json()) as { token: string }).token;
    const ref = (await (await call('/me', { token: rr })).json()).member.referral;
    expect(ref).toMatchObject({ code: expect.stringMatching(/^[a-z2-9]{8}$/), url: `${SITE}pricing/?ref=${ref.code}`, signups: 0, paid: 0 });
    expect((await (await call('/me', { token: rr })).json()).member.referral.code).toBe(ref.code); // stable

    const calls: { path: string; body: string }[] = [];
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (!url.startsWith('https://api.stripe.com/v1/') || (init?.method !== 'POST' && !url.includes('/prices?') && !url.includes('/coupons/'))) return orig(u, init);
      const path = url.slice('https://api.stripe.com/v1/'.length).split('?')[0];
      calls.push({ path, body: decodeURIComponent(String(init?.body ?? '')) });
      const unit: Record<string, number> = { copy_monthly: 900, copy_yearly: 7900, pro_monthly: 3900, pro_yearly: 34900 };
      if (path === 'prices') return Response.json({ data: [{ id: `price_${new URL(url).searchParams.get('lookup_keys[]')}`, unit_amount: unit[new URL(url).searchParams.get('lookup_keys[]')!] }] });
      if (path.startsWith('coupons/')) return Response.json({ error: { message: 'No such coupon' } }, { status: 404 });
      if (path === 'checkout/sessions') return Response.json({ url: 'https://checkout.stripe.com/c/pay/cs_ref' });
      return Response.json({ id: 'ok' });
    });
    const co = await (await call('/checkout', { body: { plan: 'pro', interval: 'yearly', ref: ref.code.toUpperCase(), email: 'new@example.com' } })).json();
    // Pro yearly: one month of Pro ($39) off the first year, charged after the trial.
    expect(co).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_ref', trial_days: 14, referral: { applied: true, months_free: 1, interval: 'yearly', list_usd: 349, discount_usd: 39, first_charge_usd: 310, charged_after_trial_days: 14 } });
    // Copy: the whole first month on monthly; $9 off the first year ($70) on yearly.
    expect((await (await call('/checkout', { body: { plan: 'copy', interval: 'monthly', ref: ref.code, email: 'new2@example.com' } })).json()).referral.first_charge_usd).toBe(0);
    expect((await (await call('/checkout', { body: { plan: 'copy', interval: 'yearly', ref: ref.code, email: 'new3@example.com' } })).json()).referral.first_charge_usd).toBe(70);
    // Copy's trial needs no card and is cancelled (never invoiced) if none is added; Pro still takes the card at Checkout.
    const sessions = calls.filter((c) => c.path === 'checkout/sessions').map((c) => c.body);
    expect(sessions.every((b) => /metadata\[client\]=(bot|browser|unknown)/.test(b))).toBe(true);
    const noCard = (b: string) => [b.includes('payment_method_collection=if_required'), b.includes('[missing_payment_method]=cancel')];
    expect([noCard(sessions[0]), noCard(sessions[sessions.length - 1])]).toEqual([[false, false], [true, true]]);
    const { trialEndingMail, yearlyPeakLine } = await import('../src/revenue');
    // Yearly at the peak: Berkshire's alert carries one switch line for monthly members and monthly trials only.
    const mo = { customer: 'cus_y', email: 'y@example.com', plan: 'copy', interval: 'monthly', status: 'trialing', subscription: 'sub_y' } as never;
    const brk = [{ slug: 'warren-buffett', slugs: ['warren-buffett'] }];
    // The day-12 email for a cardless Copy trial ending between seasons (plan rev 76): it just ends, nothing charged.
    const d12 = trialEndingMail(env, { customer: 'cus_t', email: 't@example.com', plan: 'copy', interval: 'monthly', status: 'trialing', trial_end: Date.UTC(2026, 10, 25, 20) / 1000, has_payment_method: false } as never, { n: 0, acc: [], owned: [], fastest: null } as never, 0, 0, 'k', 'u');
    expect([d12.subject, /nothing is charged/.test(d12.text), d12.text.includes('19 Schedule 13D/G filings') && d12.text.includes('14 open-market buys of $100K or more') && d12.text.includes("Add a card before November 25 to keep the founding price, $9/month or $79/year, for as long as you stay. If the trial ends and you rejoin from Feb 1, it's $12/month or $99/year.") && !/new members/.test(d12.text), /\b13 insider/.test(d12.text), /Pause once a year, up to 3 months/.test(d12.text), /months free/.test(d12.text)]).toEqual(['Your Copy trial ends Wednesday', true, true, false, true, false]);
    const yl = await yearlyPeakLine(env, mo, brk);
    expect([/^Switch to yearly at your founding price: \$79\/yr, locked, with history back to 2013 \(from Dec 31\)\. Switch now: \S+\/keep\?t=\S+$/.test(yl ?? ''), await yearlyPeakLine(env, { ...(mo as object), interval: 'yearly' } as never, brk), await yearlyPeakLine(env, mo, [{ slug: 'bill-ackman' }])]).toEqual([true, null, null]);
    // A cardless trial's line adds a card on yearly, and its link opens that choice signed in (a GET changes nothing).
    const cardless = await yearlyPeakLine(env, { ...(mo as object), has_payment_method: false, trial_end: Date.UTC(2026, 10, 25, 20) / 1000 } as never, brk);
    expect(/^Keep Copy at the founding price: add a card before November 25\. Yearly \$79 or \$9\/month\. Add card: \S+\/keep\?t=\S+$/.test(cardless ?? '')).toBe(true);
    await env.DB.put('cus:cus_y', JSON.stringify({ ...(mo as object), has_payment_method: false }));
    const kept = await handleRequest(new Request(cardless!.split('Add card: ')[1].replace(/^\S+?\/keep/, 'https://api.test/keep')), env);
    expect(/account\/\?add_card=yearly&login=/.test(kept.headers.get('location') ?? '')).toBe(true);
    const tm = (card: boolean) => trialEndingMail(env, { customer: 'cus_t', email: 't@example.com', plan: 'copy', interval: 'monthly', status: 'trialing', trial_end: Math.floor(Date.now() / 1000) + 2 * 86400, has_payment_method: card } as never, { n: 0, acc: [], owned: [], fastest: null } as never, 1, 0, 'https://api.test/keep?t=x', 'https://api.test/unsubscribe?t=x', 2);
    expect([/add a card/i.test(tm(false).subject), /nothing is charged/.test(tm(false).text), /renews on/.test(tm(false).text), /add a card/i.test(tm(true).subject), /renews on/.test(tm(true).text)]).toEqual([true, true, false, false, true]);
    expect(calls.find((c) => c.path === 'coupons')!.body).toContain('amount_off=3900'); // a month of Pro, off the first year
    const cs = calls.find((c) => c.path === 'checkout/sessions')!.body;
    expect(cs).toContain('discounts[0][coupon]=copybook-ref-pro-1mo');
    expect(cs).toContain(`subscription_data[metadata][ref]=${ref.code}`);
    expect(cs).toContain('subscription_data[trial_period_days]=14');
    expect(cs).toContain('line_items[0][price]=price_pro_yearly');
    // A paying member's address (here the referrer's own) gets no referral month.
    calls.length = 0;
    expect((await (await call('/checkout', { body: { plan: 'copy', interval: 'monthly', ref: ref.code, email: 'rr@example.com' } })).json()).referral).toEqual({ applied: false });
    // One free trial per person (the lead, Nov 11): an address that has had a subscription gets plain checkout.
    const rb = calls.find((c) => c.path === 'checkout/sessions')!.body;
    expect([rb.includes('discounts'), rb.includes('trial_period_days'), rb.includes('payment_method_collection=if_required'), rb.includes('metadata[returning]=true')]).toEqual([false, false, false, true]);
    expect((await call('/checkout', { body: { plan: 'gold', interval: 'monthly' } })).status).toBe(400);
    // The visitor's first touch and landing page ride on the session; our own checks are tagged test (the lead).
    calls.length = 0;
    await call('/checkout', { body: { plan: 'copy', interval: 'monthly', utm_source: 'x', utm_content: 'seed-season', landing: '/season/' } });
    await call('/checkout', { body: { plan: 'copy', interval: 'monthly', email: 'copybook-test-sweep@example.com' } });
    await call('/checkout', { body: { plan: 'fund', interval: 'yearly', test: true } });
    const bodies = calls.filter((c) => c.path === 'checkout/sessions').map((c) => c.body);
    expect([bodies[0].includes('metadata[utm_content]=seed-season'), bodies[0].includes('metadata[landing]=/season/'), bodies[0].includes('metadata[test]'), bodies[1].includes('metadata[test]=true'), bodies[2].includes('metadata[test]=true')]).toEqual([true, true, false, true, true]);

    // The referred subscription arrives: counted as a signup for the referrer, no credit yet.
    stripeObjects['customers/cus_nw'] = { id: 'cus_nw', email: 'new@example.com' };
    await webhook({ type: 'customer.subscription.created', data: { object: { ...sub('sub_nw', 'cus_nw', 'trialing', 'year', 'pro_yearly'), metadata: { ref: ref.code, source: 'referral' } } } });
    expect(JSON.parse((await env.DB.get('cus:cus_nw'))!)).toMatchObject({ referred_by: ref.code, source: 'referral' });
    expect((await (await call('/me', { token: rr })).json()).member.referral).toMatchObject({ signups: 1, paid: 0 });
    calls.length = 0;
    sent = [];
    stripeObjects['prices/price_pro_yearly'] = { id: 'price_pro_yearly', lookup_key: 'pro_yearly', metadata: { copybook: 'pro' } }; // invoice lines name the price by id
    await webhook({ type: 'invoice.paid', data: { object: { customer: 'cus_nw', lines: { data: [{ pricing: { price_details: { price: 'price_pro_yearly' } } }] }, amount_paid: 0 } } }); // the trial's $0 invoice
    expect(calls).toHaveLength(0);
    // The first paid invoice: one month of the referrer's own plan (Copy, $9) as a balance credit, once.
    await webhook({ type: 'invoice.paid', data: { object: { customer: 'cus_nw', lines: { data: [{ pricing: { price_details: { price: 'price_pro_yearly' } } }] }, amount_paid: 35100 } } });
    await webhook({ type: 'invoice.paid', data: { object: { customer: 'cus_nw', lines: { data: [{ pricing: { price_details: { price: 'price_pro_yearly' } } }] }, amount_paid: 35100 } } });
    expect(calls.map((c) => [c.path, c.body.match(/amount=(-?\d+)/)?.[1]])).toEqual([['customers/cus_rr/balance_transactions', '-900']]);
    expect(sent.map((m) => [m.to[0], m.subject])).toEqual([['rr@example.com', 'You earned a free month of Copy']]);
    expect((await (await call('/me', { token: rr })).json()).member.referral).toMatchObject({ signups: 1, paid: 1, months_earned: 1 });
    vi.stubGlobal('fetch', orig);
  });

  it('POST /upgrade: Copy yearly gets a portal confirm page for Pro yearly on the same subscription item; Pro and bad plans are refused', async () => {
    const session = async (c: string, lookup: string, interval = 'month') => {
      stripeObjects[`checkout/sessions/cs_test_${c}`] = { id: `cs_test_${c}`, status: 'complete', created: now(), subscription: `sub_${c}`, customer_details: { email: `${c}@example.com` } };
      const s = sub(`sub_${c}`, `cus_${c}`, 'active', interval, lookup);
      s.items.data[0] = { ...s.items.data[0], id: `si_${c}` } as (typeof s.items.data)[0];
      stripeObjects[`subscriptions/sub_${c}`] = s;
      return ((await (await fullCheckout(`cs_test_${c}`)).json()) as { token: string }).token;
    };
    const copy = await session('cu', 'copy_yearly', 'year');
    const pro = await session('pu', 'pro_monthly');
    let portal = '';
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.startsWith('https://api.stripe.com/v1/prices?')) {
        const key = new URL(url).searchParams.get('lookup_keys[]');
        return Response.json({ data: [{ id: `price_${key}`, lookup_key: key }] });
      }
      if (url.includes('billing_portal/sessions')) portal = decodeURIComponent(String(init?.body));
      return orig(u, init);
    });
    const r = await call('/upgrade', { body: { plan: 'pro' }, token: copy });
    expect(r.status).toBe(200);
    expect((await r.json()).url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    // The yearly Copy member is offered yearly Pro (not monthly), on its existing item, so no second subscription.
    expect(portal).toContain('flow_data[type]=subscription_update_confirm');
    expect(portal).toContain('flow_data[subscription_update_confirm][subscription]=sub_cu');
    expect(portal).toContain('flow_data[subscription_update_confirm][items][0][id]=si_cu');
    expect(portal).toContain('flow_data[subscription_update_confirm][items][0][price]=price_pro_yearly');
    expect(portal).toContain(`flow_data[after_completion][redirect][return_url]=${env.SITE_URL}account/?upgraded=pro`);
    portal = '';
    expect(await (await call('/upgrade', { body: { plan: 'pro' }, token: pro })).json()).toMatchObject({ code: 'already_on_plan' });
    expect((await call('/upgrade', { body: { plan: 'copy' }, token: copy })).status).toBe(400);
    await call('/upgrade', { body: { plan: 'fund' }, token: pro });
    expect(portal).toContain('[price]=price_fund_monthly');
  });

  it('Copy Pro: keys only for Pro, shown once, /v1 needs an active Pro key, rate limits with standard headers, revoke works', async () => {
    let clock = Date.parse('2026-11-09T15:00:10Z');
    env.METER = memMeters(() => clock);
    const session = async (c: string, lookup: string, interval = 'month') => {
      stripeObjects[`checkout/sessions/cs_test_${c}`] = { id: `cs_test_${c}`, status: 'complete', created: now(), subscription: `sub_${c}`, customer_details: { email: `${c}@example.com` } };
      stripeObjects[`subscriptions/sub_${c}`] = sub(`sub_${c}`, `cus_${c}`, 'active', interval, lookup);
      return (await (await fullCheckout(`cs_test_${c}`)).json()) as { token: string; member: { plan: string } };
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

    // 60 a minute per account, across its keys (the lead: never 10x with 10 keys): the 2nd call above was #1, so 59
    // more pass, then 429 with Retry-After until the minute rolls, on every key of the account.
    const second = await (await call('/keys', { body: { name: 'second' }, token: pro.token })).json();
    for (let i = 0; i < 57; i++) expect((await v1('/v1/me', made.key)).status).toBe(200);
    expect((await v1('/v1/me', second.key)).status).toBe(200);
    const last = await v1('/v1/me', made.key);
    expect(last.headers.get('RateLimit-Limit')).toBe('60');
    expect(last.headers.get('RateLimit-Remaining')).toBe('0');
    const limited = await v1('/v1/me', made.key);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatchObject({ code: 'rate_limited', scope: 'account', window: 'minute', limit: 60, retry_after_seconds: 50 });
    expect(limited.headers.get('Retry-After')).toBe('50');
    const other = await v1('/v1/me', second.key);
    expect([other.status, (await other.json()).error.scope]).toEqual([429, 'account']);
    // A Fund seat has its own: the Fund owner's key is not limited by the Pro account's use.
    const fundKey = await (await call('/keys', { body: { name: 'fund' }, token: fund.token })).json();
    expect((await v1('/v1/me', fundKey.key)).status).toBe(200);
    clock += 60_000;
    const next = await v1('/v1/me', made.key);
    expect(next.status).toBe(200);
    const nextBody = await next.json();
    expect(nextBody.data.usage[0]).toEqual({ day: '2026-11-09', requests: 60 }); // this key's own allowed requests
    expect(nextBody.data.key.last_used_at).toBe('2026-11-09T15:01:10Z');
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
    // Timed for /latency like a curated manager's, tagged as any filer's.
    expect(JSON.parse((await env.DB.get('alerts:latency'))!).find((l: { accession: string }) => l.accession === sa)).toMatchObject({ coverage: 'any_filer', slug: 'situational-awareness-lp-5724' });
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
    // A $581K new name (<0.1% of book) isn't headline news: the biggest trades by dollars lead.
    expect(m.subject).toBe('Buffett Q2: GOOGL +$8.8B · BAC -$1.7B · COF -$832.6M');
    expect(m.text).toContain('Bought $19.2B, sold $4.1B this quarter.');
    expect(m.text).toContain('Added: GOOGL +$8.8B (+45% shares, 2.9% of book)');
    // A trim that leaves a sliver says ">99%"; a 10x add reads as share counts; a truncated name loses " in".
    const r2 = (o: Record<string, unknown>) => ({ display_name: null, put_call: null, cusip: 'X', value: 1e8, delta_pct_of_book: 0.01, ...o });
    const fisher = { ...a, manager: 'Fisher Asset Management', moves: { bought_usd: 5e9, sold_usd: 4e9, new: [r2({ ticker: 'FCOM', issuer: 'FCOM', shares: 10, prev_shares: 0, value_delta: 56.9e6, delta_pct_of_book: 0.0002 }), r2({ ticker: null, issuer: 'CRINETICS PHARMACEUTICALS IN', display_name: 'Crinetics Pharmaceuticals in', shares: 10, prev_shares: 0, value_delta: 13.6e6, delta_pct_of_book: 0.00005 })], added: [r2({ ticker: 'TLT', issuer: 'TLT', shares: 59.2e6, prev_shares: 44294, value_delta: 4.6e9 })], trimmed: [r2({ ticker: 'IEF', issuer: 'IEF', shares: 9e6, prev_shares: 12e6, value_delta: -3.1e9 }), r2({ ticker: 'IEX', issuer: 'IEX', shares: 1553, prev_shares: 748815, value_delta: -150e6 })], exited: [r2({ ticker: 'FN', issuer: 'FN', shares: 0, prev_shares: 10, value_delta: -66.3e6, delta_pct_of_book: -0.0002 })] } };
    const fm = alertMail(env, 'x@example.com', [fisher as never], [], { investors: [], stocks: [], owned: [] } as never);
    expect(fm.subject).toBe('Fisher Asset Management Q2: TLT +$4.6B · IEF -$3.1B · IEX -$150.0M');
    expect(fm.text).toContain('TLT +$4.6B (44K → 59.2M sh');
    expect(fm.text).toContain('IEX -$150.0M (sold >99% of the position');
    expect(fm.text).toContain('Crinetics Pharmaceuticals +$13.6M');
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
    const t = (await (await fullCheckout('cs_test_c')).json()).token;
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
    // Peers and linked books need a prior quarter too: after the hourly run they're on the list (non-curated only).
    filers.push({ cik: '0001387322', name: 'Whale Rock Capital Management LLC', slug: 'whale-rock-capital-management-llc-7322', ok: true, quarter: '2026Q2' });
    await putMember('p', 'pm@example.com', 'active', []);
    await putFollows('p', { peers: ['whale-rock-capital-management-llc-7322', 'warren-buffett'], book: { cik: '0001541617', name: 'Altimeter', quarter: '2026Q2', tickers: [] } });
    await putMember('p2', 'pm2@example.com', 'active', []);
    await putFollows('p2', { book: { cik: '0001067983', name: 'Berkshire', quarter: '2026Q2', tickers: [] } });
    await cron(52);
    expect(JSON.parse(new TextDecoder().decode(hist.m.get('followed/ciks.json'))).ciks).toEqual(['0001387322', '0001541617', '0001798849']);
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
    const handed = await s.json();
    expect([handed.session, handed.member]).toMatchObject(['provisional', { plan: 'holdterm', active: true }]);
    // The welcome comes from Holdterm, with a Holdterm sign-in link, and never names Copybook.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'Holdterm <holdterm@factordynamics.com>', subject: 'Holdterm alerts are on' });
    expect(sent[0].text).toContain('https://holdterm.pages.dev/account?login=');
    expect(JSON.stringify(sent[0])).not.toMatch(/copybook/i);
    // Signed in by the welcome's link: a full session.
    const token = (await (await call('/session', { body: { login: decodeURIComponent(sent[0].text.match(/account\?login=([^\s]+)/)![1]) } })).json()).token as string;
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
    // Holdterm names the firm, never the person: "Berkshire Hathaway SIRI Form 4", not "Buffett".
    expect(mail.subject).toBe('Berkshire Hathaway bought $25K of SIRI + 2 more');
    expect(mail.text).not.toMatch(/Buffett/i);
    // Holdterm's designed email (alert-render.ts htEmail, what /alerts previews), with its plain-text alternative.
    expect(mail.text).toContain('Manage alerts: https://holdterm.pages.dev/account\nFrom SEC EDGAR filings, as filed. Not investment advice.');
    expect([mail.html?.includes('<title>Holdterm</title>'), mail.html?.includes('<pre')]).toEqual([true, false]);
    // A 13F links the fund by its public slug, no redirect hop (bill-ackman -> pershing-square).
    const { holdtermAlertMail } = await import('../src/email');
    const f13 = holdtermAlertMail({ ...env, HOLDTERM_SITE_URL: 'https://holdterm.pages.dev/' } as Env, 'ht@example.com', [{ slug: 'bill-ackman', slugs: ['bill-ackman'], manager: 'Bill Ackman', name: 'Pershing Square Capital Management, L.P.', quarter: '2026Q3', report_date: '2026-09-30', filing_date: '2026-11-13', accession: '0001336528-26-000099', sec_url: 'https://www.sec.gov/x', tickers: [], moves: null } as never], []);
    expect([f13.text.includes('https://holdterm.pages.dev/m/pershing-square'), f13.text.includes('/m/bill-ackman'), /Ackman/.test(f13.subject)]).toEqual([true, false, false]);
    expect(JSON.stringify(mail)).not.toMatch(/copybook/i);
  });

  it('delivery channels: Discord, Slack, Telegram and a revocable private feed for Copy; signed webhooks with retry for Pro', async () => {
    const session = async (id: string, plan?: string) => {
      stripeObjects[`checkout/sessions/cs_test_${id}`] = { id: `cs_test_${id}`, status: 'complete', created: now(), subscription: `sub_${id}`, customer_details: { email: `${id}@example.com` } };
      stripeObjects[`subscriptions/sub_${id}`] = plan ? sub(`sub_${id}`, `cus_${id}`, 'active', 'month', plan) : sub(`sub_${id}`, `cus_${id}`, 'active');
      return (await (await fullCheckout(`cs_test_${id}`)).json()).token as string;
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
    expect(set.channels).toMatchObject({ slack: 'https://hooks.slack.com/…mnop', telegram: { chat_id: '-1001234' }, webhook: null, webhook_available: false, verified: ['discord', 'slack', 'telegram'] });
    // Save checked each for real: Telegram's token (getMe), then a "Connected" message to every destination.
    expect(posts.map((p) => (p.url.includes('telegram') ? `api.telegram.org/${p.url.split('/').at(-1)}` : new URL(p.url).hostname))).toEqual(['discord.com', 'hooks.slack.com', 'api.telegram.org/getMe', 'api.telegram.org/sendMessage']);
    expect(JSON.parse(posts[1].body).text).toMatch(/^Connected ✓ to Copybook/);
    posts = [];
    // A bad token is refused with what to check; no chat id: read from the bot's latest message, else asked for.
    chatReplies = { 'api.telegram.org': [{ status: 401, body: { ok: false } }] };
    expect(await (await req(copy, 'PUT', '/channels', { telegram: { bot_token: '123456789:AAbbccddeeffgghhiijjkkllmmnnoopp', chat_id: '-1001234' } })).json()).toMatchObject({ code: 'telegram_token', error: 'Check the token from @BotFather' });
    chatReplies = { 'api.telegram.org': [{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true, result: [{ message: { chat: { id: 555 } } }, { message: { chat: { id: 777 } } }] } }] };
    expect((await (await req(copy, 'PUT', '/channels', { telegram: { bot_token: '123456789:AAbbccddeeffgghhiijjkkllmmnnoopp' } })).json()).channels.telegram).toEqual({ chat_id: '777' });
    chatReplies = { 'api.telegram.org': [{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true, result: [] } }] };
    expect((await (await req(copy, 'PUT', '/channels', { telegram: { bot_token: '123456789:AAbbccddeeffgghhiijjkkllmmnnoopp' } })).json()).code).toBe('telegram_chat_needed');
    chatReplies = {};
    await req(copy, 'PUT', '/channels', { telegram: { bot_token: '123456789:AAbbccddeeffgghhiijjkkllmmnnoopp', chat_id: '-1001234' } });
    posts = [];
    // The checklist's "Keep email" choice is the member's, not the browser's.
    expect(set.channels.keep_email).toBe(false);
    expect((await req(copy, 'PUT', '/channels', { keep_email: 'yes' })).status).toBe(400);
    await req(copy, 'PUT', '/channels', { keep_email: true });
    expect((await (await req(copy, 'GET', '/channels')).json()).channels).toMatchObject({ keep_email: true, slack: 'https://hooks.slack.com/…mnop' });
    const feedUrls = (await (await req(copy, 'POST', '/channels/feed')).json()).channels.feed;
    expect(feedUrls.json_url).toMatch(/^https:\/\/api\.test\/feed\/[\w-]{30,}\.json$/);
    // Feed URLs live in readers: they never take the request's (possibly ephemeral) entry point.
    const viaTunnel = await (await handleRequest(new Request('https://api.test/channels', { headers: { origin: 'https://refcell.github.io', authorization: `Bearer ${copy}`, 'x-copybook-public-base': 'https://solid-amanda-dir-fiction.trycloudflare.com/copybook' } }), env)).json();
    expect(viaTunnel.channels.feed.json_url).toBe(feedUrls.json_url);
    const hook = await (await req(pro, 'PUT', '/channels', { webhook: 'https://hooks.example.com/cb' })).json();
    const secret = hook.channels.webhook.secret as string;
    // A webhook pins the summed share-class moves until Feb 22, 2027 (the lead, Nov 11); the pin survives a URL change.
    expect((await req(pro, 'PUT', '/channels', { webhook_schema_version: '2026-11-23' })).status).toBe(400);
    expect((await (await req(pro, 'PUT', '/channels', { webhook_schema_version: '2026-11-09' })).json()).channels.webhook.schema_version).toBe('2026-11-09');
    expect((await (await req(pro, 'PUT', '/channels', { webhook: 'https://hooks.example.com/cb' })).json()).channels.webhook.schema_version).toBe('2026-11-09');
    expect((await (await req(pro, 'PUT', '/channels', { webhook_schema_version: null })).json()).channels.webhook.schema_version).toBeNull();
    expect(secret).toMatch(/^whsec_/);
    await putFollows('cus_chan', { investors: ['warren-buffett'] });
    await putFollows('cus_hook', { investors: ['warren-buffett'] });

    const today = new Date().toISOString().slice(0, 10);
    const ev = (id: string) => ({ id, slug: 'warren-buffett', manager: 'Warren Buffett', form: '4', kind: 'form4', action: 'buy', filing_date: today, url: `https://www.sec.gov/${id}`, issuer: 'SIRIUS XM', display_name: null, ticker: 'SIRI', shares: 1000, value_usd: 25000, avg_price: 25, shares_after: null, percent_of_class: null, accepted: new Date(Date.now() - 120_000).toISOString() });
    events = [ev('seed')];
    await cron(47);
    hookStatus = 500; // the Pro endpoint is down at first
    events = [ev('seed'), ev('C1')];
    await cron(47);
    const by = (host: string) => posts.filter((p) => p.url.includes(host));
    expect(JSON.parse(by('hooks.slack.com')[0].body).text).toContain('Buffett SIRI Form 4: bought $25K');
    // The SEC link is in <…> so Discord doesn't unfurl it.
    expect(JSON.parse(by('discord.com')[0].body).content).toContain('<https://www.sec.gov/C1>');
    expect(by('api.telegram.org')[0].url).toBe('https://api.telegram.org/bot123456789:AAbbccddeeffgghhiijjkkllmmnnoopp/sendMessage');
    expect(JSON.parse(by('api.telegram.org')[0].body)).toMatchObject({ chat_id: '-1001234' });
    // Each channel's first successful post is timed for /latency; the failed webhook isn't.
    const timed = JSON.parse((await env.DB.get('alerts:latency:ch'))!) as { channel: string; accession: string; seconds: number }[];
    expect(timed.filter((x) => x.accession === 'C1').map((x) => x.channel).sort()).toEqual(['discord', 'feed', 'slack', 'telegram']);
    expect(timed.every((x) => x.seconds >= 90 && x.seconds < 200)).toBe(true);
    // The webhook is signed: t=<seconds>,v1=HMAC(secret, "<t>.<body>").
    const first = by('hooks.example.com')[0];
    const [, t, v1] = first.headers['copybook-signature'].match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    expect(v1).toBe(await hmacHex(secret, `${t}.${first.body}`));
    expect(JSON.parse(first.body)).toMatchObject({ type: 'form4', accession: 'C1', filer: { slug: 'warren-buffett' }, ticker: 'SIRI' });
    expect(JSON.parse(first.body).detected_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
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
    expect(jf.items[0].sent_at).toBeTruthy();
    // HTML too, so phone readers keep the lines apart: a paragraph per block, a <br> per line, links clickable, names escaped.
    const lines = jf.items[0].content_text.split('\n').filter((l: string) => l.trim()).length;
    expect([jf.items[0].content_html.startsWith('<p>'), jf.items[0].content_html.split('<br>').length >= lines - jf.items[0].content_text.split(/\n{2,}/).length + 1, /<a href="https:\/\//.test(jf.items[0].content_html), /<(?!\/?(p|br|a)\b)/.test(jf.items[0].content_html)]).toEqual([true, true, true, false]);
    expect(rss).toContain(`<description><![CDATA[${jf.items[0].content_html}]]></description>`);
    // "Rotate feed link": a new URL that works at once, and the old one is dead at once.
    const rotated = (await (await req(copy, 'POST', '/channels/feed')).json()).channels.feed;
    expect(rotated.json_url).not.toBe(feedUrls.json_url);
    expect((await handleRequest(new Request(feedUrls.json_url), env)).status).toBe(404);
    expect((await handleRequest(new Request(feedUrls.rss_url), env)).status).toBe(404);
    expect((await handleRequest(new Request(rotated.json_url), env)).status).toBe(200);
    await req(copy, 'DELETE', '/channels/feed');
    expect((await handleRequest(new Request(rotated.json_url), env)).status).toBe(404);

    // Chat failures. Discord asks to wait 150 s (429), Slack answers 500 every time, Telegram's bot was removed (404).
    // keep_email (set above): the email goes too. Without it, a working chat destination replaces email.
    expect(sent.some((m) => m.to[0] === 'chan@example.com' && /SIRI/.test(m.subject))).toBe(true);
    await req(copy, 'PUT', '/channels', { keep_email: false });
    sent = [];
    posts = [];
    events = [ev('seed'), ev('C1'), ev('C1x')];
    await cron(47);
    expect(by('hooks.slack.com')).toHaveLength(1);
    expect(sent.filter((m) => m.to[0] === 'chan@example.com' && /SIRI/.test(m.subject))).toEqual([]);
    // "Send a test" then tests the chats only, with a real alert, and says so up front (test_sends).
    expect((await (await req(copy, 'GET', '/channels')).json()).channels.test_sends).toEqual(['discord', 'slack', 'telegram']);
    const tr = (await (await req(copy, 'POST', '/channels/test')).json()).results;
    expect([tr.email, Object.keys(tr).sort()]).toEqual([undefined, ['discord', 'slack', 'telegram']]);
    expect(JSON.parse(by('hooks.slack.com').at(-1)!.body).text).toMatch(/^Copybook test, with your latest alert:\n.*SIRI/);
    await req(copy, 'PUT', '/channels', { keep_email: true });
    // The test email carries the same real sample: the latest alert in subject and body, not a placeholder.
    sent = [];
    await req(copy, 'POST', '/channels/test');
    const te = sent.find((m) => m.to[0] === 'chan@example.com')!;
    expect(te.subject).toMatch(/^Copybook test: .*SIRI/);
    expect(te.text).toMatch(/Your latest alert, as it would arrive:\n\n.*SIRI/);
    const at47 = new Date();
    // Not hour 3 (the digest job's), and the hour of replays below must stay in today's ET day (it ends at 05:00 UTC) for the feed seed.
    at47.setUTCHours([3, 4].includes(at47.getUTCHours()) ? 2 : at47.getUTCHours(), 47, 0, 0);
    const minute = (n: number) => cron(0, at47.getTime() + n * 60_000);
    chatReplies = { 'discord.com': [{ status: 429, body: { retry_after: 150, global: false } }], 'hooks.slack.com': Array(4).fill({ status: 500 }), 'api.telegram.org': [{ status: 404, body: { ok: false } }] };
    posts = [];
    sent = [];
    events = [ev('seed'), ev('C1'), ev('C2')];
    await minute(0); // the events job (minute 47), on the same clock as the retries below
    const stopped = () => sent.filter((m) => m.to[0] === 'chan@example.com' && /alerts stopped/.test(m.subject)).map((m) => m.subject);
    // The email alert still goes out; Telegram is flagged at once with one notice; the others wait to retry.
    expect(sent.some((m) => m.to[0] === 'chan@example.com' && /SIRI/.test(m.subject))).toBe(true);
    expect(stopped()).toEqual(['Your Telegram alerts stopped: the webhook or chat no longer exists (HTTP 404)']);
    await minute(1); // Slack's first retry (500 again); Discord's wait isn't over
    expect(by('discord.com')).toHaveLength(1);
    expect(by('hooks.slack.com')).toHaveLength(2);
    await minute(3); // past Discord's 150 s: delivered
    expect(by('discord.com')).toHaveLength(2);
    await minute(6); // Slack's second retry
    await minute(21); // the third and last: Slack is flagged, once
    expect(by('hooks.slack.com')).toHaveLength(4);
    expect(stopped()).toEqual(['Your Telegram alerts stopped: the webhook or chat no longer exists (HTTP 404)', 'Your Slack alerts stopped: HTTP 500 after 4 tries']);
    await minute(40);
    expect(by('hooks.slack.com')).toHaveLength(4);
    const failing = (await (await req(copy, 'GET', '/me')).json()).member.channels_failing;
    expect(Object.keys(failing).sort()).toEqual(['slack', 'telegram']);
    expect((await (await req(copy, 'GET', '/channels')).json()).channels.failing.slack).toMatchObject({ reason: 'HTTP 500 after 4 tries' });
    // The next alert: Telegram still answers 404 but no second notice; Slack works again and its flag clears.
    chatReplies = { 'api.telegram.org': [{ status: 404 }] };
    events = [ev('seed'), ev('C1'), ev('C2'), ev('C3')];
    await minute(60);
    expect(by('api.telegram.org').length).toBeGreaterThan(1);
    expect(stopped()).toHaveLength(2);
    expect(Object.keys((await (await req(copy, 'GET', '/me')).json()).member.channels_failing)).toEqual(['telegram']);
    // So does a test that goes through.
    expect((await (await req(copy, 'POST', '/channels/test')).json()).results).toMatchObject({ slack: '200', telegram: '200', discord: '200' });
    expect((await (await req(copy, 'GET', '/me')).json()).member.channels_failing).toEqual({});
    // A test that shows a destination is gone flags it at once, in plain words; the email waits for a real alert.
    chatReplies = { 'discord.com': [{ status: 404 }] };
    sent = [];
    const t404 = await (await req(copy, 'POST', '/channels/test')).json();
    expect(t404.messages).toMatchObject({ discord: 'Discord rejected this webhook (deleted or wrong URL)', slack: 'Delivered' });
    expect(Object.keys((await (await req(copy, 'GET', '/me')).json()).member.channels_failing)).toEqual(['discord']);
    expect(sent.map((m) => m.subject)).toEqual(['Copybook test: Buffett SIRI Form 4: bought $25K']); // the test email, no failure notice
    await req(copy, 'POST', '/channels/test');
    expect((await (await req(copy, 'GET', '/me')).json()).member.channels_failing).toEqual({});

    // A new feed starts with the member's recent alerts (sent time included); "Send a test" writes to it.
    const beforeFeed = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const feed2 = (await (await req(copy, 'POST', '/channels/feed')).json()).channels.feed;
    let items = (await (await handleRequest(new Request(feed2.json_url), env)).json()).items;
    // Seeded items keep when they were sent, not the feed's creation time (in RSS pubDate too).
    const afterFeed = new Date().toISOString();
    expect(items.filter((i: { sent_at: string }) => i.sent_at >= beforeFeed && i.sent_at <= afterFeed)).toEqual([]);
    const feedRes = await handleRequest(new Request(feed2.rss_url), env);
    expect(feedRes.headers.get('cache-control')).toBe('no-store');
    expect(items.map((i: { id: string }) => i.id).sort()).toEqual(['C1', 'C1x', 'C2', 'C3']);
    expect(items.every((i: { sent_at: string | null }) => !!i.sent_at)).toBe(true);
    await req(copy, 'PUT', '/channels', { slack: null, discord: null, telegram: null });
    // With a feed, the test still emails: every alert goes by email too.
    expect((await (await req(copy, 'POST', '/channels/test')).json()).results).toEqual({ feed: 'ok', email: '200' });
    items = (await (await handleRequest(new Request(feed2.json_url), env)).json()).items;
    // It links to the latest alert's page (the filing's card or the investor), not the home page.
    expect([items[0].title, items[0].url === items[1].url, items[0].url === 'https://refcell.github.io/gust/copybook/']).toEqual(['Copybook test', true, false]);
  });

  it("Telegram contract, against the Bot API's documented responses (getMe, getUpdates, sendMessage; 401, 403, 400): Save, a blocked bot, and alerts as valid Telegram HTML", async () => {
    stripeObjects['checkout/sessions/cs_test_tgc'] = { id: 'cs_test_tgc', status: 'complete', created: now(), subscription: 'sub_tgc', customer_details: { email: 'tgc@example.com' } };
    stripeObjects['subscriptions/sub_tgc'] = sub('sub_tgc', 'cus_tgc', 'active');
    const t = (await (await fullCheckout('cs_test_tgc')).json()).token as string;
    const req = (method: string, path: string, b?: unknown) => handleRequest(new Request(`https://api.test${path}`, { method, body: b ? JSON.stringify(b) : undefined, headers: { origin: 'https://refcell.github.io', authorization: `Bearer ${t}` } }), env);
    const TOKEN = '123456789:AAbbccddeeffgghhiijjkkllmmnnoopp';
    // Response bodies as https://core.telegram.org/bots/api documents them.
    const me = { ok: true, result: { id: 123456789, is_bot: true, first_name: 'Copybook alerts', username: 'copybook_alerts_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } };
    const updates = { ok: true, result: [{ update_id: 873451201, message: { message_id: 1, from: { id: 424242, is_bot: false, first_name: 'Ann', language_code: 'en' }, chat: { id: 424242, first_name: 'Ann', type: 'private' }, date: 1762862400, text: '/start', entities: [{ offset: 0, length: 6, type: 'bot_command' }] } }] };
    const sentOk = { ok: true, result: { message_id: 2, from: me.result, chat: { id: 424242, first_name: 'Ann', type: 'private' }, date: 1762862401, text: 'Connected' } };
    const err = (code: number, description: string) => ({ status: code, body: { ok: false, error_code: code, description } });
    const tg = () => posts.filter((p) => p.url.startsWith('https://api.telegram.org/'));

    // Save with no chat id: the token (getMe), the chat from the bot's latest update (getUpdates), then "Connected ✓" there.
    posts = [];
    chatReplies = { 'api.telegram.org': [{ status: 200, body: me }, { status: 200, body: updates }, { status: 200, body: sentOk }] };
    const saved = await (await req('PUT', '/channels', { telegram: { bot_token: TOKEN } })).json();
    expect(saved.channels).toMatchObject({ telegram: { chat_id: '424242' }, verified: ['telegram'] });
    expect(tg().map((p) => p.url.split('/').at(-1))).toEqual(['getMe', 'getUpdates', 'sendMessage']);
    expect(JSON.parse(tg()[2].body)).toMatchObject({ chat_id: '424242', parse_mode: 'HTML', disable_web_page_preview: true });
    expect(JSON.parse(tg()[2].body).text).toMatch(/^Connected ✓ to Copybook/);
    // 401 Unauthorized (a bad or revoked token): refused, with what to check; the working chat stays.
    chatReplies = { 'api.telegram.org': [err(401, 'Unauthorized')] };
    expect(await (await req('PUT', '/channels', { telegram: { bot_token: TOKEN, chat_id: '424242' } })).json()).toMatchObject({ ok: false, code: 'telegram_token', error: 'Check the token from @BotFather' });
    // 400 chat not found (HTML, then the plain-text fallback): refused in plain words, not saved.
    chatReplies = { 'api.telegram.org': [{ status: 200, body: me }, err(400, 'Bad Request: chat not found'), err(400, 'Bad Request: chat not found')] };
    expect(await (await req('PUT', '/channels', { telegram: { bot_token: TOKEN, chat_id: '999' } })).json()).toMatchObject({ ok: false, code: 'telegram_unreachable', error: "Telegram couldn't find this chat (check the chat id, and that the bot is in the chat)" });
    expect((await (await req('GET', '/channels')).json()).channels.telegram).toEqual({ chat_id: '424242' });

    // 403 Forbidden: bot was blocked by the user, on a real alert: Telegram is flagged at once with one notice, and email
    // resumes with that same alert (chats go first, so the failure is known before email is decided).
    await putFollows('cus_tgc', { investors: ['warren-buffett'] });
    const today = new Date().toISOString().slice(0, 10);
    const ev = (id: string) => ({ id, slug: 'warren-buffett', manager: 'Warren Buffett', form: '4', kind: 'form4', action: 'buy', filing_date: today, url: `https://www.sec.gov/${id}`, issuer: 'SIRIUS XM', display_name: null, ticker: 'SIRI', shares: 1000, value: 25000, accepted: new Date().toISOString() });
    events = [ev('tg-seed')];
    await cron(47);
    sent = [];
    posts = [];
    chatReplies = { 'api.telegram.org': [err(403, 'Forbidden: bot was blocked by the user')] };
    events = [ev('tg-seed'), ev('TG1')];
    await cron(47);
    expect(tg()).toHaveLength(1);
    expect(JSON.parse(tg()[0].body)).toMatchObject({ chat_id: '424242', parse_mode: 'HTML' });
    expect((await (await req('GET', '/me')).json()).member.channels_failing).toHaveProperty('telegram');
    expect(sent.filter((m) => m.to[0] === 'tgc@example.com').map((m) => m.subject).sort()).toEqual(['Buffett SIRI Form 4: bought', 'Your Telegram alerts stopped: access was revoked (HTTP 403)']);
    chatReplies = {};

    // A real alert's text as Telegram HTML: <, > and & escaped, links as <a href>, nothing else; under 4,096 characters.
    const { telegramParts } = await import('../src/channels');
    const { chatText } = await import('../src/email');
    const row = (change: string, display_name: string, value_delta: number) => ({ change, ticker: null, display_name, issuer: display_name, cusip: '00206R102', put_call: null, shares: 1000, prev_shares: change === 'new' ? 0 : 500, value: 1e6, value_delta, delta_pct_of_book: 0.01 });
    const filing = { slug: 'ruane-cunniff', slugs: ['ruane-cunniff'], manager: 'Ruane, Cunniff & Goldfarb L.P.', name: 'Ruane, Cunniff & Goldfarb L.P.', quarter: '2026Q3', report_date: '2026-09-30', filing_date: today, accession: '0001720792-26-000011', sec_url: 'https://www.sec.gov/Archives/edgar/data/1720792/000172079226000011/0001720792-26-000011-index.html', tickers: [], moves: { bought_usd: 2e6, sold_usd: 0, new: [row('new', 'AT&T <Class A>', 1e6)], added: [row('added', 'Johnson & Johnson', 5e5)], trimmed: [], exited: [] } };
    const f = { investors: ['ruane-cunniff'], stocks: [], owned: [], peers: [], onboarded: true };
    const valid = (h: string) => !/[<>]/.test(h.replace(/<a href="https?:\/\/[^"<>\s]+">[^<>]*<\/a>/g, '')) && !/&(?!(amp|lt|gt|quot);)/.test(h);
    const one = telegramParts(chatText(env, [filing as never], [], f as never));
    expect([one.length, valid(one[0].html), one[0].html.length <= 4096]).toEqual([1, true, true]);
    expect(one[0].html).toContain('Ruane, Cunniff &amp; Goldfarb');
    expect(one[0].html).toContain('AT&amp;T &lt;Class A&gt;');
    expect(one[0].html).toContain(`<a href="${filing.sec_url}">${filing.sec_url}</a>`);
    // Longer than one message: several, split at line ends, each valid and under the limit, nothing cut or lost.
    const long = chatText(env, Array.from({ length: 40 }, (_, i) => ({ ...filing, accession: `0001720792-26-${String(100 + i).padStart(6, '0')}` })) as never, [], f as never);
    const parts = telegramParts(long);
    expect(long.length).toBeGreaterThan(4096);
    expect([parts.length > 1, parts.every((p) => valid(p.html) && p.html.length <= 4096), parts.map((p) => p.plain).join('\n') === long]).toEqual([true, true, true]);
  });

  it("Item 4 excerpts: Icahn's real CVI 13D/A #41 without the amendment preamble or defined terms, cut at a sentence end", () => {
    const p = parseSchedule13(cvi41)!;
    expect(p.item4).toBe(
      'On November 3, 2026, the Issuer entered into an underwriting agreement with Barclays Capital Inc. and Jefferies LLC, as representatives of the several underwriters named therein, relating to the offering of 10,515,248 Shares at a public offering price of $47.55 per Share. The Issuer also granted the Underwriters a 30-day option to purchase up to 1,577,287 additional Shares from the Issuer. The Equity Offering closed on November 5, 2026. The Reporting Persons and their affiliates did not sell Shares as selling stockholders in the Equity Offering. …',
    );
    // Cleaning again changes nothing; an excerpt stored before (preamble, cut mid-sentence) loses both.
    expect(cleanItem4(p.item4)).toBe(p.item4);
    expect(cleanItem4('Item 4 of the Initial 13D is hereby amended and supplemented by adding the following: On November 3, 2026, the Issuer entered into an underwriting agreement (the "Underwriting Agreement") with Barclays Capital Inc. and Jefferies LLC. The Equity Offering…')).toBe('On November 3, 2026, the Issuer entered into an underwriting agreement with Barclays Capital Inc. and Jefferies LLC.');
    expect(cleanItem4('Item 4 is amended to add the following: The Reporting Persons intend to seek board representation.')).toBe('The Reporting Persons intend to seek board representation.');
    expect(cleanItem4('This Amendment amends and supplements Item 4 of the Original Schedule 13D by adding the following: Revised Non-Binding Proposal On July 27, 2026, the Consortium submitted a revised proposal.')).toBe('Revised Non-Binding Proposal On July 27, 2026, the Consortium submitted a revised proposal.');
    // A colon in the substance itself stays.
    expect(cleanItem4('The Reporting Persons propose: a sale of the Issuer.')).toBe('The Reporting Persons propose: a sale of the Issuer.');
  });

  it('chat retries get a slot every minute: ten busy minutes in a row still retry a failed Slack post on time', async () => {
    index = { managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, form: '13F-HR', accession: 'q2', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }] };
    await cron(17);
    await putMember('s', 'slack@example.com', 'active', ['warren-buffett']);
    await putFollows('s', { investors: ['warren-buffett'] });
    await env.DB.put('channels:s', JSON.stringify({ slack: 'https://hooks.slack.com/services/T000/B000/busyafternoon01' }));
    const t20 = new Date();
    t20.setUTCHours(t20.getUTCHours() === 3 ? 4 : t20.getUTCHours(), 20, 0, 0);
    const tick = (min: number) => cron(0, t20.getTime() + min * 60_000);
    const iso = (min: number) => new Date(t20.getTime() + min * 60_000 - 20_000).toISOString();
    const entry = (acc: string, when: string) => `<entry><title>4 - BERKSHIRE (0001067983) (Reporting)</title><updated>${when}</updated><category scheme="https://www.sec.gov/" label="form type" term="4"/><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
    await tick(-1); // seeds the poll
    const accs: string[] = [];
    chatReplies = { 'hooks.slack.com': [{ status: 500 }] };
    // A deadline afternoon: a new Berkshire Form 4 every minute for 11 minutes, so every minute is busy.
    for (let i = 0; i <= 10; i++) {
      accs.unshift(`0001067983-26-9000${String(i).padStart(2, '0')}`);
      secFiles['feed:4'] = `<feed>${accs.map((a, j) => entry(a, iso(i - j))).join('')}</feed>`;
      await tick(i);
      if (i === 0) expect(JSON.parse((await env.DB.get('webhooks:retry'))!)).toHaveLength(1);
      if (i === 1) {
        // The first alert's retry went out one minute later, in a busy minute.
        expect(posts.filter((p) => p.body.includes(accs[1])).length).toBe(2);
        expect(await env.DB.get('webhooks:retry')).toBeNull();
      }
    }
    expect(posts.filter((p) => p.url.includes('hooks.slack.com'))).toHaveLength(12);
  });

  it('missed-filing detector: a followed Form 4 pushed off the poll\'s feed page by a burst is requeued after 10 minutes, sent, logged and counted', async () => {
    index = { managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, form: '13F-HR', accession: 'q2', report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' }] };
    await cron(17);
    await putMember('b', 'buffett@example.com', 'active', ['warren-buffett']);
    await putFollows('b', { investors: ['warren-buffett'] });
    const t14 = new Date();
    t14.setUTCHours(t14.getUTCHours() === 3 ? 4 : t14.getUTCHours(), 14, 0, 0);
    const at = (min: number) => cron(0, t14.getTime() + (min - 14) * 60_000);
    await at(4); // the polls' first run seeds them
    const iso = (min: number) => new Date(t14.getTime() + (min - 14) * 60_000).toISOString();
    const entry = (acc: string, cik: string, name: string, when: string) => `<entry><title>4 - ${name} (${cik}) (Reporting)</title><updated>${when}</updated><category scheme="https://www.sec.gov/" label="form type" term="4"/><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
    // A burst: two full pages of other filers' Form 4s in the last minutes; Berkshire's, accepted at :50 of
    // the previous hour, is on page 3, past the two pages the minute poll reads.
    const burst = (from: number) => `<feed>${Array.from({ length: 100 }, (_, i) => entry(`0000111111-26-${String(from + i).padStart(6, '0')}`, '0000111111', 'SOMEONE', iso(12))).join('')}</feed>`;
    secFiles['feed:4'] = burst(0);
    secFiles['feed@100:4'] = burst(100);
    const missed = '0001193125-26-500001';
    secFiles['feed@200:4'] = `<feed>${entry(missed, '0001067983', 'BERKSHIRE', iso(-10))}</feed>`;
    sent = [];
    await at(14);
    expect(sent).toHaveLength(0);
    await at(15); // the detector: 25 minutes past acceptance and unsent
    expect(JSON.parse((await env.DB.get('missed:queue'))!).map((e: { accession: string }) => e.accession)).toEqual([missed]);
    await at(16); // the next poll sends it
    expect(sent.filter((m) => m.to[0] === 'buffett@example.com').map((m) => m.subject)).toEqual([expect.stringMatching(/^Buffett Form 4/)]);
    const health = await (await call('/health')).json();
    expect(health.missed_recovered).toMatchObject({ count: 1, recent: [{ accession: missed, form: '4', cik: '0001067983', minutes_late: 25 }] });
    // Next pass: handled now, so the queue empties and nothing is counted twice.
    sent = [];
    await at(25);
    expect(JSON.parse((await env.DB.get('missed:queue'))!)).toEqual([]);
    expect((await (await call('/health')).json()).missed_recovered.count).toBe(1);
    expect(sent).toHaveLength(0);
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
    // The requester gets an acknowledgement that replies to our inbox; our inbox gets the request, replying to them.
    expect(sent.map((m) => [m.to[0], m.reply_to])).toEqual([['pat@fund.example', 'hello@example.com'], ['hello@example.com', 'pat@fund.example']]);
    expect(sent[0].text).toContain('annual invoice quote');
    expect(sent[1].text).toContain('fund: Pat Capital');
    expect(sent[1].text).toContain('Annual please');
    // A bot filling the hidden field gets a quiet 200 and nothing is stored or sent.
    sent = [];
    expect((await post({ ...ok, email: 'bot@x.example', website: 'http://spam' })).status).toBe(200);
    expect((await env.DB.list({ prefix: 'lead:' })).keys).toHaveLength(1);
    expect(sent).toHaveLength(0);
    // Three per address an hour.
    await post(ok, '5.5.5.5');
    await post(ok, '6.6.6.6');
    expect((await post(ok, '7.7.7.7')).status).toBe(429);
    expect((await (await privateHealth()).json()).business.fund_requests).toBe(3);
    // A reviewer's TEST submission is stored but not counted.
    sent = [];
    expect((await post({ ...ok, email: 'copybook-test-pm@x.example', name: 'TEST PM critic' }, '8.8.8.8')).status).toBe(200);
    expect(sent.map((m) => m.to[0])).toEqual(['copybook-test-pm@x.example']);
    expect((await (await privateHealth()).json()).business.fund_requests).toBe(3);

    const t = Date.now();
    const row = (acc: string, seconds: number, extra: Record<string, unknown> = {}) => ({ slug: 'warren-buffett', manager: 'Warren Buffett', quarter: '2026Q3', kind: '13f', accession: acc, accepted: new Date(t - seconds * 1000).toISOString(), sent: new Date(t).toISOString(), seconds, moves: true, ...extra });
    // Newest first, as logged; one replay; one from last season; a 13F timed by its first email (no moves), before the fix.
    // A1 again, to a second member 4 minutes later (a coalesced send): one alert, counted once at its first delivery.
    await env.DB.put('alerts:latency', JSON.stringify([row('A1', 300, { sent: new Date(t + 260_000).toISOString(), coalesced: true }), row('A1', 40), row('R1', 163146, { replay: true }), row('A2', 100, { kind: 'form4', form: '4' }), row('A3', 60, { coverage: 'any_filer', slug: 'whale-rock-capital-management-llc' }), row('OLD', 5, { sent: '2025-01-02T00:00:00Z' }), row('FILED', 30, { moves: undefined }), row('0001386060-26-000054', 9149, { replay: true, slug: 'boston-partners', manager: 'Boston Partners' })]));
    const d = (channel: string, acc: string, seconds: number, extra: Record<string, unknown> = {}) => ({ channel, accession: acc, form: '13F-HR', manager: 'Warren Buffett', accepted: new Date(t - seconds * 1000).toISOString(), delivered: new Date(t).toISOString(), seconds, ...extra });
    await env.DB.put('alerts:latency:ch', JSON.stringify([d('slack', 'A1', 41), d('slack', 'A3', 61), d('slack', 'A2', 101, { form: '4' }), d('discord', 'A1', 43), d('slack', 'OLD', 9, { delivered: '2025-01-02T00:00:00Z' }), d('webhook', 'A3', 20, { moves: false, delivered: new Date(t - 40_000).toISOString() })]));
    const lat = await (await call('/latency')).json();
    expect(lat).toMatchObject({ count: 3, median_seconds: 60, p90_seconds: 100, p95_seconds: 100 });
    // Per form family and per channel (email: acceptance to the mailer; chat: to the first successful post), this season only.
    // An even count's median is the mean of the middle two (40 and 60 -> 50), not the lower one.
    expect(lat.by_form).toEqual({
      '13F': { count: 2, median_seconds: 50, p90_seconds: 60, season: { count: 2, median_seconds: 50, p90_seconds: 60, max_seconds: 60, over_15m: 0 }, since_fix: { count: 2, median_seconds: 50, p90_seconds: 60 } },
      'Form 4': { count: 1, median_seconds: 100, p90_seconds: 100 },
    });
    expect(lat.by_channel).toEqual({ email: { count: 3, median_seconds: 60, p90_seconds: 100 }, slack: { count: 3, median_seconds: 61, p90_seconds: 101 }, discord: { count: 1, median_seconds: 43, p90_seconds: 43 } });
    // Any filer's 13F is timed too (followed, peers, linked books), tagged apart; untagged rows are curated.
    expect(lat.by_coverage).toEqual({ curated: { count: 2, median_seconds: 70, p90_seconds: 100 }, any_filer: { count: 1, median_seconds: 60, p90_seconds: 60 } });
    expect(lat.recent.map((r: { accession: string }) => r.accession)).toEqual(['A1', 'A2', 'A3']);
    expect(lat.recent[1]).toEqual({ form: '4', manager: 'Warren Buffett', slug: 'warren-buffett', coverage: 'curated', accession: 'A2', accepted_at: expect.any(String), delivered_at: expect.any(String), seconds: 100, channel: 'email' });
    // Every alert row, the replay included and flagged (the figures above leave it out), then the misses.
    type Row = { accession: string; missed: boolean; replay: boolean; audience?: string; never: boolean; team_delivered_at: string | null; email_accepted_at: string | null };
    const sentRows = lat.alerts.filter((a: Row) => !a.missed);
    expect(sentRows.map((a: Row) => [a.accession, a.replay])).toEqual([['A1', false], ['R1', true], ['A2', false], ['A3', false], ['0001386060-26-000054', true]]);
    expect(sentRows[2]).toMatchObject({ form: '4', gap_seconds: 100, manager: 'Warren Buffett', missed: false, never: false, first_alert_at: null });
    // Team channel: the first successful chat or webhook post that carried a 13F's moves (A3's earlier webhook post
    // without them isn't its time, nor in by_channel).
    expect([sentRows[0].team_delivered_at, sentRows[3].team_delivered_at]).toEqual([new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'), new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')]);
    expect(sentRows[0].email_accepted_at).toBe(sentRows[0].sent_at);
    // The long-only routing outage: 16 13Fs never reached stock watchers.
    const watchers = lat.alerts.filter((a: Row) => a.audience === 'stock_watchers');
    expect([watchers.length, watchers.every((a: Row) => a.missed && a.never && a.email_accepted_at === null)]).toEqual([16, true]);
    // Each names its manager and its followers' alert, says how watchers get it, and stays out of the figures.
    expect(watchers.find((a: Row) => a.accession === '0001386060-26-000054')).toMatchObject({ manager: 'Boston Partners', followers_alerted_at: expect.any(String), covered_by: 'weekly_names', covered_at: '2026-11-14T02:15:00Z', in_stats: false });
    expect([lat.missed_stock_watchers, lat.missed_never, sentRows.filter((a: { in_stats: boolean }) => a.in_stats).map((a: Row) => a.accession)]).toEqual([16, 0, ['A1', 'A2', 'A3']]);
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
      secFiles[`${dir}index.json`] = JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml', size: '5000' }, { name: 't.xml', size: '900' }] } });
      secFiles[`${dir}primary_doc.xml`] = '<periodOfReport>09-30-2026</periodOfReport>';
      secFiles[`${dir}t.xml`] = '<informationTable><infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><cusip>037833100</cusip><value>2000</value><shrsOrPrnAmt><sshPrnamt>12</sshPrnamt></shrsOrPrnAmt></infoTable></informationTable>';
    };
    for (const slug of ['warren-buffett', 'dan-loeb']) hist.m.set(`h/${slug}/2026Q2.json`, new TextEncoder().encode(JSON.stringify({ holdings: [{ cusip: '037833100', put_call: null, issuer: 'APPLE INC', ticker: 'AAPL', shares: 10, value: 1500 }] })));
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
    const s = await (await fullCheckout('cs_test_new')).json();
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
    let owner = (await (await fullCheckout('cs_test_fund')).json()).token;
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
    let seat = (await (await call('/session', { body: { login } })).json()).token;
    expect((await (await call('/me', { token: seat })).json()).member).toMatchObject({ email: 'analyst@fund.example', plan: 'fund', active: true, seat: true, owner: 'pm@fund.example' });

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

    // Slack is the team's: the owner connects the team channel, and a seat that connects the same one too
    // still gets each alert once there; the seat's own Discord gets its copy. Seats see the team channel read-only.
    const teamSlack = 'https://hooks.slack.com/services/T000/B000/teamchannel0001';
    const chan = (token: string, b: unknown) => handleRequest(new Request('https://api.test/channels', { method: b ? 'PUT' : 'GET', body: b ? JSON.stringify(b) : undefined, headers: { authorization: `Bearer ${token}` } }), env);
    expect((await (await chan(owner, { slack: teamSlack })).json()).channels).toMatchObject({ scope: 'team', editable: true });
    // A seat can't save the team's channel as its own (409, nothing stored); its personal Discord is fine.
    const dupe = await chan(seat, { slack: teamSlack, discord: 'https://discord.com/api/webhooks/123456789/seatpersonalabcdefghijklmn' });
    expect(dupe.status).toBe(409);
    expect((await dupe.json()).code).toBe('already_team_channel');
    expect((await (await chan(seat, null)).json()).channels.discord).toBeNull();
    expect((await (await chan(seat, { discord: 'https://discord.com/api/webhooks/123456789/seatpersonalabcdefghijklmn' })).json()).channels).toMatchObject({ scope: 'personal' });
    // A duplicate saved before the rule: the owner's next save clears the seat's copy, once, with an email.
    const seatId = (await env.DB.get('email:analyst@fund.example'))!;
    await env.DB.put(`channels:${seatId}`, JSON.stringify({ ...JSON.parse((await env.DB.get(`channels:${seatId}`))!), slack: teamSlack }));
    sent = [];
    await chan(owner, { slack: teamSlack });
    expect(JSON.parse((await env.DB.get(`channels:${seatId}`))!).slack).toBeUndefined();
    expect(sent.map((m) => [m.to[0], m.subject])).toEqual([['analyst@fund.example', "Your Slack alerts now come from your team's channel"]]);
    // The team webhook has one secret, readable by seats; a seat can't add the same URL with its own.
    const ownerHook = (await (await chan(owner, { webhook: 'https://hooks.example.com/team' })).json()).channels.webhook;
    expect((await (await chan(seat, null)).json()).channels.team.webhook).toEqual({ url: 'https://hooks.example.com/team', secret: ownerHook.secret });
    expect((await chan(seat, { webhook: 'https://hooks.example.com/team' })).status).toBe(409);
    expect((await (await chan(seat, null)).json()).channels).toMatchObject({ scope: 'personal', team: { scope: 'team', editable: false, slack: 'https://hooks.slack.com/…0001', discord: null } });
    const today = new Date().toISOString().slice(0, 10);
    const ev = (id: string) => ({ id, slug: 'warren-buffett', manager: 'Warren Buffett', form: '4', kind: 'form4', action: 'buy', filing_date: today, url: `https://www.sec.gov/${id}`, issuer: 'SIRIUS XM', ticker: 'SIRI', shares: 1000, value_usd: 25000, avg_price: 25 });
    events = [ev('seed')];
    await cron(47);
    posts = [];
    events = [ev('seed'), ev('T1')];
    await cron(47);
    expect(posts.filter((p) => p.url === teamSlack)).toHaveLength(1);
    expect(posts.filter((p) => p.url.includes('discord.com'))).toHaveLength(1);

    // The owner signs a seat out everywhere: its sessions stop working at once (even after the owner's next
    // subscription update rewrites the seat), and the seat can sign in again by email.
    const seatKey = (await (await call('/keys', { body: { name: 'seat-revoke-test' }, token: seat })).json()).key as string;
    const v1me = () => handleRequest(new Request('https://api.test/v1/me', { headers: { authorization: `Bearer ${seatKey}` } }), env);
    expect((await v1me()).status).toBe(200);
    const before = await call('/seats/analyst%40fund.example/revoke', { method: 'POST', token: seat });
    expect(before.status).toBe(403); // only the owner
    const rv = await call('/seats/analyst%40fund.example/revoke', { method: 'POST', token: owner });
    expect([rv.status, (await rv.json()).revoke_available]).toEqual([200, true]);
    await webhook({ type: 'customer.subscription.updated', data: { object: sub('sub_fund', 'cus_fund', 'active', 'year', 'fund_yearly') } });
    expect((await call('/me', { token: seat })).status).toBe(401);
    expect((await call('/me', { token: owner })).status).toBe(200);
    // Its API keys stop too: "sign out everywhere" leaves a departing colleague no access.
    expect((await v1me()).status).toBe(401);
    expect((await call('/seats/nobody%40fund.example/revoke', { method: 'POST', token: owner })).status).toBe(404);
    // Any member signs their own sessions out everywhere: a copied token dies at once, this browser gets a fresh session.
    const copied = await signToken(env.SESSION_SECRET, 'session', 'cus_fund', 30 * 86400, {}, Date.now() / 1000 - 30);
    const here = await signToken(env.SESSION_SECRET, 'session', 'cus_fund', 30 * 86400, {}, Date.now() / 1000 - 20);
    expect((await call('/me', { token: copied })).status).toBe(200);
    const so = await (await call('/me/sessions/revoke', { method: 'POST', token: here })).json();
    expect(so).toMatchObject({ ok: true, member: { email: expect.any(String) } });
    expect([(await call('/me', { token: copied })).status, (await call('/me', { token: here })).status, (await call('/me', { token: so.token })).status]).toEqual([401, 401, 200]);
    // A copy issued in the very second of the sign-out dies too (the PM's i=1794395761); only the fresh one lives.
    const sameSecond = await signToken(env.SESSION_SECRET, 'session', 'cus_fund', 30 * 86400, {}, Date.parse(so.revoked_at) / 1000 + 0.5);
    expect((await call('/me', { token: sameSecond })).status).toBe(401);
    // The site signs out only on invalid_session (revoked, forged, expired); a valid session this host can't place, or none, is not that.
    const code = async (token: string) => (await (await call('/me', { token })).json()).code;
    expect([await code(copied), await code(`${here}x`), await code(await signToken(env.SESSION_SECRET, 'session', 'cus_nobody', 600)), await code('')]).toEqual(['invalid_session', 'invalid_session', 'member_unavailable', 'no_session']);
    owner = so.token;
    await new Promise((r) => setTimeout(r, 1000)); // a new session is issued in a later second
    const again = (await (await call('/session', { body: { login: await signToken(env.SESSION_SECRET, 'login', seatId, 600) } })).json()).token;
    expect((await call('/me', { token: again })).status).toBe(200);
    seat = again;

    // Removing a seat ends access like revoke, and re-inviting the address brings none of it back (the PM's test on
    // the live API: the old session and key answered 200 a second after the re-invite).
    const oldKey = (await (await call('/keys', { body: { name: 'seat-remove-test' }, token: seat })).json()).key as string;
    const keyStatus = async (k: string) => (await handleRequest(new Request('https://api.test/v1/me', { headers: { authorization: `Bearer ${k}` } }), env)).status;
    expect(await keyStatus(oldKey)).toBe(200);
    const staleLink = await signToken(env.SESSION_SECRET, 'login', seatId, 600, {}, Date.now() / 1000 - 5);
    const seatFeed = (await (await call('/channels/feed', { body: {}, token: seat })).json()).channels.feed.json_url as string;
    expect((await handleRequest(new Request(seatFeed), env)).status).toBe(200);
    expect((await call('/seats/analyst%40fund.example', { method: 'DELETE', token: owner })).status).toBe(200);
    expect([(await call('/me', { token: seat })).status, await keyStatus(oldKey)]).toEqual([401, 401]);
    // The removed seat's private feed stops at once too (a feed URL is a credential of its own).
    expect((await handleRequest(new Request(seatFeed), env)).status).toBe(404);
    expect((await call('/seats', { body: { email: 'analyst@fund.example' }, token: owner })).status).toBe(201);
    expect([(await call('/me', { token: seat })).status, await keyStatus(oldKey)]).toEqual([401, 401]);
    expect((await call('/session', { body: { login: staleLink } })).status).toBe(401); // a link from before the removal
    await new Promise((r) => setTimeout(r, 1000)); // the fresh sign-in, a second after the invite
    seat = (await (await call('/session', { body: { login: await signToken(env.SESSION_SECRET, 'login', seatId, 600) } })).json()).token;
    expect((await call('/me', { token: seat })).status).toBe(200);
    expect((await (await call('/keys', { token: seat })).json()).keys).toEqual([]);

    // Ten seats at most; the 11th is refused.
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10]) expect((await call('/seats', { body: { email: `s${n}@fund.example` }, token: owner })).status).toBe(201);
    const eleventh = await call('/seats', { body: { email: 's11@fund.example' }, token: owner });
    expect([eleventh.status, (await eleventh.json()).code]).toEqual([409, 'seat_limit']);

    // A removed seat is gone; when the Fund ends, every remaining seat ends with it.
    const s5 = await env.DB.get('email:s5@fund.example');
    expect((await call('/seats/s5%40fund.example', { method: 'DELETE', token: owner })).status).toBe(200);
    expect(await env.DB.get('email:s5@fund.example')).toBeNull();
    expect(await env.DB.get(`cus:${s5}`)).toBeNull();
    const fundKey = (await (await call('/keys', { body: { name: 'seat-fund-end' }, token: seat })).json()).key as string;
    await webhook({ type: 'customer.subscription.deleted', data: { object: { ...sub('sub_fund', 'cus_fund', 'canceled', 'year', 'fund_yearly') } } });
    expect((await (await call('/me', { token: seat })).json()).member).toMatchObject({ active: false, status: 'canceled' });
    expect((await call('/follows', { token: seat })).status).toBe(402);
    // A seat's API key once the Fund ends: 402 that names the plan that lapsed, Copy Fund (not Copy or Copy Pro).
    const ended = await handleRequest(new Request('https://api.test/v1/filers', { headers: { authorization: `Bearer ${fundKey}` } }), env);
    const endedBody = (await ended.json()) as { error?: { code?: string; message?: string }; code?: string; message?: string };
    expect([ended.status, JSON.stringify(endedBody).includes('subscription_inactive'), JSON.stringify(endedBody).includes('Copy Fund subscription')]).toEqual([402, true, true]);
  });

  it('/v1 every filer: the all-filer list, books from the public shard then the full R2 book, ranges, stock holders', async () => {
    index = { generated_at: '2026-11-08T21:29:01Z', managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, status: 'current', form: '13F-HR', accession: 'A2', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', total_value: 2000, position_count: 1, history_quarters: ['2026Q2'] }] };
    await cron(17);
    // A stale cached index.json (an older build) never moves the build /v1 reports backwards.
    const current = index;
    index = { ...(current as Record<string, unknown>), generated_at: '2026-11-08T20:00:00Z' } as typeof index;
    await cron(17);
    expect(JSON.parse((await env.DB.get('v1:build'))!).data_built_at).toBe('2026-11-08T21:29:01Z');
    index = current;
    stripeObjects['checkout/sessions/cs_test_af'] = { id: 'cs_test_af', status: 'complete', created: now(), subscription: 'sub_af', customer_details: { email: 'af@example.com' } };
    stripeObjects['subscriptions/sub_af'] = sub('sub_af', 'cus_af', 'active', 'month', 'pro_monthly');
    const t = (await (await fullCheckout('cs_test_af')).json()).token;
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
    expect(full.holdings[2]).toMatchObject({ ticker: 'XYZ', value_usd: 700, weight: 700 / 23700, weight_equity: 700 / 23700 });
    // A book whose exits sit inside its rows (row_type or change `exited`): holdings[] keeps current positions only,
    // exited[] gets the exits, both with row_type, and an exit carries its old value as prev_value_usd.
    const ex = ['ZZ', 'ZZ CORP', 'COM', '98422D999', null, 0, 0, 'Zz', null];
    hist.m.set('fb/2026Q2/0002045724.json', new TextEncoder().encode(JSON.stringify({ ...(shards['0002045724.json'] as object), columns: [...cols, 'change', 'row_type', 'prev_shares', 'prev_value', 'value_delta'], rows: [[...nvda, 'added', 'holding', 90, 15000, 1800], [...be, null, null, null, null, null], [...small, 'unchanged', null, 7, 700, 0], [...ex, 'exited', 'exited', 40, 3000, -3000]] })));
    const split = (await v1('/v1/filers/2045724/holdings/2026Q2')).body.data;
    expect(split.holdings.map((h: { ticker: string; row_type: string }) => [h.ticker, h.row_type])).toEqual([['NVDA', 'holding'], ['BE', 'holding'], ['XYZ', 'holding']]);
    expect(split.exited.map((h: { ticker: string; row_type: string; prev_shares: number; prev_value_usd: number; zero_value: boolean }) => [h.ticker, h.row_type, h.prev_shares, h.prev_value_usd, h.zero_value])).toEqual([['ZZ', 'exited', 40, 3000, false]]);
    expect(split.total_value_usd).toBe(23700);
    hist.m.set('fb/2026Q2/0002045724.json', new TextEncoder().encode(JSON.stringify({ ...(shards['0002045724.json'] as object), rows: [nvda, be, small] })));

    const range = (await v1('/v1/filers/2045724/holdings?from=2025Q4&to=2026Q2')).body;
    expect(range.data.map((b: { quarter: string }) => b.quarter)).toEqual(['2026Q2']);
    expect(range.missing).toEqual(['2025Q4', '2026Q1']);
    expect(range.next_from).toBeNull();
    const long = (await v1('/v1/filers/2045724/holdings?from=2024Q1&to=2026Q2')).body;
    expect(long.missing).toHaveLength(8);
    expect(long.next_from).toBe('2026Q1');
    expect((await v1('/v1/filers/2045724/holdings?from=2026Q2&to=2026Q1')).status).toBe(400);

    // Holders of one stock, by ticker or CUSIP: every filer from the holder index (R2 hl/, uploaded by the data run).
    expect((await v1('/v1/stocks/NVDA/holders')).status).toBe(404);
    await env.DB.put('filing:A2', JSON.stringify({ accession: 'A2', accepted_at: '2026-08-14T20:05:04.000Z' }));
    await hist.put('hl/67066G.json', JSON.stringify({
      issuer: '67066G', tickers: ['NVDA'], counts: { holders: 4, by_period: { '2026Q3': 1, '2026Q2': 3 }, net: 10800, net_quarter: '2026Q3', net_by_period: { '2026Q3': 10800, '2026Q2': 12345 } }, rows_total: 4,
      columns: ['cik', 'name', 'slug', 'type', 'curated', 'period', 'shares', 'prev_shares', 'value', 'prev_value', 'change', 'put_call'],
      // Not in size order: the API sorts largest first.
      rows: [
        ['0001067983', 'Berkshire Hathaway Inc', 'warren-buffett', 'active', true, '2026Q2', 10, 0, 1800, 0, 'new'],
        ['0002045724', 'Situational Awareness LP', 'situational-awareness-lp-5724', 'hedge_fund', false, '2026Q3', 100, 40, 18000, 6000, 'added'],
        ['0000102909', 'Vanguard Group Inc', 'vanguard-group-inc-2909', 'index', false, '2026Q2', 50, 50, 9000, 8000, 'unchanged'],
        ['0001387322', 'Whale Rock Capital Management LLC', null, 'hedge_fund', false, '2026Q2', 5, null, 900, null, 'new'],
        // An options row that closed (0 shares, $0) and a filer whose latest 13F is a year old.
        ['0002012383', 'BlackRock, Inc.', null, 'index', false, '2026Q2', 0, 3, 0, 500, 'exited', 'Call'],
        ['0000000077', 'Old Filer LP', null, 'long_only', false, '2025Q3', 7, 7, 700, 650, 'unchanged', null],
        // A live put, untyped in the file: its type comes from ingest's filer_types.json.
        ['0001423053', 'Citadel Advisors LLC', null, null, false, '2026Q3', 20, 0, 5000, 0, 'new', 'Put'],
      ],
    }), { customMetadata: { build_id: 'gust-3a8c773b', built_at: '2026-11-09T02:30:00.000Z' } });
    const h = (await v1('/v1/stocks/NVDA/holders')).body;
    // The response names the upload it read, not the static data's build.
    expect([h.build_id, h.data_built_at]).toEqual(['gust-3a8c773b', '2026-11-09T02:30:00Z']);
    // Current share (SH) positions by default: count is their rows, filers the distinct filers among them. Options and
    // exits come in their own lists (CVI's 38 exited zero-share rows were in count before).
    expect(h).toMatchObject({ count: 4, filers: 4, next_offset: null, options_count: { calls: { rows: 0, filers: 0 }, puts: { rows: 1, filers: 1 } }, exited_count: 1, data: { issuer: '67066G', ticker: 'NVDA', counts: { holders: 4, holders_all: 5, not_current: 1 }, truncated: false } });
    // Counts follow current_only: Old Filer LP (last 13F 2025Q3) is in holders_all and not_current only; current_only=false counts it.
    // Ingest's net, net_quarter and net_by_period are served as they are (canonical), and its quarter's net must equal that
    // quarter's /v1/changes?ticker= sum: Situational Awareness +60 sh x $180 (the put is an option, not in net).
    expect([h.data.counts.net, h.data.counts.net_quarter, h.data.counts.net_by_period, h.data.counts.net_by_period_incomplete]).toEqual([10800, '2026Q3', { '2026Q3': 10800, '2026Q2': null }, ['2026Q2']]);
    // Where net comes from: ingest's index as published, and the build both it and /v1/changes?ticker= read (the quant).
    expect([h.data.counts.net_source, h.data.counts.net_build, h.data.counts.changes_build]).toEqual(['hl', 'gust-3a8c773b', 'gust-3a8c773b']);
    // Ingest's share-class fields pass through as published, on holders and changes rows (FMR's BRK A and B, summed).
    const brkClasses = [{ cusip: '084670108', ticker: 'BRK.A', shares: 10, prev_shares: 8, value_delta: 1_500_000 }, { cusip: '084670702', ticker: 'BRK.B', shares: 1000, prev_shares: 900, value_delta: 50_000 }];
    await hist.put('hl/084670.json', JSON.stringify({ issuer: '084670', tickers: ['BRK.B'], schema: 3, columns: ['cik', 'name', 'slug', 'type', 'curated', 'period', 'shares', 'prev_shares', 'value', 'prev_value', 'change', 'put_call', 'classes', 'shares_unit', 'cusip', 'net_direction'],
      rows: [['0000315066', 'FMR LLC', null, 'active', false, '2026Q3', 1010, 908, 7_000_000, 5_000_000, 'mixed', null, brkClasses, 'mixed', '084670702', 'buy']] }));
    const brkRow = (await v1('/v1/stocks/084670702/holders')).body.data.holders[0];
    const brkChange = (await v1('/v1/changes/2026Q3?cusip=084670702')).body.data[0];
    expect([brkRow.classes, brkRow.shares_unit, brkChange.classes, brkChange.shares_unit]).toEqual([brkClasses, 'mixed', brkClasses, 'mixed']);
    // A blend of classes has no CUSIP of its own and no shares in mixed units; its change is ingest's, not the $ sum's sign.
    for (const r of [brkRow, brkChange]) expect([r.cusip, r.issuer_cusip6, r.shares, r.prev_shares, r.share_change, r.change, r.net_direction]).toEqual([null, '084670', null, null, null, 'mixed', 'buy']);
    // Ingest's schema-5 BRK row states its shares in BRK.B (shares_ratio per class CUSIP): they pass through, CUSIP still null.
    await hist.put('hl/084670.json', JSON.stringify({ issuer: '084670', tickers: ['BRK.B'], schema: 5, columns: ['cik', 'name', 'slug', 'type', 'curated', 'period', 'shares', 'prev_shares', 'value', 'prev_value', 'change', 'put_call', 'classes', 'shares_unit', 'shares_ratio', 'ratio_source', 'cusip', 'issuer_cusip6', 'net_direction', 'value_delta', 'value_delta_basis', 'unreliable', 'unreliable_reason'],
      rows: [['0000315066', 'FMR LLC', null, 'active', false, '2026Q3', 16000, 12900, 7_000_000, 5_000_000, 'mixed', null, brkClasses, 'BRK.B', { '084670108': 1500 }, '0001193125-26-000001', null, '084670', 'buy', 1_550_000, 'net_shares_repriced', null, null],
        // A held row (ingest's rule): filed facts, its unreliable class and reason, change unknown, no value change.
        ['0000102909', 'VANGUARD GROUP INC', null, 'passive', false, '2026Q3', 9_000_000, 4_000, 4_000_000, 3_000_000, 'unknown', null, null, 'BRK.B', null, null, '084670702', '084670', null, null, null, 'shares', 'share count 2,250x the prior quarter']] }));
    const brk5 = (await v1('/v1/stocks/084670702/holders')).body.data.holders[0];
    expect([brk5.cusip, brk5.issuer_cusip6, brk5.shares, brk5.prev_shares, brk5.share_change, brk5.shares_unit, brk5.shares_ratio, brk5.value_delta_basis]).toEqual([null, '084670', 16000, 12900, 3100, 'BRK.B', { '084670108': 1500 }, 'net_shares_repriced']);
    // A client pinned to the summed rows (2026-11-09) is told when the pin ends; an unpinned one isn't.
    let lastBody: any = null;
    const hdrs = async (path: string, pin?: string) => {
      const res = await handleRequest(new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${key}`, ...(pin ? { 'copybook-schema-version': pin } : {}) } }), env);
      lastBody = await res.clone().json().catch(() => null);
      return res.headers;
    };
    let pinnedHolders: any = null;
    // Before Nov 23 every client is warned (unpinned ones break that day), in one format: Deprecation @<epoch>.
    const echoed: (string | null)[] = [];
    for (const path of ['/v1/stocks/084670702/holders', '/v1/changes/2026Q3?cusip=084670702']) {
      for (const pin of ['2026-11-09', undefined]) {
        const hd = await hdrs(path, pin);
        echoed.push(hd.get('copybook-schema-version'));
        if (pin && path.includes('/holders')) pinnedHolders = lastBody;
        expect([hd.get('deprecation'), hd.get('sunset'), /changelog\?id=2026-11-23-per-class-rows>; rel="deprecation"/.test(hd.get('link') ?? '')]).toEqual(['@1795392000', 'Mon, 22 Feb 2027 00:00:00 GMT', true]);
      }
    }
    // A held row passes through a pinned summed response as ingest published it: nothing re-derives a direction or dollars.
    const held = pinnedHolders.data.holders.find((r: { filer: { cik: string } }) => r.filer.cik === '0000102909');
    expect([held.change, held.unreliable, held.unreliable_reason, held.value_delta_usd, held.net_direction ?? null, held.shares]).toEqual(['unknown', 'shares', 'share count 2,250x the prior quarter', null, null, 9_000_000]);
    // Every /v1 response names the schema it served (the PM, Nov 11): a valid pin or the default (the holders calls
    // above), errors and the spec too; an unknown pin is refused and never echoed. (Unmetered calls: this test is near
    // the 60-a-minute limit.)
    const { SCHEMA_VERSION } = await import('../src/v1');
    const bad = await handleRequest(new Request('https://api.test/v1/filers', { headers: { authorization: `Bearer ${key}`, 'copybook-schema-version': '1999-01-01' } }), env);
    const sp = await handleRequest(new Request('https://api.test/v1/openapi.json'), env);
    const pv = await handleRequest(new Request('https://api.test/v1/filers', { headers: { authorization: `Bearer ${key}`, 'copybook-schema-version': '2026-11-23' } }), env);
    expect([pv.status, /preview available from Sat Nov 21, 2026/.test((await pv.json()).error.message)]).toEqual([400, true]);
    expect([echoed, bad.status, bad.headers.get('copybook-schema-version'), sp.headers.get('copybook-schema-version'), /copybook-schema-version/.test(bad.headers.get('access-control-expose-headers') ?? '')]).toEqual([['2026-11-09', SCHEMA_VERSION, '2026-11-09', SCHEMA_VERSION], 400, SCHEMA_VERSION, SCHEMA_VERSION, true]);
    // Public responses never name a machine or tunnel host (the lead, Nov 11), even when the request came in on gene's
    // Funnel: Link headers, bulk URLs and the spec's servers all use the one public base.
    const viaGene = await handleRequest(new Request('https://api.test/v1/stocks/084670702/holders', { headers: { authorization: `Bearer ${key}`, 'x-copybook-public-base': 'https://gene.tail70ba3.ts.net/copybook' } }), env);
    const spec = await (await handleRequest(new Request('https://api.test/v1/openapi.json'), env)).text();
    expect([viaGene.headers.get('link')?.startsWith('<https://copybook-api.factordynamics.workers.dev/v1/changelog'), /tail70ba3|trycloudflare/.test((() => { const all: string[] = []; viaGene.headers.forEach((v) => void all.push(v)); return all.join(' '); })() + (await viaGene.text()) + spec), JSON.parse(spec).servers]).toEqual([true, false, [{ url: 'https://copybook-api.factordynamics.workers.dev' }]]);
    // From Nov 23 only pinned clients and endpoints are warned, until Feb 22, 2027; then nobody.
    const { perClassNotice } = await import('../src/v1');
    const at = (d: string, pinned: boolean) => !!perClassNotice(pinned, 'https://b', Date.parse(d));
    expect([at('2026-11-22T23:59:59Z', false), at('2026-11-23T00:00:00Z', false), at('2027-02-21T23:59:59Z', true), at('2027-02-22T00:00:00Z', true)]).toEqual([true, false, true, false]);
    // A webhook body carries the same notice inside the signature; a pinned endpoint keeps it after Nov 23.
    const { withNotice } = await import('../src/channels');
    const hook = (sv?: string) => ({ webhook: { url: 'https://h', secret: 's', created: '', ...(sv ? { schema_version: sv } : {}) } });
    expect(JSON.parse(withNotice(hook(), '{"type":"13f"}', Date.parse('2026-11-12T00:00:00Z'))).deprecation).toEqual({ deprecated_at: '2026-11-23T00:00:00Z', sunset: '2027-02-22T00:00:00Z', link: 'https://copybook-api.factordynamics.workers.dev/v1/changelog?id=2026-11-23-per-class-rows' });
    expect([withNotice(hook(), '{"type":"13f"}', Date.parse('2026-12-01T00:00:00Z')), 'deprecation' in JSON.parse(withNotice(hook('2026-11-09'), '{"type":"13f"}', Date.parse('2026-12-01T00:00:00Z')))]).toEqual(['{"type":"13f"}', true]);
    expect('classes' in (await v1('/v1/stocks/NVDA/holders')).body.data.holders[0]).toBe(false);
    const nch = (await v1('/v1/changes/2026Q3?ticker=NVDA')).body.data.filter((r: { put_call: string | null }) => !r.put_call);
    // A holder index from before hl/ schema 3 has no held marking: GuardCap's BKNG (646,216 -> 1,304 sh, $121.6M -> $6.7M)
    // is marked at read time, never served as a -$3.30B trade; a real trim beside it is untouched. Schema 3: as published.
    const bkng = (schema?: number) => JSON.stringify({ issuer: '09857L', tickers: ['BKNG'], ...(schema ? { schema } : {}), columns: ['cik', 'name', 'slug', 'type', 'curated', 'period', 'shares', 'prev_shares', 'value', 'prev_value', 'change', 'put_call', 'cusip'],
      rows: [['0001732008', 'GuardCap', null, 'long_only', false, '2026Q3', 1304, 646216, 6_676_571, 121_636_487, 'trimmed', null, '09857L108'], ['0000000077', 'Steady', null, 'long_only', false, '2026Q3', 900, 1000, 4_608_000, 5_120_000, 'trimmed', null, '09857L108']] });
    const bk = async () => (await v1('/v1/changes/2026Q3?cusip=09857L108')).body.data.map((r: { filer: { name: string }; value_delta_usd: number | null; unreliable?: string; value_change_usd?: number }) => [r.filer.name, r.value_delta_usd, r.unreliable ?? null, r.value_change_usd ?? null]);
    await hist.put('hl/09857L.json', bkng());
    expect(await bk()).toEqual(expect.arrayContaining([['GuardCap', null, 'shares', 6_676_571 - 121_636_487], ['Steady', -512_000, null, null]]));
    await hist.put('hl/09857L.json', bkng(3));
    expect((await bk()).find((r: unknown[]) => r[0] === 'GuardCap')).toEqual(['GuardCap', expect.any(Number), null, null]);
    expect(nch.reduce((a: number, r: { value_delta_usd: number }) => a + r.value_delta_usd, 0)).toBe(h.data.counts.net);
    expect(h.data.holders.map((x: { filer: { cik: string } }) => x.filer.cik)).toEqual(['0002045724', '0000102909', '0001067983', '0001387322']);
    expect(h.data.options.map((x: { filer: { cik: string; type: string } }) => [x.filer.cik, x.filer.type])).toEqual([['0001423053', 'hedge_fund']]);
    expect(h.data.exited).toEqual([expect.objectContaining({ kind: 'calls', put_call: 'CALL', shares: 0, weight: null, change: 'exited' })]); // as EDGAR writes it
    // An index with the data run's value_delta column (run 43049731351 on): rows serve it as their dollar change and net
    // is their sum, whatever shares x price implies (a filer's two lines, a capped line); a flagged row is null, marked.
    await hist.put('hl/30233Q.json', JSON.stringify({
      issuer: '30233Q', tickers: ['XOM'], counts: { holders: 3, net: 1_000_000 - 250_000, net_quarter: '2026Q3', net_by_period: { '2026Q3': 750_000 } },
      columns: ['cik', 'name', 'slug', 'type', 'curated', 'period', 'shares', 'prev_shares', 'value', 'prev_value', 'change', 'put_call', 'unreliable', 'value_change', 'value_delta', 'value_delta_basis', 'shares_basis'],
      rows: [
        ['0000000101', 'Two Lines LP', null, 'hedge_fund', false, '2026Q3', 20_000, 10_000, 2_400_000, 1_000_000, 'added', null, null, null, 1_000_000, 'trade', null],
        ['0000000102', 'Capped LP', null, 'hedge_fund', false, '2026Q3', 5_000, 7_500, 600_000, 850_000, 'trimmed', null, null, null, -250_000, 'filed_value', null],
        ['0000000103', 'Units Off LP', null, 'hedge_fund', false, '2026Q3', 1_304, 646_216, 6_700_000, 121_600_000, 'trimmed', null, 'shares', -114_900_000, 0, null, null],
        ['0000000104', 'Contracts LP', null, 'hedge_fund', false, '2026Q3', 30_000, 10_000, 3_600_000, 1_200_000, 'added', 'Call', null, null, 2_400_000, 'trade', 'contracts'],
      ],
    }), { customMetadata: { build_id: 'gh-43049731351-1', built_at: '2026-11-11T16:20:00.000Z' } });
    const xh = (await v1('/v1/stocks/30233Q/holders?current_only=false')).body.data;
    const xc = (await v1('/v1/changes/2026Q3?cusip=30233Q&limit=100')).body.data as { value_delta_usd: number | null; trade_usd_implied: number; unreliable?: string; value_change_usd?: number; filer: { name: string } }[];
    expect(xc.map((r) => [r.filer.name, r.value_delta_usd, r.unreliable ?? null])).toEqual(expect.arrayContaining([['Two Lines LP', 1_000_000, null], ['Capped LP', -250_000, null], ['Units Off LP', null, 'shares']]));
    // net covers share rows (put_call null): the contract-filed call line is labelled but not in it.
    expect(xc.filter((r) => !(r as { put_call?: string | null }).put_call).reduce((a, r) => a + (r.value_delta_usd ?? 0), 0)).toBe(xh.counts.net);
    expect(xc.find((r) => r.filer.name === 'Two Lines LP')!.trade_usd_implied).toBe(1_200_000); // implied, not summed
    // A flagged line's implied trade is null (its price is the bad part); counts say where the rows' figures come from:
    // this index has the column ("hl"), NVDA's older one doesn't ("implied": its rows don't sum to net).
    expect([xc.find((r) => r.filer.name === 'Units Off LP')!.trade_usd_implied, xh.counts.value_delta_source, h.data.counts.value_delta_source]).toEqual([null, 'hl', 'implied']);
    // The data run's labels pass through: what each value_delta measures, and a contract-filed option line.
    const lab = xc as unknown as { filer: { name: string }; value_delta_basis: string | null; shares_basis?: string }[];
    expect(['Two Lines LP', 'Capped LP', 'Units Off LP', 'Contracts LP'].map((n) => { const r = lab.find((x) => x.filer.name === n); return [r?.value_delta_basis, r?.shares_basis ?? null]; })).toEqual([['trade', null], ['filed_value', null], [null, null], ['trade', 'contracts']]);
    expect(xc.find((r) => r.filer.name === 'Units Off LP')!.value_change_usd).toBe(-114_900_000);
    // current_only=false adds the filer whose latest 13F is a year old.
    const every = (await v1('/v1/stocks/NVDA/holders?current_only=false')).body;
    expect([every.count, every.filers, every.data.holders[4].filer.name, every.data.counts.holders, every.data.counts.holders_all]).toEqual([5, 5, 'Old Filer LP', 5, 5]);
    // include_options=true mixes calls and puts into the list.
    const mixed = (await v1('/v1/stocks/NVDA/holders?include_options=true')).body;
    expect([mixed.count, mixed.filers, mixed.data.holders[2].filer.name]).toEqual([5, 5, 'Citadel Advisors LLC']);
    expect(h.data.holders[0]).toEqual({ filer: { cik: '0002045724', name: 'Situational Awareness LP', slug: 'situational-awareness-lp-5724', type: 'hedge_fund', curated: false }, period: '2026Q3', kind: 'equity', put_call: null, shares: 100, prev_shares: 40, share_change: 60, value_usd: 18000, value_delta_usd: 10800, value_delta_basis: null, trade_usd_implied: 10800, prev_value_usd: 6000, change: 'added', weight: null, accession: null, original_accession: null, accepted_at: null, cusip: null, prev_cusip: null, issuer: null });
    // A curated fund's row: its latest 13F, acceptance from the filing cache, weight of its $2,000 book.
    expect(h.data.holders[2]).toMatchObject({ filer: { slug: 'warren-buffett', curated: true }, accession: 'A2', accepted_at: '2026-08-14T20:05:04Z', weight: 0.9 });
    expect(h.data.holders[3]).toMatchObject({ prev_shares: null, share_change: null, change: 'new' });
    // Any filer's row with an accession gets EDGAR's acceptance time: the first request queues the issuer, gene's cron
    // reads each filing's index headers (Eastern wall time to UTC), and the next request has it. No-dash accessions match.
    await hist.put('hl/037833.json', JSON.stringify({ issuer: '037833', tickers: ['AAPL'], rows_total: 2, columns: ['cik', 'name', 'type', 'curated', 'period', 'shares', 'value', 'change', 'accession'], rows: [
      ['0000102909', 'Vanguard Group Inc', 'index', false, '2026Q3', 50, 9000, 'added', '0000102909-26-000123'],
      ['0002045724', 'Situational Awareness LP', 'hedge_fund', false, '2026Q3', 10, 900, 'new', '000204572426000007'],
    ] }));
    const aapl = async () => (await v1('/v1/stocks/AAPL/holders')).body.data.holders.map((x: { accepted_at: string | null }) => x.accepted_at);
    expect(await aapl()).toEqual([null, null]);
    const secReads: string[] = [];
    const before = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      const m = String(u).match(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d{18})\/([\d-]+)-index-headers\.html$/);
      if (!m) return before(u, init);
      secReads.push(`${m[1]} ${m[3]}`);
      return m[1] === '102909' ? new Response('<SEC-HEADER>\n<ACCEPTANCE-DATETIME>20261103161501\n</SEC-HEADER>') : new Response('<ACCEPTANCE-DATETIME>20260814160504');
    });
    const { fillAccepted } = await import('../src/v1data');
    expect(await fillAccepted(env, 300, 10_000)).toMatchObject({ fetched: 2, errors: 0, issuers_left: 0 });
    vi.stubGlobal('fetch', before);
    expect(secReads.sort()).toEqual(['102909 0000102909-26-000123', '2045724 0002045724-26-000007']);
    expect(await aapl()).toEqual(['2026-11-03T21:15:01Z', '2026-08-14T20:05:04Z']); // EST after Nov 1, EDT before
    expect(await fillAccepted(env)).toEqual({ queued: 0 }); // nothing left to read
    const ciks = async (q: string) => (await v1(`/v1/stocks/NVDA/holders${q}`)).body.data.holders.map((x: { filer: { cik: string } }) => x.filer.cik);
    expect(await ciks('?type=hedge_fund')).toEqual(['0002045724', '0001387322']);
    expect(await ciks('?type=hedge_fund&include_options=true')).toEqual(['0002045724', '0001423053', '0001387322']);
    expect(await ciks('?type=hedge_fund,active')).toEqual(['0002045724', '0001067983', '0001387322']);
    expect(await ciks('?type=smart_money')).toEqual(['0002045724', '0001067983', '0001387322']); // ingest's hedge_fund + long_only
    // During ingest's rename, long_only and active match each other.
    expect(await ciks('?type=long_only&current_only=false')).toEqual(['0001067983', '0000000077']);
    expect(await ciks('?cohort=curated')).toEqual(['0001067983']);
    expect(await ciks('?quarter=2026Q3')).toEqual(['0002045724']);
    const page = (await v1('/v1/stocks/67066G104/holders?limit=2&offset=1')).body;
    expect([page.count, page.next_offset, page.data.holders.map((x: { filer: { cik: string } }) => x.filer.cik)]).toEqual([4, 3, ['0000102909', '0001067983']]);
    for (const bad of ['?type=hedgefund', '?limit=0', '?cohort=x', '?current_only=yes', '?include_options=1']) expect((await v1(`/v1/stocks/NVDA/holders${bad}`)).status).toBe(400);
    expect((await v1('/v1/stocks/ZZZZ/holders')).status).toBe(404);
    // The session route for My book (Pro): the same rows, lensed.
    const sj = await (await call('/stocks/NVDA/holders?type=hedge_fund&limit=1', { token: t })).json();
    expect([sj.count, sj.next_offset, sj.holders[0].filer.cik, sj.truncated]).toEqual([2, 1, '0002045724', false]);
    // /v1/changes by ticker reads the same index, with a filer-type cohort.
    const ch = (await v1('/v1/changes/2026Q3?ticker=NVDA&cohort=hedge_fund')).body;
    expect([ch.build_id, ch.data.map((r: { filer: { cik: string }; value_delta_usd: number | null }) => [r.filer.cik, r.value_delta_usd])]).toEqual(['gust-3a8c773b', [['0002045724', 10800], ['0001423053', 5000]]]);
    // A past quarter by ticker would list only filers whose latest 13F is that quarter (the quant: XOM's 2026Q2 left out
    // FMR, which has since filed Q3): refused until the per-quarter index ships, on /changes and holders alike.
    for (const path of ['/v1/changes/2026Q2?ticker=NVDA', '/v1/stocks/NVDA/holders?quarter=2026Q2']) {
      const past = await v1(path);
      expect([past.status, past.body.error.code, /\/v1\/bulk\/2026Q2/.test(past.body.error.message), /Nov 23/.test(past.body.error.message)]).toEqual([400, 'quarter_incomplete_by_ticker', true, true]);
    }
    expect((await v1('/v1/changes/2026Q2?filer=0001387322')).status).not.toBe(400);

    // Bulk exports: listed, then streamed as uploaded.
    expect((await v1('/v1/bulk/2026Q2.csv.gz')).status).toBe(501);
    const gzBytes = new Uint8Array(1_200_000);
    gzBytes.set([31, 139, 8, 0]);
    hist.m.set('bulk/2026Q2.csv.gz', gzBytes);
    const gzSha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', gzBytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
    hist.meta.set('bulk/2026Q2.csv.gz', { sha256: gzSha }); // stamped at upload
    hist.m.set('bulk/2025Q1.csv.gz', new Uint8Array(1440)); // a stub from a failed run: hidden, and 501 like a missing file
    expect((await v1('/v1/bulk')).body.data).toEqual([{ file: '2026Q2.csv.gz', quarter: '2026Q2', kind: 'books', bytes: 1_200_000, etag: null, sha256: gzSha, uploaded_at: '1970-01-01T00:00:00Z', url: 'https://copybook-api.factordynamics.workers.dev/v1/bulk/2026Q2.csv.gz' }]);
    const bulkVia = await (await handleRequest(new Request('https://api.test/v1/bulk', { headers: { authorization: `Bearer ${key}`, 'x-copybook-public-base': 'https://gene.tail70ba3.ts.net/copybook' } }), env)).json();
    expect(bulkVia.data[0].url).toBe('https://copybook-api.factordynamics.workers.dev/v1/bulk/2026Q2.csv.gz');
    expect((await v1('/v1/bulk/2025Q1.csv.gz')).status).toBe(501);
    const gz = await handleRequest(new Request('https://api.test/v1/bulk/2026Q2.csv.gz', { headers: { authorization: `Bearer ${key}` } }), env);
    expect(gz.headers.get('content-disposition')).toBe('attachment; filename="copybook-13f-2026Q2.csv.gz"');
    const got = new Uint8Array(await gz.arrayBuffer());
    expect([got.length, ...got.slice(0, 4)]).toEqual([1_200_000, 31, 139, 8, 0]);

    // On the Funnel name, without R2 signing, a bulk file comes straight from here, bytes intact.
    const orig = globalThis.fetch;
    const envF = env;
    const viaF = (path: string) => handleRequest(new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${key}`, 'x-copybook-public-base': 'https://gene.tail70ba3.ts.net/copybook' } }), envF);
    const direct = await viaF('/v1/bulk/2026Q2.csv.gz');
    expect([direct.status, ...new Uint8Array(await direct.arrayBuffer()).slice(0, 2)]).toEqual([200, 31, 139]);
    // With the service's R2 signing configured, a bulk file answers 302 on every host to a 5-minute presigned URL on
    // the account's R2 endpoint (R2 itself answers 403 once it expires); a stub stays 501.
    Object.assign(envF, { CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'acct' });
    // The bucket the links sign holds an older copy (the Nov 9 stale bulk files): the download streams the listed file
    // from here, never the stale one, and the listed file is mirrored to the bucket with its sha256.
    const bucketUrl = 'https://acct.r2.cloudflarestorage.com/copybook-history/bulk/2026Q2.csv.gz';
    let served = { size: 900_000, sha: 'stale' };
    const bulkPuts: string[] = [];
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u).endsWith('/user/tokens/verify')) return Response.json({ result: { id: 'tokid' } });
      if (String(u) === bucketUrl && init?.method === 'PUT') {
        const h = init.headers as Record<string, string>;
        bulkPuts.push(`${h['x-amz-meta-sha256']} ${(init.body as Uint8Array).length}`);
        served = { size: (init.body as Uint8Array).length, sha: h['x-amz-meta-sha256'] };
        return new Response(null, { status: 200 });
      }
      if (String(u) === bucketUrl) return new Response('x', { status: 206, headers: { 'content-range': `bytes 0-0/${served.size}`, etag: '"e1"', 'x-amz-meta-sha256': served.sha } });
      return orig(u, init);
    });
    const plain = (path: string) => handleRequest(new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${key}` } }), envF);
    const stale = await plain('/v1/bulk/2026Q2.csv.gz');
    expect([stale.status, (await stale.arrayBuffer()).byteLength, stale.headers.get('content-length')]).toEqual([200, 1_200_000, '1200000']);
    // RFC 9530: the sha256 of the bytes, base64 between colons.
    expect(stale.headers.get('repr-digest')).toBe(`sha-256=:${btoa(String.fromCharCode(...gzSha.match(/../g)!.map((x) => parseInt(x, 16))))}:`);
    await vi.waitFor(() => expect(bulkPuts).toEqual([`${gzSha} 1200000`]));
    for (const r of [await plain('/v1/bulk/2026Q2.csv.gz'), await viaF('/v1/bulk/2026Q2.csv.gz')]) {
      const u = new URL(r.headers.get('location')!);
      expect([r.status, `${u.origin}${u.pathname}`, u.searchParams.get('X-Amz-Expires'), u.searchParams.get('X-Amz-SignedHeaders'), !!u.searchParams.get('X-Amz-Signature'), u.searchParams.get('response-content-disposition')])
        .toEqual([302, 'https://acct.r2.cloudflarestorage.com/copybook-history/bulk/2026Q2.csv.gz', '300', 'host', true, 'attachment; filename="copybook-13f-2026Q2.csv.gz"']);
    }
    // ?redirect=false: the same link as JSON with 200, for Python urllib (it forwards Authorization on a redirect).
    const asJson = await plain('/v1/bulk/2026Q2.csv.gz?redirect=false');
    const j = (await asJson.json()).data;
    expect([asJson.status, asJson.headers.get('location'), j.file, j.auth, j.sha256, j.bytes, new URL(j.url).pathname, Date.parse(j.expires_at) - Date.now() > 250_000]).toEqual([200, null, '2026Q2.csv.gz', 'none', gzSha, 1_200_000, '/copybook-history/bulk/2026Q2.csv.gz', true]);
    expect((await plain('/v1/bulk/2025Q1.csv.gz')).status).toBe(501);
    // A generated response over 1 MB on the Funnel name: written once under dl/ on R2, then a 302 to it presigned for
    // 5 minutes with its own type and filename; R2 refusing the write leaves it to be served here.
    const { toR2 } = await import('../src/download');
    const puts: string[] = [];
    let putOk = true;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u).endsWith('/user/tokens/verify')) return Response.json({ result: { id: 'tokid' } });
      if (init?.method === 'PUT') return puts.push(`${u} ${(init.headers as Record<string, string>)['content-type']} ${String(init.body).length}`), new Response(null, { status: putOk ? 200 : 500 });
      return orig(u, init);
    });
    const big = new Response(null, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="x.csv"' } });
    const r2 = await toR2(envF, 'a,b\n'.repeat(300_000), big);
    const u2 = new URL(r2!.headers.get('location')!);
    expect([r2!.status, u2.host, u2.searchParams.get('X-Amz-Expires'), u2.searchParams.get('response-content-disposition'), u2.searchParams.get('response-content-type')]).toEqual([302, 'acct.r2.cloudflarestorage.com', '300', 'attachment; filename="x.csv"', 'text/csv; charset=utf-8']);
    expect(puts).toEqual([`https://acct.r2.cloudflarestorage.com${u2.pathname} text/csv; charset=utf-8 1200000`]);
    expect(u2.pathname).toMatch(/^\/copybook-history\/dl\/[0-9a-f-]{36}$/);
    putOk = false;
    expect(await toR2(envF, 'x', big)).toBeNull();
    Object.assign(envF, { CF_API_TOKEN: undefined, CF_ACCOUNT_ID: undefined });
    vi.useRealTimers();
    vi.stubGlobal('fetch', orig);
    Object.assign(env, { PUBLIC_URL: undefined });
    // TEVA (ADS 881624209 -> ordinary M8769Q102, SEC-confirmed): the new code's index has only Q3 filers; the old code's
    // is merged at read time (the analyst: 311 Q3 holders, the 291 still on Q2 gone, FMR read new, Barclays' exit hidden).
    const tcols = ['cik', 'name', 'slug', 'type', 'curated', 'period', 'shares', 'prev_shares', 'value', 'prev_value', 'change'];
    await hist.put('hl/M8769Q.json', JSON.stringify({ issuer: 'M8769Q', tickers: ['TEVA'], counts: { holders: 2, new: 2, by_period: { '2026Q3': 2 } }, columns: tcols, rows: [
      ['0000315066', 'FMR LLC', 'fmr-llc', 'long_only', true, '2026Q3', 25784696, null, 900000000, null, 'new'],
      ['0001364742', 'Norges Bank', null, 'sovereign', false, '2026Q3', 5000000, null, 170000000, null, 'new'],
      ['0001669055', 'IFP Advisors', null, 'wealth', false, '2026Q3', 143876, null, 5000000, null, 'new'],
    ] }));
    await hist.put('hl/881624.json', JSON.stringify({ issuer: '881624', tickers: ['TEVA'], columns: tcols, rows: [
      // FMR's ADS line: exited in Q3 (the reissue). Norges' Q2 holding (its latest on this code). BlackRock still on Q2.
      ['0000315066', 'FMR LLC', 'fmr-llc', 'long_only', true, '2026Q3', 0, 30258016, 0, 1025141579, 'exited'],
      ['0001364742', 'Norges Bank', null, 'sovereign', false, '2026Q2', 4000000, 3900000, 120000000, 110000000, 'added'],
      ['0001364743', 'BlackRock, Inc.', null, 'index', false, '2026Q2', 70000000, 69000000, 2160000000, 2000000000, 'added'],
      // Barclays sold out for real: no ordinary line.
      ['0000312069', 'Barclays PLC', null, 'bank', false, '2026Q3', 0, 800000, 0, 25000000, 'exited'],
      // IFP's Q3 13F lists both codes: a stale ADS line beside the ordinary one.
      ['0001669055', 'IFP Advisors', null, 'wealth', false, '2026Q3', 143891, 140000, 5000500, 4600000, 'added'],
    ] }));
    const codes0 = hist.m.get('pre/stock-codes.json');
    hist.m.set('pre/stock-codes.json', new TextEncoder().encode('{"TEVA":"881624"}'));
    const teva = (await v1('/v1/stocks/TEVA/holders')).body;
    if (!teva.data) throw new Error(JSON.stringify(teva).slice(0, 300));
    const by = Object.fromEntries([...teva.data.holders, ...teva.data.exited].map((r: { filer: { name: string }; change: string; share_change: number | null; period: string }) => [r.filer.name, [r.change, r.share_change, r.period]]));
    expect(by).toEqual({ 'FMR LLC': ['trimmed', -4473320, '2026Q3'], 'Norges Bank': ['added', 1000000, '2026Q3'], 'BlackRock, Inc.': ['added', 1000000, '2026Q2'], 'Barclays PLC': ['exited', -800000, '2026Q3'], 'IFP Advisors': ['added', 3876, '2026Q3'] });
    expect([teva.data.issuer, teva.filers, teva.exited_count, teva.data.counts.merged_from, teva.data.counts.new ?? 0]).toEqual(['M8769Q', 4, 1, ['881624'], 0]);
    // One IFP row, on the new code, the stale line flagged and out of the sums.
    expect(teva.data.holders.filter((r: { filer: { name: string } }) => r.filer.name === 'IFP Advisors').map((r: { cusip: string; shares: number; suspect_duplicate: unknown }) => [r.cusip, r.shares, r.suspect_duplicate])).toEqual([['M8769Q102', 143876, { cusip: '881624209', shares: 143891, value: 5000500 }]]);
    // Ingest's run rewrote the old code's hl/ with the one line still filed under it (Nov 11 12:2x): the old Q2 snapshot
    // (s/881624) carries the priors instead. Holders that didn't carry over stay Q2 holders with no change, never an
    // inferred exit (the lead: ~100 of 247 inferred TEVA exits were false); exits are pending until ingest's merged index.
    // The old code's remaining hl/ row is current: Migdal's Q3 13F still files 39.4M ADS under 881624209 (the quant).
    const hl0 = hist.m.get('hl/881624.json'), rest0 = hist.m.get('pre/v1-filers-rest.txt'), new0 = hist.m.get('hl/M8769Q.json');
    await hist.put('hl/881624.json', JSON.stringify({ issuer: '881624', columns: tcols, rows: [['0001178913', 'Migdal Insurance', null, 'insurance', false, '2026Q3', 39422212, 38900000, 1340000000, 1320000000, 'added']] }));
    // Ingest's own Q3 rows with priors (Sound Shore, Sumitomo) beside the ones lacking them (the analyst: both read as a
    // holding plus an exit).
    await hist.put('hl/M8769Q.json', JSON.stringify({ issuer: 'M8769Q', tickers: ['TEVA'], counts: { holders: 7, by_period: { '2026Q3': 7 } }, columns: tcols, rows: [
      ['0000315066', 'FMR LLC', 'fmr-llc', 'long_only', true, '2026Q3', 25784696, null, 900000000, null, 'new'],
      ['0001364742', 'Norges Bank', null, 'sovereign', false, '2026Q3', 5000000, null, 170000000, null, 'new'],
      ['0001669055', 'IFP Advisors', null, 'wealth', false, '2026Q3', 143876, null, 5000000, null, 'new'],
      ['0000713676', 'PNC Financial', null, 'bank', false, '2026Q3', 1200, null, 42000, null, 'new'],
      ['0001000001', 'Sound Shore', null, 'long_only', false, '2026Q3', 3673882, 3804497, 128000000, 130000000, 'trimmed'],
      ['0001000002', 'Sumitomo Mitsui Trust', null, 'bank', false, '2026Q3', 769408, 769408, 26800000, 26300000, 'unchanged'],
      ['0001000003', 'New Buyer', null, 'other', false, '2026Q3', 100, null, 3500, null, 'new'],
    ] }));
    await hist.put('s/881624.json', JSON.stringify({ issuer: '881624', period: '2026Q2', prev_period: '2026Q1', columns: ['cik', 'name', 'slug', 'kind', 'shares', 'prev_shares', 'value', 'prev_value', 'change', 'accession'], holders: [
      ['0000315066', 'FMR LLC', 'fmr-llc', 'equity', 30258016, 33132795, 1025141579, 997959810, 'trimmed', 'F2'],
      ['0001364743', 'BlackRock, Inc.', null, 'equity', 70000000, 69000000, 2160000000, 2000000000, 'added', 'B2'],
      ['0000312069', 'Barclays PLC', null, 'equity', 800000, 900000, 25000000, 27000000, 'trimmed', 'X2'],
      ['0000713676', 'PNC Financial', null, 'equity', 1000, 900, 31000, 27000, 'added', 'P2'],
      ['0001000001', 'Sound Shore', null, 'equity', 3804497, 3800000, 130000000, 120000000, 'added', 'S2'],
      ['0001000002', 'Sumitomo Mitsui Trust', null, 'equity', 769408, 769408, 26300000, 24000000, 'unchanged', 'T2'],
      ['0001669055', 'IFP Advisors', null, 'equity', 140000, 130000, 4600000, 4000000, 'added', 'I2'],
      ['0001000004', 'Old Exit LP', null, 'equity', 0, 500, 0, 15000, 'exited', 'O2'],
    ] }));
    hist.m.set('pre/v1-filers-rest.txt', new TextEncoder().encode(`2 \n${JSON.stringify([{ slug: 'barclays-plc', cik: '0000312069', name: 'Barclays PLC', manager: null, featured: false, status: null, latest_quarter: '2026Q3' }, { slug: 'blackrock', cik: '0001364743', name: 'BlackRock, Inc.', manager: null, featured: false, status: null, latest_quarter: '2026Q2' }])}`));
    const snapV = (await v1('/v1/stocks/TEVA/holders?current_only=false')).body;
    const bySnap = Object.fromEntries([...snapV.data.holders, ...snapV.data.exited].map((r: { filer: { name: string }; change: string; share_change: number | null; period: string }) => [r.filer.name, [r.change, r.share_change, r.period]]));
    // BlackRock's latest 13F is still Q2: a Q2 holder. Barclays has filed Q3 and lists neither code in either index:
    // pending (filed_newer_not_indexed), out of holders, the counts and net (the analyst, 13:00).
    expect([bySnap['FMR LLC'], bySnap['BlackRock, Inc.'], bySnap['Barclays PLC'], snapV.exited_count, snapV.data.counts.merged_via, snapV.data.counts.exits_pending, snapV.data.counts.merged_from]).toEqual([['trimmed', -4473320, '2026Q3'], [null, null, '2026Q2'], undefined, 0, 'snapshot', true, ['881624']]);
    expect([snapV.data.pending.map((r: { filer: { name: string }; reason: string; period: string }) => [r.filer.name, r.reason, r.period]), snapV.data.counts.pending]).toEqual([[['Barclays PLC', 'filed_newer_not_indexed', '2026Q2']], 1]);
    expect(snapV.data.counts.holders).toBe(snapV.count);
    expect(snapV.data.counts.note).toMatch(/2026Q2 snapshot/);
    // One row per filer, none an exit: a Q3 holding under either code is current.
    const rowsOf2 = [...snapV.data.holders, ...snapV.data.exited] as { filer: { name: string; cik: string } }[];
    expect(rowsOf2.length).toBe(new Set(rowsOf2.map((r) => r.filer.cik)).size);
    expect([bySnap['Sound Shore'], bySnap['Sumitomo Mitsui Trust'], bySnap['PNC Financial'], bySnap['IFP Advisors'], bySnap['Migdal Insurance'], bySnap['Old Exit LP']]).toEqual([['trimmed', -130615, '2026Q3'], ['unchanged', 0, '2026Q3'], ['added', 200, '2026Q3'], ['added', 3876, '2026Q3'], ['added', 522212, '2026Q3'], undefined]);
    hist.m.delete('s/881624.json');
    if (new0) hist.m.set('hl/M8769Q.json', new0);
    if (hl0) hist.m.set('hl/881624.json', hl0);
    if (rest0) hist.m.set('pre/v1-filers-rest.txt', rest0);
    else hist.m.delete('pre/v1-filers-rest.txt');
    // The same view through /v1/changes?ticker=: no new TEVA for a filer that held the ADS, and the trade sized as shares
    // sold x this filing's price (-4,473,320 x $34.90 = -$156.1M), not the value difference (-$125.1M); the quant: FMR
    // read -$4.07M where -$177.1M was right.
    const tch = (await v1('/v1/changes/2026Q3?ticker=TEVA')).body;
    const fmr = tch.data.find((r: { filer: { name: string } }) => r.filer.name === 'FMR LLC');
    expect(tch.data.filter((r: { change: string }) => r.change === 'new')).toEqual([]);
    expect(fmr).toMatchObject({ change: 'trimmed', share_change: -4473320, value_delta_usd: -156138665, cusip: 'M8769Q102', prev_cusip: '881624209' });
    // Holders' net covers one quarter, the latest (the quant: XOM's mixed Q2 and Q3 to -$3.15B where Q3's changes sum to
    // +$3.13B), and equals that quarter's /v1/changes sum: FMR -156.1M, Norges +34.0M, Barclays' exit -25.0M, IFP +0.13M.
    // BlackRock's Q2 add (+30.9M) is Q2's.
    expect([teva.data.counts.net, teva.data.counts.net_quarter, teva.data.counts.net_by_period]).toEqual([-156138665 + 34000000 - 25000000 + 134699, '2026Q3', { '2026Q3': -156138665 + 34000000 - 25000000 + 134699, '2026Q2': null }]);
    // Merged at read time, so net is computed here (not ingest's figure).
    expect([teva.data.counts.net_source, teva.data.counts.net_by_period_incomplete]).toEqual(['computed', ['2026Q2']]);
    expect(tch.data.reduce((a: number, r: { value_delta_usd: number }) => a + r.value_delta_usd, 0)).toBe(teva.data.counts.net);
    expect((await v1('/v1/stocks/TEVA/holders?quarter=2026Q3&current_only=false')).body.data.counts).toMatchObject({ net: teva.data.counts.net, net_quarter: '2026Q3' });
    expect((await v1('/v1/stocks/TEVA/holders?quarter=2026Q2')).status).toBe(400);
    // prev_cusip on every new-code row in the reissue quarter that has a prior, whoever supplied it.
    expect(tch.data.filter((r: { prev_shares: number | null; change: string }) => r.prev_shares && r.change !== 'exited').every((r: { prev_cusip: string | null }) => r.prev_cusip === '881624209')).toBe(true);
    expect(teva.data.holders.find((r: { filer: { name: string } }) => r.filer.name === 'BlackRock, Inc.').cusip).toBe('881624209');
    // A plain ticker: a price move is no trade. 100 -> 110 shares while the price doubled: +$2,000, not +$12,000.
    await hist.put('hl/037833.json', JSON.stringify({ issuer: '037833', tickers: ['AAPL'], counts: { holders: 1, net: 12000 }, columns: tcols, rows: [
      ['0000315066', 'FMR LLC', 'fmr-llc', 'long_only', true, '2026Q3', 110, 100, 22000, 10000, 'added'],
    ] }));
    hist.m.set('pre/stock-codes.json', new TextEncoder().encode('{"TEVA":"881624","AAPL":"037833"}'));
    const ach = (await v1('/v1/changes/2026Q3?ticker=AAPL')).body;
    hist.m.set('pre/issuer-cusips.json', new TextEncoder().encode('{"67066G":"67066G104|NVIDIA","037833":"037833100|Apple \\"Inc\\""}'));
    expect([ach.data[0].value_delta_usd, (await v1('/v1/stocks/AAPL/holders')).body.data.counts.net]).toEqual([2000, 2000]);
    expect((await v1('/v1/changes/2026Q3?ticker=AAPL')).body.data[0]).toMatchObject({ cusip: '037833100', prev_cusip: null, issuer: 'Apple "Inc"' });
    hist.m.delete('pre/issuer-cusips.json');
    hist.m.delete('hl/037833.json');
    if (codes0) hist.m.set('pre/stock-codes.json', codes0);
    else hist.m.delete('pre/stock-codes.json');
  });

  it('Copy paid data: the full Flow from R2, a per-stock holder CSV, one CSV across followed funds', async () => {
    index = { generated_at: '2026-11-08T21:29:01Z', managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, status: 'current', form: '13F-HR', accession: 'A2', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', total_value: 2000, position_count: 1, history_quarters: ['2026Q2', '2026Q1'] }] };
    await cron(17);
    stripeObjects['checkout/sessions/cs_test_pd'] = { id: 'cs_test_pd', status: 'complete', created: now(), subscription: 'sub_pd', customer_details: { email: 'pd@example.com' } };
    stripeObjects['subscriptions/sub_pd'] = sub('sub_pd', 'cus_pd', 'active');
    const t = (await (await fullCheckout('cs_test_pd')).json()).token;
    expect((await call('/flow')).status).toBe(401);

    expect((await call('/flow', { token: t })).status).toBe(404);
    hist.m.set('flow/full.json', new TextEncoder().encode('{"periods":[{"quarter":"2026Q2","featured":{"bought":[{"ticker":"NVDA","n_buyers":31}]}}]}'));
    expect((await (await call('/flow', { token: t })).json()).periods[0].featured.bought[0].n_buyers).toBe(31);

    // Every 13F holder once published: share change computed, names with commas quoted.
    stockPages['NVDA'] = { classes: [{ cusip: '67066G104' }], holders: [{ slug: 'warren-buffett', manager: 'Warren Buffett', quarter: '2026Q2', shares: 10, prev_shares: 0, value: 1800, change: 'new', weight: 0.9 }] };
    // Curated rows carry the fund's CIK, its 13F's accession and EDGAR acceptance (cached per filing).
    await env.DB.put('filing:A2', JSON.stringify({ accession: 'A2', accepted_at: '2026-08-14T20:05:04Z' }));
    let csv = await call('/stocks/nvda/holders.csv', { token: t });
    expect(csv.headers.get('x-copybook-coverage')).toBe('curated');
    expect((await csv.text()).split('\r\n')[1]).toBe('0001067983,Warren Buffett,warren-buffett,equity,2026Q2,10,0,10,1800,,new,0.9,A2,2026-08-14T20:05:04Z,');
    hist.m.set('pre/stock-codes.json', new TextEncoder().encode('{"NVDA":"67066G"}'));
    await hist.put('hl/67066G.json', JSON.stringify({ issuer: '67066G', tickers: ['NVDA'], columns: ['cik', 'name', 'slug', 'type', 'curated', 'period', 'shares', 'prev_shares', 'value', 'prev_value', 'change'], rows: [['0001387322', 'Whale Rock, LLC', null, 'hedge_fund', false, '2026Q2', 100, 140, 18000, 20000, 'trimmed'], ['0000102909', 'Vanguard Group Inc', null, 'index', false, '2026Q2', 50, 50, 9000, 8000, 'unchanged']] }));
    csv = await call('/stocks/NVDA/holders.csv', { token: t });
    expect(csv.headers.get('x-copybook-coverage')).toBe('all-filers');
    expect((await csv.text()).split('\r\n').slice(1, 3)).toEqual(['0001387322,"Whale Rock, LLC",,equity,2026Q2,100,140,-40,18000,20000,trimmed,,,,hedge_fund', '0000102909,Vanguard Group Inc,,equity,2026Q2,50,50,0,9000,8000,unchanged,,,,index']);
    // The lensed CSV: only the filer types asked for.
    expect((await (await call('/stocks/NVDA/holders.csv?type=hedge_fund,active', { token: t })).text()).trim().split('\r\n')).toHaveLength(2);
    expect((await call('/stocks/NVDA/holders.csv?type=nope', { token: t })).status).toBe(400);
    // Like /v1: share positions by default; ?include=options,exited adds those rows, `kind` and `change` say which.
    await hist.put('hl/67066G.json', JSON.stringify({ issuer: '67066G', tickers: ['NVDA'], columns: ['cik', 'name', 'slug', 'type', 'curated', 'period', 'shares', 'prev_shares', 'value', 'prev_value', 'change', 'put_call'], rows: [['0000000001', 'Holder A', null, 'hedge_fund', false, '2026Q2', 100, 100, 1000, 1000, 'unchanged', null], ['0000000002', 'Seller B', null, 'hedge_fund', false, '2026Q2', 0, 50, 0, 500, 'exited', null], ['0000000003', 'Options C', null, 'hedge_fund', false, '2026Q2', 10, 0, 100, 0, 'new', 'Call']] }));
    const kinds = async (q: string) => (await (await call(`/stocks/NVDA/holders.csv${q}`, { token: t })).text()).trim().split('\r\n').slice(1).map((l) => l.split(',').slice(1, 4).filter(Boolean).join(' ') + ' ' + l.split(',')[10]);
    expect(await kinds('')).toEqual(['Holder A equity unchanged']);
    expect(await kinds('?include=options,exited')).toEqual(['Holder A equity unchanged', 'Options C calls new', 'Seller B equity exited']);
    expect((await call('/stocks/NVDA/holders.csv?include=bonds', { token: t })).status).toBe(400);
    // The JSON list for My book is Pro and Fund only.
    expect((await call('/stocks/NVDA/holders', { token: t })).status).toBe(403);
    expect((await call('/stocks/ZZZZ/holders.csv', { token: t })).status).toBe(404);

    // The followed funds' latest books in one file, one row per position with its fund.
    await call('/follows/warren-buffett', { method: 'POST', token: t });
    const all = await call('/follows.csv', { token: t });
    expect(all.headers.get('x-copybook-funds')).toBe('1');
    const lines = (await all.text()).trim().split('\r\n');
    expect(lines[0]).toMatch(/^manager,slug,cik,quarter/);
    expect(lines[1]).toMatch(/^Warren Buffett,warren-buffett,0001067983,2026Q2,2026-06-30,2026-08-14,A2,AAPL,APPLE INC,037833100/);

    // A non-curated follow (Durable, from its public shard) is in the file too, and every row matches the header.
    filers.push({ cik: '0001798849', name: 'Durable Capital Partners LP', slug: 'durable-capital-partners-lp-8849', ok: true, quarter: '2026Q2', filing_date: '2026-08-14' });
    shards['0001798849.json'] = durableQ2;
    expect((await call('/follows/durable-capital-partners-lp-8849', { method: 'POST', token: t })).status).toBe(200);
    const both = await call('/follows.csv', { token: t });
    expect(both.headers.get('x-copybook-funds')).toBe('2');
    const rowsOut = (await both.text()).trim().split('\r\n');
    const n = (l: string) => l.replace(/"(?:[^"]|"")*"/g, '').split(',').length;
    for (const l of rowsOut) expect(n(l)).toBe(n(rowsOut[0]));
    expect(rowsOut.filter((l) => l.startsWith('Durable Capital Partners LP,durable-capital-partners-lp-8849,0001798849,2026Q2,')).length).toBe((durableQ2.rows as unknown[]).length);

    // weight is the equity-book share in every fund's rows: filled for a non-curated book, and, for a curated
    // CSV whose data-run weight counts options (Tepper's summed to 1.034), recomputed with options blank.
    const head = rowsOut[0].split(',');
    const field = (l: string, k: string) => l.replace(/"(?:[^"]|"")*"/g, 'q').split(',')[head.indexOf(k)];
    const sum = (slug: string) => rowsOut.filter((l) => field(l, 'slug') === slug).reduce((a, l) => a + Number(field(l, 'weight')), 0);
    expect(rowsOut.filter((l) => field(l, 'slug') === 'durable-capital-partners-lp-8849' && field(l, 'weight') === '')).toHaveLength(0);
    expect(sum('durable-capital-partners-lp-8849')).toBeCloseTo(1, 4);
    const row = (t: string, pc: string, sh: number, v: number, w: number) => ['Warren Buffett', 'warren-buffett', '0001067983', '2026Q2', '2026-06-30', '2026-08-14', 'A2', t, t, '000000000', 'COM', pc, sh, v, w, ...Array(18).fill('')].join(',');
    hist.m.set('h/warren-buffett/2026Q2.csv', new TextEncoder().encode([head.join(','), row('AAPL', '', 10, 300, 0.29), row('AAPL', 'PUT', 5, 30, 0.03), row('OXY', '', 5, 700, 0.68)].join('\r\n') + '\r\n'));
    const tep = (await (await call('/follows.csv', { token: t })).text()).trim().split('\r\n').filter((l) => field(l, 'slug') === 'warren-buffett');
    expect(tep.map((l) => [field(l, 'ticker'), field(l, 'put_call'), field(l, 'weight')])).toEqual([['AAPL', '', '0.3'], ['AAPL', 'PUT', ''], ['OXY', '', '0.7']]);
    hist.m.delete('h/warren-buffett/2026Q2.csv');
  });

  it('book import: pasted list, broker CSV, and a 13F filer by CIK that follows its newest quarter', async () => {
    stripeObjects['checkout/sessions/cs_test_bk'] = { id: 'cs_test_bk', status: 'complete', created: now(), subscription: 'sub_bk', customer_details: { email: 'bk@example.com' } };
    stripeObjects['subscriptions/sub_bk'] = sub('sub_bk', 'cus_bk', 'active');
    const t = (await (await fullCheckout('cs_test_bk')).json()).token;
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

    // Linking a 13F is Pro and Fund: a Copy member gets 403 pro_required and nothing changes.
    const copyLink = await call('/book/import', { body: { cik: '2045724' }, token: t });
    expect(copyLink.status).toBe(403);
    expect((await copyLink.json()).code).toBe('pro_required');
    expect((await (await call('/follows', { token: t })).json()).follows.book ?? null).toBeNull();
    stripeObjects['subscriptions/sub_bk'] = sub('sub_bk', 'cus_bk', 'active', 'month', 'pro_monthly');
    await webhook({ type: 'customer.subscription.updated', data: { object: stripeObjects['subscriptions/sub_bk'] } });

    // A 13F filer's book: tickers largest first, options left out. Linking it (the default mode, as the
    // site sends it) keeps the hand-added names: the PM lost CRWD, APH and others this way.
    const cols = ['ticker', 'issuer', 'title', 'cusip', 'put_call', 'shares', 'value', 'display_name', 'sector'];
    shards['0002045724.json'] = { ok: true, name: 'Situational Awareness LP', quarter: '2026Q2', columns: cols, rows: [['BE', 'BLOOM', 'COM', '093712107', null, 1, 500, null, null], ['NVDA', 'NVIDIA', 'COM', '67066G104', null, 1, 900, null, null], ['TSM', 'TSMC', 'ADR', '874039100', 'Call', 1, 2000, null, null]] };
    r = await imp({ cik: '2045724' });
    expect(r).toMatchObject({ ok: true, imported: 2, source: { cik: '0002045724', quarter: '2026Q2' } });
    expect(r.follows.owned).toEqual(['NVDA', 'COF', 'BE']);
    expect(r.follows.owned_manual).toEqual(['NVDA', 'COF']);
    expect(r.follows.stocks).toEqual(['NVDA', 'COF', 'TSLA', 'BE']);
    await call('/follows/owned/AMD', { method: 'POST', token: t });
    // A pasted list in merge mode adds hand-added names and keeps the link.
    r = await imp({ text: 'CRWD', mode: 'merge' });
    expect(r.follows.owned).toEqual(['NVDA', 'COF', 'AMD', 'CRWD', 'BE']);
    expect(r.follows.book).toMatchObject({ cik: '0002045724' });

    // The filer's next quarter: BE (linked only) leaves, INTC arrives, every hand-added name stays.
    shards['0002045724.json'] = { ...(shards['0002045724.json'] as object), quarter: '2026Q3', rows: [['NVDA', 'NVIDIA', 'COM', '67066G104', null, 1, 900, null, null], ['INTC', 'INTEL', 'COM', '458140100', null, 1, 100, null, null]] };
    await cron(52);
    let f = (await (await call('/follows', { token: t })).json()).follows;
    expect(f.owned).toEqual(['NVDA', 'COF', 'AMD', 'CRWD', 'INTC']);
    expect(f.stocks).toEqual(['NVDA', 'COF', 'TSLA', 'AMD', 'CRWD', 'INTC']);
    expect(f.book).toMatchObject({ cik: '0002045724', quarter: '2026Q3', tickers: ['NVDA', 'INTC'] });
    // Linking again (same or another filer) still keeps them; removing one by hand drops it for good.
    r = await imp({ cik: '2045724' });
    expect(r.follows.owned).toEqual(['NVDA', 'COF', 'AMD', 'CRWD', 'INTC']);
    await call('/follows/owned/COF', { method: 'DELETE', token: t });
    await cron(52);
    f = (await (await call('/follows', { token: t })).json()).follows;
    expect(f.owned_manual).toEqual(['NVDA', 'AMD', 'CRWD']);
    expect(f.owned).toEqual(['NVDA', 'AMD', 'CRWD', 'INTC']);
    expect(f.stocks).toEqual(['NVDA', 'TSLA', 'AMD', 'CRWD', 'INTC']);

    expect((await call('/book/import', { body: { cik: '0009999999' }, token: t })).status).toBe(404);
    expect((await call('/book/import', { body: { text: '!!! ???' }, token: t })).status).toBe(400);
  });

  it('/v1 events and changes: filters, the poll\'s detail over the data run\'s rows, cross-filer moves by size', async () => {
    index = { generated_at: '2026-11-08T21:29:01Z', managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, status: 'current', form: '13F-HR', accession: 'A2', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', total_value: 2000, position_count: 2, history_quarters: ['2026Q2'] }, { ok: true, slug: 'carl-icahn', cik: '0000921669', manager: 'Carl Icahn', name: 'ICAHN CARL C', featured: true, status: 'current', form: '13F-HR', accession: 'I2', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', total_value: 1000, position_count: 1, history_quarters: ['2026Q2'] }] };
    await cron(17);
    stripeObjects['checkout/sessions/cs_test_ec'] = { id: 'cs_test_ec', status: 'complete', created: now(), subscription: 'sub_ec', customer_details: { email: 'ec@example.com' } };
    stripeObjects['subscriptions/sub_ec'] = sub('sub_ec', 'cus_ec', 'active', 'month', 'pro_monthly');
    const t = (await (await fullCheckout('cs_test_ec')).json()).token;
    const key = (await (await call('/keys', { body: { name: 'k' }, token: t })).json()).key;
    const v1 = async (path: string) => {
      const r = await handleRequest(new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${key}` } }), env);
      return { status: r.status, body: await r.json() };
    };
    const ev = (id: string, kind: string, ticker: string, date: string, extra: Record<string, unknown> = {}) => ({ id, slug: 'warren-buffett', manager: 'Warren Buffett', form: kind === 'form4' ? '4' : 'SC 13D', kind, action: 'buy', filing_date: date, url: `https://www.sec.gov/Archives/edgar/data/1067983/${id.replace(/-/g, '')}/${id}-index.html`, issuer: ticker, issuer_cik: '0000000001', ticker, cusip: ticker === 'OXY' ? '674599105' : null, shares: 100, value_usd: 5000, shares_after: 1000, percent_of_class: null, ...extra });
    events = [ev('0001-26-000001', 'form4', 'OXY', '2026-11-03'), ev('0001-26-000002', '13d', 'SIRI', '2026-11-05'), ev('0001-26-000003', 'form4', 'OXY', '2026-10-01')];
    // The minute poll's parse of #1 (acceptance, classes) and an any-filer 13D the data run doesn't carry.
    await env.DB.put('v1:events', JSON.stringify([
      { ...ev('0001-26-000001', 'form4', 'OXY', '2026-11-03'), accepted: '2026-11-03T21:00:00Z', classes: [{ security: 'Common Stock', bought: 100, sold: 0, value_usd: 5000, shares_before: 900, shares_after: 1000 }] },
      { ...ev('0009-26-000009', '13d', 'OXY', '2026-11-06'), slug: '', manager: 'Some Activist', url: 'https://www.sec.gov/Archives/edgar/data/9999/x-index.html', accepted: '2026-11-06T14:00:00Z', prev_accession: '0009-26-000001', prev_percent_of_class: 4.1, percent_of_class: 6.2 },
    ]));
    let r = await v1('/v1/events?ticker=oxy');
    expect(r.body.count).toBe(3);
    expect(r.body.data.map((e: { accession: string }) => e.accession)).toEqual(['0009-26-000009', '0001-26-000001', '0001-26-000003']);
    expect(r.body.data[1]).toMatchObject({ accepted_at: '2026-11-03T21:00:00Z', filer: { slug: 'warren-buffett', cik: '0001067983' }, classes: [{ shares_before: 900, shares_after: 1000 }] });
    expect(r.body.data[0]).toMatchObject({ filer: { cik: '0000009999', name: 'Some Activist' }, prev: { accession: '0009-26-000001', percent_of_class: 4.1 }, percent_of_class: 6.2 });
    expect((await v1('/v1/events?filer=1067983&form=13d')).body.data.map((e: { accession: string }) => e.accession)).toEqual(['0001-26-000002']);
    expect((await v1('/v1/events?from=2026-11-01&to=2026-11-04')).body.data.map((e: { accession: string }) => e.accession)).toEqual(['0001-26-000001']);
    expect((await v1('/v1/events?cusip=674599105')).body.count).toBe(3); // the OXY rows, by issuer CUSIP
    r = await v1('/v1/events?limit=2');
    expect(r.body).toMatchObject({ count: 4, next_offset: 2 });
    expect((await v1('/v1/events?form=10k')).status).toBe(400);
    // Each bad parameter is named; an impossible date is refused, not read as an empty range.
    for (const [q, name] of [['form=bogus', 'form'], ['from=2026-13-01', 'from'], ['to=2026-02-30', 'to'], ['limit=abc', 'limit'], ['from=2026-11-05&to=2026-11-01', 'from']]) {
      const r = await v1(`/v1/events?${q}`);
      expect([r.status, r.body.error.message.startsWith(name)]).toEqual([400, true]);
    }

    // Once the hourly build publishes pre/events.json, /v1/events serves every filing the investor page
    // shows, with EDGAR's detail. Icahn's real CVI 13D/A #41 (0001193125-26-451979), paired with #40.
    const icahn = (id: string, extra: Record<string, unknown>) => ({ id, slug: 'carl-icahn', manager: 'Carl Icahn', form: 'SCHEDULE 13D/A', kind: '13d', action: 'stake_update', filing_date: '2026-11-06', url: `https://www.sec.gov/Archives/edgar/data/921669/${id.replace(/-/g, '')}/${id}-index.html`, issuer: 'CVR Energy, Inc.', issuer_cik: '0001376139', ticker: 'CVI', cusip: '12662P108', shares_after: 71201875, ...extra });
    hist.m.set('pre/events.json', new TextEncoder().encode(JSON.stringify({ events: [
      icahn('0001193125-26-451979', { accepted: '2026-11-06T21:46:52Z', percent_of_class: 64.1, amendment_no: 41, item4: 'Item 4 of the Initial 13D is hereby amended and supplemented by adding the following: On November 3, 2026, the Issuer entered into an underwriting agreement', prev_accession: '0001193125-26-445965', prev_form: 'SCHEDULE 13D/A', prev_percent_of_class: 70.8, prev_shares_after: 71201875 }),
      icahn('0001193125-26-445965', { filing_date: '2026-11-03', accepted: '2026-11-04T02:57:23Z', percent_of_class: 70.8, amendment_no: 40 }),
      { ...icahn('0001539497-26-002606', { form: '4', kind: 'form4', action: 'buy', filing_date: '2026-09-25', ticker: 'IEP', issuer: 'Icahn Enterprises L.P.', issuer_cik: '0000813762', cusip: null, accepted: '2026-09-25T20:31:10Z', classes: [{ security: 'Depositary Units', bought: 1000, sold: 0, value_usd: 9000, shares_before: 1, shares_after: 1001 }] }) },
    ] })));
    // The poll's own record of #41 has no Item 4: it must not blank the build's.
    await env.DB.put('v1:events', JSON.stringify([icahn('0001193125-26-451979', { accepted: '2026-11-06T21:46:52Z', percent_of_class: 64.1, item4: null })]));
    r = await v1('/v1/events?ticker=CVI');
    expect(r.body.data.map((e: { accession: string }) => e.accession)).toEqual(['0001193125-26-451979', '0001193125-26-445965']);
    expect(r.body.data[0]).toMatchObject({ accepted_at: '2026-11-06T21:46:52Z', percent_of_class: 64.1, amendment_no: 41, prev: { accession: '0001193125-26-445965', percent_of_class: 70.8 }, filer: { slug: 'carl-icahn', cik: '0000921669' } });
    // Served without the amendment preamble.
    expect(r.body.data[0].purpose).toBe('On November 3, 2026, the Issuer entered into an underwriting agreement');
    r = await v1('/v1/events?filer=carl-icahn');
    expect(r.body.count).toBe(3);
    expect(r.body.data[2]).toMatchObject({ kind: 'form4', classes: [{ shares_after: 1001 }] });
    hist.m.delete('pre/events.json');

    // Changes for one filer: its book's change rows, largest first.
    hist.m.set('h/warren-buffett/2026Q2.json', new TextEncoder().encode(JSON.stringify({
      quarter: '2026Q2', report_date: '2026-06-30', accession: 'A2', form: '13F-HR', total_value: 2000, position_count: 2,
      holdings: [{ cusip: '037833100', ticker: 'AAPL', issuer: 'APPLE INC', shares: 10, value: 1500, change: 'trimmed', prev_shares: 20, share_change: -10, value_delta: -1500 }, { cusip: '674599105', ticker: 'OXY', issuer: 'OCCIDENTAL', shares: 5, value: 500, change: 'unchanged', prev_shares: 5, share_change: 0, value_delta: 20 }],
      exited: [{ cusip: '060505104', ticker: 'BAC', issuer: 'BANK OF AMERICA', shares: 0, value: 0, change: 'exited', prev_shares: 5, share_change: -5, value_delta: -2500 }],
    })));
    r = await v1('/v1/changes/2026Q2?filer=warren-buffett');
    expect(r.body.data.map((x: { ticker: string; change: string }) => [x.ticker, x.change])).toEqual([['BAC', 'exited'], ['AAPL', 'trimmed']]);
    expect((await v1('/v1/changes/2026Q2?filer=warren-buffett&change=exited')).body.count).toBe(1);
    // Across filers: the data run's file; cohort by filer type.
    expect((await v1('/v1/changes/2026Q2')).status).toBe(501);
    hist.m.set('changes/2026Q2.json', new TextEncoder().encode(JSON.stringify({ columns: ['cik', 'slug', 'filer_name', 'curated', 'type', 'cusip', 'ticker', 'issuer', 'put_call', 'change', 'shares', 'prev_shares', 'value', 'value_delta'], rows: [
      ['1067983', 'warren-buffett', 'Berkshire', true, 'active', '037833100', 'AAPL', 'APPLE', null, 'trimmed', 10, 20, 1500, -1500],
      ['1387322', null, 'Whale Rock', false, 'hedge_fund', '67066G104', 'NVDA', 'NVIDIA', null, 'new', 50, 0, 9000, 9000],
      ['0000102909', null, 'Vanguard', false, 'index', '037833100', 'AAPL', 'APPLE', null, 'added', 1000, 990, 300000, 400],
    ] })));
    r = await v1('/v1/changes/2026Q2');
    expect(r.body.data.map((x: { filer: { name: string } }) => x.filer.name)).toEqual(['Whale Rock', 'Berkshire', 'Vanguard']);
    expect(r.body.data[0]).toMatchObject({ filer: { cik: '0001387322', type: 'hedge_fund' }, share_change: 50, value_delta_usd: 9000 });
    expect((await v1('/v1/changes/2026Q2?cohort=hedge_fund')).body.data.map((x: { ticker: string }) => x.ticker)).toEqual(['NVDA']);
    expect((await v1('/v1/changes/2026Q2?cohort=curated')).body.data.map((x: { ticker: string }) => x.ticker)).toEqual(['AAPL']);
    expect((await v1('/v1/changes/2026Q2?min_value_usd=1000&change=new,trimmed')).body.count).toBe(2);
    expect((await v1('/v1/changes/2026Q2?change=sold')).status).toBe(400);
  });

  it('lifecycle email: trial ending in 3 days, the season recap for monthly members, one question on cancel; /health counts', async () => {
    const put = (c: string, m: Record<string, unknown>) => env.DB.put(`cus:${c}`, JSON.stringify({ customer: c, email: `${c}@example.com`, status: 'active', plan: 'copy', interval: 'monthly', period_end: 1795000000, subscription: `sub_${c}`, alerts: [], welcomed: true, ...m }));
    const at = Date.UTC(2026, 10, 10, 15, 12);
    const trialEnd = Math.floor(at / 1000) + 2.5 * 86400;
    await put('trial', { status: 'trialing', trial_end: trialEnd });
    await putFollows('trial', { investors: ['warren-buffett', 'bill-ackman'], stocks: ['AAPL'], owned: ['NVDA', 'DHI'] });
    await env.DB.put('stats:trial', JSON.stringify({ n: 7, acc: ['a1', 'a2', 'a3', 'a4', 'a5'], owned: ['DHI'], fastest: 48, fastest_what: 'Warren Buffett 13F' }));
    await put('later', { status: 'trialing', trial_end: trialEnd + 2 * 86400 }); // 4.5 days out: not yet
    await put('ht', { status: 'trialing', trial_end: trialEnd, plan: 'holdterm' }); // Holdterm: never a Copybook email
    await put('seat_x', { status: 'trialing', trial_end: trialEnd, plan: 'fund', seat_of: 'cus_owner' }); // seats don't pay
    await put('comp', { status: 'trialing', trial_end: trialEnd, comped: true }); // critics: never a revenue email
    await put('unsub', { status: 'trialing', trial_end: trialEnd, marketing_off: true }); // unsubscribed: still told before the charge
    await put('promo', { plan: 'pro' });
    await put('yearly', { interval: 'yearly' });

    await cron(12, at);
    expect(sent.map((m) => m.to[0])).toEqual(['trial@example.com', 'unsub@example.com']);
    // Day 11 of 14: their own numbers, what ends, one button to keep it on yearly.
    expect(sent[0].subject).toBe('Your Copy trial ends in 3 days');
    expect(sent[0].text).toContain('Copybook sent you 7 alerts covering 5 filings.');
    expect(sent[0].text).toContain('1 name you own moved in them: DHI.');
    expect(sent[0].text).toContain('Your fastest alert reached you 48 seconds after EDGAR accepted the filing (Warren Buffett 13F).');
    expect(sent[0].text).toContain('alerts for the 2 funds you follow and the 2 names you own');
    const keep = sent[0].text.match(/Keep Copy yearly: \$79\/year, history back to 2013 \(from Dec 31\) · monthly costs \$81\+ even with a pause · founding price locked: (\S+)/)![1];
    expect(sent[0].text).toContain('Or stay monthly at $9/month');
    expect(sent[0].html).toContain(`href="${keep}"`);
    expect(sent[0].text).toContain('founding price locked'); // Copy's founding price (the lead, Nov 11)
    // One unsubscribe, also as the List-Unsubscribe header.
    const unsub = sent[0].text.match(/Unsubscribe from tips and newsletters: (\S+)/)![1];
    expect((sent[0] as unknown as { headers: Record<string, string> }).headers['List-Unsubscribe']).toBe(`<${unsub}>`);
    // A trialist never pays before the trial ends (the lead's P0, Nov 11): never the portal's update flow, which bills
    // the yearly price at once. Stripe calls are recorded.
    let portal = '';
    const posts: { path: string; body: string }[] = [];
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      if (String(u).startsWith('https://api.stripe.com/v1/prices?')) return Response.json({ data: [{ id: `price_${new URL(String(u)).searchParams.get('lookup_keys[]')}`, unit_amount: 7900 }] });
      if (String(u).includes('billing_portal/sessions')) portal = decodeURIComponent(String(init?.body));
      else if (init?.method === 'POST' && String(u).includes('/v1/subscriptions/')) posts.push({ path: String(u).split('/v1/')[1], body: decodeURIComponent(String(init.body)) });
      return orig(u, init);
    });
    const trialSub = (card: boolean) => ({ ...sub('sub_trial', 'trial', 'trialing'), trial_end: trialEnd, ...(card ? { default_payment_method: 'pm_1' } : {}), items: { data: [{ id: 'si_trial', price: { id: 'price_copy_monthly', lookup_key: 'copy_monthly', recurring: { interval: 'month' } } }] } });
    const yearly = async () => (await (await handleRequest(new Request('https://api.test/yearly', { method: 'POST', headers: { authorization: `Bearer ${await signToken(env.SESSION_SECRET, 'session', 'trial', 3600)}`, origin: 'https://refcell.github.io' } }), env)).json()).url as string;
    const keepGet = async () => (await handleRequest(new Request(keep.replace('https://copybook-api.factordynamics.workers.dev/', 'https://api.test/')), env)).headers.get('location') ?? '';
    // 1. No card: the email link and POST /yearly both open the add-a-card choice on yearly; nothing changes at Stripe.
    stripeObjects['subscriptions/sub_trial'] = trialSub(false);
    expect([/account\/\?add_card=yearly&login=/.test(await keepGet()), (await yearly()).endsWith('account/?add_card=yearly'), portal, posts.length]).toEqual([true, true, '', 0]);
    // 2. A card on file: the email link only lands on /account/ (a mail scanner switches nothing); POST /yearly moves the
    // trial to the yearly price here, trial end kept, no proration: $0 today, $79 at the trial's end.
    stripeObjects['subscriptions/sub_trial'] = trialSub(true);
    expect([/account\/\?switch=yearly&login=/.test(await keepGet()), posts.length]).toEqual([true, 0]);
    expect((await yearly()).endsWith('account/?kept=yearly')).toBe(true);
    expect([portal, posts.length, posts[0].body.includes('items[0][price]=price_copy_yearly'), posts[0].body.includes('proration_behavior=none'), posts[0].body.includes(`trial_end=${trialEnd}`)]).toEqual(['', 1, true, true, true]);
    // 3. A paid monthly member: the portal's confirm page, as before.
    posts.length = 0;
    const trialRec = (await env.DB.get('cus:trial'))!;
    await env.DB.put('cus:trial', JSON.stringify({ ...JSON.parse(trialRec), status: 'active', trial_end: null, interval: 'monthly' }));
    stripeObjects['subscriptions/sub_trial'] = { ...trialSub(true), status: 'active', trial_end: null };
    await yearly();
    expect([portal.includes('[items][0][id]=si_trial'), portal.includes('[items][0][price]=price_copy_yearly'), posts.length]).toEqual([true, true, 0]);
    await env.DB.put('cus:trial', trialRec);
    vi.stubGlobal('fetch', orig);
    sent = [];
    await cron(12, at + 86400_000);
    expect(sent).toHaveLength(0); // once per trial
    await env.DB.delete('cus:unsub');

    // After filing week: monthly payers get the recap with the yearly price; yearly and Holdterm don't.
    await env.DB.put('sent:promo', '41'); // a count from before stats: still reads
    await env.DB.put('alerts:latency', JSON.stringify([{ seconds: 50, sent: '2026-11-14T21:00:00Z' }, { seconds: 70, sent: '2026-11-14T21:01:00Z' }, { seconds: 90, sent: '2026-11-14T21:02:00Z' }, { seconds: 4000, sent: '2026-11-14T21:03:00Z', replay: true }]));
    await cron(12, Date.UTC(2026, 10, 18, 15, 12));
    expect(sent.map((m) => m.to[0])).toEqual(['promo@example.com']);
    expect(sent[0].subject).toBe('Your Q3 2026 filing season on Copybook, and yearly for the price of 10 months of monthly'); // the pricing page's words, no dollar figure
    expect(sent[0].text).toContain('Copybook sent you 41 alerts. Our median time from EDGAR acceptance to your inbox this season was 70 seconds.');
    expect(sent[0].text).toContain('Copy Pro monthly: $468 a year. Yearly is $390');
    // One button to the same portal confirm page as the trial's day 11, with the founding price.
    expect(sent[0].text).toMatch(/Switch to yearly: \$390\/year, the price of 10 months of monthly, price locked \(you see the amount and confirm on the next page\): https:\/\/\S+\/keep\?t=/);
    expect(sent[0].text).toContain('Your founding price stays at $39/month or $390/year');
    expect(sent[0].html).toContain('Switch to yearly: $390/year, the price of 10 months of monthly, price locked</a>');
    sent = [];
    await cron(12, Date.UTC(2026, 10, 19, 15, 12));
    expect(sent).toHaveLength(0);

    // Filing week: one ops email a day to the team; none outside the season.
    const { runOpsDigest } = await import('../src/revenue');
    await env.DB.put('alerts:latency', JSON.stringify([{ seconds: 40, sent: '2026-11-14T21:00:00Z' }, { seconds: 70, sent: '2026-11-14T21:01:00Z' }, { seconds: 300, sent: '2026-11-14T21:02:00Z' }, { seconds: 9000, sent: '2026-11-14T21:03:00Z', replay: true }]));
    await env.DB.put('chfail:x1', JSON.stringify({ discord: { reason: '404' } }));
    sent = [];
    const opsAt = Date.UTC(2026, 10, 15, 13, 12);
    expect((await runOpsDigest(env, opsAt)).status).toBe('200');
    await runOpsDigest(env, opsAt + 3600_000);
    expect(sent.map((m) => m.to[0])).toEqual(['hello@factordynamics.com']);
    expect(sent[0].text).toContain('p50 70 s, p90 300 s, from 3 alerts');
    expect(sent[0].text).toContain('Members with a failing channel: discord 1');
    expect((await runOpsDigest(env, Date.UTC(2026, 10, 25, 13, 12))).status).toBe('not a filing week');
    sent = [];

    // A portal cancel: one email with one-click reasons; the webhook repeating sends nothing more.
    const cancel = (id: string, plan = 'copy_monthly') => webhook({ type: 'customer.subscription.updated', data: { object: { ...sub(`sub_${id}`, id, 'active', 'month', plan), cancel_at_period_end: true } } });
    await cancel('yearly');
    await cancel('yearly');
    await cancel('ht', 'holdterm_monthly');
    // A comped subscription (forever 100% off) cancelling: no email either.
    await webhook({ type: 'customer.subscription.updated', data: { object: { ...sub('sub_promo', 'promo', 'active', 'month', 'pro_monthly'), cancel_at_period_end: true, discount: { coupon: { id: 'c', percent_off: 100, duration: 'forever' } } } } });
    // A gate-run test member counts nowhere but gets the email, as a member would.
    await env.DB.put('cus:gate', JSON.stringify({ customer: 'gate', email: 'gate@example.com', status: 'trialing', plan: 'copy', interval: 'monthly', subscription: 'sub_gate', alerts: [], welcomed: true, test: 'gatecheck' }));
    await webhook({ type: 'customer.subscription.updated', data: { object: { ...sub('sub_gate', 'gate', 'trialing'), trial_end: now() + 14 * 86400, cancel_at_period_end: true, metadata: { test: 'gatecheck' } } } });
    expect(sent.map((m) => m.to[0])).toEqual(['yearly@example.com', 'gate@example.com']);
    expect(sent[0].subject).toMatch(/^Your Copy plan ends \w+ \d+ · Resume anytime before then$/);
    expect(sent[1].text).toContain("and you won't be charged");
    // Resume: the link opens the site's page (GET changes nothing); its button POSTs, the cancellation is lifted,
    // one confirmation, and a later cancel asks again.
    const resume = sent[0].text.match(/follows kept:\n(\S+)/)![1];
    expect(resume.startsWith(`${env.SITE_URL}resume/?t=`)).toBe(true);
    const rq = (method: string) => handleRequest(new Request(`https://api.test/resume${new URL(resume).search}`, { method }), env);
    expect((await rq('GET')).headers.get('location')).toBe(resume);
    stripeObjects['subscriptions/sub_yearly'] = sub('sub_yearly', 'yearly', 'active');
    expect((await rq('POST')).headers.get('location')).toMatch(/account\/\?resumed=1&login=/);
    expect(sent.map((m) => m.subject).slice(2)).toEqual(["You've resumed Copy"]);
    expect(JSON.parse((await env.DB.get('cus:yearly'))!)).toMatchObject({ cancel_at_period_end: false });
    await cancel('yearly');
    expect(sent.map((m) => m.subject).slice(3)).toEqual([sent[0].subject]);
    const link = sent[0].text.match(/Too expensive: (\S+)/)![1];
    // The site's /why/ page asks first, then POSTs to the API.
    expect(link).toMatch(new RegExp(`^${SITE.replace(/[./]/g, '\\$&')}why/\\?t=.+&r=price$`));
    const u = new URL(link);
    // Opening the link records nothing (mail scanners follow links); Send posts the reason and the note.
    const page = await handleRequest(new Request(`https://api.test/why${u.search}`), env);
    expect(await page.text()).toContain('Your reason: “Too expensive”. Send it?');
    expect(await env.DB.get('why:yearly')).toBeNull();
    expect((await handleRequest(new Request('https://api.test/why?t=bogus&r=price'), env)).status).toBe(200);
    const thanks = await handleRequest(new Request('https://api.test/why', { method: 'POST', body: new URLSearchParams({ t: u.searchParams.get('t')!, r: 'price', note: 'Need options data' }) }), env);
    expect(await thanks.text()).toContain('“Too expensive” is noted');
    expect(JSON.parse((await env.DB.get('why:yearly'))!)).toMatchObject({ reason: 'price', note: 'Need options data' });
    // The site's referral card asks whether ?ref= is a live code; it never says whose.
    const refOf = async (c: string) => (await handleRequest(new Request(`https://api.test/ref/${c}`), env)).json();
    expect(await refOf('zzzz-not-a-code')).toEqual({ ok: true, valid: false });
    // A reason already given in the app: the cancel email doesn't ask again.
    sent = [];
    await env.DB.put('why:told', JSON.stringify({ reason: 'seasonal', via: 'account', at: new Date().toISOString() }));
    await env.DB.put('cus:told', JSON.stringify({ customer: 'told', email: 'told@example.com', status: 'active', plan: 'copy', interval: 'yearly', subscription: 'sub_told', alerts: [], welcomed: true }));
    await webhook({ type: 'customer.subscription.updated', data: { object: { ...sub('sub_told', 'told', 'active', 'year'), cancel_at_period_end: true } } });
    expect(sent.map((m) => m.to[0])).toEqual(['told@example.com']);
    expect(sent[0].text).not.toContain('One question');
    for (const k of ['cus:told', 'why:told', 'email:told@example.com']) await env.DB.delete(k);

    // A reviewer's reason on a test member (retail's 01:44 "Reviewer test") is never churn.
    await env.DB.put('cus:cus_rv', JSON.stringify({ customer: 'cus_rv', email: 'copybook-test-rv@fldubai.com', status: 'active', plan: 'copy', interval: 'monthly', subscription: 'sub_rv', alerts: [], comped: true, test: true }));
    await env.DB.put('why:cus_rv', JSON.stringify({ reason: 'seasonal', via: 'email', at: new Date().toISOString() }));

    const pub = await (await call('/health')).json();
    expect(pub).not.toHaveProperty('business');
    expect(pub).not.toHaveProperty('fund_requests');
    expect(await (await handleRequest(new Request('https://api.test/health', { headers: { authorization: 'Bearer wrong-token-of-length-x' } }), env)).json()).not.toHaveProperty('business');
    const b = (await (await privateHealth()).json()).business;
    // Holdterm counts as its own plan in the business numbers (its cancel too), though it gets no Copybook email.
    expect(b).toMatchObject({ trials: 2, cancellations_scheduled: 2, fund_seats: 1, comped: 2, cancel_reasons: { price: 1 } });
    expect(b.cancel_reasons).toEqual({ price: 1 });
    expect(b.by_plan).toEqual({ copy_monthly: 3, holdterm_monthly: 1 });
    expect(JSON.stringify(b)).not.toMatch(/@/);
  });

  it('CPU: a busy alert minute defers the hourly jobs to the next quiet one; precomputed lookups replace big parses', async () => {
    const row = (slug: string, cik: string) => ({ ok: true, slug, cik, manager: slug, name: slug, featured: true, form: '13F-HR', accession: `${slug}-q2`, report_date: '2026-06-30', filing_date: '2026-08-14', quarter: '2026Q2' });
    index = { managers: [row('warren-buffett', '0001067983')] };
    await cron(17);
    expect(JSON.parse((await env.DB.get('v1:filers'))!)).toHaveLength(1);
    // Minute :17 again, now with a 13F in the feed that the poll can't finish this minute: busy.
    index = { managers: [row('warren-buffett', '0001067983'), row('dan-loeb', '0001040273')] };
    const today = new Date().toISOString().slice(0, 10);
    secFiles.feed = `<feed><entry><title>13F-HR - BERKSHIRE (0001067983) (Filer)</title><updated>${today}T00:05:00-05:00</updated><category term="13F-HR"/><id>urn:tag:sec.gov,2008:accession-number=0000950123-26-077777</id></entry></feed>`;
    env.SEC_BUDGET = '5';
    await cron(17);
    expect(JSON.parse((await env.DB.get('jobs:due'))!).map((j: { name: string }) => j.name)).toEqual(['backstop']);
    expect(JSON.parse((await env.DB.get('v1:filers'))!)).toHaveLength(1); // not yet
    // The next quiet minute runs it.
    secFiles.feed = '<feed></feed>';
    env.SEC_BUDGET = '40';
    await cron(18);
    expect(JSON.parse((await env.DB.get('v1:filers'))!)).toHaveLength(2);
    expect(await env.DB.get('jobs:due')).toBe('[]');

    // /v1/filers lists the precomputed non-curated rows after the curated ones, paged (default limit 500).
    stripeObjects['checkout/sessions/cs_test_cpu'] = { id: 'cs_test_cpu', status: 'complete', created: now(), subscription: 'sub_cpu', customer_details: { email: 'cpu@example.com' } };
    stripeObjects['subscriptions/sub_cpu'] = sub('sub_cpu', 'cus_cpu', 'active', 'month', 'pro_monthly');
    const tk = (await (await fullCheckout('cs_test_cpu')).json()).token;
    const key = (await (await call('/keys', { body: { name: 'k' }, token: tk })).json()).key;
    const v1 = async (path: string) => (await handleRequest(new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${key}` } }), env)).json();
    const rest = [{ slug: 'whale-rock-7322', cik: '0001387322', curated: false }, { slug: 'x-1', cik: '0001423053', curated: false, type: 'bank', latest_quarter: '2026Q3', history_quarters: ['2026Q3'] }];
    // x-1's full books for 2026Q1 and Q2 are stored: /v1 serves them, so history_quarters lists them (not only the latest).
    for (const q of ['2026Q1', '2026Q2']) hist.m.set(`fb/${q}/0001423053.json`, new TextEncoder().encode('{}'));
    hist.m.set('pre/v1-filers-rest.txt', new TextEncoder().encode(`2 0001067983,0001040273\n${JSON.stringify(rest)}`));
    const all = await v1('/v1/filers');
    expect(all).toMatchObject({ schema_version: expect.any(String), count: 4 });
    expect(all.data.map((f: { slug: string }) => f.slug)).toEqual(['warren-buffett', 'dan-loeb', 'whale-rock-7322', 'x-1']);
    expect((await v1('/v1/filers?curated=false')).data.map((f: { slug: string }) => f.slug)).toEqual(['whale-rock-7322', 'x-1']);
    expect((await v1('/v1/filers?curated=true')).count).toBe(2);
    // The type comes from filer_types.json (hand-checked overrides, reclasses), not the row's own copy.
    expect(all.data.find((f: { slug: string }) => f.slug === 'x-1').type).toBe('hedge_fund');
    // The stored-quarter list is re-read hourly: an hour on, x-1's stored books show.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    expect((await v1('/v1/filers?curated=false')).data.find((f: { slug: string }) => f.slug === 'x-1').history_quarters).toEqual(['2026Q3', '2026Q2', '2026Q1']);
    vi.useRealTimers();
    const page = await v1('/v1/filers?limit=2&offset=1');
    expect([page.count, page.next_offset, page.data.map((f: { slug: string }) => f.slug)]).toEqual([4, 3, ['dan-loeb', 'whale-rock-7322']]);
    expect((await v1('/v1/filers?limit=2&offset=3')).next_offset).toBeNull();
    // No limit: every filer in one response, no next_offset (a paged default silently cut clients to 500 on Nov 11).
    const whole = await v1('/v1/filers');
    expect([whole.data.length, whole.count, 'next_offset' in whole]).toEqual([4, 4, false]);
    expect((await v1('/v1/filers?limit=1001')).error.code).toBe('bad_request');
    // Dan Loeb was curated after the list was built (the header names only Buffett): listed once, as curated, wherever his row was.
    const stale = (rows: unknown[]) => hist.m.set('pre/v1-filers-rest.txt', new TextEncoder().encode(`${rows.length} 0001067983\n${JSON.stringify(rows)}`));
    const loeb = { slug: 'third-point-0273', cik: '0001040273', curated: false };
    for (const rows of [[rest[0], loeb, rest[1]], [rest[0], rest[1], loeb], [loeb]]) {
      stale(rows);
      const r = await v1('/v1/filers');
      expect([r.count, r.data.map((f: { slug: string; curated: boolean }) => `${f.slug}:${f.curated}`)]).toEqual([2 + rows.length - 1, ['warren-buffett:true', 'dan-loeb:true', ...rows.filter((x) => x !== loeb).map((x) => `${x.slug}:false`)]]);
    }
    // A newly curated fund with no history in R2 yet serves its latest book like any filer, still curated.
    shards['0001040273.json'] = { ok: true, cik: '0001040273', quarter: '2026Q2', report_date: '2026-06-30', form: '13F-HR', accession: '0001040273-26-000004', filing_date: '2026-08-14', position_count: 1, total_value: 900, columns: ['ticker', 'issuer', 'cusip', 'put_call', 'shares', 'value'], rows: [['NVDA', 'NVIDIA CORP', '67066G104', null, 5, 900]] };
    await env.DB.put('filing:0001040273-26-000004', JSON.stringify({ accession: '0001040273-26-000004', accepted_at: '2026-08-14T20:00:00Z' }));
    const lb = await v1('/v1/filers/dan-loeb/holdings/latest');
    expect(lb.data).toMatchObject({ filer: { slug: 'dan-loeb', curated: true }, quarter: '2026Q2', total_value_usd: 900, filing: { accession: '0001040273-26-000004' } });

    // Ticker -> issuer from the precomputed map (the full stock list is never fetched).
    hist.m.set('pre/stock-codes.json', new TextEncoder().encode('{"NVDAX":"999999","NVDA":"67066G"}'));
    hist.m.set('s/67066G.json', new TextEncoder().encode(JSON.stringify({ issuer: '67066G', period: '2026Q2', columns: ['cik', 'name', 'slug', 'kind', 'shares', 'prev_shares', 'value', 'prev_value', 'change'], holders: [] })));
    expect((await v1('/v1/stocks/NVDA/holders')).data.issuer).toBe('67066G');
  });

  it('/v1 restatement lineage: versions[] oldest first with status, every amendment attached, ?version= serves the book as originally filed', async () => {
    index = { generated_at: '2026-11-08T21:29:01Z', managers: [{ ok: true, slug: 'warren-buffett', cik: '0001067983', manager: 'Warren Buffett', name: 'Berkshire Hathaway Inc', featured: true, status: 'current', form: '13F-HR/A', accession: 'R', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-09-02', total_value: 3000, position_count: 1, history_quarters: ['2026Q2'] }] };
    await cron(17);
    const ORIG = '0001104659-26-097200', REST = '0001104659-26-104387', NEWH = '0001104659-26-110001';
    // The data run serves the restatement and merged nothing; a later NEW HOLDINGS amendment isn't in it.
    hist.m.set('h/warren-buffett/2026Q2.json', new TextEncoder().encode(JSON.stringify({
      quarter: '2026Q2', report_date: '2026-06-30', accession: REST, form: '13F-HR/A', filing_date: '2026-09-02', sec_url: 'https://www.sec.gov/Archives/edgar/data/1067983/x-index.html', amendments: [], prev_quarter: '2026Q1', total_value: 3000, position_count: 1,
      holdings: [{ cusip: '037833100', ticker: 'AAPL', issuer: 'APPLE INC', title: 'COM', put_call: null, shares: 15, value: 3000, value_as_filed: 3, value_adjusted: true, weight: 1, change: 'added', prev_shares: 10, share_change: 5, value_delta: 1000, split: { ratio: 2, from_quarter: '2026Q1', to_quarter: '2026Q2' }, prev_shares_as_filed: 5 }],
      filings: [{ accession: ORIG, role: 'superseded' }, { accession: REST, role: 'base' }, { accession: NEWH, role: 'ignored', mislabeled_amendment: true }],
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
    const t = (await (await fullCheckout('cs_test_ver')).json()).token;
    const key = (await (await call('/keys', { body: { name: 'k' }, token: t })).json()).key;
    const v1 = async (path: string) => {
      const r = await handleRequest(new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${key}` } }), env);
      return { status: r.status, body: await r.json() };
    };

    const cur = (await v1('/v1/filers/warren-buffett/holdings/2026Q2')).body.data;
    expect(cur.filing).toMatchObject({ accession: REST, accepted_at: '2026-09-01T22:14:00Z', amendment_type: 'RESTATEMENT' });
    expect(cur.filing.versions.map((v: { accession: string; status: string; accepted_at: string }) => [v.accession, v.status, v.accepted_at])).toEqual([
      [ORIG, 'superseded', '2026-08-14T20:18:47Z'],
      [REST, 'current', '2026-09-01T22:14:00Z'],
      [NEWH, 'not_merged', '2026-10-02T13:00:00Z'],
    ]);
    // Amendments come from EDGAR, not only the ones the data run merged.
    expect(cur.filing.amendments.map((a: { accession: string; amendment_type: string }) => [a.accession, a.amendment_type])).toEqual([[REST, 'RESTATEMENT'], [NEWH, 'NEW HOLDINGS']]);
    // Ingest's filing trail marks a mislabeled amendment; a rescaled row carries its unit fix.
    expect([cur.filing.mislabeled_amendment, ...cur.filing.versions.map((v: { mislabeled_amendment: boolean }) => v.mislabeled_amendment), ...cur.filing.amendments.map((v: { mislabeled_amendment: boolean }) => v.mislabeled_amendment)]).toEqual([false, false, false, true, false, true]);
    expect(cur.holdings[0]).toMatchObject({ value_usd: 3000, value_as_filed: 3, value_adjusted: true, value_scale: 1000, prev_shares: 10, prev_shares_as_filed: 5, split: { ratio: 2, from_quarter: '2026Q1', to_quarter: '2026Q2' } });

    const orig = await v1('/v1/filers/warren-buffett/holdings/2026Q2?version=original');
    expect(orig.status).toBe(200);
    expect(orig.body.data).toMatchObject({ version: ORIG, total_value_usd: 2800, position_count: 2, filing: { accession: ORIG, form: '13F-HR', accepted_at: '2026-08-14T20:18:47Z', amendment_type: null, filing_date: '2026-08-14' } });
    expect(orig.body.data.holdings.map((h: { ticker: string; shares: number; value_usd: number; change: string | null }) => [h.ticker, h.shares, h.value_usd, h.change])).toEqual([['AAPL', 10, 2000, null], [null, 20, 800, null]]);
    expect((await v1(`/v1/filers/1067983/holdings/2026Q2?version=${ORIG}`)).body.data.version).toBe(ORIG);
    expect((await v1(`/v1/filers/warren-buffett/holdings/2026Q2?version=${REST}`)).body.data).toMatchObject({ version: REST, total_value_usd: 3000 });
    expect((await v1('/v1/filers/warren-buffett/holdings/2026Q2?version=0000000000-26-000000')).status).toBe(404);
    expect((await v1('/v1/filers/warren-buffett/holdings/2026Q2?version=first')).status).toBe(400);
  });

  it('/v1 mislabeled_amendment: true on a NEW HOLDINGS refile the lineage serves in place of the original, false on a merged one', async () => {
    index = { generated_at: '2026-11-08T21:29:01Z', managers: [{ ok: true, slug: 'matthew-mclennan', cik: '0001325447', manager: 'Matthew McLennan', name: 'First Eagle Investment Management LLC', featured: true, status: 'current', form: '13F-HR/A', accession: 'R', quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-24', total_value: 3000, position_count: 1, history_quarters: ['2026Q1', '2026Q2'] }] };
    await cron(17);
    // McLennan 2026Q2: -000033 (NEW HOLDINGS) re-filed the whole book and is served; ingest's trail calls it an addition.
    // 2026Q1: a small NEW HOLDINGS amendment the data run merged into the original (the Invesco and Blackstone shape).
    const ORIG = '0001325447-26-000020', REFILE = '0001325447-26-000033', Q1 = '0001325447-26-000010', Q1A = '0001325447-26-000015';
    const book = (quarter: string, accession: string, amendments: string[], filings: unknown[]) => new TextEncoder().encode(JSON.stringify({
      quarter, report_date: quarter === '2026Q2' ? '2026-06-30' : '2026-03-31', accession, form: accession === Q1 ? '13F-HR' : '13F-HR/A', amendments, total_value: 3000, position_count: 1, filings,
      holdings: [{ cusip: '037833100', ticker: 'AAPL', issuer: 'APPLE INC', title: 'COM', put_call: null, shares: 15, value: 3000, weight: 1, change: null }],
    }));
    hist.m.set('h/matthew-mclennan/2026Q2.json', book('2026Q2', REFILE, [], [{ accession: ORIG, form: '13F-HR', role: 'base' }, { accession: REFILE, form: '13F-HR/A', role: 'addition', amendment_type: 'NEW HOLDINGS' }]));
    hist.m.set('h/matthew-mclennan/2026Q1.json', book('2026Q1', Q1, [Q1A], [{ accession: Q1, form: '13F-HR', role: 'base' }, { accession: Q1A, form: '13F-HR/A', role: 'addition', amendment_type: 'NEW HOLDINGS' }]));
    secFiles['submissions/CIK0001325447.json'] = JSON.stringify({ filings: { recent: {
      accessionNumber: [REFILE, ORIG, Q1A, Q1], form: ['13F-HR/A', '13F-HR', '13F-HR/A', '13F-HR'], reportDate: ['2026-06-30', '2026-06-30', '2026-03-31', '2026-03-31'],
    } } });
    const dir = (a: string) => `Archives/edgar/data/1325447/${a.replace(/-/g, '')}/`;
    secFiles[`${dir(ORIG)}${ORIG}-index-headers.html`] = '<ACCEPTANCE-DATETIME>20260805152203\n<TYPE>13F-HR\n<FILING-DATE>20260805\n';
    secFiles[`${dir(REFILE)}${REFILE}-index-headers.html`] = '<ACCEPTANCE-DATETIME>20260824160608\n<TYPE>13F-HR/A\n<FILING-DATE>20260824\n';
    secFiles[`${dir(REFILE)}primary_doc.xml`] = '<isAmendment>true</isAmendment><amendmentNo>1</amendmentNo><amendmentType>NEW HOLDINGS</amendmentType>';
    secFiles[`${dir(Q1)}${Q1}-index-headers.html`] = '<ACCEPTANCE-DATETIME>20260512120000\n<TYPE>13F-HR\n<FILING-DATE>20260512\n';
    secFiles[`${dir(Q1A)}${Q1A}-index-headers.html`] = '<ACCEPTANCE-DATETIME>20260520120000\n<TYPE>13F-HR/A\n<FILING-DATE>20260520\n';
    secFiles[`${dir(Q1A)}primary_doc.xml`] = '<isAmendment>true</isAmendment><amendmentNo>1</amendmentNo><amendmentType>NEW HOLDINGS</amendmentType>';

    stripeObjects['checkout/sessions/cs_test_mis'] = { id: 'cs_test_mis', status: 'complete', created: now(), subscription: 'sub_mis', customer_details: { email: 'mis@example.com' } };
    stripeObjects['subscriptions/sub_mis'] = sub('sub_mis', 'cus_mis', 'active', 'month', 'pro_monthly');
    const t = (await (await fullCheckout('cs_test_mis')).json()).token;
    const key = (await (await call('/keys', { body: { name: 'k' }, token: t })).json()).key;
    const filing = async (q: string) => (await (await handleRequest(new Request(`https://api.test/v1/filers/matthew-mclennan/holdings/${q}`, { headers: { authorization: `Bearer ${key}` } }), env)).json()).data.filing;
    const flags = (f: { accession: string; mislabeled_amendment: boolean; versions: { accession: string; status: string; mislabeled_amendment: boolean }[]; amendments: { accession: string; mislabeled_amendment: boolean }[] }) => ({
      filing: [f.accession, f.mislabeled_amendment], versions: f.versions.map((v) => [v.accession, v.status, v.mislabeled_amendment]), amendments: f.amendments.map((a) => [a.accession, a.mislabeled_amendment]),
    });

    expect(flags(await filing('2026Q2'))).toEqual({ filing: [REFILE, true], versions: [[ORIG, 'superseded', false], [REFILE, 'current', true]], amendments: [[REFILE, true]] });
    expect(flags(await filing('2026Q1'))).toEqual({ filing: [Q1, false], versions: [[Q1, 'current', false], [Q1A, 'merged', false]], amendments: [[Q1A, false]] });
  });

  it('/v1 filers and holdings: by slug or CIK, every field the OpenAPI schema requires, as_of from the pit/ index', async () => {
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
    const t = (await (await fullCheckout('cs_test_v')).json()).token;
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
    expect(d.filing.accepted_at).toBe('2025-05-15T20:05:12Z');
    expect(d.filing.amendments).toEqual([{ accession: '0000950123-25-008361', filed_on: '2025-08-14', accepted_at: '2025-08-14T20:10:02Z', amendment_type: 'NEW HOLDINGS', amendment_no: 1, confidential_treatment_expired: true, mislabeled_amendment: null }]); // null: this quarter has no filing trail from the data run
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
    // `weight` keeps its all-rows meaning (options included) until Feb 8, 2027, even once the data run publishes
    // its equity-book weight; weight_equity is equity-only (an option row gets null), weight_incl_options the alias.
    hist.m.set('h/warren-buffett/2025Q2.json', new TextEncoder().encode(JSON.stringify({
      quarter: '2025Q2', report_date: '2025-06-30', accession: '0000950123-25-005701', form: '13F-HR', filing_date: '2025-08-14', sec_url: 'https://www.sec.gov/x', prev_quarter: '2025Q1', total_value: 1500,
      holdings: [
        { cusip: '670346105', ticker: 'NUE', issuer: 'NUCOR CORP', shares: 10, value: 1000, weight: 0.6667, pct_of_book: 1, delta_pct_of_book: 0 },
        { cusip: '670346105', ticker: 'NUE', issuer: 'NUCOR CORP', put_call: 'Call', shares: 5, value: 500, weight: 0.3333, pct_of_book: null, delta_pct_of_book: 0.33 },
      ],
    })));
    const w = (await v1('/v1/filers/warren-buffett/holdings/2025Q2')).body.data.holdings;
    const r3 = (x: number | null) => (x == null ? x : Math.round(x * 1000) / 1000);
    expect(w.map((r: { weight: number | null; weight_incl_options: number | null; weight_equity: number | null }) => [r3(r.weight), r3(r.weight_incl_options), r.weight_equity])).toEqual([[0.667, 0.667, 1], [0.333, 0.333, null]]);
    // Announced with 90 days' notice: the holdings response says when weight changes.
    const wh = (await handleRequest(new Request('https://api.test/v1/filers/warren-buffett/holdings/2025Q2', { headers: { authorization: `Bearer ${key}` } }), env)).headers;
    expect([wh.get('deprecation'), wh.get('sunset'), wh.get('link')]).toEqual(['@1794182400', 'Mon, 08 Feb 2027 00:00:00 GMT', '<https://copybook-api.factordynamics.workers.dev/v1/changelog?id=2026-11-09-weight-equity-only>; rel="deprecation"']);
    // Through gene's front door the link keeps the /copybook prefix (it was missing, so the link returned 401), and it resolves.
    const viaGene = (await handleRequest(new Request('https://api.test/v1/filers/warren-buffett/holdings/2025Q2', { headers: { authorization: `Bearer ${key}`, 'x-copybook-public-base': 'https://gene.tail70ba3.ts.net/copybook' } }), env)).headers.get('link');
    expect(viaGene).toBe('<https://copybook-api.factordynamics.workers.dev/v1/changelog?id=2026-11-09-weight-equity-only>; rel="deprecation"');
    const entry = await (await handleRequest(new Request('https://api.test/v1/changelog?id=2026-11-09-weight-equity-only'), env)).json();
    expect(entry.data.map((c: { id: string }) => c.id)).toEqual(['2026-11-09-weight-equity-only']);
    for (const k of spec.components.schemas.Error.required) expect((await v1('/v1/filers/warren-buffett/holdings/2025Q9')).body).toHaveProperty(k);
    expect((await handleRequest(new Request('https://api.test/v1/changelog'), env)).status).toBe(200); // no key needed
    expect((await handleRequest(new Request('https://api.test/v1/filers', { headers: { authorization: `Bearer ${key}`, 'copybook-schema-version': '1999-01-01' } }), env)).status).toBe(400);
    for (const k of spec.components.schemas.Holdings.required) expect(d).toHaveProperty(k);
    for (const row of [...d.holdings, ...d.exited]) {
      for (const k of spec.components.schemas.Position.required) expect(row).toHaveProperty(k);
      // Nothing undocumented; classes and shares_unit only when the data run publishes them.
      expect(Object.keys(row).sort()).toEqual(Object.keys(spec.components.schemas.Position.properties).filter((k) => !['classes', 'classes_held', 'shares_unit', 'shares_ratio', 'ratio_source', 'issuer_cusip6', 'net_direction'].includes(k) || k in row).sort());
    }

    expect((await v1('/v1/filers/warren-buffett/holdings/2025Q1?as_of=2025-05-20')).body.error.code).toBe('not_yet_available');
    expect((await v1('/v1/filers/warren-buffett/holdings/2025Q1?as_of=garbage')).body.error.code).toBe('bad_request');
    const off = (await v1('/v1/filers/warren-buffett/holdings/2025Q1?as_of=2025-06-01T16:07:00-04:00')).body.error;
    expect([off.code, /read as 2025-06-01T20:07:00Z \(UTC\)/.test(off.message)]).toEqual(['not_yet_available', true]);
    expect((await v1('/v1/filers/warren-buffett/holdings/2025Q1?as_of=2025-06-01&version=original')).body.error.code).toBe('bad_request');
    // Ignoring as_of would hand back today's answer as a point-in-time one.
    for (const p of ['/v1/stocks/AAPL/holders?as_of=2025-06-01', '/v1/changes/2025Q1?filer=warren-buffett&as_of=2025-06-01', '/v1/filers/warren-buffett/holdings?from=2025Q1&to=2025Q1&as_of=2025-06-01']) {
      const r = await v1(p);
      expect([r.status, r.body.error.code]).toEqual([400, 'as_of_not_supported']);
    }
    expect((await v1('/v1/filers/warren-buffett/holdings/2019Q1')).status).toBe(404);
    expect((await v1('/v1/filers/warren-buffett/holdings/Q1')).body.error.code).toBe('bad_request');
    expect((await v1('/v1/filers/nobody/holdings/2025Q1')).status).toBe(404);
    for (const p of ['/v1/me', '/v1/filers', '/v1/filers/{filer}/holdings/{quarter}']) expect(spec.paths[p].get.responses['200'].content).toBeDefined();

    // as_of once ingest's pit/ index exists (draft 2): the latest epoch at or before T. The original's epoch is its stored
    // book (lots[] rebuilt for a one-lot row); the amendment's epoch is the current book; before any version, not_yet_filed.
    const asof = async (path: string) => {
      const r = await handleRequest(new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${key}` } }), env);
      return { status: r.status, h: r.headers, body: await r.json() };
    };
    hist.m.set('pit/0001067983/index.json', new TextEncoder().encode(JSON.stringify({ quarters: { '2025Q1': ['2025-05-15T20:05:12Z', '2025-08-14T20:10:02Z'] } })));
    const epochBook = { quarter: '2025Q1', accession: '0000950123-25-005701', filing: { versions: [{ accession: '0000950123-25-005701', accepted_at: '2025-05-15T20:05:12Z' }] }, holdings: [{ cusip: '670346105', ticker: 'NUE', shares: 10, value_usd: 1000, value_as_filed: 1, value_scale: 1000, source_accession: '0000950123-25-005701', first_disclosed_at: '2025-05-15T20:05:12Z' }], exited: [] };
    hist.m.set('pit/0001067983/2025Q1/20250515T200512Z.json', new TextEncoder().encode(JSON.stringify(epochBook)));
    const may = await asof('/v1/filers/warren-buffett/holdings/2025Q1?as_of=2025-05-20');
    expect([may.status, may.h.get('copybook-as-of'), may.h.get('copybook-epoch'), may.body.data.holdings[0].lots]).toEqual([200, '2025-05-20T23:59:59Z', '2025-05-15T20:05:12Z', [{ accession: '0000950123-25-005701', accepted_at: '2025-05-15T20:05:12Z', superseded_at: null, kind: 'original', shares: 10, value_as_filed: 1, value_scale: 1000, value_usd: 1000 }]]);
    const sep = await asof('/v1/filers/warren-buffett/holdings/2025Q1?as_of=2025-09-01T00:00:00Z');
    // The current epoch is the current book, unchanged (no as_of = as_of now).
    expect([sep.status, sep.h.get('copybook-epoch'), sep.body.data]).toEqual([200, '2025-08-14T20:10:02Z', (await v1('/v1/filers/warren-buffett/holdings/2025Q1')).body.data]);
    const early = await asof('/v1/filers/warren-buffett/holdings/2025Q1?as_of=2025-05-01');
    const latest = await asof('/v1/filers/warren-buffett/holdings/latest?as_of=2025-05-20');
    expect([early.status, early.body.error.code, latest.status, latest.h.get('copybook-epoch')]).toEqual([404, 'not_yet_filed', 200, '2025-05-15T20:05:12Z']);
    // include_superseded: rows a restatement dropped at or before T, with their last lots; never without the flag.
    hist.m.set('pit/0001067983/2025Q1/20250515T200512Z.json', new TextEncoder().encode(JSON.stringify({ ...epochBook, superseded: [{ cusip: '037833100', superseded_at: '2025-05-15T20:05:12Z', lots: [{ accession: '0000950123-25-005701', accepted_at: '2025-05-15T20:05:12Z' }] }, { cusip: '191216100', superseded_at: '2025-08-14T20:10:02Z' }] })));
    const plain = (await asof('/v1/filers/warren-buffett/holdings/2025Q1?as_of=2025-05-20')).body.data;
    const sup = (await asof('/v1/filers/warren-buffett/holdings/2025Q1?as_of=2025-05-20&include_superseded=true')).body.data;
    expect(['superseded' in plain, sup.superseded.map((r: { cusip: string }) => r.cusip)]).toEqual([false, ['037833100']]);
    // Point-in-time bulk: one row per lot, listed as kind pit beside the books, downloadable like them.
    const pitGz = new Uint8Array(1_100_000);
    hist.m.set('bulk/pit/2025Q1.csv.gz', pitGz);
    const listing = (await asof('/v1/bulk')).body.data.find((x: { file: string }) => x.file === 'pit/2025Q1.csv.gz');
    const dl = await handleRequest(new Request('https://api.test/v1/bulk/pit/2025Q1.csv.gz', { headers: { authorization: `Bearer ${key}` } }), env);
    expect([listing?.quarter, listing?.kind, dl.status, dl.headers.get('content-disposition')]).toEqual(['2025Q1', 'pit', 200, 'attachment; filename="copybook-13f-pit-2025Q1.csv.gz"']);
    // Invariant 3: an epoch book naming a filing accepted after T is never served.
    hist.m.set('pit/0001067983/2025Q1/20250515T200512Z.json', new TextEncoder().encode(JSON.stringify({ ...epochBook, holdings: [{ ...epochBook.holdings[0], lots: [{ accession: '0000950123-25-008361', accepted_at: '2025-08-14T20:10:02Z' }] }] })));
    const leak = await asof('/v1/filers/warren-buffett/holdings/2025Q1?as_of=2025-05-20');
    expect([leak.status, leak.body.error.code, JSON.stringify(leak.body).includes('0000950123-25-008361')]).toEqual([500, 'server_error', false]);
  });

  it('EDGAR Eastern timestamps convert to UTC on both sides of the DST switches', async () => {
    const { easternToUtc } = await import('../src/edgar');
    expect(easternToUtc('20260106120000')).toBe('2026-01-06T17:00:00Z'); // EST
    expect(easternToUtc('20260308015959')).toBe('2026-03-08T06:59:59Z'); // just before DST starts
    expect(easternToUtc('20260308030000')).toBe('2026-03-08T07:00:00Z'); // just after
    expect(easternToUtc('20261031235900')).toBe('2026-11-01T03:59:00Z'); // EDT
    expect(easternToUtc('20261102000000')).toBe('2026-11-02T05:00:00Z'); // EST again
  });
});
