// Zonas inundables oficiales para el generador de paquetes: igual que js/flood-zones.js pero
// guardando cada capa descargada en disco para no repetir descargas.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { floodGrid as coreGrid, fetchLayer, LAYERS } from '../js/flood-zones.js';

export { LAYERS };

export function floodGrid(b, cacheDir, log = console.log) {
  mkdirSync(cacheDir, { recursive: true });
  const cached = async (layer, box, lg) => {
    const key = [box.s, box.w, box.n, box.e].map((v) => v.toFixed(3)).join('_');
    const f = join(cacheDir, `${layer}_${key}.json`);
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
    const geoms = await fetchLayer(layer, box, lg);
    writeFileSync(f, JSON.stringify(geoms));
    return geoms;
  };
  return coreGrid(b, log, cached);
}
