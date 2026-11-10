// Modo con conexión: cuando el origen o el destino quedan fuera de tus mapas descargados, Rumbo
// calcula la ruta, busca direcciones y encuentra servicios con servicios abiertos de OpenStreetMap
// (Valhalla de FOSSGIS, Photon de Komoot y Overpass). Sin conexión se sigue usando solo lo descargado.
// El resultado tiene la misma forma que una ruta local, así que el guiado, la voz y los avisos funcionan igual.
import { haversine, bearing } from './geo.js';
import { EMERGENCY } from './graph-build.js';

const VALHALLA = 'https://valhalla1.openstreetmap.de';
const PHOTON = 'https://photon.komoot.io/api/';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const ORD = ['primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta', 'séptima', 'octava'];
const CARD = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];

export const isOnline = () => globalThis.navigator?.onLine !== false;

async function post(path, body, timeout = 20000) {
  const r = await fetch(VALHALLA + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `El servidor de rutas respondió ${r.status}`);
  return j;
}

/** Polilínea codificada con 6 decimales (formato de Valhalla) → [[lon, lat], …]. */
export function decodePolyline(str, precision = 6) {
  const f = 10 ** precision;
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, res = 0, b;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lon / f, lat / f]);
  }
  return out;
}

// ------------------------------------------------------------------ instrucciones en español
// Carriles de Valhalla: cada dirección es un bit; «active»/«valid» marcan los que sirven.
const LANE_BITS = [[1, 'none'], [2, 'through'], [4, 'sharp_left'], [8, 'left'], [16, 'slight_left'], [32, 'slight_right'], [64, 'right'], [128, 'sharp_right'], [256, 'reverse'], [512, 'merge_to_left'], [1024, 'merge_to_right']];
function valhallaLanes(list) {
  if (!Array.isArray(list) || list.length < 2) return undefined;
  const lanes = list.map((l) => ({
    ind: LANE_BITS.filter(([b]) => l.directions & b).map(([, n]) => n),
    ok: !!(l.active || l.valid),
  }));
  if (!lanes.some((l) => l.ok) || lanes.every((l) => l.ok)) return undefined;
  for (const l of lanes) if (!l.ind.length) l.ind = ['none'];
  return lanes;
}

const SIDE = (right) => (right ? 'derecha' : 'izquierda');
function stepFromManeuver(m, next, coords) {
  const name = m.street_names?.[0] || '';
  const toward = m.sign?.exit_toward_elements?.[0]?.text || m.sign?.exit_branch_elements?.[0]?.text || '';
  const exitNo = m.sign?.exit_number_elements?.[0]?.text;
  const por = name ? ` por ${name}` : '';
  const hacia = toward ? ` hacia ${toward}` : name ? ` hacia ${name}` : '';
  const t = m.type;
  const turn = (mod, angle, txt) => ({ type: 'turn', mod, angle, text: txt });
  switch (t) {
    case 1: case 2: case 3: {
      const i = m.begin_shape_index, j = Math.min(coords.length - 1, i + 3);
      const dep = bearing(coords[i][1], coords[i][0], coords[j][1], coords[j][0]);
      return { type: 'depart', mod: 'straight', angle: 0, text: `Dirígete hacia el ${CARD[Math.round(dep / 45) % 8]}${por}` };
    }
    case 4: case 5: case 6:
      return { type: 'arrive', mod: 'arrive', angle: 0, text: t === 4 ? 'Has llegado a tu destino' : `Has llegado a tu destino, a la ${SIDE(t === 5)}` };
    case 7: case 8: case 22: case 17:
      return name ? turn('straight', 0, `Continúa por ${name}`) : null;
    case 9: case 16: return turn('slight', t === 9 ? 45 : -45, `Gira ligeramente a la ${SIDE(t === 9)}${por}`);
    case 10: case 15: return turn('turn', t === 10 ? 90 : -90, `Gira a la ${SIDE(t === 10)}${por}`);
    case 11: case 14: return turn('sharp', t === 11 ? 135 : -135, `Gira bruscamente a la ${SIDE(t === 11)}${por}`);
    case 12: case 13: return turn('uturn', 180, `Cambia de sentido${por}`);
    case 18: case 19: return turn('slight', t === 18 ? 45 : -45, `Toma el ramal de la ${SIDE(t === 18)}${hacia}`);
    case 20: case 21: return turn('slight', t === 20 ? 45 : -45, `Toma la salida${exitNo ? ` ${exitNo}` : ''} de la ${SIDE(t === 20)}${hacia}`);
    case 23: case 24: return turn('slight', t === 23 ? 30 : -30, `Mantente a la ${SIDE(t === 23)}${hacia}`);
    case 25: case 37: case 38: return turn('slight', t === 38 ? -30 : 30, `Incorpórate${name ? ` a ${name}` : ''}`);
    case 26: {
      const n = m.roundabout_exit_count || 1;
      const out = next?.street_names?.[0] || '';
      return { type: 'roundabout', mod: 'roundabout', angle: 0, exit: n, text: `En la rotonda, toma la ${ORD[n - 1] || n + 'ª'} salida${out ? ` hacia ${out}` : ''}` };
    }
    case 28: return turn('straight', 0, `Embarca en el ferry${name ? ` ${name}` : ''}`);
    default: return null; // 27 (salida de rotonda) y 29 ya van incluidas en la maniobra anterior
  }
}

function buildRoute(trip, foot) {
  const leg = trip.legs[0];
  const coords = decodePolyline(leg.shape);
  const cum = new Array(coords.length).fill(0);
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  const steps = [];
  leg.maneuvers.forEach((m, k) => {
    const s = stepFromManeuver(m, leg.maneuvers[k + 1], coords);
    if (!s) return;
    const i = Math.min(m.begin_shape_index, coords.length - 1);
    steps.push({ ...s, name: m.street_names?.[0] || '', along: cum[i], i, lanes: s.type === 'turn' ? valhallaLanes(m.lanes) : undefined });
  });
  if (steps[0]?.type !== 'depart') steps.unshift({ type: 'depart', mod: 'straight', angle: 0, name: '', along: 0, i: 0, text: 'Sigue la ruta' });
  if (steps[steps.length - 1].type !== 'arrive') steps.push({ type: 'arrive', mod: 'arrive', angle: 0, name: '', along: cum[cum.length - 1], i: coords.length - 1, text: 'Has llegado a tu destino' });
  for (let k = 0; k < steps.length; k++) steps[k].dist = (steps[k + 1]?.along ?? cum[cum.length - 1]) - steps[k].along;
  const n = coords.length - 1;
  return {
    online: true, foot, level: 0, flood: false,
    coords, cum, steps, shape: leg.shape,
    distance: cum[n], duration: trip.summary.time,
    lim: new Array(n).fill(0), limInf: new Array(n).fill(0),
    risk: new Array(n).fill(0), riskRuns: [], riskLen: 0, tollLen: 0,
    cameras: [], sections: [],
  };
}

/**
 * Ruta con conexión.
 * @param avoid  puntos [lat, lon] por los que no debe pasar (cortes de la DGT, entradas a ZBE prohibidas)
 */
export async function onlineRoute(from, to, { foot = false, avoidTolls = false, avoid = [], alternates = 0 } = {}) {
  const body = {
    locations: [{ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }],
    costing: foot ? 'pedestrian' : 'auto',
    costing_options: foot ? {} : { auto: { use_tolls: avoidTolls ? 0 : 0.5 } },
    exclude_locations: avoid.slice(0, 40).map(([lat, lon]) => ({ lat, lon })),
    language: 'es', units: 'kilometers', directions_type: 'maneuvers', turn_lanes: true,
  };
  if (alternates) body.alternates = alternates;
  const j = await post('/route', body);
  const r = buildRoute(j.trip, foot);
  if (alternates) r.altTrips = (j.alternates || []).map((a) => buildRoute(a.trip, foot));
  return r;
}

/** Límite de velocidad y peaje de cada tramo de la ruta (se ajusta la ruta a la red de Valhalla). */
export async function annotate(route) {
  try {
    const j = await post('/trace_attributes', {
      encoded_polyline: route.shape, costing: route.foot ? 'pedestrian' : 'auto', shape_match: 'edge_walk',
      filters: { attributes: ['edge.speed_limit', 'edge.toll', 'edge.begin_shape_index', 'edge.end_shape_index'], action: 'include' },
    }, 25000);
    for (const e of j.edges || []) {
      const a = e.begin_shape_index ?? 0, b = Math.min(e.end_shape_index ?? a, route.lim.length);
      for (let i = a; i < b; i++) {
        if (e.speed_limit > 0 && e.speed_limit < 200) route.lim[i] = e.speed_limit;
        if (e.toll) route.tollLen += route.cum[i + 1] - route.cum[i];
      }
    }
  } catch {
    // Sin límites: la ruta sigue siendo válida.
  }
  return route;
}

// ------------------------------------------------------------------ búsqueda de direcciones
export async function searchOnline(q, near) {
  const u = new URL(PHOTON);
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '10');
  if (near) { u.searchParams.set('lat', near[0].toFixed(4)); u.searchParams.set('lon', near[1].toFixed(4)); }
  const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.features || []).map((f) => {
    const p = f.properties;
    const street = p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : '';
    const name = p.name || street || p.city || '';
    const where = [p.name && street, p.city !== name && p.city, p.state].filter(Boolean).join(', ');
    return { name, kind: where || 'Lugar', lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], online: true };
  }).filter((x) => x.name)
    // Photon apenas tiene en cuenta la cercanía: se mezcla su orden con la distancia (5 km ≈ un puesto).
    .map((x, i) => ({ x, s: i + (near ? haversine(near[0], near[1], x.lat, x.lon) / 5000 : 0) }))
    .sort((a, b) => a.s - b.s)
    .map(({ x }) => x);
}

// ------------------------------------------------------------------ servicios cercanos (SOS)
// Photon responde en menos de un segundo; Overpass solo se usa si Photon no encuentra nada (puede tardar).
const PHOTON_POI = {
  hospital: ['hospital', 'amenity:hospital'], clinic: ['centro de salud', 'amenity:clinic'], pharmacy: ['farmacia', 'amenity:pharmacy'],
  police: ['policia', 'amenity:police'], fire_station: ['bomberos', 'amenity:fire_station'], drinking_water: ['fuente', 'amenity:drinking_water'],
  shelter: ['refugio', 'amenity:shelter'], defibrillator: ['desfibrilador', 'emergency:defibrillator'], fuel: ['gasolinera', 'amenity:fuel'],
};
const SELECT = {
  hospital: 'nwr["amenity"="hospital"]', clinic: 'nwr["amenity"="clinic"]', pharmacy: 'nwr["amenity"="pharmacy"]',
  fuel: 'nwr["amenity"="fuel"]', police: 'nwr["amenity"="police"]', fire_station: 'nwr["amenity"="fire_station"]',
  drinking_water: 'node["amenity"="drinking_water"]', shelter: 'nwr["amenity"="shelter"]', defibrillator: 'node["emergency"="defibrillator"]',
};
const poi = (kind, name, phone, lat, lon, near) => ({
  kind, label: EMERGENCY[kind], name: name || '', phone: phone || '', lat, lon,
  dist: haversine(near[0], near[1], lat, lon), bearing: bearing(near[0], near[1], lat, lon),
});

async function photonPois(near, kind) {
  const [q, tag] = PHOTON_POI[kind];
  const u = new URL(PHOTON);
  u.search = new URLSearchParams({ q, osm_tag: tag, lat: near[0].toFixed(4), lon: near[1].toFixed(4), limit: '15' });
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.features || []).map((f) => poi(kind, f.properties.name, '', f.geometry.coordinates[1], f.geometry.coordinates[0], near));
}

async function overpassPois(near, cats) {
  for (const radius of [5000, 30000]) {
    const sel = cats.map((c) => `${SELECT[c]}(around:${radius},${near[0]},${near[1]});`).join('');
    const q = `[out:json][timeout:15];(${sel});out center tags 200;`;
    let json = null;
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(12000) });
        if (r.ok) { json = await r.json(); break; }
      } catch { /* siguiente servidor */ }
    }
    if (!json) return [];
    const out = [];
    for (const el of json.elements) {
      const t = el.tags || {};
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      const kind = t.emergency === 'defibrillator' ? 'defibrillator' : t.amenity;
      if (lat != null && EMERGENCY[kind]) out.push(poi(kind, t.name, t.phone || t['contact:phone'], lat, lon, near));
    }
    if (out.length) return out;
  }
  return [];
}

export async function nearbyOnline(near, cat) {
  const cats = cat ? [cat] : ['hospital', 'clinic', 'pharmacy', 'police', 'fire_station'];
  let out = (await Promise.all(cats.map((c) => photonPois(near, c).catch(() => [])))).flat();
  if (!out.length) out = await overpassPois(near, cats).catch(() => []);
  const seen = new Set();
  return out.sort((a, b) => a.dist - b.dist)
    .filter((x) => { const k = x.kind + Math.round(x.lat * 2000) + Math.round(x.lon * 2000); return !seen.has(k) && seen.add(k); })
    .slice(0, 30);
}
