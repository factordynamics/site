#!/usr/bin/env node
// Idempotently creates the Copybook "Copy" product, its two prices, Payment Links,
// the customer portal configuration, and (with --api) the webhook endpoint.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs --api https://copybook-api.<sub>.workers.dev --out /tmp/stripe.json
//
// The output file holds the webhook signing secret: keep it out of git.
import { writeFileSync } from 'node:fs';

const SITE = 'https://refcell.github.io/gust/copybook/';
const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error('STRIPE_SECRET_KEY is required');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const api = arg('--api')?.replace(/\/+$/, '');
const out = arg('--out');

async function stripe(method, path, params = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) body.append(k, String(x));
  const qs = body.toString();
  const res = await fetch(`${process.env.STRIPE_API_BASE ?? 'https://api.stripe.com'}/v1/${path}${method !== 'POST' && qs ? `?${qs}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'POST' ? qs : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data.error ?? data)}`);
  return data;
}

const mode = key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : 'test';

let product = (await stripe('GET', 'products', { active: true, limit: 100 })).data.find((p) => p.metadata?.copybook === 'copy');
if (!product) {
  product = await stripe('POST', 'products', {
    name: 'Copy',
    description: 'Full 13F history, CSV export, and an email when a tracked manager files a new 13F. SEC filings as filed; not investment advice.',
    'metadata[copybook]': 'copy',
    statement_descriptor: 'COPYBOOK',
  });
}

const prices = {};
const existing = (await stripe('GET', 'prices', { 'lookup_keys[]': ['copy_monthly', 'copy_yearly'], active: true })).data;
for (const [plan, amount, interval] of [['monthly', 900, 'month'], ['yearly', 7900, 'year']]) {
  prices[plan] =
    existing.find((p) => p.lookup_key === `copy_${plan}`) ??
    (await stripe('POST', 'prices', { product: product.id, currency: 'usd', unit_amount: amount, 'recurring[interval]': interval, lookup_key: `copy_${plan}`, nickname: `Copy ${plan}` }));
}

const success = `${SITE}account/?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
const links = {};
const activeLinks = (await stripe('GET', 'payment_links', { active: true, limit: 100 })).data;
for (const plan of ['monthly', 'yearly']) {
  links[plan] =
    activeLinks.find((l) => l.metadata?.copybook === plan) ??
    (await stripe('POST', 'payment_links', {
      'line_items[0][price]': prices[plan].id,
      'line_items[0][quantity]': 1,
      'after_completion[type]': 'redirect',
      'after_completion[redirect][url]': success,
      allow_promotion_codes: true,
      'metadata[copybook]': plan,
    }));
}

const portalParams = {
  'business_profile[headline]': 'Copybook by Factor Dynamics: manage your Copy plan',
  default_return_url: `${SITE}account/`,
  'features[customer_update][enabled]': true,
  'features[customer_update][allowed_updates][]': ['email'],
  'features[invoice_history][enabled]': true,
  'features[payment_method_update][enabled]': true,
  'features[subscription_cancel][enabled]': true,
  'features[subscription_cancel][mode]': 'at_period_end',
  'features[subscription_update][enabled]': true,
  'features[subscription_update][default_allowed_updates][]': ['price'],
  'features[subscription_update][products][0][product]': product.id,
  'features[subscription_update][products][0][prices][]': [prices.monthly.id, prices.yearly.id],
  'login_page[enabled]': true,
  'metadata[copybook]': 'portal',
};
const configs = (await stripe('GET', 'billing_portal/configurations', { limit: 100 })).data;
const found = configs.find((c) => c.metadata?.copybook === 'portal');
const portal = found
  ? await stripe('POST', `billing_portal/configurations/${found.id}`, portalParams)
  : await stripe('POST', 'billing_portal/configurations', portalParams);

let webhook;
if (api) {
  const url = `${api}/webhook`;
  for (const w of (await stripe('GET', 'webhook_endpoints', { limit: 100 })).data) if (w.url === url) await stripe('DELETE', `webhook_endpoints/${w.id}`);
  webhook = await stripe('POST', 'webhook_endpoints', {
    url,
    'enabled_events[]': ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'],
    description: 'Copybook API: grants and revokes Copy access',
  });
}

const result = {
  mode,
  product: product.id,
  prices: { monthly: prices.monthly.id, yearly: prices.yearly.id },
  checkout: { monthly: links.monthly.url, yearly: links.yearly.url },
  portal: portal.login_page?.url ?? null,
  portal_configuration: portal.id,
  webhook: webhook ? { id: webhook.id, url: webhook.url } : null,
};
if (out) {
  writeFileSync(out, JSON.stringify({ ...result, webhook_secret: webhook?.secret ?? null }, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(result, null, 2));
