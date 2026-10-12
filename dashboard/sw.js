const CACHE_NAME = 'asrs-v2.1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Network-first strategy for dynamic API calls, Cache-first for static UI
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Do not cache API requests or non-GET requests
  if (event.request.method !== 'GET' || url.pathname.startsWith('/auth') || url.pathname.startsWith('/slots') || url.pathname.startsWith('/transactions') || url.pathname.startsWith('/summary') || url.pathname.startsWith('/api') || url.pathname.startsWith('/rack') || url.pathname.startsWith('/hardware') || url.pathname.startsWith('/users')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(networkRes => {
        if (networkRes.ok) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkRes;
      })
      .catch(() => caches.match(event.request))
  );
});
