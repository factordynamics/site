import { useEffect, useMemo, useState } from 'react'
import { api, checkout, price } from './config'
import {
  aggregate,
  loadBook,
  loadBooks,
  loadEvents,
  loadFundEvents,
  loadHistory,
  loadIndex,
  loadInsiders,
  loadStock,
  quarterLabel,
  SECTOR_COLOR,
  SECTOR_SHORT,
  sectorMix,
  superinvestors,
  type Agg,
  type Event,
  type Holding,
  type Insider,
  type StockHolder,
} from './data'
import { A, Bar, ChangeTag, Columns, date, Failed, Grid, Loading, num, Panel, pct, signedUsd, StackBar, Stat, Tabs, Tick, usd, useLoad, type Col } from './lib'
import { follows, Follow, useMember, startFromUrl, requestLogin, saveFollows, openPortal, signOut, type Follows } from './account'

const title = (t: string) => {
  document.title = `${t} · holdterm`
}

// ---------- shared columns ----------
const aggCols = {
  ticker: { key: 'ticker', label: 'ticker', render: (r: Agg) => <Tick t={r.ticker} name={r.name} />, sort: (r: Agg) => r.ticker ?? r.name, width: '76px' } as Col<Agg>,
  name: { key: 'name', label: 'company', render: (r: Agg) => <span className="trunc">{r.name}</span>, sort: (r: Agg) => r.name } as Col<Agg>,
  sector: { key: 'sector', label: 'sec', hideSm: true, render: (r: Agg) => <Sector s={r.sector} />, sort: (r: Agg) => r.sector } as Col<Agg>,
}
function Sector({ s }: { s?: string | null }) {
  const k = s || 'Unclassified'
  return (
    <span className="sector" title={k}>
      <i style={{ background: SECTOR_COLOR[k] ?? '#555' }} />
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
          <A to={`/m/${w.slug}`}>{short(w.manager)}</A>
        </span>
      ))}
      {list.length > max && <span className="dim"> +{list.length - max}</span>}
    </span>
  )
}
const short = (n: string) => n.replace(/\s+(LLC|LP|L\.P\.|Inc\.?|Ltd\.?|LLP|Corp\.?|plc)$/i, '')

function SectorStrip({ items }: { items: { sector?: string | null; value: number }[] }) {
  const mix = sectorMix(items)
  return (
    <div className="sector-strip">
      <StackBar parts={mix.map((m) => ({ label: m.sector, value: m.value, color: SECTOR_COLOR[m.sector] ?? '#555' }))} />
      <div className="legend">
        {mix.slice(0, 8).map((m) => (
          <span key={m.sector}>
            <i style={{ background: SECTOR_COLOR[m.sector] ?? '#555' }} />
            {SECTOR_SHORT[m.sector] ?? m.sector} <span className="dim">{pct(m.weight, 1)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function SectorRows({ items }: { items: { sector?: string | null; value: number }[] }) {
  const mix = sectorMix(items)
  const max = mix[0]?.weight ?? 1
  return (
    <table className="grid sector-rows">
      <tbody>
        {mix.map((m) => (
          <tr key={m.sector}>
            <td>
              <Sector s={m.sector} /> <span className="hide-sm dim">{m.sector}</span>
            </td>
            <td className="num">{pct(m.weight, 1)}</td>
            <td className="barcell">
              <span className="bar wide">
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

const ACTION: Record<string, [string, string]> = {
  buy: ['BUY', 'pos'],
  sell: ['SELL', 'neg'],
  mixed: ['MIXED', ''],
  other: ['OTHER', 'dim'],
  new_stake: ['NEW 5%+', 'pos'],
  stake_update: ['UPDATE', ''],
  below_threshold: ['<5%', 'neg'],
}
const eventCols = (withWho = true): Col<Event>[] => [
  { key: 'filed', label: 'filed', render: (e) => <span className="dim">{date(e.filing_date)}</span>, sort: (e) => e.filing_date, width: '78px' },
  { key: 'form', label: 'form', render: (e) => <span className="form">{e.kind === 'form4' ? 'F4' : e.kind.toUpperCase()}</span>, sort: (e) => e.kind },
  ...(withWho ? [{ key: 'who', label: 'filer', render: (e: Event) => <A to={`/m/${e.slug}`}>{short(e.manager)}</A>, sort: (e: Event) => e.manager } as Col<Event>] : []),
  { key: 'tk', label: 'ticker', render: (e) => <Tick t={e.ticker} name={e.display_name || e.issuer} /> },
  { key: 'iss', label: 'issuer', hideSm: true, render: (e) => <span className="trunc">{e.display_name || e.issuer}</span> },
  { key: 'act', label: 'action', render: (e) => <span className={`tag ${ACTION[e.action]?.[1] ?? ''}`}>{ACTION[e.action]?.[0] ?? e.action}</span>, sort: (e) => e.action },
  { key: 'pc', label: '% class', num: true, hideSm: true, render: (e) => (e.percent_of_class != null ? `${e.percent_of_class.toFixed(1)}%` : <span className="dim">—</span>), sort: (e) => e.percent_of_class ?? -1 },
  { key: 'val', label: 'value', num: true, render: (e) => (e.value_usd != null ? <span className={e.action === 'sell' ? 'neg' : e.action === 'buy' ? 'pos' : ''}>{usd(e.value_usd)}</span> : <span className="dim">—</span>), sort: (e) => e.value_usd ?? -1 },
  { key: 'sa', label: 'shares after', num: true, hideSm: true, render: (e) => num(e.shares_after), sort: (e) => e.shares_after ?? -1 },
  {
    key: 'sec',
    label: '',
    render: (e) => (
      <a href={e.url} target="_blank" rel="noreferrer" className="dim ext">
        sec↗
      </a>
    ),
  },
]

// ---------- home ----------
export function Home() {
  title('superinvestor 13F terminal')
  const ix = useLoad(loadIndex, [])
  const books = useLoad(loadBooks, [])
  const ev = useLoad(loadEvents, [])
  const ms = useMemo(() => (ix.data ? superinvestors(ix.data) : []), [ix.data])
  const agg = useMemo(() => (books.data ? aggregate(books.data) : null), [books.data])
  if (ix.error) return <Failed error={ix.error} />
  if (!ix.data) return <Loading what="loading filings" />
  const newest = ms.map((m) => m.quarter).sort().at(-1) ?? ''
  const filedNewest = ms.filter((m) => m.quarter === newest).length
  const total = ms.reduce((s, m) => s + m.total_value, 0)
  const recentFilings = [...ms].sort((a, b) => b.filing_date.localeCompare(a.filing_date))
  const slugs = new Set(ms.map((m) => m.slug))
  const events = (ev.data?.events ?? []).filter((e) => slugs.has(e.slug))
  const rows = agg?.rows ?? []
  const owned = [...rows].sort((a, b) => b.holders.length - a.holders.length || b.value - a.value).slice(0, 12)
  const bets = [...rows].filter((r) => r.sector !== 'Funds & ETFs').sort((a, b) => b.maxWeight - a.maxWeight).slice(0, 12)
  const buys = [...rows].filter((r) => r.buyers.length).sort((a, b) => b.buyers.length - a.buyers.length || b.buy - a.buy).slice(0, 12)
  const sells = [...rows].filter((r) => r.sellers.length).sort((a, b) => b.sellers.length - a.sellers.length || a.sell - b.sell).slice(0, 12)
  return (
    <div className="page">
      <div className="stats">
        <Stat label="superinvestors" value={ms.length} sub={<A to="/m">directory →</A>} />
        <Stat label="combined 13F book" value={usd(total)} sub={`${num(ms.reduce((s, m) => s + m.position_count, 0))} positions`} />
        <Stat label={`${quarterLabel(newest)} season`} value={`${filedNewest}/${ms.length}`} sub={<Bar value={filedNewest} max={ms.length} />} />
        <Stat label="13D/G + Form 4, 30d" value={events.length} sub={<A to="/insiders">feed →</A>} />
        <Stat label="alerts" value={`$${price.monthly}/mo`} sub={<A to="/alerts">email on every filing →</A>} />
      </div>
      {agg && (
        <Panel title={<A to="/grand">grand portfolio</A>} right={<span className="dim">{usd(agg.total)} · {num(rows.length)} stocks</span>}>
          <SectorStrip items={rows} />
        </Panel>
      )}
      <div className="cols-home">
        <Panel title="latest 13F filings" right={<span className="dim">newest first</span>} className="tall">
          <Grid
            keyboard
            limit={30}
            rows={recentFilings}
            href={(m) => `/m/${m.slug}`}
            cols={[
              { key: 'f', label: 'filed', render: (m) => <span className="dim">{date(m.filing_date)}</span>, sort: (m) => m.filing_date, width: '78px' },
              { key: 'q', label: 'qtr', render: (m) => <span className={m.quarter === newest ? 'acc' : 'dim'}>{quarterLabel(m.quarter)}</span>, sort: (m) => m.quarter },
              { key: 'm', label: 'investor', render: (m) => <span>{m.manager}</span>, sort: (m) => m.manager },
              { key: 'v', label: 'value', num: true, render: (m) => usd(m.total_value), sort: (m) => m.total_value },
              { key: 'n', label: 'pos', num: true, hideSm: true, render: (m) => m.position_count, sort: (m) => m.position_count },
            ]}
          />
        </Panel>
        <div className="stack">
          {!agg ? (
            books.error ? <Failed error={books.error} /> : <Loading what="rolling up portfolios" />
          ) : (
            <div className="duo">
              <Panel title="most owned" right={<A to="/grand">all →</A>}>
                <Grid
                  rank
                  rows={owned}
                  href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
                  cols={[aggCols.ticker, aggCols.name, { key: 'h', label: 'own', num: true, render: (r) => r.holders.length }]}
                />
              </Panel>
              <Panel title="biggest bets" right={<span className="dim">max % of a book</span>}>
                <Grid
                  rank
                  rows={bets}
                  href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
                  cols={[{ ...aggCols.ticker, render: (r) => (r.ticker ? <Tick t={r.ticker} name={r.name} /> : <span className="dim trunc tkname">{r.name}</span>) }, { key: 'w', label: 'who', render: (r) => <Who list={[...r.holders].sort((a, b) => b.weight - a.weight)} max={1} /> }, { key: 'mw', label: 'max', num: true, render: (r) => pct(r.maxWeight, 1) }]}
                />
              </Panel>
              <Panel title="most bought" right={<A to="/activity">activity →</A>}>
                <Grid
                  rank
                  rows={buys}
                  href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
                  cols={[aggCols.ticker, aggCols.name, { key: 'b', label: 'buyers', num: true, render: (r) => <span className="pos">{r.buyers.length}</span> }, { key: 'v', label: '$', num: true, render: (r) => <span className="pos">{usd(r.buy)}</span> }]}
                />
              </Panel>
              <Panel title="most sold" right={<A to="/activity">activity →</A>}>
                <Grid
                  rank
                  rows={sells}
                  href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
                  cols={[aggCols.ticker, aggCols.name, { key: 's', label: 'sellers', num: true, render: (r) => <span className="neg">{r.sellers.length}</span> }, { key: 'v', label: '$', num: true, render: (r) => <span className="neg">{usd(r.sell)}</span> }]}
                />
              </Panel>
            </div>
          )}
          <Panel title="13D/G and Form 4 by superinvestors" right={<A to="/insiders">all →</A>}>
            {ev.data ? <Grid rows={events.slice(0, 10)} cols={eventCols()} empty="no filings in the last 30 days" /> : <Loading />}
          </Panel>
        </div>
      </div>
    </div>
  )
}

// ---------- investors directory ----------
export function Investors() {
  title('superinvestors')
  const ix = useLoad(loadIndex, [])
  if (ix.error) return <Failed error={ix.error} />
  if (!ix.data) return <Loading />
  const ms = superinvestors(ix.data)
  const newest = ms.map((m) => m.quarter).sort().at(-1)
  return (
    <div className="page">
      <h1>
        superinvestors <span className="dim">· {ms.length} managers · latest 13F-HR each</span>
      </h1>
      <Panel title="directory" right={<span className="dim">j/k + enter</span>}>
        <Grid
          keyboard
          rank
          rows={ms}
          initial={['v', 'desc']}
          href={(m) => `/m/${m.slug}`}
          cols={[
            { key: 'm', label: 'investor', render: (m) => <span className="strong">{m.manager}</span>, sort: (m) => m.manager },
            { key: 'firm', label: 'firm', hideSm: true, render: (m) => <span className="dim trunc">{m.name}</span>, sort: (m) => m.name },
            { key: 'v', label: 'value', num: true, render: (m) => usd(m.total_value), sort: (m) => m.total_value },
            { key: 'n', label: 'pos', num: true, render: (m) => m.position_count, sort: (m) => m.position_count },
            { key: 't', label: 'top 1', num: true, hideSm: true, render: (m) => pct(m.top[0]?.weight, 1), sort: (m) => m.top[0]?.weight ?? 0, title: 'weight of the largest position' },
            {
              key: 'top',
              label: 'top holdings',
              hideSm: true,
              render: (m) => (
                <span className="tks">
                  {m.top.filter((h) => !h.put_call).slice(0, 5).map((h) => (
                    <Tick key={h.cusip} t={h.ticker} name={h.display_name} />
                  ))}
                </span>
              ),
            },
            { key: 'q', label: 'qtr', render: (m) => <span className={m.quarter === newest ? 'acc' : 'dim'}>{quarterLabel(m.quarter)}</span>, sort: (m) => m.quarter },
            { key: 'f', label: 'filed', num: true, render: (m) => <span className="dim">{date(m.filing_date)}</span>, sort: (m) => m.filing_date },
          ]}
        />
      </Panel>
    </div>
  )
}

// ---------- one investor ----------
type ITab = 'holdings' | 'buys' | 'sells' | 'filings' | 'events'
export function Investor({ slug }: { slug: string }) {
  const b = useLoad(() => loadBook(slug), [slug])
  const h = useLoad(() => loadHistory(slug).catch(() => ({ history: [] })), [slug])
  const ev = useLoad(() => loadFundEvents(slug), [slug])
  const [tab, setTab] = useState<ITab>('holdings')
  if (b.error) return <NotFound what={`no 13F book for "${slug}"`} />
  if (!b.data) return <Loading what={`loading ${slug}`} />
  const book = b.data
  title(`${book.manager} 13F portfolio`)
  const live = book.holdings.filter((x) => x.value > 0)
  const buys = book.holdings.filter((x) => (x.value_delta ?? 0) > 0).sort((a, b) => (b.value_delta ?? 0) - (a.value_delta ?? 0))
  const sells = book.holdings.filter((x) => (x.value_delta ?? 0) < 0).sort((a, b) => (a.value_delta ?? 0) - (b.value_delta ?? 0))
  const bought = buys.reduce((s, x) => s + (x.value_delta ?? 0), 0)
  const sold = sells.reduce((s, x) => s + (x.value_delta ?? 0), 0)
  const top10 = [...live].sort((a, b) => b.weight - a.weight).slice(0, 10).reduce((s, x) => s + x.weight, 0)
  const hist = [...(h.data?.history ?? [])].filter((r) => r.total_value > 0).reverse()
  const events = ev.data?.events ?? []
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>{book.manager}</h1>
          <div className="dim">
            {book.name} · CIK {book.cik.replace(/^0+/, '')} ·{' '}
            <a href={book.sec_url} target="_blank" rel="noreferrer">
              13F-HR {book.accession} ↗
            </a>
          </div>
        </div>
        <Follow kind="investors" id={slug} />
      </div>
      <div className="stats">
        <Stat label="period" value={quarterLabel(book.quarter)} sub={`as of ${date(book.report_date)} · filed ${date(book.filing_date)}`} />
        <Stat label="13F value" value={usd(book.total_value)} sub={book.prev_total_value ? `${signedUsd(book.total_value - book.prev_total_value)} vs ${quarterLabel(book.prev_quarter ?? '')}` : 'first filing'} />
        <Stat label="positions" value={live.length} sub={book.changes ? `${book.changes.new ?? 0} new · ${book.changes.exited ?? 0} exited` : ''} />
        <Stat label="top 10 weight" value={pct(top10, 1)} sub={<Bar value={top10} max={1} />} />
        <Stat label="bought" value={usd(bought)} tone="pos" sub={`${buys.length} lines`} />
        <Stat label="sold" value={usd(-sold)} tone="neg" sub={`${sells.length} lines`} />
      </div>
      <div className="duo wide">
        <Panel title="sector mix">
          <SectorRows items={live} />
        </Panel>
        <Panel title="reported 13F value by quarter">{hist.length > 1 ? <Columns height={110} data={hist.map((r) => ({ label: r.quarter.slice(2), value: r.total_value }))} /> : <div className="dim empty">one quarter on file</div>}</Panel>
      </div>
      <Tabs<ITab>
        value={tab}
        onChange={setTab}
        options={[
          ['holdings', `holdings ${live.length}`],
          ['buys', `buys ${buys.length}`],
          ['sells', `sells ${sells.length}`],
          ['filings', `filings ${hist.length}`],
          ['events', `13D/G·F4 ${events.length}`],
        ]}
      />
      <Panel title={tab} right={tab === 'holdings' ? <span className="dim">reported price = value ÷ shares as filed</span> : undefined}>
        {tab === 'holdings' && <HoldingsGrid rows={live} />}
        {tab === 'buys' && <MovesGrid rows={buys} />}
        {tab === 'sells' && <MovesGrid rows={sells} />}
        {tab === 'filings' && (
          <Grid
            rows={[...hist].reverse()}
            cols={[
              { key: 'q', label: 'qtr', render: (r) => quarterLabel(r.quarter) },
              { key: 'rd', label: 'period end', render: (r) => date(r.report_date) },
              { key: 'fd', label: 'filed', render: (r) => date(r.filing_date) },
              { key: 'v', label: 'value', num: true, render: (r) => usd(r.total_value) },
              { key: 'n', label: 'pos', num: true, render: (r) => r.position_count },
              {
                key: 's',
                label: '',
                render: (r) => (
                  <a href={r.sec_url} target="_blank" rel="noreferrer" className="dim ext">
                    sec↗
                  </a>
                ),
              },
            ]}
          />
        )}
        {tab === 'events' && <Grid rows={events} cols={eventCols(false)} empty="no Form 4 or 13D/G filed since the latest 13F period" />}
      </Panel>
    </div>
  )
}
function HoldingsGrid({ rows }: { rows: Holding[] }) {
  const max = Math.max(...rows.map((r) => r.weight))
  return (
    <Grid
      keyboard
      rank
      rows={rows}
      initial={['w', 'desc']}
      href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
      cols={[
        { key: 't', label: 'ticker', render: (r) => <Tick t={r.ticker} name={r.display_name || r.issuer} />, sort: (r) => r.ticker ?? '', width: '76px' },
        { key: 'n', label: 'company', render: (r) => <span className="trunc">{r.display_name || r.issuer}{r.put_call ? <span className="tag"> {r.put_call}</span> : null}</span>, sort: (r) => r.display_name || r.issuer },
        { key: 's', label: 'sec', hideSm: true, render: (r) => <Sector s={r.sector} />, sort: (r) => r.sector ?? '' },
        { key: 'w', label: '% port', num: true, render: (r) => <span className="wcell">{pct(r.weight)}<Bar value={r.weight} max={max} /></span>, sort: (r) => r.weight },
        { key: 'c', label: 'activity', render: (r) => <ChangeTag change={r.change} share_change={r.share_change} prev_shares={r.prev_shares} />, sort: (r) => r.share_change ?? 0 },
        { key: 'sh', label: 'shares', num: true, hideSm: true, render: (r) => num(r.shares), sort: (r) => r.shares },
        { key: 'p', label: 'rep. px', num: true, hideSm: true, render: (r) => (r.shares && !r.put_call ? `$${(r.value / r.shares).toFixed(2)}` : '—'), sort: (r) => (r.shares ? r.value / r.shares : 0) },
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
      href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
      cols={[
        { key: 't', label: 'ticker', render: (r) => <Tick t={r.ticker} name={r.display_name || r.issuer} />, width: '76px' },
        { key: 'n', label: 'company', render: (r) => <span className="trunc">{r.display_name || r.issuer}</span> },
        { key: 'c', label: 'activity', render: (r) => <ChangeTag change={r.change} share_change={r.share_change} prev_shares={r.prev_shares} /> },
        { key: 'sc', label: 'Δ shares', num: true, hideSm: true, render: (r) => <span className={(r.share_change ?? 0) > 0 ? 'pos' : 'neg'}>{(r.share_change ?? 0) > 0 ? '+' : ''}{num(r.share_change)}</span>, sort: (r) => r.share_change ?? 0 },
        { key: 'd', label: 'Δ value', num: true, render: (r) => <span className={(r.value_delta ?? 0) > 0 ? 'pos' : 'neg'}>{signedUsd(r.value_delta)}</span>, sort: (r) => r.value_delta ?? 0 },
        { key: 'pb', label: '% of book', num: true, render: (r) => pct(r.pct_of_book), sort: (r) => r.pct_of_book ?? 0, title: 'trade size as a share of the whole 13F book' },
        { key: 'w', label: 'now', num: true, hideSm: true, render: (r) => pct(r.weight), sort: (r) => r.weight },
      ]}
    />
  )
}

// ---------- activity ----------
type ATab = 'buyers' | 'buy$' | 'new' | 'sellers' | 'exits'
export function Activity() {
  title('buys and sells')
  const books = useLoad(loadBooks, [])
  const [q, setQ] = useState<string>('latest')
  const [tab, setTab] = useState<ATab>('buyers')
  const quarters = useMemo(() => [...new Set((books.data ?? []).map((b) => b.quarter))].sort().reverse(), [books.data])
  const rows = useMemo(() => (books.data ? aggregate(q === 'latest' ? books.data : books.data.filter((b) => b.quarter === q)).rows : []), [books.data, q])
  if (books.error) return <Failed error={books.error} />
  if (!books.data) return <Loading what="rolling up buys and sells" />
  const funds = q === 'latest' ? books.data.length : books.data.filter((b) => b.quarter === q).length
  const exits = (r: Agg) => r.sellers.filter((s) => s.change === 'exited').length
  let list: Agg[]
  if (tab === 'buyers') list = rows.filter((r) => r.buyers.length).sort((a, b) => b.buyers.length - a.buyers.length || b.buy - a.buy)
  else if (tab === 'buy$') list = rows.filter((r) => r.net > 0).sort((a, b) => b.net - a.net)
  else if (tab === 'new') list = rows.filter((r) => r.newBuyers).sort((a, b) => b.newBuyers - a.newBuyers || b.buy - a.buy)
  else if (tab === 'sellers') list = rows.filter((r) => r.sellers.length).sort((a, b) => b.sellers.length - a.sellers.length || a.sell - b.sell)
  else list = rows.filter((r) => exits(r)).sort((a, b) => exits(b) - exits(a) || a.sell - b.sell)
  const isBuy = tab === 'buyers' || tab === 'buy$' || tab === 'new'
  return (
    <div className="page">
      <h1>
        activity <span className="dim">· what superinvestors bought and sold, from 13F changes vs the prior quarter</span>
      </h1>
      <div className="filters">
        <span className="dim">quarter</span>
        {['latest', ...quarters].map((x) => (
          <button key={x} className={q === x ? 'chip on' : 'chip'} onClick={() => setQ(x)}>
            {x === 'latest' ? 'each fund’s latest' : quarterLabel(x)}
          </button>
        ))}
        <span className="dim">· {funds} funds</span>
      </div>
      <Tabs<ATab>
        value={tab}
        onChange={setTab}
        options={[
          ['buyers', 'most buyers'],
          ['buy$', 'net $ bought'],
          ['new', 'new positions'],
          ['sellers', 'most sellers'],
          ['exits', 'exits'],
        ]}
      />
      <Panel title={tab} right={<span className="dim">trade $ = share change × filed price; price moves alone count as 0</span>}>
        <Grid
          keyboard
          rank
          limit={100}
          rows={list}
          href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
          cols={[
            aggCols.ticker,
            aggCols.name,
            aggCols.sector,
            isBuy
              ? { key: 'b', label: tab === 'new' ? 'new' : 'buyers', num: true, render: (r) => <span className="pos">{tab === 'new' ? r.newBuyers : r.buyers.length}</span> }
              : { key: 's', label: tab === 'exits' ? 'exits' : 'sellers', num: true, render: (r) => <span className="neg">{tab === 'exits' ? exits(r) : r.sellers.length}</span> },
            { key: 'w', label: isBuy ? 'who bought' : 'who sold', hideSm: true, render: (r) => <Who list={[...(isBuy ? r.buyers : r.sellers)].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))} /> },
            { key: 'bv', label: 'bought', num: true, render: (r) => <span className="pos">{r.buy ? usd(r.buy) : '·'}</span>, sort: (r) => r.buy },
            { key: 'sv', label: 'sold', num: true, render: (r) => <span className="neg">{r.sell ? usd(-r.sell) : '·'}</span>, sort: (r) => -r.sell },
            { key: 'nv', label: 'net', num: true, hideSm: true, render: (r) => <span className={r.net >= 0 ? 'pos' : 'neg'}>{signedUsd(r.net)}</span>, sort: (r) => r.net },
            { key: 'h', label: 'own', num: true, hideSm: true, render: (r) => r.holders.length, sort: (r) => r.holders.length },
          ]}
        />
      </Panel>
    </div>
  )
}

// ---------- grand portfolio ----------
type GTab = 'owners' | 'value' | 'bets'
export function Grand() {
  title('grand portfolio')
  const books = useLoad(loadBooks, [])
  const [tab, setTab] = useState<GTab>('owners')
  const [sector, setSector] = useState<string | null>(null)
  const agg = useMemo(() => (books.data ? aggregate(books.data) : null), [books.data])
  if (books.error) return <Failed error={books.error} />
  if (!agg || !books.data) return <Loading what="building the grand portfolio" />
  const n = books.data.length
  const base = sector ? agg.rows.filter((r) => r.sector === sector) : agg.rows
  const list = [...base].sort(tab === 'owners' ? (a, b) => b.holders.length - a.holders.length || b.value - a.value : tab === 'value' ? (a, b) => b.value - a.value : (a, b) => b.maxWeight - a.maxWeight)
  const mix = sectorMix(agg.rows)
  return (
    <div className="page">
      <h1>
        grand portfolio <span className="dim">· every superinvestor’s latest 13F stocks in one book · {n} funds · {usd(agg.total)}</span>
      </h1>
      <Panel title="sector mix" right={<span className="dim">click a sector to filter</span>}>
        <SectorStrip items={agg.rows} />
        <div className="filters">
          <button className={!sector ? 'chip on' : 'chip'} onClick={() => setSector(null)}>
            all
          </button>
          {mix.map((m) => (
            <button key={m.sector} className={sector === m.sector ? 'chip on' : 'chip'} onClick={() => setSector(m.sector)}>
              <i className="dot" style={{ background: SECTOR_COLOR[m.sector] }} />
              {SECTOR_SHORT[m.sector] ?? m.sector} {pct(m.weight, 1)}
            </button>
          ))}
        </div>
      </Panel>
      <Tabs<GTab>
        value={tab}
        onChange={setTab}
        options={[
          ['owners', 'by owners'],
          ['value', 'by $ held'],
          ['bets', 'biggest bets'],
        ]}
      />
      <Panel title={`${num(list.length)} stocks`} right={<span className="dim">common stock and ADRs; options excluded</span>}>
        <Grid
          keyboard
          rank
          limit={150}
          rows={list}
          href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
          cols={[
            aggCols.ticker,
            aggCols.name,
            aggCols.sector,
            { key: 'h', label: 'own', num: true, render: (r) => r.holders.length, sort: (r) => r.holders.length },
            { key: 'hp', label: '% funds', num: true, hideSm: true, render: (r) => <span className="wcell">{pct(r.holders.length / n, 0)}<Bar value={r.holders.length} max={n} /></span>, sort: (r) => r.holders.length },
            { key: 'v', label: '$ held', num: true, render: (r) => usd(r.value), sort: (r) => r.value },
            { key: 'gw', label: '% grand', num: true, hideSm: true, render: (r) => pct(r.value / agg.total), sort: (r) => r.value },
            { key: 'mw', label: 'max %', num: true, render: (r) => pct(r.maxWeight, 1), sort: (r) => r.maxWeight, title: 'largest weight in any one book' },
            { key: 'aw', label: 'avg %', num: true, hideSm: true, render: (r) => pct(r.holders.reduce((s, h) => s + h.weight, 0) / Math.max(1, r.holders.length), 2), sort: (r) => r.holders.reduce((s, h) => s + h.weight, 0) / Math.max(1, r.holders.length) },
            { key: 'who', label: 'largest holders', hideSm: true, render: (r) => <Who list={[...r.holders].sort((a, b) => b.weight - a.weight)} max={2} /> },
          ]}
        />
      </Panel>
    </div>
  )
}

// ---------- insiders / 13D/G ----------
type ETab = 'all' | '13dg' | 'f4' | 'market'
export function Insiders() {
  title('insider and 13D/G activity')
  const ev = useLoad(loadEvents, [])
  const ix = useLoad(loadIndex, [])
  const ins = useLoad(loadInsiders, [])
  const [tab, setTab] = useState<ETab>('all')
  const [scope, setScope] = useState<'super' | 'all'>('super')
  if (ev.error) return <Failed error={ev.error} />
  if (!ev.data || !ix.data) return <Loading />
  const supers = new Set(superinvestors(ix.data).map((m) => m.slug))
  let list = ev.data.events.filter((e) => scope === 'all' || supers.has(e.slug))
  if (tab === '13dg') list = list.filter((e) => e.kind !== 'form4')
  if (tab === 'f4') list = list.filter((e) => e.kind === 'form4')
  const market = ins.data
  return (
    <div className="page">
      <h1>
        insiders <span className="dim">· Form 4 and Schedule 13D/13G filed by tracked funds since their latest 13F · last {ev.data.window_days} days</span>
      </h1>
      <div className="stats">
        <Stat label="filings" value={ev.data.events.length} sub={`updated ${ev.data.updated_at.slice(0, 16).replace('T', ' ')}Z`} />
        <Stat label="new 5%+ stakes" value={ev.data.events.filter((e) => e.action === 'new_stake').length} tone="pos" />
        <Stat label="dropped below 5%" value={ev.data.events.filter((e) => e.action === 'below_threshold').length} tone="neg" />
        <Stat label="Form 4 buys / sells" value={`${ev.data.events.filter((e) => e.action === 'buy').length} / ${ev.data.events.filter((e) => e.action === 'sell').length}`} />
      </div>
      <Tabs<ETab>
        value={tab}
        onChange={setTab}
        options={[
          ['all', 'all'],
          ['13dg', '13D / 13G'],
          ['f4', 'Form 4'],
          ['market', 'market-wide insiders'],
        ]}
      />
      {tab !== 'market' ? (
        <>
          <div className="filters">
            <button className={scope === 'super' ? 'chip on' : 'chip'} onClick={() => setScope('super')}>
              superinvestors
            </button>
            <button className={scope === 'all' ? 'chip on' : 'chip'} onClick={() => setScope('all')}>
              all tracked funds
            </button>
          </div>
          <Panel title={`${list.length} filings`}>
            <Grid keyboard rows={list} limit={150} href={(e) => (e.ticker ? `/s/${e.ticker}` : null)} cols={eventCols()} />
          </Panel>
        </>
      ) : market && market.length ? (
        <Panel title="open-market insider trades · Form 4 codes P and S" right={<span className="dim">company officers, directors and 10% owners</span>}>
          <Grid<Insider>
            keyboard
            limit={200}
            rows={market}
            href={(r) => (r.ticker ? `/s/${r.ticker}` : null)}
            cols={[
              { key: 'f', label: 'filed', render: (r) => <span className="dim">{date(r.filing_date)}</span>, sort: (r) => r.filing_date },
              { key: 't', label: 'ticker', render: (r) => <Tick t={r.ticker} name={r.issuer} /> },
              { key: 'i', label: 'issuer', hideSm: true, render: (r) => <span className="trunc">{r.issuer}</span> },
              { key: 'o', label: 'insider', render: (r) => <span className="trunc">{r.owner}</span> },
              { key: 'r', label: 'role', hideSm: true, render: (r) => <span className="dim trunc">{r.relationship}</span> },
              { key: 'c', label: 'side', render: (r) => <span className={`tag ${r.code === 'P' ? 'pos' : 'neg'}`}>{r.code === 'P' ? 'BUY' : 'SELL'}</span>, sort: (r) => r.code },
              { key: 'p', label: 'price', num: true, hideSm: true, render: (r) => `$${r.price.toFixed(2)}` },
              { key: 'v', label: 'value', num: true, render: (r) => <span className={r.code === 'P' ? 'pos' : 'neg'}>{usd(r.value_usd)}</span>, sort: (r) => r.value_usd },
              {
                key: 's',
                label: '',
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
        <Panel title="market-wide insiders">
          <div className="empty dim">The market-wide Form 4 feed (every company’s open-market insider buys and sells) is being built from EDGAR daily indexes. Until it lands, the other tabs cover Form 4 and 13D/G filed by tracked funds.</div>
        </Panel>
      )}
    </div>
  )
}

// ---------- stock ----------
type STab = 'holders' | 'activity' | 'options' | 'filings'
export function Stock({ ticker }: { ticker: string }) {
  const s = useLoad(() => loadStock(ticker), [ticker])
  const ev = useLoad(loadEvents, [])
  const [tab, setTab] = useState<STab>('holders')
  const [scope, setScope] = useState<'super' | 'all'>('super')
  title(`${ticker} superinvestor ownership`)
  if (s.error) return <NotFound what={`no tracked fund reports ${ticker} in its latest 13F`} />
  if (!s.data) return <Loading what={`loading ${ticker}`} />
  const d = s.data
  const pick = (l: StockHolder[]) => (scope === 'super' ? l.filter((h) => h.featured) : l)
  const holders = pick(d.holders)
  const supers = d.holders.filter((h) => h.featured)
  const movers = pick([...d.holders, ...d.exited]).filter((h) => h.change && h.change !== 'unchanged').sort((a, b) => Math.abs(b.delta_value ?? 0) - Math.abs(a.delta_value ?? 0))
  const tickers = new Set(d.classes.map((c) => c.ticker))
  const events = (ev.data?.events ?? []).filter((e) => e.ticker && tickers.has(e.ticker))
  const superValue = supers.reduce((x, h) => x + h.value, 0)
  const holderCols: Col<StockHolder>[] = [
    { key: 'm', label: 'fund', render: (h) => <span className={h.featured ? 'strong' : ''}>{h.manager}</span>, sort: (h) => h.manager },
    { key: 'w', label: '% port', num: true, render: (h) => pct(h.weight), sort: (h) => h.weight },
    { key: 'c', label: 'activity', render: (h) => <ChangeTag change={h.change} share_change={h.prev_shares != null ? h.shares - h.prev_shares : null} prev_shares={h.prev_shares} />, sort: (h) => h.delta_value ?? 0 },
    { key: 'sh', label: 'shares', num: true, hideSm: true, render: (h) => num(h.shares), sort: (h) => h.shares },
    { key: 'v', label: 'value', num: true, render: (h) => usd(h.value), sort: (h) => h.value },
    { key: 'q', label: 'qtr', num: true, hideSm: true, render: (h) => <span className="dim">{quarterLabel(h.quarter)}</span>, sort: (h) => h.quarter },
  ]
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>
            <span className="acc">{d.ticker}</span> {d.name}
          </h1>
          <div className="dim">
            <Sector s={d.sector} /> {d.sector ?? 'Unclassified'} · {d.classes.map((c) => `${c.ticker} ${c.cusip}`).join(' · ')}
          </div>
        </div>
        <Follow kind="stocks" id={d.ticker} />
      </div>
      <div className="stats">
        <Stat label="superinvestors" value={supers.length} sub={`${d.holders.length} tracked funds in total`} />
        <Stat label="superinvestor $" value={usd(superValue)} sub={`${usd(d.value)} across all tracked funds`} />
        <Stat label="holders vs prior qtr" value={`${d.counts.holders - d.counts.prev_holders >= 0 ? '+' : ''}${d.counts.holders - d.counts.prev_holders}`} tone={d.counts.holders >= d.counts.prev_holders ? 'pos' : 'neg'} sub={`${d.counts.prev_holders} → ${d.counts.holders}`} />
        <Stat label="new / added" value={`${d.counts.new} / ${d.counts.added}`} tone="pos" />
        <Stat label="trimmed / exited" value={`${d.counts.trimmed} / ${d.counts.exited}`} tone="neg" />
      </div>
      <div className="filters">
        <button className={scope === 'super' ? 'chip on' : 'chip'} onClick={() => setScope('super')}>
          superinvestors
        </button>
        <button className={scope === 'all' ? 'chip on' : 'chip'} onClick={() => setScope('all')}>
          all tracked funds
        </button>
      </div>
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
        {tab === 'holders' && <Grid keyboard rank rows={holders} initial={['w', 'desc']} href={(h) => `/m/${h.slug}`} cols={holderCols} empty="no superinvestor holds it; switch to all tracked funds" />}
        {tab === 'activity' && (
          <Grid
            keyboard
            rows={movers}
            href={(h) => `/m/${h.slug}`}
            cols={[
              holderCols[0],
              holderCols[2],
              { key: 'd', label: 'Δ value', num: true, render: (h) => <span className={(h.delta_value ?? 0) >= 0 ? 'pos' : 'neg'}>{signedUsd(h.delta_value)}</span>, sort: (h) => h.delta_value ?? 0 },
              holderCols[1],
              holderCols[5],
            ]}
          />
        )}
        {tab === 'options' && (
          <Grid
            rows={pick(d.options)}
            href={(h) => `/m/${h.slug}`}
            cols={[holderCols[0], { key: 'pc', label: 'type', render: (h) => <span className={`tag ${h.put_call === 'CALL' ? 'pos' : 'neg'}`}>{h.put_call}</span> }, { key: 'v', label: 'notional', num: true, render: (h) => usd(h.value), sort: (h) => h.value }, holderCols[1]]}
          />
        )}
        {tab === 'filings' && <Grid rows={events} cols={eventCols()} empty="no Form 4 or 13D/G by tracked funds in the last 30 days" />}
      </Panel>
    </div>
  )
}

// ---------- alerts (paid) ----------
export function Alerts() {
  title('email alerts')
  const [yearly, setYearly] = useState(false)
  const link = yearly ? checkout.yearly : checkout.monthly
  return (
    <div className="page narrow">
      <h1>
        alerts <span className="dim">· the only thing we sell</span>
      </h1>
      <div className="duo">
        <Panel title="holdterm alerts">
          <div className="price">
            <span className="big">${yearly ? price.yearly : price.monthly}</span>
            <span className="dim">/{yearly ? 'year' : 'month'}</span>
          </div>
          <div className="filters">
            <button className={!yearly ? 'chip on' : 'chip'} onClick={() => setYearly(false)}>
              monthly ${price.monthly}
            </button>
            <button className={yearly ? 'chip on' : 'chip'} onClick={() => setYearly(true)}>
              yearly ${price.yearly} <span className="pos">-{Math.round((1 - price.yearly / (price.monthly * 12)) * 100)}%</span>
            </button>
          </div>
          {link ? (
            <a className="btn" href={link}>
              start {price.trialDays}-day free trial →
            </a>
          ) : (
            <div className="note">checkout opens shortly · the site itself is free and stays free</div>
          )}
          <p className="dim small">
            {price.trialDays} days free, then ${price.monthly}/month or ${price.yearly}/year until you cancel. Cancel any time from your account; billing runs through Stripe.
          </p>
        </Panel>
        <Panel title="what you get">
          <ul className="list">
            <li>
              <span className="acc">▸</span> an email within hours of a superinvestor you follow filing a new 13F, with its biggest buys, sells, new positions and exits
            </li>
            <li>
              <span className="acc">▸</span> 13D, 13G and Form 4 filings by those investors, and by any fund in stocks you follow
            </li>
            <li>
              <span className="acc">▸</span> follow nobody and you get every superinvestor
            </li>
            <li>
              <span className="acc">▸</span> plain, dense emails with the SEC link; change who you follow any time
            </li>
            <li>
              <span className="acc">▸</span> the whole site stays free with no ads; alerts pay for it
            </li>
          </ul>
        </Panel>
      </div>
      <Panel title="already subscribed">
        <A to="/account">sign in with your email →</A>
      </Panel>
    </div>
  )
}

// ---------- account ----------
export function Account() {
  title('account')
  const [member, setMember, err] = useMember()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [f, setF] = useState<Follows | null>(null)
  const ix = useLoad(loadIndex, [])
  useEffect(() => {
    startFromUrl().then((m) => m && setMember(m))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (member?.active) follows().then(setF).catch(() => {})
  }, [member])
  if (!api)
    return (
      <div className="page narrow">
        <h1>account</h1>
        <Panel title="sign in">
          <div className="empty dim">Accounts open with paid alerts. <A to="/alerts">see alerts →</A></div>
        </Panel>
      </div>
    )
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
              <span className="acc">&gt;</span>
              <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn">email me a link</button>
            </form>
          )}
          <p className="dim small">
            No account yet? <A to="/alerts">start a {price.trialDays}-day trial →</A>
          </p>
        </Panel>
      </div>
    )
  const ms = ix.data ? superinvestors(ix.data) : []
  const on = new Set(f?.investors ?? [])
  const toggle = (slug: string) => {
    const next = on.has(slug) ? [...on].filter((x) => x !== slug) : [...on, slug]
    saveFollows({ investors: next }).then(setF)
  }
  return (
    <div className="page narrow">
      <h1>account</h1>
      <div className="stats">
        <Stat label="email" value={<span className="small">{member.email}</span>} />
        <Stat label="plan" value={member.active ? 'alerts' : member.status} tone={member.active ? 'pos' : 'neg'} sub={member.period_end ? `renews ${String(member.period_end).slice(0, 10)}` : undefined} />
        <Stat label="following" value={on.size || 'all'} sub={on.size ? 'investors' : 'every superinvestor'} />
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
          <Panel title="investors you get alerts for" right={<span className="dim">none selected = all</span>}>
            <div className="checks">
              {ms.map((m) => (
                <label key={m.slug} className={on.has(m.slug) ? 'on' : ''}>
                  <input type="checkbox" checked={on.has(m.slug)} onChange={() => toggle(m.slug)} />
                  {m.manager}
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
            <button className="linkish" onClick={() => saveFollows({ stocks: list.filter((y) => y !== x) }).then(setF)}>
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
          if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(v) && !list.includes(v)) saveFollows({ stocks: [...list, v] }).then(setF)
          setT('')
        }}
      >
        <span className="acc">+</span>
        <input placeholder="ticker" value={t} onChange={(e) => setT(e.target.value)} />
      </form>
    </div>
  )
}

// ---------- about ----------
export function About() {
  title('about')
  return (
    <div className="page narrow prose">
      <h1>about</h1>
      <Panel title="what this is">
        <p>Holdterm tracks the stock portfolios of a hand-picked list of long-term investors, as they disclose them to the SEC. It is a dense, keyboard-first reader for those filings: every portfolio, what changed this quarter, which stocks the group owns most, and the 13D, 13G and Form 4 filings between quarters.</p>
        <p>There are no ads. The site is free; the one paid product is <A to="/alerts">email alerts</A> at ${price.monthly} a month.</p>
      </Panel>
      <Panel title="data">
        <ul className="list">
          <li>
            <span className="acc">▸</span> Form 13F-HR, as filed on SEC EDGAR, quarterly. Funds file up to 45 days after quarter end, so holdings are a snapshot, not today’s book. 13F covers US-listed long positions and listed options only; no shorts, cash, bonds or foreign shares.
          </li>
          <li>
            <span className="acc">▸</span> Buys and sells are share changes against the fund’s previous 13F, valued at the price implied by the filing. A price move alone is not a trade.
          </li>
          <li>
            <span className="acc">▸</span> Schedule 13D and 13G (5%+ ownership) and Form 4 (insider transactions) where a tracked fund is the filer, from EDGAR.
          </li>
          <li>
            <span className="acc">▸</span> No market prices: everything here comes from SEC filings. Reported price is the filing’s value divided by its share count.
          </li>
          <li>
            <span className="acc">▸</span> Tickers from CUSIP mapping; sectors from each issuer’s SEC SIC code.
          </li>
        </ul>
      </Panel>
      <Panel title="keys">
        <p>
          <kbd>/</kbd> search · <kbd>g</kbd> then <kbd>h</kbd> <kbd>m</kbd> <kbd>a</kbd> <kbd>p</kbd> <kbd>i</kbd> <kbd>e</kbd> to jump · <kbd>j</kbd>/<kbd>k</kbd> and <kbd>enter</kbd> in tables · <kbd>1</kbd>-<kbd>5</kbd> tabs · <kbd>?</kbd> help
        </p>
      </Panel>
      <Panel title="not advice">
        <p>Information only, not investment advice. Filings can be amended, late or wrong; check the linked SEC document before relying on a number.</p>
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
