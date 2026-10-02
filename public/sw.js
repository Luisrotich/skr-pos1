const CACHE = 'pos-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/admin.html',
  '/manifest-cashier.webmanifest',
  '/manifest-admin.webmanifest',
  '/icon-cashier.svg',
  '/icon-admin.svg'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache API or auth calls
  if (url.pathname.startsWith('/api/')){
    return;
  }

  // Network-first for page loads, fallback to cache
  if (e.request.mode === 'navigate'){
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match(e.request).then(r => r || caches.match('/index.html'))
      )
    );
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok && res.type === 'basic'){
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }))
  );
});