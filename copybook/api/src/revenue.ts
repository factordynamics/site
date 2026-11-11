import type { Alert13F, AlertEvent } from './alerts';
import { FOOTER, sendMail, type Mail } from './email';
import { isActive, isPaused, WORKER_URL, pauseScheduled, testAddress, type Env, type Member } from './env';
import { unsubscribeUrl } from './free';
import { customerHasCard, getFollows, getMember, listMembers, putMember, syncSubscription } from './members';
import { SEAT_LIMIT } from './seats';
import { type WinterPreview, winterLine } from './stockevents';
import { DEADLINES, deadlineLabel, deadlineMs, inFilingWeek, lastDeadline, nextDeadline, pauseResumesAt } from './seasons';
import { stripe } from './stripe';
import { signToken, verifyToken } from './tokens';

/**
 * Lifecycle email for paying Copybook members (never Holdterm, never Fund seats, who don't pay):
 * a trial-ending reminder, the filing-season recap with a yearly offer for monthly members, and a
 * one-question follow-up when someone cancels. Plus the counts behind /health's business summary.
 */

const PRICES: Record<string, { name: string; month: number; year: number }> = {
  copy: { name: 'Copy', month: 9, year: 79 },
  pro: { name: 'Copy Pro', month: 39, year: 390 },
  fund: { name: 'Copy Fund', month: 199, year: 1990 },
};

/** Counted in revenue, funnel and ops metrics. Test members (gate runs) are not. */
const billable = (m: Member) => lifecycle(m) && !m.test;
/** Gets lifecycle email (trial, cancel, resume, pause, dunning): test members too, so a gate run sees what a member sees. */
const lifecycle = (m: Member) => m.plan !== 'holdterm' && !m.seat_of && !m.comped && !!PRICES[m.plan];
/** Cancel and undo-cancel confirmations: as lifecycle, plus comped test members (critics run the member's path end to end). */
const confirms = (m: Member) => lifecycle(m) || (m.plan !== 'holdterm' && !m.seat_of && !!PRICES[m.plan] && (!!m.test || testAddress(m.email ?? '')));
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
/** A trial or period end with its time (Stripe shows the UTC date, so a 7:46 pm ET end reads as the next day there): "November 24, 7:46 pm ET". */
export const endAt = (unix: number) => `${day(unix)}, ${new Date(unix * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).replace(' AM', ' am').replace(' PM', ' pm')} ET`;
const money = (n: number) => `$${n.toLocaleString('en-US')}`;
/** Yearly as marketing words it (plan rev 75): \"less than 9 months of monthly, price locked\"; never \"months free\" or a %. */
const monthsOf = (p: { month: number; year: number }) => (Number.isInteger(p.year / p.month) ? `the price of ${p.year / p.month} months of monthly` : `less than ${Math.ceil(p.year / p.month)} months of monthly`);
const monthsFree = (p: { month: number; year: number }) => `${monthsOf(p)}, price locked`;

/** What one member got (email, digest or chat), for the trial and season emails: KV stats:{customer}. */
export interface MemberStats {
  /** Alerts delivered. */
  n: number;
  /** Filings covered (accessions, the latest 300). */
  acc: string[];
  /** Names the member owns that moved in those filings. */
  owned: string[];
  /** Fastest EDGAR acceptance to delivery, seconds (live alerts only, not replays or late ones). */
  fastest: number | null;
  fastest_what?: string;
}

export async function memberStats(env: Env, customer: string): Promise<MemberStats> {
  const raw = await env.DB.get(`stats:${customer}`);
  if (raw) return JSON.parse(raw) as MemberStats;
  // Before stats:, only a count was kept.
  return { n: Number((await env.DB.get(`sent:${customer}`)) ?? 0), acc: [], owned: [], fastest: null };
}

export async function countAlerts(env: Env, customer: string, filings: Alert13F[], events: AlertEvent[], owned: string[], now: number, replay: boolean): Promise<void> {
  const n = filings.length + events.length;
  if (!n) return;
  const s = await memberStats(env, customer);
  s.n += n;
  s.acc = [...new Set([...s.acc, ...filings.map((a) => a.accession), ...events.map((e) => e.id.replace(/^cluster:\d+:/, ''))])].slice(-300);
  const mine = new Set(owned);
  const moved = [...filings.flatMap((a) => a.tickers ?? []), ...events.flatMap((e) => [e.ticker, ...(e.subject_tickers ?? [])])].filter((t): t is string => !!t && mine.has(t));
  s.owned = [...new Set([...s.owned, ...moved])].slice(0, 100);
  if (!replay) {
    for (const x of [...filings.map((a) => ({ at: a.accepted, f: a.followup, what: `${a.manager} 13F` })), ...events.map((e) => ({ at: e.accepted ?? e.accepted_at, f: e.followup || e.late, what: `${e.manager} ${e.form}${e.ticker ? ` on ${e.ticker}` : ''}` }))]) {
      const sec = x.at && !x.f ? Math.round((now - Date.parse(x.at)) / 1000) : NaN;
      if (sec >= 0 && (s.fastest === null || sec < s.fastest)) {
        s.fastest = sec;
        s.fastest_what = x.what;
      }
    }
  }
  await env.DB.put(`stats:${customer}`, JSON.stringify(s));
}

/** Alert emails handed to the mailer, per hour, for the last 48 hours (KV stats:sent). */
export async function logSent(env: Env, n: number, now: number): Promise<void> {
  if (!n) return;
  const hour = Math.floor(now / 3600_000);
  const log = (JSON.parse((await env.DB.get('stats:sent')) ?? '[]') as [number, number][]).filter(([h]) => h > hour - 48);
  const cur = log.find(([h]) => h === hour);
  if (cur) cur[1] += n;
  else log.push([hour, n]);
  await env.DB.put('stats:sent', JSON.stringify(log));
}

const etDay = (t: number) => new Date(t - 5 * 3600_000).toISOString().slice(0, 10);
export type FunnelKind = 'signups' | 'trials' | 'trial_to_paid' | 'paid_direct' | 'cancellations' | 'pauses' | 'invoice_trials';

/**
 * Funnel counts by ET day (KV funnel:{day}, kept 400 days): each kind by source, and the plan mix
 * (plan_interval) of trials and new paid members. `once` dedupes a transition that several Stripe
 * events report (checkout completed, subscription updated) so it counts once.
 */
export async function bump(env: Env, kind: FunnelKind, m: Member, once?: string, now = Date.now()): Promise<void> {
  if (once) {
    const k = `fseen:${once}:${kind}`;
    if (await env.DB.get(k)) return;
    await env.DB.put(k, '1', { expirationTtl: 400 * 86400 });
  }
  const key = `funnel:${etDay(now)}`;
  const d = JSON.parse((await env.DB.get(key)) ?? '{}') as Record<string, Record<string, number>>;
  const src = m.source ?? m.utm?.utm_source ?? 'direct';
  (d[kind] ??= {})[src] = (d[kind][src] ?? 0) + 1;
  // And by the post that brought them (the site sends the session's first-touch utm_*): "utm_source|utm_content".
  const post = `${m.utm?.utm_source ?? 'direct'}|${m.utm?.utm_content ?? '-'}`;
  (d[`utm:${kind}`] ??= {})[post] = (d[`utm:${kind}`][post] ?? 0) + 1;
  if (kind !== 'signups') {
    const mix = `${kind}:${m.plan}_${m.interval}`;
    (d.plan_mix ??= {})[mix] = (d.plan_mix[mix] ?? 0) + 1;
  }
  await env.DB.put(key, JSON.stringify(d), { expirationTtl: 400 * 86400 });
}

/** Counts the member's lifecycle step from Stripe's subscription change. Comped and test members don't count. */
export async function countTransition(env: Env, prev: Member | null, m: Member): Promise<void> {
  if (!billable(m)) return;
  const was = prev?.subscription === m.subscription ? prev.status : null;
  if (m.status === 'trialing' && was !== 'trialing') await bump(env, 'trials', m, m.subscription);
  if (m.status === 'active' && was === 'trialing') await bump(env, 'trial_to_paid', m, m.subscription);
  if (m.status === 'active' && was !== 'trialing' && was !== 'active' && was !== 'past_due') await bump(env, 'paid_direct', m, m.subscription);
  const cancelled = (m.cancel_at_period_end && !(prev?.subscription === m.subscription && prev.cancel_at_period_end)) || (m.status === 'canceled' && was !== null && was !== 'canceled' && !prev?.cancel_at_period_end);
  if (cancelled) await bump(env, 'cancellations', m, m.subscription);
}

/** The funnel for the last `days` ET days: per day, and totals by source. */
export async function funnel(env: Env, now: number, days: number) {
  const by_day: Record<string, Record<string, Record<string, number>>> = {};
  const total: Record<string, Record<string, number>> = {};
  for (let i = 0; i < days; i++) {
    const day = etDay(now - i * 86400_000);
    const raw = await env.DB.get(`funnel:${day}`);
    if (!raw) continue;
    const d = JSON.parse(raw) as Record<string, Record<string, number>>;
    by_day[day] = d;
    for (const [kind, xs] of Object.entries(d)) for (const [k, n] of Object.entries(xs)) (total[kind] ??= {})[k] = (total[kind][k] ?? 0) + n;
  }
  const sum = (kind: string) => Object.values(total[kind] ?? {}).reduce((a, n) => a + n, 0);
  return { days, signups: sum('signups'), trials: sum('trials'), invoice_trials: sum('invoice_trials'), trial_to_paid: sum('trial_to_paid'), paid_direct: sum('paid_direct'), cancellations: sum('cancellations'), pauses: sum('pauses'), by_source: Object.fromEntries(Object.entries(total).filter(([k]) => k !== 'plan_mix' && !k.startsWith('utm:'))), by_utm: Object.fromEntries(Object.entries(total).filter(([k]) => k.startsWith('utm:')).map(([k, v]) => [k.slice(4), v])), plan_mix: total.plan_mix ?? {}, by_day };
}

const secs = (n: number) => (n < 120 ? `${n} seconds` : `${Math.round(n / 60)} minutes`);
const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const FOUNDING: Record<string, string> = { pro: 'Your founding price stays at $39/month or $390/year for as long as you stay subscribed.', fund: 'Your founding price stays at $1,990/year for as long as you stay subscribed.' };

/**
 * The Fund order terms: seats, the founding price lock, renewal, cancellation and /terms/. Every Fund customer's
 * invoices carry them in the footer (Stripe's customer default), and a net-30 invoice also in its memo.
 */
export const fundTerms = (env: Env) =>
  `Order terms: Copy Fund, up to ${SEAT_LIMIT} seats (manage them at ${env.SITE_URL}account/). Founding price $1,990 a year for up to ${SEAT_LIMIT} seats, whatever number are used, locked for as long as this subscription stays active. ` +
  `The service period is shown on the line item. Renews each year at that price until cancelled. Cancel any time from Manage billing; access runs to the end of the paid year, and partial years aren't refunded. If we discontinue the plan during a prepaid period, we refund the unused part pro rata. ` +
  `Invoices are payable within 30 days. Terms in force on the invoice date: ${env.SITE_URL}terms/`;

/** A net-30 Fund invoice's memo (Stripe allows 500 characters; the full order terms are in the footer). */
export const fundMemo = (env: Env) => `Copy Fund, up to ${SEAT_LIMIT} seats, founding price $1,990 a year, payable within 30 days. Full order terms below and at ${env.SITE_URL}terms/`;
/** Every Copybook invoice's footer ends with this (Stripe Tax is off). */
export const TAX_LINE = 'Prices exclude applicable taxes. Copybook does not currently collect sales tax.';
/** Subscriptions started before this keep their price while subscribed: their invoices say so. */
export const FOUNDING_UNTIL = Date.parse('2026-12-31T00:00:00-05:00');
/**
 * Pro and Fund only (/pricing/ promises Copy no founding price): "Founding price ($390/yr), kept while subscribed",
 * from the price's amount and interval. Null for Copy.
 */
export function foundingLine(plan: string | null, cents: number | null | undefined, interval: string | null | undefined): string | null {
  if (plan !== 'pro' && plan !== 'fund') return null;
  const amt = cents ? `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}/${interval === 'year' ? 'yr' : 'mo'}` : null;
  return `Founding price${amt ? ` (${amt})` : ''}, kept while subscribed`;
}
/** Checkout's after-submit text for Pro and Fund: the founding price with its deadline, then the tax line. Null for Copy. */
export const checkoutNote = (plan: string, cents: number | null | undefined, interval: string | null | undefined) => {
  const f = foundingLine(plan, cents, interval);
  if (plan === 'copy') return null;
  return `${f && Date.now() < FOUNDING_UNTIL ? `${f}; offer ends Dec 31. ` : ''}${TAX_LINE}`;
};
const footerFor = (env: Env, plan: string | null) => (plan === 'fund' ? `${fundTerms(env)} ${TAX_LINE}` : TAX_LINE);

/**
 * A Copybook customer's invoice defaults (Stripe's customer settings, on every later invoice): the footer (a Fund
 * customer's order terms, then the tax line), and the custom fields: "Price: Founding price, kept while subscribed"
 * when the subscription (metadata founding=true) started before Dec 31, and the Company and PO the buyer gave at
 * checkout. The subscription is tagged founding=true here. `sub`: the Stripe subscription; `extra`: checkout's fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureInvoiceTerms(env: Env, sub: any, plan: string | null, extra: { company?: string | null; po?: string | null; ap_email?: string | null } = {}): Promise<{ result: string; footer: string; fields: { name: string; value: string }[] }> {
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customer) return { result: 'no customer', footer: '', fields: [] };
  // Copy has no founding price: its invoices carry no Price field (an existing one is removed below).
  const pr = sub.items?.data?.[0]?.price ?? sub.plan;
  const line = foundingLine(plan, pr?.unit_amount, pr?.recurring?.interval ?? pr?.interval);
  const founding = !!line && (sub.metadata?.founding === 'true' || Number(sub.created ?? sub.start_date ?? 0) * 1000 < FOUNDING_UNTIL);
  if (founding && sub.metadata?.founding !== 'true' && sub.id) await stripe(env, 'POST', `subscriptions/${sub.id}`, { 'metadata[founding]': 'true' });
  const c = await stripe(env, 'GET', `customers/${customer}`);
  const had = (c.invoice_settings?.custom_fields ?? []) as { name: string; value: string }[];
  const want = [
    ...(founding && line ? [{ name: 'Price', value: line }] : []),
    { name: 'PO', value: extra.po?.trim().slice(0, 140) || had.find((f) => f.name === 'PO')?.value || '' },
    { name: 'AP email', value: extra.ap_email?.trim().slice(0, 140) || had.find((f) => f.name === 'AP email')?.value || '' },
    // Invoiced (net-30) subscriptions say their terms in words, not only by the due date.
    ...(sub.collection_method === 'send_invoice' ? [{ name: 'Payment terms', value: `Net ${sub.days_until_due ?? 30}` }] : []),
    // Stripe keeps 4 fields; the company is also the customer's name on the invoice, so it goes last.
    { name: 'Company', value: extra.company?.trim().slice(0, 140) || had.find((f) => f.name === 'Company')?.value || '' },
    ...had.filter((f) => !['Price', 'Company', 'PO', 'AP email', 'Payment terms'].includes(f.name)),
  ].filter((f) => f.value).slice(0, 4);
  const footer = footerFor(env, plan);
  if (c.invoice_settings?.footer === footer && JSON.stringify(had.map((f) => [f.name, f.value])) === JSON.stringify(want.map((f) => [f.name, f.value]))) return { result: 'already', footer, fields: want };
  await stripe(env, 'POST', `customers/${customer}`, {
    'invoice_settings[footer]': footer,
    ...(want.length ? Object.fromEntries(want.flatMap((f, i) => [[`invoice_settings[custom_fields][${i}][name]`, f.name], [`invoice_settings[custom_fields][${i}][value]`, f.value]])) : { 'invoice_settings[custom_fields]': '' }),
  });
  return { result: 'set', footer, fields: want };
}

/**
 * Operator: a team that buys Copy Fund by invoice. A yearly Fund subscription billed net 30 (the webhook makes the
 * member as for a checkout); its first invoice carries the order terms as memo and footer and is emailed now.
 */
/** A net-30 yearly Fund order, invoiced now; `po`: the customer's purchase order, printed on the invoice as "PO". */
export async function fundInvoice(env: Env, email: string, name?: string, po?: string) {
  const found = (await stripe(env, 'GET', 'customers', { email, limit: 1 })).data?.[0];
  const customer: string = found?.id ?? (await stripe(env, 'POST', 'customers', { email, name, 'invoice_settings[footer]': footerFor(env, 'fund') })).id;
  const price = (await stripe(env, 'GET', 'prices', { 'lookup_keys[]': 'fund_yearly', active: true })).data?.[0];
  if (!price) throw new Error('no active fund_yearly price');
  const founding = Date.now() < FOUNDING_UNTIL;
  const sub = await stripe(env, 'POST', 'subscriptions', { customer, 'items[0][price]': price.id, collection_method: 'send_invoice', days_until_due: 30, description: fundMemo(env),
    // Card or ACH Direct Debit on the hosted invoice page ("Pay online"): per-payment fees only, no bank details printed.
    'payment_settings[payment_method_types][0]': 'card',
    'payment_settings[payment_method_types][1]': 'us_bank_account', 'metadata[copybook]': 'fund', ...(founding ? { 'metadata[founding]': 'true' } : {}) });
  const terms = await ensureInvoiceTerms(env, sub, 'fund', { company: name, po });
  let inv = await stripe(env, 'GET', `invoices/${sub.latest_invoice}`);
  // A draft takes the terms as its memo, and the customer's footer and fields (set after it was drafted); then it goes out now.
  if (inv.status === 'draft') {
    await stripe(env, 'POST', `invoices/${inv.id}`, { description: fundMemo(env), footer: terms.footer, ...Object.fromEntries(terms.fields.flatMap((f, i) => [[`custom_fields[${i}][name]`, f.name], [`custom_fields[${i}][value]`, f.value]])) });
    inv = await stripe(env, 'POST', `invoices/${inv.id}/finalize`);
  }
  inv = await stripe(env, 'POST', `invoices/${inv.id}/send`);
  return { customer, subscription: sub.id as string, invoice: inv.id as string, number: inv.number ?? null, due_date: inv.due_date ? new Date(inv.due_date * 1000).toISOString().slice(0, 10) : null, hosted_invoice_url: inv.hosted_invoice_url ?? null };
}

/**
 * Freemail domains: an invoice trial needs a company address (one per company domain). Subdomains count too
 * (mail.yahoo.co.uk).
 */
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io', 'mail.ru', 'inbox.com', 'hushmail.com']);
export const domainOf = (email: string) => email.trim().toLowerCase().split('@')[1] ?? '';
export const isFreemail = (d: string) => [...FREEMAIL].some((f) => d === f || d.endsWith(`.${f}`)) || /^(yahoo|hotmail|outlook|live)\./.test(d);

let DISPOSABLE_SET: Set<string> | null = null;
/** A disposable (throwaway) email domain, or a subdomain of one (src/disposable.ts, CC0 list). */
export async function isDisposable(d: string): Promise<boolean> {
  DISPOSABLE_SET ??= new Set((await import('./disposable')).DISPOSABLE.split('\n'));
  const parts = d.toLowerCase().split('.');
  return parts.some((_, i) => i < parts.length - 1 && DISPOSABLE_SET!.has(parts.slice(i).join('.')));
}

export interface InvoiceTrialForm {
  email: string;
  company: string;
  address: { line1: string; line2?: string | null; city: string; state?: string | null; postal_code: string; country: string };
  po?: string | null;
  ap_email?: string | null;
}
export type InvoiceTrialResult =
  | { state: 'started'; customer: string; subscription: string; trial_end: string; invoice_on: string; due_on: string; sign_in_email: 'sent' | 'not_sent' }
  | { state: 'freemail' | 'domain_used' | 'already_member' };

/**
 * Copy Fund on a 14-day trial billed by invoice, no card and no approval (the /contact/?topic=fund form): the customer
 * with the company and billing address, a yearly Fund subscription with send_invoice, Net 30 and a 14-day trial; the
 * owner is signed up at once (the welcome email carries the sign-in link) and seats work. Day 14: Stripe issues the
 * invoice (founding price, Net 30, PO and AP email as fields). Unpaid at day 44: access pauses (sweepInvoiceTrials).
 * Cancelling before day 14 costs nothing. One per company domain; freemail refused.
 */
export async function fundInvoiceTrial(env: Env, f: InvoiceTrialForm, now = Date.now()): Promise<InvoiceTrialResult> {
  const email = f.email.trim().toLowerCase();
  const domain = domainOf(email);
  if (!domain || isFreemail(domain)) return { state: 'freemail' };
  const { memberByEmail } = await import('./members');
  const had = await memberByEmail(env, email);
  if (had && isActive(had) && had.status !== 'free') return { state: 'already_member' };
  // Claimed before any Stripe call, so two submissions can't both start one; released if Stripe fails.
  const lock = `invtrial:domain:${domain}`;
  if (await env.DB.get(lock)) return { state: 'domain_used' };
  await env.DB.put(lock, JSON.stringify({ at: new Date(now).toISOString(), email, pending: true }));
  try {
    const a = f.address;
    const customer = await stripe(env, 'POST', 'customers', {
      email,
      name: f.company,
      'address[line1]': a.line1,
      ...(a.line2 ? { 'address[line2]': a.line2 } : {}),
      'address[city]': a.city,
      ...(a.state ? { 'address[state]': a.state } : {}),
      'address[postal_code]': a.postal_code,
      'address[country]': a.country,
      'invoice_settings[footer]': footerFor(env, 'fund'),
      'metadata[copybook]': 'fund',
      'metadata[invoice_trial]': 'true',
      ...(f.ap_email ? { 'metadata[ap_email]': f.ap_email } : {}),
    });
    const price = (await stripe(env, 'GET', 'prices', { 'lookup_keys[]': 'fund_yearly', active: true })).data?.[0];
    if (!price) throw new Error('no active fund_yearly price');
    const sub = await stripe(env, 'POST', 'subscriptions', {
      customer: customer.id,
      'items[0][price]': price.id,
      trial_period_days: 14,
      collection_method: 'send_invoice',
      days_until_due: 30,
      description: fundMemo(env),
      'payment_settings[payment_method_types][0]': 'card',
      'payment_settings[payment_method_types][1]': 'us_bank_account',
      'metadata[copybook]': 'fund',
      'metadata[invoice_trial]': 'true',
      'metadata[source]': 'invoice_trial',
      ...(f.po ? { 'metadata[po]': f.po } : {}),
      ...(f.ap_email ? { 'metadata[ap_email]': f.ap_email } : {}),
      ...(now < FOUNDING_UNTIL ? { 'metadata[founding]': 'true' } : {}),
      ...(/^copybook-test-/.test(email) ? { 'metadata[test]': 'invoice-trial' } : {}),
    });
    await ensureInvoiceTerms(env, sub, 'fund', { company: f.company, po: f.po ?? null, ap_email: f.ap_email ?? null });
    const m = await syncSubscription(env, sub, email);
    await env.DB.put(lock, JSON.stringify({ at: new Date(now).toISOString(), email, customer: customer.id, subscription: sub.id }));
    const list = JSON.parse((await env.DB.get('invtrial:customers')) ?? '[]') as string[];
    if (!list.includes(customer.id)) await env.DB.put('invtrial:customers', JSON.stringify([...list, customer.id]));
    if (billable(m)) await bump(env, 'invoice_trials', m, `invtrial:${sub.id}`, now);
    const trialEnd = Number(sub.trial_end ?? Math.floor(now / 1000) + 14 * 86400) * 1000;
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    return { state: 'started', customer: customer.id, subscription: sub.id, trial_end: new Date(trialEnd).toISOString().replace(/\.\d+Z$/, 'Z'), invoice_on: day(trialEnd), due_on: day(trialEnd + 30 * 86400_000), sign_in_email: m.welcomed ? 'sent' : 'not_sent' };
  } catch (e) {
    await env.DB.delete(lock);
    throw e;
  }
}

/**
 * A finalized Fund invoice's copy for the AP email on file (the subscription's, as the invoice prints it): number,
 * amount, due date, Pay online and PDF links. Once per invoice; a $0 invoice (a trial's start) gets none.
 */
export async function apCopy(env: Env, inv: { id?: string; customer?: string; number?: string | null; amount_due?: number; due_date?: number | null; hosted_invoice_url?: string | null; invoice_pdf?: string | null }): Promise<string> {
  if (!inv.id || !inv.customer || !inv.amount_due) return 'nothing due';
  const m = await getMember(env, inv.customer);
  const ap = m?.invoice_terms?.ap_email;
  if (!m || !ap) return 'no ap email';
  if (await env.DB.get(`apcopy:${inv.id}`)) return 'already';
  const due = inv.due_date ? new Date(inv.due_date * 1000).toISOString().slice(0, 10) : 'on receipt';
  const amount = `$${(inv.amount_due / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const status = await sendMail(env, [{
    to: ap,
    replyTo: env.CONTACT_EMAIL,
    subject: `Invoice ${inv.number ?? ''} from Factor Dynamics (Copybook): ${amount} due ${due}`.replace('  ', ' '),
    text: `A copy for your accounts payable team of the Copy Fund invoice sent to ${m.email}.\n\nInvoice: ${inv.number ?? inv.id}\nAmount due: ${amount} (USD)\nDue: ${due} (Net 30)${m.invoice_terms?.po ? `\nPO: ${m.invoice_terms.po}` : ''}\n\nPay online (card or US bank account): ${inv.hosted_invoice_url ?? `${env.SITE_URL}account/`}\nPDF: ${inv.invoice_pdf ?? 'on the payment page'}\n\nQuestions about this invoice: reply to this email.${FOOTER}`,
  }]);
  await env.DB.put(`apcopy:${inv.id}`, new Date().toISOString(), { expirationTtl: 400 * 86400 });
  return `sent ${status}`;
}

/** Access paused for an unpaid invoice (past its due date): the owner and seats lose access until it's paid. */
export async function markOverdue(env: Env, customer: string, invoice: { id?: string; number?: string | null; hosted_invoice_url?: string | null; amount_due?: number; due_date?: number | null }, now = Date.now()): Promise<string> {
  const m = await getMember(env, customer);
  if (!m || m.overdue_since) return m ? 'already' : 'no member';
  m.overdue_since = new Date(now).toISOString();
  await putMember(env, m);
  const { mirrorSeats } = await import('./seats');
  await mirrorSeats(env, m);
  if (!m.email) return 'paused';
  const amount = invoice.amount_due != null ? money(invoice.amount_due / 100) : 'the amount due';
  const due = invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().slice(0, 10) : 'its due date';
  const url = invoice.hosted_invoice_url ?? `${env.SITE_URL}account/`;
  const status = await sendMail(env, [
    {
      to: m.email,
      subject: `Copy Fund is paused: invoice ${invoice.number ?? ''} is past due`.replace('  ', ' '),
      text: `Your Copy Fund invoice ${invoice.number ?? ''} for ${amount} was due on ${due} and hasn't been paid, so Copybook access for you and your team's seats is paused.\n\nPay it online (card or ACH) and access comes back within minutes, with your follows, seats and API keys as they were:\n${url}\n\nIf it's already in your payables run, reply to this email and we'll keep you open meanwhile.\n\nYour account: ${env.SITE_URL}account/${FOOTER}`,
    },
  ]);
  return `paused, mail ${status}`;
}

/** An overdue member paid: access back for the owner and seats. */
export async function clearOverdue(env: Env, customer: string): Promise<string> {
  const m = await getMember(env, customer);
  if (!m?.overdue_since) return 'not overdue';
  delete m.overdue_since;
  await putMember(env, m);
  const { mirrorSeats } = await import('./seats');
  await mirrorSeats(env, m);
  return 'resumed';
}

/** Daily: every invoice-billed Fund customer whose open invoice is past its due date is paused (Stripe's invoice.overdue covers it too). */
export async function sweepInvoiceTrials(env: Env, now = Date.now()): Promise<{ checked: number; paused: number; resumed: number }> {
  const list = JSON.parse((await env.DB.get('invtrial:customers')) ?? '[]') as string[];
  let paused = 0, resumed = 0;
  for (const c of list) {
    const open = ((await stripe(env, 'GET', 'invoices', { customer: c, status: 'open', limit: 10 })).data ?? []) as { id: string; number: string | null; hosted_invoice_url: string | null; amount_due: number; due_date: number | null }[];
    const late = open.find((i) => i.due_date && i.due_date * 1000 < now);
    if (late && (await markOverdue(env, c, late, now)).startsWith('paused')) paused++;
    if (!late && (await clearOverdue(env, c)) === 'resumed') resumed++;
  }
  return { checked: list.length, paused, resumed };
}

/** A Fund owner on a card trial (yearly) switches to paying by invoice (Net 30) from /account/, with nobody to email. */
export async function switchToInvoice(env: Env, m: Member, f: { company?: string | null; po?: string | null; ap_email?: string | null } = {}): Promise<{ ok: true; collection: 'send_invoice' } | { ok: false; code: string; error: string }> {
  if (m.seat_of || m.plan !== 'fund') return { ok: false, code: 'fund_owner_only', error: 'Only a Copy Fund owner can switch to invoice billing.' };
  if (m.interval !== 'yearly') return { ok: false, code: 'monthly_card_only', error: 'Copy Fund monthly is paid by card. Switch to yearly to pay by invoice.' };
  if (!isActive(m)) return { ok: false, code: 'subscription_inactive', error: 'No active Copy Fund subscription.' };
  const sub = await stripe(env, 'POST', `subscriptions/${m.subscription}`, { collection_method: 'send_invoice', days_until_due: 30, 'metadata[invoice]': 'true', ...(f.po !== undefined ? { 'metadata[po]': f.po ?? '' } : {}), ...(f.ap_email !== undefined ? { 'metadata[ap_email]': f.ap_email ?? '' } : {}), 'payment_settings[payment_method_types][0]': 'card', 'payment_settings[payment_method_types][1]': 'us_bank_account' });
  await ensureInvoiceTerms(env, sub, 'fund', f);
  await syncSubscription(env, sub);
  const list = JSON.parse((await env.DB.get('invtrial:customers')) ?? '[]') as string[];
  if (!list.includes(m.customer)) await env.DB.put('invtrial:customers', JSON.stringify([...list, m.customer]));
  return { ok: true, collection: 'send_invoice' };
}

/** Day 11 of 14: the member's own numbers this trial, what ends with it, and one button to keep it (yearly preselected). */
/** Copy's quiet stretch: a trial ending between the Q3 13F deadline and February's (Nov 17, 2026 to Feb 1, 2027). */
const betweenSeasons = (unix: number) => unix * 1000 >= Date.UTC(2026, 10, 17) && unix * 1000 < Date.UTC(2027, 1, 2);
/** Last winter on EDGAR, the accessions published at /winter-2025-26.json (the trader's re-count, Nov 11). */
export const WINTER_LINE = 'Last winter (Dec 2025–Jan 2026): 19 Schedule 13D/G filings by the superinvestors we follow (4 new stakes, 15 amendments), and 18 open-market buys by directors and officers in the 100 stocks they hold most by value.';

/**
 * The day-12 email for a cardless Copy trial between seasons (marketing's plan rev 76): it just ends, nothing charged;
 * what Copy gives from now to February; the founding price; monthly pauses once a year; the free tier stays.
 */
export function day12Mail(env: Env, m: Member, unsub: string, now = Date.now(), preview?: WinterPreview | null): Mail {
  const weekday = new Date(m.trial_end! * 1000).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  const add = `${env.SITE_URL}account/`;
  const gives = [
    'Open-market insider buys in your stocks, as they\'re filed.',
    'Form 4 trades and 13D/G stakes by the funds you follow, and any new 13D or 13G in your stocks.',
    now < Date.UTC(2026, 11, 5, 11) ? 'The Friday email on Dec 4.' : 'The Friday email, every week.',
    'February\'s 13Fs, each one by email as it\'s filed (due Tue 16 Feb).',
  ];
  // The member's own names (marketing's rev 73): only when every name is read and something happened.
  const pv = preview && !preview.pending.length && preview.insider_buys + preview.schedule_13dg > 0 ? preview : null;
  const mine = pv ? `Your ${pv.names} name${pv.names === 1 ? '' : 's'} had ${pv.insider_buys} insider buy${pv.insider_buys === 1 ? '' : 's'} and ${pv.schedule_13dg} 13D/G filing${pv.schedule_13dg === 1 ? '' : 's'} last winter${pv.events.length ? `, e.g. ${pv.events.slice(0, 2).map(winterLine).join('; ')}` : ''}.` : '';
  const keep = 'Keep Copy at the founding price: $79/yr, locked. Goes to $99 for new members Feb 1. Monthly? Pause once a year, up to 3 months, and it resumes for the next 13F season. Both start once you add a card.';
  const stay = 'The free pages and the free Friday email stay yours.';
  return {
    to: m.email,
    subject: `Your Copy trial ends ${weekday}`,
    text: `Your Copy trial ends ${weekday}, ${endAt(m.trial_end!)}. No card is on file, so it simply ends and nothing is charged.\n\nFrom now to February, Copy gives you:\n${gives.map((g) => `  - ${g}`).join('\n')}\n\n${WINTER_LINE}${mine ? `\n${mine}` : ''}\n\n${keep}\nAdd a card: ${add}\n\n${stay}\n\nUnsubscribe from Copybook emails: ${unsub}${FOOTER}`,
    html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:560px"><p>Your Copy trial ends <b>${esc(weekday)}, ${esc(endAt(m.trial_end!))}</b>. No card is on file, so it simply ends and nothing is charged.</p><p style="margin-bottom:4px"><b>From now to February, Copy gives you</b></p><ul style="margin-top:0;padding-left:20px">${gives.map((g) => `<li>${esc(g)}</li>`).join('')}</ul><p>${esc(WINTER_LINE)} <a href="https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/winter-2025-26.json" style="color:#1d4ed8">The filings</a></p>${mine ? `<p>${esc(mine)}</p>` : ''}<p>${esc(keep)}</p><p><a href="${add}" style="color:#1d4ed8"><b>Add a card</b></a></p><p>${esc(stay)}</p><p style="font-size:12px;color:#6b7280"><a href="${unsub}" style="color:#6b7280">Unsubscribe</a></p></div>`,
    unsubscribe: unsub,
  };
}

export function trialEndingMail(env: Env, m: Member, s: MemberStats, funds: number, owned: number, keep: string, unsub: string, daysLeft = 3, preview?: WinterPreview | null): Mail {
  const p = PRICES[m.plan];
  const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
  const got = s.n
    ? [
        `Copybook sent you ${plural(s.n, 'alert')}${s.acc.length ? ` covering ${plural(s.acc.length, 'filing')}` : ''}.`,
        s.owned.length ? `${plural(s.owned.length, 'name')} you own moved in them: ${s.owned.slice(0, 6).join(', ')}${s.owned.length > 6 ? ', …' : ''}.` : '',
        s.fastest !== null ? `Your fastest alert reached you ${secs(s.fastest)} after EDGAR accepted the filing${s.fastest_what ? ` (${s.fastest_what})` : ''}.` : '',
      ].filter(Boolean)
    : [`You haven't had an alert yet. Follow a fund or add the names you own and the next filing reaches you within minutes: ${env.SITE_URL}investors/`];
  const lose = [
    `${[funds && `alerts for the ${plural(funds, 'fund')} you follow`, owned && `${funds ? '' : 'alerts on '}the ${plural(owned, 'name')} you own`].filter(Boolean).join(' and ') || 'filing alerts'}, minutes after each filing`,
    '8 quarters of 13F history and CSV export',
    'Slack, Discord, Telegram and RSS delivery',
    ...(m.plan === 'pro' || m.plan === 'fund' ? ['your API keys, /v1 and webhooks'] : []),
    ...(m.plan === 'fund' ? ["your team's seats, shared book and peers"] : []),
  ];
  const yearly = m.interval === 'yearly';
  const cta = yearly ? `Keep ${p.name} (${money(p.year)}/year)` : `Keep ${p.name} yearly: ${money(p.year)}/year, ${monthsFree(p)}`;
  const charge = yearly ? `${money(p.year)}/year` : `${money(p.month)}/month`;
  const founding = FOUNDING[m.plan] ? ` ${FOUNDING[m.plan]}` : '';
  const ends = endAt(m.trial_end!);
  // A no-card trial (Copy from Nov 11): it ends on its own, so the ask is to add a card, and doing nothing costs nothing.
  if (m.has_payment_method === false && m.plan === 'copy' && betweenSeasons(m.trial_end!)) return day12Mail(env, m, unsub, Date.now(), preview);
  if (m.has_payment_method === false) {
    const add = `${env.SITE_URL}account/`;
    const keepLine = `Add a card to keep ${p.name} (${charge}${yearly ? '' : `, or ${money(p.year)}/year`}): ${add} (Manage billing). The first charge is on ${ends}.`;
    return {
      to: m.email,
      subject: `Your ${p.name} trial ends in ${daysLeft === 1 ? '1 day' : `${daysLeft} days`}: add a card to keep it`,
      text: `Your ${p.name} trial ends on ${ends}. No card is on file, so if you do nothing it simply ends and nothing is charged.\n\nThis trial so far:\n${got.map((g) => `  ${g}`).join('\n')}\n\nIf it ends, you lose:\n${lose.map((l) => `  - ${l}`).join('\n')}\n\n${keepLine}\n${founding ? `${founding.trim()}\n` : ''}\nUnsubscribe from Copybook emails: ${unsub}${FOOTER}`,
      html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:560px"><p>Your ${p.name} trial ends on <b>${ends}</b>. No card is on file, so if you do nothing it simply ends and nothing is charged.</p><p style="margin-bottom:4px"><b>This trial so far</b></p><ul style="margin-top:0;padding-left:20px">${got.map((g) => `<li>${esc(g)}</li>`).join('')}</ul><p style="margin-bottom:4px"><b>If it ends, you lose</b></p><ul style="margin-top:0;padding-left:20px">${lose.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p><a href="${add}" style="color:#1d4ed8"><b>Add a card to keep ${p.name}</b></a> (${esc(charge)}${yearly ? '' : `, or ${esc(money(p.year))}/year`}). The first charge is on ${ends}.</p>${founding ? `<p>${esc(founding.trim())}</p>` : ''}<p style="font-size:12px;color:#6b7280"><a href="${unsub}" style="color:#6b7280">Unsubscribe</a></p></div>`,
      unsubscribe: unsub,
    };
  }
  return {
    to: m.email,
    subject: `Your ${p.name} trial ends in ${daysLeft === 1 ? '1 day' : `${daysLeft} days`}`,
    text: `Your ${p.name} trial ends on ${ends}.\n\nThis trial so far:\n${got.map((g) => `  ${g}`).join('\n')}\n\nIf it ends, you lose:\n${lose.map((l) => `  - ${l}`).join('\n')}\n\n${cta}: ${keep}\n${yearly ? '' : `Or stay monthly at ${charge}: nothing to do, it renews on ${ends}.\n`}${founding ? `${founding.trim()}\n` : ''}\nTo cancel before you're charged: ${env.SITE_URL}account/ (Manage billing).\n\nUnsubscribe from tips and newsletters: ${unsub}${FOOTER}`,
    html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:560px"><p>Your ${p.name} trial ends on <b>${ends}</b>.</p><p style="margin-bottom:4px"><b>This trial so far</b></p><ul style="margin-top:0;padding-left:20px">${got.map((g) => `<li>${esc(g)}</li>`).join('')}</ul><p style="margin-bottom:4px"><b>If it ends, you lose</b></p><ul style="margin-top:0;padding-left:20px">${lose.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p style="margin:22px 0 8px"><a href="${keep}" style="display:inline-block;background:#111;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:600">${esc(cta)}</a></p>${founding ? `<p style="font-size:13px;color:#374151;margin:0 0 6px">${esc(founding.trim())}</p>` : ''}<p style="font-size:13px;color:#374151;margin:0">${yearly ? '' : `Or stay monthly at ${charge}: nothing to do, it renews on ${ends}. `}To cancel before you're charged, use Manage billing in <a href="${env.SITE_URL}account/" style="color:#1d4ed8">your account</a>.</p><p style="color:#6b7280;font-size:12px;margin-top:24px">Source: SEC EDGAR filings, as filed. Not investment advice. Copybook by Factor Dynamics. <a href="${unsub}" style="color:#6b7280">Unsubscribe from tips and newsletters</a></p></div>`,
    unsubscribe: unsub,
  };
}

/** The trial ended cancelled: one short note offering the monthly plan instead. */
export function winbackMail(env: Env, m: Member, resume: string, unsub: string): Mail {
  const p = PRICES[m.plan];
  return {
    to: m.email,
    subject: `Your ${p.name} trial ended. Monthly is ${money(p.month)}`,
    text: `Your ${p.name} trial has ended and you weren't charged.\n\nIf a year up front was the problem, ${p.name} is ${money(p.month)} a month, cancel any time, with your follows and settings as you left them:\n${resume}\n\nYour account: ${env.SITE_URL}account/\nUnsubscribe: ${unsub}${FOOTER}`,
    unsubscribe: unsub,
  };
}

// Emailed API links go through the Worker (it forwards to the members' API), never gene's host.
const API = (_env: Env) => `${WORKER_URL}/`;

/** Sends the day-14 note once per subscription when a trial runs out cancelled (not a mid-trial cancel). */
export async function maybeWinback(env: Env, prev: Member | null, m: Member, now = Date.now()): Promise<void> {
  if (!prev || prev.status !== 'trialing' || m.status !== 'canceled' || !lifecycle(m) || m.marketing_off || !m.email || m.winback_sent === m.subscription) return;
  if (!prev.trial_end || now < prev.trial_end * 1000 - 3600_000) return;
  const resume = `${env.SITE_URL}resume/?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'resume', m.customer, 30 * 86400, { s: m.plan }))}`;
  if ((await sendMail(env, [winbackMail(env, m, resume, await unsubscribeUrl(env, m.customer))])) === '200') m.winback_sent = m.subscription;
}

/**
 * The email buttons: GET /keep switches a trial to the yearly price on a portal confirm page (the
 * member sees the amount first); GET /resume starts a new monthly subscription at Checkout, no trial.
 */
/**
 * Yearly at the peak (the lead, Nov 11): in an alert that carries Berkshire's 13F, one line for a monthly member or a
 * monthly trial, linked to the portal's switch (/keep). Null for everyone else.
 */
export async function yearlyPeakLine(env: Env, m: Member, filings: { slug: string; slugs?: string[]; followup?: boolean }[]): Promise<string | null> {
  const p = PRICES[m.plan];
  if (!p || m.interval !== 'monthly' || m.seat_of || !isActive(m) || m.comped) return null;
  if (!filings.some((a) => !a.followup && (a.slug === 'warren-buffett' || a.slugs?.includes('warren-buffett')))) return null;
  const keep = `${API(env)}keep?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'keep', m.customer, 14 * 86400))}`;
  // Copy's founding price (the lead, Nov 11): $79 a year, locked while subscribed; $99 for new members from Feb 1.
  return m.plan === 'copy' ? `Founding price ${money(p.year)}/yr, locked. Goes to $99 for new members Feb 1: ${keep}` : `Switch to yearly: ${money(p.year)}, ${monthsFree(p)}: ${keep}`;
}

/**
 * The portal's confirm page for moving a monthly plan (or a monthly trial) to yearly on the same subscription, back to
 * /account/?kept=yearly. Null when there's nothing to switch (yearly already, inactive, no item or price).
 */
export async function yearlyPortalUrl(env: Env, m: Member): Promise<string | null> {
  const account = `${env.SITE_URL}account/`;
  if (!PRICES[m.plan] || !isActive(m) || m.interval === 'yearly' || !m.subscription?.startsWith('sub_')) return null;
  const sub = await stripe(env, 'GET', `subscriptions/${m.subscription}`);
  const item = sub.items?.data?.[0];
  const price = (await stripe(env, 'GET', 'prices', { 'lookup_keys[]': `${m.plan}_yearly`, active: true })).data?.[0];
  if (!item?.id || !price?.id) return null;
  const s = await stripe(env, 'POST', 'billing_portal/sessions', {
    customer: m.customer,
    configuration: env.PORTAL_CONFIGURATION || undefined,
    return_url: account,
    'flow_data[type]': 'subscription_update_confirm',
    'flow_data[subscription_update_confirm][subscription]': m.subscription,
    'flow_data[subscription_update_confirm][items][0][id]': item.id,
    'flow_data[subscription_update_confirm][items][0][price]': price.id,
    'flow_data[subscription_update_confirm][items][0][quantity]': 1,
    'flow_data[after_completion][type]': 'redirect',
    'flow_data[after_completion][redirect][return_url]': `${account}?kept=yearly`,
  });
  return s.url ?? null;
}

export async function handleKeepResume(env: Env, path: '/keep' | '/resume', url: URL, method = 'GET'): Promise<Response> {
  const go = (to: string) => Response.redirect(to, 303);
  const account = `${env.SITE_URL}account/`;
  const p = await verifyToken(env.SESSION_SECRET, url.searchParams.get('t') ?? '', path === '/keep' ? 'keep' : 'resume');
  const m = p && (await getMember(env, p.c));
  if (!m || !PRICES[m.plan]) return go(account);
  try {
    if (path === '/keep') {
      return go((await yearlyPortalUrl(env, m)) ?? account);
    }
    const plan = p!.s ?? m.plan;
    const customer = m.customer;
    // Paused between seasons, or cancelled but not ended yet: resuming keeps the same subscription (a checkout
    // would start a second one). Opening the link (GET) changes nothing: it shows the site's /resume/ page, whose
    // button POSTs here, so a mail scanner can't resume a plan. The POST also signs them in (a 2-minute sign-in
    // handoff, as the account page's own links), so they land on /account/ seeing "You've resumed".
    const cancelling = isActive(m) && !!m.cancel_at_period_end;
    if (isPaused(m) || pauseScheduled(m) || cancelling) {
      if (method !== 'POST') return go(`${env.SITE_URL}resume/?t=${encodeURIComponent(url.searchParams.get('t') ?? '')}`);
      if (isPaused(m) || pauseScheduled(m)) await endPause(env, m);
      else await syncSubscription(env, await stripe(env, 'POST', `subscriptions/${m.subscription}`, { cancel_at_period_end: 'false' }));
      return go(`${account}?resumed=1&login=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'login', m.customer, 120))}`);
    }
    // Already back on a plan: nothing to start.
    if (isActive(m)) return go(account);
    const price = (await stripe(env, 'GET', 'prices', { 'lookup_keys[]': `${plan}_monthly`, active: true })).data?.[0];
    if (!price?.id) return go(`${env.SITE_URL}pricing/`);
    const cs = await stripe(env, 'POST', 'checkout/sessions', {
      mode: 'subscription',
      customer,
      'line_items[0][price]': price.id,
      'line_items[0][quantity]': 1,
      success_url: `${account}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.SITE_URL}pricing/`,
      'metadata[copybook]': 'resume',
      // The seller on the card statement is the account's name: say whose product it is.
      'custom_text[submit][message]': 'Copybook is made by Factor Dynamics.',
    });
    return go(cs.url);
  } catch (e) {
    console.log(`${path}: ${e}`);
    return go(account);
  }
}

/**
 * The day after each 13F deadline, to monthly payers: their season (alerts, the fastest one, moves in their
 * names), then yearly's price and savings with one button to the same portal confirm page as the trial's day 11.
 */
export function seasonRecapMail(m: Member, st: MemberStats, sent: number, funds: number, median: number | null, season: string, keep: string, unsub: string): Mail {
  const p = PRICES[m.plan];
  const secs = (n: number) => (n < 120 ? `${n} seconds` : `${Math.round(n / 60)} minutes`);
  const got = [
    `${sent} alert${sent === 1 ? '' : 's'} on the ${funds} fund${funds === 1 ? '' : 's'} you follow`,
    ...(st.fastest != null ? [`Your fastest: ${secs(st.fastest)} from EDGAR acceptance${st.fastest_what ? ` (${st.fastest_what})` : ''}`] : []),
    ...(st.owned.length ? [`Moves in names you own: ${st.owned.slice(0, 6).join(', ')}${st.owned.length > 6 ? ` and ${st.owned.length - 6} more` : ''}`] : []),
    ...(median != null ? [`Median time from EDGAR acceptance to inbox this season: ${secs(median)}`] : []),
  ];
  const cta = `Switch to yearly: ${money(p.year)}/year, ${monthsFree(p)}`;
  const founding = FOUNDING[m.plan] ?? '';
  return {
    to: m.email,
    subject: `Your ${season} filing season on Copybook, and yearly for ${monthsOf(p)}`,
    text: `The ${season} 13F filing season is in. Copybook sent you ${sent} alert${sent === 1 ? '' : 's'}.${median != null ? ` Our median time from EDGAR acceptance to your inbox this season was ${secs(median)}.` : ''}\n\nYour season:\n${got.map((g) => `  - ${g}`).join('\n')}\n\nYou're on ${p.name} monthly: ${money(p.month * 12)} a year. Yearly is ${money(p.year)}: ${monthsFree(p)}.${founding ? ` ${founding}` : ''}\n\n${cta} (you see the amount and confirm on the next page): ${keep}\n\nUnsubscribe from tips and newsletters: ${unsub}${FOOTER}`,
    html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:560px"><p>The ${esc(season)} 13F filing season is in.</p><p style="margin-bottom:4px"><b>Your season</b></p><ul style="margin-top:0;padding-left:20px">${got.map((g) => `<li>${esc(g)}</li>`).join('')}</ul><p>You're on ${esc(p.name)} monthly: ${money(p.month * 12)} a year. Yearly is <b>${money(p.year)}</b>: ${monthsFree(p)}.</p><p style="margin:22px 0 8px"><a href="${keep}" style="display:inline-block;background:#111;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:600">${esc(cta)}</a></p>${founding ? `<p style="font-size:13px;color:#374151;margin:0 0 6px">${esc(founding)}</p>` : ''}<p style="font-size:13px;color:#374151;margin:0">You see the amount and confirm on the next page.</p><p style="color:#6b7280;font-size:12px;margin-top:24px">Source: SEC EDGAR filings, as filed. Not investment advice. Copybook by Factor Dynamics. <a href="${unsub}" style="color:#6b7280">Unsubscribe from tips and newsletters</a></p></div>`,
    unsubscribe: unsub,
  };
}

export const WHY: Record<string, string> = {
  price: 'Too expensive',
  value: 'Not useful enough',
  feature: 'Missing a feature I need',
  alerts: 'Alerts too slow or too noisy',
  temporary: 'Only needed it for a while',
  seasonal: 'Only need it in filing season',
  other: 'Something else',
};

export async function cancelMail(env: Env, m: Member): Promise<Mail> {
  const token = await signToken(env.SESSION_SECRET, 'why', m.customer, 60 * 86400);
  // The site's /why/ page asks, then POSTs to the API: opening the link (mail scanners) records nothing.
  const base = `${env.SITE_URL}why/?t=${encodeURIComponent(token)}&r=`;
  const ends = m.status === 'canceled' ? null : (m.cancel_at ?? (m.status === 'trialing' ? m.trial_end : null) ?? m.period_end) || null;
  const name = PRICES[m.plan]?.name ?? 'Copybook';
  // The resume link opens the site's page, which changes nothing until its button posts (mail scanners follow links).
  // Already told us why they cancelled (in the app or a cancel email, within a day): the email doesn't ask again.
  // A pause reason doesn't count: pausing isn't cancelling (retail's 00:26 pause hid the question at 01:29).
  const told = JSON.parse((await env.DB.get(`why:${m.customer}`)) ?? 'null') as { at?: string; via?: string } | null;
  const ask = !(told?.at && told.via !== 'pause' && Date.now() - Date.parse(told.at) < 86400_000);
  const resume = ends ? `${env.SITE_URL}resume/?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'resume', m.customer, Math.max(86400, ends - Math.floor(Date.now() / 1000) + 86400)))}` : null;
  return {
    to: m.email,
    subject: ends ? `Your ${name} plan ends ${day(ends)} · Resume anytime before then` : `Your ${name} plan has ended`,
    text: `${ends ? `Your ${name} plan is cancelled and ends on ${endAt(ends)}. Alerts, history and CSV keep working until then${m.status === 'trialing' ? ", and you won't be charged" : ''}.\n\nChanged your mind? Resume with one click, same plan and price, follows kept:\n${resume}` : `Your ${name} plan has ended. Your follows are kept if you come back: ${env.SITE_URL}pricing/`}${ask ? `\n\nOne question: what was the main reason? One click is enough:\n${Object.entries(WHY).map(([k, v]) => `  ${v}: ${base}${k}`).join('\n')}` : ''}\n\nYour account: ${env.SITE_URL}account/${FOOTER}`,
    html: mailHtml(
      (ends
        ? `<p>Your ${esc(name)} plan is cancelled and ends on <b>${esc(endAt(ends))}</b>. Alerts, history and CSV keep working until then${m.status === 'trialing' ? ", and you won't be charged" : ''}.</p><p>Changed your mind? Same plan and price, follows kept.</p>${button(resume!, 'Resume your plan')}`
        : `<p>Your ${esc(name)} plan has ended. Your follows are kept if you come back: <a href="${env.SITE_URL}pricing/">see plans</a>.</p>`) +
        (ask ? `<p style="margin-bottom:4px"><b>One question: what was the main reason?</b> One click is enough. <a href="${base}other">Tell us why</a>:</p><ul style="margin-top:0">${Object.entries(WHY).map(([k, v]) => `<li><a href="${base}${k}">${esc(v)}</a></li>`).join('')}</ul>` : '') +
        `<p><a href="${env.SITE_URL}account/">Your account</a></p>`,
    ),
  };
}

/** A footer'd HTML body with real links (the text part keeps bare URLs). */
const mailHtml = (inner: string) =>
  `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:560px">${inner}<p style="color:#666;font-size:13px">${esc(FOOTER.trim()).replace(/\n/g, '<br>')}</p></div>`;
const button = (href: string, label: string) =>
  `<p><a href="${href}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(label)}</a></p>`;

/** A cancellation undone before it took effect (the resume link, or Renew in the billing portal): one confirmation. */
export async function maybeResumeMail(env: Env, prev: Member | null, m: Member): Promise<void> {
  if (!prev || prev.subscription !== m.subscription || !prev.cancel_at_period_end || m.cancel_at_period_end || !isActive(m) || isPaused(m)) return;
  if (!confirms(m) || !m.email) return;
  // A later cancel asks again.
  if ((await sendMail(env, [resumedMail(env, m)])) === '200') m.why_sent = undefined;
}

function resumedMail(env: Env, m: Member): Mail {
  const name = PRICES[m.plan]?.name ?? 'Copybook';
  const next = m.status === 'trialing' ? m.trial_end : m.period_end;
  return {
    to: m.email,
    subject: `You've resumed ${name}`,
    text: `You've resumed ${name}. Nothing ends: alerts, history and CSV carry on, with your follows and settings as they are.\n\n${next ? `${m.status === 'trialing' ? 'Your trial ends' : 'Your plan renews'} on ${endAt(next)}.` : ''} ${priceLine(m)}\n\nYour account: ${env.SITE_URL}account/${FOOTER}`,
    html: mailHtml(`<p>You've resumed ${esc(name)}. Nothing ends: alerts, history and CSV carry on, with your follows and settings as they are.</p><p>${next ? `${m.status === 'trialing' ? 'Your trial ends' : 'Your plan renews'} on <b>${esc(endAt(next))}</b>. ` : ''}${esc(priceLine(m))}</p><p><a href="${env.SITE_URL}account/">Your account</a></p>`),
  };
}

/** Sent once per subscription when a member cancels (now or at period end). */
export async function maybeCancelMail(env: Env, prev: Member | null, m: Member): Promise<void> {
  if (!confirms(m) || !m.email || m.why_sent === m.subscription) return;
  const cancelling = (m.cancel_at_period_end && !prev?.cancel_at_period_end) || (m.status === 'canceled' && !!prev && isActive(prev) && !prev.cancel_at_period_end);
  if (!cancelling) return;
  if ((await sendMail(env, [await cancelMail(env, m)])) === '200') m.why_sent = m.subscription;
}

/** GET /why?t=&r= records the reason (once; a later click replaces it) and thanks them. POST adds a note. */
export async function handleWhy(env: Env, req: Request, url: URL): Promise<Response> {
  const page = (msg: string, form = '') =>
    new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Copybook</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#111"><p>${msg}</p>${form}<p style="color:#6b7280;font-size:14px"><a href="${env.SITE_URL}" style="color:#1d4ed8">Copybook</a></p></body>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  const form = req.method === 'POST' ? await req.formData().catch(() => new FormData()) : null;
  const t = form ? String(form.get('t') ?? '') : (url.searchParams.get('t') ?? '');
  const p = await verifyToken(env.SESSION_SECRET, t, 'why');
  if (!p) return page('This link has expired. Thanks anyway.');
  const k = `why:${p.c}`;
  const cur = JSON.parse((await env.DB.get(k)) ?? 'null') as { reason: string; note?: string; at: string } | null;
  const r = String(form ? (form.get('r') ?? '') : (url.searchParams.get('r') ?? ''));
  // Opening the email's link (GET) records nothing (mail scanners follow links): it asks, and Send POSTs.
  if (req.method === 'POST') {
    const note = String(form?.get('note') ?? '').trim().slice(0, 2000);
    if (WHY[r]) await env.DB.put(k, JSON.stringify({ reason: r, via: 'email', at: new Date().toISOString(), ...(note ? { note } : cur?.note ? { note: cur.note } : {}) }));
    else if (cur && note) await env.DB.put(k, JSON.stringify({ ...cur, note }));
    return page(WHY[r] ? `Thanks: “${WHY[r]}” is noted. We read every one.` : 'Thank you. We read every one.');
  }
  if (!WHY[r]) return page('Unknown reason.');
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const send = `<form method="post" action="why"><input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="r" value="${esc(r)}"><p><label>Anything else we should know? (optional)<br><textarea name="note" rows="4" style="width:100%;font:inherit"></textarea></label></p><button style="font:inherit;padding:6px 14px">Send</button></form>`;
  return page(`Your reason: “${WHY[r]}”. Send it?`, send);
}

/** Daily: trial reminders 3 days out, and once per season the recap for monthly members. */
export async function runRevenue(env: Env, now: number): Promise<Record<string, unknown>> {
  // Unsubscribed members still get the trial-ending reminder: it's a notice before a charge, not marketing. The recap
  // below checks marketing_off itself.
  // An unconfirmed trial (email_pending) has had its welcome, with the sign-in link; nothing else until it is opened.
  const members = (await listMembers(env)).filter((m) => lifecycle(m) && isActive(m) && m.email && !m.email_pending);
  const mails: Mail[] = [];
  const marks: Member[] = [];
  // The season recap goes out from the day after each 13F deadline, for a week (Q3 2026: from Nov 17).
  const ld = lastDeadline(now);
  const recap = ld && now - deadlineMs(ld.date) <= 7 * 86400_000 ? ld.quarter.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1') : null;
  let median: number | null = null;
  if (recap) {
    const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as { seconds: number; replay?: boolean; sent?: string }[];
    const s = log.filter((l) => !l.replay && l.sent && Date.parse(l.sent) > now - 45 * 86400_000).map((l) => l.seconds).sort((a, b) => a - b);
    median = s.length ? s[Math.floor((s.length - 1) / 2)] : null;
  }
  // Invoice-billed Fund customers past due: paused, with an email (Stripe's invoice.overdue does the same).
  const invoices = await sweepInvoiceTrials(env, now).catch((e) => ({ error: String(e).slice(0, 160) }));
  for (const m of members) {
    const left = (m.trial_end ?? 0) * 1000 - now;
    if (m.status === 'trialing' && !pauseScheduled(m, now) && left > 0 && left <= 3 * 86400_000 && m.trial_reminded !== m.trial_end) {
      const f = await getFollows(env, m);
      const keep = `${API(env)}keep?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'keep', m.customer, 14 * 86400))}`;
      // Billed by invoice: no card to add and nothing to keep; the notice says when the invoice comes and how to stop it.
      if (m.collection === 'send_invoice') {
        const ends = new Date((m.trial_end ?? 0) * 1000).toISOString().slice(0, 10);
        mails.push({ to: m.email, subject: `Your Copy Fund invoice comes on ${ends}`, text: `Your Copy Fund trial ends on ${ends}. That day Stripe emails your invoice for ${money(PRICES.fund.year)} (the founding price, a year), payable within 30 days by card, ACH or bank transfer. Access continues meanwhile.

Not going ahead? Cancel before ${ends} in your account and nothing is owed:
${env.SITE_URL}account/

Unsubscribe: ${await unsubscribeUrl(env, m.customer)}${FOOTER}`, unsubscribe: await unsubscribeUrl(env, m.customer) });
      } else {
        // A card added in Manage billing since the last sync (customer.updated doesn't re-sync): ask only if still none.
        if (m.has_payment_method === false && (await customerHasCard(env, m.customer))) m.has_payment_method = true;
        const pv = m.has_payment_method === false && m.plan === 'copy' ? await (await import('./stockevents')).winterPreview(env, [...f.stocks, ...f.owned]).catch(() => null) : null;
        mails.push(trialEndingMail(env, m, await memberStats(env, m.customer), f.investors.length, f.owned.length, keep, await unsubscribeUrl(env, m.customer), Math.max(1, Math.ceil(left / 86400_000)), pv));
      }
      marks.push({ ...m, trial_reminded: m.trial_end });
    } else if (recap && m.status === 'active' && m.interval === 'monthly' && m.recap_sent !== recap && !m.marketing_off) {
      const f = await getFollows(env, m);
      const st = await memberStats(env, m.customer);
      const keep = `${API(env)}keep?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'keep', m.customer, 14 * 86400))}`;
      mails.push(seasonRecapMail(m, st, st.n - (m.recap_n ?? 0), f.investors.length, median, recap, keep, await unsubscribeUrl(env, m.customer)));
      marks.push({ ...m, recap_sent: recap, recap_n: st.n });
    }
  }
  const status = await sendMail(env, mails, { tier: 'low' });
  if (status.split(',').every((s) => s === '200')) {
    // Re-read so a webhook that landed meanwhile isn't overwritten.
    for (const mk of marks) {
      const cur = await getMember(env, mk.customer);
      if (cur) await putMember(env, { ...cur, trial_reminded: mk.trial_reminded ?? cur.trial_reminded, recap_sent: mk.recap_sent ?? cur.recap_sent, recap_n: mk.recap_n ?? cur.recap_n });
    }
  }
  return { emails: mails.length, status, invoices };
}

/** Counts only: paying members by plan and interval (comped and seats counted apart), trials, scheduled cancellations, cancel reasons, alerts sent. */
export async function businessSummary(env: Env, now: number) {
  const members = await listMembers(env);
  const by: Record<string, number> = {};
  let trials = 0;
  let cancelling = 0;
  let seats = 0;
  let comped = 0;
  for (const m of members) {
    // Synthetic records (the latency probe) have no plan and aren't members.
    // Synthetic records (the latency probe) have no plan and aren't members; launch-gate test subscriptions aren't revenue.
    if (!isActive(m) || m.test || (!PRICES[m.plan] && m.plan !== 'holdterm')) continue;
    if (m.seat_of) {
      seats++;
      continue;
    }
    if (m.comped) {
      comped++;
      continue;
    }
    by[`${m.plan}_${m.interval}`] = (by[`${m.plan}_${m.interval}`] ?? 0) + 1;
    if (m.status === 'trialing') trials++;
    if (m.cancel_at_period_end) cancelling++;
  }
  const reasons: Record<string, number> = {};
  // Real members' reasons only: test and comped members' (reviewers' runs) never count as churn.
  const real = new Set(members.filter((m) => billable(m)).map((m) => m.customer));
  let cursor: string | undefined;
  do {
    const page = await env.DB.list({ prefix: 'why:', cursor });
    for (const k of page.keys) {
      if (!real.has(k.name.slice(4))) continue;
      const r = (JSON.parse((await env.DB.get(k.name)) ?? 'null') as { reason?: string } | null)?.reason;
      if (r) reasons[r] = (reasons[r] ?? 0) + 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const hour = Math.floor(now / 3600_000);
  const sent = (JSON.parse((await env.DB.get('stats:sent')) ?? '[]') as [number, number][]).filter(([h]) => h > hour - 24).reduce((a, [, n]) => a + n, 0);
  return {
    active: Object.values(by).reduce((a, n) => a + n, 0),
    by_plan: by,
    trials,
    cancellations_scheduled: cancelling,
    fund_seats: seats,
    comped,
    cancel_reasons: reasons,
    alert_emails_24h: sent,
    funnel_7d: await funnel(env, now, 7).then(({ by_day: _, ...f }) => f),
    funnel_30d: await funnel(env, now, 30),
  };
}

// ---------------------------------------------------------------------------------------------------
// Seasonal churn defense: pause until the next season instead of cancelling, a reminder before it ends,
// a win-back before each 13F deadline for paused and lapsed members, and failed-payment email.

/** The New York calendar day (22:00 ET on Feb 2 is Feb 2, not 03:00 UTC Feb 3). */
const isoDay = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * Who can pause: a monthly Copy, Pro or Fund owner on their own subscription, after the trial. Comped and
 * test members can too (critics try it); Holdterm, seats and yearly plans can't. /me's pause_offer and POST
 * /pause both use this.
 */
const pausable = (m: Member) => m.plan !== 'holdterm' && !m.seat_of && !!PRICES[m.plan] && !!m.subscription && m.interval === 'monthly';


export const PAUSE_NOTE = 'Monthly plans can pause once a year, for up to 3 months: until 2 weeks before the next 13F deadline.';
export const PAUSE_AFTER_TRIAL_NOTE = 'Pause after your trial, once a year for up to 3 months: no charge until 2 weeks before the next 13F deadline, when real-time alerts resume.';
/**
 * One pause per rolling 12 months, of at most 3 months (the lead, Nov 11): 9 paid months x $9 = $81, so $79 a year stays
 * the better deal. When the next one can start (ms), or null when one can now.
 */
export const PAUSE_EVERY_MS = 365 * 86_400_000;
export const pauseNextAt = (m: Member, now = Date.now()) => (m.paused_at && m.paused_at * 1000 + PAUSE_EVERY_MS > now ? m.paused_at * 1000 + PAUSE_EVERY_MS : null);
/** Resumes 2 weeks before the next deadline, and never more than 3 calendar months after the pause starts. */
const pauseEnd = (from: number) => {
  const r = pauseResumesAt(from);
  const cap = new Date(from);
  cap.setUTCMonth(cap.getUTCMonth() + 3);
  return { ...r, at: Math.min(r.at, Math.floor(cap.getTime() / 1000)) };
};

/** When a pause chosen now starts: today, or for a monthly trial, the trial's end (the trial keeps everything). */
const pauseStart = (m: Member, now: number) => (m.status === 'trialing' && m.trial_end && m.trial_end * 1000 > now ? m.trial_end * 1000 : now);

export function pauseOffer(m: Member, now = Date.now()): { until: string; quarter: string; deadline: string; deadline_label: string; note: string; starts: string } | null {
  // Never a trial without a card (it just ends), and once per 12 months.
  if (!pausable(m) || (m.status !== 'active' && m.status !== 'trialing') || (m.status === 'trialing' && m.has_payment_method === false) || pauseNextAt(m, now) || isPaused(m, now) || pauseScheduled(m, now)) return null;
  const from = pauseStart(m, now);
  const r = pauseEnd(from);
  return { until: isoDay(r.at), quarter: r.quarter, deadline: r.deadline, deadline_label: deadlineLabel(r.deadline), note: from > now ? PAUSE_AFTER_TRIAL_NOTE : PAUSE_NOTE, starts: isoDay(Math.floor(from / 1000)) };
}

/** Stores the one cancellation question's answer (from /account/ or the email); counted in business.cancel_reasons. */
/** Free text that can go with any cancellation or pause reason. */
export const NOTE_MAX = 300;

export async function noteReason(env: Env, customer: string, reason: string, via: 'account' | 'pause' | 'email', note?: string): Promise<boolean> {
  if (!WHY[reason]) return false;
  await env.DB.put(`why:${customer}`, JSON.stringify({ reason, via, at: new Date().toISOString(), ...(note ? { note: note.slice(0, NOTE_MAX) } : {}) }));
  return true;
}

/**
 * POST /pause: Stripe pause_collection (invoices voided) until 14 days before the next deadline. The member
 * keeps the account, follows and price; alerts and paid features stop until then (isActive). A scheduled
 * cancellation is lifted: they chose to pause instead.
 */
export async function pauseMember(env: Env, m: Member, reason: string | null, now = Date.now(), note?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const offer = pauseOffer(m, now);
  const nextAt = pausable(m) ? pauseNextAt(m, now) : null;
  if (!offer && nextAt && !isPaused(m, now) && !pauseScheduled(m, now)) return { status: 409, body: { ok: false, error: `Monthly plans can pause once a year; your next pause is available from ${isoDay(Math.floor(nextAt / 1000))}`, code: 'pause_used', next_pause: isoDay(Math.floor(nextAt / 1000)) } };
  if (!offer && m.status === 'trialing' && m.has_payment_method === false) return { status: 409, body: { ok: false, error: 'Add a card to keep Copy; a trial without one just ends, so there is nothing to pause', code: 'no_card' } };
  if (!offer) return { status: 409, body: { ok: false, error: isPaused(m, now) ? 'Already paused' : m.status === 'trialing' ? 'Monthly plans can pause after the trial; cancel in Manage billing instead' : 'Monthly plans can pause; yearly, seat and Holdterm plans cancel in Manage billing instead', code: 'pause_unavailable' } };
  if (reason && !(await noteReason(env, m.customer, reason, 'pause', note))) return { status: 400, body: { ok: false, error: `reason: ${Object.keys(WHY).join(', ')}`, code: 'bad_request' } };
  const start = pauseStart(m, now);
  const at = pauseEnd(start).at;
  const sub = await stripe(env, 'POST', `subscriptions/${m.subscription}`, { 'pause_collection[behavior]': 'void', 'pause_collection[resumes_at]': at, cancel_at_period_end: 'false' });
  // The pause counts from when it starts (a trial's end), resumed early or not.
  const next = { ...(await syncSubscription(env, sub)), paused_at: Math.floor(start / 1000) };
  await putMember(env, next);
  if (billable(next)) await bump(env, 'pauses', next, `${m.subscription}:${at}`, now);
  await sendMail(env, [pauseReceiptMail(env, next, at, await resumeUrl(env, next))]);
  return { status: 200, body: { ok: true, paused_until: isoDay(at), starts: offer.starts, deadline: offer.deadline, member: { paused_until: next.paused_until, pause_after_trial: pauseScheduled(next, now) ? { from: next.paused_from, until: next.paused_until } : null } } };
}

/** Ends a pause on the same subscription and sends the confirmation with the next charge date (DELETE /pause and the email's resume link). */
export async function endPause(env: Env, m: Member): Promise<Member> {
  const next = await syncSubscription(env, await stripe(env, 'POST', `subscriptions/${m.subscription}`, { pause_collection: '' }));
  await sendMail(env, [resumeConfirmMail(env, next)]);
  return next;
}

/** DELETE /pause: back now, on the same subscription and price. */
export async function unpauseMember(env: Env, m: Member): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isPaused(m) && !pauseScheduled(m)) return { status: 409, body: { ok: false, error: 'Not paused', code: 'not_paused' } };
  const next = await endPause(env, m);
  return { status: 200, body: { ok: true, next_charge: next.period_end ? isoDay(next.period_end) : null } };
}

const priceLine = (m: Member) => {
  const p = PRICES[m.plan];
  if (!p) return 'Your follows and settings are kept.';
  return FOUNDING[m.plan] ? `Your follows and founding price are kept. ${FOUNDING[m.plan]}` : `Your follows and price (${m.interval === 'yearly' ? `${money(p.year)} a year` : `${money(p.month)} a month`}) are kept.`;
};

/** The pause receipt: until when, no charges until then, what is kept, and the one-click resume. */
export function pauseReceiptMail(env: Env, m: Member, at: number, resume: string): Mail {
  const until = deadlineLabel(isoDay(at));
  const p = PRICES[m.plan];
  const after = pauseScheduled(m) ? m.paused_from! : null;
  return {
    to: m.email,
    subject: after ? `Your trial continues; then paused until ${until} · no charges until then` : `Paused until ${until} · no charges until then`,
    text: `${after ? `Your ${p?.name ?? 'Copybook'} trial continues with everything on until ${endAt(after)}. Then your plan pauses` : `Your ${p?.name ?? 'Copybook'} plan is paused`} until ${until}, two weeks before the next 13F deadline (${deadlineLabel(nextDeadline(at * 1000).date)}).\n\n  - No charges until then; billing resumes on ${until}.\n  - ${priceLine(m)}\n  - Real-time alerts are off while you're paused. If a fund you follow files its 13F while you're paused, we'll email you so you can resume right away.\n  - Resume anytime, one click, same subscription: ${resume}\n\nYour account: ${env.SITE_URL}account/${FOOTER}`,
  };
}

/** After a pause ends early: alerts are back, and when the next charge is. */
export function resumeConfirmMail(env: Env, m: Member): Mail {
  const p = PRICES[m.plan];
  // A trial with a pause scheduled after it: nothing had stopped, so only the scheduled pause is gone.
  if (m.status === 'trialing' && m.trial_end) {
    const price = p ? (m.interval === 'yearly' ? `${money(p.year)} a year` : `${money(p.month)} a month`) : 'your plan';
    return {
      to: m.email,
      subject: `Pause cancelled: your ${p?.name ?? 'Copybook'} trial continues`,
      text: `Pause cancelled: your ${p?.name ?? 'Copybook'} trial continues to ${endAt(m.trial_end)}, then ${price}${m.has_payment_method === false ? ' once you add a card in your account' : ''}. Your alerts never stopped, and your follows and settings are as they were.\n\nYour account: ${env.SITE_URL}account/${FOOTER}`,
    };
  }
  const when = m.period_end ? deadlineLabel(isoDay(m.period_end)) : null;
  return {
    to: m.email,
    subject: `Your Copybook alerts are back on`,
    text: `You've resumed ${p?.name ?? 'Copybook'}. Alerts, history and CSV are on again, with your follows and settings as you left them.\n\n${when ? `Your next charge is on ${when}${p ? ` (${money(m.interval === 'yearly' ? p.year : p.month)}, before any discount on your account)` : ''}.` : 'Your plan renews on its usual date.'} ${priceLine(m)}\n\nYour account: ${env.SITE_URL}account/${FOOTER}`,
  };
}

/** 3 days before a pause ends (and the paused member's pre-season note): when alerts restart, and last season in their names. */
export function pauseReminderMail(env: Env, m: Member, highlights: string[] = []): Mail {
  const back = day(m.paused_until!);
  const due = deadlineLabel(nextDeadline(m.paused_until! * 1000).date);
  const p = PRICES[m.plan];
  const last = highlights.length ? `Last season in your names:\n${highlights.map((h) => `  - ${h}`).join('\n')}\n\n` : '';
  return {
    to: m.email,
    subject: `Your Copybook alerts restart on ${back}, before the 13F deadline`,
    text: `Your ${p?.name ?? 'Copybook'} pause ends on ${back}, two weeks before the next 13F deadline (${due}). Alerts, history and CSV come back that day with your follows and settings as you left them, and your plan stays at ${p ? money(p.month) : 'the same price'} a month. Billing resumes then.\n\n${last}Want to stay paused, or cancel? ${env.SITE_URL}account/ (Manage billing).${FOOTER}`,
  };
}

/** The season's superinvestor moves in a member's names (public facts, like the free weekly), up to 3. */
async function seasonHighlights(names: string[], week: import('./free').Week): Promise<string[]> {
  const mine = new Set(names);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...week.all].filter((x) => x.featured && mine.has(x.ticker)).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))) {
    if (seen.has(x.ticker)) continue;
    seen.add(x.ticker);
    out.push(`${x.manager} ${x.usd > 0 ? 'bought' : 'sold'} $${(Math.abs(x.usd) / 1e6).toFixed(1)}M of ${x.ticker} (${x.form})`);
    if (out.length === 3) break;
  }
  return out;
}

/**
 * A followed fund filed its 13F while the member is paused (early filers come weeks before the season):
 * one note per filing day, with the one-click resume of the same subscription. Real-time alerts stay off.
 */
export function pausedFilingMail(m: Member, filings: Pick<Alert13F, 'manager' | 'quarter' | 'accepted' | 'filing_date'>[], resume: string, unsub: string): Mail {
  const q = (x: string, year = false) => x.replace(/^(\d{4})Q(\d)$/, year ? 'Q$2 $1' : 'Q$2');
  const at = (x: (typeof filings)[number]) => (x.accepted ? `${new Date(x.accepted).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET` : x.filing_date);
  const back = day(m.paused_until!);
  return {
    to: m.email,
    subject: `${filings[0].manager} filed its ${q(filings[0].quarter)} 13F · resume now to see the moves`,
    text: `${filings.map((x) => `${x.manager} filed its ${q(x.quarter, true)} 13F (accepted ${at(x)}).`).join('\n')}\n\nYou're paused until ${back}, so the moves aren't in your inbox. Resume now to get them, with your follows and price as you left them (one click, same subscription; billing picks up from your next billing date):\n${resume}\n\nOr stay paused: alerts restart on ${back} and billing resumes then.\n\nUnsubscribe from tips and newsletters: ${unsub}${FOOTER}`,
    unsubscribe: unsub,
  };
}

/** The resume button's link: ends a pause on the same subscription, or starts a new monthly one after a cancel. */
export async function resumeUrl(env: Env, m: Member): Promise<string> {
  return `${env.SITE_URL}resume/?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'resume', m.customer, 30 * 86400))}`;
}

export function preseasonMail(env: Env, m: Member, deadline: string, quarter: string, highlights: string[], resume: string | null, unsub: string): Mail {
  const due = deadlineLabel(deadline);
  const q = quarter.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1');
  const p = PRICES[m.plan];
  const last = highlights.length ? `Last season in your names:\n${highlights.map((h) => `  - ${h}`).join('\n')}\n\n` : '';
  const ask = isPaused(m)
    ? `Your pause ends on ${day(m.paused_until!)}, so alerts start again before the deadline; nothing to do.`
    : `${p?.name ?? 'Copy'} is ${p ? money(p.month) : '$9'} a month, cancel any time, with your follows as you left them. Start again: ${resume}`;
  return {
    to: m.email,
    subject: `${q} 13Fs are due ${due}: get each one minutes after it's filed`,
    text: `The ${q} 13F filing season peaks in the two weeks before ${due}. Copybook emails each filing minutes after EDGAR accepts it, with the moves in names you own first.\n\n${last}${ask}\n\nYour account: ${env.SITE_URL}account/\nUnsubscribe from tips and newsletters: ${unsub}${FOOTER}`,
    unsubscribe: unsub,
  };
}

/**
 * Daily: the pause reminder (3 days before alerts restart) and, from 14 days before each 13F deadline,
 * the pre-season win-back to paused members and lapsed ones (cancelled in the last 400 days, not back).
 */
export async function runSeasonal(env: Env, now: number): Promise<Record<string, unknown>> {
  const all = await listMembers(env);
  const mails: Mail[] = [];
  const marks: { customer: string; patch: Partial<Member> }[] = [];
  // Last season's moves, read once and only when someone gets a note: from 45 days before the last deadline to now.
  let week: import('./free').Week | null = null;
  const names = async (m: Member) => {
    if (!week) {
      const last = lastDeadline(now);
      const days = last ? Math.ceil((now - (deadlineMs(last.date) - 45 * 86400_000)) / 86400_000) : 120;
      week = await (await import('./free')).weeklyMoves(env, now, days);
    }
    const f = await getFollows(env, m);
    return seasonHighlights([...new Set([...f.owned, ...f.stocks])], week);
  };
  // Paused: 3 days before alerts restart (14 days before the deadline), with last season in their names.
  const reminders = all.filter((m) => pausable(m) && m.email && m.paused_until && isPaused(m, now) && m.pause_reminded !== m.paused_until && m.paused_until * 1000 - now <= 3 * 86400_000);
  for (const m of reminders) {
    mails.push(pauseReminderMail(env, m, await names(m)));
    marks.push({ customer: m.customer, patch: { pause_reminded: m.paused_until } });
  }
  // Lapsed (cancelled in the last 400 days, not back) and anyone still paused: from 14 to 7 days before a deadline.
  const d = DEADLINES.find((x) => now >= deadlineMs(x.date) - 14 * 86400_000 && now < deadlineMs(x.date) - 7 * 86400_000);
  let winbacks = 0;
  if (d) {
    const back = new Set(all.filter((m) => isActive(m) && billable(m)).map((m) => m.email));
    const who = all.filter(
      (m) => (billable(m) || (pausable(m) && isPaused(m, now))) && m.email && !m.marketing_off && m.preseason_sent !== d.quarter && !back.has(m.email) &&
        (isPaused(m, now) || (m.status === 'canceled' && (m.period_end ?? 0) * 1000 > now - 400 * 86400_000)),
    );
    for (const m of who) {
      const resume = isPaused(m, now) ? null : `${env.SITE_URL}resume/?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'resume', m.customer, 30 * 86400))}`;
      mails.push(preseasonMail(env, m, d.date, d.quarter, await names(m), resume, await unsubscribeUrl(env, m.customer)));
      marks.push({ customer: m.customer, patch: { preseason_sent: d.quarter } });
      winbacks++;
    }
  }
  const status = mails.length ? await sendMail(env, mails, { tier: 'low' }) : 'none';
  if (mails.length && status.split(',').every((x) => x === '200')) {
    for (const mk of marks) {
      const cur = await getMember(env, mk.customer);
      if (cur) await putMember(env, { ...cur, ...mk.patch });
    }
  }
  return { reminders: reminders.length, winbacks, status };
}

/**
 * invoice.payment_failed: one email per invoice with Stripe's hosted invoice page, where the member pays
 * with a new card. Stripe's Smart Retries keep retrying meanwhile.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function paymentFailed(env: Env, inv: any): Promise<string> {
  const customer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
  const m = customer ? await getMember(env, customer) : null;
  if (!m || !lifecycle(m) || !m.email || !(Number(inv.amount_due) > 0) || !inv.hosted_invoice_url) return 'skipped';
  if (m.dunning_sent === inv.id) return 'already sent';
  const p = PRICES[m.plan];
  const amount = (Number(inv.amount_due) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const next = inv.next_payment_attempt ? ` We'll try again on ${day(Number(inv.next_payment_attempt))}.` : '';
  const status = await sendMail(env, [
    {
      to: m.email,
      subject: `Your ${p?.name ?? 'Copybook'} payment didn't go through`,
      text: `We couldn't charge ${amount} for ${p?.name ?? 'Copybook'}.${next} Your alerts keep coming while we retry.\n\nUpdate your card and pay here (a secure Stripe page): ${inv.hosted_invoice_url}\n\nOr in your account: ${env.SITE_URL}account/ (Manage billing).${FOOTER}`,
    },
  ]);
  if (status === '200') {
    const cur = await getMember(env, customer);
    if (cur) await putMember(env, { ...cur, dunning_sent: inv.id });
  }
  return status === '200' ? 'sent' : `mail ${status}`;
}

/**
 * Filing weeks only (7 days before a 13F deadline through the day after): one email a day to the team with the
 * last 24 hours: alerts sent, live latency p50/p90, missed filings recovered, failing channels, and the funnel.
 */
/** Workers requests a day on the plan, and when to warn: the free plan's 100,000 (Workers Paid has no daily cap). */
export const DAILY_REQUESTS = 100_000;
const WARN_AT = 0.7;

/**
 * The account's Workers and Pages Functions requests since 00:00 UTC (they share the daily quota), from Cloudflare's
 * GraphQL analytics (one subrequest, no Worker request). Null without CF_API_TOKEN or when it can't be read.
 */
export async function requestsToday(env: Env, now: number): Promise<{ workers: number; pages: number; total: number } | null> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const start = `${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`;
  const query = `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){w:workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests}} p:pagesFunctionsInvocationsAdaptiveGroups(limit:100,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests}}}}}`;
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, s: start, e: new Date(now).toISOString() } }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = ((await res.json()) as any)?.data?.viewer?.accounts?.[0];
    if (!acc) return null;
    const sum = (xs: { sum: { requests: number } }[] = []) => xs.reduce((t, x) => t + (x.sum?.requests ?? 0), 0);
    const workers = sum(acc.w);
    const pages = sum(acc.p);
    return { workers, pages, total: workers + pages };
  } catch {
    return null;
  }
}

/**
 * Hourly: one email to the team, once per UTC day, when the account passes 70% of the plan's daily Workers
 * requests, so a burst (a bulk upload, a busy Pages function) is caught before the API starts answering 429.
 */
/** Past these shares of the day's requests the Worker sheds non-member paths (shedLevel): 1 at 85%, 2 at 95%. */
const SHED_AT = [0.85, 0.95];
/** The day's shed level, in R2 (both hosts read and write it; it resets with the UTC day). */
export const SHED_KEY = 'quota/shed.json';

export async function runQuotaCheck(env: Env, now: number, to = 'hello@factordynamics.com'): Promise<Record<string, unknown>> {
  const used = await requestsToday(env, now);
  if (!used) return { status: 'no analytics token' };
  const share = used.total / DAILY_REQUESTS;
  // Shedding: members, sign-in, checkout, the webhook and unsubscribe are always served; the site's page counts and
  // anonymous probes go first. Raised only (usage only grows within a UTC day), so one write per level a day.
  const level = SHED_AT.filter((x) => share >= x).length;
  const day = new Date(now).toISOString().slice(0, 10);
  if (level) {
    const fo = await import('./failover');
    const cur = JSON.parse((await fo.r2Get(env, SHED_KEY).catch(() => null)) ?? 'null') as { day: string; level: number } | null;
    if (!cur || cur.day !== day || cur.level < level) await fo.r2Put(env, SHED_KEY, JSON.stringify({ day, level, used: used.total, at: new Date(now).toISOString() })).catch((e) => console.log(`shed: ${e}`));
  }
  if (share < WARN_AT) return { status: 'ok', ...used, share: Math.round(share * 1000) / 10 };
  const key = `quota:warned:${new Date(now).toISOString().slice(0, 10)}`;
  if (await env.DB.get(key)) return { status: 'already warned', ...used, shed: level };
  const pct = Math.round(share * 100);
  const status = await sendMail(env, [{ to, subject: `Copybook: ${pct}% of today's Workers requests used (${used.total.toLocaleString('en-US')} of ${DAILY_REQUESTS.toLocaleString('en-US')})`, text: `Since 00:00 UTC the Cloudflare account has used ${used.total.toLocaleString('en-US')} of the free plan's ${DAILY_REQUESTS.toLocaleString('en-US')} Workers requests a day: copybook-api and other Workers ${used.workers.toLocaleString('en-US')}, Pages Functions ${used.pages.toLocaleString('en-US')}.\n\nAt 85% the Worker stops answering the site's page counts (/track), anonymous /health and /latency; at 95% also anonymous /events. Members, sign-in, checkout, the Stripe webhook and unsubscribe are always served. At 100% every API request (sign-in, accounts, checkout, /v1) returns 429 until 00:00 UTC. Workers Paid ($5/mo) removes the daily cap: dash.cloudflare.com, Workers & Pages, Plans.${FOOTER}` }]);
  if (status === '200') await env.DB.put(key, '1', { expirationTtl: 3 * 86400 });
  return { status, ...used, shed: level };
}

export async function runOpsDigest(env: Env, now: number, to = 'hello@factordynamics.com'): Promise<Record<string, unknown>> {
  if (!inFilingWeek(now)) return { status: 'not a filing week' };
  const key = `ops:sent:${new Date(now).toISOString().slice(0, 10)}`;
  if (await env.DB.get(key)) return { status: 'already sent' };
  const since = now - 86400_000;
  const hour = Math.floor(now / 3600_000);
  const alerts = (JSON.parse((await env.DB.get('stats:sent')) ?? '[]') as [number, number][]).filter(([h]) => h > hour - 24).reduce((a, [, n]) => a + n, 0);
  const lat = (JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as { seconds: number; replay?: boolean; sent: string }[]).filter((l) => !l.replay && Date.parse(l.sent) >= since).map((l) => l.seconds).sort((a, b) => a - b);
  const at = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.ceil(q * lat.length) - 1)] : null);
  const missed = (JSON.parse((await env.DB.get('missed:log')) ?? '[]') as { accepted?: string }[]).filter((x) => x.accepted && Date.parse(x.accepted) >= since).length;
  const failing: Record<string, number> = {};
  let cursor: string | undefined;
  do {
    const page = await env.DB.list({ prefix: 'chfail:', cursor });
    for (const k of page.keys) for (const ch of Object.keys(JSON.parse((await env.DB.get(k.name)) ?? '{}'))) failing[ch] = (failing[ch] ?? 0) + 1;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const f = await funnel(env, now, 1);
  const used = await requestsToday(env, now);
  const lines = [
    `Workers requests today (UTC): ${used ? `${used.total.toLocaleString('en-US')} of ${DAILY_REQUESTS.toLocaleString('en-US')} (${Math.round((used.total / DAILY_REQUESTS) * 100)}%; Pages Functions ${used.pages.toLocaleString('en-US')})` : 'n/a'}`,
    `Alerts sent: ${alerts}`,
    `Latency (live, EDGAR acceptance to send): p50 ${at(0.5) ?? 'n/a'} s, p90 ${at(0.9) ?? 'n/a'} s, from ${lat.length} alerts`,
    `Missed filings recovered: ${missed} (${Number((await env.DB.get('missed:count')) ?? 0)} this season)`,
    `Members with a failing channel: ${Object.keys(failing).length ? Object.entries(failing).map(([c, n]) => `${c} ${n}`).join(', ') : 'none'}`,
    `Free signups: ${f.signups}`,
    `Trials started: ${f.trials}`,
    `Paid: ${f.trial_to_paid + f.paid_direct} (${f.trial_to_paid} from trials, ${f.paid_direct} direct)`,
    `Cancellations: ${f.cancellations}, pauses: ${f.pauses}`,
  ];
  const day = new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  const status = await sendMail(env, [{ to, subject: `Copybook filing week, ${day}: ${alerts} alerts, p50 ${at(0.5) ?? 'n/a'} s, ${f.trials} trials, ${f.trial_to_paid + f.paid_direct} paid`, text: `Last 24 hours (funnel: today, ET):\n${lines.map((l) => `  ${l}`).join('\n')}${FOOTER}` }]);
  if (status === '200') await env.DB.put(key, '1', { expirationTtl: 30 * 86400 });
  return { status, lines };
}
