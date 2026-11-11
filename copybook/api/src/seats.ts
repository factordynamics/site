import { seatInviteMail, sendMail } from './email';
import { testAddress } from './env';
import { isActive, type Env, type Member } from './env';
import { getMember, LOGIN_TTL, putMember } from './members';
import { signToken } from './tokens';

/**
 * Copy Fund seats. The owner (the Stripe customer) invites up to SEAT_LIMIT teammates by email.
 * Each seat is its own member record (cus:seat_...), with its own sign-in link, API keys, channels
 * and alert settings; the followed investors, watchlist, owned book and peer list are the owner's,
 * shared by every seat (see getFollows and changeFollows). A seat's status mirrors the owner's
 * subscription, so a cancelled or unpaid Fund turns every seat off with it.
 */
export const SEAT_LIMIT = 10;

export interface Seat {
  id: string;
  email: string;
  invited_at: string;
}

async function seatId(owner: string, email: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email)));
  return `seat_${owner.replace(/^cus_/, '')}_${[...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function listSeats(env: Env, owner: string): Promise<Seat[]> {
  return JSON.parse((await env.DB.get(`seats:${owner}`)) ?? '[]') as Seat[];
}

/** The seat's member record, following the owner's subscription. */
function mirror(owner: Member, seat: Seat, prev?: Member | null): Member {
  return {
    customer: seat.id,
    email: seat.email,
    // An owner paused for an unpaid invoice pauses every seat.
    status: owner.plan === 'fund' ? (owner.overdue_since ? 'unpaid' : owner.status) : 'canceled',
    plan: 'fund',
    interval: owner.interval,
    period_end: owner.period_end,
    subscription: owner.subscription,
    cancel_at_period_end: owner.cancel_at_period_end ?? false,
    cancel_at: owner.cancel_at ?? null,
    paused_until: owner.paused_until ?? null,
    // Seats alert on the shared follows unless they choose otherwise.
    alerts: prev?.alerts ?? [],
    alerts_chosen: prev?.alerts_chosen,
    welcomed: true,
    seat_of: owner.customer,
    ...(prev?.sessions_after ? { sessions_after: prev.sessions_after } : {}),
  };
}

/**
 * The owner signs a seat out everywhere: its sessions issued until now stop working and its API keys are revoked
 * (a departing colleague keeps no access). It can sign in again by email and make new keys while still a seat.
 */
export async function revokeSeatSessions(env: Env, owner: Member, raw: string, now = Date.now()): Promise<boolean> {
  const seat = (await listSeats(env, owner.customer)).find((s) => s.email === raw.trim().toLowerCase());
  const m = seat ? await getMember(env, seat.id) : null;
  if (!m) return false;
  await putMember(env, { ...m, sessions_after: Math.floor(now / 1000) });
  await (await import('./keys')).revokeAll(env, m.customer);
  return true;
}

export async function inviteSeat(env: Env, owner: Member, raw: string): Promise<{ ok: true; seat: Seat } | { ok: false; status: number; error: string; code: string }> {
  const email = raw.trim().toLowerCase();
  const seats = await listSeats(env, owner.customer);
  if (email === owner.email.toLowerCase() || seats.some((s) => s.email === email)) return { ok: false, status: 409, error: 'already on this team', code: 'seat_exists' };
  if (seats.length >= SEAT_LIMIT) return { ok: false, status: 409, error: `at most ${SEAT_LIMIT} seats; remove one first`, code: 'seat_limit' };
  if (await env.DB.get(`email:${email}`)) return { ok: false, status: 409, error: 'that email already has a Copybook account; use another address or cancel that account first', code: 'email_taken' };
  const seat: Seat = { id: await seatId(owner.customer, email), email, invited_at: new Date().toISOString() };
  await env.DB.put(`seats:${owner.customer}`, JSON.stringify([...seats, seat]));
  // A seat's id follows from the email, so a re-invited address gets the old id: it starts empty, and every session
  // issued before this invite (a removed colleague's copied one) stays refused. It signs in fresh from the invite.
  const gone = Number((await env.DB.get(`seatgone:${seat.id}`)) ?? 0);
  await putMember(env, { ...mirror(owner, seat), ...(gone ? { sessions_after: gone } : {}) });
  const token = await signToken(env.SESSION_SECRET, 'login', seat.id, LOGIN_TTL);
  // A test team's seats (the owner is a test address) get their mail in the sink, keyed by the seat's address.
  await sendMail(env, [{ ...seatInviteMail(env, email, owner.email, token), ...(testAddress(owner.email) ? { test: true } : {}) }]);
  return { ok: true, seat };
}

export async function removeSeat(env: Env, owner: Member, raw: string): Promise<boolean> {
  const email = raw.trim().toLowerCase();
  const seats = await listSeats(env, owner.customer);
  const seat = seats.find((s) => s.email === email);
  if (!seat) return false;
  await env.DB.put(`seats:${owner.customer}`, JSON.stringify(seats.filter((s) => s !== seat)));
  // Removal ends access as revoke does: every API key the seat made is deleted and its private feed stops; its
  // sessions die with its member record (and stay refused if the address is invited again, see inviteSeat).
  await (await import('./keys')).revokeAll(env, seat.id);
  // Kept past any session's life: a re-invite refuses every session and sign-in link issued up to now.
  await env.DB.put(`seatgone:${seat.id}`, String(Math.floor(Date.now() / 1000)), { expirationTtl: 40 * 86400 });
  const ch = JSON.parse((await env.DB.get(`channels:${seat.id}`)) ?? '{}') as { feed_token?: string };
  if (ch.feed_token) await env.DB.delete(`feedtok:${ch.feed_token}`);
  for (const k of [`cus:${seat.id}`, `email:${email}`, `follows:${seat.id}`, `channels:${seat.id}`, `chfail:${seat.id}`, `feed:${seat.id}`]) await env.DB.delete(k);
  return true;
}

/** After the owner's subscription changes: every seat takes its status, plan end and cancel state. */
export async function mirrorSeats(env: Env, owner: Member): Promise<void> {
  for (const seat of await listSeats(env, owner.customer)) {
    const prev = await getMember(env, seat.id);
    const next = mirror(owner, seat, prev);
    if (!prev || prev.status !== next.status || prev.period_end !== next.period_end || prev.cancel_at_period_end !== next.cancel_at_period_end) await putMember(env, next);
  }
}

export function seatsView(owner: Member, seats: Seat[]) {
  return { max: SEAT_LIMIT, active: isActive(owner) && owner.plan === 'fund', seats: seats.map(({ email, invited_at }) => ({ email, invited_at })), revoke_available: true };
}
