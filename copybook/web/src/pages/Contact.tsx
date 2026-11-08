import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button, Check } from '../components/ui'
import { api } from '../config'
import { useTitle } from '../lib/data'

// Posts to {api}/fund-request: Fund access requests, support questions and data deletion requests.
type Topic = 'fund' | 'support' | 'delete'
const TOPICS: [Topic, string][] = [
  ['fund', 'Copy Fund access'],
  ['support', 'A question or problem'],
  ['delete', 'Delete my data'],
]

const field = 'h-11 w-full rounded-xl bg-paper px-3.5 text-[15px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]'

export function Contact() {
  useTitle('Contact · Copybook')
  const [params] = useSearchParams()
  const [topic, setTopic] = useState<Topic>((TOPICS.find(([k]) => k === params.get('topic'))?.[0] as Topic) ?? 'fund')
  const [form, setForm] = useState({ name: '', email: '', fund: '', seats: '5', invoice: true, message: '', website: '' })
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [err, setErr] = useState('')
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const fund = topic === 'fund'

  const submit = async () => {
    setState('sending')
    try {
      const body = {
        topic,
        name: form.name.trim(),
        email: form.email.trim(),
        message: form.message.trim() || undefined,
        page: '/contact/',
        website: form.website || undefined,
        ...(fund ? { fund: form.fund.trim(), seats: Number(form.seats) || undefined, invoice: form.invoice, plan_interval: 'yearly' } : {}),
      }
      const r = await fetch(`${api}/fund-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (r.ok) return setState('sent')
      const j = (await r.json().catch(() => null)) as { error?: string; code?: string } | null
      setErr(r.status === 429 || j?.code === 'rate_limited' ? 'Too many requests from here in the last hour. Please try again later.' : j?.code === 'bad_request' && j.error ? `Please check the form: ${j.error}` : '')
      setState('error')
    } catch {
      setErr('')
      setState('error')
    }
  }

  return (
    <div className="container-x pt-12 md:pt-16">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <header className="max-w-md">
          <p className="text-[13px] font-medium text-accent">Contact</p>
          <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">{fund ? 'Copybook for your fund.' : 'Get in touch.'}</h1>
          {fund ? (
            <>
              <p className="mt-4 text-[17px] leading-relaxed text-ink-2">Copy Fund is everything in Copy Pro for a team: API access today, with 5 seats, a shared book and peer lists, and Slack alerts arriving this month.</p>
              <ul className="mt-6 space-y-2.5 text-[15px] text-ink-2">
                {['Founding price $1,990/yr, kept for as long as you stay subscribed', 'Invoiced when seats go live, not before', 'W-9 and invoice on request', 'Your uploaded book stays private to your team'].map((x) => (
                  <li key={x} className="flex gap-2.5">
                    <Check className="mt-1 shrink-0 text-accent" /> {x}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
              Questions about the data, your plan or your account. For how the numbers are built, see the{' '}
              <Link to="/methodology/" className="font-medium text-accent hover:text-accent-2">
                methodology
              </Link>
              .
            </p>
          )}
          <p className="mt-6 text-[15px] font-medium text-ink">Use the form; we reply within one business day.</p>
          <p className="mt-3 text-[13.5px] text-ink-3">
            Copybook is operated by Factor Dynamics. See our <Link to="/terms/" className="underline underline-offset-2 hover:text-ink">terms</Link>, <Link to="/privacy/" className="underline underline-offset-2 hover:text-ink">privacy</Link> and{' '}
            <Link to="/security/" className="underline underline-offset-2 hover:text-ink">security</Link> pages.
          </p>
        </header>

        <section className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)] md:p-8">
          {state === 'sent' ? (
            <div role="status" className="py-8 text-center">
              <span className="inline-flex size-11 items-center justify-center rounded-full bg-up text-white">
                <Check />
              </span>
              <h2 className="mt-4 text-[22px] font-semibold tracking-[-0.02em]">Thanks, it’s sent.</h2>
              <p className="mt-2 text-[15px] text-ink-2">{fund ? 'We’ll reply within one business day with access and an invoice.' : 'We’ll reply by email, usually within one business day.'}</p>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              <fieldset>
                <legend className="text-[13px] font-medium text-ink-2">What’s this about?</legend>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {TOPICS.map(([k, l]) => (
                    <label key={k} className={`cursor-pointer rounded-full px-3 py-1.5 text-[13.5px] ${topic === k ? 'bg-ink text-white' : 'bg-ink/[0.05] text-ink-2 hover:bg-ink/[0.08]'}`}>
                      <input type="radio" name="topic" value={k} checked={topic === k} onChange={() => setTopic(k)} className="sr-only" />
                      {l}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-[13px] font-medium text-ink-2">
                  Name
                  <input required value={form.name} onChange={set('name')} autoComplete="name" className={`${field} mt-1.5`} />
                </label>
                <label className="block text-[13px] font-medium text-ink-2">
                  {fund ? 'Work email' : 'Email'}
                  <input required type="email" value={form.email} onChange={set('email')} autoComplete="email" className={`${field} mt-1.5`} />
                </label>
              </div>
              {fund && (
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
                  <label className="block text-[13px] font-medium text-ink-2">
                    Fund or firm
                    <input required value={form.fund} onChange={set('fund')} autoComplete="organization" className={`${field} mt-1.5`} />
                  </label>
                  <label className="block text-[13px] font-medium text-ink-2">
                    Seats
                    <input type="number" min={1} max={100} value={form.seats} onChange={set('seats')} className={`${field} mt-1.5`} />
                  </label>
                </div>
              )}
              {fund && (
                <label className="flex cursor-pointer items-center gap-3 text-[14px]">
                  <input type="checkbox" checked={form.invoice} onChange={(e) => setForm((f) => ({ ...f, invoice: e.target.checked }))} className="size-4 accent-[var(--color-accent)]" />
                  Pay by invoice (yearly)
                </label>
              )}
              {/* Honeypot: people never see or fill it; the API drops requests that do. */}
              <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={set('website')} className="absolute left-[-10000px] size-px opacity-0" />
              <label className="block text-[13px] font-medium text-ink-2">
                {topic === 'delete' ? 'The email on your account, if different, and anything we should know' : 'Note'}
                <textarea value={form.message} onChange={set('message')} rows={4} className={`${field} mt-1.5 h-auto py-2.5`} />
              </label>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button type="submit" disabled={state === 'sending'}>
                  {state === 'sending' ? 'Sending…' : fund ? 'Request Fund access' : topic === 'delete' ? 'Request deletion' : 'Send'}
                </Button>
                {state === 'error' && (
                  <p role="alert" className="text-[13.5px] text-down">
                    {err || 'That didn’t send. Please try again in a moment.'}
                  </p>
                )}
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  )
}
