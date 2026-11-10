// Cruza los datos en directo (live.js) con un grafo de rutas:
//   · qué ZBE contiene cada nodo, y qué tramos penalizar según tu etiqueta y el horario
//   · qué tramos están cortados o con obras según la DGT
//   · qué incidencias, ZBE y gasolineras encuentra una ruta concreta
import { fastDist } from './geo.js';
import { zoneActive, FUELS, activeWarnings } from './live.js';
import { nearest } from './router.js';
import { liveTrafficItems, liveEdgePenalty } from './live-traffic.js';

const M = 111320;

// ------------------------------------------------------------------ rejilla espacial de nodos
function nodeGrid(G) {
  if (G._grid) return G._grid;
  const { la, lo } = G;
  const n = la.length;
  const b = G.bbox;
  const cell = 0.002; // ~200 m
  const W = Math.ceil((b.e - b.w) / cell) + 3, H = Math.ceil((b.n - b.s) / cell) + 3;
  const cellOf = (lat, lon) => {
    const x = Math.floor((lon - b.w) / cell) + 1, y = Math.floor((lat - b.s) / cell) + 1;
    return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
  };
  const start = new Int32Array(W * H + 1);
  const ci = new Int32Array(n);
  for (let i = 0; i < n; i++) { ci[i] = cellOf(la[i], lo[i]); if (ci[i] >= 0) start[ci[i] + 1]++; }
  for (let c = 0; c < W * H; c++) start[c + 1] += start[c];
  const pos = start.slice(0, W * H);
  const nodes = new Int32Array(n);
  for (let i = 0; i < n; i++) if (ci[i] >= 0) nodes[pos[ci[i]]++] = i;
  const near = (lat, lon, radiusM, fn) => {
    const r = Math.ceil(radiusM / (cell * M)) + 1;
    const c = cellOf(lat, lon);
    if (c < 0) return;
    const cx = c % W, cy = Math.floor(c / W);
    for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
        const k = y * W + x;
        for (let p = start[k]; p < start[k + 1]; p++) fn(nodes[p]);
      }
    }
  };
  G._grid = { near };
  return G._grid;
}

// ------------------------------------------------------------------ ZBE de cada nodo
function rasterize(polys, cellM) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const ring of polys) for (const [x, y] of ring) { if (y < s) s = y; if (y > n) n = y; if (x < w) w = x; if (x > e) e = x; }
  const dLat = cellM / 110540, dLon = cellM / (M * Math.cos((((s + n) / 2) * Math.PI) / 180));
  const Wd = Math.ceil((e - w) / dLon) + 1, Hd = Math.ceil((n - s) / dLat) + 1;
  const data = new Uint8Array(Wd * Hd);
  // Cada polígono de la lista es un anillo exterior independiente (zonas con varias piezas).
  for (const ring of polys) {
    const edges = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const x1 = (ring[j][0] - w) / dLon, y1 = (ring[j][1] - s) / dLat, x2 = (ring[i][0] - w) / dLon, y2 = (ring[i][1] - s) / dLat;
      if (y1 !== y2) edges.push(y1 < y2 ? [x1, y1, x2, y2] : [x2, y2, x1, y1]);
    }
    const xs = [];
    for (let y = 0; y < Hd; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (const [ax, ay, bx, by] of edges) if (yc >= ay && yc < by) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(Wd - 1, Math.floor(xs[k + 1] - 0.5)); x++) data[y * Wd + x] = 1;
      }
    }
  }
  return { s, w, n, e, dLat, dLon, W: Wd, H: Hd, data };
}

/** Índice de la ZBE que contiene cada nodo (-1 si ninguna). Se recalcula si cambian las ZBE. */
export function zoneOfNode(G, zones, version) {
  if (G._zoneV === version) return G._zone;
  const out = new Int16Array(G.la.length).fill(-1);
  const b = G.bbox;
  zones.forEach((z, zi) => {
    const r = rasterize(z.polys, 20);
    if (r.n < b.s || r.s > b.n || r.e < b.w || r.w > b.e) return;
    for (let i = 0; i < G.la.length; i++) {
      const lat = G.la[i], lon = G.lo[i];
      if (lat < r.s || lat > r.n || lon < r.w || lon > r.e) continue;
      const x = Math.floor((lon - r.w) / r.dLon), y = Math.floor((lat - r.s) / r.dLat);
      // Las calles que hacen de límite de la ZBE se pueden usar: un punto cuenta como «dentro» solo si
      // también lo están las celdas a su alrededor (≈ 20 m hacia cada lado).
      const at = (xx, yy) => xx >= 0 && yy >= 0 && xx < r.W && yy < r.H && r.data[yy * r.W + xx];
      const inside = at(x, y) && at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1);
      // ZBE dentro de otra (Distrito Centro dentro de Madrid): manda la que restringe más etiquetas.
      if (inside && (out[i] < 0 || zones[out[i]].restricted.length < z.restricted.length)) out[i] = zi;
    }
  });
  G._zone = out;
  G._zoneV = version;
  return out;
}

// ------------------------------------------------------------------ penalizaciones
const BLOCK = 500;       // corte total o inundación: solo si no hay otra forma de llegar
const CARRIAGEWAY = 8;   // calzada cortada (suele ser un sentido)
const ZBE = 5000;        // ZBE donde tu etiqueta no puede entrar ahora: solo para salir si ya estás dentro

function distToSegment(lat, lon, a, b) {
  const kx = Math.cos((lat * Math.PI) / 180) * M;
  const ax = a[1] * kx, ay = a[0] * M, bx = b[1] * kx, by = b[0] * M, px = lon * kx, py = lat * M;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Multiplicador de coste por tramo (Float32Array) o null si no hay nada que penalizar.
 * @param opts { sticker: 'A'|'B'|'C'|'ECO'|'0'|'' , avoidZbe: boolean, now: Date }
 */
export function penalties(G, live, opts) {
  const key = `${live.version}|${opts.sticker}|${opts.avoidZbe}|${new Date(opts.now).getHours()}|${!!opts.traffic}`;
  if (G._penKey === key) return G._pen;
  const m = G.tgt.length;
  let pen = null;
  const ensure = () => (pen ??= new Float32Array(m).fill(1));

  // ZBE
  const zones = live.zbe?.zones || [];
  if (zones.length && opts.avoidZbe && opts.sticker) {
    const zon = zoneOfNode(G, zones, live.zbe?.updated || live.version);
    const banned = zones.map((z) => z.restricted.includes(opts.sticker) && zoneActive(z, new Date(opts.now)));
    if (banned.some(Boolean)) {
      for (let u = 0; u < G.la.length; u++) {
        for (let e = G.off[u]; e < G.off[u + 1]; e++) {
          const z = zon[G.tgt[e]];
          if (z >= 0 && banned[z]) ensure()[e] = ZBE;
        }
      }
    }
  }

  // Incidencias de la DGT: cortes e inundaciones
  const items = (live.inc?.items || []).filter((x) => x.k === 'cortada' || x.k === 'inundacion' || x.k === 'calzada');
  if (items.length) {
    const grid = nodeGrid(G);
    for (const it of items) {
      const a = it.from, b = it.to || it.from;
      if (fastDist(a[0], a[1], b[0], b[1]) > 20000) continue; // tramos larguísimos: poco fiables
      const mult = it.k === 'calzada' ? CARRIAGEWAY : BLOCK;
      const midLa = (a[0] + b[0]) / 2, midLo = (a[1] + b[1]) / 2;
      // Radio amplio: en carretera los tramos del grafo pueden medir cientos de metros.
      const radius = fastDist(a[0], a[1], b[0], b[1]) / 2 + 600;
      grid.near(midLa, midLo, radius, (u) => {
        for (let e = G.off[u]; e < G.off[u + 1]; e++) {
          const v = G.tgt[e];
          // Un tramo está afectado si al menos 2 de 5 puntos repartidos por él caen sobre el corte.
          let hits = 0;
          for (let s = 0; s <= 4; s++) {
            const t = s / 4;
            if (distToSegment(G.la[u] + (G.la[v] - G.la[u]) * t, G.lo[u] + (G.lo[v] - G.lo[u]) * t, a, b) <= 25) hits++;
          }
          if (hits >= 2) ensure()[e] = Math.max(pen[e], mult);
        }
      });
    }
  }
  // Atascos fuertes en directo: las rutas los evitan si hay alternativa razonable.
  if (opts.traffic) {
    const items = liveTrafficItems(live).filter((x) => x.l >= 2 && x.p.some((q) => q[0] >= G.bbox.s && q[0] <= G.bbox.n && q[1] >= G.bbox.w && q[1] <= G.bbox.e));
    if (items.length) liveEdgePenalty(G, items, nodeGrid(G).near, ensure);
  }
  G._pen = pen;
  G._penKey = key;
  return pen;
}

// ------------------------------------------------------------------ lo que encuentra una ruta
function projectOnRoute(route, lat, lon, maxD) {
  const { coords, cum } = route;
  const kx = Math.cos((lat * Math.PI) / 180) * M;
  let best = Infinity, along = 0;
  for (let j = 0; j + 1 < coords.length; j++) {
    const ax = coords[j][0] * kx, ay = coords[j][1] * M;
    const dx = coords[j + 1][0] * kx - ax, dy = coords[j + 1][1] * M - ay;
    const px = lon * kx - ax, py = lat * M - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
    const d = Math.hypot(px - t * dx, py - t * dy);
    if (d < best) { best = d; along = cum[j] + t * (cum[j + 1] - cum[j]); }
  }
  return best <= maxD ? { d: best, along } : null;
}

function routeBox(route, padDeg) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lo, la] of route.coords) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  return { s: s - padDeg, n: n + padDeg, w: w - padDeg, e: e + padDeg };
}
const inBox = (b, la, lo) => la >= b.s && la <= b.n && lo >= b.w && lo <= b.e;

export function incidentsOnRoute(route, live) {
  const items = live.inc?.items || [];
  if (!items.length) return [];
  const box = routeBox(route, 0.003);
  const out = [];
  for (const it of items) {
    const pts = it.to ? [it.from, it.to] : [it.from];
    if (!pts.some((p) => inBox(box, p[0], p[1]))) continue;
    let hit = null;
    for (const p of pts) {
      const h = projectOnRoute(route, p[0], p[1], 40);
      if (h && (!hit || h.along < hit.along)) hit = h;
    }
    if (hit) out.push({ along: hit.along, k: it.k, road: it.road, town: it.town, det: it.det, pk: it.pk });
  }
  return out.sort((a, b) => a.along - b.along);
}

/** Tramos de la ruta dentro de una ZBE, con si tu etiqueta puede entrar ahora. */
export function zbeOnRoute(G, route, path, live, opts) {
  const zones = live.zbe?.zones || [];
  if (!zones.length || !path) return [];
  const zon = zoneOfNode(G, zones, live.zbe?.updated || live.version);
  const runs = [];
  for (let i = 0; i < path.length; i++) {
    const z = zon[path[i]];
    const last = runs[runs.length - 1];
    if (z < 0) { if (last && last.open) last.open = false; continue; }
    if (last && last.open && last.z === z) { last.end = route.cum[i]; continue; }
    const zone = zones[z];
    runs.push({
      z, open: true, start: route.cum[i], end: route.cum[i], name: zone.name, url: zone.url,
      restricted: zone.restricted, days: zone.days, times: zone.times,
      banned: !!opts.sticker && zone.restricted.includes(opts.sticker) && zoneActive(zone, new Date(opts.now)),
      active: zoneActive(zone, new Date(opts.now)),
    });
  }
  return runs.map(({ open, z, ...r }) => r);
}

/** Gasolineras a menos de 700 m de la ruta, de la más barata a la más cara. */
export function fuelOnRoute(route, live, fuelType, limit = 6) {
  const F = live.fuel;
  if (!F || !FUELS[fuelType]) return null;
  const price = F.prices[fuelType];
  const box = routeBox(route, 0.008);
  const all = [];
  for (let i = 0; i < F.la.length; i++) {
    if (!(price[i] > 0) || !inBox(box, F.la[i], F.lo[i])) continue;
    const h = projectOnRoute(route, F.la[i], F.lo[i], 700);
    if (h) all.push({ i, along: h.along, detour: Math.round(h.d * 2), price: Math.round(price[i] * 1000) / 1000 });
  }
  if (!all.length) return { fuel: fuelType, date: F.date, list: [] };
  const avg = all.reduce((s, x) => s + x.price, 0) / all.length;
  all.sort((a, b) => a.price - b.price || a.detour - b.detour);
  return {
    fuel: fuelType, date: F.date, count: all.length, avg: Math.round(avg * 1000) / 1000,
    list: all.slice(0, limit).map((x) => ({
      ...x, name: F.name[x.i], addr: F.addr[x.i], hours: F.hours[x.i], lat: F.la[x.i], lon: F.lo[x.i],
    })),
  };
}

function inRing(x, y, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Avisos de AEMET que cruza la ruta (se comprueba un punto cada ~2 km). */
export function warningsOnRoute(route, list) {
  if (!list?.length) return [];
  const { coords, cum } = route;
  const hits = new Map();
  let next = 0;
  for (let i = 0; i < coords.length; i++) {
    if (cum[i] < next && i !== coords.length - 1) continue;
    next = cum[i] + 2000;
    const [x, y] = coords[i];
    list.forEach((a, k) => {
      if (hits.has(k)) return;
      if (a.polys.some((p) => inRing(x, y, p))) hits.set(k, cum[i]);
    });
  }
  return [...hits].map(([k, along]) => ({ ...list[k], polys: undefined, along })).sort((a, b) => b.level - a.level || a.along - b.along);
}

/** Avisos que afectan a un punto (tu posición). */
export function warningsAt(lat, lon, list) {
  return (list || []).filter((a) => a.polys.some((p) => inRing(lon, lat, p))).map((a) => ({ ...a, polys: undefined }));
}

/** GeoJSON para el mapa (zona visible): incidencias, ZBE y gasolineras con precio. */
export function liveLayer(live, b, fuelType, sticker) {
  const inc = (live.inc?.items || []).filter((x) => inBox(b, x.from[0], x.from[1]) || (x.to && inBox(b, x.to[0], x.to[1])))
    .slice(0, 1500)
    .map((x) => ({ type: 'Feature', properties: { k: x.k, road: x.road }, geometry: { type: 'Point', coordinates: [x.from[1], x.from[0]] } }));
  const lines = (live.inc?.items || []).filter((x) => x.to && (x.k === 'cortada' || x.k === 'inundacion' || x.k === 'calzada') && (inBox(b, x.from[0], x.from[1]) || inBox(b, x.to[0], x.to[1])))
    .map((x) => ({ type: 'Feature', properties: { k: x.k }, geometry: { type: 'LineString', coordinates: [[x.from[1], x.from[0]], [x.to[1], x.to[0]]] } }));
  const zbe = (live.zbe?.zones || []).filter((z) => z.polys.some((r) => r.some(([x, y]) => inBox(b, y, x))) || z.polys.some((r) => {
    let s = 90, n = -90, w = 180, e = -180;
    for (const [x, y] of r) { if (y < s) s = y; if (y > n) n = y; if (x < w) w = x; if (x > e) e = x; }
    return s <= b.s && n >= b.n && w <= b.w && e >= b.e;
  })).map((z) => ({
    type: 'Feature',
    properties: { name: z.name, banned: !!sticker && z.restricted.includes(sticker), active: zoneActive(z) },
    geometry: { type: 'MultiPolygon', coordinates: z.polys.map((r) => [r]) },
  }));
  const F = live.fuel;
  const fuel = [];
  if (F && FUELS[fuelType]) {
    const price = F.prices[fuelType];
    for (let i = 0; i < F.la.length && fuel.length < 800; i++) {
      if (price[i] > 0 && inBox(b, F.la[i], F.lo[i])) fuel.push({ type: 'Feature', properties: { p: price[i].toFixed(3).replace('.', ','), v: price[i], name: F.name[i] }, geometry: { type: 'Point', coordinates: [F.lo[i], F.la[i]] } });
    }
    // Color relativo a la zona visible: verde las más baratas, rojo las más caras.
    const ps = fuel.map((f) => f.properties.v).sort((a, c) => a - c);
    const lo = ps[Math.floor(ps.length * 0.2)] ?? 0, hi = ps[Math.floor(ps.length * 0.8)] ?? 0;
    for (const f of fuel) f.properties.tier = f.properties.v <= lo ? 0 : f.properties.v >= hi ? 2 : 1;
  }
  const avisos = activeWarnings().filter((a) => a.polys.some((r) => r.some(([x, y]) => inBox({ s: b.s - 1, n: b.n + 1, w: b.w - 1, e: b.e + 1 }, y, x))))
    .map((a) => ({ type: 'Feature', properties: { level: a.level, phen: a.phen, area: a.area, expires: a.expires }, geometry: { type: 'MultiPolygon', coordinates: a.polys.map((r) => [r]) } }));
  const fc = (features) => ({ type: 'FeatureCollection', features });
  return { inc: fc(inc), incLines: fc(lines), zbe: fc(zbe), fuel: fc(fuel), avisos: fc(avisos) };
}

// Prepara la protección frente a ZBE prohibidas para tu etiqueta (ahora mismo):
//  · si el destino está dentro, se cambia por el punto más cercano fuera de la zona
//  · después, si la ruta aún entrara en una (sin salir de ella), se corta en el límite
// Si ya estás dentro de una ZBE, se permite salir de ella (la penalización te saca por lo más corto).
export function zbeGuard(G, live, from, to, opts, now) {
  const zones = live.zbe?.zones || [];
  if (!zones.length || !opts.sticker || opts.avoidZbe === false) return null;
  const banned = zones.map((z) => z.restricted.includes(opts.sticker) && zoneActive(z, new Date(now)));
  if (!banned.some(Boolean)) return null;
  const zon = zoneOfNode(G, zones, live.zbe?.updated || live.version);
  const isBanned = (i) => zon[i] >= 0 && banned[zon[i]];
  const S = nearest(G, from[0], from[1]), T = nearest(G, to[0], to[1]);
  const startZone = isBanned(S.i) ? zon[S.i] : -1;
  const out = {
    zoneName: (i) => (zon[i] >= 0 ? zones[zon[i]].name : ''),
    // Primer nodo de la ruta dentro de una ZBE prohibida distinta de la de salida.
    firstBannedIndex: (path) => {
      if (!path) return -1;
      for (let k = 1; k < path.length; k++) if (isBanned(path[k]) && zon[path[k]] !== startZone) return k;
      return -1;
    },
  };
  if (isBanned(T.i) && zon[T.i] !== startZone) {
    // Destino dentro: el punto más cercano FUERA de la zona al que se puede llegar SIN entrar en ella
    // (los polígonos tienen huecos a los que solo se llega cruzando la zona).
    const reach = new Uint8Array(G.la.length);
    const queue = new Int32Array(G.la.length);
    let qh = 0, qt = 0;
    reach[S.i] = 1;
    queue[qt++] = S.i;
    while (qh < qt) {
      const u = queue[qh++];
      for (let e = G.off[u]; e < G.off[u + 1]; e++) {
        const v = G.tgt[e];
        if (reach[v] || (isBanned(v) && zon[v] !== startZone)) continue;
        reach[v] = 1;
        queue[qt++] = v;
      }
    }
    let best = -1, bd = Infinity;
    for (let i = 0; i < G.la.length; i++) {
      if (!reach[i] || isBanned(i)) continue;
      const d = (G.la[i] - to[0]) ** 2 + ((G.lo[i] - to[1]) * Math.cos((to[0] * Math.PI) / 180)) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      out.to = [G.la[best], G.lo[best]];
      const metres = Math.round(Math.sqrt(bd) * 111320);
      out.retarget = { name: zones[zon[T.i]].name, reason: 'destino-dentro', metres, url: zones[zon[T.i]].url };
    }
  }
  return out;
}

// ------------------------------------------------------------------ rutas con conexión (sin grafo)
// Las rutas online no tienen nodos: la ZBE de cada punto se mira directamente en los polígonos.
let zoneBoxes = null, zoneBoxesKey = null;
function boxesOf(zones, key) {
  if (zoneBoxesKey !== key) {
    zoneBoxes = zones.map((z) => z.polys.map((ring) => {
      let s = 90, n = -90, w = 180, e = -180;
      for (const [x, y] of ring) { if (y < s) s = y; if (y > n) n = y; if (x < w) w = x; if (x > e) e = x; }
      return { s, n, w, e };
    }));
    zoneBoxesKey = key;
  }
  return zoneBoxes;
}

/** Índice de la ZBE que contiene un punto (-1 si ninguna); si se solapan, la más restrictiva. */
export function zoneAt(live, lat, lon) {
  const zones = live.zbe?.zones || [];
  const boxes = boxesOf(zones, live.zbe?.updated || live.version);
  let best = -1;
  for (let z = 0; z < zones.length; z++) {
    const polys = zones[z].polys;
    for (let k = 0; k < polys.length; k++) {
      const b = boxes[z][k];
      if (lat < b.s || lat > b.n || lon < b.w || lon > b.e) continue;
      if (inRing(lon, lat, polys[k])) {
        if (best < 0 || zones[z].restricted.length > zones[best].restricted.length) best = z;
        break;
      }
    }
  }
  return best;
}

/** Zona de cada punto de la ruta (las rutas online tienen puntos cada pocos metros en ciudad). */
export function zonesAlong(route, live) {
  if (!live.zbe?.zones?.length) return null;
  return route.coords.map(([lo, la]) => zoneAt(live, la, lo));
}

/** Igual que zbeOnRoute, pero a partir de la zona de cada punto. */
export function zbeOnCoords(route, zon, live, opts) {
  const zones = live.zbe?.zones || [];
  if (!zon) return [];
  const runs = [];
  for (let i = 0; i < zon.length; i++) {
    const z = zon[i];
    const last = runs[runs.length - 1];
    if (z < 0) { if (last && last.open) last.open = false; continue; }
    if (last && last.open && last.z === z) { last.end = route.cum[i]; continue; }
    const zone = zones[z];
    const active = zoneActive(zone, new Date(opts.now));
    runs.push({
      z, open: true, start: route.cum[i], end: route.cum[i], name: zone.name, url: zone.url,
      restricted: zone.restricted, days: zone.days, times: zone.times,
      banned: !!opts.sticker && zone.restricted.includes(opts.sticker) && active, active,
    });
  }
  return runs.map(({ open, z, ...r }) => r);
}

/** ZBE donde tu etiqueta no puede entrar ahora (índices). */
export function bannedZones(live, opts) {
  const zones = live.zbe?.zones || [];
  if (!zones.length || !opts.sticker || opts.avoidZbe === false) return null;
  const b = zones.map((z) => z.restricted.includes(opts.sticker) && zoneActive(z, new Date(opts.now)));
  return b.some(Boolean) ? b : null;
}

/** Cortes totales de la DGT (y calzadas inundadas) por los que pasa una ruta: [lat, lon] de cada uno. */
export function closuresOnRoute(route, live) {
  return incidentsOnRoute(route, live)
    .filter((x) => x.k === 'cortada' || x.k === 'inundacion')
    .map((x) => {
      // Punto de la ruta a la altura del corte: ahí se pide a Valhalla que no pase.
      let j = 0;
      while (j < route.cum.length - 1 && route.cum[j + 1] < x.along) j++;
      const [lo, la] = route.coords[Math.min(j + 1, route.coords.length - 1)];
      return [la, lo];
    });
}
