// Sitúa en el mapa los semáforos con cámara de tools/fotovermell.json: busca el nodo donde se
// cruzan las dos calles (por nombre, cerca del centro del municipio) en las vías de OpenStreetMap.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(carrer|calle|avinguda|avenida|av|passeig|paseo|carretera|ctra|rambla|placa|plaza|ronda|via|de|del|dels|de la|la|el|les|los|las|d|i|y)\b/g, ' ')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param ways     [{nodes, tags}] vías del grafo (con nombre)
 * @param coordOf  id → [lat, lon]
 * @returns { found: [{lat, lon, ...}], missing: [entrada] }
 */
export function locateRedLights(ways, coordOf, bbox, root) {
  const { items } = JSON.parse(readFileSync(join(root, 'tools', 'fotovermell.json'), 'utf8'));
  const found = [], missing = [];
  for (const it of items) {
    const [cla, clo] = it.center;
    if (cla < bbox.s || cla > bbox.n || clo < bbox.w || clo > bbox.e) continue;
    if (!it.b) { missing.push(it); continue; }
    const near = (id) => { const c = coordOf(id); return c && Math.abs(c[0] - cla) < 0.06 && Math.abs(c[1] - clo) < 0.08 ? c : null; };
    const na = norm(it.a), nb = norm(it.b);
    const nodesA = new Set(), nodesB = new Set();
    for (const w of ways) {
      const n = norm(w.tags.name || '');
      if (!n) continue;
      const isA = n === na || n.includes(na), isB = n === nb || n.includes(nb);
      if (!isA && !isB) continue;
      for (const id of w.nodes) {
        if (!near(id)) continue;
        if (isA) nodesA.add(id);
        if (isB) nodesB.add(id);
      }
    }
    const shared = [...nodesA].filter((id) => nodesB.has(id));
    if (!shared.length) { missing.push(it); continue; }
    // Si se cruzan en varios nodos (calzadas separadas), se usa el punto medio.
    const pts = shared.map(coordOf);
    const lat = pts.reduce((s, p) => s + p[0], 0) / pts.length, lon = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    found.push({ lat, lon, speed: 0, kind: 'red_light', src: 'prensa', name: `${it.a} / ${it.b}`, source: it.source });
  }
  return { found, missing };
}
