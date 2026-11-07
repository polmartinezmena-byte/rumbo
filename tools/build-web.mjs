#!/usr/bin/env node
// Copia la web a www/ para empaquetarla en la app nativa (Capacitor). Sin service worker ni
// paquetes de mapas: la app los descarga de la web publicada (js/config.js).
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'www');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const f of ['index.html', 'privacidad.html', 'icon.svg', 'manifest.webmanifest', 'css', 'js', 'icons']) {
  cpSync(join(ROOT, f), join(OUT, f), { recursive: true });
}
// MapLibre dentro de la app (en la web se usa el CDN): así arranca sin conexión.
mkdirSync(join(OUT, 'vendor'));
for (const f of ['maplibre-gl.js', 'maplibre-gl.css']) cpSync(join(ROOT, 'node_modules/maplibre-gl/dist', f), join(OUT, 'vendor', f));
const html = readFileSync(join(OUT, 'index.html'), 'utf8')
  .replace('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css', 'vendor/maplibre-gl.css')
  .replace('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'vendor/maplibre-gl.js');
if (!html.includes('vendor/maplibre-gl.js')) throw new Error('index.html: no se encontró la URL de MapLibre');
writeFileSync(join(OUT, 'index.html'), html);
console.log('www/ lista');
