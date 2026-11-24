import { Suspense, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { getToken, isPaying, useMemberState } from '../lib/account'
import { SearchBox } from './Search'
import { Boundary, Button, Wordmark } from './ui'
import { UpdatePrompt } from './UpdatePrompt'

// The Factor Dynamics sections (S1): labels over today's paths, no new URLs. Stocks opens on Consensus (every stock
// page is reached by search); Insiders is Coming with no page; Terminal is Holdterm until S2 builds /terminal/.
type NavItem = { to: string; label: string; end?: boolean; soon?: boolean; external?: boolean }
const NAV: NavItem[] = [
  { to: '/', label: 'Today', end: true },
  { to: '/investors/', label: 'Investors' },
  { to: '/consensus/', label: 'Stocks' },
  { to: '', label: 'Insiders', soon: true },
  { to: '/my-book/', label: 'My book' },
  { to: 'https://holdterm.factordynamics.com/', label: 'Terminal', external: true },
]

export function Layout() {
  const { pathname, hash } = useLocation()
  // Re-read on every route change, so it updates after checkout or sign-out. A session whose /me failed with
  // nothing cached (member null) gets the signed-out header, so the trial is always one click away.
  const member = useMemberState()
  const signedIn = Boolean(getToken()) && member !== null
  // Only paying members (active, trialing or paused on Copy or above) lose the trial button; a free or
  // cancelled member keeps it, with Account beside it.
  const paying = signedIn && isPaying(member)
  // While a stored session's /me loads, show neither: a trialing or paid member never sees "Try Copy free" flash.
  const cta = !(getToken() && member === undefined)
  const nav = NAV
  const [menu, setMenu] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    setMenu(false)
    // A link to a section (/security/#who-can-see-member-data) scrolls to it once the lazy page renders.
    const id = hash.slice(1)
    // Current Chrome returns a Promise from scrollTo; an effect must return nothing or a cleanup function.
    if (!id || id.includes('=')) {
      window.scrollTo(0, 0)
      return
    }
    // Sections above the target can finish loading after the first scroll (/account/#channels landed too high about
    // one load in two): keep the target in place until it has held still for half a second, for at most 5 seconds,
    // and stop as soon as the visitor scrolls themselves.
    let n = 0
    let still = 0
    let last: number | null = null
    const stop = () => clearInterval(t)
    const t = setInterval(() => {
      if (++n > 50) return stop()
      const el = document.getElementById(decodeURIComponent(id))
      if (!el) return
      const top = Math.round(el.getBoundingClientRect().top + window.scrollY)
      if (top !== last) {
        still = 0
        last = top
        el.scrollIntoView()
      } else if (++still >= 5) stop()
    }, 100)
    const opts = { passive: true, once: true } as const
    window.addEventListener('wheel', stop, opts)
    window.addEventListener('touchstart', stop, opts)
    window.addEventListener('keydown', stop, opts)
    return () => {
      stop()
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchstart', stop)
      window.removeEventListener('keydown', stop)
    }
  }, [pathname, hash])
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
          <Link to="/" aria-label="Factor Dynamics home" className="shrink-0">
            <Wordmark />
          </Link>
          <nav className="hidden items-center gap-0.5 whitespace-nowrap lg:flex" aria-label="Main">
            {nav.map((n) => (
              <NavItemLink key={n.label} n={n} className={(on) => `rounded-full px-3 py-1.5 text-[14px] transition-colors ${on ? 'text-ink font-medium' : 'text-ink-2 hover:text-ink'}`} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {!home && (
              <div className={`hidden xl:block ${signedIn && !paying ? 'w-44 2xl:w-52' : 'w-56'}`}>
                <SearchBox />
              </div>
            )}
            <NavLink to="/pricing/" className={({ isActive }) => `hidden h-8 items-center rounded-full px-3 text-[13px] font-medium lg:inline-flex ${isActive ? 'text-ink' : 'text-ink-2 hover:text-ink'}`}>
              Pricing
            </NavLink>
            {signedIn && !paying && (
              <Link to="/account/" className="hidden h-8 items-center rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-ink/5 hover:text-ink sm:inline-flex">
                Account
              </Link>
            )}
            {cta && (
              <Button to={paying ? '/account/' : '/pricing/'} size="sm" variant="dark" className="hidden sm:inline-flex">
                {paying ? 'Account' : 'Try Plus free'}
              </Button>
            )}
            <button
              type="button"
              className="-mr-2 inline-flex size-10 items-center justify-center rounded-full text-ink lg:hidden"
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
          <div className="container-x border-t border-line pb-5 pt-3 lg:hidden">
            <SearchBox />
            <nav className="mt-3 grid" aria-label="Mobile">
              {nav.map((n) => (
                <NavItemLink key={n.label} n={n} className={(on) => `border-b border-line py-3 text-[16px] ${on ? 'font-medium text-ink' : 'text-ink-2'}`} />
              ))}
              <NavLink to="/pricing/" className={({ isActive }) => `border-b border-line py-3 text-[16px] ${isActive ? 'font-medium text-ink' : 'text-ink-2'}`}>
                Pricing
              </NavLink>
            </nav>
            {cta && (
              <Button to={paying ? '/account/' : '/pricing/'} variant="dark" className="mt-4 w-full">
                {paying ? 'Account' : 'Try Plus free'}
              </Button>
            )}
            {signedIn && !paying && (
              <Button to="/account/" variant="outline" className="mt-2 w-full">
                Account
              </Button>
            )}
          </div>
        )}
      </header>
      <main id="main" className="flex-1">
        {/* Lazy pages: the footer stays below the fold while their code loads. */}
        <Suspense fallback={<div className="min-h-screen" />}>
          <Boundary key={pathname} full>
            <Outlet />
          </Boundary>
        </Suspense>
      </main>
      <Footer />
    </div>
  )
}

function NavItemLink({ n, className }: { n: NavItem; className: (active: boolean) => string }) {
  if (n.soon)
    return (
      <span className={`${className(false)} inline-flex cursor-default items-center gap-1.5`} aria-disabled="true">
        {n.label}
        <span className="rounded-full bg-ink/[0.06] px-1.5 py-px text-[10.5px] font-medium uppercase tracking-wide text-ink-3">Coming</span>
      </span>
    )
  if (n.external)
    return (
      <a href={n.to} className={className(false)}>
        {n.label}
      </a>
    )
  return (
    <NavLink to={n.to} end={n.end} className={({ isActive }) => className(isActive)}>
      {n.label}
    </NavLink>
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
          <p className="mt-3 text-[13.5px] text-white/80">Copybook is now Factor Dynamics.</p>
          <a href="https://itscreo.com/" className="mt-2 block text-[13.5px] text-white/60 hover:text-white">
            creo, our factor exposure API
          </a>
          <a href="mailto:hello@factordynamics.com" className="mt-4 inline-block text-[14px] text-white/80 hover:text-white">
            hello@factordynamics.com
          </a>
        </div>
        <FooterCol title="Product" links={[['Today', '/'], ['Investors', '/investors/'], ['Stocks', '/consensus/'], ['My book', '/my-book/'], ['Flow', '/flow/'], ['Pricing', '/pricing/'], ['For funds', '/for-funds/'], ['For quants', '/for-quants/'], ['API', '/api/']]} />
        <FooterCol title="Company" links={[['About', '/about/'], ['Methodology', '/methodology/'], ['Data quality', '/data-quality/'], ['Contact', '/contact/'], ['Terms', '/terms/'], ['Privacy', '/privacy/'], ['Security', '/security/'], ['Status', '/status/']]} />
        <FooterCol title="Popular" links={[['Berkshire Hathaway', '/investors/warren-buffett/'], ['Bill Ackman', '/investors/bill-ackman/'], ['Stanley Druckenmiller', '/investors/stanley-druckenmiller/']]} />
      </div>
      <div className="border-t border-night-line">
        <div className="container-x flex flex-col gap-2 py-6 text-[12.5px] text-white/60 md:flex-row md:items-center md:justify-between">
          <p>© 2026 Factor Dynamics. Data from SEC EDGAR Form 13F-HR, as filed. <span className="num text-ink-3/70">build {import.meta.env.VITE_BUILD}</span></p>
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
