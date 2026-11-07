import type { Env } from './env';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Sends through Resend's batch API (100 per request). Returns a short status for logs. */
export async function sendMail(env: Env, mails: Mail[]): Promise<string> {
  if (!mails.length) return 'none';
  if (!env.RESEND_API_KEY) {
    console.log(`email skipped (no RESEND_API_KEY): ${mails.map((m) => m.subject).join(' | ')}`);
    return 'skipped';
  }
  const statuses: string[] = [];
  for (let i = 0; i < mails.length; i += 100) {
    const batch = mails.slice(i, i + 100).map((m) => ({ from: env.EMAIL_FROM, to: [m.to], subject: m.subject, text: m.text }));
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) console.log(`resend ${res.status}: ${await res.text()}`);
    statuses.push(String(res.status));
  }
  return statuses.join(',');
}

const FOOTER = '\n\nSource: SEC EDGAR 13F-HR filings, as filed. Not investment advice.\nCopybook by Factor Dynamics.';

export function loginMail(env: Env, to: string, token: string, welcome: boolean): Mail {
  const link = `${env.SITE_URL}account/?login=${encodeURIComponent(token)}`;
  const intro = welcome
    ? 'Thanks for subscribing to Copy. Your plan includes full 13F history, CSV export, and an email when a tracked manager files a new 13F.'
    : 'Here is your Copybook sign-in link.';
  return {
    to,
    subject: welcome ? 'Welcome to Copybook Copy' : 'Your Copybook sign-in link',
    text: `${intro}\n\nSign in (link works for 7 days):\n${link}\n\nManage or cancel billing any time from ${env.SITE_URL}account/.${FOOTER}`,
  };
}

export function alertMail(env: Env, to: string, filings: { manager: string; name: string; quarter: string; filing_date: string; sec_url: string; slug: string }[]): Mail {
  const lines = filings.map((f) => `- ${f.manager} (${f.name}) ${f.quarter}, filed ${f.filing_date}\n  ${f.sec_url}`);
  return {
    to,
    subject: `Copybook: ${filings.length} new 13F filing${filings.length === 1 ? '' : 's'}`,
    text: `New 13F filings from managers you track:\n\n${lines.join('\n')}\n\nChange alert settings at ${env.SITE_URL}account/.${FOOTER}`,
  };
}
