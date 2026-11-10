// Descarga previa de las teselas vectoriales (OpenFreeMap) de una zona a la Cache Storage,
// para que el mapa se dibuje sin conexión. El service worker las sirve desde la misma caché.
export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
// Mapa de noche: mismas teselas y mismos iconos que el de día (también sirve sin conexión).
export const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
export const TILE_CACHE = 'rumbo-tiles-v1';
export const MAX_ZOOM = 14; // las teselas de OpenFreeMap llegan a z14; MapLibre sobre-amplía el resto.

// Las URLs de teselas llevan la versión del planeta (cambia con cada build). La quitamos de la
// clave de caché para que una zona descargada siga sirviendo aunque el estilo apunte a otra versión.
// (Misma función en sw.js.)
const TILE_RE = /^https:\/\/tiles\.openfreemap\.org\/planet\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.pbf/;
export function tileKey(url) {
  const m = url.match(TILE_RE);
  return m ? `https://tiles.openfreemap.org/planet/_/${m[1]}/${m[2]}/${m[3]}.pbf` : url;
}

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

export function tileList(b, maxZ = MAX_ZOOM) {
  const out = [];
  for (let z = 0; z <= maxZ; z++) {
    const x0 = lon2x(b.w, z), x1 = lon2x(b.e, z);
    const y0 = lat2y(b.n, z), y1 = lat2y(b.s, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  }
  return out;
}

function collectFonts(expr, set) {
  if (!Array.isArray(expr)) return;
  if (expr.every((s) => typeof s === 'string')) {
    if (expr[0] !== 'literal') set.add(expr.join(','));
    return;
  }
  for (const part of expr) collectFonts(part, set);
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

export async function prefetchArea(b, onProgress, maxZ = MAX_ZOOM) {
  const style = await getJson(STYLE_URL);
  const urls = [];

  for (const src of Object.values(style.sources)) {
    if (src.type !== 'vector') continue;
    const tiles = src.tiles || (await getJson(src.url)).tiles;
    for (const [z, x, y] of tileList(b, Math.min(maxZ, src.maxzoom ?? MAX_ZOOM))) {
      urls.push(tiles[0].replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
  }

  const sprites = typeof style.sprite === 'string' ? [style.sprite] : (style.sprite || []).map((s) => s.url);
  for (const s of sprites) urls.push(`${s}.json`, `${s}.png`, `${s}@2x.json`, `${s}@2x.png`);

  if (style.glyphs) {
    const stacks = new Set();
    for (const layer of style.layers) collectFonts(layer.layout?.['text-font'], stacks);
    for (const st of stacks) {
      for (const r of ['0-255', '256-511', '512-767', '8192-8447']) {
        urls.push(style.glyphs.replace('{fontstack}', st).replace('{range}', r));
      }
    }
  }

  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const url = urls[i++];
      const key = tileKey(new URL(url).href);
      try {
        if (!(await cache.match(key))) {
          const res = await fetch(url);
          if (res.ok) await cache.put(key, res);
          else if (res.status !== 404) failed++;
        }
      } catch {
        failed++;
      }
      onProgress?.(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { total: urls.length, failed };
}

const inside = (b, z, x, y) => {
  const n = 2 ** z;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;
};

// Borra las teselas de una zona que no usen otras zonas descargadas.
export async function removeTiles(b, maxZ = MAX_ZOOM, keep = []) {
  const cache = await caches.open(TILE_CACHE);
  for (const [z, x, y] of tileList(b, maxZ)) {
    if (keep.some((k) => z <= k.maxZ && inside(k.bbox, z, x, y))) continue;
    await cache.delete(`https://tiles.openfreemap.org/planet/_/${z}/${x}/${y}.pbf`);
  }
}

// Tamaño medio aproximado de una tesela vectorial (mezcla de ciudad y campo).
export const AVG_TILE_KB = 14;
