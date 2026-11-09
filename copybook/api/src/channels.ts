import type { Alert13F, AlertEvent } from './alerts';
import { channelFailMail, chatText, feedItems, sendMail, teamDuplicateMail, type FeedItem } from './email';
import { isPro, type Env, type Member } from './env';
import { getMember, type Follows } from './members';
import { listSeats } from './seats';
import { cleanItem4 } from './edgar';
import { hmacHex } from './tokens';

/**
 * Alert delivery besides email. Copy and above: a personal Discord, Slack or Telegram destination
 * and a private feed (JSON Feed and RSS) behind a revocable token. Copy Pro and Fund: a signed
 * generic webhook, retried with backoff.
 */
export interface Channels {
  discord?: string;
  slack?: string;
  telegram?: { bot_token: string; chat_id: string };
  webhook?: { url: string; secret: string; created: string };
  feed_token?: string;
}

export type Dest = 'discord' | 'slack' | 'telegram' | 'webhook';
/** A destination that stopped working: KV chfail:{customer}, apart from the member's settings so the cron never overwrites an edit. */
export type ChannelFailures = Partial<Record<Dest, { reason: string; since: string; notified?: boolean }>>;
const failKey = (customer: string) => `chfail:${customer}`;

export async function getFailures(env: Env, customer: string): Promise<ChannelFailures> {
  return JSON.parse((await env.DB.get(failKey(customer))) ?? '{}') as ChannelFailures;
}

const LABEL: Record<Dest, string> = { discord: 'Discord', slack: 'Slack', telegram: 'Telegram', webhook: 'webhook' };

/**
 * Flags a destination as failing and, for a real alert, emails the member once (until it works
 * again). A failed test only flags it: the member is looking at the result. Email alerts carry on.
 */
async function markFailing(env: Env, customer: string, dest: Dest, reason: string, notify = true): Promise<void> {
  const f = await getFailures(env, customer);
  if (f[dest] && (f[dest]!.notified || !notify)) return;
  f[dest] = { reason, since: f[dest]?.since ?? new Date().toISOString(), notified: notify };
  await env.DB.put(failKey(customer), JSON.stringify(f));
  if (!notify) return;
  const m = await getMember(env, customer);
  if (m?.email) await sendMail(env, [channelFailMail(env, m.email, LABEL[dest], reason)]);
}

/** What a test result means, in words for the account page. */
function testMessage(dest: Dest, status: string): string {
  const label = dest === 'webhook' ? 'Your endpoint' : LABEL[dest];
  if (/^2\d\d$/.test(status)) return 'Delivered';
  if (status === '404' || status === '410') return dest === 'telegram' ? 'Telegram rejected this chat (wrong chat id, or the bot was removed)' : `${label} rejected this ${dest === 'webhook' ? 'URL' : 'webhook'} (deleted or wrong URL)`;
  if (status === '401' || status === '403') return dest === 'telegram' ? 'Telegram rejected this bot (token revoked, or the bot was blocked or removed from the chat)' : `${label} refused it (access revoked)`;
  if (status === '429') return `${label} is rate limiting; try again in a minute`;
  return /^\d+$/.test(status) ? `${label} answered HTTP ${status}` : `No answer from ${label}`;
}

/** The next delivery that goes through clears the flag. */
async function recovered(env: Env, customer: string, dest: Dest): Promise<void> {
  const f = await getFailures(env, customer);
  if (!f[dest]) return;
  delete f[dest];
  if (Object.keys(f).length) await env.DB.put(failKey(customer), JSON.stringify(f));
  else await env.DB.delete(failKey(customer));
}

/** Answers that mean the destination is gone (webhook deleted, token revoked, bot removed): no retry. */
const REVOKED = /^(401|403|404|410)$/;
const why = (status: string, tries: number) =>
  REVOKED.test(status) ? `${status === '404' || status === '410' ? 'the webhook or chat no longer exists' : 'access was revoked'} (HTTP ${status})` : `${/^\d+$/.test(status) ? `HTTP ${status}` : 'no answer'} after ${tries} tries`;

const DISCORD = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,100}$/;
const SLACK = /^https:\/\/hooks\.slack\.com\/(?:services|triggers)\/[\w/-]{10,200}$/;
const TG_TOKEN = /^\d{5,12}:[\w-]{30,60}$/;
const TG_CHAT = /^(?:-?\d{1,20}|@[A-Za-z]\w{4,31})$/;

export async function getChannels(env: Env, customer: string): Promise<Channels> {
  return JSON.parse((await env.DB.get(`channels:${customer}`)) ?? '{}') as Channels;
}

async function putChannels(env: Env, customer: string, c: Channels): Promise<void> {
  await env.DB.put(`channels:${customer}`, JSON.stringify(c));
}

const mask = (u: string) => `${u.slice(0, u.indexOf('/', 8) + 1)}…${u.slice(-4)}`;
const randomToken = (bytes: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function feedUrls(token: string, apiBase: string) {
  return { json_url: `${apiBase}/feed/${token}.json`, rss_url: `${apiBase}/feed/${token}.rss` };
}

/** What the account page shows: destinations masked, the webhook secret (the member's own) in full. */
/**
 * A Copy Fund owner's channels are the team's: they post the team's shared alerts once. A seat's own
 * channels are personal; it sees the team's read-only (`team`), and edits only its own.
 */
export const channelScope = (m: Member): 'team' | 'personal' => (!m.seat_of && m.plan === 'fund' ? 'team' : 'personal');

export const failView = (f: ChannelFailures) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { reason: v.reason, since: v.since }]));

export function channelsView(m: Member, c: Channels, apiBase: string, failing: ChannelFailures = {}, team?: { owner: Member; c: Channels; failing: ChannelFailures }) {
  return {
    scope: channelScope(m),
    editable: true,
    /** Destinations that stopped working, with why and since when; cleared by the next delivery that works. */
    failing: failView(failing),
    // The team's webhook signs every team alert with one secret, which seats can read to verify them.
    ...(team ? { team: { scope: 'team' as const, editable: false, discord: team.c.discord ? mask(team.c.discord) : null, slack: team.c.slack ? mask(team.c.slack) : null, telegram: team.c.telegram ? { chat_id: team.c.telegram.chat_id } : null, webhook: team.c.webhook ? { url: team.c.webhook.url, secret: team.c.webhook.secret } : null, failing: failView(team.failing) } } : {}),
    discord: c.discord ? mask(c.discord) : null,
    slack: c.slack ? mask(c.slack) : null,
    telegram: c.telegram ? { chat_id: c.telegram.chat_id } : null,
    webhook: c.webhook ? { url: c.webhook.url, secret: c.webhook.secret, created: c.webhook.created } : null,
    webhook_available: isPro(m),
    feed: c.feed_token ? feedUrls(c.feed_token, apiBase) : null,
  };
}

function httpsPublic(u: string): boolean {
  try {
    const url = new URL(u);
    const host = url.hostname;
    return url.protocol === 'https:' && u.length <= 500 && !/^(localhost|.*\.local|.*\.internal)$/i.test(host) && !/^[\d.]+$/.test(host) && !host.includes(':');
  } catch {
    return false;
  }
}

/** PUT /channels: each field set (string or object), cleared (null) or left alone (absent). */
/** Which of `c`'s destinations are also the team's (`team`): the same URL, or the same Telegram chat. */
function sameAs(c: Channels, team: Channels): Exclude<Dest, never>[] {
  const out: Dest[] = [];
  if (c.discord && c.discord === team.discord) out.push('discord');
  if (c.slack && c.slack === team.slack) out.push('slack');
  if (c.telegram && team.telegram && c.telegram.chat_id === team.telegram.chat_id) out.push('telegram');
  if (c.webhook && team.webhook && c.webhook.url === team.webhook.url) out.push('webhook');
  return out;
}

/**
 * A Fund team's destinations are the owner's: one post per alert, signed with one team secret. Any
 * seat that also saved one of them (before seats were stopped from doing so, or before the owner
 * connected it) loses its copy, and is told once by email.
 */
export async function clearSeatDuplicates(env: Env, owner: Member): Promise<string[]> {
  const team = await getChannels(env, owner.customer);
  const cleared: string[] = [];
  for (const seat of await listSeats(env, owner.customer)) {
    const c = await getChannels(env, seat.id);
    const dup = sameAs(c, team);
    if (!dup.length) continue;
    for (const d of dup) delete c[d];
    await putChannels(env, seat.id, c);
    const fail = await getFailures(env, seat.id);
    if (dup.some((d) => fail[d])) {
      for (const d of dup) delete fail[d];
      await env.DB.put(failKey(seat.id), JSON.stringify(fail));
    }
    await sendMail(env, [teamDuplicateMail(env, seat.email, dup.map((d) => LABEL[d]))]);
    cleared.push(`${seat.id}: ${dup.join(', ')}`);
  }
  return cleared;
}

export async function updateChannels(env: Env, m: Member, b: Record<string, unknown>, team?: Channels): Promise<{ ok: true; channels: Channels } | { ok: false; error: string; code: string }> {
  const c = await getChannels(env, m.customer);
  const bad = (error: string) => ({ ok: false as const, error, code: 'bad_request' });
  if (b.discord !== undefined) {
    if (b.discord === null || b.discord === '') delete c.discord;
    else if (typeof b.discord === 'string' && DISCORD.test(b.discord.trim())) c.discord = b.discord.trim();
    else return bad('discord: a Discord webhook URL, https://discord.com/api/webhooks/…');
  }
  if (b.slack !== undefined) {
    if (b.slack === null || b.slack === '') delete c.slack;
    else if (typeof b.slack === 'string' && SLACK.test(b.slack.trim())) c.slack = b.slack.trim();
    else return bad('slack: a Slack incoming-webhook URL, https://hooks.slack.com/services/…');
  }
  if (b.telegram !== undefined) {
    const t = b.telegram as { bot_token?: unknown; chat_id?: unknown } | null;
    if (t === null) delete c.telegram;
    else if (t && typeof t.bot_token === 'string' && TG_TOKEN.test(t.bot_token.trim()) && (typeof t.chat_id === 'string' || typeof t.chat_id === 'number') && TG_CHAT.test(String(t.chat_id).trim())) {
      c.telegram = { bot_token: t.bot_token.trim(), chat_id: String(t.chat_id).trim() };
    } else return bad('telegram: {bot_token from @BotFather, chat_id (a number, or @channelname)}');
  }
  if (b.webhook !== undefined) {
    if (b.webhook === null || b.webhook === '') delete c.webhook;
    else if (!isPro(m)) return { ok: false, error: 'Signed webhooks are part of Copy Pro', code: 'pro_required' };
    else if (typeof b.webhook === 'string' && httpsPublic(b.webhook.trim())) {
      const url = b.webhook.trim();
      // A new URL keeps the secret; ask for a new one with rotate_secret.
      c.webhook = { url, secret: c.webhook?.secret && !b.rotate_secret ? c.webhook.secret : `whsec_${randomToken(24)}`, created: c.webhook?.created ?? new Date().toISOString() };
    } else return bad('webhook: a public https URL');
  }
  // A seat can't save its team's destination as its own: nothing is stored.
  if (team) {
    const dup = sameAs(c, team).filter((d) => b[d] !== undefined);
    if (dup.length) return { ok: false, error: "Already your team's channel", code: 'already_team_channel' };
  }
  await putChannels(env, m.customer, c);
  const fail = await getFailures(env, m.customer);
  const changed = (['discord', 'slack', 'telegram', 'webhook'] as const).filter((k) => b[k] !== undefined && fail[k]);
  if (changed.length) {
    for (const k of changed) delete fail[k];
    if (Object.keys(fail).length) await env.DB.put(failKey(m.customer), JSON.stringify(fail));
    else await env.DB.delete(failKey(m.customer));
  }
  return { ok: true, channels: c };
}

/** A new private feed token (the old one stops working), or none. */
export async function rotateFeed(env: Env, m: Member, revoke = false): Promise<Channels> {
  const c = await getChannels(env, m.customer);
  if (c.feed_token) await env.DB.delete(`feedtok:${c.feed_token}`);
  if (revoke) delete c.feed_token;
  else {
    c.feed_token = randomToken(24);
    await env.DB.put(`feedtok:${c.feed_token}`, m.customer);
  }
  await putChannels(env, m.customer, c);
  return c;
}

// ---------------------------------------------------------------------------------------------
// Sending

/** POSTs JSON; on 429, also the wait the receiver asked for (Discord and Telegram put it in the body, Slack in Retry-After), in seconds. */
async function postFull(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: string; retryAfter: number | null }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Copybook-Alerts/1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    let retryAfter: number | null = null;
    if (res.status === 429) {
      const b = (await res.json().catch(() => null)) as { retry_after?: number; parameters?: { retry_after?: number } } | null;
      const v = b?.retry_after ?? b?.parameters?.retry_after ?? Number(res.headers.get('retry-after') ?? NaN);
      retryAfter = Number.isFinite(v) && v >= 0 ? v : null;
    }
    return { status: String(res.status), retryAfter };
  } catch (err) {
    return { status: `error ${err}`, retryAfter: null };
  }
}

const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => (await postFull(url, body, headers)).status;

/** Discord unfurls every link; the SEC's in <…> so only the Copybook link (card or investor page) previews. */
const discordText = (text: string) => text.replace(/(?<!<)(https:\/\/www\.sec\.gov\/[^\s>]+)/g, '<$1>');

/** One chat message to one destination, built from the member's current settings (a retry follows a fixed URL). */
async function sendChat(c: Channels, dest: Exclude<Dest, 'webhook'>, text: string) {
  if (dest === 'discord' && c.discord) return postFull(c.discord, { content: discordText(text).slice(0, 1990), allowed_mentions: { parse: [] } });
  if (dest === 'slack' && c.slack) return postFull(c.slack, { text });
  if (dest === 'telegram' && c.telegram) return postFull(`https://api.telegram.org/bot${c.telegram.bot_token}/sendMessage`, { chat_id: c.telegram.chat_id, text: text.slice(0, 4000), disable_web_page_preview: true });
  return null; // removed meanwhile
}

/** A destination's identity for de-duplication: the webhook URL, or the Telegram chat. */
function chatTarget(c: Channels, dest: Exclude<Dest, 'webhook'>): string | null {
  if (dest === 'telegram') return c.telegram ? `telegram:${c.telegram.chat_id}` : null;
  return c[dest] ?? null;
}

/** Minutes before chat retries 1, 2 and 3 (or longer when the receiver asks); after the third, the channel is flagged. */
const CHAT_BACKOFF_MIN = [1, 5, 15];

/**
 * Sends one member's alerts to their chat destinations; returns a status per destination. A 429 or
 * 5xx (or no answer) is retried with backoff; a revoked or deleted destination flags it at once.
 */
/**
 * Acceptance-to-delivery per channel for the public /latency page: the first successful post of each
 * alert to each channel in this fan-out (first attempts; a delivery that needed a retry isn't timed).
 * Collected in memory and written once per fan-out by flushChannelLatency.
 */
export interface ChannelDelivery {
  channel: 'slack' | 'discord' | 'telegram' | 'webhook' | 'feed';
  accession: string;
  form: string;
  manager: string | null;
  accepted: string;
  delivered: string;
  seconds: number;
}
const timed: ChannelDelivery[] = [];

function noteDelivered(channel: ChannelDelivery['channel'], filings: Alert13F[], events: AlertEvent[]): void {
  const at = Date.now();
  const rows = [
    ...filings.filter((a) => !a.followup).map((a) => ({ accession: a.accession, form: a.reveal ? '13F-HR/A' : '13F-HR', manager: a.manager, accepted: a.accepted })),
    ...events.filter((e) => !e.followup && !e.late).map((e) => ({ accession: e.id, form: e.form, manager: e.manager, accepted: e.accepted ?? e.accepted_at })),
  ];
  for (const r of rows) {
    if (!r.accepted || timed.some((t) => t.channel === channel && t.accession === r.accession)) continue;
    timed.push({ channel, accession: r.accession, form: r.form, manager: r.manager || null, accepted: r.accepted, delivered: new Date(at).toISOString(), seconds: Math.round((at - Date.parse(r.accepted)) / 1000) });
  }
}

/** Saves this fan-out's channel timings (KV alerts:latency:ch, newest first). A replay's are dropped. */
export async function flushChannelLatency(env: Env, save: boolean): Promise<void> {
  const add = timed.splice(0).filter((t) => t.seconds >= 0);
  if (!save || !add.length) return;
  const log = JSON.parse((await env.DB.get('alerts:latency:ch')) ?? '[]') as ChannelDelivery[];
  await env.DB.put('alerts:latency:ch', JSON.stringify([...add, ...log].slice(0, 3000)));
}

export async function sendChats(env: Env, customer: string, c: Channels, filings: Alert13F[], events: AlertEvent[], f: Follows, now: number, posted = new Set<string>()): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!c.discord && !c.slack && !c.telegram) return out;
  const retries: Retry[] = [];
  for (const dest of ['discord', 'slack', 'telegram'] as const) {
    const where = chatTarget(c, dest);
    if (!where) continue;
    // One post per alert per destination, across members: a Fund team's channel connected by the
    // owner and by seats gets each alert once.
    const fl = filings.filter((a) => !posted.has(`${where}|${a.accession}${a.followup ? ':moves' : ''}`));
    const ev = events.filter((e) => !posted.has(`${where}|${e.id}${e.followup ? ':details' : ''}`));
    if (!fl.length && !ev.length) {
      out[dest] = 'already posted';
      continue;
    }
    for (const a of fl) posted.add(`${where}|${a.accession}${a.followup ? ':moves' : ''}`);
    for (const e of ev) posted.add(`${where}|${e.id}${e.followup ? ':details' : ''}`);
    const text = chatText(env, fl, ev, f);
    const id = [...fl.map((a) => a.accession), ...ev.map((e) => e.id)].join(',').slice(0, 200);
    const r = await sendChat(c, dest, text);
    if (!r) continue;
    out[dest] = r.status;
    if (/^2\d\d$/.test(r.status)) noteDelivered(dest, fl, ev);
    const next = await settle(env, { customer, id, dest, body: text, attempt: 1, next_at: 0 }, r, now, CHAT_BACKOFF_MIN);
    if (next) retries.push(next);
  }
  await queueRetries(env, retries);
  return out;
}

/** After one delivery attempt: clears the flag on success, flags a revoked destination, or returns the retry to queue (null: done). */
async function settle(env: Env, item: Retry, r: { status: string; retryAfter: number | null }, now: number, backoff: number[]): Promise<Retry | null> {
  const dest = item.dest ?? 'webhook';
  if (/^2\d\d$/.test(r.status)) {
    await recovered(env, item.customer, dest);
    return null;
  }
  if (REVOKED.test(r.status)) {
    await markFailing(env, item.customer, dest, why(r.status, item.attempt));
    return null;
  }
  // Other 4xx (a message the receiver won't take) don't get better with retries.
  if (/^4\d\d$/.test(r.status) && r.status !== '408' && r.status !== '429') return null;
  if (item.attempt > backoff.length) {
    await markFailing(env, item.customer, dest, r.status === '429' ? `rate limited (HTTP 429) after ${item.attempt} tries` : why(r.status, item.attempt));
    return null;
  }
  const wait = Math.max(backoff[item.attempt - 1] * 60_000, (r.retryAfter ?? 0) * 1000);
  return { ...item, attempt: item.attempt + 1, next_at: now + wait };
}

/** Signs a webhook body: Copybook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export async function signature(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

/** The signed JSON body for one alert. */
export function webhookPayloads(env: Env, filings: Alert13F[], events: AlertEvent[], detectedAt: number): { id: string; body: string }[] {
  const detected_at = new Date(detectedAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const page = (slug: string) => (slug ? `${env.SITE_URL}investors/${slug}` : null);
  return [
    ...filings.map((a) => ({
      type: '13f',
      id: `${a.accession}${a.followup ? ':moves' : ''}`,
      accession: a.accession,
      form: '13F-HR',
      accepted_at: a.accepted ?? null,
      detected_at,
      filer: { slug: a.slug, manager: a.manager, name: a.name },
      quarter: a.quarter,
      report_date: a.report_date,
      followup: !!a.followup,
      moves: a.moves,
      top_holdings: a.top ?? null,
      sec_url: a.sec_url,
      copybook_url: page(a.slug),
    })),
    ...events.map((e) => ({
      type: e.cluster ? 'insider_cluster' : e.insider ? 'insider_buy' : e.kind,
      id: `${e.id}${e.followup ? ':details' : ''}`,
      accession: e.cluster ? null : e.id,
      form: e.form,
      accepted_at: e.accepted ?? e.accepted_at ?? null,
      detected_at,
      filer: { slug: e.slug || null, name: e.manager },
      issuer: e.issuer,
      ticker: e.ticker,
      action: e.action,
      details_pending: !!e.details_pending,
      followup: !!e.followup,
      shares: e.shares,
      value_usd: e.value_usd,
      avg_price: e.avg_price,
      classes: e.classes ?? null,
      percent_of_class: e.percent_of_class,
      shares_after: e.shares_after,
      prev_percent_of_class: e.prev_percent_of_class ?? null,
      prev_shares_after: e.prev_shares_after ?? null,
      amendment_no: e.amendment_no ?? null,
      item4: cleanItem4(e.item4),
      insider: e.insider ?? null,
      insiders: e.cluster ?? null,
      sec_url: e.url,
      copybook_url: page(e.slug),
    })),
  ].map((p) => ({ id: p.id, body: JSON.stringify({ schema_version: '2026-11-08', ...p }) }));
}

interface Retry {
  customer: string;
  id: string;
  /** A chat destination; absent for the Pro webhook. */
  dest?: Exclude<Dest, 'webhook'>;
  /** The webhook's signed JSON, or the chat message text. */
  body: string;
  attempt: number;
  next_at: number;
}

/** Minutes to wait before attempt 2, 3, …; after the last, the delivery is dropped. */
const BACKOFF_MIN = [1, 5, 30, 120, 720];

async function sendWebhook(c: Channels, id: string, body: string) {
  if (!c.webhook) return null; // removed meanwhile: nothing to do
  return postFull(c.webhook.url, body, { 'copybook-signature': await signature(c.webhook.secret, body), 'copybook-delivery': id });
}

async function queueRetries(env: Env, items: Retry[]): Promise<void> {
  if (!items.length) return;
  const q = JSON.parse((await env.DB.get('webhooks:retry')) ?? '[]') as Retry[];
  await env.DB.put('webhooks:retry', JSON.stringify([...q, ...items].slice(-500)));
}

/** Sends each alert to a Pro member's webhook; failures are queued for retry. */
export async function sendWebhooks(env: Env, m: Member, c: Channels, filings: Alert13F[], events: AlertEvent[], now: number, posted = new Set<string>()): Promise<string | null> {
  if (!c.webhook || !isPro(m)) return null;
  const failed: Retry[] = [];
  for (const p of webhookPayloads(env, filings, events, now)) {
    // The same endpoint gets each alert once, however many members (a Fund team) connected it.
    if (posted.has(`${c.webhook.url}|${p.id}`)) continue;
    posted.add(`${c.webhook.url}|${p.id}`);
    const r = await sendWebhook(c, p.id, p.body);
    if (!r) continue;
    if (/^2\d\d$/.test(r.status)) noteDelivered('webhook', filings.filter((a) => p.id.startsWith(a.accession)), events.filter((e) => p.id.startsWith(e.id)));
    const next = await settle(env, { customer: m.customer, id: p.id, body: p.body, attempt: 1, next_at: 0 }, r, now, BACKOFF_MIN);
    if (next) failed.push(next);
  }
  await queueRetries(env, failed);
  return failed.length ? `${failed.length} queued for retry` : 'ok';
}

/** Every quiet minute: retries due webhook and chat deliveries (at most 5 a run), with backoff. */
export async function runWebhookRetries(env: Env, now: number, max = 5): Promise<Record<string, unknown>> {
  const raw = await env.DB.get('webhooks:retry');
  if (!raw) return { status: 'none' };
  const q = JSON.parse(raw) as Retry[];
  // Oldest due first, so a busy afternoon can't push any one retry back indefinitely.
  const due = q.filter((r) => r.next_at <= now).sort((a, b) => a.next_at - b.next_at).slice(0, max);
  if (!due.length) return { status: 'waiting', queued: q.length };
  const keep = q.filter((r) => !due.includes(r));
  let sent = 0;
  let dropped = 0;
  for (const r of due) {
    const c = await getChannels(env, r.customer);
    const res = r.dest ? await sendChat(c, r.dest, r.body) : await sendWebhook(c, r.id, r.body);
    if (!res) continue;
    const next = await settle(env, r, res, now, r.dest ? CHAT_BACKOFF_MIN : BACKOFF_MIN);
    if (next) keep.push(next);
    else if (/^2\d\d$/.test(res.status)) sent++;
    else dropped++;
  }
  if (keep.length) await env.DB.put('webhooks:retry', JSON.stringify(keep));
  else await env.DB.delete('webhooks:retry');
  return { status: 'retried', sent, dropped, queued: keep.length };
}

// ---------------------------------------------------------------------------------------------
// The private feed

/** Adds this delivery's alerts to the member's feed (newest first, 50 kept), when they have one. */
export async function addToFeed(env: Env, m: Member, c: Channels, filings: Alert13F[], events: AlertEvent[], now: number): Promise<void> {
  if (!c.feed_token) return;
  const key = `feed:${m.customer}`;
  const items = JSON.parse((await env.DB.get(key)) ?? '[]') as FeedItem[];
  const add = feedItems(env, filings, events, now).filter((i) => !items.some((x) => x.id === i.id));
  if (add.length) await env.DB.put(key, JSON.stringify([...add, ...items].slice(0, 50)));
  noteDelivered('feed', filings, events);
}

const xml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

/** GET /feed/{token}.json (JSON Feed 1.1) or .rss (RSS 2.0). The token is the only credential. */
export async function serveFeed(env: Env, token: string, format: 'json' | 'rss', selfUrl: string): Promise<Response> {
  const customer = /^[\w-]{20,64}$/.test(token) ? await env.DB.get(`feedtok:${token}`) : null;
  if (!customer) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  const items = JSON.parse((await env.DB.get(`feed:${customer}`)) ?? '[]') as FeedItem[];
  // Never cached: a revoked token must stop working for both formats at once.
  const headers = { 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'referrer-policy': 'no-referrer' };
  if (format === 'json') {
    return new Response(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Copybook alerts',
        home_page_url: env.SITE_URL,
        feed_url: selfUrl,
        description: 'Your Copybook alerts: 13F, Form 4 and Schedule 13D/G filings from SEC EDGAR. Not investment advice.',
        // date_published is EDGAR's acceptance; sent_at is when Copybook sent the alert.
        // A "Send a test" item is tagged test, so readers (and the account page) can count alerts only.
        items: items.map((i) => ({ id: i.id, url: i.url, title: i.title, content_text: i.text, date_published: i.published, sent_at: i.sent ?? null, ...(i.test ? { tags: ['test'] } : {}) })),
      }),
      { headers: { ...headers, 'content-type': 'application/feed+json; charset=utf-8' } },
    );
  }
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Copybook alerts</title><link>${xml(env.SITE_URL)}</link><description>Your Copybook alerts: 13F, Form 4 and Schedule 13D/G filings from SEC EDGAR. Not investment advice.</description>
${items.map((i) => `<item><title>${xml(i.title)}</title><link>${xml(i.url)}</link><guid isPermaLink="false">${xml(i.id)}</guid><pubDate>${new Date(i.sent ?? i.published).toUTCString()}</pubDate><description>${xml(i.text)}</description></item>`).join('\n')}
</channel></rss>`;
  return new Response(rss, { headers: { ...headers, 'content-type': 'application/rss+xml; charset=utf-8' } });
}

/** POST /channels/test: a short message to every configured destination (and a test item in the feed), so a member can check setup. */
export async function testChannels(env: Env, m: Member, c: Channels): Promise<{ results: Record<string, string>; messages: Record<string, string> }> {
  const text = 'Copybook test: your alerts will arrive here. SEC EDGAR filings, as filed. Not investment advice.';
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const out: Record<string, string> = {};
  // A test that works clears a flag; one that shows the destination is gone sets it (the email waits for a real alert).
  const after = async (dest: Dest, status: string) => {
    if (/^2\d\d$/.test(status)) await recovered(env, m.customer, dest);
    else if (REVOKED.test(status)) await markFailing(env, m.customer, dest, why(status, 1), false);
  };
  for (const dest of ['discord', 'slack', 'telegram'] as const) {
    const r = await sendChat(c, dest, text);
    if (!r) continue;
    out[dest] = r.status;
    await after(dest, r.status);
  }
  if (c.webhook && isPro(m)) {
    // Shaped like an alert (type test), with its own delivery id so receivers that deduplicate keep every test.
    const id = `test:${crypto.randomUUID()}`;
    const body = JSON.stringify({ schema_version: '2026-11-08', type: 'test', id, accession: null, form: 'TEST', accepted_at: null, detected_at: now, followup: false, filer: { slug: null, name: 'Copybook test' }, sec_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent', copybook_url: env.SITE_URL });
    out.webhook = await post(c.webhook.url, body, { 'copybook-signature': await signature(c.webhook.secret, body), 'copybook-delivery': id });
    await after('webhook', out.webhook);
  }
  if (c.feed_token) {
    const key = `feed:${m.customer}`;
    const items = JSON.parse((await env.DB.get(key)) ?? '[]') as FeedItem[];
    await env.DB.put(key, JSON.stringify([{ id: `test:${now}`, title: 'Copybook test', text, url: env.SITE_URL, published: now, sent: now, test: true }, ...items].slice(0, 50)));
    out.feed = 'ok';
  }
  // Every alert also goes by email (chat, webhook and feed are extras), so the test sends one too.
  if (m.email && m.alerts !== 'off') {
    const st = await sendMail(env, [{ to: m.email, subject: 'Copybook test: your alerts will arrive here', text: `This is a test. When a fund you follow files, or someone trades a stock you own or watch, the alert arrives at this address within minutes.\n\nChange where alerts go: ${env.SITE_URL}account/\n\nSEC EDGAR filings, as filed. Not investment advice.` }]);
    out.email = st;
  }
  const messages = Object.fromEntries(Object.entries(out).map(([d, st]) => [d, d === 'feed' ? 'Test item added to your feed' : d === 'email' ? (st === '200' ? `Test email sent to ${m.email}` : `The test email could not be sent (${st})`) : testMessage(d as Dest, st)]));
  return { results: out, messages };
}

/**
 * A new feed starts with the member's recent alerts instead of empty (the caller reads them from the
 * daily stores). Merged with what an earlier feed kept, so alerts sent while there was no feed show too.
 */
export async function seedFeed(env: Env, customer: string, recent: FeedItem[]): Promise<void> {
  if (!recent.length) return;
  const key = `feed:${customer}`;
  const kept = JSON.parse((await env.DB.get(key)) ?? '[]') as FeedItem[];
  const all = [...kept, ...recent.filter((i) => !kept.some((x) => x.id === i.id))];
  await env.DB.put(key, JSON.stringify(all.sort((a, b) => (b.sent ?? b.published).localeCompare(a.sent ?? a.published)).slice(0, 50)));
}
