// Holdterm's service worker: only so that a reload while offline shows Holdterm's own offline page instead of
// the browser's. It caches the app shell (the hashed script, stylesheet and Latin fonts) and /offline, nothing
// else. Pages are network-first with the offline page as the only fallback, and SEC data (on other hosts) is never
// touched, so nothing it shows can go stale. The build (vite.config.ts) fills in VERSION and SHELL; each deploy
// gets a new cache and deletes the old one.
const VERSION = '__VERSION__'
const SHELL = __SHELL__
const CACHE = `holdterm-shell-${VERSION}`

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['/offline', ...SHELL]))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('holdterm-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return
  // Pages: always the network; offline, the offline page.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline', { cacheName: CACHE })))
    return
  }
  // The shell's files are content-hashed, so a cached copy is never out of date.
  if (SHELL.includes(url.pathname)) e.respondWith(caches.match(req, { cacheName: CACHE }).then((r) => r || fetch(req)))
})
