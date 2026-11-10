// Tráfico en directo: retenciones de la DGT (carreteras) y el estado del tráfico de Madrid (sensores) y
// Barcelona (tramos). Se cruza con una ruta para saber qué trozos van lentos ahora mismo y cuánto
// tiempo más cuesta, y con el grafo para que las rutas sin conexión eviten los atascos fuertes.
import { bearing } from './geo.js';

const M = 111320;
// Cuántas veces más se tarda según el nivel: 1 denso/lento, 2 muy denso/retención, 3 congestión/parado.
export const LIVE_FACTOR = { 1: 1.4, 2: 2.5, 3: 4 };
const POINT_SPAN = 120;   // un sensor representa ~120 m a cada lado
const MATCH_D = 35;       // a qué distancia de la ruta tiene que estar un dato para contar

const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/** Todos los datos de tráfico en directo como lista común: { p: [[lat, lon], …], l: 1..3, b?: rumbo }. */
export function liveTrafficItems(live) {
  const out = [];
  for (const it of live.inc?.items || []) {
    if (it.k !== 'retencion') continue;
    out.push({ p: it.to ? [it.from, it.to] : [it.from], l: it.lvl || 1, dgt: true });
  }
  for (const it of live.traf?.items || []) out.push(it);
  return out;
}

// Proyección de un punto sobre la ruta: distancia, metros desde la salida y segmento.
function project(coords, cum, lat, lon, maxD, from = 0, to = coords.length - 1) {
  const kx = Math.cos((lat * Math.PI) / 180) * M;
  let best = Infinity, along = 0, seg = -1;
  for (let j = from; j < to; j++) {
    const ax = coords[j][0] * kx, ay = coords[j][1] * M;
    const dx = coords[j + 1][0] * kx - ax, dy = coords[j + 1][1] * M - ay;
    const px = lon * kx - ax, py = lat * M - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
    const d = Math.hypot(px - t * dx, py - t * dy);
    if (d < best) { best = d; along = cum[j] + t * (cum[j + 1] - cum[j]); seg = j; }
  }
  return best <= maxD ? { d: best, along, seg } : null;
}

function boxOf(coords, pad) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lo, la] of coords) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  return { s: s - pad, n: n + pad, w: w - pad, e: e + pad };
}

/**
 * Qué tramos de la ruta van lentos ahora. Devuelve { ranges: [{start, end, l}], f: factor por segmento }
 * o null si no hay nada.
 */
export function liveOnRoute(route, items) {
  const { coords, cum } = route;
  if (!coords?.length || !items.length) return null;
  const box = boxOf(coords, 0.004);
  const ranges = [];
  const dirAt = (seg) => bearing(coords[seg][1], coords[seg][0], coords[seg + 1][1], coords[seg + 1][0]);
  for (const it of items) {
    const a = it.p[0], z = it.p[it.p.length - 1];
    if (!it.p.some((q) => q[0] >= box.s && q[0] <= box.n && q[1] >= box.w && q[1] <= box.e)) continue;
    if (it.p.length === 1) {
      const h = project(coords, cum, a[0], a[1], MATCH_D);
      if (!h) continue;
      // Si el sensor dice su sentido, tiene que coincidir con el de la ruta.
      if (it.b != null && angle(dirAt(h.seg), it.b) > 60) continue;
      const span = it.dgt ? 400 : POINT_SPAN;
      ranges.push({ start: Math.max(0, h.along - span), end: h.along + span, l: it.l });
    } else {
      const h1 = project(coords, cum, a[0], a[1], it.dgt ? 60 : MATCH_D);
      const h2 = h1 && project(coords, cum, z[0], z[1], it.dgt ? 60 : MATCH_D);
      // Los tramos tienen sentido: el principio tiene que quedar antes que el final.
      if (!h1 || !h2 || h2.along <= h1.along) continue;
      if (h2.along - h1.along > 30000) continue; // tramos larguísimos: poco fiables
      ranges.push({ start: h1.along, end: h2.along, l: it.l });
    }
  }
  if (!ranges.length) return null;
  const f = new Array(coords.length - 1).fill(1);
  for (const r of ranges) {
    for (let i = 0; i < f.length; i++) {
      const mid = (cum[i] + cum[i + 1]) / 2;
      if (mid >= r.start && mid <= r.end) f[i] = Math.max(f[i], LIVE_FACTOR[r.l] || 1);
    }
  }
  return { ranges, f };
}

/**
 * Suma el tráfico en directo a una ruta ya calculada: duración, retraso, color de cada tramo y un
 * resumen para la ficha. Lo que ya cuenta el tráfico típico de la hora no se cuenta dos veces.
 */
export function applyLiveTraffic(r, live) {
  if (!r?.coords) return r;
  const hit = liveOnRoute(r, liveTrafficItems(live));
  if (!hit) return r;
  const typical = r.traffic?.seg; // factor del tráfico típico por segmento (rutas sin conexión)
  const baseDur = r.duration - (r.traffic?.delay || 0); // con vía libre
  const v = r.distance / (baseDur || 1); // velocidad media con vía libre
  let extra = 0, slowLen = 0, worst = 0;
  const seg = new Array(hit.f.length);
  for (let i = 0; i < hit.f.length; i++) {
    const t = typical?.[i] || 1, lf = hit.f[i];
    seg[i] = Math.max(t, lf);
    if (lf > t) {
      const len = r.cum[i + 1] - r.cum[i];
      extra += (len / v) * (lf - t);
      slowLen += len;
    }
  }
  for (const x of hit.ranges) worst = Math.max(worst, x.l);
  r.duration += extra;
  r.traffic = { ...(r.traffic || { label: '', delay: 0 }), seg, delay: (r.traffic?.delay || 0) + extra };
  r.liveTraffic = { delay: extra, len: slowLen, worst, n: hit.ranges.length, updated: live.traf?.updated || live.inc?.updated || null };
  return r;
}

/** Multiplicador por arista del grafo para los atascos fuertes (nivel 2 y 3), para rutas sin conexión. */
export function liveEdgePenalty(G, items, near, ensure) {
  for (const it of items) {
    if (it.l < 2) continue;
    const pts = it.p;
    const mult = LIVE_FACTOR[it.l];
    const segs = pts.length === 1 ? [[pts[0], pts[0]]] : pts.slice(1).map((q, i) => [pts[i], q]);
    for (const [a, b] of segs) {
      const midLa = (a[0] + b[0]) / 2, midLo = (a[1] + b[1]) / 2;
      const half = Math.hypot((a[0] - b[0]) * M, (a[1] - b[1]) * M * Math.cos((midLa * Math.PI) / 180)) / 2;
      if (half > 15000) continue;
      const span = pts.length === 1 ? (it.dgt ? 400 : POINT_SPAN) : 0;
      near(midLa, midLo, half + span + 80, (u) => {
        for (let e = G.off[u]; e < G.off[u + 1]; e++) {
          const w = G.tgt[e];
          const mla = (G.la[u] + G.la[w]) / 2, mlo = (G.lo[u] + G.lo[w]) / 2;
          const kx = Math.cos((mla * Math.PI) / 180) * M;
          // distancia del centro de la arista al tramo con atasco
          const ax = a[1] * kx, ay = a[0] * M, dx = b[1] * kx - ax, dy = b[0] * M - ay;
          const px = mlo * kx - ax, py = mla * M - ay, len2 = dx * dx + dy * dy || 1e-9;
          const t = Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
          const d = Math.hypot(px - t * dx, py - t * dy);
          if (d > (span ? 60 : 25)) continue;
          // mismo sentido que el atasco (o que el sensor)
          const eb = bearing(G.la[u], G.lo[u], G.la[w], G.lo[w]);
          const ib = it.b != null ? it.b : pts.length > 1 ? bearing(a[0], a[1], b[0], b[1]) : null;
          if (ib != null && angle(eb, ib) > 60) continue;
          const pen = ensure();
          pen[e] = Math.max(pen[e], mult);
        }
      });
    }
  }
}
