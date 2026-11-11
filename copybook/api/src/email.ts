import type { Alert13F, AlertEvent } from './alerts';
import { siteFirm, siteName } from './names';
import { cleanItem4, countedMoves, exchangeLine, filingId, FILER_VALUE, posKey, UNUSUAL, type MoveRow, type Moves } from './edgar';
import { testAddress, WORKER_URL, type Env, type Member } from './env';
import type { Follows } from './members';
import { firmName, publicSlug } from '../../../holdterm/src/names';
import { htEmail, htLoginEmail, type HtEvent, type HtFiling } from '../../../holdterm/src/alert-render';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** The same content laid out as tables, for mail clients that show HTML. */
  html?: string;
  /** Sender, when not Copybook's (Holdterm). */
  from?: string;
  /** Where replies go, when not CONTACT_EMAIL (a request notice replies to the requester). */
  replyTo?: string;
  /** Marketing and lifecycle email: the one-click unsubscribe URL (List-Unsubscribe). */
  unsubscribe?: string;
  /** A test or critic member: sent after real members when the day's email budget runs low. */
  test?: boolean;
  /** A preview, replay or sample to a test inbox: counted against PREVIEW_DAILY_CAP. */
  preview?: boolean;
  /** Filings and events the email carries: a delayed send is excluded from the latency figures. */
  ids?: string[];
}

/** Sends through Resend's batch API (100 per request). Returns a short status for logs. */
/** Who may get a sample or preview (a template with illustrative figures): our inbox and the test inboxes only. */
export const previewInbox = (to: string) => to === 'hello@factordynamics.com' || to.startsWith('copybook-test-') || /^copybook-[a-z0-9-]+@fldubai\.com$/.test(to);
const SAMPLE = /^\[(sample|preview|draft)\]/i;

/**
 * Resend's free plan: 100 emails a day and 3,000 a month, account-wide. Send order once the budget runs low:
 * account mail (sign-in, receipts, pause, resume) always; alerts and digests up to the cap less a reserve,
 * real members before test members; low-priority mail (free weekly, recap, pre-season) only while 50 are left
 * for alerts. What doesn't fit is never dropped: it is queued and sent after the reset, marked as delayed.
 */
export const MAIL_DAILY_CAP = 100;
export const MAIL_MONTHLY_CAP = 3000;
export const MAIL_RESERVE = 15;
const LOW_HOLD = 50;
/** Weekends: what each provider keeps for account mail while the Friday email uses the rest. */
export const WEEKEND_RESERVE = 10;
export const isWeekend = (t: number) => [0, 6].includes(new Date(t).getUTCDay());
const DELAY_MARK = '(delayed: email limit) ';
/** Usage from Resend's x-resend-daily-quota and x-resend-monthly-quota headers (emails sent, account-wide). */
export const mailQuota: { day: string; used: number; month: string; monthly: number; delayed: number; mailgun: number; refused?: string; kinds?: MailKinds } = { day: '', used: 0, month: '', monthly: 0, delayed: 0, mailgun: 0 };
/** This host's sends today by kind (both providers): real members, test and critic members, account mail; `preview` (part of test) is previews, replays and samples. */
/** Sends by kind from `since` (this host's first counted send of the UTC day); used_at_since: Resend's day count then. */
export type MailKinds = { real: number; test: number; account: number; preview: number; since?: string; used_at_since?: number; dropped?: number; queued?: number; sinked?: number; dropped_why?: Record<string, number> };
/**
 * Every mail handed to sendMail ends in one counted state: sent (real, test or account above), queued (waiting for
 * Resend: the 00:00 UTC reset or the every-minute retry), sinked (a test inbox) or dropped (counted by reason).
 */
const kindsToday = () => (mailQuota.kinds ??= { real: 0, test: 0, account: 0, preview: 0, since: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), used_at_since: mailQuota.used });
function counted(what: 'queued' | 'sinked', n: number): void {
  if (n) kindsToday()[what] = (kindsToday()[what] ?? 0) + n;
}
function droppedFor(why: string, n: number): void {
  if (!n) return;
  const k = kindsToday();
  k.dropped = (k.dropped ?? 0) + n;
  (k.dropped_why ??= {})[why] = (k.dropped_why[why] ?? 0) + n;
  console.log(`email: ${n} dropped (${why})`);
}
/**
 * Test, preview and ops mail (notices to our own inbox) send only while Resend has more than this left today; past it
 * they are dropped (counted in kinds.dropped), never queued, so they can't take alert or account room (MAIL_RESERVE 15
 * for account mail, 35 for alerts).
 */
export const NONMEMBER_FLOOR = 50;
/**
 * One day's Resend count split so it adds up: before_since (sent before these counters started) + real + test + account
 * + other (counted by Resend after since but by no host's tally: another host's lost write, or another sender) = used.
 * Previews are a subset of test.
 */
export function kindsView(used: number, k: MailKinds | null | undefined) {
  const real = k?.real ?? 0, test = k?.test ?? 0, account = k?.account ?? 0;
  // Counters started without the day's count then (an older build): everything not tallied counts as before them.
  const before = k ? (k.used_at_since ?? Math.max(0, used - real - test - account)) : used;
  const outcomes = { queued: k?.queued ?? 0, sinked: k?.sinked ?? 0, dropped_not_sent: k?.dropped ?? 0, dropped_why: k?.dropped_why ?? {} };
  // Sums to used: before_since + real + test + account + other. `outcomes` is what never reached Resend (not in used);
  // its flat copies stay until Feb 2027.
  return { real, test, account, preview: k?.preview ?? 0, before_since: before, other: Math.max(0, used - before - real - test - account), since: k?.since ?? null, outcomes, ...outcomes };
}
/** Previews, replays and samples to test inboxes: at most this many a day; past it they wait for the reset. */
export const PREVIEW_DAILY_CAP = 10;
/** Mailgun's free plan, the overflow when MAILGUN_API_KEY is set: 100 a day, from the same address (factordynamics.com is verified there). */
export const MAILGUN_DAILY_CAP = 100;
const mailgunOn = (env: Env) => !!env.MAILGUN_API_KEY;
const mailgunRoom = (env: Env) => (mailgunOn(env) ? Math.max(0, MAILGUN_DAILY_CAP - mailQuota.mailgun) : 0);
/** What both providers can still send today (alerts' share): for the coalescing decision. */
export const alertRoomToday = (env: Env) => Math.max(0, Math.min(MAIL_DAILY_CAP - MAIL_RESERVE - mailQuota.used, MAIL_MONTHLY_CAP - MAIL_RESERVE - mailQuota.monthly)) + mailgunRoom(env);

/** One message through Mailgun's HTTP API. Returns the HTTP status. */
/** The List-Unsubscribe target: the Worker, which records the one-click POST even when gene is down. */
const oneClick = (u: string) => {
  const t = /\/unsubscribe\/?\?/.test(u) ? new URL(u).searchParams.get('t') : null;
  return t ? `${WORKER_URL}/unsubscribe?t=${encodeURIComponent(t)}` : u;
};

async function sendMailgun(env: Env, m: Mail): Promise<number> {
  const b = new URLSearchParams({ from: m.from ?? env.EMAIL_FROM, to: m.to, subject: m.subject, text: m.text });
  if (m.html) b.set('html', m.html);
  const reply = m.replyTo ?? env.CONTACT_EMAIL;
  if (reply) b.set('h:Reply-To', reply);
  if (m.unsubscribe) {
    b.set('h:List-Unsubscribe', `<${oneClick(m.unsubscribe)}>`);
    b.set('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
  }
  const base = (env.MAILGUN_BASE ?? 'https://api.mailgun.net').replace(/\/+$/, '');
  const res = await fetch(`${base}/v3/${env.MAILGUN_DOMAIN ?? 'factordynamics.com'}/messages`, { method: 'POST', headers: { Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}` }, body: b }).catch(() => null);
  if (res?.ok) mailQuota.mailgun++;
  else console.log(`mailgun ${res?.status ?? 'network'}`);
  return res?.status ?? 599;
}

/** Overflow to Mailgun, one by one while it has room; returns what it couldn't send. */
async function viaMailgun(env: Env, mails: Mail[], statuses: string[], reserve = 0, sent: (m: Mail) => void = () => {}): Promise<Mail[]> {
  const left: Mail[] = [];
  for (const m of mails) {
    if (mailgunRoom(env) <= reserve) {
      left.push(m);
      continue;
    }
    const st = await sendMailgun(env, m);
    if (st >= 200 && st < 300) {
      statuses.push('200');
      sent(m);
    } else {
      left.push(m);
      if (st === 429) mailQuota.mailgun = MAILGUN_DAILY_CAP; // its cap: stop trying today
    }
  }
  return left;
}
const RETRY = 'host:mail-retry';
const DELAYED = 'host:mail-delayed';
const METER = 'host:mail-meter';
export const DELAYED_IDS = 'host:mail-delayed-ids';
type Tier = 'account' | 'alert' | 'low';

async function loadMeter(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (mailQuota.day === today) return;
  const saved = JSON.parse((await env.DB.get(METER)) ?? 'null') as typeof mailQuota | null;
  const month = today.slice(0, 7);
  Object.assign(mailQuota, { day: today, used: saved?.day === today ? saved.used : 0, delayed: saved?.day === today ? saved.delayed : 0, mailgun: saved?.day === today ? (saved.mailgun ?? 0) : 0, kinds: saved?.day === today ? saved.kinds : undefined, month, monthly: saved?.month === month ? saved.monthly : 0, refused: undefined });
}

/** Alerts' room left today across Resend and (when configured) Mailgun. */
export async function mailRoom(env: Env): Promise<number> {
  await loadMeter(env);
  return alertRoomToday(env);
}

/** Mail that doesn't fit today's budget waits for the reset, marked; its filings aren't timed as fast. */
async function delay(env: Env, mails: Mail[]): Promise<void> {
  if (!mails.length) return;
  const today = new Date().toISOString().slice(0, 10);
  const q = JSON.parse((await env.DB.get(DELAYED)) ?? '[]') as (Mail & { day: string })[];
  const add = mails.map((m) => ({ ...m, subject: m.subject.startsWith(DELAY_MARK) ? m.subject : DELAY_MARK + m.subject, day: today }));
  await env.DB.put(DELAYED, JSON.stringify([...q, ...add].slice(-2000)));
  const ids = new Set(JSON.parse((await env.DB.get(DELAYED_IDS)) ?? '[]') as string[]);
  for (const m of mails) for (const id of m.ids ?? []) ids.add(id);
  await env.DB.put(DELAYED_IDS, JSON.stringify([...ids].slice(-500)));
  mailQuota.delayed += mails.length;
  counted('queued', mails.filter((m) => !m.subject.startsWith(DELAY_MARK)).length);
  console.log(`email limit: ${mails.length} delayed to after the reset`);
}

/** Launch week (Nov 11-16): test and preview mail never uses Resend or Mailgun quota; it goes to the test inbox sink. */
export const SINK_UNTIL = Date.parse('2026-11-17T00:00:00Z');
/** The cap rules in plain words, for /health, status.json and /status/. */
export const MAIL_POLICY =
  "Account emails (sign-in, welcome) are sent even past the alert cap, until Resend itself refuses them; then they go out after the 00:00 UTC reset. Alert emails over the cap wait until 00:00 UTC, marked delayed; chat, feed and webhook alerts go at once. Test and preview mail goes to a test inbox, not by email, through Nov 16.";
const isTestMail = (m: Mail) => !!m.preview || !!m.test || testAddress(m.to);
/** The sink's object for one address: unguessable (HMAC of the address), readable at PUBLIC_URL + this key. */
/** Each critic's aliases (copybook-test-<critic>-<anything>) share the critic's own test inbox. */
const CRITIC_INBOX: Record<string, string> = {
  trader: 'copybook-test-trader-f94afc@fldubai.com',
  retail: 'copybook-test-retail-b00e46@fldubai.com',
  analyst: 'copybook-test-pro-6dd05f@fldubai.com',
  quant: 'copybook-test-quant-362d85@fldubai.com',
  pm: 'copybook-test-pm-f5f4b5@fldubai.com',
};
export const sinkOwner = (to: string) => CRITIC_INBOX[to.toLowerCase().match(/^copybook-test-(trader|retail|analyst|quant|pm)-[^@]*@/)?.[1] ?? ''] ?? to.toLowerCase();
export async function sinkKey(env: Env, to: string): Promise<string> {
  const { hmacHex } = await import('./tokens');
  return `sink/${(await hmacHex(env.SESSION_SECRET, `sink:${sinkOwner(to)}`)).slice(0, 40)}.json`;
}
/** Stores test mail, newest first (40 kept per address), in the public bucket (both hosts write there), else KV. */
async function sinkMail(env: Env, mails: Mail[]): Promise<void> {
  const by = new Map<string, Mail[]>();
  // Keyed by inbox (a critic's aliases share theirs); each item names the address it was sent to.
  for (const m of mails) by.set(sinkOwner(m.to), [...(by.get(sinkOwner(m.to)) ?? []), m]);
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const [to, ms] of by) {
    const key = await sinkKey(env, to);
    const add = ms.map((m) => ({ at, to: m.to.toLowerCase(), subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }));
    const remote = !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.PUBLIC_BUCKET && env.PUBLIC_URL);
    try {
      const prev = remote
        ? ((await fetch(`${env.PUBLIC_URL}${key}?t=${Date.now()}`, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { items?: unknown[] } | null)
        : (JSON.parse((await env.DB.get(key)) ?? 'null') as { items?: unknown[] } | null);
      const body = JSON.stringify({ address: to, note: 'Copybook test inbox: mail to this test address during launch week (Nov 11-16), not sent by email.', items: [...add, ...(prev?.items ?? [])].slice(0, 40) });
      const put = remote
        ? await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${env.PUBLIC_BUCKET}/objects/${key}`, { method: 'PUT', headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json', 'cache-control': 'no-store' }, body, signal: AbortSignal.timeout(8000) })
        : null;
      // A failed bucket write keeps the mail in KV (GET /ops/test-inbox reads it there too), never silently lost.
      if (put && !put.ok) console.log(`sink: bucket PUT ${put.status}, kept in KV`);
      if (!put?.ok) await env.DB.put(key, body, { expirationTtl: 8 * 86400 });
    } catch (e) {
      console.log(`sink: ${String(e).slice(0, 120)}, kept in KV`);
      await env.DB.put(key, JSON.stringify({ address: to, items: add }), { expirationTtl: 8 * 86400 }).catch(() => {});
    }
  }
  console.log(`email: ${mails.length} test/preview to the sink, not sent`);
}

export async function sendMail(env: Env, mails: Mail[], opts: { bulk?: boolean; tier?: Tier; via?: 'mailgun'; preview?: boolean } = {}): Promise<string> {
  const tier: Tier = opts.tier ?? (opts.via ? 'low' : opts.bulk ? 'alert' : 'account');
  await loadMeter(env);
  if (opts.preview) mails = mails.map((m) => ({ ...m, preview: true }));
  // `since`: the first send counted today (Resend's `used` counts the whole UTC day, account-wide; these count from here).
  // Kinds an older build started without `since` (so they couldn't be read against `used`) start over here.
  if (mailQuota.kinds && (!mailQuota.kinds.since || mailQuota.kinds.used_at_since === undefined)) mailQuota.kinds = undefined;
  const kinds = kindsToday();
  // Launch week: test, critic and preview mail goes to the sink, never to a provider (Space ruling, Nov 11).
  if (env.TEST_MAIL_SINK !== 'off' && Date.now() < SINK_UNTIL) {
    const sunk = mails.filter(isTestMail);
    if (sunk.length) {
      await sinkMail(env, sunk);
      counted('sinked', sunk.length);
      mails = mails.filter((m) => !sunk.includes(m));
      if (!mails.length) {
        await env.DB.put(METER, JSON.stringify(mailQuota));
        return 'sunk';
      }
    }
  }
  const tally = (m: Mail) => {
    if (m.preview) kinds.preview++;
    kinds[m.preview || m.test || testAddress(m.to) ? 'test' : tier === 'account' ? 'account' : 'real']++;
  };
  // Previews, replays and samples past today's PREVIEW_DAILY_CAP wait for the reset.
  const previews = mails.filter((m) => m.preview);
  if (previews.length > Math.max(0, PREVIEW_DAILY_CAP - kinds.preview)) {
    const over = previews.slice(Math.max(0, PREVIEW_DAILY_CAP - kinds.preview));
    await delay(env, over);
    mails = mails.filter((m) => !over.includes(m));
    if (!mails.length) {
      await env.DB.put(METER, JSON.stringify(mailQuota));
      return 'delayed';
    }
  }
  // A sample never reaches a member's real address.
  const blocked = mails.filter((m) => SAMPLE.test(m.subject) && !previewInbox(m.to));
  droppedFor('sample_to_member', blocked.length);
  mails = mails.filter((m) => !blocked.includes(m));
  // Test, preview and ops mail first in line to go: past NONMEMBER_FLOOR left today, dropped. A test member's sign-in
  // and billing mail (account tier) still sends; a notice to our inbox doesn't.
  const ours = (m: Mail) => m.to === (env.CONTACT_EMAIL ?? 'hello@factordynamics.com') || m.to === 'hello@factordynamics.com';
  const nonMember = (m: Mail) => !!m.preview || ours(m) || (tier !== 'account' && (!!m.test || testAddress(m.to)));
  // Each provider keeps NONMEMBER_FLOOR for members: Resend's room above it, plus Mailgun's when it's configured.
  let spare = Math.max(0, MAIL_DAILY_CAP - NONMEMBER_FLOOR - mailQuota.used) + (mailgunOn(env) ? Math.max(0, MAILGUN_DAILY_CAP - NONMEMBER_FLOOR - mailQuota.mailgun) : 0);
  const dropped = mails.filter((m) => nonMember(m) && spare-- <= 0);
  if (dropped.length) {
    droppedFor('test_or_ops_past_floor', dropped.length);
    console.log(`email: ${dropped.length} test/preview/ops dropped (Resend ${mailQuota.used} of ${MAIL_DAILY_CAP} used; non-member mail stops at ${NONMEMBER_FLOOR} left)`);
    mails = mails.filter((m) => !dropped.includes(m));
    if (!mails.length) {
      await env.DB.put(METER, JSON.stringify(mailQuota));
      return 'dropped';
    }
  }
  if (!mails.length) return blocked.length ? 'blocked' : 'none';
  const statuses: string[] = [];
  const done = async () => {
    await env.DB.put(METER, JSON.stringify(mailQuota));
    await notice80(env);
    return statuses.join(',') || 'delayed';
  };
  // A one-off batch (Email 2): Mailgun while it has room for the day; the rest goes on as low-priority mail, so it
  // never takes the alerts' Resend hold (past that, it waits in the reset queue).
  if (opts.via === 'mailgun') {
    if (!mailgunOn(env)) {
      droppedFor('no_mailgun_key', mails.length);
      await env.DB.put(METER, JSON.stringify(mailQuota));
      return 'skipped (no MAILGUN_API_KEY)';
    }
    mails = await viaMailgun(env, mails, statuses, 0, tally);
    if (!mails.length) return done();
  }
  if (tier !== 'account') {
    // Saturday and Sunday (UTC) EDGAR accepts nothing: low-priority mail (the Friday email) may use both providers'
    // day but WEEKEND_RESERVE each, kept for account mail. Weekdays keep LOW_HOLD of Resend for alerts, no Mailgun.
    const wk = tier === 'low' && isWeekend(Date.now());
    const hold = wk ? WEEKEND_RESERVE : MAIL_RESERVE + (tier === 'low' ? LOW_HOLD : 0);
    const room = Math.max(0, Math.min(MAIL_DAILY_CAP - hold - mailQuota.used, MAIL_MONTHLY_CAP - MAIL_RESERVE - mailQuota.monthly));
    if (mails.length > room) {
      const order = [...mails.filter((m) => !m.test), ...mails.filter((m) => m.test)];
      // Past Resend's share: Mailgun (when configured) for alerts and weekend low-priority mail, then the reset queue.
      const over = order.slice(room);
      await delay(env, tier === 'alert' || wk ? await viaMailgun(env, over, statuses, wk ? WEEKEND_RESERVE : 0, tally) : over);
      mails = order.slice(0, room);
      if (!mails.length) return done();
    }
  }
  if (!env.RESEND_API_KEY) {
    droppedFor('no_resend_key', mails.length);
    await env.DB.put(METER, JSON.stringify(mailQuota));
    return 'skipped';
  }
  for (let i = 0; i < mails.length; i += 100) {
    const batch = mails.slice(i, i + 100).map((m) => ({ from: m.from ?? env.EMAIL_FROM, to: [m.to], subject: m.subject, text: m.text, ...((m.replyTo ?? env.CONTACT_EMAIL) ? { reply_to: m.replyTo ?? env.CONTACT_EMAIL } : {}), ...(m.html ? { html: m.html } : {}), ...(m.unsubscribe ? { headers: { 'List-Unsubscribe': `<${oneClick(m.unsubscribe)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}) }));
    // A network failure is an outage: the mail waits like a 5xx, never lost with a thrown error.
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    }).catch((e) => {
      console.log(`resend fetch failed: ${String(e).slice(0, 80)}`);
      return new Response('{"name":"network_error"}', { status: 503 });
    });
    // Resend's error can quote an address: the log keeps its error name only.
    if (res.headers.has('x-resend-daily-quota')) mailQuota.used = Number(res.headers.get('x-resend-daily-quota'));
    else if (res.ok) mailQuota.used += batch.length;
    if (res.headers.has('x-resend-monthly-quota')) mailQuota.monthly = Number(res.headers.get('x-resend-monthly-quota'));
    else if (res.ok) mailQuota.monthly += batch.length;
    if (!res.ok) {
      const name = ((await res.json().catch(() => ({}))) as { name?: string }).name ?? 'error';
      console.log(`resend ${res.status}: ${name}`);
      mailQuota.refused = `${new Date().toISOString()} ${res.status} ${name}`;
      // Refused by Resend (its cap, a rate limit, an outage): Mailgun if configured; then alerts wait for the
      // reset (marked delayed) and account mail retries every minute.
      const refused = res.status === 429 || res.status >= 500 ? await viaMailgun(env, tier === 'low' ? [] : mails.slice(i, i + 100), statuses, 0, tally) : [];
      const rest = tier === 'low' ? mails.slice(i, i + 100) : refused;
      if (tier !== 'account' && res.status === 429) await delay(env, rest);
      else if (rest.length && (res.status === 429 || res.status >= 500)) {
        const q = JSON.parse((await env.DB.get(RETRY)) ?? '[]') as (Mail & { first: string })[];
        await env.DB.put(RETRY, JSON.stringify([...q, ...rest.map((m) => ({ ...m, first: (m as { first?: string }).first ?? new Date().toISOString() }))].slice(-200)));
        // A retry refused again is the same mail, already counted.
        counted('queued', rest.filter((m) => !(m as { first?: string }).first).length);
      }
      // Any other refusal (a 4xx: a bad address, a rejected sender) won't succeed on a retry: dropped, with Resend's reason.
      if (res.status < 429 || (res.status > 429 && res.status < 500)) droppedFor(`resend_${res.status}_${name}`, mails.slice(i, i + 100).length);
      if (rest.length || res.status < 429) statuses.push(String(res.status));
      continue;
    }
    mails.slice(i, i + 100).forEach(tally);
    statuses.push(String(res.status));
  }
  return done();
}

/** Once a day (and once a month) at 80% of the free plan's cap: a note to hello@. */
async function notice80(env: Env): Promise<void> {
  const day = mailQuota.used >= MAIL_DAILY_CAP * 0.8 ? `day ${mailQuota.day}` : null;
  const month = mailQuota.monthly >= MAIL_MONTHLY_CAP * 0.8 ? `month ${mailQuota.month}` : null;
  for (const what of [day, month]) {
    if (!what) continue;
    const k = `host:mail80:${what}`;
    if (await env.DB.get(k)) continue;
    await env.DB.put(k, '1', { expirationTtl: 40 * 86400 });
    const [used, cap] = what.startsWith('day') ? [mailQuota.used, MAIL_DAILY_CAP] : [mailQuota.monthly, MAIL_MONTHLY_CAP];
    await sendMail(env, [{ to: env.CONTACT_EMAIL ?? 'hello@factordynamics.com', subject: `Copybook: ${Math.round((used / cap) * 100)}% of this ${what.split(' ')[0]}'s email sends used (${used} of ${cap})`, text: `Resend's free plan: ${used} of ${cap} emails sent this ${what}. Past ${cap - MAIL_RESERVE}, alerts are queued and sent after the reset, marked "(delayed: email limit)"; chat, feed and webhook alerts still go out at once. Sign-in, receipts, pause and resume always go out.` }]);
  }
}

/** Every minute: account mail Resend refused goes out once it accepts again (kept 2 days); after the daily reset, the delayed queue. */
export async function retryMail(env: Env): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const today = new Date().toISOString().slice(0, 10);
  const waiting = JSON.parse((await env.DB.get(DELAYED)) ?? '[]') as (Mail & { day: string })[];
  const due = waiting.filter((m) => m.day < today);
  if (due.length) {
    await env.DB.put(DELAYED, JSON.stringify(waiting.filter((m) => m.day >= today)));
    // What still doesn't fit goes back on the queue (sendMail does that) for the next reset.
    out.mail_delayed = { n: due.length, status: await sendMail(env, due.map(({ day: _d, ...m }) => m), { tier: 'alert' }) };
  }
  const raw = await env.DB.get(RETRY);
  if (!raw) return out;
  const all = JSON.parse(raw) as (Mail & { first: string })[];
  const q = all.filter((m) => Date.now() - Date.parse(m.first) < 2 * 86_400_000);
  await env.DB.delete(RETRY);
  if (all.length > q.length) {
    await loadMeter(env);
    droppedFor('retry_expired_2d', all.length - q.length);
    await env.DB.put(METER, JSON.stringify(mailQuota));
  }
  if (!q.length) return out;
  // A refusal puts them back on the list (sendMail does that), so nothing is lost.
  const status = await sendMail(env, q);
  return { ...out, mail_retry: { n: q.length, status } };
}

export const FOOTER = '\n\nSource: SEC EDGAR filings (13F-HR, Form 4, Schedules 13D and 13G), as filed. Not investment advice.\nCopybook by Factor Dynamics.';

/** The reply to a fund-plan, support or data-deletion request from the site. */
export function leadAckMail(env: Env, l: { topic: unknown; name: string | null; email: string; fund: string | null; seats: number | null; invoice: boolean | null; plan_interval: string | null; message: string | null }): Mail {
  const hi = l.name ? `Hi ${l.name},` : 'Hi,';
  const what =
    l.topic === 'delete'
      ? 'We received your request to delete your Copybook data. We will confirm by email once it is done, within 30 days.'
      : l.topic === 'support'
        ? 'We received your message and will reply to this address, usually within one business day.'
        : `Thanks for your interest in Copy Fund${l.fund ? ` for ${l.fund}` : ''}. We will reply to this address within one business day${l.invoice ? ' with an annual invoice quote' : ' with how to get started'}.`;
  const got = [
    l.fund && `Fund: ${l.fund}`,
    l.seats && `Seats: ${l.seats}`,
    l.invoice !== null && l.topic === 'fund' && `Invoice billing: ${l.invoice ? 'yes' : 'no'}`,
    l.plan_interval && `Billing: ${l.plan_interval}`,
    l.message && `Your note: ${l.message.length > 600 ? `${l.message.slice(0, 600)}…` : l.message}`,
  ].filter(Boolean);
  return {
    to: l.email,
    subject: l.topic === 'delete' ? 'Your Copybook data deletion request' : l.topic === 'support' ? 'We got your message' : 'Your Copy Fund request',
    text: `${hi}\n\n${what}${got.length ? `\n\nWhat you sent:\n${got.join('\n')}` : ''}\n\nCopybook: ${env.SITE_URL}${FOOTER}`,
  };
}

/** The copy of a site request that goes to our inbox (CONTACT_EMAIL); replying answers the requester. */
export function leadNoticeMail(env: Env, l: Record<string, unknown> & { topic: unknown; email: string }, id: string): Mail {
  const kind = l.topic === 'delete' ? 'Data deletion request' : l.topic === 'support' ? 'Support message' : 'Copy Fund request';
  const rows = ['name', 'email', 'fund', 'seats', 'invoice', 'plan_interval', 'page', 'received_at']
    .filter((k) => l[k] !== null && l[k] !== undefined)
    .map((k) => `${k}: ${String(l[k])}`);
  return {
    to: env.CONTACT_EMAIL,
    replyTo: l.email,
    subject: `${kind}: ${l.fund ?? l.name ?? l.email}`,
    text: `${kind} from the Copybook site. Reply to this email to answer ${l.email}.\n\n${rows.join('\n')}${l.message ? `\n\nMessage:\n${String(l.message)}` : ''}\n\nId: ${id}`,
  };
}

/** A seat had saved its Fund team's destination too: its copy is removed so each alert arrives once. */
export function teamDuplicateMail(env: Env, to: string, labels: string[]): Mail {
  const what = labels.join(' and ');
  return {
    to,
    subject: `Your ${what} alerts now come from your team's channel`,
    text: `You had connected the same ${what} destination your Copy Fund team's owner connected for the team. To deliver each alert there once, we removed your copy; team alerts keep arriving there from the team's channel${labels.includes('webhook') ? ", signed with the team's webhook secret (shown read-only in your account)" : ''}.\n\nYou can still connect personal channels of your own at ${env.SITE_URL}account/.${FOOTER}`,
  };
}

/** A chat or webhook destination stopped working; email alerts carry on. */
export function channelFailMail(env: Env, to: string, label: string, reason: string): Mail {
  return {
    to,
    subject: `Your ${label} alerts stopped: ${reason}`,
    text: `Copybook couldn't deliver your alerts to ${label}: ${reason}.\n\nYour email alerts are unaffected and keep arriving as usual. To fix ${label}, reconnect it (or paste a new URL or token) at ${env.SITE_URL}account/ and use "Send a test". Delivery resumes, and this notice clears, with the next alert that goes through.${FOOTER}`,
  };
}

/** A repeat checkout by an address already welcomed: the sign-in link and what carried over, not a second welcome. */
export function backMail(env: Env, to: string, token: string, m: Member): Mail {
  const link = `${env.SITE_URL}account/?login=${encodeURIComponent(token)}`;
  const name = m.plan === 'pro' ? 'Copy Pro' : m.plan === 'fund' ? 'Copy Fund' : 'Copy';
  const trial = m.trial_end ? ` Your trial runs until ${new Date(m.trial_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' })}.` : '';
  const text = `You're signed back in to ${name}.${trial} Your follows, alert channels and settings are as you left them.\n\nSign in on any device (this link works once, for 7 days):\n${link}\n\nManage or cancel billing any time from ${env.SITE_URL}account/.${FOOTER}`;
  return { to, subject: `You're signed back in to ${name}`, text };
}

export function loginMail(env: Env, to: string, token: string, welcome: boolean, m?: Member, waiting = false): Mail {
  const link = `${env.SITE_URL}account/?login=${encodeURIComponent(token)}`;
  // An unconfirmed member with follows waiting (the trader, Nov 11): the link is the confirmation, so say so first.
  if (!welcome && waiting) {
    return { to, subject: 'Confirm your email to start alerts', text: `Your Copybook alerts start once you open this link: it confirms your email and signs you in.\n\nConfirm (this link works once, for 15 minutes):\n${link}\n\nManage or cancel billing any time from ${env.SITE_URL}account/.${FOOTER}` };
  }
  if (!welcome) {
    return { to, subject: 'Your Copybook sign-in link', text: `Here is your Copybook sign-in link.\n\nSign in (this link works once, for 15 minutes):\n${link}\n\nManage or cancel billing any time from ${env.SITE_URL}account/.${FOOTER}` };
  }
  const name = m?.plan === 'pro' ? 'Copy Pro' : m?.plan === 'fund' ? 'Copy Fund' : 'Copy';
  const trial = m?.trial_end ? ` Your free trial runs until ${new Date(m.trial_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' })}, ${new Date(m.trial_end * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).replace(' AM', ' am').replace(' PM', ' pm')} ET; ${m.has_payment_method === false ? "no card is on file, so it simply ends then unless you add one in your account. Nothing is charged." : "cancel before then from your account and you're not charged."}` : '';
  // A Fund trial billed by invoice (no card): the invoice's dates, amount, PO and recipients, and the team's first steps.
  const inv = m?.collection === 'send_invoice' && m.plan === 'fund' && m.trial_end ? m : null;
  const day = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  const terms = inv
    ? ` Your 14-day trial runs until ${day(inv.trial_end!)}. On that day we issue the invoice for the year${inv.invoice_terms?.amount ? `, $${(inv.invoice_terms.amount / 100).toLocaleString('en-US')}` : ''}, due ${day(inv.trial_end! + 30 * 86400)} (Net 30)${inv.invoice_terms?.po ? `, with your PO ${inv.invoice_terms.po}` : ''}. It goes to ${to}${inv.invoice_terms?.ap_email ? `, with a copy to ${inv.invoice_terms.ap_email}` : ''}, with a Pay online link (card or US bank account). Your invoice stays Net 30 even if you add a card. Cancel before ${day(inv.trial_end!)} and nothing is owed.`
    : trial;
  const steps: [string, string, string][] = inv
    ? [
        ['Invite your team (up to 10)', 'Each seat gets its own sign-in, alerts and API keys. Under Team in your account.', `${env.SITE_URL}account/`],
        ['Bring in your book', "Paste tickers or a CSV in My book: any superinvestor's move in them is flagged [you own].", `${env.SITE_URL}my-book/`],
        ['Connect a team channel', 'Slack, Discord, Telegram or a signed webhook, for the whole team. Under Alerts in your account.', `${env.SITE_URL}account/`],
      ]
    : [
        ['Follow the funds you care about', 'Each 13F, Form 4 and 13D they file reaches you minutes after EDGAR accepts it.', `${env.SITE_URL}investors/`],
        ['Add the names you own', "Paste tickers or a CSV in My book: any superinvestor's move in them is flagged [you own].", `${env.SITE_URL}my-book/`],
        ['Connect a channel', 'Slack, Discord, Telegram or a private RSS feed, next to email. Under Alerts in your account.', `${env.SITE_URL}account/`],
      ];
  const signIn = inv
    ? 'Open this link to sign in and confirm your address: it turns on seats, alert channels and API keys (it works once, for 7 days):'
    : "You're signed in on the device you subscribed from. Open this link to confirm your address: it turns on alert channels, API keys and billing, and signs you in on any other device (it works once, for 7 days):";
  const text = `Welcome to ${name}.${terms}\n\n${signIn}\n${link}\n\nThen three steps, two minutes:\n${steps.map(([t, d, u], i) => `${i + 1}. ${t}: ${u}\n   ${d}`).join('\n')}\n\nYour plan also includes 8 quarters of 13F history and CSV export on every investor page.${FOOTER}`;
  const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:560px"><p>Welcome to ${name}.${esc(terms)}</p><p>${esc(signIn.replace(/:$/, '.'))}</p><p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">Sign in to Copybook</a></p><p>Then three steps, two minutes:</p><ol style="padding-left:20px">${steps.map(([t, d, u]) => `<li style="margin:0 0 10px"><a href="${u}" style="color:#1d4ed8;font-weight:600">${t}</a><br><span style="color:#374151">${esc(d)}</span></li>`).join('')}</ol><p style="color:#374151">Your plan also includes 8 quarters of 13F history and CSV export on every investor page.</p><p style="color:#6b7280;font-size:12px;margin-top:24px">Source: SEC EDGAR filings, as filed. Not investment advice. Copybook by Factor Dynamics.</p></div>`;
  return { to, subject: `Welcome to ${name}: three steps to your first alert`, text, html };
}

/** A Copy Fund seat invitation, with the seat's own sign-in link. */
export function seatInviteMail(env: Env, to: string, owner: string, token: string): Mail {
  const link = `${env.SITE_URL}account/?login=${encodeURIComponent(token)}`;
  return {
    to,
    subject: 'You have a Copy Fund seat on Copybook',
    text: `${owner} added you to their team's Copy Fund plan on Copybook. Your seat shares the team's followed funds, watchlist, book and peer list, and has its own alert settings, delivery channels and API keys.\n\nSign in (this link works once, for 7 days; later, request a new link with this address at ${env.SITE_URL}account/):\n${link}${FOOTER}`,
  };
}

function usd(v: number, sign = true): string {
  const a = Math.abs(v);
  const s = a >= 1e9 ? `$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : `$${Math.round(a / 1e3)}K`;
  return sign ? (v < 0 ? '-' : '+') + s : s;
}

const quarterLabel = (q: string) => (/^\d{4}Q[1-4]$/.test(q) ? `Q${q[5]} ${q.slice(0, 4)}` : q);

function flag(ticker: string | null, f: Follows): string {
  if (!ticker) return '';
  return f.owned.includes(ticker) ? ' [you own]' : f.stocks.includes(ticker) ? ' [watchlist]' : '';
}

const MOVE_LABELS = [['New', 'new'], ['Added', 'added'], ['Trimmed', 'trimmed'], ['Exited', 'exited']] as const;

// A name cut off at 13F's 30 characters ("CRINETICS PHARMACEUTICALS IN") loses the stray fragment of its legal suffix.
const rowName = (r: MoveRow) => (r.ticker || (r.display_name || r.issuer || r.cusip).replace(/\s+(in|cor|corpo|incor|hl|hld)$/i, '')) + (r.put_call ? ` ${r.put_call.toLowerCase()}s` : '');
/** 4,380,656 as "4.38M", 44,294 as "44K". */
const compact = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toPrecision(3)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n.toLocaleString('en-US'));
/** " · Unusual size · check the filing" after a large but real move. */
const odd = (r: MoveRow) => `${r.unusual ? ` · ${UNUSUAL}` : ''}${r.filer_value && r.unreliable !== 'value' ? ` · ${FILER_VALUE}` : ''}${unreliableNote(r) ? ` · ${unreliableNote(r)}` : ''}`;

/** A marked row's note (markUnreliable): what can't be trusted, and that it isn't in the totals. */
function unreliableNote(r: MoveRow): string {
  if (r.unreliable === 'value') return 'value unavailable, not in totals';
  if (r.unreliable === 'shares') return r.change === 'new' || r.change === 'exited' ? "share counts don't reconcile, not in totals" : 'not counted';
  if (r.unreliable === 'both') return 'share count unreliable in this filing, not in totals';
  return '';
}
/** An add or trim whose share counts don't reconcile: shown by its filed values only, no computed trade. */
const sharesOnly = (r: MoveRow) => r.unreliable === 'shares' && (r.change === 'added' || r.change === 'trimmed');
const prevFiled = (r: MoveRow) => r.prev_value ?? r.value - r.value_delta;
/** "value as filed fell from $121.6M to $6.7M" */
const filedFacts = (r: MoveRow) => `value as filed ${r.value < prevFiled(r) ? 'fell' : 'rose'} from ${usd(prevFiled(r), false)} to ${usd(r.value, false)}`;
const NOT_COUNTED_SHARES = "share counts don't reconcile, not counted";
/** A row's size: dollars, the share change when its value can't be trusted ("TEVA +159,272 sh"), or the filed values. */
const amount = (r: MoveRow) => {
  if (sharesOnly(r)) return `${usd(prevFiled(r), false)} → ${usd(r.value, false)} as filed`;
  return r.unreliable === 'value' || r.unreliable === 'both' ? shareMove(r) : usd(r.value_delta);
};
/** A move by share count, for a line whose $ can't be trusted: \"+159,272 sh\", \"3,900,000 sh\" (new), \"-133,000 sh\" (exit). */
const shareMove = (r: MoveRow) => {
  const d = r.change === 'new' ? r.shares : r.change === 'exited' ? -(r.prev_shares ?? 0) : r.shares - (r.prev_shares ?? 0);
  return `${r.change === 'new' ? '' : d >= 0 ? '+' : '-'}${Math.abs(d).toLocaleString('en-US')} sh`;
};

/** The trade as a share of this filing's book; no % without it (pct_of_book is the position's weight, never a trade size). */
const bookPct = (r: MoveRow) => {
  if (sharesOnly(r) || r.unreliable === 'value' || r.unreliable === 'both') return '';
  const d = r.delta_pct_of_book;
  if (!d) return '';
  return Math.abs(d) < 0.0005 ? '<0.1%' : `${(Math.abs(d) * 100).toFixed(1)}%`;
};

const misfiled = (r: MoveRow) => r.cusip_pair === 'merged_misfiled' && !!r.filed_cusip;
/** ": Q2 was filed under 68389X204 at common's price, treated as common": a prior line ingest merged into this class. */
const misfiledNote = (a: { quarter: string }, r: MoveRow) => {
  const q = Number(a.quarter.slice(-1));
  return `: Q${q === 1 ? 4 : q - 1} was filed under ${r.filed_cusip} at common's price, treated as common`;
};
/** A change sized from filed values because the share counts don't (guardShares): no share or position figures. */
const UNRECONCILED = "share counts don't reconcile; change from filed values";
/** How much of the position itself changed: a trim of 40% of the shares reads differently from 0.4% of the book. */
function positionChange(label: string, r: MoveRow): string {
  if (sharesOnly(r)) return "share counts don't reconcile";
  if (r.unreliable === 'shares') return UNRECONCILED;
  if (label === 'New') return 'new';
  if (label === 'Exited') return 'sold all';
  if (!r.prev_shares) return '';
  const p = ((r.shares - r.prev_shares) / r.prev_shares) * 100;
  // A trim that leaves a sliver isn't "sold 100%"; a position grown 10x or more reads better as share counts.
  if (label === 'Trimmed') return r.shares > 0 && p <= -99.5 ? 'sold >99%' : `sold ${Math.abs(p).toFixed(0)}%`;
  return p >= 1000 ? `${compact(r.prev_shares)} → ${compact(r.shares)} sh` : `+${p.toFixed(0)}% shares`;
}
/** "In your names" detail: the trade in shares, then what's held ("sold 135,048 sh (3%), holds 4.38M"). */
function shareTrade(r: MoveRow): string {
  if (r.unreliable === 'shares') return UNRECONCILED;
  if (!r.prev_shares) return r.shares ? `${compact(r.shares)} sh` : '';
  if (!r.shares) return `sold all ${compact(r.prev_shares)} sh`;
  const d = r.shares - r.prev_shares;
  const pct = Math.abs(d / r.prev_shares) * 100;
  const pctText = pct >= 1000 ? '' : ` (${d > 0 ? '+' : ''}${pct < 1 ? pct.toFixed(1) : pct.toFixed(0)}%)`;
  return `${d > 0 ? 'bought' : 'sold'} ${Math.abs(d).toLocaleString('en-US')} sh${pctText}, holds ${compact(r.shares)}`;
}

/** Short name for subjects: a person's surname ("Buffett"), else the firm without its legal suffix. */
export function shortName(manager: string): string {
  const name = manager.trim();
  // EDGAR writes filer names in capitals, people surname first ("ICAHN CARL C"): keep the order, drop the legal suffix.
  if (name === name.toUpperCase()) {
    // Names known by their initials, as people write them.
    const known: Record<string, string> = { 'FMR LLC': 'Fidelity (FMR)', FMR: 'Fidelity (FMR)' };
    if (known[name.replace(/\.$/, '')]) return known[name.replace(/\.$/, '')];
    const bare = name.replace(/[,\s]+(LLC|L\.L\.C\.|LP|L\.P\.|INC\.?|CORP\.?|LTD\.?|PLC|CO\.?|ET AL)\.?$/i, '') || name;
    return bare.toLowerCase().replace(/(^|[\s\-/&(])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
  }
  const firm = /\b(LLC|L\.?L\.?C\.?|LP|L\.?P\.?|INC|CORP|CO|LTD|PLC|GROUP|MANAGEMENT|CAPITAL|PARTNERS|ADVIS[OE]RS|TRUST|FUND|HOLDINGS|ASSOCIATES|INVESTMENTS?|ASSET|ENTERPRISES|BANK|S\.?A\.?|AG|GMBH)\b/i;
  const words = name.split(/\s+/);
  if (words.length >= 2 && words.length <= 3 && !firm.test(name)) return words[words.length - 1];
  return name.replace(/[,\s]+(LLC|L\.L\.C\.|LP|L\.P\.|INC\.?|CORP\.?|LTD\.?|PLC)\.?$/i, '') || name;
}

/**
 * "NEW DHI · EXIT STZ · GOOGL +$8.8B": the largest new position and the largest exit (a new name
 * or a full exit is the news, whatever its size), then the largest adds and trims by dollars.
 */
function headlineMoves(mv0: Moves): string {
  const mv = countedMoves(mv0); // stored moves too: a held or possibly re-coded line never leads
  const big = (rows: MoveRow[]) => [...rows].sort((a, b) => Math.abs(b.value_delta) - Math.abs(a.value_delta));
  // The largest new position and exit lead when each is at least 0.2% of the book (news whatever its dollars), then
  // the biggest trades by dollars. Below that a new name or exit is just a trade: Fisher's Q3 led with a $57M new
  // name and a $66M exit, under 0.1% of book, over a $4.6B bond rotation.
  const pct = (r: MoveRow) => (r.delta_pct_of_book == null ? 1 : Math.abs(r.delta_pct_of_book));
  const label = (r: MoveRow) => (mv.new.includes(r) ? `NEW ${rowName(r)}` : mv.exited.includes(r) ? `EXIT ${rowName(r)}` : `${rowName(r)} ${usd(r.value_delta)}`) + odd(r);
  // A marked row (markUnreliable) never makes the headline.
  const ok = (rows: MoveRow[]) => rows.filter((r) => !r.unreliable);
  const news = [...big(ok(mv.new)).slice(0, 1), ...big(ok(mv.exited)).slice(0, 1)].filter((r) => pct(r) >= 0.002);
  const rest = big(ok([...mv.new, ...mv.exited, ...mv.added, ...mv.trimmed])).filter((r) => !news.includes(r));
  return [...news, ...rest].slice(0, 3).map(label).join(' · ');
}

const acceptedUtc = (iso: string) => iso.replace('T', ' ').replace(/(\.\d+)?Z$/, ' UTC');

/** The filing's public card when the site has built it, otherwise the investor page. */
export const filingUrl = (env: Env, a: Alert13F) => (a.card ? `${env.SITE_URL}f/${a.accession}/` : `${env.SITE_URL}investors/${a.slug}`);

/** Every move in the member's owned and watched names, named and tagged (the capped lists above may not show them). */
function yourMoves(a: Alert13F, f: Follows): MoveRow[] {
  const mv = a.moves;
  if (!mv) return [];
  const all = [...(a.changed ?? []), ...mv.new, ...mv.added, ...mv.trimmed, ...mv.exited];
  const seen = new Set<string>();
  return all.filter((r) => r.ticker && (f.owned.includes(r.ticker) || f.stocks.includes(r.ticker)) && !seen.has(`${r.ticker}:${r.put_call ?? ''}`) && !!seen.add(`${r.ticker}:${r.put_call ?? ''}`));
}
const verb = (r: MoveRow) => (!r.prev_shares ? 'new' : !r.shares ? 'exited' : r.shares > r.prev_shares ? 'added' : 'trimmed');
/** One of your names: a trade in $, a \"value\" trade by shares, or a held line's facts. */
const yourLine = (r: MoveRow) =>
  r.unreliable === 'value'
    ? `${verb(r)} ${shareTrade(r) || shareMove(r)}, value unavailable`
    : r.unreliable
      ? `${heldFacts(r) ? `${heldFacts(r)}, ` : ''}not counted (${notCountedWhy(r)})`
      : `${verb(r)} ${usd(r.value_delta)}${shareTrade(r) ? `, ${shareTrade(r)}` : ''}`;

/** Rows the publish gate held back, named without figures. */
const posName = (h: { ticker: string | null; display_name: string | null; issuer: string; put_call: string | null }) => `${h.ticker || h.display_name || h.issuer}${h.put_call ? ` ${h.put_call.toLowerCase()}s` : ''}`;
function heldLine(a: Alert13F): string {
  const wait = (a.held ?? []).filter((h) => h.reason !== 'unreliable_shares');
  return [
    wait.length ? `${wait.map((h) => `${posName(h)}${h.change ? ` (${h.change})` : ''}: move pending check`).join('; ')}. Figures failed a price check and are left out of this email and its totals; they follow once the full build of the filing confirms them, or within 24 hours marked if the filer's own figures look wrong.` : '',
    notCountedLine(a),
  ].filter(Boolean).join(' ');
}
/** Why a line isn't counted, in a few words. */
// \"pre-split\" only where ingest's held_reason says so (the trader, Nov 11): Mizuho's Oracle and O read \"pre-split count\"
// from a fallback, which was wrong.
const notCountedWhy = (x: { unreliable?: string; put_call: string | null; reason?: string; cusip_pair?: boolean | string; held_reason?: string }) =>
  x.cusip_pair === true ? 'possible CUSIP change' : /pre.?split|mixed.?scale/i.test(x.held_reason ?? '') ? 'share count looks pre-split' : x.unreliable === 'value' ? 'value unavailable' : x.unreliable === 'both' && x.put_call ? "filed figures don't reconcile" : "share counts don't reconcile";
const perShare = (x: number) => (x >= 10 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2));
/** \"filed value implausible (≈$7,758/sh vs ~$78)\": a line priced far off other filers, without its filed $. */
function implausible(r: MoveRow): string {
  const ps = r.filed_per_share ?? (r.shares > 0 && r.value > 0 ? r.value / r.shares : null);
  const m = r.median_per_share;
  const off = (r as { price_outlier?: boolean }).price_outlier === true || r.unreliable === 'value' || (!!ps && !!m && (ps / m > 3 || m / ps > 3));
  return ps && off ? `filed value implausible (≈$${perShare(ps)}/sh${m ? ` vs ~$${perShare(m)}` : ''})` : '';
}
/**
 * A marked row's filed facts, never a computed trade in $: "value as filed fell from $121.6M to $6.7M" (shares side),
 * "+159,272 sh" (value side), "new, 3.9M sh, value as filed $30.2B", "sold all 646K sh, value as filed was $121.6M".
 */
function heldFacts(r: MoveRow): string {
  // Only a \"shares\" line keeps its filed $ (\"value as filed\"); a \"value\" or \"both\" line never prints one (the analyst's
  // round 39): its shares, and why the value is off when it is priced far from other filers.
  // A held option line never shows a filed $ either, whatever its stored side (the analyst, Nov 11: Mizuho's TLT puts).
  if (r.unreliable === 'shares' && !r.put_call) {
    if (r.change === 'new') return `new, ${compact(r.shares)} sh${r.value ? `, value as filed ${usd(r.value, false)}` : ''}`;
    if (r.change === 'exited') {
      const was = r.prev_value ?? (r.value_delta < 0 ? -r.value_delta : null); // an exit's delta is minus its filed value
      return `sold all${r.prev_shares ? ` ${compact(r.prev_shares)} sh` : ''}${was ? `, value as filed was ${usd(was, false)}` : ''}`;
    }
    return filedFacts(r);
  }
  const d = r.shares - (r.prev_shares ?? 0);
  const sh = r.change === 'new' ? `new, ${compact(r.shares)} sh` : r.change === 'exited' ? `sold all${r.prev_shares ? ` ${compact(r.prev_shares)} sh` : ''}` : r.unreliable === 'value' ? (d ? `${d >= 0 ? '+' : '-'}${Math.abs(d).toLocaleString('en-US')} sh` : '') : r.prev_shares ? `${compact(r.prev_shares)} → ${compact(r.shares)} sh as filed` : '';
  // A "both" line: neither figure is blamed (the analyst, Nov 11: O's $11.1M is plausible, its 23.3M shares aren't).
  // "new; 23.3M sh and $11.1M as filed don't reconcile (≈$0.48/sh vs ~$54)". Options keep no filed $ (above).
  if (r.unreliable === 'both' && !r.put_call) {
    const ps = r.filed_per_share ?? (r.shares > 0 && r.value > 0 ? r.value / r.shares : null);
    const m = r.median_per_share;
    const filed = r.change === 'exited' ? { sh: r.prev_shares ?? 0, v: r.prev_value ?? (r.value_delta < 0 ? -r.value_delta : 0) } : { sh: r.shares, v: r.value };
    const head = r.change === 'new' ? 'new' : r.change === 'exited' ? 'sold all' : r.change;
    return `${head}; ${compact(filed.sh)} sh and ${usd(filed.v, false)} as filed don't reconcile${ps && r.change !== 'exited' ? ` (≈$${perShare(ps)}/sh${m ? ` vs ~$${perShare(m)}` : ''})` : ''}`;
  }
  // A "both" option line keeps no filed $ either, and blames neither figure.
  if (r.unreliable === 'both') {
    const ps = r.filed_per_share ?? (r.shares > 0 && r.value > 0 ? r.value / r.shares : null);
    const m = r.median_per_share;
    return [sh, `shares and value as filed don't reconcile${ps ? ` (≈$${perShare(ps)}/sh${m ? ` vs ~$${perShare(m)}` : ''})` : ''}`].filter(Boolean).join('; ');
  }
  const why = implausible(r);
  return [sh, why].filter(Boolean).join('; ');
}
const isMoveRow = (x: unknown): x is MoveRow => typeof (x as MoveRow)?.value_delta === 'number';
/** "Not counted: SPY calls, SPY puts (share counts don't reconcile).": lines held out, or marked and past the lists. */
function notCountedLine(a: Alert13F): string {
  const items = [...(a.held ?? []).filter((h) => h.reason === 'unreliable_shares'), ...(a.moves ? countedMoves(a.moves).not_counted ?? [] : [])];
  if (!items.length) return '';
  // Lines named only (held by the gate) group by reason; a marked row adds its filed facts.
  const by = new Map<string, string[]>();
  // A possible CUSIP change is one entry, both codes in it (the lead's ruling, Nov 11): an exit and a new line on one
  // ticker read as a round trip otherwise, the misreading the hold exists to prevent. "ORCL 133K → 166K sh: possible CUSIP
  // change (68389X105 → 68389X204)".
  const pairs = new Map<string, MoveRow[]>();
  for (const x of items) if (isMoveRow(x) && x.cusip_pair === true) pairs.set(posName(x), [...(pairs.get(posName(x)) ?? []), x]);
  const merged = new Set<MoveRow>();
  for (const [name, rows] of pairs) {
    const gone = rows.find((r) => r.change === 'exited');
    const now = rows.find((r) => r.change === 'new');
    if (!gone || !now || gone.cusip === now.cusip) continue;
    by.set(`${name} ${gone.prev_shares ? compact(gone.prev_shares) : '?'} → ${compact(now.shares)} sh: possible CUSIP change (${gone.cusip} → ${now.cusip})`, []);
    merged.add(gone).add(now);
  }
  for (const x of items) {
    if (isMoveRow(x) && merged.has(x)) continue;
    const facts = isMoveRow(x) ? heldFacts(x) : '';
    const why = notCountedWhy(x);
    // \"EW puts new, 3.9M sh; filed value implausible (≈$7,758/sh vs ~$78)\" already says why.
    if (facts) by.set(/implausible|don't reconcile/.test(facts) ? `${posName(x)} ${facts}` : `${posName(x)} ${facts} (${why})`, []);
    else by.set(why, [...(by.get(why) ?? []), posName(x)]);
  }
  return `Not counted: ${[...by].map(([k, names]) => (names.length ? `${[...new Set(names)].join(', ')} (${k})` : k)).join('; ')}.`;
}
/** The Corrected note, one line: lines now not counted are named as such; any other row says what it was and is. */
function correctedNote(a: Alert13F): string {
  const c = a.corrected!;
  const out = new Set([...(a.held ?? []).filter((h) => h.reason === 'unreliable_shares'), ...[...(a.moves?.new ?? []), ...(a.moves?.added ?? []), ...(a.moves?.trimmed ?? []), ...(a.moves?.exited ?? []), ...(a.moves?.not_counted ?? [])].filter((r) => r.unreliable)].map((x) => posKey(x)));
  const gone = c.rows.filter((r) => r.v1.change === 'held' || out.has(posKey(r)));
  const rest = c.rows.filter((r) => !gone.includes(r));
  const parts = [gone.length ? `${[...new Set(gone.map((r) => posName({ ...r, display_name: null, issuer: r.name })))].join(', ')} not counted (${notCountedWhy(gone[0])})` : '', ...rest.map(corrLine)].filter(Boolean).map((x) => x.replace(/\.$/, ''));
  return `Corrected ${c.at.slice(0, 10)}: ${parts.join('; ')}.`;
}

/** What the alert said, or what the build has, for one row of a correction. */
const said = (x: { change: string; value_delta: number }) =>
  x.change === 'total' ? usd(x.value_delta, false) : x.change === 'unchanged' ? 'unchanged' : `${x.change === 'new' ? 'a new position' : x.change === 'exited' ? 'sold out' : x.change} ${usd(x.value_delta)}`;
const corrLine = (r: CorrectionRow) =>
  r.v1.change === 'held'
    ? `${r.ticker || r.name}${r.put_call ? ` ${r.put_call.toLowerCase()}s` : ''}: share counts don't reconcile in this filing, so no change is computed (not ${said(r.emailed)}).`
    : `${r.ticker || r.name}${r.put_call ? ` ${r.put_call.toLowerCase()}s` : ''} was ${said(r.v1)}, not ${said(r.emailed)}.`;

/** One wrong row in a sent 13F alert: what the email said and what the data run's build (and /v1) has. */
export interface CorrectionRow {
  cusip: string;
  ticker: string | null;
  name: string;
  put_call: string | null;
  emailed: { change: string; value_delta: number };
  v1: { change: string; value_delta: number };
  /** Reconciliation's verdict: disclosed on /status/, explained (no wrong figure), or wrong (the only one mailed). */
  class?: 'disclosed' | 'explained' | 'wrong';
  why?: string;
}

/** "Correction: Jensen (Jensen Investment Management) APH was trimmed -$15.3M, not added +$36.5M". */
export function correctionMail(env: Env, to: string, a: Alert13F, rows: CorrectionRow[]): Mail {
  const who = `${filerLabel(a)}`;
  const first = rows[0];
  const subject = `Correction: ${who} ${first.ticker || first.name}${first.put_call ? ` ${first.put_call.toLowerCase()}s` : ''} was ${said(first.v1)}, not ${said(first.emailed)}${rows.length > 1 ? ` (+${rows.length - 1} more)` : ''}`;
  const intro = `Our alert for ${who}'s ${quarterLabel(a.quarter)} 13F (accession ${a.accession}) had ${rows.length === 1 ? 'a wrong figure' : `${rows.length} wrong figures`}. Copybook checks every emailed move against the full build of the filing, which is what fund pages, the CSV and /v1 serve. ${rows.length === 1 ? 'This one' : 'These'} didn't match:`;
  const page = filingUrl(env, a);
  const text = [intro, rows.map((r) => `- ${corrLine(r)}`).join('\n'), `The filing's moves on Copybook: ${page}`, `SEC filing: ${a.sec_url}`].join('\n\n') + FOOTER;
  const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:600px"><p>${esc(intro)}</p><ul>${rows.map((r) => `<li><b>${esc(r.ticker || r.name)}</b>${r.put_call ? ` ${esc(r.put_call.toLowerCase())}s` : ''} was <b>${esc(said(r.v1))}</b>, not ${esc(said(r.emailed))}.</li>`).join('')}</ul><p>${link(page, "The filing's moves on Copybook")} · ${link(a.sec_url, 'SEC filing')}</p><p style="font-size:12px;color:#6b7280">${esc(FOOTER.trim()).replace(/\n/g, '<br>')}</p></div>`;
  return { to, subject, text, html };
}

/** An alert as rendered: marked rows out of the move lists (countedMoves), whenever the alert was stored. */
const withCounted = (a: Alert13F): Alert13F => (a.moves ? { ...a, moves: countedMoves(a.moves) } : a);

function filingBlock(env: Env, a0: Alert13F, f: Follows): string {
  const a = withCounted(a0);
  const head = `${filerLabel(a)}: ${quarterLabel(a.quarter)} 13F, filed ${a.filing_date}${a.checked ? ' (checked position changes)' : a.followup ? ' (position changes)' : ''}`;
  const lines = [head];
  const mv = a.moves;
  if (a.reveal) {
    lines[0] = `${filerLabel(a)}: ${quarterLabel(a.quarter)} 13F amendment${a.reveal.amendment_no ? ` no. ${a.reveal.amendment_no}` : ''} (new holdings)`;
    lines.push(a.reveal.confidential ? `  Positions held at ${a.report_date} that were kept confidential until now:` : `  Positions added to the ${a.report_date} book:`);
    lines.push(`  ${a.reveal.rows.map((r) => `${rowName(r)} ${r.shares.toLocaleString('en-US')} sh, ${usd(r.value, false)}${bookPct(r) ? ` (${bookPct(r)} of book)` : ''}${flag(r.ticker, f)}`).join(', ')}`);
  } else if (mv) {
    lines.push(`Bought ${usd(mv.bought_usd, false)}, sold ${usd(mv.sold_usd, false)} this quarter.`);
    for (const [label, rows] of [['New', mv.new], ['Added', mv.added], ['Trimmed', mv.trimmed], ['Exited', mv.exited]] as const) {
      if (!rows.length) continue;
      const parts = rows.map((r) => {
        // \"BKNG value as filed fell from $121.6M to $6.7M; share counts don't reconcile, not counted\": no computed trade.
        if (sharesOnly(r)) return `${rowName(r)} ${filedFacts(r)}; ${NOT_COUNTED_SHARES}${flag(r.ticker, f)}`;
        // Ingest merged a prior line filed under another class's CUSIP (the lead, Nov 11: Mizuho's Oracle).
        if (misfiled(r)) return `${rowName(r)} ${shareMove(r)} (${usd(r.value_delta)})${misfiledNote(a, r)}${flag(r.ticker, f)}`;
        const pos = label === 'Trimmed' || label === 'Added' ? positionChange(label, r) : '';
        const bits = [pos && (pos.startsWith('sold ') ? `${pos} of the position` : pos), bookPct(r) && `${bookPct(r)} of book`].filter(Boolean);
        return `${rowName(r)} ${amount(r)}${bits.length ? ` (${bits.join(', ')})` : ''}${flag(r.ticker, f)}${odd(r)}`;
      });
      lines.push(`  ${label}: ${parts.join(', ')}`);
    }
    for (const r of mv.exchanged ?? []) lines.push(`  ${exchangeLine(r)}`);
    if (a.held?.length || a.moves?.not_counted?.length) lines.push(`  ${heldLine(a)}`);
    const mine = yourMoves(a, f);
    if (mine.length) lines.push(`  In your names: ${mine.map((r) => `${rowName(r)} ${yourLine(r)} (${f.owned.includes(r.ticker!) ? 'you own' : 'watchlist'})`).join('; ')}`);
  } else if (a.top?.length) {
    lines.push('  No earlier quarter on file for this filer, so no changes yet. Largest holdings:');
    lines.push(`  ${a.top.map((r) => `${r.ticker || r.display_name || r.issuer}${r.put_call ? ` ${r.put_call.toLowerCase()}s` : ''} ${usd(r.value, false)}${flag(r.ticker, f)}`).join(', ')}`);
  } else if (a.moves_pending || !a.extra) {
    lines.push('  Position changes follow in a second email within minutes.');
  } else {
    lines.push('  Holdings are on the filer page below.');
  }
  if (a.accepted) lines.push(`  Accession ${a.accession}, accepted by EDGAR ${acceptedUtc(a.accepted)}`);
  lines.push(`  Copybook: ${filingUrl(env, a)}`, `  SEC: ${a.sec_url}`);
  return lines.join('\n');
}

/** One 13F in the Copy alert's format, for the Friday email's "Your follows". */
export const followFiling = (env: Env, a: Alert13F, f: Follows) => ({ text: filingBlock(env, a, f), html: filingHtml(env, a, f) });

const FORM_LABEL: Record<string, string> = { form4: 'Form 4', '13d': 'Schedule 13D', '13g': 'Schedule 13G' };

const n = (v: number) => {
  const a = Math.abs(v);
  return a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : v.toLocaleString('en-US');
};

/** What changed in a 13D/G stake, and why: trading, dilution or issuance, thresholds, 13G to 13D. */
export function stakeChange(e: AlertEvent): { line: string | null; note: string | null } {
  const pct = e.percent_of_class;
  const prev = e.prev_percent_of_class;
  if (pct == null) return { line: null, note: null };
  if (prev == null) return { line: `${pct}% of the class${e.shares_after != null ? `, ${e.shares_after.toLocaleString('en-US')} shares` : ''}`, note: e.action === 'new_stake' ? 'new stake' : null };
  const sh = e.shares_after;
  const psh = e.prev_shares_after;
  const shares = sh != null && psh != null ? (sh === psh ? `${sh.toLocaleString('en-US')} shares (unchanged)` : `${psh.toLocaleString('en-US')} → ${sh.toLocaleString('en-US')} shares (${sh > psh ? '+' : ''}${n(sh - psh)})`) : null;
  const notes: string[] = [];
  if (sh != null && psh != null) {
    if (sh === psh && pct < prev) notes.push('diluted, no shares sold');
    else if (sh === psh && pct > prev) notes.push('fewer shares outstanding, no shares bought');
    else if (sh > psh) notes.push('bought');
    else if (sh < psh) notes.push('sold');
  }
  for (const t of [5, 10, 20, 50]) {
    if (prev < t && pct >= t) notes.push(`crossed above ${t}%`);
    if (prev >= t && pct < t) notes.push(`fell below ${t}%`);
  }
  if (e.prev_form?.includes('13G') && e.kind === '13d') notes.push('switched from passive 13G to activist 13D');
  return { line: `${prev}% → ${pct}% of the class${shares ? `; ${shares}` : ''}`, note: notes.join('; ') || null };
}

/** EDGAR's "SMITH JOHN A" as "John A Smith"; other names as they are. */
export function titleName(n: string): string {
  if (n !== n.toUpperCase()) return n;
  const legal = /^(LP|LLC|L\.?P\.?|INC\.?|CORP\.?|CO\.?|LTD\.?|PLC|N\.?A\.?|II|III|IV)$/;
  const w = n.trim().split(/\s+/).map((x) => (legal.test(x) ? x : x.charAt(0) + x.slice(1).toLowerCase()));
  // Firms and trusts keep their word order; people are filed surname first.
  const entity = /\b(LP|LLC|L\.P\.|INC|CORP|CO|LTD|PLC|TRUST|FUND|PARTNERS|CAPITAL|HOLDINGS?|MANAGEMENT|GROUP|ADVISORS|INVESTMENTS?|FOUNDATION|ESTATE|BANK)\b/;
  return entity.test(n) || w.length < 2 ? w.join(' ') : [...w.slice(1), w[0]].join(' ');
}

const clusterRows = (e: AlertEvent) => (e.cluster ?? []).map((i) => [titleName(i.name), i.roles.join(', '), i.accepted.slice(0, 10), usd(i.bought_usd, false)]);

function eventLine(env: Env, e: AlertEvent, f: Follows): string {
  const what = e.ticker || e.display_name || e.issuer || 'a security';
  if (e.cluster) {
    const lines = [`Cluster buy: ${eventHeadline(e)}${flag(e.ticker, f)}`, ...clusterRows(e).map((r) => `  ${r[0]} (${r[1]}), ${r[2]}: ${r[3]}`), `  SEC: ${e.url}`];
    return lines.join('\n');
  }
  const form = `${FORM_LABEL[e.kind]}${/\/A$/.test(e.form) ? '/A' : ''}${e.amendment_no ? ` (amendment ${e.amendment_no})` : ''}`;
  const who = e.insider ? `${titleName(e.insider.name)} (${e.insider.roles.join(', ')} of ${e.issuer ?? what})` : siteName(e.slug) ?? (e.manager || 'A filer');
  const lines: string[] = [];
  if (e.details_pending) {
    lines.push(`${form}: ${who}${e.issuer || e.ticker ? `, ${what}` : ''}. Details follow once the filing is processed.`);
  } else if (e.kind === 'form4') {
    const verb = e.action === 'buy' ? 'bought' : e.action === 'sell' ? 'sold' : e.action === 'mixed' ? 'bought and sold' : 'reported';
    const money = e.value_usd ? ` (${usd(Math.abs(e.value_usd), false)}${e.avg_price ? `, avg $${e.avg_price.toFixed(2)}` : ''})` : '';
    const sh = e.shares && e.action !== 'mixed' ? `${Math.abs(e.shares).toLocaleString('en-US')} shares of ` : '';
    lines.push(`${form}: ${who} ${verb} ${sh}${what}${money}`);
    // Holdings per class: Class A and Class B are separate securities.
    for (const c of e.classes ?? []) {
      const delta = c.bought - c.sold;
      if (c.shares_after == null && !delta) continue;
      const pctChg = c.shares_before && c.shares_after != null ? ` (${c.shares_after >= c.shares_before ? '+' : ''}${(((c.shares_after - c.shares_before) / c.shares_before) * 100).toFixed(1)}%)` : '';
      lines.push(`  ${c.security}: ${c.shares_before != null ? `${n(c.shares_before)} → ` : ''}${c.shares_after != null ? n(c.shares_after) : '?'} shares${pctChg}`);
    }
    if (!e.classes && e.shares_after != null) lines.push(`  Shares held after: ${e.shares_after.toLocaleString('en-US')}`);
  } else {
    const verb = e.action === 'new_stake' ? 'disclosed a new stake in' : e.action === 'below_threshold' ? 'reported below 5% of' : 'filed an amendment on';
    const c = stakeChange(e);
    const inline = e.prev_percent_of_class == null && c.line;
    lines.push(`${form}: ${who} ${verb} ${what}${inline ? `, ${c.line}` : ''}`);
    if (c.line && !inline) lines.push(`  Stake: ${c.line}${c.note ? ` (${c.note})` : ''}`);
    if (e.item4) lines.push(`  Purpose (Item 4): ${cleanItem4(e.item4)}`);
  }
  for (const fn of (e.footnotes ?? []).slice(0, 3)) lines.push(`  Footnote: ${fn.length > 240 ? `${fn.slice(0, 240)}…` : fn}`);
  const stamp = e.accepted ? `accepted by EDGAR ${acceptedUtc(e.accepted)}` : `filed ${e.filing_date}`;
  lines.push(`  ${flag(e.ticker, f).trim() ? `${flag(e.ticker, f).trim()} · ` : ''}Accession ${e.id}, ${stamp}`);
  if (e.slug) lines.push(`  Copybook: ${env.SITE_URL}investors/${e.slug}`);
  lines.push(`  SEC: ${e.url}`);
  return lines.join('\n');
}

function body(env: Env, intro: string, filings: Alert13F[], events: AlertEvent[], f: Follows, m?: Member): string {
  const parts = [intro];
  if (m?.alerts_note === 'followed') {
    parts.push(`Alert change: you now get alerts only for the ${f.investors.length} fund${f.investors.length === 1 ? '' : 's'} you follow, plus active managers' moves in stocks you own or watch. To get every curated fund again, choose "Every investor" in alert settings at ${env.SITE_URL}account/.`);
  }
  if (filings.length) parts.push(filings.map((a) => filingBlock(env, a, f)).join('\n\n'));
  const now = events.filter((e) => !e.late);
  const late = events.filter((e) => e.late);
  if (now.length) parts.push(`Between-quarter moves:\n${now.map((e) => eventLine(env, e, f)).join('\n')}`);
  if (late.length) parts.push(`Earlier filings you may have missed (accepted by EDGAR more than 6 hours before we could alert):\n${late.map((e) => eventLine(env, e, f)).join('\n')}`);
  return `${parts.join('\n\n')}\n\nChoose whom you follow and how you get alerts at ${env.SITE_URL}account/.${FOOTER}`;
}

/** A filing's header name: the site's display name, else EDGAR's manager with its filer name when they differ. */
const filerLabel = (a: Alert13F) => siteName(a.slug) ?? `${a.manager}${a.name && a.name !== a.manager ? ` (${a.name})` : ''}`;

/** One alert as a subject line: "Buffett Q3: NEW DHI · EXIT STZ · GOOGL +$8.8B". */
function filingHeadline(a: Alert13F, firm = false): string {
  const q = /^\d{4}Q[1-4]$/.test(a.quarter) ? `Q${a.quarter[5]}` : a.quarter;
  // The site's name when it has one (\"Kahn Brothers\", \"Berkshire Hathaway (Warren Buffett)\"; firm-first: \"Berkshire Hathaway\").
  const who = (firm ? siteFirm(a.slug) : siteName(a.slug)) ?? (firm ? a.manager : shortName(a.manager));
  if (a.reveal) {
    const r = a.reveal.rows[0];
    const what = `${rowName(r)} (${[usd(r.value, false), bookPct(r) && `${bookPct(r)} of book`].filter(Boolean).join(', ')})${a.reveal.rows.length > 1 ? ` + ${a.reveal.rows.length - 1} more` : ''}`;
    return a.reveal.confidential ? `${who} revealed ${what}, previously confidential` : `${who} added ${what} to its ${q} 13F`;
  }
  // Held rows have no figures to rank, so any of them may be the largest move: the subject says they're coming.
  // Only rows still to come; a line not counted (unreliable share count) is no move to wait for.
  const pend = (a.held ?? []).filter((h) => h.reason !== 'unreliable_shares').length;
  const held = pend ? ` +${pend} pending check` : '';
  if (a.moves) return `${who} ${q}${a.followup ? ' changes' : ''}: ${headlineMoves(a.moves) || (held ? 'moves' : 'no position changes')}${held}`;
  return `${who} filed its ${q} 13F`;
}

/** "Icahn CVI 13D/A: 70.8% → 64.1% (diluted, no shares sold)"; "Buffett LEN Form 4: bought $192.6M". */
export function eventHeadline(e: AlertEvent, firm = false): string {
  const who = (firm ? siteFirm(e.slug) : siteName(e.slug)) ?? (firm ? e.manager || 'A filer' : shortName(e.manager || 'A filer'));
  const what = e.ticker || e.display_name || e.issuer || '';
  const form = e.kind === 'form4' ? 'Form 4' : `${e.kind === '13d' ? '13D' : '13G'}${/\/A$/.test(e.form) ? '/A' : ''}`;
  const head = `${who}${what ? ` ${what}` : ''} ${form}`;
  if (e.cluster) return `${what}: ${e.cluster.length} insiders bought ${usd(e.cluster.reduce((s, i) => s + i.bought_usd, 0), false)} in 30 days`;
  if (e.insider) return `${what} insider buy: ${e.insider.roles[0] ?? 'Insider'} ${titleName(e.insider.name)} bought ${usd(e.insider.bought_usd, false)}`;
  if (e.details_pending) return `${head} filed (details to follow)`;
  if (e.kind === 'form4') {
    const verb = e.action === 'buy' ? 'bought' : e.action === 'sell' ? 'sold' : e.action === 'mixed' ? 'bought and sold' : 'filed';
    return `${head}: ${verb}${e.value_usd ? ` ${usd(Math.abs(e.value_usd), false)}` : ''}`;
  }
  const pct = e.percent_of_class;
  if (pct == null) return `${head} filed`;
  const c = stakeChange(e);
  if (e.prev_percent_of_class != null) return `${head}: ${e.prev_percent_of_class}% → ${pct}%${c.note ? ` (${c.note})` : ''}`;
  return `${head}: ${e.action === 'new_stake' ? `new ${pct}% stake` : `${pct}%`}`;
}

export function alertMail(env: Env, to: string, filings: Alert13F[], events: AlertEvent[], f: Follows, m?: Member): Mail {
  const heads = [...filings.map((a) => filingHeadline(a)), ...events.map((e) => eventHeadline(e))];
  const subject = `${heads[0]}${heads.length > 1 ? ` + ${heads.length - 1} more` : ''}`;
  const intro = 'New filings from managers and stocks you follow:';
  return { to, subject, text: body(env, intro, filings, events, f, m), html: htmlBody(env, intro, filings, events, f, m) };
}

export function digestMail(env: Env, to: string, day: string, filings: Alert13F[], events: AlertEvent[], f: Follows, m?: Member, lateOnly = false): Mail {
  if (lateOnly) {
    const intro = 'Filings from managers and stocks you follow that EDGAR accepted too long ago to send as news:';
    return { to, subject: `Copybook: ${events.length} earlier filing${events.length === 1 ? '' : 's'} you may have missed`, text: body(env, intro, [], events, f), html: htmlBody(env, intro, [], events, f) };
  }
  const n = [filings.length && `${filings.length} 13F${filings.length === 1 ? '' : 's'}`, events.length && `${events.length} Form 4/13D/G`].filter(Boolean).join(', ');
  const intro = `Today's filings from managers and stocks you follow (${day}):`;
  return { to, subject: `Copybook daily digest for ${day}: ${n}`, text: body(env, intro, filings, events, f, m), html: htmlBody(env, intro, filings, events, f, m) };
}

/**
 * Saturday's "Your names this week" for paying members (paused ones too): each 13F from a followed fund with its three
 * largest trades and filing card, and each Form 4 and 13D/G on followed funds and names, one line each.
 */
export function weeklyNamesMail(env: Env, to: string, weekOf: string, filings: Alert13F[], events: AlertEvent[], f: Follows, pausedUntil: number | null): Mail {
  const top3 = (a: Alert13F) =>
    MOVE_LABELS.flatMap(([label, k]) => (a.moves?.[k] ?? []).map((r) => ({ label, r })))
      .filter(({ r }) => !r.unreliable)
      .sort((x, y) => Math.abs(y.r.value_delta) - Math.abs(x.r.value_delta))
      .slice(0, 3)
      .map(({ label, r }) => `${label.toLowerCase()} ${rowName(r)} ${usd(r.value_delta)}`)
      .join(', ');
  const fl = filings.map((a) => ({ head: `${filerLabel(a)}, ${quarterLabel(a.quarter)} 13F`, moves: a.moves ? top3(a) : '', url: filingUrl(env, a) }));
  const ev = events.map((e) => ({ head: eventHeadline(e, true), url: e.url }));
  const n = [fl.length && `${fl.length} 13F${fl.length === 1 ? '' : 's'}`, ev.length && `${ev.length} Form 4/13D/G`].filter(Boolean).join(', ');
  const paused = pausedUntil ? `Your plan is paused; alerts resume ${new Date(pausedUntil * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })}. This weekly summary keeps coming meanwhile.` : '';
  const following = `You follow ${f.investors.length} fund${f.investors.length === 1 ? '' : 's'} and ${f.stocks.length} stock${f.stocks.length === 1 ? '' : 's'}. Change them: ${env.SITE_URL}account/`;
  const off = `Turn off this weekly summary on ${env.SITE_URL}account/ (Email settings).`;
  const quiet = `A quiet week: none of your funds or names filed a 13F, Form 4 or 13D/G.`;
  const text = [
    `Your names this week (week of ${weekOf}):`,
    ...(paused ? [paused] : []),
    ...(fl.length ? ['13F filings:', ...fl.map((x) => `- ${x.head}${x.moves ? `: ${x.moves}` : ''}\n  ${x.url}`)] : []),
    ...(ev.length ? ['Form 4 and 13D/G:', ...ev.map((x) => `- ${x.head}\n  ${x.url}`)] : []),
    ...(fl.length || ev.length ? [] : [quiet]),
    following,
    off,
  ].join('\n\n') + FOOTER;
  const li = (head: string, more: string, url: string) => `<li style="margin:6px 0">${esc(head)}${more ? `: ${esc(more)}` : ''} · ${link(url, 'See it')}</li>`;
  const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:640px"><p><b>Your names this week</b> (week of ${esc(weekOf)})</p>${paused ? `<p>${esc(paused)}</p>` : ''}${fl.length ? `<h3 style="font-size:15px;margin:16px 0 4px">13F filings</h3><ul style="padding-left:18px;margin:0">${fl.map((x) => li(x.head, x.moves, x.url)).join('')}</ul>` : ''}${ev.length ? `<h3 style="font-size:15px;margin:16px 0 4px">Form 4 and 13D/G</h3><ul style="padding-left:18px;margin:0">${ev.map((x) => li(x.head, '', x.url)).join('')}</ul>` : ''}${fl.length || ev.length ? '' : `<p>${esc(quiet)}</p>`}<p style="margin-top:18px">You follow ${f.investors.length} fund${f.investors.length === 1 ? '' : 's'} and ${f.stocks.length} stock${f.stocks.length === 1 ? '' : 's'}. ${link(`${env.SITE_URL}account/`, 'Change them')}.</p><p style="color:#6b7280;font-size:12px;margin-top:24px">${link(`${env.SITE_URL}account/`, 'Turn off this weekly summary')} (Email settings). Source: SEC EDGAR filings, as filed. Not investment advice. Copybook by Factor Dynamics.</p></div>`;
  return { to, subject: `Your names this week: ${n || 'a quiet week'}`, text, html };
}

// ---------------------------------------------------------------------------------------------
// HTML: the same alert as tables

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const TD = 'padding:4px 10px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top';
const TDR = `${TD};text-align:right;font-variant-numeric:tabular-nums`;
const link = (href: string, text: string) => `<a href="${esc(href)}" style="color:#1d4ed8">${esc(text)}</a>`;

function table(head: string[], rows: string[][], right: number[] = []): string {
  const th = head.map((h, i) => `<th style="${right.includes(i) ? TDR : TD};font-weight:600;color:#6b7280;font-size:12px">${esc(h)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td style="${right.includes(i) ? TDR : TD}">${c}</td>`).join('')}</tr>`).join('');
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:14px;margin:6px 0 4px">${th ? `<tr>${th}</tr>` : ''}${tr}</table>`;
}

const meta = (page: string | null, accession: string, accepted: string | undefined, sec: string, label = 'Copybook page') =>
  `<p style="margin:4px 0 18px;font-size:12px;color:#6b7280">Accession ${esc(accession)}${accepted ? `, accepted by EDGAR ${esc(acceptedUtc(accepted))}` : ''} · ${page ? `${link(page, label)} · ` : ''}${link(sec, 'SEC filing')}</p>`;

function filingHtml(env: Env, a0: Alert13F, f: Follows): string {
  const a = withCounted(a0);
  const out = [`<h3 style="margin:16px 0 2px;font-size:16px">${esc(siteName(a.slug) ?? a.manager)}${!siteName(a.slug) && a.name && a.name !== a.manager ? ` <span style="color:#6b7280;font-weight:400">(${esc(a.name)})</span>` : ''}: ${esc(quarterLabel(a.quarter))} 13F${a.reveal ? ' amendment (new holdings)' : a.followup ? ' position changes' : ''}</h3>`];
  const mv = a.moves;
  if (a.reveal) {
    out.push(`<p style="margin:2px 0">${a.reveal.confidential ? `Positions held at ${esc(a.report_date)} that were kept confidential until now:` : `Positions added to the ${esc(a.report_date)} book:`}</p>`);
    out.push(table(['Stock', 'Shares', 'Value', '% of book'], a.reveal.rows.map((r) => [`<b>${esc(rowName(r))}</b>${esc(flag(r.ticker, f))}`, r.shares.toLocaleString('en-US'), usd(r.value, false), bookPct(r)]), [1, 2, 3]));
  } else if (mv) {
    out.push(`<p style="margin:2px 0">Bought ${usd(mv.bought_usd, false)}, sold ${usd(mv.sold_usd, false)} this quarter.</p>`);
    const rows = MOVE_LABELS.flatMap(([label, k]) => mv[k].map((r) => [esc(label), `<b>${esc(rowName(r))}</b>${esc(flag(r.ticker, f))}${misfiled(r) ? `<br><span style="color:#6b7280;font-size:12px">${esc(misfiledNote(a, r).slice(2))}</span>` : ''}${r.unusual ? `<br><span style="color:#b45309;font-size:12px">${UNUSUAL}</span>` : ''}${r.filer_value && r.unreliable !== 'value' ? `<br><span style="color:#b45309;font-size:12px">${esc(FILER_VALUE)}</span>` : ''}${unreliableNote(r) ? `<br><span style="color:#b45309;font-size:12px">${esc(unreliableNote(r))}</span>` : ''}`, amount(r), `<span style="white-space:nowrap">${esc(positionChange(label, r))}</span>`, r.unreliable === 'value' ? '' : bookPct(r)]));
    out.push(table(['Move', 'Stock', 'Value change', 'Position', 'Trade, % of book'], rows, [2, 4]));
    for (const r of mv.exchanged ?? []) out.push(`<p style="margin:6px 0 2px">${esc(exchangeLine(r))}</p>`);
    if (a.held?.length || a.moves?.not_counted?.length) out.push(`<p style="margin:6px 0 2px;color:#b45309">${esc(heldLine(a))}</p>`);
    const mine = yourMoves(a, f);
    if (mine.length) out.push(`<p style="margin:6px 0 2px"><b>In your names:</b> ${mine.map((r) => `${esc(rowName(r))} ${esc(yourLine(r))} (${f.owned.includes(r.ticker!) ? 'you own' : 'watchlist'})`).join('; ')}</p>`);
  } else if (a.top?.length) {
    out.push('<p style="margin:2px 0">No earlier quarter on file for this filer, so no changes yet. Largest holdings:</p>');
    out.push(table(['Stock', 'Value'], a.top.map((r) => [`<b>${esc(rowName(r))}</b>${esc(flag(r.ticker, f))}`, usd(r.value, false)]), [1]));
  } else {
    out.push(`<p style="margin:2px 0">${a.moves_pending || !a.extra ? 'Position changes follow in a second email within minutes.' : 'Holdings are on the filer page.'}</p>`);
  }
  out.push(meta(a.slug ? filingUrl(env, a) : null, a.accession, a.accepted, a.sec_url, a.card ? 'Filing card' : 'Copybook page'));
  return out.join('');
}

function eventHtml(env: Env, e: AlertEvent, f: Follows): string {
  const parts = [`<h3 style="margin:16px 0 2px;font-size:16px">${esc(eventHeadline(e))}${esc(flag(e.ticker, f))}</h3>`];
  if (e.cluster) {
    parts.push(table(['Insider', 'Role', 'Filed', 'Bought'], clusterRows(e).map((r) => r.map(esc)), [3]));
    parts.push(`<p style="margin:4px 0 18px;font-size:12px;color:#6b7280">Open-market purchases (Form 4 code P) in the last 30 days · ${link(e.url, 'latest filing')}</p>`);
    return parts.join('');
  }
  if (e.insider) parts.push(`<p style="margin:2px 0">${esc(titleName(e.insider.name))}, ${esc(e.insider.roles.join(', '))} of ${esc(e.issuer ?? '')}, bought on the open market.</p>`);
  if (e.details_pending) parts.push('<p style="margin:2px 0">Details follow once the filing is processed.</p>');
  if (e.kind === 'form4') {
    // One row per share class: Class A and Class B are separate securities.
    const rows = (e.classes ?? []).map((c) => {
      const chg = c.shares_before && c.shares_after != null ? `${c.shares_after >= c.shares_before ? '+' : ''}${(((c.shares_after - c.shares_before) / c.shares_before) * 100).toFixed(1)}%` : '';
      return [esc(c.security), c.bought ? n(c.bought) : '—', c.sold ? n(c.sold) : '—', c.shares_before != null ? n(c.shares_before) : '', c.shares_after != null ? n(c.shares_after) : '', chg];
    });
    if (rows.length) parts.push(table(['Class', 'Bought', 'Sold', 'Held before', 'Held after', 'Change'], rows, [1, 2, 3, 4, 5]));
    if (e.value_usd && !e.details_pending) parts.push(`<p style="margin:2px 0">${usd(Math.abs(e.value_usd), false)}${e.avg_price ? ` at an average $${e.avg_price.toFixed(2)}` : ''}</p>`);
  } else {
    const c = stakeChange(e);
    if (c.line) {
      const prev = e.prev_percent_of_class;
      const stake = [
        ['% of class', prev != null ? `${prev}% → ${e.percent_of_class}%` : `${e.percent_of_class}%`],
        ['Shares', e.prev_shares_after != null && e.shares_after != null ? `${e.prev_shares_after.toLocaleString('en-US')} → ${e.shares_after.toLocaleString('en-US')}` : (e.shares_after?.toLocaleString('en-US') ?? '')],
        ...(c.note ? [['What changed', c.note]] : []),
        ...(e.amendment_no ? [['Amendment', String(e.amendment_no)]] : []),
      ];
      parts.push(table([], stake.map(([k, v]) => [`<span style="color:#6b7280">${esc(k)}</span>`, esc(v)])));
    }
    if (e.item4) parts.push(`<p style="margin:4px 0;font-size:13px"><b>Purpose (Item 4):</b> ${esc(cleanItem4(e.item4) ?? '')}</p>`);
  }
  for (const fn of (e.footnotes ?? []).slice(0, 3)) parts.push(`<p style="margin:2px 0;font-size:12px;color:#4b5563">Footnote: ${esc(fn.length > 240 ? `${fn.slice(0, 240)}…` : fn)}</p>`);
  parts.push(meta(e.slug ? `${env.SITE_URL}investors/${e.slug}` : null, e.id, e.accepted, e.url));
  return parts.join('');
}

function htmlBody(env: Env, intro: string, filings: Alert13F[], events: AlertEvent[], f: Follows, m?: Member): string {
  const parts = [`<p style="margin:0 0 8px">${esc(intro)}</p>`];
  if (m?.alerts_note === 'followed') parts.push(`<p style="padding:8px 10px;background:#fef9c3">Alert change: you now get alerts only for the ${f.investors.length} fund${f.investors.length === 1 ? '' : 's'} you follow, plus active managers' moves in stocks you own or watch. To get every curated fund again, choose "Every investor" in ${link(`${env.SITE_URL}account/`, 'alert settings')}.</p>`);
  parts.push(...filings.map((a) => filingHtml(env, a, f)));
  const now = events.filter((e) => !e.late);
  const late = events.filter((e) => e.late);
  if (now.length) parts.push('<h2 style="font-size:15px;margin:20px 0 0;color:#374151">Between-quarter moves</h2>', ...now.map((e) => eventHtml(env, e, f)));
  if (late.length) parts.push('<h2 style="font-size:15px;margin:20px 0 0;color:#374151">Earlier filings you may have missed (accepted by EDGAR more than 6 hours before we could alert):</h2>', ...late.map((e) => eventHtml(env, e, f)));
  parts.push(`<p style="margin-top:24px;font-size:12px;color:#6b7280">Choose whom you follow and how you get alerts at ${link(`${env.SITE_URL}account/`, 'your account')}.<br>Source: SEC EDGAR filings (13F-HR, Form 4, Schedules 13D and 13G), as filed. Not investment advice.<br>Copybook by Factor Dynamics.</p>`);
  return `<!doctype html><html><body style="margin:0;padding:16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111827;max-width:680px">${parts.join('')}</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Holdterm: a separate brand on this Worker. Its own designed mail (holdterm/src/alert-render.ts), never naming Copybook.

export const HOLDTERM_FROM = 'Holdterm <holdterm@factordynamics.com>';
const htSite = (env: Env) => env.HOLDTERM_SITE_URL ?? 'https://holdterm.factordynamics.com/';

/** Holdterm's designed sign-in and welcome email (alert-render.ts, what its pages preview), with the text alternative. */
export function holdtermLoginMail(env: Env, to: string, token: string, welcome: boolean): Mail {
  const link = `${htSite(env)}account?login=${encodeURIComponent(token)}`;
  return { to, from: HOLDTERM_FROM, ...htLoginEmail(link, welcome, htSite(env)) };
}

/**
 * Holdterm's designed alert email (alert-render.ts htEmail, what /alerts previews; the lead, Nov 11), HTML with the
 * plain-text alternative. Holdterm leads with the firm ("Berkshire Hathaway"), never the person, and links funds by their
 * public slug (no redirect hop).
 */
export function holdtermAlertMail(env: Env, to: string, allFilings: Alert13F[], allEvents: AlertEvent[]): Mail {
  const filings = allFilings.map((a0) => {
    const a = withCounted(a0);
    return { ...a, slug: publicSlug(a.slug), manager: firmName(a.slug, a.name || a.manager) } as HtFiling;
  });
  const events = allEvents.map((e) => ({ ...e, slug: publicSlug(e.slug ?? ''), manager: e.manager ? firmName(e.slug ?? '', e.manager) : e.manager }) as HtEvent);
  return { to, from: HOLDTERM_FROM, ...htEmail(filings, events, htSite(env)) };
}

// ---------------------------------------------------------------------------------------------
// Chat (Discord, Slack, Telegram) and the private feed: the same alert, as plain text.

/** One message with every alert in this delivery: the headline, then the details and links. */
export function chatText(env: Env, filings: Alert13F[], events: AlertEvent[], f: Follows): string {
  const blocks = [
    ...filings.map((a) => `${filingHeadline(a)}\n${filingBlock(env, a, f).split('\n').slice(1).join('\n')}`),
    ...events.map((e) => `${eventHeadline(e)}\n${eventLine(env, e, f)}`),
  ];
  return `${blocks.join('\n\n')}\n\nCopybook · SEC EDGAR filings, as filed. Not investment advice.`;
}

export interface FeedItem {
  id: string;
  title: string;
  text: string;
  url: string;
  /** EDGAR acceptance. */
  published: string;
  /** When Copybook sent the alert. */
  sent?: string;
  /** A "Send a test" item, not an alert. */
  test?: boolean;
}

/** Feed entries for this delivery, one per filing; ids are stable so a follow-up gets its own entry. */
export function feedItems(env: Env, filings: Alert13F[], events: AlertEvent[], now: number, seeded = false): FeedItem[] {
  const none: Follows = { investors: [], stocks: [], owned: [], peers: [], onboarded: true, include_13g: false, digest: false, insider_buys: true, insider_min_usd: 0, cluster_buys: true, any_13d: true };
  // A live item was sent now. A seeded one (an older alert in a new feed) keeps when it was sent, else
  // EDGAR's acceptance, else its filing day, so readers don't show it as new.
  const sentAt = (x: { sent_at?: string; accepted?: string; filing_date: string }) => x.sent_at ?? (seeded ? (x.accepted ?? `${x.filing_date}T21:00:00Z`) : new Date(now).toISOString());
  return [
    ...filings.map((a) => ({ id: `${filingId(a)}`, title: `${a.corrected ? 'Corrected · ' : ''}${filingHeadline(a)}`, text: `${filingBlock(env, a, none)}${a.corrected ? `\n  ${correctedNote(a)}` : ''}`, url: filingUrl(env, a), published: a.accepted ?? sentAt(a), sent: sentAt(a) })),
    ...events.map((e) => ({ id: `${e.id}${e.followup ? ':details' : ''}`, title: eventHeadline(e), text: eventLine(env, e, none), url: e.slug ? `${env.SITE_URL}investors/${e.slug}` : e.url, published: e.accepted ?? sentAt(e), sent: sentAt(e) })),
  ];
}
