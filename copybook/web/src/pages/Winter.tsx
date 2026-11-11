import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Panel, Skeleton, Ticker } from '../components/ui'
import { BASE, dateLabel, displayName, getJSON, money, useAsync, useTitle } from '../lib/data'
import { stockPath } from '../lib/stocks'

// The filings behind /pricing/'s winter sentence, from payments' list (public/d/winter-2025-26.json, EDGAR full index
// and filings), each linked to its EDGAR index page.
type Filing13 = { manager: string; form: string; filed: string; accession: string; subject_company?: string; subject_cik?: string }
type Buy = { ticker: string; form: string; filed: string; transaction_date: string; accession: string; owner: string; roles: string[]; officer_title: string | null; value_usd: number }
type Winter = {
  window: [string, string]
  insider_buys: { definition: string; count: number; filings: Buy[] }
  schedule_13dg: { definition: string; count: number; initial: number; filings: Filing13[] }
}

// EDGAR keeps a filing's index under every CIK on it: the subject company's for a 13D/G, the accession's own prefix otherwise.
const edgar = (acc: string, cik?: string) => `https://www.sec.gov/Archives/edgar/data/${Number(cik ?? acc.split('-')[0])}/${acc.replace(/-/g, '')}/${acc}-index.html`
// All-caps EDGAR names in title case, keeping initialisms (BBB, PLC, L.P.) upper.
const titled = (s: string) =>
  s === s.toUpperCase()
    ? s
        .split(' ')
        .map((t) => (/^(LTD|JR|SR)\.?,?$/.test(t) || !/^[A-Z]+[.,]?$/.test(t.replace(/\./g, '')) || /[AEIOUY]/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t))
        .join(' ')
    : s
// EDGAR files reporting owners last name first ("GORMAN JAMES P"): read them as "James P. Gorman".
function person(raw: string) {
  const w = titled(raw).split(/\s+/)
  const sfx = /^(jr|sr|ii|iii|iv)\.?$/i.test(w[w.length - 1] ?? '') && w.length > 2 ? [w.pop()!] : []
  const [last, ...rest] = w
  return [...rest.map((t) => (/^[A-Z]$/.test(t) ? `${t}.` : t)), last, ...sfx].join(' ')
}
const role = (b: Buy) => (b.officer_title ? b.officer_title : b.roles.includes('director') ? 'Director' : b.roles.includes('officer') ? 'Officer' : '')
const form13 = (f: string) => {
  const base = f.replace(/^SCHEDULE /, '').replace(/\/A$/, '')
  return /\/A$/.test(f) ? `${base} amendment` : `${base} new stake`
}

const th = 'py-2 pr-3 font-medium'
const link = 'font-medium text-accent hover:text-accent-2'

export function Winter() {
  useTitle('Last winter between 13F seasons: the filings · Copybook')
  const w = useAsync(() => getJSON<Winter>(`${BASE}d/winter-2025-26.json`), [])
  const g = w.data?.schedule_13dg
  const b = w.data?.insider_buys
  // /pricing/ links each number to its table (#filings-13dg, #insider-buys): scroll there once the rows are in.
  useEffect(() => {
    if (w.data && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }, [w.data])
  return (
    <div className="container-x max-w-3xl pt-10 md:pt-14">
      <nav className="text-[13px] text-ink-3" aria-label="Breadcrumb">
        <Link to="/pricing/" className="hover:text-ink">
          Copy
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink-2">Last winter</span>
      </nav>
      <h1 className="mt-6 text-[34px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-[40px]">Last winter, between 13F seasons</h1>
      <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
        From Dec 1, 2025 to Jan 31, 2026, with no 13Fs due, the superinvestors we follow made {g ? g.count : '…'} Schedule 13D/G filings ({g ? g.initial : '…'} new stakes), and directors and officers made {b ? b.count : '…'} open-market buys of $100K or more in the 100 stocks those investors hold most by value. Copy emails you each one as it’s filed. Every row links to SEC EDGAR.
      </p>

      <div id="filings-13dg" className="scroll-mt-24">
        <Panel className="mt-8" title={`${g?.count ?? ''} Schedule 13D and 13G filings`} sub={g?.definition}>
          {!g ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                  <th className={th}>Filed</th>
                  <th className={th}>Investor and company</th>
                  <th className="py-2 text-right font-medium">EDGAR</th>
                </tr>
              </thead>
              <tbody>
                {[...g.filings]
                  .sort((x, y) => x.filed.localeCompare(y.filed))
                  .map((f) => (
                    <tr key={f.accession} className="border-b border-line align-top last:border-0">
                      <td className="num whitespace-nowrap py-2.5 pr-3 text-ink-2">{dateLabel(f.filed)}</td>
                      <td className="py-2.5 pr-3">
                        <div className="font-medium">{displayName(f.manager)}</div>
                        <div className="text-[12.5px] text-ink-3">
                          {f.subject_company ? `${titled(f.subject_company)} · ` : ''}
                          {form13(f.form)}
                        </div>
                      </td>
                      <td className="py-2.5 text-right">
                        <a href={edgar(f.accession, f.subject_cik)} className={link}>
                          Filing
                        </a>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div id="insider-buys" className="scroll-mt-24">
        <Panel className="mt-6" title={`${b?.count ?? ''} insider buys of $100K or more`} sub={b?.definition}>
          {!b ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                  <th className={th}>Bought</th>
                  <th className={th}>Stock and insider</th>
                  <th className="py-2 pr-3 text-right font-medium">Amount</th>
                  <th className="py-2 text-right font-medium">EDGAR</th>
                </tr>
              </thead>
              <tbody>
                {[...b.filings]
                  .sort((x, y) => x.transaction_date.localeCompare(y.transaction_date))
                  .map((r) => (
                    <tr key={r.accession} className="border-b border-line align-top last:border-0">
                      <td className="num whitespace-nowrap py-2.5 pr-3 text-ink-2">{dateLabel(r.transaction_date)}</td>
                      <td className="py-2.5 pr-3">
                        <Link to={stockPath(r.ticker)} className="hover:text-accent">
                          <Ticker t={r.ticker} className="text-[13px]" />
                        </Link>
                        <div className="text-[12.5px] text-ink-3">
                          {person(r.owner)}
                          {role(r) ? `, ${role(r)}` : ''}
                        </div>
                      </td>
                      <td className="num whitespace-nowrap py-2.5 pr-3 text-right font-medium">{money(r.value_usd)}</td>
                      <td className="py-2.5 text-right">
                        <a href={edgar(r.accession)} className={link}>
                          Form 4
                        </a>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
      <p className="mt-4 text-[13px] text-ink-3">
        Source: SEC EDGAR full index and filings. The list as data:{' '}
        <a href={`${BASE}d/winter-2025-26.json`} className={link}>
          winter-2025-26.json
        </a>
        .
      </p>
    </div>
  )
}
