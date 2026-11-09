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
}

export interface R2 {
  get(key: string): Promise<R2Object | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | string | null, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  list(opts: { prefix: string }): Promise<{ objects: { key: string; size: number; uploaded: Date }[] }>;
}

export interface Env {
  DB: KV;
  /** Private bucket for paid data: h/{slug}/{quarter}.json|.csv, fb/{quarter}/{cik}.json full books, s/{issuer}.json holders, bulk/{quarter}.csv.gz exports. */
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
  /** Fine-grained GitHub PAT (refcell/gust only, Actions: read and write) to dispatch the data refresh. */
  GITHUB_DISPATCH_TOKEN?: string;
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
  why_sent?: string;
  /** A Copy Fund seat: the owner's Stripe customer id. Billing, seats and shared lists are the owner's. */
  seat_of?: string;
  /** Set once the member picks an alert scope themselves (POST /alerts). */
  alerts_chosen?: boolean;
  /** A one-time line for the next email, e.g. "followed" after moving "all" to followed funds. */
  alerts_note?: 'followed';
  /** Where the member came from (the signup box's placement, or utm_source), carried from a free signup onto the paid member. */
  source?: string | null;
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
}

export const ACTIVE = new Set(['active', 'trialing', 'past_due']);

/** Copy Pro and Copy Fund: API keys, /v1, webhooks, bulk export. */
export function isPro(m: Member | null): boolean {
  return isActive(m) && (m.plan === 'pro' || m.plan === 'fund');
}

/** Holdterm members (a separate brand on this Worker) get alerts and nothing else. */
export function isCopy(m: Member | null): m is Member {
  return isActive(m) && m.plan !== 'holdterm';
}

export function isActive(m: Member | null): m is Member {
  return !!m && ACTIVE.has(m.status);
}
