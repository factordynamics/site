import { loadFilers, loadIndex, useAsync, useTitle } from '../lib/data'
import { Link } from 'react-router-dom'
import { Onboarding } from '../components/Onboarding'
import { ApiKeys } from '../components/ApiKeys'
import { Channels, FailingBanner } from '../components/Channels'
import { Team } from '../components/Team'
import { FundSetup } from '../components/FundSetup'
import { UpgradePro } from '../components/UpgradePro'
import { FreeNames } from '../components/FreeNames'
import { CopySetup } from '../components/CopySetup'
import { dayLabel, Paused } from '../components/Paused'
import { CsvButton } from '../components/CsvButton'
import { resetFollows, saveFollows, useFollows } from '../lib/follows'
import { stockPath } from '../lib/stocks'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { WaitlistForm } from '../components/Waitlist'
import { Arrow, Badge, Button, Check, Monogram, Skeleton } from '../components/ui'
import { api, checkout, DATA_TERMS, plans, renewalTerms, trialTerms, TRIAL_DAYS } from '../config'
import { ApiError, apiDown, downloadFile, fetchMe, getToken, readMe, isFree, openPortal, pausePlan, PLAN_NAME, requestLogin, sendCancelReason, setAlerts, signOut, startSession, type CancelReason, type Member } from '../lib/account'

type State = { kind: 'loading' } | { kind: 'in'; member: Member; welcome: boolean; focus?: boolean; upgraded?: string; kept?: string; resumed?: boolean } | { kind: 'out'; error?: string } | { kind: 'off' } | { kind: 'down' }

export function Account() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  useTitle('Account · Copybook')
  const [state, setState] = useState<State>(() => (api ? { kind: 'loading' } : { kind: 'off' }))

  useEffect(() => {
    if (!api) return
    const sid = params.get('session_id')
    const login = params.get('login')
    // Back from Stripe (checkout=success, or a checkout session id) or a plan=pro link.
    const welcome = params.get('checkout') === 'success' || Boolean(sid?.startsWith('cs_'))
    const pro = params.get('plan') === 'pro'
    // Back from the billing portal's plan change: /me flips when Stripe's webhook lands, usually within seconds.
    const upgraded = params.get('upgraded') ?? undefined
    // Back from the day-11 trial email's switch to yearly.
    const kept = params.get('kept') ?? undefined
    // The resume email's link (signed in, ?resumed=1), or Resume now on this page.
    const resumed = params.get('resumed') === '1'
    const run = async () => {
      try {
        let member: Member
        if (sid?.startsWith('cs_')) member = await startSession({ checkout_session: sid })
        else if (login) member = await startSession({ login })
        else if (getToken()) member = await readMe()
        else return setState({ kind: 'out' })
        for (let i = 0; upgraded && member.plan !== upgraded && i < 8; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          member = await fetchMe()
        }
        resetFollows()
        // The Pro quickstart takes focus after a Pro checkout; a Fund checkout starts at the Fund setup list.
        setState({ kind: 'in', member, welcome, upgraded, kept, resumed, focus: pro || (welcome && member.plan === 'pro') || (upgraded === 'pro' && member.plan === 'pro') })
      } catch {
        // The API is over its limit or down: say so, and keep the link in the address bar so a reload retries it.
        if (apiDown()) return setState({ kind: 'down' })
        setState({ kind: 'out', error: sid ? 'We couldn’t confirm that checkout. If you were charged, sign in to Stripe billing below or refresh in a minute.' : login ? 'That sign-in link has expired. Enter your email for a new one.' : undefined })
      }
      if (sid || login || upgraded || kept) nav('/account/', { replace: true })
    }
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="container-x max-w-3xl pt-12 md:pt-16">
      {state.kind === 'loading' && (
        <div className="space-y-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="mt-8 h-40 w-full" />
        </div>
      )}
      {state.kind === 'down' && (
        <section role="alert" className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
          <h1 className="text-[24px] font-semibold tracking-[-0.03em]">Your account is temporarily unavailable.</h1>
          <p className="mt-2 text-[15px] text-ink-2">Our account server isn’t answering right now. Your plan, follows and saved names are safe. Please reload this page later; nothing here needs redoing.</p>
        </section>
      )}
      {state.kind === 'in' && <SignedIn member={state.member} welcome={state.welcome} upgraded={state.upgraded} kept={state.kept} resumed={state.resumed} focus={state.focus} onOut={() => setState({ kind: 'out' })} onChange={(member) => setState((s) => ({ kind: 'in', member, welcome: false, resumed: s.kind === 'in' && Boolean(s.member.paused_until) && !member.paused_until }))} />}
      {state.kind === 'out' && <SignedOut error={state.error} />}
      {state.kind === 'off' && <NotOpen />}
      <p className="mt-10 text-[13px] leading-relaxed text-ink-3">{DATA_TERMS}</p>
    </div>
  )
}

function SignedIn({ member, welcome, upgraded, kept, resumed = false, focus = false, onOut, onChange }: { member: Member; welcome: boolean; upgraded?: string; kept?: string; resumed?: boolean; focus?: boolean; onOut: () => void; onChange: (m: Member) => void }) {
  const [busy, setBusy] = useState(false)
  const { status, follows } = useFollows()
  const [editing, setEditing] = useState(false)
  const cancelling = Boolean(member.cancel_at_period_end)
  const paused = Boolean(member.paused_until)
  const endRaw = cancelling && member.cancel_at ? member.cancel_at : member.status === 'trialing' && member.trial_end ? member.trial_end : member.period_end
  const end = endRaw ? new Date(typeof endRaw === 'number' ? endRaw * 1000 : endRaw) : null
  // Member-facing dates are on New York's calendar, like EDGAR's.
  const endLabel = end?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
  const trial = member.status === 'trialing'
  const alertMode = member.alerts === 'off' ? 'off' : Array.isArray(member.alerts) ? 'follows' : 'all'
  const idx = useAsync(loadIndex, [])
  // Any 13F filer can be followed; names outside the curated set come from filers.json, loaded only when needed.
  const curatedNames = new Map((idx.data?.managers ?? []).map((m) => [m.slug, m.manager]))
  const needFilers = Boolean(idx.data) && follows.investors.some((s) => !curatedNames.has(s))
  const filerNames = useAsync(() => (needFilers ? loadFilers() : Promise.resolve([])), [needFilers])
  const names = new Map([...(filerNames.data ?? []).map((f) => [f.slug, f.name] as const), ...curatedNames])
  const onboard = member.active && status === 'ready' && (!follows.onboarded || editing)
  if (isFree(member)) return <Free member={member} onOut={onOut} />
  return (
    <>
      <header>
        {upgraded ? (
          <>
            <span className={`inline-flex size-11 items-center justify-center rounded-full text-white ${member.plan === upgraded ? 'bg-up' : 'bg-ink-3'}`}>
              <Check />
            </span>
            <h1 className="mt-5 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">
              {member.plan === upgraded ? `You’re on Copy ${upgraded === 'fund' ? 'Fund' : 'Pro'}.` : 'Confirming your upgrade.'}
            </h1>
            <p className="mt-3 text-[17px] text-ink-2">
              {member.plan === upgraded
                ? 'Same billing date and interval; Stripe is emailing the prorated invoice.'
                : 'Stripe is still confirming the change. Refresh in a minute; you won’t be charged twice.'}
            </p>
          </>
        ) : resumed && member.active && !member.paused_until ? (
          <>
            <span className="inline-flex size-11 items-center justify-center rounded-full bg-up text-white">
              <Check />
            </span>
            <h1 className="mt-5 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">You’ve resumed.</h1>
            <p className="mt-3 text-[17px] text-ink-2">
              Real-time alerts are back on
              {end ? ` · next charge ${end.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' })} ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}` : ''}.
            </p>
          </>
        ) : welcome ? (
          <>
            <span className="inline-flex size-11 items-center justify-center rounded-full bg-up text-white">
              <Check />
            </span>
            <h1 className="mt-5 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Welcome to Copy.</h1>
            <p className="mt-3 text-[17px] text-ink-2">
              {trial ? `Your free trial runs until ${endLabel}. Stripe is emailing your confirmation.` : 'Your payment went through. Stripe is emailing your receipt.'}
            </p>
          </>
        ) : (
          <>
            <p className="text-[13px] font-medium text-accent">Account</p>
            <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Your Copy subscription.</h1>
          </>
        )}
      </header>

      {kept === 'yearly' && (
        <p role="status" className="mt-6 flex items-center gap-2 rounded-xl bg-[#e3f1e8] px-4 py-3 text-[14px] text-[#126b3c]">
          <Check className="size-4 shrink-0" /> You’re on yearly billing now. Stripe is emailing the confirmation.
        </p>
      )}

      {member.active && <FailingBanner initial={member.channels_failing} onAccount />}

      {member.active && member.plan === 'fund' && <FundSetup member={member} welcome={welcome} />}
      {member.active && member.plan === 'copy' && !member.seat && <CopySetup welcome={welcome} />}

      {onboard && (
        <div className="mt-10">
          <Onboarding
            shared={member.plan === 'fund'}
            onDone={(m) => {
              setEditing(false)
              if (m) onChange(m)
            }}
          />
        </div>
      )}

      <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-2">
        <section className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Plan</h2>
            <Badge tone={cancelling || paused ? 'warn' : trial ? 'accent' : member.active ? 'up' : 'warn'}>{paused ? 'Paused' : cancelling ? 'Cancelled' : trial ? 'Free trial' : member.active ? 'Active' : member.status}</Badge>
          </div>
          <p className="mt-3 text-[14px] text-ink-2">{member.email}</p>
          <p className="mt-1 text-[14px] text-ink-2">
            {PLAN_NAME[member.plan] ?? 'Copy'}
            {member.interval === 'yearly' ? ', yearly' : member.interval === 'monthly' ? ', monthly' : ''}
            {endLabel && !cancelling && !paused && ` · ${trial ? `trial ends ${endLabel}` : member.active ? `renews ${endLabel}` : `ends ${endLabel}`}`}
          </p>
          {member.seat ? (
            <p className="mt-4 rounded-xl bg-accent-soft px-3.5 py-2.5 text-[14px] text-accent-2">
              Part of {member.owner ? `${member.owner}’s` : 'your team’s'} Copy Fund plan. Billing and seats are managed by the plan owner.
            </p>
          ) : (
            <>
          {paused ? (
            <Paused until={member.paused_until!} digest={Boolean(member.digest_live)} onChange={onChange} />
          ) : (
            <>
          {cancelling && (
            <p className="mt-3 rounded-xl bg-[#fdf3e1] px-3.5 py-2.5 text-[14px] text-[#7a4b06]">
              Your plan ends {endLabel ?? 'at the end of this period'}. You keep everything until then and won’t be charged again.
            </p>
          )}
          <Button
            variant="dark"
            className="mt-5"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              openPortal().catch(() => {
                setBusy(false)
                if (checkout.portal) window.location.href = checkout.portal
              })
            }}
          >
            {busy ? 'Opening…' : cancelling ? 'Resume plan' : 'Manage billing'} <Arrow />
          </Button>
          <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">
            {cancelling ? 'Resume in the billing portal to keep your plan, follows and alerts without a gap.' : trial ? trialTerms(member.plan) : renewalTerms(member.plan)}
          </p>
          {!cancelling && member.interval === 'monthly' && !trial && <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">Monthly plans can pause between seasons{member.digest_live ? '; your names digest keeps coming' : ''}.</p>}
          {!cancelling && <Leave member={member} onChange={onChange} />}
            </>
          )}
            </>
          )}
        </section>
        <section className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
          <h2 className="text-[15px] font-semibold">Filing alerts</h2>
          {paused ? (
            <p className="mt-1 text-[14px] font-medium text-[#7a4b06]">Real-time alerts are off while paused. Your choices below come back when you resume.</p>
          ) : (
            <p className="mt-1 text-[14px] text-ink-2">An email with the moves inside, usually within a couple of minutes of a new 13F on EDGAR. Form 4 and 13D filings by funds you follow usually arrive within minutes.{' '}
              <Link to="/speed/" className="font-medium text-accent hover:text-accent-2">
                Live speed
              </Link>
            </p>
          )}
          <fieldset disabled={paused} className={`mt-4 space-y-2.5 text-[14px] ${paused ? 'opacity-50' : ''}`}>
            <legend className="sr-only">Send alerts for</legend>
            {(
              [
                [
                  'follows',
                  `Investors I follow + stocks I own or watch${follows.investors.length || follows.stocks.length ? ` (${follows.investors.length} + ${follows.stocks.length})` : ''}`,
                  'Stocks alert when a hedge fund or active manager trades them, never banks, brokers or index funds.',
                ],
                ['all', `Every fund we track closely (${idx.data?.managers.length ?? 199})`, ''],
                ['off', 'Off', ''],
              ] as const
            ).map(([k, l, d]) => (
              <label key={k} className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="alerts"
                  className="mt-0.5 size-4 accent-[var(--color-accent)]"
                  checked={alertMode === k}
                  onChange={() => setAlerts(k === 'follows' ? follows.investors : k).then(onChange, () => null)}
                />
                <span>
                  <span className="block">{l}</span>
                  {d && <span className="block text-[12.5px] text-ink-3">{d}</span>}
                </span>
              </label>
            ))}
          </fieldset>
          {status === 'ready' && (
            <fieldset disabled={paused} className={`mt-5 space-y-2.5 border-t border-line pt-4 text-[14px] ${paused ? 'opacity-50' : ''}`}>
              <legend className="sr-only">Alert options</legend>
              {(
                [
                  ['include_13g', 'Also Schedule 13G filings', 'Passive 5% stakes. Big asset managers file many of these.'],
                  ['digest', 'One daily digest', 'A single email after EDGAR closes, about 10:30 pm ET, instead of one per filing.'],
                ] as const
              ).map(([k, l, d]) => (
                <label key={k} className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={follows[k]} onChange={(e) => saveFollows({ [k]: e.target.checked }).catch(() => null)} />
                  <span>
                    <span className="block">{l}</span>
                    <span className="block text-[12.5px] text-ink-3">{d}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {status === 'ready' && (
            <fieldset disabled={paused} className={paused ? 'opacity-50' : ''}>
              <InsiderSettings />
            </fieldset>
          )}
        </section>
      </div>

      {member.active && member.plan === 'copy' && !member.seat && !member.cancel_at_period_end && <UpgradePro member={member} className="mt-5" />}
      {member.active && member.referral && <Referral r={member.referral} />}
      {member.active && member.plan === 'fund' && !member.seat && <Team />}
      {member.active && PLAN_NAME[member.plan ?? 'copy'] && <Channels />}
      {member.active && <ApiKeys member={member} focus={focus} />}

      {(member.active || paused) && status === 'ready' && follows.onboarded && !editing && (
        <section className="mt-5 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              Following
              {member.plan === 'fund' && <Badge tone="accent">Shared with your team</Badge>}
            </h2>
            <span className="flex flex-wrap items-center gap-1">
              {follows.investors.length > 0 && <CsvButton variant="outline" label="Latest 13F holdings (CSV)" download={() => downloadFile('/follows.csv', `copybook-followed-${new Date().toISOString().slice(0, 10)}.csv`)} />}
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            </span>
          </div>
          {follows.investors.length + follows.stocks.length === 0 ? (
            <p className="mt-2 text-[14px] text-ink-2">Nothing yet. Press Follow on any investor or stock page.</p>
          ) : (
            <>
              <ul className="mt-3 flex flex-wrap gap-2">
                {follows.investors.map((slug) => (
                  <li key={slug}>
                    <Link to={`/investors/${slug}/`} className="inline-flex items-center gap-2 rounded-full bg-paper py-1 pl-1 pr-3 text-[13px] shadow-[0_0_0_1px_var(--color-line)] hover:shadow-[0_0_0_1px_var(--color-ink-3)]">
                      <Monogram name={names.get(slug) ?? slug} size={22} />
                      {names.get(slug) ?? slug}
                    </Link>
                  </li>
                ))}
              </ul>
              {follows.stocks.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {follows.stocks.map((t) => (
                    <li key={t}>
                      <Link to={stockPath(t)} className="inline-flex items-center gap-1.5 rounded-full bg-paper px-3 py-1 text-[13px] shadow-[0_0_0_1px_var(--color-line)] hover:shadow-[0_0_0_1px_var(--color-ink-3)]">
                        <span className="font-mono font-medium">{t}</span>
                        {follows.owned.includes(t) && <span className="text-[11.5px] text-ink-3">owned</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-[12.5px] text-ink-3">You’ll get a fund’s 13F email whenever it changes a position in one of these stocks, even if you don’t follow the fund.</p>
            </>
          )}
        </section>
      )}

      <div className="mt-8 flex flex-wrap gap-3">
        <Button to="/flow/">See this season’s flow</Button>
        <Button
          variant="ghost"
          onClick={() => {
            signOut()
            resetFollows()
            onOut()
          }}
        >
          Sign out
        </Button>
      </div>
    </>
  )
}

// "Give a month, get a month": the member's referral link (GET /me referral), a copy button and the counts.
function Referral({ r }: { r: NonNullable<Member['referral']> }) {
  const [copied, setCopied] = useState(false)
  return (
    <section className="mt-5 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]" aria-labelledby="referral-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 id="referral-title" className="text-[15px] font-semibold">
            Give a month, get a month
          </h2>
          <p className="mt-1 text-[14px] text-ink-2">Anyone who starts Copy from your link gets their first month free. When they pay for the first time, a month of your plan is credited to your bill, and we email you.</p>
        </div>
        <dl className="flex gap-6 text-[13px]">
          {(
            [
              ['Signed up', r.signups],
              ['Paying', r.paid],
              ['Months earned', r.months_earned],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-ink-3">{k}</dt>
              <dd className="num mt-0.5 text-[20px] font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="mt-4 flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-full bg-paper px-4 py-2 font-mono text-[13px] text-ink-2 shadow-[0_0_0_1px_var(--color-line)]" title={r.url}>
          {r.url}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            navigator.clipboard.writeText(r.url).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
    </section>
  )
}

// A free account from the Friday email signup: no paid plan, so no billing, follows or alerts here.
function Free({ member, onOut }: { member: Member; onOut: () => void }) {
  return (
    <>
      <header>
        <p className="text-[13px] font-medium text-accent">Account</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">You’re on the free Friday email.</h1>
        <p className="mt-3 text-[17px] text-ink-2">Every Friday evening: the week’s five biggest buys and sells by the investors we track, from SEC filings. Sent to {member.email}.</p>
      </header>
      <FreeNames className="mt-10" />
      <section className="mt-5 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">What Copy adds</h2>
        </div>
        <ul className="mt-4 space-y-2.5 text-[14px] text-ink-2">
          {['An email minutes after each 13F, Form 4 and 13D on EDGAR, with the moves inside', 'Follow investors and the stocks you own or watch, and see who holds them in My book', '8 quarters of history for the funds we track closely, with CSV export'].map((t) => (
            <li key={t} className="flex gap-2.5">
              <Check className="mt-0.5 shrink-0 text-accent" /> {t}
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button to="/pricing/">
            Start {TRIAL_DAYS}-day trial <Arrow />
          </Button>
          <span className="text-[13px] text-ink-3">Copy is free for {TRIAL_DAYS} days, then ${plans.copy.yearly}/year or ${plans.copy.monthly}/month.</span>
        </div>
      </section>
      <p className="mt-6 text-[13px] text-ink-3">To stop the Friday email, use the unsubscribe link at the bottom of any issue.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button to="/season/" variant="outline">
          Follow this filing season
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            signOut()
            resetFollows()
            onOut()
          }}
        >
          Sign out
        </Button>
      </div>
    </>
  )
}

function SignedOut({ error }: { error?: string }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  return (
    <>
      <header>
        <p className="text-[13px] font-medium text-accent">Account</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Sign in to Copy.</h1>
        <p className="mt-3 text-[17px] text-ink-2">No password. We’ll email you a sign-in link.</p>
      </header>
      {error && <p className="mt-6 rounded-xl bg-[#f6ead2] px-4 py-3 text-[14px] text-[#7a5410]">{error}</p>}
      <section className="mt-8 max-w-lg rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
        {sent ? (
          <p role="status" className="text-[15px]">
            If that address has Copy, a sign-in link is on its way.
          </p>
        ) : (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault()
              requestLogin(email.trim()).finally(() => setSent(true))
            }}
          >
            <label htmlFor="login-email" className="sr-only">
              Email address
            </label>
            <input
              id="login-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="h-11 min-w-0 flex-1 rounded-full bg-paper px-4 text-[15px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
            />
            <Button type="submit" className="h-11">
              Email me a link
            </Button>
          </form>
        )}
      </section>
      <p className="mt-6 text-[14px] text-ink-2">
        Need your billing details now?{' '}
        <a href={checkout.portal} className="font-medium text-accent hover:text-accent-2">
          Sign in to Stripe billing
        </a>
        .
      </p>
      <p className="mt-2 text-[14px] text-ink-2">
        Don’t have Copy yet?{' '}
        <Button to="/pricing/" variant="ghost" size="sm">
          See plans <Arrow />
        </Button>
      </p>
    </>
  )
}

function NotOpen() {
  return (
    <>
      <header>
        <p className="text-[13px] font-medium text-accent">Account</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">Copy opens with the Q3 filings.</h1>
        <p className="mt-3 text-[17px] text-ink-2">Quarter-over-quarter changes, 8 quarters of 13F history and CSV export, and filing-day alerts. Join and we’ll email you the moment it opens.</p>
      </header>
      <div className="mt-8 max-w-lg">
        <WaitlistForm id="wl-account" />
      </div>
    </>
  )
}

/** Insider and 13D alerts on the stocks a member owns or watches ({api}/follows fields). */
function InsiderSettings() {
  const { follows } = useFollows()
  const fmt = (n: number) => n.toLocaleString('en-US')
  const [min, setMin] = useState(fmt(follows.insider_min_usd))
  const [minErr, setMinErr] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => setMin(fmt(follows.insider_min_usd)), [follows.insider_min_usd])
  // "100,000", "$100000" and "0" are fine; letters, negatives and decimals are not.
  const commitMin = () => {
    const t = min.trim().replace(/^\$\s*/, '').replace(/,/g, '')
    if (!/^\d+$/.test(t)) return setMinErr('Enter a whole dollar amount of 0 or more, like 100,000.')
    setMinErr('')
    const n = Number(t)
    setMin(fmt(n))
    if (n !== follows.insider_min_usd) save({ insider_min_usd: n })
  }
  const save = (patch: Parameters<typeof saveFollows>[0]) =>
    saveFollows(patch).then(
      () => setErr(''),
      (e) => setErr(e instanceof ApiError && e.detail ? e.detail : 'That didn’t save. Please try again.'),
    )
  const box = (k: 'insider_buys' | 'cluster_buys' | 'any_13d', l: string, d: string, extra?: ReactNode) => (
    <div key={k} className="flex items-start gap-3">
      <input id={`f-${k}`} type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={follows[k]} onChange={(e) => save({ [k]: e.target.checked })} />
      <span>
        <label htmlFor={`f-${k}`} className="block cursor-pointer">
          {l}
        </label>
        <span className="block text-[12.5px] text-ink-3">{d}</span>
        {extra}
      </span>
    </div>
  )
  return (
    <fieldset className="mt-5 space-y-2.5 border-t border-line pt-4 text-[14px]">
      <legend className="mb-2.5 text-[13px] font-medium text-ink-2">On stocks you own or watch</legend>
      {box(
        'insider_buys',
        'Insider buys',
        'Open-market purchases (Form 4 code P) by the company’s directors, officers or 10% owners.',
        follows.insider_buys && (
          <span className="mt-2 flex items-center gap-2 text-[13px] text-ink-2">
            <label htmlFor="f-insider-min">Only buys of at least</label>
            <span className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3">$</span>
              <input
                id="f-insider-min"
                inputMode="numeric"
                value={min}
                aria-invalid={Boolean(minErr)}
                aria-describedby={minErr ? 'f-insider-min-err' : undefined}
                onChange={(e) => setMin(e.target.value)}
                onBlur={commitMin}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                className={`num h-8 w-32 rounded-lg bg-paper pl-6 pr-2 outline-none focus:shadow-[0_0_0_2px_var(--color-accent)] ${minErr ? 'shadow-[0_0_0_1.5px_var(--color-down)]' : 'shadow-[0_0_0_1px_var(--color-line-2)]'}`}
              />
            </span>
          </span>
        ),
      )}
      {minErr && (
        <p id="f-insider-min-err" role="alert" className="-mt-1 pl-7 text-[13px] text-down">
          {minErr}
        </p>
      )}
      {box('cluster_buys', 'Cluster buys', 'Three or more insiders of one company buying within 30 days. At most one alert per company every 30 days.')}
      {box('any_13d', 'Any filer’s 13D or 13G', 'A new Schedule 13D or 13G by anyone, not only the funds you follow.')}
      {err && (
        <p role="alert" className="text-[13px] text-down">
          {err}
        </p>
      )}
    </fieldset>
  )
}

const REASONS: [CancelReason, string][] = [
  ['seasonal', 'Seasonal: nothing happens between filings'],
  ['price', 'It costs too much'],
  ['value', 'I’m not using it enough'],
  ['feature', 'It’s missing something I need'],
  ['alerts', 'The alerts weren’t useful'],
  ['other', 'Something else'],
]

/** Leaving: one question, then Pause until the next season (monthly members) ahead of cancelling in the portal. */
function Leave({ member, onChange }: { member: Member; onChange: (m: Member) => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<CancelReason | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'pause' | 'cancel' | null>(null)
  const [err, setErr] = useState('')
  const offer = member.pause_offer
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 min-h-9 text-[13px] text-ink-3 underline underline-offset-2 hover:text-ink-2">
        {offer ? 'Pause or cancel' : 'Cancel plan'}
      </button>
    )
  return (
    <div className="mt-5 rounded-xl bg-paper p-4 shadow-[0_0_0_1px_var(--color-line)]">
      <fieldset>
        <legend className="text-[14px] font-medium">What’s the main reason?</legend>
        <div className="mt-2 space-y-1.5 text-[14px]">
          {REASONS.map(([k, l]) => (
            <label key={k} className="flex min-h-8 cursor-pointer items-center gap-2.5">
              <input type="radio" name="leave" className="size-4 accent-[var(--color-accent)]" checked={reason === k} onChange={() => setReason(k)} />
              {l}
            </label>
          ))}
        </div>
      </fieldset>
      {reason && (reason === 'feature' || reason === 'other') && (
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What would have made it worth keeping? (optional)" className="mt-3 w-full rounded-xl bg-card px-3 py-2 text-[14px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none focus:shadow-[0_0_0_2px_var(--color-accent)]" />
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {offer && (
          <Button
            variant="dark"
            disabled={!reason || busy !== null}
            onClick={async () => {
              setBusy('pause')
              setErr('')
              try {
                await pausePlan(reason!)
                onChange(await fetchMe())
              } catch (e) {
                setErr(e instanceof ApiError && e.detail ? e.detail : 'The pause didn’t go through. Please try again.')
                setBusy(null)
              }
            }}
          >
            {busy === 'pause' ? 'Pausing…' : `Pause until ${dayLabel(offer.until)}`}
          </Button>
        )}
        <Button
          variant="outline"
          disabled={!reason || busy !== null}
          onClick={async () => {
            setBusy('cancel')
            setErr('')
            await sendCancelReason(reason!, note.trim() || undefined).catch(() => null)
            openPortal().catch(() => {
              setBusy(null)
              if (checkout.portal) window.location.href = checkout.portal
            })
          }}
        >
          {busy === 'cancel' ? 'Opening…' : 'Continue to cancel'}
        </Button>
        <button type="button" onClick={() => setOpen(false)} className="min-h-9 px-2 text-[13px] text-ink-3 hover:text-ink-2">
          Keep my plan
        </button>
      </div>
      {offer && <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">Pausing stops charges and real-time alerts until {dayLabel(offer.until)}{offer.quarter ? `, in time for the ${offer.quarter.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1')} 13F season` : ''}. {member.digest_live ? ' The weekly digest of your names keeps coming, your' : ' Your'} follows and settings stay, and we’ll email you before it resumes.</p>}
      {err && <p role="alert" className="mt-2 text-[13px] text-down">{err}</p>}
    </div>
  )
}
