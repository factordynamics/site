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
import { dayLabel, Paused, timeLabel } from '../components/Paused'
import { CsvButton } from '../components/CsvButton'
import { resetFollows, saveFollows, useFollows } from '../lib/follows'
import { loadExpected, seasonStatus, stockPath } from '../lib/stocks'
import { isReadOnly, refreshFollows, setFollow } from '../lib/follows'
import { useEffect, useState, type ReactNode } from 'react'
import { Signup } from '../components/Signup'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Arrow, Badge, Button, Check, Monogram, Skeleton } from '../components/ui'
import { api, checkout, DATA_TERMS, plans, renewalTerms, trialTerms, TRIAL_DAYS } from '../config'
import { ApiStatus, Updating } from '../components/ApiStatus'
import { ApiError, call, errText, needsVerify, signOutEverywhere, apiDown, cachedFresh, downloadFile, fetchMe, getToken, lastMe, needsReauth, readMe, isFree, openPortal, pausePlan, resumePlan, PLAN_NAME, requestLogin, sendCancelReason, setAlerts, signOut, startSession, type CancelReason, type Member } from '../lib/account'

type State = { kind: 'loading' } | { kind: 'in'; member: Member; welcome: boolean; focus?: boolean; upgraded?: string; kept?: string; resumed?: boolean; stale?: boolean } | { kind: 'out'; error?: string } | { kind: 'off' } | { kind: 'down' }

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
        let started: Member | null = null
        if (sid?.startsWith('cs_')) started = await startSession({ checkout_session: sid })
        else if (login) started = await startSession({ login })
        // A checkout for an address that already had an account: keep this browser's session, or ask for the emailed link.
        if (sid && !started && !getToken()) {
          nav('/account/', { replace: true })
          return setState({ kind: 'out', error: 'Your subscription is active. Sign in with the link we emailed you.' })
        }
        if (sid || login) member = await fetchMe().catch(() => started as Member)
        else if (getToken()) {
          // The last-known account renders at once, marked updating, so a slow API isn't a blank page.
          const last = cachedFresh() ? null : lastMe()
          if (last) setState({ kind: 'in', member: last, welcome: false, stale: true })
          member = await readMe()
        }
        else {
          // Back from /resume/ with no sign-in: the API sends a dead or expired resume link to plain /account/.
          const fromResume = Number(sessionStorage.getItem('copybook-resume-sent') ?? 0) > Date.now() - 5 * 60_000
          sessionStorage.removeItem('copybook-resume-sent')
          return setState({ kind: 'out', ...(fromResume ? { error: 'This link has expired. Sign in to manage your plan.' } : {}) })
        }
        for (let i = 0; upgraded && member.plan !== upgraded && i < 8; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          member = await fetchMe()
        }
        resetFollows()
        // The Pro quickstart takes focus after a Pro checkout; a Fund checkout starts at the Fund setup list.
        setState({ kind: 'in', member, welcome, upgraded, kept, resumed, focus: pro || (welcome && member.plan === 'pro') || (upgraded === 'pro' && member.plan === 'pro') })
      } catch (e) {
        // The API is over its limit or down: say so, and keep the link in the address bar so a reload retries it.
        // A failing API keeps the last-known account on screen (the status banner says why).
        if (apiDown() && getToken() && lastMe()) return setState({ kind: 'in', member: lastMe()!, welcome: false, stale: false })
        if (apiDown()) return setState({ kind: 'down' })
        setState({ kind: 'out', error: sid ? 'We couldn’t confirm that checkout. If you were charged, sign in to Stripe billing below or refresh in a minute.' : login ? (e instanceof ApiError && e.code === 'link_used' ? 'That sign-in link was already used. Enter your email for a new one.' : 'That sign-in link has expired. Enter your email for a new one.') : undefined })
      }
      if (sid || login || upgraded || kept) nav('/account/', { replace: true })
    }
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="container-x max-w-3xl pt-12 md:pt-16">
      {state.kind !== 'down' && state.kind !== 'out' && <ApiStatus className="mb-6" />}
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
          {/* A failing account server never removes the way to a plan or to billing. */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button to="/pricing/">Start {TRIAL_DAYS}-day free trial</Button>
            <Button href={checkout.portal} variant="outline">
              Manage billing on Stripe
            </Button>
          </div>
        </section>
      )}
      {state.kind === 'in' && <Updating show={Boolean(state.stale)} className="mb-4" />}
      {state.kind === 'in' && <SignedIn member={state.member} welcome={state.welcome} upgraded={state.upgraded} kept={state.kept} resumed={state.resumed} focus={state.focus} onOut={() => setState({ kind: 'out' })} onChange={(member) => setState((s) => ({ kind: 'in', member, welcome: false, resumed: s.kind === 'in' && Boolean(s.member.paused_until) && !member.paused_until }))} />}
      {state.kind === 'out' && <SignedOut error={state.error} />}
      {state.kind === 'off' && <NotOpen />}
      <p className="mt-10 text-[13px] leading-relaxed text-ink-3">{DATA_TERMS}</p>
    </div>
  )
}

function SignedIn({ member, welcome, upgraded, kept, resumed = false, focus = false, onOut, onChange }: { member: Member; welcome: boolean; upgraded?: string; kept?: string; resumed?: boolean; focus?: boolean; onOut: () => void; onChange: (m: Member) => void }) {
  const [busy, setBusy] = useState(false)
  // The billing portal opens in this tab; when neither the API's portal session nor the fallback link can open, say so.
  const [portalErr, setPortalErr] = useState('')
  const portal = () => {
    setBusy(true)
    setPortalErr('')
    openPortal().catch((e) => {
      setBusy(false)
      if (needsVerify(e)) return
      if (checkout.portal) window.location.href = checkout.portal
      else setPortalErr(errText(e, 'The billing portal didn’t open. Please try again, or email us.'))
    })
  }
  const { status, follows } = useFollows()
  const [editing, setEditing] = useState(false)
  const cancelling = Boolean(member.cancel_at_period_end)
  const paused = Boolean(member.paused_until)
  const endRaw = cancelling && member.cancel_at ? member.cancel_at : member.status === 'trialing' && member.trial_end ? member.trial_end : member.period_end
  const end = endRaw ? new Date(typeof endRaw === 'number' ? endRaw * 1000 : endRaw) : null
  // Member-facing dates are on New York's calendar, like EDGAR's.
  const endLabel = end ? timeLabel(end.getTime() / 1000) : undefined
  const trial = member.status === 'trialing'
  const alertMode = member.alerts === 'off' ? 'off' : Array.isArray(member.alerts) ? 'follows' : 'all'
  const idx = useAsync(loadIndex, [])
  // Any 13F filer can be followed; names outside the curated set come from filers.json, loaded only when needed.
  const curatedNames = new Map((idx.data?.managers ?? []).map((m) => [m.slug, m.manager]))
  const needFilers = Boolean(idx.data) && follows.investors.some((s) => !curatedNames.has(s))
  const filerNames = useAsync(() => (needFilers ? loadFilers() : Promise.resolve([])), [needFilers])
  // Each followed fund's season line ("Q3 filed …", "Q3 expected …", "Q3 due by …"), the helper free members' list uses.
  const soon = useAsync(loadExpected, [])
  const q3 = (slug: string) => (soon.data ? seasonStatus(idx.data?.managers.find((m) => m.slug === slug), soon.data.expected.find((x) => x.slug === slug))?.text : undefined)
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
              {trial ? `Your free trial runs until ${endLabel}. Check your inbox for your welcome email.` : 'Your payment went through. Stripe is emailing your receipt.'}
            </p>
          </>
        ) : (
          <>
            <p className="text-[13px] font-medium text-accent">Account</p>
            <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">{member.seat ? `Your ${PLAN_NAME[member.plan] ?? 'Copy Fund'} seat.` : `Your ${PLAN_NAME[member.plan] ?? 'Copy'} subscription.`}</h1>
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
            <Badge tone={cancelling || paused ? 'warn' : trial ? 'accent' : member.active ? 'up' : 'warn'}>{paused ? 'Paused' : cancelling ? 'Cancelled' : trial ? (member.collection === 'send_invoice' ? 'Invoice trial' : 'Free trial') : member.active ? 'Active' : member.status}</Badge>
          </div>
          <p className="mt-3 text-[14px] text-ink-2">{member.email}</p>
          <p className="mt-1 text-[14px] text-ink-2">
            {PLAN_NAME[member.plan] ?? 'Copy'}
            {member.interval === 'yearly' ? ', yearly' : member.interval === 'monthly' ? ', monthly' : ''}
            {member.pause_after_trial && !cancelling && !paused ? (
              <>
                {' · '}free trial until {timeLabel(member.trial_end ?? member.pause_after_trial.from)} → then paused until {dayLabel(member.pause_after_trial.until)} · no charges ·{' '}
                <UndoPause onChange={onChange} />
              </>
            ) : (
              endLabel && !cancelling && !paused && ` · ${trial ? `trial ends ${endLabel}` : member.active ? `renews ${endLabel}` : `ends ${endLabel}`}`
            )}
          </p>
          {member.seat ? (
            <p className="mt-4 rounded-xl bg-accent-soft px-3.5 py-2.5 text-[14px] text-accent-2">
              Part of {member.owner ? `${member.owner}’s` : 'your team’s'} Copy Fund plan. Billing and seats are managed by the plan owner.
            </p>
          ) : (
            <>
          {paused ? (
            <>
              <Paused until={member.paused_until!} digest={Boolean(member.digest_live)} onChange={onChange} />
              {/* Leaving doesn't need a resume first: billing (invoices, card, cancel) opens from here too. */}
              <p className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4 text-[14px]">
                {(['Manage billing', 'Cancel plan'] as const).map((label) => (
                  <button
                    key={label}
                    type="button"
                    disabled={busy}
                    onClick={portal}
                    className={`font-medium ${label === 'Cancel plan' ? 'text-ink-2 hover:text-down' : 'text-accent hover:text-accent-2'}`}
                  >
                    {label}
                  </button>
                ))}
                <span className="text-[12.5px] text-ink-3">Both open the Stripe billing portal; a paused plan cancels without being charged again.</span>
              </p>
            </>
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
            onClick={portal}
          >
            {busy ? 'Opening…' : cancelling ? 'Resume plan' : 'Manage billing'} <Arrow />
          </Button>
          {portalErr && (
            <p role="alert" className="mt-2 text-[13px] text-down">
              {portalErr}
            </p>
          )}
          {/* Adding a card in the portal doesn't change collection_method (payments, Nov 11). */}
          {member.collection === 'send_invoice' && !cancelling && <p className="mt-2 text-[12.5px] text-ink-3">Your invoice stays Net 30 even if you add a card.</p>}
          <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">
            {cancelling ? 'Resume in the billing portal to keep your plan, follows and alerts without a gap.' : member.collection === 'send_invoice' && member.invoice_trial ? invoiceTerms(member.invoice_trial) : member.collection === 'send_invoice' ? 'Billed by invoice (Net 30), payable online by card or US bank account (ACH). Each invoice comes by email; nothing is charged to a card.' : member.pause_after_trial ? `Nothing is charged until ${dayLabel(member.pause_after_trial.until)}. Real-time alerts stop when the trial ends and resume then; your follows and settings stay.` : trial ? trialTerms(member.plan) : renewalTerms(member.plan)}
          </p>
          {!cancelling && member.interval === 'monthly' && !trial && <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">Monthly plans can pause between seasons{member.digest_live ? '; your names digest keeps coming' : ''}.</p>}
          {!cancelling && member.plan === 'fund' && member.interval === 'yearly' && member.collection !== 'send_invoice' && <InvoiceSwitch onChange={onChange} />}
          {!cancelling && member.collection === 'send_invoice' && member.invoice_trial && <InvoiceDetails t={member.invoice_trial} onChange={onChange} />}
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
            <p className="mt-1 text-[14px] text-ink-2">An email with the moves inside for each new 13F, Form 4 and 13D from funds you follow. We poll EDGAR every minute; measured timings appear on /speed/ as alerts go out.{' '}
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
                  ['digest', 'One daily digest', 'A single email after EDGAR closes, about 10:30 pm ET, instead of one per filing. Without it, if several filings land within a couple of minutes, you get them in one email.'],
                  // Shown once the weekly email has gone to a real member (/me digest_live).
                  ...(member.digest_live ? ([['weekly_digest', 'Weekly “Your names this week” email', 'Fridays, about 9:15 pm ET: what the superinvestors did in your names that week.']] as const) : []),
                ] as const
              ).map(([k, l, d]) => (
                <label key={k} className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={follows[k] ?? true} onChange={(e) => saveFollows({ [k]: e.target.checked }).catch(() => null)} />
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
      {member.active && member.referral && member.plan !== 'fund' && <Referral r={member.referral} />}
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
                      {q3(slug) && <span className="text-[12px] text-ink-3">· {q3(slug)}</span>}
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
        <SignOutEverywhere />
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
// Signed sessions aren't stored, so signing out here ends only this browser's; this ends every one, copied
// tokens included, and keeps this browser signed in.
function SignOutEverywhere() {
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  return (
    <span className="flex flex-col items-start">
      <Button
        variant="ghost"
        onClick={async () => {
          if (!confirm('Sign out everywhere? Every other browser and device is signed out at once, including a copied session. This browser stays signed in. API keys keep working until you delete them.')) return
          setMsg(null)
          try {
            await signOutEverywhere()
            setMsg({ text: 'Every other session is signed out.', ok: true })
          } catch (e) {
            setMsg({ text: errText(e, 'That didn’t go through. Please try again.'), ok: false })
          }
        }}
      >
        Sign out everywhere
      </Button>
      {msg && <span role="status" className={`mt-1 px-4.5 text-[12.5px] ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</span>}
    </span>
  )
}

function Free({ member, onOut }: { member: Member; onOut: () => void }) {
  return (
    <>
      <header>
        <p className="text-[13px] font-medium text-accent">Account</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">You’re on the free Friday email.</h1>
        <p className="mt-3 text-[17px] text-ink-2">Every Friday evening: moves by the investors and stocks you follow first, then the week’s five biggest buys and sells by the investors we track, from SEC filings. Sent to {member.email}.</p>
      </header>
      <FreeFollows />
      <FreeNames className="mt-10" />
      <section className="mt-5 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">What Copy adds</h2>
        </div>
        <ul className="mt-4 space-y-2.5 text-[14px] text-ink-2">
          {['An email for each 13F, Form 4 and 13D, checked on EDGAR every minute, with the moves inside', 'Follow investors and the stocks you own or watch, and see who holds them in My book', 'Up to 8 quarters of history for the funds we track closely, with CSV export'].map((t) => (
            <li key={t} className="flex gap-2.5">
              <Check className="mt-0.5 shrink-0 text-accent" /> {t}
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button to="/pricing/">
            Start {TRIAL_DAYS}-day free trial <Arrow />
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
        <SignOutEverywhere />
      </div>
    </>
  )
}

export function SignedOut({ error, eyebrow = 'Account' }: { error?: string; eyebrow?: string }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [delayed, setDelayed] = useState(false)
  // A stored session the API no longer accepts (401): most often one from before the server move.
  const moved = needsReauth()
  const note = error ?? (moved ? 'Please sign in again: we moved servers. Your plan, follows and saved names are all still here.' : undefined)
  return (
    <>
      <header>
        <p className="text-[13px] font-medium text-accent">{eyebrow}</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em]">{moved ? 'Please sign in again.' : 'Sign in to Copybook.'}</h1>
        <p className="mt-3 text-[17px] text-ink-2">No password. We’ll email you a sign-in link.</p>
      </header>
      {note && <p className="mt-6 rounded-xl bg-[#f6ead2] px-4 py-3 text-[14px] text-[#7a5410]">{note}</p>}
      {delayed && (
        <p role="alert" className="mt-6 rounded-xl bg-[#f6ead2] px-4 py-3 text-[14px] text-[#7a5410]">
          The sign-in email is delayed. Please try again in a minute.
        </p>
      )}
      <section className="mt-8 max-w-lg rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
        {sent ? (
          <p role="status" className="text-[15px]">
            Check your inbox: if that address has a Copybook account, a sign-in link is on its way.
          </p>
        ) : (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault()
              setSending(true)
              setDelayed(false)
              requestLogin(email.trim())
                .then(() => setSent(true))
                // A 4xx means the address was refused (shown as sent: we never say which addresses exist);
                // a 5xx or no answer means the email couldn't be queued yet.
                .catch((err) => (err instanceof ApiError && err.status < 500 && err.status !== 429 ? setSent(true) : setDelayed(true)))
                .finally(() => setSending(false))
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
            <Button type="submit" className="h-11" disabled={sending}>
              {sending ? 'Sending…' : 'Email me a link'}
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
        <p className="mt-3 text-[17px] text-ink-2">Quarter-over-quarter changes, up to 8 quarters of 13F history and CSV export, and filing-day alerts. Meanwhile, the free Friday email has the week’s top moves.</p>
      </header>
      <Signup source="account" className="mt-8" />
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

/** Cancels a pause scheduled for the trial's end (DELETE /pause), so the plan simply continues. */
function UndoPause({ onChange }: { onChange: (m: Member) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        setErr(false)
        try {
          await resumePlan()
          onChange(await fetchMe())
        } catch {
          setErr(true)
        }
        setBusy(false)
      }}
      className="font-medium text-accent hover:text-accent-2"
    >
      {busy ? 'Undoing…' : err ? 'Undo pause (try again)' : 'Undo pause'}
    </button>
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
/** A Fund owner on yearly billing moves the card subscription or trial to an invoice, Net 30 (POST /account/invoice). */
const shortDay = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
// `amount` is Stripe's integer cents (199000 for the founding Fund year).

/** The plan line for a Copy Fund trial billed by invoice (payments' /me invoice_trial). */
const invoiceTerms = (t: NonNullable<Member['invoice_trial']>) =>
  [
    // amount is in cents; records from before payments' 17:00 build read null until the hourly re-sync, so no amount then.
    `Invoice trial: ${t.amount != null ? `$${(t.amount / 100).toLocaleString('en-US')} invoice` : 'invoice'} on ${shortDay(t.invoice_on)}${t.invoice_to ? ` to ${t.invoice_to}` : ''}, due ${shortDay(t.due_on)} (Net 30)`,
    t.po && `PO ${t.po}`,
    t.ap_email && `AP ${t.ap_email} gets a copy, and it’s printed on the invoice`,
    'payable online by card or US bank account (ACH)',
    `cancel before ${shortDay(t.invoice_on)} and nothing is owed`,
  ]
    .filter(Boolean)
    .join(' · ')

/** Edit what prints on the invoice (POST /account/invoice with po and ap_email; an empty field clears it). */
function InvoiceDetails({ t, onChange }: { t: NonNullable<Member['invoice_trial']>; onChange: (m: Member) => void }) {
  const [open, setOpen] = useState(false)
  const [po, setPo] = useState(t.po ?? '')
  const [ap, setAp] = useState(t.ap_email ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const field = 'h-10 w-full rounded-lg bg-paper px-3 text-[14px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none focus:shadow-[0_0_0_2px_var(--color-accent)]'
  if (!open)
    return (
      <p className="mt-2 text-[13.5px]">
        <button type="button" onClick={() => setOpen(true)} className="font-medium text-accent hover:text-accent-2">
          Edit PO and AP email
        </button>
        {msg?.ok && <span className="ml-3 text-[12.5px] text-up">{msg.text}</span>}
      </p>
    )
  return (
    <form
      className="mt-3 grid max-w-xl gap-3 rounded-xl bg-ink/[0.03] p-3.5"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        setMsg(null)
        call<{ member?: Member }>('/account/invoice', { method: 'POST', body: { po: po.trim(), ap_email: ap.trim() }, auth: true })
          .then((r) => {
            if (r.member) onChange(r.member)
            setOpen(false)
            setMsg({ text: 'Saved. AP gets a copy, and it’s printed on the invoice.', ok: true })
          })
          .catch((e) => setMsg({ text: errText(e, e instanceof ApiError && e.detail ? e.detail : 'That didn’t save. Please try again, or email us.'), ok: false }))
          .finally(() => setBusy(false))
      }}
    >
      <label className="block text-[12.5px] font-medium text-ink-2">
        PO number
        <input value={po} onChange={(e) => setPo(e.target.value)} maxLength={140} className={`${field} mt-1`} />
      </label>
      <label className="block text-[12.5px] font-medium text-ink-2">
        AP email (gets a copy, and it’s printed on the invoice)
        {/* Wraps instead of scrolling, so a long AP address (46 characters at 390 px) reads in full. */}
        <textarea
          value={ap}
          onChange={(e) => setAp(e.target.value.replace(/\s+/g, ''))}
          rows={ap.length > 28 ? 2 : 1}
          inputMode="email"
          autoComplete="email"
          spellCheck={false}
          className={`${field} mt-1 h-auto resize-none break-all py-2 leading-snug`}
        />
      </label>
      <span className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </span>
      {msg && !msg.ok && (
        <p role="alert" className="text-[12.5px] text-down sm:col-span-3">
          {msg.text}
        </p>
      )}
    </form>
  )
}

function InvoiceSwitch({ onChange }: { onChange: (m: Member) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  if (done) return <p className="mt-3 text-[13px] text-up">Switched: we email each invoice, due in 30 days, payable online by card or US bank account (ACH).</p>
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px]">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setErr('')
          call<{ member?: Member }>('/account/invoice', { method: 'POST', body: {}, auth: true })
            .then((r) => {
              setDone(true)
              if (r.member) onChange(r.member)
            })
            .catch((e) => setErr(errText(e, e instanceof ApiError && e.detail ? e.detail : 'That didn’t go through. Please try again, or email us.')))
            .finally(() => setBusy(false))
        }}
        className="font-medium text-accent hover:text-accent-2"
      >
        {busy ? 'Switching…' : 'Pay by invoice instead (Net 30)'}
      </button>
      {err && (
        <span role="alert" className="text-[12.5px] text-down">
          {err}
        </span>
      )}
    </p>
  )
}

function Leave({ member, onChange }: { member: Member; onChange: (m: Member) => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<CancelReason | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'pause' | 'cancel' | null>(null)
  const [err, setErr] = useState('')
  const offer = member.pause_after_trial ? null : member.pause_offer
  // Trialing monthly members: the pause starts when the trial ends, so nothing is charged until it's over.
  const afterTrial = Boolean(offer?.starts && Date.parse(String(offer.starts)) > Date.now())
  // A pause is already scheduled for the trial's end (undo is on the plan line): only cancelling is left here.
  const scheduled = Boolean(member.pause_after_trial)
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 min-h-9 text-[13px] text-ink-3 underline underline-offset-2 hover:text-ink-2">
        {offer && !scheduled ? 'Pause or cancel' : 'Cancel plan'}
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
            {busy === 'pause' ? 'Pausing…' : afterTrial ? 'Pause after your trial' : `Pause until ${dayLabel(offer.until)}`}
          </Button>
        )}
        <Button
          variant="outline"
          disabled={!reason || busy !== null}
          onClick={async () => {
            setBusy('cancel')
            setErr('')
            await sendCancelReason(reason!, note.trim() || undefined).catch(() => null)
            openPortal().catch((e) => {
              setBusy(null)
              if (needsVerify(e)) return setErr(errText(e, ''))
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
      {offer && afterTrial && <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">Your trial continues with everything until {member.trial_end ? timeLabel(member.trial_end) : dayLabel(offer.starts!)}. Then no charges and no real-time alerts until {dayLabel(offer.until)}, two weeks before the {offer.quarter ? offer.quarter.replace(/^(\d{4})Q(\d)$/, 'Q$2') : deadlineQuarter(offer.until)} 13F deadline. Your follows and settings stay.</p>}
      {offer && !afterTrial && <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">Pausing stops charges and real-time alerts until {dayLabel(offer.until)}{offer.quarter ? `, in time for the ${offer.quarter.replace(/^(\d{4})Q(\d)$/, 'Q$2 $1')} 13F season` : ''}. {member.digest_live ? ' The weekly digest of your names keeps coming, your' : ' Your'} follows and settings stay, and we’ll email you before it resumes.</p>}
      {err && <p role="alert" className="mt-2 text-[13px] text-down">{err}</p>}
    </div>
  )
}

// The 13F deadline a pause ends before: Feb → Q4, May → Q1, Aug → Q2, Nov → Q3 filings.
function deadlineQuarter(until: string | number) {
  const m = new Date(typeof until === 'number' ? until * 1000 : `${until}T12:00:00Z`).getUTCMonth() + 1
  return `Q${[4, 1, 2, 3][Math.floor((((m - 2) % 12) + 12) % 12 / 3)]}`
}

// A free member's followed investors, each with when its next 13F is expected (d/expected.json). Their
// moves lead the Friday email; a per-filing email is Copy.
function FreeFollows() {
  const { follows, status, pending } = useFollows()
  const idx = useAsync(loadIndex, [])
  const soon = useAsync(loadExpected, [])
  const [err, setErr] = useState<string | null>(null)
  // Fresh from the API on every visit; the cached list only shows while it answers or if it's down.
  useEffect(() => void refreshFollows(), [])
  if (status !== 'ready' || !follows.investors.length) return null
  const name = (slug: string) => idx.data?.managers.find((m) => m.slug === slug)?.manager ?? soon.data?.expected.find((x) => x.slug === slug)?.manager ?? slug
  return (
    <section className="mt-10 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Investors you follow</h2>
        {follows.limit != null && <span className="text-[12.5px] text-ink-3">{follows.investors.length} of 10 free follows</span>}
      </div>
      <ul className="mt-3 divide-y divide-line">
        {follows.investors.map((slug) => {
          // Filed this quarter (index.json's latest book), its usual day, or due by the deadline: never blank.
          const line = soon.data ? seasonStatus(idx.data?.managers.find((m) => m.slug === slug), soon.data.expected.find((x) => x.slug === slug))?.text : undefined
          const removing = pending[`investors:${slug}`]?.state === 'saving'
          return (
            <li key={slug} className="flex items-center justify-between gap-3 py-2.5 text-[14px]">
              <span className="min-w-0">
                <Link to={`/investors/${slug}/`} className="font-medium hover:text-accent">
                  {name(slug)}
                </Link>
                <span className="block text-[13px] text-ink-3">{line ? `${line} · ` : ''}moves in Friday’s email</span>
              </span>
              <button
                type="button"
                disabled={removing}
                onClick={() => {
                  setErr(null)
                  setFollow('investors', slug, false).catch((e) => setErr(isReadOnly(e) ? `Couldn’t remove ${name(slug)}: follows can’t be changed while we’re on the backup. Try again in a few minutes.` : `Couldn’t remove ${name(slug)}${e instanceof ApiError && e.detail ? `: ${e.detail}` : ''}. Please try again.`))
                }}
                aria-label={`Stop following ${name(slug)}`}
                className="shrink-0 rounded-full px-3 py-1 text-[13px] font-medium text-ink-2 shadow-[0_0_0_1px_var(--color-line-2)] hover:text-ink hover:shadow-[0_0_0_1px_var(--color-ink-3)] disabled:opacity-60"
              >
                {removing ? 'Removing…' : 'Remove'}
              </button>
            </li>
          )
        })}
      </ul>
      {err && <p role="alert" className="mt-2 text-[13px] text-down">{err}</p>}
    </section>
  )
}
