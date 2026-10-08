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
 * It also owns the OS-level notifications: `push` renders the backend's
 * payload, `notificationclick` opens/focuses the app at the payload path.
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

// ── OS-level notifications (Web Push) ──
// Payload from the backend: { title, body, path, tag } — `path` is relative
// to this worker's scope (the reverse-proxy base), so no base path travels
// with the notification.

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : null;
  } catch (_err) {
    data = { body: event.data ? event.data.text() : '' };
  }
  if (!data) return;
  event.waitUntil(self.registration.showNotification(data.title || 'autere', {
    body: data.body || '',
    tag: data.tag || undefined,
    data: { path: data.path || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || null;
  event.waitUntil((async () => {
    const target = new URL(path || './', self.registration.scope).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameUrl = windows.find((c) => c.url.replace(/\/$/, '') === target.replace(/\/$/, ''));
    if (sameUrl) { await sameUrl.focus(); return; }
    if (windows.length > 0) {
      await windows[0].focus();
      // Client.navigate() is unsupported in Safari/iOS — fall back to a new window.
      if (typeof windows[0].navigate === 'function') {
        try { await windows[0].navigate(target); return; } catch (_err) { /* open below */ }
      }
    }
    await self.clients.openWindow(target);
  })());
});
