import { useState } from 'react'
import { requestLogin } from '../lib/account'

const LEAD = {
  step: 'Confirm your email to turn on alerts, channels and tests',
  saved: 'Saved. Alerts start when you confirm your email',
  follow: 'Confirm your email to follow',
}

/** A provisional session's standing reminder (account step 0, a follow): which address has the sign-in link, and
 *  a Resend. Persistent, never a toast, so a control that waits on the link never looks like it silently failed. */
export function ConfirmEmail({ email, kind = 'step', className = '' }: { email: string; kind?: keyof typeof LEAD; className?: string }) {
  const [sent, resend] = useResend(email)
  return (
    <p role="status" className={`rounded-xl bg-[#fdf3e1] px-3.5 py-2.5 text-[13.5px] leading-snug text-[#7a4b06] ${className}`}>
      {LEAD[kind]}: link sent to <span className="font-medium break-all">{email}</span>
      {' · '}
      <button type="button" onClick={resend} disabled={sent === 'busy' || sent === 'sent'} className="font-medium underline underline-offset-2 hover:text-[#5c3804] disabled:no-underline">
        {sent === 'busy' ? 'Sending…' : sent === 'sent' ? 'Sent again' : 'Resend'}
      </button>
      {sent === 'error' && ' That didn’t send. Please try again in a minute.'}
    </p>
  )
}

/** "Resend" for the sign-in link, as a text button: beside a follow toggle that's on while alerts wait for it. */
export function ResendLink({ email }: { email: string }) {
  const [sent, resend] = useResend(email)
  return (
    <button type="button" onClick={resend} disabled={sent === 'busy' || sent === 'sent'} title={`Resend the confirmation link to ${email}`} className="whitespace-nowrap text-[12.5px] font-medium text-[#7a4b06] underline underline-offset-2 hover:text-[#5c3804] disabled:no-underline">
      {sent === 'busy' ? 'Sending…' : sent === 'sent' ? 'Sent again' : sent === 'error' ? 'Retry resend' : 'Resend link'}
    </button>
  )
}

function useResend(email: string) {
  const [sent, setSent] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle')
  const resend = () => {
    setSent('busy')
    requestLogin(email).then(
      () => setSent('sent'),
      () => setSent('error'),
    )
  }
  return [sent, resend] as const
}
