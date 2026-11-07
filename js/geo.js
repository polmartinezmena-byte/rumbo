// Utilidades geográficas y de formato (compartidas por la app y el worker).
const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(la1, lo1, la2, lo2) {
  const dLa = (la2 - la1) * RAD;
  const dLo = (lo2 - lo1) * RAD;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Aproximación equirectangular: rapidísima y precisa a escala de ciudad.
export function fastDist(la1, lo1, la2, lo2) {
  const x = (lo2 - lo1) * RAD * Math.cos(((la1 + la2) / 2) * RAD);
  const y = (la2 - la1) * RAD;
  return R * Math.sqrt(x * x + y * y);
}

export function bearing(la1, lo1, la2, lo2) {
  const y = Math.sin((lo2 - lo1) * RAD) * Math.cos(la2 * RAD);
  const x =
    Math.cos(la1 * RAD) * Math.sin(la2 * RAD) -
    Math.sin(la1 * RAD) * Math.cos(la2 * RAD) * Math.cos((lo2 - lo1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export const norm = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function fmtDist(m) {
  if (m < 100) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  if (m < 975) return `${Math.round(m / 50) * 50} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

export function fmtDistSpeech(m) {
  if (m < 1000) return `${Math.round(m / 50) * 50 || 50} metros`;
  const km = (m / 1000).toFixed(1).replace('.0', '').replace('.', ',');
  return km === '1' ? '1 kilómetro' : `${km} kilómetros`;
}

export function fmtTime(s) {
  const min = Math.round(s / 60);
  if (min < 60) return `${Math.max(1, min)} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function fmtClock(date) {
  return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}
