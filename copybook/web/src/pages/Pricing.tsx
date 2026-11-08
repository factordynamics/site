import type { ReactNode } from 'react'
import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { WaitlistForm } from '../components/Waitlist'
import { Button, Check } from '../components/ui'
import { attributed } from '../lib/attribution'
import { useTitle } from '../lib/data'
import { checkoutEnabled, DATA_TERMS, plans, TRIAL_DAYS, trialTerms, type PlanId } from '../config'

type Feature = { t: string; d?: string; soon?: boolean }
// soon: not live yet. Labelled so nothing is sold before it ships; drop the flag as each one lands.
const SOON = 'Rolling out this month'

const FREE: Feature[] = [
  { t: 'The latest 13F of every filer', d: 'Nearly 9,000 funds, with top holdings and sector mix.' },
  { t: 'Stock pages', d: 'Who holds a ticker, and who bought or sold it.' },
  { t: 'Top buys and sells', d: 'The four biggest moves per fund, and the top of each season’s flow.' },
  { t: 'Search and consensus', d: 'Find any fund or ticker; see where great investors agree.' },
]
const COPY: Feature[] = [
  { t: 'An email minutes after they file', d: 'We check EDGAR every minute. The moves are in the email: new, added, trimmed, exited, with dollars and share of the book.' },
  { t: 'Follow investors and stocks', d: 'Tell us what you own or watch, and hear when an active manager trades it.' },
  { t: 'Moves between 13Fs', d: 'Form 4 trades and 13D stakes by the funds you follow, within a few hours.' },
  { t: 'Every move, every quarter', d: 'All buys and sells, the full filing-season flow, and 8 quarters of history with CSV.' },
]
const PRO: Feature[] = [
  { t: 'API keys and docs', d: 'Up to 10 keys, 60 requests a minute and 20,000 a day each, with usage on your account page.' },
  { t: 'Holdings, history and events endpoints', d: 'Every filer’s 13F, Form 4 and 13D/G data as JSON.', soon: true },
  { t: 'Point-in-time history', d: 'Each position dated by when it was disclosed, so backtests don’t see the future.', soon: true },
  { t: 'Bulk exports and webhooks', d: 'Whole-quarter files, and a POST to your endpoint when a filing lands.', soon: true },
  { t: 'My book and peer overlap', d: 'Crowding in your names, and overlap with the funds you benchmark against.', soon: true },
]
const FUND: Feature[] = [
  { t: '5 seats', d: 'Invite your team; each seat gets its own alerts.', soon: true },
  { t: 'Shared book and peer lists', d: 'One list of holdings and peers the whole team works from.', soon: true },
  { t: 'Alerts in Slack', d: 'Filings and moves in your channel.', soon: true },
  { t: 'Annual invoice billing', d: 'Pay by invoice on the yearly plan.', soon: true },
]

const TIERS: { id: 'free' | PlanId; who: string; lead?: string; features: Feature[] }[] = [
  { id: 'free', who: 'For reading what great investors own.', features: FREE },
  { id: 'copy', who: 'For individual investors who follow the best funds.', lead: 'Everything in Free, plus', features: COPY },
  { id: 'pro', who: 'For quants, analysts and small funds. 1 seat.', lead: 'Everything in Copy, plus', features: PRO },
  { id: 'fund', who: 'For investment teams. 5 seats.', lead: 'Everything in Pro, plus', features: FUND },
]

// What each plan includes. true = included, false = not, string = shown as is.
const COMPARE: [string, ...(boolean | string)[]][] = [
  ['Latest 13F of every filer', true, true, true, true],
  ['Stock pages and search', true, true, true, true],
  ['Top 4 buys and sells per fund', true, true, true, true],
  ['Follow investors and stocks', false, true, true, true],
  ['Filing alerts, moves inside', false, true, true, true],
  ['Form 4 and 13D moves between 13Fs', false, true, true, true],
  ['Every move and full flow', false, true, true, true],
  ['8 quarters of history and CSV', false, true, true, true],
  ['API keys', false, false, true, true],
  ['API data endpoints', false, false, SOON, SOON],
  ['Point-in-time history', false, false, SOON, SOON],
  ['Bulk exports and webhooks', false, false, SOON, SOON],
  ['My book and peer overlap', false, false, SOON, SOON],
  ['Seats', '1', '1', '1', '5'],
  ['Shared book, Slack, invoice billing', false, false, false, SOON],
]

export function Pricing() {
  const [cycle, setCycle] = useState<'yearly' | 'monthly'>('yearly')
  const live = checkoutEnabled()
  useTitle('Pricing · Copybook')
  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="mx-auto max-w-2xl text-center">
        <p className="text-[13px] font-medium text-accent">Pricing</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Know what they bought the day they file.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          Reading a portfolio is free. Copy follows the investors and stocks you care about. Pro and Fund add the data feed and the tools research teams need. Every paid plan starts with {TRIAL_DAYS} days free.
        </p>
        <div className="mt-8 inline-flex rounded-full bg-ink/[0.05] p-1 text-[14px]" role="tablist" aria-label="Billing period">
          {(['monthly', 'yearly'] as const).map((c) => (
            <button key={c} role="tab" aria-selected={cycle === c} onClick={() => setCycle(c)} className={`rounded-full px-4 py-1.5 ${cycle === c ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
              {c === 'monthly' ? 'Monthly' : 'Yearly'}
              {c === 'yearly' && <span className="ml-1.5 text-[12px] font-medium text-up">2+ months free</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="mx-auto mt-10 grid max-w-[1240px] gap-4 md:grid-cols-2 xl:grid-cols-4">
        {TIERS.map((tier) => {
          const dark = tier.id === 'copy'
          const plan = tier.id === 'free' ? null : plans[tier.id]
          const price = plan ? (cycle === 'yearly' ? plan.yearly : plan.monthly) : 0
          const save = plan ? Math.round((1 - plan.yearly / (plan.monthly * 12)) * 100) : 0
          const link = plan ? plan.links[cycle] || plan.links.monthly : ''
          return (
            <article
              key={tier.id}
              className={`relative flex flex-col overflow-hidden rounded-[18px] p-6 md:p-7 ${dark ? 'bg-night text-white shadow-[var(--shadow-frame)]' : 'bg-card shadow-[var(--shadow-card)]'}`}
            >
              {dark && <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-accent/40 blur-[80px]" aria-hidden="true" />}
              <div className="relative flex items-center justify-between gap-3">
                <h2 className="text-[17px] font-semibold">{plan?.name ?? 'Free'}</h2>
                {dark && <span className="whitespace-nowrap rounded-full bg-accent px-2.5 py-0.5 text-[12px] font-medium text-white">Recommended</span>}
              </div>
              <p className={`relative mt-1 min-h-[2.75em] text-[13.5px] leading-snug ${dark ? 'text-white/65' : 'text-ink-3'}`}>{tier.who}</p>
              <p className="relative mt-5 flex items-baseline gap-1.5">
                <span className="num text-[40px] font-semibold tracking-[-0.04em]">${price.toLocaleString('en-US')}</span>
                <span className={`text-[14px] ${dark ? 'text-white/60' : 'text-ink-3'}`}>{plan ? (cycle === 'yearly' ? 'per year' : 'per month') : 'forever'}</span>
              </p>
              <p className={`relative min-h-[1.5em] text-[12.5px] ${dark ? 'text-white/60' : 'text-ink-3'}`}>
                {plan ? (cycle === 'yearly' ? `About $${Math.round(plan.yearly / 12)} a month · save ${save}%` : `Or $${plan.yearly.toLocaleString('en-US')} a year`) : 'No card, no account'}
              </p>
              <div className="relative mt-5">
                {!plan ? (
                  <Button to="/investors/" variant="outline" className="w-full">
                    Browse investors
                  </Button>
                ) : live ? (
                  <Button href={attributed(link)} variant={dark ? 'primary' : 'dark'} className="w-full">
                    Start {TRIAL_DAYS}-day free trial
                  </Button>
                ) : (
                  <WaitlistForm cta="Get early access" dark={dark} id={`wl-${tier.id}`} />
                )}
                <p className={`mt-2.5 min-h-[3.6em] text-[11.5px] leading-snug ${dark ? 'text-white/55' : 'text-ink-3'}`}>{plan ? trialTerms(tier.id) : 'Free forever. Upgrade when you want alerts and history.'}</p>
              </div>
              <div className={`relative mt-5 border-t pt-5 ${dark ? 'border-white/10' : 'border-line'}`}>
                {tier.lead && <p className={`mb-3 text-[12.5px] font-medium ${dark ? 'text-white/70' : 'text-ink-2'}`}>{tier.lead}:</p>}
                <ul className="space-y-3.5">
                  {tier.features.map((f) => (
                    <li key={f.t} className="flex gap-2.5">
                      <Check className={`mt-0.5 shrink-0 ${dark ? 'text-[#9fb0ff]' : f.soon ? 'text-ink-3' : 'text-accent'}`} />
                      <span>
                        <span className={`block text-[14px] font-medium ${dark ? 'text-white' : ''}`}>{f.t}</span>
                        {f.soon && <span className="mt-1 inline-block rounded-full bg-[#f6ead2] px-2 text-[11px] font-medium leading-5 text-[#5c3f0b]">{SOON}</span>}
                        {f.d && <span className={`mt-0.5 block text-[12.5px] leading-relaxed ${dark ? 'text-white/65' : 'text-ink-3'}`}>{f.d}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          )
        })}
      </div>

      <section className="mx-auto mt-20 max-w-[1240px]" aria-labelledby="compare">
        <h2 id="compare" className="text-[28px] font-semibold tracking-[-0.03em]">
          Compare plans
        </h2>
        <div className="mt-6 overflow-x-auto rounded-[var(--radius-card)] bg-card shadow-[var(--shadow-card)]" tabIndex={0} role="region" aria-label="Plan comparison table">
          <table className="w-full min-w-[640px] text-[14px]">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-5 py-3.5 font-medium text-ink-3 md:px-6">Feature</th>
                {TIERS.map((t) => (
                  <th key={t.id} className={`px-3 py-3.5 text-center font-semibold ${t.id === 'copy' ? 'text-accent' : ''}`}>
                    {t.id === 'free' ? 'Free' : plans[t.id].name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE.map(([label, ...cells]) => (
                <tr key={label} className="border-b border-line last:border-0">
                  <td className="px-5 py-3 text-ink-2 md:px-6">{label}</td>
                  {cells.map((c, i) => (
                    <td key={i} className={`px-3 py-3 text-center ${i === 1 ? 'bg-accent-soft/40' : ''}`}>
                      {c === true ? (
                        <Check className="mx-auto text-accent" />
                      ) : c === false ? (
                        <span className="text-ink-3" aria-label="Not included">
                          –
                        </span>
                      ) : c === SOON ? (
                        <span className="text-[12px] font-medium text-[#8a5a0b]">Rolling out</span>
                      ) : (
                        <span className="num font-medium">{c}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mx-auto mt-20 max-w-3xl">
        <h2 className="text-[28px] font-semibold tracking-[-0.03em]">Questions</h2>
        <dl className="mt-6 divide-y divide-line border-y border-line">
          {(
            [
              [
                'Which plan is right for me?',
                'Copy is for individuals who want to know what the best funds bought, the moment they file. Pro is for anyone who needs the data in their own tools: the API, point-in-time history and exports. Fund adds seats and shared lists for a team.',
              ],
              [
                'What’s live in Pro and Fund today?',
                'Everything in Copy, plus API keys and the API docs. The data endpoints, point-in-time history, bulk exports, webhooks, My book, peer overlap, seats, Slack and invoice billing are rolling out this month and turn on for your plan as each ships, at no extra cost. Each is marked above until it’s live.',
              ],
              [
                'How does the free trial work?',
                `Every paid plan is free for ${TRIAL_DAYS} days. Stripe takes a card at signup so the plan continues without a gap; you’re charged on day ${TRIAL_DAYS + 1} unless you cancel from Manage billing before then.`,
              ],
              ['Can I switch plans?', 'Yes. Upgrade, downgrade or change between monthly and yearly from Manage billing on your account page. Stripe prorates the difference.'],
              [
                'How fast are filing alerts?',
                'We poll EDGAR’s latest-filings feed every minute, so a 13F alert usually arrives within a couple of minutes of the filing appearing there. For the very largest books, the first email is just as fast and the moves follow in a second email after our next data refresh, usually within a few hours. Form 4 and 13D alerts arrive within a few hours of filing. Funds have 45 days after quarter end to file a 13F, so the positions in it are always a few weeks old.',
              ],
              [
                'What’s in an alert?',
                'The fund, the quarter and a link to the filing, then its top five new, added, trimmed and exited positions with dollars and share of the book. Moves in stocks you own or watch are tagged. Schedule 13G filings are optional, and you can choose one daily digest after EDGAR closes instead of an email per filing.',
              ],
              [
                'Where does the data come from?',
                <Fragment key="src">
                  Every holding comes from the Form 13F-HR the fund filed with the SEC, and every between-quarter move from its Form 4 or Schedule 13D/G. We link each one to the original filing. How we handle amendments, units, options and tickers is on the{' '}
                  <Link to="/methodology/" className="font-medium text-accent hover:text-accent-2">
                    methodology page
                  </Link>
                  .
                </Fragment>,
              ],
              ['Do you show live prices or returns?', 'No. Values are what the fund reported at quarter end. We don’t re-price holdings or estimate performance.'],
              ['How are options shown?', 'Calls and puts are listed apart from shares. A 13F reports options at the value of the underlying shares, so we label them as notional and leave them out of portfolio weights and holder counts.'],
              ['Can I cancel?', 'Yes, any time from Manage billing on your account page. After a paid period starts, you keep access until the end of the period you paid for.'],
              ['Is this investment advice?', 'No. Copybook shows public filings. 13F omits short positions, most non-US holdings and cash, so a portfolio here is never the whole picture.'],
            ] as [string, ReactNode][]
          ).map(([q, a]) => (
            <div key={q} className="py-5">
              <dt className="text-[16px] font-medium">{q}</dt>
              <dd className="mt-2 text-[15px] leading-relaxed text-ink-2">{a}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 text-[14px] text-ink-3">
          Already a member?{' '}
          <Link to="/account/" className="font-medium text-accent hover:text-accent-2">
            Sign in to your account
          </Link>
          . {DATA_TERMS}
        </p>
      </section>
    </div>
  )
}
