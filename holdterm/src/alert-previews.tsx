// What a Holdterm alert looks like on each channel, drawn from real recent filings and from the exact
// payloads src/alert-render.ts builds for the alerts API (email HTML, push, Discord, Slack, Telegram).
import { useState } from 'react'
import { eventTitle, htDiscord, htEmail, htPush, htSlack, htTelegram, type HtEvent, type HtFiling, type HtRow } from './alert-render'
import { type Book, type Event, isStockLine, loadBook, loadEvents } from './data'
import { day } from './lib'
import { firmName } from './names'

const site = 'https://holdterm.factordynamics.com/'

const row = (h: Book['holdings'][number]): HtRow => ({
  ticker: h.ticker,
  display_name: h.display_name ?? null,
  issuer: h.issuer,
  put_call: h.put_call,
  shares: h.shares,
  prev_shares: h.prev_shares ?? 0,
  value: h.value,
  value_delta: h.value_delta ?? 0,
})
export function bookToAlert(b: Book): HtFiling {
  const live = b.holdings.filter((h) => isStockLine(h) && h.value_delta)
  const of = (c: string) => live.filter((h) => h.change === c).map(row)
  return {
    slug: b.slug,
    manager: b.firm,
    quarter: b.quarter,
    filing_date: b.filing_date,
    accession: b.accession,
    sec_url: b.sec_url,
    moves: {
      bought_usd: live.reduce((s, h) => s + Math.max(0, h.value_delta ?? 0), 0),
      sold_usd: live.reduce((s, h) => s - Math.min(0, h.value_delta ?? 0), 0),
      new: of('new'),
      added: of('added'),
      trimmed: of('trimmed'),
      exited: of('exited'),
    },
  }
}
const eventToAlert = (e: Event, prev?: Event): HtEvent => ({
  id: e.id,
  slug: e.slug,
  manager: firmName(e.slug, e.manager),
  form: e.form,
  kind: e.kind,
  action: e.action,
  filing_date: e.filing_date,
  url: e.url,
  issuer: e.issuer,
  display_name: e.display_name ?? null,
  ticker: e.ticker,
  shares: e.shares,
  value_usd: e.value_usd,
  avg_price: e.avg_price,
  shares_after: e.shares_after,
  percent_of_class: e.percent_of_class,
  prev_percent_of_class: prev?.percent_of_class ?? null,
})

export type Samples = { filing: HtFiling; form4?: HtEvent; g13?: HtEvent; d13?: HtEvent }
// Sanders Capital's Q3 13F is a large, clean, recent book; Berkshire's is the fallback.
const SAMPLE_FUNDS = ['sanders-capital-llc-8097', 'warren-buffett']
let samples: Promise<Samples> | undefined
export const loadSamples = () =>
  (samples ??= Promise.all([
    loadBook(SAMPLE_FUNDS[0]).catch(() => loadBook(SAMPLE_FUNDS[1])),
    loadEvents().catch(() => ({ events: [] as Event[] })),
  ]).then(([b, d]) => {
    const ev = [...d.events].sort((x, y) => y.filing_date.localeCompare(x.filing_date))
    const pick = (ok: (e: Event) => boolean) => {
      const e = ev.find(ok)
      return e && eventToAlert(e, ev.find((p) => p !== e && p.slug === e.slug && p.ticker === e.ticker && p.kind === e.kind && p.filing_date <= e.filing_date && p.percent_of_class != null))
    }
    return {
      filing: bookToAlert(b),
      form4: pick((e) => e.kind === 'form4' && (e.action === 'buy' || e.action === 'sell') && !!e.value_usd && !!e.ticker),
      g13: pick((e) => e.kind === '13g' && e.action === 'new_stake' && e.percent_of_class != null && !!e.ticker),
      d13: pick((e) => e.kind === '13d' && e.percent_of_class != null && !!e.ticker && e.action !== 'below_threshold'),
    }
  }))

const longDay = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

function AppIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden className="ap-icon">
      <rect width="20" height="20" rx="4.5" fill="#ffb224" />
      <rect x="4" y="4.5" width="12" height="2.2" fill="#0b0b0a" />
      <rect x="4" y="8.9" width="8.5" height="2.2" fill="#0b0b0a" />
      <rect x="4" y="13.3" width="5" height="2.2" fill="#0b0b0a" />
    </svg>
  )
}

/** The email exactly as sent (htEmail), in a frame. */
export function EmailPreview({ s }: { s: Samples }) {
  const m = htEmail([s.filing], [], site)
  return (
    <figure className="ap ap-email">
      <div className="ap-mailhead">
        <div className="ap-mailfrom">
          <AppIcon size={32} />
          <div>
            <b>Holdterm</b> <span className="dim">holdterm@factordynamics.com</span>
            <div className="ap-subject">{m.subject}</div>
          </div>
        </div>
      </div>
      {/* No allow-scripts, so allow-same-origin only lets this page read the email's height to fit the frame to it. */}
      <iframe
        title={`Sample email: ${m.subject}`}
        srcDoc={m.html}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        onLoad={(e) => {
          const f = e.currentTarget
          const h = f.contentDocument?.documentElement.scrollHeight
          if (h) f.style.height = `${h}px`
        }}
      />
    </figure>
  )
}

const shortDay = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
/** An inbox with the alert emails htEmail builds for the sample filings: each email's real subject, its first line
 * and the day the filing came in, newest first. */
export function InboxPreview({ s }: { s: Samples }) {
  const events = [s.form4, s.d13, s.g13].filter((e): e is HtEvent => Boolean(e))
  const pushes = htPush([s.filing], events, site)
  const mails = [
    { date: s.filing.filing_date, subject: htEmail([s.filing], [], site).subject, body: pushes[0].body },
    ...events.map((e, i) => ({ date: e.filing_date, subject: htEmail([], [e], site).subject, body: pushes[i + 1].body })),
  ].sort((a, b) => b.date.localeCompare(a.date))
  return (
    <figure className="ap ap-inbox" aria-label="Holdterm alert emails in an inbox">
      <div className="ap-inbox-head">Inbox</div>
      {mails.map((m) => (
        <div className="ap-inbox-row" key={m.subject}>
          <AppIcon size={28} />
          <div>
            <div className="ap-note-top">
              <b>Holdterm</b>
              <span>{shortDay(m.date)}</span>
            </div>
            <div className="ap-note-title">{m.subject}</div>
            <div className="ap-note-body">{m.body}</div>
          </div>
        </div>
      ))}
    </figure>
  )
}

/** A phone lock screen with the push notifications htPush builds. */
export function PushPreview({ s, compact = false }: { s: Samples; compact?: boolean }) {
  const pushes = htPush([s.filing], [s.form4, s.d13].filter((e): e is HtEvent => Boolean(e)), site)
  const order = [pushes[1], pushes[0], pushes[2]].filter(Boolean).slice(0, compact ? 2 : 3)
  const latest = [s.form4?.filing_date, s.filing.filing_date].filter(Boolean).sort().pop()!
  return (
    <figure className={`ap ap-phone${compact ? ' compact' : ''}`} aria-label="Push notifications on a phone lock screen">
      <div className="ap-screen">
        <div className="ap-clock">
          <div className="ap-date">{longDay(latest)}</div>
          <div className="ap-time">4:05</div>
        </div>
        {order.map((p, i) => (
          <div className="ap-note" key={p.tag}>
            <AppIcon size={30} />
            <div>
              <div className="ap-note-top">
                <b>Holdterm</b>
                <span>{i === 0 ? 'now' : `${i * 7 + 2}m ago`}</span>
              </div>
              <div className="ap-note-title">{p.title}</div>
              <div className="ap-note-body">{p.body}</div>
            </div>
          </div>
        ))}
      </div>
    </figure>
  )
}

type Embed = ReturnType<typeof htDiscord>['embeds'][number] & { fields?: { name: string; value: string }[] }
const md = (s: string) => s.split(/(\[[^\]]+\]\([^)]+\))/).map((part, i) => {
  const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
  return m ? (
    <a key={i} href={m[2]} target="_blank" rel="noreferrer">
      {m[1]}
    </a>
  ) : (
    part
  )
})
function DiscordPreview({ filing, events }: { filing?: HtFiling; events: HtEvent[] }) {
  const body = htDiscord(filing ? [filing] : [], events, site)
  return (
    <div className="ap-discord">
      <div className="ap-chatrow">
        <span className="ap-avatar round">
          <AppIcon size={22} />
        </span>
        <div className="ap-chatmain">
          <div className="ap-chathead">
            <b>Holdterm</b> <span className="ap-app">APP</span> <span className="ap-when">Today at 4:05 PM</span>
          </div>
          {body.embeds.map((e: Embed) => (
            <div className="ap-embed" key={e.title} style={{ borderColor: `#${e.color.toString(16).padStart(6, '0')}` }}>
              <a className="ap-embed-title" href={e.url} target="_blank" rel="noreferrer">
                {e.title}
              </a>
              <div className="ap-embed-desc">{e.description.split('\n').map((l, i) => <div key={i}>{md(l)}</div>)}</div>
              {!!e.fields?.length && (
                <div className="ap-fields">
                  {e.fields.map((f) => (
                    <div key={f.name}>
                      <b>{f.name}</b>
                      {f.value.split('\n').map((l) => (
                        <div key={l}>{l}</div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              <div className="ap-embed-foot">{e.footer.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

type Block = { type: string; text?: { text: string }; fields?: { text: string }[]; elements?: { text: string | { text: string }; url?: string; style?: string }[] }
const slackText = (s: string) =>
  s.split(/(\*[^*]+\*|<[^|>]+\|[^>]+>)/).map((part, i) => {
    const link = /^<([^|>]+)\|([^>]+)>$/.exec(part)
    if (link)
      return (
        <a key={i} href={link[1]} target="_blank" rel="noreferrer">
          {link[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')}
        </a>
      )
    if (/^\*[^*]+\*$/.test(part)) return <b key={i}>{part.slice(1, -1)}</b>
    return part.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  })
const lines = (s: string) => s.split('\n').map((l, i) => <div key={i}>{slackText(l)}</div>)
function SlackPreview({ filing, events }: { filing?: HtFiling; events: HtEvent[] }) {
  const body = htSlack(filing ? [filing] : [], events, site)
  return (
    <div className="ap-slack">
      <div className="ap-chatrow">
        <span className="ap-avatar">
          <AppIcon size={22} />
        </span>
        <div className="ap-chatmain">
          <div className="ap-chathead">
            <b>Holdterm</b> <span className="ap-app">APP</span> <span className="ap-when">4:05 PM</span>
          </div>
          {(body.blocks as Block[]).map((b, i) => {
            if (b.type === 'header') return <div key={i} className="ap-sl-header">{b.text!.text}</div>
            if (b.type === 'section') return <div key={i} className="ap-sl-section">{b.text ? lines(b.text.text) : <div className="ap-sl-fields">{b.fields!.map((f, j) => <div key={j}>{lines(f.text)}</div>)}</div>}</div>
            if (b.type === 'actions')
              return (
                <div key={i} className="ap-sl-actions">
                  {b.elements!.map((el, j) => (
                    <a key={j} href={el.url} className={el.style === 'primary' ? 'primary' : ''} target="_blank" rel="noreferrer">
                      {typeof el.text === 'string' ? el.text : el.text.text}
                    </a>
                  ))}
                </div>
              )
            if (b.type === 'context') return <div key={i} className="ap-sl-context">{b.elements!.map((el) => slackText(typeof el.text === 'string' ? el.text : el.text.text))}</div>
            return <hr key={i} />
          })}
        </div>
      </div>
    </div>
  )
}

function TelegramPreview({ events, filing }: { events: HtEvent[]; filing?: HtFiling }) {
  // htTelegram escapes everything it writes and only emits <b> and <a href>, so its output is safe to show as HTML.
  const html = htTelegram(filing ? [filing] : [], events, site).replace(/<a href=/g, '<a target="_blank" rel="noreferrer" href=').replace(/\n/g, '<br>')
  return (
    <div className="ap-telegram">
      <div className="ap-tg-bubble">
        <div className="ap-tg-name">Holdterm</div>
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <div className="ap-tg-time">16:05</div>
      </div>
    </div>
  )
}

const CHATS = [
  ['discord', 'Discord'],
  ['slack', 'Slack'],
  ['telegram', 'Telegram'],
] as const
/** Discord, Slack and Telegram, one at a time, each showing a different kind of real filing. */
export function ChatPreviews({ s }: { s: Samples }) {
  const [tab, setTab] = useState<(typeof CHATS)[number][0]>('discord')
  const ev = (e?: HtEvent) => (e ? [e] : [])
  return (
    <figure className="ap ap-chats">
      <div className="ap-tabs" role="tablist" aria-label="Chat apps">
        {CHATS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={`${CHATS.find((c) => c[0] === tab)![1]} preview`}>
        {tab === 'discord' && <DiscordPreview events={ev(s.d13 ?? s.g13)} />}
        {tab === 'slack' && <SlackPreview filing={s.filing} events={[]} />}
        {tab === 'telegram' && <TelegramPreview events={ev(s.g13 ?? s.form4)} />}
      </div>
    </figure>
  )
}

/** Which real filings the previews use, with links to them on EDGAR. */
export function SampleSources({ s }: { s: Samples }) {
  const items: [string, string, string][] = [[`${s.filing.manager}’s 13F`, s.filing.filing_date, s.filing.sec_url]]
  for (const e of [s.form4, s.d13, s.g13]) if (e) items.push([`${e.manager}’s ${e.kind === 'form4' ? 'Form 4' : e.kind === '13d' ? '13D' : '13G'}${e.ticker ? ` on ${e.ticker}` : ''}`, e.filing_date, e.url])
  return (
    <p className="dim small ap-sources">
      Every preview is built from a real filing:{' '}
      {items.map(([label, d, url], i) => (
        <span key={url}>
          {i ? (i === items.length - 1 ? ' and ' : ', ') : ''}
          <a href={url} target="_blank" rel="noreferrer">
            {label}
          </a>{' '}
          ({day(d)})
        </span>
      ))}
      .
    </p>
  )
}

/** The newest roster 13D, 13G or Form 4 as a one-line notification title, for the home page's alerts offer. */
export const loadLatestTitle = () =>
  loadEvents().then((d) => {
    const ev = d.events.filter((e) => e.ticker && e.action !== 'below_threshold' && e.action !== 'other' && (e.kind !== 'form4' || e.value_usd) && (e.kind === 'form4' || e.percent_of_class != null))
    const e = ev.sort((x, y) => y.filing_date.localeCompare(x.filing_date))[0]
    if (!e) return null
    const prev = d.events.find((p) => p !== e && p.slug === e.slug && p.ticker === e.ticker && p.kind === e.kind && p.filing_date <= e.filing_date && p.percent_of_class != null)
    return { title: eventTitle(eventToAlert(e, prev)), date: e.filing_date }
  })
export { AppIcon }
