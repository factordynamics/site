import { Link, useSearchParams } from 'react-router-dom'
import { Arrow } from '../components/ui'
import { api } from '../config'
import { useTitle } from '../lib/data'

const REASONS: Record<string, string> = {
  price: 'Too expensive',
  seasonal: 'Only need it in filing season',
  not_using: 'Not using it enough',
  data: 'Missing data I need',
  other: 'Something else',
}

// The cancel email's reason links land here (copybook.factordynamics.com/why/?t=...&r=...). Opening it
// records nothing, so a mail scanner that follows links can't send a reason; the button form-posts t, r
// and the optional note to the API, which answers with its own thank-you page.
export function Why() {
  useTitle('Why you cancelled · Copybook')
  const [params] = useSearchParams()
  const t = params.get('t') ?? ''
  const r = params.get('r') ?? ''
  const reason = REASONS[r]
  return (
    <div className="container-x max-w-2xl pt-12 md:pt-16">
      <p className="text-[13px] font-medium text-accent">Account</p>
      <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Tell us why you cancelled.</h1>
      {t && reason ? (
        <form method="POST" action={`${api}/why`} onSubmit={(e) => (e.currentTarget.action = `${api}/why`)} className="mt-6">
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
            placeholder={r === 'data' ? 'Which data were you missing?' : 'What would have kept you?'}
            className="mt-2 w-full rounded-xl bg-paper px-3.5 py-2.5 text-[15px] leading-relaxed shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
          />
          <button type="submit" className="mt-5 inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-medium text-white hover:bg-ink/90">
            Send <Arrow />
          </button>
          <p className="mt-4 text-[14px] text-ink-3">Nothing is sent until you press Send. It goes to the person who runs Copybook, and changes nothing on your plan.</p>
        </form>
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
