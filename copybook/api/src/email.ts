import type { Alert13F, AlertEvent } from './alerts';
import type { Env, Member } from './env';
import type { Follows } from './members';

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

const FOOTER = '\n\nSource: SEC EDGAR filings (13F-HR, Form 4, Schedules 13D and 13G), as filed. Not investment advice.\nCopybook by Factor Dynamics.';

export function loginMail(env: Env, to: string, token: string, welcome: boolean): Mail {
  const link = `${env.SITE_URL}account/?login=${encodeURIComponent(token)}`;
  const intro = welcome
    ? 'Thanks for subscribing to Copy. Your plan includes 8 quarters of 13F history (every position each quarter), CSV export, and email alerts: a manager you follow files a 13F and you get its new, added, trimmed and exited positions, usually within minutes, plus their Form 4 and Schedule 13D filings between quarters. Alerts start once you follow funds or add stocks you own on Copybook; you can switch to every curated fund in alert settings.'
    : 'Here is your Copybook sign-in link.';
  return {
    to,
    subject: welcome ? 'Welcome to Copybook Copy' : 'Your Copybook sign-in link',
    text: `${intro}\n\nSign in (link works for 7 days):\n${link}\n\nManage or cancel billing any time from ${env.SITE_URL}account/.${FOOTER}`,
  };
}

function usd(v: number, sign = true): string {
  const a = Math.abs(v);
  const s = a >= 1e9 ? `$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : `$${Math.round(a / 1e3)}K`;
  return sign ? (v < 0 ? '-' : '+') + s : s;
}

const quarterLabel = (q: string) => (/^\d{4}Q[1-4]$/.test(q) ? `Q${q[5]} ${q.slice(0, 4)}` : q);

function flag(ticker: string | null, f: Follows): string {
  if (!ticker) return '';
  return f.owned.includes(ticker) ? ' [you own]' : f.stocks.includes(ticker) ? ' [watchlist]' : '';
}

function filingBlock(env: Env, a: Alert13F, f: Follows): string {
  const head = `${a.manager}${a.name && a.name !== a.manager ? ` (${a.name})` : ''}: ${quarterLabel(a.quarter)} 13F, filed ${a.filing_date}${a.followup ? ' (position changes)' : ''}`;
  const lines = [head];
  const mv = a.moves;
  if (mv) {
    lines.push(`Bought ${usd(mv.bought_usd, false)}, sold ${usd(mv.sold_usd, false)} this quarter.`);
    for (const [label, rows] of [['New', mv.new], ['Added', mv.added], ['Trimmed', mv.trimmed], ['Exited', mv.exited]] as const) {
      if (!rows.length) continue;
      const parts = rows.map((r) => {
        const name = (r.ticker || r.display_name || r.issuer || r.cusip) + (r.put_call ? ` ${r.put_call.toLowerCase()}s` : '');
        // The data run is renaming the trade size to delta_pct_of_book (pct_of_book becomes the position's weight).
        const d = r.delta_pct_of_book ?? r.pct_of_book;
        const pct = d ? ` (${(Math.abs(d) * 100).toFixed(1)}% of book)` : '';
        return `${name} ${usd(r.value_delta)}${pct}${flag(r.ticker, f)}`;
      });
      lines.push(`  ${label}: ${parts.join(', ')}`);
    }
    const owned = a.tickers.filter((t) => f.owned.includes(t)).length;
    const watched = a.tickers.filter((t) => f.stocks.includes(t) && !f.owned.includes(t)).length;
    const yours = [owned && `${owned} ${owned === 1 ? 'is a stock' : 'are stocks'} you own`, watched && `${watched} ${watched === 1 ? 'is' : 'are'} on your watchlist`].filter(Boolean);
    if (yours.length) lines.push(`  Of the positions that changed, ${yours.join(' and ')}.`);
  } else if (a.top?.length) {
    lines.push('  No earlier quarter on file for this filer, so no changes yet. Largest holdings:');
    lines.push(`  ${a.top.map((r) => `${r.ticker || r.display_name || r.issuer}${r.put_call ? ` ${r.put_call.toLowerCase()}s` : ''} ${usd(r.value, false)}${flag(r.ticker, f)}`).join(', ')}`);
  } else if (a.extra) {
    lines.push('  Holdings are on the filer page below.');
  } else {
    lines.push('  Too many positions to diff on filing. A second email with its position changes follows after the next data refresh, usually within a few hours.');
  }
  lines.push(`  Copybook: ${env.SITE_URL}investors/${a.slug}`, `  SEC: ${a.sec_url}`);
  return lines.join('\n');
}

const FORM_LABEL: Record<string, string> = { form4: 'Form 4', '13d': 'Schedule 13D', '13g': 'Schedule 13G' };

const n = (v: number) => {
  const a = Math.abs(v);
  return a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : v.toLocaleString('en-US');
};

/** What changed in a 13D/G stake, and why: trading, dilution or issuance, thresholds, 13G to 13D. */
export function stakeChange(e: AlertEvent): { line: string | null; note: string | null } {
  const pct = e.percent_of_class;
  const prev = e.prev_percent_of_class;
  if (pct == null) return { line: null, note: null };
  if (prev == null) return { line: `${pct}% of the class${e.shares_after != null ? `, ${e.shares_after.toLocaleString('en-US')} shares` : ''}`, note: e.action === 'new_stake' ? 'new stake' : null };
  const sh = e.shares_after;
  const psh = e.prev_shares_after;
  const shares = sh != null && psh != null ? (sh === psh ? `${sh.toLocaleString('en-US')} shares (unchanged)` : `${psh.toLocaleString('en-US')} → ${sh.toLocaleString('en-US')} shares (${sh > psh ? '+' : ''}${n(sh - psh)})`) : null;
  const notes: string[] = [];
  if (sh != null && psh != null) {
    if (sh === psh && pct < prev) notes.push('diluted, no shares sold');
    else if (sh === psh && pct > prev) notes.push('fewer shares outstanding, no shares bought');
    else if (sh > psh) notes.push('bought');
    else if (sh < psh) notes.push('sold');
  }
  for (const t of [5, 10, 20, 50]) {
    if (prev < t && pct >= t) notes.push(`crossed above ${t}%`);
    if (prev >= t && pct < t) notes.push(`fell below ${t}%`);
  }
  if (e.prev_form?.includes('13G') && e.kind === '13d') notes.push('switched from passive 13G to activist 13D');
  return { line: `${prev}% → ${pct}% of the class${shares ? `; ${shares}` : ''}`, note: notes.join('; ') || null };
}

function eventLine(env: Env, e: AlertEvent, f: Follows): string {
  const what = e.ticker || e.display_name || e.issuer || 'a security';
  const form = `${FORM_LABEL[e.kind]}${/\/A$/.test(e.form) ? '/A' : ''}${e.amendment_no ? ` (amendment ${e.amendment_no})` : ''}`;
  const who = e.manager || 'A filer';
  const lines: string[] = [];
  if (e.details_pending) {
    lines.push(`${form}: ${who}${e.issuer || e.ticker ? `, ${what}` : ''}. Details follow once the filing is processed.`);
  } else if (e.kind === 'form4') {
    const verb = e.action === 'buy' ? 'bought' : e.action === 'sell' ? 'sold' : e.action === 'mixed' ? 'bought and sold' : 'reported';
    const money = e.value_usd ? ` (${usd(Math.abs(e.value_usd), false)}${e.avg_price ? `, avg $${e.avg_price.toFixed(2)}` : ''})` : '';
    const sh = e.shares && e.action !== 'mixed' ? `${Math.abs(e.shares).toLocaleString('en-US')} shares of ` : '';
    lines.push(`${form}: ${who} ${verb} ${sh}${what}${money}`);
    // Holdings per class: Class A and Class B are separate securities.
    for (const c of e.classes ?? []) {
      const delta = c.bought - c.sold;
      if (c.shares_after == null && !delta) continue;
      const pctChg = c.shares_before && c.shares_after != null ? ` (${c.shares_after >= c.shares_before ? '+' : ''}${(((c.shares_after - c.shares_before) / c.shares_before) * 100).toFixed(1)}%)` : '';
      lines.push(`  ${c.security}: ${c.shares_before != null ? `${n(c.shares_before)} → ` : ''}${c.shares_after != null ? n(c.shares_after) : '?'} shares${pctChg}`);
    }
    if (!e.classes && e.shares_after != null) lines.push(`  Shares held after: ${e.shares_after.toLocaleString('en-US')}`);
  } else {
    const verb = e.action === 'new_stake' ? 'disclosed a new stake in' : e.action === 'below_threshold' ? 'reported below 5% of' : 'filed an amendment on';
    const c = stakeChange(e);
    const inline = e.prev_percent_of_class == null && c.line;
    lines.push(`${form}: ${who} ${verb} ${what}${inline ? `, ${c.line}` : ''}`);
    if (c.line && !inline) lines.push(`  Stake: ${c.line}${c.note ? ` (${c.note})` : ''}`);
    if (e.item4) lines.push(`  Purpose (Item 4): ${e.item4}`);
  }
  for (const fn of (e.footnotes ?? []).slice(0, 3)) lines.push(`  Footnote: ${fn.length > 240 ? `${fn.slice(0, 240)}…` : fn}`);
  const stamp = e.accepted ? `accepted by EDGAR ${e.accepted.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}` : `filed ${e.filing_date}`;
  lines.push(`  ${flag(e.ticker, f).trim() ? `${flag(e.ticker, f).trim()} · ` : ''}Accession ${e.id}, ${stamp}`);
  if (e.slug) lines.push(`  Copybook: ${env.SITE_URL}investors/${e.slug}`);
  lines.push(`  SEC: ${e.url}`);
  return lines.join('\n');
}

function body(env: Env, intro: string, filings: Alert13F[], events: AlertEvent[], f: Follows, m?: Member): string {
  const parts = [intro];
  if (m?.alerts_note === 'followed') {
    parts.push(`Alert change: you now get alerts only for the ${f.investors.length} fund${f.investors.length === 1 ? '' : 's'} you follow, plus active managers' moves in stocks you own or watch. To get every curated fund again, choose "Every investor" in alert settings at ${env.SITE_URL}account/.`);
  }
  if (filings.length) parts.push(filings.map((a) => filingBlock(env, a, f)).join('\n\n'));
  if (events.length) parts.push(`Between-quarter moves:\n${events.map((e) => eventLine(env, e, f)).join('\n')}`);
  return `${parts.join('\n\n')}\n\nChoose whom you follow and how you get alerts at ${env.SITE_URL}account/.${FOOTER}`;
}

function summary(filings: Alert13F[]): string {
  if (filings.length !== 1) return `${filings.length} new 13F filings`;
  const a = filings[0];
  const mv = a.moves;
  const bits = mv ? [mv.new.length && `${mv.new.length}${mv.new.length === 5 ? '+' : ''} new`, mv.exited.length && `${mv.exited.length}${mv.exited.length === 5 ? '+' : ''} exited`].filter(Boolean) : [];
  return `${a.manager} ${a.followup ? 'position changes,' : 'filed'} ${quarterLabel(a.quarter)} 13F${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

export function alertMail(env: Env, to: string, filings: Alert13F[], events: AlertEvent[], f: Follows, m?: Member): Mail {
  const subject = filings.length
    ? `Copybook: ${summary(filings)}${events.length ? ` + ${events.length} more` : ''}`
    : `Copybook: ${events.length === 1 ? `${events[0].manager} ${FORM_LABEL[events[0].kind]} filing` : `${events.length} new Form 4 and 13D/G filings`}`;
  return { to, subject, text: body(env, 'New filings from managers and stocks you follow:', filings, events, f, m) };
}

export function digestMail(env: Env, to: string, day: string, filings: Alert13F[], events: AlertEvent[], f: Follows, m?: Member): Mail {
  const n = [filings.length && `${filings.length} 13F${filings.length === 1 ? '' : 's'}`, events.length && `${events.length} Form 4/13D/G`].filter(Boolean).join(', ');
  return { to, subject: `Copybook daily digest for ${day}: ${n}`, text: body(env, `Today's filings from managers and stocks you follow (${day}):`, filings, events, f, m) };
}
