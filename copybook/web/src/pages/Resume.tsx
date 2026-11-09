import { Link, useSearchParams } from 'react-router-dom'
import { Arrow } from '../components/ui'
import { api } from '../config'
import { useTitle } from '../lib/data'

// The paused-plan email's link lands here (copybook.factordynamics.com/resume/?t=...). Opening it changes
// nothing, so a mail scanner that follows links can't end a pause; the button posts the token to the API,
// which resumes the plan and sends the browser to /account/?resumed=1, signed in.
export function Resume() {
  useTitle('Resume your plan · Copybook')
  const [params] = useSearchParams()
  const t = params.get('t') ?? ''
  return (
    <div className="container-x max-w-2xl pt-12 md:pt-16">
      <p className="text-[13px] font-medium text-accent">Account</p>
      <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Resume your plan.</h1>
      {t ? (
        <>
          <p className="mt-3 text-[17px] leading-relaxed text-ink-2">Real-time alerts and billing start again today. Your follows, names and settings are just as you left them.</p>
          {/* The action is set again on submit: the API base may have changed since render (api.json). */}
          <form method="POST" action={`${api}/resume?t=${encodeURIComponent(t)}`} onSubmit={(e) => (e.currentTarget.action = `${api}/resume?t=${encodeURIComponent(t)}`)} className="mt-8">
            <button type="submit" className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-medium text-white hover:bg-ink/90">
              Resume now <Arrow />
            </button>
          </form>
          <p className="mt-4 text-[14px] text-ink-3">
            Changed your mind? Close this page and nothing changes. Your plan stays paused until the date in your email.
          </p>
        </>
      ) : (
        <p className="mt-3 text-[17px] leading-relaxed text-ink-2">
          This link is missing its code. Resume from{' '}
          <Link to="/account/" className="font-medium text-accent hover:text-accent-2">
            your account page
          </Link>{' '}
          instead.
        </p>
      )}
    </div>
  )
}
