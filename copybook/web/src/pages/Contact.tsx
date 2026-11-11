import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button, Check } from '../components/ui'
import { api, apiReady, FUND_SEATS } from '../config'
import { useTitle } from '../lib/data'

// Posts to {api}/fund-request: Fund access requests, support questions and data deletion requests.
type Topic = 'fund' | 'support' | 'delete'
const TOPICS: [Topic, string][] = [
  ['fund', 'Copy Fund access'],
  ['support', 'A question or problem'],
  ['delete', 'Delete my data'],
]

const field = 'h-11 w-full rounded-xl bg-paper px-3.5 text-[15px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)] aria-[invalid=true]:shadow-[0_0_0_2px_var(--color-down)]'

// The no-card Fund trial (invoice_trial on /fund-request): the API's field names for what it says is missing.
const ADDRESS = { line1: 'Street address', line2: 'Suite, floor (optional)', city: 'City', state: 'State or region', postal_code: 'Postal code', country: 'Country (2 letters)' } as const
type Started = { trial_end: string; invoice_on: string; due_on: string; sign_in_email?: string; po?: string | null; ap_email?: string | null; email?: string }
const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: iso.length === 10 ? 'UTC' : undefined })

export function Contact() {
  useTitle('Contact · Copybook')
  const [params] = useSearchParams()
  const [topic, setTopic] = useState<Topic>((TOPICS.find(([k]) => k === params.get('topic'))?.[0] as Topic) ?? 'fund')
  const [form, setForm] = useState({ name: '', email: '', fund: '', seats: String(FUND_SEATS), invoice: true, message: '', website: '', line1: '', line2: '', city: '', state: '', postal_code: '', country: 'US', po: '', ap_email: '' })
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [err, setErr] = useState<React.ReactNode>('')
  // Fund only: start the 14-day trial now and pay by invoice (no card), or just ask us.
  const [trial, setTrial] = useState(params.get('trial') === 'invoice')
  const [bad, setBad] = useState<string[]>([])
  // The API's hint for the highlighted fields (400 bad_request `error`), shown under the first of them; and whether
  // the answer is a message rather than an error (409 trial_used and already_member: the request is in hand).
  const [hint, setHint] = useState('')
  const [notice, setNotice] = useState(false)
  const [started, setStarted] = useState<Started | null>(null)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const fund = topic === 'fund'
  const invoiceTrial = fund && trial
  const invalid = (k: string) => bad.some((f) => f === k || f.startsWith(`${k} `) || f === `billing_address.${k}` || f.startsWith(`billing_address.${k} `))
  const ORDER = ['email', 'fund', 'line1', 'line2', 'city', 'state', 'postal_code', 'country', 'ap_email']
  const hintAt = hint ? ORDER.find(invalid) : undefined
  const hintFor = (k: string) =>
    hintAt === k && (
      <span role="alert" className="mt-1 block text-[12.5px] font-normal text-down">
        {hint}
      </span>
    )

  const submit = async () => {
    setState('sending')
    try {
      const body = {
        topic,
        name: form.name.trim(),
        email: form.email.trim(),
        // "More than 10" has no seat number; it reaches us at the top of the note.
        message: [fund && form.seats === 'more' ? `Team size: more than ${FUND_SEATS}.` : '', form.message.trim()].filter(Boolean).join('\n') || undefined,
        page: '/contact/',
        website: form.website || undefined,
        ...(fund ? { fund: form.fund.trim(), seats: Number(form.seats) || undefined, invoice: invoiceTrial || form.invoice, plan_interval: 'yearly' } : {}),
        ...(invoiceTrial
          ? {
              invoice_trial: true,
              billing_address: { line1: form.line1.trim(), line2: form.line2.trim() || undefined, city: form.city.trim(), state: form.state.trim() || undefined, postal_code: form.postal_code.trim(), country: form.country.trim().toUpperCase() },
              po: form.po.trim() || undefined,
              ap_email: form.ap_email.trim() || undefined,
            }
          : {}),
      }
      setBad([])
      setHint('')
      setNotice(false)
      await apiReady
      const r = await fetch(`${api}/fund-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = (await r.json().catch(() => null)) as ({ error?: string; code?: string; fields?: string[]; trial?: string } & Partial<Started>) | null
      if (r.ok) {
        if (invoiceTrial && j?.trial === 'started' && j.trial_end && j.invoice_on && j.due_on) setStarted({ trial_end: j.trial_end, invoice_on: j.invoice_on, due_on: j.due_on, sign_in_email: j.sign_in_email, po: j.po ?? (form.po.trim() || null), ap_email: j.ap_email ?? (form.ap_email.trim().toLowerCase() || null), email: form.email.trim() })
        return setState('sent')
      }
      const throwaway = j?.code === 'freemail' || j?.code === 'disposable'
      setBad(throwaway ? ['email'] : (j?.fields ?? []))
      if (j?.code === 'bad_request' && j.fields?.length && j.error) {
        // "missing or invalid: billing_address.country must be 2 letters" reads "Must be 2 letters" under the field.
        const h = j.error.replace(/^missing or invalid:\s*/i, '').replace(/^[a-z_]+(\.[a-z0-9_]+)*\s*(:\s*)?/i, (m) => (j.fields!.some((f) => m.trim().replace(/:$/, '') === f) ? '' : m))
        setHint(h ? h[0].toUpperCase() + h.slice(1) : '')
      }
      setNotice(j?.code === 'trial_used' || j?.code === 'already_member')
      setErr(
        r.status === 429 || j?.code === 'rate_limited' ? (
          'Too many requests from here in the last hour. Please try again later.'
        ) : throwaway ? (
          'Use your work email: an invoice trial goes to a company address.'
        ) : j?.code === 'trial_used' ? (
          'Your company has already had a Copy Fund trial. We have your request and will email you to set up an invoice.'
        ) : j?.code === 'already_member' ? (
          <>
            This address already has a Copybook subscription.{' '}
            <Link to="/account/" className="font-medium underline underline-offset-2">
              Sign in
            </Link>
            , or switch to invoice billing in your account.
          </>
        ) : r.status >= 500 && invoiceTrial ? (
          'We couldn’t start the trial just now. We’ve got your request and will email you today.'
        ) : j?.code === 'bad_request' ? (
          j.fields?.length ? 'Please fill in or fix the highlighted fields.' : `Please check the form${j.error ? `: ${j.error}` : '.'}`
        ) : (
          ''
        ),
      )
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
              <p className="mt-4 text-[17px] leading-relaxed text-ink-2">Copy Fund is everything in Pro for up to {FUND_SEATS} seats at a flat price: each seat signs in on its own, and the team shares one book, watchlist and peer list. The API, signed webhooks and Slack alerts are included.</p>
              <ul className="mt-6 space-y-2.5 text-[15px] text-ink-2">
                {['Founding price $1,990/yr for teams that subscribe before Dec 31, kept for as long as you stay subscribed', 'Invoiced yearly, net 30', 'W-9 available once our entity details are published', 'Your uploaded book stays private to your team', 'Prices exclude applicable taxes. Copybook does not currently collect sales tax.'].map((x) => (
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
          <p className="mt-6 text-[15px] font-medium text-ink">
            Use the form, or email{' '}
            <a href="mailto:hello@factordynamics.com" className="text-accent hover:text-accent-2">
              hello@factordynamics.com
            </a>
            . We reply within one business day.
          </p>
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
              {started ? (
                <>
                  <h2 className="mt-4 text-[22px] font-semibold tracking-[-0.02em]">Your 14-day trial has started.</h2>
                  <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-ink-2">
                    {started.sign_in_email === 'not_sent' ? (
                      <>
                        We couldn’t send your sign-in email just now; we’ll retry. You can also sign in from{' '}
                        <Link to="/account/" className="font-medium text-accent hover:text-accent-2">
                          /account/
                        </Link>{' '}
                        with this address.
                      </>
                    ) : (
                      'Check your inbox to sign in.'
                    )}{' '}
                    The invoice for $1,990 (the founding price, a year) comes on {day(started.invoice_on)}, due {day(started.due_on)}; nothing is charged before then. It’s payable online by card or US bank account (ACH). Cancel before {day(started.invoice_on)} in your account and nothing is owed.
                    {/* Stripe emails the invoice to the owner; from 17:00 Nov 11 the AP address gets a copy when it's finalized (payments). */}{' '}
                    The invoice {started.po ? `will show PO ${started.po} and ` : ''}goes to {started.email}
                    {started.ap_email ? `; your AP team (${started.ap_email}) gets a copy, and it’s printed on the invoice` : ''}.
                  </p>
                </>
              ) : (
                <>
                  <h2 className="mt-4 text-[22px] font-semibold tracking-[-0.02em]">Thanks, it’s sent.</h2>
                  <p className="mt-2 text-[15px] text-ink-2">{fund ? 'We’ll reply within one business day with your invoice and team access.' : 'We’ll reply by email, usually within one business day.'}</p>
                </>
              )}
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
              {fund && (
                <fieldset>
                  <legend className="text-[13px] font-medium text-ink-2">How do you want to start?</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {([
                      [true, 'Start a 14-day trial now', '14-day trial, no card. Invoice on day 14, Net 30.'],
                      [false, 'Talk to us first', 'We reply within one business day.'],
                    ] as const).map(([v, t, d]) => (
                      <label key={t} className={`cursor-pointer rounded-xl px-3.5 py-2.5 text-[14px] ${trial === v ? 'bg-ink/[0.04] shadow-[0_0_0_2px_var(--color-ink)]' : 'shadow-[0_0_0_1px_var(--color-line-2)] hover:bg-ink/[0.03]'}`}>
                        <input type="radio" name="start" checked={trial === v} onChange={() => setTrial(v)} className="sr-only" />
                        <span className="block font-medium text-ink">{t}</span>
                        <span className="block text-[12.5px] text-ink-3">{d}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-[13px] font-medium text-ink-2">
                  Name
                  <input required value={form.name} onChange={set('name')} autoComplete="name" className={`${field} mt-1.5`} />
                </label>
                <label className="block text-[13px] font-medium text-ink-2">
                  {fund ? 'Work email' : 'Email'}
                  <input required type="email" value={form.email} onChange={set('email')} autoComplete="email" aria-invalid={invalid('email')} className={`${field} mt-1.5`} />
                  {hintFor('email')}
                </label>
              </div>
              {fund && (
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
                  <label className="block text-[13px] font-medium text-ink-2">
                    Fund or firm
                    <input required value={form.fund} onChange={set('fund')} autoComplete="organization" aria-invalid={invalid('fund')} className={`${field} mt-1.5`} />
                    {hintFor('fund')}
                  </label>
                  <label className="block text-[13px] font-medium text-ink-2">
                    Team size (flat price, up to {FUND_SEATS})
                    <select value={form.seats} onChange={set('seats')} className={`${field} mt-1.5`}>
                      {Array.from({ length: FUND_SEATS }, (_, i) => String(i + 1)).map((n) => (
                        <option key={n} value={n}>
                          {n === '1' ? '1 person' : `${n} people`}
                        </option>
                      ))}
                      <option value="more">More than {FUND_SEATS} (tell us in the note)</option>
                    </select>
                  </label>
                </div>
              )}
              {invoiceTrial && (
                <fieldset className="space-y-4">
                  <legend className="text-[13px] font-medium text-ink-2">Billing address, for the invoice</legend>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {(Object.keys(ADDRESS) as (keyof typeof ADDRESS)[]).map((k) => (
                      <label key={k} className="block text-[13px] font-medium text-ink-2">
                        {ADDRESS[k]}
                        <input
                          required={k !== 'line2' && k !== 'state'}
                          value={form[k]}
                          onChange={set(k)}
                          maxLength={k === 'country' ? 2 : undefined}
                          autoComplete={{ line1: 'address-line1', line2: 'address-line2', city: 'address-level2', state: 'address-level1', postal_code: 'postal-code', country: 'country' }[k]}
                          aria-invalid={invalid(k)}
                          className={`${field} mt-1.5`}
                        />
                        {hintFor(k)}
                      </label>
                    ))}
                  </div>
                  <div className="grid gap-4">
                    <label className="block text-[13px] font-medium text-ink-2">
                      PO number (optional)
                      <input value={form.po} onChange={set('po')} className={`${field} mt-1.5`} />
                    </label>
                    <label className="block text-[13px] font-medium text-ink-2">
                      Accounts payable email (optional; AP gets a copy, and it’s printed on the invoice)
                      <input type="email" value={form.ap_email} onChange={set('ap_email')} aria-invalid={invalid('ap_email')} className={`${field} mt-1.5`} />
                      {hintFor('ap_email')}
                    </label>
                  </div>
                  <p className="text-[12.5px] leading-relaxed text-ink-3">Both are printed on the invoice, and AP gets a copy. $1,990 a year at the founding price, invoiced on day 14, Net 30, payable online by card or US bank account (ACH). Prices exclude applicable taxes. Copybook does not currently collect sales tax.</p>
                </fieldset>
              )}
              {fund && !invoiceTrial && (
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
                  {state === 'sending' ? 'Sending…' : invoiceTrial ? 'Start the 14-day trial' : fund ? 'Request Fund access' : topic === 'delete' ? 'Request deletion' : 'Send'}
                </Button>
                {fund && state !== 'error' && <p className="text-[13px] text-ink-3">{invoiceTrial ? 'Starts at once; your sign-in link comes by email.' : 'We reply within one business day.'}</p>}
                {state === 'error' &&
                  (notice ? (
                    <p role="status" className="text-[13.5px] text-ink-2">
                      {err}
                    </p>
                  ) : (
                    <p role="alert" className="text-[13.5px] text-down">
                      {err || 'That didn’t send. Please try again in a moment.'}
                    </p>
                  ))}
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  )
}
