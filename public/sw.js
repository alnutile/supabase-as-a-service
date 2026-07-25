// Minimal service worker for SupaNet's PWA.
//
// Its main job is to satisfy Chrome/Edge's install criteria (an installable PWA
// needs a manifest AND a service worker with a fetch handler), so the browser
// offers "Install app". It also adds a lightweight offline app-shell.
//
// Deliberately conservative: we only ever touch same-origin GET requests. Every
// Supabase call, edge-function/SSE stream, realtime socket, auth redirect, and
// cross-origin request bypasses the worker untouched — so nothing about the live,
// data-driven behavior of the app changes.

const VERSION = 'v1'
const SHELL_CACHE = `supanet-shell-${VERSION}`
const ASSET_CACHE = `supanet-assets-${VERSION}`
const OFFLINE_URL = '/index.html'

self.addEventListener('install', (event) => {
  // Pre-cache the app shell so a cold offline navigation still boots the SPA.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.add(OFFLINE_URL))
      .catch(() => {}),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Drop caches from older versions of this worker.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map((k) => caches.delete(k)),
        ),
      ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  // Never intercept Supabase / other origins — keep realtime, auth, SSE, and
  // function calls straight-to-network.
  if (url.origin !== self.location.origin) return

  // App navigations: network-first so content is always fresh; fall back to the
  // cached shell only when the network is unavailable.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(OFFLINE_URL).then((r) => r || Response.error()),
      ),
    )
    return
  }

  // Hashed build assets are immutable (their name changes per build), so a
  // cache-first read is safe and speeds up repeat loads.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            const copy = res.clone()
            caches
              .open(ASSET_CACHE)
              .then((c) => c.put(req, copy))
              .catch(() => {})
            return res
          }),
      ),
    )
    return
  }

  // Everything else (favicon, manifest, etc.): go straight to the network.
})
