// Lluvia observada y prevista (Open-Meteo: gratis, sin clave) y caudal de ríos (GloFAS vía Open-Meteo).
// Con conexión se consulta cada 15 min; sin conexión se usa la última lectura guardada.
const KEY = 'rumbo:weather';
const FRESH_MS = 3 * 3600e3;   // con red: una lectura de hace menos de 3 h sirve
const STALE_MS = 12 * 3600e3;  // sin red: se aprovecha hasta 12 h

// Umbrales inspirados en los de AEMET para precipitación (mm/h y mm acumulados).
export const LEVELS = [
  { level: 0, label: 'Sin lluvia relevante', icon: '☀️' },
  { level: 1, label: 'Lluvia fuerte', icon: '🌧️' },
  { level: 2, label: 'Lluvia muy fuerte o torrencial', icon: '⛈️' },
];

export function classify({ maxHour, next12, past6, riverRatio }) {
  if (maxHour >= 20 || next12 >= 60 || past6 >= 40 || riverRatio >= 4) return 2;
  if (maxHour >= 7 || next12 >= 25 || past6 >= 15 || riverRatio >= 2) return 1;
  return 0;
}

export async function fetchWeather(lat, lon) {
  const la = lat.toFixed(3), lo = lon.toFixed(3);
  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}` +
      '&hourly=precipitation&current=precipitation&past_hours=6&forecast_hours=12&timezone=auto',
  );
  if (!r.ok) throw new Error('Open-Meteo ' + r.status);
  const j = await r.json();
  const p = j.hourly.precipitation.map((v) => v ?? 0);
  const past = p.slice(0, 6), next = p.slice(6, 18);
  const w = {
    at: Date.now(), lat, lon,
    now: j.current?.precipitation ?? 0,
    past6: sum(past),
    next12: sum(next),
    maxHour: Math.max(0, ...past.slice(3), ...next.slice(0, 6)),
    hourly: p,
    riverRatio: 0,
  };
  try {
    const f = await (await fetch(
      `https://flood-api.open-meteo.com/v1/flood?latitude=${la}&longitude=${lo}&daily=river_discharge,river_discharge_median&forecast_days=3`,
    )).json();
    const d = f.daily?.river_discharge || [], m = f.daily?.river_discharge_median || [];
    // Solo cuenta si hay un río con caudal apreciable en la celda (evita dividir casi por cero).
    w.riverRatio = Math.max(0, ...d.map((v, i) => (m[i] > 1 && v ? v / m[i] : 0)));
  } catch { /* opcional */ }
  w.level = classify(w);
  try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* sin almacenamiento */ }
  return w;
}

export function cachedWeather() {
  try {
    const w = JSON.parse(localStorage.getItem(KEY));
    if (!w) return null;
    const age = Date.now() - w.at;
    if (age > (navigator.onLine ? FRESH_MS : STALE_MS)) return { ...w, stale: true };
    return w;
  } catch {
    return null;
  }
}

const sum = (a) => Math.round(a.reduce((s, v) => s + v, 0) * 10) / 10;
