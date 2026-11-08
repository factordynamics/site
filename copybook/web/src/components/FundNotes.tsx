import { Link } from 'react-router-dom'
import { useMember } from '../lib/account'
import { DATA, dateLabel, money, pct, quarterLabel, sharesFmt, useAsync, type ManagerFile } from '../lib/data'
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
  const by = f.reported_by
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
      title: `The ${quarterLabel(f.quarter)} filing lists no holdings`,
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
type Ev = {
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

/** Between-quarter moves: Form 4 trades and 13D/G stake filings since the latest 13F. Hidden until ingest publishes the feed. */
export function SinceLast13F({ slug, quarter }: { slug: string; quarter?: string }) {
  const r = useAsync(() => fetch(`${DATA}events/${slug}.json`).then((x) => (x.ok ? (x.json() as Promise<{ events?: Ev[] }>) : null)), [slug])
  const member = useMember()
  const events = (r.data?.events ?? []).filter((e) => !('skip' in e))
  if (!events.length) return null
  const paid = Boolean(member?.active)
  const shown = paid ? events.slice(0, 20) : events.slice(0, FREE_EVENTS)
  return (
    <Panel title="Since the last 13F" sub={`Form 4 trades and 13D/G stake filings after the ${quarterLabel(quarter)} 13F, as filed with the SEC`} className="mt-6">
      <ul className="divide-y divide-line">
        {shown.map((e) => {
          const a = ACTION[e.action] ?? ACTION.other
          const pctClass = e.percent_of_class != null ? (e.percent_of_class > 1 ? e.percent_of_class / 100 : e.percent_of_class) : null
          return (
            <li key={e.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 text-[14px] md:grid-cols-[6.5rem_minmax(0,1fr)_auto]">
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
                  {e.kind === 'form4'
                    ? [e.shares ? `${sharesFmt(Math.abs(e.shares))} shares` : null, e.avg_price ? `avg $${e.avg_price.toFixed(2)}` : null, e.shares_after != null ? `${sharesFmt(e.shares_after)} held after` : null].filter(Boolean).join(' · ')
                    : [pctClass != null ? `${pct(pctClass)} of the class` : null, e.shares_after != null ? `${sharesFmt(e.shares_after)} shares reported` : null].filter(Boolean).join(' · ')}
                  {' · '}
                  <a href={e.url} className="underline underline-offset-2 hover:text-ink">
                    Form {e.form.replace('SCHEDULE ', '')}
                  </a>
                </span>
              </span>
              <span className="num text-right text-[14px] font-medium">{e.value_usd ? money(e.value_usd) : ''}</span>
            </li>
          )
        })}
      </ul>
      {!paid && events.length > FREE_EVENTS && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-accent-soft px-4 py-3">
          <p className="flex items-center gap-2 text-[13.5px] text-accent-2">
            <Lock /> {events.length - FREE_EVENTS} more moves since the 13F, with Copy
          </p>
          <Link to="/pricing/" className="inline-flex h-8 items-center rounded-full bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent-2">
            Start 14-day free trial
          </Link>
        </div>
      )}
    </Panel>
  )
}
