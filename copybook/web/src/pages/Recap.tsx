import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Share } from '../components/Share'
import { Signup } from '../components/Signup'
import { dayName } from '../lib/calendar.mjs'
import { Arrow, Badge, Button, Lock, Panel, Skeleton } from '../components/ui'
import { TRIAL_DAYS } from '../config'
import { useMember } from '../lib/account'
import { dateLabel, displayName, money, quarterLabel, useAsync, useTick, useTitle } from '../lib/data'
import { recapFilers, recapTitle } from '../lib/titles.mjs'
import { loadRecap, stockPath, type PctRow, type RecapMove, type SeasonRow } from '../lib/stocks'

// /season/2026q3/: the season recap, from d/recap/{Q}.json (scripts/stocks.mjs). Before the deadline it
// reads as "so far"; after it, as final, with late filers still flowing in on each build.
// Everyone sees the top 5 of each list; members see the full lists.

const FREE = 5
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`
const CHANGE: Record<RecapMove['change'], string> = { new: 'New', added: 'Added', trimmed: 'Trimmed', exited: 'Exited' }
const dueLabel = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })

export function Recap() {
  const { quarter = '', view } = useParams()
  const nav = useNavigate()
  const q = quarter.toUpperCase()
  const valid = /^\d{4}Q[1-4]$/.test(q)
  const tick = useTick(120_000, true)
  const r = useAsync(() => (valid ? loadRecap(q, tick ? Date.now() : undefined) : Promise.reject(new Error('bad quarter'))), [q, tick])
  const member = useMember()
  // Rank by dollars or by % of book (a small fund's conviction counts as much as a big book's dollars).
  // The % view has its own path (/season/{q}/pct/) so a shared link unfurls its own card; ?by=pct still works.
  const [params] = useSearchParams()
  const by: 'usd' | 'pct' = view === 'pct' || params.get('by') === 'pct' ? 'pct' : 'usd'
  const paid = Boolean(member?.active)
  const d = r.data
  const Q = quarterLabel(q)
  const filedNames = d ? d.filing.filter((f) => f.filed).map((f) => displayName(f.manager)) : []
  // Until about 10 have filed, the headline names them, so a few funds don't read as the whole field.
  const few = d ? recapFilers({ filed: d.superinvestors.filed, names: filedNames, final: d.final }) : null
  useTitle(d ? (by === 'pct' ? `${Q} 13F recap: the superinvestors' biggest bets by % of book · Copybook` : recapTitle({ quarter: d.quarter, filed: d.superinvestors.filed, total: d.superinvestors.total, names: filedNames, final: d.final })) : undefined)

  if (r.error && !d)
    return (
      <div className="container-x pt-12 md:pt-16">
        <h1 className="text-[32px] font-semibold tracking-[-0.03em]">No recap for {valid ? Q : 'that quarter'} yet.</h1>
        <p className="mt-3 text-ink-2">
          See the <Link to="/season/" className="font-medium text-accent hover:text-accent-2">filing season tracker</Link> for the quarter now filing.
        </p>
      </div>
    )

  const waiting = d?.filing.filter((x) => !x.filed) ?? []
  const late = d?.filing.filter((x) => x.late) ?? []

  return (
    <div className="container-x pt-12 md:pt-16">
      <header className="max-w-3xl">
        <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-accent">
          {Q} · 13F recap
          {d && (d.final ? <Badge tone="up">Final · late filers still added</Badge> : <Badge tone="accent">In progress · deadline {dueLabel(d.deadline)} ET</Badge>)}
        </p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">{few ? `${Q} so far: what ${few} bought and sold.` : `What the superinvestors bought and sold in ${Q}.`}</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
          {d
            ? `${d.superinvestors.filed} of the ${d.superinvestors.total} superinvestors we feature ${d.final ? 'filed' : 'have filed so far'}. Each move compares a fund’s ${Q} 13F with its previous one, valued at quarter-end prices as filed with the SEC.`
            : '\u00a0'}
        </p>
        {d && (
          <Share
            className="mt-5"
            url={`${location.origin}${import.meta.env.BASE_URL}season/${quarter.toLowerCase()}/${by === 'pct' ? 'pct/' : ''}`}
            text={`${Q} 13F recap. Most bought by the superinvestors: ${(by === 'pct' ? (d.most_bought_pct ?? []) : d.most_bought)
              .slice(0, 3)
              .map((x) => `$${x.ticker}`)
              .join(', ')}`}
          />
        )}
      </header>

      <section className="mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-[var(--radius-card)] bg-line shadow-[var(--shadow-card)] sm:grid-cols-2 lg:grid-cols-5" aria-label="Season totals">
        {(
          [
            ['Superinvestors filed', d ? `${d.superinvestors.filed} of ${d.superinvestors.total}` : null, d?.final ? 'deadline passed' : 'so far'],
            ['Bought', d ? `+${money(d.bought_usd)}` : null, 'new and added positions'],
            ['Sold', d ? `−${money(Math.abs(d.sold_usd))}` : null, 'trimmed and exited'],
            ['New positions', d ? d.opened_count.toLocaleString('en-US') : null, 'opened this quarter'],
            ['Full exits', d ? d.exited_count.toLocaleString('en-US') : null, 'sold out entirely'],
          ] as const
        ).map(([k, v, s]) => (
          <div key={k} className="bg-card p-5">
            <p className="text-[12.5px] text-ink-3">{k}</p>
            {v == null ? <Skeleton className="mt-2 h-7 w-20" /> : <p className="num mt-1.5 text-[26px] font-semibold leading-none tracking-[-0.03em]">{v}</p>}
            <p className="mt-2 text-[12px] text-ink-3">{s}</p>
          </div>
        ))}
      </section>

      {!d ? (
        <Skeleton className="mt-6 h-96 w-full" />
      ) : (
        <>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold">Most bought and sold</h2>
            <div className="seg rounded-full bg-ink/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="Rank by">
              {(
                [
                  ['usd', 'Dollars'],
                  ['pct', '% of book'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} type="button" role="tab" aria-selected={by === k} onClick={() => nav(`/season/${quarter}/${k === 'pct' ? 'pct/' : ''}`, { replace: true })} className={`min-h-9 rounded-full px-3.5 ${by === k ? 'bg-card font-medium shadow-[var(--shadow-card)]' : 'text-ink-2'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Panel title="Most bought" sub={by === 'pct' ? 'Each superinvestor’s buy as a share of its book, summed; ETFs left out' : 'Net dollars added by superinvestors, ETFs and index funds left out'}>
              {by === 'pct' ? <PctBars rows={d.most_bought_pct ?? []} paid={paid} what="most bought" /> : <Bars rows={d.most_bought} paid={paid} what="most bought" />}
            </Panel>
            <Panel title="Most sold" sub={by === 'pct' ? 'Each superinvestor’s sale as a share of its book, summed; ETFs left out' : 'Net dollars sold by superinvestors, ETFs and index funds left out'}>
              {by === 'pct' ? <PctBars rows={d.most_sold_pct ?? []} paid={paid} what="most sold" sold /> : <Bars rows={d.most_sold} paid={paid} what="most sold" sold />}
            </Panel>
          </div>

          <Panel className="mt-5" title="Bought by the most superinvestors" sub="How many of them added to or opened each name">
            <Buyers rows={d.most_buyers} paid={paid} />
          </Panel>

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Panel title="New positions" sub={`${d.opened_count} opened, largest first`}>
              <Moves rows={d.opened} paid={paid} what="new positions" />
            </Panel>
            <Panel title="Full exits" sub={`${d.exited_count} sold out entirely, largest first`}>
              <Moves rows={d.exited} paid={paid} what="exits" />
            </Panel>
          </div>

          <Panel className="mt-5" title="Biggest single moves" sub="One fund, one stock, by dollars traded">
            <Moves rows={d.biggest} paid={paid} what="moves" wide />
          </Panel>

          <Panel className="mt-5" title="Who filed when" sub={d.final ? 'After the deadline, late filings still appear here as EDGAR accepts them' : 'Superinvestors still to file, by the day they usually file'}>
            <div className="grid grid-cols-1 gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <div className="space-y-6">
                <List
                  title={`Filed (${d.filing.filter((x) => x.filed).length})`}
                  rows={d.filing
                    .filter((x) => x.filed)
                    .sort((a, b) => (b.accepted_at ?? '').localeCompare(a.accepted_at ?? ''))
                    .map((x) => [x.slug, x.manager, x.filing_date ? dateLabel(x.filing_date) : '', x.late])}
                />
                <div>
                  <p className="text-[13px] font-medium text-ink-2">Late ({late.length})</p>
                  {late.length ? (
                    <List rows={late.map((x) => [x.slug, x.manager, x.filing_date ? dateLabel(x.filing_date) : '', true])} />
                  ) : (
                    <p className="mt-2 text-[13.5px] text-ink-3">{d.final ? 'Nobody has filed late yet.' : `Anyone filing after ${dueLabel(d.deadline)} ET shows here.`}</p>
                  )}
                </div>
              </div>
              <div>
                <p className="text-[13px] font-medium text-ink-2">{d.final ? `Not filed (${waiting.length})` : `Still to file (${waiting.length})`}</p>
                <Waiting rows={waiting} final={d.final} />
                {d.not_filing.length > 0 && <p className="mt-4 text-[12.5px] text-ink-3">No 13F in the last year: {d.not_filing.map((x) => x.manager).join(', ')}.</p>}
              </div>
            </div>
            {!d.final && (
              <p className="mt-5 text-[13.5px]">
                <Link to="/season/#expected" className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent-2">
                  Expected to file, day by day <Arrow className="size-3" />
                </Link>
              </p>
            )}
          </Panel>

          {d.splits.length > 0 && (
            <p className="mt-4 text-[12.5px] text-ink-3">
              Left out as possible stock splits rather than trades: {d.splits.map((x) => `${x.ticker} (${x.ratio})`).join(', ')}.{' '}
              <Link to="/methodology/#splits" className="underline underline-offset-2 hover:text-ink">How we check</Link>
            </p>
          )}
        </>
      )}

      {!paid && (
        <section className="mt-10 flex flex-col items-start justify-between gap-4 rounded-[var(--radius-card)] bg-night p-6 text-white shadow-[var(--shadow-card)] md:flex-row md:items-center md:p-8">
          <div className="max-w-xl">
            <h2 className="text-[20px] font-semibold tracking-[-0.02em]">Next quarter, know the day they file.</h2>
            <p className="mt-1.5 text-[14.5px] text-white/70">Copy emails you each superinvestor’s moves minutes after EDGAR accepts the 13F, with every list on this page in full.</p>
          </div>
          <Button to="/pricing/" size="lg">
            Start {TRIAL_DAYS}-day trial <Arrow />
          </Button>
        </section>
      )}
      <Signup source="recap" className="mt-6" />
      <p className="mt-6 text-[12.5px] text-ink-3">From Form 13F-HR filings as accepted by SEC EDGAR, each fund against its previous 13F, valued at quarter-end prices as filed. Not investment advice.</p>
    </div>
  )
}

/** "+20 more for Copy members": the rest of a list, locked for guests and free members. */
function More({ n, what }: { n: number; what: string }) {
  if (n <= 0) return null
  return (
    <Link to="/pricing/" className="mt-3 flex items-center gap-2 rounded-xl bg-ink/[0.03] px-3 py-2.5 text-[13px] text-ink-2 hover:text-ink">
      <Lock />
      <span>
        {n} more {what} with Copy · <span className="font-medium text-accent">Start {TRIAL_DAYS}-day trial</span>
      </span>
    </Link>
  )
}

function Bars({ rows, paid, what, sold = false }: { rows: SeasonRow[]; paid: boolean; what: string; sold?: boolean }) {
  const shown = paid ? rows : rows.slice(0, FREE)
  const max = Math.max(1, ...shown.map((r) => Math.abs(r.net_value)))
  if (!rows.length) return <p className="text-[14px] text-ink-3">Nothing yet.</p>
  return (
    <>
      <ol className="space-y-2.5">
        {shown.map((r, i) => (
          <li key={r.ticker} className="grid grid-cols-[1.5rem_4.5rem_minmax(0,1fr)_5.5rem] items-center gap-2 text-[13.5px]">
            <span className="num text-ink-3">{i + 1}</span>
            <Link to={stockPath(r.ticker)} className="font-mono text-[13px] font-semibold hover:text-accent">
              {r.ticker}
            </Link>
            <span className="min-w-0">
              {/* On a phone the fund gets its own line, so a long company name can't push it out. */}
              <span className="block truncate text-ink-2" title={r.name}>
                {r.name}
                <span className="hidden text-ink-3 sm:inline"> · {who(sold ? r.sellers : r.buyers, sold ? r.n_sellers : r.n_buyers)}</span>
              </span>
              <span className="block truncate text-[12.5px] text-ink-3 sm:hidden">{who(sold ? r.sellers : r.buyers, sold ? r.n_sellers : r.n_buyers)}</span>
              <span className="mt-1 block h-1.5 rounded-full bg-ink/[0.05]">
                <span className={`block h-full rounded-full ${sold ? 'bg-down' : 'bg-up'}`} style={{ width: `${(Math.abs(r.net_value) / max) * 100}%` }} />
              </span>
            </span>
            <span className={`num text-right font-medium ${sold ? 'text-down' : 'text-up'}`}>{signed(r.net_value)}</span>
          </li>
        ))}
      </ol>
      {!paid && <More n={rows.length - shown.length} what={what} />}
    </>
  )
}

/** "Richard Pzena", or "3 superinvestors" when more than one did it. */
const who = (people: { manager: string }[], n?: number) => ((n ?? people.length) > 1 ? `${n ?? people.length} superinvestors` : (people[0]?.manager ?? ''))

function PctBars({ rows, paid, what, sold = false }: { rows: PctRow[]; paid: boolean; what: string; sold?: boolean }) {
  const shown = paid ? rows : rows.slice(0, FREE)
  const max = Math.max(1e-9, ...shown.map((r) => Math.abs(r.pct)))
  if (!rows.length) return <p className="text-[14px] text-ink-3">Nothing yet.</p>
  return (
    <>
      <ol className="space-y-2.5">
        {shown.map((r, i) => (
          <li key={r.ticker} className="grid grid-cols-[1.5rem_4.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-[13.5px]">
            <span className="num text-ink-3">{i + 1}</span>
            <Link to={stockPath(r.ticker)} className="font-mono text-[13px] font-semibold hover:text-accent">
              {r.ticker}
            </Link>
            <span className="min-w-0">
              {/* On a phone the fund gets its own line, so a long company name can't push it out. */}
              <span className="block truncate text-ink-2" title={r.name}>
                {r.name}
                <span className="hidden text-ink-3 sm:inline"> · {who(sold ? r.sellers : r.buyers, sold ? r.n_sellers : r.n_buyers)}</span>
              </span>
              <span className="block truncate text-[12.5px] text-ink-3 sm:hidden">{who(sold ? r.sellers : r.buyers, sold ? r.n_sellers : r.n_buyers)}</span>
              <span className="mt-1 block h-1.5 rounded-full bg-ink/[0.05]">
                <span className={`block h-full rounded-full ${sold ? 'bg-down' : 'bg-up'}`} style={{ width: `${(Math.abs(r.pct) / max) * 100}%` }} />
              </span>
            </span>
            <span className={`num text-right font-medium ${sold ? 'text-down' : 'text-up'}`}>
              {r.pct >= 0 ? '+' : '−'}
              {(Math.abs(r.pct) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ol>
      {!paid && <More n={rows.length - shown.length} what={what} />}
    </>
  )
}

function Buyers({ rows, paid }: { rows: SeasonRow[]; paid: boolean }) {
  const shown = paid ? rows.slice(0, 15) : rows.slice(0, FREE)
  if (!rows.length) return <p className="text-[14px] text-ink-3">Nothing yet.</p>
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="text-left text-[12px] text-ink-3">
              <th className="pb-2 font-medium">Stock</th>
              <th className="pb-2 text-right font-medium">Buyers</th>
              <th className="pb-2 pl-6 font-medium">Who</th>
              <th className="pb-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.ticker} className="border-t border-line">
                <td className="py-2.5 pr-3">
                  <Link to={stockPath(r.ticker)} className="font-mono text-[13px] font-semibold hover:text-accent">
                    {r.ticker}
                  </Link>
                  <span className="ml-2 text-ink-2">{r.name}</span>
                </td>
                <td className="num py-2.5 text-right font-medium">{r.n_buyers}</td>
                <td className="py-2.5 pl-6 text-ink-2">
                  {r.buyers.slice(0, 3).map((b) => b.manager).join(', ')}
                  {(r.n_buyers ?? 0) > 3 && <span className="text-ink-3"> +{(r.n_buyers ?? 0) - 3}</span>}
                </td>
                <td className={`num py-2.5 text-right ${r.net_value >= 0 ? 'text-up' : 'text-down'}`}>{signed(r.net_value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!paid && <More n={rows.length - shown.length} what="names" />}
    </>
  )
}

function Moves({ rows, paid, what, wide = false }: { rows: RecapMove[]; paid: boolean; what: string; wide?: boolean }) {
  const shown = paid ? rows.slice(0, wide ? 30 : 20) : rows.slice(0, FREE)
  if (!rows.length) return <p className="text-[14px] text-ink-3">None yet.</p>
  return (
    <>
      <ul className="divide-y divide-line">
        {shown.map((m) => (
          <li key={`${m.slug}-${m.ticker}`} className="flex items-center gap-3 py-2.5 text-[13.5px]">
            {wide && <span className={`w-16 shrink-0 text-[12px] font-medium ${m.delta_value >= 0 ? 'text-up' : 'text-down'}`}>{CHANGE[m.change]}</span>}
            <Link to={stockPath(m.ticker)} className="-my-2 w-14 shrink-0 py-2 font-mono text-[13px] font-semibold hover:text-accent">
              {m.ticker}
            </Link>
            <span className="min-w-0 flex-1 truncate">
              <Link to={`/investors/${m.slug}/`} className="hover:text-accent">
                {m.manager}
              </Link>
              <span className="text-ink-3"> · {m.name}</span>
            </span>
            <span className={`num shrink-0 font-medium ${m.delta_value >= 0 ? 'text-up' : 'text-down'}`}>{signed(m.delta_value)}</span>
          </li>
        ))}
      </ul>
      {!paid && <More n={rows.length - shown.length} what={what} />}
    </>
  )
}

/** Still to file, grouped by the day each usually files; overdue and patternless ones apart. */
function Waiting({ rows, final }: { rows: { slug: string; manager: string; expected_date: string | null; placeholder?: { quarter: string } }[]; final: boolean }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  // A filer whose last 13F was an empty placeholder did file: listed apart, never as late or missing.
  const key = (x: (typeof rows)[number]) => (x.placeholder ? 'empty' : final ? 'none' : !x.expected_date ? 'nofixed' : x.expected_date < today ? 'late' : x.expected_date)
  const rank = (k: string) => (k === 'late' ? 0 : k === 'nofixed' ? 2 : k === 'empty' ? 3 : 1)
  const groups = [...new Set(rows.map(key))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const label = (k: string) =>
    k === 'empty' ? `Last 13F was empty` : k === 'none' ? 'No 13F yet' : k === 'late' ? 'Later than usual' : k === 'nofixed' ? 'No fixed day' : `Usually ${dayName(k, today)}`
  if (!rows.length) return <p className="mt-2 text-[13.5px] text-ink-3">Everyone has filed.</p>
  return (
    <dl className="mt-2 divide-y divide-line">
      {groups.map((g) => {
        const xs = rows.filter((x) => key(x) === g)
        return (
          <div key={g} className="grid gap-1 py-2.5 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-4">
            <dt className={`text-[12.5px] font-medium ${g === 'late' ? 'text-[#8a5a0b]' : 'text-ink-3'}`}>
              {label(g)} <span className="font-normal">({xs.length})</span>
            </dt>
            <dd className="text-[13.5px] leading-relaxed">
              {xs.map((x, i) => (
                <span key={x.slug}>
                  <Link to={`/investors/${x.slug}/`} className="hover:text-accent">
                    {x.manager}
                  </Link>
                  {i < xs.length - 1 && <span className="text-ink-3">, </span>}
                </span>
              ))}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

function List({ title, rows }: { title?: string; rows: [string, string, string, boolean][] }) {
  return (
    <div>
      {title && <p className="text-[13px] font-medium text-ink-2">{title}</p>}
      <ul className="mt-2 space-y-1.5 text-[13.5px]">
        {rows.map(([slug, name, note, late]) => (
          <li key={slug} className="flex items-baseline justify-between gap-3">
            <Link to={`/investors/${slug}/`} className="truncate hover:text-accent">
              {name}
            </Link>
            <span className={`shrink-0 text-[12.5px] ${late ? 'text-[#8a5a0b]' : 'text-ink-3'}`}>
              {note}
              {late ? ' · late' : ''}
            </span>
          </li>
        ))}
        {!rows.length && <li className="text-ink-3">None</li>}
      </ul>
    </div>
  )
}
