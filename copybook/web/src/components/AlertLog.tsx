import { Link } from 'react-router-dom'
import { call, gapLabel } from '../lib/account'
import { useAsync } from '../lib/data'
import { timeLabel } from './Paused'
import { Badge } from './ui'

// GET /me/alerts (payments, Nov 16): the member's last 50 alerts, newest first, with what each channel did.
type EmailState = { state: string; until?: string | null }
type AlertRow = {
  id: string
  kind: '13f' | 'form4' | '13d' | '13g'
  form: string
  manager: string
  slug?: string | null
  accession: string
  accepted: string | null
  followup?: boolean
  sent_at: string
  channels: { email?: EmailState; feed?: 'delivered'; discord?: 'delivered' | 'retrying'; slack?: 'delivered' | 'retrying'; telegram?: 'delivered' | 'retrying'; webhook?: 'delivered' | 'retrying' }
}

/** What happened to the alert's email, in words; `warn` when the member may be waiting on it. */
function emailLine(e: EmailState): { text: string; warn?: boolean } {
  switch (e.state) {
    case 'sent':
      return { text: 'Email sent' }
    case 'queued':
    case 'sending':
    case 'pending':
      return { text: 'Email queued, not yet sent', warn: true }
    case 'test_inbox':
      return { text: 'Email to the test inbox' }
    case 'batched':
      return { text: e.until ? `Email batched, goes by ${timeLabel(e.until)}` : 'Email batched', warn: true }
    case 'delayed_to_reset':
      return { text: 'Email delayed by our daily email limit; goes at 7pm ET', warn: true }
    case 'skipped_daily_limit':
      return { text: 'Not emailed: past our daily email limit', warn: true }
    case 'replaced_by_chat':
      return { text: 'Not emailed: went to your chat or webhook instead' }
    case 'weekly_digest':
      return { text: 'In your weekly email' }
    case 'already_emailed':
      return { text: 'Already emailed' }
    case 'not_emailed':
      return { text: 'Not emailed' }
    case 'test_daily_cap':
      return { text: 'Not emailed: test daily cap' }
    default:
      return { text: `Email: ${e.state.replace(/_/g, ' ')}` }
  }
}

const CHATS = [
  ['discord', 'Discord'],
  ['slack', 'Slack'],
  ['telegram', 'Telegram'],
  ['webhook', 'Webhook'],
] as const

/** /account/#alerts: each recent alert and where it went. Renders nothing until the API serves /me/alerts. */
export function AlertLog() {
  const r = useAsync(() => call<{ ok: boolean; limit?: number; alerts: AlertRow[] }>('/me/alerts', { auth: true, cache: 'no-store' }), [])
  const rows = r.data?.alerts
  if (!rows) return null
  return (
    <section className="mt-5 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]" aria-labelledby="alert-log-title">
      <h2 id="alert-log-title" className="text-[15px] font-semibold">
        Your alerts
      </h2>
      <p className="mt-1 text-[14px] text-ink-2">Your last {r.data?.limit ?? 50} alerts, newest first, and what each channel did with them. Listed from Nov 16, 2026.</p>
      {rows.length === 0 ? (
        <p className="mt-4 text-[14px] text-ink-3">No alerts yet. Each one appears here once it goes out.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {rows.map((a) => {
            const email = a.channels.email ? emailLine(a.channels.email) : null
            const gap = a.accepted ? (Date.parse(a.sent_at) - Date.parse(a.accepted)) / 1000 : null
            return (
              <li key={a.id} className="py-3 text-[14px]">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge>{a.form === '4' ? 'Form 4' : a.form}</Badge>
                  {a.slug ? (
                    <Link to={`/investors/${a.slug}/`} className="font-medium hover:text-accent">
                      {a.manager}
                    </Link>
                  ) : (
                    <span className="font-medium">{a.manager}</span>
                  )}
                  {a.followup && <Badge tone="accent">follow-up</Badge>}
                </div>
                <p className="mt-0.5 text-[12.5px] text-ink-3">
                  Sent {timeLabel(a.sent_at)}
                  {gap != null && gap >= 0 ? ` · ${gapLabel(gap)} after EDGAR accepted it` : ''}
                </p>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
                  {email && <span className={email.warn ? 'text-[#7a5410]' : 'text-ink-2'}>{email.text}</span>}
                  {a.channels.feed && <span className="text-ink-2">Feed ✓</span>}
                  {CHATS.filter(([k]) => a.channels[k]).map(([k, label]) =>
                    a.channels[k] === 'delivered' ? (
                      <span key={k} className="text-ink-2">
                        {label} ✓
                      </span>
                    ) : (
                      <span key={k} className="text-[#7a5410]">
                        {label}: retrying
                      </span>
                    ),
                  )}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
