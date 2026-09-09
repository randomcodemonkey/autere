/**
 * autere service worker.
 *
 * Purpose: make home-screen (standalone) web apps pick up new assets
 * WITHOUT closing and reopening the app.
 *
 * Strategy: network-first for app shell requests (HTML, hashed assets,
 * manifest, icons). If the network is unreachable (offline), fall back to
 * the last cached response. API and SSE requests are never intercepted.
 *
 * On activation it claims all clients and notifies them, so a freshly
 * deployed version takes effect on the next visibility change / update
 * check rather than at an arbitrary later time.
 */

const CACHE = 'autere-runtime';

self.addEventListener('install', () => {
  // Take over as soon as possible
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop old caches from previous versions
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Let open pages know a (possibly new) worker is in control
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({ type: 'sw-activated' });
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never touch API, SSE or auth endpoints
  if (url.pathname.includes('/api/') || url.pathname.endsWith('/events')) return;

  // App shell: navigations, html, js/css, hashed assets, manifest, icons
  const isAppShell =
    req.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.webmanifest') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.ico');

  if (!isAppShell) return;

  event.respondWith((async () => {
    try {
      // Network first — a deployed update must win over any cached copy
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch (_err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
