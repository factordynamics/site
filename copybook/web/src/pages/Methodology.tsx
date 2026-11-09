import { useEffect, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Panel } from '../components/ui'
import { api } from '../config'
import { DATA, dateLabel, quarterLabel, useAsync, useTitle } from '../lib/data'
import { loadSplitLog, stockPath } from '../lib/stocks'

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
        <p>Holdings values are as filed, except the unit fixes below. Copybook uses no market prices, never re-prices a position and never estimates returns.</p>
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
        <p>Each quarter starts from the fund’s original 13F-HR. A 13F-HR/A marked RESTATEMENT replaces the whole book. A 13F-HR/A marked NEW HOLDINGS, usually positions the fund first kept confidential, adds rows to the book.</p>
        <p>
          <strong className="font-medium text-ink">Re-filed books.</strong> Some filers re-file their whole 13F as NEW HOLDINGS. An amendment that repeats more than half of the book’s CUSIPs, or whose total is within 0.8–1.25× of the book’s, replaces the book instead of adding to it, and the filing trail marks it <code>mislabeled_amendment</code>. That flag is announced for the API’s <code>filing.versions</code>, not live there yet.
        </p>
        <p>
          <strong className="font-medium text-ink">Point in time, partly.</strong> Most rows carry the filing that first disclosed them (<code>source_accession</code>) and that filing’s EDGAR acceptance time (<code>first_disclosed_at</code>). Positions an amendment adds are dated to that amendment. Shares a later amendment adds to a position already in the original are still dated to the original; a fix is in progress, and the changelog below will say when it lands.
        </p>
        <p>
          <strong className="font-medium text-ink">What you get by default.</strong> Pages, CSVs and the API without <code>as_of</code> return the book as it is known today: the latest RESTATEMENT if there is one, otherwise the original, plus every NEW HOLDINGS row accepted since. The API’s <code>as_of</code> parameter, which will return the book exactly as it was public at a given instant, is announced, not live: today it returns 501 <code>not_yet_available</code>.
        </p>
        <p>Earlier versions of a restated quarter are kept. Restatements by the managers we track closely are recorded in the changelog below.</p>
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
        <p>The whole-filing rule depends only on the filing itself, so it never changes. A single-line fix depends on what other filers reported, so it can be revised as more 13Fs for that quarter arrive. Every revision is logged in the changelog below. Per-row fields for these fixes in the API (<code>value_scale</code>, <code>value_as_filed</code>) are announced and still empty.</p>
      </>
    ),
  },
  {
    id: 'options',
    title: 'Options and notes',
    body: (
      <>
        <p>Calls and puts are shown at their filed value, which is the notional value of the underlying shares, not the price of the options. They’re listed apart from shares and never added to share totals or holder counts.</p>
        <p>Notes and other debt, identified by their title, are left out of stock holder counts. Rows reported as a principal amount (<code>PRN</code>, such as convertible notes) keep their filed value but are never counted as shares; the API marks them with <code>shares_type</code> (<code>SH</code> or <code>PRN</code>).</p>
        <p>Lines filed with a value of zero are kept as filed. About 56 such lines are still missing from the published books; a fix is in progress.</p>
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
        <p>A quarter-over-quarter move is the change in shares between a fund’s two filings, valued at the newer filing’s own value per share. A price move alone is never counted as buying or selling, except in the split cases still being fixed (IESC’s split, and Amundi’s mixed pre- and post-split CRWD lines), which can show a split as a buy.</p>
        <p>
          <strong className="font-medium text-ink">CUSIP changes.</strong> When an issuer’s CUSIP is reissued, as Exxon’s 30231G102 became 30233Q108 between Q2 and Q3 2026, a fund’s new row is compared with its previous row under the old CUSIP, so a position it kept reads as added, trimmed or unchanged rather than new. Those rows are labelled “CUSIP change” with both CUSIPs, and the API carries the old one as <code>prev_cusip</code>. Reissues are linked by the data pipeline, which lists every pair it links.
        </p>
        <p>
          <strong className="font-medium text-ink">Splits.</strong> When a stock split between a fund’s two filings, the previous quarter’s shares are multiplied by the split ratio before the comparison, and the row is labelled, for example, “split 2:1 adjusted”. The splits section below lists each one.
        </p>
        <p>“Since the last 13F” rolls up Form 4 and Schedule 13D/G filings made after a fund’s latest 13F. The newest holding shown is the one in the most recent Form 4, which reports exact shares after each trade; a Schedule 13D/G counts the whole filing group, so it stands in only when there’s no Form 4. Dollar amounts there come from Form 4 open-market purchases and sales (codes P and S) at the prices reported.</p>
      </>
    ),
  },
  {
    id: 'csv',
    title: 'CSV exports',
    body: (
      <p>
        Each CSV row is one position: every line of the 13F with the same CUSIP and the same put/call is added together, because funds often split one holding across several lines (Berkshire’s Q2 2026 13F has 89 lines and 29 positions). Each row has the ticker, sector and the change since the fund’s previous filing, in shares and dollars, valued as above. Positions the fund exited are listed last. Values follow the unit rules on this page.
        <br />
        <br />
        The API’s bulk files (<code>GET /v1/bulk</code>) are different for now: they’re built from each filer’s original 13F, without restatements or amendments, and without the point-in-time columns. They’ll match the pages once they share one builder, and the changelog will say so.
      </p>
    ),
  },
  {
    id: 'definitions',
    title: 'Definitions',
    body: (
      <dl className="space-y-3 [&_dt]:font-medium [&_dt]:text-ink">
        <div>
          <dt>Quarter</dt>
          <dd>The report period the 13F covers, not the date it was filed. Q3 2026 is the book as of September 30, 2026, filed up to 45 days later.</dd>
        </div>
        <div>
          <dt>Total value (<code>total_value_usd</code>)</dt>
          <dd>The sum of every line in the filing after unit fixes: shares, options at their notional value and notes at their filed value.</dd>
        </div>
        <div>
          <dt>Weight</dt>
          <dd>A position’s value divided by the total value of the filer’s share (SH) positions, on every page, file and alert. Put and call options (at notional) and principal-amount notes (PRN) are left out of the denominator and shown apart. The API’s <code>weight</code> is being aligned to the same definition; <code>weight_equity</code> already is.</dd>
        </div>
        <div>
          <dt>New, added, trimmed, unchanged, exited</dt>
          <dd>
            Compared with the fund’s previous 13F, by shares of the same CUSIP: <em>new</em> had none before; <em>added</em> and <em>trimmed</em> hold more or fewer shares; <em>unchanged</em> holds the same shares, whatever the price did; <em>exited</em> held shares before and none now. With no earlier
            13F on file, the change is empty.
          </dd>
        </div>
        <div>
          <dt>Dollar change</dt>
          <dd>The change in shares times the newer filing’s own value per share. A new position counts its full value; an exited one counts minus its value in the previous filing, since it has no current value. A price move alone is zero, except in the split cases noted under Moves and changes.</dd>
        </div>
        <div>
          <dt>Ticker</dt>
          <dd>Empty when the CUSIP has no single US listing (many foreign shares, units and warrants) or no mapping yet. The CUSIP and issuer are always shown.</dd>
        </div>
      </dl>
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

// Where an entry (written by the data run) runs ahead of what's served today, the current status.
const STATUS: Record<string, string> = {
  '2026-11-08-amendments-point-in-time': 'Status: most rows carry source_accession and first_disclosed_at, not every row. Shares a later amendment adds to a position already in the original are still dated to the original (fix in progress).',
  '2026-11-09-refiled-amendments': 'Status: the public pages and the API’s /v1 books are corrected (checked: First Eagle 2026Q2 $60.75B, JPMorgan Chase 2025Q3 $1,669B). Member 13F history and CSV downloads are being confirmed. Bulk files are built from original filings, so they show each original book rather than the replacement. mislabeled_amendment is announced for the API’s filing.versions, not live yet.',
}

export function Methodology() {
  useTitle('Methodology · Copybook')
  const log = useAsync(() => fetch(`${DATA}changelog.json`).then((r) => (r.ok ? (r.json() as Promise<{ updated_at?: string; entries: Entry[] }>) : null)), [])
  const entries = log.data?.entries ?? []
  const splits = useAsync(loadSplitLog, [])
  // Sections that load late (splits, changelog) still honour a #hash in the URL.
  const { hash } = useLocation()
  useEffect(() => {
    if (hash && !splits.loading && !log.loading) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash, splits.loading, log.loading])
  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Methodology</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">How Copybook reads the filings.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">The rules we apply between EDGAR and this site, and a log of every change to them and to the data.</p>
      </header>

      <div className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-24 space-y-1.5 text-[14px]">
            {[...SECTIONS, { id: 'splits', title: 'Stock splits' }, { id: 'latency', title: 'Alert latency' }, { id: 'changelog', title: 'Changelog' }].map((s) => (
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

          <section id="splits" className="scroll-mt-24">
            <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Stock splits</h2>
            <div className="mt-3 space-y-3 text-[15.5px] leading-relaxed text-ink-2">
              <p>A split changes every holder’s share count without anyone trading. The data pipeline’s split list is the source of truth; every candidate below gets one of two treatments:</p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>
                  <span className="font-medium text-ink">Adjusted.</span> Confirmed by the data pipeline: at least 5 holders at the exact ratio, the median holder at that ratio, the price moving by about its inverse, and SEC XBRL shares outstanding not contradicting it. The pipeline matches by CUSIP, so a split that came with a new CUSIP (DD’s 1-for-3) is adjusted by our holder check instead, on strong evidence only: at least 10 holders, a median share ratio within 5% of the factor and a median price ratio within 10% of its inverse. Earlier quarters’ shares are multiplied by the ratio, so buying and selling are counted as usual.
                </li>
                <li>
                  <span className="font-medium text-ink">Not treated.</span> A weaker pattern in our holder check (the median share ratio within 25% of a clean factor among at least 5 holders) that the pipeline doesn’t list as a split. The share changes count as trades; the row stays here as evidence. ETFs are exempt.
                </li>
              </ul>
            </div>
            <Panel className="mt-4">
              {!splits.data ? (
                <p className="text-[14px] text-ink-3">Loading…</p>
              ) : (
                <div className="-mx-5 overflow-x-auto md:-mx-6" tabIndex={0} role="region" aria-label="Flagged splits">
                  <table className="w-full min-w-[640px] text-[13.5px]">
                    <thead>
                      <tr className="border-b border-line text-left text-[12px] text-ink-3">
                        <th className="px-5 py-2 font-medium md:px-6">Stock</th>
                        <th className="px-3 py-2 font-medium">Quarter</th>
                        <th className="px-3 py-2 font-medium">Treatment</th>
                        <th className="px-3 py-2 text-right font-medium">Holders</th>
                        <th className="px-3 py-2 text-right font-medium">Share ratio</th>
                        <th className="px-3 py-2 text-right font-medium">Price ratio</th>
                        <th className="px-5 py-2 text-right font-medium md:px-6">XBRL shares</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {splits.data.map((x) => (
                        <tr key={x.ticker + x.quarter}>
                          <td className="px-5 py-2 md:px-6">
                            <Link to={stockPath(x.ticker)} className="font-mono text-[13px] font-semibold hover:text-accent">
                              {x.ticker}
                            </Link>{' '}
                            <span className="text-ink-3">{x.ratio}</span>
                          </td>
                          <td className="px-3 py-2 text-ink-2">{quarterLabel(x.quarter)}</td>
                          <td className={`px-3 py-2 ${x.treatment === 'excluded' ? 'text-[#8a5a0b]' : 'text-ink-2'}`}>{x.treatment === 'adjusted' ? 'Adjusted' : x.treatment === 'excluded' ? 'Not counted' : 'Not treated'}
                            <span className="block text-[12px] text-ink-3">{x.source.startsWith('Ingest') ? 'Pipeline' : 'Holder check'}</span>
                          </td>
                          <td className="num px-3 py-2 text-right">{x.holders}</td>
                          <td className="num px-3 py-2 text-right">{x.share_ratio.toFixed(2)}</td>
                          <td className="num px-3 py-2 text-right">{x.price_ratio.toFixed(2)}</td>
                          <td className="num px-5 py-2 text-right text-ink-3 md:px-6">{x.xbrl_shares_ratio != null ? x.xbrl_shares_ratio.toFixed(2) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
            <p className="mt-2 text-[13px] text-ink-3">Ratios are medians across holders that reported the stock in both quarters: shares now ÷ shares before, and price per share now ÷ before. XBRL shares is the company’s own shares-outstanding change, where reported.</p>
          </section>

          <section id="latency" className="scroll-mt-24">
            <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Alert latency</h2>
            <p className="mt-2 text-[15.5px] leading-relaxed text-ink-2">
              Live alerts will be timed from EDGAR acceptance to delivery once the first ones fire; none so far. The timings, and the latest alerts, will be on the{' '}
              <Link to="/speed/" className="font-medium text-accent hover:text-accent-2">
                speed page
              </Link>
              . The raw feed is at{' '}
              <a href={`${api}/latency`} className="font-mono text-[14px] text-accent hover:text-accent-2">
                /latency
              </a>
              .
            </p>
          </section>

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
                      {STATUS[e.id] && <p className="mt-2 rounded-lg bg-[#fff6e5] px-3 py-2 text-[13px] leading-relaxed text-[#7a4b00]">{STATUS[e.id]}</p>}
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
