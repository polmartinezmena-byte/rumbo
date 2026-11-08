// Service worker: la app y el mapa funcionan sin conexión.
const VERSION = 'v19';
const SHELL = `rumbo-shell-${VERSION}`;
const TILES = 'rumbo-tiles-v1';     // compartida con js/offline-tiles.js
const RUNTIME = 'rumbo-runtime-v1'; // estilo del mapa y TileJSON

const SHELL_FILES = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './icon.svg',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './js/app.js', './js/geo.js', './js/db.js', './js/nav.js', './js/offline-tiles.js', './js/graph-worker.js',
  './js/graph-build.js', './js/router.js', './js/flood.js', './js/pack.js', './js/weather.js', './js/radars.js', './js/settings.js', './js/flood-zones.js', './js/live.js', './js/live-route.js', './js/online.js', './js/awake.js', './js/vendor/nosleep-media.js', './js/config.js', './js/native.js', './js/map-offline.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

const TILE_RE = /^https:\/\/tiles\.openfreemap\.org\/planet\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.pbf/;
const tileKey = (url) => {
  const m = url.match(TILE_RE);
  return m ? `https://tiles.openfreemap.org/planet/_/${m[1]}/${m[2]}/${m[3]}.pbf` : url;
};

self.addEventListener('install', (e) => {
  // cache: 'reload' evita copiar ficheros viejos de la caché HTTP del navegador (GitHub Pages cachea 10 min).
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  const keep = [SHELL, TILES, RUNTIME];
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(req, cacheName, key) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(key, res.clone());
  return res;
}

async function networkFirst(req, cacheName, timeoutMs = 4000) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req)
    .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'tiles.openfreemap.org') {
    const isAsset = /\.(pbf|png|webp)$/.test(url.pathname) || url.pathname.includes('/sprites/');
    e.respondWith(isAsset ? cacheFirst(req, TILES, tileKey(req.url)) : networkFirst(req, RUNTIME));
    return;
  }
  // Los paquetes de rutas los guarda el worker en IndexedDB; el catálogo, siempre de la red.
  if (url.origin === location.origin && url.pathname.includes('/packs/')) {
    if (url.pathname.endsWith('index.json')) e.respondWith(networkFirst(req, RUNTIME));
    return;
  }
  if (url.origin === location.origin || url.hostname === 'unpkg.com') {
    if (req.mode === 'navigate') {
      e.respondWith(networkFirst(req, SHELL, 2500).catch(() => caches.match('./index.html')));
      return;
    }
    e.respondWith(staleWhileRevalidate(req, SHELL));
  }
});
