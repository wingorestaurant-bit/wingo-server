// Wing-O Service Worker — PWA offline support + Push Notifications
// ─────────────────────────────────────────────────────────────────
// VERSION-BASED CACHING:
// Bump CACHE_VERSION every time you push a meaningful site change.
// This invalidates old caches and forces customers to fetch fresh files.
// HTML files always check network first (so updates appear instantly).
// Static assets (images/fonts) use cache-first (fast, rarely change).
// ─────────────────────────────────────────────────────────────────
const CACHE_VERSION = 'v23';
const CACHE_NAME = `wingo-${CACHE_VERSION}`;

// ── PUSH NOTIFICATION HANDLER ──────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch(e) { data = { title: 'Wing-O 🍗', body: event.data?.text() || 'You have a new message!' }; }
  const options = {
    body: data.body || '',
    icon: data.icon || '/images/logo.jpg',
    badge: '/images/logo.jpg',
    image: data.image || null,
    data: { url: data.url || '/' },
    vibrate: [200, 100, 200],
    requireInteraction: false,
    actions: [
      { action: 'order', title: '🍗 Order Now' },
      { action: 'close', title: '✕ Dismiss' }
    ]
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Wing-O 🍗', options)
  );
});

// Handle notification click
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  if (event.action === 'close') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If app is already open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// Core files to cache for offline use
// Core files to cache for offline use. Kept tiny on purpose: menu photos are cached
// the first time a customer actually sees them (cache-first below), so a first visit
// doesn't download every photo in the background on a phone's data plan.
const CORE_CACHE = [
  '/',
  '/order',
  '/index.html',
  '/images/logo.jpg',
  '/images/wingo-logo-wide.png'
];

// Install — cache core files, take over immediately
self.addEventListener('install', event => {
  console.log(`[Wing-O SW] Installing ${CACHE_VERSION}`);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[Wing-O SW] Caching core files');
      return cache.addAll(CORE_CACHE.map(url => new Request(url, { cache: 'reload' })))
        .catch(err => console.log('[Wing-O SW] Some files failed to cache:', err));
    }).then(() => self.skipWaiting()) // Take over from old SW immediately
  );
});

// Activate — clean old caches, claim all clients
self.addEventListener('activate', event => {
  console.log(`[Wing-O SW] Activating ${CACHE_VERSION}`);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log(`[Wing-O SW] Deleting old cache: ${k}`);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim()) // Take control of all open tabs immediately
  );
});

// Listen for skip-waiting messages (so frontend can trigger immediate update)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Helper: is this an HTML navigation request?
function isHtmlRequest(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

// Fetch handler
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Skip cross-origin requests entirely (Clover, OneSignal, Google Fonts, etc.)
  if (url.origin !== self.location.origin) {
    return;
  }

  // 2. API calls — always pass through to network, never cache
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // 3. POST/PUT/DELETE — never cache
  if (event.request.method !== 'GET') {
    return;
  }

  // 4. HTML pages → NETWORK-FIRST (always try fresh, fall back to cache if offline)
  //    This is what makes site updates appear instantly for returning customers.
  if (isHtmlRequest(event.request)) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Got a fresh response — cache it for offline fallback
          if (response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => {
          // Network failed (offline) — serve from cache
          return caches.match(event.request).then(cached => {
            return cached || caches.match('/index.html');
          });
        })
    );
    return;
  }

  // 5. Everything else (images, CSS, JS, fonts) → CACHE-FIRST (fast, rarely change)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
