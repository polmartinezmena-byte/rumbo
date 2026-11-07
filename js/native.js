// Funciones que en la app nativa (Capacitor) usan el sistema y en la web, la API del navegador.
// Los plugins nativos se registran en window.Capacitor.Plugins: no hace falta empaquetador.
const plugins = () => globalThis.Capacitor?.Plugins || {};
const isNative = () => !!globalThis.Capacitor?.isNativePlatform?.();

/** Mantiene la pantalla encendida (navegación, descargas). Devuelve un manejador para allowSleep. */
export async function keepAwake() {
  try {
    if (isNative() && plugins().KeepAwake) { await plugins().KeepAwake.keepAwake(); return 'native'; }
    return await navigator.wakeLock?.request('screen');
  } catch {
    return null;
  }
}

export function allowSleep(handle) {
  try {
    if (handle === 'native') plugins().KeepAwake?.allowSleep();
    else handle?.release?.();
  } catch { /* nada */ }
}

/**
 * Voz. El WebView de Android no implementa speechSynthesis: en la app se usa el motor de voz del
 * sistema (plugin TextToSpeech). Devuelve true si la ha usado.
 */
export function nativeSpeak(text) {
  const tts = isNative() && plugins().TextToSpeech;
  if (!tts) return false;
  tts.stop().catch(() => {}).finally(() => tts.speak({ text, lang: 'es-ES', rate: 1.0, pitch: 1.0, volume: 1.0, category: 'playback' }).catch(() => {}));
  return true;
}

export function nativeStop() {
  const tts = isNative() && plugins().TextToSpeech;
  if (tts) tts.stop().catch(() => {});
  return !!tts;
}
