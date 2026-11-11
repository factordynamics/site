import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Arrow, Button, Check, Panel } from '../components/ui'
import { FUND_SEATS, FUND_WHY, plans, TRIAL_DAYS, trialTerms, SPEED_CLAIMS } from '../config'
import { attributed, referredCheckout } from '../lib/attribution'
import { gapLabel, loadLatency } from '../lib/account'
import { BASE, useAsync, useTitle } from '../lib/data'
import { API_TIMING, API_UNIVERSE, HOST_MOVE, HOSTING, VENDOR } from '../lib/hosting'
import { HISTORY_EXACT, loadCoverage } from '../lib/stocks'

// Landing pages for the two buyers of the paid data plans: investment teams (Copy Fund) and quants
// (Copy Pro). Each has one primary call to action. Comparisons stick to facts a reader can check.

function Hero({ kicker, title, sub, cta, note }: { kicker: string; title: ReactNode; sub: string; cta: ReactNode; note: ReactNode }) {
  return (
    <header className="max-w-3xl">
      <p className="text-[13px] font-medium text-accent">{kicker}</p>
      <h1 className="mt-3 text-[40px] font-semibold leading-[1.03] tracking-[-0.045em] md:text-[56px]">{title}</h1>
      <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-ink-2 md:text-[18px]">{sub}</p>
      <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
        {cta}
        <Link to="/pricing/" className="text-[14px] font-medium text-ink-2 hover:text-ink">
          Compare plans
        </Link>
      </div>
      <p className="mt-3 max-w-xl text-[12.5px] leading-snug text-ink-3">{note}</p>
    </header>
  )
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded-[var(--radius-card)] bg-line shadow-[var(--shadow-card)] sm:grid-cols-3">
      {items.map(([v, l]) => (
        // The label is the term and the figure its value; the figure shows first, so a link in the
        // label is rendered (and focusable) once, where it's seen.
        <div key={v} className="flex flex-col-reverse bg-card p-5 md:p-6">
          <dt className="mt-1 text-[13.5px] text-ink-2">{l}</dt>
          <dd className="num text-[26px] font-semibold tracking-[-0.03em]">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Shot({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="mt-12">
      {/* On a phone the screenshot keeps a readable width and scrolls sideways; a tap opens it full size. */}
      <div className="overflow-x-auto rounded-[18px] bg-paper p-2 shadow-[var(--shadow-frame)] md:p-3" tabIndex={0} role="region" aria-label={alt}>
        <a href={`${BASE}img/${src}`} target="_blank" rel="noopener" className="block min-w-[760px] md:min-w-0">
          <img src={`${BASE}img/${src}`} alt={alt} width={1600} loading="lazy" className="block h-auto w-full rounded-[12px]" />
        </a>
      </div>
      <figcaption className="mt-3 text-[12.5px] text-ink-3">
        <span className="md:hidden">Scroll sideways, or tap to open full size. </span>
        {caption}
      </figcaption>
    </figure>
  )
}

function Features({ items }: { items: [string, ReactNode][] }) {
  return (
    <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {items.map(([t, d]) => (
        <div key={t} className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Check className="size-3.5" />
          </span>
          <h3 className="mt-4 text-[16px] font-semibold tracking-[-0.01em]">{t}</h3>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{d}</p>
        </div>
      ))}
    </div>
  )
}

// The vendor review in one box: what we hold, what's public anyway, controls with their dates, what we
// don't have, and what happens without the founder (lib/hosting VENDOR, the same lines as the questionnaire).
function VendorSummary() {
  const row = (h: string, body: ReactNode) => (
    <div className="grid gap-1 py-3.5 first:pt-0 last:pb-0 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-6">
      <dt className="text-[13px] font-semibold text-ink">{h}</dt>
      <dd className="text-[14.5px] leading-relaxed text-ink-2">{body}</dd>
    </div>
  )
  const list = (xs: string[]) => (
    <ul className="list-disc space-y-1 pl-4.5 marker:text-ink-3">
      {xs.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  )
  return (
    <section aria-labelledby="vendor-summary" className="mt-6 rounded-[var(--radius-card)] bg-card p-5 shadow-[0_0_0_1.5px_rgb(43_68_214/0.35),var(--shadow-card)] md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="vendor-summary" className="text-[17px] font-semibold tracking-[-0.01em]">
          Vendor summary
        </h3>
        <p className="text-[12.5px] text-ink-3">As of Nov 11, 2026</p>
      </div>
      <dl className="mt-4 divide-y divide-line">
        {row('What we hold', VENDOR.holds)}
        {row('Public anyway', VENDOR.publicBook)}
        {row('Controls today', list(VENDOR.today))}
        {row('From Nov 17, 2026', list(VENDOR.nov17))}
        {row('What we don’t have', <><span className="font-medium text-ink">{VENDOR.noCert}</span> {VENDOR.training}</>)}
        {row('If the founder is unreachable', VENDOR.founder)}
        {row('Legal entity', 'Details to be published.')}
      </dl>
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-4 text-[14px]">
        <Link to="/security/questionnaire/" className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent-2">
          Security questionnaire, filled in <Arrow className="size-3" />
        </Link>
        <Link to="/security/" className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent-2">
          Full security page and change log <Arrow className="size-3" />
        </Link>
      </div>
    </section>
  )
}

function H2({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="mt-20 max-w-2xl">
      <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.03em] md:text-[34px]">{children}</h2>
      {sub && <p className="mt-2 text-[16px] leading-relaxed text-ink-2">{sub}</p>}
    </div>
  )
}

function Band({ title, sub, cta }: { title: string; sub: string; cta: ReactNode }) {
  return (
    <section className="relative mt-20 overflow-hidden rounded-[22px] bg-night px-6 py-12 text-white md:px-12 md:py-14">
      <div className="pointer-events-none absolute -right-24 -top-24 size-[380px] rounded-full bg-accent/30 blur-[100px]" aria-hidden="true" />
      <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div className="max-w-xl">
          <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.03em]">{title}</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-white/70">{sub}</p>
        </div>
        {cta}
      </div>
    </section>
  )
}

export function ForFunds() {
  useTitle('Copybook for investment teams · Copy Fund')
  const cov = useAsync(loadCoverage, [])
  const filers = cov.data?.filers ? cov.data.filers.toLocaleString('en-US') : '8,900+'
  // The speed claim shows the live median once real alerts have gone out, and links to the log.
  const lat = useAsync(loadLatency, [])
  const median = SPEED_CLAIMS && lat.data?.count ? lat.data.median_seconds : null
  const card = attributed(plans.fund.links.yearly || plans.fund.links.monthly)
  const cta = (
    <span className="flex flex-wrap items-center gap-3">
      <Button to="/contact/?topic=fund&trial=invoice" size="md">
        Start a 14-day trial, pay by invoice <Arrow />
      </Button>
      {card && (
        <Button href={card} onClick={referredCheckout('fund', 'yearly', card)} variant="outline" size="md">
          Or start on a card
        </Button>
      )}
    </span>
  )
  return (
    <div className="container-x pt-12 md:pt-16">
      <Hero
        kicker="Copy Fund · for investment teams"
        title="Know who owns what you own."
        sub={`Your book next to every 13F filer: who holds your names, how crowded they are, and how the funds you benchmark against are positioned. ${FUND_SEATS} seats, shared lists, one team channel in Slack, and an annual invoice.`}
        cta={cta}
        note="Founding price $1,990/yr for teams that subscribe before Dec 31, kept for as long as you stay. Invoiced net 30; W-9 available once our entity details are published. Prepaid and protected: pro-rata refund if we ever discontinue the plan. Prices exclude applicable taxes. Copybook does not currently collect sales tax."
      />

      <Facts items={[[`${filers}`, '13F filers covered, the latest filing of each'], median != null
            ? [`${gapLabel(median)}`, <>median from EDGAR acceptance to alert this season, <Link to="/speed/" className="text-accent hover:text-accent-2">every alert timed</Link></>]
            : ['As filed', <>alerts sent as filings hit EDGAR, for the funds you follow, <Link to="/speed/" className="text-accent hover:text-accent-2">every alert timed</Link></>], ['Form 4 · 13D/G', 'insider and activist filings on your names, between 13Fs']]} />

      <Shot
        src="my-book-example.webp"
        alt="My book: nine stocks with the number of funds holding each, change since the last 13F, top-10 counts, this season's buying and selling, and net trades"
        caption="My book with Pershing Square’s Q2 2026 13F linked as the owned book. Real SEC filing data, captured Nov 8, 2026."
      />

      <H2 sub="Everything a PM or analyst checks in filing week, in one place the whole team shares.">Built for the book you run</H2>
      <Features
        items={[
          ['My book', 'Paste tickers, upload a broker CSV or link your fund’s own 13F. Every name shows how many funds hold it, how many have it in their top 10, and who bought and sold this season.'],
          ['Peer overlap', 'Pick up to 12 funds you benchmark against. See how much of their books overlap, the names they share, and what each did in yours.'],
          [`${FUND_SEATS} seats, shared lists`, 'Each colleague signs in with their own email and keeps their own alert settings. Follows, the watchlist, the owned book and peers are shared.'],
          ['One team channel', 'Every filing from the funds you follow posts once to your team’s Slack channel as it hits EDGAR, whoever follows the fund, with new, added, trimmed and exited positions inside.'],
          ['Insider and 13D alerts', 'Open-market insider buys over your threshold, cluster buys, and any filer’s new 13D on the stocks you own or watch.'],
          [
            'Invoice, net 30',
            <>
              Annual plan, invoiced net 30. W-9 available once our entity details are published.{' '}
              {/* The Fund card checkout /pricing/ links (yearly, its default), with the visitor's attribution. */}
              <a href={attributed(plans.fund.links.yearly || plans.fund.links.monthly)} onClick={referredCheckout('fund', 'yearly', attributed(plans.fund.links.yearly || plans.fund.links.monthly))} className="font-medium text-accent hover:text-accent-2">
                Or start on a card with a {TRIAL_DAYS}-day trial
              </a>
              . Pay by invoice (net 30): email{' '}
              <a href="mailto:hello@factordynamics.com" className="font-medium text-accent hover:text-accent-2">
                hello@factordynamics.com
              </a>
              .
            </>,
          ],
        ]}
      />
      <p className="mt-6 max-w-3xl rounded-[var(--radius-card)] bg-ink/[0.04] px-5 py-4 text-[15px] leading-relaxed text-ink-2">
        <strong className="font-semibold text-ink">{FUND_WHY.split('? ')[0]}?</strong> {FUND_WHY.split('? ')[1]}
      </p>

      <Shot
        src="peers-example.webp"
        alt="Peer overlap: for each of five peer funds, how many of your names it holds, their share of its book, its largest of your names, and what it bought, trimmed or exited this quarter"
        caption="Peer overlap with five well-known managers as peers, against the same book. Also on the page: a book-overlap matrix and the stocks your peers share."
      />

      <H2 sub="Your holdings are yours. We hold the least we need and say exactly where it lives.">Security your compliance team can read</H2>
      <VendorSummary />
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Panel className="h-full">
          <ul className="space-y-2.5 text-[14.5px] leading-relaxed text-ink-2">
            <li>
              An uploaded or linked book is private to your team. It is never shared, except as described under{' '}
              <Link to="/security/#who-can-see-member-data" className="font-medium text-accent hover:text-accent-2">
                Who can see member data
              </Link>
              , and never used in aggregates.
            </li>
            <li>{HOSTING.api}</li>
            <li>{HOSTING.shared}</li>
            <li>{HOSTING.encryption}</li>
            {HOSTING.accessParts.map(([h, t]) => (
              <li key={h}>
                <span className="font-medium text-ink">Who can see member data, {h.charAt(0).toLowerCase() + h.slice(1)}:</span> {t}
              </li>
            ))}
            <li>{HOSTING.physical}</li>
            <li>{HOSTING.backups} {HOSTING.logging}</li>
          </ul>
        </Panel>
        <Panel>
          <ul className="space-y-2.5 text-[14.5px] leading-relaxed text-ink-2">
            <li>
              {HOSTING.availability}{' '}
              <Link to="/status/" className="font-medium text-accent hover:text-accent-2">
                Status and incidents
              </Link>
            </li>
            <li>Breaches affecting member data are notified within 72 hours.</li>
            <li>Remove names, keys and seats yourself at any time, or ask us to delete everything.</li>
            <li>
              {HOSTING.soc2}{' '}
              <Link to="/security/questionnaire/" className="font-medium text-accent hover:text-accent-2">
                Read the filled-in questionnaire
              </Link>
            </li>
          </ul>
        </Panel>
      </div>

      <Band title="Put your book next to every 13F." sub="Tell us your team size and how you’d like to pay. We aim to reply within one business day." cta={cta} />
    </div>
  )
}

export function ForQuants() {
  useTitle('Copybook API for quants · Copy Pro')
  const cov = useAsync(loadCoverage, [])
  const filers = cov.data?.filers ? cov.data.filers.toLocaleString('en-US') : '8,900+'
  const sample = useAsync(() => fetch(`${BASE}api/sample-holdings.json`).then((r) => r.text()), [])
  const trial = attributed(plans.pro.links.yearly || plans.pro.links.monthly)
  const cta = (
    <Button href={trial} onClick={referredCheckout('pro', plans.pro.links.yearly ? 'yearly' : 'monthly', trial)} size="md">
      Start {TRIAL_DAYS}-day free trial <Arrow />
    </Button>
  )
  // The base URL lives on /api/ only (the Space, Nov 11): this marketing page names no host.
  const curl = `curl "$COPYBOOK_API/v1/filers/warren-buffett/holdings/latest" \\
  -H "Authorization: Bearer cbk_live_..." \\
  -H "User-Agent: my-research/1.0"`
  return (
    <div className="container-x pt-12 md:pt-16">
      <Hero
        kicker="Copy Pro · the Copybook API"
        title="13F, Form 4 and 13D/G, as clean JSON."
        sub="Every 13F filer’s latest holdings, aggregated by CUSIP, with the EDGAR accession and acceptance time on every filing."
        cta={cta}
        note={`${trialTerms('pro')} Founding price: subscribe before Dec 31 and keep $39/mo ($390/yr) for as long as you stay.`}
      />

      <Facts items={[[filers, '13F filers in /v1, the latest filing of each'], ['8 quarters', HISTORY_EXACT], ['To the second', 'EDGAR acceptance time on every filing']]} />

      <div className="mt-12 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Panel title="One request" sub="Send your key as a Bearer token, and a User-Agent that names your app">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-night p-4 font-mono text-[12.5px] leading-relaxed text-white/90 sm:whitespace-pre sm:break-normal">
            <code>{curl}</code>
          </pre>
          <p className="mt-2 text-[12.5px] text-ink-3">
            <code className="font-mono">$COPYBOOK_API</code> is the base URL on the{' '}
            <Link to="/api/" className="font-medium text-accent hover:text-accent-2">
              API docs
            </Link>
            . {HOST_MOVE}
          </p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[14px]">
            <Link to="/api/" className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent-2">
              API docs <Arrow className="size-3" />
            </Link>
            <a href={`${BASE}api/openapi.json`} className="font-medium text-accent hover:text-accent-2">
              OpenAPI spec
            </a>
            <a href={`${BASE}api/sample-holdings.json`} className="font-medium text-accent hover:text-accent-2">
              Full sample response
            </a>
          </div>
        </Panel>
        <Panel title="The response" sub="Berkshire Hathaway’s Q2 2026 13F, abridged">
          <pre className="max-h-[360px] overflow-auto rounded-xl bg-paper p-4 font-mono text-[12px] leading-relaxed text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <code>{sample.data ? sample.data.split('\n').slice(0, 44).join('\n') + '\n  …' : 'Loading…'}</code>
          </pre>
        </Panel>
      </div>

      <H2 sub="Every number traces back to a filing, with the time it became public.">Source filings, timed</H2>
      <Features
        items={[
          ['Source filing on most rows', 'Most rows carry the accession of the filing that disclosed them and that filing’s acceptance time (source_accession, first_disclosed_at), and each response names the filing, its SEC URL and its amendments. Shares a later amendment adds to a position already in the original are still dated to the original (fix in progress).'],
          ['Acceptance time to the second', 'The EDGAR acceptance timestamp, so you can date a position by when it became public, not by its quarter end.'],
          ['Amendments, listed', 'Each book lists every version EDGAR holds for its quarter (filing.versions), with acceptance times. An as_of parameter for point-in-time books is announced, not live: it returns 501 until the data is published.'],
          ['Aggregated by CUSIP', 'Lines are rolled up by CUSIP and put/call, the way funds report one position across several lines. Options are kept separate.'],
          ['One click to the source', 'Every filing carries its SEC URL, so any number can be checked against the document EDGAR published.'],
        ]}
      />

      <H2>Coverage, limits and terms</H2>
      <div className="mt-6 grid gap-4 md:grid-cols-3 [&>*]:h-full">
        <Panel title="Coverage">
          <ul className="space-y-2 text-[14px] leading-relaxed text-ink-2">
            <li>Live: at least the latest 13F for {filers} filers (the /v1/filers count), 8 quarters (2024Q3–2026Q2) for 341 of the 355 managers we track closely and 3–7 for the other 14, holders by stock, quarter-range history, Form 4 and 13D/G events, and bulk CSV files.</li>
            <li>Coming: hedge-fund and long-only new, exited and net trades in My book by Nov 20; the as_of parameter with per-row amendment lots by Nov 30; history back to 2013Q2 by Dec 31; Parquet bulk files, no date yet. Each appears in the changelog when it returns data.{' '}
              <Link to="/methodology/#coverage" className="font-medium text-accent hover:text-accent-2">
                Coverage
              </Link>
            </li>
          </ul>
        </Panel>
        <Panel title="Limits">
          <ul className="space-y-2 text-[14px] leading-relaxed text-ink-2">
            <li>Up to 10 keys, with usage on your account page.</li>
            <li>60 requests a minute and 20,000 a day per account, across all its keys. Each Fund seat has its own limit. Bulk file downloads aren’t metered.</li>
            <li>Signed webhooks for every alert, retried 5 times over about 15 hours.</li>
            <li>{API_TIMING}</li>
            <li>{API_UNIVERSE}</li>
          </ul>
        </Panel>
        <Panel title="Terms">
          <ul className="space-y-2 text-[14px] leading-relaxed text-ink-2">
            <li>For internal use; no redistribution of bulk data.</li>
            <li>Data downloaded while subscribed may be kept for internal use after you cancel.</li>
            <li>
              90 days’ notice for breaking changes. Best-effort freshness, no uptime SLA.{' '}
              <Link to="/terms/" className="font-medium text-accent hover:text-accent-2">
                Terms
              </Link>
            </li>
          </ul>
        </Panel>
      </div>

      <Band title="Pull your first 13F in a minute." sub="Start the trial, create a key on your account page, and run the curl above." cta={cta} />
    </div>
  )
}
