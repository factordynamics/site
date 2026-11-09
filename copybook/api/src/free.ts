/**
 * Free accounts: POST /signup makes a member with no card and no Stripe customer, who gets one email a
 * week (Friday evening, after EDGAR closes) with the week's biggest superinvestor buys and sells and
 * never a real-time alert. Every paid route treats them as inactive. Plus the one unsubscribe link
 * that every marketing and lifecycle email carries.
 */
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
  /** One of the curated superinvestors (index.json `featured`): ranked ahead of every other fund. */
  featured: boolean;
  accession: string;
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
const plainName = (n: string) => n.replace(/,?\s+(llc|l\.?l\.?c\.?|l\.?p\.?|ltd\.?|limited|inc\.?|co\.?)$/i, '').trim();
const PASSIVE = /\b(vanguard|blackrock|ishares|state street|spdr|geode|dimensional|invesco|schwab|northern trust|index|etf|securities co|morgan stanley|barclays|deutsche bank|ubs|jpmorgan|goldman sachs|citigroup|bank of america|mitsubishi|mizuho|amundi|nomura|wells fargo|royal bank)\b/i;
/** Filing cards read per weekly run (each is a subrequest): the superinvestors' first, then other funds, newest first. */
const MAX_CARDS = 30;

/**
 * The 7 days before `now`: every 13F with a public filing card (its full new, added, trimmed and exited
 * lists) and every Form 4 and 13D/G by a curated filer (pre/events.json, the hourly events build).
 * Superinvestors rank first, each fund at most 2 rows, index and broker flow left out.
 */
export async function weeklyMoves(env: Env, now: number): Promise<Week> {
  const since = now - 7 * 86400_000;
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
    .sort((a, b) => Number(featured.has(b.slug)) - Number(featured.has(a.slug)) || b.filing_date.localeCompare(a.filing_date))
    .slice(0, MAX_CARDS);
  type Row = { ticker: string | null; value_delta: number; put_call?: string | null; name?: string };
  const read = await Promise.all(cards.map((c) => get(`${env.SITE_URL}d/f/${c.accession}.json`)));
  cards.forEach((c, i) => {
    // A card keeps its top 5 moves by size in `moves` (each with `change`); `changes` holds only counts.
    const d = read[i] as { manager?: string; firm?: string; featured?: boolean; moves?: (Row & { change?: string })[] } | null;
    if (!d) return;
    const manager = plainName(d.manager ?? d.firm ?? c.slug);
    if (!d.featured && !featured.has(c.slug) && PASSIVE.test(`${manager} ${d.firm ?? ''}`)) return;
    for (const r of Array.isArray(d.moves) ? d.moves : []) {
      const what = r.change as 'new' | 'added' | 'trimmed' | 'exited';
      if (!r.ticker || r.put_call || !r.value_delta || !['new', 'added', 'trimmed', 'exited'].includes(what) || FUND_SECURITY.test(r.name ?? '')) continue;
      all.push({ manager, slug: c.slug, ticker: r.ticker, what, usd: r.value_delta, form: `13F ${c.quarter.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1')}`, url: `${env.SITE_URL}f/${c.accession}/`, featured: !!d.featured || featured.has(c.slug), accession: c.accession });
    }
  });

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
  // Superinvestors first, then size; at most 2 rows per fund in each list.
  const rank = (xs: WeeklyMove[], sign: 1 | -1) => {
    const per = new Map<string, number>();
    return xs
      .filter((x) => Math.sign(x.usd) === sign)
      .sort((a, b) => Number(b.featured) - Number(a.featured) || Math.abs(b.usd) - Math.abs(a.usd))
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
  x.prev != null && x.pct != null ? `${x.manager}'s stake in ${x.ticker} went ${x.prev}% → ${x.pct}%` : `${x.manager} reported ${x.pct != null ? `a ${x.pct}%` : 'a'} stake in ${x.ticker} (${x.form.replace(/^SCHEDULE /, '')})`;

export interface InYourNames {
  names: number;
  /** One public fact per saved name: its biggest superinvestor move this week (a 13F row, Form 4 or 13D/G). */
  facts: { text: string; url: string }[];
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

/**
 * A free member's block. Facts are public (what the investor pages and filing cards show); the hook names
 * the biggest of what Copy adds: a company insider's open-market trade from $100K (never gifts, grants,
 * withholding or exercises), or another fund's move or 13D/G in their names.
 */
export async function inYourNames(env: Env, names: string[], week: Week, now: number): Promise<InYourNames> {
  const facts: InYourNames['facts'] = [];
  const shown = new Set<string>();
  type Item = { text: string; size: number };
  const locked: Item[] = [];
  for (const t of names) {
    const cands = [
      ...week.all.filter((x) => x.ticker === t).map((x) => ({ key: `${x.accession}|${x.ticker}|${x.what}`, featured: x.featured, size: Math.abs(x.usd), text: `${x.manager} ${FACT[x.what](x)}`, url: x.url })),
      ...week.stakes.filter((x) => x.ticker === t).map((x) => ({ key: x.accession, featured: x.featured, size: 0, text: stakeFact(x), url: x.url })),
    ].sort((a, b) => Number(b.featured) - Number(a.featured) || b.size - a.size);
    const top = cands.find((c) => c.featured);
    if (top) {
      facts.push({ text: `${top.text}, which you own`, url: top.url });
      shown.add(top.key);
    }
    for (const c of cands) if (!shown.has(c.key)) locked.push({ text: c.text, size: c.size });
  }
  // Company insiders and anyone's 13D/G, from the per-stock events the precompute keeps current.
  const { stockEvents } = await import('./stockevents');
  const r = names.length ? await stockEvents(env, names, 50, { budget: 8, freshMs: 6 * 3600_000 }) : { tickers: {} as Record<string, { events: import('./stockevents').StockEvent[] }> };
  const since = new Date(now - 7 * 86400_000).toISOString();
  const fundAcc = new Set([...week.all.map((x) => x.accession), ...week.stakes.map((x) => x.accession)]);
  for (const [t, x] of Object.entries(r.tickers)) {
    for (const e of x.events) {
      if (e.accepted_at < since || fundAcc.has(e.accession)) continue;
      if (e.form.startsWith('4')) {
        if (!e.open_market || !e.value_usd || e.value_usd < INSIDER_MIN_USD) continue;
        const sold = (e.totals?.sold?.shares ?? 0) > (e.totals?.bought?.shares ?? 0);
        locked.push({ text: `${short(e.issuer)}'s ${roleOf(e.role)} ${sold ? 'sold' : 'bought'} ${money(e.value_usd)} of ${t}`, size: e.value_usd });
      } else locked.push({ text: `${e.filer_name} filed a ${e.form.replace(/^SCHEDULE /, '')} on ${t}`, size: 0 });
    }
  }
  locked.sort((a, b) => b.size - a.size);
  return { names: names.length, facts, hook: locked[0]?.text ?? null, more: Math.max(0, locked.length - 1) };
}

const LABEL: Record<WeeklyMove['what'], string> = { new: 'new position', added: 'added', trimmed: 'trimmed', exited: 'sold out', bought: 'bought', sold: 'sold' };

export function weeklyMail(env: Env, to: string, moves: { buys: WeeklyMove[]; sells: WeeklyMove[] }, weekOf: string, unsub: string, yours?: InYourNames): Mail {
  const line = (x: WeeklyMove) => `${x.manager}: ${LABEL[x.what]} ${x.ticker}, ${x.usd > 0 ? '+' : '−'}${money(x.usd)} (${x.form})`;
  // The subject's fallback: the week's biggest superinvestor move, buy or sell.
  const top = [moves.buys[0], moves.sells[0]].filter((x): x is WeeklyMove => !!x).sort((a, b) => Number(b.featured) - Number(a.featured) || Math.abs(b.usd) - Math.abs(a.usd))[0];
  const pricing = `${env.SITE_URL}pricing/?utm_source=weekly&utm_medium=email`;
  const book = `${env.SITE_URL}my-book/`;
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const locked = yours?.hook ? `${yours.hook}, with Copy${yours.more ? ` (+${yours.more} more in your names)` : ''}` : null;
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

/** Operator: this week's issue for one free member, sent now (a check of what Friday sends; the week isn't marked sent). `dry` returns the text instead. */
export async function previewWeekly(env: Env, email: string, now: number, dry = false): Promise<Record<string, unknown>> {
  const m = await memberByEmail(env, email);
  if (!m || m.status !== 'free') return { ok: false, error: 'no free member with that email' };
  const moves = await weeklyMoves(env, now);
  const weekOf = new Date(now - 6 * 86400_000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const f = await changeFollows(env, m, { get: true });
  const yours = await inYourNames(env, (f.ok ? f.follows : await getFollows(env, m)).owned.slice(0, FREE_NAMES), moves, now);
  const mail = weeklyMail(env, m.email, moves, weekOf, await unsubscribeUrl(env, m.customer), yours);
  if (dry) return { ok: true, sent: false, subject: mail.subject, in_your_names: yours, text: mail.text };
  return { ok: true, status: await sendMail(env, [mail]), subject: mail.subject, in_your_names: yours };
}
