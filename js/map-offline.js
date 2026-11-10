// Mapa sin conexión SIN depender del service worker (que en la app nativa no existe):
//   · el estilo y su TileJSON se guardan en Cache Storage (red primero, caché si falla)
//   · teselas, sprites y fuentes se piden con el protocolo propio «rumbo://», que mira primero
//     en la caché de teselas descargadas y, si no están, las pide a la red y las guarda.
import { STYLE_URL, TILE_CACHE, tileKey } from './offline-tiles.js';

const RUNTIME = 'rumbo-runtime-v1';
const P = 'rumbo://';

// Para arrancar al instante: si ya hay una copia guardada se usa esa y se actualiza en segundo plano
// (la próxima vez se usará la nueva). Solo la primera vez se espera a la red.
async function cacheFirstJson(url) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(url);
  if (!hit) return networkFirstJson(url);
  networkFirstJson(url, 15000).catch(() => {}); // refresco en segundo plano
  return hit.json();
}

async function networkFirstJson(url, timeout = 5000) {
  const cache = await caches.open(RUNTIME);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    cache.put(url, new Response(JSON.stringify(j), { headers: { 'Content-Type': 'application/json' } }));
    return j;
  } catch (err) {
    const hit = await cache.match(url);
    if (hit) return hit.json();
    throw err;
  }
}

/** Estilo del mapa listo para funcionar sin conexión. */
export async function offlineStyle(url = STYLE_URL) {
  const style = await cacheFirstJson(url);
  for (const src of Object.values(style.sources)) {
    if (src.type !== 'vector' && src.type !== 'raster') continue;
    if (src.url && !src.tiles) {
      try {
        const tj = await cacheFirstJson(src.url);
        Object.assign(src, { tiles: tj.tiles, minzoom: tj.minzoom ?? src.minzoom, maxzoom: tj.maxzoom ?? src.maxzoom, bounds: tj.bounds, attribution: tj.attribution ?? src.attribution });
        delete src.url;
      } catch { continue; }
    }
    if (src.tiles) src.tiles = src.tiles.map((t) => P + t);
  }
  if (typeof style.sprite === 'string') style.sprite = P + style.sprite;
  else if (Array.isArray(style.sprite)) style.sprite = style.sprite.map((s) => ({ ...s, url: P + s.url }));
  if (style.glyphs) style.glyphs = P + style.glyphs;
  return style;
}

/** Registra el protocolo «rumbo://» en MapLibre (llamar antes de crear el mapa). */
export function registerOfflineProtocol(maplibregl) {
  maplibregl.addProtocol('rumbo', async (params, abort) => {
    const url = params.url.slice(P.length);
    const key = tileKey(url);
    let res = null;
    try {
      const cache = await caches.open(TILE_CACHE);
      res = await cache.match(key);
      if (!res) {
        const net = await fetch(url, { signal: abort.signal });
        if (net.ok) { cache.put(key, net.clone()); res = net; }
        else if (net.status === 404 || net.status === 204) return { data: params.type === 'json' ? {} : new ArrayBuffer(0) };
        else throw new Error('HTTP ' + net.status);
      }
    } catch (e) {
      // Sin conexión y sin la tesela guardada: tesela vacía (el mapa sigue funcionando).
      if (abort.signal.aborted) throw e;
      return { data: params.type === 'json' ? {} : new ArrayBuffer(0) };
    }
    if (params.type === 'json') return { data: await res.json() };
    if (params.type === 'string') return { data: await res.text() };
    return { data: await res.arrayBuffer() };
  });
}
