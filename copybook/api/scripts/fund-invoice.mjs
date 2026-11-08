#!/usr/bin/env node
// Starts an invoiced annual Copy Fund subscription for a team that asked for one (POST /fund-request).
// Stripe emails the invoice, due net 30. The subscription is active straight away, so the
// webhook creates the member and emails the owner a sign-in link; they invite seats from /account/.
//
//   STRIPE_SECRET_KEY=sk_live_... node scripts/fund-invoice.mjs --email pm@fund.example --name "Jane Doe" --fund "Example Capital" [--coupon CODE] [--dry-run]
//
// Re-running for the same email reuses the customer and refuses to add a second Fund subscription.
const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error('STRIPE_SECRET_KEY is required');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const email = arg('--email')?.trim().toLowerCase();
const name = arg('--name');
const fund = arg('--fund');
const coupon = arg('--coupon');
const dry = process.argv.includes('--dry-run');
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('--email is required');

async function stripe(method, path, params = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) for (const x of [v].flat()) body.append(k, String(x));
  const qs = body.toString();
  const res = await fetch(`https://api.stripe.com/v1/${path}${method !== 'POST' && qs ? `?${qs}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'POST' ? qs : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data.error ?? data)}`);
  return data;
}

const price = (await stripe('GET', 'prices', { 'lookup_keys[]': 'fund_yearly', active: true })).data[0];
if (!price) throw new Error('no active fund_yearly price; run stripe-setup.mjs');
let customer = (await stripe('GET', 'customers', { email, limit: 1 })).data[0];
if (customer) {
  const subs = (await stripe('GET', 'subscriptions', { customer: customer.id, status: 'all' })).data;
  const live = subs.find((s) => ['active', 'trialing', 'past_due', 'incomplete'].includes(s.status) && s.items.data.some((i) => i.price.lookup_key?.startsWith('fund_')));
  if (live) throw new Error(`${email} already has Copy Fund ${live.id} (${live.status})`);
}
console.log(`${dry ? 'Would invoice' : 'Invoicing'} ${email}${fund ? ` (${fund})` : ''}: Copy Fund yearly, ${price.unit_amount / 100} ${price.currency.toUpperCase()}, net 30${coupon ? `, coupon ${coupon}` : ''}`);
if (dry) process.exit(0);
customer ??= await stripe('POST', 'customers', { email, name: fund ?? name, 'metadata[copybook]': 'fund', 'metadata[contact]': name });
const sub = await stripe('POST', 'subscriptions', {
  customer: customer.id,
  'items[0][price]': price.id,
  collection_method: 'send_invoice',
  days_until_due: 30,
  'discounts[0][coupon]': coupon,
  'metadata[copybook]': 'fund',
  'metadata[billing]': 'invoice',
});
// Subscription invoices start as drafts that Stripe finalizes about an hour later; send it now.
let inv = await stripe('POST', `invoices/${sub.latest_invoice}/finalize`);
if (inv.status === 'open') inv = await stripe('POST', `invoices/${inv.id}/send`);
console.log(JSON.stringify({ customer: customer.id, subscription: sub.id, status: sub.status, invoice: inv.id, invoice_status: inv.status, amount_due: inv.amount_due, due_date: inv.due_date, hosted_invoice_url: inv.hosted_invoice_url }, null, 1));
