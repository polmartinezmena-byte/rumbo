// Tráfico típico por franja horaria (no es tráfico en directo): cuánto más lento se circula a cada
// hora según el día y el tipo de vía. Afecta a la ruta elegida y al tiempo de llegada.
// Perfiles aproximados para España: hora punta de mañana (7:30-9:30), mediodía (13:30-15:30) y tarde
// (17:30-20:00) entre semana; operación salida el viernes por la tarde y retorno el domingo por la
// tarde en autopistas y autovías.

// Intensidad (0 = vía libre, 1 = hora punta fuerte) por hora local.
const WEEKDAY = [0, 0, 0, 0, 0, 0.05, 0.3, 0.85, 1, 0.7, 0.35, 0.3, 0.35, 0.5, 0.55, 0.4, 0.4, 0.6, 0.85, 0.9, 0.6, 0.3, 0.1, 0.05];
const SATURDAY = [0, 0, 0, 0, 0, 0, 0, 0.05, 0.1, 0.2, 0.35, 0.45, 0.45, 0.4, 0.25, 0.15, 0.2, 0.3, 0.35, 0.3, 0.2, 0.1, 0.05, 0.05];
const SUNDAY = [0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.2, 0.1, 0.1, 0.15, 0.25, 0.3, 0.3, 0.2, 0.1, 0.05, 0];
// Cuánto más lento en hora punta fuerte, por tipo de vía (según su velocidad libre).
const MAX = { autopista: 1.3, principal: 1.45, urbana: 1.7, local: 1.2 };

const at = (arr, h) => {
  const i = Math.floor(h), t = h - i;
  return arr[i % 24] * (1 - t) + arr[(i + 1) % 24] * t;
};

/** Perfil para un momento: multiplicadores por tipo de vía y una etiqueta para la interfaz. */
export function trafficProfile(date = new Date()) {
  const day = date.getDay(); // 0 domingo … 6 sábado
  const h = date.getHours() + date.getMinutes() / 60;
  const base = day === 0 ? SUNDAY : day === 6 ? SATURDAY : WEEKDAY;
  let city = at(base, h);
  let road = city;
  if (day === 5 && h >= 14 && h < 21) road = Math.max(road, 0.7); // salida de fin de semana
  if (day === 0 && h >= 17 && h < 22) road = Math.max(road, 0.6); // retorno del domingo
  const f = [
    1 + road * (MAX.autopista - 1),
    1 + Math.max(city, road * 0.6) * (MAX.principal - 1),
    1 + city * (MAX.urbana - 1),
    1 + city * (MAX.local - 1),
  ];
  const peak = Math.max(city, road);
  const label = peak >= 0.75 ? 'hora punta' : peak >= 0.4 ? 'tráfico moderado' : peak >= 0.15 ? 'tráfico ligero' : 'vía libre';
  return { f, label, peak };
}

/** Multiplicador de un tramo según su velocidad libre (m/s). */
export function trafficFactor(prof, freeSpeed) {
  if (!prof) return 1;
  return freeSpeed >= 25 ? prof.f[0] : freeSpeed >= 15 ? prof.f[1] : freeSpeed >= 8 ? prof.f[2] : prof.f[3];
}
