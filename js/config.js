// Dónde se ejecuta Rumbo: web publicada, app nativa (Capacitor) o servidor de desarrollo.
// Funciona en la página y en el worker.
const loc = globalThis.location;

/** Servidor de desarrollo local (node dev-server.mjs → puerto 5173). */
export const DEV = loc?.port === '5173';

/** App nativa (Capacitor sirve los archivos desde https://localhost sin puerto). */
export const NATIVE = !!globalThis.Capacitor?.isNativePlatform?.() ||
  loc?.protocol === 'capacitor:' || (loc?.hostname === 'localhost' && !loc?.port);

/** Web publicada: de aquí salen los paquetes de comunidades cuando se usa la app nativa. */
export const SITE = 'https://polmartinezmena-byte.github.io/rumbo/';

/** Carpeta raíz de la app (la de index.html), tanto desde la página como desde js/graph-worker.js. */
function appRoot() {
  if (NATIVE) return SITE;
  const href = loc?.href || SITE;
  return /\/js\/[^/]+$/.test(new URL(href).pathname) ? new URL('../', href).href : new URL('./', href).href;
}

export const PACKS = appRoot() + 'packs/';
