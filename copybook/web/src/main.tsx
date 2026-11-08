import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import { Layout } from './components/Layout'
import { Home } from './pages/Home'
import { Investors } from './pages/Investors'
import { ManagerPage } from './pages/Manager'
import { History } from './pages/History'
import { StockPage } from './pages/Stock'
import { Flow } from './pages/Flow'
import { Consensus } from './pages/Consensus'
import { Pricing } from './pages/Pricing'
import { Account } from './pages/Account'
import { About } from './pages/About'
import { NotFound } from './pages/NotFound'
import { captureAttribution } from './lib/attribution'
import { getToken, startSession } from './lib/account'
import { analytics } from './config'

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
if (analytics.cloudflare) {
  // Cloudflare Web Analytics: cookieless, SPA mode counts client-side navigations.
  const s = document.createElement('script')
  s.defer = true
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js'
  s.dataset.cfBeacon = JSON.stringify({ token: analytics.cloudflare, spa: true })
  document.head.appendChild(s)
}

handoff.then(() =>
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
            <Route path="consensus" element={<Consensus />} />
            <Route path="pricing" element={<Pricing />} />
            <Route path="account" element={<Account />} />
            <Route path="about" element={<About />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </StrictMode>,
  ),
)
