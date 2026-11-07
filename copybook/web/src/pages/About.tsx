import { Button } from '../components/ui'

export function About() {
  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-3xl">
        <p className="text-[13px] font-medium text-accent">About</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">
          Portfolios, as filed. <span className="font-serif font-normal italic text-accent">Nothing invented.</span>
        </h1>
        <p className="mt-5 text-[18px] leading-relaxed text-ink-2">
          Every quarter, investment managers with more than $100 million in US equities tell the SEC what they own. Those filings are public, precise and nearly unreadable. Copybook makes them easy to read for anyone who wants to learn from the best investors.
        </p>
      </header>

      <div className="mt-14 grid gap-5 md:grid-cols-3">
        {[
          ['Who it’s for', 'Individual investors, students of the craft and anyone who reads a shareholder letter and wants to see the actual book behind it.'],
          ['Why as filed', 'A 13F is a legal disclosure. We show the values the fund reported, linked to the original document, so you can always check our work.'],
          ['What we won’t do', 'We don’t re-price positions, estimate returns or guess at tickers. If a security has no clear public ticker, we show a dash.'],
        ].map(([t, d]) => (
          <section key={t} className="rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
            <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{t}</h2>
            <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">{d}</p>
          </section>
        ))}
      </div>

      <section id="method" className="mt-20 grid max-w-5xl scroll-mt-24 gap-10 md:grid-cols-[1fr_1.6fr]">
        <h2 className="text-[28px] font-semibold tracking-[-0.03em]">How to read a 13F</h2>
        <div className="space-y-5 text-[15.5px] leading-relaxed text-ink-2">
          <p>
            <strong className="font-medium text-ink">It’s a snapshot.</strong> Each filing shows positions on the last day of the quarter. Funds have 45 days to file, so the newest data is always a few weeks old.
          </p>
          <p>
            <strong className="font-medium text-ink">It’s long US equities.</strong> 13F covers US-listed stocks, some options and convertible notes. Short positions, most foreign shares, private holdings and cash are not included.
          </p>
          <p>
            <strong className="font-medium text-ink">Share classes are separate.</strong> Alphabet Class A and Class C are two lines in a filing, so they’re two lines here too.
          </p>
          <p>
            <strong className="font-medium text-ink">Consensus is a lens, not a fund.</strong> The consensus book adds up the latest filings of the superinvestors we follow. It shows where they agree; it isn’t a recommendation.
          </p>
        </div>
      </section>

      <section className="mt-20 max-w-3xl rounded-[18px] bg-paper-2 p-8">
        <h2 className="text-[20px] font-semibold tracking-[-0.02em]">Made by Factor Dynamics</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          Copybook is built by Factor Dynamics, a small team that makes research tools for investors. Copybook is not investment advice, and Factor Dynamics is not a registered investment adviser.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button to="/investors/">Browse investors</Button>
          <Button href="https://www.factordynamics.com" variant="outline">
            factordynamics.com
          </Button>
        </div>
      </section>
    </div>
  )
}
