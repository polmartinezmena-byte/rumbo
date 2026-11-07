// Preferencias del usuario (solo en este dispositivo, en localStorage).
const KEY = 'rumbo:settings';

export const DEFAULTS = {
  voice: true,               // indicaciones por voz
  alertFixed: true,          // radares fijos
  alertSection: true,        // radares de tramo
  alertRedLight: true,       // semáforos con cámara
  speedWarning: true,        // aviso al superar el límite
  speedMargin: 5,            // km/h de margen antes de avisar
  avoidTolls: false,
  floodMode: 'auto',         // auto | on | off
  emergencyNumber: '112',
  theme: 'auto',             // auto | light | dark
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
