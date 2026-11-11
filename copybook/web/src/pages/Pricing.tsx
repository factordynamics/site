import type { ReactNode } from 'react'
import { Fragment, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button, Check } from '../components/ui'
import { attributed, checkRef, referredCheckout, refCode } from '../lib/attribution'
import { useMember } from '../lib/account'
import { money, useAsync, useTitle } from '../lib/data'
import { loadCoverage, loadStock } from '../lib/stocks'
import { loadEvents } from '../components/FundNotes'
import { BOOK_PRO, checkoutEnabled, FUND_SEATS, FUND_WHY, DATA_TERMS, plans, referredDeal, referredTerms, TRIAL_DAYS, trialTerms, type PlanId } from '../config'

type Feature = { t: string; d?: string }
type Tier = { id: 'free' | PlanId; who: string; lead?: string; now: Feature[]; soon?: Feature[]; proof?: boolean; why?: string }

const tiers = (filers: string, curated: number): Tier[] => [
  {
    id: 'free',
    who: 'For reading what great investors own.',
    now: [
      { t: `The latest 13F of ${filers} filers`, d: 'Every fund that files, with top holdings and sector mix.' },
      { t: 'Stock pages', d: 'Who holds a ticker, and who bought or sold it.' },
      { t: 'Top buys and sells', d: 'The four biggest moves per fund, and the top of each season’s flow.' },
      { t: 'Search and consensus', d: 'Find any fund or ticker; see where great investors agree.' },
      { t: 'Free account', d: 'Save 5 names and get the Friday email of the week’s top moves.' },
    ],
  },
  {
    id: 'copy',
    who: 'For individual investors who follow the best funds.',
    lead: 'Everything in Free, plus',
    now: [
      { t: 'Moves between 13Fs', d: 'Form 4 trades and 13D stakes by the funds you follow, checked on EDGAR every minute: holdings per share class, % of the class before → after, threshold crossings and the 13D’s Item 4.' },
      { t: 'My book', d: 'Your names, who owns them among the superinvestors, and alerts when that changes.' },
      { t: 'An email when they file', d: `We check EDGAR every minute. Alerts, moves and history cover the ${curated} managers we track closely, and the list is growing.` },
      { t: 'The moves inside the email', d: 'New, added, trimmed and exited positions, with dollars and share of the book.' },
      { t: 'Follow investors and stocks', d: 'Tell us what you own or watch, and hear when an active manager trades it.' },
      { t: 'Telegram, Discord, Slack and RSS delivery', d: 'Each alert in your chat or reader as it happens, as well as by email.' },
      { t: 'Insider buys and any filer’s 13D', d: 'On stocks you own or watch: open-market insider buys over a threshold you set, cluster buys by 3+ insiders, and a new 13D or 13G by anyone.' },
      { t: 'Every move, every quarter', d: 'All buys and sells, the full filing-season flow, and 8 quarters of history with CSV.' },
    ],
  },
  {
    id: 'pro',
    proof: true,
    who: 'For one analyst or quant. 1 seat, card billing.',
    lead: 'Everything in Copy, plus',
    now: [
      { t: 'API keys and docs', d: 'Up to 10 keys, 60 requests a minute and 20,000 a day each, with usage on your account page.' },
      { t: 'Filer and holdings endpoints', d: `Every 13F filer, ${filers}, with its latest holdings as JSON; 8 quarters of history for the ${curated} we track closely, back to 2013 by Dec 31.` },
      { t: 'Filing acceptance times', d: 'The EDGAR acceptance time of each filing, to the second.' },
      { t: 'Signed webhooks', d: 'A signed JSON POST to your endpoint for every alert, retried for 12 hours if it fails.' },
      { t: 'Holders, history and events endpoints', d: 'Every filer holding a stock, a filer’s books across a range of quarters, and Form 4 and 13D/G events, as JSON.' },
      { t: 'Bulk CSV exports', d: 'One gzip CSV per quarter of every filer’s 13F book, built from original filings: no restatements, amendments or point-in-time columns yet, so a re-filed book shows its original.' },
      BOOK_PRO,
      { t: 'Peer overlap', d: 'Up to 12 funds you benchmark against: how much their books overlap, the names they share, and what they did in yours.' },
    ],
    soon: [
      { t: 'Point-in-time history', d: 'An as_of parameter with per-row amendment lots, so a backtest sees only what was public. By Nov 30.' },
      { t: 'History back to 2013', d: 'By Dec 31; 8 quarters today.' },
      { t: 'Parquet bulk files', d: 'Next to the CSVs. No date yet.' },
    ],
  },
  {
    id: 'fund',
    who: `For a PM and analysts working one book. ${FUND_SEATS} seats, one invoice.`,
    lead: 'Everything in Pro, plus',
    now: [
      { t: `${FUND_SEATS} seats`, d: 'Invite your team by email; each seat signs in on its own and keeps its own alerts and channels.' },
      { t: 'Shared book and peer lists', d: 'One set of follows, watchlist, owned book and peers the whole team works from.' },
      { t: 'One team channel', d: 'Each alert posts once to your team’s Slack channel, whoever follows it.' },
      { t: 'Seat admin', d: 'Add and remove seats from your account page, sign a departing colleague out everywhere at once and delete their API keys; Remove the seat to end access.' },
      { t: 'Annual invoice', d: 'Invoiced yearly, net 30. W-9 on request.' },
    ],
    why: FUND_WHY,
  },
]

const FOUNDING: Partial<Record<PlanId, string>> = {
  pro: 'Founding price: subscribe before Dec 31 and keep $39/mo ($390/yr) for as long as you stay subscribed.',
  fund: 'Founding price: subscribe before Dec 31 and keep $1,990/yr for as long as you stay subscribed.',
}

// What each plan includes. true = included, false = not, 'soon' = coming (no date), 'by …' = coming by that date, string = shown as is.
const compare = (filers: string): [string, ...(boolean | string)[]][] => [
  [`Latest 13F of ${filers} filers`, true, true, true, true],
  ['Stock pages and search', true, true, true, true],
  ['Top 4 buys and sells per fund', true, true, true, true],
  ['Free account: save 5 names, Friday email', true, true, true, true],
  ['Follow investors and stocks', false, true, true, true],
  ['Filing alerts, moves inside', false, true, true, true],
  ['Form 4 and 13D moves between 13Fs', 'Top 2 per fund', true, true, true],
  ['Every move and full flow', false, true, true, true],
  ['Slack, Discord, Telegram and RSS delivery', false, true, true, true],
  ['Insider buys and any filer’s 13D on your stocks', false, true, true, true],
  ['8 quarters of history and CSV', false, true, true, true],
  ['API keys, filer and holdings endpoints', false, false, true, true],
  ['Holders, history and events endpoints', false, false, true, true],
  ['Point-in-time history', false, false, 'by Nov 30', 'by Nov 30'],
  ['Signed webhooks', false, false, true, true],
  ['Bulk CSV exports (as filed)', false, false, true, true],
  ['My book lite: superinvestors in your names', false, true, true, true],
  ['Full My book: every 13F filer (holders, crowding, peers), 13F linking, CSV', false, false, true, true],
  ['New, exited and net trades for all filers in My book (tracked funds today)', false, false, 'by Nov 20', 'by Nov 20'],
  ['Peer overlap', false, false, true, true],
  ['Seats', '1', '1', '1', `${FUND_SEATS}`],
  ['Shared book and peer lists', false, false, false, true],
  ['One team Slack channel: each alert posts once', false, false, false, true],
  ['Seat admin: add and remove seats', false, false, false, true],
  ['Revoke a seat’s sessions', false, false, false, true],
  ['Invoice billing, W-9', false, false, false, true],
]

/** "Warren Buffett buy $26.9M of SIRI between 13Fs": the top between-13F move on the stock or investor page the
 *  visitor came from (/pricing/?from=SIRI or ?from=warren-buffett), from the same static files those pages read. */
type Move = { manager: string; ticker?: string | null; display_name?: string | null; issuer: string; kind: string; action: string; value_usd?: number | null; percent_of_class?: number | null }
async function fromFact(from: string | null): Promise<string | null> {
  if (!from || !/^[A-Za-z0-9.-]{1,60}$/.test(from)) return null
  const moves: Move[] = /^[A-Z0-9.-]{1,10}$/.test(from)
    ? ((await loadStock(from).catch(() => null))?.since ?? [])
    : (((await loadEvents(from).catch(() => null))?.events ?? []).filter((e) => !('skip' in e)) as unknown as Move[]).map((e) => ({ ...e, manager: (e as { manager?: string }).manager ?? '' }))
  const trades = moves.filter((m) => m.kind === 'form4' && (m.action === 'buy' || m.action === 'sell') && (m.value_usd ?? 0) > 0)
  const top = trades.sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0))[0]
  const what = (m: Move) => m.ticker || m.display_name || m.issuer
  if (top?.manager) return `${top.manager} ${top.action === 'buy' ? 'buy' : 'sell'} ${money(top.value_usd!)} of ${what(top)} between 13Fs`
  const stake = moves.find((m) => (m.kind === '13d' || m.kind === '13g') && m.manager && m.percent_of_class != null)
  const pc = stake?.percent_of_class?.toFixed(1) ?? ''
  // "an 8.3%", "an 11.0%", "a 70.8%": the article follows how the number is said.
  return stake ? `${stake.manager} report ${/^(8|1[18](\.|$))/.test(pc) ? 'an' : 'a'} ${pc}% stake in ${what(stake)} between 13Fs` : null
}

export function Pricing() {
  const [cycle, setCycle] = useState<'yearly' | 'monthly'>('yearly')
  const live = checkoutEnabled()
  // Members move up through /upgrade (prorated, same interval); a second checkout would double-bill.
  const member = useMember()
  const RANK: Record<string, number> = { copy: 1, pro: 2, fund: 3 }
  const mine = member?.active && member.plan !== 'holdterm' ? member.plan : null
  useTitle('Pricing · Copybook')
  const cov = useAsync(loadCoverage, [])
  const filers = cov.data ? cov.data.filers.toLocaleString('en-US') : '8,900+'
  const curated = cov.data?.curated ?? 348
  const TIERS = tiers(filers, curated)
  const COMPARE = compare(filers)
  // A friend's referral link: Copy and Pro show the first charge with the free month taken off.
  // Only once the API confirms the code: a made-up ?ref= shows the normal card.
  const refOk = useAsync(() => checkRef(refCode()), []).data === true
  const referred = Boolean(refOk && !mine && live)
  const [params] = useSearchParams()
  const hook = useAsync(() => fromFact(params.get('from')), [params.get('from')])
  const copy = plans.copy
  const monthsFree = Math.round(12 - copy.yearly / copy.monthly)
  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="mx-auto max-w-2xl text-center">
        <p className="text-[13px] font-medium text-accent">Pricing</p>
        <h1 className="mt-3 text-[32px] font-semibold leading-[1.08] tracking-[-0.04em] sm:text-[38px] md:text-h1">See what they bought between 13Fs, the day they file.</h1>
        {hook.data && (
          <p className="mx-auto mt-4 max-w-xl rounded-xl bg-accent-soft px-4 py-2.5 text-[15px] leading-snug text-accent-2">
            You just saw {hook.data}. Copy emails moves like this, checked on EDGAR every minute.
          </p>
        )}
        <p className="mt-4 text-[16px] leading-relaxed text-ink-2 sm:text-[17px]">
          Reading a portfolio is free. Copy follows the investors and stocks you care about. Every paid plan starts with {TRIAL_DAYS} days free.
        </p>
        <p className="mt-4 text-[13.5px] text-ink-3">
          We check EDGAR every minute.{' '}
          <Link to="/speed/" className="font-medium text-accent hover:text-accent-2">
            Alert speed
          </Link>
        </p>
        {refOk && !mine && (
          <div className="mt-5">
            <p role="status" className="inline-flex items-center gap-2 rounded-full bg-[#e3f1e8] px-4 py-1.5 text-[14px] font-medium text-[#126b3c]">
              <Check className="size-3.5" /> A member sent you a free month: after the {TRIAL_DAYS}-day trial, your first month is on us.
            </p>
          </div>
        )}
        <div className="mt-6 seg rounded-full sm:mt-8 bg-ink/[0.05] p-1 text-[14px]" role="tablist" aria-label="Billing period">
          {(['monthly', 'yearly'] as const).map((c) => (
            <button key={c} role="tab" aria-selected={cycle === c} onClick={() => setCycle(c)} className={`rounded-full px-4 py-1.5 ${cycle === c ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
              {c === 'monthly' ? 'Monthly' : 'Yearly'}
              {c === 'yearly' && <span className="ml-1.5 text-[12px] font-medium text-up">${copy.yearly}/yr: about {monthsFree} months free</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="mx-auto mt-6 grid max-w-[1240px] gap-4 sm:mt-10 md:grid-cols-2 xl:grid-cols-4">
        {TIERS.map((tier) => {
          const dark = tier.id === 'copy'
          const plan = tier.id === 'free' ? null : plans[tier.id]
          const price = plan ? (cycle === 'yearly' ? plan.yearly : plan.monthly) : 0
          const save = plan ? Math.round((1 - plan.yearly / (plan.monthly * 12)) * 100) : 0
          const link = plan ? plan.links[cycle] || plan.links.monthly : ''
          return (
            <article
              key={tier.id}
              id={tier.id}
              // On phones Copy comes first, so its price is on the first screen.
              className={`relative flex flex-col overflow-hidden rounded-[18px] p-6 md:p-7 ${dark ? 'order-first md:order-none' : ''} ${dark ? 'bg-night text-white shadow-[var(--shadow-frame)]' : 'bg-card shadow-[var(--shadow-card)]'}`}
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
              {referred && plan && tier.id !== 'fund' ? (
                <p className={`relative min-h-[1.5em] text-[13.5px] font-semibold ${dark ? 'text-[#7fe0a6]' : 'text-[#126b3c]'}`}>{referredDeal(tier.id, cycle)}</p>
              ) : (
                <p className={`relative text-[12.5px] ${cycle === 'yearly' ? 'min-h-[53px]' : 'min-h-[1.5em]'} ${dark ? 'text-white/60' : 'text-ink-3'}`}>
                  {plan ? (cycle === 'yearly' ? `About $${Math.round(plan.yearly / 12)} a month · save ${save}%` : `Or $${plan.yearly.toLocaleString('en-US')} a year`) : 'No card needed'}
                  {plan && cycle === 'yearly' && <span className="block text-[11.5px]">Prepaid and protected: pro-rata refund if we ever discontinue the plan.</span>}
                </p>
              )}
              <div className="relative mt-5">
                {!plan ? (
                  <Button to="/investors/" variant="outline" className="w-full">
                    Browse investors
                  </Button>
                ) : mine && !member?.seat && RANK[tier.id] <= RANK[mine] ? (
                  <Button to="/account/" variant="outline" className="w-full">
                    {tier.id === mine ? 'Your plan' : 'Included in your plan'}
                  </Button>
                ) : mine && !member?.seat && tier.id === 'pro' ? (
                  <Button to="/upgrade/?plan=pro" variant="primary" className="w-full">
                    Upgrade to Pro
                  </Button>
                ) : mine && !member?.seat && tier.id === 'fund' ? (
                  <Button to="/upgrade/?plan=fund" variant="dark" className="w-full">
                    Upgrade to Fund
                  </Button>
                ) : tier.id === 'fund' ? (
                  // Funds mostly buy by invoice; the card trial stays as a quiet second path.
                  <Button to="/contact/?topic=fund" variant="dark" className="w-full">
                    Request Fund access
                  </Button>
                ) : live ? (
                  <Button href={attributed(link)} onClick={referredCheckout(tier.id as 'copy' | 'pro', cycle, attributed(link))} variant={dark ? 'primary' : 'dark'} className="w-full">
                    Start {TRIAL_DAYS}-day free trial
                  </Button>
                ) : (
                  // Only when Stripe checkout isn't configured (never in production): no form, no promise.
                  <p className={`rounded-full px-4 py-2.5 text-center text-[14px] font-medium ${dark ? 'bg-white/10 text-white/80' : 'bg-ink/[0.05] text-ink-2'}`}>Checkout is briefly unavailable</p>
                )}
                <p className={`mt-2.5 min-h-[3.6em] text-[11.5px] leading-snug ${dark ? 'text-white/55' : 'text-ink-3'}`}>
                  {tier.id === 'fund' ? (
                    <>
                      Founding price $1,990/yr, invoiced net 30. W-9 on request. Or email{' '}
                      <a href="mailto:hello@factordynamics.com" className="underline underline-offset-2 hover:text-ink">
                        hello@factordynamics.com
                      </a>
                      .{' '}
                      {live && (
                        <a href={attributed(link)} onClick={referredCheckout('fund', cycle, attributed(link))} className="underline underline-offset-2 hover:text-ink">
                          Or start a {TRIAL_DAYS}-day trial by card
                        </a>
                      )}
                    </>
                  ) : plan && mine && !member?.seat && tier.id === 'pro' && mine === 'copy' ? (
                    `Switches your Copy plan to Pro on the same ${member?.interval === 'monthly' ? 'monthly' : 'yearly'} billing, at the founding price, prorated for the rest of this period. You confirm the amount before anything changes.`
                  ) : plan ? (
                    // Stripe takes a card before the trial starts: said plainly under every paid button, next to Free's "No card needed".
                    <>
                      <span className={`block text-[12.5px] font-medium ${dark ? 'text-white/80' : 'text-ink-2'}`}>Card required · charged on day {TRIAL_DAYS + 1} unless you cancel</span>
                      {referred ? referredTerms(tier.id, cycle) : trialTerms(tier.id)}
                    </>
                  ) : (
                    'Free forever. Upgrade when you want alerts and history.'
                  )}
                </p>
                {plan && FOUNDING[tier.id as PlanId] && (
                  <p className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-[12px] font-medium leading-snug text-accent-2">{FOUNDING[tier.id as PlanId]}</p>
                )}
              </div>
              <div className={`relative mt-5 border-t pt-5 ${dark ? 'border-white/10' : 'border-line'}`}>
                {tier.lead && <p className={`mb-3 text-[12.5px] font-medium ${dark ? 'text-white/70' : 'text-ink-2'}`}>{tier.lead}:</p>}
                {tier.soon && <h3 className="mb-2.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">Included now</h3>}
                <FeatureList items={tier.now} dark={dark} />
                {tier.why && <p className={`mt-5 rounded-lg px-3 py-2.5 text-[12.5px] leading-snug ${dark ? 'bg-white/[0.06] text-white/75' : 'bg-ink/[0.04] text-ink-2'}`}>{tier.why}</p>}
                {tier.soon && tier.soon.length > 0 && (
                  <>
                    <h3 className="mb-2.5 mt-6 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[#8a5a0b]">Coming</h3>
                    <FeatureList items={tier.soon} soon />
                  </>
                )}
                {tier.proof && (
                  <div className="mt-6 border-t border-line pt-4 text-[12.5px] leading-snug text-ink-2">
                    <p className="flex flex-wrap gap-x-3 font-medium">
                      <Link to="/api/" className="text-accent hover:text-accent-2">
                        API docs
                      </Link>
                      <a href={`${import.meta.env.BASE_URL}api/sample-holdings.json`} className="text-accent hover:text-accent-2">
                        Sample response
                      </a>
                    </p>
                  </div>
                )}
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
                      ) : c === 'soon' || c.startsWith('by ') ? (
                        <span className="whitespace-nowrap text-[12px] font-medium text-[#8a5a0b]">{c === 'soon' ? 'Coming' : `Coming ${c}`}</span>
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
                `Pro: everything in Copy, API keys, the filer, holdings, holders, history and events endpoints, bulk CSV files (as originally filed), filing acceptance times, signed webhooks, the full My book (every 13F filer, crowding, 13F linking and CSV) and peer overlap. Copy includes My book lite: who among the superinvestors holds your names and what they did this season. Coming, at no extra cost: new, exited and net trades for all filers in My book by Nov 20, point-in-time history (as_of) by Nov 30, history back to 2013 by Dec 31, and Parquet files with no date yet; each turns on in the API changelog when it returns data. Fund adds up to ${FUND_SEATS} seats, a shared book and peer lists, all live, and can be paid by annual invoice, net 30.`,
              ],
              [
                'How does the free trial work?',
                `Every paid plan is free for ${TRIAL_DAYS} days. Stripe takes a card at signup so the plan continues without a gap; you’re charged on day ${TRIAL_DAYS + 1} unless you cancel from Manage billing before then.`,
              ],
              ['What does the founding price mean?', 'Subscribe to Pro or Fund before December 31 and your price stays at $39/mo ($390/yr) for Pro or $1,990/yr for Fund for as long as you stay subscribed, even if list prices rise.'],
              ['Can I switch plans?', 'Yes. Upgrade, downgrade or change between monthly and yearly from Manage billing on your account page. Stripe prorates the difference.'],
              [
                'How fast are filing alerts?',
                'We poll EDGAR every minute for 13F, Form 4 and 13D/G filings; measured timings appear on the speed page as alerts go out, and none have been timed yet this season. For the very largest books, the moves follow in a second email after our next data refresh, usually within a few hours. Funds have 45 days after quarter end to file a 13F, so the positions in it are always a few weeks old.',
              ],
              [
                'What’s in an alert?',
                'The fund, the quarter and a link to the filing, then its top five new, added, trimmed and exited positions with dollars and share of the book. Moves in stocks you own or watch are tagged. Form 4 and 13D/G emails show the holding per share class, the amendment number, % of the class before → after with whether it moved by buying, selling or dilution, any 5% or 10% threshold crossed, and the 13D’s Item 4 purpose. Schedule 13G filings are optional, and you can choose one daily digest after EDGAR closes instead of an email per filing.',
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
              ['Can I cancel?', 'Yes, any time from Manage billing on your account page. After a paid period starts, you keep access until the end of the period you paid for. Monthly plans can also pause between seasons instead.'],
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

function FeatureList({ items, dark = false, soon = false }: { items: Feature[]; dark?: boolean; soon?: boolean }) {
  return (
    <ul className="space-y-3.5">
      {items.map((f) => (
        <li key={f.t} className="flex gap-2.5">
          {soon ? (
            <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#c99a4a] mx-[5px]" aria-hidden="true" />
          ) : (
            <Check className={`mt-0.5 shrink-0 ${dark ? 'text-[#9fb0ff]' : 'text-accent'}`} />
          )}
          <span>
            <span className={`block text-[14px] font-medium ${dark ? 'text-white' : soon ? 'text-ink-2' : ''}`}>{f.t}</span>
            {f.d && <span className={`mt-0.5 block text-[12.5px] leading-relaxed ${dark ? 'text-white/65' : 'text-ink-3'}`}>{f.d}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}
