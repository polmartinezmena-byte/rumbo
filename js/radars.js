// Radares fijos, de tramo y de semáforo a partir de OpenStreetMap:
//   · nodos highway=speed_camera
//   · relaciones type=enforcement (enforcement=maxspeed | average_speed | traffic_signals)
//     con miembros "device", "from" y "to" (un tramo va de "from" a "to").
// Avisar de la ubicación de radares es legal en España: la DGT publica la de los fijos y de tramo.
// Los radares móviles no son públicos y no se incluyen.
import { bearing } from './geo.js';

export const KIND = { FIXED: 0, SECTION_START: 1, SECTION_END: 2, RED_LIGHT: 3 };
const CARD = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };

// Semáforos con cámara («foto-rojo»): varias formas de etiquetarlos en OSM.
export const isRedLight = (t) =>
  t?.enforcement === 'traffic_signals' || t?.speed_camera === 'traffic_signals' ||
  t?.red_light_camera === 'yes' || t?.['camera:type'] === 'red_light';
export const isCameraNode = (t) => t?.highway === 'speed_camera' || isRedLight(t);

const speedOf = (t) => {
  const v = parseInt(t?.maxspeed, 10);
  return v > 0 && v <= 150 ? v : 0;
};
const dirOf = (t) => {
  const d = t?.direction ?? t?.['camera:direction'];
  if (d == null) return -1;
  const n = parseFloat(d);
  if (!Number.isNaN(n)) return ((n % 360) + 360) % 360;
  return CARD[String(d).toUpperCase()] ?? -1;
};

/**
 * @param nodes      [{id, lat, lon, tags}] nodos highway=speed_camera (y otros miembros con etiquetas)
 * @param relations  [{id, tags, members: [{type, ref, role}]}]
 * @param coordOf    id → [lat, lon]
 * @returns { cLa, cLo, cSpeed, cKind, cSec, cDir }
 */
export function buildCameras(nodes, relations, coordOf, official = []) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const used = new Set();
  const out = [];
  const pos = (m) => (m && m.type === 'node' ? coordOf(m.ref) || (byId.get(m.ref) && [byId.get(m.ref).lat, byId.get(m.ref).lon]) : null);
  let sec = 0;
  for (const r of relations) {
    const t = r.tags;
    const role = (name) => r.members.find((m) => m.role === name && m.type === 'node');
    const devices = r.members.filter((m) => m.role === 'device' && m.type === 'node');
    devices.forEach((m) => used.add(m.ref));
    const dev = devices[0] && byId.get(devices[0].ref);
    const speed = speedOf(t) || speedOf(dev?.tags);
    if (t.enforcement === 'average_speed') {
      const a = pos(role('from')) || pos(devices[0]);
      const b = pos(role('to')) || pos(devices[devices.length - 1]);
      if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
      out.push({ lat: a[0], lon: a[1], speed, kind: KIND.SECTION_START, sec, dir: -1 });
      out.push({ lat: b[0], lon: b[1], speed, kind: KIND.SECTION_END, sec, dir: -1 });
      sec++;
    } else if (t.enforcement === 'maxspeed' || t.enforcement === 'traffic_signals') {
      const p = pos(role('from')) || pos(devices[0]);
      if (!p) continue;
      out.push({ lat: p[0], lon: p[1], speed, kind: t.enforcement === 'maxspeed' ? KIND.FIXED : KIND.RED_LIGHT, sec: -1, dir: dirOf(dev?.tags) });
    }
  }
  for (const n of nodes) {
    if (used.has(n.id) || !isCameraNode(n.tags)) continue;
    out.push({ lat: n.lat, lon: n.lon, speed: speedOf(n.tags), kind: isRedLight(n.tags) ? KIND.RED_LIGHT : KIND.FIXED, sec: -1, dir: dirOf(n.tags) });
  }
  return pack(mergeOfficial(out, official, sec));
}

const OFFICIAL_KIND = { fixed: KIND.FIXED, section_start: KIND.SECTION_START, section_end: KIND.SECTION_END, red_light: KIND.RED_LIGHT };
const near = (a, b, m) => {
  const dy = (a.lat - b.lat) * 111320, dx = (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return dx * dx + dy * dy < m * m;
};

// Los datos oficiales mandan: un radar de OSM a menos de 40 m de uno oficial del mismo tipo se
// considera el mismo (se aprovecha su límite y su dirección si el oficial no los trae); un tramo de
// OSM con un extremo a menos de 150 m de un tramo oficial se descarta entero.
function mergeOfficial(osm, official, secBase) {
  if (!official.length) return osm;
  const off = official.map((c) => ({ lat: c.lat, lon: c.lon, speed: c.speed || 0, kind: OFFICIAL_KIND[c.kind], sec: c.sec !== undefined ? secBase + c.sec : -1, dir: -1 }));
  const isSec = (k) => k === KIND.SECTION_START || k === KIND.SECTION_END;
  const dropSec = new Set();
  const keep = [];
  for (const c of osm) {
    if (isSec(c.kind)) {
      if (off.some((o) => isSec(o.kind) && near(o, c, 150))) dropSec.add(c.sec);
      continue;
    }
    const twin = off.find((o) => o.kind === c.kind && near(o, c, 40));
    if (twin) {
      if (!twin.speed) twin.speed = c.speed;
      if (twin.dir < 0) twin.dir = c.dir;
    } else keep.push(c);
  }
  for (const c of osm) if (isSec(c.kind) && !dropSec.has(c.sec)) keep.push(c);
  return [...off, ...keep];
}

function pack(out) {
  return {
    cLa: Float64Array.from(out, (c) => c.lat), cLo: Float64Array.from(out, (c) => c.lon),
    cSpeed: Uint8Array.from(out, (c) => c.speed), cKind: Uint8Array.from(out, (c) => c.kind),
    cSec: Int32Array.from(out, (c) => c.sec), cDir: Int16Array.from(out, (c) => Math.round(c.dir)),
  };
}

const M = 111320;
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/** Radares y tramos que encuentra la ruta, con su distancia desde el origen. */
export function camerasOnRoute(G, route) {
  if (!G.cLa?.length) return { cameras: [], sections: [] };
  const { coords, cum } = route;
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lo, la] of coords) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  const pad = 0.0005;
  const hits = [];
  for (let i = 0; i < G.cLa.length; i++) {
    const la = G.cLa[i], lo = G.cLo[i];
    if (la < s - pad || la > n + pad || lo < w - pad || lo > e + pad) continue;
    const kx = Math.cos((la * Math.PI) / 180) * M;
    let best = Infinity, along = 0, head = 0, bj = 0;
    for (let j = 0; j + 1 < coords.length; j++) {
      const ax = coords[j][0] * kx, ay = coords[j][1] * M;
      const dx = coords[j + 1][0] * kx - ax, dy = coords[j + 1][1] * M - ay;
      const px = lo * kx - ax, py = la * M - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      const t = Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d < best) {
        best = d;
        bj = j;
        along = cum[j] + t * (cum[j + 1] - cum[j]);
        head = bearing(coords[j][1], coords[j][0], coords[j + 1][1], coords[j + 1][0]);
      }
    }
    if (best > 30) continue;
    // Si el radar tiene dirección y no coincide con la nuestra, es del otro sentido.
    if (G.cDir[i] >= 0 && angleDiff(G.cDir[i], head) > 70) continue;
    // Si la fuente no trae el límite, se usa el de la vía (OSM) en ese punto.
    hits.push({ along, speed: G.cSpeed[i] || route.lim?.[bj] || 0, kind: G.cKind[i], sec: G.cSec[i] });
  }
  hits.sort((a, b) => a.along - b.along);

  const sections = [];
  const starts = new Map();
  for (const h of hits) {
    if (h.kind === KIND.SECTION_START) starts.set(h.sec, h);
    else if (h.kind === KIND.SECTION_END && starts.has(h.sec)) {
      const a = starts.get(h.sec);
      if (h.along - a.along > 200) sections.push({ start: a.along, end: h.along, speed: a.speed || h.speed });
      starts.delete(h.sec);
    }
  }
  // Puntos sueltos (fijos y semáforos); evita duplicados a menos de 50 m.
  const cameras = [];
  for (const h of hits) {
    if (h.kind === KIND.SECTION_START || h.kind === KIND.SECTION_END) continue;
    if (cameras.length && h.along - cameras[cameras.length - 1].along < 50) continue;
    cameras.push({ along: h.along, speed: h.speed, kind: h.kind });
  }
  return { cameras, sections };
}

/** Capa GeoJSON con los radares dentro de una caja. */
export function camerasLayer(G, b) {
  const features = [];
  if (G.cLa) {
    for (let i = 0; i < G.cLa.length && features.length < 3000; i++) {
      const la = G.cLa[i], lo = G.cLo[i];
      if (la < b.s || la > b.n || lo < b.w || lo > b.e) continue;
      features.push({ type: 'Feature', properties: { kind: G.cKind[i], speed: G.cSpeed[i] || '' }, geometry: { type: 'Point', coordinates: [lo, la] } });
    }
  }
  return { type: 'FeatureCollection', features };
}
