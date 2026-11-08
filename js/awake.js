// Pantalla encendida. Cada motivo ('nav', 'descarga', 'siempre') la pide y la suelta por separado:
// la pantalla puede apagarse solo cuando no queda ninguno.
//   · App nativa: plugin KeepAwake.
//   · Navegador: Screen Wake Lock. El navegador la suelta al cambiar de app o bloquear el móvil,
//     así que se vuelve a pedir al volver a la página.
//   · Donde no hay Wake Lock o no funciona (Chrome y Safari en iPhone antiguos, accesos directos
//     en la pantalla de inicio de iOS): un vídeo diminuto, mudo e invisible en bucle.
import { media } from './vendor/nosleep-media.js';

const reasons = new Set();
const plugins = () => globalThis.Capacitor?.Plugins || {};
const isNative = () => !!globalThis.Capacitor?.isNativePlatform?.();
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let sentinel = null, video = null, nativeOn = false, pending = null;

function makeVideo() {
  const v = document.createElement('video');
  v.setAttribute('playsinline', '');
  v.setAttribute('muted', '');
  v.setAttribute('aria-hidden', 'true');
  v.muted = true;
  v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  for (const [type, src] of [['webm', media.webm], ['mp4', media.mp4]]) {
    const s = document.createElement('source');
    s.src = src;
    s.type = `video/${type}`;
    v.appendChild(s);
  }
  v.addEventListener('loadedmetadata', () => {
    if (v.duration <= 1) v.loop = true;
    else v.addEventListener('timeupdate', () => { if (v.currentTime > 0.5) v.currentTime = Math.random(); });
  });
  document.body.appendChild(v);
  return v;
}

async function acquire() {
  if (!reasons.size || document.hidden) return;
  if (isNative() && plugins().KeepAwake) {
    if (!nativeOn) { await plugins().KeepAwake.keepAwake().catch(() => {}); nativeOn = true; }
    return;
  }
  if ('wakeLock' in navigator && !sentinel) {
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch {
      sentinel = null;
    }
  }
  // En iOS, Wake Lock no siempre funciona en accesos directos: el vídeo va de refuerzo.
  if (!sentinel || isIOS()) {
    video ??= makeVideo();
    if (video.paused) await video.play().catch(() => {}); // si falla, se reintenta al tocar la pantalla
  }
}

function release() {
  if (nativeOn) { plugins().KeepAwake?.allowSleep().catch?.(() => {}); nativeOn = false; }
  sentinel?.release?.().catch?.(() => {});
  sentinel = null;
  video?.pause();
}

const refresh = () => {
  pending = (pending || Promise.resolve()).then(() => (reasons.size ? acquire() : release())).catch(() => {});
  return pending;
};

/** Pide que la pantalla no se apague por un motivo. */
export function keepAwake(reason = 'nav') {
  reasons.add(reason);
  return refresh();
}

/** Ya no hace falta por ese motivo (si no queda ninguno, se puede apagar). */
export function allowSleep(reason = 'nav') {
  reasons.delete(reason);
  return refresh();
}

export const isAwakeWanted = () => reasons.size > 0;

if (typeof document !== 'undefined') {
  // Al volver a la app (o salir de pantalla completa) el navegador ha soltado el bloqueo: se pide otra vez.
  const again = () => { if (!document.hidden && reasons.size) refresh(); };
  document.addEventListener('visibilitychange', again);
  document.addEventListener('fullscreenchange', again);
  // Algunos navegadores solo dejan reproducir el vídeo tras un toque.
  document.addEventListener('pointerdown', () => { if (reasons.size && (!sentinel || isIOS()) && (!video || video.paused)) refresh(); }, { passive: true });
}
