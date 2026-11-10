// Indicaciones de carril a partir de turn:lanes de OpenStreetMap
// ("left|through|through;right": un carril por «|», varias flechas por «;»).
// Código puro: lo usan el worker (al describir la ruta), la app (para dibujarlos) y los tests.

const SIDE_L = ['sharp_left', 'left', 'slight_left', 'merge_to_left'];
const SIDE_R = ['sharp_right', 'right', 'slight_right', 'merge_to_right'];

/** Carriles válidos para una maniobra. mod: straight | slight | turn | sharp | uturn; angle: <0 izquierda. */
export function lanesFor(raw, mod, angle) {
  if (!raw) return null;
  const lanes = raw.split('|').map((l) => (l.trim() ? l.trim().split(';').map((x) => x.trim()) : ['none']));
  if (lanes.length < 2) return null;
  const left = angle < 0;
  const want = (ind) => {
    if (mod === 'straight') return ind.includes('through') || ind.includes('none');
    if (mod === 'uturn') return ind.includes('reverse') || ind.includes(left ? 'left' : 'right');
    const side = left ? SIDE_L : SIDE_R;
    if (mod === 'slight') return ind.some((x) => side.includes(x)) || ind.includes('through');
    return ind.some((x) => side.includes(x) && (mod !== 'sharp' || x !== `slight_${left ? 'left' : 'right'}`));
  };
  let ok = lanes.map(want);
  // En un giro suave, si hay carriles específicos de giro, solo valen esos (no los de «seguir recto»).
  if (mod === 'slight') {
    const strict = lanes.map((ind) => ind.some((x) => (left ? SIDE_L : SIDE_R).includes(x)));
    if (strict.some(Boolean)) ok = strict;
  }
  if (!ok.some(Boolean) || ok.every(Boolean)) return null; // nada que aclarar
  return lanes.map((ind, i) => ({ ind, ok: ok[i] }));
}

/** Frase para la voz: «usa el carril derecho», «usa los dos carriles de la izquierda»… */
export function lanesSpeech(lanes) {
  if (!lanes) return '';
  const n = lanes.length;
  const idx = lanes.map((l, i) => (l.ok ? i : -1)).filter((i) => i >= 0);
  const k = idx.length;
  const contiguous = idx[k - 1] - idx[0] === k - 1;
  if (!contiguous) return '';
  const num = ['', 'el', 'los dos', 'los tres', 'los cuatro'][k] || `los ${k}`;
  const carril = k === 1 ? 'carril' : 'carriles';
  if (idx[0] === 0) return k === 1 ? 'Usa el carril izquierdo' : `Usa ${num} ${carril} de la izquierda`;
  if (idx[k - 1] === n - 1) return k === 1 ? 'Usa el carril derecho' : `Usa ${num} ${carril} de la derecha`;
  return k === 1 ? 'Usa el carril central' : 'Usa los carriles centrales';
}

/** Ángulo de la flecha que se dibuja para una indicación de carril. */
export const LANE_ANGLE = {
  through: 0, none: 0, slight_left: -45, slight_right: 45, left: -90, right: 90,
  sharp_left: -135, sharp_right: 135, reverse: -180, merge_to_left: -30, merge_to_right: 30,
};
