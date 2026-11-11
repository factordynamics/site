import { timeLabel } from '../components/Paused'
import { useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { Arrow, Button, Check, Skeleton } from '../components/ui'
import { BOOK_PRO, FUND_SEATS, plans, TRIAL_DAYS } from '../config'
import { ApiError, isFree, openPortal, PLAN_NAME, upgradeTo, useMemberState, type Member } from '../lib/account'
import { useTitle } from '../lib/data'

// /upgrade/?plan=pro|fund: the plan change before Stripe's confirm page. It keeps the member's interval
// and founding price, estimates the prorated amount, and hands off to POST /upgrade (a billing-portal
// confirm session on the same subscription). The portal is the fallback when that call fails.

const RANK: Record<string, number> = { copy: 1, pro: 2, fund: 3 }
const ADDS: Record<'pro' | 'fund', [string, string][]> = {
  pro: [
    [BOOK_PRO.t, BOOK_PRO.d],
    ['API keys and signed webhooks', 'Holdings for every filer, Form 4 and 13D/G as JSON, 60 requests a minute per key.'],
    ['Peer overlap', 'Compare your book with the funds you benchmark against, quarter by quarter.'],
  ],
  fund: [
    [`${FUND_SEATS} seats`, 'Your team shares one book, one set of follows and one team channel, where each alert posts once.'],
    ['Seat admin', 'Add and remove seats from your account page, and sign a departing colleague out everywhere at once (API keys keep working; Remove a seat to cut all access).'],
    ['Everything in Copy Pro', 'Full My book across every 13F filer, peers, 13F linking, CSV and the API.'],
    ['Annual invoice', 'Net 30 with a W-9, if your fund pays that way.'],
  ],
}
const dateOf = (v?: number | string | null) => (v == null ? null : new Date(typeof v === 'number' ? v * 1000 : v))
const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export function Upgrade() {
  const [params] = useSearchParams()
  const target: 'pro' | 'fund' = params.get('plan') === 'fund' ? 'fund' : 'pro'
  useTitle(`Upgrade to ${PLAN_NAME[target]} · Copybook`)
  const member = useMemberState()
  // Copy is the entry plan: there's nothing to switch to, so its trial starts on the pricing page.
  if (params.get('plan') === 'copy') return <Navigate to="/pricing/#copy" replace />
  return (
    <div className="container-x max-w-3xl pt-12 md:pt-16">
      <p className="text-[13px] font-medium text-accent">Upgrade</p>
      <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Switch to {PLAN_NAME[target]}.</h1>
      {member === undefined ? (
        <div className="mt-8 space-y-3">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <Body member={member} target={target} />
      )}
    </div>
  )
}

function Body({ member, target }: { member: Member | null; target: 'pro' | 'fund' }) {
  const name = PLAN_NAME[target]
  // Forwarded links reach people with no account (often a fund's ops team): the invoice path never needs a login.
  const other =
    target === 'fund' ? (
      <Paths
        left={['Pay by invoice', 'Annual invoice, net 30, with a W-9. No account needed; we set up the plan when you reply.', <Button to="/contact/?topic=fund" className="mt-3 w-full">Request an invoice (net 30, W-9)</Button>]}
        right={['Pay by card', 'Sign in with the email on your Copy plan to switch it to Fund, prorated.', <Button to="/account/" variant="outline" className="mt-3 w-full">Sign in to switch</Button>]}
      />
    ) : (
      <Paths
        left={['New to Copybook', `Start Copy Pro free for ${TRIAL_DAYS} days.`, <Button to="/pricing/" className="mt-3 w-full">Start {TRIAL_DAYS}-day free trial</Button>]}
        right={['Already on Copy', 'Sign in with the email on your plan to switch it to Pro, prorated.', <Button to="/account/" variant="outline" className="mt-3 w-full">Sign in to switch</Button>]}
      />
    )
  if (!member)
    return (
      <>
        <Note>Switching an existing plan needs a sign-in. {target === 'fund' ? 'Paying by invoice doesn’t.' : ''}</Note>
        {other}
      </>
    )
  if (member.seat)
    return (
      <Note>
        Your seat is part of your team’s Copy Fund plan. {member.owner ? (
          <>
            Ask{' '}
            <a href={`mailto:${member.owner}?subject=${encodeURIComponent('Copybook plan change')}`} className="font-medium text-accent hover:text-accent-2">
              {member.owner}
            </a>{' '}
            (plan owner) to change it.
          </>
        ) : (
          'Ask your team’s plan owner to change it.'
        )}
      </Note>
    )
  if (isFree(member))
    return (
      <>
        <Note>You’re on the free Friday email, so there’s no paid plan to switch yet.</Note>
        {target === 'fund' ? (
          <Paths
            left={['Pay by invoice', 'Annual invoice, net 30, with a W-9. We set up the plan when you reply.', <Button to="/contact/?topic=fund" className="mt-3 w-full">Request an invoice (net 30, W-9)</Button>]}
            right={['Pay by card', `Start Copy Fund free for ${TRIAL_DAYS} days.`, <Button to="/pricing/" variant="outline" className="mt-3 w-full">Start {TRIAL_DAYS}-day free trial</Button>]}
          />
        ) : (
          <div className="mt-6">
            <Button to="/pricing/">
              Start {TRIAL_DAYS}-day free trial <Arrow />
            </Button>
          </div>
        )}
      </>
    )
  if (!member.active)
    return (
      <Note>
        Your plan isn’t active. <LinkTo to="/pricing/">Choose a plan</LinkTo> to start again.
      </Note>
    )
  if (member.plan === target)
    return (
      <Note>
        You’re already on {name}. <LinkTo to="/account/">Back to your account</LinkTo>
      </Note>
    )
  if ((RANK[member.plan] ?? 1) > RANK[target])
    return (
      <Note>
        You’re on {PLAN_NAME[member.plan] ?? member.plan}, which includes everything in {name}. <LinkTo to="/account/">Back to your account</LinkTo>
      </Note>
    )
  return <Change member={member} target={target} />
}

function Change({ member, target }: { member: Member; target: 'pro' | 'fund' }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const yearly = member.interval !== 'monthly'
  const from = plans[(member.plan in plans ? member.plan : 'copy') as keyof typeof plans]
  const to = plans[target]
  const price = (p: typeof to) => (yearly ? `$${p.yearly.toLocaleString('en-US')}/yr` : `$${p.monthly.toLocaleString('en-US')}/mo`)
  const trial = member.status === 'trialing'
  const end = dateOf(trial ? member.trial_end : member.period_end)
  // Stripe prorates by time left in the period; this is the estimate, and its confirm page shows the exact amount.
  const left = end ? Math.max(0, (end.getTime() - Date.now()) / 864e5) : null
  const span = yearly ? 365 : 30
  const diff = yearly ? to.yearly - from.yearly : to.monthly - from.monthly
  const estimate = left != null ? Math.round((diff * Math.min(left, span)) / span) : null
  const cancelling = Boolean(member.cancel_at_period_end)
  const go = () => {
    setBusy(true)
    setErr(null)
    upgradeTo(target).catch(async (e) => {
      setBusy(false)
      if (e instanceof ApiError && e.code === 'upgrade_unavailable') return setErr(e.detail ?? 'Stripe couldn’t change this plan. Open Manage billing to check it.')
      if (e instanceof ApiError && e.code === 'already_on_plan') return window.location.assign(`${import.meta.env.BASE_URL}account/`)
      // Anything else (a network error, the API down): the billing portal can still change the plan.
      await openPortal().catch(() => setErr('Billing is unreachable right now. Please try again in a minute.'))
    })
  }
  return (
    <>
      <p className="mt-3 text-[17px] text-ink-2">
        Same {yearly ? 'yearly' : 'monthly'} billing and renewal date, at the founding price. {trial ? 'You’re in your free trial, so nothing is charged today.' : 'You pay only the difference for the rest of this period.'}
      </p>

      <section className="mt-8 rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]" aria-label="Plan change">
        <dl className="divide-y divide-line text-[14px]">
          <Line k="Now" v={`${from.name} · ${price(from)}`} />
          <Line k="After" v={<span className="font-semibold">{`${to.name} · ${price(to)}`}</span>} sub="Founding price, kept for as long as you stay subscribed" />
          <Line k="Billing" v={`${yearly ? 'Yearly' : 'Monthly'}, unchanged`} sub={end ? `${trial ? 'Trial ends' : 'Next renewal'} ${timeLabel(end.getTime() / 1000)}` : undefined} />
          <Line
            k="Today"
            v={trial ? '$0' : estimate != null ? `About $${estimate.toLocaleString('en-US')}` : 'Prorated'}
            sub={
              trial
                ? `${to.name}’s price applies when your trial ends${end ? ` on ${fmt(end)}` : ''}.`
                : `Prorated for the ${left != null ? `${Math.ceil(left)} days` : 'time'} left in this period. Stripe shows the exact amount, with tax, before you confirm.`
            }
          />
        </dl>
        <div className="border-t border-line p-5 md:p-6">
          {cancelling && <p className="mb-3 text-[13.5px] text-[#8a5a0b]">Your plan is set to end. Stripe may ask you to resume it before switching.</p>}
          {target === 'fund' ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-xl bg-paper p-4">
                <p className="text-[14px] font-semibold">Switch now</p>
                <p className="mt-1 min-h-[2.5em] text-[13px] text-ink-2">On your card, prorated, with seats ready right away.</p>
                <Button onClick={go} disabled={busy} className="mt-3 w-full">
                  {busy ? 'Opening Stripe…' : 'Switch now (card, prorated)'}
                </Button>
              </div>
              <div className="rounded-xl bg-paper p-4">
                <p className="text-[14px] font-semibold">Pay by invoice</p>
                <p className="mt-1 min-h-[2.5em] text-[13px] text-ink-2">Annual invoice, net 30, with a W-9. We set up the plan when you reply.</p>
                <Button to="/contact/?topic=fund" variant="outline" className="mt-3 w-full">
                  Request an invoice (net 30, W-9)
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={go} disabled={busy} size="lg">
              {busy ? 'Opening Stripe…' : 'Continue to confirm'} <Arrow />
            </Button>
          )}
          {err && (
            <p role="alert" className="mt-3 text-[13.5px] text-down">
              {err}
            </p>
          )}
          <p className="mt-3 text-[12.5px] text-ink-3">Nothing changes until you confirm on Stripe’s page. You come back to your account when it’s done.</p>
        </div>
      </section>

      <section className="mt-6 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:p-6" aria-labelledby="adds">
        <h2 id="adds" className="text-[15px] font-semibold">
          What {to.name} adds
        </h2>
        <ul className="mt-3 space-y-3 text-[14px]">
          {ADDS[target].map(([t, d]) => (
            <li key={t} className="flex gap-2.5">
              <Check className="mt-0.5 shrink-0 text-accent" />
              <span>
                <span className="font-medium">{t}</span>
                <span className="block text-[13px] text-ink-3">{d}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[13px] text-ink-3">
          Full comparison on <LinkTo to="/pricing/">Pricing</LinkTo>.
        </p>
      </section>
    </>
  )
}

function Line({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-4 md:px-6">
      <dt className="w-24 text-ink-3">{k}</dt>
      <dd className="min-w-0 flex-1 text-right">
        <span className="num">{v}</span>
        {sub && <span className="block text-[12.5px] text-ink-3">{sub}</span>}
      </dd>
    </div>
  )
}
function Paths({ left, right }: { left: [string, string, React.ReactNode]; right: [string, string, React.ReactNode] }) {
  return (
    <div className="mt-6 grid max-w-2xl gap-3 md:grid-cols-2">
      {[left, right].map(([t, d, b]) => (
        <div key={t} className="rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)]">
          <p className="text-[14px] font-semibold">{t}</p>
          <p className="mt-1 min-h-[2.5em] text-[13px] text-ink-2">{d}</p>
          {b}
        </div>
      ))}
    </div>
  )
}
const Note = ({ children }: { children: React.ReactNode }) => <p className="mt-4 max-w-xl text-[16px] text-ink-2">{children}</p>
const LinkTo = ({ to, children }: { to: string; children: React.ReactNode }) => (
  <Link to={to} className="font-medium text-accent hover:text-accent-2">
    {children}
  </Link>
)
