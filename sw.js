const CACHE_NAME = 'ihm-cache-v3';
const MAP_CACHE_NAME = 'ihm-map-v1';
const PMTILES_URL_SUFFIX = '/data/israel.pmtiles';

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
  'vendor/maplibre/maplibre-gl.mjs',
  'vendor/maplibre/maplibre-gl-shared.mjs',
  'vendor/maplibre/maplibre-gl-worker.mjs',
  'vendor/maplibre/maplibre-gl.css',
  'vendor/maplibre/pmtiles.js',
  'vendor/maplibre/style.json',
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
      keys.filter(k => k !== CACHE_NAME && k !== MAP_CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

/* ---- Explicit whole-map download, triggered by the "download for offline" button ---- */
async function cacheWholeMapFile(client) {
  const pmtilesUrl = new URL('data/israel.pmtiles', self.registration.scope).href;
  try {
    const response = await fetch(pmtilesUrl);
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total && client) {
        client.postMessage({ type: 'cache-map-progress', percent: Math.round((received / total) * 100) });
      }
    }
    const blob = new Blob(chunks);
    const fullResponse = new Response(blob, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(blob.size),
        'Accept-Ranges': 'bytes'
      }
    });
    const cache = await caches.open(MAP_CACHE_NAME);
    await cache.put(pmtilesUrl, fullResponse);
    if (client) client.postMessage({ type: 'cache-map-done', ok: true });
  } catch (err) {
    if (client) client.postMessage({ type: 'cache-map-done', ok: false, error: err.message });
  }
}

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'cache-map') {
    cacheWholeMapFile(event.source);
  }
});

/* ---- Serve Range requests for the pmtiles file from a fully-cached blob ---- */
async function servePmtilesRange(request) {
  const cache = await caches.open(MAP_CACHE_NAME);
  const cached = await cache.match(request.url, { ignoreSearch: true });
  if (!cached) return null;

  const rangeHeader = request.headers.get('range');
  const buffer = await cached.arrayBuffer();
  if (!rangeHeader) {
    return new Response(buffer, { headers: cached.headers });
  }
  const match = /bytes=(\d+)-(\d+)?/.exec(rangeHeader);
  if (!match) return new Response(buffer, { headers: cached.headers });

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : buffer.byteLength - 1;
  const slice = buffer.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${buffer.byteLength}`,
      'Content-Length': String(slice.byteLength),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = request.url;

  if (url.endsWith(PMTILES_URL_SUFFIX)) {
    event.respondWith(
      servePmtilesRange(request).then(cachedResponse => cachedResponse || fetch(request))
    );
    return;
  }

  if (url.includes('/vendor/maplibre/fonts/') || url.includes('/vendor/fonts/')) {
    // Static font assets: cache-first, they never change.
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return response;
      }))
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
