#!/usr/bin/env node
// Idempotently creates the Copybook "Copy" product, its two prices, Payment Links,
// the customer portal configuration, and (with --api) the webhook endpoint.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs --api https://copybook-api.<sub>.workers.dev --out /tmp/stripe.json
//
// The output file holds the webhook signing secret: keep it out of git.
import { writeFileSync } from 'node:fs';

const SITE = 'https://copybook.factordynamics.com/';
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

// Copy for individuals, and Copy Pro (everything in Copy plus API keys, /v1, webhooks and bulk export).
const PRODUCTS = {
  copy: {
    name: 'Copy',
    description: '8 quarters of 13F history (every position each quarter), CSV export, and email alerts with each filing\'s moves. SEC filings as filed; not investment advice.',
    prices: [['monthly', 900, 'month'], ['yearly', 7900, 'year']],
    redirect: '',
  },
  pro: {
    name: 'Copy Pro',
    description: 'Everything in Copy, plus API keys for the versioned /v1 API, signed webhooks for filings, and bulk quarterly exports. SEC filings as filed; not investment advice.',
    prices: [['monthly', 3900, 'month'], ['yearly', 39000, 'year']],
    redirect: '&plan=pro',
  },
  fund: {
    name: 'Copy Fund',
    description: 'Everything in Copy Pro for a team of 5 seats, with a shared book and peer lists, Slack and webhook delivery. Annual plans can be invoiced. SEC filings as filed; not investment advice.',
    prices: [['monthly', 19900, 'month'], ['yearly', 199000, 'year']],
    redirect: '&plan=fund',
  },
  // Holdterm: a separate brand on the same account and Worker. Alerts only; its own site, trial,
  // statement descriptor and billing portal.
  holdterm: {
    name: 'Holdterm Alerts',
    description: 'Email alerts when the superinvestors you follow file a 13F, 13D, 13G or Form 4. SEC EDGAR data, not investment advice.',
    prices: [['monthly', 300, 'month'], ['yearly', 2900, 'year']],
    success: 'https://holdterm.pages.dev/account?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    trial: 7,
    descriptor: 'HOLDTERM',
  },
};

const TRIAL_DAYS = 14; // card collected up front; converts automatically unless cancelled
const products = {};
const prices = {};
const links = {};
const activeProducts = (await stripe('GET', 'products', { active: true, limit: 100 })).data;
const activeLinks = (await stripe('GET', 'payment_links', { active: true, limit: 100 })).data;
for (const [tier, spec] of Object.entries(PRODUCTS)) {
  products[tier] =
    activeProducts.find((p) => p.metadata?.copybook === tier) ??
    (await stripe('POST', 'products', { name: spec.name, description: spec.description, 'metadata[copybook]': tier, statement_descriptor: spec.descriptor ?? 'COPYBOOK' }));
  const keys = spec.prices.map(([plan]) => `${tier}_${plan}`);
  const existing = (await stripe('GET', 'prices', { 'lookup_keys[]': keys, active: true })).data;
  for (const [plan, amount, interval] of spec.prices) {
    const key = `${tier}_${plan}`;
    prices[key] =
      existing.find((p) => p.lookup_key === key) ??
      (await stripe('POST', 'prices', { product: products[tier].id, currency: 'usd', unit_amount: amount, 'recurring[interval]': interval, lookup_key: key, nickname: `${spec.name} ${plan}`, 'metadata[copybook]': tier }));
    const success = spec.success ?? `${SITE}account/?checkout=success&session_id={CHECKOUT_SESSION_ID}${spec.redirect}`;
    const redirect = { 'after_completion[type]': 'redirect', 'after_completion[redirect][url]': success, 'subscription_data[trial_period_days]': spec.trial ?? TRIAL_DAYS };
    // Copy's links predate tiers and are tagged with the bare interval.
    const tag = tier === 'copy' ? plan : key;
    const found = activeLinks.find((l) => l.metadata?.copybook === tag);
    links[key] = found
      ? await stripe('POST', `payment_links/${found.id}`, redirect)
      : await stripe('POST', 'payment_links', { 'line_items[0][price]': prices[key].id, 'line_items[0][quantity]': 1, ...redirect, allow_promotion_codes: true, 'metadata[copybook]': tag });
  }
}

const portalParams = {
  'business_profile[headline]': 'Copybook: manage your Copy, Pro or Fund plan',
  default_return_url: `${SITE}account/`,
  'features[customer_update][enabled]': true,
  'features[customer_update][allowed_updates][]': ['email'],
  'features[invoice_history][enabled]': true,
  'features[payment_method_update][enabled]': true,
  'features[subscription_cancel][enabled]': true,
  'features[subscription_cancel][mode]': 'at_period_end',
  'features[subscription_update][enabled]': true,
  'features[subscription_update][default_allowed_updates][]': ['price'],
  'features[subscription_update][products][0][product]': products.copy.id,
  'features[subscription_update][products][0][prices][]': [prices.copy_monthly.id, prices.copy_yearly.id],
  'features[subscription_update][products][0][adjustable_quantity][enabled]': false,
  'features[subscription_update][products][1][product]': products.pro.id,
  'features[subscription_update][products][1][prices][]': [prices.pro_monthly.id, prices.pro_yearly.id],
  'features[subscription_update][products][1][adjustable_quantity][enabled]': false,
  'features[subscription_update][products][2][product]': products.fund.id,
  'features[subscription_update][products][2][prices][]': [prices.fund_monthly.id, prices.fund_yearly.id],
  'features[subscription_update][products][2][adjustable_quantity][enabled]': false,
  // Copy -> Pro (and interval changes) bill the difference now, prorated.
  'features[subscription_update][proration_behavior]': 'create_prorations',
  'login_page[enabled]': true,
  'metadata[copybook]': 'portal',
};
const configs = (await stripe('GET', 'billing_portal/configurations', { limit: 100 })).data;
const found = configs.find((c) => c.metadata?.copybook === 'portal');
const portal = found
  ? await stripe('POST', `billing_portal/configurations/${found.id}`, portalParams)
  : await stripe('POST', 'billing_portal/configurations', portalParams);

// Holdterm's own portal: its plan only, back to its site, no Copybook plans to switch to.
const HOLDTERM_SITE = 'https://holdterm.pages.dev/';
const holdtermPortalParams = {
  'business_profile[headline]': 'Holdterm: manage your alerts subscription',
  default_return_url: `${HOLDTERM_SITE}account/`,
  'features[customer_update][enabled]': true,
  'features[customer_update][allowed_updates][]': ['email'],
  'features[invoice_history][enabled]': true,
  'features[payment_method_update][enabled]': true,
  'features[subscription_cancel][enabled]': true,
  'features[subscription_cancel][mode]': 'at_period_end',
  'features[subscription_update][enabled]': true,
  'features[subscription_update][default_allowed_updates][]': ['price'],
  'features[subscription_update][products][0][product]': products.holdterm.id,
  'features[subscription_update][products][0][prices][]': [prices.holdterm_monthly.id, prices.holdterm_yearly.id],
  'features[subscription_update][proration_behavior]': 'create_prorations',
  'login_page[enabled]': true,
  'metadata[copybook]': 'portal-holdterm',
};
const foundHt = configs.find((c) => c.metadata?.copybook === 'portal-holdterm');
const holdtermPortal = foundHt
  ? await stripe('POST', `billing_portal/configurations/${foundHt.id}`, holdtermPortalParams)
  : await stripe('POST', 'billing_portal/configurations', holdtermPortalParams);

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
  products: Object.fromEntries(Object.entries(products).map(([k, p]) => [k, p.id])),
  prices: Object.fromEntries(Object.entries(prices).map(([k, p]) => [k, p.id])),
  checkout: Object.fromEntries(Object.entries(links).map(([k, l]) => [k, l.url])),
  portal: portal.login_page?.url ?? null,
  portal_configuration: portal.id,
  holdterm_portal: holdtermPortal.login_page?.url ?? null,
  holdterm_portal_configuration: holdtermPortal.id,
  webhook: webhook ? { id: webhook.id, url: webhook.url } : null,
};
if (out) {
  writeFileSync(out, JSON.stringify({ ...result, webhook_secret: webhook?.secret ?? null }, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(result, null, 2));
