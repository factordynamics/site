// Holdterm alert messages, one renderer for every channel: email (HTML and text), Discord, Slack,
// Telegram, browser push and the private feed. Copybook's alerts API is to import this file to send Holdterm
// members their alerts, and Holdterm's /alerts page previews these outputs. It runs in the browser and in
// the Worker, so its only import is names.ts, which the Worker already bundles. Firm names come in already
// shortened (firmName) by the caller.

import { publicSlug } from './names'

export interface HtRow {
  ticker: string | null
  display_name: string | null
  issuer: string
  put_call: string | null
  shares: number
  prev_shares: number
  value: number
  value_delta: number
  unusual?: boolean
}
export interface HtFiling {
  slug: string
  manager: string
  quarter: string
  filing_date: string
  accession: string
  sec_url: string
  moves: { bought_usd: number; sold_usd: number; new: HtRow[]; added: HtRow[]; trimmed: HtRow[]; exited: HtRow[] } | null
  top?: HtRow[]
  followup?: boolean
  reveal?: { confidential: boolean; rows: HtRow[] } | null
}
export interface HtEvent {
  id: string
  slug: string
  manager: string
  form: string
  kind: 'form4' | '13d' | '13g'
  action: string
  filing_date: string
  url: string
  issuer: string | null
  display_name: string | null
  ticker: string | null
  shares: number | null
  value_usd: number | null
  avg_price?: number | null
  shares_after: number | null
  percent_of_class: number | null
  prev_percent_of_class?: number | null
  subject_tickers?: string[]
  details_pending?: boolean
}
export interface HtMail {
  subject: string
  text: string
  html: string
}
export interface HtPush {
  title: string
  body: string
  url: string
  tag: string
}
export interface HtFeedItem {
  id: string
  title: string
  text: string
  url: string
}

const SITE = 'https://holdterm.factordynamics.com/'
const DISCLAIMER = 'From SEC EDGAR filings, as filed. Not investment advice.'

// ---------- wording ----------
const money = (v: number) => {
  const a = Math.abs(v)
  return a >= 1e9 ? `$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}K` : `$${Math.round(a)}`
}
const signed = (v: number) => `${v < 0 ? '−' : '+'}${money(v)}`
const quarter = (q: string) => (/^\d{4}Q[1-4]$/.test(q) ? `Q${q[5]} ${q.slice(0, 4)}` : q)
const day = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`)
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
/** "NVIDIA CORP" → "Nvidia Corp", when there is no display name. */
const tidy = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s\-/&(.])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase()) : s)
const company = (r: { display_name: string | null; issuer: string | null; ticker?: string | null }) => (r.display_name || (r.issuer ? tidy(r.issuer) : '') || r.ticker || 'a company')
const symbol = (r: HtRow) => (r.ticker || company(r)) + (r.put_call ? ` ${r.put_call.toLowerCase()}s` : '')
// Links go to the fund's canonical URL (/m/sanders-capital), not Copybook's data slug, so emails skip a redirect.
const fundUrl = (site: string, slug: string) => `${site}m/${publicSlug(slug)}`
const stockUrl = (site: string, t: string) => `${site}s/${t}`

type Move = { kind: 'new' | 'added' | 'trimmed' | 'exited'; r: HtRow }
const changeLabel = ({ kind, r }: Move) => {
  if (kind === 'new') return 'New position'
  if (kind === 'exited') return 'Sold all'
  if (!r.prev_shares) return kind === 'added' ? 'Added' : 'Trimmed'
  const p = Math.abs(((r.shares - r.prev_shares) / r.prev_shares) * 100)
  return `${kind === 'added' ? 'Added' : 'Trimmed'} ${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`
}
function buysSells(a: HtFiling, n = 5) {
  const mv = a.moves
  if (!mv) return { buys: [] as Move[], sells: [] as Move[] }
  const buys = [...mv.new.map((r) => ({ kind: 'new' as const, r })), ...mv.added.map((r) => ({ kind: 'added' as const, r }))].sort((x, y) => y.r.value_delta - x.r.value_delta).slice(0, n)
  const sells = [...mv.exited.map((r) => ({ kind: 'exited' as const, r })), ...mv.trimmed.map((r) => ({ kind: 'trimmed' as const, r }))].sort((x, y) => x.r.value_delta - y.r.value_delta).slice(0, n)
  return { buys, sells }
}
const verb = (m: Move) => (m.kind === 'new' ? 'opened a position in' : m.kind === 'added' ? 'added to' : m.kind === 'trimmed' ? 'trimmed' : 'sold all of')

/** The one-line headline: email subject, push title, chat title. */
export function filingTitle(a: HtFiling): string {
  if (a.reveal?.rows.length) return `${a.manager} revealed ${a.reveal.rows.length === 1 ? 'a position' : `${a.reveal.rows.length} positions`} in an amended ${quarter(a.quarter).slice(0, 2)} 13F`
  return `${a.manager} filed its ${quarter(a.quarter)} 13F${a.followup ? ': the trades' : ''}`
}
/** A sentence a reader understands without knowing what a 13F is. */
export function filingSummary(a: HtFiling): string {
  if (a.reveal?.rows.length) {
    const r = a.reveal.rows[0]
    return `${a.reveal.confidential ? 'Previously confidential: ' : ''}${company(r)} (${symbol(r)}), ${money(r.value)}${a.reveal.rows.length > 1 ? `, and ${a.reveal.rows.length - 1} more` : ''}.`
  }
  const mv = a.moves
  if (!mv) return a.top?.length ? `Its largest holding is ${company(a.top[0])}, worth ${money(a.top[0].value)}.` : 'The trades follow once the filing is processed.'
  const { buys, sells } = buysSells(a, 1)
  const big = [...buys, ...sells].sort((x, y) => Math.abs(y.r.value_delta) - Math.abs(x.r.value_delta))[0]
  const counts = [mv.new.length && `${mv.new.length} new`, mv.exited.length && `${mv.exited.length} sold out`].filter(Boolean).join(', ')
  return `Bought ${money(mv.bought_usd)} and sold ${money(mv.sold_usd)} of stock last quarter${counts ? ` (${counts})` : ''}.${big ? ` Biggest move: ${verb(big)} ${company(big.r)}, ${signed(big.r.value_delta)}.` : ''}`
}

const formName = (e: HtEvent) => (e.kind === 'form4' ? 'Form 4' : `Schedule ${e.kind === '13d' ? '13D' : '13G'}${/\/A$/.test(e.form) ? ' amendment' : ''}`)
const evTicker = (e: HtEvent) => e.ticker ?? e.subject_tickers?.[0] ?? null
const evCompany = (e: HtEvent) => company(e) + (evTicker(e) && company(e) !== evTicker(e) ? ` (${evTicker(e)})` : '')
export function eventTitle(e: HtEvent): string {
  const c = evCompany(e)
  if (e.details_pending) return `${e.manager} filed a ${formName(e)} on ${c}`
  if (e.kind === 'form4') {
    const v = e.value_usd ? ` ${money(Math.abs(e.value_usd))} of` : ''
    return e.action === 'buy' ? `${e.manager} bought${v} ${c}` : e.action === 'sell' ? `${e.manager} sold${v} ${c}` : `${e.manager} reported a trade in ${c}`
  }
  const pct = e.percent_of_class
  if (pct == null) return `${e.manager} filed a ${formName(e)} on ${c}`
  if (e.prev_percent_of_class != null && e.prev_percent_of_class !== pct) return `${e.manager} now owns ${pct}% of ${c}, ${pct > e.prev_percent_of_class ? 'up' : 'down'} from ${e.prev_percent_of_class}%`
  return e.action === 'new_stake' ? `${e.manager} disclosed a ${pct}% stake in ${c}` : `${e.manager} reports a ${pct}% stake in ${c}`
}
/** The filing's numbers in a sentence ("8,355,251 shares at about $3.76; …"), or ''. */
function eventNumbers(e: HtEvent): string {
  const n = (v: number) => Math.abs(v).toLocaleString('en-US')
  const facts =
    e.kind === 'form4'
      ? [e.shares ? `${n(e.shares)} shares${e.avg_price ? ` at about $${e.avg_price.toFixed(2)}` : ''}` : '', e.shares_after != null ? `${n(e.shares_after)} shares held after` : ''].filter(Boolean).join('; ')
      : e.shares_after
        ? `Holds ${n(e.shares_after)} shares`
        : ''
  return facts ? `${facts[0].toUpperCase()}${facts.slice(1)}.` : ''
}
export function eventSummary(e: HtEvent): string {
  if (e.details_pending) return 'Details follow once the filing is processed.'
  const why =
    e.kind === 'form4'
      ? 'A Form 4 is filed within two business days of a trade by a company insider or 10% owner.'
      : e.kind === '13d'
        ? 'A 13D means an investor owns more than 5% and may seek to influence the company.'
        : 'A 13G means a passive investor crossed 5% of the company.'
  return `${eventNumbers(e)} ${why}`.trim()
}
const eventUrl = (site: string, e: HtEvent) => (evTicker(e) ? stockUrl(site, evTicker(e)!) : fundUrl(site, e.slug))
const filingFacts = (a: HtFiling) => `${quarter(a.quarter)} 13F · filed ${day(a.filing_date)}`
const eventFacts = (e: HtEvent) => `${formName(e)} · filed ${day(e.filing_date)}`
const subjectOf = (heads: string[]) => `${heads[0]}${heads.length > 1 ? ` + ${heads.length - 1} more` : ''}`

// ---------- email ----------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const C = { bg: '#f4f5f7', card: '#ffffff', ink: '#111827', ink2: '#374151', dim: '#5d6573', line: '#e4e7ec', acc: '#2457d0', pos: '#0b7a42', posSoft: '#e6f5ec', neg: '#c22a2a', negSoft: '#fcebeb', brand: '#ffb224' }
const FONT = `Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`
const logo = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="width:22px;height:22px;background:${C.brand};border-radius:5px;padding:5px 4px 0 4px;vertical-align:top"><div style="height:2px;width:14px;background:#0b0b0a;margin-bottom:3px"></div><div style="height:2px;width:10px;background:#0b0b0a;margin-bottom:3px"></div><div style="height:2px;width:6px;background:#0b0b0a"></div></td><td style="padding-left:9px;font:700 17px/1 ${FONT};color:${C.ink};letter-spacing:-0.2px">Holdterm</td></tr></table>`
const button = (href: string, label: string, primary = true) =>
  `<a href="${esc(href)}" style="display:inline-block;padding:10px 16px;border-radius:8px;font:600 14px/1 ${FONT};text-decoration:none;${primary ? `background:${C.acc};color:#ffffff` : `background:#ffffff;color:${C.acc};border:1px solid ${C.line}`}">${esc(label)}</a>`
const pill = (text: string, tone: 'pos' | 'neg' | 'acc') =>
  `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font:600 12px/1.5 ${FONT};background:${tone === 'pos' ? C.posSoft : tone === 'neg' ? C.negSoft : '#eaf0fd'};color:${tone === 'pos' ? C.pos : tone === 'neg' ? C.neg : C.acc}">${esc(text)}</span>`

function moveRows(site: string, title: string, rows: Move[], tone: 'pos' | 'neg') {
  if (!rows.length) return ''
  const tr = rows
    .map(
      (m) => `<tr>
<td style="padding:10px 0;border-top:1px solid ${C.line};font:600 14px/1.3 ${FONT};color:${C.ink}">${m.r.ticker ? `<a href="${esc(stockUrl(site, m.r.ticker))}" style="color:${C.ink};text-decoration:none">${esc(company(m.r))}</a>` : esc(company(m.r))}<div style="font:400 12px/1.4 ${FONT};color:${C.dim}">${esc(symbol(m.r))}${m.r.unusual ? ' · unusual size, check the filing' : ''}</div></td>
<td style="padding:10px 8px;border-top:1px solid ${C.line};white-space:nowrap">${pill(changeLabel(m), tone)}</td>
<td align="right" style="padding:10px 0;border-top:1px solid ${C.line};white-space:nowrap;font:600 14px/1.3 ${FONT};color:${tone === 'pos' ? C.pos : C.neg}">${signed(m.r.value_delta)}</td>
</tr>`,
    )
    .join('')
  return `<div style="font:600 12px/1 ${FONT};letter-spacing:0.4px;text-transform:uppercase;color:${C.dim};margin:22px 0 4px">${esc(title)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${tr}</table>`
}
const stat = (label: string, value: string, color: string) =>
  `<td style="padding:12px 14px;background:${C.bg};border-radius:8px" width="48%"><div style="font:500 12px/1.2 ${FONT};color:${C.dim}">${esc(label)}</div><div style="font:700 20px/1.3 ${FONT};color:${color};margin-top:3px">${esc(value)}</div></td>`

function filingCard(site: string, a: HtFiling) {
  const { buys, sells } = buysSells(a)
  const mv = a.moves
  const body = a.reveal?.rows.length
    ? moveRows(site, 'Positions revealed', a.reveal.rows.map((r) => ({ kind: 'new' as const, r: { ...r, value_delta: r.value } })), 'pos')
    : mv
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px"><tr>${stat('Bought', money(mv.bought_usd), C.pos)}<td width="4%" style="font-size:0">&nbsp;</td>${stat('Sold', money(mv.sold_usd), C.neg)}</tr></table>${moveRows(site, 'Biggest buys', buys, 'pos')}${moveRows(site, 'Biggest sells', sells, 'neg')}`
      : ''
  return card(filingFacts(a), filingTitle(a), filingSummary(a), body, button(fundUrl(site, a.slug), 'See the full portfolio'), a.sec_url)
}
function eventCard(site: string, e: HtEvent) {
  return card(eventFacts(e), eventTitle(e), eventSummary(e), '', button(eventUrl(site, e), evTicker(e) ? `See who owns ${evTicker(e)}` : `See ${e.manager}`), e.url)
}
function card(eyebrow: string, title: string, summary: string, body: string, cta: string, sec: string) {
  return `<tr><td style="padding:0 0 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.card};border:1px solid ${C.line};border-radius:12px"><tr><td style="padding:24px">
<div style="font:600 12px/1.4 ${FONT};color:${C.acc}">${esc(eyebrow)}</div>
<h1 style="margin:6px 0 0;font:700 21px/1.3 ${FONT};color:${C.ink};letter-spacing:-0.2px">${esc(title)}</h1>
<p style="margin:8px 0 0;font:400 15px/1.55 ${FONT};color:${C.ink2}">${esc(summary)}</p>
${body}
<div style="margin-top:22px">${cta}&nbsp; <a href="${esc(sec)}" style="display:inline-block;padding:10px 0;white-space:nowrap;font:500 14px/1 ${FONT};color:${C.acc};text-decoration:none">Read the SEC filing&nbsp;›</a></div>
</td></tr></table></td></tr>`
}
function frame(site: string, preheader: string, cards: string, note: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Holdterm</title></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
<tr><td style="padding:0 4px 18px">${logo}</td></tr>
${cards}
<tr><td style="padding:8px 4px 0;font:400 12px/1.6 ${FONT};color:${C.dim}">${note}<br><a href="${esc(site)}account" style="color:${C.dim}">Manage alerts or what you follow</a> · ${esc(DISCLAIMER)}<br>Holdterm, by Factor Dynamics.</td></tr>
</table></td></tr></table></body></html>`
}

function filingText(site: string, a: HtFiling) {
  const { buys, sells } = buysSells(a)
  const line = (m: Move) => `  ${symbol(m.r)}: ${changeLabel(m).toLowerCase()}, ${signed(m.r.value_delta)}`
  return [
    filingTitle(a),
    filingFacts(a),
    '',
    filingSummary(a),
    ...(buys.length ? ['', 'Biggest buys', ...buys.map(line)] : []),
    ...(sells.length ? ['', 'Biggest sells', ...sells.map(line)] : []),
    '',
    `Full portfolio: ${fundUrl(site, a.slug)}`,
    `SEC filing: ${a.sec_url}`,
  ].join('\n')
}
const eventText = (site: string, e: HtEvent) => [eventTitle(e), eventFacts(e), '', eventSummary(e), '', `On Holdterm: ${eventUrl(site, e)}`, `SEC filing: ${e.url}`].join('\n')

/** The alert email: one card per filing, newest first as given. */
export function htEmail(filings: HtFiling[], events: HtEvent[], site = SITE): HtMail {
  const heads = [...filings.map(filingTitle), ...events.map(eventTitle)]
  const summaries = [...filings.map(filingSummary), ...events.map(eventSummary)]
  const html = frame(site, summaries[0] ?? '', [...filings.map((a) => filingCard(site, a)), ...events.map((e) => eventCard(site, e))].join(''), 'You’re getting this because you subscribe to Holdterm alerts.')
  const text = `${[...filings.map((a) => filingText(site, a)), ...events.map((e) => eventText(site, e))].join('\n\n———\n\n')}\n\n--\nManage alerts: ${site}account\n${DISCLAIMER}`
  return { subject: subjectOf(heads), text, html }
}

/** The sign-in (and welcome) email in the same design. */
export function htLoginEmail(link: string, welcome: boolean, site = SITE): HtMail {
  const title = welcome ? 'Your Holdterm alerts are on' : 'Sign in to Holdterm'
  const summary = welcome
    ? 'You’ll hear from us when an investor you follow files a 13F, 13D, 13G or Form 4. Follow nobody and you get every investor Holdterm tracks.'
    : 'Use this button to sign in. It works once, for 15 minutes. If you didn’t ask for it, ignore this email.'
  const body = `<tr><td style="padding:0 0 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.card};border:1px solid ${C.line};border-radius:12px"><tr><td style="padding:24px">
<h1 style="margin:0;font:700 21px/1.3 ${FONT};color:${C.ink}">${esc(title)}</h1>
<p style="margin:8px 0 20px;font:400 15px/1.55 ${FONT};color:${C.ink2}">${esc(summary)}</p>${button(link, welcome ? 'Choose who to follow' : 'Sign in')}
<p style="margin:18px 0 0;font:400 12px/1.5 ${FONT};color:${C.dim};word-break:break-all">Or paste this link: ${esc(link)}</p></td></tr></table></td></tr>`
  return { subject: welcome ? 'Holdterm alerts are on' : 'Your Holdterm sign-in link', html: frame(site, summary, body, ''), text: `${title}\n\n${summary}\n\n${link}\n\n--\n${DISCLAIMER}` }
}

// ---------- chat, push and feed ----------
const short = (m: Move) => `${symbol(m.r)} ${signed(m.r.value_delta)} (${changeLabel(m).toLowerCase()})`

/** Discord webhook body: one embed per filing (Discord shows up to 10). */
export function htDiscord(filings: HtFiling[], events: HtEvent[], site = SITE) {
  const embeds = [
    ...filings.map((a) => {
      const { buys, sells } = buysSells(a, 4)
      return {
        title: filingTitle(a),
        url: fundUrl(site, a.slug),
        description: `${filingSummary(a)}\n[Read the SEC filing](${a.sec_url})`,
        color: 0x2457d0,
        fields: [buys.length && { name: 'Biggest buys', value: buys.map(short).join('\n'), inline: true }, sells.length && { name: 'Biggest sells', value: sells.map(short).join('\n'), inline: true }].filter(Boolean),
        footer: { text: `Holdterm · ${filingFacts(a)}` },
      }
    }),
    ...events.map((e) => ({ title: eventTitle(e), url: eventUrl(site, e), description: `${eventSummary(e)}\n[Read the SEC filing](${e.url})`, color: 0xffb224, footer: { text: `Holdterm · ${eventFacts(e)}` } })),
  ].slice(0, 10)
  return { username: 'Holdterm', embeds }
}

/** Slack incoming-webhook body (Block Kit), with a plain-text fallback for notifications. */
export function htSlack(filings: HtFiling[], events: HtEvent[], site = SITE) {
  const mrk = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const blocks: unknown[] = []
  for (const a of filings) {
    const { buys, sells } = buysSells(a, 4)
    blocks.push(
      { type: 'header', text: { type: 'plain_text', text: filingTitle(a).slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: mrk(filingSummary(a)) } },
      ...(buys.length || sells.length
        ? [{ type: 'section', fields: [buys.length && { type: 'mrkdwn', text: `*Biggest buys*\n${buys.map((m) => mrk(short(m))).join('\n')}` }, sells.length && { type: 'mrkdwn', text: `*Biggest sells*\n${sells.map((m) => mrk(short(m))).join('\n')}` }].filter(Boolean) }]
        : []),
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'See the full portfolio' }, url: fundUrl(site, a.slug), style: 'primary' }, { type: 'button', text: { type: 'plain_text', text: 'SEC filing' }, url: a.sec_url }] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Holdterm · ${filingFacts(a)}` }] },
      { type: 'divider' },
    )
  }
  for (const e of events)
    blocks.push(
      { type: 'section', text: { type: 'mrkdwn', text: `*<${eventUrl(site, e)}|${mrk(eventTitle(e))}>*\n${mrk(eventSummary(e))}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Holdterm · ${eventFacts(e)} · <${e.url}|SEC filing>` }] },
      { type: 'divider' },
    )
  if (blocks.length) blocks.pop()
  return { text: subjectOf([...filings.map(filingTitle), ...events.map(eventTitle)]), blocks: blocks.slice(0, 50) }
}

/** Telegram sendMessage text for parse_mode HTML (4,096 characters at most). */
export function htTelegram(filings: HtFiling[], events: HtEvent[], site = SITE): string {
  const parts = [
    ...filings.map((a) => {
      const { buys, sells } = buysSells(a, 3)
      return [
        `<b>${esc(filingTitle(a))}</b>`,
        esc(filingSummary(a)),
        ...(buys.length ? ['', '<b>Biggest buys</b>', ...buys.map((m) => `🟢 ${esc(short(m))}`)] : []),
        ...(sells.length ? ['', '<b>Biggest sells</b>', ...sells.map((m) => `🔴 ${esc(short(m))}`)] : []),
        '',
        `<a href="${esc(fundUrl(site, a.slug))}">Full portfolio</a> · <a href="${esc(a.sec_url)}">SEC filing</a>`,
      ].join('\n')
    }),
    ...events.map((e) => [`<b>${esc(eventTitle(e))}</b>`, esc(eventSummary(e)), '', `<a href="${esc(eventUrl(site, e))}">On Holdterm</a> · <a href="${esc(e.url)}">SEC filing</a>`].join('\n')),
  ]
  return parts.join('\n\n').slice(0, 4000)
}

/** Browser push: one notification per filing (the tag replaces an earlier one for the same filing). */
export function htPush(filings: HtFiling[], events: HtEvent[], site = SITE): HtPush[] {
  return [
    ...filings.map((a) => {
      const mv = a.moves
      const { buys, sells } = buysSells(a, 1)
      const top = [buys[0] && `Top buy ${short(buys[0])}`, sells[0] && `top sell ${short(sells[0])}`].filter(Boolean).join('; ')
      return { title: filingTitle(a), body: mv ? `Bought ${money(mv.bought_usd)}, sold ${money(mv.sold_usd)}.${top ? ` ${top}.` : ''}` : filingSummary(a), url: fundUrl(site, a.slug), tag: a.accession }
    }),
    ...events.map((e) => ({ title: eventTitle(e), body: `${eventNumbers(e) || eventSummary(e)} ${eventFacts(e)}.`, url: eventUrl(site, e), tag: e.id })),
  ]
}

/** Private RSS/JSON feed items. */
export function htFeed(filings: HtFiling[], events: HtEvent[], site = SITE): HtFeedItem[] {
  return [
    ...filings.map((a) => ({ id: `${a.accession}${a.followup ? ':moves' : ''}`, title: filingTitle(a), text: filingText(site, a), url: fundUrl(site, a.slug) })),
    ...events.map((e) => ({ id: e.id, title: eventTitle(e), text: eventText(site, e), url: eventUrl(site, e) })),
  ]
}
