import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import { Layout } from './components/Layout'
import { Home } from './pages/Home'
import { Investors } from './pages/Investors'
import { ManagerPage } from './pages/Manager'
import { History } from './pages/History'
import { Consensus } from './pages/Consensus'
import { Pricing } from './pages/Pricing'
import { Account } from './pages/Account'
import { About } from './pages/About'
import { NotFound } from './pages/NotFound'
import { captureAttribution } from './lib/attribution'
import { analytics } from './config'

captureAttribution()
if (analytics.cloudflare) {
  // Cloudflare Web Analytics: cookieless, SPA mode counts client-side navigations.
  const s = document.createElement('script')
  s.defer = true
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js'
  s.dataset.cfBeacon = JSON.stringify({ token: analytics.cloudflare, spa: true })
  document.head.appendChild(s)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="investors" element={<Investors />} />
          <Route path="investors/:slug" element={<ManagerPage />} />
          <Route path="investors/:slug/history" element={<History />} />
          <Route path="consensus" element={<Consensus />} />
          <Route path="pricing" element={<Pricing />} />
          <Route path="account" element={<Account />} />
          <Route path="about" element={<About />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
