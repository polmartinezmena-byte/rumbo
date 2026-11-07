// Búsqueda, puntos de emergencia y cálculo de rutas (A*) sobre un grafo de graph-build.js.
// Código puro: se ejecuta en el worker y también en los tests de Node.
import { fastDist, bearing, norm } from './geo.js';
import { EMERGENCY } from './graph-build.js';
import { camerasOnRoute } from './radars.js';

const ORD = ['primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta', 'séptima', 'octava'];
const CARD = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];

// Modo "ruta segura" por nivel de lluvia: 0 normal · 1 lluvia fuerte · 2 lluvia muy fuerte/torrencial.
// coste = tiempo · (1 + K·riesgo²) · (tramo duro ? HARD : 1). Los tramos duros son badenes y pasos
// subterráneos: con nivel 2 se evitan del todo salvo que no exista otra forma de llegar.
const K = [0, 3, 12];
const HARD = [1, 30, Infinity];
// A partir de aquí un tramo cuenta como «zona de riesgo» (avisos y textos): zonas oficiales del SNCZI,
// badenes, pasos inferiores y vías flood_prone. Las estimaciones propias (≤ 0,55) solo encarecen la ruta.
const RISKY = 0.58;
const TOLL_PENALTY = 20; // "sin peaje": solo se usa una autopista de pago si no hay alternativa razonable

export function search(G, q, near) {
  const tokens = norm(q).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const hits = [];
  for (let i = 0; i < G.sNorm.length; i++) {
    const s = G.sNorm[i];
    if (!tokens.every((t) => s.includes(t))) continue;
    let score = near ? fastDist(near[0], near[1], G.sLa[i], G.sLo[i]) / 1000 : 0;
    if (s.startsWith(tokens[0])) score -= 3;
    if (s === tokens.join(' ')) score -= 5;
    hits.push([score, i]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits.slice(0, 12).map(([, i]) => ({ name: G.sName[i], kind: G.sKind[i], lat: G.sLa[i], lon: G.sLo[i] }));
}

export function nearby(G, near, cat) {
  const out = [];
  for (let i = 0; i < G.eKind.length; i++) {
    if (cat && G.eKind[i] !== cat) continue;
    out.push({
      kind: G.eKind[i], label: EMERGENCY[G.eKind[i]], name: G.eName[i], phone: G.ePhone[i],
      lat: G.eLa[i], lon: G.eLo[i],
      dist: fastDist(near[0], near[1], G.eLa[i], G.eLo[i]),
      bearing: bearing(near[0], near[1], G.eLa[i], G.eLo[i]),
    });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, 30);
}

export function nearest(G, lat, lon) {
  let best = -1, bd = Infinity;
  const { la, lo, snap } = G;
  for (let i = 0; i < la.length; i++) {
    if (!snap[i]) continue;
    const d = fastDist(lat, lon, la[i], lo[i]);
    if (d < bd) { bd = d; best = i; }
  }
  return { i: best, d: bd };
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

const WALK = 1.3; // m/s a pie

// Grafo inverso (para ir a pie también contra dirección). Se calcula una vez y queda en memoria.
function reverse(G) {
  if (G._rev) return G._rev;
  const n = G.la.length, m = G.tgt.length;
  const roff = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) roff[G.tgt[e] + 1]++;
  for (let i = 0; i < n; i++) roff[i + 1] += roff[i];
  const pos = roff.slice(0, n), rsrc = new Int32Array(m), redge = new Int32Array(m);
  for (let u = 0; u < n; u++) for (let e = G.off[u]; e < G.off[u + 1]; e++) { const p = pos[G.tgt[e]]++; rsrc[p] = u; redge[p] = e; }
  G._rev = { roff, rsrc, redge };
  return G._rev;
}

function astar(G, s, t, level, hardPenalty, avoidTolls = false, pen = null, foot = false) {
  const { la, lo, off, tgt, wt, risk, hard, toll } = G;
  const tollOn = avoidTolls && toll && !foot;
  const rev = foot ? reverse(G) : null;
  const n = la.length;
  const g = new Float64Array(n).fill(Infinity);
  const prevN = new Int32Array(n).fill(-1);
  const prevE = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const inv = 1 / (foot ? WALK : G.maxMs);
  const k = K[level] || 0;
  const hasRisk = level > 0 && risk;
  const tla = la[t], tlo = lo[t];
  const heap = new Heap();
  g[s] = 0;
  heap.push(fastDist(la[s], lo[s], tla, tlo) * inv, s);
  while (heap.size) {
    const u = heap.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === t) break;
    // A pie: también se puede recorrer un tramo en sentido contrario (aristas del grafo inverso).
    const nOut = off[u + 1] - off[u];
    const nIn = foot ? rev.roff[u + 1] - rev.roff[u] : 0;
    for (let q = 0; q < nOut + nIn; q++) {
      const e = q < nOut ? off[u] + q : rev.redge[rev.roff[u] + q - nOut];
      const v = q < nOut ? tgt[e] : rev.rsrc[rev.roff[u] + q - nOut];
      if (closed[v]) continue;
      if (foot && G.lim && G.lim[e] >= 90) continue; // autopistas y autovías: no se camina
      let c = foot ? G.dist[e] / WALK : wt[e];
      if (pen && !foot) c *= pen[e];
      if (hasRisk) {
        const r = risk[e] / 255;
        c *= 1 + k * r * r;
        if (hard[e]) c *= hardPenalty;
      }
      if (tollOn && toll[e]) c *= TOLL_PENALTY;
      const ng = g[u] + c;
      if (ng < g[v]) {
        g[v] = ng; prevN[v] = u; prevE[v] = e;
        heap.push(ng + fastDist(la[v], lo[v], tla, tlo) * inv, v);
      }
    }
  }
  if (g[t] === Infinity) return null;
  const path = [], edges = [];
  for (let v = t; v !== s; v = prevN[v]) { path.push(v); edges.push(prevE[v]); }
  path.push(s);
  return { path: path.reverse(), edges: edges.reverse() };
}

export function route(G, from, to, level = 0, { avoidTolls = false, pen = null, foot = false } = {}) {
  const S = nearest(G, from[0], from[1]);
  const T = nearest(G, to[0], to[1]);
  if (S.d > 1500) throw new Error('El punto de salida está fuera de la zona descargada');
  if (T.d > 1500) throw new Error('El destino está fuera de la zona descargada');
  if (S.i === T.i) throw new Error('El origen y el destino están en el mismo punto');
  if (level > 0 && !G.risk) level = 0; // zona descargada con una versión antigua

  if (foot) level = 0;
  let res = astar(G, S.i, T.i, level, HARD[level], avoidTolls, pen, foot);
  let forcedHard = false;
  if (!res && level === 2) { res = astar(G, S.i, T.i, level, 200, avoidTolls, pen, foot); forcedHard = true; }
  if (!res) throw new Error('No hay ninguna ruta posible entre esos dos puntos');
  const out = describe(G, res.path, res.edges, foot);
  out.path = res.path;
  out.foot = foot;
  if (pen) out.penalized = res.edges.some((e) => pen[e] >= 100);
  out.level = level;
  out.forcedHard = forcedHard;
  out.avoidTolls = avoidTolls;
  Object.assign(out, camerasOnRoute(G, out));
  return out;
}

function describe(G, path, edges, foot = false) {
  const { lo, la, wt, risk, hard } = G;
  const { steps, cum } = buildSteps(G, path, edges, foot);
  let duration = 0, tollLen = 0;
  const segRisk = new Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    duration += foot ? G.dist[edges[i]] / WALK : wt[edges[i]];
    if (G.toll?.[edges[i]]) tollLen += G.dist[edges[i]];
    segRisk[i] = risk ? (hard[edges[i]] ? 1 : Math.round((risk[edges[i]] / 255) * 100) / 100) : 0;
  }
  // Tramos seguidos con riesgo alto → "zonas" (se unen si los separan menos de 40 m).
  const runs = [];
  for (let i = 0; i < edges.length; i++) {
    if (segRisk[i] < RISKY) continue;
    const start = cum[i], end = cum[i + 1];
    const isHard = risk ? hard[edges[i]] === 1 : false;
    const last = runs[runs.length - 1];
    if (last && start - last.end < 40) {
      last.end = end; last.max = Math.max(last.max, segRisk[i]); last.hard ||= isHard;
    } else runs.push({ start, end, max: segRisk[i], hard: isHard });
  }
  const riskLen = runs.reduce((s, x) => s + (x.end - x.start), 0);
  return {
    riskLen,
    tollLen,
    lim: G.lim ? edges.map((e) => G.lim[e]) : [],
    limInf: G.limInf ? edges.map((e) => G.limInf[e]) : [],
    coords: path.map((i) => [lo[i], la[i]]),
    cum: Array.from(cum),
    risk: segRisk,
    riskRuns: runs,
    steps,
    distance: cum[cum.length - 1],
    duration,
  };
}

function turnText(a) {
  const side = a > 0 ? 'derecha' : 'izquierda';
  const x = Math.abs(a);
  if (x < 25) return { mod: 'straight', angle: 0, txt: 'Continúa recto' };
  if (x < 60) return { mod: 'slight', angle: a > 0 ? 45 : -45, txt: `Gira ligeramente a la ${side}` };
  if (x < 140) return { mod: 'turn', angle: a > 0 ? 90 : -90, txt: `Gira a la ${side}` };
  return { mod: 'sharp', angle: a > 0 ? 135 : -135, txt: `Gira bruscamente a la ${side}` };
}

function buildSteps(G, path, edges, foot = false) {
  const { la, lo, nm, names, off, dist } = G;
  // A pie las rotondas no se anuncian como tales.
  const rb = foot ? new Uint8Array(G.rb.length) : G.rb;
  const L = path.length;
  const cum = new Float64Array(L);
  for (let i = 1; i < L; i++) cum[i] = cum[i - 1] + dist[edges[i - 1]];
  const nameAt = (i) => (nm[edges[i]] >= 0 ? names[nm[edges[i]]] : '');
  const back = (i, m) => { let k = i; while (k > 0 && cum[i] - cum[k] < m) k--; return path[k]; };
  const fwd = (i, m) => { let k = i; while (k < L - 1 && cum[k] - cum[i] < m) k++; return path[k]; };
  const turnAt = (i) => {
    const a = back(i, 20), j = path[i], b = fwd(i, 20);
    const b1 = bearing(la[a], lo[a], la[j], lo[j]);
    const b2 = bearing(la[j], lo[j], la[b], lo[b]);
    return ((b2 - b1 + 540) % 360) - 180;
  };

  const steps = [];
  const n0 = nameAt(0);
  const f0 = fwd(0, 30);
  const dep = bearing(la[path[0]], lo[path[0]], la[f0], lo[f0]);
  steps.push({
    type: 'depart', mod: 'straight', angle: 0, name: n0, along: 0, i: 0,
    text: `Dirígete hacia el ${CARD[Math.round(dep / 45) % 8]}${n0 ? ` por ${n0}` : ''}`,
  });

  let skipUntil = -1;
  for (let i = 1; i < L - 1; i++) {
    if (i <= skipUntil) continue;
    const ePrev = edges[i - 1], e = edges[i];
    if (!rb[ePrev] && rb[e]) {
      let j = i;
      while (j < L - 1 && rb[edges[j]]) j++;
      let exits = 0;
      for (let k = i + 1; k <= j; k++) {
        const u = path[k];
        for (let x = off[u]; x < off[u + 1]; x++) if (!rb[x]) { exits++; break; }
      }
      exits = Math.max(1, exits);
      const out = j < L - 1 ? nameAt(j) : '';
      steps.push({
        type: 'roundabout', mod: 'roundabout', angle: 0, exit: exits, name: out, along: cum[i], i,
        text: `En la rotonda, toma la ${ORD[exits - 1] || exits + 'ª'} salida${out ? ` hacia ${out}` : ''}`,
      });
      skipUntil = j;
      continue;
    }
    if (rb[e]) continue;
    const prevName = nameAt(i - 1), curName = nameAt(i);
    const changed = curName !== prevName;
    const ang = turnAt(i);
    if (!changed && (curName || Math.abs(ang) <= 55)) continue;
    const t = turnText(ang);
    if (t.mod === 'straight' && !curName) continue;
    steps.push({
      type: 'turn', mod: t.mod, angle: t.angle, name: curName, along: cum[i], i,
      text: t.mod === 'straight' ? `Continúa por ${curName}` : `${t.txt}${curName ? ` por ${curName}` : ''}`,
    });
  }
  steps.push({ type: 'arrive', mod: 'arrive', angle: 0, name: '', along: cum[L - 1], i: L - 1, text: 'Has llegado a tu destino' });
  for (let k = 0; k < steps.length; k++) steps[k].dist = (steps[k + 1]?.along ?? cum[L - 1]) - steps[k].along;
  return { steps, cum };
}

/** Capa GeoJSON de tramos con riesgo (para dibujar en el mapa), agrupada en 3 niveles. */
export function riskLayer(G, bbox) {
  if (!G.risk) return { type: 'FeatureCollection', features: [] };
  const { la, lo, off, tgt, risk, hard } = G;
  const buckets = { medio: [], alto: [], paso: [] };
  const n = la.length;
  let count = 0;
  for (let u = 0; u < n && count < 60000; u++) {
    if (bbox && (la[u] < bbox.s || la[u] > bbox.n || lo[u] < bbox.w || lo[u] > bbox.e)) continue;
    for (let e = off[u]; e < off[u + 1]; e++) {
      const v = tgt[e];
      if (v < u) {
        // Evita duplicar calles de doble sentido: solo si no existe la arista inversa.
        let rev = false;
        for (let x = off[v]; x < off[v + 1]; x++) if (tgt[x] === u) { rev = true; break; }
        if (rev) continue;
      }
      const r = risk[e] / 255;
      const b = hard[e] ? 'paso' : r >= 0.7 ? 'alto' : r >= 0.4 ? 'medio' : null;
      if (b) { buckets[b].push([[lo[u], la[u]], [lo[v], la[v]]]); count++; }
    }
  }
  return {
    type: 'FeatureCollection',
    features: Object.entries(buckets).filter(([, c]) => c.length).map(([level, coordinates]) => ({
      type: 'Feature', properties: { level }, geometry: { type: 'MultiLineString', coordinates },
    })),
  };
}

export function stats(G) {
  return {
    bbox: G.bbox, date: G.date, nodes: G.la.length, edges: G.tgt.length,
    places: G.sName.length, emergency: G.eKind.length,
    flood: !!G.risk, dem: !!G.dem, waterways: G.waterways || 0,
    region: G.region || null, name: G.name || null,
  };
}
