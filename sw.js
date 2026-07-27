const CACHE_NAME = 'ihm-cache-v1';
const APP_SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/data/periods.json',
  'js/data/regions.geojson',
  'js/data/religions.json',
  'js/data/sites.geojson',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  return /tile\.openstreetmap\.org/.test(url);
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = request.url;

  if (isTileRequest(url)) {
    // Map tiles: cache-first, so previously viewed/saved areas work offline.
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        }).catch(() => cached);
      })
    );
    return;
  }

  if (url.startsWith(self.location.origin)) {
    // App shell / data files: network-first so edits show up, fall back to cache offline.
    event.respondWith(
      fetch(request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return response;
      }).catch(() => caches.match(request))
    );
  }
});
