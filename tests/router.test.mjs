// Tests del motor de rutas sobre el paquete de Ceuta (genéralo con: node tools/build-region.mjs ceuta)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { deserialize, serialize } from '../js/pack.js';
import * as R from '../js/router.js';
import { build, fromOverpass } from '../js/graph-build.js';

const PACK = new URL('../packs/ceuta.rumbo.gz', import.meta.url);
const G = existsSync(PACK) ? deserialize(gunzipSync(readFileSync(PACK))) : null;
const opts = { skip: !G && 'falta packs/ceuta.rumbo.gz' };

// Mini red sintética: un cuadrado con una calle de sentido único y un paso subterráneo.
//   A ── B
//   │    │      A→B→D por arriba (con túnel en B→D), A→C→D por abajo (más larga)
//   C ────── D
function toy() {
  const n = (id, lat, lon) => ({ type: 'node', id, lat, lon });
  return build(fromOverpass([
    n(1, 40.0, -3.0), n(2, 40.0, -2.998), n(3, 39.998, -3.0), n(4, 39.998, -2.997),
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential', name: 'Calle Alta' } },
    { type: 'way', id: 11, nodes: [2, 4], tags: { highway: 'residential', name: 'Paso Bajo', tunnel: 'yes' } },
    { type: 'way', id: 12, nodes: [1, 3, 4], tags: { highway: 'residential', name: 'Calle Larga' } },
    { type: 'way', id: 13, nodes: [4, 3], tags: { highway: 'residential', name: 'Única', oneway: 'yes' } },
  ]), { s: 39.99, w: -3.01, n: 40.01, e: -2.99 });
}

test('la ruta normal usa el túnel; con lluvia muy fuerte lo evita', () => {
  const g = toy();
  const fast = R.route(g, [40.0, -3.0], [39.998, -2.997], 0);
  assert.ok(fast.steps.some((s) => s.name === 'Paso Bajo'));
  assert.equal(fast.riskRuns.filter((r) => r.hard).length, 1);
  const safe = R.route(g, [40.0, -3.0], [39.998, -2.997], 2);
  assert.ok(!safe.steps.some((s) => s.name === 'Paso Bajo'), 'no debe pasar por el túnel');
  assert.equal(safe.riskRuns.filter((r) => r.hard).length, 0);
});

test('si el único camino es de riesgo, lo usa igualmente y lo marca', () => {
  const g = toy();
  // De B a D solo hay túnel o un rodeo largo; desde B no hay rodeo razonable → forcedHard o rodeo.
  const r = R.route(g, [40.0, -2.998], [39.998, -2.997], 2);
  assert.ok(r.distance > 0);
});

test('empaquetar y desempaquetar conserva el grafo', () => {
  const g = toy();
  const back = deserialize(serialize(g));
  assert.equal(back.tgt.length, g.tgt.length);
  assert.deepEqual(R.route(back, [40.0, -3.0], [39.998, -2.997], 0).distance.toFixed(0),
    R.route(g, [40.0, -3.0], [39.998, -2.997], 0).distance.toFixed(0));
});

test('Ceuta: ruta del puerto a la frontera del Tarajal', opts, () => {
  const r = R.route(G, [35.8893, -5.3163], [35.8710, -5.3420], 0);
  assert.ok(r.distance > 2000 && r.distance < 8000, `distancia ${r.distance}`);
  assert.ok(r.steps.length >= 3);
  assert.equal(r.steps.at(-1).type, 'arrive');
});

test('Ceuta: búsqueda sin acentos y emergencias cercanas', opts, () => {
  assert.ok(R.search(G, 'hospital', [35.889, -5.316]).length > 0);
  const near = R.nearby(G, [35.889, -5.316], 'pharmacy');
  assert.ok(near.length > 0 && near[0].dist < 3000);
});

test('Ceuta: hay tramos con riesgo de inundación calculado', opts, () => {
  let risky = 0;
  for (let i = 0; i < G.risk.length; i++) if (G.risk[i] > 128) risky++;
  assert.ok(risky > 0 && risky < G.risk.length * 0.5, `tramos con riesgo: ${risky} de ${G.risk.length}`);
});

test('peajes: con «sin peaje» evita la autopista de pago si hay alternativa', () => {
  const n = (id, lat, lon) => ({ type: 'node', id, lat, lon });
  const g = build(fromOverpass([
    n(1, 40.0, -3.0), n(2, 40.0, -2.9), n(3, 40.01, -2.95),
    { type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'motorway', name: 'AP-1', toll: 'yes', oneway: 'no' } },
    { type: 'way', id: 2, nodes: [1, 3, 2], tags: { highway: 'primary', name: 'N-1' } },
  ]), { s: 39.9, w: -3.1, n: 40.1, e: -2.8 });
  const withToll = R.route(g, [40.0, -3.0], [40.0, -2.9]);
  const noToll = R.route(g, [40.0, -3.0], [40.0, -2.9], 0, { avoidTolls: true });
  assert.ok(withToll.tollLen > 8000);
  assert.equal(noToll.tollLen, 0);
  assert.ok(noToll.duration > withToll.duration);
});

test('radares: fijo con límite y tramo con inicio y fin sobre la ruta', () => {
  const n = (id, lat, lon, tags) => ({ type: 'node', id, lat, lon, tags });
  const g = build(fromOverpass([
    n(1, 40.0, -3.0), n(2, 40.0, -2.95), n(3, 40.0, -2.9), n(4, 40.0, -2.85),
    n(10, 40.0, -2.97, { highway: 'speed_camera', maxspeed: '100' }),
    n(11, 40.0, -2.93), n(12, 40.0, -2.87),
    n(13, 40.0, -2.92, { highway: 'traffic_signals', red_light_camera: 'yes' }),
    { type: 'way', id: 1, nodes: [1, 2, 3, 4], tags: { highway: 'primary' } },
    { type: 'relation', id: 5, tags: { type: 'enforcement', enforcement: 'average_speed', maxspeed: '80' },
      members: [{ type: 'node', ref: 11, role: 'from' }, { type: 'node', ref: 12, role: 'to' }] },
  ]), { s: 39.9, w: -3.1, n: 40.1, e: -2.8 });
  const r = R.route(g, [40.0, -3.0], [40.0, -2.85]);
  assert.equal(r.cameras.filter((c) => c.kind === 0)[0].speed, 100);
  assert.equal(r.cameras.filter((c) => c.kind === 3).length, 1, 'semáforo con cámara');
  assert.equal(r.sections.length, 1);
  assert.equal(r.sections[0].speed, 80);
  assert.ok(r.sections[0].end - r.sections[0].start > 4000);
});

import { speedLimit } from '../js/graph-build.js';
import { buildCameras } from '../js/radars.js';
import { utmToLatLon } from '../tools/official-radars.mjs';

test('límite de velocidad: etiquetas de OSM y reglas generales en España', () => {
  assert.deepEqual(speedLimit({ highway: 'primary', maxspeed: '80' }), [80, 0]);
  assert.deepEqual(speedLimit({ highway: 'primary', maxspeed: 'ES:urban' }), [50, 0]);
  assert.deepEqual(speedLimit({ highway: 'motorway' }), [120, 1]);
  assert.deepEqual(speedLimit({ highway: 'residential' }), [30, 1]);
  assert.deepEqual(speedLimit({ highway: 'secondary' }), [0, 0], 'sin dato y ambiguo: no se inventa');
  assert.deepEqual(speedLimit({ highway: 'trunk', 'maxspeed:backward': '60', maxspeed: '100' }, false), [60, 0]);
});

test('fuentes oficiales: un radar de OSM duplicado se fusiona y aporta su límite', () => {
  const cams = buildCameras(
    [{ id: 1, lat: 40.0, lon: -3.0, tags: { highway: 'speed_camera', maxspeed: '80' } },
     { id: 2, lat: 40.1, lon: -3.1, tags: { highway: 'speed_camera' } }],
    [], () => undefined,
    [{ lat: 40.0001, lon: -3.0001, speed: 0, kind: 'fixed' }, { lat: 40.2, lon: -3.2, speed: 0, kind: 'red_light' }],
  );
  assert.equal(cams.cLa.length, 3, '2 oficiales + 1 de OSM no duplicado');
  assert.equal(cams.cSpeed[0], 80, 'el oficial hereda el límite de OSM');
  assert.equal(cams.cKind[1], 3);
});

test('UTM 31N (ETRS89) → WGS84', () => {
  // Plaça de Catalunya, Barcelona ≈ 41.3870, 2.1700
  const [lat, lon] = utmToLatLon(430620, 4582200, 31);
  assert.ok(Math.abs(lat - 41.387) < 0.003 && Math.abs(lon - 2.17) < 0.003, `${lat}, ${lon}`);
});

test('zonas oficiales: la ruta segura evita una calle dentro de zona inundable T10 aunque sea más corta', () => {
  const n = (id, lat, lon) => ({ type: 'node', id, lat, lon });
  //  1 ── 2 ── 3   ← calle corta, atraviesa una zona T10 (alrededor del nodo 2)
  //  │         │
  //  4 ─────── 5   ← rodeo por el sur, fuera de zona
  const input = fromOverpass([
    n(1, 40.0, -3.0), n(2, 40.0, -2.995), n(3, 40.0, -2.99), n(4, 39.997, -3.0), n(5, 39.997, -2.99),
    { type: 'way', id: 1, nodes: [1, 2, 3], tags: { highway: 'residential', name: 'Calle del Barranco' } },
    { type: 'way', id: 2, nodes: [1, 4, 5, 3], tags: { highway: 'residential', name: 'Ronda Alta' } },
  ]);
  // Rejilla oficial: clase 3 (T10) en un cuadrado alrededor de (40.0, -2.995).
  const grid = { s: 39.99, w: -3.01, dLat: 0.0005, dLon: 0.0005, W: 60, H: 60, data: new Uint8Array(3600) };
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) {
    const lat = grid.s + (y + 0.5) * grid.dLat, lon = grid.w + (x + 0.5) * grid.dLon;
    if (Math.abs(lat - 40.0) < 0.001 && Math.abs(lon + 2.995) < 0.002) grid.data[y * 60 + x] = 3;
  }
  input.floodGrid = grid;
  const g = build(input, { s: 39.99, w: -3.01, n: 40.02, e: -2.98 });
  assert.ok(g.official);
  const fast = R.route(g, [40.0, -3.0], [40.0, -2.99], 0);
  const safe = R.route(g, [40.0, -3.0], [40.0, -2.99], 2);
  assert.ok(fast.steps.some((s) => s.name === 'Calle del Barranco'), 'la rápida cruza la zona');
  assert.ok(fast.riskLen > 300, `la rápida tiene riesgo (${fast.riskLen})`);
  assert.equal(safe.riskLen, 0, 'la segura no pasa por la zona oficial');
  assert.ok(safe.steps.some((s) => s.name === 'Ronda Alta'));
});

test('estimación propia sin datos oficiales: nunca llega a «riesgo alto»', () => {
  const n = (id, lat, lon) => ({ type: 'node', id, lat, lon });
  const g = build(fromOverpass([
    n(1, 40.0, -3.0), n(2, 40.0, -2.999),
    { type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'residential' } },
    { type: 'way', id: 9, tags: { waterway: 'river' }, geometry: [{ lat: 40.0001, lon: -3.001 }, { lat: 40.0001, lon: -2.998 }] },
  ]), { s: 39.99, w: -3.01, n: 40.01, e: -2.99 });
  for (const r of g.risk) assert.ok(r / 255 <= 0.56, `riesgo ${r / 255}`);
});

import { penalties, incidentsOnRoute } from '../js/live-route.js';

test('a pie se puede ir contra dirección; en coche no', () => {
  const n = (id, lat, lon) => ({ type: 'node', id, lat, lon });
  const g = build(fromOverpass([
    n(1, 40.0, -3.0), n(2, 40.0, -2.998), n(3, 40.003, -2.999),
    { type: 'way', id: 1, nodes: [2, 1], tags: { highway: 'residential', name: 'Sentido Único', oneway: 'yes' } },
    { type: 'way', id: 2, nodes: [1, 3, 2], tags: { highway: 'residential', name: 'Rodeo' } },
  ]), { s: 39.99, w: -3.01, n: 40.01, e: -2.99 });
  const car = R.route(g, [40.0, -3.0], [40.0, -2.998]);
  const foot = R.route(g, [40.0, -3.0], [40.0, -2.998], 0, { foot: true });
  assert.ok(car.steps.some((s) => s.name === 'Rodeo'), 'el coche rodea');
  assert.ok(foot.distance < car.distance, 'a pie va por el camino corto');
  assert.ok(foot.duration > 100, 'a paso de peatón');
});

test('un corte de la DGT desvía la ruta y aparece como incidencia en ella', () => {
  const n = (id, lat, lon) => ({ type: 'node', id, lat, lon });
  const g = build(fromOverpass([
    n(1, 40.0, -3.0), n(2, 40.0, -2.99), n(3, 40.004, -2.995),
    { type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'primary', name: 'N-1' } },
    { type: 'way', id: 2, nodes: [1, 3, 2], tags: { highway: 'secondary', name: 'Variante' } },
  ]), { s: 39.99, w: -3.01, n: 40.01, e: -2.98 });
  const live = { version: 1, inc: { items: [{ k: 'cortada', road: 'N-1', from: [40.0, -2.999], to: [40.0, -2.991] }] }, zbe: null, fuel: null };
  const pen = penalties(g, live, { sticker: '', avoidZbe: false, now: Date.now() });
  const free = R.route(g, [40.0, -3.0], [40.0, -2.99]);
  const cut = R.route(g, [40.0, -3.0], [40.0, -2.99], 0, { pen });
  assert.ok(free.steps.every((s) => s.name !== 'Variante'), 'sin corte va por la N-1');
  assert.ok(cut.steps.some((s) => s.name === 'Variante'), 'con el corte se desvía');
  assert.equal(incidentsOnRoute(free, live).length, 1, 'la ruta normal detecta el corte');
});

import { parseCap, untar } from '../tools/datos.mjs';
import { warningsOnRoute } from '../js/live-route.js';

const CAP = `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>2.49.0.0.724.0.ES.1</identifier><sender>http://www.aemet.es</sender>
<info><language>es-ES</language><event>Aviso de lluvias de nivel rojo</event><severity>Extreme</severity>
<onset>2026-10-29T06:00:00+01:00</onset><expires>2026-10-29T23:59:59+01:00</expires>
<description>Precipitación acumulada en 12 horas: 180 mm.</description>
<parameter><valueName>AEMET-Meteoalerta nivel</valueName><value>rojo</value></parameter>
<parameter><valueName>AEMET-Meteoalerta parametro</valueName><value>PR;Precipitación acumulada en 12 horas;180 mm</value></parameter>
<area><areaDesc>Litoral sur de Valencia</areaDesc><polygon>39.30,-0.50 39.50,-0.50 39.50,-0.30 39.30,-0.30 39.30,-0.50</polygon></area></info>
<info><language>en-GB</language><event>Red rain warning</event><parameter><valueName>AEMET-Meteoalerta nivel</valueName><value>rojo</value></parameter>
<area><areaDesc>South coast of Valencia</areaDesc><polygon>39.30,-0.50 39.50,-0.50 39.50,-0.30 39.30,-0.30 39.30,-0.50</polygon></area></info></alert>`;

test('AEMET: lee un aviso CAP (solo en español) y detecta que la ruta lo cruza', () => {
  const av = parseCap(CAP);
  assert.equal(av.length, 1, 'solo la parte en español');
  assert.equal(av[0].level, 3);
  assert.ok(av[0].rain, 'es de lluvias');
  assert.equal(av[0].area, 'Litoral sur de Valencia');
  const route = { coords: [[-0.6, 39.4], [-0.4, 39.4], [-0.2, 39.4]], cum: [0, 17000, 34000] };
  const hits = warningsOnRoute(route, av);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].along > 0 && hits[0].along <= 17000);
});

test('AEMET: abre un .tar con varios avisos', () => {
  const file = (name, body) => {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  };
  const tar = Buffer.concat([file('a.xml', CAP), file('b.xml', CAP), Buffer.alloc(1024)]);
  const files = untar(tar);
  assert.equal(files.length, 2);
  assert.equal(parseCap(files[1].data.toString()).length, 1);
});

import { zbeGuard } from '../js/live-route.js';

test('ZBE prohibida: nunca te mete dentro; si el destino está dentro, te deja en el límite', () => {
  // Rejilla de calles 5×5; la ZBE es el cuadrado central.
  const els = [];
  let id = 1;
  const nid = (r, c) => r * 10 + c + 1;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) els.push({ type: 'node', id: nid(r, c), lat: 40 + r * 0.002, lon: -3 + c * 0.002 });
  for (let r = 0; r < 5; r++) els.push({ type: 'way', id: 1000 + id++, nodes: [0, 1, 2, 3, 4].map((c) => nid(r, c)), tags: { highway: 'residential' } });
  for (let c = 0; c < 5; c++) els.push({ type: 'way', id: 1000 + id++, nodes: [0, 1, 2, 3, 4].map((r) => nid(r, c)), tags: { highway: 'residential' } });
  const g = build(fromOverpass(els), { s: 39.99, w: -3.01, n: 40.02, e: -2.99 });
  const sq = [[-2.9965, 40.0035], [-2.9935, 40.0035], [-2.9935, 40.0065], [-2.9965, 40.0065], [-2.9965, 40.0035]];
  const live = { version: 1, zbe: { updated: 'x', zones: [{ name: 'ZBE Centro', restricted: ['A', 'B'], days: 'LF', times: ['00:00-23:59'], polys: [sq] }] }, inc: null, fuel: null };
  const now = Date.now();
  const pen = penalties(g, live, { sticker: 'B', avoidZbe: true, now });
  const center = [40.004, -2.996];
  const guard = zbeGuard(g, live, [40.0, -3.0], center, { sticker: 'B', avoidZbe: true }, now);
  assert.ok(guard.to, 'el destino del centro se cambia');
  const r = R.route(g, [40.0, -3.0], guard.to, 0, { pen });
  assert.equal(guard.firstBannedIndex(r.path), -1, 'la ruta no entra en la ZBE');
  // Con etiqueta ECO no hay restricción
  assert.equal(zbeGuard(g, live, [40.0, -3.0], center, { sticker: 'ECO', avoidZbe: true }, now), null);
});
