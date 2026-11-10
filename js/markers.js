// Iconos para tu posición mientras conduces: dibujos propios vistos desde arriba y apuntando hacia
// arriba (el mapa los gira con tu rumbo). Se eligen en Ajustes → Apariencia.

export const MARKER_COLORS = {
  azul: '#2563eb', rojo: '#dc2626', verde: '#16a34a', naranja: '#ea580c', morado: '#7c3aed', negro: '#111827',
};

const W = 'stroke="#fff" stroke-linejoin="round"';
const ICONS = {
  flecha: { name: 'Flecha', svg: (c) => `<path d="M24 4 40 42 24 34 8 42z" fill="${c}" ${W} stroke-width="3"/>` },
  coche: {
    name: 'Coche',
    svg: (c) => `<rect x="10.5" y="17" width="4" height="3.4" rx="1.4" fill="${c}"/><rect x="33.5" y="17" width="4" height="3.4" rx="1.4" fill="${c}"/>
      <rect x="13.5" y="5" width="21" height="38" rx="8.5" fill="${c}" ${W} stroke-width="2.5"/>
      <path d="M17 18.5c4.4-2.6 9.6-2.6 14 0l-1.4 5.5h-11.2z" fill="#dbeafe" opacity=".92"/>
      <rect x="18" y="33" width="12" height="4.5" rx="2" fill="#dbeafe" opacity=".85"/>
      <rect x="17.5" y="25.5" width="13" height="6" rx="1.5" fill="#fff" opacity=".18"/>`,
  },
  moto: {
    name: 'Moto',
    svg: (c) => `<ellipse cx="24" cy="9" rx="3.2" ry="5.2" fill="#111827" ${W} stroke-width="1.5"/><ellipse cx="24" cy="39" rx="3.6" ry="5.6" fill="#111827" ${W} stroke-width="1.5"/>
      <rect x="19.5" y="11" width="9" height="26" rx="4.5" fill="${c}" ${W} stroke-width="2"/>
      <rect x="13" y="13" width="22" height="3.2" rx="1.6" fill="#111827"/>
      <circle cx="24" cy="23" r="5" fill="#fff"/><circle cx="24" cy="23" r="3.4" fill="${c}"/>`,
  },
  furgoneta: {
    name: 'Furgoneta',
    svg: (c) => `<rect x="12.5" y="3.5" width="23" height="41" rx="6" fill="${c}" ${W} stroke-width="2.5"/>
      <path d="M15.5 12c5.6-2.2 11.4-2.2 17 0l-1 5h-15z" fill="#dbeafe" opacity=".92"/>
      <rect x="15.5" y="20" width="17" height="21" rx="2" fill="#fff" opacity=".16"/>
      <path d="M24 20v21" stroke="#fff" stroke-opacity=".35" stroke-width="1.2"/>`,
  },
  cohete: {
    name: 'Cohete',
    svg: (c) => `<path d="M21 35.5 24 44l3-8.5z" fill="#f97316"/>
      <path d="M18.5 26 11 37l7.5-2.5zM29.5 26 37 37l-7.5-2.5z" fill="${c}" ${W} stroke-width="1.6"/>
      <path d="M24 3c7 6.5 8 19 6 32.5H18C16 22 17 9.5 24 3z" fill="${c}" ${W} stroke-width="2.5"/>
      <circle cx="24" cy="16" r="3.8" fill="#fff"/><circle cx="24" cy="16" r="2.2" fill="#93c5fd"/>`,
  },
  punto: {
    name: 'Punto',
    svg: (c) => `<path d="M24 3 32 16H16z" fill="${c}" opacity=".55"/><circle cx="24" cy="25" r="10" fill="${c}" ${W} stroke-width="3.5"/>`,
  },
};

export const MARKER_ICONS = Object.fromEntries(Object.entries(ICONS).map(([k, v]) => [k, v.name]));

/** SVG completo del icono elegido. */
export function markerSvg(icon = 'flecha', color = 'azul') {
  const c = MARKER_COLORS[color] || MARKER_COLORS.azul;
  const draw = (ICONS[icon] || ICONS.flecha).svg;
  return `<svg viewBox="0 0 48 48" aria-hidden="true">${draw(c)}</svg>`;
}
