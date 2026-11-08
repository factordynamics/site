import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Panel } from '../components/ui'
import { DATA, dateLabel, quarterLabel, useAsync, useTitle } from '../lib/data'

// data/changelog.json from ingest: append-only, newest first; id is a stable anchor.
type Entry = { id: string; date: string; title: string; body: string; kind: 'methodology' | 'restatement' | 'data_fix' | string; funds?: string[]; quarters?: string[]; accessions?: string[] }
const KIND: Record<string, string> = { methodology: 'Method', restatement: 'Restatement', data_fix: 'Data fix' }

const SECTIONS: { id: string; title: string; body: ReactNode }[] = [
  {
    id: 'sources',
    title: 'Sources',
    body: (
      <>
        <p>Everything on Copybook comes from SEC EDGAR: Form 13F-HR and 13F-HR/A for holdings, Form 13F-NT for funds whose holdings another manager reports, Form 4 for insider trades, and Schedule 13D and 13G for stakes of 5% or more. Each page links to the filing it was read from.</p>
        <p>Holdings values are always the ones the fund filed. Copybook uses no market prices, never re-prices a position and never estimates returns.</p>
      </>
    ),
  },
  {
    id: 'refresh',
    title: 'Refresh',
    body: (
      <ul>
        <li>New 13F filings: the alert service checks EDGAR’s latest-filings feed every minute.</li>
        <li>Holdings data: rebuilt every 3 hours. GitHub’s scheduler can delay or occasionally skip a run.</li>
        <li>Form 4 and Schedule 13D/G: alerts for the funds we track closely and the filers you follow usually go out within minutes of filing; pages pick them up with each refresh.</li>
      </ul>
    ),
  },
  {
    id: 'amendments',
    title: 'Amendments',
    body: (
      <>
        <p>Each quarter starts from the fund’s original 13F-HR. A 13F-HR/A marked RESTATEMENT replaces it. An amendment marked NEW HOLDINGS, usually positions the fund first kept confidential, is added on top and never replaces the original.</p>
        <p>Restatements of the funds we follow closely are recorded in the changelog below.</p>
      </>
    ),
  },
  {
    id: 'units',
    title: 'Units',
    body: (
      <>
        <p>Since January 3, 2023, 13F values must be reported in dollars; before that, in thousands. Some filers still get it wrong, so each filing is checked by its median implied price per share (value ÷ shares, stock rows only, with at least 5 rows):</p>
        <ul>
          <li>Under $0.50: the filing was reported in thousands, and its values are multiplied by 1,000.</li>
          <li>Over $2,500: the values are 1,000 times too high, and are divided by 1,000.</li>
        </ul>
        <p>Single lines are checked too:</p>
        <ul>
          <li>A stock line priced above $20,000 a share, other than Berkshire Hathaway Class A, is divided by 1,000.</li>
          <li>A line priced 300 to 3,000 times away from the median price other 13F filers report for the same CUSIP and quarter is rescaled by 1,000. This needs at least 3 other filers.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'options',
    title: 'Options and notes',
    body: (
      <>
        <p>Calls and puts are shown at their filed value, which is the notional value of the underlying shares, not the price of the options. They’re listed apart from shares and never added to share totals, portfolio weights or holder counts.</p>
        <p>Notes and other debt, identified by their title, are left out of stock holder counts.</p>
      </>
    ),
  },
  {
    id: 'tickers',
    title: 'Tickers, names and sectors',
    body: (
      <>
        <p>13F filings identify securities by CUSIP. Copybook maps each CUSIP to a ticker from, in order:</p>
        <ol>
          <li>A hand-checked override file.</li>
          <li>OpenFIGI’s CUSIP mapping (identifiers only, no prices).</li>
          <li>The SEC’s company_tickers.json.</li>
        </ol>
        <p>A CUSIP with no single US listing shows no ticker rather than a guess. Share classes of one company (Alphabet Class A and C) appear together on its stock page. Sectors come from the issuer’s SEC SIC code, mapped to GICS-style sectors; anything unmatched is “Unclassified”.</p>
      </>
    ),
  },
  {
    id: 'moves',
    title: 'Moves and changes',
    body: (
      <>
        <p>A quarter-over-quarter move is the change in shares between a fund’s two filings, valued at the newer filing’s own value per share. A price move alone is never counted as buying or selling.</p>
        <p>“Since the last 13F” rolls up Form 4 and Schedule 13D/G filings made after a fund’s latest 13F. The newest holding shown is the one in the most recent Form 4, which reports exact shares after each trade; a Schedule 13D/G counts the whole filing group, so it stands in only when there’s no Form 4. Dollar amounts there come from Form 4 open-market purchases and sales (codes P and S) at the prices reported.</p>
      </>
    ),
  },
  {
    id: 'csv',
    title: 'CSV exports',
    body: (
      <p>
        Each CSV row is one line of the 13F as filed, with the ticker, sector and the change since the fund’s previous filing (shares and dollars, valued as above). Positions the fund exited are listed last. Values follow the unit rules on this page.
      </p>
    ),
  },
  {
    id: 'limits',
    title: 'What a 13F leaves out',
    body: (
      <p>
        A 13F covers US-listed equities, ETFs, certain convertibles and listed options held at quarter end. It omits short positions, most non-US holdings, cash, bonds and private investments, and it’s filed up to 45 days after the quarter ends. A portfolio on Copybook is never the whole picture. Nothing here is investment advice.
      </p>
    ),
  },
]

export function Methodology() {
  useTitle('Methodology · Copybook')
  const log = useAsync(() => fetch(`${DATA}changelog.json`).then((r) => (r.ok ? (r.json() as Promise<{ updated_at?: string; entries: Entry[] }>) : null)), [])
  const entries = log.data?.entries ?? []
  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Methodology</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">How Copybook reads the filings.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">The rules we apply between EDGAR and this site, and a log of every change to them and to the data.</p>
      </header>

      <div className="mt-12 grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-24 space-y-1.5 text-[14px]">
            {[...SECTIONS, { id: 'changelog', title: 'Changelog' }].map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-ink-2 hover:text-ink">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="max-w-3xl space-y-12">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="scroll-mt-24">
              <h2 className="text-[22px] font-semibold tracking-[-0.02em]">{s.title}</h2>
              <div className="prose-cb mt-3 space-y-3 text-[15.5px] leading-relaxed text-ink-2 [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">{s.body}</div>
            </section>
          ))}

          <section id="changelog" className="scroll-mt-24">
            <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Changelog</h2>
            <p className="mt-2 text-[14px] text-ink-3">
              Every change to these rules, every restatement filed by a fund we follow closely, and every correction to the data. Entries are only ever added.
              {log.data?.updated_at && ` Updated ${dateLabel(log.data.updated_at)}.`}
            </p>
            <Panel className="mt-4">
              {log.loading ? (
                <p className="text-[14px] text-ink-3">Loading…</p>
              ) : entries.length ? (
                <ol className="divide-y divide-line">
                  {entries.map((e) => (
                    <li key={e.id} id={e.id} className="scroll-mt-24 py-4 first:pt-0 last:pb-0">
                      <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
                        <span className="num">{dateLabel(e.date)}</span>
                        <span className="rounded-full bg-ink/[0.05] px-2 py-0.5 font-medium text-ink-2">{KIND[e.kind] ?? e.kind}</span>
                        {e.quarters?.map((q) => (
                          <span key={q}>{quarterLabel(q)}</span>
                        ))}
                        <a href={`#${e.id}`} className="ml-auto text-ink-3 hover:text-ink" aria-label={`Link to ${e.title}`}>
                          #
                        </a>
                      </p>
                      <h3 className="mt-1.5 text-[15.5px] font-semibold">{e.title}</h3>
                      <p className="mt-1 text-[14.5px] leading-relaxed text-ink-2">{e.body}</p>
                      {(e.funds?.length || e.accessions?.length) && (
                        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
                          {e.funds?.map((f) => (
                            <Link key={f} to={`/investors/${f}/`} className="text-accent hover:text-accent-2">
                              {f.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                            </Link>
                          ))}
                          {e.accessions?.map((a) => (
                            <span key={a} className="font-mono text-[12px] text-ink-3">
                              {a}
                            </span>
                          ))}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-[14px] text-ink-2">The first entries are being written now. They’ll appear here as soon as they’re published.</p>
              )}
            </Panel>
          </section>
        </div>
      </div>
    </div>
  )
}
