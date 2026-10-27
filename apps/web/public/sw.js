/* Meridian Terminal service worker: offline shell + cached market data (stale-while-revalidate). */
const VERSION = 'meridian-v3';
const SHELL = ['/', '/index.html', '/theme-init.js', '/favicon.svg', '/apple-touch-icon.png', '/icon-192.png', '/manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Password gate pages (apps/server/src/gate.ts) always go to the network and are never cached.
  if (url.pathname === '/__login' || url.pathname === '/__logout') return;
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  if (/^\/api\/(bars|quotes|search)/.test(url.pathname)) {
    // network-first (live data must be fresh); the cached copy is the offline fallback
    const name = `${VERSION}-data`;
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone(); // clone synchronously, before the page consumes the body
            caches.open(name).then((c) => c.put(req, copy).then(() => trim(name, 300)));
          }
          return res;
        })
        .catch(() => caches.open(name).then((c) => c.match(req)).then((hit) => hit || Response.error())),
    );
    return;
  }
  if (req.mode === 'navigate') {
    // Cache only the real app shell: a sign-in redirect (opaque, status 0) or error page must never replace it.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.status === 200 && res.type === 'basic' && !res.redirected) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put('/index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
  }
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('/'))));
});
