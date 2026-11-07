import { useState } from 'react'
import { joinWaitlist } from '../lib/waitlist'
import { Button, Check } from './ui'

export function WaitlistForm({ cta = 'Join the waitlist', dark = false, id = 'wl' }: { cta?: string; dark?: boolean; id?: string }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  if (state === 'done')
    return (
      <p role="status" className={`flex items-center gap-2 text-[15px] font-medium ${dark ? 'text-white' : 'text-ink'}`}>
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-up text-white">
          <Check className="size-3.5" />
        </span>
        You’re on the list. We’ll email you when Copy opens.
      </p>
    )
  return (
    <form
      className="flex w-full flex-col gap-2 sm:flex-row"
      onSubmit={async (e) => {
        e.preventDefault()
        const v = email.trim()
        if (!/^\S+@\S+\.\S+$/.test(v)) return setState('error')
        setState('sending')
        try {
          await joinWaitlist(v)
          setState('done')
        } catch {
          setState('error')
        }
      }}
    >
      <label htmlFor={id} className="sr-only">
        Email address
      </label>
      <input
        id={id}
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value)
          if (state === 'error') setState('idle')
        }}
        placeholder="you@example.com"
        className={`h-11 min-w-0 flex-1 rounded-full px-4 text-[15px] outline-none ${dark ? 'bg-white/10 text-white placeholder:text-white/50 focus:ring-2 focus:ring-white/60' : 'bg-card shadow-[0_0_0_1px_var(--color-line-2)] placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]'}`}
      />
      <Button type="submit" size="md" className="h-11" disabled={state === 'sending'}>
        {state === 'sending' ? 'Joining…' : cta}
      </Button>
      {state === 'error' && (
        <p role="alert" className={`text-[13px] sm:hidden ${dark ? 'text-white/80' : 'text-down'}`}>
          Check the email address and try again.
        </p>
      )}
    </form>
  )
}
