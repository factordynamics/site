import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, call } from '../lib/account'
import { Badge, Button } from './ui'

// Where alerts go besides email: GET/PUT {api}/channels, POST /channels/test, POST/DELETE /channels/feed.
// Every paid plan gets Slack, Discord, Telegram and a private feed; signed webhooks are Pro and Fund.
type Channels = {
  discord: string | null
  slack: string | null
  telegram: { chat_id: string } | null
  webhook: { url: string; secret: string; created?: number | string } | null
  webhook_available: boolean
  feed: { json_url: string; rss_url: string } | null
  /** 'team' for a Copy Fund owner: these channels post the team's alerts. */
  scope?: 'team' | 'personal'
  /** Destinations that stopped delivering: retries ran out, or the destination was revoked. */
  failing?: Failing
  /** A seat's view of the owner's team channels, read-only. */
  team?: { discord: string | null; slack: string | null; telegram: { chat_id: string } | null; webhook: { url: string; secret?: string } | null; failing?: Failing } | null
}
export type Failing = Partial<Record<'discord' | 'slack' | 'telegram' | 'webhook', { reason: string; since: string }>>
export const CHANNEL_LABEL = { discord: 'Discord', slack: 'Slack', telegram: 'Telegram', webhook: 'The webhook' } as const
const sinceLabel = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
type Put = Partial<{ discord: string | null; slack: string | null; telegram: { bot_token: string; chat_id: string } | null; webhook: string | null; rotate_secret: boolean }>

const field = 'h-10 w-full min-w-0 rounded-xl bg-paper px-3.5 text-[14px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]'
const why = (e: unknown) => (e instanceof ApiError && e.code === 'already_team_channel' ? 'Already your team’s channel. Alerts reach it once; no need to add it here.' : e instanceof ApiError && e.detail ? e.detail : 'That didn’t save. Please try again.')
// Tells the failing-channel banner (and the Fund setup list) what /channels now says.
const announce = (c: Channels) => window.dispatchEvent(new CustomEvent('copybook:channels', { detail: c.failing ?? {} }))

export function Channels() {
  const [c, setC] = useState<Channels | null>(null)
  const [loadErr, setLoadErr] = useState(false)
  const [msg, setMsg] = useState<{ k: string; text: string; ok: boolean } | null>(null)
  const [test, setTest] = useState<Record<string, string> | null>(null)

  useEffect(() => {
    call<{ channels: Channels }>('/channels', { auth: true }).then(
      (r) => setC(r.channels),
      () => setLoadErr(true),
    )
  }, [])

  const save = async (k: string, body: Put) => {
    setMsg(null)
    try {
      const r = await call<{ channels: Channels }>('/channels', { method: 'PUT', body, auth: true })
      setC(r.channels)
      announce(r.channels)
      window.dispatchEvent(new Event('copybook:setup'))
      setMsg({ k, text: 'Saved.', ok: true })
      return true
    } catch (e) {
      setMsg({ k, text: why(e), ok: false })
      return false
    }
  }
  const feed = async (make: boolean) => {
    if (!make && !confirm('Revoke your private feed? Readers using it stop getting alerts.')) return
    setMsg(null)
    try {
      await call('/channels/feed', { method: make ? 'POST' : 'DELETE', auth: true })
      setC((await call<{ channels: Channels }>('/channels', { auth: true })).channels)
    } catch (e) {
      setMsg({ k: 'feed', text: why(e), ok: false })
    }
  }
  const sendTest = async () => {
    setTest(null)
    try {
      // The API's messages are written for members ("Discord rejected this webhook…"); status codes are the fallback.
      const r = await call<{ results: Record<string, string>; messages?: Record<string, string> }>('/channels/test', { method: 'POST', auth: true })
      setTest(Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, r.messages?.[k] ?? (/^2\d\d$|^ok$/.test(v) ? 'delivered' : `failed (${v})`)])))
    } catch (e) {
      setTest({ error: why(e) })
    }
    // A test that goes through clears that destination's failing flag.
    call<{ channels: Channels }>('/channels', { auth: true }).then((r) => (setC(r.channels), announce(r.channels)), () => null)
  }

  const note = (k: string) =>
    msg?.k === k && (
      <p role={msg.ok ? 'status' : 'alert'} className={`mt-2 text-[13px] ${msg.ok ? 'text-up' : 'text-down'}`}>
        {msg.text}
      </p>
    )
  const configured = c && (c.discord || c.slack || c.telegram || c.webhook || c.feed)

  return (
    <section id="channels" className="mt-5 scroll-mt-24 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{c?.scope === 'team' ? 'Where your team’s alerts go' : c?.team ? 'Your own channels' : 'Where alerts go'}</h2>
          <p className="mt-1 text-[14px] text-ink-2">
            {c?.scope === 'team'
              ? 'Email always. A chat, feed or webhook you add here is your team’s: every alert for the team’s follows posts there once, as it happens. Seats can add their own as well.'
              : c?.team
                ? 'Email always. Add your own chat, feed or webhook for alerts on your settings, as they happen. The team’s channels come first; the plan owner manages them.'
                : 'Email always. Add a chat, a feed or a webhook and each alert arrives there as it happens, even if you take the daily email digest.'}
          </p>
        </div>
        {configured && (
          <Button size="sm" variant="outline" onClick={sendTest}>
            Send a test
          </Button>
        )}
      </div>
      {test && (
        <p role="status" className="mt-3 rounded-xl bg-paper px-3.5 py-2.5 text-[13px] text-ink-2">
          {Object.entries(test)
            .map(([k, v]) => `${k[0].toUpperCase() + k.slice(1)}: ${v}`)
            .join(' · ')}
        </p>
      )}
      {loadErr ? (
        <p className="mt-4 text-[14px] text-ink-2">Delivery settings didn’t load. Refresh to try again.</p>
      ) : !c ? (
        <div className="mt-4 h-40 animate-pulse rounded-xl bg-ink/[0.04]" />
      ) : (
        <div className="mt-2 divide-y divide-line">
          {c.team && <TeamChannels t={c.team} />}
          <UrlChannel
            name="Slack"
            hint={
              <>
                An incoming webhook URL from Slack (<span className="font-mono text-[12px]">https://hooks.slack.com/services/…</span>). Create one under Apps → Incoming Webhooks in your workspace.
              </>
            }
            value={c.slack}
            placeholder="https://hooks.slack.com/services/…"
            onSave={(v) => save('slack', { slack: v })}
            note={<>{fail(c.failing, 'slack')}{note('slack')}</>}
          />
          <UrlChannel
            name="Discord"
            hint={
              <>
                A channel webhook URL (<span className="font-mono text-[12px]">https://discord.com/api/webhooks/…</span>), from the channel’s Integrations settings.
              </>
            }
            value={c.discord}
            placeholder="https://discord.com/api/webhooks/…"
            onSave={(v) => save('discord', { discord: v })}
            note={<>{fail(c.failing, 'discord')}{note('discord')}</>}
          />
          <Telegram value={c.telegram} onSave={(v) => save('telegram', { telegram: v })} note={<>{fail(c.failing, 'telegram')}{note('telegram')}</>} />
          <Row name="Private feed" hint="An RSS and JSON Feed of your alerts for a reader or your own tools. The link is the password: anyone with it can read your alerts.">
            {c.feed ? (
              <>
                <Copyable label="RSS" value={c.feed.rss_url} />
                <Copyable label="JSON" value={c.feed.json_url} />
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => feed(true)}>
                    New link
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => feed(false)}>
                    Revoke
                  </Button>
                </div>
                <p className="mt-1.5 text-[12px] text-ink-3">A new link revokes the old one.</p>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => feed(true)}>
                Create feed link
              </Button>
            )}
            {note('feed')}
          </Row>
          <Webhook c={c} onSave={(b) => save('webhook', b)} note={<>{fail(c.failing, 'webhook')}{note('webhook')}</>} />
        </div>
      )}
    </section>
  )
}

function fail(f: Failing | undefined, k: keyof Failing) {
  const x = f?.[k]
  return x ? (
    <p role="alert" className="mt-2 rounded-lg bg-down/[0.07] px-3 py-2 text-[13px] text-down">
      Not delivering since {sinceLabel(x.since)}: {x.reason}. Fix it or remove it; a test that goes through clears this.
    </p>
  ) : null
}

// A seat's read-only view of the team channels the plan owner connected.
function TeamChannels({ t }: { t: NonNullable<Channels['team']> }) {
  const items = (
    [
      ['slack', 'Slack', t.slack],
      ['discord', 'Discord', t.discord],
      ['telegram', 'Telegram', t.telegram ? `chat ${t.telegram.chat_id}` : null],
      ['webhook', 'Signed webhook', t.webhook?.url ?? null],
    ] as const
  ).filter(([, , v]) => v)
  return (
    <div className="my-3 rounded-xl bg-paper px-4 shadow-[0_0_0_1px_var(--color-line)]">
    <Row
      name={
        <span className="flex flex-wrap items-center gap-2">
          Team channels <Badge>Read-only</Badge>
        </span>
      }
      hint="Managed by the plan owner. Every alert for the team’s follows posts here once."
    >
      {items.length === 0 ? (
        <p className="text-[13.5px] text-ink-2">The plan owner hasn’t connected a team channel yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map(([k, label, v]) => (
            <li key={k}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="w-32 shrink-0 text-[13px] text-ink-2">
                  {label}
                  <span className={`flex items-center gap-1.5 text-[12px] ${t.failing?.[k] ? 'text-down' : 'text-up'}`}>
                    <span className={`size-1.5 shrink-0 rounded-full ${t.failing?.[k] ? 'bg-down' : 'bg-up'}`} aria-hidden="true" />
                    {t.failing?.[k] ? 'Not delivering' : 'Delivering'}
                  </span>
                </span>
                <span title={v!} className="min-w-0 flex-1 basis-40 truncate rounded-lg bg-card px-3 py-2 font-mono text-[12.5px] text-ink-2 shadow-[0_0_0_1px_var(--color-line)]">{v}</span>
                {k === 'webhook' && t.webhook?.url && <CopyButton value={t.webhook.url} />}
              </span>
              {t.failing?.[k] && (
                <span className="mt-1 block pl-[8.5rem] text-[12px] text-down">
                  Since {sinceLabel(t.failing[k]!.since)}: {t.failing[k]!.reason}
                </span>
              )}
              {k === 'webhook' && t.webhook?.secret && <Copyable label="Signing secret" value={t.webhook.secret} wide />}
            </li>
          ))}
        </ul>
      )}
    </Row>
    </div>
  )
}

function Row({ name, hint, children }: { name: ReactNode; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-3 py-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-6">
      <div>
        <h3 className="text-[14px] font-medium">{name}</h3>
        <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function UrlChannel({ name, hint, value, placeholder, onSave, note }: { name: string; hint: ReactNode; value: string | null; placeholder: string; onSave: (v: string | null) => Promise<boolean>; note: ReactNode }) {
  const [edit, setEdit] = useState(false)
  const [v, setV] = useState('')
  return (
    <Row name={name} hint={hint}>
      {value && !edit ? (
        <div className="flex items-center gap-2">
          <span title={value} className="min-w-0 flex-1 basis-40 truncate rounded-lg bg-paper px-3 py-2 font-mono text-[12.5px] text-ink-2 shadow-[0_0_0_1px_var(--color-line)]">{value}</span>
          <Button size="sm" variant="outline" onClick={() => setEdit(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onSave(null)}>
            Remove
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await onSave(v.trim())) {
              setEdit(false)
              setV('')
            }
          }}
        >
          <input type="url" required value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} aria-label={`${name} webhook URL`} className={`${field} flex-1 basis-64 font-mono text-[13px]`} />
          <Button size="sm" type="submit">
            Save
          </Button>
          {edit && (
            <Button size="sm" variant="ghost" onClick={() => setEdit(false)}>
              Cancel
            </Button>
          )}
        </form>
      )}
      {note}
    </Row>
  )
}

function Telegram({ value, onSave, note }: { value: Channels['telegram']; onSave: (v: { bot_token: string; chat_id: string } | null) => Promise<boolean>; note: ReactNode }) {
  const [edit, setEdit] = useState(false)
  const [token, setToken] = useState('')
  const [chat, setChat] = useState('')
  return (
    <Row
      name="Telegram"
      hint={
        <>
          Create a bot with <span className="font-mono text-[12px]">@BotFather</span>, send it a message, then enter its token and your chat id, or <span className="font-mono text-[12px]">@channelname</span> for a channel the bot is in.
        </>
      }
    >
      {value && !edit ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-lg bg-paper px-3 py-2 font-mono text-[12.5px] text-ink-2 shadow-[0_0_0_1px_var(--color-line)]">chat {value.chat_id}</span>
          <Button size="sm" variant="outline" onClick={() => setEdit(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onSave(null)}>
            Remove
          </Button>
        </div>
      ) : (
        <form
          className="grid gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await onSave({ bot_token: token.trim(), chat_id: chat.trim() })) {
              setEdit(false)
              setToken('')
              setChat('')
            }
          }}
        >
          <input required value={token} onChange={(e) => setToken(e.target.value)} placeholder="Bot token" aria-label="Telegram bot token" autoComplete="off" className={`${field} font-mono text-[13px]`} />
          <input required value={chat} onChange={(e) => setChat(e.target.value)} placeholder="Chat id" aria-label="Telegram chat id" className={`${field} font-mono text-[13px]`} />
          <Button size="sm" type="submit" className="h-10">
            Save
          </Button>
        </form>
      )}
      {note}
    </Row>
  )
}

function Webhook({ c, onSave, note }: { c: Channels; onSave: (b: Put) => Promise<boolean>; note: ReactNode }) {
  const [v, setV] = useState('')
  const [edit, setEdit] = useState(false)
  return (
    <Row
      name="Signed webhook"
      hint={
        <>
          A JSON POST to your endpoint for each alert, signed in the <span className="font-mono text-[12px]">Copybook-Signature</span> header (HMAC-SHA256 of <span className="font-mono text-[12px]">t.body</span>). Failed deliveries retry for 12 hours.
        </>
      }
    >
      {!c.webhook_available ? (
        <p className="text-[13.5px] text-ink-2">
          Signed webhooks are part of Copy Pro and Copy Fund.{' '}
          <Link to="/upgrade/?plan=pro" className="font-medium text-accent hover:text-accent-2">
            Upgrade to Pro
          </Link>
        </p>
      ) : c.webhook && !edit ? (
        <>
          <div className="flex items-center gap-2">
            <span title={c.webhook.url} className="min-w-0 flex-1 basis-40 truncate rounded-lg bg-paper px-3 py-2 font-mono text-[12.5px] text-ink-2 shadow-[0_0_0_1px_var(--color-line)]">{c.webhook.url}</span>
            <Button size="sm" variant="outline" onClick={() => setEdit(true)}>
              Change
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onSave({ webhook: null })}>
              Remove
            </Button>
          </div>
          <Copyable label="Signing secret" value={c.webhook.secret} />
          <Button size="sm" variant="ghost" className="mt-1" onClick={() => confirm('Issue a new signing secret? Signatures made with the old one stop verifying.') && onSave({ rotate_secret: true })}>
            Rotate secret
          </Button>
        </>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await onSave({ webhook: v.trim() })) {
              setEdit(false)
              setV('')
            }
          }}
        >
          <input type="url" required value={v} onChange={(e) => setV(e.target.value)} placeholder="https://your-app.example/copybook" aria-label="Webhook URL" className={`${field} flex-1 basis-64 font-mono text-[13px]`} />
          <Button size="sm" type="submit">
            Save
          </Button>
        </form>
      )}
      {note}
    </Row>
  )
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard.writeText(value).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }
      className="shrink-0 text-[12.5px] font-medium text-accent hover:text-accent-2"
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function Copyable({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <span className={`${wide ? 'w-32' : 'w-24'} shrink-0 text-[12.5px] text-ink-3`}>{label}</span>
      <code title={value} className="min-w-0 flex-1 truncate rounded-lg bg-paper px-3 py-1.5 font-mono text-[12px] text-ink-2 shadow-[0_0_0_1px_var(--color-line)]">{value}</code>
      <CopyButton value={value} />
    </div>
  )
}

/** A banner while any destination is failing; it updates when /channels changes on this page. */
export function FailingBanner({ initial, onAccount }: { initial?: Failing; onAccount?: boolean }) {
  const [f, setF] = useState<Failing>(initial ?? {})
  useEffect(() => setF(initial ?? {}), [initial])
  useEffect(() => {
    const on = (e: Event) => setF((e as CustomEvent<Failing>).detail)
    window.addEventListener('copybook:channels', on)
    return () => window.removeEventListener('copybook:channels', on)
  }, [])
  const list = (Object.entries(f) as [keyof Failing, { reason: string; since: string }][]).filter(([, x]) => x)
  if (!list.length) return null
  return (
    <div role="alert" className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] bg-down/[0.07] px-5 py-3.5 text-[14px] text-down">
      <p className="min-w-0 flex-1 basis-80">
        {list.map(([k, x], i) => (
          <span key={k}>
            {i > 0 && ' '}
            {CHANNEL_LABEL[k]} stopped delivering on {sinceLabel(x.since)}: {x.reason}.
          </span>
        ))}{' '}
        Fix it or remove it. Email alerts carry on.
      </p>
      {onAccount ? (
        <a href="#channels" className="shrink-0 font-medium underline underline-offset-2">
          Go to channels
        </a>
      ) : (
        <Link to="/account/#channels" className="shrink-0 font-medium underline underline-offset-2">
          Fix it in Account
        </Link>
      )}
    </div>
  )
}

