import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTitle } from '../lib/data'
import { FUND_SEATS } from '../config'
import { HOSTING, SUBPROCESSORS } from '../lib/hosting'

const UPDATED = 'November 9, 2026'
// Material changes to /privacy/ and /security/, newest first. Every material edit adds a line here, and the
// newest date is the page's "Last updated".
const CHANGES: Partial<Record<'terms' | 'privacy' | 'security', [string, string][]>> = {
  terms: [['November 11, 2026', 'Copy Fund: the founding price kept while subscribed, up to 10 seats at a flat price, net 30 invoicing on request, an uploaded book kept confidential and deleted on request with written confirmation, 60 days’ notice of price changes and a reminder 30 days before an annual renewal.'], ['November 11, 2026', 'Accounts and plans: if we discontinue a paid plan during a prepaid period, we refund the unused part pro rata.']],
  security: [
    ['November 11, 2026', 'Who can see member data: the November 17 payment-key and administrator-access lines moved under From Nov 17; Limits adds what keeps running if the founder is unreachable for a week. Where the machine is: from November 17 a restore from backup needs the founder.'],
    ['November 11, 2026', 'Backups: from November 17 the backup key’s private half is kept offline by the founder; weekly checks without the key and a monthly test restore. Limits: what administrator access the agents’ account has from November 17.'],
    ['November 11, 2026', 'Who can see member data moved to the top and split into Today, From Nov 17, Limits and AI providers; from Nov 17 the agents’ payment key is restricted to billing support.'],
    ['November 11, 2026', 'The API’s own hostname will be api.factordynamics.com, with at least 7 days’ notice before the old host stops working.'],
    ['November 11, 2026', 'Sign-in: sessions last 30 days from sign-in; Sign out everywhere on /account/ ends every session, copied ones included; welcome-email links work for 7 days; the post-checkout hand-off lasts 2 minutes.'],
    ['November 11, 2026', 'Access logging: operator and /ops/ reads of member data are logged with who, when, route and row ID; direct shell reads are not covered until Nov 17. What else runs on it now lists member books and peer lists among the readable files.'],
    ['November 11, 2026', 'Who can see member data: what changes on Nov 17 (a separate service account for member data and secrets; rotated signing secrets) and the limits that remain (deployed code can read member data, deploys aren’t individually reviewed, isolation stops accidental reads only, older agent session logs).'],
    ['November 11, 2026', 'Who can see member data now leads with how member data is kept out of agent sessions (counts and row IDs only, logged book reads, a separate API account from Nov 17) and says the model provider’s training setting is unconfirmed, so assume it may be on. Access logging updated to match.'],
    ['November 11, 2026', 'How credentials are stored: API keys as SHA-256 hashes, sign-in links and sessions as signed tokens we don’t store, private feed links stored and rotatable.'],
    ['November 11, 2026', 'Host description shortened; the disclosure is unchanged.'],
    ['November 11, 2026', 'What else runs on it: the API runs on a personal machine, under an account shared with other software that can technically read its data files.'],
    ['November 11, 2026', 'Who can see member data: Copybook is maintained by AI coding agents on Amp; the MDR terms and their exceptions are quoted, and agent requests that run through the founder’s personal Claude and Grok subscriptions go under those providers’ consumer terms.'],
    ['November 11, 2026', 'Hosting: the API is reached through a temporary Cloudflare quick tunnel until it has its own hostname. Hourly local snapshots are now encrypted. Sign-in and Fund invite link lifetimes added.'],
    ['November 11, 2026', 'Failover: the backup serves accounts as of about a minute before the move; changes made on it (seats, sign-outs, API key changes, channels and settings) carry over when service moves back, and follows can’t be changed meanwhile. API clients don’t move to the backup. Limits: if the founder is unreachable, the move to the backup is automatic.'],
    ['November 11, 2026', 'Failover: member access now moves to the Cloudflare backup automatically (within 2–3 minutes after two failed checks a minute apart, back after 3 healthy minutes, capped at 95% of the backup’s daily quota). Tested Nov 11, 08:53 UTC: moved in 1 min 54 s, with about 2 minutes of member errors first.'],
    ['November 11, 2026', 'Recovery: the rebuild from encrypted backups was rehearsed (about 7 minutes to restore, 30–60 minutes end to end); the automatic failover was tested later the same day (see Failover above).'],
    ['November 9, 2026', 'Where the API runs, encryption at rest, access, backups, physical risk and deletion described.'],
  ],
  privacy: [
    ['November 11, 2026', 'The encrypted waitlist is retired and its key deleted; the waitlist line is removed from What we store.'],
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
      ['Accounts and plans', 'Paid plans renew automatically until you cancel from Manage billing. A free trial converts to a paid plan at its end unless you cancel before then. After a paid period starts, you keep access until it ends; we don’t refund partial periods unless the law requires it. If we discontinue a paid plan during a prepaid period, we refund the unused part pro rata.'],
      [
        'Copy Fund',
        <>
          <p>If your team subscribes to Copy Fund, these commitments are part of these terms:</p>
          <ul className="mt-2.5 list-disc space-y-1.5 pl-5">
            <li>Price: your founding price stays the same for as long as the subscription continues without a break.</li>
            <li>Seats: up to {FUND_SEATS} seats at one flat price. Adding or removing a seat doesn’t change what you pay.</li>
            <li>Invoicing: annual plans can be invoiced, payable net 30, on request to {email}.</li>
            <li>Your book: a book your team uploads or links is confidential to your team. We never share it and never use it in aggregates or anyone else’s figures, and we delete it on request and confirm the deletion in writing. A book linked to a public 13F filing is public through the filing itself.</li>
            <li>Price changes: we give at least 60 days’ notice by email before any price change takes effect for your subscription.</li>
            <li>Renewal: we email the account owner at least 30 days before an annual renewal.</li>
          </ul>
        </>,
      ],
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
      [
        'Who can see member data',
        <>
          {HOSTING.accessParts.map(([h, t]) => (
            <span key={h} className="mt-3 block first:mt-0">
              <span className="block font-semibold text-ink">{h}</span>
              {t}
            </span>
          ))}
        </>,
      ],
      ['Where data lives', `${HOSTING.api} ${HOSTING.sync} ${HOSTING.files}`],
      ['Encryption', HOSTING.encryption],
      ['Where the machine is', HOSTING.physical],
      ['What else runs on it', HOSTING.shared],
      ['Backups', HOSTING.backups],
      ['Access logging', HOSTING.logging],
      ['Availability', <>{HOSTING.availability} Live status and incidents are on the <Link to="/status/" className="font-medium text-accent hover:text-accent-2">status page</Link>.</>],
      ['Sign-in', 'Sign-in is by emailed one-time links; there are no passwords to leak. A sign-in link you ask for works once, within 15 minutes; links in the welcome email and Copy Fund seat invites work once, within 7 days; the hand-off right after checkout lasts 2 minutes. Sessions last 30 days from sign-in and aren’t extended by use; Sign out everywhere on your account page ends every session at once, including one copied from another browser; signing out in one browser ends only that browser’s session. API keys stay valid until you delete them. A Copy Fund owner can also sign a seat out everywhere. Session tokens are never put in URLs. CSV downloads use single-use links that expire in 60 seconds.'],
      ['Your book is private', <>A list of holdings you upload or enter is private to you, or to your team on Copy Fund. It is never shared, except as described under <Link to="/security/#who-can-see-member-data" className="font-medium text-accent hover:text-accent-2">Who can see member data</Link>; it is never shown to other members, and never used in aggregates, rankings or anything we publish.</>],
      ['API keys', 'A key’s secret is shown once, when you create it. Revoke a key from your account page and requests with it fail immediately.'],
      ['How credentials are stored', 'API keys are stored only as SHA-256 hashes and shown once; sign-in links and sessions are signed, expiring tokens we don’t store; private feed links are stored so your account page can show them, and you can rotate one anytime.'],
      ['Deleting data', <>Remove follows, owned stocks and keys yourself on your account page at any time, or ask us to delete everything through the {contact}. {HOSTING.deletion}</>],
      ['Breach notification', 'If a breach affects member data, we notify the affected members within 72 hours of finding it.'],
      ['Subprocessors', <>The companies that process data for Copybook are listed on the <Link to="/privacy/" className="font-medium text-accent hover:text-accent-2">privacy page</Link>.</>],
      ['Certifications and questionnaires', <>{HOSTING.soc2} The <Link to="/security/questionnaire/" className="font-medium text-accent hover:text-accent-2">security questionnaire</Link> is filled in and can be saved as a PDF. For anything it doesn’t answer, email {email} or use the {contact}.</>],
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
