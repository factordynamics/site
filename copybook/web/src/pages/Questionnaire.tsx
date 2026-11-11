import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { FUND_SEATS } from '../config'
import { useTitle } from '../lib/data'
import { HOSTING, OUTAGES, SUBPROCESSORS, VENDOR } from '../lib/hosting'

// /security/questionnaire/: the questions a fund's vendor review asks, answered from the same lines as
// /security/ and /for-funds/ (lib/hosting), so a fact changes in one place. Printable as a PDF.
const AS_OF = 'November 11, 2026'
const a = (to: string, label: string) => (
  <Link to={to} className="font-medium text-accent hover:text-accent-2">
    {label}
  </Link>
)
const ul = (xs: string[]) => (
  <ul className="mt-1 list-disc space-y-1 pl-5">
    {xs.map((x) => (
      <li key={x}>{x}</li>
    ))}
  </ul>
)

const SECTIONS: [string, [string, ReactNode][]][] = [
  [
    'Company and service',
    [
      ['What is the service?', 'Copybook shows SEC 13F, Form 4 and Schedule 13D/G filings as they’re filed, with email, chat and webhook alerts, and a member API. Copy Fund adds your own book next to every 13F, for a team.'],
      ['Who runs it?', 'Factor Dynamics. Copybook is run by its founder with AI coding agents that maintain and deploy it. There is no security team or on-call rotation.'],
      ['Security contact', <>hello@factordynamics.com, or the {a('/contact/', 'contact form')}. We acknowledge security reports quickly; please report before disclosing.</>],
      ['Certifications and audits', VENDOR.noCert],
      ['Legal entity', 'Pending; shown on invoices once registered.'],
      ['Cyber or E&O insurance', 'None held today.'],
    ],
  ],
  [
    'Data',
    [
      ['What customer data do you hold?', VENDOR.holds],
      ['Do you hold non-public positions?', `Only if you add names by hand: they are held privately for your team. ${VENDOR.publicBook}`],
      ['Is customer data shared or used in aggregates?', 'No. An uploaded or linked book is private to your team, never shared with other members, and never used in aggregates, rankings or any public figure.'],
      ['Where is data stored?', `${HOSTING.api} ${HOSTING.files}`],
      ['Data replicated to a second location', HOSTING.sync],
      ['Retention and deletion', <>Account data is kept while you have an account. {HOSTING.deletion} Remove names, keys and seats yourself at any time, or ask us to delete everything. On Copy Fund, an uploaded book is deleted on request and we confirm it in writing. See the {a('/terms/#copy-fund', 'Copy Fund terms')}.</>],
    ],
  ],
  [
    'Access',
    [
      ['Who can access customer data today?', HOSTING.accessParts.find(([h]) => h === 'Today')?.[1]],
      ['What changes on Nov 17, 2026?', HOSTING.accessParts.find(([h]) => h === 'From Nov 17')?.[1]],
      ['Known limits', HOSTING.accessParts.find(([h]) => h === 'Limits')?.[1]],
      ['What else runs on the machine?', HOSTING.shared],
      ['Use of AI and model providers', HOSTING.accessParts.find(([h]) => h === 'AI providers')?.[1]],
      ['Customer sign-in', 'One-time links sent by email; there are no passwords. Sessions are signed, expiring tokens we don’t store.'],
      ['Team seats', `Copy Fund covers up to ${FUND_SEATS} seats at a flat price. Your team’s admin adds and removes seats from the account page; adding or removing one doesn’t change what you pay.`],
      ['API keys', 'Stored only as SHA-256 hashes and shown once, when created. A revoked key stops working within 3 seconds on whichever server is answering, the backup included, and stays revoked when we switch back.'],
    ],
  ],
  [
    'Protection',
    [
      ['Encryption in transit and at rest', HOSTING.encryption],
      ['Access logging', HOSTING.logging],
      ['Controls in place today', ul(VENDOR.today)],
      ['Controls from Nov 17, 2026', ul(VENDOR.nov17)],
      ['Change management', 'Code changes are made and deployed by the maintenance agents without per-deploy founder review. Every API deploy is logged on the status page with its build, and every website build shows its commit in the page footer.'],
      ['Penetration testing', 'None performed.'],
      // Not claimed until the founder confirms it (PM, Nov 11).
      ['MFA on admin accounts (GitHub, Cloudflare, Stripe, Amp)', 'Being confirmed by the founder; answer by Nov 17.'],
    ],
  ],
  [
    'Availability and recovery',
    [
      ['Uptime commitment', `${HOSTING.availability}`],
      ['Where the machine is and failover', HOSTING.physical],
      ['What happens when parts are down', ul(OUTAGES.map(([w, t]) => `${w}: ${t}`))],
      ['Backups', HOSTING.backups],
      ['If the founder is unreachable', VENDOR.founder],
      ['Incident history', <>Every incident that made member pages or alerts unavailable or slow is listed on the {a('/status/', 'status page')}, newest first.</>],
      ['Breach notification', 'If a breach affects member data, we notify the affected members within 72 hours of finding it.'],
    ],
  ],
  [
    'Subprocessors',
    [
      ['Who processes data for Copybook?', ul(SUBPROCESSORS.map(([w, t]) => `${w}: ${t}`))],
      ['Payments', 'Stripe handles cards, invoices and the billing portal. Card details go straight to Stripe. Pay by invoice (net 30) on request.'],
    ],
  ],
]

const slug = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function Questionnaire() {
  useTitle('Security questionnaire · Copybook')
  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Answers as of {AS_OF}</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">Security questionnaire</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          The questions a vendor review asks, answered in full, so you don’t have to send one. Every answer comes from the same lines as the {a('/security/', 'security page')}, where each change is logged with its date.
        </p>
        <div className="mt-5 flex flex-wrap gap-3 print:hidden">
          <button type="button" onClick={() => window.print()} className="inline-flex h-10 items-center rounded-full bg-ink px-4.5 text-sm font-medium text-white hover:bg-ink/85">
            Save as PDF
          </button>
          <Link to="/contact/?topic=fund" className="inline-flex h-10 items-center rounded-full px-4.5 text-sm font-medium text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] hover:bg-ink/[0.04]">
            Ask a follow-up question
          </Link>
        </div>
      </header>
      <div className="mt-10 max-w-3xl space-y-10">
        {SECTIONS.map(([h, qs]) => (
          <section key={h} id={slug(h)} className="scroll-mt-24 break-inside-avoid-page">
            <h2 className="text-[20px] font-semibold tracking-[-0.02em]">{h}</h2>
            <dl className="mt-3 divide-y divide-line rounded-[var(--radius-card)] bg-card px-5 shadow-[var(--shadow-card)] print:shadow-none">
              {qs.map(([q, ans]) => (
                <div key={q} className="grid gap-1 py-3.5 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-6">
                  <dt className="text-[14px] font-semibold text-ink">{q}</dt>
                  <dd className="text-[14.5px] leading-relaxed text-ink-2">{ans}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  )
}
