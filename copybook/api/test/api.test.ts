import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleRequest } from '../src/index';
import type { Env, KV } from '../src/env';
import { hmacHex } from '../src/tokens';

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

const SITE = 'https://refcell.github.io/gust/copybook/';
const now = () => Math.floor(Date.now() / 1000);

function sub(id: string, customer: string, status: string, interval = 'month') {
  return { id, customer, status, items: { data: [{ price: { recurring: { interval } }, current_period_end: now() + 30 * 86400 }] } };
}

let env: Env;
let sent: { to: string[]; subject: string; text: string }[];
let stripeObjects: Record<string, unknown>;
let index: unknown;

beforeEach(() => {
  env = { DB: new MemKV(), SITE_URL: SITE, DATA_URL: `${SITE}data/`, EMAIL_FROM: 'Copybook <a@b.c>', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', SESSION_SECRET: 'session-secret', RESEND_API_KEY: 're_x' };
  sent = [];
  stripeObjects = {};
  index = { managers: [] };
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
    if (url === `${SITE}data/index.json`) return Response.json(index);
    if (url === `${SITE}data/warren-buffett-history.json`) {
      return Response.json({
        slug: 'warren-buffett', manager: 'Warren Buffett', cik: '0001067983', history_quarters: ['2026Q2', '2026Q1'],
        history: [
          { quarter: '2026Q2', report_date: '2026-06-30', filing_date: '2026-08-14', accession: 'A2', holdings: [{ issuer: 'APPLE INC', ticker: 'AAPL', cusip: '037833100', title: 'COM', shares: 10, value: 2000, weight: 0.5, put_call: null }] },
          { quarter: '2026Q1', report_date: '2026-03-31', filing_date: '2026-05-15', accession: 'A1', holdings: [{ issuer: 'BANK, "OF" AMERICA', ticker: 'BAC', cusip: '060505104', title: 'COM', shares: 5, value: 100, weight: 0.1, put_call: null }] },
        ],
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
    expect(session.member).toMatchObject({ email: 'buyer@example.com', active: true, plan: 'yearly' });

    expect((await call('/history/warren-buffett')).status).toBe(401);
    const hist = await (await call('/history/warren-buffett', { token: session.token })).json();
    expect(hist.history_quarters).toEqual(['2026Q2', '2026Q1']);

    const csv = await (await call('/csv/warren-buffett.csv', { token: session.token })).text();
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('Warren Buffett,warren-buffett,0001067983,2026Q2,2026-06-30,2026-08-14,A2,AAPL,APPLE INC,037833100,COM,,10,2000,0.5');
    expect(lines[2]).toContain('"BANK, ""OF"" AMERICA"');

    const portal = await (await call('/portal', { method: 'POST', token: session.token })).json();
    expect(portal.url).toMatch(/^https:\/\/billing\.stripe\.com\//);

    await webhook({ type: 'customer.subscription.deleted', data: { object: sub('sub_1', 'cus_1', 'canceled', 'year') } });
    expect((await call('/csv/warren-buffett.csv', { token: session.token })).status).toBe(402);
    // Billing stays reachable after cancelling, so they can resubscribe or fetch invoices.
    expect((await call('/portal', { method: 'POST', token: session.token })).status).toBe(200);
  });

  it('exchanges a completed checkout session for a session token right after redirect', async () => {
    stripeObjects['checkout/sessions/cs_test_abc'] = { id: 'cs_test_abc', status: 'complete', created: now() - 30, subscription: 'sub_2', customer_details: { email: 'fast@example.com' } };
    stripeObjects['subscriptions/sub_2'] = sub('sub_2', 'cus_2', 'active');
    const r = await (await call('/session', { body: { checkout_session: 'cs_test_abc' } })).json();
    expect(r.member).toMatchObject({ email: 'fast@example.com', active: true, plan: 'monthly' });
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

  it('cron seeds silently, then emails each active member only the managers they track', async () => {
    const mk = (slug: string, acc: string) => ({ ok: true, slug, accession: acc, manager: slug, name: `${slug} LP`, quarter: '2026Q3', filing_date: new Date().toISOString().slice(0, 10), sec_url: `https://www.sec.gov/${acc}` });
    index = { managers: [mk('warren-buffett', 'A2'), mk('bill-ackman', 'B2')] };
    const put = (c: string, email: string, status: string, alerts: unknown) => env.DB.put(`cus:${c}`, JSON.stringify({ customer: c, email, status, plan: 'monthly', period_end: 0, subscription: `sub_${c}`, alerts, welcomed: true }));
    await put('c1', 'all@example.com', 'active', 'all');
    await put('c2', 'ackman@example.com', 'active', ['bill-ackman']);
    await put('c3', 'off@example.com', 'active', 'off');
    await put('c4', 'gone@example.com', 'canceled', 'all');

    const ctx = { waitUntil: (p: Promise<unknown>) => p };
    let pending: Promise<unknown> = Promise.resolve();
    await worker.scheduled({}, env, { waitUntil: (p) => (pending = ctx.waitUntil(p)) });
    await pending;
    expect(sent).toHaveLength(0);

    // A fund added to the roster with an old filing must not alert; Buffett's new accession must.
    index = { managers: [mk('warren-buffett', 'A3'), mk('bill-ackman', 'B2'), { ...mk('seth-klarman', 'K1'), filing_date: '2026-02-14' }] };
    await worker.scheduled({}, env, { waitUntil: (p) => (pending = p) });
    await pending;
    expect(sent.map((m) => m.to[0])).toEqual(['all@example.com']);
    expect(sent[0].text).toContain('warren-buffett LP');
    expect(sent[0].text).not.toContain('seth-klarman');

    sent = [];
    await worker.scheduled({}, env, { waitUntil: (p) => (pending = p) });
    await pending;
    expect(sent).toHaveLength(0);
  });
});
