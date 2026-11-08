import type { Alert13F, AlertEvent } from './alerts';
import { chatText, feedItems, type FeedItem } from './email';
import { isPro, type Env, type Member } from './env';
import type { Follows } from './members';
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
export function channelsView(m: Member, c: Channels, apiBase: string) {
  return {
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
export async function updateChannels(env: Env, m: Member, b: Record<string, unknown>): Promise<{ ok: true; channels: Channels } | { ok: false; error: string; code: string }> {
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
  await putChannels(env, m.customer, c);
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

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<string> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Copybook-Alerts/1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return String(res.status);
  } catch (err) {
    return `error ${err}`;
  }
}

/** Sends one member's alerts to their chat destinations; returns a status per destination. */
export async function sendChats(env: Env, c: Channels, filings: Alert13F[], events: AlertEvent[], f: Follows): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!c.discord && !c.slack && !c.telegram) return out;
  const text = chatText(env, filings, events, f);
  if (c.discord) out.discord = await post(c.discord, { content: text.slice(0, 1990), allowed_mentions: { parse: [] } });
  if (c.slack) out.slack = await post(c.slack, { text });
  if (c.telegram) out.telegram = await post(`https://api.telegram.org/bot${c.telegram.bot_token}/sendMessage`, { chat_id: c.telegram.chat_id, text: text.slice(0, 4000), disable_web_page_preview: true });
  return out;
}

/** Signs a webhook body: Copybook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export async function signature(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

/** The signed JSON body for one alert. */
export function webhookPayloads(env: Env, filings: Alert13F[], events: AlertEvent[], detectedAt: number): { id: string; body: string }[] {
  const detected_at = new Date(detectedAt).toISOString();
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
      item4: e.item4 ?? null,
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
  body: string;
  attempt: number;
  next_at: number;
}

/** Minutes to wait before attempt 2, 3, …; after the last, the delivery is dropped. */
const BACKOFF_MIN = [1, 5, 30, 120, 720];

async function sendWebhook(c: Channels, id: string, body: string): Promise<boolean> {
  if (!c.webhook) return true; // removed meanwhile: nothing to do
  const status = await post(c.webhook.url, body, { 'copybook-signature': await signature(c.webhook.secret, body), 'copybook-delivery': id });
  return /^2\d\d$/.test(status);
}

async function queueRetries(env: Env, items: Retry[]): Promise<void> {
  if (!items.length) return;
  const q = JSON.parse((await env.DB.get('webhooks:retry')) ?? '[]') as Retry[];
  await env.DB.put('webhooks:retry', JSON.stringify([...q, ...items].slice(-500)));
}

/** Sends each alert to a Pro member's webhook; failures are queued for retry. */
export async function sendWebhooks(env: Env, m: Member, c: Channels, filings: Alert13F[], events: AlertEvent[], now: number): Promise<string | null> {
  if (!c.webhook || !isPro(m)) return null;
  const failed: Retry[] = [];
  for (const p of webhookPayloads(env, filings, events, now)) {
    if (!(await sendWebhook(c, p.id, p.body))) failed.push({ customer: m.customer, id: p.id, body: p.body, attempt: 1, next_at: now + BACKOFF_MIN[0] * 60_000 });
  }
  await queueRetries(env, failed);
  return failed.length ? `${failed.length} queued for retry` : 'ok';
}

/** Every minute: retries due webhook deliveries (at most 5 a run), with backoff. */
export async function runWebhookRetries(env: Env, now: number): Promise<Record<string, unknown>> {
  const raw = await env.DB.get('webhooks:retry');
  if (!raw) return { status: 'none' };
  const q = JSON.parse(raw) as Retry[];
  const due = q.filter((r) => r.next_at <= now).slice(0, 5);
  if (!due.length) return { status: 'waiting', queued: q.length };
  const keep = q.filter((r) => !due.includes(r));
  let sent = 0;
  let dropped = 0;
  for (const r of due) {
    if (await sendWebhook(await getChannels(env, r.customer), r.id, r.body)) sent++;
    else if (r.attempt < BACKOFF_MIN.length) keep.push({ ...r, attempt: r.attempt + 1, next_at: now + BACKOFF_MIN[r.attempt] * 60_000 });
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
}

const xml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

/** GET /feed/{token}.json (JSON Feed 1.1) or .rss (RSS 2.0). The token is the only credential. */
export async function serveFeed(env: Env, token: string, format: 'json' | 'rss', selfUrl: string): Promise<Response> {
  const customer = /^[\w-]{20,64}$/.test(token) ? await env.DB.get(`feedtok:${token}`) : null;
  if (!customer) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  const items = JSON.parse((await env.DB.get(`feed:${customer}`)) ?? '[]') as FeedItem[];
  const headers = { 'cache-control': 'private, max-age=60', 'access-control-allow-origin': '*', 'referrer-policy': 'no-referrer' };
  if (format === 'json') {
    return new Response(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Copybook alerts',
        home_page_url: env.SITE_URL,
        feed_url: selfUrl,
        description: 'Your Copybook alerts: 13F, Form 4 and Schedule 13D/G filings from SEC EDGAR. Not investment advice.',
        items: items.map((i) => ({ id: i.id, url: i.url, title: i.title, content_text: i.text, date_published: i.published })),
      }),
      { headers: { ...headers, 'content-type': 'application/feed+json; charset=utf-8' } },
    );
  }
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Copybook alerts</title><link>${xml(env.SITE_URL)}</link><description>Your Copybook alerts: 13F, Form 4 and Schedule 13D/G filings from SEC EDGAR. Not investment advice.</description>
${items.map((i) => `<item><title>${xml(i.title)}</title><link>${xml(i.url)}</link><guid isPermaLink="false">${xml(i.id)}</guid><pubDate>${new Date(i.published).toUTCString()}</pubDate><description>${xml(i.text)}</description></item>`).join('\n')}
</channel></rss>`;
  return new Response(rss, { headers: { ...headers, 'content-type': 'application/rss+xml; charset=utf-8' } });
}

/** POST /channels/test: a short message to every configured destination, so a member can check setup. */
export async function testChannels(m: Member, c: Channels): Promise<Record<string, string>> {
  const text = 'Copybook test: your alerts will arrive here. SEC EDGAR filings, as filed. Not investment advice.';
  const out: Record<string, string> = {};
  if (c.discord) out.discord = await post(c.discord, { content: text });
  if (c.slack) out.slack = await post(c.slack, { text });
  if (c.telegram) out.telegram = await post(`https://api.telegram.org/bot${c.telegram.bot_token}/sendMessage`, { chat_id: c.telegram.chat_id, text });
  if (c.webhook && isPro(m)) {
    const body = JSON.stringify({ schema_version: '2026-11-08', type: 'test', id: `test:${Date.now()}`, detected_at: new Date().toISOString() });
    out.webhook = await post(c.webhook.url, body, { 'copybook-signature': await signature(c.webhook.secret, body), 'copybook-delivery': 'test' });
  }
  return out;
}
