// Network-first service worker: makes the tablet app installable and lets the
// shell open instantly; live data always comes from the server.
const CACHE = 'inkvault-v2';
const SHELL = ['/tablet', '/build/tablet.js', '/styles/tablet.css', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', e => {
  // one missing file must not stop the worker from installing (that would block app install)
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
