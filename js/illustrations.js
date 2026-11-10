// Ilustraciones propias (líneas sencillas con la paleta de la app) para la bienvenida y las pantallas
// vacías. Usan variables CSS, así se ven bien en claro y en oscuro.
const A = 'var(--primary)', S = 'var(--surface-2)', L = 'var(--line-strong)', T = 'var(--text)', OK = 'var(--ok)', D = 'var(--danger)';
const svg = (body) => `<svg viewBox="0 0 200 130" aria-hidden="true" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ART = {
  welcome: svg(`<ellipse cx="100" cy="118" rx="70" ry="6" fill="${S}"/>
    <rect x="62" y="10" width="76" height="104" rx="14" fill="${S}" stroke="${T}" stroke-width="3"/>
    <path d="M70 34h60M70 58h60M70 82h60M86 22v86M114 22v86" stroke="${L}" stroke-width="2"/>
    <path d="M76 98c10-14 8-26 22-34s24-6 28-26" stroke="${A}" stroke-width="5"/>
    <circle cx="76" cy="98" r="6" fill="${OK}"/><path d="M126 30a8 8 0 1 0-16 0c0 7 8 14 8 14s8-7 8-14z" fill="${D}"/><circle cx="118" cy="30" r="2.8" fill="#fff"/>`),
  location: svg(`<ellipse cx="100" cy="112" rx="56" ry="10" stroke="${L}" stroke-width="2"/><ellipse cx="100" cy="112" rx="32" ry="6" stroke="${A}" stroke-width="2.5" opacity=".6"/>
    <path d="M128 52a28 28 0 1 0-56 0c0 24 28 56 28 56s28-32 28-56z" fill="${A}" stroke="${A}" stroke-width="3"/>
    <circle cx="100" cy="52" r="10" fill="#fff"/>`),
  download: svg(`<path d="M58 70a22 22 0 0 1 4-43 30 30 0 0 1 57 6 18 18 0 0 1 21 37" stroke="${T}" stroke-width="3" fill="${S}"/>
    <path d="M100 46v50m0 0-14-14m14 14 14-14" stroke="${A}" stroke-width="5"/>
    <rect x="70" y="102" width="60" height="16" rx="5" fill="${S}" stroke="${T}" stroke-width="3"/><path d="M80 110h22" stroke="${OK}" stroke-width="4"/>`),
  sos: svg(`<path d="M100 14 56 30v32c0 28 19 44 44 52 25-8 44-24 44-52V30z" fill="${S}" stroke="${T}" stroke-width="3"/>
    <path d="M100 42c-6-10-24-8-24 6 0 12 24 26 24 26s24-14 24-26c0-14-18-16-24-6z" fill="${D}"/>`),
  search: svg(`<circle cx="88" cy="58" r="34" fill="${S}" stroke="${T}" stroke-width="3"/><path d="m113 83 26 26" stroke="${T}" stroke-width="7"/>
    <path d="M78 50a10 10 0 1 1 14 9c-3 2-4 4-4 7" stroke="${A}" stroke-width="4"/><circle cx="88" cy="76" r="2.5" fill="${A}"/>`),
  offline: svg(`<path d="M58 84a22 22 0 0 1 4-43 30 30 0 0 1 57 6 18 18 0 0 1 21 37z" fill="${S}" stroke="${T}" stroke-width="3"/>
    <path d="m62 24 82 82" stroke="${D}" stroke-width="5"/>`),
  maps: svg(`<path d="M52 30 82 18l36 12 30-12v82l-30 12-36-12-30 12z" fill="${S}" stroke="${T}" stroke-width="3"/>
    <path d="M82 18v82M118 30v82" stroke="${L}" stroke-width="2.5"/><path d="M62 82c12-8 20-24 36-22s22-20 40-24" stroke="${A}" stroke-width="4" stroke-dasharray="1 9"/>`),
  star: svg(`<path d="m100 14 14 30 32 4-24 22 6 32-28-15-28 15 6-32-24-22 32-4z" fill="${S}" stroke="${T}" stroke-width="3"/>
    <path d="m100 40 6 12 13 2-10 9 3 13-12-7-12 7 3-13-10-9 13-2z" fill="${A}"/>`),
};

/** Pantalla vacía: ilustración + título + texto (+ botón opcional). */
export function emptyState(art, title, text, btn = '') {
  return `<div class="empty-state">${ART[art] || ''}<b>${title}</b>${text ? `<span>${text}</span>` : ''}${btn}</div>`;
}
