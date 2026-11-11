export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface R2Object {
  body: ReadableStream<Uint8Array>;
  size?: number;
  httpMetadata?: { contentType?: string };
  /** When the object was written, and the build that wrote it (ingest's x-copybook-build-id / x-copybook-built-at). */
  uploaded?: Date;
  customMetadata?: Record<string, string>;
  etag?: string;
}

export interface R2 {
  get(key: string): Promise<R2Object | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  list(opts: { prefix: string; cursor?: string; include?: 'customMetadata'[] }): Promise<{ objects: { key: string; size: number; uploaded: Date; etag?: string; customMetadata?: Record<string, string> }[]; truncated?: boolean; cursor?: string }>;
}

export interface Env {
  DB: KV;
  /** Private bucket for paid data: h/{slug}/{quarter}.json|.csv, fb/{quarter}/{cik}.json full books, hl/{issuer}.json (and older s/{issuer}.json) holders, bulk/{quarter}.csv.gz exports. */
  HIST: R2;
  /** GitHub Actions OIDC identity allowed to upload history, e.g. refcell/gust/.github/workflows/copybook-data.yml@refs/heads/main */
  INGEST_WORKFLOW: string;
  /** The site's Pages workflow, allowed to upload the full Flow lists (flow/full.json). */
  PAGES_WORKFLOW?: string;
  /** The API's own precompute workflow, allowed to upload pre/ lookup files. */
  PRECOMPUTE_WORKFLOW?: string;
  /** Site root, e.g. https://refcell.github.io/gust/copybook/ (trailing slash). */
  SITE_URL: string;
  /** Where {slug}-history.json and alerts.json live. */
  DATA_URL: string;
  ALLOWED_ORIGINS?: string;
  EMAIL_FROM: string;
  /** Our inbox (forwards to the owner): reply-to on every email, and where site requests go. */
  CONTACT_EMAIL: string;
  /** This Worker's public base URL (trailing slash), for links in email. */
  API_URL?: string;
  /** Bearer token for /health's private business block (Worker secret). */
  HEALTH_TOKEN?: string;
  /** bpc_... from scripts/stripe-setup.mjs; empty uses the account's default portal settings. */
  PORTAL_CONFIGURATION?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** HMAC key for login and session tokens. */
  SESSION_SECRET: string;
  RESEND_API_KEY?: string;
  /** Mailgun overflow (free plan, factordynamics.com already verified there). Off when unset. */
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  MAILGUN_BASE?: string;
  /** Fine-grained GitHub PAT (refcell/gust only, Actions: read and write) to dispatch the data refresh. */
  GITHUB_DISPATCH_TOKEN?: string;
  /** Set (as a secret) only on a retired copy of the API: every request is redirected to this base. */
  MOVED_TO?: string;
  /** The base for members' private feed URLs (gene's Funnel): feed readers poll every few minutes, off the shared Workers quota. */
  FEED_URL?: string;
  /** The mailing address marketing email must carry (the Friday email, Email 2). Empty: no Copy ask, and Email 2 isn't sent. */
  POSTAL_ADDRESS?: string;
  /** The commit this copy runs (gene's deployer sets it from state.deployed-sha): /health's api_build, so /status/ tells a deploy from a crash. */
  BUILD_SHA?: string;
  /** "on": Cloudflare (poller) and gene (members) sync KV through R2 and share the poll (failover.ts). */
  SYNC?: string;
  /** Cloudflare API token: Account Analytics read (the daily request-budget check) and R2 write to PUBLIC_BUCKET (latency.json). */
  CF_API_TOKEN?: string;
  /** Public R2 bucket the cron writes static JSON to (latency.json), and its public base URL. */
  PUBLIC_BUCKET?: string;
  /** 'off' turns the launch-week test-mail sink off (the test suite); anything else leaves it on through Nov 16. */
  TEST_MAIL_SINK?: string;
  PUBLIC_URL?: string;
  CF_ACCOUNT_ID?: string;
  /** SEC requests per minute run: 40 fits the free plan's 50 subrequests; raise on Workers Paid. */
  SEC_BUDGET?: string;
  /** Durable Object namespace: one KeyMeter per API key (rate limits and usage). */
  METER: import('./keys').MeterNamespace;
  FOLLOWS: import('./members').FollowsNamespace;
  /** Holdterm's site root (trailing slash) and billing portal configuration. */
  HOLDTERM_SITE_URL?: string;
  HOLDTERM_PORTAL_CONFIGURATION?: string;
}

/** What we keep per Stripe customer. */
export interface Member {
  /** When the record last took Stripe's subscription (webhook or reconciliation). */
  synced_at?: string;
  /** The subscription has a card (or other payment method) to charge when its trial ends. */
  has_payment_method?: boolean;
  customer: string;
  email: string;
  status: string;
  /** Which product: Copy, or Copy Pro (everything in Copy plus API keys, /v1, webhooks, bulk export). */
  plan: 'copy' | 'pro' | 'fund' | 'holdterm' | 'free';
  interval: 'monthly' | 'yearly' | 'unknown';
  /** Unix seconds when a 14-day trial ends, while trialing. */
  trial_end?: number | null;
  period_end: number;
  subscription: string;
  /** "all", or the manager slugs to alert on. */
  alerts: 'all' | 'off' | string[];
  welcomed?: boolean;
  /** Cancelled in the portal: active until period_end (or cancel_at), then it ends. */
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  /** Lifecycle email already sent: the trial_end reminded, the season recapped, the subscription asked why. */
  trial_reminded?: number | null;
  /** Free of charge for good (critics, a forever 100%-off coupon): no revenue email. */
  comped?: boolean;
  recap_sent?: string;
  /** Alerts delivered up to the last season recap, so the next one counts that season only. */
  recap_n?: number;
  why_sent?: string;
  /** A Copy Fund seat: the owner's Stripe customer id. Billing, seats and shared lists are the owner's. */
  seat_of?: string;
  /** Sessions issued before this (unix) are refused: the Fund owner revoked the seat's sessions. */
  sessions_after?: number;
  /** Set when the member first signs in by an emailed link: a signup's provisional session stops working then. */
  verified?: boolean;
  /** Set once the member picks an alert scope themselves (POST /alerts). */
  alerts_chosen?: boolean;
  /** A one-time line for the next email, e.g. "followed" after moving "all" to followed funds. */
  alerts_note?: 'followed';
  /** Where the member came from (the signup box's placement, or utm_source), carried from a free signup onto the paid member. */
  source?: string | null;
  /** A launch-gate test subscription (a 100%-off gate promotion code): left out of revenue and funnel counts. */
  test?: string;
  utm?: Record<string, string>;
  /** First seen (free signup or first subscription), ISO. */
  created_at?: string;
  /** Unsubscribed from the weekly email and lifecycle email (alerts and receipts still come). */
  marketing_off?: boolean;
  /** A free signup that later subscribed: the paid member's customer id. */
  converted_to?: string;
  /** The trial-ended note offering monthly, sent for this subscription. */
  winback_sent?: string;
  /** Referral: the code that brought this member, and the referrer's customer id. */
  referred_by?: string | null;
  /** Paused between filing seasons (Stripe pause_collection): unix seconds when alerts and access come back. */
  paused_until?: number | null;
  /** A pause chosen during a monthly trial starts when the trial ends (unix); the trial keeps everything until then. */
  paused_from?: number | null;
  /** The 3-days-before reminder, sent for this paused_until. */
  pause_reminded?: number | null;
  /** The pre-season win-back, sent for this season (the quarter whose 13Fs are due next). */
  preseason_sent?: string;
  /** Failed-payment email, sent for this invoice. */
  dunning_sent?: string;
}

/**
 * Cloudflare's Worker: always up, and it answers /unsubscribe itself (failover.writeThrough), so a member email's
 * one-click unsubscribe works when gene is down; its feeds are proxied and its other paths 307 to the members' API. Member emails link here or to
 * the site, never to gene's host.
 */
export const WORKER_URL = 'https://copybook-api.factordynamics.workers.dev';

/** The one public base URL for every absolute link the API hands out (feeds, CSV and bulk links, email links), without
 * a trailing slash: API_URL when set (the API can sit under a path behind a proxy, e.g. self-hosted at
 * https://host/copybook/), else the request's origin. */
export function apiBase(env: Env, url?: URL): string {
  return (env.API_URL ?? (url ? `${url.origin}/` : 'https://copybook-api.factordynamics.workers.dev/')).replace(/\/+$/, '');
}

/** The stable public base, gene's Funnel name (FEED_URL): every stored or emailed link (unsubscribe, resume, reasons,
 * feeds) and the documented /v1 base. Member pages read api.json (the faster quick tunnel) instead. */
export function stableBase(env: Env, url?: URL): string {
  return (env.FEED_URL ?? apiBase(env, url)).replace(/\/+$/, '');
}

/** Base for short-lived links only (a CSV download link, /v1/bulk file URLs): the entry point this request came in on,
 * from the self-hosted front door's x-copybook-public-base (it strips any client copy first). Only known public hosts
 * count, so a client calling Cloudflare directly can't pick the base. Never for stored or emailed links: use apiBase. */
export function linkBase(env: Env, req: Request, url: URL): string {
  const h = req.headers.get('x-copybook-public-base');
  return h && (h === 'https://copybook-api.factordynamics.workers.dev' || /^https:\/\/[a-z0-9-]+\.(trycloudflare\.com|tail70ba3\.ts\.net)\/copybook$/.test(h)) ? h : apiBase(env, url);
}

/**
 * Operator output never carries a real member's data (agent sessions are logged): an email shows as a***@domain,
 * lists as counts, destinations not at all. Test members (gate and critic inboxes, `test`) show as they are.
 */
/**
 * The per-member access log: every operator read of a member's records (book, follows, channels, account), with
 * who (the x-copybook-operator header naming the session or script, else \"operator token\"), when, the route and the
 * member's row ID. Kept per member (access:{customer}, last 500) so a member can be told whether any session read
 * their book. Members' own requests are not logged.
 */
export async function logAccess(env: Env, req: Request | null, route: string, customers: (string | null | undefined)[], note?: string, who?: string, at = new Date().toISOString()): Promise<void> {
  const named = req?.headers.get('x-copybook-operator')?.slice(0, 120);
  // A caller still sending the token in this header (the old timing bypass) is never written to the log.
  const by = who ?? (named && named !== env.HEALTH_TOKEN ? named : 'operator token');
  for (const c of new Set(customers.filter((x): x is string => !!x))) {
    const k = `access:${c}`;
    const log = JSON.parse((await env.DB.get(k)) ?? '[]') as unknown[];
    await env.DB.put(k, JSON.stringify([...log, { at, who: by, route, customer: c, ...(note ? { note } : {}) }].slice(-500)));
  }
}

export const testAddress = (e: string) => /^copybook-(test|gate)-/.test(e) || e.endsWith('@fldubai.com');
export const maskEmail = (e: string) => (testAddress(e) ? e : e.replace(/^(.)[^@]*(@.*)$/, '$1***$2'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const followCounts = (f: any) => Object.fromEntries(['investors', 'stocks', 'owned', 'peers'].map((k) => [k, Array.isArray(f?.[k]) ? f[k].length : 0]).concat([['linked_book', f?.book ? 1 : 0]]));

export const ACTIVE = new Set(['active', 'trialing', 'past_due']);

/** Copy Pro and Copy Fund: API keys, /v1, webhooks, bulk export. */
export function isPro(m: Member | null): boolean {
  return isActive(m) && (m.plan === 'pro' || m.plan === 'fund');
}

/** Holdterm members (a separate brand on this Worker) get alerts and nothing else. */
export function isCopy(m: Member | null): m is Member {
  return isActive(m) && m.plan !== 'holdterm';
}

/** Paused until the next season: Stripe still says active, but no alerts or paid features until paused_until. */
export function isPaused(m: Member | null, now = Date.now()): boolean {
  return !!m?.paused_until && m.paused_until * 1000 > now && !((m.paused_from ?? 0) * 1000 > now);
}

/** A pause that starts when the trial ends (chosen during a monthly trial). */
export function pauseScheduled(m: Member | null, now = Date.now()): boolean {
  return !!m?.paused_until && !!m.paused_from && m.paused_from * 1000 > now;
}

export function isActive(m: Member | null): m is Member {
  return !!m && ACTIVE.has(m.status) && !isPaused(m);
}
