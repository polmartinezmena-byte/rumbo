// Preferencias del usuario (solo en este dispositivo, en localStorage).
const KEY = 'rumbo:settings';

export const DEFAULTS = {
  lang: 'auto',              // idioma: auto (el del teléfono) | es | ca | en
  voice: true,               // indicaciones por voz
  alertFixed: true,          // radares fijos
  alertSection: true,        // radares de tramo
  alertRedLight: true,       // semáforos con cámara
  freeDrive: true,           // avisos también conduciendo sin ruta
  chime: true,               // sonido suave antes de cada indicación
  traffic: true,             // tráfico típico por franja horaria en rutas y tiempos de llegada
  speedWarning: true,        // aviso al superar el límite
  speedMargin: 5,            // km/h de margen antes de avisar
  avoidTolls: false,
  floodMode: 'auto',         // auto | on | off
  emergencyNumber: '112',
  theme: 'auto',             // auto | light | dark
  mapNight: 'auto',          // mapa oscuro: auto (de noche) | on | off
  markerIcon: 'flecha',      // icono de tu posición al conducir (js/markers.js)
  markerColor: 'azul',
  screenAlways: false,       // pantalla encendida con la app abierta (si no, solo al navegar y al descargar)
  sticker: '',               // etiqueta DGT: '0' | 'ECO' | 'C' | 'B' | 'A' (sin etiqueta) | '' (no lo sé)
  avoidZbe: true,            // evitar las ZBE donde la etiqueta no puede entrar
  fuel: 'g95',               // g95 | g98 | diesel | dieselp | glp | '' (eléctrico)
  showFuel: true,            // precios en el mapa
  showIncidents: true,       // incidencias de la DGT en el mapa
  // Edificios en 3D: solo por defecto en dispositivos potentes (en móviles modestos restan fluidez).
  buildings3d: (globalThis.navigator?.hardwareConcurrency || 4) >= 6 && (globalThis.navigator?.deviceMemory ?? 8) >= 4,
};

let current = { ...DEFAULTS };
const listeners = new Set();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    // Migración: antes estas dos opciones se guardaban por separado.
    const legacy = {};
    const lt = localStorage.getItem('rumbo:avoidTolls');
    const lf = localStorage.getItem('rumbo:floodMode');
    if (lt !== null) legacy.avoidTolls = JSON.parse(lt);
    if (lf !== null) legacy.floodMode = JSON.parse(lf);
    current = { ...DEFAULTS, ...legacy, ...(saved || {}) };
  } catch {
    current = { ...DEFAULTS };
  }
}
load();

export const settings = new Proxy({}, { get: (_, k) => current[k] });

export function setSetting(key, value) {
  if (current[key] === value) return;
  current[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* sin almacenamiento */ }
  for (const fn of listeners) fn(key, value);
}

export const onSettingChange = (fn) => listeners.add(fn);

export function applyTheme() {
  const t = current.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
