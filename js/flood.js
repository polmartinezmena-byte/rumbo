// Riesgo de inundación por calle, calculado una vez al descargar la zona (luego funciona offline).
//
// Señales que combina:
//  1. Relieve (modelo digital de elevación, teselas "terrarium" de AWS Open Data):
//     - Hondonadas: cuánto está un punto por debajo de su entorno (~450 m) — el agua se acumula ahí.
//     - Altura sobre el cauce más cercano (una versión sencilla del índice HAND): estar a pocos
//       metros por encima de un río o rambla cercano es la mejor señal simple de zona inundable.
//  2. OpenStreetMap: ríos, arroyos, ramblas (intermitentes), badenes (ford), túneles y pasos
//     inferiores (tunnel / layer < 0), y vías etiquetadas flood_prone=yes.
//
//  3. Zonas inundables OFICIALES del SNCZI (Ministerio para la Transición Ecológica), cuando hay:
//     T=10, T=100 y T=500 años y zona de flujo preferente (tools/flood-zones.mjs). Son la fuente
//     principal; las señales 1 y 2 solo llegan a riesgo «medio» para no dar falsas alarmas.
//
// Es una ayuda para elegir mejor la ruta, no un aviso oficial.

// Riesgo de cada clase oficial: 0 fuera · 1 T500 · 2 T100 · 3 T10 · 4 flujo preferente.
export const CLASS_RISK = [0, 0.6, 0.85, 1, 1];
// Techo de las estimaciones propias (relieve + cauces) para que no marquen solas «riesgo alto».
const HEURISTIC_MAX = 0.55;
const HOLLOW_MAX = 0.45;

export function officialClassAt(grid, lat, lon) {
  if (!grid) return 0;
  const x = Math.floor((lon - grid.w) / grid.dLon), y = Math.floor((lat - grid.s) / grid.dLat);
  if (x < 0 || y < 0 || x >= grid.W || y >= grid.H) return 0;
  return grid.data[y * grid.W + x];
}

const DEM_Z = 12; // ~30 m por píxel en España: suficiente para la resolución real de los datos (SRTM)
const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const lon2px = (lon, z) => ((lon + 180) / 360) * 2 ** z * 256;
const lat2px = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * 256;
};

// Descarga el relieve del área y lo une en un mosaico de alturas (metros).
export async function fetchDem(b, onProgress) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const z = DEM_Z;
  const x0 = Math.floor(lon2px(b.w, z) / 256), x1 = Math.floor(lon2px(b.e, z) / 256);
  const y0 = Math.floor(lat2px(b.n, z) / 256), y1 = Math.floor(lat2px(b.s, z) / 256);
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
  const W = nx * 256, H = ny * 256;
  const data = new Float32Array(W * H).fill(NaN);
  const ctx = new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  let done = 0, ok = 0;
  const run = async () => {
    while (jobs.length) {
      const [x, y] = jobs.pop();
      try {
        const r = await fetch(DEM_URL(z, x, y));
        if (r.ok) {
          const bmp = await createImageBitmap(await r.blob());
          ctx.clearRect(0, 0, 256, 256);
          ctx.drawImage(bmp, 0, 0);
          const px = ctx.getImageData(0, 0, 256, 256).data;
          const ox = (x - x0) * 256, oy = (y - y0) * 256;
          for (let j = 0; j < 256; j++) {
            for (let i = 0; i < 256; i++) {
              const k = (j * 256 + i) * 4;
              data[(oy + j) * W + ox + i] = px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
            }
          }
          ok++;
        }
      } catch { /* sin relieve para esta tesela: se usan solo las señales de OSM */ }
      onProgress?.(++done / (nx * ny));
    }
  };
  await Promise.all(Array.from({ length: 6 }, run));
  if (!ok) return null;
  return { z, ox: x0 * 256, oy: y0 * 256, W, H, data };
}

function demSampler(dem) {
  if (!dem) return null;
  const { z, ox, oy, W, H, data } = dem;
  // Imagen integral para la media del entorno en O(1).
  const I = new Float64Array((W + 1) * (H + 1));
  const C = new Uint32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0, rc = 0;
    for (let x = 0; x < W; x++) {
      const v = data[y * W + x];
      if (!Number.isNaN(v)) { rs += v; rc++; }
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + rs;
      C[(y + 1) * (W + 1) + x + 1] = C[y * (W + 1) + x + 1] + rc;
    }
  }
  // Radio del "entorno" ≈ 450 m, sea cual sea el zoom del relieve.
  const midLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (oy + H / 2)) / (256 * 2 ** z)))) * 180) / Math.PI;
  const pxMeters = (156543.03 * Math.cos((midLat * Math.PI) / 180)) / 2 ** z;
  const R = Math.max(3, Math.round(450 / pxMeters));
  const pix = (lat, lon) => [Math.floor(lon2px(lon, z) - ox), Math.floor(lat2px(lat, z) - oy)];
  return {
    elev(lat, lon) {
      const [x, y] = pix(lat, lon);
      if (x < 0 || y < 0 || x >= W || y >= H) return NaN;
      return data[y * W + x];
    },
    // Mínimo en una ventana pequeña: el fondo del cauce (evita leer la altura de un puente).
    minElev(lat, lon, r = 2) {
      const [cx, cy] = pix(lat, lon);
      let m = Infinity;
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const v = data[y * W + x];
        if (v < m) m = v;
      }
      return m === Infinity ? NaN : m;
    },
    meanAround(lat, lon) {
      const [cx, cy] = pix(lat, lon);
      const xa = Math.max(0, cx - R), xb = Math.min(W, cx + R + 1);
      const ya = Math.max(0, cy - R), yb = Math.min(H, cy + R + 1);
      if (xa >= xb || ya >= yb) return NaN;
      const s = I[yb * (W + 1) + xb] - I[ya * (W + 1) + xb] - I[yb * (W + 1) + xa] + I[ya * (W + 1) + xa];
      const c = C[yb * (W + 1) + xb] - C[ya * (W + 1) + xb] - C[yb * (W + 1) + xa] + C[ya * (W + 1) + xa];
      return c ? s / c : NaN;
    },
  };
}

/**
 * Riesgo (0..1) de cada nodo del grafo.
 * @param waterways  [{ w: peso del cauce (graph-build.js), geom: [[lat, lon], ...] }]
 */
export function nodeRisk(la, lo, waterways, dem, official = null) {
  const n = la.length;
  const risk = new Float32Array(n);
  const S = demSampler(dem);
  const lat0 = la.length ? la[0] : 0;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320, ky = 110540;

  // Puntos de cauce cada ~30 m en una rejilla espacial de 100 m.
  const CELL = 100;
  const grid = new Map();
  const cellKey = (cx, cy) => cx * 100003 + cy;
  for (const ww of waterways) {
    const g = ww.geom;
    for (let k = 0; k + 1 < g.length; k++) {
      const [a1, o1] = g[k], [a2, o2] = g[k + 1];
      const seg = Math.hypot((o2 - o1) * kx, (a2 - a1) * ky);
      const steps = Math.max(1, Math.ceil(seg / 30));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const lat = a1 + (a2 - a1) * t, lon = o1 + (o2 - o1) * t;
        const x = lon * kx, y = lat * ky;
        const key = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
        let arr = grid.get(key);
        if (!arr) grid.set(key, (arr = []));
        arr.push(x, y, ww.w, S ? S.minElev(lat, lon) : NaN);
      }
    }
  }

  // Radio de influencia según el cauce: un río grande inunda más lejos que una acequia.
  const NEAR = 100, FAR = 450, SAFE_H = 6;
  for (let i = 0; i < n; i++) {
    const x = lo[i] * kx, y = la[i] * ky;
    const e = S ? S.elev(la[i], lo[i]) : NaN;
    let r = 0;

    // 1) Altura sobre cauces cercanos.
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    const rc = Math.ceil(FAR / CELL);
    for (let gx = cx - rc; gx <= cx + rc; gx++) {
      for (let gy = cy - rc; gy <= cy + rc; gy++) {
        const arr = grid.get(cellKey(gx, gy));
        if (!arr) continue;
        for (let p = 0; p < arr.length; p += 4) {
          const d = Math.hypot(arr[p] - x, arr[p + 1] - y);
          const far = 150 + 300 * arr[p + 2];
          if (d > far) continue;
          const prox = d < NEAR ? 1 : 1 - (d - NEAR) / (far - NEAR);
          const we = arr[p + 3];
          // Sin relieve: solo la cercanía, con menos peso.
          const hf = Number.isNaN(e) || Number.isNaN(we) ? 0.45 : Math.min(1, Math.max(0, (SAFE_H - (e - we)) / SAFE_H));
          const v = prox * hf * arr[p + 2] * HEURISTIC_MAX;
          if (v > r) r = v;
        }
      }
    }

    // 2) Hondonadas del terreno.
    if (S && !Number.isNaN(e)) {
      const m = S.meanAround(la[i], lo[i]);
      if (!Number.isNaN(m)) {
        const tpi = e - m; // negativo = más bajo que el entorno
        const v = Math.min(1, Math.max(0, -tpi / 12)) * HOLLOW_MAX;
        if (v > r) r = v;
      }
    }
    risk[i] = Math.max(r, CLASS_RISK[officialClassAt(official, la[i], lo[i])]);
  }
  return risk;
}

/** Riesgo de un tramo a partir de sus nodos y de las etiquetas de la vía. Devuelve [riesgo 0..1, duro 0/1]. */
export function edgeRisk(rA, rB, t, fordA, fordB, rMid = 0) {
  const isBridge = t.bridge && t.bridge !== 'no';
  if (isBridge) return [0.05, 0];
  let r = Math.max(rA, rB, rMid);
  let hard = 0;
  const tunnel = t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage';
  const layer = parseInt(t.layer, 10);
  if (t.ford === 'yes' || fordA || fordB) { r = 1; hard = 1; }
  else if (tunnel || (layer < 0 && !t.covered)) { r = Math.max(r, 0.9); hard = 1; }
  if (t.flood_prone === 'yes') r = Math.max(r, 0.85);
  return [r, hard];
}
