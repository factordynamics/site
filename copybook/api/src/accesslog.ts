import { isActive, maskEmail, type Env, type Member } from './env';

/**
 * The access log: a Fund owner's Team access (GET /team/access) and every member's "Access to your account"
 * (GET /me/access). Sign-ins (time and country from Cloudflare, never an IP), API keys made and deleted, seat invites,
 * revokes and removals, alert channel and webhook changes, CSV and bulk downloads, and every operator read or change
 * of the member's data with its reason. Append-only (no route edits or deletes an entry); kept a year, shown 90 days;
 * erased with the member.
 *   acl:{customer}       -> AccessEvent[] (oldest first)
 *   seatsgone:{owner}    -> removed seats, for the owner's list
 */
export type AccessKind =
  | 'invite'
  | 'sign_in'
  | 'key_created'
  | 'key_deleted'
  | 'revoke'
  | 'removal'
  | 'channel_change'
  | 'webhook_change'
  | 'csv_download'
  | 'bulk_download'
  | 'operator';

export interface AccessEvent {
  at: string;
  kind: AccessKind;
  /** Who acted: the member, their Fund owner, or the operator. */
  by: 'self' | 'owner' | 'operator';
  /** Two-letter country from Cloudflare; null when unknown. Never an IP. */
  country: string | null;
  /** What: the channel changed, the file downloaded, the operator route. */
  detail?: string;
  key?: { id: string; name: string };
  /** Operator entries: why. */
  reason?: string;
}

const DAY = 86_400_000;
export const KEEP_DAYS = 365;
export const SHOWN_DAYS = 90;
const MAX_EVENTS = 5000;
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The caller's country: the Worker's (forwarded with the proxy proof), else Cloudflare's header on the live host. */
export function countryOf(req: Request | null | undefined): string | null {
  const c = (req?.headers.get('x-copybook-country') ?? req?.headers.get('cf-ipcountry') ?? (req as { cf?: { country?: string } } | undefined)?.cf?.country ?? '').toUpperCase();
  return /^[A-Z][A-Z0-9]$/.test(c) && c !== 'XX' ? c : null;
}

/** Appends one event to a member's log (and drops what is past a year). */
export async function logEvent(env: Env, customer: string | null | undefined, e: Omit<AccessEvent, 'at' | 'country'> & { at?: string }, req?: Request | null, now = Date.now()): Promise<void> {
  if (!customer) return;
  const k = `acl:${customer}`;
  const log = JSON.parse((await env.DB.get(k)) ?? '[]') as AccessEvent[];
  const kept = log.filter((x) => now - Date.parse(x.at) < KEEP_DAYS * DAY).slice(-(MAX_EVENTS - 1));
  const { at, ...rest } = e;
  kept.push({ at: at ?? iso(now), country: countryOf(req), ...rest });
  await env.DB.put(k, JSON.stringify(kept));
}

/** A member's events of the last 90 days, newest first. */
export async function recentEvents(env: Env, customer: string, now = Date.now()): Promise<AccessEvent[]> {
  const log = JSON.parse((await env.DB.get(`acl:${customer}`)) ?? '[]') as AccessEvent[];
  return log.filter((x) => now - Date.parse(x.at) < SHOWN_DAYS * DAY).reverse();
}

/** A removed seat, kept for the owner's list (its own events stay under acl:{id}). */
export async function noteSeatRemoved(env: Env, owner: string, seat: { id: string; email: string; invited_at: string }, now = Date.now()): Promise<void> {
  const k = `seatsgone:${owner}`;
  const list = (JSON.parse((await env.DB.get(k)) ?? '[]') as { id: string; email: string; invited_at: string; removed_at: string }[]).filter((s) => s.id !== seat.id);
  await env.DB.put(k, JSON.stringify([...list, { ...seat, removed_at: iso(now) }].slice(-50)));
}

type KeyView = { id: string; name: string; prefix: string; created: string; last_used_at: string | null };

async function keysOf(env: Env, customer: string): Promise<KeyView[]> {
  const { listKeys, meter } = await import('./keys');
  const out: KeyView[] = [];
  for (const k of await listKeys(env, customer)) {
    const u = await meter(env, k.id).usage(90);
    out.push({ id: k.id, name: k.name, prefix: k.prefix, created: k.created, last_used_at: u.last_used_at ?? null });
  }
  return out;
}

const latest = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;

/** GET /me/access: the member's own sign-ins, keys (with last use), changes and downloads, and any operator access. */
export async function meAccess(env: Env, m: Member, now = Date.now()) {
  const events = await recentEvents(env, m.customer, now);
  const keys = await keysOf(env, m.customer);
  return {
    shown_days: SHOWN_DAYS,
    last_sign_in: events.find((e) => e.kind === 'sign_in')?.at ?? null,
    last_api_use: latest(keys.map((k) => k.last_used_at)),
    keys,
    events,
    operator: events.filter((e) => e.by === 'operator'),
  };
}

type SeatRow = { email: string; role: 'owner' | 'seat'; status: 'owner' | 'invited' | 'active' | 'revoked' | 'removed'; invited_at: string | null; removed_at: string | null; last_sign_in: string | null; last_api_use: string | null; key_count: number; keys: KeyView[] };
export type TeamEvent = AccessEvent & { seat: string };

/** GET /team/access (Fund owner): every seat with status, last sign-in, last API use and keys; the team's events. */
export async function teamAccess(env: Env, owner: Member, filter: string | null, now = Date.now()): Promise<{ shown_days: number; seats: SeatRow[]; events: TeamEvent[] }> {
  const { listSeats } = await import('./seats');
  const { getMember } = await import('./members');
  const seats = await listSeats(env, owner.customer);
  const gone = JSON.parse((await env.DB.get(`seatsgone:${owner.customer}`)) ?? '[]') as { id: string; email: string; invited_at: string; removed_at: string }[];
  const rows: SeatRow[] = [];
  const events: TeamEvent[] = [];
  const add = async (id: string, email: string, role: 'owner' | 'seat', invited_at: string | null, removed_at: string | null) => {
    const ev = await recentEvents(env, id, now);
    const keys = removed_at ? [] : await keysOf(env, id);
    const signIn = ev.find((e) => e.kind === 'sign_in')?.at ?? null;
    let status: SeatRow['status'] = role === 'owner' ? 'owner' : removed_at ? 'removed' : signIn ? 'active' : 'invited';
    if (status === 'active' || status === 'invited') {
      // Signed out everywhere by the owner, and not signed in since.
      const sm = await getMember(env, id);
      if (sm?.sessions_after && (!signIn || Date.parse(signIn) < sm.sessions_after * 1000) && ev.some((e) => e.kind === 'revoke')) status = 'revoked';
    }
    rows.push({ email, role, status, invited_at, removed_at, last_sign_in: signIn, last_api_use: latest(keys.map((k) => k.last_used_at)), key_count: keys.length, keys });
    for (const e of ev) events.push({ ...e, seat: email });
  };
  await add(owner.customer, owner.email, 'owner', null, null);
  for (const s of seats) await add(s.id, s.email, 'seat', s.invited_at, null);
  for (const s of gone) if (!seats.some((x) => x.id === s.id)) await add(s.id, s.email, 'seat', s.invited_at, s.removed_at);
  const want = filter?.trim().toLowerCase() || null;
  return {
    shown_days: SHOWN_DAYS,
    seats: want ? rows.filter((r) => r.email === want) : rows,
    events: events.filter((e) => !want || e.seat === want).sort((a, b) => b.at.localeCompare(a.at)),
  };
}

/** The team's events as CSV (one row per event). */
export function teamCsv(events: TeamEvent[]): string {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
  };
  const head = ['at', 'seat', 'kind', 'by', 'country', 'detail', 'key_id', 'key_name', 'reason'];
  return [head.join(','), ...events.map((e) => [e.at, e.seat, e.kind, e.by, e.country, e.detail, e.key?.id, e.key?.name, e.reason].map(cell).join(','))].join('\n') + '\n';
}

/** Whether `m` may read its team's access: the Fund owner while the Fund is on. */
export const teamOwner = (m: Member) => m.plan === 'fund' && !m.seat_of && isActive(m);

export { maskEmail };
