const CACHE_NAME = 'ihm-cache-v2';
const APP_SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/data/periods.json',
  'js/data/regions.geojson',
  'js/data/religions.json',
  'js/data/sites.geojson',
  'js/data/geology_basic.geojson',
  'js/data/geology_advanced.geojson',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/fonts/rubik/rubik.css',
  'vendor/fonts/rubik/rubik-400-hebrew.woff2',
  'vendor/fonts/rubik/rubik-400-latin.woff2',
  'vendor/fonts/rubik/rubik-500-hebrew.woff2',
  'vendor/fonts/rubik/rubik-500-latin.woff2',
  'vendor/fonts/rubik/rubik-700-hebrew.woff2',
  'vendor/fonts/rubik/rubik-700-latin.woff2',
  'vendor/fonts/rubik/rubik-800-hebrew.woff2',
  'vendor/fonts/rubik/rubik-800-latin.woff2',
  'icons/svg/logo.svg',
  'icons/svg/era-prehistoric.svg',
  'icons/svg/era-bronze.svg',
  'icons/svg/era-biblical.svg',
  'icons/svg/era-classical.svg',
  'icons/svg/era-medieval.svg',
  'icons/svg/era-modern.svg',
  'icons/svg/layer-regions.svg',
  'icons/svg/layer-timeline.svg',
  'icons/svg/layer-religion.svg',
  'icons/svg/layer-geology.svg',
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
