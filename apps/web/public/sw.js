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
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('/index.html', copy)); return res; }).catch(() => caches.match('/index.html')));
  }
});
// Web Push from the alert scheduler: arrives with every Meridian tab closed.
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Meridian alert', { body: d.body || '', tag: d.tag, renotify: !!d.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' } }),
  );
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      const c = cs.find((x) => new URL(x.url).origin === self.location.origin);
      if (!c) return self.clients.openWindow(url);
      return c.focus().then((w) => (url !== self.location.origin + '/' && w && 'navigate' in w ? w.navigate(url) : w));
    }),
  );
});
