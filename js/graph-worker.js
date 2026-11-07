// Worker de rutas. Guarda varios grafos en IndexedDB:
//   · "area"         la zona que el usuario descarga a mano (Overpass + relieve)
//   · "region:<id>"  el paquete de una comunidad autónoma (generado con tools/build-region.mjs)
//   · "region:es"    el mapa general de España (solo carreteras principales) para rutas largas
// y elige el más detallado que contenga origen y destino. Todo funciona sin conexión.
import * as db from './db.js';
import { overpassQuery, fromOverpass, build } from './graph-build.js';
import { fetchDem } from './flood.js';
import { floodGrid } from './flood-zones.js';
import { deserialize } from './pack.js';
import * as R from './router.js';
import { camerasLayer } from './radars.js';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

let catalog = {};          // key → stats (lo que hay guardado)
const loaded = new Map();  // key → grafo en memoria (máx. 2: los grafos grandes ocupan mucho)

const post = (m) => self.postMessage(m);
const progress = (id, msg, pct) => post({ id, progress: { msg, pct } });

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    let result;
    switch (type) {
      case 'init': result = await init(); break;
      case 'download': result = await downloadArea(e.data.bbox, id); break;
      case 'installPack': result = await installPack(e.data, id); break;
      case 'remove': result = await remove(e.data.key); break;
      case 'route': result = await routeAny(e.data.from, e.data.to, e.data.level || 0, e.data.avoidTolls); break;
      case 'cameras': result = await camerasIn(e.data.bbox); break;
      case 'search': result = await searchAll(e.data.q, e.data.near); break;
      case 'nearby': result = await nearbyAll(e.data.near, e.data.cat); break;
      case 'riskLayer': result = await riskLayer(e.data.bbox); break;
      default: throw new Error('Petición desconocida: ' + type);
    }
    post({ id, ok: true, result });
  } catch (err) {
    post({ id, ok: false, error: err.message || String(err) });
  }
};

// ------------------------------------------------------------------ almacén
async function init() {
  catalog = (await db.get('catalog')) || {};
  // Migración desde la v1 (un único grafo en la clave "graph").
  const old = await db.get('graph');
  if (old) {
    await db.set('graph:area', old);
    await db.del('graph');
    catalog.area = R.stats(old);
    await db.set('catalog', catalog);
  }
  return catalog;
}

async function save(key, G) {
  loaded.delete(key);
  await db.set('graph:' + key, G);
  catalog[key] = R.stats(G);
  await db.set('catalog', catalog);
  remember(key, G);
  return catalog;
}

async function remove(key) {
  loaded.delete(key);
  await db.del('graph:' + key);
  delete catalog[key];
  await db.set('catalog', catalog);
  return catalog;
}

function remember(key, G) {
  loaded.delete(key);
  loaded.set(key, G);
  while (loaded.size > 2) loaded.delete(loaded.keys().next().value);
}

async function graph(key) {
  if (loaded.has(key)) {
    const G = loaded.get(key);
    remember(key, G);
    return G;
  }
  const G = await db.get('graph:' + key);
  if (!G) throw new Error('Falta el mapa descargado: vuelve a descargarlo');
  remember(key, G);
  return G;
}

const inBox = (b, lat, lon, pad = 0.01) => lat >= b.s - pad && lat <= b.n + pad && lon >= b.w - pad && lon <= b.e + pad;

// Grafos candidatos para un conjunto de puntos, del más detallado (más pequeño) al general.
function candidates(points) {
  return Object.entries(catalog)
    .filter(([, st]) => points.every(([lat, lon]) => inBox(st.bbox, lat, lon)))
    .sort(([ka, a], [kb, b]) => (ka === 'region:es') - (kb === 'region:es') || area(a.bbox) - area(b.bbox))
    .map(([k]) => k);
}
const area = (b) => (b.n - b.s) * (b.e - b.w);

// ------------------------------------------------------------------ descarga de una zona
async function downloadArea(b, id) {
  progress(id, 'Descargando calles, ríos y servicios de OpenStreetMap…', 0.02);
  const q = overpassQuery(b);
  const demP = fetchDem(b, (p) => progress(id, 'Descargando el relieve del terreno…', 0.02 + p * 0.1)).catch(() => null);
  // Zonas inundables oficiales (SNCZI). Si el servicio falla, se sigue con la estimación propia.
  const zonesP = floodGrid(b, (m) => progress(id, 'Zonas inundables oficiales: ' + m.trim(), 0.3)).catch(() => null);
  let json, lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!r.ok) throw new Error(`Overpass respondió ${r.status}`);
      progress(id, 'Leyendo datos…', 0.5);
      json = await r.json();
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!json) throw new Error(`No se pudieron descargar las calles (${lastErr?.message})`);
  const dem = await demP;
  const input = fromOverpass(json.elements);
  input.official = await officialRadars(b);
  input.floodGrid = await zonesP;
  const G = build(input, b, dem, (msg) => progress(id, msg, 0.7));
  if (!G.la.length) throw new Error('No hay calles en esta zona');
  progress(id, 'Guardando en el dispositivo…', 0.92);
  return save('area', G);
}

// ------------------------------------------------------------------ paquetes por comunidad
async function installPack({ key, urls, size }, id) {
  const chunks = [];
  let got = 0;
  for (const url of urls) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`No se pudo descargar el paquete (${r.status})`);
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      progress(id, `Rutas: ${(got / 1048576).toFixed(0)} de ${(size / 1048576).toFixed(0)} MB`, size ? Math.min(0.8, (got / size) * 0.8) : 0.4);
    }
  }
  progress(id, 'Descomprimiendo…', 0.85);
  const gz = new Blob(chunks).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(gz).arrayBuffer();
  const G = deserialize(buf);
  progress(id, 'Guardando en el dispositivo…', 0.92);
  return save(key, G);
}

// ------------------------------------------------------------------ consultas
async function routeAny(from, to, level, avoidTolls = false) {
  const keys = candidates([from, to]);
  if (!keys.length) throw new Error('Origen o destino fuera de tus mapas descargados. Descarga la zona o la comunidad.');
  let lastErr;
  for (const key of keys) {
    try {
      const G = await graph(key);
      const safe = R.route(G, from, to, level, { avoidTolls });
      safe.graph = key;
      safe.flood = !!G.risk;
      if (level > 0 && G.risk) {
        // Compara con la ruta más rápida para explicar qué se evita y cuánto cuesta.
        const fast = R.route(G, from, to, 0, { avoidTolls });
        safe.compare = {
          fastDuration: fast.duration,
          fastZones: fast.riskRuns.length,
          fastRiskLen: fast.riskLen,
          fastHard: fast.riskRuns.filter((r) => r.hard).length,
        };
      }
      // Alternativa con / sin peaje para poder elegir.
      if (G.toll) {
        const alt = avoidTolls ? R.route(G, from, to, level) : safe.tollLen > 0 ? R.route(G, from, to, level, { avoidTolls: true }) : null;
        if (alt && Math.abs(alt.tollLen - safe.tollLen) > 50) safe.tollAlt = { duration: alt.duration, distance: alt.distance, tollLen: alt.tollLen };
      }
      return safe;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function searchAll(q, near) {
  const keys = near ? candidates([near]) : Object.keys(catalog);
  const all = Object.keys(catalog);
  const order = [...keys, ...all.filter((k) => !keys.includes(k))].slice(0, 3);
  const seen = new Set();
  const out = [];
  for (const key of order) {
    for (const r of R.search(await graph(key), q, near)) {
      const k = r.name + Math.round(r.lat * 1000) + Math.round(r.lon * 1000);
      if (!seen.has(k)) { seen.add(k); out.push(r); }
    }
    if (out.length >= 12) break;
  }
  return out.slice(0, 12);
}

async function nearbyAll(near, cat) {
  const keys = candidates([near]).filter((k) => k !== 'region:es');
  if (!keys.length) return [];
  return R.nearby(await graph(keys[0]), near, cat);
}

async function riskLayer(bbox) {
  const c = [(bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2];
  const k = candidates([c]).filter((x) => x !== 'region:es')[0];
  if (!k) return { type: 'FeatureCollection', features: [] };
  return R.riskLayer(await graph(k), bbox);
}

async function camerasIn(bbox) {
  const c = [(bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2];
  const keys = candidates([c]);
  const fc = { type: 'FeatureCollection', features: [] };
  for (const k of keys.slice(0, 2)) fc.features.push(...camerasLayer(await graph(k), bbox).features);
  return fc;
}

// Radares oficiales (DGT, Cataluña, Madrid) publicados junto a la app al generar los paquetes.
async function officialRadars(b) {
  try {
    const r = await fetch(new URL('../packs/radares-oficiales.json', self.location.href));
    if (!r.ok) return [];
    return (await r.json())
      .filter(([la, lo]) => la >= b.s && la <= b.n && lo >= b.w && lo <= b.e)
      .map(([lat, lon, speed, kind, sec]) => ({ lat, lon, speed, kind, sec: sec >= 0 ? sec : undefined }));
  } catch {
    return [];
  }
}
