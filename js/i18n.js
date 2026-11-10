// Idiomas: la app está escrita en español; en catalán o inglés se traduce lo que se ve y lo que se oye.
// Las traducciones (js/i18n-ca.js, js/i18n-en.js) usan como clave la frase original; lo variable va
// como {0}, {1}… («Gira a la {0} por {1}» → «Gira a la {0} per {1}»), y lo variable también se traduce
// si es una palabra conocida («derecha» → «dreta»). Las frases se sacan con tools/i18n-extract.mjs.
import { settings } from './settings.js';

export const LANGS = { es: 'Español', ca: 'Català', en: 'English' };
const VOICE = { es: 'es-ES', ca: 'ca-ES', en: 'en-GB' };

function resolve(pref) {
  if (LANGS[pref]) return pref;
  const nav = (globalThis.navigator?.languages || [globalThis.navigator?.language || 'es']).map((l) => String(l).toLowerCase());
  for (const l of nav) {
    if (l.startsWith('ca') || l.startsWith('va')) return 'ca';
    if (l.startsWith('es') || l.startsWith('gl') || l.startsWith('eu')) return 'es';
    if (l.startsWith('en')) return 'en';
  }
  return nav[0]?.startsWith('es') ? 'es' : 'en';
}

export const LANG = resolve(settings.lang);
export const voiceLang = () => VOICE[LANG];
let L = LANG; // idioma de las traducciones (los tests lo cambian)

let exact = null;     // Map frase → traducción
let pats = [];        // [{ re, out, lit }] para frases con partes variables

function build(dict) {
  exact = new Map();
  pats = [];
  for (const [k, v] of Object.entries(dict)) {
    if (!/\{\d+\}/.test(k)) { exact.set(k, v); continue; }
    // Cada parte variable puede ir vacía (p. ej. «Gira a la {0}{1}» con {1} = « por Calle Mayor» o nada);
    // la última se lleva el resto de la frase.
    const last = [...k.matchAll(/\{(\d+)\}/g)].pop()[1];
    const esc = k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\d+)\}/g, (_, n) => (n === last ? `(?<g${n}>.*)` : `(?<g${n}>.*?)`));
    // el trozo fijo más largo sirve para descartar rápido
    const lit = k.split(/\{\d+\}/).sort((a, b) => b.length - a.length)[0];
    pats.push({ re: new RegExp(`^${esc}$`, 's'), out: v, lit });
  }
  // primero las más específicas (más texto fijo)
  pats.sort((a, b) => b.lit.length - a.lit.length);
}

/** Traduce una frase (o la deja igual si no hay traducción). */
export function t(s) {
  if (!exact || s == null) return s;
  const str = String(s);
  const m = str.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const core = m[2].replace(/\s+/g, ' ');
  if (!core) return str;
  let out = tr(core, 0);
  if (L === 'en') out = out.replace(/(\d),(\d)/g, '$1.$2'); // 1,2 km → 1.2 km
  return m[1] + out + m[3];
}

// Coletillas que la app añade a muchas frases («… por Calle Mayor», «… hacia Burgos», «. Límite 50»).
const TAILS = {
  ca: [[/^ por (.+)$/, ' per $1'], [/^ hacia (.+)$/, ' cap a $1'], [/^ a (.+)$/, ' a $1'], [/^ en (.+)$/, ' a $1'],
    [/^\. Límite (\d+)$/, '. Límit $1'], [/^\. Mantén la media por debajo de (\d+)$/, '. Mantén la mitjana per sota de $1'],
    [/^ · datos de hace (\d+) min$/, ' · dades de fa $1 min']],
  en: [[/^ por (.+)$/, ' onto $1'], [/^ hacia (.+)$/, ' towards $1'], [/^ a (.+)$/, ' to $1'], [/^ en (.+)$/, ' in $1'],
    [/^\. Límite (\d+)$/, '. Limit $1'], [/^\. Mantén la media por debajo de (\d+)$/, '. Keep your average below $1'],
    [/^ · datos de hace (\d+) min$/, ' · data from $1 min ago']],
};
const TAIL_RE = /( por .+| hacia .+|\. Límite \d+|\. Mantén la media por debajo de \d+| · datos de hace \d+ min)$/;

function tr(core, depth) {
  if (!core) return core;
  const hit = exact.get(core);
  if (hit != null) return hit;
  if (depth > 3) return core;
  // coletilla suelta (lo que llega como parte variable de otra frase)
  for (const [re, rep] of TAILS[L] || []) if (re.test(core) && depth > 0) return core.replace(re, (...a) => rep.replace('$1', tr(a[1], depth + 1)));
  for (const p of pats) {
    if (p.lit && !core.includes(p.lit)) continue;
    const g = core.match(p.re);
    if (!g) continue;
    return p.out.replace(/\{(\d+)\}/g, (_, n) => tr(g.groups[`g${n}`] ?? '', depth + 1));
  }
  // Frase + coletilla: se traducen por separado.
  const tail = core.match(TAIL_RE);
  if (tail && tail.index > 0) {
    const head = core.slice(0, tail.index);
    const h = tr(head, depth + 1);
    if (h !== head) return h + tr(tail[1], depth + 1);
  }
  // Trozos separados por « · » («Farmacia · Calle Mayor, Logroño · 70 m»): uno a uno.
  if (core.includes(' · ')) {
    const parts = core.split(' · ');
    const outp = parts.map((x) => tr(x, depth + 1));
    if (outp.some((x, i) => x !== parts[i])) return outp.join(' · ');
  }
  // Varias frases seguidas («Gira a la derecha. Usa el carril izquierdo»): una a una.
  if (/\. [A-ZÁÉÍÓÚ¿¡]/.test(core)) {
    const parts = core.split(/(?<=\.) (?=[A-ZÁÉÍÓÚ¿¡])/);
    if (parts.length > 1) return parts.map((s) => tr(s, depth + 1)).join(' ');
  }
  return core;
}

// ------------------------------------------------------------------ traducción de la página
const done = new WeakMap(); // nodo → último texto que pusimos (para no traducir dos veces)
const ATTRS = ['placeholder', 'title', 'aria-label'];

function translateNode(n) {
  if (n.nodeType === 3) {
    const p = n.parentNode;
    if (!p || p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE' || p.closest?.('[data-no-i18n], pre, input, textarea')) return;
    if (done.get(n) === n.data) return;
    const out = t(n.data);
    if (out !== n.data) n.data = out;
    done.set(n, n.data);
    return;
  }
  if (n.nodeType !== 1 || n.closest?.('[data-no-i18n]')) return;
  for (const a of ATTRS) {
    const v = n.getAttribute?.(a);
    if (v) { const o = t(v); if (o !== v) n.setAttribute(a, o); }
  }
  const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let c;
  while ((c = w.nextNode())) {
    if (c.nodeType === 3) translateNode(c);
    else for (const a of ATTRS) { const v = c.getAttribute(a); if (v) { const o = t(v); if (o !== v) c.setAttribute(a, o); } }
  }
}

/** Solo para los tests: carga un diccionario sin tocar la página. */
export const __build = (dict, lang) => { L = lang || L; build(dict); };

/** Carga el idioma y traduce la página (y todo lo que se pinte después). */
export async function initI18n() {
  document.documentElement.lang = LANG;
  if (LANG === 'es') return;
  try {
    const mod = await import(`./i18n-${LANG}.js`);
    build(mod.default || {});
  } catch (e) { console.warn('i18n', e); return; }
  document.title = t(document.title);
  translateNode(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') translateNode(m.target);
      else if (m.type === 'attributes') { const v = m.target.getAttribute(m.attributeName); if (v) { const o = t(v); if (o !== v) m.target.setAttribute(m.attributeName, o); } }
      else for (const n of m.addedNodes) translateNode(n);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
