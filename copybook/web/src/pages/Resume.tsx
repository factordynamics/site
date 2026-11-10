import { Link, useSearchParams } from 'react-router-dom'
import { Arrow } from '../components/ui'
import { api } from '../config'
import { useTitle } from '../lib/data'
import { PLAN_NAME, useMember } from '../lib/account'
import { dayLabel } from '../components/Paused'

// The paused-plan email's link lands here (copybook.factordynamics.com/resume/?t=...). Opening it changes
// nothing, so a mail scanner that follows links can't end a pause; the button posts the token to the API,
// which resumes the plan and sends the browser to /account/?resumed=1, signed in.
export function Resume() {
  useTitle('Keep your plan · Copybook')
  const [params] = useSearchParams()
  const t = params.get('t') ?? ''
  // Signed in on this browser: word the page for what the link undoes. Otherwise it stays generic.
  const m = useMember()
  const plan = PLAN_NAME[m?.plan ?? ''] ?? 'Copy'
  const pausedNow = Boolean(m?.paused_until && m.paused_until * 1000 > Date.now())
  const billFrom = (m?.status === 'trialing' ? m.trial_end : m?.period_end) ?? null
  const title = m?.cancel_at_period_end ? `Keep your ${plan} plan.` : pausedNow ? `Resume your ${plan} plan.` : 'Keep your plan.'
  const lead = m?.cancel_at_period_end
    ? `This undoes the cancellation. ${billFrom ? `Billing starts ${m.status === 'trialing' ? '' : 'again '}${dayLabel(billFrom)}, as before.` : 'Billing continues as before.'} Your follows, names and settings stay as they are.`
    : pausedNow
      ? 'Real-time alerts and billing start again today. Your follows, names and settings are just as you left them.'
      : 'This lifts a pause or a cancellation on your plan. Your follows, names and settings are just as you left them.'
  return (
    <div className="container-x max-w-2xl pt-12 md:pt-16">
      <p className="text-[13px] font-medium text-accent">Account</p>
      <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">{title}</h1>
      {t ? (
        <>
          <p className="mt-3 text-[17px] leading-relaxed text-ink-2">{lead}</p>
          {/* The action is set again on submit: the API base may have changed since render (api.json). */}
          <form method="POST" action={`${api}/resume?t=${encodeURIComponent(t)}`} onSubmit={(e) => {
              e.currentTarget.action = `${api}/resume?t=${encodeURIComponent(t)}`
              sessionStorage.setItem('copybook-resume-sent', String(Date.now()))
            }} className="mt-8">
            <button type="submit" className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-medium text-white hover:bg-ink/90">
              Keep my plan <Arrow />
            </button>
          </form>
          <p className="mt-4 text-[14px] text-ink-3">
            Changed your mind? Close this page and nothing changes.
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
