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
for (const f of ['index.html', 'privacidad.html', 'icon.svg', 'manifest.webmanifest', 'css', 'js', 'icons', 'vendor']) {
  cpSync(join(ROOT, f), join(OUT, f), { recursive: true });
}
// MapLibre va en vendor/ (mismo origen que la app): arranca sin depender de un CDN.
if (!readFileSync(join(OUT, 'index.html'), 'utf8').includes('vendor/maplibre-gl.js')) throw new Error('index.html: falta vendor/maplibre-gl.js');
console.log('www/ lista');
