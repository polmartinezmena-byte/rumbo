// Construye el grafo de calles a partir de elementos OSM (formato JSON de Overpass).
// Código puro (sin DOM): lo usan el worker del navegador y el script de Node que genera
// los paquetes por comunidad autónoma (tools/build-region.mjs).
import { haversine, norm } from './geo.js';
import { nodeRisk, edgeRisk } from './flood.js';
import { buildCameras, isCameraNode } from './radars.js';

export const GRAPH_VERSION = 4;

// Límite de velocidad (km/h) de una vía. Devuelve [límite, estimado]. Si OSM no lo trae se aplican
// las reglas generales del Reglamento General de Circulación solo donde no hay ambigüedad:
// autopista/autovía 120, calle de un carril por sentido 30 y calle de plataforma única 20.
// En el resto (una carretera puede atravesar un pueblo) se deja sin límite antes que inventarlo.
const ES_LIMITS = { 'ES:urban': 50, 'ES:rural': 90, 'ES:motorway': 120, 'ES:trunk': 120, 'ES:zone30': 30, 'ES:zone20': 20, 'ES:living_street': 20, walk: 10 };
export function speedLimit(t, forward = true) {
  const raw = (forward ? t['maxspeed:forward'] : t['maxspeed:backward']) || t.maxspeed;
  if (raw) {
    const n = parseInt(raw, 10);
    if (n > 0 && n <= 130) return [/mph/.test(raw) ? Math.round(n * 1.609) : n, 0];
    if (ES_LIMITS[raw]) return [ES_LIMITS[raw], 0];
  }
  if (t.highway === 'motorway') return [120, 1];
  if (t.highway === 'residential') return [30, 1];
  if (t.highway === 'living_street') return [20, 1];
  return [0, 0];
}

export const HIGHWAYS =
  'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|' +
  'tertiary|tertiary_link|unclassified|residential|living_street|service';
export const MAIN_HIGHWAYS = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link';
export const WATERWAYS = 'river|stream|canal|drain|ditch|wadi|brook|torrent';

// Velocidad media real (km/h) por tipo de vía cuando no hay límite etiquetado.
const SPEED = {
  motorway: 110, motorway_link: 60, trunk: 90, trunk_link: 50,
  primary: 50, primary_link: 40, secondary: 45, secondary_link: 35,
  tertiary: 40, tertiary_link: 30, unclassified: 30, residential: 25,
  living_street: 10, service: 15,
};
// Fuera de ciudad las vías principales son más rápidas: si el límite está etiquetado lo usamos.

export const EMERGENCY = {
  hospital: 'Hospital', clinic: 'Centro de salud', pharmacy: 'Farmacia', police: 'Policía',
  fire_station: 'Bomberos', drinking_water: 'Agua potable', shelter: 'Refugio',
  defibrillator: 'Desfibrilador', fuel: 'Gasolinera',
};

const KIND = {
  ...EMERGENCY,
  restaurant: 'Restaurante', cafe: 'Cafetería', bar: 'Bar', fast_food: 'Comida rápida',
  parking: 'Parking', bank: 'Banco', atm: 'Cajero', school: 'Escuela',
  university: 'Universidad', supermarket: 'Supermercado', bakery: 'Panadería', hotel: 'Hotel',
  museum: 'Museo', attraction: 'Atracción', city: 'Ciudad', town: 'Pueblo', village: 'Pueblo',
  suburb: 'Barrio', neighbourhood: 'Barrio', hamlet: 'Aldea', library: 'Biblioteca',
  post_office: 'Correos', townhall: 'Ayuntamiento', marketplace: 'Mercado',
};

export function overpassQuery(b) {
  const bb = `${b.s},${b.w},${b.n},${b.e}`;
  return `[out:json][timeout:180][maxsize:536870912];
way["highway"~"^(${HIGHWAYS})$"]["area"!="yes"]["access"!~"^(private|no)$"]["service"!~"^(parking_aisle|driveway|drive-through|emergency_access)$"](${bb})->.r;
.r out body qt;
.r >;
out skel qt;
(node["name"]["amenity"](${bb});node["name"]["shop"](${bb});node["name"]["tourism"](${bb});node["name"]["place"](${bb}););
out body qt;
(nwr["amenity"~"^(hospital|clinic|pharmacy|police|fire_station|drinking_water|shelter|fuel)$"](${bb});node["emergency"="defibrillator"](${bb}););
out tags center qt;
way["waterway"~"^(${WATERWAYS})$"](${bb});
out tags geom qt;
node["ford"~"^(yes|stepping_stones)$"](${bb});
out body qt;
(node["highway"="speed_camera"](${bb});node["enforcement"="traffic_signals"](${bb});node["red_light_camera"="yes"](${bb}););
out body qt;
relation["type"="enforcement"]["enforcement"~"^(maxspeed|average_speed|traffic_signals)$"](${bb})->.enf;
.enf out body qt;
node(r.enf);
out body qt;`;
}

/** Convierte la respuesta JSON de Overpass en la entrada de build(). */
export function fromOverpass(elements) {
  const coord = new Map();
  const input = { ways: [], pois: [], waterways: [], fords: new Set(), cameraNodes: [], relations: [], coordOf: (id) => coord.get(id) };
  for (const el of elements) {
    const t = el.tags;
    if (el.type === 'way' && t?.waterway && el.geometry) {
      input.waterways.push({ tags: t, geom: el.geometry.filter(Boolean).map((g) => [g.lat, g.lon]) });
      continue;
    }
    if (el.type === 'way' && el.nodes && t?.highway) { input.ways.push(el); continue; }
    if (el.type === 'relation') { input.relations.push(el.members ? { id: el.id, tags: t || {}, members: el.members } : el); continue; }
    if (el.type === 'node' && isCameraNode(t)) input.cameraNodes.push(el);
    if (el.type === 'node' && el.lat !== undefined) coord.set(el.id, [el.lat, el.lon]);
    if (t) {
      if (t.ford === 'yes' || t.ford === 'stepping_stones') input.fords.add(el.id);
      if (t.name || t.amenity || t.emergency) input.pois.push(el);
    }
  }
  return input;
}

/**
 * @param input  { ways: [{nodes, tags}], coordOf(id) → [lat, lon] | undefined,
 *                 pois: [{type, id, lat|center, tags}], waterways: [{tags, geom: [[lat, lon]]}], fords: Set<id> }
 * @param dem    mosaico de relieve (flood.js) o null
 */
export function build(input, bbox, dem = null, onProgress) {
  const { ways, pois, fords, coordOf } = input;
  const coord = { get: coordOf };
  const waterways = [];
  for (const ww of input.waterways) {
    const w = WATER_WEIGHT_OF(ww.tags);
    if (w && ww.geom.length > 1) waterways.push({ w, geom: ww.geom });
  }
  onProgress?.('Construyendo el grafo de calles…');

  const idx = new Map();
  const la = [];
  const lo = [];
  const isFord = [];
  const ix = (id) => {
    let i = idx.get(id);
    if (i === undefined) {
      const c = coord.get(id);
      if (!c) return -1;
      i = la.length;
      idx.set(id, i);
      la.push(c[0]);
      lo.push(c[1]);
      isFord.push(fords.has(id) ? 1 : 0);
    }
    return i;
  };

  const names = [];
  const nameIdx = new Map();
  const nameOf = (s) => {
    if (!s) return -1;
    let i = nameIdx.get(s);
    if (i === undefined) { i = names.length; names.push(s); nameIdx.set(s, i); }
    return i;
  };

  // Primera pasada: nodos y aristas (el riesgo necesita conocer todos los nodos antes).
  const ef = [], et = [], ew = [], ed = [], en = [], er = [], eway = [], etoll = [], elim = [], einf = [];
  const streets = new Map();
  let maxMs = 1;
  for (let wi = 0; wi < ways.length; wi++) {
    const t = ways[wi].tags;
    const nodes = ways[wi].nodes;
    const hw = t.highway;
    const rb = t.junction === 'roundabout' || t.junction === 'circular';
    let ow = 0;
    if (t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1') ow = 1;
    else if (t.oneway === '-1' || t.oneway === 'reverse') ow = -1;
    else if (t.oneway !== 'no' && (rb || hw === 'motorway' || hw === 'motorway_link')) ow = 1;

    const limit = parseInt(t.maxspeed, 10);
    const base = SPEED[hw] || 30;
    const kmh = limit > 0 && limit <= 130 ? Math.min(limit * 0.85, Math.max(base, limit * 0.85)) : base;
    const mps = kmh / 3.6;
    if (mps > maxMs) maxMs = mps;
    const nm = nameOf(t.name || t.ref || '');
    const toll = t.toll === 'yes' || t['toll:motorcar'] === 'yes' ? 1 : 0;
    const [limF, infF] = speedLimit(t, true);
    const [limB, infB] = speedLimit(t, false);
    if (t.name && !streets.has(t.name)) {
      const c = coord.get(nodes[nodes.length >> 1]);
      if (c) streets.set(t.name, c);
    }
    for (let k = 0; k + 1 < nodes.length; k++) {
      const a = ix(nodes[k]);
      const b = ix(nodes[k + 1]);
      if (a < 0 || b < 0 || a === b) continue;
      const d = haversine(la[a], lo[a], la[b], lo[b]);
      const s = d / mps;
      const r = rb ? 1 : 0;
      if (ow >= 0) { ef.push(a); et.push(b); ew.push(s); ed.push(d); en.push(nm); er.push(r); eway.push(wi); etoll.push(toll); elim.push(ow === -1 ? limB : limF); einf.push(ow === -1 ? infB : infF); }
      if (ow <= 0) { ef.push(b); et.push(a); ew.push(s); ed.push(d); en.push(nm); er.push(r); eway.push(wi); etoll.push(toll); elim.push(limB); einf.push(infB); }
    }
  }

  onProgress?.('Calculando el riesgo de inundación…');
  const nRisk = nodeRisk(la, lo, waterways, dem);

  // Lista de adyacencia compacta (CSR) en arrays tipados.
  const n = la.length;
  const m = ef.length;
  const off = new Int32Array(n + 1);
  for (let j = 0; j < m; j++) off[ef[j] + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const pos = off.slice(0, n);
  const tgt = new Int32Array(m), wt = new Float32Array(m), dist = new Float32Array(m);
  const nmA = new Int32Array(m), rbA = new Uint8Array(m), risk = new Uint8Array(m), hard = new Uint8Array(m), tollA = new Uint8Array(m), limA = new Uint8Array(m), limInf = new Uint8Array(m);
  for (let j = 0; j < m; j++) {
    const p = pos[ef[j]]++;
    tgt[p] = et[j]; wt[p] = ew[j]; dist[p] = ed[j]; nmA[p] = en[j]; rbA[p] = er[j]; tollA[p] = etoll[j]; limA[p] = elim[j]; limInf[p] = einf[j];
    const [r, h] = edgeRisk(nRisk[ef[j]], nRisk[et[j]], ways[eway[j]].tags, isFord[ef[j]], isFord[et[j]]);
    risk[p] = Math.round(r * 255);
    hard[p] = h;
  }

  // Solo se "engancha" a la mayor componente FUERTEMENTE conexa: desde cualquiera de sus nodos se
  // llega a cualquier otro respetando los sentidos únicos (evita quedar atrapado en un callejón).
  const snap = strongestComponent(n, off, tgt);

  // Índice de búsqueda y puntos de emergencia.
  const sName = [], sNorm = [], sKind = [], sLa = [], sLo = [];
  const add = (name, kind, lat, lon) => { sName.push(name); sNorm.push(norm(name)); sKind.push(kind); sLa.push(lat); sLo.push(lon); };
  const eKind = [], eName = [], eLa = [], eLo = [], ePhone = [];
  const seen = new Set();
  for (const p of pois) {
    const t = p.tags;
    const lat = p.lat ?? p.center?.lat;
    const lon = p.lon ?? p.center?.lon;
    if (lat === undefined) continue;
    const em = t.emergency === 'defibrillator' ? 'defibrillator' : EMERGENCY[t.amenity] ? t.amenity : null;
    if (em && !seen.has('e' + p.type + p.id)) {
      seen.add('e' + p.type + p.id);
      eKind.push(em); eName.push(t.name || ''); eLa.push(lat); eLo.push(lon);
      ePhone.push(t.phone || t['contact:phone'] || '');
    }
    if (t.name && !seen.has('s' + p.type + p.id)) {
      seen.add('s' + p.type + p.id);
      const k = t.amenity || t.shop || t.tourism || t.place || '';
      add(t.name, KIND[k] || (t.shop ? 'Tienda' : 'Lugar'), lat, lon);
    }
  }
  for (const [name, c] of streets) add(name, 'Calle', c[0], c[1]);

  const cams = buildCameras(input.cameraNodes || [], input.relations || [], coordOf, input.official || []);

  return {
    version: GRAPH_VERSION, date: Date.now(), bbox, maxMs, dem: !!dem, waterways: waterways.length,
    la: Float64Array.from(la), lo: Float64Array.from(lo), off, tgt, wt, dist, nm: nmA, rb: rbA, risk, hard, toll: tollA, lim: limA, limInf, names, snap, ...cams,
    sName, sNorm, sKind, sLa: Float64Array.from(sLa), sLo: Float64Array.from(sLo),
    eKind, eName, ePhone, eLa: Float64Array.from(eLa), eLo: Float64Array.from(eLo),
  };
}

// Algoritmo de Kosaraju iterativo (sin recursión: hay grafos con millones de nodos).
function strongestComponent(n, off, tgt) {
  const m = tgt.length;
  const order = new Int32Array(n);
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const it = new Int32Array(n);
  let oi = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    let sp = 0;
    stack[sp++] = s; seen[s] = 1; it[s] = off[s];
    while (sp) {
      const u = stack[sp - 1];
      if (it[u] < off[u + 1]) {
        const v = tgt[it[u]++];
        if (!seen[v]) { seen[v] = 1; it[v] = off[v]; stack[sp++] = v; }
      } else { sp--; order[oi++] = u; }
    }
  }
  // Grafo inverso en CSR.
  const roff = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) roff[tgt[e] + 1]++;
  for (let i = 0; i < n; i++) roff[i + 1] += roff[i];
  const rpos = roff.slice(0, n);
  const rsrc = new Int32Array(m);
  for (let u = 0; u < n; u++) for (let e = off[u]; e < off[u + 1]; e++) rsrc[rpos[tgt[e]]++] = u;

  const comp = new Int32Array(n).fill(-1);
  let best = -1, bestSize = 0, c = 0;
  for (let k = n - 1; k >= 0; k--) {
    const s = order[k];
    if (comp[s] >= 0) continue;
    let sp = 0, size = 0;
    stack[sp++] = s; comp[s] = c;
    while (sp) {
      const u = stack[--sp];
      size++;
      for (let x = roff[u]; x < roff[u + 1]; x++) {
        const v = rsrc[x];
        if (comp[v] < 0) { comp[v] = c; stack[sp++] = v; }
      }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }
  const snap = new Uint8Array(n);
  for (let i = 0; i < n; i++) snap[i] = comp[i] === best ? 1 : 0;
  return snap;
}

const WATER_W = { river: 1, torrent: 0.9, wadi: 0.9, stream: 0.55, brook: 0.45, canal: 0.3, drain: 0.3, ditch: 0.25 };
function WATER_WEIGHT_OF(t) {
  let w = WATER_W[t.waterway] || 0;
  if (!w) return 0;
  // Ramblas y arroyos intermitentes: secos casi siempre, violentos con lluvia torrencial.
  if (t.intermittent === 'yes' || t.seasonal === 'yes') w = Math.max(w, 0.8);
  return w;
}
