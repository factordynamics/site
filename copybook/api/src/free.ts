/**
 * Free accounts: POST /signup makes a member with no card and no Stripe customer, who gets one email a
 * week (Friday evening, after EDGAR closes) with the week's biggest superinvestor buys and sells and
 * never a real-time alert. Every paid route treats them as inactive. Plus the one unsubscribe link
 * that every marketing and lifecycle email carries.
 */
import type { Alert13F, AlertEvent } from './alerts';
import { FOOTER, sendMail, type Mail } from './email';
import type { Env, Member } from './env';
import { changeFollows, getFollows, getMember, listMembers, LOGIN_TTL, memberByEmail, putMember } from './members';
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
export interface Week {
  buys: WeeklyMove[];
  sells: WeeklyMove[];
  /** Every fund move of the week (13F rows and curated filers' Form 4 trades), for the per-member block. */
  all: WeeklyMove[];
  /** Curated filers' 13D/G on a ticker: fund moves too, not shown as facts. */
  stakes: { ticker: string; accession: string }[];
  /** Company insiders' trades the minute poll saw (buys and clusters on watched names). */
  insiders: { ticker: string; accession: string }[];
}

export async function weeklyMoves(env: Env, now: number): Promise<Week> {
  const filings: Alert13F[] = [];
  const events: AlertEvent[] = [];
  const stakes: Week['stakes'] = [];
  const insiders: Week['insiders'] = [];
  for (let d = 0; d < 7; d++) {
    const day = await env.DB.get(`digest:${etDay(now - d * 86400_000)}`);
    if (!day) continue;
    const s = JSON.parse(day) as { filings: Alert13F[]; events: AlertEvent[] };
    filings.push(...s.filings.filter((a) => a.moves && !a.extra));
    events.push(...s.events.filter((e) => e.kind === 'form4' && !e.extra && !e.insider && !e.cluster && e.slug));
    for (const e of s.events) {
      const ts = [...new Set([e.ticker, ...(e.subject_tickers ?? [])].filter((t): t is string => !!t))];
      if (e.insider || e.cluster) insiders.push(...ts.map((ticker) => ({ ticker, accession: e.id.replace(/^cluster:\d+:/, '') })));
      else if (e.kind !== 'form4' && e.slug && !e.extra) stakes.push(...ts.map((ticker) => ({ ticker, accession: e.id })));
    }
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
    all,
    stakes,
    insiders,
  };
}

/** Free accounts may save this many owned names; the Friday email leads with them. */
export const FREE_NAMES = 5;

const FACT: Record<WeeklyMove['what'], (x: WeeklyMove) => string> = {
  new: (x) => `opened a ${money(x.usd)} position in ${x.ticker}`,
  added: (x) => `added ${money(x.usd)} of ${x.ticker}`,
  trimmed: (x) => `trimmed ${money(x.usd)} of ${x.ticker}`,
  exited: (x) => `sold out of ${x.ticker} (${money(x.usd)})`,
  bought: (x) => `bought ${money(x.usd)} of ${x.ticker}`,
  sold: (x) => `sold ${money(x.usd)} of ${x.ticker}`,
};

export interface InYourNames {
  names: number;
  /** One public fact per saved name that moved: its largest fund move this week. */
  facts: { text: string; url: string }[];
  /** What Copy would show on top: the other fund moves and the insider trades in these names. */
  more_fund: number;
  insiders: number;
}

/**
 * A free member's block. Facts use only what free pages show (fund 13F moves and curated filers'
 * Form 4s, each linked to its card or investor page); insider trades are counted, never shown.
 * Insider Form 4s also come from the per-stock cache (tev/, filled by My book's /events), read only.
 */
export async function inYourNames(env: Env, names: string[], week: Week, now: number): Promise<InYourNames> {
  const mine = new Set(names);
  const facts: InYourNames['facts'] = [];
  let fund = 0;
  for (const t of names) {
    const rows = week.all.filter((x) => x.ticker === t).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
    fund += rows.length + new Set(week.stakes.filter((x) => x.ticker === t).map((x) => x.accession)).size;
    if (rows[0]) facts.push({ text: `${rows[0].manager} ${FACT[rows[0].what](rows[0])}, which you own`, url: rows[0].url });
  }
  const ins = new Set(week.insiders.filter((x) => mine.has(x.ticker)).map((x) => x.accession));
  const since = new Date(now - 7 * 86400_000).toISOString();
  for (const t of names) {
    const o = await env.HIST.get(`tev/${t}.json`);
    if (!o) continue;
    const c = JSON.parse(await new Response(o.body).text()) as { seen?: Record<string, { form: string; accepted_at: string } | 0> };
    for (const [acc, e] of Object.entries(c.seen ?? {})) if (e && e.form.startsWith('4') && e.accepted_at >= since) ins.add(acc);
  }
  return { names: names.length, facts, more_fund: fund - facts.length, insiders: ins.size };
}

const LABEL: Record<WeeklyMove['what'], string> = { new: 'new position', added: 'added', trimmed: 'trimmed', exited: 'sold out', bought: 'bought', sold: 'sold' };

export function weeklyMail(env: Env, to: string, moves: { buys: WeeklyMove[]; sells: WeeklyMove[] }, weekOf: string, unsub: string, yours?: InYourNames): Mail {
  const line = (x: WeeklyMove) => `${x.manager}: ${LABEL[x.what]} ${x.ticker}, ${x.usd > 0 ? '+' : '−'}${money(x.usd)} (${x.form})`;
  const top = moves.buys[0] ?? moves.sells[0];
  const pricing = `${env.SITE_URL}pricing/?utm_source=weekly&utm_medium=email`;
  const book = `${env.SITE_URL}my-book/`;
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const lockedParts = yours ? [yours.insiders && `${n(yours.insiders, 'insider trade')}`, yours.more_fund && `${n(yours.more_fund, 'fund move')}`].filter(Boolean) : [];
  const locked = lockedParts.length ? `+${lockedParts.join(' and ')} in your names, with Copy` : null;
  const trial = 'Try Copy free for 14 days';
  // Leads the email: what moved in the names they saved, then what Copy adds. No names yet: how to add them.
  const yoursText = !yours
    ? ''
    : !yours.names
      ? `Save up to ${FREE_NAMES} names you own and this email leads with them: ${book}\n\n`
      : `In your names:\n${yours.facts.map((f) => `  ${f.text}.\n    ${f.url}`).join('\n') || `  None of your ${n(yours.names, 'name')} moved in superinvestor filings this week.`}\n${locked ? `  ${locked}: ${pricing}\n` : ''}\n`;
  const yoursHtml = !yours
    ? ''
    : !yours.names
      ? `<p style="background:#f3f4f6;border-radius:10px;padding:12px 14px">Save up to ${FREE_NAMES} names you own in <a href="${book}" style="color:#1d4ed8">My book</a> and this email leads with them.</p>`
      : `<div style="background:#f3f4f6;border-radius:10px;padding:12px 14px"><h3 style="font-size:15px;margin:0 0 6px">In your names</h3>${yours.facts.map((f) => `<p style="margin:4px 0"><a href="${f.url}" style="color:#111;text-decoration:none">${esc(f.text)}.</a></p>`).join('') || `<p style="margin:4px 0">None of your ${n(yours.names, 'name')} moved in superinvestor filings this week.</p>`}${locked ? `<p style="margin:8px 0 4px;color:#6b7280">🔒 ${esc(locked)}</p><p style="margin:8px 0 0"><a href="${pricing}" style="display:inline-block;background:#111;color:#fff;padding:8px 16px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px">${trial}</a></p>` : ''}</div>`;
  const lead = yours?.facts[0];
  const row = (x: WeeklyMove) =>
    `<tr><td style="padding:4px 8px 4px 0">${esc(x.manager)}</td><td style="padding:4px 8px;white-space:nowrap"><b>${esc(x.ticker)}</b> ${LABEL[x.what]}</td><td style="padding:4px 8px;text-align:right;white-space:nowrap;color:${x.usd > 0 ? '#047857' : '#b91c1c'}">${x.usd > 0 ? '+' : '−'}${money(x.usd)}</td><td style="padding:4px 0 4px 8px"><a href="${x.url}" style="color:#1d4ed8">${esc(x.form)}</a></td></tr>`;
  const table = (title: string, xs: WeeklyMove[]) => (xs.length ? `<h3 style="font-size:15px;margin:18px 0 6px">${title}</h3><table style="border-collapse:collapse;font-size:14px">${xs.map(row).join('')}</table>` : '');
  return {
    to,
    subject: lead ? `In your names: ${lead.text.replace(/, which you own$/, '')}` : `The week in superinvestor filings: ${top ? `${top.manager} ${LABEL[top.what]} ${top.ticker}` : 'the biggest moves'}`,
    text: `Superinvestor filings, week of ${weekOf}.\n\n${yoursText}Biggest buys:\n${moves.buys.map((x) => `  ${line(x)}\n    ${x.url}`).join('\n') || '  none this week'}\n\nBiggest sells:\n${moves.sells.map((x) => `  ${line(x)}\n    ${x.url}`).join('\n') || '  none this week'}\n\nThese came days after the filings. Copy emails each one minutes after EDGAR accepts it, with 13F history and CSV; free for 14 days: ${pricing}\n\nUnsubscribe: ${unsub}${FOOTER}`,
    html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:600px"><p>Superinvestor filings, week of ${esc(weekOf)}.</p>${yoursHtml}${table('Biggest buys', moves.buys)}${table('Biggest sells', moves.sells)}<p style="margin-top:20px">These came days after the filings. <a href="${pricing}" style="color:#1d4ed8"><b>Copy</b></a> emails each one minutes after EDGAR accepts it, with 13F history and CSV. Free for 14 days.</p><p style="color:#6b7280;font-size:12px;margin-top:24px">Source: SEC EDGAR filings, as filed. Not investment advice. Copybook by Factor Dynamics. <a href="${unsub}" style="color:#6b7280">Unsubscribe</a></p></div>`,
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
  const mails = await Promise.all(members.map(async (m) => weeklyMail(env, m.email, moves, weekOf, await unsubscribeUrl(env, m.customer), await inYourNames(env, (await getFollows(env, m)).owned.slice(0, FREE_NAMES), moves, now))));
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

/** Operator: this week's issue for one free member, sent now (a check of what Friday sends; the week isn't marked sent). */
export async function previewWeekly(env: Env, email: string, now: number): Promise<Record<string, unknown>> {
  const m = await memberByEmail(env, email);
  if (!m || m.status !== 'free') return { ok: false, error: 'no free member with that email' };
  const moves = await weeklyMoves(env, now);
  const weekOf = new Date(now - 6 * 86400_000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const f = await changeFollows(env, m, { get: true });
  const yours = await inYourNames(env, (f.ok ? f.follows : await getFollows(env, m)).owned.slice(0, FREE_NAMES), moves, now);
  const mail = weeklyMail(env, m.email, moves, weekOf, await unsubscribeUrl(env, m.customer), yours);
  return { ok: true, status: await sendMail(env, [mail]), subject: mail.subject, in_your_names: yours };
}
