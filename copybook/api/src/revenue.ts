import { FOOTER, sendMail, type Mail } from './email';
import { isActive, type Env, type Member } from './env';
import { getFollows, getMember, listMembers, putMember } from './members';
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

const billable = (m: Member) => m.plan !== 'holdterm' && !m.seat_of && !!PRICES[m.plan];
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
const money = (n: number) => `$${n.toLocaleString('en-US')}`;

/** Alerts delivered to one member (email, digest or chat), for the trial and season emails. */
export async function countAlerts(env: Env, customer: string, n: number): Promise<void> {
  if (!n) return;
  const k = `sent:${customer}`;
  await env.DB.put(k, String(Number((await env.DB.get(k)) ?? 0) + n));
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

async function alertsSent(env: Env, customer: string): Promise<number> {
  return Number((await env.DB.get(`sent:${customer}`)) ?? 0);
}

export function trialEndingMail(env: Env, m: Member, sent: number, funds: number, stocks: number): Mail {
  const p = PRICES[m.plan];
  const price = m.interval === 'yearly' ? `${money(p.year)}/year` : `${money(p.month)}/month`;
  const got = [`${sent} alert${sent === 1 ? '' : 's'} sent to you`, `${funds} fund${funds === 1 ? '' : 's'} followed`, stocks && `${stocks} stock${stocks === 1 ? '' : 's'} on your watchlist`].filter(Boolean).join(', ');
  return {
    to: m.email,
    subject: `Your ${p.name} trial ends ${day(m.trial_end!)}`,
    text: `Your ${p.name} trial ends on ${day(m.trial_end!)}. After that your card is charged ${price}${m.interval === 'monthly' ? ` (or ${money(p.year)}/year if you switch to yearly)` : ''}.\n\nDuring your trial so far: ${got}.\n\nNothing to do if you'd like to keep it. To change plan or cancel before you're charged: ${env.SITE_URL}account/ (Manage billing).${FOOTER}`,
  };
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
  const members = (await listMembers(env)).filter((m) => billable(m) && isActive(m) && m.email);
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
      mails.push(trialEndingMail(env, m, await alertsSent(env, m.customer), f.investors.length, f.stocks.length));
      marks.push({ ...m, trial_reminded: m.trial_end });
    } else if (recap && m.status === 'active' && m.interval === 'monthly' && m.recap_sent !== recap) {
      const f = await getFollows(env, m);
      mails.push(seasonRecapMail(env, m, await alertsSent(env, m.customer), f.investors.length, median, recap));
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

/** Counts only: members by plan and interval, trials, scheduled cancellations, cancel reasons, alerts sent. */
export async function businessSummary(env: Env, now: number) {
  const members = await listMembers(env);
  const by: Record<string, number> = {};
  let trials = 0;
  let cancelling = 0;
  let seats = 0;
  for (const m of members) {
    if (!isActive(m)) continue;
    if (m.seat_of) {
      seats++;
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
    cancel_reasons: reasons,
    alert_emails_24h: sent,
  };
}
