const CACHE_NAME = 'ihm-cache-v11';
const MAP_CACHE_NAME = 'ihm-map-v1';
// Every self-hosted tile archive. These are the only files served by Range
// request, so they take the byte-slicing path below rather than plain caching.
const PMTILES_FILES = ['data/israel.pmtiles'];
const isPmtilesUrl = url => PMTILES_FILES.some(f => url.endsWith('/' + f));

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
  'js/data/nature.geojson',
  'js/data/visitor_sites.geojson',
  'data/terrain-manifest.json',
  'vendor/maplibre/maplibre-contour.mjs',
  'vendor/maplibre/maplibre-gl.mjs',
  'vendor/maplibre/maplibre-gl-shared.mjs',
  'vendor/maplibre/maplibre-gl-worker.mjs',
  'vendor/maplibre/maplibre-gl.css',
  'vendor/maplibre/pmtiles.js',
  'vendor/maplibre/style.json',
  'vendor/maplibre/mapbox-gl-rtl-text.js',
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
  'icons/svg/layer-topo.svg',
  'icons/svg/layer-nature.svg',
  'icons/svg/layer-visitor.svg',
  'assets/rocks/arava-eilat-mountains.jpg',
  'assets/rocks/central-mountain-backbone.jpg',
  'assets/rocks/coastal-plain-kurkar.jpg',
  'assets/rocks/golan-heights-basalt.jpg',
  'assets/rocks/jezreel-beit-shean-valleys.jpg',
  'assets/rocks/jordan-rift-dead-sea.jpg',
  'assets/rocks/judean-desert-basic.jpg',
  'assets/rocks/korazim-eastern-galilee-basalt.jpg',
  'assets/rocks/northern-central-negev.jpg',
  'assets/rocks/nw-negev-loess-dunes.jpg',
  'assets/rocks/shephelah.jpg',
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
async function cacheOneArchive(file, client, onProgress) {
  const url = new URL(file, self.registration.scope).href;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${file}: ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(received, total);
  }
  const blob = new Blob(chunks);
  const cache = await caches.open(MAP_CACHE_NAME);
  await cache.put(url, new Response(blob, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(blob.size),
      'Accept-Ranges': 'bytes'
    }
  }));
}

// Progress is reported across both archives together, so the bar reflects the
// whole download rather than restarting when the terrain file begins.
async function cacheWholeMapFile(client) {
  try {
    const sizes = await Promise.all(PMTILES_FILES.map(async f => {
      const r = await fetch(new URL(f, self.registration.scope).href, { method: 'HEAD' });
      return Number(r.headers.get('content-length')) || 0;
    }));
    // The elevation tiles are many small files rather than one archive, so they
    // are counted as a flat share of the progress bar instead of by bytes.
    const terrain = await fetch(new URL('data/terrain-manifest.json', self.registration.scope).href)
      .then(r => r.ok ? r.json() : []).catch(() => []);
    const grandTotal = sizes.reduce((a, b) => a + b, 0);
    const archiveShare = terrain.length ? 0.85 : 1;
    let done = 0;
    for (let i = 0; i < PMTILES_FILES.length; i++) {
      await cacheOneArchive(PMTILES_FILES[i], client, received => {
        if (client && grandTotal) {
          client.postMessage({
            type: 'cache-map-progress',
            percent: Math.min(100, Math.round(((done + received) / grandTotal) * 100 * archiveShare))
          });
        }
      });
      done += sizes[i];
    }
    if (terrain.length) {
      const cache = await caches.open(CACHE_NAME);
      for (let i = 0; i < terrain.length; i++) {
        const url = new URL(terrain[i], self.registration.scope).href;
        try { await cache.add(url); } catch (e) { /* one missing tile must not fail the whole download */ }
        if (client && i % 20 === 0) {
          client.postMessage({
            type: 'cache-map-progress',
            percent: Math.min(100, Math.round((archiveShare + (1 - archiveShare) * (i / terrain.length)) * 100))
          });
        }
      }
    }
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

  if (isPmtilesUrl(url)) {
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
