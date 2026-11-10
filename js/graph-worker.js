// Worker de rutas. Guarda varios grafos en IndexedDB:
//   · "area"         la zona que el usuario descarga a mano (Overpass + relieve)
//   · "region:<id>"  el paquete de una comunidad autónoma (generado con tools/build-region.mjs)
//   · "region:es"    el mapa general de España (solo carreteras principales) para rutas largas
// y elige el más detallado que contenga origen y destino. Todo funciona sin conexión.
import * as db from './db.js';
import { haversine, bearing } from './geo.js';
import { overpassQuery, fromOverpass, build } from './graph-build.js';
import { fetchDem } from './flood.js';
import { floodGrid } from './flood-zones.js';
import { deserialize } from './pack.js';
import * as R from './router.js';
import { camerasLayer, camerasOnRoute, packOfficial } from './radars.js';
import { live, loadCached, refresh as refreshLive, summary as liveSummary } from './live.js';
import {
  penalties, incidentsOnRoute, zbeOnRoute, fuelOnRoute, liveLayer, warningsOnRoute, warningsAt, zbeGuard,
  zoneAt, zonesAlong, zbeOnCoords, bannedZones, closuresOnRoute,
} from './live-route.js';
import { trafficProfile, trafficFactor } from './traffic.js';
import { applyLiveTraffic } from './live-traffic.js';
import { isOnline, onlineRoute, annotate, searchOnline, nearbyOnline } from './online.js';
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
// Operaciones que usan mucha memoria: la app lo apunta en el diagnóstico y, si iOS cierra la app en
// medio, en la siguiente apertura no las repite sola (evita quedarse en negro en bucle).
const heavy = (on, what) => post({ heavy: on, what });
const MB = (G) => Math.round(Object.values(G).reduce((s, v) => s + (ArrayBuffer.isView(v) ? v.byteLength : 0), 0) / 1048576);

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    let result;
    switch (type) {
      case 'init': result = await init(); break;
      case 'download': result = await downloadArea(e.data.bbox, id); break;
      case 'installPack': result = await installPack(e.data, id); break;
      case 'remove': result = await remove(e.data.key); break;
      case 'route': {
        const o = e.data.opts || {};
        result = await routeAny(e.data.from, e.data.to, e.data.level || 0, e.data.avoidTolls, o);
        // Tráfico en directo encima del típico de la hora (si está activado y no vas a pie).
        if (o.traffic && !o.foot) { applyLiveTraffic(result, live); for (const a of result.alts || []) applyLiveTraffic(a, live); }
        break;
      }
      case 'liveRefresh': result = await refreshLive(e.data.force, (m) => progress(id, m, 0.5)); break;
      case 'liveSummary': result = liveSummary(); break;
      case 'liveLayer': result = liveLayer(live, e.data.bbox, e.data.fuel, e.data.sticker); break;
      case 'fuelNear': result = fuelNear(e.data.near, e.data.fuel); break;
      case 'warningsAt': result = warningsAt(e.data.near[0], e.data.near[1], activeWarnings()); break;
      case 'cameras': result = await camerasIn(e.data.bbox); break;
      case 'ahead': result = await ahead(e.data.lat, e.data.lon, e.data.heading); break;
      case 'search': result = await searchAll(e.data.q, e.data.near); break;
      case 'nearby': result = await nearbyAll(e.data.near, e.data.cat); break;
      case 'riskLayer': result = await riskLayer(e.data.bbox); break;
      case 'loadedKeys': result = { full: [...loaded.keys()], partial: [...partial.keys()] }; break; // diagnóstico
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
  partial.delete(key);
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
  // En iPhone no se queda en memoria tras instalarlo: se cargará cuando haga falta una ruta.
  if (!IOS) remember(key, G);
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

// Solo algunas tablas de un mapa guardado (p. ej. los radares) sin cargar el mapa entero.
const partial = new Map(); // key → { campo: array }
async function loadFields(key, fields) {
  const have = partial.get(key) || {};
  const head = await db.get('graph:' + key);
  if (!head?.__parts) return null;
  for (const p of head.__parts) {
    if (!fields.includes(p.k) || have[p.k]) continue;
    const out = new ARRAYS[p.type](p.length);
    let off = 0;
    for (let i = 0; i < p.n; i++) {
      const part = await db.get(`graph:${key}:${p.k}:${i}`);
      if (!part) return null;
      out.set(part, off);
      off += part.length;
    }
    have[p.k] = out;
  }
  partial.set(key, have);
  return have;
}

async function remove(key) {
  loaded.delete(key);
  partial.delete(key);
  await removeParts(key);
  await db.del('graph:' + key);
  delete catalog[key];
  await db.set('catalog', catalog);
  return catalog;
}

// En iPhone, Safari cierra la página si usa demasiada memoria (se queda la pantalla en negro):
// allí solo se mantiene un mapa grande en memoria a la vez.
const IOS = /iP(hone|ad|od)|Macintosh.*Mobile/.test(self.navigator?.userAgent || '');
const MAX_LOADED = IOS ? 1 : 2;
function remember(key, G) {
  loaded.delete(key);
  loaded.set(key, G);
  while (loaded.size > MAX_LOADED) loaded.delete(loaded.keys().next().value);
}

async function graph(key) {
  if (loaded.has(key)) {
    const G = loaded.get(key);
    remember(key, G);
    return G;
  }
  // En iPhone, antes de cargar uno grande se suelta todo lo demás.
  if (IOS) { loaded.clear(); partial.clear(); }
  heavy(true, 'cargando el mapa ' + key);
  let G;
  try { G = await load(key); } finally { heavy(false); }
  if (!G) throw new Error('Falta el mapa descargado: vuelve a descargarlo');
  partial.delete(key); // ya está entero en memoria
  post({ heavy: false, what: `mapa ${key} en memoria (${MB(G)} MB)` });
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
  // Se descomprime a la vez que se descarga: así nunca están en memoria el paquete comprimido, su
  // copia y el descomprimido a la vez (en iPhone eso bastaba para que Safari cerrara la app).
  if (IOS) { loaded.clear(); partial.clear(); }
  heavy(true, 'instalando el mapa ' + key);
  try {
    let got = 0;
    const parts = [];
    for (const url of urls) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`No se pudo descargar el paquete (${r.status})`);
      const count = new TransformStream({
        transform(chunk, ctl) {
          got += chunk.length;
          progress(id, `Rutas: ${(got / 1048576).toFixed(0)} de ${(size / 1048576).toFixed(0)} MB`, size ? Math.min(0.85, (got / size) * 0.85) : 0.4);
          ctl.enqueue(chunk);
        },
      });
      parts.push(await new Response(r.body.pipeThrough(count).pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    let buf = parts[0];
    if (parts.length > 1) { // varios ficheros: se unen (raro)
      const all = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
      let o = 0; for (const p of parts) { all.set(new Uint8Array(p), o); o += p.byteLength; }
      buf = all.buffer;
    }
    parts.length = 0;
    const G = deserialize(buf);
    buf = null;
    progress(id, 'Guardando en el dispositivo…', 0.92);
    return await save(key, G);
  } finally { heavy(false); }
}

// ------------------------------------------------------------------ consultas
async function routeAny(from, to, level, avoidTolls = false, opts = {}) {
  const now = opts.now || Date.now();
  const foot = !!opts.foot;
  let keys = candidates([from, to]);
  // El mapa general de España solo tiene carreteras principales: con conexión es mejor la ruta online.
  if (isOnline() && keys.every((k) => k === 'region:es')) keys = [];
  if (!keys.length) {
    if (isOnline()) return routeOnline(from, to, level, avoidTolls, opts);
    throw new Error('Sin conexión, y el origen o el destino quedan fuera de tus mapas descargados. Descarga la zona o la comunidad.');
  }
  let lastErr;
  for (const key of keys) {
    try {
      const G = await graph(key);
      const pen = foot ? null : penalties(G, live, { sticker: opts.sticker || '', avoidZbe: opts.avoidZbe !== false, now, traffic: !!opts.traffic });
      // ---- ZBE donde tu etiqueta no puede entrar: la ruta nunca te mete dentro.
      const zbeFix = foot ? null : zbeGuard(G, live, from, to, opts, now);
      if (zbeFix?.to) to = zbeFix.to;
      const traffic = opts.traffic ? now : null;
      let safe = R.route(G, from, to, level, { avoidTolls, pen, foot, traffic });
      if (zbeFix) {
        // Si aun así la ruta entra (no hay forma de rodearla), se corta en el límite de la zona.
        const cut = zbeFix.firstBannedIndex(safe.path);
        if (cut > 0) {
          const stop = safe.path[cut - 1];
          const name = zbeFix.zoneName(safe.path[cut]);
          safe = R.route(G, from, [G.la[stop], G.lo[stop]], level, { avoidTolls, pen, foot, traffic });
          zbeFix.stop = { name, reason: 'sin-alternativa' };
        }
        safe.zbeLimit = zbeFix.stop || zbeFix.retarget || null;
        if (safe.zbeLimit) safe.steps[safe.steps.length - 1].text = 'Has llegado al límite de la zona de bajas emisiones. No entres: con tu etiqueta no puedes circular';
      }
      const decorate = (r) => {
        r.graph = key;
        r.incidents = incidentsOnRoute(r, live);
        r.zbe = zbeOnRoute(G, r, r.path, live, { sticker: opts.sticker || '', now });
        r.fuel = foot ? null : fuelOnRoute(r, live, opts.fuel);
        r.avisos = warningsOnRoute(r, activeWarnings(now));
        r.flood = !!G.risk;
        return r;
      };
      decorate(safe);
      // Alternativa: la mejor ruta que comparte poco con la principal (sus tramos cuestan un 60 % más).
      if (!foot && !safe.zbeLimit && safe.distance < 400000) {
        try {
          const onMain = new Set();
          for (let k = 0; k + 1 < safe.path.length; k++) {
            const u = safe.path[k], v = safe.path[k + 1];
            for (let e = G.off[u]; e < G.off[u + 1]; e++) if (G.tgt[e] === v) onMain.add(e);
          }
          const altPen = pen ? Float32Array.from(pen) : new Float32Array(G.tgt.length).fill(1);
          for (const e of onMain) altPen[e] *= 1.6;
          const alt = R.route(G, from, to, level, { avoidTolls, pen: altPen, foot, traffic });
          let shared = 0;
          for (let k = 0; k + 1 < alt.path.length; k++) {
            const u = alt.path[k], v = alt.path[k + 1];
            for (let e = G.off[u]; e < G.off[u + 1]; e++) if (G.tgt[e] === v && onMain.has(e)) { shared += G.dist[e]; break; }
          }
          if (alt.duration < safe.duration * 1.4 && shared < alt.distance * 0.7) {
            decorate(alt);
            delete alt.path;
            safe.alts = [alt];
          }
        } catch { /* sin alternativa */ }
      }
      delete safe.path;
      safe.flood = !!G.risk;
      if (level > 0 && G.risk) {
        // Compara con la ruta más rápida para explicar qué se evita y cuánto cuesta.
        const fast = R.route(G, from, to, 0, { avoidTolls, pen, traffic });
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
        const alt = foot ? null : avoidTolls ? R.route(G, from, to, level, { pen, traffic }) : safe.tollLen > 0 ? R.route(G, from, to, level, { avoidTolls: true, pen, traffic }) : null;
        if (alt && Math.abs(alt.tollLen - safe.tollLen) > 50) safe.tollAlt = { duration: alt.duration, distance: alt.distance, tollLen: alt.tollLen };
      }
      return safe;
    } catch (err) {
      lastErr = err;
    }
  }
  if (isOnline()) return routeOnline(from, to, level, avoidTolls, opts);
  throw lastErr;
}

// ------------------------------------------------------------------ rutas con conexión
// Fuera de tus mapas: ruta de Valhalla (OpenStreetMap) + lo que Rumbo sabe sin grafo: radares oficiales,
// límites de velocidad, incidencias, ZBE, gasolineras y avisos. Lo que no puede saber (zonas inundables)
// se dice en la ficha de la ruta.
async function routeOnline(from, to, level, avoidTolls, opts) {
  const now = opts.now || Date.now();
  const foot = !!opts.foot;
  const o = { sticker: opts.sticker || '', avoidZbe: opts.avoidZbe !== false, now };
  const banned = foot ? null : bannedZones(live, o);
  const startZone = banned ? zoneAt(live, from[0], from[1]) : -1;
  const isBan = (z) => z >= 0 && banned[z] && z !== startZone;
  const radarsP = officialPack().catch(() => null);
  let zbeLimit = null;

  // Destino dentro de una ZBE prohibida: se llega hasta el último punto antes de entrar en ella.
  const destZone = banned ? zoneAt(live, to[0], to[1]) : -1;
  if (isBan(destZone)) {
    const r0 = await onlineRoute(from, to, { foot, avoidTolls });
    const zon = zonesAlong(r0, live);
    let k = zon.length - 1;
    while (k > 0 && zon[k] === destZone) k--;
    if (k > 0) {
      const [lo, la] = r0.coords[k];
      zbeLimit = { name: live.zbe.zones[destZone].name, reason: 'destino-dentro', metres: Math.round(haversine(la, lo, to[0], to[1])), url: live.zbe.zones[destZone].url };
      to = [la, lo];
    }
  }

  // Se pide la ruta y, si entra en una ZBE prohibida o pasa por un corte de la DGT, se vuelve a pedir
  // marcando esos puntos como prohibidos (Valhalla no admite polígonos tan grandes como una ZBE).
  const avoid = [];
  let r = await onlineRoute(from, to, { foot, avoidTolls });
  let entries = [];
  for (let round = 0; round < 5 && !foot; round++) {
    const zon = banned ? zonesAlong(r, live) : null;
    entries = [];
    if (zon) {
      for (let i = 1; i < zon.length; i++) {
        if (isBan(zon[i]) && !isBan(zon[i - 1]) && r.distance - r.cum[i] > 60) entries.push(i);
      }
    }
    const closures = closuresOnRoute(r, live).filter(([la, lo]) => !avoid.some((p) => haversine(la, lo, p[0], p[1]) < 30));
    if (!entries.length && !closures.length) break;
    const added = [...entries.map((i) => [r.coords[i][1], r.coords[i][0]]), ...closures];
    avoid.push(...added);
    try {
      r = await onlineRoute(from, to, { foot, avoidTolls, avoid });
    } catch {
      avoid.splice(avoid.length - added.length); // sin alternativa: se queda la ruta anterior
      break;
    }
  }
  if (entries.length && banned) {
    // No hay forma de rodear la zona: te lleva hasta su límite y no más.
    const i = entries[0];
    const z = zoneAt(live, r.coords[i][1], r.coords[i][0]);
    const stop = r.coords[i - 1];
    r = await onlineRoute(from, [stop[1], stop[0]], { foot, avoidTolls, avoid }).catch(() => r);
    zbeLimit = { name: live.zbe.zones[z].name, reason: 'sin-alternativa' };
  }

  // Límites de velocidad y peajes (y la alternativa con / sin peaje) en paralelo.
  const altP = foot ? null : onlineRoute(from, to, { foot, avoidTolls: !avoidTolls, avoid }).then(annotate).catch(() => null);
  const altsP = foot || zbeLimit ? null : onlineRoute(from, to, { foot, avoidTolls, avoid, alternates: 1 })
    .then((x) => Promise.all((x.altTrips || []).filter((a) => a.duration < x.duration * 1.4).slice(0, 1).map(annotate))).catch(() => []);
  await annotate(r);
  const alt = await altP;
  if (alt && Math.abs(alt.tollLen - r.tollLen) > 50) r.tollAlt = { duration: alt.duration, distance: alt.distance, tollLen: alt.tollLen };

  const cams = await radarsP;
  Object.assign(r, cams ? camerasOnRoute(cams, r) : {});
  if (zbeLimit) {
    r.zbeLimit = zbeLimit;
    r.steps[r.steps.length - 1].text = 'Has llegado al límite de la zona de bajas emisiones. No entres: con tu etiqueta no puedes circular';
  }
  if (opts.traffic && !foot) {
    const prof = trafficProfile(new Date(now));
    const k = trafficFactor(prof, r.distance / (r.duration || 1));
    const free = r.duration;
    r.duration *= k;
    if (r.tollAlt) r.tollAlt.duration *= k;
    r.traffic = { label: prof.label, delay: r.duration - free };
  }
  r.level = level;
  r.graph = 'online';
  r.incidents = incidentsOnRoute(r, live);
  r.zbe = zbeOnCoords(r, zonesAlong(r, live), live, o);
  r.fuel = foot ? null : fuelOnRoute(r, live, opts.fuel);
  r.avisos = warningsOnRoute(r, activeWarnings(now));
  delete r.shape;
  // Alternativas con los mismos avisos (radares, incidencias, ZBE, gasolineras).
  const alts = (await altsP) || [];
  for (const a of alts) {
    Object.assign(a, cams ? camerasOnRoute(cams, a) : {});
    if (r.traffic) {
      const prof = trafficProfile(new Date(now));
      const k = trafficFactor(prof, a.distance / (a.duration || 1));
      const free = a.duration; a.duration *= k; a.traffic = { label: prof.label, delay: a.duration - free };
    }
    Object.assign(a, { level, graph: 'online', incidents: incidentsOnRoute(a, live), zbe: zbeOnCoords(a, zonesAlong(a, live), live, o), fuel: fuelOnRoute(a, live, opts.fuel), avisos: warningsOnRoute(a, activeWarnings(now)) });
    delete a.shape;
  }
  if (alts.length) r.alts = alts;
  return r;
}


// Radares oficiales de toda España (se guardan para usarlos también sin conexión).
let offPack = null;
async function officialPack() {
  if (offPack) return offPack;
  let list = null;
  try {
    const r = await fetch(PACKS + 'radares-oficiales.json', { signal: AbortSignal.timeout(15000) });
    if (r.ok) { list = await r.json(); db.set('radares-oficiales', list).catch(() => {}); }
  } catch { /* sin conexión */ }
  list ??= await db.get('radares-oficiales');
  if (!list) return null;
  offPack = packOfficial(list.map(([lat, lon, speed, kind, sec]) => ({ lat, lon, speed, kind, sec: sec >= 0 ? sec : undefined })));
  return offPack;
}

async function searchAll(q, near) {
  const keys = near ? candidates([near]) : Object.keys(catalog);
  const all = Object.keys(catalog);
  const order = [...keys, ...all.filter((k) => !keys.includes(k))].slice(0, 3);
  // Con conexión también se buscan direcciones y lugares de toda España (con número de portal).
  const onlineP = isOnline() && q.length >= 3 ? searchOnline(q, near).catch(() => []) : Promise.resolve([]);
  const seen = new Set();
  const local = [];
  const key = (r) => r.name.toLowerCase() + Math.round(r.lat * 200) + Math.round(r.lon * 200);
  for (const k of order) {
    for (const r of R.search(await graph(k), q, near)) {
      if (!seen.has(key(r))) { seen.add(key(r)); local.push(r); }
    }
    if (local.length >= 12) break;
  }
  const online = (await onlineP).filter((r) => !seen.has(key(r)));
  // Primero lo descargado que está cerca; lo lejano, detrás de los resultados en línea.
  const close = near ? local.filter((r) => haversine(near[0], near[1], r.lat, r.lon) < 30000) : local;
  const far = local.filter((r) => !close.includes(r));
  return [...close.slice(0, 6), ...online, ...close.slice(6), ...far].slice(0, 12);
}

async function nearbyAll(near, cat) {
  const keys = candidates([near]).filter((k) => k !== 'region:es');
  const list = keys.length ? R.nearby(await graph(keys[0]), near, cat) : [];
  if (list.length) return list;
  // Fuera de tus mapas: gasolineras del Ministerio (guardadas, funcionan sin red) y el resto en línea.
  const fuel = !cat || cat === 'fuel' ? fuelStations(near) : [];
  const online = isOnline() && !(cat === 'fuel' && fuel.length) ? await nearbyOnline(near, cat === 'fuel' ? 'fuel' : cat).catch(() => []) : [];
  return [...online.filter((x) => !(fuel.length && x.kind === 'fuel')), ...fuel].sort((a, b) => a.dist - b.dist).slice(0, 30);
}

function fuelStations(near, max = 15) {
  const F = live.fuel;
  if (!F) return [];
  const out = [];
  for (let i = 0; i < F.la.length; i++) {
    const d = haversine(near[0], near[1], F.la[i], F.lo[i]);
    if (d < 30000) out.push({ kind: 'fuel', label: 'Gasolinera', name: F.name[i], phone: '', lat: F.la[i], lon: F.lo[i], dist: d, bearing: bearing(near[0], near[1], F.la[i], F.lo[i]) });
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, max);
}

async function riskLayer(bbox) {
  const c = [(bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2];
  const k = candidates([c]).filter((x) => x !== 'region:es')[0];
  if (!k) return { type: 'FeatureCollection', features: [] };
  // Solo las tablas que hacen falta (unos 40-60 MB), no el mapa entero (150-200 MB en una comunidad grande).
  const G = loaded.get(k) || (await loadFields(k, ['la', 'lo', 'off', 'tgt', 'risk', 'hard'])) || (await graph(k));
  return R.riskLayer(G, bbox);
}

async function camerasIn(bbox) {
  const c = [(bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2];
  const keys = candidates([c]);
  const fc = { type: 'FeatureCollection', features: [] };
  // Para dibujar los radares basta con sus tablas (unos KB), no con el mapa entero (cientos de MB).
  const CAM = ['cLa', 'cLo', 'cSpeed', 'cKind', 'cSec', 'cDir'];
  for (const k of keys.slice(0, 2)) {
    const G = loaded.get(k) || (await loadFields(k, CAM)) || (await graph(k));
    fc.features.push(...camerasLayer(G, bbox).features);
  }
  // Fuera de tus mapas: al menos los radares oficiales (DGT, Cataluña, Madrid).
  if (!keys.length) {
    const P = await officialPack().catch(() => null);
    if (P) fc.features.push(...camerasLayer(P, bbox).features);
  }
  return fc;
}

// ------------------------------------------------------------------ conducción sin ruta
// Radares a menos de 1,5 km (con el final de cada tramo) y, si el mapa ya está en memoria, el límite
// de la vía por la que vas. La app decide cuáles quedan por delante según tu rumbo.
const CAM_FIELDS = ['cLa', 'cLo', 'cSpeed', 'cKind', 'cSec', 'cDir'];
const secEnds = new WeakMap(); // tablas de radares → { sec: índice del final del tramo }
async function ahead(lat, lon, heading) {
  const keys = candidates([[lat, lon]]);
  const tables = [];
  for (const k of keys.slice(0, 2)) {
    const T = loaded.get(k) || (await loadFields(k, CAM_FIELDS));
    if (T?.cLa) tables.push(T);
  }
  if (!tables.length) { const P = await officialPack().catch(() => null); if (P) tables.push(P); }
  const R2 = 1500, dLat = R2 / 111320, dLon = R2 / (111320 * Math.cos((lat * Math.PI) / 180));
  const out = [], seen = new Set();
  for (const T of tables) {
    let ends = secEnds.get(T);
    if (!ends) {
      ends = {};
      for (let i = 0; i < T.cLa.length; i++) if (T.cKind[i] === 2) ends[T.cSec[i]] = i;
      secEnds.set(T, ends);
    }
    for (let i = 0; i < T.cLa.length; i++) {
      const la = T.cLa[i], lo = T.cLo[i];
      if (Math.abs(la - lat) > dLat || Math.abs(lo - lon) > dLon) continue;
      const key = la.toFixed(5) + ',' + lo.toFixed(5);
      if (seen.has(key)) continue;
      seen.add(key);
      const c = { lat: la, lon: lo, kind: T.cKind[i], speed: T.cSpeed[i] || 0, dir: T.cDir?.[i] ?? -1, id: key };
      if (c.kind === 1 && ends[T.cSec[i]] !== undefined) { const j = ends[T.cSec[i]]; c.end = [T.cLa[j], T.cLo[j]]; }
      out.push(c);
    }
  }
  return { cams: out, limit: limitHere(keys, lat, lon, heading) };
}

// Límite de la vía en un punto (solo si el mapa completo ya está cargado: no se carga para esto).
function limitHere(keys, lat, lon, heading) {
  const k = keys.find((x) => loaded.has(x));
  const G = k && loaded.get(k);
  if (!G?.lim || heading == null) return null;
  const n = R.nearest(G, lat, lon);
  if (n.i < 0 || n.d > 40) return null;
  let best = null, bd = 60;
  const consider = (u, v, e) => {
    const b = bearing(G.la[u], G.lo[u], G.la[v], G.lo[v]);
    const diff = Math.abs(((b - heading + 540) % 360) - 180);
    if (diff < bd && G.lim[e]) { bd = diff; best = { limit: G.lim[e], inferred: !!G.limInf?.[e] }; }
  };
  for (let e = G.off[n.i]; e < G.off[n.i + 1]; e++) consider(n.i, G.tgt[e], e);
  return best;
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
