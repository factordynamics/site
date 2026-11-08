import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { filerCiks, loadFilers, loadIndex, money, quarterLabel, secFilerUrl, type Filer, type Manager } from '../lib/data'
import { loadStockIndex, stockPath, tickerText, type StockRef } from '../lib/stocks'
import { Monogram, SearchIcon } from './ui'

type Hit = { kind: 'manager'; m: Manager } | { kind: 'filer'; f: Filer } | { kind: 'stock'; s: StockRef }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

function score(q: string, ...fields: string[]) {
  let best = 0
  for (const f of fields) {
    const n = norm(f)
    if (!n) continue
    if (n === q) best = Math.max(best, 100)
    else if (n.startsWith(q)) best = Math.max(best, 80)
    else if (n.split(' ').some((w) => w.startsWith(q))) best = Math.max(best, 60)
    else if (n.includes(q)) best = Math.max(best, 40)
  }
  return best
}

export function useSearch(query: string) {
  const [managers, setManagers] = useState<Manager[]>([])
  const [filers, setFilers] = useState<Filer[] | null>(null)
  const [stocks, setStocks] = useState<StockRef[] | null>(null)
  useEffect(() => {
    loadIndex().then((d) => setManagers(d.managers)).catch(() => null)
  }, [])
  useEffect(() => {
    if (query && !filers) loadFilers().then(setFilers).catch(() => setFilers([]))
    if (query && !stocks) loadStockIndex().then((d) => setStocks(d.stocks)).catch(() => setStocks([]))
  }, [query, filers, stocks])
  return useMemo<Hit[]>(() => {
    const q = norm(query)
    if (!q) return managers.filter((m) => m.featured).slice(0, 6).map((m) => ({ kind: 'manager', m }))
    const ms = managers
      .map((m) => ({ m, s: score(q, m.manager, m.name) }))
      .filter((x) => x.s > 0)
      .map((x) => ({ ...x, s: x.s + (x.m.featured ? 15 : 0) }))
      .sort((a, b) => b.s - a.s || (b.m.total_value ?? 0) - (a.m.total_value ?? 0))
      .slice(0, 6)
    // Tickers: exact or prefix match on any share class, then company names. Uppercase queries of
    // five letters or fewer read as tickers first (NVDA, COF).
    const up = tickerText(query)
    const tickerish = /^[A-Z.\-]{1,6}$/.test(up)
    const ss = (stocks || [])
      .map((x) => {
        const tick = x.t === up || x.a.includes(up) ? 120 : x.t.startsWith(up) && tickerish ? 70 : 0
        return { x, s: Math.max(tick, q.length >= 3 ? score(q, x.n) : 0) }
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.x.h - a.x.h)
      .slice(0, 4)
    // An ETF named after a fund ("AKRE") never outranks the fund itself.
    const etf = (x: StockRef) => x.s === 'Funds & ETFs'
    const exactTicker = ss.length > 0 && ss[0].s >= 120 && !etf(ss[0].x)
    const known = new Set(managers.map((m) => m.cik.replace(/^0+/, '')))
    const fs = (filers || [])
      .filter((f) => !known.has(f.cik.replace(/^0+/, '')))
      .map((f) => ({ f, s: score(q, f.name) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, ms.length || ss.length ? 3 : 8)
    const mh = ms.map(({ m }) => ({ kind: 'manager' as const, m }))
    const sh = ss.map(({ x }) => ({ kind: 'stock' as const, s: x }))
    const fh = fs.map(({ f }) => ({ kind: 'filer' as const, f }))
    if (exactTicker || (tickerish && !ms.length && !fh.length)) return [...sh, ...mh, ...fh]
    return [...mh, ...sh.filter((h) => !etf(h.s)), ...fh, ...sh.filter((h) => etf(h.s))]
  }, [query, managers, filers, stocks])
}

export function SearchBox({ size = 'md', autoFocus = false, placeholder = 'Search investors or tickers' }: { size?: 'md' | 'lg'; autoFocus?: boolean; placeholder?: string }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const hits = useSearch(q)
  const nav = useNavigate()
  const wrap = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && size === 'md') {
        e.preventDefault()
        input.current?.focus()
        setOpen(true)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [size])
  useEffect(() => setSel(0), [q])

  const go = (h: Hit) => {
    setOpen(false)
    setQ('')
    input.current?.blur()
    if (h.kind === 'manager') nav(`/investors/${h.m.slug}/`)
    else if (h.kind === 'stock') nav(stockPath(h.s.t))
    else if (h.f.ok === false) window.open(secFilerUrl(h.f.cik), '_blank', 'noopener')
    else {
      filerCiks.set(h.f.slug, h.f.cik)
      nav(`/investors/${h.f.slug}/`)
    }
  }

  const lg = size === 'lg'
  return (
    <div ref={wrap} className="relative w-full">
      <label className="sr-only" htmlFor={`search-${size}`}>
        Search investors, funds or tickers
      </label>
      <div
        className={`flex items-center gap-2.5 rounded-full bg-card transition-shadow ${
          lg ? 'h-14 pl-5 pr-2 shadow-[0_0_0_1px_var(--color-line-2),0_10px_30px_-12px_rgb(12_14_19/0.25)]' : 'h-9 pl-3 pr-2 shadow-[0_0_0_1px_var(--color-line)]'
        } focus-within:shadow-[0_0_0_2px_var(--color-accent)]`}
      >
        <SearchIcon className="shrink-0 text-ink-3" />
        <input
          ref={input}
          id={`search-${size}`}
          value={q}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-controls={`search-list-${size}`}
          aria-autocomplete="list"
          aria-activedescendant={open && hits[sel] ? `search-opt-${size}-${sel}` : undefined}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, hits.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter' && hits[sel]) {
              e.preventDefault()
              go(hits[sel])
            } else if (e.key === 'Escape') {
              setOpen(false)
              input.current?.blur()
            }
          }}
          className={`min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-3 ${lg ? 'text-[16px]' : 'text-[13.5px]'}`}
          style={{ outline: 'none' }}
        />
        {lg ? (
          <span className="hidden rounded-full bg-ink px-4 py-2 text-[14px] font-medium text-white sm:inline">Search</span>
        ) : (
          <kbd className="hidden rounded border border-line bg-paper px-1.5 font-sans text-[11px] text-ink-3 lg:inline">⌘K</kbd>
        )}
      </div>
      {open && hits.length > 0 && (
        <ul
          id={`search-list-${size}`}
          role="listbox"
          className={`absolute z-50 mt-2 max-h-[420px] w-full overflow-auto rounded-2xl bg-card p-1.5 shadow-[0_0_0_1px_rgb(12_14_19/0.08),0_18px_50px_-12px_rgb(12_14_19/0.3)] ${lg ? '' : 'min-w-[340px] right-0'}`}
        >
          {!q && <li role="presentation" className="px-3 pb-1 pt-2 text-[12px] font-medium text-ink-3">Popular</li>}
          {hits.map((h, i) => (
            <li
              key={h.kind === 'manager' ? h.m.slug : h.kind === 'stock' ? `s-${h.s.t}` : h.f.cik}
              id={`search-opt-${size}-${i}`}
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => go(h)}
              className={`flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left ${i === sel ? 'bg-ink/[0.05]' : ''}`}
            >
                {h.kind === 'manager' ? (
                  <>
                    <Monogram name={h.m.manager} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">{h.m.manager}</span>
                      <span className="block truncate text-[12.5px] text-ink-3">{h.m.name !== h.m.manager ? h.m.name : `${(h.m.position_count ?? 0).toLocaleString('en-US')} positions`}</span>
                    </span>
                    <span className="num text-[13px] text-ink-2">{money(h.m.total_value)}</span>
                  </>
                ) : h.kind === 'stock' ? (
                  <>
                    <span className="flex h-[30px] min-w-[30px] items-center justify-center rounded-lg bg-accent-soft px-1.5 font-mono text-[10.5px] font-semibold text-accent-2">{h.s.t.length > 4 ? h.s.t.slice(0, 4) : h.s.t}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">
                        <span className="font-mono">{h.s.t}</span> <span className="font-normal text-ink-2">{h.s.n}</span>
                      </span>
                      <span className="block truncate text-[12.5px] text-ink-3">Stock · held by {h.s.h} {h.s.h === 1 ? 'fund' : 'funds'} we track</span>
                    </span>
                  </>
                ) : (
                  <>
                    {h.f.ok === false ? (
                      <span className="flex size-[30px] items-center justify-center rounded-full bg-ink/[0.06] text-[11px] font-semibold text-ink-3">SEC</span>
                    ) : (
                      <Monogram name={h.f.name} size={30} />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">{h.f.name}</span>
                      <span className="block truncate text-[12.5px] text-ink-3">
                        {h.f.ok === false ? '13F filer · opens on SEC EDGAR' : `13F filer${h.f.position_count ? ` · ${h.f.position_count.toLocaleString('en-US')} positions` : ''}${h.f.quarter ? ` · ${quarterLabel(h.f.quarter)}` : ''}`}
                      </span>
                    </span>
                  </>
                )}
              </li>
          ))}
        </ul>
      )}
    </div>
  )
}
