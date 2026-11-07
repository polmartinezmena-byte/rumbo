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
import { live, loadCached, refresh as refreshLive, summary as liveSummary } from './live.js';
import { penalties, incidentsOnRoute, zbeOnRoute, fuelOnRoute, liveLayer, warningsOnRoute, warningsAt, zbeGuard } from './live-route.js';
import { activeWarnings } from './live.js';
import { PACKS } from './config.js';

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
      case 'route': result = await routeAny(e.data.from, e.data.to, e.data.level || 0, e.data.avoidTolls, e.data.opts || {}); break;
      case 'liveRefresh': result = await refreshLive(e.data.force, (m) => progress(id, m, 0.5)); break;
      case 'liveSummary': result = liveSummary(); break;
      case 'liveLayer': result = liveLayer(live, e.data.bbox, e.data.fuel, e.data.sticker); break;
      case 'fuelNear': result = fuelNear(e.data.near, e.data.fuel); break;
      case 'warningsAt': result = warningsAt(e.data.near[0], e.data.near[1], activeWarnings()); break;
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
  await loadCached().catch(() => {});
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

// IndexedDB no admite un valor de más de ~128 MB en Chrome, y una comunidad grande ocupa más:
// cada tabla (array tipado) se guarda como una entrada aparte y la cabecera lista cuáles son.
const PART_MAX = 32 * 1024 * 1024;

async function save(key, G) {
  loaded.delete(key);
  await removeParts(key);
  const head = { __parts: [] };
  for (const [k, v] of Object.entries(G)) {
    if (!ArrayBuffer.isView(v)) { head[k] = v; continue; }
    const per = Math.max(1, Math.floor(PART_MAX / v.BYTES_PER_ELEMENT));
    const n = Math.ceil(v.length / per) || 1;
    head.__parts.push({ k, n, type: v.constructor.name, length: v.length });
    for (let i = 0; i < n; i++) await db.set(`graph:${key}:${k}:${i}`, v.slice(i * per, (i + 1) * per));
  }
  await db.set('graph:' + key, head);
  catalog[key] = R.stats(G);
  await db.set('catalog', catalog);
  remember(key, G);
  return catalog;
}

async function removeParts(key) {
  const head = await db.get('graph:' + key);
  for (const p of head?.__parts || []) for (let i = 0; i < p.n; i++) await db.del(`graph:${key}:${p.k}:${i}`);
}

const ARRAYS = { Float64Array, Float32Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int16Array };

async function load(key) {
  const head = await db.get('graph:' + key);
  if (!head || !head.__parts) return head; // formato antiguo: todo en una entrada
  const G = { ...head };
  delete G.__parts;
  for (const p of head.__parts) {
    const out = new ARRAYS[p.type](p.length);
    let off = 0;
    for (let i = 0; i < p.n; i++) {
      const part = await db.get(`graph:${key}:${p.k}:${i}`);
      if (!part) throw new Error('El mapa guardado está incompleto: vuelve a descargarlo');
      out.set(part, off);
      off += part.length;
    }
    G[p.k] = out;
  }
  return G;
}

async function remove(key) {
  loaded.delete(key);
  await removeParts(key);
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
  const G = await load(key);
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
        // Si un servidor se satura y no responde, se prueba el siguiente en vez de esperar para siempre.
        signal: AbortSignal.timeout(150000),
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
async function routeAny(from, to, level, avoidTolls = false, opts = {}) {
  const now = opts.now || Date.now();
  const foot = !!opts.foot;
  const keys = candidates([from, to]);
  if (!keys.length) throw new Error('Origen o destino fuera de tus mapas descargados. Descarga la zona o la comunidad.');
  let lastErr;
  for (const key of keys) {
    try {
      const G = await graph(key);
      const pen = foot ? null : penalties(G, live, { sticker: opts.sticker || '', avoidZbe: opts.avoidZbe !== false, now });
      // ---- ZBE donde tu etiqueta no puede entrar: la ruta nunca te mete dentro.
      const zbeFix = foot ? null : zbeGuard(G, live, from, to, opts, now);
      if (zbeFix?.to) to = zbeFix.to;
      let safe = R.route(G, from, to, level, { avoidTolls, pen, foot });
      if (zbeFix) {
        // Si aun así la ruta entra (no hay forma de rodearla), se corta en el límite de la zona.
        const cut = zbeFix.firstBannedIndex(safe.path);
        if (cut > 0) {
          const stop = safe.path[cut - 1];
          const name = zbeFix.zoneName(safe.path[cut]);
          safe = R.route(G, from, [G.la[stop], G.lo[stop]], level, { avoidTolls, pen, foot });
          zbeFix.stop = { name, reason: 'sin-alternativa' };
        }
        safe.zbeLimit = zbeFix.stop || zbeFix.retarget || null;
        if (safe.zbeLimit) safe.steps[safe.steps.length - 1].text = 'Has llegado al límite de la zona de bajas emisiones. No entres: con tu etiqueta no puedes circular';
      }
      safe.graph = key;
      safe.incidents = incidentsOnRoute(safe, live);
      safe.zbe = zbeOnRoute(G, safe, safe.path, live, { sticker: opts.sticker || '', now });
      safe.fuel = foot ? null : fuelOnRoute(safe, live, opts.fuel);
      safe.avisos = warningsOnRoute(safe, activeWarnings(now));
      delete safe.path;
      safe.flood = !!G.risk;
      if (level > 0 && G.risk) {
        // Compara con la ruta más rápida para explicar qué se evita y cuánto cuesta.
        const fast = R.route(G, from, to, 0, { avoidTolls, pen });
        delete fast.path;
        safe.compare = {
          fastDuration: fast.duration,
          fastZones: fast.riskRuns.length,
          fastRiskLen: fast.riskLen,
          fastHard: fast.riskRuns.filter((r) => r.hard).length,
        };
      }
      // Alternativa con / sin peaje para poder elegir.
      if (G.toll) {
        const alt = foot ? null : avoidTolls ? R.route(G, from, to, level, { pen }) : safe.tollLen > 0 ? R.route(G, from, to, level, { avoidTolls: true, pen }) : null;
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
    const r = await fetch(PACKS + 'radares-oficiales.json');
    if (!r.ok) return [];
    return (await r.json())
      .filter(([la, lo]) => la >= b.s && la <= b.n && lo >= b.w && lo <= b.e)
      .map(([lat, lon, speed, kind, sec]) => ({ lat, lon, speed, kind, sec: sec >= 0 ? sec : undefined }));
  } catch {
    return [];
  }
}

// Gasolineras más baratas cerca de un punto (radio 5 km), para el botón SOS.
function fuelNear(near, fuel) {
  const F = live.fuel;
  if (!F || !F.prices[fuel]) return null;
  const p = F.prices[fuel];
  let best = null;
  for (let i = 0; i < F.la.length; i++) {
    if (!(p[i] > 0)) continue;
    const d = Math.hypot((F.la[i] - near[0]) * 111320, (F.lo[i] - near[1]) * 111320 * Math.cos((near[0] * Math.PI) / 180));
    if (d > 5000) continue;
    if (!best || d < best.dist) best = { dist: d, price: p[i], name: F.name[i], lat: F.la[i], lon: F.lo[i], addr: F.addr[i] };
  }
  return best;
}
