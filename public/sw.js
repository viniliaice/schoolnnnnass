/* MBK School service worker.
 *
 * Responsibilities: offline app-shell, PWA install support, Web Push
 * notification display, notification click deep-linking, versioned cache
 * management and safe updates.
 *
 * SECURITY MODEL (read before changing fetch handling):
 *  - Only same-origin GET requests are ever intercepted.
 *  - `/api/*` is NEVER cached (server endpoints may return per-user data).
 *  - Cross-origin requests (Supabase REST/Auth/Realtime, Google Fonts) are
 *    never intercepted: they use the browser default fetch, so no student or
 *    teacher data is ever written to a cache that another user could read.
 *  - Navigations use network-first: the cached shell is ONLY a fallback for
 *    when the network is unreachable, and the shell contains no user data.
 *  - Hashed /assets/* files are content-addressed (the filename changes when
 *    the content changes), so they are served cache-first: a cached copy can
 *    never be stale for its URL.
 *
 * The `__SW_BUILD_ID__` token is replaced with a content hash of the built
 * app (index.html + the emitted asset manifest) by the Vite build plugin in
 * vite.config.ts, so every real deploy changes this file's bytes and
 * browsers detect the new worker. `__SW_PRECACHE_ASSETS__` is replaced with
 * the entry /assets/*.js and /assets/*.css URLs referenced by index.html.
 */

const RAW_BUILD_ID = '__SW_BUILD_ID__';
const BUILD_ID = RAW_BUILD_ID.startsWith('__') ? 'dev' : RAW_BUILD_ID;

// Entry JS/CSS emitted by the build (empty in dev, where modules are served
// individually and offline support is not meaningful).
const RAW_PRECACHE_ASSETS = '__SW_PRECACHE_ASSETS__';
const PRECACHE_ASSETS = RAW_PRECACHE_ASSETS.startsWith('__')
  ? []
  : RAW_PRECACHE_ASSETS.split(',').filter(Boolean);

const STATIC_CACHE = 'mbk-static-' + BUILD_ID;
const RUNTIME_CACHE = 'mbk-runtime-' + BUILD_ID;

// The offline app shell = the document plus the entry JS/CSS it references
// plus the manifest/icons. ('/' and '/index.html' are the same document —
// cache it once under '/'.) Lazy/optional chunks are NOT precached; they are
// runtime-cached on first use so a deploy never re-downloads the whole app.
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  ...PRECACHE_ASSETS,
];

const CHANNEL_NAME = 'mbk-pwa';

/** Broadcast to any open app page (used to refresh notification lists). */
function broadcast(message) {
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(message);
    channel.close();
  } catch (e) {
    /* BroadcastChannel unsupported — page will refresh on focus anyway. */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Tolerate individual precache failures (e.g. flaky first install).
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] precache failed for', url, err);
          })
        )
      );
      // Stay idle until the current worker is gone, EXCEPT when the page
      // explicitly asks us to take over (Update Now button).
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Remove obsolete caches from older versions.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .filter((key) => key.startsWith('mbk-'))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

// Update control: the page posts SKIP_WAITING when the user taps "Update Now".
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Only ever intercept same-origin GET requests (see security model above).
  if (url.origin !== self.location.origin) return;
  // Never cache server endpoints.
  if (url.pathname.startsWith('/api/')) return;

  // Hashed build assets: cache-first. The filename embeds a content hash, so
  // a cached entry is immutable for its URL; anything not already cached
  // (e.g. a future lazily-loaded chunk) is fetched once and kept in the
  // versioned runtime cache. This also keeps the offline shell working for
  // assets fetched after install.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request.url);
        if (cached) return cached;
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(request.url, response.clone());
        }
        return response;
      })()
    );
    return;
  }

  // App navigations: network-first with offline shell fallback.
  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response && response.ok) {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put('/', response.clone());
          }
          return response;
        } catch (err) {
          const cached =
            (await caches.match(request.url)) ||
            (await caches.match('/')) ||
            (await caches.match('/index.html'));
          if (cached) return cached;
          throw err;
        }
      })()
    );
    return;
  }

  // Static shell assets (icons/manifest/logo): cache-first, refresh in
  // background so an update lands on the next cold start.
  const isStaticAsset =
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/logo.png' ||
    url.pathname.startsWith('/icons/');
  if (isStaticAsset) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request.url);
        const refresh = fetch(request)
          .then((response) => {
            if (response && (response.ok || response.type === 'opaque')) {
              caches.open(STATIC_CACHE).then((cache) => cache.put(request.url, response.clone()));
            }
            return response;
          })
          .catch(() => cached);
        if (cached) return cached;
        return refresh;
      })()
    );
    return;
  }

  // Everything else same-origin (shouldn't exist beyond the above): default.
});

/* ── Web Push ─────────────────────────────────────────────────────────────── */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'MBK School', body: event.data ? event.data.text() : 'New notification' };
  }

  const title = payload.title || 'MBK School';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'mbk-notification',
    renotify: false,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: {
      url: typeof payload.url === 'string' ? payload.url : '/',
      category: payload.category || 'general',
    },
    requireInteraction: false,
  };

  // Let open pages refresh their notification lists immediately.
  broadcast({ type: 'PUSH_RECEIVED', category: options.data.category });

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const targetPath = (notification.data && notification.data.url) || '/';
  notification.close();

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Prefer focusing an existing app window and navigating it in place.
      const sameOriginClients = clientList.filter((client) => {
        try {
          return new URL(client.url).origin === self.location.origin;
        } catch (e) {
          return false;
        }
      });
      if (sameOriginClients.length > 0) {
        const client = sameOriginClients[0];
        await client.focus();
        client.postMessage({ type: 'NAVIGATE', path: targetPath });
        return;
      }
      const windowClient = await self.clients.openWindow(targetPath);
      if (!windowClient) return;
      // If the window needed booting, it will read the URL itself on startup.
    })()
  );
});

self.addEventListener('notificationclose', () => {
  /* No bookkeeping needed server-side for closes. */
});
