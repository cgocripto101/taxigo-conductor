// ═══════════════════════════════════════════════════════
//  TaxiGo Ibiza — Service Worker  v2.0
//  Estrategia: Cache-first para assets estáticos,
//  Network-first para mapas y geocodificación.
// ═══════════════════════════════════════════════════════

const CACHE_NAME    = 'taxigo-ibiza-v2';
const ASSETS_CACHE  = 'taxigo-assets-v2';
const MAPS_CACHE    = 'taxigo-maps-v2';

// Archivos que se cachean en la instalación
const PRECACHE = [
  '/',
  '/index.html',
  '/conductor.html',
  '/admin.html',
  '/manifest.json',
  '/manifest-conductor.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// ── Install: pre-cachear archivos ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(ASSETS_CACHE)
      .then(cache => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: limpiar cachés antiguas ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== ASSETS_CACHE && k !== MAPS_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: estrategia por tipo de recurso ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Tile de mapa → cache con tiempo de vida de 7 días
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(cacheWithExpiry(event.request, MAPS_CACHE, 7));
    return;
  }

  // Geocodificación Nominatim → siempre red (datos frescos)
  if (url.hostname.includes('nominatim.openstreetmap.org')) {
    event.respondWith(fetch(event.request).catch(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Stripe.js → siempre red (seguridad)
  if (url.hostname.includes('js.stripe.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Assets propios → Cache-first, fallback red
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(ASSETS_CACHE).then(c => c.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback → devolver index.html para navegación
        if (event.request.mode === 'navigate') return caches.match('/index.html');
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// ── Cache con expiración (tiles de mapa) ──
async function cacheWithExpiry(request, cacheName, days) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    const cachedDate = cached.headers.get('sw-cached-date');
    if (cachedDate) {
      const age = (Date.now() - new Date(cachedDate)) / (1000 * 60 * 60 * 24);
      if (age < days) return cached;
    } else return cached;
  }
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const headers = new Headers(response.headers);
      headers.append('sw-cached-date', new Date().toISOString());
      const body = await response.blob();
      const modified = new Response(body, { status: response.status, statusText: response.statusText, headers });
      cache.put(request, modified.clone());
      return modified;
    }
    return response;
  } catch(e) {
    return cached || new Response('', { status: 503 });
  }
}

// ── Push notifications (preparado para backend) ──
self.addEventListener('push', event => {
  let data = { title: '🚖 TaxiGo Ibiza', body: 'Tienes un nuevo mensaje', icon: '/icons/icon-192.png' };
  try { data = { ...data, ...event.data.json() }; } catch(e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      vibrate: [300, 150, 300],
      data: data.url ? { url: data.url } : {},
      actions: data.actions || []
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.notification.data?.url) {
    event.waitUntil(clients.openWindow(event.notification.data.url));
  }
});
