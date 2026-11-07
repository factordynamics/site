import { fetchHistory, historyCsv, runAlerts, SLUG } from './data';
import { loginMail, sendMail } from './email';
import { isActive, type Env, type Member } from './env';
import { getMember, LOGIN_TTL, memberByEmail, publicView, putMember, SESSION_TTL, syncSubscription } from './members';
import { stripe, verifyStripeSignature } from './stripe';
import { signToken, verifyToken } from './tokens';

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function allowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  const list = [new URL(env.SITE_URL).origin, ...(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  return LOCAL_ORIGIN.test(origin) || list.includes(origin) ? origin : null;
}

function cors(origin: string | null): Record<string, string> {
  return origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : {};
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 16_384) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Member from `Authorization: Bearer <session token>` (or `?token=` for plain download links). */
async function authed(req: Request, env: Env): Promise<Member | null> {
  const url = new URL(req.url);
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  const p = await verifyToken(env.SESSION_SECRET, token, 'session');
  return p ? getMember(env, p.c) : null;
}

async function issueSession(env: Env, m: Member) {
  return { token: await signToken(env.SESSION_SECRET, 'session', m.customer, SESSION_TTL), member: publicView(m) };
}

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json({ ok: false, error: 'bad signature' }, 400, {});
  }
  const event = JSON.parse(raw);
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode === 'subscription' && obj.subscription) {
        const sub = await stripe(env, 'GET', `subscriptions/${obj.subscription}`);
        await syncSubscription(env, sub, obj.customer_details?.email);
      }
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(env, obj);
      break;
  }
  return json({ ok: true }, 200, {});
}

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const origin = allowedOrigin(req.headers.get('origin'), env);
  const h = cors(origin);

  if (req.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: h });
  if (req.method === 'POST' && path === '/webhook') return handleWebhook(req, env);
  if (req.method === 'POST' && req.headers.get('origin') && !origin) return json({ ok: false, error: 'origin not allowed' }, 403, {});

  if (req.method === 'GET' && path === '/health') return json({ ok: true }, 200, h);

  // Email a sign-in link to an active member. Always answers ok so it can't be used to probe emails.
  if (req.method === 'POST' && path === '/login') {
    const email = String((await body(req)).email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) return json({ ok: false, error: 'invalid email' }, 400, h);
    const m = await memberByEmail(env, email);
    if (isActive(m) && !(await env.DB.get(`rl:${email}`))) {
      await env.DB.put(`rl:${email}`, '1', { expirationTtl: 60 });
      await sendMail(env, [loginMail(env, m.email, await signToken(env.SESSION_SECRET, 'login', m.customer, LOGIN_TTL), false)]);
    }
    return json({ ok: true }, 200, h);
  }

  // Exchange a sign-in link token, or a just-completed Checkout Session id, for a session token.
  if (req.method === 'POST' && path === '/session') {
    const b = await body(req);
    if (typeof b.login === 'string') {
      const p = await verifyToken(env.SESSION_SECRET, b.login, 'login');
      const m = p && (await getMember(env, p.c));
      return m ? json(await issueSession(env, m), 200, h) : json({ ok: false, error: 'link expired or invalid' }, 401, h);
    }
    if (typeof b.checkout_session === 'string' && /^cs_(test|live)_[A-Za-z0-9]+$/.test(b.checkout_session)) {
      let cs;
      try {
        cs = await stripe(env, 'GET', `checkout/sessions/${b.checkout_session}`);
      } catch {
        return json({ ok: false, error: 'unknown checkout session' }, 404, h);
      }
      const fresh = Date.now() / 1000 - Number(cs.created) < 24 * 3600;
      if (cs.status !== 'complete' || !cs.subscription || !fresh) return json({ ok: false, error: 'checkout not complete' }, 409, h);
      const sub = await stripe(env, 'GET', `subscriptions/${cs.subscription}`);
      const m = await syncSubscription(env, sub, cs.customer_details?.email);
      return json(await issueSession(env, m), 200, h);
    }
    return json({ ok: false, error: 'login or checkout_session required' }, 400, h);
  }

  const m = await authed(req, env);
  if (!m) return json({ ok: false, error: 'sign in required' }, 401, h);

  if (req.method === 'GET' && path === '/me') return json({ ok: true, member: publicView(m) }, 200, h);

  if (req.method === 'POST' && path === '/portal') {
    const s = await stripe(env, 'POST', 'billing_portal/sessions', { customer: m.customer, return_url: `${env.SITE_URL}account/`, configuration: env.PORTAL_CONFIGURATION || undefined });
    return json({ ok: true, url: s.url }, 200, h);
  }

  if (!isActive(m)) return json({ ok: false, error: 'Copy subscription required', member: publicView(m) }, 402, h);

  if (req.method === 'POST' && path === '/alerts') {
    const a = (await body(req)).alerts;
    const valid = a === 'all' || a === 'off' || (Array.isArray(a) && a.length <= 500 && a.every((s) => typeof s === 'string' && SLUG.test(s)));
    if (!valid) return json({ ok: false, error: 'alerts must be "all", "off", or a list of manager slugs' }, 400, h);
    const updated: Member = { ...m, alerts: a as Member['alerts'] };
    await putMember(env, updated);
    return json({ ok: true, member: publicView(updated) }, 200, h);
  }

  const hist = path.match(/^\/history\/([a-z0-9-]+)$/);
  const csv = path.match(/^\/csv\/([a-z0-9-]+)\.csv$/);
  const slug = hist?.[1] ?? csv?.[1];
  if (req.method === 'GET' && slug && SLUG.test(slug)) {
    const data = await fetchHistory(env, slug);
    if (!data) return json({ ok: false, error: 'unknown manager' }, 404, h);
    if (hist) return json(data, 200, { ...h, 'cache-control': 'private, max-age=300' });
    return new Response(historyCsv(env, data), {
      status: 200,
      headers: { ...h, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="copybook-${slug}-13f-history.csv"`, 'cache-control': 'private, max-age=300' },
    });
  }

  return json({ ok: false, error: 'not found' }, 404, h);
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env).catch((err) => {
      console.log(String(err?.stack ?? err));
      return json({ ok: false, error: 'server error' }, 500, cors(allowedOrigin(req.headers.get('origin'), env)));
    });
  },
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(runAlerts(env).then((r) => console.log(`alerts: ${JSON.stringify(r)}`)));
  },
};
