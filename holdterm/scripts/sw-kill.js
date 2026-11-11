// Holdterm's service worker kill switch. Deleting sw.js does not remove a worker visitors already have: browsers
// keep running it. A build with VITE_HOLDTERM_SW=off deploys this file as /sw.js instead, and stops the page from
// registering a worker. Each visitor's browser picks it up on its next update check (any page load), and it then
// deletes Holdterm's caches, unregisters itself and reloads open Holdterm tabs, which come back with no worker.
// It has no fetch handler, so until then every request goes straight to the network.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('holdterm-shell-')) await caches.delete(k)
      await self.registration.unregister()
      // The reloaded pages don't register a worker again (the same build turns registration off), so this runs once.
      for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url).catch(() => {})
    })(),
  )
})
