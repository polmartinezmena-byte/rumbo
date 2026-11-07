#!/usr/bin/env node
// Genera el paquete de rutas de una comunidad autónoma (o de toda España, solo carreteras principales).
//
//   node tools/build-region.mjs la-rioja            → packs/la-rioja.rumbo.gz + packs/index.json
//   node tools/build-region.mjs es                  → mapa general de España
//   node tools/build-region.mjs madrid --no-dem     → sin relieve (más rápido, riesgo solo con OSM)
//
// Datos: extractos diarios de Geofabrik (© colaboradores de OpenStreetMap, ODbL).
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, readHeaderBbox } from './pbf.mjs';
import { fetchDemNode } from './dem-node.mjs';
import { build, HIGHWAYS, WATERWAYS, EMERGENCY } from '../js/graph-build.js';
import { serialize } from '../js/pack.js';
import { isCameraNode } from '../js/radars.js';
import { officialRadars, SOURCES } from './official-radars.mjs';
import { floodGrid } from './flood-zones.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const OUT = join(ROOT, opt('--out', 'packs'));
const CACHE = join(ROOT, 'tools', '.cache');
const PART = 90 * 1024 * 1024; // GitHub Pages: ficheros < 100 MB

const regions = JSON.parse(readFileSync(join(ROOT, 'tools', 'regions.json'), 'utf8'));
const region = regions.find((r) => r.id === id);
if (!region) {
  console.error(`Uso: node tools/build-region.mjs <id>\nIds: ${regions.map((r) => r.id).join(', ')}`);
  process.exit(1);
}
const MAIN = !!region.main;
const log = (...a) => console.log(`[${region.id}]`, ...a);
const t0 = Date.now();

// ---------------------------------------------------------------- 1. descarga
mkdirSync(CACHE, { recursive: true });
const pbf = opt('--pbf', join(CACHE, `${region.id}.osm.pbf`));
if (!existsSync(pbf)) {
  const url = `https://download.geofabrik.de/${region.geofabrik}-latest.osm.pbf`;
  log('Descargando', url);
  const r = await fetch(url, { headers: { 'User-Agent': 'rumbo-pack-builder (github.com)' } });
  if (!r.ok) throw new Error(`Geofabrik respondió ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(pbf));
}
log(`PBF: ${(statSync(pbf).size / 1048576).toFixed(1)} MB`);
const bbox = readHeaderBbox(pbf);
if (!bbox) throw new Error('El PBF no tiene caja delimitadora en la cabecera');
log('Caja:', JSON.stringify(bbox));

// ---------------------------------------------------------------- 2. filtros (los mismos que la consulta Overpass)
const HW = new Set((MAIN ? 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link' : HIGHWAYS).split('|'));
const WW = new Set(WATERWAYS.split('|'));
const KEEP = ['highway', 'oneway', 'junction', 'maxspeed', 'name', 'ref', 'bridge', 'tunnel', 'layer', 'covered', 'ford', 'flood_prone', 'toll', 'toll:motorcar', 'maxspeed:forward', 'maxspeed:backward'];
const keepRoad = (t) =>
  HW.has(t.highway) && t.area !== 'yes' &&
  !/^(private|no)$/.test(t.access || '') &&
  !/^(parking_aisle|driveway|drive-through|emergency_access)$/.test(t.service || '');
const isEmergency = (t) => EMERGENCY[t.amenity] || t.emergency === 'defibrillator';
const keepPoiNode = (t) => {
  if (MAIN) return (t.name && /^(city|town|village)$/.test(t.place || '')) || t.amenity === 'fuel';
  return isEmergency(t) || t.ford === 'yes' || t.ford === 'stepping_stones' ||
    (t.name && (t.amenity || t.shop || t.tourism || t.place));
};

// ---------------------------------------------------------------- 3. primera pasada: vías
const ways = [];
const waterRaw = [];
const poiWays = [];
const relations = [];
let need = new Float64Array(1 << 20);
let nNeed = 0;
const addNeed = (refs) => {
  if (nNeed + refs.length > need.length) {
    const bigger = new Float64Array(Math.max(need.length * 2, nNeed + refs.length));
    bigger.set(need.subarray(0, nNeed));
    need = bigger;
  }
  for (const r of refs) need[nNeed++] = r;
};
log('Pasada 1: vías y relaciones de radares…');
scan(pbf, {
  relation(rid, members, t) {
    if (t.type !== 'enforcement' || !/^(maxspeed|average_speed|traffic_signals)$/.test(t.enforcement || '')) return;
    const nodesM = members.filter((m) => m.type === 'node');
    relations.push({ id: rid, tags: { enforcement: t.enforcement, maxspeed: t.maxspeed }, members: nodesM });
    addNeed(nodesM.map((m) => m.ref));
  },
  way(wid, refs, t) {
    if (t.highway && keepRoad(t)) {
      const tags = {};
      for (const k of KEEP) if (t[k] !== undefined) tags[k] = t[k];
      ways.push({ nodes: refs, tags });
      addNeed(refs);
    } else if (!MAIN && t.waterway && WW.has(t.waterway)) {
      waterRaw.push({ refs, tags: { waterway: t.waterway, intermittent: t.intermittent, seasonal: t.seasonal } });
      addNeed(refs);
    } else if (!MAIN && isEmergency(t)) {
      poiWays.push({ id: wid, refs, tags: t });
      addNeed(refs);
    }
  },
  onProgress: (p) => process.stdout.write(`\r  ${(p * 100).toFixed(0)} %`),
});
process.stdout.write('\n');
log(`${ways.length} vías, ${waterRaw.length} cauces, ${poiWays.length} servicios como área, ${relations.length} relaciones de radar`);

// Ids necesarios, ordenados y únicos → búsqueda binaria (mucha menos memoria que un Map).
const ids = need.subarray(0, nNeed).sort();
let u = 0;
for (let i = 0; i < ids.length; i++) if (i === 0 || ids[i] !== ids[i - 1]) ids[u++] = ids[i];
const sorted = ids.slice(0, u);
need = null;
const lat = new Float64Array(u).fill(NaN);
const lon = new Float64Array(u).fill(NaN);
const find = (x) => {
  let a = 0, b = u - 1;
  while (a <= b) {
    const m = (a + b) >> 1;
    const v = sorted[m];
    if (v === x) return m;
    if (v < x) a = m + 1; else b = m - 1;
  }
  return -1;
};

// ---------------------------------------------------------------- 4. segunda pasada: nodos
const pois = [];
const fords = new Set();
const cameraNodes = [];
log(`Pasada 2: coordenadas de ${u.toLocaleString('es-ES')} nodos…`);
scan(pbf, {
  node(nid, la, lo, tags) {
    const i = find(nid);
    if (i >= 0) { lat[i] = la; lon[i] = lo; }
    if (tags && isCameraNode(tags)) cameraNodes.push({ id: nid, lat: la, lon: lo, tags });
    if (tags && keepPoiNode(tags)) {
      if (tags.ford === 'yes' || tags.ford === 'stepping_stones') fords.add(nid);
      if (tags.name || isEmergency(tags)) pois.push({ type: 'node', id: nid, lat: la, lon: lo, tags });
    }
  },
  onProgress: (p) => process.stdout.write(`\r  ${(p * 100).toFixed(0)} %`),
});
process.stdout.write('\n');

const coordOf = (nid) => {
  const i = find(nid);
  return i >= 0 && !Number.isNaN(lat[i]) ? [lat[i], lon[i]] : undefined;
};
const waterways = waterRaw.map((w) => ({ tags: w.tags, geom: w.refs.map(coordOf).filter(Boolean) }));
for (const w of poiWays) {
  const pts = w.refs.map(coordOf).filter(Boolean);
  if (!pts.length) continue;
  const c = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
  pois.push({ type: 'way', id: w.id, center: { lat: c[0] / pts.length, lon: c[1] / pts.length }, tags: w.tags });
}

// ---------------------------------------------------------------- 5. relieve
let dem = null;
if (!MAIN && !flag('--no-dem')) {
  const tilesAt = (z) => {
    const n = 2 ** z;
    const x = (lon) => Math.floor(((lon + 180) / 360) * n);
    const y = (la) => { const r = (la * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
    return (x(bbox.e) - x(bbox.w) + 1) * (y(bbox.s) - y(bbox.n) + 1);
  };
  let z = 12;
  while (z > 9 && tilesAt(z) > 1200) z--;
  log(`Relieve: ${tilesAt(z)} teselas a z${z}…`);
  dem = await fetchDemNode(bbox, z, (p) => process.stdout.write(`\r  ${(p * 100).toFixed(0)} %`));
  process.stdout.write('\n');
}

// ---------------------------------------------------------------- 6. grafo + paquete
let floodZones = null;
if (!MAIN && !flag('--no-snczi')) {
  log('Zonas inundables oficiales (SNCZI, Ministerio para la Transición Ecológica)…');
  floodZones = await floodGrid(bbox, join(CACHE, 'snczi'), (m) => log(m));
}

let official = [];
if (!flag('--no-official')) {
  log('Radares oficiales (DGT, Servei Català de Trànsit, Ayuntamiento de Madrid)…');
  official = await officialRadars(bbox, join(CACHE, 'sources'), (m) => log(m));
}

log('Construyendo grafo y riesgo de inundación…');
const G = build({ ways, pois, waterways, fords, coordOf, cameraNodes, relations, official, floodGrid: floodZones }, bbox, dem, (m) => log(m));
log(`Radares: ${G.cLa.length} (${[...G.cKind].filter((k) => k === 1).length} tramos, ${[...G.cKind].filter((k) => k === 3).length} semáforos) · peaje: ${[...G.toll].filter(Boolean).length} tramos`);
G.region = region.id;
G.name = region.name;
G.main = MAIN;
const bin = serialize(G);
const gz = gzipSync(bin, { level: 9 });
log(`Grafo: ${G.la.length.toLocaleString('es-ES')} nodos, ${G.tgt.length.toLocaleString('es-ES')} tramos · ${(bin.length / 1048576).toFixed(1)} MB → ${(gz.length / 1048576).toFixed(1)} MB comprimido`);

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.startsWith(`${region.id}.rumbo.gz`)) unlinkSync(join(OUT, f));
const files = [];
for (let p = 0, i = 0; p < gz.length; p += PART, i++) {
  const name = gz.length > PART ? `${region.id}.rumbo.gz.${i}` : `${region.id}.rumbo.gz`;
  writeFileSync(join(OUT, name), gz.subarray(p, p + PART));
  files.push(name);
}

const indexPath = join(OUT, 'index.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { regions: [] };
index.regions = index.regions.filter((r) => r.id !== region.id);
index.regions.push({
  id: region.id, name: region.name, main: MAIN, bbox, files, size: gz.length,
  nodes: G.la.length, edges: G.tgt.length, places: G.sName.length, emergency: G.eKind.length,
  dem: !!dem, snczi: !!floodZones, date: new Date().toISOString().slice(0, 10),
});
index.regions.sort((a, b) => (a.main - b.main) || a.name.localeCompare(b.name, 'es'));
index.updated = new Date().toISOString();
index.sources = Object.values(SOURCES).map(({ name, licence }) => ({ name, licence }));
writeFileSync(indexPath, JSON.stringify(index, null, 2));
log(`Listo en ${((Date.now() - t0) / 1000).toFixed(0)} s → ${files.join(', ')}`);

// Radares oficiales de toda España en un JSON pequeño: lo usa la app al descargar una «zona a medida».
if (!flag('--no-official')) {
  const all = await officialRadars({ s: 27, n: 44.5, w: -19, e: 5 }, join(CACHE, 'sources'), () => {});
  writeFileSync(join(OUT, 'radares-oficiales.json'), JSON.stringify(all.map((c) => [+c.lat.toFixed(6), +c.lon.toFixed(6), c.speed, c.kind, c.sec ?? -1])));
}
