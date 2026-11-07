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

export interface Env {
  DB: KV;
  /** Site root, e.g. https://refcell.github.io/gust/copybook/ (trailing slash). */
  SITE_URL: string;
  /** Where {slug}-history.json and alerts.json live. */
  DATA_URL: string;
  ALLOWED_ORIGINS?: string;
  EMAIL_FROM: string;
  /** bpc_... from scripts/stripe-setup.mjs; empty uses the account's default portal settings. */
  PORTAL_CONFIGURATION?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** HMAC key for login and session tokens. */
  SESSION_SECRET: string;
  RESEND_API_KEY?: string;
}

/** What we keep per Stripe customer. */
export interface Member {
  customer: string;
  email: string;
  status: string;
  plan: 'monthly' | 'yearly' | 'unknown';
  period_end: number;
  subscription: string;
  /** "all", or the manager slugs to alert on. */
  alerts: 'all' | 'off' | string[];
  welcomed?: boolean;
}

export const ACTIVE = new Set(['active', 'trialing', 'past_due']);

export function isActive(m: Member | null): m is Member {
  return !!m && ACTIVE.has(m.status);
}
