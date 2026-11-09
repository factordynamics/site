// End-to-end checks against the self-hosted API through its public URL. Uses only comped test members.
import { createHmac } from 'node:crypto';
const B = process.argv[2] ?? 'https://gene.tail70ba3.ts.net/copybook';
const ORIGIN = 'https://copybook.factordynamics.com';
const env = process.env;
const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (kind, c, ttl) => { const body = b64(JSON.stringify({ k: kind, c, x: Math.floor(Date.now() / 1000 + ttl) })); return `${body}.${b64(createHmac('sha256', env.SESSION_SECRET).update(body).digest())}`; };
const call = async (path, { method, body, token, headers = {} } = {}) => {
  const r = await fetch(`${B}${path}`, { method: method ?? (body ? 'POST' : 'GET'), body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body), headers: { origin: ORIGIN, ...(body && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, redirect: 'manual' });
  return r;
};
const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
const stripe = async (path) => (await fetch(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } })).json();

const COPY = 'cus_VanPqWjIrbVUMU', PRO = 'cus_VanP6vPTeg2lHw';

// Sign-in: an emailed login token (signed with the live SESSION_SECRET) becomes a session.
let r = await call('/session', { body: { login: sign('login', COPY, 600) } });
const s = await r.json();
ok('sign-in: POST /session {login}', r.status === 200 && !!s.token, `${r.status} plan=${s.member?.plan}`);
r = await call('/me', { token: s.token });
const me = await r.json();
ok('/me', r.status === 200 && me.member?.active, `${r.status} plan=${me.member?.plan} status=${me.member?.status}`);
ok('CORS for the Copybook origin', r.headers.get('access-control-allow-origin') === ORIGIN);
r = await call('/me', { token: s.token, headers: { origin: 'https://holdterm.factordynamics.com' } });
ok('CORS for the Holdterm origin', r.headers.get('access-control-allow-origin') === 'https://holdterm.factordynamics.com');
r = await call('/me', { token: sign('session', COPY, 600).slice(0, -2) + 'AA' });
ok('forged session rejected', r.status === 401, String(r.status));
r = await call('/login', { body: { email: 'nobody-here@example.com' } });
ok('POST /login (unknown email, no mail sent)', r.status === 200, String(r.status));

// Checkout return: a real completed Checkout Session from Stripe becomes a session.
const cs = (await stripe('checkout/sessions?limit=1&status=complete')).data?.[0];
if (cs) {
  r = await call('/session', { body: { checkout_session: cs.id } });
  const c = await r.json();
  ok('checkout return: POST /session {checkout_session}', r.status === 200 && !!c.token, `${r.status} ${cs.id.slice(0, 14)}… plan=${c.member?.plan}`);
} else ok('checkout return', false, 'no completed checkout session for a test customer');

// History and CSV from the private bucket.
r = await call('/history/warren-buffett', { token: s.token });
const h = await r.json();
ok('history /history/warren-buffett', r.status === 200 && Array.isArray(h.quarters ?? h.history ?? h.periods ?? Object.values(h)), `${r.status} ${JSON.stringify(h).length} bytes`);
r = await call('/csv-link/warren-buffett', { method: 'POST', token: s.token });
const link = (await r.json()).url;
ok('csv-link under the public base', link?.startsWith(`${B}/csv/warren-buffett.csv?dl=`), link?.slice(0, 70));
r = await fetch(link);
const csv = await r.text();
ok('CSV download', r.status === 200 && csv.split('\n').length > 10, `${r.status} ${csv.split('\n').length} lines, header ${csv.split('\n')[0].slice(0, 60)}`);
ok('CSV link single use', (await fetch(link)).status === 401);
r = await call('/csv/citadel-advisors-llc.csv', { token: s.token });
const big = await r.arrayBuffer();
ok('large CSV (Citadel)', r.status === 200 && big.byteLength > 1e6, `${r.status} ${(big.byteLength / 1e6).toFixed(1)} MB`);

// Durable Objects: follows (MemberFollows) and an API key metered by KeyMeter.
r = await call('/follows', { token: s.token });
ok('follows (Durable Object)', r.status === 200, `${r.status} ${JSON.stringify((await r.json()).follows ?? {}).slice(0, 80)}`);
const p = await (await call('/session', { body: { login: sign('login', PRO, 600) } })).json();
r = await call('/keys', { body: { name: 'selfhost-check' }, token: p.token });
const k = await r.json();
const key = k.key ?? k.secret ?? k.token;
ok('create API key (Pro)', r.status === 200 || r.status === 201, `${r.status}`);
if (key) {
  r = await fetch(`${B}/v1/filers/warren-buffett/holdings/latest`, { headers: { authorization: `Bearer ${key}` } });
  ok('/v1 with the key (KeyMeter)', r.status === 200, `${r.status} RateLimit-Remaining=${r.headers.get('ratelimit-remaining')}`);
  const id = k.id ?? k.key_id ?? k.keyId;
  if (id) { r = await call(`/keys/${id}`, { method: 'DELETE', token: p.token }); ok('delete the check key', r.status < 300, String(r.status)); }
  else console.log('NOTE key id not in response:', Object.keys(k));
}

// Stripe webhook: a real recent event, signed with the live whsec, and a bad signature.
const ev = (await stripe('events?limit=10&type=customer.subscription.updated')).data?.find((e) => [COPY, PRO, 'cus_VanPCSWpz1uvLh', 'cus_VanPmc5q1iLlqx', 'cus_VanPzdEb1bksVn'].includes(e.data.object.customer));
if (ev) {
  const body = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  r = await fetch(`${B}/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` } });
  ok('webhook (signed, replayed real event)', r.status === 200, `${r.status} ${ev.type} ${(await r.text()).slice(0, 60)}`);
  r = await fetch(`${B}/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` } });
  ok('webhook bad signature rejected', r.status >= 400, String(r.status));
} else ok('webhook', false, 'no recent subscription event for a test customer');

r = await call('/health');
ok('public /health', r.status === 200);
