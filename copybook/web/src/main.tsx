import { lazy, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './index.css'
import { Layout } from './components/Layout'
import { Home } from './pages/Home'
import { ManagerPage } from './pages/Manager'
import { StockPage } from './pages/Stock'
import { Season } from './pages/Season'
import { Recap } from './pages/Recap'
import { captureAttribution, captureRef } from './lib/attribution'
import { getToken, startSession } from './lib/account'
import { analytics } from './config'

// Pages people land on from search (home, investors, stocks, the season) ship in the main bundle;
// the rest load on first visit.
const Investors = lazy(() => import('./pages/Investors').then((m) => ({ default: m.Investors })))
const History = lazy(() => import('./pages/History').then((m) => ({ default: m.History })))
const Flow = lazy(() => import('./pages/Flow').then((m) => ({ default: m.Flow })))
const Consensus = lazy(() => import('./pages/Consensus').then((m) => ({ default: m.Consensus })))
const Pricing = lazy(() => import('./pages/Pricing').then((m) => ({ default: m.Pricing })))
const Account = lazy(() => import('./pages/Account').then((m) => ({ default: m.Account })))
const Book = lazy(() => import('./pages/Book').then((m) => ({ default: m.Book })))
const ForFunds = lazy(() => import('./pages/Personas').then((m) => ({ default: m.ForFunds })))
const ForQuants = lazy(() => import('./pages/Personas').then((m) => ({ default: m.ForQuants })))
const About = lazy(() => import('./pages/About').then((m) => ({ default: m.About })))
const Methodology = lazy(() => import('./pages/Methodology').then((m) => ({ default: m.Methodology })))
const ApiDocs = lazy(() => import('./pages/Api').then((m) => ({ default: m.ApiDocs })))
const Contact = lazy(() => import('./pages/Contact').then((m) => ({ default: m.Contact })))
const Legal = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Legal })))
const NotFound = lazy(() => import('./pages/NotFound').then((m) => ({ default: m.NotFound })))
const FilingCard = lazy(() => import('./pages/Filing').then((m) => ({ default: m.FilingCard })))
const Upgrade = lazy(() => import('./pages/Upgrade').then((m) => ({ default: m.Upgrade })))
const Speed = lazy(() => import('./pages/Speed').then((m) => ({ default: m.Speed })))

// The old refcell.github.io/gust/copybook/ pages redirect here. They pass a 2-minute sign-in token
// (from POST {api}/handoff, never the session itself) and the campaign touch in the hash, since
// localStorage doesn't cross origins. The sign-in token is exchanged like an emailed link.
let handoff: Promise<unknown> = Promise.resolve()
if (location.hash.startsWith('#handoff=')) {
  try {
    const h = JSON.parse(decodeURIComponent(location.hash.slice(9))) as { login?: string; utm?: string | null }
    if (h.utm && !localStorage.getItem('copybook-utm')) localStorage.setItem('copybook-utm', h.utm)
    if (h.login && !getToken()) handoff = startSession({ login: h.login }).catch(() => null)
  } catch {
    // Malformed handoff: ignore it.
  }
  history.replaceState(null, '', location.pathname + location.search)
}
captureAttribution()
captureRef()
if (analytics.cloudflare) {
  // Cloudflare Web Analytics: cookieless, SPA mode counts client-side navigations.
  const s = document.createElement('script')
  s.defer = true
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js'
  s.dataset.cfBeacon = JSON.stringify({ token: analytics.cloudflare, spa: true })
  document.head.appendChild(s)
}

// First paint waits briefly for the two preloaded web fonts (index.html), so headlines don't reflow when they
// swap in: that reflow was most of the home page's layout shift. Never more than 600 ms.
const fontsReady = Promise.race([
  Promise.all([document.fonts?.load('600 1em "Geist Variable"'), document.fonts?.load('italic 400 1em "Newsreader Variable"')]),
  new Promise((r) => setTimeout(r, 600)),
]).catch(() => null)

Promise.all([handoff, fontsReady]).then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="investors" element={<Investors />} />
            <Route path="investors/:slug" element={<ManagerPage />} />
            <Route path="investors/:slug/history" element={<History />} />
            <Route path="stocks/:ticker" element={<StockPage />} />
            <Route path="flow" element={<Flow />} />
            <Route path="season" element={<Season />} />
            <Route path="season/:quarter" element={<Recap />} />
            <Route path="season/:quarter/:view" element={<Recap />} />
            <Route path="for-funds" element={<ForFunds />} />
            <Route path="for-quants" element={<ForQuants />} />
            <Route path="consensus" element={<Consensus />} />
            <Route path="pricing" element={<Pricing />} />
            <Route path="account" element={<Account />} />
            <Route path="my-book" element={<Book />} />
            <Route path="upgrade" element={<Upgrade />} />
            <Route path="about" element={<About />} />
            <Route path="methodology" element={<Methodology />} />
            <Route path="f/:accession" element={<FilingCard />} />
            <Route path="speed" element={<Speed />} />
            <Route path="latency" element={<Navigate to="/speed/" replace />} />
            <Route path="api" element={<ApiDocs />} />
            <Route path="contact" element={<Contact />} />
            <Route path="terms" element={<Legal page="terms" />} />
            <Route path="privacy" element={<Legal page="privacy" />} />
            <Route path="security" element={<Legal page="security" />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </StrictMode>,
  ),
)
