import { useState } from 'react'
import { Link } from 'react-router-dom'
import { WaitlistForm } from '../components/Waitlist'
import { Button, Check } from '../components/ui'
import { attributed } from '../lib/attribution'
import { useTitle } from '../lib/data'
import { checkout, checkoutEnabled, DATA_TERMS, prices, TRIAL_DAYS, TRIAL_TERMS } from '../config'

const FREE = [
  'The latest 13F portfolio of every investor we track',
  'Stock pages: who holds a ticker, and who bought or sold it',
  'The top buys and sells for each fund, and the top of this season’s flow',
  'Consensus book and search across every 13F filer',
]
const COPY: { t: string; d: string }[] = [
  { t: 'An email minutes after they file', d: 'We check EDGAR every minute. For the funds you follow, the alert usually lands within a couple of minutes of the 13F.' },
  { t: 'The moves inside the email', d: 'The top new, added, trimmed and exited positions, with dollars and share of the book. No clicking through to find out.' },
  { t: 'Alerts on the stocks you own', d: 'Tell us what you own and what you watch. Moves in those stocks are tagged, and you hear about any fund that trades them.' },
  { t: 'Moves between 13Fs', d: 'Form 4 buys and sells and 13D stake filings by the funds you follow, emailed within a few hours and shown on each investor page.' },
  { t: 'Follow investors and stocks', d: 'One click on any investor or stock page, or pick them all at once when you sign up.' },
  { t: 'Every filing, or one digest', d: 'An email per filing, or a single daily digest after EDGAR closes. Passive 13G stakes are optional.' },
  { t: 'Every move, not just the top four', d: 'All buys, sells, new positions and exits for every fund, and the full filing-season flow.' },
  { t: '8 quarters of history and CSV', d: 'Every position in every quarter, quarter tabs, and a download for your own spreadsheet.' },
]

export function Pricing() {
  const [cycle, setCycle] = useState<'yearly' | 'monthly'>('yearly')
  const live = checkoutEnabled()
  useTitle('Pricing · Copybook')
  const link = cycle === 'yearly' ? checkout.yearly || checkout.monthly : checkout.monthly || checkout.yearly
  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="mx-auto max-w-2xl text-center">
        <p className="text-[13px] font-medium text-accent">Pricing</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Know what they bought the day they file.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          Reading a portfolio is free. Copy follows the investors and stocks you care about and emails you minutes after a filing lands, with the moves inside.
        </p>
        <div className="mt-8 inline-flex rounded-full bg-ink/[0.05] p-1 text-[14px]" role="tablist" aria-label="Billing period">
          {(['monthly', 'yearly'] as const).map((c) => (
            <button key={c} role="tab" aria-selected={cycle === c} onClick={() => setCycle(c)} className={`rounded-full px-4 py-1.5 ${cycle === c ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
              {c === 'monthly' ? 'Monthly' : 'Yearly'}
              {c === 'yearly' && <span className="ml-1.5 text-[12px] font-medium text-up">Save 27%</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="mx-auto mt-10 grid max-w-5xl gap-5 md:grid-cols-[1fr_1.35fr]">
        <article className="flex flex-col rounded-[18px] bg-card p-7 shadow-[var(--shadow-card)] md:p-8">
          <h2 className="text-[17px] font-semibold">Free</h2>
          <p className="mt-1 text-[14px] text-ink-3">For reading what great investors own.</p>
          <p className="mt-6 flex items-baseline gap-1.5">
            <span className="num text-[44px] font-semibold tracking-[-0.04em]">$0</span>
            <span className="text-[14px] text-ink-3">forever</span>
          </p>
          <Button to="/investors/" variant="outline" className="mt-6 w-full">
            Browse investors
          </Button>
          <ul className="mt-7 space-y-3 text-[14.5px] text-ink-2">
            {FREE.map((f) => (
              <li key={f} className="flex gap-2.5">
                <Check className="mt-0.5 shrink-0 text-ink-3" /> {f}
              </li>
            ))}
          </ul>
        </article>

        <article className="relative flex flex-col overflow-hidden rounded-[18px] bg-night p-7 text-white shadow-[var(--shadow-frame)] md:p-8">
          <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-accent/40 blur-[80px]" aria-hidden="true" />
          <div className="relative flex items-center justify-between gap-3">
            <h2 className="text-[17px] font-semibold">Copy</h2>
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[12px] font-medium text-white/85">{TRIAL_DAYS} days free</span>
          </div>
          <p className="relative mt-1 text-[14px] text-white/60">For following every move, as it’s filed.</p>
          <p className="relative mt-6 flex items-baseline gap-1.5">
            <span className="num text-[44px] font-semibold tracking-[-0.04em]">${cycle === 'yearly' ? prices.yearly : prices.monthly}</span>
            <span className="text-[14px] text-white/60">{cycle === 'yearly' ? 'per year' : 'per month'}</span>
          </p>
          <p className="relative text-[13px] text-white/60">
            {cycle === 'yearly' ? `About $${(prices.yearly / 12).toFixed(2)} a month, billed yearly after the trial` : `Or $${prices.yearly} a year`}
          </p>
          <div className="relative mt-6">
            {live ? (
              <>
                <Button href={attributed(link)} className="w-full" size="lg">
                  Start {TRIAL_DAYS}-day free trial
                </Button>
                <p className="mt-3 text-[12px] leading-relaxed text-white/60">{TRIAL_TERMS}</p>
              </>
            ) : (
              <WaitlistForm cta="Get early access" dark id="wl-pricing" />
            )}
          </div>
          <ul className="relative mt-7 grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {COPY.map((f) => (
              <li key={f.t} className="flex gap-2.5">
                <Check className="mt-0.5 shrink-0 text-[#9fb0ff]" />
                <span>
                  <span className="block text-[14.5px] font-medium text-white">{f.t}</span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-white/65">{f.d}</span>
                </span>
              </li>
            ))}
          </ul>
        </article>
      </div>

      <section className="mx-auto mt-24 max-w-3xl">
        <h2 className="text-[28px] font-semibold tracking-[-0.03em]">Questions</h2>
        <dl className="mt-6 divide-y divide-line border-y border-line">
          {[
            [
              'How does the free trial work?',
              `You get every Copy feature for ${TRIAL_DAYS} days. Stripe takes a card at signup so the plan continues without a gap; you’re charged on day ${TRIAL_DAYS + 1} unless you cancel from Manage billing before then.`,
            ],
            [
              'How fast are filing alerts?',
              'We poll EDGAR’s latest-filings feed every minute, so a 13F alert usually arrives within a couple of minutes of the filing appearing there. For the very largest books, the first email is just as fast and the moves follow in a second email after our next data refresh, usually within a few hours. Form 4 and 13D alerts arrive within a few hours of filing. Funds have 45 days after quarter end to file a 13F, so the positions in it are always a few weeks old.',
            ],
            [
              'What’s in an alert?',
              'The fund, the quarter and a link to the filing, then its top five new, added, trimmed and exited positions with dollars and share of the book. Moves in stocks you own or watch are tagged. Schedule 13G filings are optional, and you can choose one daily digest after EDGAR closes instead of an email per filing.',
            ],
            ['Where does the data come from?', 'Every holding comes from the Form 13F-HR the fund filed with the SEC, and every between-quarter move from its Form 4 or Schedule 13D/G. We link each one to the original filing.'],
            ['Do you show live prices or returns?', 'No. Values are what the fund reported at quarter end. We don’t re-price holdings or estimate performance.'],
            ['How are options shown?', 'Calls and puts are listed apart from shares. A 13F reports options at the value of the underlying shares, so we label them as notional and leave them out of portfolio weights and holder counts.'],
            ['Can I cancel?', 'Yes, any time from Manage billing on your account page. After a paid period starts, you keep access until the end of the period you paid for.'],
            ['Is this investment advice?', 'No. Copybook shows public filings. 13F omits short positions, most non-US holdings and cash, so a portfolio here is never the whole picture.'],
          ].map(([q, a]) => (
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
