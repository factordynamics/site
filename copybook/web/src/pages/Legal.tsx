import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTitle } from '../lib/data'
import { HOSTING, SUBPROCESSORS } from '../lib/hosting'

const UPDATED = 'November 9, 2026'
// Material changes to /privacy/ and /security/, newest first. Every material edit adds a line here, and the
// newest date is the page's "Last updated".
const CHANGES: Partial<Record<'terms' | 'privacy' | 'security', [string, string][]>> = {
  security: [
    ['November 11, 2026', 'How credentials are stored: API keys as SHA-256 hashes, sign-in links and sessions as signed tokens we don’t store, private feed links stored and rotatable.'],
    ['November 11, 2026', 'Host description shortened; the disclosure is unchanged.'],
    ['November 11, 2026', 'What else runs on it: the API runs on a personal machine, under an account shared with other software that can technically read its data files.'],
    ['November 11, 2026', 'Who can see member data: Copybook is maintained by AI coding agents on Amp; the MDR terms and their exceptions are quoted, and agent requests that run through the founder’s personal Claude and Grok subscriptions go under those providers’ consumer terms.'],
    ['November 11, 2026', 'Hosting: the API is reached through a temporary Cloudflare quick tunnel until it has its own hostname. Hourly local snapshots are now encrypted. Sign-in and Fund invite link lifetimes added.'],
    ['November 11, 2026', 'Recovery: the rebuild from encrypted backups was rehearsed (about 7 minutes to restore, 30–60 minutes end to end); the standby move is not yet rehearsed.'],
    ['November 9, 2026', 'Where the API runs, encryption at rest, access, backups, physical risk and deletion described.'],
  ],
  privacy: [
    ['November 11, 2026', 'Subprocessors: Amp (AI coding agents) and its model providers, Anthropic and SpaceXAI via personal subscriptions on consumer terms, and Amp’s session-log storage on Google Cloud in the US.'],
    ['November 11, 2026', 'What we store now lists everything: your book, peers and team, imported 13F and broker CSV contents, and channel settings including webhook URLs and signing secrets.'],
    ['November 9, 2026', 'Member records copied to a private Cloudflare R2 bucket; lawful basis, retention and deletion periods added.'],
  ],
}
const email = (
  <a href="mailto:hello@factordynamics.com" className="font-medium text-accent hover:text-accent-2">
    hello@factordynamics.com
  </a>
)
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
      ['Data after you cancel', 'Data you downloaded or fetched through the API while your subscription was active may be kept and used for your internal purposes after you cancel, under the same limits. New requests stop when the subscription ends.'],
      ['API changes', <>We version the API. Breaking changes are announced at least 90 days ahead on the <Link to="/api/#changelog" className="font-medium text-accent hover:text-accent-2">API changelog</Link>; additive changes, such as new fields or endpoints, can ship at any time.</>],
      ['Availability and freshness', <>We aim to keep Copybook and its data current, but freshness is best-effort and there is no uptime or latency SLA. The refresh cadence is set out on the <Link to="/methodology/#refresh" className="font-medium text-accent hover:text-accent-2">methodology page</Link>.</>],
      ['Site content', 'You can link to and quote Copybook pages and share individual charts. Don’t scrape the site in bulk; use the API instead.'],
      ['Changes and termination', 'We may change or discontinue features, and we’ll give notice of material changes to paid plans. We may suspend accounts that break these terms. You can stop using Copybook and delete your data at any time.'],
      ['Liability', 'To the extent the law allows, Factor Dynamics is not liable for indirect or consequential losses, or for losses from decisions made using Copybook, and our total liability is limited to what you paid us in the 12 months before the claim.'],
      ['Contact', <>Questions about these terms: use the {contact} or email {email}.</>],
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
          <li>Your book: the tickers you own or watch, and the funds you follow.</li>
          <li>The peers you pick and, on Copy Fund, who is on your team.</li>
          <li>The contents of any 13F filing or broker CSV you import into My book.</li>
          <li>Your alert and channel settings, including Slack and Discord webhook URLs (which work as credentials) and the signing secrets for webhooks we send you.</li>
          <li>Your Stripe customer ID and plan status. Card details go straight to Stripe; we never see or store them.</li>
          <li>API key names, creation dates and request counts, if you create keys.</li>
          <li>If you join the waitlist, your email, encrypted in your browser before it’s sent.</li>
        </ul>,
      ],
      ['What we don’t do', 'We don’t sell or rent your data, share it with advertisers, or use advertising cookies. Your follows and owned stocks are never shown to other members or used in public aggregates.'],
      ['In your browser', 'Your browser’s local storage keeps your sign-in session; the last copy of your account, follows and recent insider filings, so your pages still load when our server is slow; and, for 30 days, the campaign link you arrived from, so a purchase can be attributed to it. Signing out clears everything but the campaign link. Nothing else is stored there.'],
      ['Where it’s kept', `${HOSTING.api} ${HOSTING.sync} ${HOSTING.files}`],
      [
        'Who processes it',
        <>
          <p>These companies process data for Copybook, each only to provide its service:</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            {SUBPROCESSORS.map(([who, what]) => (
              <li key={who}>
                <span className="font-medium text-ink">{who}</span>: {what}
              </li>
            ))}
          </ul>
        </>,
      ],
      ['Lawful basis', 'We process members’ data to provide the service they signed up for (performance of a contract), and send the free weekly email on the basis of our legitimate interest in telling readers about the week’s filings; you can unsubscribe from any email.'],
      ['How long we keep it', 'Account data is kept while you have an account, then for up to 30 days in encrypted backups. Billing records are kept by Stripe and by us for as long as the law requires.'],
      ['Data processing agreements', 'A DPA and Standard Contractual Clauses are available on request once our legal entity details are published.'],
      ['Deleting your data', <>Cancel any paid plan from Manage billing, then ask us to delete your account through the {contact} (choose “Delete my data”) or by email to {email}. We delete your account record, follows and keys; Stripe keeps billing records it must keep by law. {HOSTING.deletion}</>],
    ],
  },
  security: {
    title: 'Security',
    lead: 'Where Copybook keeps data and how it’s protected.',
    sections: [
      ['Where data lives', `${HOSTING.api} ${HOSTING.sync} ${HOSTING.files}`],
      ['Encryption', HOSTING.encryption],
      ['Who can see member data', HOSTING.access],
      ['Where the machine is', HOSTING.physical],
      ['What else runs on it', HOSTING.shared],
      ['Backups', HOSTING.backups],
      ['Access logging', HOSTING.logging],
      ['Availability', <>{HOSTING.availability} Live status and incidents are on the <Link to="/status/" className="font-medium text-accent hover:text-accent-2">status page</Link>.</>],
      ['Sign-in', 'Sign-in is by emailed one-time links; there are no passwords to leak. A sign-in link you ask for works once, within 15 minutes; a Copy Fund invite link works once, within 7 days. Session tokens are never put in URLs. CSV downloads use single-use links that expire in 60 seconds.'],
      ['Your book is private', <>A list of holdings you upload or enter is private to you, or to your team on Copy Fund. It is never shared, except as described under <Link to="/security/#who-can-see-member-data" className="font-medium text-accent hover:text-accent-2">Who can see member data</Link>; it is never shown to other members, and never used in aggregates, rankings or anything we publish.</>],
      ['API keys', 'A key’s secret is shown once, when you create it. Revoke a key from your account page and requests with it fail immediately.'],
      ['How credentials are stored', 'API keys are stored only as SHA-256 hashes and shown once; sign-in links and sessions are signed, expiring tokens we don’t store; private feed links are stored so your account page can show them, and you can rotate one anytime.'],
      ['Deleting data', <>Remove follows, owned stocks and keys yourself on your account page at any time, or ask us to delete everything through the {contact}. {HOSTING.deletion}</>],
      ['Breach notification', 'If a breach affects member data, we notify the affected members within 72 hours of finding it.'],
      ['Subprocessors', <>The companies that process data for Copybook are listed on the <Link to="/privacy/" className="font-medium text-accent hover:text-accent-2">privacy page</Link>.</>],
      ['Certifications and questionnaires', <>{HOSTING.soc2} Email {email} or use the {contact}.</>],
      ['Reporting a problem', <>If you find a security issue, please email {email} or use the {contact} before disclosing it. We’ll respond quickly.</>],
    ],
  },
}

export function Legal({ page }: { page: keyof typeof PAGES }) {
  const p = PAGES[page]
  useTitle(`${p.title} · Copybook`)
  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Last updated {CHANGES[page]?.[0][0] ?? UPDATED}</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">{p.title}</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">{p.lead}</p>
      </header>
      <div className="mt-12 max-w-3xl space-y-10">
        {p.sections.map(([h, body]) => (
          <section key={h} id={h.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')} className="scroll-mt-24">
            <h2 className="text-[20px] font-semibold tracking-[-0.02em]">{h}</h2>
            <div className="mt-2.5 text-[15.5px] leading-relaxed text-ink-2">{body}</div>
          </section>
        ))}
        {CHANGES[page] && (
          <section id="changes" className="scroll-mt-24 border-t border-line pt-8">
            <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Changes to this page</h2>
            <ul className="mt-3 space-y-2.5 text-[14px] leading-relaxed text-ink-2">
              {CHANGES[page]!.map(([d, t]) => (
                <li key={d + t.slice(0, 20)}>
                  <span className="num block text-[12.5px] text-ink-3">{d}</span>
                  {t}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
