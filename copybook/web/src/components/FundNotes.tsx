import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMember } from '../lib/account'
import { live, pricingTo, dateLabel, displayName, shareClass as shareClassOf, money, pct, quarterLabel, sharesFmt, useAsync, type ManagerFile } from '../lib/data'
import { stockPath } from '../lib/stocks'
import { Badge, Lock, Panel } from './ui'

export type FundStatus = 'current' | 'stale' | 'inactive' | 'empty_latest' | 'unreadable_latest' | 'notice_pending' | 'reported_by_other'
type WithStatus = ManagerFile & { status?: FundStatus; status_note?: string | null; reported_by?: { slug?: string; name?: string; cik?: string } | null }

const qn = (q?: string) => (q ? Number(q.slice(0, 4)) * 4 + Number(q.slice(5)) - 1 : 0)
/** The quarter whose 13F is due now: filings are due 45 days after quarter end. */
function expectedQuarter(now = new Date()) {
  const d = new Date(now.getTime() - 45 * 86_400_000)
  return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3) - 1
}

/** Why this fund's page might not show the newest quarter. Uses ingest's status when present, else quarter age. */
export function fundStatus(f: WithStatus): { status: FundStatus; behind: number } {
  const behind = Math.max(0, expectedQuarter() - qn(f.quarter))
  if (f.status) return { status: f.status, behind }
  return { status: behind >= 4 ? 'inactive' : behind >= 1 ? 'stale' : 'current', behind }
}

export function FundNotice({ f }: { f: WithStatus }) {
  const { status, behind } = fundStatus(f)
  if (status === 'current') return null
  const by = f.reported_by ? { ...f.reported_by, name: f.reported_by.name ? displayName(f.reported_by.name) : undefined } : null
  const text: Record<Exclude<FundStatus, 'current'>, { title: string; body: string; tone: 'warn' | 'info' }> = {
    stale: {
      title: `Latest 13F on file is ${quarterLabel(f.quarter)}`,
      body: `No newer 13F has been filed yet${behind > 1 ? ` (${behind} quarters behind)` : ''}. This page updates as soon as one appears on EDGAR.`,
      tone: 'warn',
    },
    inactive: {
      title: `No 13F since ${quarterLabel(f.quarter)}`,
      body: 'This fund has stopped filing 13Fs or fell below the $100M reporting threshold. These are its last reported holdings, and it’s left out of the consensus book.',
      tone: 'warn',
    },
    notice_pending: {
      title: 'Filed a 13F notice instead of holdings',
      body: 'The fund filed Form 13F-NT, which means another entity reports its holdings. We show the last holdings it reported itself until the other filing is matched.',
      tone: 'info',
    },
    reported_by_other: {
      title: `Holdings reported by ${by?.name ?? 'an affiliated filer'}`,
      body: `This manager’s 13F is now filed by ${by?.name ?? 'an affiliated entity'}${by?.cik ? ` (CIK ${by.cik.replace(/^0+/, '')})` : ''}. The holdings below come from that filing.`,
      tone: 'info',
    },
    empty_latest: {
      title: 'The newest 13F lists no holdings',
      body: 'The fund filed a 13F with an empty table, which usually means it’s winding down or holds nothing reportable. Holdings below are from its last full filing.',
      tone: 'info',
    },
    unreadable_latest: {
      title: 'The newest filing couldn’t be read',
      body: 'Its holdings table doesn’t follow the SEC format. Holdings below are from the last filing we could read, and we retry on every refresh.',
      tone: 'warn',
    },
  }
  const t = text[status]
  return (
    <div role="note" className={`mt-6 flex gap-3 rounded-xl px-4 py-3 text-[14px] ${t.tone === 'warn' ? 'bg-[#f6ead2] text-[#5c3f0b]' : 'bg-accent-soft text-accent-2'}`}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="mt-0.5 shrink-0">
        <circle cx="10" cy="10" r="7.5" />
        <path d="M10 6.5v4.5M10 13.5v.01" strokeLinecap="round" />
      </svg>
      <div>
        <p className="font-medium">{t.title}</p>
        <p className="mt-0.5 leading-relaxed opacity-90">
          {f.status_note || t.body}
          {status === 'reported_by_other' && by?.slug && (
            <>
              {' '}
              <Link to={`/investors/${by.slug}/`} className="font-medium underline underline-offset-2">
                See {by.name ?? 'that filer'}
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  )
}

// data/events/{slug}.json from ingest: Form 4 and Schedule 13D/G filings since the latest 13F.
/** SEC Form 4 transaction codes (Form 4 General Instructions, item 8), in plain English. */
export const FORM4_CODE: Record<string, string> = {
  P: 'open-market purchase',
  S: 'open-market sale',
  A: 'grant or award',
  D: 'disposed to the issuer',
  F: 'shares withheld for tax or exercise price',
  G: 'gift',
  I: 'discretionary transaction',
  J: 'other acquisition or disposition; the filing’s footnotes explain it',
  K: 'equity swap',
  L: 'small acquisition',
  M: 'option exercise or conversion',
  C: 'conversion of a derivative',
  E: 'expiration of a short derivative',
  H: 'expiration of a long derivative',
  O: 'exercise of an out-of-the-money derivative',
  X: 'exercise of an in-the-money derivative',
  U: 'disposed in a tender offer',
  W: 'acquired or disposed by will or inheritance',
  Z: 'deposit into or withdrawal from a voting trust',
}

export type BookLine = { cusip: string; ticker?: string | null; title?: string; shares: number }

/** "Class A Common Stock" -> "Class A"; "" when the security names no class. */
const classOf = (security?: string) => {
  const m = /\bclass\s+([A-Z])\b/i.exec(security || '')
  return m ? `Class ${m[1].toUpperCase()}` : ''
}
/** The 13F line for this event's own CUSIP: comparisons never mix share classes. */
const ownLine = (e: Ev) => (e.cusip ? e.class_book?.find((b) => b.cusip === e.cusip) : undefined)

export type Ev = {
  id: string
  form: string
  kind: 'form4' | '13d' | '13g'
  action: 'buy' | 'sell' | 'mixed' | 'other' | 'new_stake' | 'stake_update' | 'below_threshold'
  filing_date: string
  event_date?: string | null
  url: string
  ticker?: string | null
  display_name?: string | null
  issuer: string
  shares?: number | null
  value_usd?: number | null
  avg_price?: number | null
  shares_after?: number | null
  percent_of_class?: number | null
  change_vs_13f?: number | null
  shares_in_13f?: number | null
  issuer_cik?: string | null
  /** The fund's 13F share lines for this issuer, one per CUSIP/class (set by the page or the build). */
  class_book?: BookLine[]
  cusip?: string | null
  amendment_no?: number | null
  // The previous Schedule 13D/G on this issuer (from ingest, or the next older row in this feed).
  prev_percent_of_class?: number | null
  prev_shares_after?: number | null
  prev_amendment_no?: number | null
  prev_filing_date?: string | null
  /** Item 4, Purpose of Transaction: a short excerpt. */
  item4?: string | null
  footnotes?: { id: string; text: string }[] | null
  transactions?: { date?: string; security?: string; shares_after?: number | null; code: string; code_label?: string; shares?: number | null; price?: number | null; acquired?: boolean; derivative?: boolean; footnote_ids?: string[] }[]
}
const ACTION: Record<Ev['action'], { label: string; tone: 'up' | 'down' | 'neutral' | 'accent' }> = {
  buy: { label: 'Bought', tone: 'up' },
  sell: { label: 'Sold', tone: 'down' },
  mixed: { label: 'Bought and sold', tone: 'neutral' },
  other: { label: 'Other', tone: 'neutral' },
  new_stake: { label: 'New 5%+ stake', tone: 'accent' },
  stake_update: { label: 'Stake update', tone: 'neutral' },
  below_threshold: { label: 'Below 5%', tone: 'down' },
}
const FREE_EVENTS = 2
// percent_of_class is a percentage (64.1 = 64.1%).
const pctOf = (x?: number | null) => (x == null ? null : x / 100)
const signed = (n: number) => `${n > 0 ? '+' : '−'}${sharesFmt(Math.abs(n))}`

/** Fill prev_* for 13D/G rows from the next older filing on the same issuer in this feed. */
function withPrevious(events: Ev[]): Ev[] {
  return events.map((e, i) => {
    if (e.kind === 'form4' || e.prev_percent_of_class != null || e.prev_shares_after != null) return e
    const key = e.issuer_cik || e.cusip || e.issuer
    const p = events.slice(i + 1).find((x) => x.kind !== 'form4' && (x.issuer_cik || x.cusip || x.issuer) === key)
    return p ? { ...e, prev_percent_of_class: p.percent_of_class, prev_shares_after: p.shares_after, prev_amendment_no: p.amendment_no, prev_filing_date: p.filing_date } : e
  })
}

/** A 13D/G stake: against the previous amendment when we have it, else the latest 13F line. */
function stakeLine(e: Ev) {
  const now = pctOf(e.percent_of_class)
  const was = pctOf(e.prev_percent_of_class)
  const parts: string[] = []
  if (now != null) parts.push(was != null && Math.abs(now - was) >= 0.0005 ? `${pct(was)} → ${pct(now)} of the class` : `${pct(now)} of the class${was != null ? ', unchanged' : ''}`)
  if (e.shares_after != null) {
    if (e.prev_shares_after != null) {
      const d = e.shares_after - e.prev_shares_after
      parts.push(d ? `${signed(d)} shares to ${sharesFmt(e.shares_after)}` : `${sharesFmt(e.shares_after)} shares, unchanged`)
    } else if (e.class_book && e.cusip) {
      const d = e.shares_after - (ownLine(e)?.shares ?? 0)
      parts.push(d ? `${sharesFmt(e.shares_after)} shares, ${signed(d)} vs the 13F` : `${sharesFmt(e.shares_after)} shares, as in the 13F`)
    } else parts.push(`${sharesFmt(e.shares_after)} shares reported`)
  }
  if (e.prev_shares_after != null && e.shares_after === e.prev_shares_after && now != null && was != null && Math.abs(now - was) >= 0.0005)
    parts.push('the class size changed, not the stake')
  if (e.prev_amendment_no != null || e.prev_filing_date) parts.push(`vs ${e.prev_amendment_no != null ? `No. ${e.prev_amendment_no}` : 'the previous filing'}${e.prev_filing_date ? ` of ${dateLabel(e.prev_filing_date)}` : ''}`)
  return parts.join(' · ')
}

/** Form 4 without open-market trades (gifts, conversions, awards): name what happened. */
function heldAfter(e: Ev) {
  const last = new Map<string, number>()
  for (const t of e.transactions ?? []) if (!t.derivative && t.shares_after != null) last.set(classOf(t.security), t.shares_after)
  if (last.size > 1) return `${[...last].map(([c, n]) => `${sharesFmt(n)} ${c || 'common'}`).join(' and ')} held after`
  return e.shares_after != null ? `${sharesFmt(e.shares_after)} held after` : null
}

function form4Line(e: Ev) {
  if (e.shares) return [`${sharesFmt(Math.abs(e.shares))} shares`, e.avg_price ? `avg $${e.avg_price.toFixed(2)}` : null, heldAfter(e)].filter(Boolean).join(' · ')
  const tx = (e.transactions ?? []).filter((t) => t.shares)
  const what = tx.map((t) => {
    const how = FORM4_CODE[t.code] ? `, ${FORM4_CODE[t.code]}` : t.code_label && t.code_label !== 'other' ? `, ${t.code_label}` : ''
    return `${t.acquired ? 'Acquired' : 'Disposed of'} ${sharesFmt(t.shares)}${t.derivative ? ' derivative' : ''} (code ${t.code}${how})`
  })
  const after = heldAfter(e)
  return [...new Set(what)].slice(0, 2).concat(after ? [after] : []).join(' · ')
}

/** Between-quarter moves: Form 4 trades and 13D/G stake filings since the latest 13F. Hidden until ingest publishes the feed. */
export type Position = {
  key: string
  /** The class's CUSIP when matched to a 13F line, and its class label from the filing. */
  cusip?: string
  label: string
  ticker?: string | null
  name: string
  /** Shares in the latest 13F, and the newest reported holding after it. */
  from?: number | null
  to?: number | null
  asOf?: string
  source?: string
  /** Open-market trades reported on Form 4 (codes P and S). */
  /** Non-market Form 4 rows (codes A, G, J, M, F…): shares only, never counted as bought or sold. */
  acquiredOther: number
  disposedOther: number
  otherCodes: string[]
  boughtShares: number
  boughtUsd: number
  soldShares: number
  soldUsd: number
  first?: string
  last?: string
  filings: number
  stake?: Ev
  prevStake?: Ev
}

/** One line per issuer: the 13F position, the newest holding filed since, and the Form 4 trades in between. */
/**
 * One line per position and share class: the 13F line with the same CUSIP, the newest holding filed
 * since, and the Form 4 trades in between. Form 4 rows are split by the class they name, so a filing
 * that buys Class A and Class B gives two lines; 13D/G stakes belong to the event's own CUSIP.
 */
export function rollUp(events: Ev[]): Position[] {
  const by = new Map<string, Position>()
  const line = (e: Ev, label: string) => {
    const book = e.class_book
    const h = label ? book?.find((b) => shareClassOf(b.title) === label) ?? (book && book.length === 1 && !shareClassOf(book[0].title) ? book[0] : undefined) : ownLine(e) ?? (book?.length === 1 ? book[0] : undefined)
    const key = h ? h.cusip : `${e.cusip?.slice(0, 6) || e.ticker || e.issuer}|${label}`
    let p = by.get(key)
    if (!p) {
      p = {
        key,
        cusip: h?.cusip,
        label: label || shareClassOf(h?.title),
        ticker: h?.ticker ?? (label ? null : e.ticker),
        name: e.display_name || e.issuer,
        // Known 13F book: a class it didn't hold started at 0. Unknown book: no baseline.
        from: book ? (h?.shares ?? 0) : undefined,
        acquiredOther: 0,
        disposedOther: 0,
        otherCodes: [],
        boughtShares: 0,
        boughtUsd: 0,
        soldShares: 0,
        soldUsd: 0,
        filings: 0,
      }
      by.set(key, p)
    }
    return p
  }
  for (const e of [...events].reverse()) {
    const touched = new Set<Position>()
    const rows = (e.transactions ?? []).filter((t) => !t.derivative && t.shares)
    for (const t of rows) {
      const p = line(e, classOf(t.security))
      touched.add(p)
      if (t.shares_after != null) {
        p.to = t.shares_after
        p.asOf = t.date || e.event_date || e.filing_date
        p.source = 'Form 4'
      }
      if (t.code !== 'P' && t.code !== 'S') {
        if (t.acquired) p.acquiredOther += t.shares!
        else p.disposedOther += t.shares!
        if (!p.otherCodes.includes(t.code)) p.otherCodes.push(t.code)
      }
      if (t.price && (t.code === 'P' || t.code === 'S')) {
        if (t.code === 'P') {
          p.boughtShares += t.shares!
          p.boughtUsd += t.shares! * t.price
        } else {
          p.soldShares += t.shares!
          p.soldUsd += t.shares! * t.price
        }
        if (t.date) {
          if (!p.first || t.date < p.first) p.first = t.date
          if (!p.last || t.date > p.last) p.last = t.date
        }
      }
    }
    if (!rows.length || e.kind !== 'form4') {
      const p = line(e, '')
      touched.add(p)
      // A 13D/G counts the whole filing group, so it only stands in when there's no Form 4.
      if (e.shares_after != null && (e.kind === 'form4' || p.source !== 'Form 4')) {
        p.to = e.shares_after
        p.asOf = e.event_date || e.filing_date
        p.source = e.kind === 'form4' ? 'Form 4' : `Schedule ${e.form.replace('SCHEDULE ', '')}`
      }
      if (e.kind !== 'form4') {
        if (p.stake) p.prevStake = p.stake
        p.stake = e
      }
    }
    for (const p of touched) {
      p.filings++
      p.ticker ||= p.label ? null : e.ticker
    }
  }
  const list = [...by.values()]
  // Name the class wherever an issuer shows up in more than one class.
  const issuer = (p: Position) => p.key.slice(0, 6)
  const multi = new Set(list.filter((p, _, all) => all.some((q) => q !== p && issuer(q) === issuer(p))).map(issuer))
  for (const p of list) if (p.label && multi.has(issuer(p)) && !p.name.includes(p.label)) p.name = `${p.name} ${p.label}`
  const size = (p: Position) => Math.max(p.boughtUsd, p.soldUsd) || Math.abs((p.to ?? 0) - (p.from ?? 0))
  return list.sort((a, b) => size(b) - size(a))
}

/** The fund's 13F share lines for each event's issuer, by the first 6 CUSIP digits. */
export function withBook(events: Ev[], holdings: { cusip: string; ticker?: string | null; title?: string; shares: number; put_call?: string | null }[]): Ev[] {
  return events.map((e) =>
    e.class_book || !e.cusip
      ? e
      : { ...e, class_book: holdings.filter((h) => !h.put_call && h.cusip.slice(0, 6) === e.cusip!.slice(0, 6)).map(({ cusip, ticker, title, shares }) => ({ cusip, ticker, title, shares })) },
  )
}

const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const span = (a?: string, b?: string) => (!a ? '' : a === b || !b ? ` on ${shortDate(a)}` : ` ${shortDate(a)}–${shortDate(b)}`)

function stakePct(p: Position) {
  const e = p.stake!
  const now = e.percent_of_class! / 100
  const wasRaw = e.prev_percent_of_class ?? p.prevStake?.percent_of_class
  const was = wasRaw != null ? wasRaw / 100 : null
  const no = e.prev_amendment_no ?? p.prevStake?.amendment_no
  const form = `${e.form.replace('SCHEDULE ', 'Schedule ')}${e.amendment_no ? ` No. ${e.amendment_no}` : ''}`
  return was != null && Math.abs(now - was) >= 0.0005
    ? `${pct(was)} → ${pct(now)} of the class per ${form}${no != null ? ` (vs No. ${no})` : ''}`
    : `${pct(now)} of the class per ${form}`
}

/** who: show the fund instead of the stock (stock pages). */
export function PositionLine({ p, who }: { p: Position; who?: { slug: string; manager: string } }) {
  const net = p.boughtUsd - p.soldUsd
  const tone = net > 0 ? 'up' : net < 0 ? 'down' : p.to != null && p.from != null && p.to !== p.from ? (p.to > p.from ? 'up' : 'down') : 'neutral'
  const other = p.acquiredOther || p.disposedOther
  const label =
    p.boughtUsd && p.soldUsd ? 'Bought and sold' : p.boughtUsd ? 'Bought' : p.soldUsd ? 'Sold' : other ? (p.acquiredOther >= p.disposedOther ? 'Acquired' : 'Disposed') : p.stake ? (ACTION[p.stake.action] ?? ACTION.other).label : 'Filed'
  const codes = p.otherCodes.map((c) => `code ${c}: ${FORM4_CODE[c] ?? 'other'}`).join('; ')
  const otherLine = other
    ? [p.acquiredOther ? `${sharesFmt(p.acquiredOther)} acquired` : null, p.disposedOther ? `${sharesFmt(p.disposedOther)} disposed` : null].filter(Boolean).join(' and ') + ` outside the market (${codes}), not counted as bought or sold`
    : ''
  // Form 4s only start once a filer is an insider (10%+), so part of the change since the 13F can predate them.
  const change = p.from != null && p.to != null ? p.to - p.from : 0
  const covered = p.boughtShares - p.soldShares + p.acquiredOther - p.disposedOther
  const gap = change - covered
  const partial = p.source === 'Form 4' && (p.boughtUsd || p.soldUsd) && Math.abs(change) > 0 && Math.abs(gap) / Math.abs(change) > 0.02 && Math.sign(gap) === Math.sign(change)
  const delta = p.from != null && p.to != null && p.from > 0 ? p.to / p.from - 1 : null
  const trades = partial
    ? [
        `Form 4s cover ${sharesFmt(Math.abs(covered))} of the ${change > 0 ? '+' : '−'}${sharesFmt(Math.abs(change))} shares: ${money(change > 0 ? p.boughtUsd : p.soldUsd)}${span(p.first, p.last)}, average $${(change > 0 ? p.boughtUsd / p.boughtShares : p.soldUsd / p.soldShares).toFixed(2)}; the other ${sharesFmt(Math.abs(gap))} were ${change > 0 ? 'bought' : 'sold'} before the first Form 4 and aren’t priced`,
      ]
    : [
        p.boughtUsd ? `about ${money(p.boughtUsd)} bought${span(p.first, p.last)}, average about $${(p.boughtUsd / p.boughtShares).toFixed(2)} on Form 4` : null,
        p.soldUsd ? `about ${money(p.soldUsd)} sold${p.boughtUsd ? '' : span(p.first, p.last)}, average about $${(p.soldUsd / p.soldShares).toFixed(2)} on Form 4` : null,
      ].filter(Boolean)
  const detail = [...trades, otherLine].filter(Boolean).join(' · ')
  return (
    // A phone gets the figure beside the name and the change on one full-width line; the Form 4 detail
    // (prices, coverage, codes) folds behind a tap instead of wrapping into a tall block.
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3 text-[14px]">
      <span className="flex min-w-0 items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        {who ? (
          <Link to={`/investors/${who.slug}/`} className="truncate font-medium hover:text-accent">
            {who.manager}
          </Link>
        ) : (
          <>
            {p.ticker && (
              <Link to={stockPath(p.ticker)} className="shrink-0 font-mono text-[13px] font-medium hover:text-accent">
                {p.ticker}
              </Link>
            )}
            <span className="min-w-0 truncate text-ink-2">{p.name}</span>
          </>
        )}
      </span>
      {/* The dollar figure is what Form 4s priced; when they cover only part of the change it's a floor, not the total. */}
      {net ? (
        <span className={`num text-right text-[14px] font-medium sm:row-span-2 ${net > 0 ? 'text-up' : 'text-down'}`}>
          {partial ? `≥ ${money(Math.abs(net))}` : `${net > 0 ? '+' : '−'}${money(Math.abs(net))}`}
          <span className="block text-[11.5px] font-normal text-ink-3">{partial ? `${net > 0 ? 'bought' : 'sold'} on Form 4s` : 'on Form 4s'}</span>
        </span>
      ) : (
        <span className="sm:row-span-2" />
      )}
      <span className="col-span-2 block text-[12.5px] leading-relaxed text-ink-3 sm:col-span-1">
        {p.to != null ? (
          <>
            <span className="num text-ink-2">
              {p.from ? (p.from !== p.to ? `${sharesFmt(p.from)} → ` : '') : ''}
              {sharesFmt(p.to)} shares
            </span>
            {delta != null && Math.abs(delta) >= 0.001 && <span className={`num ${delta > 0 ? 'text-up' : 'text-down'}`}> ({delta > 0 ? '+' : '−'}{pct(Math.abs(delta), 0)})</span>}
            {p.asOf && ` as of ${dateLabel(p.asOf)}`}
            <span className="hidden sm:inline">{p.asOf && `, per ${p.source}`}</span>
            {p.from === p.to && ', unchanged since the 13F'}
            {p.from === 0 && ', a new position since the 13F'}
          </>
        ) : null}
        {p.stake && p.stake.percent_of_class != null && ` · ${stakePct(p)}`}
        {detail && <span className="hidden sm:inline">{` · ${detail}`}</span>}
        {detail && (
          <details className="group mt-1 sm:hidden">
            <summary className="cursor-pointer list-none text-[12px] font-medium text-accent [&::-webkit-details-marker]:hidden">
              <span className="group-open:hidden">Form 4 detail</span>
              <span className="hidden group-open:inline">Hide detail</span>
            </summary>
            <span className="mt-1 block">
              {p.asOf && `Per ${p.source}. `}
              {detail}
            </span>
          </details>
        )}
      </span>
    </li>
  )
}

function EventRow({ e }: { e: Ev }) {
  const a = ACTION[e.action] ?? ACTION.other
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 text-[14px] md:grid-cols-[6.5rem_minmax(0,1fr)_auto]">
      <span className="hidden text-[13px] text-ink-3 md:block">{dateLabel(e.filing_date)}</span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={a.tone}>{a.label}</Badge>
          {e.ticker ? (
            <Link to={stockPath(e.ticker)} className="font-mono text-[13px] font-medium hover:text-accent">
              {e.ticker}
            </Link>
          ) : null}
          <span className="truncate text-ink-2">{e.display_name || e.issuer}</span>
        </span>
        <span className="mt-0.5 block text-[12.5px] text-ink-3">
          <span className="md:hidden">{dateLabel(e.filing_date)} · </span>
          {e.kind === 'form4' ? form4Line(e) : stakeLine(e)}
          {' · '}
          <a href={e.url} className="underline underline-offset-2 hover:text-ink">
            {e.kind === 'form4' ? 'Form 4' : `Schedule ${e.form.replace('SCHEDULE ', '')}${e.amendment_no ? ` No. ${e.amendment_no}` : ''}`}
          </a>
        </span>
        {e.item4 && (
          <span className="mt-1.5 block border-l-2 border-line-2 pl-2.5 text-[12.5px] italic leading-relaxed text-ink-2">
            <span className="not-italic text-ink-3">Item 4: </span>
            {e.item4.length > 400 ? `${e.item4.slice(0, 397).trimEnd()}…` : e.item4}
          </span>
        )}
        {e.footnotes && e.footnotes.length > 0 && (e.kind === 'form4' || !e.item4) && (
          <span className="mt-1.5 block space-y-0.5 text-[12px] leading-relaxed text-ink-3">
            {e.footnotes.slice(0, e.shares ? 2 : 4).map((n) => (
              <span key={n.id} className="block">
                <sup className="mr-0.5">{n.id.replace(/^F/, '')}</sup>
                {n.text.length > 280 ? `${n.text.slice(0, 277).trimEnd()}…` : n.text}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="num text-right text-[14px] font-medium">{e.value_usd ? money(e.value_usd) : ''}</span>
    </li>
  )
}

export const loadEvents = (slug: string) => fetch(live(`events/${slug}.json`)).then((x) => (x.ok ? (x.json() as Promise<{ events?: Ev[]; latest_13f_quarter?: string | null }>) : null))

/** Between-quarter moves: Form 4 trades and 13D/G stake filings since the latest 13F, rolled up per position. */
export function SinceLast13F({ slug, quarter, filedOn, holdings }: { slug: string; quarter?: string; filedOn?: string; holdings: ManagerFile['holdings'] }) {
  const r = useAsync(() => loadEvents(slug), [slug])
  const member = useMember()
  const [all, setAll] = useState(false)
  // On filing day the fund's new 13F can land before its events file is rebuilt against it: until then keep only
  // filings made on or after the new 13F, so an older 13G never reads as news "after" it.
  const stale = Boolean(r.data?.latest_13f_quarter && quarter && r.data.latest_13f_quarter !== quarter)
  const events = useMemo(
    () => withBook(withPrevious((r.data?.events ?? []).filter((e) => !('skip' in e) && !(stale && filedOn && e.filing_date < filedOn))), holdings),
    [r.data, holdings, stale, filedOn],
  )
  const positions = useMemo(() => rollUp(events), [events])
  if (!events.length) return null
  const paid = Boolean(member?.active)
  const shown = paid ? positions : positions.slice(0, FREE_EVENTS)
  return (
    <Panel
      title="Since the last 13F"
      sub={`What changed after the ${quarterLabel(quarter)} 13F, from ${events.length} Form 4 and 13D/G ${events.length === 1 ? 'filing' : 'filings'} with the SEC`}
      className="mt-6"
      right={
        paid && events.length > 0 ? (
          <button onClick={() => setAll((x) => !x)} className="text-[13px] font-medium text-accent hover:text-accent-2" aria-expanded={all}>
            {all ? 'By position' : `All ${events.length} filings`}
          </button>
        ) : undefined
      }
    >
      {all && paid ? (
        <ul className="divide-y divide-line">
          {events.slice(0, 100).map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
        </ul>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((p) => (
            <PositionLine key={p.key} p={p} />
          ))}
        </ul>
      )}
      {!paid && positions.length > FREE_EVENTS && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-accent-soft px-4 py-3">
          <p className="flex items-center gap-2 text-[13.5px] text-accent-2">
            <Lock /> {positions.length - FREE_EVENTS} more {positions.length - FREE_EVENTS === 1 ? 'position' : 'positions'} changed since the 13F, with Copy
          </p>
          <Link to={pricingTo()} className="inline-flex h-8 items-center rounded-full bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent-2">
            Start 14-day free trial
          </Link>
        </div>
      )}
    </Panel>
  )
}
