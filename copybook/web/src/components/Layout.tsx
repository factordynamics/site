import { Suspense, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { getToken } from '../lib/account'
import { quarterLabel } from '../lib/data'
import { seasonNow } from '../lib/stocks'
import { SearchBox } from './Search'
import { Button, Wordmark } from './ui'
import { UpdatePrompt } from './UpdatePrompt'

const NAV = [
  { to: '/investors/', label: 'Investors' },
  { to: '/flow/', label: 'Flow' },
  { to: '/consensus/', label: 'Consensus' },
  { to: '/pricing/', label: 'Pricing' },
  { to: '/about/', label: 'About' },
]

export function Layout() {
  const { pathname } = useLocation()
  // Re-read on every route change, so it updates after checkout or sign-out.
  const signedIn = Boolean(getToken())
  const sn = seasonNow()
  // During a 13F season the tracker sits after Flow.
  const base = sn.live ? [...NAV.slice(0, 2), { to: '/season/', label: `${quarterLabel(sn.quarter).split(' ')[0]} season` }, ...NAV.slice(2)] : NAV
  const nav = signedIn ? [...base.slice(0, base.length - 2), { to: '/my-book/', label: 'My book' }, ...base.slice(-2)] : base
  const [menu, setMenu] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    window.scrollTo(0, 0)
    setMenu(false)
  }, [pathname])
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  const home = pathname === '/'

  return (
    <div className="flex min-h-dvh flex-col">
      <UpdatePrompt />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <header className={`sticky top-0 z-40 transition-[background,box-shadow] ${scrolled || menu ? 'bg-paper/85 shadow-[0_1px_0_var(--color-line)] backdrop-blur-xl' : 'bg-transparent'}`}>
        <div className="container-x flex h-16 items-center gap-6">
          <Link to="/" aria-label="Copybook home" className="shrink-0">
            <Wordmark />
          </Link>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) => `rounded-full px-3 py-1.5 text-[14px] transition-colors ${isActive ? 'text-ink font-medium' : 'text-ink-2 hover:text-ink'}`}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {!home && (
              <div className="hidden w-64 lg:block">
                <SearchBox />
              </div>
            )}
            <Button to={signedIn ? '/account/' : '/pricing/'} size="sm" variant="dark" className="hidden sm:inline-flex">
              {signedIn ? 'Account' : 'Try Copy free'}
            </Button>
            <button
              type="button"
              className="-mr-2 inline-flex size-10 items-center justify-center rounded-full text-ink md:hidden"
              aria-label={menu ? 'Close menu' : 'Open menu'}
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                {menu ? <path d="M5 5l10 10M15 5 5 15" /> : <path d="M3 6.5h14M3 13.5h14" />}
              </svg>
            </button>
          </div>
        </div>
        {menu && (
          <div className="container-x border-t border-line pb-5 pt-3 md:hidden">
            <SearchBox />
            <nav className="mt-3 grid" aria-label="Mobile">
              {nav.map((n) => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => `border-b border-line py-3 text-[16px] ${isActive ? 'font-medium text-ink' : 'text-ink-2'}`}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <Button to={signedIn ? '/account/' : '/pricing/'} variant="dark" className="mt-4 w-full">
              {signedIn ? 'Account' : 'Try Copy free'}
            </Button>
          </div>
        )}
      </header>
      <main id="main" className="flex-1">
        {/* Lazy pages: the footer stays below the fold while their code loads. */}
        <Suspense fallback={<div className="min-h-screen" />}>
          <Outlet />
        </Suspense>
      </main>
      <Footer />
    </div>
  )
}

function Footer() {
  return (
    <footer className="mt-24 bg-night text-white/70">
      <div className="container-x grid gap-10 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="max-w-sm">
          <Wordmark dark />
          <p className="mt-4 text-[14px] leading-relaxed text-white/60">
            Portfolios of the world’s great investors, read straight from their SEC filings.
          </p>
          <a href="mailto:hello@factordynamics.com" className="mt-4 inline-block text-[14px] text-white/80 hover:text-white">
            hello@factordynamics.com
          </a>
        </div>
        <FooterCol title="Product" links={[['Investors', '/investors/'], ['Flow', '/flow/'], ['Pricing', '/pricing/'], ['For funds', '/for-funds/'], ['For quants', '/for-quants/'], ['API', '/api/']]} />
        <FooterCol title="Company" links={[['About', '/about/'], ['Methodology', '/methodology/'], ['Contact', '/contact/'], ['Terms', '/terms/'], ['Privacy', '/privacy/'], ['Security', '/security/']]} />
        <FooterCol title="Popular" links={[['Warren Buffett', '/investors/warren-buffett/'], ['Bill Ackman', '/investors/bill-ackman/'], ['Stanley Druckenmiller', '/investors/stanley-druckenmiller/']]} />
      </div>
      <div className="border-t border-night-line">
        <div className="container-x flex flex-col gap-2 py-6 text-[12.5px] text-white/60 md:flex-row md:items-center md:justify-between">
          <p>© 2026 Factor Dynamics. Data from SEC EDGAR Form 13F-HR, as filed.</p>
          <p>Holdings are reported about 45 days after quarter end. Not investment advice.</p>
        </div>
      </div>
    </footer>
  )
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="text-[13px] font-medium text-white">{title}</p>
      <ul className="mt-4 space-y-2.5 text-[14px]">
        {links.map(([l, to]) => (
          <li key={to}>
            <Link to={to} className="text-white/60 hover:text-white">
              {l}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
