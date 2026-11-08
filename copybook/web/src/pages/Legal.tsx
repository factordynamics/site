import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTitle } from '../lib/data'

const UPDATED = 'November 8, 2026'
const contact = (
  <Link to="/contact/" className="font-medium text-accent hover:text-accent-2">
    contact form
  </Link>
)

const PAGES: Record<'terms' | 'privacy' | 'security', { title: string; lead: string; sections: [string, ReactNode][] }> = {
  terms: {
    title: 'Terms of use',
    lead: 'The rules for using Copybook, its paid plans and its API. Copybook is operated by Factor Dynamics.',
    sections: [
      ['The data', 'Copybook shows information from public SEC EDGAR filings (Forms 13F-HR, 13F-NT, 4 and Schedules 13D and 13G), as filed, with the processing described on our methodology page. Filings can be late, amended or wrong, and our processing can be wrong too. Everything is provided as is, with no warranty of accuracy, completeness or timeliness.'],
      ['Not investment advice', 'Nothing on Copybook is a recommendation to buy or sell a security. A 13F leaves out short positions, most non-US holdings, cash and more, and is filed up to 45 days after the quarter ends. Make your own decisions.'],
      ['Accounts and plans', 'Paid plans renew automatically until you cancel from Manage billing. A free trial converts to a paid plan at its end unless you cancel before then. After a paid period starts, you keep access until it ends; we don’t refund partial periods unless the law requires it.'],
      ['API use', 'API keys are for you, or for your organization’s internal research, models and tools. You may use the results in your own work and share individual findings with attribution. You may not resell, sublicense or redistribute the API’s data in bulk, build a competing data service from it, or share keys outside your plan’s seats. Respect the rate limits.'],
      ['Site content', 'You can link to and quote Copybook pages and share individual charts. Don’t scrape the site in bulk; use the API instead.'],
      ['Changes and termination', 'We may change or discontinue features, and we’ll give notice of material changes to paid plans. We may suspend accounts that break these terms. You can stop using Copybook and delete your data at any time.'],
      ['Liability', 'To the extent the law allows, Factor Dynamics is not liable for indirect or consequential losses, or for losses from decisions made using Copybook, and our total liability is limited to what you paid us in the 12 months before the claim.'],
      ['Contact', <>Questions about these terms: use the {contact}.</>],
    ],
  },
  privacy: {
    title: 'Privacy',
    lead: 'What Copybook stores about you, why, and how to have it deleted. We never sell your data.',
    sections: [
      [
        'What we store',
        <ul key="s" className="list-disc space-y-1.5 pl-5">
          <li>Your email address, to sign you in and send the alerts you ask for.</li>
          <li>Your follows, the stocks you own or watch, and your alert settings.</li>
          <li>Your Stripe customer ID and plan status. Card details go straight to Stripe; we never see or store them.</li>
          <li>API key names, creation dates and request counts, if you create keys.</li>
          <li>If you join the waitlist, your email, encrypted in your browser before it’s sent.</li>
        </ul>,
      ],
      ['What we don’t do', 'We don’t sell or rent your data, share it with advertisers, or use advertising cookies. Your follows and owned stocks are never shown to other members or used in public aggregates.'],
      ['In your browser', 'We keep your sign-in session and, for 30 days, the campaign link you arrived from (so a purchase can be attributed to it) in your browser’s local storage. Nothing else is stored there.'],
      ['Who processes it', 'Cloudflare runs our API and stores account data; Stripe handles payments; our email provider delivers alerts and sign-in links. Each processes data only to provide that service.'],
      ['Deleting your data', <>Cancel any paid plan from Manage billing, then ask us to delete your account through the {contact} (choose “Delete my data”). We delete your account record, follows and keys; Stripe keeps billing records it must keep by law.</>],
    ],
  },
  security: {
    title: 'Security',
    lead: 'Where Copybook keeps data and how it’s protected.',
    sections: [
      ['Where data lives', 'The website and public 13F data are static files on GitHub Pages. Account data (members, follows, owned and watched stocks, alert settings, API keys) lives in Cloudflare Workers KV, and paid history files in Cloudflare R2, behind our API on Cloudflare Workers. Payments are handled entirely by Stripe.'],
      ['Sign-in', 'Sign-in is by emailed one-time links; there are no passwords to leak. Session tokens are never put in URLs. CSV downloads use single-use links that expire in 60 seconds.'],
      ['Your book is private', 'A list of holdings you upload or enter is private to you, or to your team on Copy Fund. It is never shared, never shown to other members, and never used in aggregates, rankings or anything we publish.'],
      ['API keys', 'A key’s secret is shown once, when you create it. Revoke a key from your account page and requests with it fail immediately.'],
      ['Deleting data', <>Remove follows, owned stocks and keys yourself on your account page at any time, or ask us to delete everything through the {contact}.</>],
      ['Reporting a problem', <>If you find a security issue, please tell us through the {contact} before disclosing it. We’ll respond quickly.</>],
    ],
  },
}

export function Legal({ page }: { page: keyof typeof PAGES }) {
  const p = PAGES[page]
  useTitle(`${p.title} · Copybook`)
  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Last updated {UPDATED}</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">{p.title}</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">{p.lead}</p>
      </header>
      <div className="mt-12 max-w-3xl space-y-10">
        {p.sections.map(([h, body]) => (
          <section key={h}>
            <h2 className="text-[20px] font-semibold tracking-[-0.02em]">{h}</h2>
            <div className="mt-2.5 text-[15.5px] leading-relaxed text-ink-2">{body}</div>
          </section>
        ))}
      </div>
    </div>
  )
}
