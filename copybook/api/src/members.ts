import { loginMail, sendMail } from './email';
import { isActive, type Env, type Member } from './env';
import { stripe } from './stripe';
import { signToken } from './tokens';

export const LOGIN_TTL = 7 * 24 * 3600;
export const SESSION_TTL = 30 * 24 * 3600;

export async function getMember(env: Env, customer: string): Promise<Member | null> {
  const raw = await env.DB.get(`cus:${customer}`);
  if (!raw) return null;
  const m = JSON.parse(raw) as Member & { plan: string };
  // Records from before Copy Pro kept the billing interval in `plan`.
  if (m.plan !== 'copy' && m.plan !== 'pro' && m.plan !== 'fund') return { ...m, interval: m.plan as Member['interval'], plan: 'copy' };
  return m;
}

export async function memberByEmail(env: Env, email: string): Promise<Member | null> {
  const customer = await env.DB.get(`email:${email.trim().toLowerCase()}`);
  return customer ? getMember(env, customer) : null;
}

export async function putMember(env: Env, m: Member): Promise<void> {
  await env.DB.put(`cus:${m.customer}`, JSON.stringify(m));
  if (m.email) await env.DB.put(`email:${m.email.toLowerCase()}`, m.customer);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priceOf(sub: any) {
  return sub?.items?.data?.[0]?.price ?? sub?.plan;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function planOf(sub: any): Member['plan'] {
  const p = priceOf(sub);
  const tier = String(p?.metadata?.copybook ?? String(p?.lookup_key ?? '').split('_')[0]);
  return tier === 'pro' || tier === 'fund' ? tier : 'copy';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function intervalOf(sub: any): Member['interval'] {
  const interval = priceOf(sub)?.recurring?.interval ?? priceOf(sub)?.interval;
  return interval === 'month' ? 'monthly' : interval === 'year' ? 'yearly' : 'unknown';
}

/**
 * Upserts the member for a Stripe subscription object and sends the welcome
 * email (with a sign-in link) the first time the customer becomes active.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function syncSubscription(env: Env, sub: any, emailHint?: string | null): Promise<Member> {
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const prev = await getMember(env, customer);
  let email = (emailHint || prev?.email || '').trim().toLowerCase();
  if (!email) {
    const c = await stripe(env, 'GET', `customers/${customer}`);
    email = String(c.email || '').trim().toLowerCase();
  }
  const m: Member = {
    customer,
    email,
    status: String(sub.status),
    plan: planOf(sub),
    interval: intervalOf(sub),
    trial_end: sub.status === 'trialing' ? Number(sub.trial_end ?? 0) || null : null,
    period_end: Number(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? 0),
    subscription: String(sub.id),
    // New members get alerts for the funds they follow and active managers' moves in stocks they own or watch.
    alerts: prev?.alerts ?? [],
    welcomed: prev?.welcomed ?? false,
  };
  // A stale event (older subscription) must not overwrite a newer active one.
  if (prev && prev.subscription !== m.subscription && isActive(prev) && !isActive(m)) return prev;
  if (isActive(m) && !m.welcomed && m.email) {
    const token = await signToken(env.SESSION_SECRET, 'login', customer, LOGIN_TTL);
    // Only a delivered welcome counts; otherwise the next subscription event retries it.
    m.welcomed = (await sendMail(env, [loginMail(env, m.email, token, true)])) === '200';
  }
  await putMember(env, m);
  return m;
}

export function publicView(m: Member) {
  return { email: m.email, status: m.status, active: isActive(m), plan: m.plan, interval: m.interval, trial_end: m.trial_end ?? null, period_end: m.period_end, alerts: m.alerts };
}

export async function listMembers(env: Env): Promise<Member[]> {
  const out: Member[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DB.list({ prefix: 'cus:', cursor });
    for (const k of page.keys) {
      const raw = await env.DB.get(k.name);
      if (raw) out.push(JSON.parse(raw) as Member);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** What a member follows. `investors` mirrors `member.alerts` when that is a list of slugs. */
export interface Follows {
  investors: string[];
  stocks: string[];
  owned: string[];
  onboarded: boolean;
  /** Also alert on Schedule 13G/13G-A filings (mostly routine passive-stake updates). */
  include_13g: boolean;
  /** One end-of-day email instead of an email per filing. */
  digest: boolean;
}

export async function getFollows(env: Env, m: Member): Promise<Follows> {
  const raw = await env.DB.get(`follows:${m.customer}`);
  if (raw) return { include_13g: false, digest: false, ...(JSON.parse(raw) as Partial<Follows>) } as Follows;
  // First read: seed from the follows the site kept in member.alerts before /follows existed.
  const seeded: Follows = { investors: Array.isArray(m.alerts) ? m.alerts : [], stocks: [], owned: [], onboarded: false, include_13g: false, digest: false };
  await env.DB.put(`follows:${m.customer}`, JSON.stringify(seeded));
  return seeded;
}

export async function putFollows(env: Env, m: Member, f: Follows): Promise<void> {
  await env.DB.put(`follows:${m.customer}`, JSON.stringify(f));
  // Followed investors are the alert targets whenever alerts is a list (not "all" or "off").
  if (Array.isArray(m.alerts)) await putMember(env, { ...m, alerts: f.investors });
}
