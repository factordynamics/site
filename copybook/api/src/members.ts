import { holdtermLoginMail, loginMail, sendMail } from './email';
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
  if (m.plan !== 'copy' && m.plan !== 'pro' && m.plan !== 'fund' && m.plan !== 'holdterm') return { ...m, interval: m.plan as Member['interval'], plan: 'copy' };
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
  return tier === 'pro' || tier === 'fund' || tier === 'holdterm' ? tier : 'copy';
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
    // Only a delivered welcome counts; otherwise the next subscription event retries it. Holdterm's
    // welcome comes from Holdterm, never Copybook.
    const welcome = m.plan === 'holdterm' ? holdtermLoginMail(env, m.email, token, true) : loginMail(env, m.email, token, true);
    m.welcomed = (await sendMail(env, [welcome])) === '200';
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
  /** Open-market buys (Form 4 code P) by a company's directors, officers and 10% owners, on owned and watched stocks. */
  insider_buys: boolean;
  /** Smallest insider buy that alerts, in USD. */
  insider_min_usd: number;
  /** Three or more insiders of one company buying within 30 days. */
  cluster_buys: boolean;
  /** A new Schedule 13D (or 13G) by any filer on owned and watched stocks. */
  any_13d: boolean;
}

export const FOLLOW_DEFAULTS = { include_13g: false, digest: false, insider_buys: true, insider_min_usd: 100_000, cluster_buys: true, any_13d: true };

export async function getFollows(env: Env, m: Member): Promise<Follows> {
  const raw = await env.DB.get(`follows:${m.customer}`);
  if (raw) return { ...FOLLOW_DEFAULTS, ...(JSON.parse(raw) as Partial<Follows>) } as Follows;
  // First read: seed from the follows the site kept in member.alerts before /follows existed.
  const seeded: Follows = { investors: Array.isArray(m.alerts) ? m.alerts : [], stocks: [], owned: [], onboarded: false, ...FOLLOW_DEFAULTS };
  await env.DB.put(`follows:${m.customer}`, JSON.stringify(seeded));
  return seeded;
}

export async function putFollows(env: Env, m: Member, f: Follows): Promise<void> {
  await env.DB.put(`follows:${m.customer}`, JSON.stringify(f));
  // Followed investors are the alert targets whenever alerts is a list (not "all" or "off").
  if (Array.isArray(m.alerts)) await putMember(env, { ...m, alerts: f.investors });
}

export const MAX_FOLLOWS = 500;
export type FollowList = 'investors' | 'stocks' | 'owned';
export type FollowOp = { get: true } | { set: Partial<Follows> } | { add: { list: FollowList; value: string } } | { remove: { list: FollowList; value: string } };

/** One change to a member's follows. Owned stocks are always on the watchlist. */
export function applyFollowOp(cur: Follows, op: FollowOp): Follows | string {
  const next: Follows = { ...cur, investors: [...cur.investors], stocks: [...cur.stocks], owned: [...cur.owned] };
  if ('get' in op) return next;
  if ('set' in op) Object.assign(next, op.set);
  else if ('add' in op) {
    const { list, value } = op.add;
    if (!next[list].includes(value)) next[list].push(value);
  } else {
    const { list, value } = op.remove;
    next[list] = next[list].filter((x) => x !== value);
    if (list === 'stocks') next.owned = next.owned.filter((x) => x !== value);
  }
  next.stocks = [...new Set([...next.stocks, ...next.owned])];
  for (const k of ['investors', 'stocks', 'owned'] as const) if (next[k].length > MAX_FOLLOWS) return `at most ${MAX_FOLLOWS} ${k}`;
  return next;
}

export interface FollowsNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> };
}

/**
 * Applies a follows change for one member, serialized: two clicks a second apart (Follow Durable,
 * then Follow Altimeter) must both land. KV has no compare-and-swap, so every write goes through
 * this member's Durable Object, which keeps the authoritative copy in its own storage and writes it
 * through to KV for the alert jobs.
 */
export async function changeFollows(env: Env, m: Member, op: FollowOp): Promise<{ ok: true; follows: Follows; member: Member } | { ok: false; error: string }> {
  const stub = env.FOLLOWS.get(env.FOLLOWS.idFromName(m.customer));
  return (await stub.fetch('https://follows/apply', { method: 'POST', body: JSON.stringify({ member: m, op }) })).json();
}

interface FollowsStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export class MemberFollows {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private state: { storage: FollowsStorage },
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const { member, op } = (await req.json()) as { member: Member; op: FollowOp };
    // One change at a time, even across the awaits on KV.
    const run = this.chain.then(() => this.apply(member, op));
    this.chain = run.catch(() => undefined);
    return Response.json(await run);
  }

  private async apply(m: Member, op: FollowOp) {
    const cur = (await this.state.storage.get<Follows>('follows')) ?? (await getFollows(this.env, m));
    const next = applyFollowOp({ ...FOLLOW_DEFAULTS, ...cur }, op);
    if (typeof next === 'string') return { ok: false, error: next };
    if ('get' in op) return { ok: true, follows: next, member: m };
    // Saving follows without ever choosing an alert scope means "alert me on these funds".
    const member = m.alerts === 'all' && !m.alerts_chosen && next.investors.length ? { ...m, alerts: next.investors } : m;
    await this.state.storage.put('follows', next);
    await putFollows(this.env, member, next);
    return { ok: true, follows: next, member: Array.isArray(member.alerts) ? { ...member, alerts: next.investors } : member };
  }
}
