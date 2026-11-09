import { holdtermLoginMail, loginMail, sendMail } from './email';
import { isActive, type Env, type Member } from './env';
import { stripe } from './stripe';
import { carryFreeSignup } from './free';
import { countTransition, maybeCancelMail, maybeWinback } from './revenue';
import { noteReferral } from './referrals';
import { mirrorSeats } from './seats';
import { signToken } from './tokens';

export const LOGIN_TTL = 7 * 24 * 3600;
export const SESSION_TTL = 30 * 24 * 3600;

export async function getMember(env: Env, customer: string): Promise<Member | null> {
  const raw = await env.DB.get(`cus:${customer}`);
  if (!raw) return null;
  const m = JSON.parse(raw) as Member & { plan: string };
  // Records from before Copy Pro kept the billing interval in `plan`.
  if (m.plan !== 'copy' && m.plan !== 'pro' && m.plan !== 'fund' && m.plan !== 'holdterm' && m.plan !== 'free') return { ...m, interval: m.plan as Member['interval'], plan: 'copy' };
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isComped(sub: any): boolean {
  if (sub?.metadata?.test_member === 'true' || sub?.metadata?.copybook === 'smoke') return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coupons = [sub?.discount?.coupon, ...((sub?.discounts ?? []) as any[]).map((d) => d?.coupon)].filter((c) => c && typeof c === 'object');
  return coupons.some((c) => c.percent_off === 100 && c.duration === 'forever');
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
    // Keep what we track per member (alert scope, lifecycle emails); the subscription fields below are Stripe's.
    ...(prev ?? {}),
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
    // Comped: a forever 100%-off coupon or a test member (critics). No revenue email goes to them.
    comped: isComped(sub),
    // Set by a cancel in the billing portal: still active until period_end, then it ends.
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    cancel_at: Number(sub.cancel_at ?? 0) || null,
    // Set at checkout (POST /checkout): the referral code and where the subscriber came from.
    referred_by: prev?.referred_by ?? (typeof sub.metadata?.ref === 'string' ? sub.metadata.ref : null),
    source: prev?.source ?? (typeof sub.metadata?.source === 'string' ? sub.metadata.source : undefined),
  };
  // A stale event (older subscription) must not overwrite a newer active one.
  if (prev && prev.subscription !== m.subscription && isActive(prev) && !isActive(m)) return prev;
  // A free signup subscribing: the paid member keeps where they came from.
  if (!prev) Object.assign(m, await carryFreeSignup(env, m), { created_at: m.created_at ?? new Date().toISOString() });
  // Checkout fires several events at once (session completed, subscription created, the return to
  // /session); only the one that claims the welcome sends it.
  if (isActive(m) && !m.welcomed && m.email && (await claim(env, customer, 'welcome', true))) {
    const token = await signToken(env.SESSION_SECRET, 'login', customer, LOGIN_TTL);
    // Only a delivered welcome counts; otherwise the claim is released and the next event retries it.
    // Holdterm's welcome comes from Holdterm, never Copybook.
    const welcome = m.plan === 'holdterm' ? holdtermLoginMail(env, m.email, token, true) : loginMail(env, m.email, token, true, m);
    m.welcomed = (await sendMail(env, [welcome])) === '200';
    if (!m.welcomed) await claim(env, customer, 'welcome', false);
  }
  await maybeCancelMail(env, prev, m);
  await maybeWinback(env, prev, m);
  await countTransition(env, prev, m);
  if (m.referred_by && !prev?.referred_by) await noteReferral(env, m);
  await putMember(env, m);
  await mirrorSeats(env, m);
  return m;
}

export function publicView(m: Member) {
  // A Fund seat: billing belongs to the owner, so the site hides the portal for seats.
  return { email: m.email, status: m.status, active: isActive(m), plan: m.plan, interval: m.interval, trial_end: m.trial_end ?? null, period_end: m.period_end, cancel_at_period_end: m.cancel_at_period_end ?? false, cancel_at: m.cancel_at ?? null, alerts: m.alerts, seat: Boolean(m.seat_of) };
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
  /** Funds the member benchmarks against (any 13F filer's slug); shared across a Fund team. */
  peers: string[];
  /** Owned stocks the member added by hand (list, CSV, Follow). `owned` is these plus the linked book's tickers. */
  owned_manual?: string[];
  /** Owned stocks imported from a 13F filer's book, refreshed when it files a new quarter. */
  book?: { cik: string; name: string; quarter: string; tickers: string[] } | null;
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

/** What a Fund team shares: the seats read and write the owner's lists; alert settings stay per seat. */
const SHARED = ['investors', 'stocks', 'owned', 'owned_manual', 'peers', 'book', 'onboarded'] as const;
const sharedOf = (f: Follows) => Object.fromEntries(SHARED.map((k) => [k, f[k]])) as Pick<Follows, (typeof SHARED)[number]>;

export async function getFollows(env: Env, m: Member): Promise<Follows> {
  if (m.seat_of) return { ...(await ownFollows(env, m)), ...sharedOf(await ownFollows(env, { ...m, customer: m.seat_of, seat_of: undefined, alerts: [] })) };
  return ownFollows(env, m);
}

async function ownFollows(env: Env, m: Member): Promise<Follows> {
  const raw = await env.DB.get(`follows:${m.customer}`);
  if (raw) return { peers: [], ...FOLLOW_DEFAULTS, ...(JSON.parse(raw) as Partial<Follows>) } as Follows;
  // First read: seed from the follows the site kept in member.alerts before /follows existed.
  const seeded: Follows = { investors: Array.isArray(m.alerts) ? m.alerts : [], stocks: [], owned: [], peers: [], onboarded: false, ...FOLLOW_DEFAULTS };
  await env.DB.put(`follows:${m.customer}`, JSON.stringify(seeded));
  return seeded;
}

export async function putFollows(env: Env, m: Member, f: Follows): Promise<void> {
  await env.DB.put(`follows:${m.customer}`, JSON.stringify(f));
  // Followed investors are the alert targets whenever alerts is a list (not "all" or "off"). A seat's
  // investors are the owner's, read at alert time, so its own record is left alone.
  if (Array.isArray(m.alerts) && !m.seat_of) await putMember(env, { ...m, alerts: f.investors });
}

export const MAX_FOLLOWS = 500;
export type FollowList = 'investors' | 'stocks' | 'owned' | 'peers';
/** `max` on an add caps that list (a free account's 5 owned names), checked inside the member's object so concurrent adds can't pass it. */
export type FollowOp = { get: true } | { set: Partial<Follows> } | { add: { list: FollowList; value: string; max?: number } } | { remove: { list: FollowList; value: string } };

/** Hand-added owned names; records from before `owned_manual` count every owned name outside the linked book. */
export const manualOf = (f: Pick<Follows, 'owned' | 'owned_manual' | 'book'>) => f.owned_manual ?? f.owned.filter((t) => !(f.book?.tickers ?? []).includes(t));

/** One change to a member's follows. Owned stocks are always on the watchlist. */
export function applyFollowOp(cur: Follows, op: FollowOp): Follows | string {
  const next: Follows = { ...cur, investors: [...cur.investors], stocks: [...cur.stocks], owned: [...cur.owned], peers: [...(cur.peers ?? [])] };
  if ('get' in op) return next;
  let manual = manualOf(cur);
  if ('set' in op) {
    Object.assign(next, op.set);
    // A whole owned list (PUT /follows): names outside the linked book, or already hand-added, are hand-added.
    if (op.set.owned_manual) manual = op.set.owned_manual;
    else if (op.set.owned) manual = op.set.owned.filter((t) => manual.includes(t) || !(next.book?.tickers ?? []).includes(t));
  } else if ('add' in op) {
    const { list, value, max } = op.add;
    if (max !== undefined && !next[list].includes(value) && next[list].length >= max) return `limit:${max}`;
    if (!next[list].includes(value)) next[list].push(value);
    if (list === 'owned' && !manual.includes(value)) manual = [...manual, value];
  } else {
    const { list, value } = op.remove;
    next[list] = next[list].filter((x) => x !== value);
    if (list === 'stocks') next.owned = next.owned.filter((x) => x !== value);
    if (list === 'stocks' || list === 'owned') manual = manual.filter((x) => x !== value);
  }
  next.owned_manual = manual;
  next.stocks = [...new Set([...next.stocks, ...next.owned])];
  for (const k of ['investors', 'stocks', 'owned', 'peers'] as const) if (next[k].length > MAX_FOLLOWS) return `at most ${MAX_FOLLOWS} ${k}`;
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
  if (!m.seat_of) return viaObject(env, m, op);
  // A Fund seat: list changes go to the owner's object (shared by the team), settings to the seat's own.
  const owner = await getMember(env, m.seat_of);
  if (!owner) return { ok: false, error: 'this seat is no longer part of a team' };
  const isShared = (k: string) => (SHARED as readonly string[]).includes(k);
  const listOp: FollowOp = 'set' in op ? { set: Object.fromEntries(Object.entries(op.set).filter(([k]) => isShared(k))) } : 'get' in op ? op : op;
  const ownOp: FollowOp = 'set' in op ? { set: Object.fromEntries(Object.entries(op.set).filter(([k]) => !isShared(k))) } : { get: true };
  const team = await viaObject(env, owner, 'set' in listOp && !Object.keys(listOp.set).length ? { get: true } : listOp);
  if (!team.ok) return team;
  const own = await viaObject(env, m, 'set' in ownOp && !Object.keys(ownOp.set).length ? { get: true } : ownOp);
  if (!own.ok) return own;
  return { ok: true, follows: { ...own.follows, ...sharedOf(team.follows) }, member: m };
}

async function viaObject(env: Env, m: Member, op: FollowOp): Promise<{ ok: true; follows: Follows; member: Member } | { ok: false; error: string }> {
  const stub = env.FOLLOWS.get(env.FOLLOWS.idFromName(m.customer));
  return (await stub.fetch('https://follows/apply', { method: 'POST', body: JSON.stringify({ member: m, op }) })).json();
}

/** Claims (or releases) a once-per-customer action such as the welcome email; true only for the first claim. */
export async function claim(env: Env, customer: string, name: string, take: boolean): Promise<boolean> {
  const stub = env.FOLLOWS.get(env.FOLLOWS.idFromName(customer));
  return ((await (await stub.fetch('https://follows/claim', { method: 'POST', body: JSON.stringify({ claim: name, take }) })).json()) as { first: boolean }).first;
}

interface FollowsStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class MemberFollows {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private state: { storage: FollowsStorage },
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const b = (await req.json()) as { member: Member; op: FollowOp } | { claim: string; take: boolean };
    // One change at a time, even across the awaits on KV.
    const run = this.chain.then((): Promise<unknown> => ('claim' in b ? this.claim(b.claim, b.take) : this.apply(b.member, b.op)));
    this.chain = run.catch(() => undefined);
    return Response.json(await run);
  }

  private async claim(name: string, take: boolean) {
    const key = `claim:${name}`;
    if (!take) return { first: await this.state.storage.delete(key) };
    if (await this.state.storage.get(key)) return { first: false };
    await this.state.storage.put(key, Date.now());
    return { first: true };
  }

  private async apply(m: Member, op: FollowOp) {
    const cur = (await this.state.storage.get<Follows>('follows')) ?? (await ownFollows(this.env, m));
    const next = applyFollowOp({ ...FOLLOW_DEFAULTS, ...cur }, op);
    if (typeof next === 'string') return { ok: false, error: next };
    if ('get' in op) return { ok: true, follows: next, member: m };
    // Saving follows without ever choosing an alert scope means "alert me on these funds".
    const member = m.alerts === 'all' && !m.alerts_chosen && !m.seat_of && next.investors.length ? { ...m, alerts: next.investors } : m;
    await this.state.storage.put('follows', next);
    await putFollows(this.env, member, next);
    return { ok: true, follows: next, member: Array.isArray(member.alerts) ? { ...member, alerts: next.investors } : member };
  }
}
