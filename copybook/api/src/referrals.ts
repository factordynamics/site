/**
 * Referrals, Copybook plans only: give a month, get a month. Every paying member has a code; a new
 * subscriber who checks out through it (POST /checkout with `ref`) gets their first month free, as a
 * once-only coupon worth one month of their plan. The referrer gets one month of their own plan as a
 * Stripe customer balance credit, only after the referred member's first paid invoice (invoice.paid
 * with an amount above zero), once per referred customer.
 */
import { FOOTER, sendMail } from './email';
import { isActive, type Env, type Member } from './env';
import { claim, getMember, memberByEmail } from './members';
import { stripe } from './stripe';

const MONTH: Record<string, number> = { copy: 900, pro: 3900, fund: 19900 };
const NAME: Record<string, string> = { copy: 'Copy', pro: 'Copy Pro', fund: 'Copy Fund' };
const TRIAL_DAYS = 14;

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
 * POST /checkout {plan, interval, ref?, email?, source?}: a Checkout Session for a new subscription
 * (14-day trial, card up front), with the referral month applied when `ref` is a member's live code.
 * Without `ref` it is the same checkout the site's Payment Links start, plus the source it carries.
 */
export async function createCheckout(env: Env, b: Record<string, unknown>): Promise<Reply> {
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
  const cs = await stripe(env, 'POST', 'checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': 1,
    'subscription_data[trial_period_days]': TRIAL_DAYS,
    ...(promo ? { 'discounts[0][promotion_code]': promo.id } : ref ? { 'discounts[0][coupon]': await couponFor(env, plan), 'subscription_data[metadata][ref]': ref } : {}),
    ...(gate ? { payment_method_collection: 'if_required', 'subscription_data[metadata][test]': 'gatecheck' } : {}),
    ...(source ? { 'subscription_data[metadata][source]': source } : {}),
    ...(email ? { customer_email: email } : {}),
    success_url: `${env.SITE_URL}account/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}pricing/${ref ? `?ref=${ref}` : ''}`,
    'metadata[copybook]': ref ? 'referral' : 'checkout',
  });
  // The first charge, after the trial, with the referral month off: what the pricing page shows next to the button.
  const list = Number(price.unit_amount ?? 0);
  const first = { interval, list_usd: list / 100, discount_usd: MONTH[plan] / 100, first_charge_usd: Math.max(0, list - MONTH[plan]) / 100, charged_after_trial_days: TRIAL_DAYS };
  return { status: 200, body: { ok: true, url: cs.url, referral: ref ? { applied: true, months_free: 1, ...(list ? first : {}) } : code ? { applied: false } : null } };
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
