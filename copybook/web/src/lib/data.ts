import { useEffect, useState } from 'react'
import { displayName } from './names.mjs'
export { displayName }

export const BASE = import.meta.env.BASE_URL
// Data can live on another origin (VITE_DATA_BASE); GitHub Pages serves it with CORS *.
export const DATA: string = import.meta.env.VITE_DATA_BASE || `${BASE}data/`

export type Change = 'new' | 'added' | 'trimmed' | 'exited' | 'unchanged'

export type Holding = {
  issuer: string
  cusip: string
  ticker: string | null
  title?: string
  put_call?: string | null
  shares: number
  value: number
  weight: number
  prev_shares?: number | null
  prev_value?: number | null
  /** Clean name from ingest; issuer stays the as-filed name. */
  display_name?: string | null
  /** GICS-style sector from ingest. */
  sector?: string | null
  /** As-filed issuer name, kept for tooltips. */
  filed?: string
  change?: Change | null
}

export type Manager = {
  cik: string
  name: string
  manager: string
  slug: string
  ok: boolean
  quarter?: string
  filing_date?: string
  report_date?: string
  sec_url?: string
  position_count?: number
  total_value?: number
  history_quarters?: string[]
  prev_quarter?: string | null
  prev_total_value?: number | null
  changes?: { new: number; added: number; trimmed: number; exited: number; unchanged: number } | null
  featured?: boolean
  top?: Holding[]
  /** A page built from the all-filer shard (data/f/{cik}.json): latest quarter only. */
  filer?: boolean
  /** The shard keeps only the largest positions of very large books. */
  truncated?: boolean
}

export type ManagerFile = Manager & { holdings: Holding[] }

export type Filer = { cik: string; name: string; slug: string; filing_date?: string; ok?: boolean; position_count?: number; quarter?: string }

export type Sectors = { sectors: string[]; map: Record<string, number> }

const cache = new Map<string, Promise<unknown>>()

export function getJSON<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`)
      return r.json() as Promise<T>
    })
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}


let sectorsData: Sectors | null = null
export const loadSectors = () =>
  getJSON<Sectors>(`${BASE}sectors.json`).then((s) => {
    sectorsData = s
    return s
  })

export function cleanHolding(h: Holding): Holding {
  return { ...h, filed: h.issuer, issuer: h.display_name || displayName(h.issuer), ticker: h.ticker || null }
}
/** Ingest sometimes names an ETF trust rather than the fund (every iShares CUSIP as "iShares Core S&P 500 ETF"):
 *  a display name shared by several tickers in one book is dropped, so the issuer name shows instead. */
function cleanBook(holdings: Holding[]): Holding[] {
  const tickers = new Map<string, Set<string>>()
  // Share classes (BRK.A, BRK.B) may share a name; count ticker roots.
  for (const h of holdings) if (h.display_name && h.ticker) (tickers.get(h.display_name) ?? tickers.set(h.display_name, new Set()).get(h.display_name)!).add(h.ticker.split(/[.-]/)[0])
  return holdings.map((h) => cleanHolding(h.display_name && (tickers.get(h.display_name)?.size ?? 0) > 1 ? { ...h, display_name: undefined } : h))
}

export type IndexData = {
  generated_at: string
  managers: Manager[]
  featured: Manager[]
  totalValue: number
  filerCount: number
}

export async function loadIndex(): Promise<IndexData> {
  const [idx, uni] = await Promise.all([
    getJSON<{ generated_at: string; managers: Manager[] }>(`${DATA}index.json`),
    getJSON<{ curated: { slug: string; featured?: boolean }[]; filer_count?: number }>(`${DATA}universe.json`).catch(
      () => ({ curated: [], filer_count: 0 }),
    ),
  ])
  await loadSectors().catch(() => null)
  const feat = new Set(uni.curated.filter((u) => u.featured).map((u) => u.slug))
  const managers = idx.managers
    .filter((m) => m.ok && (m.total_value ?? 0) > 0)
    .map((m) => ({
      ...m,
      featured: m.featured ?? feat.has(m.slug),
      manager: displayName(m.manager),
      name: displayName(m.name),
      top: (m.top || []).map(cleanHolding),
    }))
    .sort((a, b) => (b.total_value ?? 0) - (a.total_value ?? 0))
  return {
    generated_at: idx.generated_at,
    managers,
    featured: managers.filter((m) => m.featured),
    totalValue: managers.reduce((s, m) => s + (m.total_value ?? 0), 0),
    filerCount: uni.filer_count ?? 0,
  }
}

/** Slug -> CIK for filer pages; seeded by the prerendered page and by links, else filers.json. */
export const filerCiks = new Map<string, string>()
if (typeof document !== 'undefined') {
  const meta = document.querySelector('meta[name="cb-filer"]')?.getAttribute('content')?.split(':')
  if (meta?.length === 2) filerCiks.set(meta[0], meta[1])
}

/** Thrown when a filer slug belongs to a fund that has its own curated page. */
export class CuratedRedirect extends Error {
  slug: string
  constructor(slug: string) {
    super(slug)
    this.slug = slug
  }
}

type Shard = { cik: string; name: string; accession?: string; filing_date: string; report_date: string; quarter: string; prev_quarter?: string | null; sec_url: string; position_count: number; total_value: number; truncated?: boolean; columns: string[]; rows: unknown[][] }

/** Any 13F filer's latest filing, from data/f/{cik}.json. */
async function loadFiler(slug: string): Promise<ManagerFile> {
  let cik = filerCiks.get(slug)
  if (!cik) {
    const all = await getJSON<{ filers: Filer[] }>(`${DATA}filers.json`)
    cik = all.filers.find((f) => f.slug === slug && f.ok !== false)?.cik
    if (!cik) throw new Error(`404 ${slug}`)
  }
  const idx = await getJSON<{ managers: Manager[] }>(`${DATA}index.json`)
  const curated = idx.managers.find((m) => m.ok && m.cik.replace(/^0+/, '') === cik!.replace(/^0+/, ''))
  if (curated) throw new CuratedRedirect(curated.slug)
  const f = await getJSON<Shard>(`${DATA}f/${cik.padStart(10, '0')}.json`)
  const col = Object.fromEntries(f.columns.map((c, i) => [c, i]))
  const total = f.total_value || 1
  const holdings = cleanBook(
    f.rows.map((r) => ({
      ticker: (r[col.ticker] as string) || null,
      issuer: r[col.issuer] as string,
      title: r[col.title] as string,
      cusip: r[col.cusip] as string,
      put_call: (r[col.put_call] as string) || null,
      shares: Number(r[col.shares]) || 0,
      value: Number(r[col.value]) || 0,
      display_name: r[col.display_name] as string,
      sector: r[col.sector] as string,
      weight: (Number(r[col.value]) || 0) / total,
      // Ingest adds the prior quarter for followed filers; its change fields are used as filed, never derived here.
      ...(col.change != null && f.prev_quarter
        ? { change: (r[col.change] as Holding['change']) || null, prev_shares: Number(r[col.prev_shares]) || 0, prev_value: Number(r[col.prev_value]) || 0 }
        : {}),
    }))
  )
  const name = displayName(f.name)
  return {
    cik: f.cik,
    name,
    manager: name,
    slug,
    ok: true,
    quarter: f.quarter,
    prev_quarter: col.change != null ? f.prev_quarter ?? undefined : undefined,
    filing_date: f.filing_date,
    report_date: f.report_date,
    sec_url: f.sec_url,
    position_count: f.position_count,
    total_value: f.total_value,
    truncated: f.truncated,
    filer: true,
    holdings,
  }
}

export async function loadManager(slug: string): Promise<ManagerFile> {
  await loadSectors().catch(() => null)
  // Curated slugs never end in the "-NNNN" CIK suffix that every filers.json slug carries.
  if (/-\d{1,4}$/.test(slug) && !(await getJSON<{ managers: Manager[] }>(`${DATA}index.json`)).managers.some((m) => m.slug === slug)) return loadFiler(slug)
  const m = await getJSON<ManagerFile>(`${DATA}${slug}.json`)
  return {
    ...m,
    manager: displayName(m.manager),
    name: displayName(m.name),
    holdings: cleanBook(m.holdings || []),
  }
}

export const loadFilers = () =>
  getJSON<{ filers: Filer[] }>(`${DATA}filers.json`).then((d) => d.filers.map((f) => ({ ...f, name: displayName(f.name) })))

/** Consensus book across the featured investors, computed from their filings. */
export type BookRow = {
  key: string
  issuer: string
  ticker: string | null
  cusip: string
  put_call?: string | null
  title?: string
  value: number
  weight: number
  sector?: string | null
  holders: { slug: string; name: string; weight: number }[]
  avgWeight: number
}

export async function loadSuperBook(featured: Manager[]) {
  const files = await Promise.all(featured.map((m) => loadManager(m.slug).catch(() => null)))
  const rows = new Map<string, BookRow>()
  let total = 0
  for (const f of files) {
    if (!f) continue
    for (const h of f.holdings) {
      if (!h.value) continue
      const key = `${h.cusip}|${h.put_call || ''}`
      let r = rows.get(key)
      if (!r) {
        r = { key, issuer: h.issuer, ticker: h.ticker, cusip: h.cusip, put_call: h.put_call, title: h.title, sector: h.sector, value: 0, weight: 0, holders: [], avgWeight: 0 }
        rows.set(key, r)
      }
      r.value += h.value
      r.ticker ||= h.ticker
      r.holders.push({ slug: f.slug, name: f.manager, weight: h.weight })
      total += h.value
    }
  }
  const list = [...rows.values()]
  for (const r of list) {
    r.weight = total ? r.value / total : 0
    r.holders.sort((a, b) => b.weight - a.weight)
    r.avgWeight = r.holders.reduce((s, x) => s + x.weight, 0) / r.holders.length
  }
  list.sort((a, b) => b.holders.length - a.holders.length || b.value - a.value)
  return { rows: list, total, managers: files.filter(Boolean) as ManagerFile[] }
}

// Ingest publishes GICS names; the charts use short labels with fixed colours.
const GICS: Record<string, string> = {
  'Information Technology': 'Technology',
  'Communication Services': 'Communication',
  'Consumer Discretionary': 'Consumer',
  'Consumer Staples': 'Staples',
  'Health Care': 'Health care',
  'Real Estate': 'Real estate',
  Unclassified: 'Other',
}

/** Sector from ingest when the row carries one, else the SEC SIC map shipped with the site. */
export function sectorOf(cusip: string, fromIngest?: string | null): string {
  if (fromIngest) return GICS[fromIngest] ?? fromIngest
  const s = sectorsData
  if (!s) return 'Other'
  const i = s.map[cusip]
  return i === undefined ? 'Other' : s.sectors[i]
}

export function sectorMix(holdings: { cusip: string; value: number; sector?: string | null }[]) {
  const by = new Map<string, number>()
  let total = 0
  for (const h of holdings) {
    const k = sectorOf(h.cusip, h.sector)
    by.set(k, (by.get(k) ?? 0) + h.value)
    total += h.value
  }
  return [...by.entries()]
    .map(([name, value]) => ({ name, value, share: total ? value / total : 0 }))
    .sort((a, b) => (a.name === 'Other' ? 1 : b.name === 'Other' ? -1 : b.value - a.value))
}

/** A counter that ticks every `ms` while `on` and the tab is visible, and on returning to the tab: for re-polling. */
export function useTick(ms: number, on: boolean) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!on) return
    const bump = () => document.visibilityState === 'visible' && setN((x) => x + 1)
    const id = setInterval(bump, ms)
    document.addEventListener('visibilitychange', bump)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', bump)
    }
  }, [ms, on])
  return n
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true })
  useEffect(() => {
    let live = true
    set((s) => ({ data: s.data, loading: true }))
    fn().then(
      (data) => live && set({ data, loading: false }),
      (error: Error) => live && set({ error, loading: false }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

/* ---------- formatting ---------- */

export function money(n?: number | null, digits = 1) {
  const v = Number(n) || 0
  const a = Math.abs(v)
  if (a >= 1e12) return `$${(v / 1e12).toFixed(digits + 1)}T`
  if (a >= 1e9) return `$${(v / 1e9).toFixed(digits)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(digits)}M`
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}
export const pct = (w?: number | null, d = 1) => `${((Number(w) || 0) * 100).toFixed(d)}%`
export function sharesFmt(n?: number | null) {
  const v = Number(n) || 0
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toLocaleString('en-US')
}
export function quarterLabel(q?: string) {
  if (!q) return ''
  const m = /^(\d{4})Q(\d)$/.exec(q)
  return m ? `Q${m[2]} ${m[1]}` : q
}
export function dateLabel(d?: string) {
  if (!d) return ''
  const t = new Date(`${d.slice(0, 10)}T12:00:00Z`)
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}


/** "BANK OF AMER CORP" -> "Bank of Amer Corp". Mixed-case input is left alone. */

const LEGAL = /^(llc|lp|llp|l|p|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|gp|sa|ag|se|nv|the|of|and|et|al)$/i
export function initials(name: string) {
  const all = name.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean)
  const kept = all.filter((w) => !LEGAL.test(w))
  const parts = kept.length ? kept : all
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? '')).toUpperCase()
}

export function concentration(holdings: { weight: number }[], n = 10) {
  return [...holdings].sort((a, b) => b.weight - a.weight).slice(0, n).reduce((s, h) => s + h.weight, 0)
}

export const secFilerUrl = (cik: string) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=13F-HR&dateb=&owner=include&count=40`

export const shareClass = (title?: string) => {
  const t = (title || '').toUpperCase()
  if (/\bCL(ASS)? A\b/.test(t)) return 'Class A'
  if (/\bCL(ASS)? B\b/.test(t)) return 'Class B'
  if (/\bCL(ASS)? C\b/.test(t)) return 'Class C'
  return ''
}

/** Ticker when the filing maps to one, otherwise the first words of the issuer. */
export const shortName = (issuer: string) => issuer.split(' ').slice(0, 2).join(' ')

/** Keeps document.title in sync on client-side navigation. */
export function useTitle(title?: string) {
  useEffect(() => {
    if (title) document.title = title
  }, [title])
}
