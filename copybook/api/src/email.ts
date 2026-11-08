import type { Alert13F, AlertEvent } from './alerts';
import type { MoveRow, Moves } from './edgar';
import type { Env, Member } from './env';
import type { Follows } from './members';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** The same content laid out as tables, for mail clients that show HTML. */
  html?: string;
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
    const batch = mails.slice(i, i + 100).map((m) => ({ from: env.EMAIL_FROM, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }));
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

/** The reply to a fund-plan, support or data-deletion request from the site. */
export function leadAckMail(env: Env, l: { topic: unknown; name: string | null; email: string; fund: string | null; seats: number | null; invoice: boolean | null; plan_interval: string | null; message: string | null }): Mail {
  const hi = l.name ? `Hi ${l.name},` : 'Hi,';
  const what =
    l.topic === 'delete'
      ? 'We received your request to delete your Copybook data. We will confirm by email once it is done, within 30 days.'
      : l.topic === 'support'
        ? 'We received your message and will reply to this address, usually within one business day.'
        : `Thanks for your interest in Copy Fund${l.fund ? ` for ${l.fund}` : ''}. We will reply to this address within one business day${l.invoice ? ' with an annual invoice quote' : ' with how to get started'}.`;
  const got = [
    l.fund && `Fund: ${l.fund}`,
    l.seats && `Seats: ${l.seats}`,
    l.invoice !== null && l.topic === 'fund' && `Invoice billing: ${l.invoice ? 'yes' : 'no'}`,
    l.plan_interval && `Billing: ${l.plan_interval}`,
    l.message && `Your note: ${l.message.length > 600 ? `${l.message.slice(0, 600)}…` : l.message}`,
  ].filter(Boolean);
  return {
    to: l.email,
    subject: l.topic === 'delete' ? 'Your Copybook data deletion request' : l.topic === 'support' ? 'We got your message' : 'Your Copy Fund request',
    text: `${hi}\n\n${what}${got.length ? `\n\nWhat you sent:\n${got.join('\n')}` : ''}\n\nCopybook: ${env.SITE_URL}${FOOTER}`,
  };
}

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

const MOVE_LABELS = [['New', 'new'], ['Added', 'added'], ['Trimmed', 'trimmed'], ['Exited', 'exited']] as const;

const rowName = (r: MoveRow) => (r.ticker || r.display_name || r.issuer || r.cusip) + (r.put_call ? ` ${r.put_call.toLowerCase()}s` : '');

/** The trade as a share of this filing's book (the data run renamed it delta_pct_of_book). */
const bookPct = (r: MoveRow) => {
  const d = r.delta_pct_of_book ?? r.pct_of_book;
  if (!d) return '';
  return Math.abs(d) < 0.0005 ? '<0.1%' : `${(Math.abs(d) * 100).toFixed(1)}%`;
};

/** How much of the position itself changed: a trim of 40% of the shares reads differently from 0.4% of the book. */
function positionChange(label: string, r: MoveRow): string {
  if (label === 'New') return 'new';
  if (label === 'Exited') return 'sold all';
  if (!r.prev_shares) return '';
  const p = ((r.shares - r.prev_shares) / r.prev_shares) * 100;
  return label === 'Trimmed' ? `sold ${Math.abs(p).toFixed(0)}%` : `+${p.toFixed(0)}% shares`;
}

/** Short name for subjects: a person's surname ("Buffett"), else the firm without its legal suffix. */
export function shortName(manager: string): string {
  const name = manager.trim();
  // EDGAR writes filer names in capitals, people surname first ("ICAHN CARL C"): keep the order, drop the legal suffix.
  if (name === name.toUpperCase()) {
    const bare = name.replace(/[,\s]+(LLC|L\.L\.C\.|LP|L\.P\.|INC\.?|CORP\.?|LTD\.?|PLC|CO\.?|ET AL)\.?$/i, '') || name;
    return bare.toLowerCase().replace(/(^|[\s\-/&(])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
  }
  const firm = /\b(LLC|L\.?L\.?C\.?|LP|L\.?P\.?|INC|CORP|CO|LTD|PLC|GROUP|MANAGEMENT|CAPITAL|PARTNERS|ADVIS[OE]RS|TRUST|FUND|HOLDINGS|ASSOCIATES|INVESTMENTS?|ASSET|ENTERPRISES|BANK|S\.?A\.?|AG|GMBH)\b/i;
  const words = name.split(/\s+/);
  if (words.length >= 2 && words.length <= 3 && !firm.test(name)) return words[words.length - 1];
  return name.replace(/[,\s]+(LLC|L\.L\.C\.|LP|L\.P\.|INC\.?|CORP\.?|LTD\.?|PLC)\.?$/i, '') || name;
}

/**
 * "NEW DHI · EXIT STZ · GOOGL +$8.8B": the largest new position and the largest exit (a new name
 * or a full exit is the news, whatever its size), then the largest adds and trims by dollars.
 */
function headlineMoves(mv: Moves): string {
  const big = (rows: MoveRow[]) => [...rows].sort((a, b) => Math.abs(b.value_delta) - Math.abs(a.value_delta));
  return [
    ...big(mv.new).slice(0, 1).map((r) => `NEW ${rowName(r)}`),
    ...big(mv.exited).slice(0, 1).map((r) => `EXIT ${rowName(r)}`),
    ...big([...mv.added, ...mv.trimmed]).map((r) => `${rowName(r)} ${usd(r.value_delta)}`),
  ]
    .slice(0, 3)
    .join(' · ');
}

const acceptedUtc = (iso: string) => iso.replace('T', ' ').replace(/(\.\d+)?Z$/, ' UTC');

function filingBlock(env: Env, a: Alert13F, f: Follows): string {
  const head = `${a.manager}${a.name && a.name !== a.manager ? ` (${a.name})` : ''}: ${quarterLabel(a.quarter)} 13F, filed ${a.filing_date}${a.followup ? ' (position changes)' : ''}`;
  const lines = [head];
  const mv = a.moves;
  if (mv) {
    lines.push(`Bought ${usd(mv.bought_usd, false)}, sold ${usd(mv.sold_usd, false)} this quarter.`);
    for (const [label, rows] of [['New', mv.new], ['Added', mv.added], ['Trimmed', mv.trimmed], ['Exited', mv.exited]] as const) {
      if (!rows.length) continue;
      const parts = rows.map((r) => {
        const pos = label === 'Trimmed' || label === 'Added' ? positionChange(label, r) : '';
        const bits = [pos && (label === 'Trimmed' ? `${pos} of the position` : pos), bookPct(r) && `${bookPct(r)} of book`].filter(Boolean);
        return `${rowName(r)} ${usd(r.value_delta)}${bits.length ? ` (${bits.join(', ')})` : ''}${flag(r.ticker, f)}`;
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
  if (a.accepted) lines.push(`  Accession ${a.accession}, accepted by EDGAR ${acceptedUtc(a.accepted)}`);
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
  const stamp = e.accepted ? `accepted by EDGAR ${acceptedUtc(e.accepted)}` : `filed ${e.filing_date}`;
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
  const now = events.filter((e) => !e.late);
  const late = events.filter((e) => e.late);
  if (now.length) parts.push(`Between-quarter moves:\n${now.map((e) => eventLine(env, e, f)).join('\n')}`);
  if (late.length) parts.push(`Earlier filings you may have missed (accepted by EDGAR more than 6 hours before we could alert):\n${late.map((e) => eventLine(env, e, f)).join('\n')}`);
  return `${parts.join('\n\n')}\n\nChoose whom you follow and how you get alerts at ${env.SITE_URL}account/.${FOOTER}`;
}

/** One alert as a subject line: "Buffett Q3: NEW DHI · EXIT STZ · GOOGL +$8.8B". */
function filingHeadline(a: Alert13F): string {
  const q = /^\d{4}Q[1-4]$/.test(a.quarter) ? `Q${a.quarter[5]}` : a.quarter;
  const who = shortName(a.manager);
  if (a.moves) return `${who} ${q}${a.followup ? ' changes' : ''}: ${headlineMoves(a.moves) || 'no position changes'}`;
  return `${who} filed its ${q} 13F`;
}

/** "Icahn CVI 13D/A: 70.8% → 64.1% (diluted, no shares sold)"; "Buffett LEN Form 4: bought $192.6M". */
export function eventHeadline(e: AlertEvent): string {
  const who = shortName(e.manager || 'A filer');
  const what = e.ticker || e.display_name || e.issuer || '';
  const form = e.kind === 'form4' ? 'Form 4' : `${e.kind === '13d' ? '13D' : '13G'}${/\/A$/.test(e.form) ? '/A' : ''}`;
  const head = `${who}${what ? ` ${what}` : ''} ${form}`;
  if (e.details_pending) return `${head} filed (details to follow)`;
  if (e.kind === 'form4') {
    const verb = e.action === 'buy' ? 'bought' : e.action === 'sell' ? 'sold' : e.action === 'mixed' ? 'bought and sold' : 'filed';
    return `${head}: ${verb}${e.value_usd ? ` ${usd(Math.abs(e.value_usd), false)}` : ''}`;
  }
  const pct = e.percent_of_class;
  if (pct == null) return `${head} filed`;
  const c = stakeChange(e);
  if (e.prev_percent_of_class != null) return `${head}: ${e.prev_percent_of_class}% → ${pct}%${c.note ? ` (${c.note})` : ''}`;
  return `${head}: ${e.action === 'new_stake' ? `new ${pct}% stake` : `${pct}%`}`;
}

export function alertMail(env: Env, to: string, filings: Alert13F[], events: AlertEvent[], f: Follows, m?: Member): Mail {
  const heads = [...filings.map(filingHeadline), ...events.map(eventHeadline)];
  const subject = `${heads[0]}${heads.length > 1 ? ` + ${heads.length - 1} more` : ''}`;
  const intro = 'New filings from managers and stocks you follow:';
  return { to, subject, text: body(env, intro, filings, events, f, m), html: htmlBody(env, intro, filings, events, f, m) };
}

export function digestMail(env: Env, to: string, day: string, filings: Alert13F[], events: AlertEvent[], f: Follows, m?: Member, lateOnly = false): Mail {
  if (lateOnly) {
    const intro = 'Filings from managers and stocks you follow that EDGAR accepted too long ago to send as news:';
    return { to, subject: `Copybook: ${events.length} earlier filing${events.length === 1 ? '' : 's'} you may have missed`, text: body(env, intro, [], events, f), html: htmlBody(env, intro, [], events, f) };
  }
  const n = [filings.length && `${filings.length} 13F${filings.length === 1 ? '' : 's'}`, events.length && `${events.length} Form 4/13D/G`].filter(Boolean).join(', ');
  const intro = `Today's filings from managers and stocks you follow (${day}):`;
  return { to, subject: `Copybook daily digest for ${day}: ${n}`, text: body(env, intro, filings, events, f, m), html: htmlBody(env, intro, filings, events, f, m) };
}

// ---------------------------------------------------------------------------------------------
// HTML: the same alert as tables

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const TD = 'padding:4px 10px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top';
const TDR = `${TD};text-align:right;font-variant-numeric:tabular-nums`;
const link = (href: string, text: string) => `<a href="${esc(href)}" style="color:#1d4ed8">${esc(text)}</a>`;

function table(head: string[], rows: string[][], right: number[] = []): string {
  const th = head.map((h, i) => `<th style="${right.includes(i) ? TDR : TD};font-weight:600;color:#6b7280;font-size:12px">${esc(h)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td style="${right.includes(i) ? TDR : TD}">${c}</td>`).join('')}</tr>`).join('');
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:14px;margin:6px 0 4px">${th ? `<tr>${th}</tr>` : ''}${tr}</table>`;
}

const meta = (env: Env, slug: string, accession: string, accepted: string | undefined, sec: string) =>
  `<p style="margin:4px 0 18px;font-size:12px;color:#6b7280">Accession ${esc(accession)}${accepted ? `, accepted by EDGAR ${esc(acceptedUtc(accepted))}` : ''} · ${slug ? `${link(`${env.SITE_URL}investors/${slug}`, 'Copybook page')} · ` : ''}${link(sec, 'SEC filing')}</p>`;

function filingHtml(env: Env, a: Alert13F, f: Follows): string {
  const out = [`<h3 style="margin:16px 0 2px;font-size:16px">${esc(a.manager)}${a.name && a.name !== a.manager ? ` <span style="color:#6b7280;font-weight:400">(${esc(a.name)})</span>` : ''}: ${esc(quarterLabel(a.quarter))} 13F${a.followup ? ' position changes' : ''}</h3>`];
  const mv = a.moves;
  if (mv) {
    out.push(`<p style="margin:2px 0">Bought ${usd(mv.bought_usd, false)}, sold ${usd(mv.sold_usd, false)} this quarter.</p>`);
    const rows = MOVE_LABELS.flatMap(([label, k]) => mv[k].map((r) => [esc(label), `<b>${esc(rowName(r))}</b>${esc(flag(r.ticker, f))}`, usd(r.value_delta), esc(positionChange(label, r)), bookPct(r)]));
    out.push(table(['Move', 'Stock', 'Value change', 'Position', '% of book'], rows, [2, 4]));
  } else if (a.top?.length) {
    out.push('<p style="margin:2px 0">No earlier quarter on file for this filer, so no changes yet. Largest holdings:</p>');
    out.push(table(['Stock', 'Value'], a.top.map((r) => [`<b>${esc(rowName(r))}</b>${esc(flag(r.ticker, f))}`, usd(r.value, false)]), [1]));
  } else {
    out.push(`<p style="margin:2px 0">${a.extra ? 'Holdings are on the filer page.' : 'Too many positions to diff on filing. A second email with its position changes follows after the next data refresh, usually within a few hours.'}</p>`);
  }
  out.push(meta(env, a.slug, a.accession, a.accepted, a.sec_url));
  return out.join('');
}

function eventHtml(env: Env, e: AlertEvent, f: Follows): string {
  const parts = [`<h3 style="margin:16px 0 2px;font-size:16px">${esc(eventHeadline(e))}${esc(flag(e.ticker, f))}</h3>`];
  if (e.details_pending) parts.push('<p style="margin:2px 0">Details follow once the filing is processed.</p>');
  if (e.kind === 'form4') {
    // One row per share class: Class A and Class B are separate securities.
    const rows = (e.classes ?? []).map((c) => {
      const chg = c.shares_before && c.shares_after != null ? `${c.shares_after >= c.shares_before ? '+' : ''}${(((c.shares_after - c.shares_before) / c.shares_before) * 100).toFixed(1)}%` : '';
      return [esc(c.security), c.bought ? n(c.bought) : '—', c.sold ? n(c.sold) : '—', c.shares_before != null ? n(c.shares_before) : '', c.shares_after != null ? n(c.shares_after) : '', chg];
    });
    if (rows.length) parts.push(table(['Class', 'Bought', 'Sold', 'Held before', 'Held after', 'Change'], rows, [1, 2, 3, 4, 5]));
    if (e.value_usd && !e.details_pending) parts.push(`<p style="margin:2px 0">${usd(Math.abs(e.value_usd), false)}${e.avg_price ? ` at an average $${e.avg_price.toFixed(2)}` : ''}</p>`);
  } else {
    const c = stakeChange(e);
    if (c.line) {
      const prev = e.prev_percent_of_class;
      const stake = [
        ['% of class', prev != null ? `${prev}% → ${e.percent_of_class}%` : `${e.percent_of_class}%`],
        ['Shares', e.prev_shares_after != null && e.shares_after != null ? `${e.prev_shares_after.toLocaleString('en-US')} → ${e.shares_after.toLocaleString('en-US')}` : (e.shares_after?.toLocaleString('en-US') ?? '')],
        ...(c.note ? [['What changed', c.note]] : []),
        ...(e.amendment_no ? [['Amendment', String(e.amendment_no)]] : []),
      ];
      parts.push(table([], stake.map(([k, v]) => [`<span style="color:#6b7280">${esc(k)}</span>`, esc(v)])));
    }
    if (e.item4) parts.push(`<p style="margin:4px 0;font-size:13px"><b>Purpose (Item 4):</b> ${esc(e.item4)}</p>`);
  }
  for (const fn of (e.footnotes ?? []).slice(0, 3)) parts.push(`<p style="margin:2px 0;font-size:12px;color:#4b5563">Footnote: ${esc(fn.length > 240 ? `${fn.slice(0, 240)}…` : fn)}</p>`);
  parts.push(meta(env, e.slug, e.id, e.accepted, e.url));
  return parts.join('');
}

function htmlBody(env: Env, intro: string, filings: Alert13F[], events: AlertEvent[], f: Follows, m?: Member): string {
  const parts = [`<p style="margin:0 0 8px">${esc(intro)}</p>`];
  if (m?.alerts_note === 'followed') parts.push(`<p style="padding:8px 10px;background:#fef9c3">Alert change: you now get alerts only for the ${f.investors.length} fund${f.investors.length === 1 ? '' : 's'} you follow, plus active managers' moves in stocks you own or watch. To get every curated fund again, choose "Every investor" in ${link(`${env.SITE_URL}account/`, 'alert settings')}.</p>`);
  parts.push(...filings.map((a) => filingHtml(env, a, f)));
  const now = events.filter((e) => !e.late);
  const late = events.filter((e) => e.late);
  if (now.length) parts.push('<h2 style="font-size:15px;margin:20px 0 0;color:#374151">Between-quarter moves</h2>', ...now.map((e) => eventHtml(env, e, f)));
  if (late.length) parts.push('<h2 style="font-size:15px;margin:20px 0 0;color:#374151">Earlier filings you may have missed (accepted by EDGAR more than 6 hours before we could alert):</h2>', ...late.map((e) => eventHtml(env, e, f)));
  parts.push(`<p style="margin-top:24px;font-size:12px;color:#6b7280">Choose whom you follow and how you get alerts at ${link(`${env.SITE_URL}account/`, 'your account')}.<br>Source: SEC EDGAR filings (13F-HR, Form 4, Schedules 13D and 13G), as filed. Not investment advice.<br>Copybook by Factor Dynamics.</p>`);
  return `<!doctype html><html><body style="margin:0;padding:16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111827;max-width:680px">${parts.join('')}</body></html>`;
}
