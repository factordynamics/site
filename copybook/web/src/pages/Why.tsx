import { Link, useSearchParams } from 'react-router-dom'
import { Arrow } from '../components/ui'
import { useState } from 'react'
import { apiReady } from '../config'
import { useTitle } from '../lib/data'

// The cancel email's reasons, keys and wording exactly as the API's WHY list (copybook/api/src/revenue.ts),
// so the email, this page and the thanks say the same thing.
const REASONS: Record<string, string> = {
  price: 'Too expensive',
  value: 'Not useful enough',
  feature: 'Missing a feature I need',
  alerts: 'Alerts too slow or too noisy',
  temporary: 'Only needed it for a while',
  seasonal: 'Only need it in filing season',
  other: 'Something else',
}

// The cancel email's reason links land here (copybook.factordynamics.com/why/?t=...&r=...). Opening it
// records nothing, so a mail scanner that follows links can't send a reason; the button form-posts t, r
// and the optional note to the API with fetch, and the thanks shows on this page.
export function Why() {
  useTitle('Why you cancelled · Copybook')
  const [params] = useSearchParams()
  const t = params.get('t') ?? ''
  const r = params.get('r') ?? ''
  const reason = REASONS[r]
  const [sent, setSent] = useState<'ok' | 'expired' | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  return (
    <div className="container-x max-w-2xl pt-12 md:pt-16">
      <p className="text-[13px] font-medium text-accent">Account</p>
      <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Tell us why you cancelled.</h1>
      {t && reason ? (
        sent ? (
          <div role="status" className="mt-6">
            <p className="text-[17px] leading-relaxed text-ink-2">{sent === 'expired' ? 'This link has expired, so nothing was sent. You can reply to the email instead.' : `Thanks: “${reason}” is noted. We read every one.`}</p>
            <Link to="/" className="mt-6 inline-flex font-medium text-accent hover:text-accent-2">
              Back to Copybook
            </Link>
          </div>
        ) : (
        <form
          className="mt-6"
          onSubmit={async (e) => {
            e.preventDefault()
            const body = new URLSearchParams(new FormData(e.currentTarget) as unknown as Record<string, string>)
            setBusy(true)
            setErr('')
            // A plain form POST, sent with fetch so the thanks shows here instead of on the API's own page.
            try {
              const base = await apiReady
              const r = await fetch(`${base}/why`, { method: 'POST', body })
              const text = r.ok ? await r.text() : ''
              if (!r.ok) throw new Error(String(r.status))
              setSent(/expired/i.test(text) ? 'expired' : 'ok')
            } catch {
              setErr('That didn’t send. Please try again, or reply to the email.')
            } finally {
              setBusy(false)
            }
          }}
        >
          <input type="hidden" name="t" value={t} />
          <input type="hidden" name="r" value={r} />
          <p className="text-[17px] leading-relaxed text-ink-2">
            Your reason: <span className="font-semibold text-ink">{reason}</span>. Send it?
          </p>
          <label htmlFor="why-note" className="mt-6 block text-[13px] font-medium text-ink-3">
            Anything to add? <span className="font-normal">(optional)</span>
          </label>
          <textarea
            id="why-note"
            name="note"
            rows={4}
            maxLength={2000}
            placeholder={r === 'feature' ? 'Which feature were you missing?' : 'What would have kept you?'}
            className="mt-2 w-full rounded-xl bg-paper px-3.5 py-2.5 text-[15px] leading-relaxed shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
          />
          <button type="submit" disabled={busy} className="mt-5 inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-medium text-white hover:bg-ink/90 disabled:opacity-60">
            {busy ? 'Sending…' : 'Send'} <Arrow />
          </button>
          {err && (
            <p role="alert" className="mt-2 text-[13px] text-down">
              {err}
            </p>
          )}
          <p className="mt-4 text-[14px] text-ink-3">Nothing is sent until you press Send. It goes to the person who runs Copybook, and changes nothing on your plan.</p>
        </form>
        )
      ) : (
        <p className="mt-3 text-[17px] leading-relaxed text-ink-2">
          This link is missing its code. You can reply to the email instead, or write to{' '}
          <a href="mailto:hello@factordynamics.com" className="font-medium text-accent hover:text-accent-2">
            hello@factordynamics.com
          </a>
          . Your plan is on{' '}
          <Link to="/account/" className="font-medium text-accent hover:text-accent-2">
            your account page
          </Link>
          .
        </p>
      )}
    </div>
  )
}
