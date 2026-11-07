// Radares de fuentes oficiales, para completar los de OpenStreetMap al generar los paquetes.
//
//   · DGT — Punto de Acceso Nacional (NAP), DATEX II: cabinas de radar fijo y tramos de
//     velocidad media en la red estatal (sin Cataluña ni Euskadi). Licencia libre. Fuente: DGT.
//   · Servei Català de Trànsit — radars fixos de Catalunya (UTM ETRS89 31N, con límite).
//     Llicència oberta d'ús d'informació de Catalunya.
//   · Ayuntamiento de Madrid — radares municipales (fijos y de tramo, con límite; CC BY 4.0)
//     y semáforos con control foto-rojo (portal de datos abiertos, con atribución).
//
// Euskadi, Barcelona y el resto de ayuntamientos no publican (a fecha de hoy) un fichero
// descargable: para ellos se usan los radares cartografiados en OpenStreetMap.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCES = {
  dgt: {
    name: 'DGT · NAP (DATEX II)',
    url: 'https://nap.dgt.es/datex2/dgt/PredefinedLocationsPublication/radares/content.xml',
    licence: 'Licencia libre — Fuente: Dirección General de Tráfico',
  },
  cat: {
    name: 'Servei Català de Trànsit',
    url: 'https://transit.gencat.cat/web/.content/documents/seguretat_viaria/radars.txt',
    licence: "Llicència oberta d'ús d'informació — Catalunya",
  },
  madRadares: {
    name: 'Ayuntamiento de Madrid · Radares',
    url: 'https://datos.madrid.es/dataset/300049-0-radares-fijos-moviles/resource/300049-1-radares-fijos-moviles-csv/download/300049-1-radares-fijos-moviles-csv.csv',
    licence: 'CC BY 4.0 — Ayuntamiento de Madrid',
  },
  madFotoRojo: {
    name: 'Ayuntamiento de Madrid · Semáforos foto-rojo',
    url: 'https://datos.madrid.es/dataset/205193-0-semaforos-foto-rojo/resource/205193-1-semaforos-foto-rojo-csv/download/205193-1-semaforos-foto-rojo-csv.csv',
    licence: 'Datos abiertos del Ayuntamiento de Madrid (atribución)',
  },
};

const DAY = 24 * 3600e3;

async function cached(dir, key, url) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, key + '.raw');
  if (existsSync(f) && Date.now() - statSync(f).mtimeMs < DAY) return readFileSync(f);
  const r = await fetch(url, { headers: { 'User-Agent': 'rumbo-pack-builder (github.com)' } });
  if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  writeFileSync(f, b);
  return b;
}

// ---------------------------------------------------------------- UTM → WGS84 (GRS80/WGS84, sin cambio de datum)
export function utmToLatLon(x, y, zone = 31) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const xx = x - 500000, m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sp = Math.sin(p), cp = Math.cos(p), tp = Math.tan(p);
  const n1 = a / Math.sqrt(1 - e2 * sp * sp);
  const t1 = tp * tp, c1 = ep2 * cp * cp;
  const r1 = (a * (1 - e2)) / (1 - e2 * sp * sp) ** 1.5;
  const d = xx / (n1 * k0);
  const lat = p - ((n1 * tp) / r1) * (d * d / 2 - ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4) / 24
    + ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6) / 720);
  const lon = (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5) / 120) / cp;
  return [(lat * 180) / Math.PI, ((zone - 1) * 6 - 180 + 3) + (lon * 180) / Math.PI];
}

// ---------------------------------------------------------------- lectores
// Cada radar: { lat, lon, speed, kind: 'fixed'|'section_start'|'section_end'|'red_light', sec?, src }
function parseDgt(xml) {
  const out = [];
  const num = (s, tag) => { const m = s.match(new RegExp(`<_0:${tag}>([-\\d.]+)<`)); return m ? +m[1] : NaN; };
  const coords = (s) => [num(s, 'latitude'), num(s, 'longitude')];
  let sec = 0;
  for (const chunk of xml.split('<_0:predefinedLocation id="GUID_').slice(1)) {
    const type = chunk.slice(0, chunk.indexOf('_'));
    const body = chunk;
    if (type === 'CVM') {
      // Tramo: from → to
      const from = body.match(/<_0:from[\s\S]*?<\/_0:from>/)?.[0];
      const to = body.match(/<_0:to[\s\S]*?<\/_0:to>/)?.[0];
      if (!from || !to) continue;
      const [la1, lo1] = coords(from), [la2, lo2] = coords(to);
      if ([la1, lo1, la2, lo2].some(Number.isNaN)) continue;
      out.push({ lat: la1, lon: lo1, speed: 0, kind: 'section_start', sec, src: 'dgt' });
      out.push({ lat: la2, lon: lo2, speed: 0, kind: 'section_end', sec, src: 'dgt' });
      sec++;
    } else {
      const [la, lo] = coords(body);
      if (!Number.isNaN(la)) out.push({ lat: la, lon: lo, speed: 0, kind: 'fixed', src: 'dgt' });
    }
  }
  return out;
}

function parseCat(buf) {
  const out = [];
  for (const line of buf.toString('latin1').split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5 || !/^\d/.test(p[p.length - 1])) continue;
    const [x, y] = [parseFloat(p[p.length - 2].replace(',', '.')), parseFloat(p[p.length - 1].replace(',', '.'))];
    const speed = parseInt(p[p.length - 3], 10);
    if (!(x > 100000 && y > 4000000)) continue;
    const [lat, lon] = utmToLatLon(x, y, 31);
    out.push({ lat, lon, speed: speed > 0 && speed <= 150 ? speed : 0, kind: 'fixed', src: 'cat' });
  }
  return out;
}

function parseMadRadares(buf) {
  const out = [];
  const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1);
  let sec = 0;
  for (const l of lines) {
    const r = l.split(';');
    // Se lee desde el final: …;Longitud inicio;Latitud inicio;X;Y;Longitud;Latitud;Velocidad;Responsable
    const n = r.length;
    const speed = parseInt(r[n - 2], 10) || 0;
    const lat = parseFloat(r[n - 3]), lon = parseFloat(r[n - 4]);
    const lat0 = parseFloat(r[n - 7]), lon0 = parseFloat(r[n - 8]);
    if (Number.isNaN(lat) || Math.abs(lat) > 90) continue;
    if (r.some((c) => /tramo/i.test(c)) && !Number.isNaN(lat0) && Math.abs(lat0) <= 90) {
      out.push({ lat: lat0, lon: lon0, speed, kind: 'section_start', sec, src: 'mad' });
      out.push({ lat, lon, speed, kind: 'section_end', sec, src: 'mad' });
      sec++;
    } else out.push({ lat, lon, speed, kind: 'fixed', src: 'mad' });
  }
  return out;
}

function parseMadFotoRojo(buf) {
  const out = [];
  for (const l of buf.toString('latin1').split(/\r?\n/).slice(1)) {
    const r = l.split(';');
    if (r.length < 10) continue;
    const lon = parseFloat(r[r.length - 2]), lat = parseFloat(r[r.length - 1]);
    if (r[4] === '0') continue; // inactivo
    if (!Number.isNaN(lat)) out.push({ lat, lon, speed: 0, kind: 'red_light', src: 'mad' });
  }
  return out;
}

/** Descarga (con caché de un día) y devuelve los radares oficiales dentro de una caja. */
export async function officialRadars(bbox, cacheDir, log = console.log) {
  const parsers = { dgt: parseDgt, cat: parseCat, madRadares: parseMadRadares, madFotoRojo: parseMadFotoRojo };
  const all = [];
  let secBase = 0;
  for (const [key, src] of Object.entries(SOURCES)) {
    try {
      const raw = await cached(cacheDir, key, src.url);
      const list = parsers[key](key === 'dgt' ? raw.toString('utf8') : raw);
      // Ids de tramo únicos entre fuentes.
      let maxSec = -1;
      for (const c of list) if (c.sec !== undefined) { maxSec = Math.max(maxSec, c.sec); c.sec += secBase; }
      secBase += maxSec + 1;
      const inBox = list.filter((c) => c.lat >= bbox.s && c.lat <= bbox.n && c.lon >= bbox.w && c.lon <= bbox.e);
      log(`  ${src.name}: ${list.length} en total, ${inBox.length} en la zona`);
      all.push(...inBox);
    } catch (e) {
      log(`  ${src.name}: no disponible (${e.message}) — se sigue sin esta fuente`);
    }
  }
  return all;
}
