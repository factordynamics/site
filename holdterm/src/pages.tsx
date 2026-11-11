import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, channels, checkout, price as PRICE, SITE } from './config'
import { AppIcon, ChatPreviews, EmailPreview, InboxPreview, loadLatestTitle, loadSamples, PushPreview, SampleSources } from './alert-previews'
import {
  aggregate,
  classOrder,
  funds,
  badValue,
  inRoster,
  isStale,
  loadBook,
  loadBooks,
  loadBooksAfterIndex,
  loadEvents,
  loadFundEvents,
  loadHistory,
  loadIndex,
  loadInsiders,
  loadStock,
  loadStockIndex,
  isFundLike,
  issuerKey,
  isNoteOrPref,
  isStockLine,
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
import { A, AsFiled, Bar, Filed, BooksProgress, cap, ChangeTag, date, day, daysAgo, Empty, Failed, Grid, Loading, PageLoading, num, Panel, pct, price, signedUsd, StackBar, Stat, TabPanel, Tabs, TabsSkel, Tick, type SkelCol, usd, useLoad, type Col } from './lib'
import { HBars, ValueHistory } from './charts'
import { firmName, fundPath, issuerName, shortFirm } from './names'
import EXCLUSIONS from '../scripts/roster-exclusions.json'
import { follows, Follow, getToken, useMember, startFromUrl, requestLogin, setFollow, openPortal, signOut, UNAVAILABLE, type Follows, type Member } from './account'

/** Sets the page's title and canonical. A missing page asks not to be indexed and has no canonical; a real page
 * opened from the static 404 shell (a lowercase ticker, a link followed from a 404) drops the shell's noindex. */
const title = (t: string, missing = false) => {
  document.title = `${t} · Holdterm`
  const url = SITE + (location.pathname.replace(/\/+$/, '') || '/')
  const robots = document.querySelector('meta[name=robots]')
  if (missing) {
    if (!robots) document.head.append(Object.assign(document.createElement('meta'), { name: 'robots', content: 'noindex' }))
    document.querySelector('link[rel=canonical]')?.remove()
    return
  }
  robots?.remove()
  if (!document.querySelector('link[rel=canonical]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'canonical' }))
  document.querySelector('link[rel=canonical]')?.setAttribute('href', url)
  document.querySelector('meta[property="og:url"]')?.setAttribute('content', url)
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', `${t} · Holdterm`)
}
/** The data host answered "no such file" (or the data checks hold the fund back), unlike a failed request. */
const missing = (e: string) => /^(404|403|held:)/.test(e)
/** Where a fund or stock page sits: its section, then the page itself. */
function Crumbs({ parent, here }: { parent: [string, string]; here: string }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <A to={parent[0]}>{parent[1]}</A>
      <span aria-hidden> › </span>
      <span aria-current="page">{here}</span>
    </nav>
  )
}
export const REPO = 'https://github.com/factordynamics/site'
export const CONTACT = 'hello@factordynamics.com'
/** "Report a data error": an email with the page's address filled in, so no account is needed. */
export const reportError = (path: string) =>
  `mailto:${CONTACT}?subject=${encodeURIComponent('Holdterm data error')}&body=${encodeURIComponent(`Page: ${SITE.replace(/\/$/, '')}${path}\n\nWhat looks wrong:\n`)}`
const qOf = (period: string) => {
  // "30-JUN-2026" -> "2026Q2"
  const m = ['MAR', 'JUN', 'SEP', 'DEC'].indexOf(period.slice(3, 6))
  return `${period.slice(7)}Q${m + 1}`
}

// ---------- fund names and links ----------
/** Roster fund slug for any filer slug (a successor filer links to the fund it files for). */
const fundSlug = (slug: string) => roster.funds.find((f) => f.filer_slug === slug)?.slug ?? slug
/** Display names of the investors by slug, from the index. `wait` holds the download back until the page's own
 * data has arrived, so the large index doesn't slow the page down (names fall back to the bundled roster meanwhile). */
function useFirms(wait = false): Map<string, string> {
  const ix = useLoad(() => (wait ? Promise.resolve(null) : loadIndex()), [wait])
  return useMemo(() => new Map((ix.data?.managers ?? []).map((m) => [m.slug, m.firm])), [ix.data])
}
const firmOf = (firms: Map<string, string>, slug: string, fallback: string) => firms.get(fundSlug(slug)) ?? firmName(slug, fallback)
function FundLink({ slug, name }: { slug: string; name: ReactNode }) {
  return inRoster(slug) ? <A to={fundPath(fundSlug(slug))}>{name}</A> : <span>{name}</span>
}

// ---------- shared bits ----------
/** A firm in a dense table: its short name ("Lingotto"), wrapping to a second line rather than cut off. */
function Firm({ name, strong }: { name: string; strong?: boolean }) {
  const short = shortFirm(name)
  return (
    <span className={`firm${strong ? ' strong' : ''}`} title={short !== name ? name : undefined}>
      {short}
    </span>
  )
}
function Sector({ s, full }: { s?: string | null; full?: boolean }) {
  const k = s || 'Unclassified'
  const short = SECTOR_SHORT[k] ?? 'Other'
  return (
    <span className="sector" title={k}>
      <i style={{ background: SECTOR_COLOR[k] ?? '#bab0ac' }} aria-hidden />
      {full && short !== k ? (
        <>
          <span className="hide-sm">{k}</span>
          <span className="show-sm">{short}</span>
        </>
      ) : (
        short
      )}
    </span>
  )
}
function Who({ list, max = 3, tagQ }: { list: { slug: string; manager: string; quarter?: string }[]; max?: number; tagQ?: string }) {
  return (
    <span className="who">
      {list.slice(0, max).map((w, i) => (
        <span key={w.slug}>
          {i > 0 && <span className="dim">, </span>}
          <A to={fundPath(w.slug)} title={shortFirm(w.manager) !== w.manager ? w.manager : undefined}>
            {shortFirm(w.manager)}
          </A>
          {tagQ && w.quarter === tagQ && (
            <>
              {' '}
              <span className="qtag" title={`from the ${quarterLabel(tagQ)} 13F`}>{tagQ.slice(4)}</span>
            </>
          )}
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
  // Phones hide the Company column, so the ticker cell carries the company name on a second line.
  ticker: {
    key: 'ticker',
    label: 'Ticker',
    render: (r: Agg) => (
      <>
        <StockCell t={r.ticker} name={r.name} former={r.former} label={r.label} />
        {/* Phones show one ticker for combined share classes (GOOGL), so the second line says the others are in it. */}
        {r.ticker && <span className="row-sub stock-sub show-sm">{r.label?.includes('+') ? `${r.name}, ${r.label.split('+').length === 2 ? 'both' : 'all'} classes` : r.name}</span>}
      </>
    ),
    sort: (r: Agg) => r.ticker ?? r.name, width: '80px' } as Col<Agg>,
  name: { key: 'name', label: 'Company', link: true, render: (r: Agg) => <span className="trunc">{r.name}</span>, sort: (r: Agg) => r.name } as Col<Agg>,
  sector: { key: 'sector', label: 'Sector', hideSm: true, hide: 'lg', render: (r: Agg) => <Sector s={r.sector} />, sort: (r: Agg) => r.sector } as Col<Agg>,
}
/** A column heading with a shorter form on phones, where every pixel goes to the company name. */
const sm = (full: string, short: string) => (
  <>
    <span className="hide-sm">{full}</span>
    <span className="show-sm">{short}</span>
  </>
)
const stockHref = (r: { ticker: string | null }) => (r.ticker ? `/s/${encodeURIComponent(r.ticker)}` : null)

function SectorRows({ items }: { items: { sector?: string | null; value: number }[] }) {
  const mix = sectorMix(items)
  const max = mix[0]?.weight ?? 1
  return (
    <table className="grid sector-rows">
      <caption className="sr">Share of the portfolio by sector</caption>
      <tbody>
        {mix.map((m) => (
          <tr key={m.sector}>
            <td>
              <Sector s={m.sector} full />
            </td>
            <td className="num">{pct(m.weight, 1)}</td>
            <td className="barcell">
              <span className="bar wide" aria-hidden>
                <span className="fill" style={{ width: `${((m.weight / max) * 100).toFixed(1)}%`, background: SECTOR_COLOR[m.sector] ?? '#bab0ac' }} />
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
  buy: ['Bought', 'pos'],
  sell: ['Sold', 'neg'],
  mixed: ['Mixed', ''],
  other: ['Not a trade', 'dim'],
  new_stake: ['New 5%+ stake', 'pos'],
  stake_update: ['Stake update', ''],
  below_threshold: ['Sold below 5%', 'neg'],
}
const OTHER_WHY = 'Form 4 with no open-market purchase or sale: a gift, award, conversion, distribution or a holdings report'
function ActionTag({ e }: { e: Event }) {
  // A stake update with the investor's previous stake gives the old figure. Whether it bought or sold comes from the
  // share counts, not the percentage: a percentage also moves when the company issues or buys back shares.
  const was = e.action === 'stake_update' && e.prev_percent != null ? stakePct(e.prev_percent) : null
  const dir = was && e.prev_shares != null && e.shares_after != null && e.shares_after !== e.prev_shares ? (e.shares_after > e.prev_shares ? 'pos' : 'neg') : ''
  const same = was && !dir && e.prev_shares != null && e.shares_after === e.prev_shares
  const [label, tone] = was ? [dir === 'pos' ? `Bought, was ${was}` : dir === 'neg' ? `Sold, was ${was}` : same ? `Same shares, was ${was}` : `Was ${was}`, dir] : (ACTION[e.action] ?? [e.action, ''])
  const why = was && !dir ? (same ? 'Same number of shares: the percentage moved because the company’s share count changed' : undefined) : e.action === 'other' ? OTHER_WHY : undefined
  // Phones get the short form of the two long labels, so the action column fits. "Same shares, was 70.8%" is
  // too wide for it up to 1100px, so tablets get "Was 70.8%" too; the tooltip says why.
  const short = label === ACTION[e.action]?.[0] ? { new_stake: 'New 5%+', stake_update: 'Update' }[e.action as string] : same ? `Was ${was}` : undefined
  return (
    <span className={`tag ${tone}`} title={why}>
      {short ? (
        <>
          <span className={same ? 'tag-wide' : 'hide-sm'}>{label}</span>
          <span className={same ? 'tag-narrow' : 'show-sm'}>{short}</span>
        </>
      ) : (
        label
      )}
    </span>
  )
}
/** What each filing's tag means, folded away under one line so it costs a row, not a screen. */
function TagKey() {
  const rows: [string, string, string][] = [
    ['New 5%+ stake', 'pos', 'A first 13D or 13G on the company: the investor now owns 5% or more.'],
    ['Stake update', '', 'A later 13D or 13G. “Bought, was 6.1%” or “Sold, was 10.6%” compares it with the investor’s previous one.'],
    ['Sold below 5%', 'neg', 'The investor now owns less than 5%, so it stops filing 13Ds or 13Gs on the company.'],
    ['Bought', 'pos', 'A Form 4: the investor, an insider of the company, bought shares on the open market.'],
    ['Sold', 'neg', 'A Form 4 open-market sale.'],
    ['Not a trade', 'dim', 'A Form 4 with no open-market trade: a gift, an award, a conversion or a holdings report.'],
  ]
  return (
    <details className="tag-key">
      <summary>What the tags mean</summary>
      <dl>
        {rows.map(([t, tone, d]) => (
          <div key={t}>
            <dt>
              <span className={`tag ${tone}`}>{t}</span>
            </dt>
            <dd>{d}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
const stakePct = (p: number) => `${p.toFixed(p < 10 ? 2 : 1)}%`
const eventCols = (firms: Map<string, string>, withWho = true): Col<Event>[] => [
  // With an Investor column, phones show the date under the investor's name, so the company gets the width.
  { key: 'filed', label: 'Filed', hideSm: withWho, render: (e) => <span className="dim num">{date(e.filing_date)}</span>, sort: (e) => e.filing_date, width: '84px' },
  { key: 'form', label: 'Form', hideSm: true, render: (e) => <span className="form">{FORM[e.kind]}</span>, sort: (e) => e.kind },
  ...(withWho ? [{ key: 'who', label: 'Investor', render: (e: Event) => (
          <>
            <FundLink slug={e.slug} name={<Firm name={firmOf(firms, e.slug, e.manager)} />} />
            <span className="row-sub stock-sub show-sm">Filed {date(e.filing_date)}</span>
          </>
        ), sort: (e: Event) => e.manager } as Col<Event>] : []),
  {
    key: 'iss',
    label: 'Company',
    render: (e) => (
      <>
        <span className="iss">
          <StockCell t={ownVehicle(e) ? null : e.ticker} name={issuerName(e.display_name || e.issuer)} former={ownVehicle(e) ? undefined : e.former} />
          {ownVehicle(e) && <span className="badge">own fund</span>}
        </span>
        {/* Phones hide the Stake, Value and Form columns: the company's name and the filing's key figure go on second lines. */}
        {e.ticker && !ownVehicle(e) && <span className="row-sub stock-sub show-sm">{issuerName(e.display_name || e.issuer)}</span>}
      </>
    ),
  },
  {
    key: 'act',
    label: 'What happened',
    render: (e) => {
      const fig = e.value_usd != null && (e.action === 'buy' || e.action === 'sell') ? usd(e.value_usd) : e.action === 'below_threshold' ? 'Now under 5%' : e.percent_of_class != null && e.kind !== 'form4' ? `Owns ${stakePct(e.percent_of_class)}` : null
      return (
        <>
          <ActionTag e={e} />
          {fig && <span className="row-sub stock-sub show-sm">{fig}</span>}
        </>
      )
    },
    sort: (e) => e.action,
  },
  { key: 'pc', label: 'Stake', num: true, hideSm: true, title: 'Share of the company owned after the filing', render: (e) => (e.percent_of_class != null ? stakePct(e.percent_of_class) : <span className="dim">—</span>), sort: (e) => e.percent_of_class ?? -1 },
  { key: 'val', label: 'Value', num: true, hideSm: true, render: (e) => (e.value_usd != null ? <span className={e.action === 'sell' ? 'neg' : e.action === 'buy' ? 'pos' : ''}>{usd(e.value_usd)}</span> : <span className="dim">—</span>), sort: (e) => e.value_usd ?? -1 },
  { key: 'sa', label: 'Shares now', num: true, hideSm: true, hide: 'lg', title: 'Shares owned after the filing', render: (e) => num(e.shares_after), sort: (e) => e.shares_after ?? -1 },
  {
    key: 'sec',
    label: <span className="sr">SEC filing</span>,
    hideSm: true,
    hide: 'md',
    render: (e) => (
      <a href={e.url} target="_blank" rel="noreferrer" className="ext" aria-label={`View SEC filing ${e.id}`}>
        View filing ↗
      </a>
    ),
  },
]

// ---------- filing season ----------
const iso = (d: Date) => d.toISOString().slice(0, 10)
/** US federal holidays as observed (Saturday ones on the Friday, Sunday ones on the Monday): EDGAR's closed days. */
function holidays(y: number) {
  const nth = (m: number, wd: number, n: number) => {
    const d = new Date(Date.UTC(y, m, 1))
    d.setUTCDate(1 + ((wd - d.getUTCDay() + 7) % 7) + 7 * (n - 1))
    return d
  }
  const last = (m: number, wd: number) => {
    const d = new Date(Date.UTC(y, m + 1, 0))
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - wd + 7) % 7))
    return d
  }
  const fixed = [[0, 1], [5, 19], [6, 4], [10, 11], [11, 25]].map(([m, d]) => {
    const x = new Date(Date.UTC(y, m, d))
    x.setUTCDate(d + (x.getUTCDay() === 6 ? -1 : x.getUTCDay() === 0 ? 1 : 0))
    return x
  })
  return new Set([...fixed, nth(0, 1, 3), nth(1, 1, 3), last(4, 1), nth(8, 1, 1), nth(9, 1, 2), nth(10, 4, 4)].map(iso))
}
/** A quarter's 13F deadline: 45 days after the quarter ends, moved to the next business day when that is a weekend
 * or a federal holiday (Q4 2026: Feb 14, 2027 is a Sunday and Feb 15 is Presidents' Day, so Feb 16). */
export function dueFor(q: string) {
  const y = Number(q.slice(0, 4))
  const end = new Date(Date.UTC(y, Number(q.slice(5)) * 3, 0))
  const due = new Date(end.getTime() + 45 * 86_400_000)
  while (due.getUTCDay() === 0 || due.getUTCDay() === 6 || holidays(due.getUTCFullYear()).has(iso(due))) due.setUTCDate(due.getUTCDate() + 1)
  return { end: iso(end), due: iso(due) }
}
/** The 13F season in progress: the quarter that most recently ended, and its deadline. */
function season(now = new Date()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const qEndMonth = Math.floor(m / 3) * 3 - 1 // last month of the previous quarter
  const end = new Date(Date.UTC(y, qEndMonth + 1, 0))
  const q = `${end.getUTCFullYear()}Q${Math.floor(end.getUTCMonth() / 3) + 1}`
  return { q, ...dueFor(q) }
}
/** Days from today in New York, where the SEC's filing day runs, to a date: 0 on the day itself, negative after it. */
const daysUntil = (d: string) => Math.round((Date.parse(d) - Date.parse(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()))) / 86_400_000)
/** The quarter after another: 2026Q4 -> 2027Q1. */
const nextQ = (q: string) => (q.endsWith('4') ? `${Number(q.slice(0, 4)) + 1}Q1` : `${q.slice(0, 5)}${Number(q.slice(5)) + 1}`)

// ---------- home ----------
/** Each fund's latest book for the funds that filed in a given quarter. */
const loadQuarterBooks = (slugs: string[]) => Promise.all(slugs.map((x) => loadBook(x).catch(() => null))).then((bs) => bs.filter((b): b is Book => Boolean(b)))
const moveLabel = (h: Holding) => (h.change === 'new' ? 'New' : h.change === 'exited' ? 'Sold out' : h.change === 'added' ? 'Added' : 'Trimmed')
// ---------- alerts upsell ----------
// One closable line above the home page. Shown to signed-out visitors only; a dismissal is kept for 90 days,
// so it comes back at most once a 13F season. It is decided before the first paint (no layout shift).
const UPSELL_KEY = 'holdterm-upsell-dismissed'
const UPSELL_DAYS = 90
function showUpsell() {
  if (getToken()) return false
  try {
    const at = Number(localStorage.getItem(UPSELL_KEY))
    return !at || Date.now() - at > UPSELL_DAYS * 86_400_000
  } catch {
    return true
  }
}
function Upsell() {
  const [open, setOpen] = useState(showUpsell)
  if (!open) return null
  const close = () => {
    try {
      localStorage.setItem(UPSELL_KEY, String(Date.now()))
    } catch {}
    setOpen(false)
    // The focused close button is gone: hand focus to the page rather than dropping it on <body>.
    document.querySelector<HTMLElement>('main')?.focus()
  }
  return (
    <section className="upsell" aria-label="email alerts offer" onKeyDown={(e) => e.key === 'Escape' && close()}>
      <span className="upsell-tag" aria-hidden>
        Alerts
      </span>
      <UpsellNote />
      <p>
        <span className="hide-sm">Get an alert like this when the funds you follow file a 13F, 13D or Form 4. </span>
        <span className="show-sm">Email alerts on your funds’ filings. </span>
        <span className="upsell-price">{PRICE.trialDays} days free, then ${PRICE.monthly}/mo.</span>
      </p>
      <A to="/alerts" className="btn">
        Start free trial<span className="hide-sm"> →</span>
      </A>
      <button type="button" className="upsell-x" aria-label="dismiss alerts offer" title="dismiss" onClick={close}>
        <span aria-hidden>×</span>
      </button>
    </section>
  )
}

/** A real recent alert, drawn as a notification inside the offer (wide screens only; its box is a fixed size, so
 * nothing moves when the text arrives). */
function UpsellNote() {
  const r = useLoad(loadLatestTitle, [])
  return (
    <span className="upsell-note" aria-hidden={!r.data}>
      <AppIcon size={22} />
      <span className="upsell-note-text">
        <span className="upsell-note-top">
          Holdterm{r.data && <span className="dim"> · {day(r.data.date)}</span>}
        </span>
        <span className="upsell-note-title">{r.data ? <><span className="sr">Example alert: </span>{r.data.title}</> : '\u00a0'}</span>
      </span>
    </span>
  )
}

/** One promo above the filings per visit: the guide on a first visit, the alerts offer after that (or whichever
 * is still open). Chosen once per visit, so dismissing one never reveals the other. */
function pickPromo(): 'guide' | 'upsell' | '' {
  try {
    let first = sessionStorage.getItem('holdterm-first-visit')
    if (first == null) {
      const n = Number(localStorage.getItem('holdterm-visits') || 0) + 1
      localStorage.setItem('holdterm-visits', String(n))
      first = n === 1 ? '1' : '0'
      sessionStorage.setItem('holdterm-first-visit', first)
    }
    // Kept for the whole visit, so dismissing the guide doesn't bring the offer back on the next page load.
    const kept = sessionStorage.getItem('holdterm-promo')
    if (kept != null) return kept as 'guide' | 'upsell' | ''
    const guide = !localStorage.getItem(GUIDE_KEY)
    const upsell = showUpsell()
    const pick = guide && upsell ? (first === '1' ? 'guide' : 'upsell') : ''
    sessionStorage.setItem('holdterm-promo', pick)
    return pick
  } catch {
    return ''
  }
}
export function Home() {
  const [promo] = useState(pickPromo)
  return (
    <div className={promo ? `promo-${promo}` : undefined}>
      <Upsell />
      <div className="intro">
        <div>
          <h1>What long-term investors are buying and selling</h1>
          <p>
            <span className="hide-sm">See what {roster.funds.length} concentrated, long-term investors own, buy and sell, from the reports they file with the SEC. Updated within hours of each filing.</span>
            {/* Phones: the same promise in one short line, so a first-time visitor knows what the site is. */}
            <span className="show-sm">What {roster.funds.length} long-term investors own, buy and sell, from their SEC filings.</span>
          </p>
        </div>
        <HomeSearch />
      </div>
      <FirstVisit />
      <HomeBody />
    </div>
  )
}
/** The site search, front and centre on the home page, with a few common starting points. */
const STARTS: [string, string][] = [
  ['Berkshire Hathaway', '/m/berkshire-hathaway'],
  ['Pershing Square', '/m/pershing-square'],
  ['Apple', '/s/AAPL'],
  ['NVIDIA', '/s/NVDA'],
]
/** A search field that opens the site search, with `q` already typed when given. */
function SearchBox({ q = '', label = 'Find an investor or a stock' }: { q?: string; label?: string }) {
  return (
    <button type="button" className="home-search-box" onClick={() => window.dispatchEvent(new CustomEvent('holdterm:search', { detail: q }))}>
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span>{label}</span>
    </button>
  )
}
function HomeSearch() {
  return (
    <div className="home-search">
      <SearchBox />
      <div className="home-starts">
        <span className="dim">Popular:</span>
        {STARTS.map(([label, to]) => (
          <A key={to} to={to}>
            {label}
          </A>
        ))}
      </div>
    </div>
  )
}
function HomeBody() {
  title('What long-term investors buy and sell')
  const ix = useLoad(loadIndex, [])
  const ev = useLoad(loadEvents, [])
  const firms = useFirms()
  const ms = useMemo(() => (ix.data ? funds(ix.data) : []), [ix.data])
  const s = season()
  const seasonFiled = ms.filter((m) => m.quarter === s.q)
  // Before three funds have filed this season, lead with the previous quarter's filings instead.
  const lead = leadQuarter(ms.map((m) => m.quarter))
  // Every fund's latest 13F, newest first; the trades panel uses the lead quarter only.
  const filers = useMemo(() => [...ms].sort((a, b) => b.filing_date.localeCompare(a.filing_date) || b.total_value - a.total_value).slice(0, 15), [ms])
  const need = useMemo(() => [...new Set([...filers, ...ms.filter((m) => m.quarter === lead)].map((m) => m.slug))], [filers, ms, lead])
  const books = useLoad(() => (need.length ? loadQuarterBooks(need) : Promise.resolve([] as Book[])), [need.join()])
  if (ix.error) return <Failed error={ix.error} what="the latest filings" />
  if (!ix.data) return <Loading what="Loading the latest filings" rows={15} />
  const bySlug = new Map((books.data ?? []).map((b) => [b.slug, b]))
  // One trade per company per fund: share classes (GOOGL and GOOG) are combined.
  const trades = (b: Book) => {
    const by = new Map<string, Holding & { label?: string }>()
    for (const h of b.holdings) {
      if (!isStockLine(h) || !h.value_delta || isFundLike(h)) continue
      const k = issuerKey(h)
      const cur = by.get(k)
      if (!cur) by.set(k, { ...h, label: h.ticker ?? undefined })
      else {
        const label = [...new Set([...(cur.label?.split('+') ?? []), h.ticker].filter(Boolean))].join('+')
        if (Math.abs(h.value) > Math.abs(cur.value)) Object.assign(cur, { ticker: h.ticker, former: h.former, display_name: h.display_name, cusip: h.cusip })
        cur.label = label
        cur.value_delta = (cur.value_delta ?? 0) + h.value_delta
        cur.value += h.value
        if (cur.change !== h.change) cur.change = cur.value_delta > 0 ? (cur.change === 'new' && h.change === 'new' ? 'new' : 'added') : cur.value > 0 ? 'trimmed' : 'exited'
      }
    }
    // Classes in the site-wide order, main class first, as on every other page (classOrder).
    for (const h of by.values()) if (h.label?.includes('+')) [h.ticker] = (h.label = classOrder(h.label.split('+')).join('+')).split('+')
    return [...by.values()]
  }
  const biggest = (b: Book) => [...trades(b)].sort((x, y) => Math.abs(y.value_delta!) - Math.abs(x.value_delta!))[0]
  const moves = (books.data ?? [])
    .filter((b) => b.quarter === lead)
    .flatMap((b) => trades(b).map((h) => ({ b, h })))
    .sort((x, y) => Math.abs(y.h.value_delta!) - Math.abs(x.h.value_delta!))
    // At most four per fund (enough for a fund's sell-outs), so one early filer can't fill the list.
    .filter((x, _, all) => all.filter((y) => y.b.slug === x.b.slug).indexOf(x) < 4)
    .slice(0, 10)
  // The quarter so far in plain words. Counted only once every filed book has loaded, so the numbers never change on screen.
  const leadBooks = (books.data ?? []).filter((b) => b.quarter === lead)
  // Most bought and most sold come from the same function and the same rows as Buys & sells' quarter view.
  const picks = crowdPicks(books.data ? aggregate(leadBooks, books.data).rows : [], leadBooks.length)
  const due = ms.filter((m) => m.quarter !== s.q)
  const daysLeft = daysUntil(s.due)
  const events = (ev.data?.events ?? []).filter((e) => inRoster(e.slug) && !ownVehicle(e))
  // Highest conviction from each fund's largest positions (index), share classes combined per fund.
  const conv = new Map<string, { key: string; ticker: string | null; label?: string; former?: string; name: string; slug: string; firm: string; weight: number }>()
  for (const m of ms)
    for (const h of m.top ?? []) {
      if (!isStockLine(h) || isFundLike(h) || !h.cusip) continue
      const k = issuerKey(h)
      const id = `${k}|${m.slug}`
      const cur = conv.get(id)
      if (cur) {
        cur.weight += h.weight
        if (h.ticker) cur.label = [...new Set([...(cur.label ?? cur.ticker ?? '').split('+'), h.ticker].filter(Boolean))].join('+')
      } else conv.set(id, { key: id, ticker: h.ticker, former: h.former, name: issuerName(h.display_name || h.issuer), slug: m.slug, firm: m.firm, weight: h.weight })
    }
  for (const c of conv.values()) if (c.label?.includes('+')) [c.ticker] = (c.label = classOrder(c.label.split('+')).join('+')).split('+')
  const conviction = [...conv.values()].sort((a, b) => b.weight - a.weight).slice(0, 8)
  const newStakes = events.filter((e) => e.action === 'new_stake' && daysAgo(e.filing_date) <= 30).length
  const wait = <span className="dim">…</span>
  const crowd = (r: Agg | undefined) => (!books.data ? wait : r ? <CoValue r={r} /> : <span className="dim">None yet</span>)
  const crowdSub = (r: Agg | undefined, line: (r: Agg) => string) => (books.data && r ? line(r) : 'Across the investors who have filed')
  return (
    <div className="page home">
      <div className="stats home-stats" role="list" aria-label={`${quarterLabel(lead)} so far`}>
        <Stat label={`${quarterLabel(s.q)} 13Fs filed`} value={`${seasonFiled.length} of ${ms.length}`} sub={<>{daysLeft < 0 ? `Were due ${day(s.due)}` : `Due ${day(s.due)}${daysLeft > 1 ? `, ${daysLeft} days left` : daysLeft === 1 ? ', 1 day left' : ', today'}`}<Bar value={seasonFiled.length} max={ms.length} /></>} />
        <Stat label={`Most bought in ${quarterLabel(lead)}`} value={crowd(picks.bought)} tone={books.data && picks.bought ? 'pos' : undefined} sub={crowdSub(picks.bought, picks.boughtLine)} />
        <Stat label={`Most sold in ${quarterLabel(lead)}`} value={crowd(picks.sold)} tone={books.data && picks.sold ? 'neg' : undefined} sub={crowdSub(picks.sold, picks.soldLine)} />
        <Stat label="New 5% stakes" value={ev.data ? num(newStakes) : wait} sub="Schedule 13D and 13G filings in the last 30 days" />
      </div>
      <div className="home-grid">
        <Panel
          title="Latest 13F filings"
          right={<A to="/funds">All investors →</A>}
        >
          <Grid
            rows={filers}
            href={(m) => fundPath(m.slug)}
            cols={[
              // Phones show the date under the investor, so the biggest trade has room for its label.
              { key: 'f', label: 'Filed', hideSm: true, render: (m) => <span className="dim num">{date(m.filing_date)}</span>, width: '84px' },
              {
                key: 'm',
                label: 'Investor',
                link: true,
                // Every row is the current quarter's 13F unless marked; a late filing for an older quarter says so.
                render: (m) => (
                  <>
                    <Firm name={m.firm} strong />
                    {m.quarter !== s.q && <span className="tag late">For {quarterLabel(m.quarter)}</span>}
                    <span className="row-sub show-sm">Filed {date(m.filing_date)}</span>
                  </>
                ),
              },
              { key: 'v', label: 'Portfolio', num: true, hideSm: true, width: '76px', render: (m) => usd(bySlug.get(m.slug)?.long_value ?? m.total_value) },
              {
                key: 'd',
                label: 'Change',
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
                label: 'Biggest trade',
                // Fixed so the column keeps its width when the books arrive (no layout shift).
                width: 'var(--trade-w)',
                render: (m) => {
                  const b = bySlug.get(m.slug)
                  const h = b && biggest(b)
                  if (!h) return <span className="dim">{b ? 'No trades' : '…'}</span>
                  return (
                    <span className="move">
                      <StockCell t={h.ticker} name={h.display_name || h.issuer} former={h.former} label={h.label} />
                      <span className={`tag ${h.value_delta! > 0 ? 'pos' : 'neg'}`}>{moveLabel(h)}</span>
                      <span className={`num move-amt ${h.value_delta! > 0 ? 'pos' : 'neg'}`}>{signedUsd(h.value_delta)}</span>
                    </span>
                  )
                },
              },
            ]}
            empty={`No ${quarterLabel(lead)} 13Fs yet.`}
          />
          {/* One line on every width; the list of who hasn't filed is on Investors, one click away. */}
          {due.length > 0 && (
            <div className="due small">
              {daysLeft < 0 ? `${plural(due.length, 'investor')} ${due.length === 1 ? 'hasn’t' : 'haven’t'} filed for ${quarterLabel(s.q)} yet. It was due ${day(s.due)}.` : `${plural(due.length, 'investor')} still to file for ${quarterLabel(s.q)}, due ${day(s.due)}.`} <A to="/funds?show=due" className="nowrap">See who →</A>
            </div>
          )}
        </Panel>
        <div className="home-side">
          <Panel className="reserve-10 home-trades" title={`Largest trades in ${quarterLabel(lead)}`} right={<A to="/flows">All buys and sells →</A>}>
            {books.data ? (
              <Grid
                rows={moves}
                href={(x) => stockHref(x.h)}
                cols={[
                  // Phones: the company's name goes under its ticker and what happened under the amount, so each row reads
                  // "NVDA / Nvidia · Sanders Capital · +$1.7B / Added" without a separate tag column.
                  {
                    key: 't',
                    label: 'Stock',
                    render: (x) => (
                      <>
                        <StockCell t={x.h.ticker} name={x.h.display_name || x.h.issuer} former={x.h.former} label={x.h.label} />
                        {x.h.ticker && <span className="row-sub stock-sub show-sm">{nameOf(x.h)}</span>}
                      </>
                    ),
                  },
                  { key: 'f', label: 'Investor', link: true, render: (x) => <Firm name={x.b.firm} /> },
                  { key: 'a', label: '', hideSm: true, render: (x) => <span className={`tag ${x.h.value_delta! > 0 ? 'pos' : 'neg'}`}>{moveLabel(x.h)}</span> },
                  {
                    key: 'v',
                    label: 'Trade size',
                    num: true,
                    render: (x) => (
                      <>
                        <span className={x.h.value_delta! > 0 ? 'pos' : 'neg'}>{signedUsd(x.h.value_delta)}</span>
                        <span className="row-sub show-sm">{moveLabel(x.h)}</span>
                      </>
                    ),
                  },
                ]}
              />
            ) : (
              <Loading what="Loading the largest trades" rows={10} />
            )}
          </Panel>
          <Panel
            className="reserve-8 home-trades home-filings"
            title={
              <>
                Stakes and insider trades<span className="hide-sm">, last 30 days</span>
              </>
            }
            right={<A to="/filings">All filings →</A>}
          >
            {ev.data ? (
              <Grid
                rows={events.slice(0, 8)}
                href={(e) => (e.ticker ? `/s/${e.ticker}` : null)}
                cols={[
                  // Phones, as on the Stakes page: the date goes under the investor and the company's name under its ticker.
                  { key: 'f', label: 'Filed', hideSm: true, render: (e) => <span className="dim num">{date(e.filing_date)}</span>, width: '72px' },
                  {
                    key: 'w',
                    label: 'Investor',
                    render: (e) => (
                      <>
                        <Firm name={firmOf(firms, e.slug, e.manager)} />
                        <span className="row-sub stock-sub show-sm">Filed {date(e.filing_date)}</span>
                      </>
                    ),
                  },
                  {
                    key: 't',
                    label: 'Stock',
                    render: (e) => (
                      <>
                        <StockCell t={e.ticker} name={issuerName(e.display_name || e.issuer)} former={e.former} />
                        {e.ticker && <span className="row-sub stock-sub show-sm">{issuerName(e.display_name || e.issuer)}</span>}
                      </>
                    ),
                  },
                  { key: 'a', label: '', render: (e) => <ActionTag e={e} /> },
                ]}
                empty="No filings in the last 30 days."
              />
            ) : (
              <Loading what="Loading recent filings" rows={8} />
            )}
          </Panel>
          <Panel title="Biggest single bets" right={<span className="dim">Largest share of one investor’s portfolio</span>}>
            <Grid
              rank
              rows={conviction}
              href={(r) => stockHref(r)}
              cols={[
                { key: 't', label: 'Stock', render: (r) => <StockCell t={r.ticker} name={r.name} former={r.former} label={r.label} />, width: '72px' },
                { key: 'f', label: 'Investor', render: (r) => <A to={fundPath(r.slug)}><Firm name={r.firm} /></A> },
                { key: 'w', label: 'Weight', num: true, render: (r) => pct(r.weight, 1) },
              ]}
            />
          </Panel>
        </div>
      </div>
    </div>
  )
}

/** One entry per issuer (6-character CUSIP prefix), labelled with every class's ticker (GOOGL+GOOG). */
function byCompany(hs: Holding[]) {
  const by = new Map<string, { h: Holding; label?: string }>()
  for (const h of hs) {
    const k = issuerKey(h)
    const cur = by.get(k)
    if (!cur) by.set(k, { h, label: h.ticker ?? undefined })
    else if (h.ticker && !cur.label?.split('+').includes(h.ticker)) cur.label = classOrder([...(cur.label?.split('+') ?? []), h.ticker]).join('+')
  }
  return [...by.values()]
}
/** What a table's less obvious columns mean, in a sentence each, above the table (hidden on phones). */
function ColKey({ items }: { items: [string, string, ('lg' | 'md')?][] }) {
  return (
    <dl className="col-key">
      {items.map(([t, d, hide]) => (
        <div key={t} className={hide ? `hide-${hide}` : undefined}>
          <dt>{t}</dt>
          <dd>{d}</dd>
        </div>
      ))}
    </dl>
  )
}
// ---------- funds directory ----------
type FundsShow = 'all' | 'filed' | 'due'
export function Funds() {
  title('Investors')
  const ix = useLoad(loadIndex, [])
  const books = useLoad(loadBooksAfterIndex, [])
  // During filing season the list splits into who has filed this quarter's 13F and who hasn't (?show=filed|due).
  const [show, setShow] = useState<FundsShow>(() => {
    const v = new URLSearchParams(location.search).get('show')
    return v === 'filed' || v === 'due' ? v : 'all'
  })
  if (ix.error) return <Failed error={ix.error} what="the investors" />
  if (!ix.data) return <PageLoading what="Loading the investors" stats={0} rows={20} />
  const ms = funds(ix.data)
  const all = ix.data.managers.filter((m) => m.ok)
  const metric = new Map(roster.funds.map((f) => [f.slug, f]))
  const bookOf = new Map((books.data ?? []).map((b) => [b.slug, b]))
  const longOf = (m: Manager) => {
    const b = bookOf.get(m.slug)
    return b ? { v: b.long_value, n: b.long_count } : { v: m.total_value, n: m.position_count }
  }
  const sea = season()
  const filed = ms.filter((m) => m.quarter >= sea.q)
  const left = daysUntil(sea.due)
  // Only while some, not all, have filed: before the first filing and after the last the split says nothing.
  const split = filed.length > 0 && filed.length < ms.length
  const view = !split || show === 'all' ? ms : show === 'filed' ? filed : ms.filter((m) => m.quarter < sea.q)
  const pick = (v: FundsShow) => {
    setShow(v)
    history.replaceState(null, '', v === 'all' ? '/funds' : `/funds?show=${v}`)
  }
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Investors</h1>
          <p className="lede">
            {ms.length} concentrated, long-term funds chosen by a <A to="/about#roster">published rule</A>, each with its latest 13F.{roster.pending.length > 0 && ` ${roster.pending.length} more are loading.`}
          </p>
        </div>
      </div>
      {split && (
        <>
          <div className="filters quarter-pick" role="group" aria-label={`${quarterLabel(sea.q)} 13F`}>
            {(
              [
                ['all', 'All', ms.length],
                ['filed', sm(`Filed for ${quarterLabel(sea.q)}`, 'Filed'), filed.length],
                ['due', left >= 0 ? 'Still to file' : 'Not filed yet', ms.length - filed.length],
              ] as [FundsShow, ReactNode, number][]
            ).map(([k, label, n]) => (
              <button key={k} className={show === k ? 'chip on' : 'chip'} aria-pressed={show === k} onClick={() => pick(k)}>
                {label}
                <span className="chip-n">{n}</span>
              </button>
            ))}
          </div>
          <p className="dim small quarter-note">
            {quarterLabel(sea.q)} 13Fs {left >= 0 ? 'are' : 'were'} due {day(sea.due)}
            {left > 1 ? `, in ${left} days` : left === 1 ? ', tomorrow' : left === 0 ? ', today' : ''}. Until an investor files, its page shows its last 13F.
          </p>
        </>
      )}
      <Panel title={!split || show === 'all' ? 'All investors' : show === 'filed' ? `Filed for ${quarterLabel(sea.q)}` : left >= 0 ? `Still to file for ${quarterLabel(sea.q)}` : `${quarterLabel(sea.q)} 13F not filed yet`} right={<span className="dim hide-sm">Largest portfolio first · click a heading to sort</span>}>
        <ColKey
          items={[
            ['Portfolio', 'What its US-listed stocks were worth in its latest 13F. Options are left out.'],
            ['In top 10', 'How much of the portfolio sits in its ten biggest holdings. Higher means more concentrated.'],
            ['Traded', 'How much of the portfolio it bought and sold last quarter. Lower means more patient.'],
          ]}
        />
        <Grid
          rank
          rows={view}
          initial={['v', 'desc']}
          href={(m) => fundPath(m.slug)}
          cols={[
            {
              key: 'm',
              label: 'Investor',
              link: true,
              render: (m) => (
                <>
                  <span className="trunc wide-name" title={m.firm}>
                    <span className="strong hide-sm">{m.firm}</span>
                    <span className="strong show-sm">{shortFirm(m.firm)}</span>
                    {m.pm && <span className="dim hide-sm"> · {m.pm}</span>}
                  </span>
                  {/* Phones: a second line with what the hidden columns say, so each row reads on its own. */}
                  <span className="row-sub show-sm">
                    {quarterLabel(m.quarter)} 13F
                    {isStale(m, all) ? ' · out of date' : ''}
                    {' · '}
                    {byCompany(m.top.filter((h) => isStockLine(h) && !isFundLike(h)))
                      .slice(0, 3)
                      .map(({ h, label }) => (label && label.includes('+') ? label.split('+')[0] : (h.ticker ?? issuerName(h.display_name || h.issuer).split(' ')[0])))
                      .join(', ')}
                  </span>
                </>
              ),
              sort: (m) => m.firm,
            },
            { key: 'v', label: 'Portfolio', num: true, render: (m) => usd(longOf(m).v), sort: (m) => longOf(m).v, title: 'Value of its US-listed stocks in its latest 13F; options left out' },
            { key: 'n', label: 'Stocks', num: true, hide: 'md', hideSm: true, render: (m) => longOf(m).n, sort: (m) => longOf(m).n },
            { key: 't', label: 'In top 10', num: true, hideSm: true, render: (m) => pct(metric.get(m.slug)?.top10, 0), sort: (m) => metric.get(m.slug)?.top10 ?? 0, title: 'Share of the portfolio in its ten biggest holdings' },
            { key: 'to', label: 'Traded', num: true, hideSm: true, render: (m) => pct(metric.get(m.slug)?.turnover, 0), sort: (m) => metric.get(m.slug)?.turnover ?? 0, title: 'Last quarter: half of everything bought and sold, as a share of the average portfolio' },
            {
              key: 'top',
              label: 'Biggest holdings',
              hideSm: true,
              hide: 'md',
              width: '28%',
              // Company names, not a row of tickers: as many whole names as fit on one line (the rest wrap out of
              // sight), with the top five and their weights in the tooltip. The row itself links to the fund.
              render: (m) => {
                const top = byCompany(m.top.filter((h) => isStockLine(h) && !isFundLike(h))).slice(0, 5)
                const co = (h: Holding) => issuerName(h.display_name || h.issuer).replace(/\s+(class|cl\.?|series|ser)\s+[a-z]\b.*$/i, '')
                const weight = (h: Holding) => m.top.filter((x) => issuerKey(x) === issuerKey(h) && isStockLine(x)).reduce((t, x) => t + x.weight, 0)
                return (
                  <span className="top-names" title={top.map(({ h }) => `${co(h)} ${pct(weight(h), 1)}`).join(', ')}>
                    {top.map(({ h }) => (
                      <span key={h.cusip}>{co(h)}</span>
                    ))}
                  </span>
                )
              },
            },
            {
              key: 'q',
              label: 'Latest 13F',
              hideSm: true,
              render: (m) => (
                <span>
                  {quarterLabel(m.quarter)} {isStale(m, all) && <span className="badge warn" title="Its latest usable 13F is more than a quarter behind">Out of date</span>}
                </span>
              ),
              sort: (m) => m.quarter,
            },
            { key: 'f', label: 'Filed', num: true, hideSm: true, hide: 'md', render: (m) => <span className="dim">{date(m.filing_date)}</span>, sort: (m) => m.filing_date },
          ]}
        />
      </Panel>
    </div>
  )
}

// ---------- one fund ----------
type ITab = 'holdings' | 'buys' | 'sells' | 'options' | 'notes' | 'filings' | 'events'
const FUND_TAB: Record<ITab, string> = { holdings: 'What it owns', buys: 'What it bought this quarter', sells: 'What it sold this quarter', options: 'Options', notes: 'Bonds and preferred shares', filings: 'Past 13F filings', events: 'Stakes and insider trades' }
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
  // A missing or held-back book is a real "not found"; anything else (offline, a mirror hiccup) can be retried.
  // An address that isn't a followed investor is not found. A followed investor whose file is missing is a data
  // problem a retry may fix, so it gets the error page; one held back by the data checks says so.
  if (b.error)
    return /^held:/.test(b.error) ? (
      <NotFound what="This investor’s latest 13F is held back while its numbers are checked against the filing’s cover page. It will be back once they match" />
    ) : missing(b.error) && !inRoster(slug) ? (
      <NotFound what="Holdterm doesn’t follow an investor at this address. It may have been renamed or left the list of investors Holdterm follows" q={slug.replace(/-\d+$/, '').replace(/-/g, ' ')} />
    ) : (
      <Failed error={b.error} what="this portfolio" />
    )
  if (!b.data) return <PageLoading what="Loading this portfolio" stats={5} rows={15} />
  const book = b.data
  title(`${book.firm} 13F portfolio`)
  const filer = meta && meta.filer_slug !== slug ? ix.data?.managers.find((m) => m.slug === meta.filer_slug) : null
  // Options (notional) and notes or preferreds are not stock: they stay out of the book, its weights and the
  // bought/sold totals, each in its own tab.
  const live = book.holdings.filter((x) => x.value > 0 && isStockLine(x))
  const opts = book.holdings.filter((x) => x.put_call && (x.value > 0 || x.prev_value))
  const notes = book.holdings.filter((x) => isNoteOrPref(x) && (x.value > 0 || x.prev_value)).sort((a, c) => c.value - a.value || (c.prev_value ?? 0) - (a.prev_value ?? 0))
  const stock = book.holdings.filter(isStockLine)
  const buys = stock.filter((x) => (x.value_delta ?? 0) > 0).sort((a, c) => (c.value_delta ?? 0) - (a.value_delta ?? 0))
  const sells = stock.filter((x) => (x.value_delta ?? 0) < 0).sort((a, c) => (a.value_delta ?? 0) - (c.value_delta ?? 0))
  const bought = buys.reduce((s, x) => s + (x.value_delta ?? 0), 0)
  const sold = sells.reduce((s, x) => s + (x.value_delta ?? 0), 0)
  const top10 = [...live].sort((a, c) => c.weight - a.weight).slice(0, 10).reduce((s, x) => s + x.weight, 0)
  const hist = [...(h.data?.history ?? [])].filter((r) => r.total_value > 0).reverse()
  const events = ev.data ?? []
  const stale = ix.data ? isStale(book, ix.data.managers.filter((m) => m.ok)) : false
  // The first 13F after this one: when it is due, or that it was due and hasn't arrived. A fund whose newer 13F was
  // filed but can't be read, or that has stopped filing, already says so in its badge.
  const want = nextQ(book.quarter)
  const due = inRoster(slug) && want <= season().q && !['empty_latest', 'unreadable_latest', 'inactive'].includes(book.status) ? { q: want, due: dueFor(want).due, left: daysUntil(dueFor(want).due) } : null
  const valuePanel = (
    <Panel title="Portfolio value by quarter" right={<span className="dim hide-sm">Value of US-listed stocks in each 13F</span>}>
      {book.options_value > 0 && hist.some((r) => r.equity_value == null && r.long_value == null) && <div className="dim small">Older quarters as filed, including options.</div>}
      {hist.length > 1 ? <ValueHistory title={`${book.firm} portfolio value by quarter`} data={hist.map((r) => ({ label: quarterLabel(r.quarter).replace(' 20', " '"), value: r.equity_value ?? r.long_value ?? r.total_value }))} /> : <Empty title="Only one quarter on file so far" hint="The chart fills in as it files more 13Fs, one each quarter." />}
    </Panel>
  )
  return (
    <div className="page">
      <Crumbs parent={['/funds', 'Investors']} here={book.firm} />
      <div className="head">
        <div>
          <h1>
            {book.firm} {!inRoster(slug) && <span className="badge">Not one of the investors Holdterm follows</span>} {stale && <span className="badge warn">Latest usable 13F is for {quarterLabel(book.quarter)}</span>}
          </h1>
          {book.pm && <p className="lede">Portfolio manager {book.pm}</p>}
          {/* One plain line: which report, when, and a link to it. The legal filer name and CIK are in the link's tooltip. */}
          <div className="meta">
            <span>
              {quarterLabel(book.quarter)} 13F<span className="hide-sm"> · quarter ended {date(book.report_date)}</span> · filed {date(book.filing_date)}, {plural(lagDays(book), 'day')} later
            </span>
            <a href={book.sec_url} target="_blank" rel="noreferrer" title={`Filed as ${filer ? filer.name : book.name} (CIK ${(filer?.cik ?? book.cik).replace(/^0+/, '')}), SEC accession ${book.accession}`}>
              View the filing on SEC EDGAR ↗
            </a>
            {filer && firmName(filer.slug, filer.name) !== book.firm && <span>Filed by {firmName(filer.slug, filer.name)}</span>}
            {/* During filing season, a fund still on last quarter's 13F says when the new one is due, so its page doesn't read as out of date. */}
            {due && (
              <span className="due-next">
                {due.left < 0 ? `${quarterLabel(due.q)} 13F was due ${day(due.due)}, not filed yet` : `${quarterLabel(due.q)} 13F due ${day(due.due)}${due.left > 1 ? `, in ${due.left} days` : due.left === 1 ? ', tomorrow' : ', today'}`}
              </span>
            )}
          </div>
        </div>
        <Follow kind="investors" id={slug} />
      </div>
      <FundSummary book={book} live={live} buys={buys} sells={sells} top10={top10} />
      <div className="stats fund-stats" role="list" aria-label="Portfolio at a glance">
        <Stat
          label="portfolio value"
          value={usd(book.long_value)}
          sub={
            <>
              {book.prev_long_value ? `${signedUsd(book.long_value - book.prev_long_value)} vs ${quarterLabel(book.prev_quarter ?? '')}` : 'First filing'}
              {book.options_value > 0 && <span className="dim"> · + {usd(book.options_value)} options notional</span>}
              {book.notes_value > 0 && <span className="dim"> · + {usd(book.notes_value)} notes and preferreds</span>}
            </>
          }
        />
        <Stat label="stocks held" value={live.length} sub={`${stock.filter((x) => x.change === 'new').length} new, ${stock.filter((x) => x.change === 'exited').length} sold out`} />
        <Stat label="top 10 holdings" value={pct(top10, 1)} sub={<Bar value={top10} max={1} />} />
        <Stat label="bought" value={usd(bought)} tone="pos" sub={`Across ${plural(buys.length, 'position')}`} />
        <Stat label="sold" value={usd(-sold)} tone="neg" sub={`Across ${plural(sells.length, 'position')}`} />
      </div>
      <Tabs<ITab>
        value={tab}
        onChange={setTab}
        options={[
          ['holdings', `Holdings ${live.length}`],
          ['buys', `Bought ${buys.length}`],
          ['sells', `Sold ${sells.length}`],
          ...(opts.length ? ([['options', `Options ${opts.length}`]] as [ITab, string][]) : []),
          ...(notes.length ? ([['notes', `Bonds and preferreds ${notes.length}`]] as [ITab, string][]) : []),
          ['filings', `History ${hist.length}`],
          ['events', `Stakes and insider trades ${events.length}`],
        ]}
        label={`${book.firm} portfolio`}
      />
      <TabPanel tab={tab}>
      {tab === 'filings' && valuePanel}
      <Panel className="fund-table" title={FUND_TAB[tab]} right={tab === 'holdings' ? <span className="dim hide-sm">Prices come from the filing itself, not the market</span> : tab === 'options' ? <span className="dim hide-sm">Value of the underlying shares; not counted in the portfolio</span> : tab === 'notes' ? <span className="dim hide-sm">As filed; not counted in the stock portfolio</span> : undefined}>
        {tab === 'holdings' && <HoldingsGrid rows={live} own={(x) => ownHolding(book, x)} />}
        {tab === 'buys' && <MovesGrid rows={buys} empty={movesEmpty(book, 'bought')} />}
        {tab === 'sells' && <MovesGrid rows={sells} empty={movesEmpty(book, 'sold')} />}
        {tab === 'options' && (
          <Grid
            rows={[...opts].sort((a, c) => c.value - a.value)}
            href={stockHref}
            cols={[
              { key: 't', label: 'Ticker', render: holdingTicker, width: '80px' },
              { key: 'n', label: 'Company', hideSm: true, render: (r) => <span className="trunc">{r.display_name}</span> },
              { key: 'pc', label: 'Call or put', render: (r) => <span className={`tag ${r.put_call === 'CALL' ? 'pos' : 'neg'}`}>{r.put_call === 'CALL' ? 'Call' : 'Put'}</span> },
              { key: 'sh', label: 'Shares', num: true, hideSm: true, render: (r) => num(r.shares) },
              { key: 'v', label: 'Value of shares', num: true, title: 'Value of the shares the options cover (notional)', render: (r) => usd(r.value), sort: (r) => r.value },
              { key: 'd', label: 'Change', num: true, render: (r) => <span className="dim">{signedUsd((r.value || 0) - (r.prev_value ?? 0))}</span> },
            ]}
          />
        )}
        {tab === 'notes' && (
          <Grid
            rows={notes}
            href={stockHref}
            cols={[
              { key: 'n', label: 'Company', render: (r) => (r.ticker ? <StockCell t={r.ticker} name={r.display_name || r.issuer} /> : <span className="trunc">{issuerName(r.display_name || r.issuer)}</span>), sort: (r) => r.display_name || r.issuer },
              { key: 'k', label: 'Security', render: (r) => <span className="trunc dim">{noteLabel(r)}</span>, sort: (r) => r.title },
              { key: 'a', label: 'Amount', num: true, hideSm: true, render: noteAmount, sort: (r) => r.principal_amount ?? r.shares },
              { key: 'c', label: 'This quarter', hideSm: true, render: (r) => <ChangeTag change={r.change} share_change={r.share_change} prev_shares={r.prev_shares} held={r.unreliable} />, sort: (r) => r.share_change ?? 0 },
              { key: 'v', label: 'Value', num: true, render: (r) => usd(r.value), sort: (r) => r.value },
              { key: 'pv', label: 'Last quarter', num: true, hideSm: true, render: (r) => <span className="dim">{usd(r.prev_value)}</span>, sort: (r) => r.prev_value ?? 0 },
            ]}
          />
        )}
        {tab === 'filings' && (
          <Grid
            rows={[...hist].reverse()}
            cols={[
              {
                key: 'q',
                label: 'Quarter',
                // On phones the quarter is the filing link; the View filing column is hidden there.
                render: (r) => (
                  <a href={r.sec_url} target="_blank" rel="noreferrer" className="acc" aria-label={`${quarterLabel(r.quarter)} 13F on SEC EDGAR`}>
                    {quarterLabel(r.quarter)}
                  </a>
                ),
              },
              { key: 'rd', label: 'Holdings as of', hideSm: true, render: (r) => date(r.report_date) },
              { key: 'fd', label: 'Filed', render: (r) => date(r.filing_date) },
              { key: 'v', label: 'Portfolio value', num: true, render: (r) => usd(r.equity_value ?? r.total_value) },
              { key: 'n', label: 'Positions', num: true, render: (r) => r.position_count },
              {
                key: 's',
                label: <span className="sr">SEC filing</span>,
                hideSm: true,
                render: (r) => (
                  <a href={r.sec_url} target="_blank" rel="noreferrer" className="ext">
                    View filing ↗
                  </a>
                ),
              },
            ]}
          />
        )}
        {tab === 'events' && (
          <Grid
            rows={events}
            cols={eventCols(firms, false)}
            empty={
              <Empty
                title="No stake or insider filings since its latest 13F"
                hint="An investor files a 13D or 13G within days of passing 5% of a company, and a Form 4 within two business days when it trades as an insider. They appear here within hours."
                action={['Get an email when it files', '/alerts']}
              />
            }
          />
        )}
      </Panel>
      </TabPanel>
      <div className={tab === 'filings' ? '' : 'duo wide'}>
        {tab !== 'filings' && valuePanel}
        <Panel title="Sectors">
          <SectorRows items={live} />
        </Panel>
      </div>
    </div>
  )
}
/** "NOTE 3.875%11/3" -> "Note, 3.875%"; "PERP PFD CNV A" -> "Preferred, convertible". */
function noteLabel(h: Holding) {
  const t = (h.title ?? '').toUpperCase()
  const kind = /PFD|PREF|\bCUM\b|\bDEP\b/.test(t) ? 'Preferred' : /DEB/.test(t) ? 'Debenture' : /BOND/.test(t) ? 'Bond' : 'Note'
  const rate = t.match(/(\d+(?:\.\d+)?)\s*%/)?.[1]
  const conv = /CONV|CNV/.test(t) ? 'convertible' : ''
  return [kind, conv, rate ? `${Number(rate)}%` : ''].filter(Boolean).join(', ')
}
/** Debt shows its principal (some filers put it in the share count); a preferred shows shares. */
function noteAmount(h: Holding) {
  if (noteLabel(h).startsWith('Preferred')) return `${num(h.shares)} shares`
  const p = h.principal_amount || h.shares
  return p ? `${usd(p)} principal` : '—'
}
const plural = (n: number, one: string, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`
/** A fund table's ticker cell; phones hide the Company column, so the company's name goes on a second line. */
const holdingTicker = (r: Holding) => (
  <>
    <StockCell t={r.ticker} name={r.display_name || r.issuer} former={r.former} />
    {r.ticker && <span className="row-sub stock-sub show-sm">{r.display_name || issuerName(r.issuer)}</span>}
  </>
)
const nameOf = (h: Holding) => issuerName(h.display_name || h.issuer).replace(/\s+(class|cl\.?|series|ser)\s+[a-z]\b.*$/i, '')
/** "a, b and c" */
const listing = (xs: (string | false | 0)[]) => xs.filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1')
/** The fund's latest 13F in two or three plain sentences, for readers who don't parse stat cards. */
const lagDays = (b: Book) => Math.round((Date.parse(b.filing_date) - Date.parse(b.report_date)) / 86_400_000)
function FundSummary({ book, live, buys, sells, top10 }: { book: Book; live: Holding[]; buys: Holding[]; sells: Holding[]; top10: number }) {
  const top = [...live].sort((a, c) => c.weight - a.weight)[0]
  const shape = top10 >= 0.8 ? ', a very concentrated portfolio' : top10 >= 0.6 ? ', a concentrated portfolio' : ''
  return (
    <p className="summary">
      {/* The cards below give the totals; the summary says what they can't: how concentrated it is and what moved most. */}
      {top && (
        <>
          {book.firm}’s largest holding is {nameOf(top)} at {pct(top.weight, 1)}
          {live.length > 10 ? `, and the ten largest make up ${pct(top10, 0)}${shape}` : ''}.{' '}
        </>
      )}
      {!book.prev_long_value ? (
        <>This is its first 13F on file, so there are no trades to compare.</>
      ) : buys.length || sells.length ? (
        <>
          {listing([buys[0] && `The biggest buy was ${nameOf(buys[0])}`, sells[0] && (buys[0] ? `the biggest sale was ${nameOf(sells[0])}` : `The biggest sale was ${nameOf(sells[0])}`)])}.
        </>
      ) : (
        <>It made no trades over the quarter.</>
      )}
    </p>
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
      rank
      rows={rows}
      initial={['w', 'desc']}
      href={stockHref}
      cols={[
        { key: 't', label: 'Ticker', render: holdingTicker, sort: (r) => r.ticker ?? '', width: '80px' },
        { key: 'n', label: 'Company', link: true, hideSm: true, render: (r) => <span className="trunc">{r.display_name}{r.put_call ? <span className="badge">{r.put_call}</span> : null}{own?.(r) ? <span className="badge">own fund</span> : null}</span>, sort: (r) => r.display_name ?? '' },
        { key: 's', label: 'Sector', hideSm: true, hide: 'lg', render: (r) => <Sector s={r.sector} />, sort: (r) => r.sector ?? '' },
        // Phones show the change under the weight rather than in its own column, so the ticker and company name get
        // the width (with the # column hidden too, a name like "Seaport Entertainment Group" fits on two lines).
        {
          key: 'w',
          label: 'Weight',
          num: true,
          render: (r) => (
            <>
              {badValue(r.unreliable) ? <AsFiled why={r.unreliable!} /> : pct(r.weight)}
              <span className="row-sub show-sm change-sub">
                <ChangeTag change={r.change} share_change={r.share_change} prev_shares={r.prev_shares} held={r.unreliable} />
              </span>
            </>
          ),
          sort: (r) => r.weight,
          title: 'Share of the portfolio',
        },
        { key: 'ws', label: 'Last quarter vs now', hideSm: true, hide: 'lg', render: (r) => (badValue(r.unreliable) ? null : <WeightShift prev={r.prev_weight ?? 0} now={r.weight} max={max} />), title: 'Share of the portfolio last quarter (grey) and now' },
        { key: 'c', label: 'This quarter', hideSm: true, render: (r) => <ChangeTag change={r.change} share_change={r.share_change} prev_shares={r.prev_shares} held={r.unreliable} />, sort: (r) => r.share_change ?? 0 },
        { key: 'sh', label: 'Shares', num: true, hideSm: true, hide: 'md', render: (r) => <Filed held={r.unreliable} fig="shares">{num(r.shares)}</Filed>, sort: (r) => r.shares },
        { key: 'p', label: 'Price in filing', num: true, hideSm: true, hide: 'lg', render: (r) => (r.shares && !r.put_call ? r.unreliable ? <AsFiled why={r.unreliable}>{price(r.value / r.shares)}</AsFiled> : price(r.value / r.shares) : '—'), sort: (r) => (r.shares ? r.value / r.shares : 0) },
        { key: 'v', label: 'Value', num: true, render: (r) => <Filed held={r.unreliable} fig="value">{usd(r.value)}</Filed>, sort: (r) => r.value },
      ]}
    />
  )
}
/** Bought and Sold compare a 13F with the one before, so a first filing has nothing to compare. */
const movesEmpty = (book: Book, what: 'bought' | 'sold') =>
  book.prev_long_value ? (
    <Empty title={`It ${what === 'bought' ? 'didn’t buy' : 'didn’t sell'} any stock this quarter`} hint={what === 'bought' ? `It opened no new positions and added no shares to any stock it held in ${quarterLabel(book.prev_quarter ?? '')}.` : `It sold no shares of any stock it held in ${quarterLabel(book.prev_quarter ?? '')}.`} />
  ) : (
    <Empty title="This is its first 13F on file" hint="Bought and sold compare each 13F with the quarter before, so they fill in with its next filing." />
  )
function MovesGrid({ rows, empty }: { rows: Holding[]; empty?: ReactNode }) {
  return (
    <Grid
      empty={empty}
      rank
      rows={rows}
      href={stockHref}
      cols={[
        { key: 't', label: 'Ticker', render: holdingTicker, width: '80px' },
        { key: 'n', label: 'Company', link: true, hideSm: true, render: (r) => <span className="trunc">{r.display_name}</span> },
        { key: 'c', label: 'What changed', render: (r) => <ChangeTag change={r.change} share_change={r.share_change} prev_shares={r.prev_shares} held={r.unreliable} /> },
        { key: 'sc', label: 'Shares changed', num: true, hideSm: true, hide: 'md', render: (r) => <span className={(r.share_change ?? 0) > 0 ? 'pos' : 'neg'}>{(r.share_change ?? 0) > 0 ? '+' : ''}{num(r.share_change)}</span>, sort: (r) => r.share_change ?? 0 },
        // Phones show the trade's share of the portfolio under its size, as the header's second line says, so the
        // ticker and company name get the width of a column.
        {
          key: 'd',
          label: (
            <>
              <span className="hide-sm">Trade size</span>
              <span className="show-sm th-two">
                Trade size
                <br />% of portfolio
              </span>
            </>
          ),
          num: true,
          render: (r) => (
            <>
              <span className={(r.value_delta ?? 0) > 0 ? 'pos' : 'neg'}>{signedUsd(r.value_delta)}</span>
              <span className={`row-sub show-sm ${(r.trade_pct ?? 0) > 0 ? 'pos' : 'neg'}`}>
                {(r.trade_pct ?? 0) > 0 ? '+' : ''}
                {pct(r.trade_pct)}
              </span>
            </>
          ),
          sort: (r) => r.value_delta ?? 0,
        },
        { key: 'pb', label: 'Trade, % of portfolio', hideSm: true, num: true, render: (r) => <span className={(r.trade_pct ?? 0) > 0 ? 'pos' : 'neg'}>{(r.trade_pct ?? 0) > 0 ? '+' : ''}{pct(r.trade_pct)}</span>, sort: (r) => r.trade_pct ?? 0, title: ((r) => `Trade value ÷ this 13F’s total${r ? `, ${usd(r.value_delta! / r.trade_pct!)}` : ''}`)(rows.find((r) => r.value_delta && r.trade_pct)) },
        { key: 'w', label: 'Weight now', num: true, hideSm: true, hide: 'lg', render: (r) => pct(r.weight), sort: (r) => r.weight },
      ]}
    />
  )
}

// ---------- flows ----------
type ATab = 'buyers' | 'buy$' | 'new' | 'sellers' | 'exits'
export function Flows() {
  title('Buys and sells')
  const books = useLoad(loadBooks, [])
  const [picked, setQ] = useState<string | null>(null)
  const [tab, setTab] = useState<ATab>('buyers')
  // Opens on the quarter the home page leads with; "Each fund's latest" is one chip away.
  const q = picked ?? (books.data?.length ? leadQuarter(books.data.map((b) => b.quarter)) : 'latest')
  const quarters = useMemo(() => [...new Set((books.data ?? []).map((b) => b.quarter))].sort().reverse(), [books.data])
  // Flows are stock picks: ETFs, index and T-bill funds are left out.
  const rows = useMemo(() => (books.data ? (q === 'latest' ? aggregate(books.data) : aggregate(books.data.filter((b) => b.quarter === q), books.data)).rows.filter((r) => !r.fund) : []), [books.data, q])
  if (books.error) return <Failed error={books.error} what="this quarter’s trades" />
  if (!books.data)
    return (
      <PageLoading
        what="Loading this quarter’s trades"
        stats={0}
        rows={20}
        slowAfter={30_000}
        head={
          <div className="head">
            <div>
              <h1>Buys and sells</h1>
              <p className="lede">What the investors bought and sold, comparing each fund’s latest 13F with the one before.</p>
            </div>
          </div>
        }
        progress={<BooksProgress what="Comparing each investor’s latest 13F with the quarter before" />}
        before={
          <>
            <div className="filters quarter-pick" aria-hidden>
              <span className="skel skel-chip" />
              <span className="skel skel-chip" />
              <span className="skel skel-chip" />
            </div>
            <TickStatsSkel />
            <TabsSkel labels={['Most buyers', 'Most money in', 'New positions', 'Most sellers', 'Sold out']} />
          </>
        }
        cols={AGG_SKEL(['Investors buying', 'Who bought', 'Bought', 'Sold', 'Net money in'], [0, 4])}
      />
    )
  const fundsN = q === 'latest' ? books.data.length : books.data.filter((b) => b.quarter === q).length
  // In "latest" mode the books span quarters: say how many of each, and tag the newest quarter's funds.
  const mix = quarters.map((x) => [x, books.data!.filter((b) => b.quarter === x).length] as const)
  const tagQ = q === 'latest' && mix.length > 1 ? mix[0][0] : undefined
  // The newest quarter on its own, as the home page counts it, so the two pages' "most bought" can be told apart.
  const leadTop = tagQ ? crowdPicks(aggregate(books.data.filter((b) => b.quarter === tagQ), books.data).rows, mix[0][1]).bought : undefined
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
      <div className="head">
        <div>
          <h1>Buys and sells</h1>
          <p className="lede">What the investors bought and sold, comparing each fund’s latest 13F with the one before.</p>
        </div>
      </div>
      {/* One row of quarter chips on every width; the count under it says, in words, which 13F each investor is shown with. */}
      <div className="filters quarter-pick" role="group" aria-label="Quarter">
        <span className="dim hide-sm">Quarter</span>
        {['latest', ...quarters].map((x) => (
          <button key={x} className={q === x ? 'chip on' : 'chip'} aria-pressed={q === x} onClick={() => setQ(x)}>
            {x === 'latest' ? sm('Each fund’s latest', 'Latest') : quarterLabel(x)}
          </button>
        ))}
      </div>
      <p className="dim small quarter-note">
        {q !== 'latest'
          ? fundsN < books.data.length
            ? `${num(fundsN)} of the ${num(books.data.length)} investors have filed for ${quarterLabel(q)}. “Each fund’s latest” adds the others’ earlier 13Fs.`
            : `${plural(fundsN, 'investor')} filed for ${quarterLabel(q)}.`
          : tagQ
            ? `${num(fundsN)} investors: ${num(mix[0][1])} have filed for ${quarterLabel(tagQ)}, and the other ${num(fundsN - mix[0][1])} are shown with ${mix.length === 2 ? `their ${quarterLabel(mix[1][0])} 13F` : 'an earlier 13F'}.${leadTop?.buyers.length ? ` Among those ${num(mix[0][1])}, the most bought is ${aggName(leadTop)}, by ${num(leadTop.buyers.length)}.` : ''}`
            : `${plural(fundsN, 'investor')}, each with its latest 13F.`}
      </p>
      <FlowsStats rows={rows} q={q} n={fundsN} mixed={!!tagQ} />
      <Tabs<ATab>
        value={tab}
        onChange={setTab}
        options={[
          ['buyers', 'Most buyers'],
          ['buy$', 'Most money in'],
          ['new', 'New positions'],
          ['sellers', 'Most sellers'],
          ['exits', 'Sold out'],
        ]}
        label="Ways to rank the quarter's trades"
      />
      <TabPanel tab={tab}>
      <Panel title={`${num(list.length)} stocks`}>
        <ColKey
          items={[
            [isBuy ? (tab === 'new' ? 'New positions' : 'Investors buying') : tab === 'exits' ? 'Sold all' : 'Investors selling', isBuy ? (tab === 'new' ? 'How many investors bought it for the first time.' : 'How many investors added shares, including new positions.') : tab === 'exits' ? 'How many investors sold every share.' : 'How many investors cut shares, including those who sold out.'],
            ['Bought, Sold', 'The dollar value of shares added and cut, at the price in each 13F. A price move alone isn’t a trade.', 'md'],
            ['Net money in', 'Bought minus sold. Negative means more money came out than went in.'],
          ]}
        />
        <Grid
          rank
          limit={100}
          rows={list}
          href={stockHref}
          cols={[
            aggCols.ticker,
            { ...aggCols.name, hideSm: true },
            aggCols.sector,
            isBuy
              ? { key: 'b', label: tab === 'new' ? sm('New positions', 'New') : sm('Investors buying', 'Buyers'), num: true, title: tab === 'new' ? 'Investors that bought it for the first time' : 'Investors that added shares', render: (r) => <span className="pos">{tab === 'new' ? r.newBuyers : r.buyers.length}</span> }
              : { key: 's', label: tab === 'exits' ? 'Sold all' : sm('Investors selling', 'Sellers'), num: true, title: tab === 'exits' ? 'Investors that sold every share' : 'Investors that cut shares', render: (r) => <span className="neg">{tab === 'exits' ? exits(r) : r.sellers.length}</span> },
            { key: 'w', label: isBuy ? 'Who bought' : 'Who sold', hideSm: true, hide: 'lg', render: (r) => <Who tagQ={tagQ} list={[...(isBuy ? r.buyers : r.sellers)].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))} /> },
            { key: 'bv', label: 'Bought', num: true, hideSm: true, hide: 'md', title: 'Value of shares added, at each filing’s price', render: (r) => <span className="pos">{r.buy ? usd(r.buy) : '—'}</span>, sort: (r) => r.buy },
            { key: 'sv', label: 'Sold', num: true, hideSm: true, hide: 'md', title: 'Value of shares cut, at each filing’s price', render: (r) => <span className="neg">{r.sell ? usd(-r.sell) : '—'}</span>, sort: (r) => -r.sell },
            {
              key: 'nv',
              label: sm('Net money in', 'Net'),
              num: true,
              title: 'Bought minus sold',
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
      </TabPanel>
    </div>
  )
}

/** A stock's company name without its share class: "Alphabet". */
const aggCo = (r: Agg) => r.name.replace(/\s+(class|cl\.?|series|ser)\s+[a-z]\b.*$/i, '')
/** A stock in running text: "Alphabet (GOOGL)". */
const aggName = (r: Agg) => `${aggCo(r)}${r.ticker ? ` (${r.label ?? r.ticker})` : ''}`
/** A summary card's answer is the company, linked to its page; the ticker leads the line below it (tkLine), so the
 * cards read "Alphabet / GOOGL+GOOG · bought by 27 of 183" rather than opening on a ticker. */
const CoValue = ({ r }: { r: Agg }) => (r.ticker ? <A to={stockHref(r)!} className="tk stat-co" title={`${aggCo(r)} (${r.label ?? r.ticker})`}>{aggCo(r)}</A> : <span className="stat-co">{aggCo(r)}</span>)
const tkLine = (r: Agg, rest: string) => (r.ticker ? `${(r.label ?? r.ticker).split('+').join(' and ').replace(/ and (?=.* and )/g, ', ')} · ${rest}` : cap(rest))
/** The quarter the home page leads with and Buys & sells opens on, so the two never answer "most bought" from different
 * filings: this 13F season's quarter once three investors have filed for it, else the quarter before. */
export function leadQuarter(qs: string[]) {
  const sq = season().q
  return qs.filter((q) => q === sq).length >= 3 ? sq : ([...new Set(qs)].sort().reverse().find((q) => q !== sq) ?? sq)
}
/** The most bought and most sold stock among \`rows\` (an aggregate over \`n\` investors) and how to say each. The home page and
 * Buys & sells both use it, so they always name the same stock with the same count and words. Ties on the count go to
 * the bigger trade, as in the tables' own order (sell is negative). */
export function crowdPicks(rows: Agg[], n: number) {
  const stocks = rows.filter((r) => !r.fund)
  const top = (cmp: (a: Agg, b: Agg) => number) => [...stocks].sort(cmp)[0] as Agg | undefined
  const bought = top((a, b) => b.buyers.length - a.buyers.length || b.buy - a.buy)
  const sold = top((a, b) => b.sellers.length - a.sellers.length || a.sell - b.sell)
  const exits = (r: Agg) => r.sellers.filter((s) => s.change === 'exited').length
  return {
    bought: bought?.buyers.length ? bought : undefined,
    sold: sold?.sellers.length ? sold : undefined,
    // Counts say "of how many", so a quoted card can't read as everyone, and selling says whether anyone sold out.
    // The most buyers can still be net selling (and the most sellers net buying): say so, or the card next to it
    // ("Biggest net sale") reads as a contradiction.
    boughtLine: (r: Agg) => tkLine(r, `bought by ${num(r.buyers.length)} of ${num(n)}${r.newBuyers ? `, ${num(r.newBuyers)} new` : ''}${r.net < 0 ? '; more money out than in' : ''}`),
    soldLine: (r: Agg) =>
      tkLine(r, `${exits(r) ? `sold by ${num(r.sellers.length)} of ${num(n)}: ${num(r.sellers.length - exits(r))} trimmed, ${num(exits(r))} sold out` : `trimmed by ${num(r.sellers.length)} of ${num(n)}, none sold out`}${r.net > 0 ? '; more money in than out' : ''}`),
  }
}
/** The quarter's four answers as cards, like the home page's: most investors buying and selling, most money in and out. */
function FlowsStats({ rows, q, n, mixed }: { rows: Agg[]; q: string; n: number; mixed?: boolean }) {
  const top = (cmp: (a: Agg, b: Agg) => number) => [...rows].sort(cmp)[0] as Agg | undefined
  const { bought: buyers, sold: sellers, boughtLine: bought, soldLine: sold } = crowdPicks(rows, n)
  const netBuy = top((a, b) => b.net - a.net)
  const netSell = top((a, b) => a.net - b.net)
  // The quarter chips just above name the quarter, so the labels stay short enough for two cards a row on phones.
  const scope = q === 'latest' ? ' in each fund’s latest 13F' : ` in ${quarterLabel(q)}`
  const card = (label: string, r: Agg | undefined, ok: boolean, tone: 'pos' | 'neg', sub: (r: Agg) => string) => (
    <Stat label={label} value={r && ok ? <CoValue r={r} /> : <span className="dim">None</span>} tone={r && ok ? tone : undefined} sub={r && ok ? sub(r) : undefined} />
  )
  // A net figure that one investor makes up most of says so, so "+$2.0B into NVIDIA" isn't read as a crowd.
  const net = (r: Agg) => {
    const lead = [...(r.net > 0 ? r.buyers : r.sellers)].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0]
    // When the view mixes quarters, the one investor's trade says which 13F it is from.
    const one = lead && Math.abs(lead.delta) > Math.abs(r.net) / 2 ? `, ${shortFirm(lead.manager)} alone ${signedUsd(lead.delta)}${mixed ? ` in ${quarterLabel(lead.quarter)}` : ''}` : ''
    return tkLine(r, `${signedUsd(r.net)} net${one}`)
  }
  return (
    <div className="stats tick-stats" role="list" aria-label={`Buys and sells${scope}`}>
      {card('Most bought', buyers, !!buyers, 'pos', bought)}
      {card('Biggest net buy', netBuy, (netBuy?.net ?? 0) > 0, 'pos', net)}
      {card('Most sold', sellers, !!sellers, 'neg', sold)}
      {card('Biggest net sale', netSell, (netSell?.net ?? 0) < 0, 'neg', net)}
    </div>
  )
}
/** Four cards whose values are tickers or short figures: two rows of two on tablets, so "GOOGL+GOOG" fits. */
const TickStatsSkel = () => (
  <div className="stats tick-stats" aria-hidden>
    {[0, 1, 2, 3].map((i) => (
      <div key={i} className="stat">
        <span className="skel skel-label" />
        <span className="skel skel-value" />
      </div>
    ))}
  </div>
)
/** The combined portfolio at a glance, as Buys & sells' cards: its size, the most widely owned stock, the largest
 * holding and how much the ten largest add up to. The sector panel below covers the sectors. */
function ConsensusStats({ rows, total, n }: { rows: Agg[]; total: number; n: number }) {
  const stocks = rows.filter((r) => !r.fund)
  const wide = [...stocks].sort((a, b) => b.holders.length - a.holders.length || b.value - a.value)[0]
  const big = [...stocks].sort((a, b) => b.value - a.value)
  const top10 = big.slice(0, 10).reduce((t, r) => t + r.value, 0) / (total || 1)
  if (!wide) return null
  return (
    <div className="stats tick-stats" role="list" aria-label="The combined portfolio at a glance">
      <Stat label="Held in total" value={usd(total)} sub={`In ${num(rows.length)} stocks and funds`} />
      <Stat label="Most widely owned" value={<CoValue r={wide} />} sub={tkLine(wide, `held by ${num(wide.holders.length)} of ${num(n)} investors`)} />
      <Stat label="Largest holding" value={<CoValue r={big[0]} />} sub={tkLine(big[0], `${usd(big[0].value)}, ${pct(big[0].value / (total || 1), 1)} of the total`)} />
      <Stat label="Ten largest holdings" value={pct(top10, 0)} sub="Of everything held" />
    </div>
  )
}
/** The window's filings at a glance, as the other section pages' cards: stakes above 5%, new ones, insider trades
 * and the latest new stake. */
function FilingsStats({ list, firms, days }: { list: Event[]; firms: Map<string, string>; days: number }) {
  const stakes = list.filter((e) => e.kind !== 'form4')
  const f4 = list.filter((e) => e.kind === 'form4')
  const newStakes = stakes.filter((e) => e.action === 'new_stake')
  const buys = f4.filter((e) => e.action === 'buy').length
  const sells = f4.filter((e) => e.action === 'sell').length
  const latestNew = newStakes[0]
  return (
    <div className="stats tick-stats" role="list" aria-label={`Filings in the last ${days} days`}>
      <Stat label="5% stakes reported" value={num(stakes.length)} sub={`13D and 13G filings, last ${days} days`} />
      <Stat label="New 5% stakes" value={num(newStakes.length)} tone={newStakes.length ? 'pos' : undefined} sub="A first 13D or 13G on the company" />
      {/* Named as the table tags them, so the parts add up to the count: a Form 4 with no open-market trade is "not a trade". */}
      <Stat label="Insider filings" value={num(f4.length)} sub={f4.length ? cap(listing([buys > 0 && plural(buys, 'open-market buy'), sells > 0 && plural(sells, 'sale'), f4.length - buys - sells > 0 && `${num(f4.length - buys - sells)} not a trade`])) : 'Form 4 filings'} />
      <Stat
        label="Latest new stake"
        value={latestNew ? <Tick t={latestNew.ticker} name={issuerName(latestNew.display_name || latestNew.issuer)} /> : <span className="dim">None</span>}
        sub={latestNew ? `${shortFirm(firmOf(firms, latestNew.slug, latestNew.manager))}${latestNew.percent_of_class != null ? `, ${latestNew.percent_of_class.toFixed(1)}%` : ''}, filed ${day(latestNew.filing_date)}` : `None in the last ${days} days`}
      />
    </div>
  )
}

// ---------- consensus ----------
type GTab = 'owners' | 'value' | 'conviction'
/** The average share of the portfolios that own it, over the owners whose value is real (badValue). */
const avgBet = (r: Agg) => {
  const real = r.holders.filter((h) => h.value > 0)
  return real.reduce((s, h) => s + h.weight, 0) / Math.max(1, real.length)
}
export function Consensus() {
  title('Most owned stocks')
  const books = useLoad(loadBooks, [])
  const [tab, setTab] = useState<GTab>('owners')
  const [sector, setSector] = useState<string | null>(null)
  const agg = useMemo(() => (books.data ? aggregate(books.data) : null), [books.data])
  if (books.error) return <Failed error={books.error} what="the most owned stocks" />
  if (!agg || !books.data)
    return (
      <PageLoading
        what="Loading the most owned stocks"
        stats={0}
        rows={20}
        slowAfter={30_000}
        head={
          <div className="head">
            <div>
              <h1>Most owned stocks</h1>
              <p className="lede">Every stock and fund in the investors’ latest 13Fs, combined, with options and notes left out.</p>
            </div>
          </div>
        }
        progress={<BooksProgress what="Adding up every investor’s latest 13F" />}
        before={
          <>
            <TickStatsSkel />
            <section className="panel" aria-hidden>
              <header>
                <h2>By sector</h2>
              </header>
              <div className="body">
                <span className="skel" style={{ height: 10, width: '100%' }} />
                <div className="filters">
                  <span className="skel skel-chip" />
                  <span className="skel skel-chip" />
                  <span className="skel skel-chip" />
                  <span className="skel skel-chip" />
                </div>
              </div>
            </section>
            <TabsSkel labels={['Most investors', 'Most money', 'Biggest single bets']} />
          </>
        }
        cols={AGG_SKEL(['Owners', 'Of all investors', 'Value held', 'Of all money', 'Biggest bet', 'Average bet', 'Biggest holders'], [0, 2])}
      />
    )
  const n = books.data.length
  // Only what someone still holds: a stock every holder sold out of has a row (its sellers) but no owners.
  const held = agg.rows.filter((r) => r.holders.length)
  const base = sector ? held.filter((r) => r.sector === sector) : held
  const mixQ = [...new Set(books.data.map((b) => b.quarter))].sort().reverse().map((x) => [x, books.data!.filter((b) => b.quarter === x).length] as const)
  const list = [...base].sort(tab === 'owners' ? (a, b) => b.holders.length - a.holders.length || b.value - a.value : tab === 'value' ? (a, b) => b.value - a.value : (a, b) => b.maxWeight - a.maxWeight)
  const mix = sectorMix(agg.rows)
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Most owned stocks</h1>
          <p className="lede">Every stock and fund in all {n} investors’ latest 13Fs, combined, with options and notes left out.</p>
          {mixQ.length > 1 && (
            <p className="dim small head-note">From each investor’s latest 13F: {listing(mixQ.map(([x, k]) => `${num(k)} for ${quarterLabel(x)}`))}. Holdings are valued as of each 13F’s quarter end.</p>
          )}
        </div>
      </div>
      <ConsensusStats rows={held} total={agg.total} n={n} />
      <Panel title="By sector" right={<span className="dim hide-sm">Choose a sector to filter</span>}>
        <StackBar parts={mix.map((m) => ({ label: m.sector, value: m.value, color: SECTOR_COLOR[m.sector] ?? '#bab0ac' }))} />
        <div className="filters" role="group" aria-label="sector filter">
          <button className={!sector ? 'chip on' : 'chip'} aria-pressed={!sector} onClick={() => setSector(null)}>
            All sectors
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
          ['owners', 'Most investors'],
          ['value', 'Most money'],
          ['conviction', 'Biggest single bets'],
        ]}
        label="Ways to rank the stocks"
      />
      <TabPanel tab={tab}>
      <Panel title={`${num(list.length)} stocks`}>
        <ColKey
          items={[
            ['Of all investors', `How many of the ${n} investors own it.`, 'md'],
            ['Of all money', 'Its share of everything the investors hold combined.', 'lg'],
            ['Biggest bet', 'The largest share of any one investor’s portfolio it takes up.'],
            ['Average bet', 'Its average share of the portfolios that own it.', 'lg'],
          ]}
        />
        <Grid
          rank
          limit={150}
          rows={list}
          href={stockHref}
          cols={[
            aggCols.ticker,
            { ...aggCols.name, hideSm: true },
            aggCols.sector,
            { key: 'h', label: 'Owners', num: true, render: (r) => r.holders.length, sort: (r) => r.holders.length, title: 'How many of the investors own it' },
            { key: 'hp', label: 'Of all investors', num: true, hideSm: true, hide: 'md', render: (r) => <span className="wcell">{pct(r.holders.length / n, 0)}<Bar value={r.holders.length} max={n} /></span>, sort: (r) => r.holders.length },
            { key: 'v', label: 'Value held', num: true, hideSm: tab === 'conviction', render: (r) => usd(r.value), sort: (r) => r.value },
            { key: 'gw', label: 'Of all money', num: true, hideSm: true, hide: 'lg', render: (r) => pct(r.value / agg.total), sort: (r) => r.value, title: 'Share of everything the investors hold combined' },
            { key: 'mw', label: 'Biggest bet', num: true, hideSm: tab !== 'conviction', render: (r) => pct(r.maxWeight, 1), sort: (r) => r.maxWeight, title: 'Largest share of any one investor’s portfolio' },
            { key: 'aw', label: 'Average bet', num: true, hideSm: true, hide: 'lg', title: 'Average share of the portfolios that own it', render: (r) => pct(avgBet(r), 2), sort: avgBet },
            { key: 'who', label: 'Biggest holders', hideSm: true, hide: 'lg', render: (r) => <Who list={r.holders.filter((h) => h.value > 0).sort((a, b) => b.value - a.value)} max={2} /> },
          ]}
        />
      </Panel>
      </TabPanel>
    </div>
  )
}

/** Skeleton columns for the stock tables on Buys & sells and Most owned, in the proportions they render at: rank,
 * ticker, company and sector, then the page's own columns; on phones rank, ticker over name, and the page's columns
 * listed in `phone`. */
const AGG_SKEL = (rest: string[], phone: number[]): SkelCol[] => [
  { w: 3, pw: 9, num: true },
  { w: 11, pw: 56, two: true },
  { w: 13, on: 'wide' },
  { w: 13, on: 'wide' },
  ...rest.map((l, i): SkelCol => ({ w: /^(Who|Biggest holders)/.test(l) ? 18 : 8, pw: i === phone[0] ? 14 : 21, num: !/^(Who|Biggest holders)/.test(l), on: phone.includes(i) ? undefined : 'wide' })),
]

// ---------- filings: 13D/G and Form 4 ----------
type ETab = 'all' | '13dg' | 'f4' | 'market'
export function Filings() {
  title('Stakes and insider trades')
  const ev = useLoad(loadEvents, [])
  const ins = useLoad(loadInsiders, [])
  const firms = useFirms()
  const [tab, setTab] = useState<ETab>('all')
  const [own, setOwn] = useState(false)
  if (ev.error) return <Failed error={ev.error} what="the latest filings" />
  if (!ev.data) return <PageLoading what="Loading the latest filings" stats={4} rows={20} />
  const scoped = ev.data.events.filter((e) => inRoster(e.slug) && (own || !ownVehicle(e)))
  let list = scoped
  if (tab === '13dg') list = list.filter((e) => e.kind !== 'form4')
  if (tab === 'f4') list = list.filter((e) => e.kind === 'form4')
  // Every company's open-market insider trades: a tab only once that data exists (insiders.json).
  const market = ins.data?.length ? ins.data : null
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Stakes and insider trades</h1>
          <p className="lede">Stakes above 5% and insider trades the investors reported in the last {ev.data.window_days} days, between their quarterly 13Fs.</p>
        </div>
      </div>
      <FilingsStats list={scoped} firms={firms} days={ev.data.window_days} />
      <Tabs<ETab>
        value={tab}
        onChange={setTab}
        options={[
          ['all', 'All'],
          ['13dg', '5% stakes'],
          ['f4', 'Investor trades'],
          ...(market ? ([['market', 'Company insiders']] as [ETab, string][]) : []),
        ]}
        label="Kinds of filing"
      />
      <TabPanel tab={tab}>
      {tab !== 'market' || !market ? (
        <>
          <div className="filters" role="group" aria-label="filters">
            <button className={own ? 'chip on' : 'chip'} aria-pressed={own} onClick={() => setOwn(!own)}>
              Show filings on funds they run
            </button>
          </div>
          <Panel title={`${list.length} filings`}>
            <ColKey
              items={[
                ['13D and 13G', 'Filed within days of an investor passing 5% of a company. A 13D means it may push for change; a 13G means it stays passive.'],
                ['Form 4', 'Filed within two business days when an investor that is an insider (a director, an officer or a 10% owner) buys or sells.'],
                ['Stake', 'The share of the company the investor owns after the filing.'],
              ]}
            />
            <TagKey />
            <Grid rows={list} limit={150} href={(e) => (e.ticker && !ownVehicle(e) ? `/s/${e.ticker}` : null)} cols={eventCols(firms)} />
          </Panel>
        </>
      ) : (
        <Panel title="Insider buys and sells on the open market" right={<span className="dim hide-sm">Officers, directors and 10% owners, from Form 4</span>}>
          <Grid<Insider>
            limit={200}
            rows={market}
            href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
            cols={[
              { key: 'f', label: 'Filed', render: (r) => <span className="dim">{date(r.filing_date)}</span>, sort: (r) => r.filing_date },
              { key: 't', label: 'Company', render: (r) => <StockCell t={r.ticker} name={issuerName(r.issuer)} /> },
              { key: 'o', label: 'Insider', render: (r) => <span className="trunc">{r.owner}</span> },
              { key: 'r', label: 'Role', hideSm: true, render: (r) => <span className="dim trunc">{r.relationship}</span> },
              { key: 'c', label: 'Trade', render: (r) => <span className={`tag ${r.code === 'P' ? 'pos' : 'neg'}`}>{r.code === 'P' ? 'Bought' : 'Sold'}</span>, sort: (r) => r.code },
              { key: 'p', label: 'Price', num: true, hideSm: true, render: (r) => price(r.price) },
              { key: 'v', label: 'Value', num: true, render: (r) => <span className={r.code === 'P' ? 'pos' : 'neg'}>{usd(r.value_usd)}</span>, sort: (r) => r.value_usd },
              {
                key: 's',
                label: <span className="sr">SEC filing</span>,
                render: (r) => (
                  <a href={r.url} target="_blank" rel="noreferrer" className="dim ext">
                    SEC ↗
                  </a>
                ),
              },
            ]}
          />
        </Panel>
      )}
      </TabPanel>
    </div>
  )
}

// ---------- stock ----------
type STab = 'holders' | 'activity' | 'options' | 'filings'
const STOCK_TAB: Record<STab, string> = { holders: 'Investors that own it', activity: 'Who bought and sold it', options: 'Options on it', filings: 'Stakes and insider trades' }
export function Stock({ ticker }: { ticker: string }) {
  const s = useLoad(
    () =>
      loadStock(ticker).catch(async (e) => {
        // Not found only when the list of every stock loads and doesn't have it: if that list fails too, or has
        // the ticker but its file is missing, it's a data problem a retry may fix, not an unknown stock.
        const ix = await loadStockIndex().catch((x) => Promise.reject(new Error(`stock list: ${x?.message ?? x}`)))
        if (ix.stocks.some((r) => r.t === ticker)) throw new Error(`file missing: ${e?.message ?? e}`)
        const alias = ix.stocks.find((r) => r.a.includes(ticker))
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
  const firms = useFirms(!s.data)
  const [tab, setTab] = useState<STab>('holders')
  title(s.data ? `${issuerName(s.data.name)} (${ticker}): who owns it` : `${ticker}: who owns it`)
  if (s.error) return missing(s.error) ? <NotFound what={`None of the investors Holdterm follows reports ${ticker} in its latest 13F`} q={ticker} /> : <Failed error={s.error} what={ticker} />
  if (!s.data) return <PageLoading what={`Loading ${ticker}`} stats={4} rows={12} />
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
  const pick = (l: StockHolder[]) => l.filter((h) => inRoster(h.slug)).map(viaBook)
  const name = (h: StockHolder) => firmOf(firms, h.slug, h.firm || h.manager)
  const holders = pick(d.holders)
  const exited = pick(d.exited)
  const cnt = (c: string) => holders.filter((h) => h.change === c).length
  const nNew = cnt('new')
  const prevHolders = holders.length - nNew + exited.length
  // A held line whose value isn't real still owns it, but stays out of the value and the rankings (badValue).
  const valued = holders.filter((h) => !badValue(h.unreliable))
  const value = valued.reduce((x, h) => x + h.value, 0)
  const bigHolder = [...valued].sort((a, b) => b.value - a.value)[0]
  const movers = [...holders, ...exited].filter((h) => h.change && h.change !== 'unchanged').sort((a, b) => Math.abs(b.delta_value ?? 0) - Math.abs(a.delta_value ?? 0))
  const tickers = new Set(d.classes.map((c) => c.ticker))
  // Filings by the investors Holdterm follows, as on /filings.
  const events = (ev.data?.events ?? []).filter((e) => e.ticker && tickers.has(e.ticker) && inRoster(e.slug) && !ownVehicle(e))
  // When holders' latest 13Fs span quarters, rows from the newest one stand out (fresh filings this season).
  const holderQs = [...new Set(holders.map((h) => h.quarter))].sort()
  const freshQ = holderQs.length > 1 ? holderQs[holderQs.length - 1] : undefined
  // The summary's biggest buyer and seller. Mid-season it leads with this season's 13Fs, then the earlier ones, so a
  // Q2 trade doesn't read as the latest news while half the holders have filed for Q3.
  const most = (l: StockHolder[], when: boolean) => {
    const b = l.find((h) => (h.delta_value ?? 0) > 0)
    const s = l.find((h) => (h.delta_value ?? 0) < 0)
    const at = (h: StockHolder) => (when ? ` in ${quarterLabel(h.quarter)}` : '')
    // Each clause has its own comma ("bought the most, adding $1.7B"), so the two join with ", and".
    return [
      b && `${name(b)} bought the most, ${b.change === 'new' ? `opening a ${usd(b.delta_value)} position` : `adding ${usd(b.delta_value)}`}${at(b)}`,
      s && `${name(s)} sold the most, ${s.change === 'exited' ? `selling out of ${usd(-(s.delta_value ?? 0))}` : `cutting ${usd(-(s.delta_value ?? 0))}`}${at(s)}`,
    ]
      .filter(Boolean)
      .join(', and ')
  }
  const freshMovers = freshQ ? movers.filter((h) => h.quarter === freshQ) : []
  const freshFiled = freshQ ? [...holders, ...exited].filter((h) => h.quarter === freshQ).length : 0
  const earlier = most(movers.filter((h) => h.quarter !== freshQ), true)
  const trades = !freshQ
    ? earlier && `${earlier}.`
    : `${freshMovers.length ? `In ${quarterLabel(freshQ)} 13Fs, ${most(freshMovers, false)}.` : freshFiled === 1 ? `The one ${quarterLabel(freshQ)} 13F filed so far didn’t buy or sell it.` : `None of the ${plural(freshFiled, `${quarterLabel(freshQ)} 13F`)} filed so far bought or sold it.`}${earlier ? ` Among earlier 13Fs, ${earlier}.` : ''}`
  const holderCols: Col<StockHolder>[] = [
    // Phones show which 13F under the name instead of an "As of" column, so the name has room to show in full.
    {
      key: 'm',
      label: 'Investor',
      link: true,
      render: (h) => (
        <span className="holder">
          <Firm name={name(h)} strong={inRoster(h.slug)} />
          <span className={`row-sub show-sm${h.quarter === freshQ ? ' fresh' : ''}`}>{quarterLabel(h.quarter)} 13F</span>
        </span>
      ),
      sort: (h) => name(h),
    },
    // A held row shows the numbers its class says aren't real (unreliableOf) as filed, greyed, so they aren't read
    // as real; a wrong value has no weight, so its weight is a dash.
    { key: 'w', label: 'Weight', num: true, render: (h) => (badValue(h.unreliable) ? <AsFiled why={h.unreliable!} /> : pct(h.weight)), sort: (h) => h.weight, title: 'Share of the investor’s portfolio' },
    // Rows can come from different quarters' 13Fs, so the column says what it compares rather than "This quarter".
    { key: 'c', label: 'Change', title: 'Compared with the investor’s previous 13F', render: (h) => <ChangeTag change={h.change} share_change={h.prev_shares != null ? h.shares - h.prev_shares : null} prev_shares={h.prev_shares} held={h.unreliable} />, sort: (h) => h.delta_value ?? 0 },
    { key: 'sh', label: 'Shares', num: true, hideSm: true, render: (h) => <Filed held={h.unreliable} fig="shares">{num(h.shares)}</Filed>, sort: (h) => h.shares },
    { key: 'v', label: 'Value', num: true, hideSm: true, render: (h) => <Filed held={h.unreliable} fig="value">{usd(h.value)}</Filed>, sort: (h) => h.value },
    { key: 'q', label: 'As of', num: true, hideSm: true, render: (h) => (h.quarter === freshQ ? <span className="qtag">{quarterLabel(h.quarter)}</span> : <span className="dim">{quarterLabel(h.quarter)}</span>), sort: (h) => h.quarter, title: 'The quarter of the 13F each row comes from; the newest are highlighted' },
  ]
  const fundHref = (h: StockHolder) => (inRoster(h.slug) ? fundPath(fundSlug(h.slug)) : null)
  // Holders whose line is held (unreliableOf): left out of the trades, and the trades tab says so.
  const heldNames = holders.filter((h) => h.unreliable).map((h) => shortFirm(name(h)))
  const held = holders.length > 0 || exited.length > 0 || pick(d.options).length > 0
  return (
    <div className="page">
      <Crumbs parent={['/consensus', 'Most owned stocks']} here={issuerName(d.name)} />
      <div className="head">
        <div>
          <h1>{issuerName(d.name)}</h1>
          <div className="chips">
            {[...new Set(d.classes.map((c) => c.ticker))].map((t) => (
              <span key={t} className="ticker-chip">
                {t}
              </span>
            ))}
            <span className="sector-chip">
              <Sector s={d.sector} full />
            </span>
          </div>
          {held && events.length > 0 && <p className="activity-line">{ev.data ? <ActivityLine events={events} days={ev.data.window_days} name={(e) => firmOf(firms, e.slug, e.manager)} open={() => (setTab('filings'), document.querySelector('.tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))} /> : '\u00a0'}</p>}
          {/* One plain line on where the numbers come from; the CUSIP 13Fs use is in its tooltip. */}
          {held && (
            <div className="meta">
              <span title={`CUSIP ${d.classes.map((c) => `${c.cusip}${d.classes.length > 1 ? ` (${c.ticker})` : ''}`).join(', ')}`}>{quarterMix(holders)}</span>
            </div>
          )}
        </div>
        <Follow kind="stocks" id={d.ticker} />
      </div>
      {!held ? (
        // Nobody Holdterm follows owns it, sold it last quarter or holds options on it, so there are no numbers to show:
        // one plain panel says so instead of four zero cards and three empty tabs. Any stake or insider filing still shows.
        <>
          <Panel title="Who owns it">
            <Empty
              title={`None of the ${roster.funds.length} investors Holdterm follows owns ${issuerName(d.name)}`}
              hint="It shows up here once one of them reports it in a 13F. Those are filed each quarter, up to 45 days after the quarter ends."
              action={['See the stocks they own most', '/consensus']}
            />
          </Panel>
          {events.length > 0 && (
            <Panel title="Stakes and insider trades">
              <Grid rows={events} cols={eventCols(firms)} />
            </Panel>
          )}
        </>
      ) : (
      <>
      <p className="summary">
        {/* The cards below give the counts and the total; the summary says what they can't: who holds the most and who moved the most money. */}
        {holders.length ? (
          <>
            {holders.length === 1 ? <>{name(bigHolder)} is the only investor Holdterm follows that owns it, {usd(bigHolder.value)} worth. </> : <>{name(bigHolder)} holds the most, {usd(bigHolder.value)}, or {pct(bigHolder.value / value, 0)} of what these investors hold. </>}
            {/* Each trade is dated by its own 13F's quarter: holders' latest 13Fs can be for different quarters (Sanders' Q3 buy, H&H's Q2 sale). */}
            {trades}
          </>
        ) : (
          <>None of the investors Holdterm follows reports {issuerName(d.name)} in its latest 13F.</>
        )}
      </p>
      <div className="stats" role="list" aria-label="Ownership at a glance">
        <Stat label="Investors that own it" value={holders.length} sub={holders.length === prevHolders ? `Same as in their previous 13Fs` : `${holders.length > prevHolders ? 'Up' : 'Down'} from ${prevHolders} in their previous 13Fs`} />
        <Stat label="Value they hold" value={usd(value)} sub="In their latest 13Fs" />
        <Stat label="Bought more" value={plural(nNew + cnt('added'), 'investor')} tone={nNew + cnt('added') > 0 ? 'pos' : undefined} sub={`${num(nNew)} new, ${num(cnt('added'))} added`} />
        <Stat label="Sold some or all" value={plural(cnt('trimmed') + exited.length, 'investor')} tone={cnt('trimmed') + exited.length > 0 ? 'neg' : undefined} sub={`${num(cnt('trimmed'))} trimmed, ${num(exited.length)} sold out`} />
      </div>
      {holders.length > 0 && (
        <Panel title="Biggest bets on it" right={<span className="dim hide-sm">Share of each investor’s portfolio</span>}>
          <HBars title="Investors with the most of their portfolio in it" fmt={(v) => pct(v, 1)} labelWidth={200} rows={[...valued].sort((a, b) => b.weight - a.weight).slice(0, 6).map((h) => ({ key: h.slug, href: fundHref(h), label: <span title={name(h)}>{shortFirm(name(h))}</span>, value: h.weight }))} />
        </Panel>
      )}
      <Tabs<STab>
        value={tab}
        onChange={setTab}
        options={[
          ['holders', `Investors ${holders.length}`],
          ['activity', `Bought and sold ${movers.length}`],
          ...(pick(d.options).length ? ([['options', `Options ${pick(d.options).length}`]] as [STab, string][]) : []),
          ['filings', `Stakes and insider trades ${events.length}`],
        ]}
        label={`${issuerName(d.name)} ownership`}
      />
      <TabPanel tab={tab}>
      {/* A key for the highlighted rows, which on phones are blue text and could read as links. */}
      <Panel title={tab === 'activity' ? activityTitle(movers) : STOCK_TAB[tab]} right={freshQ && (tab === 'holders' || tab === 'activity') ? <span className="fresh-key"><b>Blue</b> = filed for {quarterLabel(freshQ)}</span> : undefined}>
        {tab === 'holders' && <Grid rank rows={holders} initial={['w', 'desc']} href={fundHref} cols={holderCols} empty={<Empty title="None of the investors Holdterm follows owns it" hint={`Holdterm follows ${roster.funds.length} concentrated, long-term investors. A stock shows up here once one of them reports it in a 13F.`} action={['See the stocks they own most', '/consensus']} />} />}
        {tab === 'activity' && (
          <>
          <Grid
            rows={movers}
            href={fundHref}
            // Phones keep the quarter each trade is from; the weight is on the Investors tab.
            cols={[holderCols[0], { ...holderCols[2], label: 'What changed' }, { key: 'd', label: 'Trade size', num: true, render: (h) => <span className={(h.delta_value ?? 0) >= 0 ? 'pos' : 'neg'}>{signedUsd(h.delta_value)}</span>, sort: (h) => h.delta_value ?? 0 }, { ...holderCols[1], hideSm: true }, holderCols[5]]}
          />
          {heldNames.length > 0 && (
            <p className="dim small held-note">
              Not counted here: {heldNames.join(', ').replace(/, ([^,]*)$/, ' and $1')}. {heldNames.length === 1 ? 'Its 13F figures don’t' : 'Their 13F figures don’t'} fit together, so no trade is counted.
            </p>
          )}
          </>
        )}
        {tab === 'options' && (
          <Grid
            rows={pick(d.options)}
            href={fundHref}
            cols={[holderCols[0], { key: 'pc', label: 'Type', render: (h) => <span className={`tag ${h.put_call === 'CALL' ? 'pos' : 'neg'}`}>{h.put_call === 'CALL' ? 'Call' : 'Put'}</span> }, { key: 'v', label: 'Value of shares', num: true, render: (h) => usd(h.value), sort: (h) => h.value }, holderCols[1]]}
          />
        )}
        {tab === 'filings' && <Grid rows={events} cols={eventCols(firms)} empty={<Empty title="No stake or insider filings in the last 30 days" hint="None of these investors filed a 13D, 13G or Form 4 on this company in that time." action={['See every recent filing', '/filings']} />} />}
      </Panel>
      </TabPanel>
      </>
      )}
    </div>
  )
}

/** The trades tab's heading names the quarter, or says the trades come from each investor's latest 13F when
 * those are for different quarters (the As of column says which). */
function activityTitle(rows: StockHolder[]) {
  const qs = [...new Set(rows.map((h) => h.quarter))]
  return qs.length === 1 ? `Who bought and sold it in ${quarterLabel(qs[0])}` : 'Who bought and sold it, in each investor’s latest 13F'
}
const FORM: Record<Event['kind'], string> = { '13d': '13D', '13g': '13G', form4: 'Form 4' }
/** Where a stock page's numbers come from, naming the quarters when its holders' latest 13Fs differ:
 * "From each investor’s latest 13F with the SEC: 12 for Q3 2026, 31 for Q2 2026". */
function quarterMix(holders: StockHolder[]) {
  const by = new Map<string, number>()
  for (const h of holders) by.set(h.quarter, (by.get(h.quarter) ?? 0) + 1)
  const qs = [...by].sort((a, b) => b[0].localeCompare(a[0]))
  if (qs.length < 2) return `From each investor’s latest 13F with the SEC${qs.length ? `, for ${quarterLabel(qs[0][0])}` : ''}`
  return `From each investor’s latest 13F with the SEC: ${qs.map(([q, n]) => `${num(n)} for ${quarterLabel(q)}`).join(', ')}`
}
/** The newest 13D/G or Form 4 on a stock in one sentence, with a count of the rest. */
function ActivityLine({ events, days, name, open }: { events: Event[]; days: number; name: (e: Event) => string; open: () => void }) {
  const e = events[0]
  if (!e) return <span className="dim">No new 5% stakes or insider trades by these investors in the last {days} days.</span>
  const p = e.percent_of_class != null ? `${e.percent_of_class.toFixed(e.percent_of_class < 10 ? 1 : 0)}%` : null
  const what: Record<string, string> = {
    new_stake: p ? `new stake of ${p}` : 'new stake above 5%',
    stake_update: p ? `stake now ${p}` : 'stake updated',
    below_threshold: 'stake now below 5%',
    buy: e.value_usd ? `bought ${usd(e.value_usd)} on the open market` : 'bought on the open market',
    sell: e.value_usd ? `sold ${usd(e.value_usd)} on the open market` : 'sold on the open market',
    mixed: 'bought and sold on the open market',
    other: 'no open-market trade',
  }
  return (
    <>
      <span className={`dot-live ${e.action === 'sell' || e.action === 'below_threshold' ? 'neg' : e.action === 'buy' || e.action === 'new_stake' ? 'pos' : ''}`} aria-hidden />
      Latest filing: <strong>{shortFirm(name(e))}</strong>, {FORM[e.kind]} on {day(e.filing_date)}: {what[e.action] ?? 'filed'}.
      {events.length > 1 && (
        <>
          {' '}
          <button type="button" className="linkbtn" onClick={open}>
            {plural(events.length - 1, 'more filing')} in the last {days} days
          </button>
        </>
      )}
    </>
  )
}

// ---------- alerts (paid) ----------
function Check() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden style={{ marginTop: 3, color: 'var(--pos)' }}>
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
const CHANNEL_LIST: { name: string; what: string; live: boolean | 'soon' }[] = [
  { name: 'Email', what: 'A clear summary of each filing: what was bought and sold, in dollars, with links to the portfolio and the SEC filing.', live: true },
  { name: 'Phone and browser push', what: 'A notification on your phone or computer the moment we have the filing. On iPhone, add Holdterm to your home screen first.', live: channels.push || 'soon' },
  { name: 'Discord and Slack', what: 'Paste a channel webhook and every alert posts there, ready for a team or an investing club.', live: channels.chat || 'soon' },
  { name: 'Telegram', what: 'Alerts as messages from your own Telegram bot.', live: channels.chat || 'soon' },
  { name: 'Private RSS feed', what: 'Every alert in a private feed for your reader, or for automations of your own.', live: channels.chat || 'soon' },
]
export function Alerts() {
  title('Alerts')
  const [yearly, setYearly] = useState(false)
  const r = useLoad(loadSamples, [])
  const s = r.data
  const link = yearly ? checkout.yearly : checkout.monthly
  const live = CHANNEL_LIST.filter((c) => c.live === true)
  const soon = CHANNEL_LIST.filter((c) => c.live !== true)
  const plan = (
    <div className="ap-plan">
      <div className="filters" role="group" aria-label="Billing period">
        <button className={!yearly ? 'chip on' : 'chip'} aria-pressed={!yearly} onClick={() => setYearly(false)}>
          Monthly
        </button>
        <button className={yearly ? 'chip on' : 'chip'} aria-pressed={yearly} onClick={() => setYearly(true)}>
          Yearly <span className="pos">save {Math.round((1 - PRICE.yearly / (PRICE.monthly * 12)) * 100)}%</span>
        </button>
      </div>
      <div className="price">
        <span className="big">${yearly ? PRICE.yearly : PRICE.monthly}</span>
        <span className="dim">
          /{yearly ? 'year' : 'month'}
          {yearly && ` ($${(PRICE.yearly / 12).toFixed(2)} a month)`} after a {PRICE.trialDays}-day free trial
        </span>
      </div>
      <a className="btn big-btn" href={link}>
        Start your free trial
      </a>
      <p className="dim small">
        Cancel any time. Checkout is by Stripe, billed by Factor Dynamics, which runs Holdterm. <A to="/terms">Terms</A> · <A to="/privacy">Privacy</A> · Already a member? <A to="/account">Sign in</A>
      </p>
    </div>
  )
  return (
    <div className="page alerts-page">
      <section className="ap-hero">
        <div className="ap-hero-text">
          <p className="eyebrow">Holdterm Alerts</p>
          <h1>{channels.push ? 'Know when your investors make a move' : 'An email when your investors make a move'}</h1>
          {/* Say only what ships: email today; push and chat join the sentence as they go live. */}
          <p className="lede">
            When a fund you follow reports its portfolio, a new 5% stake or an insider trade to the SEC, you get a plain-English summary within hours of the filing: what it bought, what it sold and how much.{' '}
            {channels.push && channels.chat ? 'By email, on your phone or in your team’s chat.' : channels.push ? 'By email or on your phone.' : channels.chat ? 'By email or in your team’s chat.' : ''}
          </p>
          {plan}
        </div>
        <div className="ap-hero-art">{s ? channels.push ? <PushPreview s={s} /> : <InboxPreview s={s} /> : <div className={`${channels.push ? 'ap-phone' : 'ap-inbox'} ap-skeleton`} aria-hidden />}</div>
      </section>

      <section className="ap-section">
        <h2>{live.length > 1 ? 'Choose where alerts arrive' : 'Where alerts arrive'}</h2>
        <p className="dim">{soon.length ? (live.length > 1 ? 'These are included in the price. Pick one or several in your account.' : 'Alerts come by email.') : 'Every channel is included in the price. Pick one or several in your account.'}</p>
        <div className="ap-channels">
          {live.map((c) => (
            <div className="ap-channel" key={c.name}>
              <div className="ap-channel-head">
                <b>{c.name}</b>
                <span className="tag pos-tag">Included</span>
              </div>
              <p>{c.what}</p>
            </div>
          ))}
          {/* That more is planned is a card of its own, plainly marked, next to what ships today. */}
          {soon.length > 0 && (
            <div className="ap-channel ap-channel-soon">
              <div className="ap-channel-head">
                <b>More on the way</b>
              </div>
              {/* No channel is named until it is scheduled to ship. */}
              <p>More ways to get alerts are planned. Members get them at no extra cost.</p>
            </div>
          )}
        </div>
      </section>

      <section className="ap-section ap-split">
        <div>
          <h2>A real alert, by email</h2>
          <p className="dim">This is the email members got for {s ? `${s.filing.manager}’s ${quarterLabel(s.filing.quarter)} 13F` : 'a recent 13F'}, exactly as sent.</p>
          <ul className="ap-points">
            <li>
              <Check /> <span><b>The headline first.</b> Who filed, what kind of filing, and when.</span>
            </li>
            <li>
              <Check /> <span><b>In plain English.</b> How much was bought and sold, and the biggest move.</span>
            </li>
            <li>
              <Check /> <span><b>The trades that matter.</b> The five biggest buys and sells, sized in dollars.</span>
            </li>
            <li>
              <Check /> <span><b>One tap to check.</b> Links to the full portfolio on Holdterm and to the filing on SEC EDGAR.</span>
            </li>
            <li>
              <Check /> <span><b>Only what you follow.</b> Pick funds and stocks, or follow nobody to hear about every fund we track.</span>
            </li>
          </ul>
        </div>
        {s ? <EmailPreview s={s} /> : r.error ? <Failed error={r.error} what="the sample alert" /> : <Loading what="Building the sample email" />}
      </section>

      {channels.chat && (
        <section className="ap-section ap-split reverse">
          <div>
            <h2>Or straight into your chat</h2>
            <p className="dim">The same alerts, formatted for each app, so a team or an investing club sees every filing together.</p>
          </div>
          {s ? <ChatPreviews s={s} /> : <Loading what="Building the previews" rows={6} />}
        </section>
      )}

      <section className="ap-section ap-cta">
        <div>
          <h2>Try it free for {PRICE.trialDays} days</h2>
          <p className="dim">Then ${PRICE.monthly} a month or ${PRICE.yearly} a year. The rest of Holdterm stays free, with no ads.</p>
        </div>
        {/* The plan picker is at the top of the page; here, one button for the period chosen there. */}
        <div className="ap-cta-act">
          <a className="btn big-btn" href={link}>
            Start your free trial{yearly ? `, $${PRICE.yearly} a year` : ''}
          </a>
          <p className="dim small">
            Cancel any time. Already a member? <A to="/account">Sign in</A>
          </p>
        </div>
      </section>
      {s && <SampleSources s={s} />}
    </div>
  )
}

// ---------- account ----------
const when = (v: number | string | null | undefined) => {
  if (v == null) return ''
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}
/** Plans that include Holdterm alerts: Holdterm's own, and Copybook Pro and Fund. Copybook's Copy plan does not. */
const COVERED = new Set(['holdterm', 'pro', 'fund'])
const covered = (m: Member) => m.active && COVERED.has(m.plan)
const COPYBOOK_ACCOUNT = 'https://copybook.factordynamics.com/account/'
/** The member's plan in a sentence, with the tone of its status pill. */
function planLine(m: Member): { pill: string; tone: 'pos' | 'neg' | 'acc'; text: string } {
  const end = when(m.period_end)
  const price = m.interval === 'yearly' ? `$${PRICE.yearly} a year` : `$${PRICE.monthly} a month`
  if (!m.active) return { pill: m.status === 'canceled' ? 'Canceled' : 'Inactive', tone: 'neg', text: 'Alerts are off. Start a new plan to turn them back on; what you follow is kept.' }
  if (m.plan === 'copy') return { pill: 'Copy plan', tone: 'acc', text: 'Your Copy plan already sends filing alerts on Copybook. Holdterm alerts are not part of it.' }
  if (!COVERED.has(m.plan)) return { pill: 'Not included', tone: 'acc', text: 'Holdterm alerts are not part of your plan.' }
  if (m.plan !== 'holdterm') return { pill: 'Included', tone: 'pos', text: `Holdterm is included with your ${m.plan === 'fund' ? 'Fund' : 'Pro'} plan. Alerts for investors you follow here arrive as Copybook alerts.` }
  if (m.cancel_at_period_end) return { pill: 'Ending', tone: 'neg', text: `Alerts stop on ${end || 'the end of this period'}. Resume any time in billing.` }
  if (m.status === 'trialing')
    return m.has_payment_method === false
      ? { pill: 'Free trial', tone: 'acc', text: `Your free trial ends on ${end || 'its last day'}. Add a card in billing before then to keep alerts on at ${price}.` }
      : { pill: 'Free trial', tone: 'acc', text: `Your free trial ends on ${end || 'its last day'}, then ${price} unless you cancel.` }
  if (m.has_payment_method === false) return { pill: 'Card needed', tone: 'neg', text: `No card is on file, so the ${end ? `renewal on ${end}` : 'next renewal'} will fail. Add one in billing to keep alerts on at ${price}.` }
  return { pill: 'Active', tone: 'pos', text: end ? `Renews on ${end} at ${price}.` : 'Your plan is active.' }
}
export function Account() {
  title('Account')
  const [member, setMember, err] = useMember()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [f, setF] = useState<Follows | null>(null)
  const ix = useLoad(loadIndex, [])
  const [pending, setPending] = useState(() => /[?&](session_id|login)=/.test(location.search))
  const [welcome, setWelcome] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    startFromUrl().then(
      (m) => {
        if (m) (setMember(m), setWelcome(true))
        setPending(false)
      },
      (e: Error) => (setProblem(e.message), setPending(false)),
    )
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (member && covered(member)) follows().then(setF).catch(() => {})
  }, [member])
  if (!api) return null
  if (pending) return <Loading what="Signing you in" />
  if (!member)
    return (
      <div className="page acct-signin">
        <div className="acct-card">
          <AppIcon size={40} />
          <h1>Sign in to Holdterm</h1>
          <p className="dim">For alert members. We’ll email you a link that signs you in; there’s no password.</p>
          {(problem || err) && <div className="notice warn">{problem || err}</div>}
          {sent ? (
            <div className="notice" role="status">
              <b>Check your inbox.</b> If {email} has a Holdterm plan, a sign-in link is on its way. It works once, for 15 minutes.
            </div>
          ) : (
            <form
              className="acct-form"
              onSubmit={(e) => {
                e.preventDefault()
                setProblem(null)
                requestLogin(email).then(
                  () => setSent(true),
                  (e: Error) => (e.message === UNAVAILABLE ? setProblem(UNAVAILABLE) : setSent(true)),
                )
              }}
            >
              <label htmlFor="email">Email address</label>
              <input id="email" type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn big-btn">Email me a sign-in link</button>
            </form>
          )}
          <p className="small acct-foot">
            New to alerts? <A to="/alerts">Start a {PRICE.trialDays}-day free trial</A>
            <br />
            <span className="dim">To change or cancel billing without signing in, use the </span>
            <a href={checkout.portal}>Stripe billing portal</a>
            <span className="dim">.</span>
          </p>
        </div>
      </div>
    )
  const plan = planLine(member)
  return (
    <div className="page acct">
      <header className="acct-head">
        <div>
          <h1>Your alerts</h1>
          <p className="lede">Signed in as {member.email}</p>
        </div>
        <button
          className="btn ghost"
          onClick={() => {
            signOut()
            setMember(null)
          }}
        >
          Sign out
        </button>
      </header>
      {problem && <div className="notice warn">{problem}</div>}
      {welcome && covered(member) && (
        <div className="notice acct-welcome" role="status">
          <b>You’re in, and alerts are on.</b> Follow nobody and you hear about every investor Holdterm tracks, or choose investors and stocks below. You can also use <b>Follow</b> on any investor or stock page.
        </div>
      )}
      <div className="acct-grid">
        <section className="acct-box">
          <div className="acct-box-head">
            <h2>Plan</h2>
            <span className={`tag ${plan.tone}`}>{plan.pill}</span>
          </div>
          <p>{plan.text}</p>
          <div className="acct-actions">
            {member.active && member.plan === 'copy' ? (
              <>
                <a className="btn" href={COPYBOOK_ACCOUNT}>
                  Go to your Copybook account
                </a>
                <A to="/alerts" className="btn ghost">
                  Holdterm alerts, ${PRICE.monthly} a month
                </A>
              </>
            ) : member.active && !COVERED.has(member.plan) ? (
              <A to="/alerts" className="btn">
                See plans
              </A>
            ) : member.active ? (
              <button className="btn ghost" onClick={() => openPortal().catch((e: Error) => setProblem(e.message))}>
                Manage billing
              </button>
            ) : (
              <A to="/alerts" className="btn">
                See plans
              </A>
            )}
          </div>
        </section>
        <section className="acct-box">
          <div className="acct-box-head">
            <h2>Where alerts go</h2>
          </div>
          <ul className="acct-channels">
            <li>
              <span>
                <b>Email</b>
                <span className="dim">{member.email}</span>
              </span>
              <span className={`tag ${covered(member) ? 'pos' : 'dim'}`}>{covered(member) ? 'On' : 'Off'}</span>
            </li>
            {/* Only channels that ship are named; the rest is one line, as on the Alerts page. */}
            {(
              [
                ['Phone and browser push', channels.push],
                ['Discord, Slack and Telegram', channels.chat],
                ['Private RSS feed', channels.chat],
              ] as [string, boolean][]
            )
              .filter(([, live]) => live)
              .map(([name]) => (
                <li key={name}>
                  <span>
                    <b>{name}</b>
                  </span>
                  <span className="tag">Available</span>
                </li>
              ))}
          </ul>
          {!(channels.push && channels.chat) && <p className="dim small">More ways to get alerts are planned. Members get them at no extra cost.</p>}
        </section>
      </div>
      {covered(member) && (
        <>
          <FundFollows ms={ix.data ? funds(ix.data) : null} f={f} setF={setF} />
          <section className="acct-box">
            <div className="acct-box-head">
              <h2>Stocks you follow</h2>
            </div>
            <p className="dim">Get an alert when any investor Holdterm tracks files a 13D, 13G or Form 4 on these companies.</p>
            <StockFollows f={f} setF={setF} />
          </section>
        </>
      )}
    </div>
  )
}
/** Investors you get alerts for: the ones you follow as removable chips, and a search to add more. */
function FundFollows({ ms, f, setF }: { ms: Manager[] | null; f: Follows | null; setF: (f: Follows) => void }) {
  const [q, setQ] = useState('')
  const on = new Set(f?.investors ?? [])
  const toggle = (slug: string) => setFollow('investors', slug, !on.has(slug)).then(setF, () => {})
  const byFirm = new Map((ms ?? []).map((m) => [m.slug, m]))
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hits = (ms ?? []).filter((m) => !on.has(m.slug) && words.every((w) => `${m.firm} ${m.pm ?? ''} ${m.name}`.toLowerCase().includes(w))).slice(0, words.length ? 12 : 8)
  return (
    <section className="acct-box">
      <div className="acct-box-head">
        <h2>Investors you follow</h2>
        <span className="dim small">{on.size ? `${on.size} of ${ms?.length ?? '…'}` : `All ${ms?.length ?? ''}`}</span>
      </div>
      <p className="dim">{on.size ? 'You get alerts for these investors’ 13F, 13D, 13G and Form 4 filings.' : 'You’re following nobody yet, so you get alerts for every investor Holdterm tracks. Add investors to hear only about them.'}</p>
      {!!on.size && (
        <ul className="acct-chips" aria-label="Investors you follow">
          {[...on].map((slug) => (
            <li key={slug}>
              <A to={fundPath(slug)}>{byFirm.get(slug)?.firm ?? slug}</A>
              <button aria-label={`Stop following ${byFirm.get(slug)?.firm ?? slug}`} onClick={() => toggle(slug)}>
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor="fund-q" className="acct-label">
        Add an investor
      </label>
      <input id="fund-q" className="acct-input" type="search" placeholder="Search by firm or manager, e.g. Berkshire" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {!ms ? (
        <Loading what="Loading investors" rows={4} />
      ) : (
        <ul className="acct-results" aria-label={words.length ? 'Matching investors' : 'Largest investors'}>
          {hits.map((m) => (
            <li key={m.slug}>
              <span className="acct-result-name">
                <A to={fundPath(m.slug)}>{m.firm}</A>
                <span className="dim small">{[m.pm, `${usd(m.total_value)} portfolio`].filter(Boolean).join(' · ')}</span>
              </span>
              <button className="btn ghost small-btn" disabled={!f} onClick={() => toggle(m.slug)}>
                Follow
              </button>
            </li>
          ))}
          {!hits.length && <li className="dim">No investor matches “{q.trim()}”.</li>}
        </ul>
      )}
    </section>
  )
}
function StockFollows({ f, setF }: { f: Follows | null; setF: (f: Follows) => void }) {
  const [t, setT] = useState('')
  const [bad, setBad] = useState(false)
  const list = f?.stocks ?? []
  return (
    <div>
      {!!list.length && (
        <ul className="acct-chips" aria-label="Stocks you follow">
          {list.map((x) => (
            <li key={x}>
              <A to={stockHref({ ticker: x })!}>{x}</A>
              <button aria-label={`Stop following ${x}`} onClick={() => setFollow('stocks', x, false).then(setF, () => {})}>
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="acct-add"
        onSubmit={(e) => {
          e.preventDefault()
          const v = t.trim().toUpperCase()
          const ok = /^[A-Z][A-Z0-9.-]{0,9}$/.test(v)
          setBad(!ok)
          if (ok && !list.includes(v)) setFollow('stocks', v, true).then(setF, () => {})
          if (ok) setT('')
        }}
      >
        <label htmlFor="tk" className="acct-label">
          Add a stock by ticker
        </label>
        <div>
          <input id="tk" className="acct-input" placeholder="e.g. AAPL" value={t} onChange={(e) => setT(e.target.value)} autoComplete="off" aria-invalid={bad} aria-describedby={bad ? 'tk-err' : undefined} />
          <button className="btn" disabled={!f}>
            Add
          </button>
        </div>
        {bad && (
          <p id="tk-err" className="neg small" role="alert">
            Enter a ticker such as AAPL or BRK.B.
          </p>
        )}
      </form>
    </div>
  )
}

// ---------- first-visit guide ----------
// Four short points on the home page for new visitors (dismissed for good with "Got it"), and the same points
// at length on /guide. Decided before the first paint, like the upsell, so nothing shifts.
const GUIDE_KEY = 'holdterm-guide-dismissed'
const GUIDE: { icon: ReactNode; t: string; p: string; short: string }[] = [
  {
    icon: <path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V3.5Zm8 0V8h4M9 12h6M9 15.5h6" />,
    t: 'What a 13F is',
    short: 'A quarterly list of US stocks that every manager with $100M or more must file with the SEC.',
    p: 'Every manager with more than $100 million in US stocks must tell the SEC what it owns, once a quarter, on Form 13F. Holdterm reads those filings for investors who hold few stocks for years.',
  },
  {
    icon: <path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 4v4.5l3 2" />,
    t: 'How current it is',
    short: 'A snapshot of the last day of the quarter, filed up to 45 days later. Not today’s portfolio.',
    p: 'A 13F shows holdings on the last day of the quarter and can arrive up to 45 days later. Treat it as a snapshot, not today’s portfolio. Stake (13D/G) and insider (Form 4) filings come within days.',
  },
  {
    icon: <path d="M4 18.5h16M6.5 15.5v-4M11 15.5v-9M15.5 15.5V9M20 15.5v-6" />,
    t: 'How to read a fund',
    short: 'Added, Trimmed, New and Sold out compare share counts, so a price move is never a trade.',
    p: 'Holdings are sorted by share of the fund. “Added”, “Trimmed”, “New” and “Sold out” compare share counts with the previous quarter, so a price move alone never counts as buying or selling.',
  },
  {
    icon: <path d="M12 4.5 4.5 8v4c0 4.2 3.2 7.2 7.5 8 4.3-.8 7.5-3.8 7.5-8V8L12 4.5Zm-3 8 2 2 4-4" />,
    t: 'What it leaves out',
    short: 'No shorts, cash or foreign shares. Read it as evidence, not advice.',
    p: 'Short positions, cash, foreign-listed shares and most bonds are not in a 13F. Options and notes appear separately. A sale can be risk management, not a change of mind: read it as evidence, not advice.',
  },
]
function GuideIcon({ children }: { children: ReactNode }) {
  return (
    <span className="guide-icon" aria-hidden>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  )
}
function FirstVisit() {
  const [open, setOpen] = useState(() => {
    try {
      return !localStorage.getItem(GUIDE_KEY)
    } catch {
      return true
    }
  })
  if (!open) return null
  const close = () => {
    try {
      localStorage.setItem(GUIDE_KEY, String(Date.now()))
    } catch {}
    setOpen(false)
    document.querySelector<HTMLElement>('main')?.focus()
  }
  return (
    <section className="guide" aria-labelledby="guide-h">
      <div className="guide-head">
        <h2 id="guide-h">New to 13F filings? Four things worth knowing</h2>
        <div className="guide-actions">
          <A to="/guide" className="btn ghost">
            Read the full guide
          </A>
          <button type="button" className="btn" onClick={close}>
            Got it
          </button>
        </div>
      </div>
      <ol className="guide-strip">
        {GUIDE.map((g) => (
          <li key={g.t}>
            <GuideIcon>{g.icon}</GuideIcon>
            <div>
              <h3>{g.t}</h3>
              <p>{g.short}</p>
            </div>
          </li>
        ))}
      </ol>
      {/* Phones: one line, so the filings stay near the top. */}
      <div className="guide-mini">
        <p>
          <strong>New to 13F filings?</strong> They’re quarterly snapshots, filed up to 45 days late.
        </p>
        <A to="/guide" className="btn ghost">
          Guide
        </A>
        <button type="button" className="upsell-x" aria-label="Dismiss the guide" onClick={close}>
          <span aria-hidden>×</span>
        </button>
      </div>
    </section>
  )
}

/** The pills used across the site, explained with the real components. */
const PILLS: [ReactNode, string][] = [
  [<span className="tag pos">New</span>, 'The fund didn’t own it last quarter.'],
  [<span className="tag pos">Added +14.6%</span>, 'It owns 14.6% more shares than last quarter. For very large additions the multiple is shown instead, such as “Added ×19”.'],
  [<span className="tag neg">Trimmed −25.2%</span>, 'It owns 25.2% fewer shares, but still holds some.'],
  [<span className="tag neg">Sold out</span>, 'It owned shares last quarter and reports none now.'],
  [<ChangeTag change={null} held="shares" />, 'The share count in this 13F doesn’t fit the one before, often a stock split the filer didn’t adjust for. The value and weight are real and counted; the shares are greyed, as filed, and no trade is counted.'],
  [<ChangeTag change={null} held="value" />, 'The value doesn’t fit the share count, often a figure filed in the wrong units. It is greyed, as filed, and left out of totals and rankings. The fund still counts as an owner, and no trade is counted. “Figures don’t match” means both are off.'],
  [<span className="tag pos">New 5%+ stake</span>, 'A 13D or 13G: the fund crossed 5% of a company, usually reported within days.'],
  [<span className="tag pos">Bought</span>, 'A Form 4: an insider (here, a fund owning 10% or more) bought on the open market.'],
]
export function Guide() {
  title('How to read Holdterm')
  const rule = roster.rule as Record<string, number>
  return (
    <article className="page narrow article">
      <header className="article-head">
        <p className="eyebrow">Guide · 3 minute read</p>
        <h1>How to read Holdterm</h1>
        <p className="lede">
          Holdterm shows what {roster.funds.length} concentrated, long-term investors own, and what they bought and sold, using only the filings they must make with the US Securities and Exchange Commission. Here is what those filings can and can’t tell you.
        </p>
      </header>
      <ol className="guide-cards guide-cards-page">
        {GUIDE.map((g) => (
          <li key={g.t}>
            <GuideIcon>{g.icon}</GuideIcon>
            <h3>{g.t}</h3>
            <p>{g.p}</p>
          </li>
        ))}
      </ol>
      <section>
        <h2>The three kinds of filing</h2>
        <dl className="defs">
          <dt>Form 13F</dt>
          <dd>A list of every US-listed stock and listed option a manager holds at the end of a quarter, with share counts and values. Due 45 days after the quarter ends: mid-February, mid-May, mid-August and mid-November. Most of Holdterm is built from these.</dd>
          <dt>Schedule 13D and 13G</dt>
          <dd>Filed when an investor owns more than 5% of one company’s shares. A 13D means the investor may try to influence the company; a 13G is for passive holders. They arrive within days to weeks, so they’re the quickest sign of a big new position.</dd>
          <dt>Form 4</dt>
          <dd>Filed within two business days when a company insider trades its shares. For a fund, that happens when it owns 10% or more of a company or has a seat on its board.</dd>
        </dl>
      </section>
      <section>
        <h2>Reading a fund page</h2>
        <p>
          The top of each <A to="/funds">investor’s page</A> sums up the latest 13F: the quarter it covers, the size of the stock portfolio, how many positions it holds, how much sits in the ten largest, and how much it bought and sold since the quarter before.
        </p>
        <p>
          Below that, the holdings are sorted by share of the portfolio. The thin double bar shows last quarter’s weight above this quarter’s. The other tabs list the quarter’s buys and sells, options, notes and preferreds (kept out of the stock totals), past 13F filings, and recent 5% stakes and insider trades.
        </p>
        <h3>What the labels mean</h3>
        <ul className="pills">
          {PILLS.map(([pill, text], i) => (
            <li key={i}>
              <span className="pill-cell">{pill}</span>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>How trades are valued</h2>
        <p>
          Holdterm uses no market prices. A trade’s size is the change in share count times the price implied by the filing (its reported value divided by its shares). If a stock rose and the fund did nothing, nothing was bought. When share counts don’t line up between quarters, for example after an unadjusted split, the trade is shown as the change in reported value instead.
        </p>
      </section>
      <section>
        <h2>Reading a stock page</h2>
        <p>
          Each stock page lists the investors Holdterm follows that own it, ordered by how much of their portfolio it takes up, which says more about conviction than dollar size. It also shows who bought and sold it last quarter and any 5% stakes or insider trades. <A to="/consensus">Most owned</A> combines every investor’s latest 13F, and <A to="/flows">Buys and sells</A> shows the quarter’s busiest stocks.
        </p>
      </section>
      <section>
        <h2>Who Holdterm follows</h2>
        <p>
          Investors are chosen by a published rule, not by fame: at least {usd(rule.min_value, 0)} in US stocks spread over {rule.min_positions} to {rule.max_positions} positions, at least {pct(rule.min_top10, 0)} of it in the ten largest, no more than {pct(rule.max_turnover, 0)} of the portfolio traded in a quarter, and {rule.min_years} or more years of filings. The full rule, and the funds held back because their filings fail our data checks, are on the <A to="/about">About page</A>.
        </p>
      </section>
      <section className="article-cta">
        <div>
          <h2>Know when they move</h2>
          <p>Get an email within hours of a fund you follow filing a 13F, 13D, 13G or Form 4. {PRICE.trialDays} days free, then ${PRICE.monthly} a month.</p>
        </div>
        <A to="/alerts" className="btn">
          Start free trial
        </A>
      </section>
      <p className="dim small">Holdterm is information drawn from public SEC filings, not investment advice.</p>
    </article>
  )
}

// ---------- about, terms, privacy ----------
/** Why a fund narrowly missed the rule, in words (screen.py's test names). */
const MISS: Record<string, string> = { top10: 'too little in its ten largest', top1: 'too much in one stock', turnover: 'trades too much', etf: 'too much in ETFs', positions: 'too many or too few stocks', value: 'too small', years: 'too short a record' }
export function About() {
  title('About')
  const r = roster.rule as Record<string, number>
  return (
    <article className="page narrow article">
      <header className="article-head">
        <p className="eyebrow">About</p>
        <h1>About Holdterm</h1>
        <p className="lede">
          Holdterm follows {roster.funds.length} concentrated, long-term investors through the filings they must make with the SEC: what each one owns, what changed this quarter, what they own in common, and the 5% stakes and insider trades they report between quarters.
        </p>
        <p className="lede">
          The site is free, with no ads. The one paid product is <A to="/alerts">alerts</A>, at ${PRICE.monthly} a month. Holdterm is run by Factor Dynamics.
        </p>
      </header>
      <section className="anchor">
        <span id="roster" />
        <h2>How investors are chosen</h2>
        <p>
          Nobody is hand-picked. Each quarter Holdterm starts from every manager that reports its US stocks to the SEC, using the SEC’s own{' '}
          <a href="https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets" target="_blank" rel="noreferrer">
            Form 13F data sets ↗
          </a>{' '}
          ({quarterLabel(qOf(roster.period))} filings: {num(roster.screened)} managers with {usd(r.min_value, 0)} or more). It keeps the ones that pass one rule: a focused portfolio, little trading, at least {r.min_years} years of filings, and a firm that picks stocks rather than a bank or a pension. The details:
        </p>
        <dl className="defs">
          <dt>Size</dt>
          <dd>
            At least {usd(r.min_value, 0)} in US stocks on its latest 13F.
          </dd>
          <dt>Focus</dt>
          <dd>
            {r.min_positions} to {r.max_positions} stocks, with at least {pct(r.min_top10, 0)} of the portfolio in the ten largest and no more than {pct(r.max_top1, 0)} in any one. No more than {pct(r.max_etf, 0)} in ETFs and index funds. Treasury-bill and money-market funds count as cash and are left out.
          </dd>
          <dt>Patience</dt>
          <dd>
            No more than {pct(r.max_turnover, 0)} of the portfolio traded in the latest quarter, counting half of everything bought and sold at the prices in the filing.
          </dd>
          <dt>Track record</dt>
          <dd>
            A 13F from the same quarter at least {r.min_years} years earlier. A firm’s earlier filing entity counts: Pershing Square Inc. carries on Pershing Square Capital Management’s record, and in a quarter where both filed their portfolios are added together.
          </dd>
          <dt>Kind of investor</dt>
          <dd>
            Investment managers, and companies whose 13F is a concentrated portfolio of outside stocks (Berkshire Hathaway, Icahn, Cincinnati Financial, Graham Holdings) are in. Out: banks, brokers, pensions, endowments and foundations; private-equity and venture sponsors and companies whose 13F lists strategic stakes; sector specialists (biotech, real estate, energy infrastructure); funds of ETFs. The {Object.keys(EXCLUSIONS).length} type exclusions are listed one by one, with the reason for each, in{' '}
                <a href={`${REPO}/blob/main/holdterm/scripts/roster-exclusions.json`} target="_blank" rel="noreferrer">
                  roster-exclusions.json ↗
                </a>.
          </dd>
          <dt>Data checks</dt>
          <dd>
            Every portfolio we publish must add up to the total on its 13F’s cover page, be no more than 25% notes and bonds, and keep its largest position, all share classes together, within the limit. Last quarter is compared with its latest corrected filing, if there is one. A fund that fails is held back until it passes.
          </dd>
          <dt>Stability</dt>
          <dd>
            A fund already on the list stays until it misses a test by more than {pct(r.incumbent_buffer, 0)} (for trading, above {pct(r.max_turnover * (1 + r.incumbent_buffer), 0)} of the portfolio), so the list doesn’t change on noise.
          </dd>
        </dl>
        <p className="article-note">
          {num(roster.funds.length + roster.pending.length + roster.held.length)} funds pass. {num(roster.funds.length)} are on Holdterm{roster.pending.length ? `, ${roster.pending.length} are loading` : ''}
          {roster.held.length ? `, and ${plural(roster.held.length, 'is', 'are')} held back until their filings pass the data checks:` : '.'}
        </p>
        {roster.held.length > 0 && (
          <ul className="plain-list article-note">
            {roster.held.map((f) => (
              <li key={f.slug ?? f.firm}>
                {firmName(f.slug ?? '', f.firm)}: {f.fails[0]}
              </li>
            ))}
          </ul>
        )}
        <p className="article-note">
          Closest misses: {listing(roster.near_misses.slice(0, 8).map((f) => `${firmName(f.slug ?? '', f.firm)} (${f.fails.map((x) => MISS[x] ?? x).join(', ')})`))}. The rule and its output are public:{' '}
          <a href={`${REPO}/blob/main/holdterm/scripts/screen.py`} target="_blank" rel="noreferrer">
            screen.py ↗
          </a>{' '}
          and{' '}
          <a href={`${REPO}/blob/main/holdterm/scripts/universe.json`} target="_blank" rel="noreferrer">
            universe.json ↗
          </a>
          , the full list. The list is redone each time the SEC publishes a quarter’s data; this one is from {date(roster.generated_at.slice(0, 10))}.
        </p>
      </section>
      <section>
        <h2>Where the data comes from</h2>
        <ul className="plain-list">
          <li>
            13F filings on SEC EDGAR. Funds file up to 45 days after the quarter ends, so a 13F is a snapshot, not today’s portfolio. It lists US-listed stocks and options only: no short positions, cash, bonds or foreign shares.
          </li>
          <li>
            Buys and sells are share changes against the fund’s previous 13F, valued at the price implied by the filing. A price move alone is not a trade.
          </li>
          <li>
            Schedule 13D and 13G filings (stakes above 5%) and Form 4 filings (insider trades) made by the investors Holdterm follows. Filings on a fund’s own vehicles are labelled “own fund” and left out of feeds by default.
          </li>
          <li>
            No market prices: everything comes from SEC filings. A stock’s price is the filing’s value divided by its share count. Tickers are matched from the securities identifiers (CUSIPs) in each filing, with a small fallback list that cites a source for each entry (src/tickers.json); a company that has left the exchange shows its former ticker with a †, and where no ticker exists we show the company name rather than guess.
          </li>
          <li>
            Funds are named by firm. A person is shown only when they run the portfolio today.
          </li>
        </ul>
      </section>
      <section>
        <h2>Contact and corrections</h2>
        <p>
          Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> for anything: a wrong number, ticker or name (send the page link and we’ll check it against the SEC filing), billing, or deleting your data. Manage or cancel a subscription in the <a href={checkout.portal}>Stripe billing portal ↗</a>.
        </p>
      </section>
      <section>
        <h2>Not investment advice</h2>
        <p>Information only, not investment advice. Filings can be amended, late or wrong; check the linked SEC document before relying on a number.</p>
      </section>
    </article>
  )
}
// Terms and Privacy use the same article layout as About and Guide. The text last changed on Nov 8, 2026.
const LEGAL_UPDATED = 'November 8, 2026'
export function Terms() {
  title('Terms')
  return (
    <article className="page narrow article">
      <header className="article-head">
        <p className="eyebrow">Last updated {LEGAL_UPDATED}</p>
        <h1>Terms of use</h1>
        <p className="lede">Holdterm is run by Factor Dynamics. By using the site or buying alerts you agree to these terms.</p>
      </header>
      <section>
        <h2>The information</h2>
        <ul className="plain-list">
          <li>Everything here is information drawn from public SEC filings. It is not investment, tax or legal advice, and it is not a recommendation to buy or sell anything.</li>
          <li>Filings can be late, amended or wrong, and our processing can introduce errors. The data is provided as is, without warranty. Check the linked SEC filing before relying on any number.</li>
          <li>Don’t resell or bulk-redistribute Holdterm’s pages or emails. The underlying SEC filings are public.</li>
        </ul>
      </section>
      <section>
        <h2>Alerts</h2>
        <ul className="plain-list">
          <li>
            Alerts are a subscription: ${PRICE.monthly} a month or ${PRICE.yearly} a year after a {PRICE.trialDays}-day free trial, renewing until you cancel. Payments are processed by Stripe.
          </li>
          <li>
            Cancel any time in the <a href={checkout.portal}>billing portal ↗</a>; you keep access to the end of the period you paid for.
          </li>
          <li>Alerts are sent on a best-effort basis, and delivery can be delayed or missed. Our liability is limited to the fees you paid in the last 12 months.</li>
        </ul>
      </section>
      <section>
        <h2>Changes and contact</h2>
        <p>
          We may change these terms; material changes to paid plans are emailed to subscribers first. Questions or corrections: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </section>
    </article>
  )
}
export function Privacy() {
  title('Privacy')
  return (
    <article className="page narrow article">
      <header className="article-head">
        <p className="eyebrow">Last updated {LEGAL_UPDATED}</p>
        <h1>Privacy</h1>
        <p className="lede">Reading Holdterm needs no account. The public pages have no ads, tracking pixels or third-party analytics.</p>
      </header>
      <section>
        <h2>What we keep</h2>
        <ul className="plain-list">
          <li>If you buy alerts we keep your email, your Stripe customer and subscription IDs, and the funds and stocks you follow. That is all we need to send alerts.</li>
          <li>Card details go to Stripe and never reach us. Emails are sent through Resend.</li>
          <li>Signing in stores a session token in your browser’s local storage. Your light or dark setting, the notices you close and a count of your visits are kept there too, and never leave your browser. There are no cookies.</li>
        </ul>
      </section>
      <section>
        <h2>Deleting your data</h2>
        <p>
          We don’t sell or share your data. Cancel in the <a href={checkout.portal}>billing portal ↗</a> and email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> to ask for deletion, and we delete your record.
        </p>
      </section>
    </article>
  )
}

/** `q`: the ticker or name the address asked for, which the search box opens with. */
export function NotFound({ what = 'There’s no page at this address', q }: { what?: string; q?: string }) {
  title('Not found', true)
  return (
    <div className="page narrow">
      <div className="head">
        <div>
          <h1>Page not found</h1>
          <p className="lede">{what.charAt(0).toUpperCase() + what.slice(1)}.</p>
        </div>
      </div>
      {/* The search first, already holding what the address asked for, so a typo or an old link is one tap from the
          right page; then the main sections. */}
      <div className="nf-search">
        <SearchBox q={q} label={q ? `Search for “${q}”` : 'Find an investor or a stock'} />
      </div>
      <div className="filters">
        <A to="/" className="btn ghost">
          Go to the overview
        </A>
        <A to="/funds" className="btn ghost">
          Browse investors
        </A>
        <A to="/consensus" className="btn ghost">
          Most owned stocks
        </A>
      </div>
    </div>
  )
}

export type { Index, Manager }
