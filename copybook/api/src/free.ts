/**
 * Free accounts: POST /signup makes a member with no card and no Stripe customer, who gets one email a
 * week (Friday evening, after EDGAR closes) with the week's biggest superinvestor buys and sells and
 * never a real-time alert. Every paid route treats them as inactive. Plus the one unsubscribe link
 * that every marketing and lifecycle email carries.
 */
import type { Alert13F } from './alerts';
import { siteFirm, siteName } from './names';
import { FOOTER, followFiling, previewInbox, sendMail, type Mail } from './email';
import { deadlineLabel, nextDeadline } from './seasons';
import { firmName } from '../../../holdterm/src/names';
import { followCounts, testAddress, WORKER_URL, type Env, type Member } from './env';
import { checkMove, countedMoves, displayCase, type MoveRow, netRenamed, reissuedTicker, UNUSUAL } from './edgar';
import { changeFollows, type Follows, getFollows, getMember, listMembers, LOGIN_TTL, memberByEmail, putMember } from './members';
import { bump } from './revenue';
import { signToken, verifyToken } from './tokens';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const etDay = (t: number) => new Date(t - 5 * 3600_000).toISOString().slice(0, 10);


/** One link that stops the weekly and lifecycle email for this member (alerts and billing email still come). */
export async function unsubscribeUrl(env: Env, customer: string): Promise<string> {
  const t = encodeURIComponent(await signToken(env.SESSION_SECRET, 'unsub', customer, 3 * 365 * 86400));
  // The site's /unsubscribe/ page once it's live (it asks, then posts to the Worker); until then the Worker's own page.
  // The List-Unsubscribe header always goes to the Worker (email.ts oneClick).
  return (await siteHas(env, 'unsubscribe/')) ? `${env.SITE_URL}unsubscribe/?t=${t}` : `${WORKER_URL}/unsubscribe?t=${t}`;
}

/** Whether the site serves a page (checked at most hourly per isolate): links switch to it once the front end ships it. */
const SITE_PAGES = new Map<string, { at: number; ok: boolean }>();
export async function siteHas(env: Env, page: string): Promise<boolean> {
  const c = SITE_PAGES.get(page);
  if (c && Date.now() - c.at < 3600_000) return c.ok;
  const ok = await fetch(`${env.SITE_URL}${page}`, { method: 'HEAD', signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
  SITE_PAGES.set(page, { at: Date.now(), ok });
  return ok;
}

const isTest = (email: string) => email.startsWith('copybook-test-');

type Json = Record<string, unknown>;
type Reply = { status: number; body: Json; headers?: Record<string, string> };

/** What happened to each requested follow: stored, already followed, or refused at the free cap. */
type FollowResult = 'added' | 'already' | 'cap_reached';

/**
 * What became of an account email: sent; queued (Resend refused it, e.g. its daily quota: it retries every minute and
 * goes out once Resend accepts, at the latest after the 00:00 UTC reset); test_inbox (a test address, launch week).
 */
function mailState(status: string): { state: 'sent' | 'queued' | 'test_inbox' | 'not_sent'; send_at?: string } {
  if (status === '200') return { state: 'sent' };
  if (status === 'sunk') return { state: 'test_inbox' };
  if (/\b(429|5\d\d)\b/.test(status)) {
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0);
    return { state: 'queued', ...(/429/.test(status) ? { send_at: next.toISOString().replace(/\.\d{3}Z$/, 'Z') } : {}) };
  }
  return { state: 'not_sent' };
}

/** /signup tries an hour, signed out: per email, and per IP (mobile carriers put many people behind one address). */
export const SIGNUP_PER_EMAIL = 5;
export const SIGNUP_PER_IP = 30;

/** `signedIn`: the member a valid session on this request belongs to (the site sends it when signed in). */
export async function handleSignup(env: Env, b: Json, ip: string, signedIn?: string): Promise<Reply> {
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { status: 400, body: { ok: false, error: 'Check the email address and try again.', code: 'bad_request' } };
  // The hidden `website` field: a bot filled it. Looks like success, does nothing.
  if (str(b.website, 200)) return { status: 200, body: { ok: true } };
  // Signed in: the session is the proof, no limit. Otherwise fixed hourly windows, per email and (looser, for carrier
  // IPs shared by many phones) per IP. Both are checked before either counts, and a refused try counts nowhere, so
  // retrying never extends the wait; Retry-After is the window's own end.
  const me = signedIn ? await getMember(env, signedIn) : null;
  if (me?.email !== email) {
    const t = Date.now();
    const wins = await Promise.all(
      ([[`rl:su-em:${email}`, SIGNUP_PER_EMAIL], [`rl:su-ip:${ip}`, SIGNUP_PER_IP]] as const).map(async ([k, max]) => {
        const w = JSON.parse((await env.DB.get(k)) ?? 'null') as { n: number; until: number } | null;
        return { k, max, w: w && w.until > t ? w : { n: 0, until: t + 3600_000 } };
      }),
    );
    const full = wins.filter((x) => x.w.n >= x.max);
    if (full.length) {
      const wait = Math.max(1, Math.ceil((Math.max(...full.map((x) => x.w.until)) - t) / 1000));
      const mins = Math.ceil(wait / 60);
      // already_member: the page can say "You're already signed up; use the link we emailed".
      const known = await memberByEmail(env, email);
      const already = !!known && known.status !== 'canceled';
      return {
        status: 429,
        body: { ok: false, error: `Too many tries. Please try again in ${mins} minute${mins === 1 ? '' : 's'}.`, code: 'rate_limited', retry_after: wait, retry_after_seconds: wait, retry_at: new Date(t + wait * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), already_member: already },
        headers: { 'retry-after': String(wait), 'access-control-expose-headers': 'retry-after' },
      };
    }
    for (const { k, w } of wins) await env.DB.put(k, JSON.stringify({ n: w.n + 1, until: w.until }), { expirationTtl: Math.max(60, Math.ceil((w.until - t) / 1000)) });
  }
  const utm = Object.fromEntries(UTM.map((k) => [k, str(b[k], 100)]).filter(([, v]) => v)) as Record<string, string>;
  const source = str(b.source, 60) ?? utm.utm_source ?? null;
  // A filer page's "Follow to get it by email": an investor slug, kept on the free member; its moves lead the Friday email.
  // `follow`: an array (one object accepted too) of { kind: investor, id: slug } or { kind: stock, id: ticker }, at most 10.
  const raw = b.follow === undefined || b.follow === null ? [] : Array.isArray(b.follow) ? b.follow : [b.follow];
  const follows = raw.map((x) => (x && typeof x === 'object' ? (x as Json) : {})).map((x) =>
    x.kind === 'investor' && typeof x.id === 'string' && /^[a-z0-9-]{1,80}$/.test(x.id) ? { list: 'investors' as const, value: x.id }
    : x.kind === 'stock' && typeof x.id === 'string' && /^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(x.id) ? { list: 'stocks' as const, value: x.id.toUpperCase().replace('-', '.') }
    : null);
  if (follows.some((x) => !x) || follows.length > 10) return { status: 400, body: { ok: false, error: 'follow: up to 10 of { kind: "investor", id: "<slug>" } or { kind: "stock", id: "<ticker>" }', code: 'bad_request' } };
  const follow = follows.length > 0;
  // Each follow's own result: one refused at the cap is never reported as added, even next to a repeat follow.
  const addFollows = async (m: Member) => {
    const before = await getFollows(env, m);
    const results: FollowResult[] = [];
    for (const x of follows) {
      if (before[x!.list].includes(x!.value)) {
        results.push('already');
        continue;
      }
      const r = await changeFollows(env, m, { add: { list: x!.list, value: x!.value, max: FREE_INVESTORS } });
      results.push(r.ok ? 'added' : 'cap_reached');
    }
    const dropped = follows.filter((_, i) => results[i] === 'cap_reached').map((x) => ({ kind: x!.list === 'investors' ? 'investor' : 'stock', id: x!.value }));
    // follow: cap_reached when any was refused (the sheet says so), else added (or already, when nothing was new).
    return { following: results.some((r) => r !== 'cap_reached'), follow: dropped.length ? 'cap_reached' : results.includes('added') ? 'added' : 'already', ...(dropped.length ? { limit: FREE_INVESTORS, dropped } : {}) };
  };
  const cur = await memberByEmail(env, email);
  // Already a member: nothing to create. A free member's follows are added; signed in, that's all. Signed out, they get
  // a sign-in link saying the follow was saved, at most one an hour. A paying member's follows change only when
  // signed in to Copy, so they are asked to follow there.
  if (cur && cur.status !== 'canceled') {
    // A paying member: the same neutral answer whether or not the address has an account (no enumeration), and a Copy
    // sign-in link by email under the 15-minute rule (the trader's 11:56 resubmit got nothing at all).
    if (cur.status !== 'free') {
      const k = `rl:signin-mail:${cur.customer}`;
      const last = signedIn === cur.customer ? 'signed-in' : await env.DB.get(k);
      if (!last) {
        await env.DB.put(k, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), { expirationTtl: 15 * 60 });
        const { loginMail, holdtermLoginMail } = await import('./email');
        const { LOGIN_REQUEST_TTL } = await import('./members');
        const token = await signToken(env.SESSION_SECRET, 'login', cur.customer, LOGIN_REQUEST_TTL);
        await sendMail(env, [cur.plan === 'holdterm' ? holdtermLoginMail(env, cur.email, token, false) : loginMail(env, cur.email, token, false)]);
      }
      return { status: 200, body: { ok: true, sign_in_email: 'sent_if_member', ...(follow ? { following: false, follow: 'sign_in' } : {}) } };
    }
    const r = follow ? await addFollows(cur) : null;
    let signIn: 'sent' | 'not_needed' | 'rate_limited' | 'already_sent' | 'queued' | 'test_inbox' | 'not_sent' = 'not_needed';
    let sentAt: string | null = null;
    let sendAt: string | undefined;
    if (signedIn !== cur.customer) {
      // One welcome or sign-in email an hour per address: a resubmit within 15 minutes of the last one is
      // `already_sent` (with when), later in the hour `rate_limited`. Older markers hold '1' (no time).
      const k = `rl:signin-mail:${cur.customer}`;
      const last = await env.DB.get(k);
      if (last) {
        sentAt = last === '1' ? null : last;
        signIn = sentAt && Date.now() - Date.parse(sentAt) < 15 * 60_000 ? 'already_sent' : 'rate_limited';
      } else {
        sentAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        await env.DB.put(k, sentAt, { expirationTtl: 3600 });
        const st = mailState(await sendMail(env, [await freeWelcomeMail(env, cur, false, r?.follow === 'added')]));
        signIn = st.state;
        sendAt = st.send_at;
      }
    }
    return { status: 200, body: { ok: true, sign_in_email: signIn, ...(sentAt ? { sent_at: sentAt } : {}), ...(sendAt ? { send_at: sendAt } : {}), ...(r ?? {}) } };
  }
  const m: Member = {
    customer: await freeId(email),
    email,
    status: 'free',
    plan: 'free',
    interval: 'unknown',
    period_end: 0,
    subscription: '',
    alerts: 'off',
    source,
    ...(Object.keys(utm).length ? { utm } : {}),
    created_at: new Date().toISOString(),
  };
  await putMember(env, m);
  const r = follow ? await addFollows(m) : null;
  if (!isTest(email)) await bump(env, 'signups', m);
  const mail = mailState(await sendMail(env, [await freeWelcomeMail(env, m, true)]));
  // The welcome carries a sign-in link: a resubmit within the hour gets no second email.
  const sentAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  await env.DB.put(`rl:signin-mail:${m.customer}`, sentAt, { expirationTtl: 3600 });
  // Signed in on this device at once, whatever the email does: a provisional session, good until the member first signs
  // in by an emailed link or subscribes (then the link or checkout gives a full one). Only for an account made just now,
  // so typing someone else's address never signs anyone into an existing account.
  const { PROVISIONAL_TTL } = await import('./members');
  // A cancelled member's address had an account: no session, only the email.
  const session = cur ? null : { token: await signToken(env.SESSION_SECRET, 'session', m.customer, PROVISIONAL_TTL, { s: 'provisional' }), session: 'provisional' };
  return {
    status: 201,
    body: { ok: true, created: true, welcome: mail.state, sign_in_email: mail.state, sent_at: sentAt, ...(mail.send_at ? { send_at: mail.send_at } : {}), ...session, ...(r ?? {}) },
  };
}

async function freeWelcomeMail(env: Env, m: Member, first: boolean, followSaved = false): Promise<Mail> {
  const link = `${env.SITE_URL}account/?login=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'login', m.customer, LOGIN_TTL))}`;
  const unsub = await unsubscribeUrl(env, m.customer);
  // What they follow, and when it comes: "You follow Irving Kahn: the Q3 13F is expected Thu Nov 12, and its moves come in Friday's email."
  const f = await getFollows(env, m);
  const lines: string[] = [];
  if (f.investors.length) {
    const ctx = await followContext(env, f.investors);
    for (const s of f.investors) lines.push(`You follow ${followLine(ctx, s, Date.now()).welcome}`);
  }
  if (f.stocks.length) lines.push(`You follow ${f.stocks.join(', ')}: superinvestors' moves in ${f.stocks.length === 1 ? 'it' : 'them'} come in Friday's email.`);
  const following = lines.length ? `${lines.join('\n')}\n\n` : '';
  return {
    to: m.email,
    subject: first ? "You're on the Copybook weekly" : followSaved ? 'Follow saved. Your Copybook sign-in link' : 'Your Copybook sign-in link',
    text: `${following}${first ? "You're signed up for the Copybook weekly: every Friday evening, the week's biggest superinvestor buys and sells from their SEC filings, with a link to each filing." : "Here is your sign-in link. You're on the free Copybook weekly, every Friday evening."}\n\nSign in (link works for 7 days): ${link}\n\nWant each 13F from the funds you follow as it's filed, with 8 quarters of history (from 2024Q3) for the managers we track closely, and CSV? Copy · 14 days free · card required: ${env.SITE_URL}pricing/?utm_source=welcome&utm_medium=email&utm_campaign=13f-q3-2026&utm_content=welcome-paid\n\nUnsubscribe: ${unsub}${FOOTER}`,
    unsubscribe: unsub,
  };
}

/** GET shows a confirmation page; POST (and the mail client's one-click POST) unsubscribes at once. */
export async function handleUnsubscribe(env: Env, req: Request, url: URL): Promise<Response> {
  const page = (msg: string) =>
    new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Copybook</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#111">${msg}<p style="color:#6b7280;font-size:14px"><a href="${env.SITE_URL}" style="color:#1d4ed8">Copybook</a></p></body>`, { headers: { 'access-control-allow-origin': '*', 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  const t = url.searchParams.get('t') ?? '';
  const p = await verifyToken(env.SESSION_SECRET, t, 'unsub');
  const m = p && (await getMember(env, p.c));
  if (!m) return page('<p>This link has expired.</p>');
  if (req.method === 'GET' && url.searchParams.get('confirm') !== '1') {
    const what = m.status === 'free' ? 'the Copybook weekly' : "Copybook tips and newsletters (your filing alerts stay on, and we'll still email you before any charge)";
    return page(`<p>Unsubscribe ${m.email} from ${what}?</p><form method="post"><button style="font:inherit;padding:6px 14px">Unsubscribe</button></form>`);
  }
  if (!m.marketing_off) await putMember(env, { ...m, marketing_off: true });
  return page(`<p>Done: ${m.email} won't get ${m.status === 'free' ? 'the weekly' : 'tips or newsletters'} any more.</p>`);
}

// ---------------------------------------------------------------------------------------------
// The weekly email

export interface WeeklyMove {
  manager: string;
  slug: string;
  ticker: string;
  what: 'new' | 'added' | 'trimmed' | 'exited' | 'bought' | 'sold';
  usd: number;
  form: string;
  url: string;
  /** One of the curated superinvestors (index.json `featured`): ranked ahead of every other fund. */
  featured: boolean;
  accession: string;
  /** A real but unusually large move (over half the book, or a share-count break): tagged in the email. */
  unusual?: boolean;
}

/**
 * A position's value in a filer's prior-quarter book in R2 (curated h/, else the full book fb/), for a
 * card row whose size looks wrong: cards carry only this quarter's value. Books over 2 MB are skipped.
 */
async function priorValue(env: Env, slug: string, quarter: string, cusip: string | undefined, ticker: string): Promise<number | null> {
  try {
    let obj = await env.HIST.get(`h/${slug}/${quarter}.json`);
    if (!obj) {
      const cik = ((JSON.parse((await env.DB.get('v1:filers')) ?? '[]') as { slug: string; cik: string }[]).find((f) => f.slug === slug))?.cik;
      obj = cik ? await env.HIST.get(`fb/${quarter}/${cik}.json`) : null;
    }
    if (!obj || (obj.size ?? 0) > 2_000_000) return null;
    const d = (await new Response(obj.body).json()) as { holdings?: { cusip?: string; ticker?: string | null; put_call?: string | null; value: number }[]; columns?: string[]; rows?: unknown[][] };
    const rows = d.holdings ?? (d.columns && d.rows ? d.rows.map((r) => Object.fromEntries(d.columns!.map((c, i) => [c, r[i]])) as { cusip?: string; ticker?: string | null; put_call?: string | null; value: number }) : []);
    const hit = rows.filter((h) => !h.put_call && (cusip ? h.cusip === cusip : h.ticker === ticker));
    return hit.length ? hit.reduce((t, h) => t + Number(h.value), 0) : null;
  } catch {
    return null;
  }
}

/** A curated filer's Schedule 13D/G on a ticker, for "In your names". */
export interface WeeklyStake {
  manager: string;
  slug: string;
  ticker: string;
  form: string;
  pct: number | null;
  prev: number | null;
  url: string;
  featured: boolean;
  accession: string;
}

const money = (v: number) => {
  const a = Math.abs(v);
  return a >= 1e9 ? `$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : `$${Math.round(a / 1e3)}K`;
};

export interface Week {
  buys: WeeklyMove[];
  sells: WeeklyMove[];
  /** Every fund move of the week (13F rows and curated filers' Form 4 trades), for the per-member block. */
  all: WeeklyMove[];
  stakes: WeeklyStake[];
}

/** Index funds, ETF sponsors and broker-dealer flow: not what a superinvestor email is about. */
/** ETFs and index products held in a 13F ("iShares 20 Yr Tr Bd ETF"): index flow, not a pick. */
const FUND_SECURITY = /\b(etf|ishares|spdr|select sector|proshares|direxion|invesco qqq|vanguard|index)\b/i;
/** "Fisher Asset Management, LLC" reads as "Fisher Asset Management". */
const plainName = (n: string) => displayCase(n).replace(/,?\s+(llc|l\.?l\.?c\.?|l\.?p\.?|ltd\.?|limited|inc\.?|co\.?)$/i, '').trim();
const PASSIVE = /\b(vanguard|blackrock|ishares|state street|spdr|geode|dimensional|invesco|schwab|northern trust|index|etf|securities co|morgan stanley|barclays|deutsche bank|ubs|jpmorgan|goldman sachs|citigroup|bank of america|mitsubishi|mizuho|amundi|nomura|wells fargo|royal bank)\b/i;
/** Filing cards read per weekly run (each is a subrequest): the superinvestors' first, then other funds, newest first. */
const MAX_CARDS = 30;

/**
 * The 7 days before `now`: every 13F with a public filing card (its full new, added, trimmed and exited
 * lists) and every Form 4 and 13D/G by a curated filer (pre/events.json, the hourly events build).
 * Superinvestors rank first, each fund at most 2 rows, index and broker flow left out.
 */
export async function weeklyMoves(env: Env, now: number, days = 7, followed: Set<string> = new Set()): Promise<Week> {
  const since = now - days * 86400_000;
  const sinceDay = etDay(since);
  const get = async (url: string) => {
    try {
      const r = await fetch(url);
      return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const index = (await get(`${env.DATA_URL}index.json`)) as { managers?: { slug: string; featured?: boolean }[] } | null;
  const featured = new Set((index?.managers ?? []).filter((m) => m.featured).map((m) => m.slug));
  const investor = (slug: string) => `${env.SITE_URL}investors/${slug}/`;
  const all: WeeklyMove[] = [];
  const stakes: WeeklyStake[] = [];

  type Card = { accession: string; slug: string; quarter: string; filing_date: string };
  const cards = (((await get(`${env.SITE_URL}d/f/index.json`)) as { cards?: Card[] } | null)?.cards ?? [])
    .filter((c) => c.filing_date >= sinceDay)
    // Investors free members follow first (their moves lead those members' emails), then the superinvestors.
    .sort((a, b) => Number(followed.has(b.slug)) - Number(followed.has(a.slug)) || Number(featured.has(b.slug)) - Number(featured.has(a.slug)) || b.filing_date.localeCompare(a.filing_date))
    .slice(0, MAX_CARDS);
  type Row = { ticker: string | null; value_delta: number; put_call?: string | null; name?: string; cusip?: string; shares?: number; prev_shares?: number; unusual?: boolean };
  const read = await Promise.all(cards.map((c) => get(`${env.SITE_URL}d/f/${c.accession}.json`)));
  for (const [i, c] of cards.entries()) {
    // A card keeps its top 5 moves by size in `moves` (each with `change`); `changes` holds only counts.
    const d = read[i] as { manager?: string; firm?: string; featured?: boolean; total_value?: number; bought_usd?: number; sold_usd?: number; prev_quarter?: string; moves?: (Row & { change?: string; weight?: number; suspect_units?: boolean })[] } | null;
    if (!d) continue;
    const manager = plainName(d.manager ?? d.firm ?? c.slug);
    if (!d.featured && !featured.has(c.slug) && PASSIVE.test(`${manager} ${d.firm ?? ''}`)) continue;
    // The yardstick is the larger of the two books; the card has only this quarter's, so the prior one is
    // estimated as this book less what was bought plus what was sold (Scion's put exits from a book that shrank).
    const total = d.total_value ?? 0;
    const book = Math.max(total, total - (d.bought_usd ?? 0) + (d.sold_usd ?? 0)) || null;
    // One row per ticker: a CUSIP or class change shows as an exit plus a new position (Fisher's XOM),
    // so a fund's rows on one ticker are netted, and dropped when the holding is unchanged.
    const byTicker = new Map<string, Row & { change?: string; value?: number | null }>();
    // A reissued CUSIP's rows (XOM's Q3 30231G102 -> 30233Q108) take its ticker, so the exit and the new row net.
    for (const raw of (Array.isArray(d.moves) ? d.moves : []).map((x) => ({ ...x, ticker: x.ticker ?? reissuedTicker(x.cusip) }))) {
      // A line the data run marked (unreliable) is no trade, so it is never sized here.
      if (!raw.ticker || raw.put_call || (raw as { unreliable?: unknown }).unreliable || !['new', 'added', 'trimmed', 'exited'].includes(raw.change ?? '')) continue;
      const value = raw.weight != null && total ? raw.weight * total : null;
      // New and exited rows carry both values; an add or trim that looks too big reads the prior book.
      let prev_value: number | null = raw.change === 'new' ? 0 : raw.change === 'exited' ? -raw.value_delta : null;
      if (prev_value == null && value != null && (Math.abs(raw.value_delta) > 1.5 * value || (book && Math.abs(raw.value_delta) > 0.5 * total)) && d.prev_quarter)
        prev_value = await priorValue(env, c.slug, d.prev_quarter, raw.cusip, raw.ticker);
      // A value per share 5x off last quarter's: checked against other filers of the same CUSIP (GuardCap's Q3 BKNG).
      const ps = value && raw.shares ? value / raw.shares : null;
      const pps = prev_value && raw.prev_shares ? prev_value / raw.prev_shares : null;
      let median = {};
      if (ps && pps && raw.cusip && (ps / pps >= 5 || pps / ps >= 5)) {
        const { perShareMedians } = await import('./alerts');
        median = (await perShareMedians(env, [raw.cusip], c.quarter)).get(raw.cusip) ?? {};
      }
      const chk = checkMove({ ...raw, value, prev_value }, book, false, median);
      if (chk.verdict === 'drop') continue;
      const r = { ...raw, value, value_delta: chk.value_delta, unusual: chk.verdict === 'unusual' };
      const o = byTicker.get(r.ticker!);
      if (!o) byTicker.set(r.ticker!, r);
      else {
        const shares = (o.shares ?? 0) + (r.shares ?? 0);
        const prev = (o.prev_shares ?? 0) + (r.prev_shares ?? 0);
        // Share-based, at this quarter's price: summing the two deltas would count the price move as a trade
        // (Fisher's XOM: +$894.9M by value, +$75.7M by shares).
        const cur = (o.shares ? (o.value ?? 0) : 0) + (r.shares ? (r.value ?? 0) : 0);
        const usd = cur && shares ? Math.round(((shares - prev) * cur) / shares) : o.value_delta + r.value_delta;
        byTicker.set(r.ticker!, { ...o, shares, prev_shares: prev, value_delta: shares === prev ? 0 : usd, change: !prev ? 'new' : !shares ? 'exited' : usd > 0 ? 'added' : 'trimmed', unusual: o.unusual || r.unusual });
      }
    }
    for (const r of byTicker.values()) {
      const what = r.change as 'new' | 'added' | 'trimmed' | 'exited';
      if (!r.ticker || !r.value_delta || FUND_SECURITY.test(r.name ?? '')) continue;
      all.push({ manager, slug: c.slug, ticker: r.ticker, what, usd: r.value_delta, form: `13F ${c.quarter.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1')}`, url: `${env.SITE_URL}f/${c.accession}/`, featured: !!d.featured || featured.has(c.slug), accession: c.accession, ...(r.unusual ? { unusual: true } : {}) });
    }
  }

  const pre = await env.HIST.get('pre/events.json');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = pre ? (((await new Response(pre.body).json()) as { events?: unknown[] }).events ?? []) : [];
  for (const e of events) {
    const at = Date.parse(e.accepted ?? e.accepted_at ?? `${e.filing_date}T21:00:00Z`);
    if (!(at >= since && at <= now) || !e.slug || !e.ticker) continue;
    const isFeatured = featured.has(e.slug);
    if (!isFeatured && PASSIVE.test(e.manager ?? '')) continue;
    if (e.kind === 'form4' && e.value_usd && (e.action === 'buy' || e.action === 'sell')) {
      all.push({ manager: e.manager, slug: e.slug, ticker: e.ticker, what: e.action === 'buy' ? 'bought' : 'sold', usd: e.action === 'buy' ? e.value_usd : -e.value_usd, form: 'Form 4', url: investor(e.slug), featured: isFeatured, accession: e.id });
    } else if (e.kind === '13d' || e.kind === '13g') {
      stakes.push({ manager: e.manager, slug: e.slug, ticker: e.ticker, form: e.form, pct: e.percent_of_class ?? null, prev: e.prev_percent_of_class ?? null, url: investor(e.slug), featured: isFeatured, accession: e.id });
    }
  }
  // The curated superinvestors only (the email says "Superinvestor filings"), by dollars; at most 2 rows per fund in
  // each list. A week with few superinvestor moves shows fewer rows, never other filers.
  const rank = (xs: WeeklyMove[], sign: 1 | -1) => {
    const per = new Map<string, number>();
    return xs
      .filter((x) => x.featured && Math.sign(x.usd) === sign)
      .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))
      .filter((x) => {
        const n = per.get(x.slug) ?? 0;
        per.set(x.slug, n + 1);
        return n < 2;
      })
      .slice(0, 5);
  };
  return { buys: rank(all, 1), sells: rank(all, -1), all, stakes };
}

/** Free accounts may save this many owned names; the Friday email leads with them. */
export const FREE_NAMES = 5;
/** What the Friday email and the welcome say about followed investors: each one's latest 13F record and expected date. */
interface FollowContext {
  filed: Map<string, Alert13F>;
  expected: Map<string, { manager: string; date: string }>;
  quarter: string | null;
}
async function followContext(env: Env, slugs: string[], now = Date.now()): Promise<FollowContext> {
  const filed = new Map<string, Alert13F>();
  for (const s of new Set(slugs)) {
    const raw = await env.DB.get(`wk13f:${s}`);
    if (!raw) continue;
    const a = JSON.parse(raw) as Alert13F;
    if (a.moves) a.moves = countedMoves(a.moves); // marked rows stored in the lists: never sized as trades
    // Moves stored before reissued CUSIPs were linked (Boston Partners' Q3 "exited XOM" plus "new XOM"): netted here.
    if (a.moves) {
      const m = a.moves;
      const rows = [...m.new.map((r) => ({ ...r, change: 'new' })), ...m.added.map((r) => ({ ...r, change: 'added' })), ...m.trimmed.map((r) => ({ ...r, change: 'trimmed' })), ...m.exited.map((r) => ({ ...r, change: 'exited' }))] as MoveRow[];
      const n = netRenamed({ moves: m, changed: rows });
      if (n.changed !== rows) a.moves = { ...n.moves, bought_usd: m.bought_usd, sold_usd: m.sold_usd };
    }
    filed.set(s, a);
  }
  // The site's list of superinvestors still to file this quarter, with each one's expected date (d/expected.json).
  const ex = await fetch(`${env.SITE_URL}d/expected.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { quarter?: string; expected?: { slug: string; manager: string; expected_date: string }[] } | null;
  const quarter = ex?.quarter ?? nextDeadline(now).quarter;
  // Whether a follow has filed comes from the data run's index (each filer's latest 13F quarter), not from this week's
  // alert records: a 13F filed before those started (Pzena, Oct 30) is filed, with the top moves from its card.
  const { filers } = await import('./v1data');
  const latest = new Map((await filers(env)).map((f) => [f.slug, f]));
  for (const s of new Set(slugs)) {
    const f = latest.get(s);
    if (!f?.latest_accession || f.latest_quarter !== quarter || filed.get(s)?.quarter === quarter) continue;
    filed.set(s, await cardAlert(env, f));
  }
  const expected = new Map((ex?.expected ?? []).filter((x) => !(filed.get(x.slug)?.quarter === quarter)).map((x) => [x.slug, { manager: x.manager, date: x.expected_date }]));
  return { filed, expected, quarter };
}
/** Legal suffixes as written ("Akre Capital Management LLC", not "Llc"). */
const legal = <T extends string | null | undefined>(n: T): T => (n ? n.replace(/\b(Llc|Lp|Llp|Plc)\b/g, (w) => w.toUpperCase()) : n) as T;
/** A 13F filed before this week's alert records, as one: its filing from the index, its top moves from the site's card. */
async function cardAlert(env: Env, f: import('./v1data').FilerRow): Promise<Alert13F> {
  type CardRow = { ticker: string | null; name?: string; cusip?: string; change?: string; value_delta: number; put_call?: string | null };
  const d = (await fetch(`${env.SITE_URL}d/f/${f.latest_accession}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { bought_usd?: number; sold_usd?: number; total_value?: number; moves?: CardRow[] } | null;
  const rows = (d?.moves ?? []).filter((r) => !r.put_call);
  // The trade as a share of the book, for the alert table's "Trade, % of book" column.
  const of = (c: string) => rows.filter((r) => r.change === c).map((r) => ({ ...r, issuer: r.name ?? '', display_name: r.name ?? null, delta_pct_of_book: d?.total_value ? r.value_delta / d.total_value : null })) as unknown as import('./edgar').MoveRow[];
  return {
    // EDGAR's all-caps names as people write them ("Davis Selected Advisers").
    slug: f.slug, slugs: [f.slug], manager: legal(f.manager && f.manager === f.manager.toUpperCase() ? displayCase(f.manager) : f.manager), name: legal(f.name), quarter: f.latest_quarter!, report_date: f.latest_report_date ?? '', filing_date: f.latest_filing_date ?? '',
    accession: f.latest_accession!, sec_url: `https://www.sec.gov/Archives/edgar/data/${Number(f.cik)}/${f.latest_accession!.replace(/-/g, '')}/${f.latest_accession}-index.html`, tickers: rows.map((r) => r.ticker).filter((t): t is string => !!t),
    moves: rows.length ? { bought_usd: d?.bought_usd ?? 0, sold_usd: d?.sold_usd ?? 0, new: of('new'), added: of('added'), trimmed: of('trimmed'), exited: of('exited') } : null,
  };
}
const qLabel = (q: string) => (/^\d{4}Q[1-4]$/.test(q) ? `Q${q[5]}` : q);
const dayLabel = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '');
const slugName = (s: string) => s.replace(/-\d{4}$/, '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
/** One followed investor: filed this week (its record), expected, or filed earlier this season. */
function followLine(ctx: FollowContext, slug: string, now: number) {
  const a = ctx.filed.get(slug);
  const ex = ctx.expected.get(slug);
  const name = siteName(slug) ?? a?.manager ?? ex?.manager ?? slugName(slug);
  const q = ctx.quarter ?? a?.quarter ?? '';
  const thisQuarter = !!a && (!ctx.quarter || a.quarter === ctx.quarter);
  const thisWeek = !!a && thisQuarter && Date.parse(a.accepted ?? `${a.filing_date}T21:00:00Z`) >= now - 7 * 86400_000;
  if (thisWeek) return { name, a, week: true, line: '', welcome: `${name}: the ${qLabel(a!.quarter)} 13F was filed ${dayLabel(a!.filing_date)}, and its moves come in Friday's email.` };
  if (ex) return { name, a: null, week: false, line: `${name}: not filed yet · expected ${dayLabel(ex.date)}`, welcome: `${name}: the ${qLabel(q)} 13F is expected ${dayLabel(ex.date)}, and its moves come in Friday's email.` };
  if (thisQuarter) return { name, a, week: false, line: `${name}: filed its ${qLabel(a!.quarter)} 13F ${dayLabel(a!.filing_date)}, before this week`, welcome: `${name}: the ${qLabel(a!.quarter)} 13F was filed ${dayLabel(a!.filing_date)}; the next one's moves come in Friday's email.` };
  return { name, a: null, week: false, line: `${name}: not filed yet`, welcome: `${name}: the next 13F's moves come in Friday's email.` };
}

/** The Friday email's "Your follows", first: each followed investor's 13F this week in the Copy alert's format (at most 10 rows), else when it's expected. */
export async function followsSection(env: Env, f: Follows, now: number, ctx?: FollowContext): Promise<{ text: string; html: string } | null> {
  if (!f.investors.length) return null;
  const c = ctx ?? (await followContext(env, f.investors));
  const blocks = f.investors.map((s) => {
    const l = followLine(c, s, now);
    if (l.week && l.a) return followFiling(env, l.a, f);
    const url = l.a ? `${env.SITE_URL}f/${l.a.accession}/` : `${env.SITE_URL}investors/${s}/`;
    return { text: `  ${l.line}\n    ${url}`, html: `<p style="margin:6px 0"><a href="${esc(url)}" style="color:#111;text-decoration:none">${esc(l.line)}</a></p>` };
  });
  return {
    text: `Your follows:\n${blocks.map((b) => b.text).join('\n\n')}\n\n`,
    html: `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;margin:12px 0"><h3 style="font-size:16px;margin:0 0 4px">Your follows</h3>${blocks.map((b) => b.html).join('')}</div>`,
  };
}

/** Investors a free account may follow (for the Friday email's "From investors you follow"). */
export const FREE_INVESTORS = 10;
/** Insider trades count toward the locked line from the alerts' default threshold up. */
const INSIDER_MIN_USD = 100_000;

const FACT: Record<WeeklyMove['what'], (x: WeeklyMove) => string> = {
  new: (x) => `opened a ${money(x.usd)} position in ${x.ticker}`,
  added: (x) => `added ${money(x.usd)} of ${x.ticker}`,
  trimmed: (x) => `trimmed ${money(x.usd)} of ${x.ticker}`,
  exited: (x) => `sold out of ${x.ticker} (${money(x.usd)})`,
  bought: (x) => `bought ${money(x.usd)} of ${x.ticker}`,
  sold: (x) => `sold ${money(x.usd)} of ${x.ticker}`,
};
const stakeFact = (x: WeeklyStake) =>
  x.prev != null && x.pct != null ? `${siteFirm(x.slug) ?? x.manager}'s stake in ${x.ticker} went ${x.prev}% → ${x.pct}%` : `${siteName(x.slug) ?? x.manager} reported ${x.pct != null ? `a ${x.pct}%` : 'a'} stake in ${x.ticker} (${x.form.replace(/^SCHEDULE /, '')})`;

export interface InYourNames {
  names: number;
  /** One public fact per saved name: its biggest superinvestor move this week (a 13F row, Form 4 or 13D/G). */
  facts: { ticker: string; text: string; url: string }[];
  /** The biggest item Copy would add, named, e.g. "Capital One Financial's CEO sold $18.6M of COF". */
  hook: string | null;
  /** Everything else Copy adds in these names: open-market insider trades from $100K, other fund moves, 13D/Gs. */
  more: number;
}

const short = (issuer: string) =>
  issuer
    .replace(/[,.]?\s+(inc|corp|corporation|co|company|ltd|plc|l\.?p\.?|llc|holdings?|group)\.?$/i, '')
    .replace(/[,.]?\s+(inc|corp|corporation|co|company|ltd|plc)\.?$/i, '')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
const roleOf = (role: string | null) => {
  const r = role ?? '';
  if (/chief executive|\bceo\b/i.test(r)) return 'CEO';
  if (/chief financial|\bcfo\b/i.test(r)) return 'CFO';
  if (/president/i.test(r)) return 'president';
  if (/chair/i.test(r)) return 'chair';
  if (/10% owner/i.test(r)) return 'a 10% owner';
  if (/director/i.test(r)) return 'a director';
  return 'an officer';
};

/** Tracked funds by CIK (the data run's index.json, read at most hourly): a Form 4 owner's person ("Warren Buffett"). */
let ownersByCik: { at: number; m: Map<string, string> } | null = null;
async function ownerName(env: Env, cik: string | null, filer: string): Promise<string> {
  if (!ownersByCik || Date.now() - ownersByCik.at > 3600_000) {
    const idx = (await fetch(`${env.DATA_URL}index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { managers?: { cik?: string; manager?: string }[] } | null;
    ownersByCik = { at: Date.now(), m: new Map((idx?.managers ?? []).filter((x) => x.cik && x.manager).map((x) => [String(Number(x.cik)), x.manager!])) };
  }
  const firm = short(filer);
  const person = cik ? ownersByCik.m.get(String(Number(cik))) : undefined;
  return person && !firm.toLowerCase().includes(person.toLowerCase()) && !person.toLowerCase().includes(firm.toLowerCase()) ? `${firm} (${displayCase(person)})` : firm;
}

/**
 * A free member's block. Facts are public (what the investor pages and filing cards show); the hook names
 * the biggest of what Copy adds: a company insider's open-market trade from $100K (never gifts, grants,
 * withholding or exercises), or another fund's move or 13D/G in their names.
 */
export async function inYourNames(env: Env, names: string[], week: Week, now: number, secBudget = 8): Promise<InYourNames> {
  const facts: InYourNames['facts'] = [];
  const shown = new Set<string>();
  type Item = { text: string; size: number };
  const locked: Item[] = [];
  for (const t of names) {
    const cands = [
      ...week.all.filter((x) => x.ticker === t).map((x) => ({ key: `${x.accession}|${x.ticker}|${x.what}`, featured: x.featured, unusual: !!x.unusual, size: Math.abs(x.usd), text: `${siteName(x.slug) ?? x.manager} ${FACT[x.what](x)}`, url: x.url })),
      ...week.stakes.filter((x) => x.ticker === t).map((x) => ({ key: x.accession, featured: x.featured, unusual: false, size: 0, text: stakeFact(x), url: x.url })),
    ].sort((a, b) => Number(b.featured) - Number(a.featured) || Number(a.unusual) - Number(b.unusual) || b.size - a.size);
    const top = cands.find((c) => c.featured);
    if (top) {
      facts.push({ ticker: t, text: `${top.text}, which you own${top.unusual ? ` (${UNUSUAL})` : ''}`, url: top.url });
      shown.add(top.key);
    }
    for (const c of cands) if (!shown.has(c.key)) locked.push({ text: c.text, size: c.size });
  }
  // Company insiders and anyone's 13D/G, from the per-stock events the precompute keeps current.
  const { stockEvents } = await import('./stockevents');
  const r = names.length ? await stockEvents(env, names, 50, { budget: secBudget, freshMs: 6 * 3600_000 }) : { tickers: {} as Record<string, { events: import('./stockevents').StockEvent[] }> };
  const since = new Date(now - 7 * 86400_000).toISOString();
  const fundAcc = new Set([...week.all.map((x) => x.accession), ...week.stakes.map((x) => x.accession)]);
  for (const [t, x] of Object.entries(r.tickers)) {
    for (const e of x.events) {
      if (e.accepted_at < since || fundAcc.has(e.accession)) continue;
      if (e.form.startsWith('4')) {
        if (!e.open_market || !e.value_usd || e.value_usd < INSIDER_MIN_USD) continue;
        const sold = (e.totals?.sold?.shares ?? 0) > (e.totals?.bought?.shares ?? 0);
        // Dated: the trade, then when it was filed ("sold Nov 4, filed Nov 6").
        const md = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
        const verb = sold ? 'sold' : 'bought';
        const when = `${e.event_date ? `${md(e.event_date)}, ` : ''}filed ${md(etDay(Date.parse(e.accepted_at)))}`;
        // "Capital One Financial's CEO sold"; an owner or director by the Form 4's reporting-owner name, with the person
        // when it's a fund we track: "Berkshire Hathaway (Warren Buffett), a 10% owner, bought".
        const role = roleOf(e.role);
        const who = role.startsWith('a ') ? `${await ownerName(env, e.filer_cik, e.filer_name)}, ${role},` : `${short(e.issuer)}'s ${role}`;
        locked.push({ text: `${who} ${verb} ${money(e.value_usd)} of ${t} (${when})`, size: e.value_usd });
      } else locked.push({ text: `${e.filer_name} filed a ${e.form.replace(/^SCHEDULE /, '')} on ${t}`, size: 0 });
    }
  }
  locked.sort((a, b) => b.size - a.size);
  return { names: names.length, facts, hook: locked[0]?.text ?? null, more: Math.max(0, locked.length - 1) };
}

/**
 * /me for a free member: the same "In your names" block the Friday email would send now, so /account/ and
 * My book show the same pull. The week is cached an hour; insider rows come from the precompute (no SEC reads).
 */
export async function freeTeaser(env: Env, names: string[], now: number): Promise<Omit<InYourNames, 'names'>> {
  const cached = await env.DB.get('free:week');
  let week = cached ? (JSON.parse(cached) as Week) : null;
  if (!week) {
    week = await weeklyMoves(env, now);
    await env.DB.put('free:week', JSON.stringify(week), { expirationTtl: 3600 });
  }
  const { facts, hook, more } = await inYourNames(env, names, week, now, 0);
  return { facts, hook, more };
}

/** The Friday email's links, told apart in the funnel. */
const WEEKLY_CAMPAIGN = '13f-q3-2026';
/** The window weeklyMoves covers, as the email names it: "November 6–13" ("October 30 – November 6" across months). */
export function weekWindow(now: number): string {
  const day = (t: number) => new Date(`${etDay(t)}T12:00:00Z`);
  const [a, b] = [day(now - 7 * 86400_000), day(now)];
  const m = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return m(a) === m(b) ? `${m(a)} ${a.getUTCDate()}–${b.getUTCDate()}` : `${m(a)} ${a.getUTCDate()} – ${m(b)} ${b.getUTCDate()}`;
}

const LABEL: Record<WeeklyMove['what'], string> = { new: 'new position', added: 'added', trimmed: 'trimmed', exited: 'sold out', bought: 'bought', sold: 'sold' };

export function weeklyMail(env: Env, to: string, moves: { buys: WeeklyMove[]; sells: WeeklyMove[] }, weekOf: string, unsub: string, yours?: InYourNames, followed: WeeklyMove[] = [], follows?: { text: string; html: string } | null): Mail {
  // The mailing address marketing email must carry: without it, no Copy ask (a plain newsletter).
  const postal = env.POSTAL_ADDRESS?.trim() || null;
  const line = (x: WeeklyMove) => `${siteName(x.slug) ?? x.manager}: ${LABEL[x.what]} ${x.ticker}, ${x.usd > 0 ? '+' : '−'}${money(x.usd)} (${x.form})${x.unusual ? ` · ${UNUSUAL}` : ''}`;
  // The subject's fallback: the week's biggest superinvestor move, buy or sell.
  const top = [moves.buys[0], moves.sells[0]].filter((x): x is WeeklyMove => !!x).sort((a, b) => Number(b.featured) - Number(a.featured) || Math.abs(b.usd) - Math.abs(a.usd))[0];
  const utm = (content: string) => `utm_source=weekly&utm_medium=email&utm_campaign=${WEEKLY_CAMPAIGN}&utm_content=${content}`;
  const pricing = `${env.SITE_URL}pricing/?${utm('weekly-paid')}`;
  const speed = `${env.SITE_URL}speed/?${utm('weekly-speed')}`;
  // The only speed and history claims marketing allows (lead, Nov 11): the season median with /speed/, and history as served.
  const COPY_SPEED = 'median under 2 minutes from EDGAR acceptance';
  const COPY_HISTORY = '8 quarters of 13F history (from 2024Q3) for the managers we track closely, back to 2013Q2 by Dec 31, and CSV';
  const book = `${env.SITE_URL}my-book/`;
  // My book is part of Copy: its line is a Copy ask, so it goes only with the Copy paragraph (a postal address set).
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const locked = yours?.hook && postal ? `${yours.hook}, with Copy${yours.more ? ` (+${yours.more} more in your names)` : ''}` : null;
  const trial = 'Try Copy · 14 days free · card required';
  // Leads the email: what moved in the names they saved, then what Copy adds. No names yet: how to add them.
  // Investors they follow (from a filer page's signup): those funds' moves this week, largest first.
  const followedText = followed.length ? `${follows ? 'Also this week from your follows' : 'From investors you follow'}:\n${followed.map((x) => `  ${line(x)}\n    ${x.url}`).join('\n')}\n\n` : '';
  const followedHtml = followed.length ? `<h3 style="font-size:15px;margin:18px 0 6px">${follows ? 'Also this week from your follows' : 'From investors you follow'}</h3><ul style="padding-left:18px;margin:0">${followed.map((x) => `<li><a href="${esc(x.url)}" style="color:#1d4ed8">${esc(line(x))}</a></li>`).join('')}</ul>` : '';
  const yoursText = !yours
    ? ''
    : !yours.names
      ? postal ? `With Copy, save up to ${FREE_NAMES} names you own in My book and this email leads with them: ${book}\n\n` : ''
      : `In your names:\n${yours.facts.map((f) => `  ${f.text}.\n    ${f.url}`).join('\n') || `  None of your ${n(yours.names, 'name')} moved in superinvestor filings this week.`}\n${locked ? `  ${locked}: ${pricing}\n` : ''}\n`;
  const yoursHtml = !yours
    ? ''
    : !yours.names
      ? postal ? `<p style="background:#f3f4f6;border-radius:10px;padding:12px 14px">With Copy, save up to ${FREE_NAMES} names you own in <a href="${book}" style="color:#1d4ed8">My book</a> and this email leads with them.</p>` : ''
      : `<div style="background:#f3f4f6;border-radius:10px;padding:12px 14px"><h3 style="font-size:15px;margin:0 0 6px">In your names</h3>${yours.facts.map((f) => `<p style="margin:4px 0"><a href="${f.url}" style="color:#111;text-decoration:none">${esc(f.text)}.</a></p>`).join('') || `<p style="margin:4px 0">None of your ${n(yours.names, 'name')} moved in superinvestor filings this week.</p>`}${locked ? `<p style="margin:8px 0 4px;color:#6b7280">🔒 ${esc(locked)}</p><p style="margin:8px 0 0"><a href="${pricing}" style="display:inline-block;background:#111;color:#fff;padding:8px 16px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px">${trial}</a></p>` : ''}</div>`;
  const lead = yours?.facts[0];
  const row = (x: WeeklyMove) =>
    `<tr><td style="padding:4px 8px 4px 0">${esc(siteName(x.slug) ?? x.manager)}</td><td style="padding:4px 8px;white-space:nowrap"><b>${esc(x.ticker)}</b> ${LABEL[x.what]}</td><td style="padding:4px 8px;text-align:right;white-space:nowrap;color:${x.usd > 0 ? '#047857' : '#b91c1c'}">${x.usd > 0 ? '+' : '−'}${money(x.usd)}</td><td style="padding:4px 0 4px 8px"><a href="${x.url}" style="color:#1d4ed8">${esc(x.form)}</a>${x.unusual ? `<br><span style="color:#b45309;font-size:12px">${UNUSUAL}</span>` : ''}</td></tr>`;
  const table = (title: string, xs: WeeklyMove[]) => (xs.length ? `<h3 style="font-size:15px;margin:18px 0 6px">${title}</h3><table style="border-collapse:collapse;font-size:14px">${xs.map(row).join('')}</table>` : '');
  // Every site link is tagged, so a trial started from a card or follow counts as the weekly's (not direct_site).
  const site = env.SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const KIND: Record<string, string> = { f: 'weekly-card', investors: 'weekly-follows', 'my-book': 'weekly-mybook' };
  const tag = (s: string) => s.replace(new RegExp(`(${site}(f|investors)/[\\w-]+/|${site}(my-book)/)(?![?\\w])`, 'g'), (u: string, _a: string, k1?: string, k2?: string) => `${u}?${utm(KIND[(k1 ?? k2)!])}`);
  return tagged({
    to,
    subject: lead ? `In your names: ${lead.text.replace(/, which you own( \(.*\))?$/, '')}` : `The week in superinvestor filings: ${top ? `${siteName(top.slug) ?? top.manager} ${LABEL[top.what]} ${top.ticker}` : 'the biggest moves'}`,
    text: `Superinvestor filings, ${weekOf}.\n\n${follows?.text ?? ''}${followedText}${yoursText}Biggest buys:\n${moves.buys.map((x) => `  ${line(x)}\n    ${x.url}`).join('\n') || '  none this week'}\n\nBiggest sells:\n${moves.sells.map((x) => `  ${line(x)}\n    ${x.url}`).join('\n') || '  none this week'}${postal ? `\n\nThis email comes once a week. Copy emails each 13F from the funds you follow as it's filed, ${COPY_SPEED} (live figures: ${speed}), with ${COPY_HISTORY}. 14 days free · card required: ${pricing}` : ''}\n\nYou get this because you signed up for the free Copybook weekly. Unsubscribe: ${unsub}${FOOTER}${postal ? `\n${postal}` : ''}`,
    html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:600px"><p>Superinvestor filings, ${esc(weekOf)}.</p>${follows?.html ?? ''}${followedHtml}${yoursHtml}${table('Biggest buys', moves.buys)}${table('Biggest sells', moves.sells)}${postal ? `<p style="margin-top:20px">This email comes once a week. <a href="${pricing}" style="color:#1d4ed8"><b>Copy</b></a> emails each 13F from the funds you follow as it's filed, ${COPY_SPEED} (<a href="${speed}" style="color:#1d4ed8">live figures</a>), with ${COPY_HISTORY}. <a href="${pricing}" style="color:#1d4ed8">14 days free · card required</a>.</p>` : ''}<p style="color:#6b7280;font-size:12px;margin-top:24px">You get this because you signed up for the free Copybook weekly. Source: SEC EDGAR filings, as filed. Not investment advice. Copybook by Factor Dynamics.${postal ? ` ${esc(postal)}.` : ''} <a href="${unsub}" style="color:#6b7280">Unsubscribe</a></p></div>`,
    unsubscribe: unsub,
  });
  function tagged(m: Mail): Mail {
    return { ...m, text: tag(m.text), ...(m.html ? { html: tag(m.html) } : {}) };
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Email 2: one batch on deadline night, Tue Nov 17 02:30 UTC (Mon 9:30pm ET), through Mailgun, to real free signups. */
const E2_MIN = 10;
const e2 = (env: Env, path: string, content: string) => `${env.SITE_URL}${path}${path.includes('?') ? '&' : '?'}utm_source=email&utm_medium=email&utm_campaign=e2&utm_content=${content}`;

/** One move row of Email 2: the person and fund, the move, and its size as a share of the fund. */
export interface E2Move {
  slug: string;
  who: string;
  firm: string;
  text: string;
  usd: number;
  change: string;
  /** The security as named in a subject: its issuer, else the ticker. */
  what: string;
}
/** One followed investor: its 13F this season (top moves), else when it's expected. */
export interface E2Follow {
  who: string;
  a: Alert13F | null;
  /** Expected date (YYYY-MM-DD) when not filed; null: by the deadline. */
  expected: string | null;
}
export interface E2Input {
  now: number;
  season: string;
  /** One row per followed investor, filed first. */
  rows: E2Follow[];
  /** Still due for the preheader: the member's follows, else the superinvestors still to file. */
  due: string[];
  biggest: E2Move[];
  yours: InYourNames | null;
  follows: boolean;
  unsub: string;
  postal: string;
}

const pctOf = (p: number | null | undefined) => (p != null && Number.isFinite(p) && Math.abs(p) <= 1 ? ` (${(Math.abs(p) * 100).toFixed(1)}% of fund)` : '');
const lastName = (who: string) => who.replace(/\s*\(.*\)$/, '').split(' ').pop() ?? who;
/** "First Eagle Investment Management LLC" as "First Eagle": the fund's name as people say it. */
const shortFirm = (slug: string, name: string) => firmName(slug, name).replace(/\s+(investment management|asset management|capital management|investment partners|global investors|management|advisors|advisers|investors|group)$/i, '').trim();
const listNames = (xs: string[]) => (xs.length <= 1 ? xs.join('') : xs.length <= 3 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more`);
/** $400.1M as $400M, $8.0M as $8M: for subject lines. */
const roundMoney = (v: number) => money(Math.abs(v)).replace(/(\d{3,})\.(\d)([KMB])/, (_, n: string, d: string, u: string) => `${Number(n) + (Number(d) >= 5 ? 1 : 0)}${u}`).replace(/\.0([KMB])/, '$1');
/** "bought $400M of NVR" / "sold out of CHRW" / "sold $300M of HM1": one move in a subject. */
/** Still-due names in a preheader: a person by last name, a firm in full ("Buffett", "Akre Capital Management"). */
const dueName = (w: string) => (/\b(capital|management|partners|advisors|advisers|group|llc|lp|inc|street|fund|trust|associates|investments?)\b/i.test(w) ? w : lastName(w));
const headPart = (change: string, v: number, what: string) => (change === 'exited' ? `sold out of ${what}` : `${v > 0 ? 'bought' : 'sold'} ${roundMoney(v)} of ${what}`);
const VERB: Record<string, string> = { new: 'new position in', added: 'added', trimmed: 'trimmed', exited: 'sold out of' };

/** One member's Email 2: their follows first (never an empty state), one trial button right after them, the day's biggest moves. No speed figures or clock times (the lead's rule). */
export function email2Mail(env: Env, to: string, o: E2Input): Mail {
  const dl = nextDeadline(o.now);
  const deadlineNight = dl.date === etDay(o.now);
  const dayName = new Date(o.now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const intro = deadlineNight ? `13F deadline night, ${dayName}.` : `${dayName}. ${qLabel(dl.quarter)} 13Fs are due ${deadlineLabel(dl.date)}.`;
  const sorted = (a: Alert13F) => {
    const m = a.moves!;
    // A marked row (unreliable) is no trade: never a $ size here.
    return [...m.new.map((r) => ['new', r] as const), ...m.added.map((r) => ['added', r] as const), ...m.trimmed.map((r) => ['trimmed', r] as const), ...m.exited.map((r) => ['exited', r] as const)]
      .filter(([, r]) => !r.unreliable)
      .sort((x, y) => Math.abs(y[1].value_delta) - Math.abs(x[1].value_delta));
  };
  const three = (a: Alert13F) => sorted(a).slice(0, 3).map(([c, r]) => `${VERB[c]} ${r.ticker || r.display_name || r.issuer}${r.put_call ? ` ${r.put_call.toLowerCase()}s` : ''} ${r.value_delta > 0 ? '+' : '−'}${money(r.value_delta)}${pctOf(r.delta_pct_of_book)}`).join('; ');
  const card = (a: Alert13F) => e2(env, `f/${a.accession}/`, 'e2-follows');
  const pricing = e2(env, 'pricing/?from=e2', 'e2-paid') + '&client_reference_id=email_e2-paid';
  const isToday = (a: Alert13F) => etDay(Date.parse(a.accepted ?? `${a.filing_date}T21:00:00Z`)) === etDay(o.now);
  // One row per follow: its top moves if it filed this season, else when it's expected.
  const lead = o.rows.map(({ who, a, expected }) => {
    if (a) {
      const when = isToday(a) ? 'today' : dayLabel(a.filing_date);
      const text = a.moves ? `${who} filed its ${qLabel(a.quarter)} 13F ${when}: ${three(a)}` : `${who} filed its ${qLabel(a.quarter)} 13F ${when}`;
      return { text: `${text}\n    ${card(a)}`, html: `<p style="margin:6px 0"><b>${esc(who)}</b>${esc(text.slice(who.length))} · <a href="${esc(card(a))}" style="color:#1d4ed8">See the filing</a></p>` };
    }
    const text = `${who}: expected by ${dayLabel(expected ?? dl.date)}`;
    return { text, html: `<p style="margin:6px 0"><b>${esc(who)}</b>${esc(text.slice(who.length))}</p>` };
  });
  const CTA = "Get each 13F as it's filed, with Copy";
  const names = o.yours && (o.yours.facts.length || o.yours.hook) ? o.yours : null;
  const moreNames = (n: number) => `+${n} more ${n === 1 ? 'item' : 'items'} in your names`;
  const namesText = names ? `In your names:\n${names.facts.map((f) => `  ${f.text}.`).join('\n')}${names.hook ? `${names.facts.length ? '\n' : ''}  Copy alerts you when it's filed: ${names.hook}${names.more ? ` (${moreNames(names.more)})` : ''}.` : ''}` : '';
  const namesHtml = names ? `<div style="background:#f3f4f6;border-radius:10px;padding:10px 14px;margin:12px 0"><h3 style="font-size:15px;margin:0 0 4px">In your names</h3>${names.facts.map((f) => `<p style="margin:4px 0">${esc(f.text)}.</p>`).join('')}${names.hook ? `<p style="margin:4px 0">Copy alerts you when it's filed: ${esc(names.hook)}${names.more ? ` (${moreNames(names.more)})` : ''}.</p>` : ''}</div>` : '';
  const big = o.biggest.map((b) => `${b.who}: ${b.text}`);
  const bigTitle = deadlineNight ? "The day's biggest moves" : "Today's biggest moves";
  const recap = e2(env, `season/${(o.season || dl.quarter).toLowerCase()}/`, 'e2-recap');
  const why = o.follows ? 'You get this because you follow investors on Copybook.' : "You get this because you signed up for Copybook's free email.";
  // Subject from the night's data: a followed manager that filed (today first, else the latest this season), its top move,
  // and the first follow still due ("Pzena added $352M of Globe Life · Buffett due Monday"); else the night's top manager.
  const followFiled = o.rows.find((r) => r.a?.moves && isToday(r.a)) ?? o.rows.find((r) => r.a?.moves && sorted(r.a).length);
  const stillDue = o.rows.find((r) => !r.a);
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  let subject = '';
  if (followFiled?.a && sorted(followFiled.a).length) {
    const [change, r] = sorted(followFiled.a)[0];
    const name = followFiled.who.match(/\((.*)\)$/)?.[1] ?? lastName(followFiled.who);
    const move = change === 'exited' ? `sold out of ${subjectName(r.display_name || r.issuer, r.ticker)}` : `${{ new: 'bought', added: 'added', trimmed: 'trimmed' }[change]} ${roundMoney(r.value_delta)} of ${subjectName(r.display_name || r.issuer, r.ticker)}`;
    subject = `${name} ${move}${stillDue ? ` · ${dueName(stillDue.who)} due ${weekday(stillDue.expected ?? dl.date)}` : ''}`;
  } else if (o.biggest.length) {
    const firm = o.biggest[0].slug;
    const mine = o.biggest.filter((b) => b.slug === firm);
    const buy = mine.find((b) => b.usd > 0);
    const sell = mine.find((b) => b.usd < 0);
    subject = `${o.biggest[0].firm} ${[buy, sell].filter((x): x is E2Move => !!x).map((b) => headPart(b.change, b.usd, b.what)).join(', ')}`;
  } else subject = `${deadlineNight ? '13F deadline night' : 'Tonight'}: the biggest superinvestor moves`;
  // Preheader: who is still due, else a big move (the second when the first is in the subject).
  const pre = o.due.length ? `${listNames(o.due.slice(0, 2).map(dueName))} due by ${dayLabel(dl.date)}` : big[1] ?? big[0] ?? intro;
  const leadText = lead.length ? `Your follows:\n${lead.map((l) => `  ${l.text}`).join('\n')}` : '';
  const bigText = big.length ? `${bigTitle}:\n${big.map((x) => `  ${x}`).join('\n')}\n  The season so far: ${recap}` : '';
  const ask = `${CTA} · 14 days free · card required: ${pricing}`;
  const button = `<p style="margin:16px 0 4px"><a href="${esc(pricing)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${esc(CTA)}</a></p><p style="margin:0 0 14px;font-size:13px;color:#6b7280">14 days free · card required</p>`;
  const bigHtml = big.length ? `<h3 style="font-size:15px;margin:18px 0 6px">${bigTitle}</h3><table style="border-collapse:collapse;font-size:14px">${o.biggest.map((b) => `<tr><td style="padding:4px 8px 4px 0;vertical-align:top">${esc(b.who)}</td><td style="padding:4px 0;vertical-align:top;color:${b.usd > 0 ? '#047857' : '#b91c1c'}">${esc(b.text)}</td></tr>`).join('')}</table><p style="margin:6px 0"><a href="${esc(recap)}" style="color:#1d4ed8">The season so far</a></p>` : '';
  const leadHtml = lead.length ? `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;margin:12px 0"><h3 style="font-size:16px;margin:0 0 4px">Your follows</h3>${lead.map((l) => l.html).join('')}</div>` : '';
  // The first block of moves, then the button (on a phone's first screen), then their names, the rest.
  // The speed line sits directly above the trial button.
  const body = lead.length ? [leadText, ask, namesText, bigText] : [bigText, ask, namesText];
  const html = lead.length ? `${leadHtml}${button}${namesHtml}${bigHtml}` : `${bigHtml}${button}${namesHtml}`;
  return {
    to,
    subject,
    text: `${intro}\n\n${body.filter(Boolean).join('\n\n')}\n\n${why} Unsubscribe: ${o.unsub}${FOOTER}\n${o.postal}`,
    html: `<div style="display:none;max-height:0;overflow:hidden">${esc(pre)}</div><div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:600px"><p>${esc(intro)}</p>${html}<p style="color:#6b7280;font-size:12px;margin-top:24px">${esc(why)} <a href="${esc(o.unsub)}" style="color:#6b7280">Unsubscribe</a>.<br>${esc(FOOTER.trim()).replace(/\n/g, '<br>')}<br>${esc(o.postal)}</p></div>`,
    unsubscribe: o.unsub,
  };
}

/** A security in a subject: its short name ("C.H. Robinson Worldwide"), or the ticker when the name is just the ticker (NVR). */
const subjectName = (name: string | undefined, ticker: string | null) => {
  // "C. H. Robinson" and EDGAR's "C H ROBINSON" alike as "C.H. Robinson".
  const n = name ? short(name).replace(/\b([A-Z])\. (?=[A-Z]\.)/g, '$1.').replace(/^([A-Z]) ([A-Z]) (?=[A-Z][a-z])/, '$1.$2. ') : '';
  return !n || (ticker && n.toUpperCase() === ticker.toUpperCase()) ? (ticker ?? n) : n;
};


/**
 * Email 2, once: skipped (and recorded why) without a postal address, without Mailgun, under 10 real free signups, or
 * when the season recap can't be read. `preview`: sent only to our inbox and test inboxes, subject marked [Preview].
 */
export async function runEmail2(env: Env, now: number, preview?: string[], dry = false): Promise<Record<string, unknown>> {
  const postal = env.POSTAL_ADDRESS?.trim();
  if (!preview && (await env.DB.get('e2:done'))) return { status: 'already done' };
  const skip = async (why: string) => {
    if (!preview) await env.DB.put('e2:done', JSON.stringify({ at: new Date(now).toISOString(), skipped: why }));
    return { status: 'skipped', why };
  };
  // A preview may go before the address and Mailgun are configured: a marked placeholder, and through Resend.
  if (!postal && !preview) return skip('no postal address');
  if (!env.MAILGUN_API_KEY && !preview) return skip('no MAILGUN_API_KEY');
  // Recipients: real free signups who haven't unsubscribed (a preview: the given test inboxes only).
  const members: Member[] = [];
  if (preview) {
    for (const to of preview.filter(previewInbox)) members.push((await memberByEmail(env, to)) ?? ({ customer: `preview:${to}`, email: to, status: 'free' } as Member));
    if (!members.length) return { status: 'skipped', why: 'no preview inbox given' };
  } else {
    for (const m of await listMembers(env)) if (m.status === 'free' && !m.marketing_off && m.email && !testAddress(m.email) && (await env.DB.get(`email:${m.email}`)) === m.customer) members.push(m);
    if (members.length < E2_MIN) return skip(`${members.length} real free signups, under ${E2_MIN}`);
  }
  const follows = new Map<string, Follows>();
  for (const m of members) follows.set(m.customer, m.customer.startsWith('preview:') ? ({ investors: ['irving-kahn', 'seth-klarman', 'howard-marks'], stocks: [], owned: [] } as unknown as Follows) : await getFollows(env, m));
  const ctx = await followContext(env, [...follows.values()].flatMap((f) => f.investors), now);
  // The ET day of the send (Mon 9:30pm ET is Tue 02:30 UTC); its biggest moves from the season recap.
  const day = etDay(now);
  const season = ctx.quarter ?? nextDeadline(now).quarter;
  const rc = season ? ((await fetch(`${env.SITE_URL}d/recap/${season}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { filing?: { slug: string; filing_date?: string | null }[]; biggest?: { slug: string; manager: string; ticker: string | null; name?: string; change: string; delta_value: number }[] } | null) : null;
  if (!rc) return preview ? { status: 'skipped', why: 'season recap unreadable' } : skip('season recap unreadable');
  // Each fund's name and book size (the data run's index.json), for "Matthew McLennan (First Eagle)" and % of fund.
  const idx = (await fetch(`${env.DATA_URL}index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { managers?: { slug: string; name?: string; manager?: string; total_value?: number }[] } | null;
  const funds = new Map((idx?.managers ?? []).map((x) => [x.slug, x]));
  const firmOf = (slug: string, fallback = '') => (funds.get(slug)?.name ? shortFirm(slug, funds.get(slug)!.name!) : fallback);
  const whoOf = (slug: string, manager: string, name = '') => {
    if (siteName(slug)) return siteName(slug)!;
    const person = plainName(manager);
    const firm = firmOf(slug, name ? shortFirm(slug, name) : '');
    return firm && !person.toLowerCase().includes(firm.toLowerCase()) ? `${person} (${firm})` : person;
  };
  const filedToday = new Set((rc.filing ?? []).filter((f) => f.filing_date === day).map((f) => f.slug));
  // The top buy and the top sell of each manager that filed today (exits count), managers by their largest move,
  // at most 6 rows: at least 2 managers when 2 filed.
  const cands = (rc.biggest ?? []).filter((b) => filedToday.has(b.slug) && VERB[b.change]).sort((x, y) => Math.abs(y.delta_value) - Math.abs(x.delta_value));
  const picked: typeof cands = [];
  for (const slug of [...new Set(cands.map((b) => b.slug))]) {
    if (picked.length >= 6) break;
    const mine = cands.filter((b) => b.slug === slug);
    picked.push(...[mine.find((b) => b.delta_value < 0), mine.find((b) => b.delta_value > 0)].filter((b): b is (typeof cands)[number] => !!b).sort((x, y) => Math.abs(y.delta_value) - Math.abs(x.delta_value)).slice(0, 6 - picked.length));
  }
  const biggest: E2Move[] = picked.map((b) => {
    const total = funds.get(b.slug)?.total_value;
    return { slug: b.slug, who: whoOf(b.slug, b.manager), firm: siteFirm(b.slug) ?? firmOf(b.slug, plainName(b.manager)), usd: b.delta_value, change: b.change, what: subjectName(b.name, b.ticker), text: `${VERB[b.change]} ${subjectName(b.name, b.ticker)} ${b.delta_value > 0 ? '+' : '−'}${money(b.delta_value)}${pctOf(total ? b.delta_value / total : null)}` };
  });
  // Still due, for the preheader when a member's follows have all filed: the superinvestors still to file.
  const seasonDue = [...ctx.expected].map(([s, x]) => siteName(s) ?? plainName(x.manager)).slice(0, 2);
  // "In your names" for members who saved names: this week's cached facts and Copy's hook (no SEC reads here).
  let week: Week | null = null;
  const mails = await Promise.all(members.map(async (m) => {
    const f = follows.get(m.customer)!;
    // One row per follow (filed this season first, then the ones still due), at most 6.
    const rows: E2Follow[] = f.investors
      .map((s) => {
        const a = ctx.filed.get(s);
        const filed = a && a.quarter === season ? a : null;
        return { who: filed ? whoOf(s, filed.manager, filed.name) : siteName(s) ?? plainName(ctx.expected.get(s)?.manager ?? a?.manager ?? funds.get(s)?.manager ?? slugName(s)), a: filed, expected: filed ? null : (ctx.expected.get(s)?.date ?? null) };
      })
      .sort((x, y) => Number(!!y.a) - Number(!!x.a) || (y.a ? Date.parse(y.a.accepted ?? `${y.a.filing_date}T21:00:00Z`) - Date.parse(x.a!.accepted ?? `${x.a!.filing_date}T21:00:00Z`) : 0))
      .slice(0, 6);
    const due = rows.filter((r) => !r.a).map((r) => r.who);
    let yours: InYourNames | null = null;
    if (f.owned?.length) {
      week ??= JSON.parse((await env.DB.get('free:week')) ?? 'null') ?? (await weeklyMoves(env, now));
      yours = await inYourNames(env, f.owned.slice(0, FREE_NAMES), week!, now, 0);
    }
    const unsub = m.customer.startsWith('preview:') ? `${env.SITE_URL}unsubscribe/` : await unsubscribeUrl(env, m.customer);
    const mail = email2Mail(env, m.email, { now, season, rows, due: due.length ? due : seasonDue, biggest, yours, follows: f.investors.length > 0, unsub, postal: postal || '[postal address: not configured yet]' });
    return preview ? { ...mail, subject: `[Preview] ${mail.subject}` } : mail;
  }));
  // A dry preview returns the rendered emails (test inboxes only) and sends nothing: no quota spent.
  if (preview && dry) return { status: 'dry', sent: 0, mails: mails.map((x) => ({ to: x.to, subject: x.subject, text: x.text, html: x.html })) };
  const status = await sendMail(env, mails, preview && !env.MAILGUN_API_KEY ? { preview: true } : { via: 'mailgun', preview: !!preview });
  if (!preview) await env.DB.put('e2:done', JSON.stringify({ at: new Date(now).toISOString(), sent: mails.length, status }));
  return { status, sent: mails.length, filed_today: filedToday.size, biggest: biggest.length };
}

/** Fridays after EDGAR closes: free members who haven't unsubscribed, once per week. */
export async function runWeekly(env: Env, now: number): Promise<Record<string, unknown>> {
  const week = etDay(now);
  if ((await env.DB.get('weekly:last')) === week) return { status: 'already sent', week };
  // The scheduler retries a missed Saturday run; a run that got as far as sending is never repeated (no double sends).
  if ((await env.DB.get('weekly:tried')) === week) return { status: 'already tried', week };
  const members: Member[] = [];
  const follows = new Map<string, Follows>();
  for (const m of await listMembers(env)) {
    // A free signup who later subscribed: their email now points at the paid member.
    if (m.status !== 'free' || m.marketing_off || !m.email || (await env.DB.get(`email:${m.email}`)) !== m.customer) continue;
    members.push(m);
    follows.set(m.customer, await getFollows(env, m));
  }
  const moves = await weeklyMoves(env, now, 7, new Set([...follows.values()].flatMap((f) => f.investors)));
  // Followers are promised their funds' moves in this email: it goes whenever anyone follows a fund.
  if (!moves.buys.length && !moves.sells.length && ![...follows.values()].some((f) => f.investors.length)) return { status: 'no moves', week };
  // Followed investors' moves, and superinvestor moves in followed stocks.
  // Followed investors lead ("Your follows": each one's 13F in the alert's format, else when it's expected); then their
  // Form 4 and 13D/G trades this week and superinvestor moves in followed stocks.
  const ctx = await followContext(env, [...follows.values()].flatMap((f) => f.investors));
  const followedMoves = (f: Follows | undefined) => moves.all.filter((x) => (f?.investors.includes(x.slug) && !/^13F/.test(x.form)) || (x.featured && f?.stocks.includes(x.ticker))).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)).slice(0, 8);
  const weekOf = weekWindow(now);
  const mails = await Promise.all(members.map(async (m) => weeklyMail(env, m.email, moves, weekOf, await unsubscribeUrl(env, m.customer), await inYourNames(env, follows.get(m.customer)!.owned.slice(0, FREE_NAMES), moves, now), followedMoves(follows.get(m.customer)), await followsSection(env, follows.get(m.customer)!, now, ctx))));
  await env.DB.put('weekly:tried', week, { expirationTtl: 8 * 86400 });
  const status = await sendMail(env, mails, { tier: 'low' });
  if (status === 'none' || status.split(',').every((s) => s === '200')) await env.DB.put('weekly:last', week);
  return { status, sent: mails.length, buys: moves.buys.length, sells: moves.sells.length };
}

/** A free signup's key: derived from the email, so one email has one free record. */
export async function freeId(email: string): Promise<string> {
  const id = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`free:${email.trim().toLowerCase()}`)));
  return `free_${[...id.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A free signup who subscribes: one account per email. The paid member takes their source, names, follows and
 * channels; the free record becomes an alias (`converted_to`), so its sessions and sign-in links open the paid
 * account (getMember follows it). Names union, so a re-run, or names added on either side, are kept.
 */
export async function carryFreeSignup(env: Env, m: Member): Promise<Member> {
  if (!m.email) return m;
  const raw = await env.DB.get(`cus:${await freeId(m.email)}`);
  const free = raw ? (JSON.parse(raw) as Member) : null;
  if (!free || free.status !== 'free' || free.customer === m.customer) return m;
  const investors = await mergeFollows(env, free.customer, m.customer);
  if (!(await env.DB.get(`channels:${m.customer}`))) {
    const ch = await env.DB.get(`channels:${free.customer}`);
    if (ch) await env.DB.put(`channels:${m.customer}`, ch);
  }
  // Written without the email index: the paid member owns the email from here.
  await env.DB.put(`cus:${free.customer}`, JSON.stringify({ ...free, converted_to: m.customer }));
  return {
    ...m,
    ...(investors && Array.isArray(m.alerts) ? { alerts: [...new Set([...m.alerts, ...investors])] } : {}),
    source: m.source ?? free.source ?? null,
    ...(free.utm && !m.utm ? { utm: free.utm } : {}),
    marketing_off: m.marketing_off ?? free.marketing_off,
    created_at: free.created_at,
    // An address proven on the free record stays proven (its provisional sessions stay ended).
    ...(free.verified ? { verified: true } : {}),
  };
}

/** The free record's lists into the paid member's (a union). Returns the merged investors, or null with nothing to merge. */
async function mergeFollows(env: Env, from: string, to: string): Promise<string[] | null> {
  const a = JSON.parse((await env.DB.get(`follows:${from}`)) ?? 'null') as Record<string, unknown> | null;
  if (!a) return null;
  const b = JSON.parse((await env.DB.get(`follows:${to}`)) ?? '{}') as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  const out: Record<string, unknown> = { ...a, ...b, onboarded: Boolean(a.onboarded || b.onboarded) };
  for (const k of ['investors', 'stocks', 'owned', 'owned_manual', 'peers']) out[k] = [...new Set([...list(b[k]), ...list(a[k])])];
  if (!b.book && a.book) out.book = a.book;
  await env.DB.put(`follows:${to}`, JSON.stringify(out));
  return out.investors as string[];
}

/**
 * Operator: removes a member and everything kept for them under that email (the paid record and its free-signup
 * alias): lists, channels, feed, keys, referral code, stats, reasons. For gate test members and data-deletion
 * requests. Stripe's customer is separate (delete it first, so its webhook can't write the record back).
 */
export async function eraseMember(env: Env, email: string): Promise<{ customers: string[]; deleted: number }> {
  const e = email.trim().toLowerCase();
  const ids = [...new Set([await env.DB.get(`email:${e}`), await freeId(e)].filter((x): x is string => !!x))];
  const keys = new Set<string>([`email:${e}`]);
  for (const c of ids) {
    const ch = JSON.parse((await env.DB.get(`channels:${c}`)) ?? '{}') as { feed_token?: string };
    if (ch.feed_token) keys.add(`feedtok:${ch.feed_token}`);
    for (const k of JSON.parse((await env.DB.get(`apikeys:${c}`)) ?? '[]') as { hash: string }[]) keys.add(`apikey:${k.hash}`);
    const code = await env.DB.get(`refcode:${c}`);
    if (code) keys.add(`ref:${code}`);
    for (const p of ['cus:', 'follows:', 'channels:', 'chfail:', 'feed:', 'sent:', 'stats:', 'why:', 'refcode:', 'refs:', 'seats:', 'apikeys:', 'delivered:', 'pausenote:']) {
      let cursor: string | undefined;
      do {
        const page = await env.DB.list({ prefix: `${p}${c}`, cursor });
        for (const k of page.keys) if (k.name === `${p}${c}` || k.name.startsWith(`${p}${c}:`)) keys.add(k.name);
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
    if (typeof caches !== 'undefined') await (caches as unknown as { default: Cache }).default.delete(`https://copybook.internal/member/${c}`).catch(() => undefined);
  }
  for (const k of keys) await env.DB.delete(k);
  return { customers: ids, deleted: keys.size };
}

/** Operator: merge a free record into the paid member that already took its email (records split before the merge shipped). */
export async function mergeFreeSignup(env: Env, email: string): Promise<Record<string, unknown>> {
  const paid = await memberByEmail(env, email);
  if (!paid || paid.status === 'free') return { ok: false, error: 'no paid member with that email' };
  const merged = await carryFreeSignup(env, paid);
  await putMember(env, merged);
  const f = await getFollows(env, merged);
  return { ok: true, customer: merged.customer, follows: merged.test || testAddress(merged.email) ? f : followCounts(f) };
}

/** Operator: this week's issue for one free member, sent now (a check of what Friday sends; the week isn't marked sent). `dry` returns the text instead. */
/** `postal`: render as if the mailing address were this (a string), or absent (false: the plain newsletter). */
export async function previewWeekly(env: Env, email: string, now: number, dry = false, postal?: string | false): Promise<Record<string, unknown>> {
  const m = await memberByEmail(env, email);
  if (!m || m.status !== 'free') return { ok: false, error: 'no free member with that email' };
  // A preview goes to our inbox or a test inbox only; for a member's address, read it with dry.
  if (!dry && !previewInbox(email)) return { ok: false, error: 'previews send only to hello@ or copybook-test- addresses; use dry: true' };
  const moves = await weeklyMoves(env, now);
  const weekOf = weekWindow(now);
  const f = await changeFollows(env, m, { get: true });
  const fl = f.ok ? f.follows : await getFollows(env, m);
  const yours = await inYourNames(env, fl.owned.slice(0, FREE_NAMES), moves, now);
  const followed = moves.all.filter((x) => (fl.investors.includes(x.slug) && !/^13F/.test(x.form)) || (x.featured && fl.stocks.includes(x.ticker))).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)).slice(0, 8);
  // Before the mailing address is set, a preview shows the issue as it will send, with a marked placeholder for it.
  const penv = postal === false ? { ...env, POSTAL_ADDRESS: '' } : typeof postal === 'string' ? { ...env, POSTAL_ADDRESS: postal } : env.POSTAL_ADDRESS?.trim() ? env : { ...env, POSTAL_ADDRESS: '[postal address: not configured yet]' };
  const mail = weeklyMail(penv, m.email, moves, weekOf, await unsubscribeUrl(env, m.customer), yours, followed, await followsSection(env, fl, now));
  // A real member's issue names their stocks: the operator gets counts only (their own test inboxes show in full).
  const shown = previewInbox(email) || testAddress(email) ? { subject: mail.subject, in_your_names: yours, text: mail.text, html: mail.html } : { customer: m.customer, in_your_names: yours.facts.length, text_chars: mail.text.length };
  if (dry) return { ok: true, sent: false, ...shown };
  return { ok: true, status: await sendMail(env, [mail], { preview: true }), ...shown };
}
