// Datos que cambian a menudo: incidencias de la DGT, Zonas de Bajas Emisiones y precios de los
// carburantes. Se descargan cuando hay conexión y se guardan en IndexedDB para usarlos sin ella.
// Se usa desde el worker de rutas.
import * as db from './db.js';

// La DGT no permite peticiones desde el navegador (CORS): un workflow de GitHub las publica cada
// 15 minutos en la rama «datos» del repositorio (tools/datos.mjs).
// En desarrollo (localhost) se leen los generados en local con: node tools/datos.mjs tools/.cache/datos --zbe
export const DATA_BASE = globalThis.location?.hostname === 'localhost'
  ? new URL('../tools/.cache/datos/', globalThis.location.href).href
  : 'https://raw.githubusercontent.com/polmartinezmena-byte/rumbo/datos/';
// El Ministerio sí permite CORS: los precios se piden directamente.
const FUEL_URL = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/';

export const FUELS = {
  g95: { label: 'Gasolina 95', field: 'Precio Gasolina 95 E5' },
  g98: { label: 'Gasolina 98', field: 'Precio Gasolina 98 E5' },
  diesel: { label: 'Diésel', field: 'Precio Gasoleo A' },
  dieselp: { label: 'Diésel premium', field: 'Precio Gasoleo Premium' },
  glp: { label: 'GLP', field: 'Precio Gases licuados del petróleo' },
};

const MAX_AGE = { inc: 10 * 60e3, zbe: 24 * 3600e3, fuel: 6 * 3600e3 };

export const live = { inc: null, zbe: null, fuel: null, version: 0 };

export async function loadCached() {
  for (const k of ['inc', 'zbe', 'fuel']) live[k] = (await db.get('live:' + k)) || null;
  live.version++;
  return summary();
}

export function summary() {
  return {
    inc: live.inc && { at: live.inc.at, updated: live.inc.updated, n: live.inc.items.length },
    zbe: live.zbe && { at: live.zbe.at, updated: live.zbe.updated, n: live.zbe.zones.length },
    fuel: live.fuel && { at: live.fuel.at, date: live.fuel.date, n: live.fuel.la.length },
  };
}

const stale = (k) => !live[k] || Date.now() - live[k].at > MAX_AGE[k];
const num = (s) => (s ? parseFloat(String(s).replace(',', '.')) : NaN);

async function getJson(url, timeout = 60000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

export async function refresh(force = false, onProgress) {
  const errors = {};
  let changed = false;
  if (force || stale('inc')) {
    try {
      const j = await getJson(DATA_BASE + 'incidencias.json');
      live.inc = { at: Date.now(), updated: j.updated, items: j.items || [] };
      await db.set('live:inc', live.inc);
      changed = true;
    } catch (e) { errors.inc = e.message; }
  }
  if (force || stale('zbe')) {
    try {
      const j = await getJson(DATA_BASE + 'zbe.json');
      live.zbe = { at: Date.now(), updated: j.updated, zones: j.zones || [] };
      await db.set('live:zbe', live.zbe);
      changed = true;
    } catch (e) { errors.zbe = e.message; }
  }
  if (force || stale('fuel')) {
    try {
      onProgress?.('Precios de carburantes…');
      const j = await getJson(FUEL_URL, 120000);
      live.fuel = parseFuel(j);
      await db.set('live:fuel', live.fuel);
      changed = true;
    } catch (e) { errors.fuel = e.message; }
  }
  if (changed) live.version++;
  return { ...summary(), errors, changed };
}

function parseFuel(j) {
  const list = j.ListaEESSPrecio || [];
  const n = list.length;
  const la = new Float32Array(n), lo = new Float32Array(n);
  const name = new Array(n), addr = new Array(n), hours = new Array(n);
  const prices = {};
  for (const k of Object.keys(FUELS)) prices[k] = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const s = list[i];
    la[i] = num(s.Latitud);
    lo[i] = num(s['Longitud (WGS84)']);
    name[i] = (s['Rótulo'] || '').trim();
    addr[i] = `${(s['Dirección'] || '').trim()}, ${(s.Localidad || '').trim()}`;
    hours[i] = s.Horario || '';
    for (const [k, f] of Object.entries(FUELS)) prices[k][i] = num(s[f.field]);
  }
  return { at: Date.now(), date: j.Fecha || '', la, lo, name, addr, hours, prices };
}

// ------------------------------------------------------------------ ZBE: ¿activa ahora?
// days: «L» laborables (lunes a viernes), «F» fines de semana y festivos, «LF» todos los días.
export function zoneActive(z, now = new Date()) {
  const dow = now.getDay(); // 0 domingo … 6 sábado
  const weekend = dow === 0 || dow === 6;
  const okDay = z.days.includes('L') && z.days.includes('F') ? true : z.days.includes('F') ? weekend : !weekend;
  if (!okDay) return false;
  const hm = now.getHours() * 60 + now.getMinutes();
  return z.times.some((t) => {
    const [a, b] = t.split('-').map((x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; });
    if (a === b) return true; // 00:00-00:00 en algunos ficheros = todo el día
    return a <= b ? hm >= a && hm <= b : hm >= a || hm <= b;
  });
}
