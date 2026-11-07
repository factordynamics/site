import { useState } from 'react'
import { Link } from 'react-router-dom'
import { WaitlistForm } from '../components/Waitlist'
import { Button, Check } from '../components/ui'
import { checkout, checkoutEnabled, DATA_TERMS, prices, RENEWAL_TERMS } from '../config'

const FREE = ['Latest 13F portfolio for every investor', 'Portfolio map, sector mix and top holdings', 'Consensus book with search', 'Every 13F filer in search']
const COPY = ['Everything in Free', 'Quarter-over-quarter buys, sells and exits', 'Full filing history for each investor', 'Email the day a fund you follow files', 'CSV export of any portfolio']

export function Pricing() {
  const [cycle, setCycle] = useState<'yearly' | 'monthly'>('yearly')
  const live = checkoutEnabled()
  const link = cycle === 'yearly' ? checkout.yearly || checkout.monthly : checkout.monthly || checkout.yearly
  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="mx-auto max-w-2xl text-center">
        <p className="text-[13px] font-medium text-accent">Pricing</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">The latest quarter is free. Copy shows what changed.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">Read any portfolio today. Upgrade when you want the buys, the sells and an email the moment a filing lands.</p>
        <div className="mt-8 inline-flex rounded-full bg-ink/[0.05] p-1 text-[14px]" role="tablist" aria-label="Billing period">
          {(['monthly', 'yearly'] as const).map((c) => (
            <button key={c} role="tab" aria-selected={cycle === c} onClick={() => setCycle(c)} className={`rounded-full px-4 py-1.5 ${cycle === c ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
              {c === 'monthly' ? 'Monthly' : 'Yearly'}
              {c === 'yearly' && <span className="ml-1.5 text-[12px] font-medium text-up">Save 27%</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="mx-auto mt-10 grid max-w-4xl gap-5 md:grid-cols-2">
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
          <div className="relative flex items-center justify-between">
            <h2 className="text-[17px] font-semibold">Copy</h2>
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[12px] font-medium">Most popular</span>
          </div>
          <p className="relative mt-1 text-[14px] text-white/60">For following every move.</p>
          <p className="relative mt-6 flex items-baseline gap-1.5">
            <span className="num text-[44px] font-semibold tracking-[-0.04em]">${cycle === 'yearly' ? prices.yearly : prices.monthly}</span>
            <span className="text-[14px] text-white/60">{cycle === 'yearly' ? 'per year' : 'per month'}</span>
          </p>
          <p className="relative text-[13px] text-white/60">{cycle === 'yearly' ? `About $${(prices.yearly / 12).toFixed(2)} a month, billed yearly` : `Or $${prices.yearly} a year`}</p>
          <div className="relative mt-6">
            {live ? (
              <>
                <Button href={link} className="w-full" size="lg">
                  Get Copy
                </Button>
                <p className="mt-3 text-[12px] leading-relaxed text-white/55">{RENEWAL_TERMS}</p>
              </>
            ) : (
              <>
                <WaitlistForm cta="Get early access" dark id="wl-pricing" />
                <p className="mt-2 text-[12.5px] text-white/55">Copy opens with the Q3 2026 filings. Join and we’ll email you first.</p>
              </>
            )}
          </div>
          <ul className="relative mt-7 space-y-3 text-[14.5px] text-white/80">
            {COPY.map((f) => (
              <li key={f} className="flex gap-2.5">
                <Check className="mt-0.5 shrink-0 text-[#9fb0ff]" /> {f}
              </li>
            ))}
          </ul>
        </article>
      </div>

      <section className="mx-auto mt-24 max-w-3xl">
        <h2 className="text-[28px] font-semibold tracking-[-0.03em]">Questions</h2>
        <dl className="mt-6 divide-y divide-line border-y border-line">
          {[
            ['Where does the data come from?', 'Every holding comes from the Form 13F-HR the fund filed with the SEC. We link each portfolio to its original filing.'],
            ['How current is it?', 'Funds file within 45 days of quarter end, so a 13F shows positions as of the last quarter end. We check EDGAR several times a day and update as soon as a filing appears.'],
            ['Do you show live prices or returns?', 'No. Values are what the fund reported. We don’t re-price holdings or estimate performance.'],
            ['Can I cancel?', 'Yes, any time, from the billing portal linked on your account page. You keep Copy until the end of the period you paid for.'],
            ['Is this investment advice?', 'No. Copybook shows public filings. 13F omits short positions, most non-US holdings and cash, so a portfolio here is never the whole picture.'],
          ].map(([q, a]) => (
            <div key={q} className="py-5">
              <dt className="text-[16px] font-medium">{q}</dt>
              <dd className="mt-2 text-[15px] leading-relaxed text-ink-2">{a}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 text-[14px] text-ink-3">
          Already subscribed? <Link to="/account/" className="font-medium text-accent hover:text-accent-2">Sign in to your account</Link>. {DATA_TERMS}
        </p>
      </section>
    </div>
  )
}
