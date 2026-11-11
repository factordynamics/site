import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTitle } from '../lib/data'

// Email footers link here (copybook.factordynamics.com/unsubscribe/?t=...). Opening it changes nothing, so a
// mail scanner that follows links can't unsubscribe anyone; the button posts the token to the Worker, which
// answers itself (it works with the member API down) and is idempotent. Mail clients' one-click unsubscribe
// posts to the Worker directly and never loads this page.
const WORKER = 'https://copybook-api.factordynamics.workers.dev'

type State = { kind: 'idle' | 'sending' | 'error' } | { kind: 'done'; email: string; paying: boolean } | { kind: 'expired' }

export function Unsubscribe() {
  useTitle('Unsubscribe · Copybook')
  const [params] = useSearchParams()
  const t = params.get('t') ?? ''
  const [s, setS] = useState<State>({ kind: 'idle' })
  const send = async () => {
    setS({ kind: 'sending' })
    try {
      // A simple CORS request: no custom headers, and the token in the query string.
      const r = await fetch(`${WORKER}/unsubscribe?t=${encodeURIComponent(t)}`, { method: 'POST' })
      const text = (await r.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
      const done = /Done:\s*(.+?)\s+won['’]t get/.exec(text)
      if (r.ok && done) setS({ kind: 'done', email: done[1], paying: /tips or plan reminders/.test(text) })
      else if (/expired/i.test(text)) setS({ kind: 'expired' })
      else setS({ kind: 'error' })
    } catch {
      setS({ kind: 'error' })
    }
  }
  const expired = !t || s.kind === 'expired'
  return (
    <div className="container-x max-w-2xl pt-12 md:pt-16">
      <p className="text-[13px] font-medium text-accent">Email</p>
      <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">
        {s.kind === 'done' ? 'You’re unsubscribed.' : expired ? 'This link has expired.' : 'Unsubscribe'}
      </h1>
      {s.kind === 'done' ? (
        <>
          <p className="mt-3 text-[17px] leading-relaxed text-ink-2">
            {s.paying
              ? `${s.email} won’t get tips or season notes any more. Your filing alerts stay on. We’ll still email you before any charge. Change alerts on `
              : `${s.email} won’t get the Friday weekly or other Copybook emails any more.`}
            {s.paying && (
              <>
                <Link to="/account/" className="font-medium text-accent hover:text-accent-2">
                  your account page
                </Link>
                .
              </>
            )}
          </p>
          <p className="mt-4 text-[14px] text-ink-3">Changed your mind? Reply to any Copybook email and we’ll turn it back on.</p>
        </>
      ) : expired ? (
        <p className="mt-3 text-[17px] leading-relaxed text-ink-2">Reply to the email and we’ll unsubscribe you.</p>
      ) : (
        <>
          <p className="mt-3 text-[17px] leading-relaxed text-ink-2">Unsubscribe from Copybook’s weekly email and tips?</p>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-3">On a paid plan: your filing alerts stay on. We’ll still email you before any charge.</p>
          <button
            type="button"
            onClick={send}
            disabled={s.kind === 'sending'}
            className="mt-8 inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-medium text-white hover:bg-ink/90 disabled:opacity-60"
          >
            {s.kind === 'sending' ? 'Unsubscribing…' : 'Unsubscribe'}
          </button>
          {s.kind === 'error' ? (
            <p className="mt-4 text-[14px] text-[#9a3412]" role="alert">
              That didn’t go through. Try again, or reply to the email and we’ll unsubscribe you.
            </p>
          ) : (
            <p className="mt-4 text-[14px] text-ink-3">Changed your mind? Close this page and nothing changes.</p>
          )}
        </>
      )}
    </div>
  )
}
