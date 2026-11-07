// Zonas inundables oficiales del SNCZI (Sistema Nacional de Cartografía de Zonas Inundables),
// del Ministerio para la Transición Ecológica y el Reto Demográfico, vía su GeoServer WFS.
// Módulo común: lo usan el worker del navegador (zona a medida) y tools/flood-zones.mjs (paquetes).
// Licencia: uso libre citando «© Ministerio para la Transición Ecológica y el Reto Demográfico».
//
// Se descargan los polígonos que tocan la zona y se rasterizan en una rejilla (~35 m) con la
// clase más grave de cada celda. Así, al generar el paquete, cada calle consulta su zona en O(1).

const WFS = 'https://gis.miteco.gob.es/geoserver/agua/ows';

// De más a menos grave. «ZFP» = zona de flujo preferente: donde el agua corre con más fuerza.
export const LAYERS = [
  { name: 'Zi_laminas_q500', cls: 1, label: 'T=500 años (probabilidad baja)' },
  { name: 'Zi_laminas_q100', cls: 2, label: 'T=100 años (probabilidad media)' },
  { name: 'Zi_laminas_q10', cls: 3, label: 'T=10 años (probabilidad alta)' },
  { name: 'ZI_Laminas_ZFP', cls: 4, label: 'Zona de flujo preferente' },
];

const CELL_M = 35;

export async function fetchLayer(layer, b, log) {
  const features = [];
  const PAGE = 25; // los polígonos son enormes (una demarcación entera): páginas pequeñas
  for (let start = 0; ; start += PAGE) {
    const url = `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=agua:${layer}` +
      `&outputFormat=application/json&srsName=EPSG:4326` +
      `&bbox=${b.w},${b.s},${b.e},${b.n},urn:ogc:def:crs:OGC:1.3:CRS84&count=${PAGE}&startIndex=${start}&sortBy=id_zona`;
    let j;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'rumbo-pack-builder (github.com)' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        j = await r.json();
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
    const got = j.features || [];
    // Solo la geometría: las propiedades no hacen falta.
    for (const ft of got) if (ft.geometry) features.push(ft.geometry);
    log?.(`    ${layer}: ${features.length} polígonos`);
    if (got.length < PAGE) break;
  }
  return features;
}

/** Rejilla con la clase oficial más grave en cada celda (0 = fuera de zona inundable). */
export async function floodGrid(b, log = () => {}, getLayer = fetchLayer) {
  const midLat = (b.s + b.n) / 2;
  const dLat = CELL_M / 110540;
  const dLon = CELL_M / (111320 * Math.cos((midLat * Math.PI) / 180));
  const W = Math.ceil((b.e - b.w) / dLon) + 1;
  const H = Math.ceil((b.n - b.s) / dLat) + 1;
  const data = new Uint8Array(W * H);
  let polys = 0;
  for (const L of LAYERS) {
    let geoms;
    try {
      geoms = await getLayer(L.name, b, log);
    } catch (e) {
      log(`  ${L.label}: no disponible (${e.message}) — se sigue sin esta capa`);
      continue;
    }
    for (const g of geoms) {
      const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const rings of list) { fillPolygon(rings, L.cls); polys++; }
    }
    log(`  ${L.label}: ${geoms.length} zonas`);
  }
  let marked = 0;
  for (let i = 0; i < data.length; i++) if (data[i]) marked++;
  log(`  Celdas en zona inundable: ${((marked / data.length) * 100).toFixed(1)} % (${polys} polígonos)`);
  return { s: b.s, w: b.w, dLat, dLon, W, H, data };

  // Relleno por líneas de barrido (regla par-impar: los anillos interiores son huecos).
  function fillPolygon(rings, cls) {
    let minY = Infinity, maxY = -Infinity;
    const edges = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const x1 = (ring[j][0] - b.w) / dLon, y1 = (ring[j][1] - b.s) / dLat;
        const x2 = (ring[i][0] - b.w) / dLon, y2 = (ring[i][1] - b.s) / dLat;
        if (y1 === y2) continue;
        edges.push(y1 < y2 ? [x1, y1, x2, y2] : [x2, y2, x1, y1]);
        minY = Math.min(minY, y1, y2);
        maxY = Math.max(maxY, y1, y2);
      }
    }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (const [ax, ay, bx, by] of edges) if (yc >= ay && yc < by) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      const row = y * W;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xa; x <= xb; x++) if (data[row + x] < cls) data[row + x] = cls;
      }
    }
  }
}

