const VERSION = 'v5';
const SHELL_CACHE = `kpop-shell-${VERSION}`;
const API_CACHE = `kpop-api-${VERSION}`;
const SHELL_ASSETS = [
  '/',
  '/styles.css',
  '/config.js',
  '/artists.js',
  '/lib/settings.js',
  '/lib/feed.js',
  '/lib/text.js',
  '/js/main.js',
  '/js/lock.js',
  '/js/api.js',
  '/js/push.js',
  '/js/pwa.js',
  '/js/state.js',
  '/js/storage.js',
  '/js/store.js',
  '/js/sync.js',
  '/js/ui.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

// A new worker waits until the page asks it to take over (the "Update" button).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, API_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: fresh content when online, cached copy when offline.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

// Stale-while-revalidate: instant from cache, refreshed in the background.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await refresh) || Response.error();
}

// ---------- web push ----------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'K-Pop Tracker', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      image: typeof data.image === 'string' && data.image.startsWith('https://') ? data.image : undefined,
      tag: data.tag || 'kpop-news',
      renotify: true,
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  let target;
  try {
    target = new URL(raw, self.location.origin);
  } catch {
    target = new URL('/', self.location.origin);
  }
  if (target.protocol !== 'https:') target = new URL('/', self.location.origin);

  event.waitUntil((async () => {
    if (target.origin !== self.location.origin) return self.clients.openWindow(target.href);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (app) return app.focus();
    return self.clients.openWindow(target.href);
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      networkFirst(request, SHELL_CACHE).catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});
