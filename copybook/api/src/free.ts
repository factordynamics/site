/**
 * Free accounts: POST /signup makes a member with no card and no Stripe customer, who gets one email a
 * week (Friday evening, after EDGAR closes) with the week's biggest superinvestor buys and sells and
 * never a real-time alert. Every paid route treats them as inactive. Plus the one unsubscribe link
 * that every marketing and lifecycle email carries.
 */
import type { Alert13F, AlertEvent } from './alerts';
import { FOOTER, sendMail, type Mail } from './email';
import type { Env, Member } from './env';
import { getMember, listMembers, LOGIN_TTL, memberByEmail, putMember } from './members';
import { bump } from './revenue';
import { signToken, verifyToken } from './tokens';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const etDay = (t: number) => new Date(t - 5 * 3600_000).toISOString().slice(0, 10);

const api = (env: Env) => env.API_URL ?? 'https://copybook-api.factordynamics.workers.dev/';

/** One link that stops the weekly and lifecycle email for this member (alerts and billing email still come). */
export async function unsubscribeUrl(env: Env, customer: string): Promise<string> {
  return `${api(env)}unsubscribe?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'unsub', customer, 3 * 365 * 86400))}`;
}

const isTest = (email: string) => email.startsWith('copybook-test-');

type Json = Record<string, unknown>;
type Reply = { status: number; body: Json; headers?: Record<string, string> };

export async function handleSignup(env: Env, b: Json, ip: string): Promise<Reply> {
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { status: 400, body: { ok: false, error: 'Check the email address and try again.', code: 'bad_request' } };
  // The hidden `website` field: a bot filled it. Looks like success, does nothing.
  if (str(b.website, 200)) return { status: 200, body: { ok: true } };
  for (const [k, max] of [[`rl:signup-ip:${ip}`, 5], [`rl:signup:${email}`, 3]] as const) {
    const n = Number((await env.DB.get(k)) ?? 0);
    if (n >= max) return { status: 429, body: { ok: false, error: 'Too many tries. Please try again in an hour.', code: 'rate_limited' }, headers: { 'retry-after': '3600' } };
    await env.DB.put(k, String(n + 1), { expirationTtl: 3600 });
  }
  const utm = Object.fromEntries(UTM.map((k) => [k, str(b[k], 100)]).filter(([, v]) => v)) as Record<string, string>;
  const source = str(b.source, 60) ?? utm.utm_source ?? null;
  const cur = await memberByEmail(env, email);
  // Already a member: nothing to create. Free members get their sign-in link again; paying members already get more.
  if (cur && cur.status !== 'canceled') {
    if (cur.status === 'free') await sendMail(env, [await freeWelcomeMail(env, cur, false)]);
    return { status: 200, body: { ok: true } };
  }
  const id = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`free:${email}`)));
  const m: Member = {
    customer: `free_${[...id.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('')}`,
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
  if (!isTest(email)) await bump(env, 'signups', m);
  const mail = await sendMail(env, [await freeWelcomeMail(env, m, true)]);
  return { status: 201, body: { ok: true, created: true, welcome: mail === '200' ? 'sent' : 'not sent' } };
}

async function freeWelcomeMail(env: Env, m: Member, first: boolean): Promise<Mail> {
  const link = `${env.SITE_URL}account/?login=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'login', m.customer, LOGIN_TTL))}`;
  const unsub = await unsubscribeUrl(env, m.customer);
  return {
    to: m.email,
    subject: first ? "You're on the Copybook weekly" : 'Your Copybook sign-in link',
    text: `${first ? "You're signed up for the Copybook weekly: every Friday evening, the week's biggest superinvestor buys and sells from their SEC filings, with a link to each filing." : "Here is your sign-in link. You're on the free Copybook weekly, every Friday evening."}\n\nSign in (link works for 7 days): ${link}\n\nWant each filing minutes after EDGAR accepts it, 13F history and CSV? Copy is free for 14 days: ${env.SITE_URL}pricing/\n\nUnsubscribe: ${unsub}${FOOTER}`,
    unsubscribe: unsub,
  };
}

/** GET shows a confirmation page; POST (and the mail client's one-click POST) unsubscribes at once. */
export async function handleUnsubscribe(env: Env, req: Request, url: URL): Promise<Response> {
  const page = (msg: string) =>
    new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Copybook</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#111">${msg}<p style="color:#6b7280;font-size:14px"><a href="${env.SITE_URL}" style="color:#1d4ed8">Copybook</a></p></body>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  const t = url.searchParams.get('t') ?? '';
  const p = await verifyToken(env.SESSION_SECRET, t, 'unsub');
  const m = p && (await getMember(env, p.c));
  if (!m) return page('<p>This link has expired.</p>');
  if (req.method === 'GET' && url.searchParams.get('confirm') !== '1') {
    const what = m.status === 'free' ? 'the Copybook weekly' : 'Copybook tips and plan reminders (your alerts and billing emails keep coming)';
    return page(`<p>Unsubscribe ${m.email} from ${what}?</p><form method="post"><button style="font:inherit;padding:6px 14px">Unsubscribe</button></form>`);
  }
  if (!m.marketing_off) await putMember(env, { ...m, marketing_off: true });
  return page(`<p>Done: ${m.email} won't get ${m.status === 'free' ? 'the weekly' : 'tips or plan reminders'} any more.</p>`);
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
}

const money = (v: number) => {
  const a = Math.abs(v);
  return a >= 1e9 ? `$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : `$${Math.round(a / 1e3)}K`;
};

/** The week's biggest buys and sells, five each, from the alert stores of the last 7 ET days. */
export async function weeklyMoves(env: Env, now: number): Promise<{ buys: WeeklyMove[]; sells: WeeklyMove[] }> {
  const filings: Alert13F[] = [];
  const events: AlertEvent[] = [];
  for (let d = 0; d < 7; d++) {
    const day = await env.DB.get(`digest:${etDay(now - d * 86400_000)}`);
    if (!day) continue;
    const s = JSON.parse(day) as { filings: Alert13F[]; events: AlertEvent[] };
    filings.push(...s.filings.filter((a) => a.moves && !a.extra));
    events.push(...s.events.filter((e) => e.kind === 'form4' && !e.extra && !e.insider && !e.cluster && e.slug));
  }
  let cards = new Set<string>();
  try {
    const res = await fetch(`${env.SITE_URL}d/f/index.json`);
    if (res.ok) cards = new Set(((await res.json()) as { cards: { accession: string }[] }).cards.map((c) => c.accession));
  } catch {
    /* investor pages instead */
  }
  const investor = (slug: string) => `${env.SITE_URL}investors/${slug}/`;
  const all: WeeklyMove[] = [];
  const seen = new Set<string>();
  for (const a of filings) {
    // A follow-up repeats its filing with moves: count each filing once.
    if (seen.has(a.accession)) continue;
    seen.add(a.accession);
    const url = cards.has(a.accession) ? `${env.SITE_URL}f/${a.accession}/` : investor(a.slug);
    for (const what of ['new', 'added', 'trimmed', 'exited'] as const) {
      for (const r of a.moves![what] ?? []) {
        if (!r.ticker || r.put_call) continue;
        all.push({ manager: a.manager, slug: a.slug, ticker: r.ticker, what, usd: r.value_delta, form: `13F ${a.quarter.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1')}`, url });
      }
    }
  }
  for (const e of events) {
    if (!e.ticker || !e.value_usd || (e.action !== 'buy' && e.action !== 'sell')) continue;
    all.push({ manager: e.manager, slug: e.slug, ticker: e.ticker, what: e.action === 'buy' ? 'bought' : 'sold', usd: e.action === 'buy' ? e.value_usd : -e.value_usd, form: 'Form 4', url: investor(e.slug) });
  }
  return {
    buys: all.filter((x) => x.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 5),
    sells: all.filter((x) => x.usd < 0).sort((a, b) => a.usd - b.usd).slice(0, 5),
  };
}

const LABEL: Record<WeeklyMove['what'], string> = { new: 'new position', added: 'added', trimmed: 'trimmed', exited: 'sold out', bought: 'bought', sold: 'sold' };

export function weeklyMail(env: Env, to: string, moves: { buys: WeeklyMove[]; sells: WeeklyMove[] }, weekOf: string, unsub: string): Mail {
  const line = (x: WeeklyMove) => `${x.manager}: ${LABEL[x.what]} ${x.ticker}, ${x.usd > 0 ? '+' : '−'}${money(x.usd)} (${x.form})`;
  const top = moves.buys[0] ?? moves.sells[0];
  const pricing = `${env.SITE_URL}pricing/?utm_source=weekly&utm_medium=email`;
  const row = (x: WeeklyMove) =>
    `<tr><td style="padding:4px 8px 4px 0">${esc(x.manager)}</td><td style="padding:4px 8px"><b>${esc(x.ticker)}</b> ${LABEL[x.what]}</td><td style="padding:4px 8px;text-align:right;color:${x.usd > 0 ? '#047857' : '#b91c1c'}">${x.usd > 0 ? '+' : '−'}${money(x.usd)}</td><td style="padding:4px 0 4px 8px"><a href="${x.url}" style="color:#1d4ed8">${esc(x.form)}</a></td></tr>`;
  const table = (title: string, xs: WeeklyMove[]) => (xs.length ? `<h3 style="font-size:15px;margin:18px 0 6px">${title}</h3><table style="border-collapse:collapse;font-size:14px">${xs.map(row).join('')}</table>` : '');
  return {
    to,
    subject: `The week in superinvestor filings: ${top ? `${top.manager} ${LABEL[top.what]} ${top.ticker}` : 'the biggest moves'}`,
    text: `Superinvestor filings, week of ${weekOf}.\n\nBiggest buys:\n${moves.buys.map((x) => `  ${line(x)}\n    ${x.url}`).join('\n') || '  none this week'}\n\nBiggest sells:\n${moves.sells.map((x) => `  ${line(x)}\n    ${x.url}`).join('\n') || '  none this week'}\n\nThese came days after the filings. Copy emails each one minutes after EDGAR accepts it, with 13F history and CSV; free for 14 days: ${pricing}\n\nUnsubscribe: ${unsub}${FOOTER}`,
    html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:600px"><p>Superinvestor filings, week of ${esc(weekOf)}.</p>${table('Biggest buys', moves.buys)}${table('Biggest sells', moves.sells)}<p style="margin-top:20px">These came days after the filings. <a href="${pricing}" style="color:#1d4ed8"><b>Copy</b></a> emails each one minutes after EDGAR accepts it, with 13F history and CSV. Free for 14 days.</p><p style="color:#6b7280;font-size:12px;margin-top:24px">Source: SEC EDGAR filings, as filed. Not investment advice. Copybook by Factor Dynamics. <a href="${unsub}" style="color:#6b7280">Unsubscribe</a></p></div>`,
    unsubscribe: unsub,
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Fridays after EDGAR closes: free members who haven't unsubscribed, once per week. */
export async function runWeekly(env: Env, now: number): Promise<Record<string, unknown>> {
  const week = etDay(now);
  if ((await env.DB.get('weekly:last')) === week) return { status: 'already sent', week };
  const moves = await weeklyMoves(env, now);
  if (!moves.buys.length && !moves.sells.length) return { status: 'no moves', week };
  const members: Member[] = [];
  for (const m of await listMembers(env)) {
    // A free signup who later subscribed: their email now points at the paid member.
    if (m.status !== 'free' || m.marketing_off || !m.email || (await env.DB.get(`email:${m.email}`)) !== m.customer) continue;
    members.push(m);
  }
  const weekOf = new Date(now - 6 * 86400_000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const mails = await Promise.all(members.map(async (m) => weeklyMail(env, m.email, moves, weekOf, await unsubscribeUrl(env, m.customer))));
  const status = await sendMail(env, mails);
  if (status === 'none' || status.split(',').every((s) => s === '200')) await env.DB.put('weekly:last', week);
  return { status, sent: mails.length, buys: moves.buys.length, sells: moves.sells.length };
}

/** A free signup who subscribes: the paid member takes their source, and the free record is marked converted. */
export async function carryFreeSignup(env: Env, m: Member): Promise<Member> {
  const free = m.email ? await memberByEmail(env, m.email) : null;
  if (!free || free.status !== 'free' || free.customer === m.customer) return m;
  await putMember(env, { ...free, converted_to: m.customer });
  return { ...m, source: m.source ?? free.source ?? null, ...(free.utm && !m.utm ? { utm: free.utm } : {}), marketing_off: m.marketing_off ?? free.marketing_off, created_at: free.created_at };
}
