import type { Alert13F, AlertEvent } from './alerts';
import { FOOTER, sendMail, type Mail } from './email';
import { isActive, type Env, type Member } from './env';
import { unsubscribeUrl } from './free';
import { getFollows, getMember, listMembers, putMember } from './members';
import { stripe } from './stripe';
import { signToken, verifyToken } from './tokens';

/**
 * Lifecycle email for paying Copybook members (never Holdterm, never Fund seats, who don't pay):
 * a trial-ending reminder, the filing-season recap with a yearly offer for monthly members, and a
 * one-question follow-up when someone cancels. Plus the counts behind /health's business summary.
 */

const PRICES: Record<string, { name: string; month: number; year: number }> = {
  copy: { name: 'Copy', month: 9, year: 79 },
  pro: { name: 'Copy Pro', month: 39, year: 390 },
  fund: { name: 'Copy Fund', month: 199, year: 1990 },
};

const billable = (m: Member) => m.plan !== 'holdterm' && !m.seat_of && !m.comped && !!PRICES[m.plan];
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
const money = (n: number) => `$${n.toLocaleString('en-US')}`;

/** What one member got (email, digest or chat), for the trial and season emails: KV stats:{customer}. */
export interface MemberStats {
  /** Alerts delivered. */
  n: number;
  /** Filings covered (accessions, the latest 300). */
  acc: string[];
  /** Names the member owns that moved in those filings. */
  owned: string[];
  /** Fastest EDGAR acceptance to delivery, seconds (live alerts only, not replays or late ones). */
  fastest: number | null;
  fastest_what?: string;
}

export async function memberStats(env: Env, customer: string): Promise<MemberStats> {
  const raw = await env.DB.get(`stats:${customer}`);
  if (raw) return JSON.parse(raw) as MemberStats;
  // Before stats:, only a count was kept.
  return { n: Number((await env.DB.get(`sent:${customer}`)) ?? 0), acc: [], owned: [], fastest: null };
}

export async function countAlerts(env: Env, customer: string, filings: Alert13F[], events: AlertEvent[], owned: string[], now: number, replay: boolean): Promise<void> {
  const n = filings.length + events.length;
  if (!n) return;
  const s = await memberStats(env, customer);
  s.n += n;
  s.acc = [...new Set([...s.acc, ...filings.map((a) => a.accession), ...events.map((e) => e.id.replace(/^cluster:\d+:/, ''))])].slice(-300);
  const mine = new Set(owned);
  const moved = [...filings.flatMap((a) => a.tickers ?? []), ...events.flatMap((e) => [e.ticker, ...(e.subject_tickers ?? [])])].filter((t): t is string => !!t && mine.has(t));
  s.owned = [...new Set([...s.owned, ...moved])].slice(0, 100);
  if (!replay) {
    for (const x of [...filings.map((a) => ({ at: a.accepted, f: a.followup, what: `${a.manager} 13F` })), ...events.map((e) => ({ at: e.accepted ?? e.accepted_at, f: e.followup || e.late, what: `${e.manager} ${e.form}${e.ticker ? ` on ${e.ticker}` : ''}` }))]) {
      const sec = x.at && !x.f ? Math.round((now - Date.parse(x.at)) / 1000) : NaN;
      if (sec >= 0 && (s.fastest === null || sec < s.fastest)) {
        s.fastest = sec;
        s.fastest_what = x.what;
      }
    }
  }
  await env.DB.put(`stats:${customer}`, JSON.stringify(s));
}

/** Alert emails handed to the mailer, per hour, for the last 48 hours (KV stats:sent). */
export async function logSent(env: Env, n: number, now: number): Promise<void> {
  if (!n) return;
  const hour = Math.floor(now / 3600_000);
  const log = (JSON.parse((await env.DB.get('stats:sent')) ?? '[]') as [number, number][]).filter(([h]) => h > hour - 48);
  const cur = log.find(([h]) => h === hour);
  if (cur) cur[1] += n;
  else log.push([hour, n]);
  await env.DB.put('stats:sent', JSON.stringify(log));
}

const etDay = (t: number) => new Date(t - 5 * 3600_000).toISOString().slice(0, 10);
export type FunnelKind = 'signups' | 'trials' | 'trial_to_paid' | 'paid_direct' | 'cancellations';

/**
 * Funnel counts by ET day (KV funnel:{day}, kept 400 days): each kind by source, and the plan mix
 * (plan_interval) of trials and new paid members. `once` dedupes a transition that several Stripe
 * events report (checkout completed, subscription updated) so it counts once.
 */
export async function bump(env: Env, kind: FunnelKind, m: Member, once?: string, now = Date.now()): Promise<void> {
  if (once) {
    const k = `fseen:${once}:${kind}`;
    if (await env.DB.get(k)) return;
    await env.DB.put(k, '1', { expirationTtl: 400 * 86400 });
  }
  const key = `funnel:${etDay(now)}`;
  const d = JSON.parse((await env.DB.get(key)) ?? '{}') as Record<string, Record<string, number>>;
  const src = m.source ?? m.utm?.utm_source ?? 'direct';
  (d[kind] ??= {})[src] = (d[kind][src] ?? 0) + 1;
  if (kind !== 'signups') {
    const mix = `${kind}:${m.plan}_${m.interval}`;
    (d.plan_mix ??= {})[mix] = (d.plan_mix[mix] ?? 0) + 1;
  }
  await env.DB.put(key, JSON.stringify(d), { expirationTtl: 400 * 86400 });
}

/** Counts the member's lifecycle step from Stripe's subscription change. Comped and test members don't count. */
export async function countTransition(env: Env, prev: Member | null, m: Member): Promise<void> {
  if (!billable(m)) return;
  const was = prev?.subscription === m.subscription ? prev.status : null;
  if (m.status === 'trialing' && was !== 'trialing') await bump(env, 'trials', m, m.subscription);
  if (m.status === 'active' && was === 'trialing') await bump(env, 'trial_to_paid', m, m.subscription);
  if (m.status === 'active' && was !== 'trialing' && was !== 'active' && was !== 'past_due') await bump(env, 'paid_direct', m, m.subscription);
  const cancelled = (m.cancel_at_period_end && !(prev?.subscription === m.subscription && prev.cancel_at_period_end)) || (m.status === 'canceled' && was !== null && was !== 'canceled' && !prev?.cancel_at_period_end);
  if (cancelled) await bump(env, 'cancellations', m, m.subscription);
}

/** The funnel for the last `days` ET days: per day, and totals by source. */
export async function funnel(env: Env, now: number, days: number) {
  const by_day: Record<string, Record<string, Record<string, number>>> = {};
  const total: Record<string, Record<string, number>> = {};
  for (let i = 0; i < days; i++) {
    const day = etDay(now - i * 86400_000);
    const raw = await env.DB.get(`funnel:${day}`);
    if (!raw) continue;
    const d = JSON.parse(raw) as Record<string, Record<string, number>>;
    by_day[day] = d;
    for (const [kind, xs] of Object.entries(d)) for (const [k, n] of Object.entries(xs)) (total[kind] ??= {})[k] = (total[kind][k] ?? 0) + n;
  }
  const sum = (kind: string) => Object.values(total[kind] ?? {}).reduce((a, n) => a + n, 0);
  return { days, signups: sum('signups'), trials: sum('trials'), trial_to_paid: sum('trial_to_paid'), paid_direct: sum('paid_direct'), cancellations: sum('cancellations'), by_source: Object.fromEntries(Object.entries(total).filter(([k]) => k !== 'plan_mix')), plan_mix: total.plan_mix ?? {}, by_day };
}

const secs = (n: number) => (n < 120 ? `${n} seconds` : `${Math.round(n / 60)} minutes`);
const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const FOUNDING: Record<string, string> = { pro: 'Your founding price stays at $39/month or $390/year for as long as you stay subscribed.', fund: 'Your founding price stays at $1,990/year for as long as you stay subscribed.' };

/** Day 11 of 14: the member's own numbers this trial, what ends with it, and one button to keep it (yearly preselected). */
export function trialEndingMail(env: Env, m: Member, s: MemberStats, funds: number, owned: number, keep: string, unsub: string, daysLeft = 3): Mail {
  const p = PRICES[m.plan];
  const save = p.month * 12 - p.year;
  const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
  const got = s.n
    ? [
        `Copybook sent you ${plural(s.n, 'alert')}${s.acc.length ? ` covering ${plural(s.acc.length, 'filing')}` : ''}.`,
        s.owned.length ? `${plural(s.owned.length, 'name')} you own moved in them: ${s.owned.slice(0, 6).join(', ')}${s.owned.length > 6 ? ', …' : ''}.` : '',
        s.fastest !== null ? `Your fastest alert reached you ${secs(s.fastest)} after EDGAR accepted the filing${s.fastest_what ? ` (${s.fastest_what})` : ''}.` : '',
      ].filter(Boolean)
    : [`You haven't had an alert yet. Follow a fund or add the names you own and the next filing reaches you within minutes: ${env.SITE_URL}investors/`];
  const lose = [
    `${[funds && `alerts for the ${plural(funds, 'fund')} you follow`, owned && `${funds ? '' : 'alerts on '}the ${plural(owned, 'name')} you own`].filter(Boolean).join(' and ') || 'filing alerts'}, minutes after each filing`,
    '8 quarters of 13F history and CSV export',
    'Slack, Discord, Telegram and RSS delivery',
    ...(m.plan === 'pro' || m.plan === 'fund' ? ['your API keys, /v1 and webhooks'] : []),
    ...(m.plan === 'fund' ? ["your team's seats, shared book and peers"] : []),
  ];
  const yearly = m.interval === 'yearly';
  const cta = yearly ? `Keep ${p.name} (${money(p.year)}/year)` : `Keep ${p.name} yearly: ${money(p.year)}/year, save ${money(save)}`;
  const charge = yearly ? `${money(p.year)}/year` : `${money(p.month)}/month`;
  const founding = FOUNDING[m.plan] ? ` ${FOUNDING[m.plan]}` : '';
  const ends = day(m.trial_end!);
  return {
    to: m.email,
    subject: `Your ${p.name} trial ends in ${daysLeft === 1 ? '1 day' : `${daysLeft} days`}`,
    text: `Your ${p.name} trial ends on ${ends}.\n\nThis trial so far:\n${got.map((g) => `  ${g}`).join('\n')}\n\nIf it ends, you lose:\n${lose.map((l) => `  - ${l}`).join('\n')}\n\n${cta}: ${keep}\n${yearly ? '' : `Or stay monthly at ${charge}: nothing to do, it renews on ${ends}.\n`}${founding ? `${founding.trim()}\n` : ''}\nTo cancel before you're charged: ${env.SITE_URL}account/ (Manage billing).\n\nUnsubscribe from tips and reminders: ${unsub}${FOOTER}`,
    html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:560px"><p>Your ${p.name} trial ends on <b>${ends}</b>.</p><p style="margin-bottom:4px"><b>This trial so far</b></p><ul style="margin-top:0;padding-left:20px">${got.map((g) => `<li>${esc(g)}</li>`).join('')}</ul><p style="margin-bottom:4px"><b>If it ends, you lose</b></p><ul style="margin-top:0;padding-left:20px">${lose.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p style="margin:22px 0 8px"><a href="${keep}" style="display:inline-block;background:#111;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:600">${esc(cta)}</a></p>${founding ? `<p style="font-size:13px;color:#374151;margin:0 0 6px">${esc(founding.trim())}</p>` : ''}<p style="font-size:13px;color:#374151;margin:0">${yearly ? '' : `Or stay monthly at ${charge}: nothing to do, it renews on ${ends}. `}To cancel before you're charged, use Manage billing in <a href="${env.SITE_URL}account/" style="color:#1d4ed8">your account</a>.</p><p style="color:#6b7280;font-size:12px;margin-top:24px">Source: SEC EDGAR filings, as filed. Not investment advice. Copybook by Factor Dynamics. <a href="${unsub}" style="color:#6b7280">Unsubscribe from tips and reminders</a></p></div>`,
    unsubscribe: unsub,
  };
}

/** The trial ended cancelled: one short note offering the monthly plan instead. */
export function winbackMail(env: Env, m: Member, resume: string, unsub: string): Mail {
  const p = PRICES[m.plan];
  return {
    to: m.email,
    subject: `Your ${p.name} trial ended. Monthly is ${money(p.month)}`,
    text: `Your ${p.name} trial has ended and you weren't charged.\n\nIf a year up front was the problem, ${p.name} is ${money(p.month)} a month, cancel any time, with your follows and settings as you left them:\n${resume}\n\nYour account: ${env.SITE_URL}account/\nUnsubscribe: ${unsub}${FOOTER}`,
    unsubscribe: unsub,
  };
}

const API = (env: Env) => env.API_URL ?? 'https://copybook-api.factordynamics.workers.dev/';

/** Sends the day-14 note once per subscription when a trial runs out cancelled (not a mid-trial cancel). */
export async function maybeWinback(env: Env, prev: Member | null, m: Member, now = Date.now()): Promise<void> {
  if (!prev || prev.status !== 'trialing' || m.status !== 'canceled' || !billable(m) || m.marketing_off || !m.email || m.winback_sent === m.subscription) return;
  if (!prev.trial_end || now < prev.trial_end * 1000 - 3600_000) return;
  const resume = `${API(env)}resume?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'resume', m.customer, 30 * 86400, { s: m.plan }))}`;
  if ((await sendMail(env, [winbackMail(env, m, resume, await unsubscribeUrl(env, m.customer))])) === '200') m.winback_sent = m.subscription;
}

/**
 * The email buttons: GET /keep switches a trial to the yearly price on a portal confirm page (the
 * member sees the amount first); GET /resume starts a new monthly subscription at Checkout, no trial.
 */
export async function handleKeepResume(env: Env, path: '/keep' | '/resume', url: URL): Promise<Response> {
  const go = (to: string) => Response.redirect(to, 303);
  const account = `${env.SITE_URL}account/`;
  const p = await verifyToken(env.SESSION_SECRET, url.searchParams.get('t') ?? '', path === '/keep' ? 'keep' : 'resume');
  const m = p && (await getMember(env, p.c));
  if (!m || !PRICES[m.plan]) return go(account);
  try {
    if (path === '/keep') {
      if (!isActive(m) || m.interval === 'yearly') return go(account);
      const sub = await stripe(env, 'GET', `subscriptions/${m.subscription}`);
      const item = sub.items?.data?.[0];
      const price = (await stripe(env, 'GET', 'prices', { 'lookup_keys[]': `${m.plan}_yearly`, active: true })).data?.[0];
      if (!item?.id || !price?.id) return go(account);
      const s = await stripe(env, 'POST', 'billing_portal/sessions', {
        customer: m.customer,
        configuration: env.PORTAL_CONFIGURATION || undefined,
        return_url: account,
        'flow_data[type]': 'subscription_update_confirm',
        'flow_data[subscription_update_confirm][subscription]': m.subscription,
        'flow_data[subscription_update_confirm][items][0][id]': item.id,
        'flow_data[subscription_update_confirm][items][0][price]': price.id,
        'flow_data[subscription_update_confirm][items][0][quantity]': 1,
        'flow_data[after_completion][type]': 'redirect',
        'flow_data[after_completion][redirect][return_url]': `${account}?kept=yearly`,
      });
      return go(s.url);
    }
    const plan = p!.s ?? m.plan;
    const customer = m.customer;
    // Already back on a plan: nothing to start.
    if (isActive(m)) return go(account);
    const price = (await stripe(env, 'GET', 'prices', { 'lookup_keys[]': `${plan}_monthly`, active: true })).data?.[0];
    if (!price?.id) return go(`${env.SITE_URL}pricing/`);
    const cs = await stripe(env, 'POST', 'checkout/sessions', {
      mode: 'subscription',
      customer,
      'line_items[0][price]': price.id,
      'line_items[0][quantity]': 1,
      success_url: `${account}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.SITE_URL}pricing/`,
      'metadata[copybook]': 'resume',
    });
    return go(cs.url);
  } catch (e) {
    console.log(`${path}: ${e}`);
    return go(account);
  }
}

export function seasonRecapMail(env: Env, m: Member, sent: number, funds: number, median: number | null, season: string): Mail {
  const p = PRICES[m.plan];
  const save = p.month * 12 - p.year;
  const speed = median != null ? ` Our median time from EDGAR acceptance to your inbox this season was ${median < 120 ? `${median} seconds` : `${Math.round(median / 60)} minutes`}.` : '';
  return {
    to: m.email,
    subject: `Your ${season} filing season on Copybook, and ${money(save)} off with yearly`,
    text: `The ${season} 13F filing season is in. You followed ${funds} fund${funds === 1 ? '' : 's'} and Copybook sent you ${sent} alert${sent === 1 ? '' : 's'}.${speed}\n\nYou're on ${p.name} monthly: ${money(p.month * 12)} a year. Yearly is ${money(p.year)}, so switching saves ${money(save)}. To switch: ${env.SITE_URL}account/ → Manage billing → Update plan → Yearly. The change takes effect at your next renewal.${FOOTER}`,
  };
}

export const WHY: Record<string, string> = {
  price: 'Too expensive',
  value: 'Not useful enough',
  feature: 'Missing a feature I need',
  alerts: 'Alerts too slow or too noisy',
  temporary: 'Only needed it for a while',
  other: 'Something else',
};

export async function cancelMail(env: Env, m: Member): Promise<Mail> {
  const token = await signToken(env.SESSION_SECRET, 'why', m.customer, 60 * 86400);
  const base = `${env.API_URL ?? 'https://copybook-api.factordynamics.workers.dev/'}why?t=${encodeURIComponent(token)}&r=`;
  const ends = m.cancel_at ?? m.period_end;
  return {
    to: m.email,
    subject: 'One question about your Copybook cancellation',
    text: `Your ${PRICES[m.plan]?.name ?? 'Copybook'} plan is cancelled${ends ? ` and stays active until ${day(ends)}` : ''}. Alerts keep coming until then.\n\nWhat was the main reason? One click is enough:\n${Object.entries(WHY).map(([k, v]) => `  ${v}: ${base}${k}`).join('\n')}\n\nYou can change your mind any time before then at ${env.SITE_URL}account/.${FOOTER}`,
  };
}

/** Sent once per subscription when a member cancels (now or at period end). */
export async function maybeCancelMail(env: Env, prev: Member | null, m: Member): Promise<void> {
  if (!billable(m) || !m.email || m.why_sent === m.subscription) return;
  const cancelling = (m.cancel_at_period_end && !prev?.cancel_at_period_end) || (m.status === 'canceled' && !!prev && isActive(prev) && !prev.cancel_at_period_end);
  if (!cancelling) return;
  if ((await sendMail(env, [await cancelMail(env, m)])) === '200') m.why_sent = m.subscription;
}

/** GET /why?t=&r= records the reason (once; a later click replaces it) and thanks them. POST adds a note. */
export async function handleWhy(env: Env, req: Request, url: URL): Promise<Response> {
  const page = (msg: string, form = '') =>
    new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Copybook</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#111"><p>${msg}</p>${form}<p style="color:#6b7280;font-size:14px"><a href="${env.SITE_URL}" style="color:#1d4ed8">Copybook</a></p></body>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  const form = req.method === 'POST' ? await req.formData().catch(() => new FormData()) : null;
  const t = form ? String(form.get('t') ?? '') : (url.searchParams.get('t') ?? '');
  const p = await verifyToken(env.SESSION_SECRET, t, 'why');
  if (!p) return page('This link has expired. Thanks anyway.');
  const k = `why:${p.c}`;
  const cur = JSON.parse((await env.DB.get(k)) ?? 'null') as { reason: string; note?: string; at: string } | null;
  if (req.method === 'POST') {
    const note = String(form?.get('note') ?? '').trim().slice(0, 2000);
    if (cur && note) await env.DB.put(k, JSON.stringify({ ...cur, note }));
    return page('Thank you. We read every one.');
  }
  const r = url.searchParams.get('r') ?? '';
  if (!WHY[r]) return page('Unknown reason.');
  await env.DB.put(k, JSON.stringify({ reason: r, at: new Date().toISOString(), ...(cur?.note ? { note: cur.note } : {}) }));
  const more = `<form method="post" action="why"><input type="hidden" name="t" value="${t.replace(/"/g, '&quot;')}"><p><label>Anything else we should know? (optional)<br><textarea name="note" rows="4" style="width:100%;font:inherit"></textarea></label></p><button style="font:inherit;padding:6px 14px">Send</button></form>`;
  return page(`Thanks: “${WHY[r]}” is noted.`, more);
}

/** Daily: trial reminders 3 days out, and once per season the recap for monthly members. */
export async function runRevenue(env: Env, now: number): Promise<Record<string, unknown>> {
  const members = (await listMembers(env)).filter((m) => billable(m) && isActive(m) && m.email && !m.marketing_off);
  const mails: Mail[] = [];
  const marks: Member[] = [];
  // The season recap goes out after the 13F deadline week (Q3 2026: from Nov 18).
  const recap = now >= Date.UTC(2026, 10, 18) ? 'Q3 2026' : null;
  let median: number | null = null;
  if (recap) {
    const log = JSON.parse((await env.DB.get('alerts:latency')) ?? '[]') as { seconds: number; replay?: boolean; sent?: string }[];
    const s = log.filter((l) => !l.replay && l.sent && Date.parse(l.sent) > now - 45 * 86400_000).map((l) => l.seconds).sort((a, b) => a - b);
    median = s.length ? s[Math.floor((s.length - 1) / 2)] : null;
  }
  for (const m of members) {
    const left = (m.trial_end ?? 0) * 1000 - now;
    if (m.status === 'trialing' && left > 0 && left <= 3 * 86400_000 && m.trial_reminded !== m.trial_end) {
      const f = await getFollows(env, m);
      const keep = `${API(env)}keep?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, 'keep', m.customer, 14 * 86400))}`;
      mails.push(trialEndingMail(env, m, await memberStats(env, m.customer), f.investors.length, f.owned.length, keep, await unsubscribeUrl(env, m.customer), Math.max(1, Math.ceil(left / 86400_000))));
      marks.push({ ...m, trial_reminded: m.trial_end });
    } else if (recap && m.status === 'active' && m.interval === 'monthly' && m.recap_sent !== recap && !m.marketing_off) {
      const f = await getFollows(env, m);
      mails.push({ ...seasonRecapMail(env, m, (await memberStats(env, m.customer)).n, f.investors.length, median, recap), unsubscribe: await unsubscribeUrl(env, m.customer) });
      marks.push({ ...m, recap_sent: recap });
    }
  }
  const status = await sendMail(env, mails);
  if (status.split(',').every((s) => s === '200')) {
    // Re-read so a webhook that landed meanwhile isn't overwritten.
    for (const mk of marks) {
      const cur = await getMember(env, mk.customer);
      if (cur) await putMember(env, { ...cur, trial_reminded: mk.trial_reminded ?? cur.trial_reminded, recap_sent: mk.recap_sent ?? cur.recap_sent });
    }
  }
  return { emails: mails.length, status };
}

/** Counts only: paying members by plan and interval (comped and seats counted apart), trials, scheduled cancellations, cancel reasons, alerts sent. */
export async function businessSummary(env: Env, now: number) {
  const members = await listMembers(env);
  const by: Record<string, number> = {};
  let trials = 0;
  let cancelling = 0;
  let seats = 0;
  let comped = 0;
  for (const m of members) {
    // Synthetic records (the latency probe) have no plan and aren't members.
    if (!isActive(m) || (!PRICES[m.plan] && m.plan !== 'holdterm')) continue;
    if (m.seat_of) {
      seats++;
      continue;
    }
    if (m.comped) {
      comped++;
      continue;
    }
    by[`${m.plan}_${m.interval}`] = (by[`${m.plan}_${m.interval}`] ?? 0) + 1;
    if (m.status === 'trialing') trials++;
    if (m.cancel_at_period_end) cancelling++;
  }
  const reasons: Record<string, number> = {};
  let cursor: string | undefined;
  do {
    const page = await env.DB.list({ prefix: 'why:', cursor });
    for (const k of page.keys) {
      const r = (JSON.parse((await env.DB.get(k.name)) ?? 'null') as { reason?: string } | null)?.reason;
      if (r) reasons[r] = (reasons[r] ?? 0) + 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const hour = Math.floor(now / 3600_000);
  const sent = (JSON.parse((await env.DB.get('stats:sent')) ?? '[]') as [number, number][]).filter(([h]) => h > hour - 24).reduce((a, [, n]) => a + n, 0);
  return {
    active: Object.values(by).reduce((a, n) => a + n, 0),
    by_plan: by,
    trials,
    cancellations_scheduled: cancelling,
    fund_seats: seats,
    comped,
    cancel_reasons: reasons,
    alert_emails_24h: sent,
    funnel_7d: await funnel(env, now, 7).then(({ by_day: _, ...f }) => f),
    funnel_30d: await funnel(env, now, 30),
  };
}
