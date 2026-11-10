#!/usr/bin/env node
// Saca todas las frases en español de la interfaz (index.html y los .js) para traducirlas.
// Cada frase es un trozo de texto entre etiquetas HTML; lo variable (${…}) se escribe como {0}, {1}…
//   node tools/i18n-extract.mjs > tools/i18n-strings.json
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const files = ['index.html', ...readdirSync(new URL('js/', ROOT)).filter((f) => f.endsWith('.js') && !/^i18n/.test(f)).map((f) => 'js/' + f)];
const SKIP_FILES = /graph-build|pack\.js|db\.js|config\.js|native\.js|icons\.js|markers\.js|map-brand|map-offline|offline-tiles|nosleep/;
const out = new Set();

const looksSpanish = (s) => /[a-záéíóúñ]{3,}/i.test(s) && /\s|[áéíóúñ¿¡]/.test(s.replace(/\{\d+\}/g, '')) &&
  !/^[\s{}\d#.:;,()=<>/*+-]*$/.test(s) && !/https?:|\.js\b|\.css\b|px\b|rgba?\(|var\(--|=>|\bconst\b|\bfunction\b|querySelector|^[a-z-]+:[^ ]/.test(s);

function addTemplate(raw) {
  // ${…} anidados → {n}
  let s = '', depth = 0, n = 0;
  for (let i = 0; i < raw.length; i++) {
    if (depth === 0 && raw[i] === '$' && raw[i + 1] === '{') { depth = 1; i++; s += `{${n++}}`; continue; }
    if (depth > 0) { if (raw[i] === '{') depth++; else if (raw[i] === '}') depth--; continue; }
    s += raw[i];
  }
  addText(s);
}
function addText(s) {
  // Trozos entre etiquetas; se renumeran los {n} de cada trozo.
  for (let part of s.split(/<[^>]*>/)) {
    part = part.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!part) continue;
    let k = 0;
    part = part.replace(/\{\d+\}/g, () => `{${k++}}`);
    // quitar bordes que son solo variables o signos
    const core = part.replace(/^(\{\d+\}|[·,.:;()\s-])+|(\{\d+\}|[·,:;(\s-])+$/g, '');
    if (looksSpanish(core)) out.add(part);
  }
}

for (const f of files) {
  if (SKIP_FILES.test(f)) continue;
  let src = readFileSync(new URL(f, ROOT), 'utf8');
  if (f.endsWith('.html')) {
    src = src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
    for (const m of src.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)) addText(m[1]);
    addText(src.replace(/<!--[\s\S]*?-->/g, ''));
    continue;
  }
  src = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // literales: `…`, '…', "…"
  const re = /`((?:\\.|[^`\\])*)`|'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"/g;
  for (const m of src.matchAll(re)) {
    if (m[1] != null) addTemplate(m[1].replace(/\\`/g, '`'));
    else addText((m[2] ?? m[3]).replace(/\\'/g, "'"));
  }
}
console.log(JSON.stringify([...out].sort(), null, 1));
