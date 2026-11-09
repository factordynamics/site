import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Arrow, Button, Check, Panel } from '../components/ui'
import { api, plans, TRIAL_DAYS, trialTerms } from '../config'
import { attributed, referredCheckout } from '../lib/attribution'
import { gapLabel, loadLatency } from '../lib/account'
import { BASE, useAsync, useTitle } from '../lib/data'
import { loadCoverage } from '../lib/stocks'

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
        <div key={v} className="bg-card p-5 md:p-6">
          <dt className="sr-only">{l}</dt>
          <dd className="num text-[26px] font-semibold tracking-[-0.03em]">{v}</dd>
          <dd className="mt-1 text-[13.5px] text-ink-2">{l}</dd>
        </div>
      ))}
    </dl>
  )
}

function Shot({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="mt-12">
      <div className="overflow-hidden rounded-[18px] bg-paper p-2 shadow-[var(--shadow-frame)] md:p-3">
        <img src={`${BASE}img/${src}`} alt={alt} width={1600} loading="lazy" className="block h-auto w-full rounded-[12px]" />
      </div>
      <figcaption className="mt-3 text-[12.5px] text-ink-3">{caption}</figcaption>
    </figure>
  )
}

function Features({ items }: { items: [string, string][] }) {
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
  const median = lat.data?.count ? lat.data.median_seconds : null
  const cta = (
    <Button to="/contact/?topic=fund" size="md">
      Request Fund access <Arrow />
    </Button>
  )
  return (
    <div className="container-x pt-12 md:pt-16">
      <Hero
        kicker="Copy Fund · for investment teams"
        title="Know who owns what you own."
        sub="Your book next to every 13F filer: who holds your names, how crowded they are, and how the funds you benchmark against are positioned. Five seats, shared lists, alerts in Slack, and an annual invoice."
        cta={cta}
        note="Founding price $1,990/yr for teams that subscribe before Dec 31, kept for as long as you stay. Invoiced net 30; W-9 on request."
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
          ['5 seats, shared lists', 'Each colleague signs in with their own email and keeps their own alert settings. Follows, the watchlist, the owned book and peers are shared.'],
          ['Alerts in Slack', 'Every filing from the funds you follow, posted to your team channel as the filing hits EDGAR, with new, added, trimmed and exited positions inside.'],
          ['Insider and 13D alerts', 'Open-market insider buys over your threshold, cluster buys, and any filer’s new 13D on the stocks you own or watch.'],
          ['Invoice and W-9', 'Annual plan invoiced net 30, with a W-9 on request. Or start on a card with a 14-day trial.'],
        ]}
      />

      <Shot
        src="peers-example.webp"
        alt="Peer overlap: for each of five peer funds, how many of your names it holds, their share of its book, its largest of your names, and what it bought, trimmed or exited this quarter"
        caption="Peer overlap with five well-known managers as peers, against the same book. Also on the page: a book-overlap matrix and the stocks your peers share."
      />

      <H2 sub="Your holdings are yours. We hold the least we need and say exactly where it lives.">Security your compliance team can read</H2>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Panel className="h-full">
          <ul className="space-y-2.5 text-[14.5px] leading-relaxed text-ink-2">
            <li>An uploaded or linked book is private to your team. It is never shown to anyone else and never used in aggregates.</li>
            <li>Data lives in Cloudflare KV and R2, payments in Stripe. All of it is encrypted at rest, and every connection uses TLS.</li>
            <li>Only the operator can access member data, and only for support or legal reasons.</li>
          </ul>
        </Panel>
        <Panel>
          <ul className="space-y-2.5 text-[14.5px] leading-relaxed text-ink-2">
            <li>Breaches affecting member data are notified within 72 hours.</li>
            <li>Remove names, keys and seats yourself at any time, or ask us to delete everything.</li>
            <li>
              A vendor security questionnaire answer is available on request.{' '}
              <Link to="/security/" className="font-medium text-accent hover:text-accent-2">
                Read the security page
              </Link>
            </li>
          </ul>
        </Panel>
      </div>

      <Band title="Put your book next to every 13F." sub="Tell us your team size and how you’d like to pay. We reply within one business day." cta={cta} />
    </div>
  )
}

export function ForQuants() {
  useTitle('Copybook API for quants · Copy Pro')
  const cov = useAsync(loadCoverage, [])
  const filers = cov.data?.filers ? cov.data.filers.toLocaleString('en-US') : '8,900+'
  const curated = cov.data?.curated ?? 199
  const sample = useAsync(() => fetch(`${BASE}api/sample-holdings.json`).then((r) => r.text()), [])
  const trial = attributed(plans.pro.links.yearly || plans.pro.links.monthly)
  const cta = (
    <Button href={trial} onClick={referredCheckout('pro', plans.pro.links.yearly ? 'yearly' : 'monthly', trial, api)} size="md">
      Start {TRIAL_DAYS}-day Pro trial <Arrow />
    </Button>
  )
  const curl = `curl ${api}/v1/filers/warren-buffett/holdings/latest \\
  -H "Authorization: Bearer cbk_live_..." \\
  -H "User-Agent: my-research/1.0"`
  return (
    <div className="container-x pt-12 md:pt-16">
      <Hero
        kicker="Copy Pro · the Copybook API"
        title="13F, Form 4 and 13D/G, as clean JSON."
        sub="Every 13F filer’s latest holdings, aggregated by CUSIP, with the EDGAR accession and acceptance time on every filing, so you know exactly what was public and when."
        cta={cta}
        note={`${trialTerms('pro')} Founding price: subscribe before Dec 31 and keep $39/mo ($390/yr) for as long as you stay.`}
      />

      <Facts items={[[filers, '13F filers in /v1, the latest filing of each'], ['8 quarters', `of history for the ${curated} managers we track closely; back to 2013 this month`], ['To the second', 'EDGAR acceptance time on every filing']]} />

      <div className="mt-12 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Panel title="One request" sub="Send your key as a Bearer token, and a User-Agent that names your app">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-night p-4 font-mono text-[12.5px] leading-relaxed text-white/90 sm:whitespace-pre sm:break-normal">
            <code>{curl}</code>
          </pre>
          <p className="mt-3 text-[13px] text-ink-3">Python urllib’s default User-Agent is blocked; curl, requests and httpx work as they are.</p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[14px]">
            <Link to="/api/" className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent-2">
              API docs <Arrow className="size-3" />
            </Link>
            <a href={`${api}/v1/openapi.json`} className="font-medium text-accent hover:text-accent-2">
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

      <H2 sub="Built so a backtest sees what the market saw, and every number traces back to a filing.">Point in time, with lineage</H2>
      <Features
        items={[
          ['Lineage on every position', 'Each position carries the accession of the filing that disclosed it and when that filing was accepted (source_accession, first_disclosed_at); each response also names the filing, its SEC URL and the amendments applied.'],
          ['Acceptance time to the second', 'The EDGAR acceptance timestamp, so you can date a position by when it became public, not by its quarter end.'],
          ['Amendments, dated', 'Positions added by a later amendment count from that amendment’s acceptance time. An as_of parameter for full point-in-time history ships this month.'],
          ['Aggregated by CUSIP', 'Lines are rolled up by CUSIP and put/call, the way funds report one position across several lines. Options are kept separate.'],
          ['Unit fixes, flagged', 'Filings that report values in thousands are corrected to dollars and flagged, as the methodology page describes.'],
          ['One click to the source', 'Every filing carries its SEC URL, so any number can be checked against the document EDGAR published.'],
        ]}
      />

      <H2>Coverage, limits and terms</H2>
      <div className="mt-6 grid gap-4 md:grid-cols-3 [&>*]:h-full">
        <Panel title="Coverage">
          <ul className="space-y-2 text-[14px] leading-relaxed text-ink-2">
            <li>Latest 13F for {filers} filers, live.</li>
            <li>8 quarters for the {curated} managers we track closely; back to 2013 this month.</li>
            <li>Stock holders endpoint and bulk exports this week; history and Form 4 / 13D/G events endpoints this month.</li>
          </ul>
        </Panel>
        <Panel title="Limits">
          <ul className="space-y-2 text-[14px] leading-relaxed text-ink-2">
            <li>Up to 10 keys, with usage on your account page.</li>
            <li>60 requests a minute and 20,000 a day per key.</li>
            <li>Signed webhooks for every alert, retried for 12 hours.</li>
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
