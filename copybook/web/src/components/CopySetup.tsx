import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { call, getToken, sharedGet } from '../lib/account'
import { useFollows } from '../lib/follows'
import { testLine, testResult } from './Channels'
import { Button, Check } from './ui'

// First-run setup for Copy, the same three steps as the day-0 email plus a test: follow funds, add
// the names you own, pick where alerts go, and send a test. Follows and channels are read live from
// the API (Channels announces changes with 'copybook:setup'); choosing email only is stored on the account
// (channels.keep_email), and a test that went through is remembered in this browser. Shown after checkout and until done; dismissible.
const HIDE = 'copybook.copySetupHidden'
export const TESTED = 'copybook.testOk'
const FUNDS = 3

type Ch = { discord: string | null; slack: string | null; telegram: unknown; webhook: unknown; feed: unknown; tested_at?: string | null; keep_email?: boolean }
// The last /channels answer for this session, so an API outage doesn't undo a finished step.
export const CH_LAST = 'copybook-channels-last'
const lastCh = (): Ch | null => {
  try {
    const c = JSON.parse(localStorage.getItem(CH_LAST) ?? 'null') as { token: string; channels: Ch } | null
    return c && c.token === getToken() ? c.channels : null
  } catch {
    return null
  }
}

export function CopySetup({ welcome }: { welcome?: boolean }) {
  const { follows, status } = useFollows()
  const [ch, setCh] = useState<Ch | null>(lastCh)
  const [hidden, setHidden] = useState(() => !welcome && localStorage.getItem(HIDE) === '1')
  const [keptEmail, setKeptEmail] = useState(false)
  const [tested, setTested] = useState(() => localStorage.getItem(TESTED) === '1')
  const [test, setTest] = useState<{ busy?: boolean; msg?: string; ok?: boolean }>({})

  const load = useCallback(() => {
    sharedGet<{ channels: Ch }>('/channels').then(
      (r) => {
        setCh(r.channels)
        try {
          localStorage.setItem(CH_LAST, JSON.stringify({ token: getToken(), channels: r.channels }))
        } catch {
          // Storage blocked: no cache.
        }
      },
      () => setCh(lastCh()),
    )
    setTested(localStorage.getItem(TESTED) === '1')
  }, [])
  useEffect(() => {
    load()
    window.addEventListener('copybook:setup', load)
    return () => window.removeEventListener('copybook:setup', load)
  }, [load])

  const keepEmail = keptEmail || Boolean(ch?.keep_email)
  const connected = Boolean(ch && (ch.discord || ch.slack || ch.telegram || ch.webhook || ch.feed))
  // A feed doesn't replace email; a chat or webhook does.
  const chat = Boolean(ch && (ch.discord || ch.slack || ch.telegram || ch.webhook))
  // Keeping email completes step 3 only; the test is its own step, and for email-only members it sends a
  // test email (POST /channels/test).
  const testDone = tested || Boolean(ch?.tested_at)
  const sendTest = async () => {
    setTest({ busy: true })
    try {
      const r = await call<{ results: Record<string, string>; messages?: Record<string, string> }>('/channels/test', { method: 'POST', auth: true })
      const ok = Object.values(r.results).some((v) => /^2\d\d$|^ok$|^sent$/.test(v))
      if (ok) localStorage.setItem(TESTED, '1')
      setTested(ok)
      // One line per channel the API actually tested, never a success for one it didn't.
      const line = ([k, v]: [string, string]) => testLine(k, testResult(k, v, r.messages?.[k]))
      setTest({ ok, msg: Object.entries(r.results).map(line).join(' · ') || 'Nothing to test yet: connect a channel or keep email first.' })
    } catch {
      setTest({ ok: false, msg: 'The test didn’t go out. Please try again.' })
    }
  }

  type Act = { label: string; to?: string; href?: string; onClick?: () => void; disabled?: boolean }
  const n = follows.investors.length
  const names = follows.owned.length + follows.stocks.filter((t) => !follows.owned.includes(t)).length
  const steps: { done: boolean; title: string; body: ReactNode; act: Act; alt?: Act }[] = [
    {
      done: n >= FUNDS,
      title: `Follow ${FUNDS} funds`,
      body: n >= FUNDS ? `Following ${n}. Each 13F, Form 4 and 13D they file reaches you; we check EDGAR every minute.` : `${n} of ${FUNDS} followed. Each 13F, Form 4 and 13D they file reaches you; we check EDGAR every minute.`,
      act: { label: n ? 'Follow more' : 'Pick funds', to: '/investors/' },
    },
    {
      done: names > 0,
      title: 'Add your names to My book',
      body: names ? `${names} ${names === 1 ? 'name' : 'names'}: any superinvestor move in them is flagged on filing cards and in My book.` : 'Paste the tickers you own or watch, or a broker CSV. Any superinvestor move in them gets flagged.',
      act: { label: names ? 'Open My book' : 'Add names', to: '/my-book/#book-import' },
    },
    {
      done: connected || keepEmail,
      title: 'Connect a channel (or keep email)',
      // A working chat or webhook replaces alert email unless keep_email is on (payments, Nov 11).
      body: chat ? (ch?.keep_email ? 'Alerts reach your chat and your inbox.' : 'Alerts go to your chat instead of email. Tick “Also email me alerts” below for both.') : connected ? 'Alerts reach your feed and your inbox.' : keepEmail ? 'Email only. You can add Slack, Discord, Telegram or a feed any time below.' : 'Add Telegram or Slack so alerts never wait on email limits.',
      act: { label: connected ? 'Channels' : 'Connect', href: '#channels' },
      alt:
        connected || keepEmail
          ? undefined
          : {
              label: 'Keep email',
              onClick: () => {
                setKeptEmail(true)
                call('/channels', { method: 'PUT', body: { keep_email: true }, auth: true }).catch(() => setKeptEmail(false))
              },
            },
    },
    {
      done: testDone,
      title: 'Send a test',
      body: test.msg ? test.msg : testDone ? 'Tested earlier. Send another test any time; each channel reports its own result.' : connected ? 'One short message to each place you connected, to check it works.' : keepEmail ? 'One test email to your inbox. Alerts come from copybook@factordynamics.com; add it to your contacts so they never land in spam.' : 'Connect a channel or keep email first, then check it here.',
      act: { label: test.busy ? 'Sending…' : 'Send a test', onClick: sendTest, disabled: !(connected || keepEmail) || test.busy },
    },
  ]
  const left = steps.filter((s) => !s.done).length
  const next = steps.findIndex((s) => !s.done)
  if (status !== 'ready' || hidden || (!left && !welcome)) return null

  return (
    <section className="mt-10 rounded-[18px] bg-card p-5 shadow-[var(--shadow-card)] md:p-8" aria-labelledby="copy-setup-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-accent">Set up Copy · {left ? `${steps.length - left} of ${steps.length} done` : 'all set'}</p>
          <h2 id="copy-setup-title" className="mt-2 text-[24px] font-semibold tracking-[-0.03em] md:text-[26px]">
            {left ? 'Two minutes to your first alert.' : 'You’re set. Your next alert is on its way.'}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(HIDE, '1')
            setHidden(true)
          }}
          className="-m-2 p-2 text-[13px] text-ink-3 hover:text-ink"
        >
          Hide
        </button>
      </div>
      <ol className="mt-6 divide-y divide-line">
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4 first:pt-0 last:pb-0">
            <span
              className={`num inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${s.done ? 'bg-up text-white' : i === next ? 'bg-accent text-white' : 'border-2 border-ink-3/70 bg-card text-ink-2'}`}
              aria-label={s.done ? 'Done' : `Step ${i + 1}`}
            >
              {s.done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1 basis-56">
              <span className={`block text-[15px] font-medium ${s.done ? 'text-ink-2' : ''}`}>{s.title}</span>
              <span className="mt-0.5 block text-[13.5px] text-ink-2">{s.body}</span>
              {i === 3 && test.msg && (
                <span role="status" className={`mt-1 block text-[13px] ${test.ok ? 'text-up' : 'text-down'}`}>
                  {test.msg}
                </span>
              )}
            </span>
            {!(s.done && i === 3) && (
              <span className="flex shrink-0 flex-wrap gap-2">
                {s.alt && (
                  <Button size="sm" variant="ghost" onClick={s.alt.onClick} to={s.alt.to} href={s.alt.href}>
                    {s.alt.label}
                  </Button>
                )}
                <Button size="sm" variant={i === next ? 'primary' : 'outline'} to={s.act.to} href={s.act.href} onClick={s.act.onClick} disabled={s.act.disabled}>
                  {s.act.label}
                </Button>
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
