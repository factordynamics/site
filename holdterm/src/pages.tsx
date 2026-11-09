import { useEffect, useMemo, useState } from 'react'
import { api, checkout, price as PRICE, SITE } from './config'
import {
  aggregate,
  funds,
  inRoster,
  isStale,
  loadBook,
  loadBooks,
  loadEvents,
  loadFundEvents,
  loadHistory,
  loadIndex,
  loadInsiders,
  loadStock,
  loadStockIndex,
  isFundLike,
  quarterLabel,
  roster,
  SECTOR_COLOR,
  SECTOR_SHORT,
  sectorMix,
  type Agg,
  type Book,
  type Event,
  type Holding,
  type Index,
  type Insider,
  type Manager,
  type StockHolder,
} from './data'
import { A, Bar, ChangeTag, date, Failed, Grid, Loading, num, Panel, pct, price, signedUsd, StackBar, Stat, Tabs, Tick, usd, useLoad, type Col } from './lib'
import { HBars, ValueHistory } from './charts'
import { firmName, fundPath, issuerName } from './names'
import EXCLUSIONS from '../scripts/roster-exclusions.json'
import { follows, Follow, useMember, startFromUrl, requestLogin, setFollow, openPortal, signOut, type Follows } from './account'

const title = (t: string) => {
  document.title = `${t} · holdterm`
  const url = SITE + (location.pathname.replace(/\/+$/, '') || '/')
  document.querySelector('link[rel=canonical]')?.setAttribute('href', url)
  document.querySelector('meta[property="og:url"]')?.setAttribute('content', url)
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', `${t} · holdterm`)
}
export const REPO = 'https://github.com/factordynamics/site'
export const ISSUES = `${REPO}/issues/new?labels=holdterm&title=Holdterm%3A+`
export const CONTACT = 'hello@factordynamics.com'
const qOf = (period: string) => {
  // "30-JUN-2026" -> "2026Q2"
  const m = ['MAR', 'JUN', 'SEP', 'DEC'].indexOf(period.slice(3, 6))
  return `${period.slice(7)}Q${m + 1}`
}

// ---------- fund names and links ----------
/** Roster fund slug for any filer slug (a successor filer links to the fund it files for). */
const fundSlug = (slug: string) => roster.funds.find((f) => f.filer_slug === slug)?.slug ?? slug
function useFirms(): Map<string, string> {
  const ix = useLoad(loadIndex, [])
  return useMemo(() => new Map((ix.data?.managers ?? []).map((m) => [m.slug, m.firm])), [ix.data])
}
const firmOf = (firms: Map<string, string>, slug: string, fallback: string) => firms.get(fundSlug(slug)) ?? firmName(slug, fallback)
function FundLink({ slug, name }: { slug: string; name: string }) {
  return inRoster(slug) ? <A to={fundPath(fundSlug(slug))}>{name}</A> : <span>{name}</span>
}

// ---------- shared bits ----------
function Sector({ s }: { s?: string | null }) {
  const k = s || 'Unclassified'
  return (
    <span className="sector" title={k}>
      <i style={{ background: SECTOR_COLOR[k] ?? '#555' }} aria-hidden />
      {SECTOR_SHORT[k] ?? 'OTHR'}
    </span>
  )
}
function Who({ list, max = 3 }: { list: { slug: string; manager: string }[]; max?: number }) {
  return (
    <span className="who">
      {list.slice(0, max).map((w, i) => (
        <span key={w.slug}>
          {i > 0 && <span className="dim">, </span>}
          <A to={fundPath(w.slug)}>{w.manager}</A>
        </span>
      ))}
      {list.length > max && <span className="dim"> +{list.length - max}</span>}
    </span>
  )
}
/** A stock cell: ticker link when there is one, else the company name (never a guessed ticker). */
function StockCell({ t, name, former, label }: { t: string | null; name: string; former?: string; label?: string }) {
  if (t) return <Tick t={t} name={name} label={label} />
  if (former) return <span className="former" title={`${name}: no longer listed (former ticker ${former})`}>{former}†</span>
  return <span className="noticker" title="no US ticker for this CUSIP">{name}</span>
}
const aggCols = {
  ticker: { key: 'ticker', label: 'ticker', render: (r: Agg) => <StockCell t={r.ticker} name={r.name} former={r.former} label={r.label} />, sort: (r: Agg) => r.ticker ?? r.name, width: '80px' } as Col<Agg>,
  name: { key: 'name', label: 'company', link: true, render: (r: Agg) => <span className="trunc">{r.name}</span>, sort: (r: Agg) => r.name } as Col<Agg>,
  sector: { key: 'sector', label: 'sector', hideSm: true, render: (r: Agg) => <Sector s={r.sector} />, sort: (r: Agg) => r.sector } as Col<Agg>,
}
const stockHref = (r: { ticker: string | null }) => (r.ticker ? `/s/${encodeURIComponent(r.ticker)}` : null)

function SectorRows({ items }: { items: { sector?: string | null; value: number }[] }) {
  const mix = sectorMix(items)
  const max = mix[0]?.weight ?? 1
  return (
    <table className="grid sector-rows">
      <caption className="sr">sector mix</caption>
      <tbody>
        {mix.map((m) => (
          <tr key={m.sector}>
            <td>
              <Sector s={m.sector} /> <span className="hide-sm dim">{m.sector}</span>
            </td>
            <td className="num">{pct(m.weight, 1)}</td>
            <td className="barcell">
              <span className="bar wide" aria-hidden>
                <span className="fill" style={{ width: `${((m.weight / max) * 100).toFixed(1)}%`, background: SECTOR_COLOR[m.sector] ?? '#555' }} />
              </span>
            </td>
            <td className="num">{usd(m.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------- 13D/G and Form 4 ----------
const GENERIC = new Set(['capital', 'management', 'partners', 'group', 'fund', 'funds', 'holdings', 'investment', 'investments', 'advisors', 'advisers', 'global', 'asset', 'associates', 'company', 'corp', 'trust', 'value', 'private', 'income', 'acquisition'])
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !GENERIC.has(w))
/** A filing on the filer's own vehicle (its own funds, SPACs or listed holding companies), not a stake in an outside company. */
export const ownVehicle = (e: Event) => {
  const own = new Set([...tokens(e.manager), ...tokens(firmName(fundSlug(e.slug), e.manager))])
  return tokens(e.display_name || e.issuer).some((w) => own.has(w))
}
const ACTION: Record<string, [string, string]> = {
  buy: ['BUY', 'pos'],
  sell: ['SELL', 'neg'],
  mixed: ['MIXED', ''],
  other: ['NO TRADE', 'dim'],
  new_stake: ['NEW 5%+', 'pos'],
  stake_update: ['UPDATE', ''],
  below_threshold: ['<5%', 'neg'],
}
function ActionTag({ e }: { e: Event }) {
  const [label, tone] = ACTION[e.action] ?? [e.action, '']
  const why = e.action === 'other' ? 'Form 4 with no open-market purchase or sale: a gift, award, conversion, distribution or a holdings report' : undefined
  return <span className={`tag ${tone}`} title={why}>{label}</span>
}
const eventCols = (firms: Map<string, string>, withWho = true): Col<Event>[] => [
  { key: 'filed', label: 'filed', render: (e) => <span className="dim num">{date(e.filing_date)}</span>, sort: (e) => e.filing_date, width: '84px' },
  { key: 'form', label: 'form', render: (e) => <span className="form">{e.kind === 'form4' ? 'F4' : e.kind.toUpperCase()}</span>, sort: (e) => e.kind },
  ...(withWho ? [{ key: 'who', label: 'filer', render: (e: Event) => <FundLink slug={e.slug} name={firmOf(firms, e.slug, e.manager)} />, sort: (e: Event) => e.manager } as Col<Event>] : []),
  {
    key: 'iss',
    label: 'issuer',
    render: (e) => (
      <span className="iss">
        <StockCell t={ownVehicle(e) ? null : e.ticker} name={issuerName(e.display_name || e.issuer)} former={ownVehicle(e) ? undefined : e.former} />
        {ownVehicle(e) && <span className="badge">own fund</span>}
      </span>
    ),
  },
  { key: 'act', label: 'action', render: (e) => <ActionTag e={e} />, sort: (e) => e.action },
  { key: 'pc', label: '% class', num: true, hideSm: true, render: (e) => (e.percent_of_class != null ? `${e.percent_of_class.toFixed(e.percent_of_class < 10 ? 2 : 1)}%` : <span className="dim">—</span>), sort: (e) => e.percent_of_class ?? -1 },
  { key: 'val', label: 'value', num: true, render: (e) => (e.value_usd != null ? <span className={e.action === 'sell' ? 'neg' : e.action === 'buy' ? 'pos' : ''}>{usd(e.value_usd)}</span> : <span className="dim">—</span>), sort: (e) => e.value_usd ?? -1 },
  { key: 'sa', label: 'shares after', num: true, hideSm: true, render: (e) => num(e.shares_after), sort: (e) => e.shares_after ?? -1 },
  {
    key: 'sec',
    label: <span className="sr">SEC filing</span>,
    render: (e) => (
      <a href={e.url} target="_blank" rel="noreferrer" className="dim ext" aria-label={`SEC filing ${e.id}`}>
        sec↗
      </a>
    ),
  },
]

// ---------- filing season ----------
/** The 13F season in progress: the quarter that most recently ended, due 45 days later (next business day). */
function season(now = new Date()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const qEndMonth = Math.floor(m / 3) * 3 - 1 // last month of the previous quarter
  const end = new Date(Date.UTC(y, qEndMonth + 1, 0))
  const q = `${end.getUTCFullYear()}Q${Math.floor(end.getUTCMonth() / 3) + 1}`
  const due = new Date(end.getTime() + 45 * 86_400_000)
  while (due.getUTCDay() === 0 || due.getUTCDay() === 6) due.setUTCDate(due.getUTCDate() + 1)
  return { q, end: end.toISOString().slice(0, 10), due: due.toISOString().slice(0, 10) }
}

// ---------- home ----------
/** Each fund's latest book for the funds that filed in a given quarter. */
const loadQuarterBooks = (slugs: string[]) => Promise.all(slugs.map((x) => loadBook(x).catch(() => null))).then((bs) => bs.filter((b): b is Book => Boolean(b)))
const moveLabel = (h: Holding) => (h.change === 'new' ? 'NEW' : h.change === 'exited' ? 'SOLD OUT' : h.change === 'added' ? 'ADD' : 'TRIM')
export function Home() {
  title('13F filings and trades of concentrated long-term funds')
  const ix = useLoad(loadIndex, [])
  const ev = useLoad(loadEvents, [])
  const firms = useFirms()
  const ms = useMemo(() => (ix.data ? funds(ix.data) : []), [ix.data])
  const s = season()
  const seasonFiled = ms.filter((m) => m.quarter === s.q)
  // Before three funds have filed this season, lead with the previous quarter's filings instead.
  const lead = seasonFiled.length >= 3 ? s.q : [...new Set(ms.map((m) => m.quarter))].sort().reverse().find((q) => q !== s.q) ?? s.q
  // Every fund's latest 13F, newest first; the trades panel uses the lead quarter only.
  const filers = useMemo(() => [...ms].sort((a, b) => b.filing_date.localeCompare(a.filing_date) || b.total_value - a.total_value).slice(0, 30), [ms])
  const need = useMemo(() => [...new Set([...filers, ...ms.filter((m) => m.quarter === lead)].map((m) => m.slug))], [filers, ms, lead])
  const books = useLoad(() => (need.length ? loadQuarterBooks(need) : Promise.resolve([] as Book[])), [need.join()])
  if (ix.error) return <Failed error={ix.error} />
  if (!ix.data) return <Loading what="loading filings" />
  const bySlug = new Map((books.data ?? []).map((b) => [b.slug, b]))
  // One trade per company per fund: share classes (GOOGL and GOOG) are combined.
  const trades = (b: Book) => {
    const by = new Map<string, Holding & { label?: string }>()
    for (const h of b.holdings) {
      if (h.put_call || !h.value_delta || isFundLike(h)) continue
      const k = h.cusip.slice(0, 6)
      const cur = by.get(k)
      if (!cur) by.set(k, { ...h, label: h.ticker ?? undefined })
      else {
        const label = [cur.label, h.ticker].filter(Boolean).join('+')
        if (Math.abs(h.value) > Math.abs(cur.value)) Object.assign(cur, { ticker: h.ticker, former: h.former, display_name: h.display_name, cusip: h.cusip })
        cur.label = label
        cur.value_delta = (cur.value_delta ?? 0) + h.value_delta
        cur.value += h.value
        if (cur.change !== h.change) cur.change = cur.value_delta > 0 ? (cur.change === 'new' && h.change === 'new' ? 'new' : 'added') : cur.value > 0 ? 'trimmed' : 'exited'
      }
    }
    return [...by.values()]
  }
  const biggest = (b: Book) => [...trades(b)].sort((x, y) => Math.abs(y.value_delta!) - Math.abs(x.value_delta!))[0]
  const moves = (books.data ?? [])
    .filter((b) => b.quarter === lead)
    .flatMap((b) => trades(b).map((h) => ({ b, h })))
    .sort((x, y) => Math.abs(y.h.value_delta!) - Math.abs(x.h.value_delta!))
    // At most four per fund (enough for a fund's sell-outs), so one early filer can't fill the list.
    .filter((x, _, all) => all.filter((y) => y.b.slug === x.b.slug).indexOf(x) < 4)
    .slice(0, 15)
  const due = ms.filter((m) => m.quarter !== s.q)
  const daysLeft = Math.ceil((Date.parse(s.due) - Date.now()) / 86_400_000)
  const events = (ev.data?.events ?? []).filter((e) => inRoster(e.slug) && !ownVehicle(e))
  // Highest conviction from each fund's largest positions (index), share classes combined per fund.
  const conv = new Map<string, { key: string; ticker: string | null; label?: string; former?: string; name: string; slug: string; firm: string; weight: number }>()
  for (const m of ms)
    for (const h of m.top ?? []) {
      if (h.put_call || isFundLike(h) || !h.cusip) continue
      const k = h.cusip.slice(0, 6)
      const id = `${k}|${m.slug}`
      const cur = conv.get(id)
      if (cur) {
        cur.weight += h.weight
        if (h.ticker) cur.label = [cur.label ?? cur.ticker, h.ticker].filter(Boolean).join('+')
      } else conv.set(id, { key: id, ticker: h.ticker, former: h.former, name: issuerName(h.display_name || h.issuer), slug: m.slug, firm: m.firm, weight: h.weight })
    }
  const conviction = [...conv.values()].sort((a, b) => b.weight - a.weight).slice(0, 12)
  return (
    <div className="page home">
      <div className="home-grid">
        <Panel
          title="latest 13F filings"
          right={
            <span className="dim">
              {seasonFiled.length}/{ms.length} filed {quarterLabel(s.q)} · due {date(s.due).slice(0, 6)}
              <span className="hide-sm">{daysLeft > 0 ? `, ${daysLeft} days left` : ' (passed)'}</span>
            </span>
          }
        >
          <Grid
            keyboard
            rows={filers}
            href={(m) => fundPath(m.slug)}
            cols={[
              { key: 'f', label: 'filed', render: (m) => <span className="dim num">{date(m.filing_date)}</span>, width: '84px' },
              { key: 'm', label: 'fund', link: true, render: (m) => <span className="trunc strong">{m.firm}</span> },
              { key: 'q', label: 'qtr', hideSm: true, render: (m) => <span className={m.quarter === s.q ? 'tag acc' : 'dim'}>{quarterLabel(m.quarter)}</span> },
              { key: 'v', label: 'book', num: true, hideSm: true, render: (m) => usd(bySlug.get(m.slug)?.long_value ?? m.total_value) },
              {
                key: 'd',
                label: 'vs prior qtr',
                num: true,
                hideSm: true,
                render: (m) => {
                  const b = bySlug.get(m.slug)
                  if (!b?.prev_long_value) return <span className="dim">—</span>
                  const d = b.long_value / b.prev_long_value - 1
                  return <span className={d > 0 ? 'pos' : d < 0 ? 'neg' : ''}>{d > 0 ? '+' : ''}{pct(d, 0)}</span>
                },
              },
              {
                key: 'mv',
                label: 'largest trade',
                render: (m) => {
                  const b = bySlug.get(m.slug)
                  const h = b && biggest(b)
                  if (!h) return <span className="dim">{b ? 'no trades' : '…'}</span>
                  return (
                    <span className="move">
                      <StockCell t={h.ticker} name={h.display_name || h.issuer} former={h.former} label={h.label} /> <span className={`tag ${h.value_delta! > 0 ? 'pos' : 'neg'}`}>{moveLabel(h)}</span> <span className={`num ${h.value_delta! > 0 ? 'pos' : 'neg'}`}>{signedUsd(h.value_delta)}</span>
                    </span>
                  )
                },
              },
            ]}
            empty={`no ${quarterLabel(lead)} 13Fs yet`}
          />
          {due.length > 0 && (
            <div className="due small">
              <span className="dim">not filed yet ({due.length}):</span>{' '}
              {due
                .sort((a, b) => b.total_value - a.total_value)
                .slice(0, 14)
                .map((m, i) => (
                  <span key={m.slug}>
                    {i > 0 && ', '}
                    <A to={fundPath(m.slug)}>{m.firm}</A>
                  </span>
                ))}
              {due.length > 14 && (
                <>
                  {' '}
                  <A to="/funds">+{due.length - 14} more</A>
                </>
              )}
            </div>
          )}
        </Panel>
        <div className="home-side">
          <Panel title={`largest trades · ${quarterLabel(lead)}`} right={<A to="/flows">flows →</A>}>
            {books.data ? (
              <Grid
                rows={moves}
                href={(x) => stockHref(x.h)}
                cols={[
                  { key: 't', label: 'stock', render: (x) => <StockCell t={x.h.ticker} name={x.h.display_name || x.h.issuer} former={x.h.former} label={x.h.label} />, width: '72px' },
                  { key: 'f', label: 'fund', link: true, render: (x) => <span className="trunc">{x.b.firm}</span> },
                  { key: 'a', label: '', render: (x) => <span className={`tag ${x.h.value_delta! > 0 ? 'pos' : 'neg'}`}>{moveLabel(x.h)}</span> },
                  { key: 'v', label: '$ traded', num: true, render: (x) => <span className={x.h.value_delta! > 0 ? 'pos' : 'neg'}>{signedUsd(x.h.value_delta)}</span> },
                ]}
              />
            ) : (
              <Loading what="reading the books" />
            )}
          </Panel>
          <Panel title="13D/G and Form 4 · 30 days" right={<A to="/filings">all →</A>}>
            {ev.data ? (
              <Grid
                rows={events.slice(0, 10)}
                href={(e) => (e.ticker ? `/s/${e.ticker}` : null)}
                cols={[
                  { key: 'f', label: 'filed', render: (e) => <span className="dim num">{date(e.filing_date)}</span>, width: '72px' },
                  { key: 'w', label: 'fund', render: (e) => <span className="trunc">{firmOf(firms, e.slug, e.manager)}</span> },
                  { key: 't', label: 'stock', render: (e) => <StockCell t={e.ticker} name={issuerName(e.display_name || e.issuer)} former={e.former} /> },
                  { key: 'a', label: '', render: (e) => <ActionTag e={e} /> },
                ]}
                empty="no filings in the last 30 days"
              />
            ) : (
              <Loading />
            )}
          </Panel>
          <Panel title="highest conviction" right={<span className="dim">largest % of one book</span>}>
            <Grid
              rank
              rows={conviction}
              href={(r) => stockHref(r)}
              cols={[
                { key: 't', label: 'stock', render: (r) => <StockCell t={r.ticker} name={r.name} former={r.former} label={r.label} />, width: '72px' },
                { key: 'f', label: 'fund', render: (r) => <A to={fundPath(r.slug)}>{r.firm}</A> },
                { key: 'w', label: 'weight', num: true, render: (r) => pct(r.weight, 1) },
              ]}
            />
          </Panel>
        </div>
      </div>
    </div>
  )
}

// ---------- funds directory ----------
export function Funds() {
  title('funds')
  const ix = useLoad(loadIndex, [])
  const books = useLoad(loadBooks, [])
  if (ix.error) return <Failed error={ix.error} />
  if (!ix.data) return <Loading />
  const ms = funds(ix.data)
  const all = ix.data.managers.filter((m) => m.ok)
  const metric = new Map(roster.funds.map((f) => [f.slug, f]))
  const bookOf = new Map((books.data ?? []).map((b) => [b.slug, b]))
  const longOf = (m: Manager) => {
    const b = bookOf.get(m.slug)
    return b ? { v: b.long_value, n: b.long_count } : { v: m.total_value, n: m.position_count }
  }
  return (
    <div className="page">
      <h1>
        funds <span className="dim">· {ms.length} of {ms.length + roster.pending.length} live: concentrated, long-term books chosen by a <A to="/about#roster">published rule</A>; the rest are loading</span>
      </h1>
      <Panel title="roster" right={<span className="dim hide-sm">j/k + enter</span>}>
        <Grid
          keyboard
          rank
          rows={ms}
          initial={['v', 'desc']}
          href={(m) => fundPath(m.slug)}
          cols={[
            {
              key: 'm',
              label: 'fund',
              link: true,
              render: (m) => (
                <span>
                  <span className="strong">{m.firm}</span>
                  {m.pm && <span className="dim hide-sm"> · {m.pm}</span>}
                </span>
              ),
              sort: (m) => m.firm,
            },
            { key: 'v', label: '13F book', num: true, hideSm: true, render: (m) => usd(longOf(m).v), sort: (m) => longOf(m).v, title: 'long stock positions; options notional excluded' },
            { key: 'n', label: 'positions', num: true, hideSm: true, render: (m) => longOf(m).n, sort: (m) => longOf(m).n },
            { key: 't', label: 'top 10', num: true, hideSm: true, render: (m) => pct(metric.get(m.slug)?.top10, 0), sort: (m) => metric.get(m.slug)?.top10 ?? 0, title: 'share of the book in the 10 largest positions' },
            { key: 'to', label: 'turnover', num: true, hideSm: true, render: (m) => pct(metric.get(m.slug)?.turnover, 0), sort: (m) => metric.get(m.slug)?.turnover ?? 0, title: 'latest quarter: (bought + sold) / 2 / average book' },
            {
              key: 'top',
              label: 'largest positions',
              hideSm: true,
              render: (m) => (
                <span className="tks">
                  {m.top.filter((h) => !h.put_call && !isFundLike(h)).slice(0, 5).map((h) => (
                    <StockCell key={h.cusip} t={h.ticker} former={h.former} name={issuerName(h.display_name || h.issuer).split(' ').slice(0, 2).join(' ')} />
                  ))}
                </span>
              ),
            },
            {
              key: 'q',
              label: 'latest',
              render: (m) => (
                <span>
                  {quarterLabel(m.quarter)} {isStale(m, all) && <span className="badge warn">stale</span>}
                  <span className="dim show-sm"> · {date(m.filing_date).slice(0, 6)}</span>
                </span>
              ),
              sort: (m) => m.quarter,
            },
            { key: 'f', label: 'filed', num: true, hideSm: true, render: (m) => <span className="dim">{date(m.filing_date)}</span>, sort: (m) => m.filing_date },
          ]}
        />
      </Panel>
    </div>
  )
}

// ---------- one fund ----------
type ITab = 'holdings' | 'buys' | 'sells' | 'options' | 'filings' | 'events'
export function Fund({ slug }: { slug: string }) {
  const b = useLoad(() => loadBook(slug), [slug])
  const ix = useLoad(loadIndex, [])
  const h = useLoad(() => loadHistory(slug).catch(() => ({ history: [] })), [slug])
  const meta = roster.funds.find((f) => f.slug === slug)
  const ev = useLoad(async () => {
    const own = await loadFundEvents(slug)
    const filer = meta && meta.filer_slug !== slug ? await loadFundEvents(meta.filer_slug) : { events: [] }
    const seen = new Set<string>()
    return [...own.events, ...filer.events].filter((e) => !seen.has(e.id) && seen.add(e.id)).sort((a, c) => c.filing_date.localeCompare(a.filing_date))
  }, [slug])
  const firms = useFirms()
  const [tab, setTab] = useState<ITab>('holdings')
  if (b.error) return <NotFound what={`no 13F book for "${slug}"`} />
  if (!b.data) return <Loading what={`loading ${slug}`} />
  const book = b.data
  title(`${book.firm} 13F portfolio`)
  const filer = meta && meta.filer_slug !== slug ? ix.data?.managers.find((m) => m.slug === meta.filer_slug) : null
  // Options are notional, not stock: they stay out of the book, its weights and the bought/sold totals.
  const live = book.holdings.filter((x) => x.value > 0 && !x.put_call)
  const opts = book.holdings.filter((x) => x.put_call && (x.value > 0 || x.prev_value))
  const stock = book.holdings.filter((x) => !x.put_call)
  const buys = stock.filter((x) => (x.value_delta ?? 0) > 0).sort((a, c) => (c.value_delta ?? 0) - (a.value_delta ?? 0))
  const sells = stock.filter((x) => (x.value_delta ?? 0) < 0).sort((a, c) => (a.value_delta ?? 0) - (c.value_delta ?? 0))
  const bought = buys.reduce((s, x) => s + (x.value_delta ?? 0), 0)
  const sold = sells.reduce((s, x) => s + (x.value_delta ?? 0), 0)
  const top10 = [...live].sort((a, c) => c.weight - a.weight).slice(0, 10).reduce((s, x) => s + x.weight, 0)
  const hist = [...(h.data?.history ?? [])].filter((r) => r.total_value > 0).reverse()
  const events = ev.data ?? []
  const stale = ix.data ? isStale(book, ix.data.managers.filter((m) => m.ok)) : false
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>
            {book.firm} {!inRoster(slug) && <span className="badge">not on the roster</span>} {stale && <span className="badge warn">stale: latest usable 13F is {quarterLabel(book.quarter)}</span>}
          </h1>
          <div className="dim">
            {book.pm && <span className="fg">PM {book.pm} · </span>}
            EDGAR filer {filer ? filer.name : book.name} · CIK {(filer?.cik ?? book.cik).replace(/^0+/, '')} ·{' '}
            <a href={book.sec_url} target="_blank" rel="noreferrer">
              13F-HR {book.accession} ↗
            </a>
          </div>
        </div>
        <Follow kind="investors" id={slug} />
      </div>
      <div className="stats fund-stats">
        <Stat label="period" value={quarterLabel(book.quarter)} sub={`filed ${date(book.filing_date)}`} />
        <Stat
          label="13F book"
          value={usd(book.long_value)}
          sub={
            <>
              {book.prev_long_value ? `${signedUsd(book.long_value - book.prev_long_value)} vs ${quarterLabel(book.prev_quarter ?? '')}` : 'first filing'}
              {book.options_value > 0 && <span className="dim"> · + {usd(book.options_value)} options notional</span>}
            </>
          }
        />
        <Stat label="positions" value={live.length} sub={`${stock.filter((x) => x.change === 'new').length} new · ${stock.filter((x) => x.change === 'exited').length} sold out`} />
        <Stat label="top 10 weight" value={pct(top10, 1)} sub={<Bar value={top10} max={1} />} />
        <Stat label="bought" value={usd(bought)} tone="pos" sub={`${buys.length} positions`} />
        <Stat label="sold" value={usd(-sold)} tone="neg" sub={`${sells.length} positions`} />
      </div>
      <Tabs<ITab>
        value={tab}
        onChange={setTab}
        options={[
          ['holdings', `holdings ${live.length}`],
          ['buys', `buys ${buys.length}`],
          ['sells', `sells ${sells.length}`],
          ...(opts.length ? ([['options', `options ${opts.length}`]] as [ITab, string][]) : []),
          ['filings', `13F filings ${hist.length}`],
          ['events', `13D/G·F4 ${events.length}`],
        ]}
      />
      <Panel title={tab} right={tab === 'holdings' ? <span className="dim hide-sm">reported price = value ÷ shares as filed</span> : tab === 'options' ? <span className="dim hide-sm">notional = underlying shares × price; not part of the book</span> : undefined}>
        {tab === 'holdings' && <HoldingsGrid rows={live} own={(x) => ownHolding(book, x)} />}
        {tab === 'buys' && <MovesGrid rows={buys} />}
        {tab === 'sells' && <MovesGrid rows={sells} />}
        {tab === 'options' && (
          <Grid
            rows={[...opts].sort((a, c) => c.value - a.value)}
            href={stockHref}
            cols={[
              { key: 't', label: 'ticker', render: (r) => <StockCell t={r.ticker} name={r.display_name || r.issuer} former={r.former} />, width: '80px' },
              { key: 'n', label: 'underlying', hideSm: true, render: (r) => <span className="trunc">{r.display_name}</span> },
              { key: 'pc', label: 'type', render: (r) => <span className={`tag ${r.put_call === 'CALL' ? 'pos' : 'neg'}`}>{r.put_call}</span> },
              { key: 'sh', label: 'shares', num: true, hideSm: true, render: (r) => num(r.shares) },
              { key: 'v', label: 'notional', num: true, render: (r) => usd(r.value), sort: (r) => r.value },
              { key: 'd', label: 'Δ notional', num: true, render: (r) => <span className="dim">{signedUsd((r.value || 0) - (r.prev_value ?? 0))}</span> },
            ]}
          />
        )}
        {tab === 'filings' && (
          <Grid
            rows={[...hist].reverse()}
            cols={[
              { key: 'q', label: 'qtr', render: (r) => quarterLabel(r.quarter) },
              { key: 'rd', label: 'period end', render: (r) => date(r.report_date) },
              { key: 'fd', label: 'filed', render: (r) => date(r.filing_date) },
              { key: 'v', label: 'book', num: true, render: (r) => usd(r.total_value) },
              { key: 'n', label: 'positions', num: true, render: (r) => r.position_count },
              {
                key: 's',
                label: <span className="sr">SEC filing</span>,
                render: (r) => (
                  <a href={r.sec_url} target="_blank" rel="noreferrer" className="dim ext">
                    sec↗
                  </a>
                ),
              },
            ]}
          />
        )}
        {tab === 'events' && <Grid rows={events} cols={eventCols(firms, false)} empty="no Form 4 or 13D/G filed since the latest 13F period" />}
      </Panel>
      <div className="duo wide">
        <Panel title="13F book by quarter" right={<span className="dim">reported value · change vs prior quarter</span>}>
          {book.options_value > 0 && hist.some((r) => r.long_value == null) && <div className="dim small">as filed, including options notional</div>}
          {hist.length > 1 ? <ValueHistory title={`${book.firm} 13F book by quarter`} data={hist.map((r) => ({ label: quarterLabel(r.quarter).replace(' 20', " '"), value: r.long_value ?? r.total_value }))} /> : <div className="dim empty">one quarter on file</div>}
        </Panel>
        <Panel title="sector mix">
          <SectorRows items={live} />
        </Panel>
      </div>
    </div>
  )
}
/** Weight last quarter vs now, as two bars on one scale. */
function WeightShift({ prev, now, max }: { prev: number; now: number; max: number }) {
  const w = (v: number) => `${Math.min(100, (v / max) * 100).toFixed(1)}%`
  return (
    <span className="shift" role="img" aria-label={`weight ${pct(prev)} last quarter, ${pct(now)} now`}>
      <i className="was" style={{ width: w(prev) }} />
      <i className={`now ${now >= prev ? 'up' : 'down'}`} style={{ width: w(now) }} />
    </span>
  )
}
/** A holding in the fund's own vehicle (its listed fund or holding company), e.g. PSUS for Pershing Square. */
const ownHolding = (b: Book, h: Holding) => {
  const own = new Set([...tokens(b.firm), ...tokens(b.name)])
  return tokens(h.display_name || h.issuer).some((w) => own.has(w))
}
function HoldingsGrid({ rows, own }: { rows: Holding[]; own?: (h: Holding) => boolean }) {
  const max = Math.max(...rows.map((r) => Math.max(r.weight, r.prev_weight ?? 0)))
  return (
    <Grid
      keyboard
      rank
      rows={rows}
      initial={['w', 'desc']}
      href={stockHref}
      cols={[
        { key: 't', label: 'ticker', render: (r) => <StockCell t={r.ticker} name={r.display_name || r.issuer} former={r.former} />, sort: (r) => r.ticker ?? '', width: '80px' },
        { key: 'n', label: 'company', link: true, hideSm: true, render: (r) => <span className="trunc">{r.display_name}{r.put_call ? <span className="badge">{r.put_call}</span> : null}{own?.(r) ? <span className="badge">own fund</span> : null}</span>, sort: (r) => r.display_name ?? '' },
        { key: 's', label: 'sector', hideSm: true, render: (r) => <Sector s={r.sector} />, sort: (r) => r.sector ?? '' },
        { key: 'w', label: '% of book', num: true, render: (r) => pct(r.weight), sort: (r) => r.weight },
        { key: 'ws', label: 'last qtr → now', hideSm: true, render: (r) => <WeightShift prev={r.prev_weight ?? 0} now={r.weight} max={max} />, title: 'weight last quarter (grey) and now' },
        { key: 'c', label: 'activity', render: (r) => <ChangeTag change={r.change} share_change={r.share_change} prev_shares={r.prev_shares} />, sort: (r) => r.share_change ?? 0 },
        { key: 'sh', label: 'shares', num: true, hideSm: true, render: (r) => num(r.shares), sort: (r) => r.shares },
        { key: 'p', label: 'reported price', num: true, hideSm: true, render: (r) => (r.shares && !r.put_call ? price(r.value / r.shares) : '—'), sort: (r) => (r.shares ? r.value / r.shares : 0) },
        { key: 'v', label: 'value', num: true, render: (r) => usd(r.value), sort: (r) => r.value },
      ]}
    />
  )
}
function MovesGrid({ rows }: { rows: Holding[] }) {
  return (
    <Grid
      keyboard
      rank
      rows={rows}
      href={stockHref}
      cols={[
        { key: 't', label: 'ticker', render: (r) => <StockCell t={r.ticker} name={r.display_name || r.issuer} former={r.former} />, width: '80px' },
        { key: 'n', label: 'company', link: true, render: (r) => <span className="trunc">{r.display_name}</span> },
        { key: 'c', label: 'activity', render: (r) => <ChangeTag change={r.change} share_change={r.share_change} prev_shares={r.prev_shares} /> },
        { key: 'sc', label: 'Δ shares', num: true, hideSm: true, render: (r) => <span className={(r.share_change ?? 0) > 0 ? 'pos' : 'neg'}>{(r.share_change ?? 0) > 0 ? '+' : ''}{num(r.share_change)}</span>, sort: (r) => r.share_change ?? 0 },
        { key: 'd', label: 'Δ value', num: true, render: (r) => <span className={(r.value_delta ?? 0) > 0 ? 'pos' : 'neg'}>{signedUsd(r.value_delta)}</span>, sort: (r) => r.value_delta ?? 0 },
        { key: 'pb', label: '% of book', num: true, render: (r) => pct(r.pct_of_book), sort: (r) => r.pct_of_book ?? 0, title: 'trade size as a share of the whole 13F book' },
        { key: 'w', label: 'weight now', num: true, hideSm: true, render: (r) => pct(r.weight), sort: (r) => r.weight },
      ]}
    />
  )
}

// ---------- flows ----------
type ATab = 'buyers' | 'buy$' | 'new' | 'sellers' | 'exits'
export function Flows() {
  title('flows: buys and sells')
  const books = useLoad(loadBooks, [])
  const [picked, setQ] = useState<string | null>(null)
  const [tab, setTab] = useState<ATab>('buyers')
  const sq = season().q
  const q = picked ?? ((books.data ?? []).filter((b) => b.quarter === sq).length >= 3 ? sq : 'latest')
  const quarters = useMemo(() => [...new Set((books.data ?? []).map((b) => b.quarter))].sort().reverse(), [books.data])
  // Flows are stock picks: ETFs, index and T-bill funds are left out.
  const rows = useMemo(() => (books.data ? aggregate(q === 'latest' ? books.data : books.data.filter((b) => b.quarter === q)).rows.filter((r) => !r.fund) : []), [books.data, q])
  if (books.error) return <Failed error={books.error} />
  if (!books.data) return <Loading what="reading every book" />
  const fundsN = q === 'latest' ? books.data.length : books.data.filter((b) => b.quarter === q).length
  const exits = (r: Agg) => r.sellers.filter((s) => s.change === 'exited').length
  let list: Agg[]
  if (tab === 'buyers') list = rows.filter((r) => r.buyers.length).sort((a, b) => b.buyers.length - a.buyers.length || b.buy - a.buy)
  else if (tab === 'buy$') list = rows.filter((r) => r.net !== 0).sort((a, b) => b.net - a.net)
  else if (tab === 'new') list = rows.filter((r) => r.newBuyers).sort((a, b) => b.newBuyers - a.newBuyers || b.buy - a.buy)
  else if (tab === 'sellers') list = rows.filter((r) => r.sellers.length).sort((a, b) => b.sellers.length - a.sellers.length || a.sell - b.sell)
  else list = rows.filter((r) => exits(r)).sort((a, b) => exits(b) - exits(a) || a.sell - b.sell)
  const isBuy = tab === 'buyers' || tab === 'buy$' || tab === 'new'
  const maxNet = Math.max(...list.slice(0, 100).map((r) => Math.abs(r.net)), 1)
  return (
    <div className="page">
      <h1>
        flows <span className="dim">· what the roster bought and sold, from each 13F against the fund’s prior quarter</span>
      </h1>
      <div className="filters" role="group" aria-label="quarter">
        <span className="dim">quarter</span>
        {['latest', ...quarters].map((x) => (
          <button key={x} className={q === x ? 'chip on' : 'chip'} aria-pressed={q === x} onClick={() => setQ(x)}>
            {x === 'latest' ? 'each fund’s latest' : quarterLabel(x)}
          </button>
        ))}
        <span className="dim">· {fundsN} funds</span>
      </div>
      <Tabs<ATab>
        value={tab}
        onChange={setTab}
        options={[
          ['buyers', 'most buyers'],
          ['buy$', 'net dollars'],
          ['new', 'new positions'],
          ['sellers', 'most sellers'],
          ['exits', 'sold out'],
        ]}
      />
      <Panel title={`${num(list.length)} stocks`} right={<span className="dim hide-sm">trade $ = share change × filed price; a price move alone counts as 0</span>}>
        <Grid
          keyboard
          rank
          limit={100}
          rows={list}
          href={stockHref}
          cols={[
            aggCols.ticker,
            { ...aggCols.name, hideSm: true },
            aggCols.sector,
            isBuy
              ? { key: 'b', label: tab === 'new' ? 'new' : 'buyers', num: true, render: (r) => <span className="pos">{tab === 'new' ? r.newBuyers : r.buyers.length}</span> }
              : { key: 's', label: tab === 'exits' ? 'sold out' : 'sellers', num: true, render: (r) => <span className="neg">{tab === 'exits' ? exits(r) : r.sellers.length}</span> },
            { key: 'w', label: isBuy ? 'who bought' : 'who sold', hideSm: true, render: (r) => <Who list={[...(isBuy ? r.buyers : r.sellers)].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))} /> },
            { key: 'bv', label: 'bought', num: true, hideSm: true, render: (r) => <span className="pos">{r.buy ? usd(r.buy) : '·'}</span>, sort: (r) => r.buy },
            { key: 'sv', label: 'sold', num: true, hideSm: true, render: (r) => <span className="neg">{r.sell ? usd(-r.sell) : '·'}</span>, sort: (r) => -r.sell },
            {
              key: 'nv',
              label: 'net',
              num: true,
              render: (r) => (
                <span className="netcell">
                  <span className="netbar" aria-hidden>
                    <i className={r.net >= 0 ? 'pos' : 'neg'} style={r.net >= 0 ? { left: '50%', width: `${(Math.abs(r.net) / maxNet) * 50}%` } : { right: '50%', width: `${(Math.abs(r.net) / maxNet) * 50}%` }} />
                  </span>
                  <span className={r.net >= 0 ? 'pos' : 'neg'}>{signedUsd(r.net)}</span>
                </span>
              ),
              sort: (r) => r.net,
            },
          ]}
        />
      </Panel>
    </div>
  )
}

// ---------- consensus ----------
type GTab = 'owners' | 'value' | 'conviction'
export function Consensus() {
  title('consensus: the roster’s combined stock book')
  const books = useLoad(loadBooks, [])
  const [tab, setTab] = useState<GTab>('owners')
  const [sector, setSector] = useState<string | null>(null)
  const agg = useMemo(() => (books.data ? aggregate(books.data) : null), [books.data])
  if (books.error) return <Failed error={books.error} />
  if (!agg || !books.data) return <Loading what="combining the books" />
  const n = books.data.length
  const base = sector ? agg.rows.filter((r) => r.sector === sector) : agg.rows
  const list = [...base].sort(tab === 'owners' ? (a, b) => b.holders.length - a.holders.length || b.value - a.value : tab === 'value' ? (a, b) => b.value - a.value : (a, b) => b.maxWeight - a.maxWeight)
  const mix = sectorMix(agg.rows)
  return (
    <div className="page">
      <h1>
        consensus <span className="dim">· the stocks in all {n} roster funds’ latest 13Fs, combined · {usd(agg.total)} in stocks (options and fund units excluded)</span>
      </h1>
      <Panel title="by sector" right={<span className="dim hide-sm">choose a sector to filter</span>}>
        <StackBar parts={mix.map((m) => ({ label: m.sector, value: m.value, color: SECTOR_COLOR[m.sector] ?? '#555' }))} />
        <div className="filters" role="group" aria-label="sector filter">
          <button className={!sector ? 'chip on' : 'chip'} aria-pressed={!sector} onClick={() => setSector(null)}>
            all sectors
          </button>
          {mix.map((m) => (
            <button key={m.sector} className={sector === m.sector ? 'chip on' : 'chip'} aria-pressed={sector === m.sector} onClick={() => setSector(m.sector)}>
              <i className="dot" style={{ background: SECTOR_COLOR[m.sector] }} aria-hidden />
              {m.sector} <span className="num">{pct(m.weight, 1)}</span>
            </button>
          ))}
        </div>
      </Panel>
      <Tabs<GTab>
        value={tab}
        onChange={setTab}
        options={[
          ['owners', 'most funds'],
          ['value', 'most dollars'],
          ['conviction', 'highest conviction'],
        ]}
      />
      <Panel title={`${num(list.length)} stocks`}>
        <Grid
          keyboard
          rank
          limit={150}
          rows={list}
          href={stockHref}
          cols={[
            aggCols.ticker,
            { ...aggCols.name, hideSm: true },
            aggCols.sector,
            { key: 'h', label: 'funds', num: true, render: (r) => r.holders.length, sort: (r) => r.holders.length },
            { key: 'hp', label: 'of roster', num: true, hideSm: true, render: (r) => <span className="wcell">{pct(r.holders.length / n, 0)}<Bar value={r.holders.length} max={n} /></span>, sort: (r) => r.holders.length },
            { key: 'v', label: 'held', num: true, render: (r) => usd(r.value), sort: (r) => r.value },
            { key: 'gw', label: '% combined', num: true, hideSm: true, render: (r) => pct(r.value / agg.total), sort: (r) => r.value },
            { key: 'mw', label: 'max weight', num: true, render: (r) => pct(r.maxWeight, 1), sort: (r) => r.maxWeight, title: 'largest weight in any one book' },
            { key: 'aw', label: 'avg weight', num: true, hideSm: true, render: (r) => pct(r.holders.reduce((s, h) => s + h.weight, 0) / Math.max(1, r.holders.length), 2), sort: (r) => r.holders.reduce((s, h) => s + h.weight, 0) / Math.max(1, r.holders.length) },
            { key: 'who', label: 'largest holders', hideSm: true, render: (r) => <Who list={[...r.holders].sort((a, b) => b.weight - a.weight)} max={2} /> },
          ]}
        />
      </Panel>
    </div>
  )
}

// ---------- filings: 13D/G and Form 4 ----------
type ETab = 'all' | '13dg' | 'f4' | 'market'
export function Filings() {
  title('13D, 13G and Form 4 filings')
  const ev = useLoad(loadEvents, [])
  const ins = useLoad(loadInsiders, [])
  const firms = useFirms()
  const [tab, setTab] = useState<ETab>('all')
  const [scope, setScope] = useState<'roster' | 'all'>('roster')
  const [own, setOwn] = useState(false)
  if (ev.error) return <Failed error={ev.error} />
  if (!ev.data) return <Loading />
  const scoped = ev.data.events.filter((e) => (scope === 'all' || inRoster(e.slug)) && (own || !ownVehicle(e)))
  let list = scoped
  if (tab === '13dg') list = list.filter((e) => e.kind !== 'form4')
  if (tab === 'f4') list = list.filter((e) => e.kind === 'form4')
  const market = ins.data
  return (
    <div className="page">
      <h1>
        filings <span className="dim">· Schedule 13D/13G and Form 4 filed by funds since their latest 13F · last {ev.data.window_days} days</span>
      </h1>
      <Tabs<ETab>
        value={tab}
        onChange={setTab}
        options={[
          ['all', 'all'],
          ['13dg', '13D / 13G'],
          ['f4', 'Form 4'],
          ['market', 'company insiders'],
        ]}
      />
      {tab !== 'market' ? (
        <>
          <div className="filters" role="group" aria-label="filters">
            <button className={scope === 'roster' ? 'chip on' : 'chip'} aria-pressed={scope === 'roster'} onClick={() => setScope('roster')}>
              roster funds
            </button>
            <button className={scope === 'all' ? 'chip on' : 'chip'} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
              all tracked funds
            </button>
            <button className={own ? 'chip on' : 'chip'} aria-pressed={own} onClick={() => setOwn(!own)}>
              include filings on their own funds
            </button>
          </div>
          <Panel title={`${list.length} filings`}>
            <Grid keyboard rows={list} limit={150} href={(e) => (e.ticker && !ownVehicle(e) ? `/s/${e.ticker}` : null)} cols={eventCols(firms)} />
          </Panel>
        </>
      ) : market && market.length ? (
        <Panel title="open-market insider trades · Form 4 codes P and S" right={<span className="dim hide-sm">officers, directors and 10% owners</span>}>
          <Grid<Insider>
            keyboard
            limit={200}
            rows={market}
            href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
            cols={[
              { key: 'f', label: 'filed', render: (r) => <span className="dim">{date(r.filing_date)}</span>, sort: (r) => r.filing_date },
              { key: 't', label: 'issuer', render: (r) => <StockCell t={r.ticker} name={issuerName(r.issuer)} /> },
              { key: 'o', label: 'insider', render: (r) => <span className="trunc">{r.owner}</span> },
              { key: 'r', label: 'role', hideSm: true, render: (r) => <span className="dim trunc">{r.relationship}</span> },
              { key: 'c', label: 'side', render: (r) => <span className={`tag ${r.code === 'P' ? 'pos' : 'neg'}`}>{r.code === 'P' ? 'BUY' : 'SELL'}</span>, sort: (r) => r.code },
              { key: 'p', label: 'price', num: true, hideSm: true, render: (r) => price(r.price) },
              { key: 'v', label: 'value', num: true, render: (r) => <span className={r.code === 'P' ? 'pos' : 'neg'}>{usd(r.value_usd)}</span>, sort: (r) => r.value_usd },
              {
                key: 's',
                label: <span className="sr">SEC filing</span>,
                render: (r) => (
                  <a href={r.url} target="_blank" rel="noreferrer" className="dim ext">
                    sec↗
                  </a>
                ),
              },
            ]}
          />
        </Panel>
      ) : (
        <Panel title="company insiders">
          <div className="empty dim">Every company’s open-market insider buys and sells (Form 4 codes P and S) is being built from EDGAR daily indexes. Until it lands, the other tabs cover Form 4 and 13D/G filed by funds.</div>
        </Panel>
      )}
    </div>
  )
}

// ---------- stock ----------
type STab = 'holders' | 'activity' | 'options' | 'filings'
export function Stock({ ticker }: { ticker: string }) {
  const s = useLoad(
    () =>
      loadStock(ticker).catch(async (e) => {
        const alias = (await loadStockIndex()).stocks.find((r) => r.a.includes(ticker))
        if (!alias) throw e
        return loadStock(alias.t)
      }),
    [ticker],
  )
  const ev = useLoad(loadEvents, [])
  const succ = useLoad(async () => {
    const m = new Map<string, Holding[]>()
    for (const f of roster.funds.filter((x) => x.filer_slug && x.filer_slug !== x.slug)) {
      const b = await loadBook(f.slug).catch(() => null)
      if (b) m.set(f.filer_slug, b.holdings)
    }
    return m
  }, [])
  const firms = useFirms()
  const [tab, setTab] = useState<STab>('holders')
  const [scope, setScope] = useState<'roster' | 'all'>('roster')
  title(`${ticker} fund ownership`)
  if (s.error) return <NotFound what={`no tracked fund reports ${ticker} in its latest 13F`} />
  if (!s.data) return <Loading what={`loading ${ticker}`} />
  const d = s.data
  // A successor filer's stock line compares against its own standalone prior 13F; the fund's book
  // (which combines the predecessor filer) carries the real quarter-on-quarter change.
  const cusips = new Set(d.classes.map((c) => c.cusip))
  const viaBook = (h: StockHolder): StockHolder => {
    const lines = succ.data?.get(h.slug)?.filter((x) => cusips.has(x.cusip) && !x.put_call)
    if (!lines?.length) return h
    const prev = lines.reduce((t, x) => t + (x.prev_shares ?? 0), 0)
    const delta = lines.reduce((t, x) => t + (x.value_delta ?? 0), 0)
    return { ...h, prev_shares: prev, delta_value: delta, change: h.shares > prev ? (prev ? 'added' : 'new') : h.shares < prev ? 'trimmed' : 'unchanged' }
  }
  const pick = (l: StockHolder[]) => (scope === 'roster' ? l.filter((h) => inRoster(h.slug)) : l).map(viaBook)
  const name = (h: StockHolder) => firmOf(firms, h.slug, h.firm || h.manager)
  const holders = pick(d.holders)
  const exited = pick(d.exited)
  const cnt = (c: string) => holders.filter((h) => h.change === c).length
  const nNew = cnt('new')
  const prevHolders = holders.length - nNew + exited.length
  const value = holders.reduce((x, h) => x + h.value, 0)
  const movers = [...holders, ...exited].filter((h) => h.change && h.change !== 'unchanged').sort((a, b) => Math.abs(b.delta_value ?? 0) - Math.abs(a.delta_value ?? 0))
  const tickers = new Set(d.classes.map((c) => c.ticker))
  const events = (ev.data?.events ?? []).filter((e) => e.ticker && tickers.has(e.ticker) && !ownVehicle(e))
  const scopeLabel = scope === 'roster' ? 'roster funds' : 'all tracked funds'
  const holderCols: Col<StockHolder>[] = [
    { key: 'm', label: 'fund', link: true, render: (h) => <span className={`trunc narrow-sm${inRoster(h.slug) ? ' strong' : ''}`}>{name(h)}</span>, sort: (h) => name(h) },
    { key: 'w', label: '% of book', num: true, render: (h) => pct(h.weight), sort: (h) => h.weight },
    { key: 'c', label: 'activity', render: (h) => <ChangeTag change={h.change} share_change={h.prev_shares != null ? h.shares - h.prev_shares : null} prev_shares={h.prev_shares} />, sort: (h) => h.delta_value ?? 0 },
    { key: 'sh', label: 'shares', num: true, hideSm: true, render: (h) => num(h.shares), sort: (h) => h.shares },
    { key: 'v', label: 'value', num: true, hideSm: true, render: (h) => usd(h.value), sort: (h) => h.value },
    { key: 'q', label: 'qtr', num: true, render: (h) => <span className="dim">{quarterLabel(h.quarter).replace(' 20', " '")}</span>, sort: (h) => h.quarter },
  ]
  const fundHref = (h: StockHolder) => (inRoster(h.slug) ? fundPath(fundSlug(h.slug)) : null)
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>
            <span className="tkh">{d.classes.length > 1 ? d.classes.map((c) => c.ticker).join('+') : d.ticker}</span> {issuerName(d.name)}
          </h1>
          <div className="dim">
            <Sector s={d.sector} /> {d.sector ?? 'Unclassified'} · {d.classes.map((c) => `${c.ticker} CUSIP ${c.cusip}`).join(' · ')}
          </div>
        </div>
        <Follow kind="stocks" id={d.ticker} />
      </div>
      <div className="filters" role="group" aria-label="scope">
        <span className="dim">counting</span>
        <button className={scope === 'roster' ? 'chip on' : 'chip'} aria-pressed={scope === 'roster'} onClick={() => setScope('roster')}>
          roster funds
        </button>
        <button className={scope === 'all' ? 'chip on' : 'chip'} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
          all {d.holders.length} tracked funds
        </button>
      </div>
      <div className="stats">
        <Stat label={`holders · ${scopeLabel}`} value={holders.length} sub={`${prevHolders} last quarter (${holders.length - prevHolders >= 0 ? '+' : ''}${holders.length - prevHolders})`} />
        <Stat label={`value held · ${scopeLabel}`} value={usd(value)} />
        <Stat label="new / added" value={`${nNew} / ${cnt('added')}`} tone={nNew + cnt('added') > 0 ? 'pos' : undefined} />
        <Stat label="trimmed / sold out" value={`${cnt('trimmed')} / ${exited.length}`} tone={cnt('trimmed') + exited.length > 0 ? 'neg' : undefined} />
      </div>
        <Panel title={`largest positions by % of book · ${scopeLabel}`}>
          {holders.length ? (
            <HBars title="largest holders by weight" fmt={(v) => pct(v, 1)} labelWidth={190} rows={[...holders].sort((a, b) => b.weight - a.weight).slice(0, 6).map((h) => ({ key: h.slug, href: fundHref(h), label: name(h), value: h.weight }))} />
          ) : (
            <div className="empty dim">no roster fund holds it; count all tracked funds</div>
          )}
        </Panel>
      <Tabs<STab>
        value={tab}
        onChange={setTab}
        options={[
          ['holders', `holders ${holders.length}`],
          ['activity', `activity ${movers.length}`],
          ['options', `options ${pick(d.options).length}`],
          ['filings', `13D/G·F4 ${events.length}`],
        ]}
      />
      <Panel title={tab}>
        {tab === 'holders' && <Grid keyboard rank rows={holders} initial={['w', 'desc']} href={fundHref} cols={holderCols} empty="no roster fund holds it; count all tracked funds" />}
        {tab === 'activity' && (
          <Grid
            keyboard
            rows={movers}
            href={fundHref}
            cols={[holderCols[0], holderCols[2], { key: 'd', label: 'Δ value', num: true, render: (h) => <span className={(h.delta_value ?? 0) >= 0 ? 'pos' : 'neg'}>{signedUsd(h.delta_value)}</span>, sort: (h) => h.delta_value ?? 0 }, holderCols[1], holderCols[5]]}
          />
        )}
        {tab === 'options' && (
          <Grid
            rows={pick(d.options)}
            href={fundHref}
            cols={[holderCols[0], { key: 'pc', label: 'type', render: (h) => <span className={`tag ${h.put_call === 'CALL' ? 'pos' : 'neg'}`}>{h.put_call}</span> }, { key: 'v', label: 'notional', num: true, render: (h) => usd(h.value), sort: (h) => h.value }, holderCols[1]]}
          />
        )}
        {tab === 'filings' && <Grid rows={events} cols={eventCols(firms)} empty="no Form 4 or 13D/G by tracked funds in the last 30 days" />}
      </Panel>
    </div>
  )
}

// ---------- alerts (paid) ----------
function sampleEmail(b: Book) {
  const fmt = (h: Holding) => {
    const tk = (h.ticker ?? '').padEnd(6)
    const nm = (h.display_name ?? '').slice(0, 22).padEnd(22)
    const d = signedUsd(h.value_delta).padStart(9)
    const ch = h.change === 'new' ? 'new' : h.change === 'exited' ? 'sold out' : h.prev_shares ? `${(((h.share_change ?? 0) / h.prev_shares) * 100).toFixed(0)}% shares` : ''
    return `  ${tk} ${nm} ${d}  ${ch}`
  }
  const buys = b.holdings.filter((h) => !h.put_call && (h.value_delta ?? 0) > 0).sort((a, c) => (c.value_delta ?? 0) - (a.value_delta ?? 0)).slice(0, 5)
  const sells = b.holdings.filter((h) => !h.put_call && (h.value_delta ?? 0) < 0).sort((a, c) => (a.value_delta ?? 0) - (c.value_delta ?? 0)).slice(0, 5)
  return [
    `Subject: ${b.firm} filed its ${quarterLabel(b.quarter)} 13F`,
    `From: Holdterm <holdterm@factordynamics.com>`,
    ``,
    `${b.firm.toUpperCase()} · 13F-HR · ${quarterLabel(b.quarter)}`,
    `filed ${b.filing_date} · book ${usd(b.long_value)} · ${b.long_count} positions`,
    ``,
    `TOP BUYS`,
    ...buys.map(fmt),
    ``,
    `TOP SELLS`,
    ...sells.map(fmt),
    ``,
    `  ${SITE}${fundPath(b.slug)}`,
    `  SEC filing ${b.accession}`,
    ``,
    `--`,
    `Manage alerts: ${SITE}/account/ · SEC EDGAR data, not investment advice.`,
  ].join('\n')
}
export function Alerts() {
  title('email alerts')
  const [yearly, setYearly] = useState(false)
  const sample = useLoad(() => loadBook('warren-buffett'), [])
  const link = yearly ? checkout.yearly : checkout.monthly
  return (
    <div className="page">
      <h1>
        alerts <span className="dim">· the one thing Holdterm sells; the site stays free with no ads</span>
      </h1>
      <div className="alerts-grid">
        <div className="alerts-side">
        <Panel title="holdterm alerts">
          <div className="price">
            <span className="big">${yearly ? PRICE.yearly : PRICE.monthly}</span>
            <span className="dim">/{yearly ? 'year' : 'month'}</span>
          </div>
          <div className="filters" role="group" aria-label="billing period">
            <button className={!yearly ? 'chip on' : 'chip'} aria-pressed={!yearly} onClick={() => setYearly(false)}>
              monthly ${PRICE.monthly}
            </button>
            <button className={yearly ? 'chip on' : 'chip'} aria-pressed={yearly} onClick={() => setYearly(true)}>
              yearly ${PRICE.yearly} <span className="pos">save {Math.round((1 - PRICE.yearly / (PRICE.monthly * 12)) * 100)}%</span>
            </button>
          </div>
          <a className="btn" href={link}>
            start the {PRICE.trialDays}-day free trial →
          </a>
          <p className="dim small">
            {PRICE.trialDays} days free, then ${PRICE.monthly}/month or ${PRICE.yearly}/year until you cancel. Cancel any time from your account. Checkout is by Stripe and billed by Factor Dynamics, which runs Holdterm. See the <A to="/terms">terms</A> and <A to="/privacy">privacy</A>.
          </p>
          <p className="small">
            Already subscribed? <A to="/account">sign in with your email →</A>
          </p>
        </Panel>
        <Panel title="what you get">
          <ul className="list">
            <li>
              <span className="acc">▸</span> an email within hours of a fund you follow filing its 13F, with the biggest buys, sells, new positions and sales
            </li>
            <li>
              <span className="acc">▸</span> 13D, 13G and Form 4 filings by those funds, and by any fund in stocks you follow
            </li>
            <li>
              <span className="acc">▸</span> follow nobody and you get every roster fund
            </li>
            <li>
              <span className="acc">▸</span> plain text with a link to the SEC filing; change what you follow any time
            </li>
          </ul>
        </Panel>
        </div>
        <Panel title="sample alert" right={<span className="dim">built from a real filing</span>} className="sample">
          {sample.data ? (
            <pre className="email">
              {sampleEmail(sample.data)}
              {'\n'}
              <a href={sample.data.sec_url} target="_blank" rel="noreferrer">
                open this filing on SEC EDGAR ↗
              </a>
            </pre>
          ) : (
            <Loading />
          )}
        </Panel>
      </div>
    </div>
  )
}

// ---------- account ----------
const when = (v: number | string | null | undefined) => {
  if (v == null) return ''
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
export function Account() {
  title('account')
  const [member, setMember, err] = useMember()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [f, setF] = useState<Follows | null>(null)
  const ix = useLoad(loadIndex, [])
  const [pending, setPending] = useState(() => /[?&](session_id|login)=/.test(location.search))
  const [welcome, setWelcome] = useState(false)
  useEffect(() => {
    startFromUrl().then((m) => {
      if (m) (setMember(m), setWelcome(true))
      setPending(false)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (member?.active) follows().then(setF).catch(() => {})
  }, [member])
  if (!api) return null
  if (pending) return <Loading what="signing you in" />
  if (!member)
    return (
      <div className="page narrow">
        <h1>account</h1>
        <Panel title="sign in">
          {err && <div className="neg">{err}</div>}
          {sent ? (
            <div>If {email} has an active plan, a sign-in link is on its way. It works for 7 days.</div>
          ) : (
            <form
              className="prompt-form"
              onSubmit={(e) => {
                e.preventDefault()
                requestLogin(email).finally(() => setSent(true))
              }}
            >
              <label htmlFor="email" className="sr">
                email
              </label>
              <span className="acc" aria-hidden>
                &gt;
              </span>
              <input id="email" type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn">email me a link</button>
            </form>
          )}
          <p className="dim small">
            No account yet? <A to="/alerts">start a {PRICE.trialDays}-day trial →</A> · <a href={checkout.portal}>manage or cancel billing on Stripe ↗</a>
          </p>
        </Panel>
      </div>
    )
  const ms = ix.data ? funds(ix.data) : []
  const on = new Set(f?.investors ?? [])
  const toggle = (slug: string) => setFollow('investors', slug, !on.has(slug)).then(setF, () => {})
  const ends = member.cancel_at_period_end || member.status === 'canceled'
  return (
    <div className="page narrow">
      <h1>account</h1>
      {welcome && (
        <Panel title="you're in">
          <p>
            Alerts are on. Follow nobody and you get every roster fund; or pick funds below, and use <span className="acc">+ follow</span> on any fund or stock page.
          </p>
        </Panel>
      )}
      <div className="stats">
        <Stat label="email" value={<span className="small">{member.email}</span>} />
        <Stat label="plan" value={member.active ? 'alerts' : member.status} tone={member.active ? 'pos' : 'neg'} sub={member.period_end ? `${ends ? 'ends' : member.status === 'trialing' ? 'trial ends' : 'renews'} ${when(member.period_end)}` : undefined} />
        <Stat label="following" value={on.size || 'all'} sub={on.size ? (on.size === 1 ? 'fund' : 'funds') : 'every roster fund'} />
      </div>
      <div className="filters">
        <button className="chip" onClick={() => openPortal()}>
          manage billing ↗
        </button>
        <button
          className="chip"
          onClick={() => {
            signOut()
            setMember(null)
          }}
        >
          sign out
        </button>
      </div>
      {member.active && (
        <>
          <Panel title="funds you get alerts for" right={<span className="dim">none selected = all</span>}>
            <div className="checks">
              {ms.map((m) => (
                <label key={m.slug} className={on.has(m.slug) ? 'on' : ''}>
                  <input type="checkbox" checked={on.has(m.slug)} onChange={() => toggle(m.slug)} />
                  {m.firm}
                </label>
              ))}
            </div>
          </Panel>
          <Panel title="stocks you follow" right={<span className="dim">13D/G and Form 4 by any tracked fund</span>}>
            <StockFollows f={f} setF={setF} />
          </Panel>
        </>
      )}
    </div>
  )
}
function StockFollows({ f, setF }: { f: Follows | null; setF: (f: Follows) => void }) {
  const [t, setT] = useState('')
  const list = f?.stocks ?? []
  return (
    <div>
      <div className="tks">
        {list.map((x) => (
          <span key={x} className="chip on">
            <Tick t={x} />
            <button className="linkish" aria-label={`unfollow ${x}`} onClick={() => setFollow('stocks', x, false).then(setF, () => {})}>
              ×
            </button>
          </span>
        ))}
        {!list.length && <span className="dim">none yet</span>}
      </div>
      <form
        className="prompt-form"
        onSubmit={(e) => {
          e.preventDefault()
          const v = t.trim().toUpperCase()
          if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(v) && !list.includes(v)) setFollow('stocks', v, true).then(setF, () => {})
          setT('')
        }}
      >
        <label htmlFor="tk" className="sr">
          add a ticker
        </label>
        <span className="acc" aria-hidden>
          +
        </span>
        <input id="tk" placeholder="ticker" value={t} onChange={(e) => setT(e.target.value)} />
      </form>
    </div>
  )
}

// ---------- about, terms, privacy ----------
export function About() {
  title('about')
  const r = roster.rule as Record<string, number>
  return (
    <div className="page narrow prose">
      <h1>about</h1>
      <Panel title="what this is">
        <p>Holdterm is a fast, keyboard-first reader for the SEC filings of concentrated, long-term investment managers: every fund’s 13F book, what changed this quarter, what the group owns in common, and the 13D, 13G and Form 4 filings between quarters.</p>
        <p>
          There are no ads. The site is free; the one paid product is <A to="/alerts">email alerts</A> at ${PRICE.monthly} a month. Holdterm is run by Factor Dynamics.
        </p>
      </Panel>
      <Panel title="who is on the roster" className="anchor">
        <span id="roster" />
        <p>
          Nobody is hand-picked. The starting universe is every 13F-HR filer in the SEC’s own quarterly{' '}
          <a href="https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets" target="_blank" rel="noreferrer">
            Form 13F data sets ↗
          </a>{' '}
          ({quarterLabel(qOf(roster.period))} filings, {num(roster.screened)} filers with a book of {usd(r.min_value, 0)} or more). Each is screened against one rule, and the roster is whoever passes:
        </p>
        <table className="grid rule">
          <tbody>
            <tr>
              <td>size</td>
              <td>13F book of at least {usd(r.min_value, 0)}</td>
            </tr>
            <tr>
              <td>focus</td>
              <td>
                {r.min_positions} to {r.max_positions} positions; the 10 largest at least {pct(r.min_top10, 0)} of the book; the largest at most {pct(r.max_top1, 0)}; ETFs and index funds at most {pct(r.max_etf, 0)}. T-bill and money-market funds count as cash and are left out of every test
              </td>
            </tr>
            <tr>
              <td>patience</td>
              <td>turnover of at most {pct(r.max_turnover, 0)} in the latest quarter: shares bought and sold, valued at the quarter’s filed prices, ÷ 2 ÷ book</td>
            </tr>
            <tr>
              <td>record</td>
              <td>a 13F for the same quarter {r.min_years} years earlier; a predecessor filer counts (Pershing Square Inc. carries Pershing Square Capital Management’s record, and their books are summed in a quarter where both filed)</td>
            </tr>
            <tr>
              <td>type</td>
              <td>
                investment managers, and companies whose 13F is a concentrated portfolio of outside stocks (Berkshire Hathaway, Icahn, Cincinnati Financial, Graham Holdings) are in. Out: banks, brokers, pensions, endowments and foundations; private-equity and venture sponsors and companies whose 13F lists strategic stakes; sector specialists (biotech, real estate, energy infrastructure); funds of ETFs. The {Object.keys(EXCLUSIONS).length} type exclusions are listed one by one, with the reason for each, in{' '}
                <a href={`${REPO}/blob/main/holdterm/scripts/roster-exclusions.json`} target="_blank" rel="noreferrer">
                  roster-exclusions.json ↗
                </a>
              </td>
            </tr>
            <tr>
              <td>stability</td>
              <td>a fund already on the roster stays until it misses a test by more than {pct(r.incumbent_buffer, 0)} of the threshold (turnover above {pct(r.max_turnover * (1 + r.incumbent_buffer), 0)}, for example), so the roster doesn’t churn on noise</td>
            </tr>
          </tbody>
        </table>
        <p className="dim small">
          {roster.funds.length + roster.pending.length} funds pass; {roster.funds.length} are live and {roster.pending.length ? `the other ${roster.pending.length} are loading` : 'none are pending'} (full list in universe.json, linked below). Closest misses:{' '}
          {roster.near_misses
            .slice(0, 8)
            .map((f) => `${firmName(f.slug ?? '', f.firm)} (${f.fails.join(', ')})`)
            .join(', ')}
          . The screen and its output are public:{' '}
          <a href={`${REPO}/blob/main/holdterm/scripts/screen.py`} target="_blank" rel="noreferrer">
            screen.py ↗
          </a>{' '}
          and{' '}
          <a href={`${REPO}/blob/main/holdterm/scripts/universe.json`} target="_blank" rel="noreferrer">
            universe.json ↗
          </a>
          . Reconstituted when the SEC publishes each quarter’s data set; roster as of {roster.generated_at.slice(0, 10)}.
        </p>
      </Panel>
      <Panel title="data">
        <ul className="list">
          <li>
            <span className="acc">▸</span> Form 13F-HR as filed on SEC EDGAR. Funds file up to 45 days after quarter end, so a 13F is a snapshot, not today’s book. It covers US-listed long positions and listed options only: no shorts, cash, bonds or foreign shares.
          </li>
          <li>
            <span className="acc">▸</span> Buys and sells are share changes against the fund’s previous 13F, valued at the price implied by the filing. A price move alone is not a trade.
          </li>
          <li>
            <span className="acc">▸</span> Schedule 13D and 13G (5%+ ownership) and Form 4 where a tracked fund is the filer. Filings on a fund’s own vehicles are labelled “own fund” and left out of feeds by default.
          </li>
          <li>
            <span className="acc">▸</span> No market prices: everything comes from SEC filings. Reported price is the filing’s value divided by its share count. Tickers come from CUSIP mapping, with a small sourced fallback file (src/tickers.json); a company that has left the exchange shows its former ticker with a †, and where no ticker exists we show the company name rather than guess.
          </li>
          <li>
            <span className="acc">▸</span> Funds are named by firm. A person is shown only when they run the portfolio today.
          </li>
        </ul>
      </Panel>
      <Panel title="contact and corrections">
        <p>
          Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> for anything: a wrong number, ticker or name (send the page link and we’ll check it against the SEC filing), billing, or deleting your data. You can also <a href={ISSUES}>open a GitHub issue ↗</a>. Manage or cancel a subscription in the <a href={checkout.portal}>Stripe billing portal ↗</a>.
        </p>
      </Panel>
      <Panel title="keys">
        <p>
          <kbd>/</kbd> search · <kbd>g</kbd> then <kbd>h</kbd> <kbd>f</kbd> <kbd>c</kbd> <kbd>m</kbd> <kbd>d</kbd> <kbd>e</kbd> to jump · <kbd>j</kbd>/<kbd>k</kbd> and <kbd>enter</kbd> in tables · <kbd>1</kbd>-<kbd>5</kbd> tabs · <kbd>?</kbd> help
        </p>
      </Panel>
      <Panel title="not advice">
        <p>Information only, not investment advice. Filings can be amended, late or wrong; check the linked SEC document before relying on a number.</p>
      </Panel>
    </div>
  )
}
export function Terms() {
  title('terms')
  return (
    <div className="page narrow prose">
      <h1>terms</h1>
      <Panel title="the short version">
        <ul className="list">
          <li><span className="acc">▸</span> Holdterm is operated by Factor Dynamics. By using the site or buying alerts you agree to these terms.</li>
          <li><span className="acc">▸</span> Everything here is information drawn from public SEC filings. It is not investment, tax or legal advice, and it is not a recommendation to buy or sell anything.</li>
          <li><span className="acc">▸</span> Filings can be late, amended or wrong, and our processing can introduce errors. The data is provided as is, without warranty. Check the linked SEC filing before relying on any number.</li>
          <li><span className="acc">▸</span> Alerts are a subscription: ${PRICE.monthly}/month or ${PRICE.yearly}/year after a {PRICE.trialDays}-day free trial, renewing until you cancel. Cancel any time in the billing portal; you keep access to the end of the period you paid for. Payments are processed by Stripe.</li>
          <li><span className="acc">▸</span> Alerts are sent on a best-effort basis; delivery can be delayed or missed. Our liability is limited to the fees you paid in the last 12 months.</li>
          <li><span className="acc">▸</span> Don’t resell or bulk-redistribute Holdterm’s pages or emails. The underlying SEC filings are public.</li>
          <li><span className="acc">▸</span> We may change these terms; material changes to paid plans are emailed to subscribers first.</li>
        </ul>
      </Panel>
      <Panel title="contact">
        <p>
          Questions or corrections: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>, or <a href={ISSUES}>open an issue on GitHub ↗</a>.
        </p>
      </Panel>
    </div>
  )
}
export function Privacy() {
  title('privacy')
  return (
    <div className="page narrow prose">
      <h1>privacy</h1>
      <Panel title="what we keep">
        <ul className="list">
          <li><span className="acc">▸</span> Browsing is anonymous: no accounts, ads, tracking pixels or third-party analytics on the public pages.</li>
          <li><span className="acc">▸</span> If you buy alerts we keep your email, your Stripe customer and subscription ids, and the funds and stocks you follow. That is all we need to send alerts.</li>
          <li><span className="acc">▸</span> Card details go to Stripe and never reach us. Emails are sent through Resend.</li>
          <li><span className="acc">▸</span> Signing in stores a session token in your browser’s local storage. No other cookies.</li>
          <li><span className="acc">▸</span> We don’t sell or share your data. Cancel in the billing portal and email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> to ask for deletion, and we delete your record.</li>
          <li><span className="acc">▸</span> Contact: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.</li>
        </ul>
      </Panel>
    </div>
  )
}

export function NotFound({ what = 'no such page' }: { what?: string }) {
  title('not found')
  return (
    <div className="page narrow">
      <h1 className="neg">404</h1>
      <Panel title="error">
        <p>{what}.</p>
        <p>
          <A to="/">home</A> · press <kbd>/</kbd> to search
        </p>
      </Panel>
    </div>
  )
}

export type { Index, Manager }
