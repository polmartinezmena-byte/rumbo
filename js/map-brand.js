// Estilo de mapa propio de Rumbo, de día y de noche, a partir del estilo base de OpenFreeMap
// (mismos datos y mismas teselas: sigue funcionando sin conexión). Solo se cambian colores, grosores
// y qué se ve a cada zoom: menos ruido (paradas de bus y comercios solo de cerca), carreteras claras
// por jerarquía y etiquetas legibles. La noche sale del mismo estilo con otra paleta.

const DAY = {
  bg: '#f1f3f6', residential: '#eceef2', building: '#e1e5eb', building3d: '#e4e8ee',
  park: '#d4ebd7', wood: '#cbe5cf', grass: '#d9eedb', sand: '#f3efe3', ice: '#eef4f7',
  water: '#a9d3f6', waterLine: '#9ccbf2', aero: '#e7e9ee',
  minor: '#ffffff', minorCase: '#d9dde3', service: '#fafbfc',
  secondary: '#ffffff', secondaryCase: '#cfd5dd',
  primary: '#ffe7a8', primaryCase: '#ecc26a',
  motorway: '#ffc96b', motorwayCase: '#e09a3e',
  path: '#ffffff', rail: '#c6ccd5',
  label: '#1f2937', labelSoft: '#4b5563', halo: '#ffffff', poi: '#64748b', waterLabel: '#3b6ea8',
  boundary: '#a3acb9', hillshade: 0.25,
};
const NIGHT = {
  bg: '#0e1522', residential: '#121b2a', building: '#1a2333', building3d: '#1d2738',
  park: '#11261c', wood: '#10261b', grass: '#132a1f', sand: '#1b1d1f', ice: '#162130',
  water: '#0a2741', waterLine: '#123557', aero: '#151d2b',
  minor: '#273246', minorCase: '#182131', service: '#222c3d',
  secondary: '#323e54', secondaryCase: '#1b2434',
  primary: '#5a4a2b', primaryCase: '#2e2716',
  motorway: '#8a6430', motorwayCase: '#3d2c15',
  path: '#2a3447', rail: '#2c3647',
  label: '#e2e8f0', labelSoft: '#a3b1c6', halo: '#0e1522', poi: '#8796ad', waterLabel: '#6fa3d6',
  boundary: '#465266', hillshade: 0.12,
};

function roadColors(id, P) {
  const casing = id.endsWith('_casing');
  if (/motorway/.test(id)) return casing ? P.motorwayCase : P.motorway;
  if (/trunk_primary/.test(id)) return casing ? P.primaryCase : P.primary;
  if (/secondary_tertiary|_link/.test(id)) return casing ? P.secondaryCase : P.secondary;
  if (/service_track/.test(id)) return casing ? P.minorCase : P.service;
  if (/minor|street/.test(id)) return casing ? P.minorCase : P.minor;
  if (/path_pedestrian/.test(id)) return casing ? P.minorCase : P.path;
  if (/rail/.test(id)) return P.rail;
  return null;
}

/** Aplica la identidad de Rumbo a un estilo base (lo modifica y lo devuelve). */
export function brandStyle(style, dark = false) {
  const P = dark ? NIGHT : DAY;
  const set = (l, k, v) => { l.paint = l.paint || {}; l.paint[k] = v; };
  for (const l of style.layers) {
    const id = l.id;
    if (l.type === 'background') set(l, 'background-color', P.bg);
    else if (id === 'natural_earth') set(l, 'raster-opacity', P.hillshade);
    else if (id === 'landuse_residential') set(l, 'fill-color', P.residential);
    else if (id === 'park') set(l, 'fill-color', P.park);
    else if (id === 'park_outline') set(l, 'line-color', P.park);
    else if (id === 'landcover_wood') set(l, 'fill-color', P.wood);
    else if (id === 'landcover_grass' || id === 'landuse_pitch' || id === 'landuse_track' || id === 'landuse_cemetery') set(l, 'fill-color', P.grass);
    else if (id === 'landcover_sand') set(l, 'fill-color', P.sand);
    else if (id === 'landcover_ice') set(l, 'fill-color', P.ice);
    else if (id === 'landuse_hospital' || id === 'landuse_school') set(l, 'fill-color', P.residential);
    else if (id === 'water') set(l, 'fill-color', P.water);
    else if (id.startsWith('waterway_') && l.type === 'line') set(l, 'line-color', P.waterLine);
    else if (id.startsWith('aeroway_')) set(l, l.type === 'fill' ? 'fill-color' : 'line-color', P.aero);
    else if (id === 'building') { set(l, 'fill-color', P.building); set(l, 'fill-outline-color', P.building); }
    else if (id === 'building-3d') { set(l, 'fill-extrusion-color', P.building3d); set(l, 'fill-extrusion-opacity', dark ? 0.85 : 0.7); }
    else if (id.startsWith('boundary')) set(l, 'line-color', P.boundary);
    else if (id === 'road_area_pattern') set(l, 'fill-opacity', dark ? 0.08 : 0.45); // zonas peatonales rayadas
    else if (/shield/.test(id)) { set(l, 'icon-opacity', dark ? 0.7 : 1); if (l.layout?.['text-field']) set(l, 'text-opacity', dark ? 0.85 : 1); }
    else if (l.type === 'line' && /^(road|tunnel|bridge)_/.test(id)) {
      const c = roadColors(id, P);
      if (c) set(l, 'line-color', c);
      if (/hatching/.test(id)) set(l, 'line-opacity', 0.5);
    } else if (l.type === 'symbol') {
      // Menos ruido: comercios y paradas de transporte solo de cerca.
      if (/^poi_/.test(id)) {
        l.minzoom = Math.max(l.minzoom || 0, id === 'poi_transit' ? 15.5 : 16);
        set(l, 'text-color', P.poi);
        set(l, 'icon-opacity', 0.85);
      } else if (/^highway-name/.test(id)) set(l, 'text-color', P.labelSoft);
      else if (/^water/.test(id)) set(l, 'text-color', P.waterLabel);
      else if (/^label_/.test(id) || id === 'airport') set(l, 'text-color', id === 'label_other' ? P.labelSoft : P.label);
      if (l.layout?.['text-field']) { set(l, 'text-halo-color', P.halo); set(l, 'text-halo-width', 1.4); set(l, 'text-halo-blur', 0.4); }
    }
  }
  return style;
}
