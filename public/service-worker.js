// Wing-O Service Worker — PWA offline support + Push Notifications
const CACHE_NAME = 'wingo-v2';

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
const CORE_CACHE = [
  '/',
  '/index.html',
  '/images/logo.jpg',
  '/images/neon-logo.jpg',
  '/images/wings-hero.jpg',
  '/images/wings-half.jpg',
  '/images/ribs.jpg',
  '/images/boneless-wings.jpg',
  '/images/boneless-sauce.jpg',
  '/images/burger-tough-guy.jpg',
  '/images/burger-dillinator.jpg',
  '/images/burger.jpg',
  '/images/combo1.jpg',
  '/images/poutine.jpg',
  '/images/salad.jpg',
  '/images/platter-bit-of.jpg',
  '/images/platter-making-love.jpg',
  '/images/oreo.jpg',
  '/images/lunch-deal.jpg',
  '/images/curly-fries.jpg',
  '/images/pickle-spears.jpg',
  '/images/empanadas.jpg',
  '/images/jalapeno-poppers.jpg',
  '/images/mini-perogies.jpg',
  '/images/mozza-sticks.jpg',
  '/images/dumplings.jpg',
  '/images/cookie-dough.jpg',
  '/images/mars-1pc.jpg',
  '/images/proudly-prairie.png'
];

// Install — cache core files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[Wing-O SW] Caching core files');
      return cache.addAll(CORE_CACHE.map(url => new Request(url, { cache: 'reload' })))
        .catch(err => console.log('[Wing-O SW] Some files failed to cache:', err));
    }).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — serve from cache, fall back to network
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go network-first for API calls
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'You are offline. Please check your connection.' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // For everything else: cache first, fall back to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses
        if (event.request.method === 'GET' && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => {
        // Offline fallback for HTML pages
        if (event.request.headers.get('accept').includes('text/html')) {
          return caches.match('/index.html');
        }
      });
    })
  );
});
