/**
 * Referrals, Copybook plans only: give a month, get a month. Every paying member has a code; a new
 * subscriber who checks out through it (POST /checkout with `ref`) gets their first month free, as a
 * once-only coupon worth one month of their plan. The referrer gets one month of their own plan as a
 * Stripe customer balance credit, only after the referred member's first paid invoice (invoice.paid
 * with an amount above zero), once per referred customer.
 */
import { FOOTER, sendMail } from './email';
import { checkoutNote, FOUNDING_UNTIL } from './revenue';
import { isActive, testAddress, type Env, type Member } from './env';
import { claim, getMember, memberByEmail } from './members';
import { stripe } from './stripe';

/** Pro and Fund checkout: billing address and tax ID, the company (required for Fund) and an optional PO number. */
export const CHECKOUT_BUYER = (plan: string): Record<string, string> => ({
  billing_address_collection: 'required',
  'tax_id_collection[enabled]': 'true',
  'custom_fields[0][key]': 'company',
  'custom_fields[0][label][type]': 'custom',
  'custom_fields[0][label][custom]': 'Company name',
  'custom_fields[0][type]': 'text',
  'custom_fields[0][optional]': plan === 'fund' ? 'false' : 'true',
  'custom_fields[1][key]': 'po',
  'custom_fields[1][label][type]': 'custom',
  'custom_fields[1][label][custom]': 'PO number (optional)',
  'custom_fields[1][type]': 'text',
  'custom_fields[1][optional]': 'true',
});

const MONTH: Record<string, number> = { copy: 900, pro: 3900, fund: 19900 };
const NAME: Record<string, string> = { copy: 'Copy', pro: 'Copy Pro', fund: 'Copy Fund' };
const TRIAL_DAYS = 14;
/** Copy's Checkout line by the button: \"$0 due today. No card needed: if you don't add one, the trial just ends on November 25.\" */
export const copySubmit = (now: number) =>
  `$0 due today. No card needed: if you don't add one, the trial just ends on ${new Date(now + TRIAL_DAYS * 86_400_000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' })}. Copybook is made by Factor Dynamics.`;

export const canRefer = (m: Member) => isActive(m) && !!MONTH[m.plan] && !m.seat_of;

interface Referral {
  customer: string;
  plan: string;
  at: string;
  /** Set when the referred member's first paid invoice credited the referrer. */
  credited_at?: string;
}

/** The member's code (made once: 8 characters, no lookalikes) and what it has earned. */
export async function referralView(env: Env, m: Member) {
  if (!canRefer(m)) return null;
  let code = await env.DB.get(`refcode:${m.customer}`);
  if (!code) {
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    code = [...bytes].map((b) => abc[b % abc.length]).join('');
    await env.DB.put(`ref:${code}`, m.customer);
    await env.DB.put(`refcode:${m.customer}`, code);
  }
  const list = await referrals(env, m.customer);
  return {
    code,
    url: `${env.SITE_URL}pricing/?ref=${code}`,
    signups: list.length,
    paid: list.filter((r) => r.credited_at).length,
    months_earned: list.filter((r) => r.credited_at).length,
  };
}

async function referrals(env: Env, customer: string): Promise<Referral[]> {
  return JSON.parse((await env.DB.get(`refs:${customer}`)) ?? '[]') as Referral[];
}

/** A once-only coupon worth one month of the plan's monthly price: the whole first month on monthly, that much off the first year on yearly (Copy: $9 off $79). */
async function couponFor(env: Env, plan: string): Promise<string> {
  const id = `copybook-ref-${plan}-1mo`;
  try {
    await stripe(env, 'GET', `coupons/${id}`);
  } catch {
    await stripe(env, 'POST', 'coupons', { id, amount_off: MONTH[plan], currency: 'usd', duration: 'once', name: `Referral: ${NAME[plan]} 1 month off ($${MONTH[plan] / 100})`, 'metadata[copybook]': 'referral' }).catch(() => null);
  }
  return id;
}

type Reply = { status: number; body: Record<string, unknown> };

/**
 * POST /checkout {plan, interval, ref?, email?, source?, utm_source?, utm_content?, landing?, test?}: a Checkout Session for a new subscription
 * (14-day trial, card up front), with the referral month applied when `ref` is a member's live code.
 * Without `ref` it is the same checkout the site's Payment Links start, plus the source it carries.
 */
/** Fund checkout's submit note, as on the Fund Payment Links: the Terms, and the invoice route. */
const FUND_SUBMIT = "Copybook is made by Factor Dynamics. By subscribing you agree to Copybook's Terms (copybook.factordynamics.com/terms/). To pay by invoice instead, use copybook.factordynamics.com/contact/?topic=fund.";

/**
 * One free trial per person, at Checkout's completion too (the lead, Nov 11): the visitor types the email at Stripe, so a
 * trial whose email (or another Stripe customer under it) already had a Copybook subscription is cancelled at once ($0,
 * nothing charged) and never becomes a member; /session sends them to /account/ to subscribe. Test addresses
 * (copybook-test-...) are exempt here so critics can walk the trial again; they still merge (carryPriorMember).
 * Idempotent: the subscription is tagged trial_repeat_blocked before it is cancelled.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function blockRepeatTrial(env: Env, sub: any, emailHint?: string | null): Promise<boolean> {
  if (sub?.metadata?.trial_repeat_blocked) return true;
  if (sub?.status !== 'trialing') return false;
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const email = (emailHint || (await stripe(env, 'GET', `customers/${customer}`).catch(() => null))?.email || '').trim().toLowerCase();
  if (!email || testAddress(email)) return false;
  const prior = await memberByEmail(env, email);
  let had = !!prior && prior.customer !== customer && prior.status !== 'free' && (!!prior.subscription?.startsWith('sub_') || !!prior.trial_end);
  if (!had) {
    try {
      for (const c of ((await stripe(env, 'GET', 'customers', { email, limit: 10 })).data ?? []) as { id: string }[]) {
        if (c.id === customer) continue;
        if ((((await stripe(env, 'GET', 'subscriptions', { customer: c.id, status: 'all', limit: 3 })).data ?? []) as unknown[]).length) had = true;
      }
    } catch {
      // Stripe unreachable: the trial stands.
    }
  }
  if (!had) return false;
  await stripe(env, 'POST', `subscriptions/${sub.id}`, { 'metadata[trial_repeat_blocked]': 'true' });
  await stripe(env, 'DELETE', `subscriptions/${sub.id}`).catch((e) => console.log(`trial_repeat_blocked: cancel ${sub.id}: ${e}`));
  await env.DB.put('ops:trial_repeat_blocked', String(Number((await env.DB.get('ops:trial_repeat_blocked')) ?? 0) + 1));
  console.log(`trial_repeat_blocked: ${sub.id} (${customer}) for an email with an earlier subscription${prior ? ` (${prior.customer})` : ''}`);
  return true;
}

/** Whether this address has had a Copybook subscription: its member record, else any Stripe customer with that email. */
async function hadSubscription(env: Env, email: string, existing: Member | null): Promise<boolean> {
  if (existing?.subscription?.startsWith('sub_') || existing?.trial_end) return true;
  try {
    for (const c of ((await stripe(env, 'GET', 'customers', { email, limit: 5 })).data ?? []) as { id: string }[]) {
      const subs = ((await stripe(env, 'GET', 'subscriptions', { customer: c.id, status: 'all', limit: 5 })).data ?? []) as unknown[];
      if (subs.length) return true;
    }
  } catch {
    // Stripe unreachable: the trial stands rather than blocking checkout.
  }
  return false;
}

export async function createCheckout(env: Env, b: Record<string, unknown>, client?: 'bot' | 'browser' | 'unknown'): Promise<Reply> {
  const plan = String(b.plan ?? '');
  const interval = String(b.interval ?? '');
  if (!MONTH[plan] || (interval !== 'monthly' && interval !== 'yearly')) return { status: 400, body: { ok: false, error: 'plan: copy, pro or fund; interval: monthly or yearly', code: 'bad_request' } };
  const email = typeof b.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim()) ? b.email.trim().toLowerCase() : null;
  const code = typeof b.ref === 'string' ? b.ref.trim().toLowerCase().slice(0, 20) : '';
  const referrer = code ? await env.DB.get(`ref:${code}`) : null;
  const owner = referrer ? await getMember(env, referrer) : null;
  // A live code, for someone new: a member who already pays (the referrer included) gets no referral month.
  const existing = email ? await memberByEmail(env, email) : null;
  const ref = owner && canRefer(owner) && !(existing && isActive(existing) && existing.plan !== 'free') ? code : null;
  const price = (await stripe(env, 'GET', 'prices', { 'lookup_keys[]': `${plan}_${interval}`, active: true })).data?.[0];
  if (!price?.id) return { status: 409, body: { ok: false, error: 'plan unavailable', code: 'unavailable' } };
  const source = typeof b.source === 'string' && b.source.trim() ? b.source.trim().slice(0, 60) : ref ? 'referral' : null;
  // A promotion code (typed codes are off on the site's Payment Links). A launch-gate code (metadata copybook=gatecheck,
  // 100% off) also skips the card, and its subscription is tagged test: left out of revenue and funnel counts.
  const promoCode = typeof b.promo === 'string' && b.promo.trim() ? b.promo.trim().toUpperCase().slice(0, 40) : null;
  const promo = promoCode ? (await stripe(env, 'GET', 'promotion_codes', { code: promoCode, active: true, limit: 1 })).data?.[0] : null;
  if (promoCode && !promo) return { status: 400, body: { ok: false, error: 'That code is not valid', code: 'invalid_promo' } };
  const gate = promo?.metadata?.copybook === 'gatecheck';
  // Our own checks are tagged (the lead): `test: true`, a copybook-test- or gate address, or a source starting "test".
  // The visitor's first touch and landing page ride on the session, so funnel pulls split real from test by post.
  const tag = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const isTest = b.test === true || (!!email && testAddress(email)) || /^test/i.test(source ?? '') || gate;
  // One free trial per person (the lead, Nov 11): an address that has had a Copybook subscription before (any plan, a
  // trial included) gets plain checkout, so lapsing and re-trialling each season isn't free. Test addresses are exempt.
  const trial = !(email && !isTest && (await hadSubscription(env, email, existing)));
  const touch = { utm_source: tag(b.utm_source, 60), utm_content: tag(b.utm_content, 60), landing: tag(b.landing, 120) };
  const cs = await stripe(env, 'POST', 'checkout/sessions', {
    ...(isTest ? { 'metadata[test]': 'true' } : {}),
    // The caller's coarse class (clientClass: bot, browser or unknown), never the User-Agent: /ops/funnel splits by it.
    ...(client ? { 'metadata[client]': client } : {}),
    ...Object.fromEntries(Object.entries(touch).filter(([, v]) => v).map(([k, v]) => [`metadata[${k}]`, v!])),
    mode: 'subscription',
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': 1,
    ...(trial ? { 'subscription_data[trial_period_days]': TRIAL_DAYS } : { 'metadata[returning]': 'true' }),
    ...(promo ? { 'discounts[0][promotion_code]': promo.id } : ref ? { 'discounts[0][coupon]': await couponFor(env, plan), 'subscription_data[metadata][ref]': ref } : {}),
    ...(gate ? { payment_method_collection: 'if_required', 'subscription_data[metadata][test]': 'gatecheck' } : {}),
    // Copy's 14-day trial needs no card (the lead, Nov 11): one is asked for near the end (trialEndingMail), and a trial
    // that ends without one is cancelled, never invoiced. Pro and Fund keep the card at Checkout.
    ...(plan === 'copy' && !gate && trial ? { payment_method_collection: 'if_required', 'subscription_data[trial_settings][end_behavior][missing_payment_method]': 'cancel' } : {}),
    ...(source ? { 'subscription_data[metadata][source]': source } : {}),
    ...(email ? { customer_email: email } : {}),
    success_url: `${env.SITE_URL}account/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}pricing/${ref ? `?ref=${ref}` : ''}`,
    'metadata[copybook]': ref ? 'referral' : 'checkout',
    // The seller on the card statement is the account's name: say whose product it is.
    // Copy: what the cardless trial means, on the main panel by the button (the trader and retail, Nov 11).
    'custom_text[submit][message]': plan === 'fund' ? FUND_SUBMIT : plan === 'copy' && !gate && trial ? copySubmit(Date.now()) : 'Copybook is made by Factor Dynamics.',
    // Pro and Fund: the founding price (amount and deadline) and the tax line. Copy: neither.
    ...(checkoutNote(plan, price.unit_amount, price.recurring?.interval) ? { 'custom_text[after_submit][message]': checkoutNote(plan, price.unit_amount, price.recurring?.interval)! } : {}),
    ...(plan !== 'copy' && Date.now() < FOUNDING_UNTIL ? { 'subscription_data[metadata][founding]': 'true' } : {}),
    // Pro and Fund: what a company's accounts team needs on the invoice.
    ...(plan === 'copy' ? {} : CHECKOUT_BUYER(plan)),
  });
  // The first charge, after the trial, with the referral month off: what the pricing page shows next to the button.
  const list = Number(price.unit_amount ?? 0);
  const first = { interval, list_usd: list / 100, discount_usd: MONTH[plan] / 100, first_charge_usd: Math.max(0, list - MONTH[plan]) / 100, charged_after_trial_days: TRIAL_DAYS };
  return { status: 200, body: { ok: true, url: cs.url, trial_days: trial ? TRIAL_DAYS : 0, referral: ref ? { applied: true, months_free: 1, ...(list ? first : {}) } : code ? { applied: false } : null } };
}

/** Records a referred subscription under its referrer, once. */
export async function noteReferral(env: Env, m: Member): Promise<void> {
  const referrer = m.referred_by ? await env.DB.get(`ref:${m.referred_by}`) : null;
  if (!referrer || referrer === m.customer) return;
  const list = await referrals(env, referrer);
  if (list.some((r) => r.customer === m.customer)) return;
  list.push({ customer: m.customer, plan: m.plan, at: new Date().toISOString() });
  await env.DB.put(`refs:${referrer}`, JSON.stringify(list));
}

/** invoice.paid: the referred member's first invoice with money in it credits the referrer a month, once. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function rewardReferrer(env: Env, inv: any): Promise<string> {
  if (!(Number(inv.amount_paid) > 0)) return 'not paid';
  const customer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
  const m = customer ? await getMember(env, customer) : null;
  const referrer = m?.referred_by ? await env.DB.get(`ref:${m.referred_by}`) : null;
  if (!m || !referrer || referrer === customer) return 'no referral';
  const list = await referrals(env, referrer);
  const r = list.find((x) => x.customer === customer) ?? (list.push({ customer, plan: m.plan, at: new Date().toISOString() }), list[list.length - 1]);
  if (r.credited_at) return 'already credited';
  const owner = await getMember(env, referrer);
  if (!owner || !MONTH[owner.plan]) return 'referrer not on a Copybook plan';
  // One credit per referred customer, even when Stripe delivers the event twice at once.
  if (!(await claim(env, referrer, `ref:${customer}`, true))) return 'already credited';
  try {
    // A month of the referrer's own plan, off their next invoice.
    await stripe(env, 'POST', `customers/${referrer}/balance_transactions`, { amount: -MONTH[owner.plan], currency: 'usd', description: `Referral: a month of ${NAME[owner.plan]} for referring a new member`, 'metadata[copybook]': 'referral', 'metadata[referred]': customer });
  } catch (e) {
    await claim(env, referrer, `ref:${customer}`, false);
    throw e;
  }
  r.credited_at = new Date().toISOString();
  await env.DB.put(`refs:${referrer}`, JSON.stringify(list));
  if (owner.email) {
    await sendMail(env, [{ to: owner.email, subject: `You earned a free month of ${NAME[owner.plan]}`, text: `Someone you referred just paid for their first month of Copybook, so your next invoice is ${(MONTH[owner.plan] / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} lower: the credit is on your account and applies automatically.\n\nYour referral link, for the next one: ${env.SITE_URL}pricing/?ref=${m.referred_by}${FOOTER}` }]);
  }
  return 'credited';
}
