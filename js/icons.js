// Iconos propios (trazo de 24 px, estilo de la app) en lugar de emojis. `iconize` cambia los emojis
// de un trozo de la interfaz por estos iconos; `drawIcon` los pinta en un canvas (iconos del mapa).

const P = {
  check: ['<path d="m5 12.5 4.5 4.5L19 7.5"/>', 'var(--ok)'],
  checkCircle: ['<circle cx="12" cy="12" r="9"/><path d="m7.5 12.5 3 3 6-6.5"/>', 'var(--ok)'],
  download: ['<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 17v3h16v-3"/>'],
  sun: ['<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', '#f59e0b'],
  sunRain: ['<path d="M8 3.5v1M3.5 8h1M5 5l.8.8"/><path d="M7.5 14a4.5 4.5 0 0 1 1-8.9A5.5 5.5 0 0 1 19 9a3.5 3.5 0 0 1-.5 7H9"/><path d="M10 19l-1 2M14 19l-1 2"/>', '#0ea5e9'],
  rain: ['<path d="M7 15a4 4 0 0 1-.6-8 6 6 0 0 1 11.4 1.5A3.5 3.5 0 0 1 17.5 15"/><path d="M9 18l-1 2M13 18l-1 2M17 18l-1 2"/>', '#0284c7'],
  storm: ['<path d="M7 15a4 4 0 0 1-.6-8 6 6 0 0 1 11.4 1.5A3.5 3.5 0 0 1 17.5 15"/><path d="m13 13-3 4h4l-3 4"/>', '#7c3aed'],
  dotRed: ['<circle cx="12" cy="12" r="6" fill="#dc2626" stroke="none"/>'],
  dotOrange: ['<circle cx="12" cy="12" r="6" fill="#ea580c" stroke="none"/>'],
  dotYellow: ['<circle cx="12" cy="12" r="6" fill="#eab308" stroke="none"/>'],
  noEntry: ['<circle cx="12" cy="12" r="9"/><path d="M7 12h10"/>', '#dc2626'],
  prohibited: ['<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>', '#dc2626'],
  water: ['<path d="M3 9c2 0 2-1.5 4.5-1.5S9.5 9 12 9s2.5-1.5 4.5-1.5S19 9 21 9M3 14c2 0 2-1.5 4.5-1.5S9.5 14 12 14s2.5-1.5 4.5-1.5S19 14 21 14M3 19c2 0 2-1.5 4.5-1.5S9.5 19 12 19s2.5-1.5 4.5-1.5S19 19 21 19"/>', '#2563eb'],
  crash: ['<path d="m12 2 2.2 5.4L20 6l-3 5 4 4-5.6.6L14 21l-2-4.5L10 21l-1.4-5.4L3 15l4-4-3-5 5.8 1.4z"/>', '#d97706'],
  works: ['<rect x="3" y="7" width="18" height="6" rx="1"/><path d="M7 7 4 13M13 7l-3 6M19 7l-3 6M6 13v7M18 13v7"/>', '#ea580c'],
  slow: ['<path d="M3 17h2M9 17h2M15 17h2"/><path d="M4 13l1.5-4h5L12 13M14 13l1.5-4h5L22 13"/><rect x="3" y="13" width="9" height="3" rx="1"/><rect x="13" y="13" width="9" height="3" rx="1"/>', '#ea580c'],
  snow: ['<path d="M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11"/><path d="m9 4 3 2 3-2M9 20l3-2 3 2"/>', '#0ea5e9'],
  warning: ['<path d="M12 3 2 20h20z"/><path d="M12 10v4.5M12 17.5v.3"/>', '#d97706'],
  fuel: ['<path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M3 21h13M15 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3"/><path d="M7 7h5"/>', '#0d9488'],
  shield: ['<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>', '#0284c7'],
  walk: ['<circle cx="13" cy="4" r="2"/><path d="m9 21 2-6 3 3v3M7 12l2-4 4 1 2 3 3 1"/><path d="m11 15-1-5"/>'],
  euro: ['<circle cx="12" cy="12" r="9"/><path d="M15 8.5a4 4 0 1 0 0 7M7.5 11h6M7.5 13.5h6"/>', '#d97706'],
  car: ['<path d="M5 17h14M6 17v2M18 17v2M4 13l2-6h12l2 6v4H4z"/><circle cx="8" cy="14.5" r="1"/><circle cx="16" cy="14.5" r="1"/>'],
  flag: ['<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>', 'var(--ok)'],
  parking: ['<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M10 17V7h3.5a3 3 0 0 1 0 6H10"/>', '#2563eb'],
  sos: ['<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>', '#dc2626'],
  gear: ['<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'],
};

const EMOJI = {
  '✔': 'check', '✅': 'checkCircle', '⬇': 'download', '☀': 'sun', '🌦': 'sunRain', '🌧': 'rain', '⛈': 'storm',
  '🔴': 'dotRed', '🟠': 'dotOrange', '🟡': 'dotYellow', '⛔': 'noEntry', '🚫': 'prohibited', '🌊': 'water', '💥': 'crash',
  '🚧': 'works', '🐢': 'slow', '❄': 'snow', '⚠': 'warning', '⛽': 'fuel', '🛟': 'shield', '🚶': 'walk', '💶': 'euro',
  '🚗': 'car', '🎉': 'flag', '🅿': 'parking', '🆘': 'sos', '⚙': 'gear', '📷': 'car',
};
const SRC = `(${Object.keys(EMOJI).join('|')})\\uFE0F?`;
const RE = new RegExp(SRC, 'gu');
const HAS = new RegExp(SRC, 'u'); // sin «g»: test() sin estado

export function ic(name) {
  const [body, color] = P[name] || P.warning;
  return `<svg class="ii" viewBox="0 0 24 24" aria-hidden="true"${color ? ` style="color:${color}"` : ''}>${body}</svg>`;
}

/** Cambia los emojis de los textos de `root` por iconos (no toca campos de texto ni el mapa). */
export function iconize(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (HAS.test(n.nodeValue) && !n.parentElement?.closest('input, textarea, .maplibregl-canvas-container, pre') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    RE.lastIndex = 0;
    const html = n.nodeValue.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
      .replace(RE, (_, e) => ic(EMOJI[e])).replace(/(<\/svg>)\s+/g, '$1 ');
    const span = document.createElement('span');
    span.innerHTML = html;
    n.replaceWith(...span.childNodes);
  }
}

/** Vigila partes de la interfaz y cambia los emojis en cuanto aparecen. */
export function autoIconize(roots) {
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') iconize(m.target.parentElement);
      else for (const n of m.addedNodes) iconize(n.nodeType === 3 ? n.parentElement : n);
    }
  });
  for (const r of roots) if (r) { iconize(r); obs.observe(r, { childList: true, subtree: true, characterData: true }); }
}

/** Pinta un icono (blanco o del color dado) centrado en un canvas 2D. */
export function drawIcon(ctx, name, cx, cy, size, color = '#fff') {
  const [body] = P[name] || P.warning;
  const s = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const m of body.matchAll(/<(path|circle|rect)([^>]*)\/>/g)) {
    const a = Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const p = new Path2D();
    if (m[1] === 'path') p.addPath(new Path2D(a.d));
    else if (m[1] === 'circle') p.arc(+a.cx, +a.cy, +a.r, 0, Math.PI * 2);
    else if (p.roundRect) p.roundRect(+a.x, +a.y, +a.width, +a.height, +(a.rx || 0)); else p.rect(+a.x, +a.y, +a.width, +a.height);
    if (a.fill && a.fill !== 'none') { ctx.fillStyle = a.fill; ctx.fill(p); ctx.fillStyle = color; } else ctx.stroke(p);
  }
  ctx.restore();
}
