import test from 'node:test';
import assert from 'node:assert/strict';

// Cada idioma en un proceso aparte (el idioma se decide al cargar el módulo).
const cases = {
  ca: [
    ['Gira a la derecha por Calle Mayor', /^Gira a la dreta per Calle Mayor$/],
    ['En la rotonda, toma la segunda salida hacia Burgos', /rotonda.*segona sortida cap a Burgos/i],
    ['Radar a 300 metros. Límite 50', /^Radar a 300 metres\. Límit 50$/],
    ['Has llegado a tu destino', /^Has arribat/],
  ],
  en: [
    ['Gira a la derecha por Calle Mayor', /^Turn right onto Calle Mayor$/],
    ['En la rotonda, toma la segunda salida hacia Burgos', /roundabout.*second exit towards Burgos/i],
    ['Radar a 300 metros. Límite 50', /300 metres\. Limit 50$/],
    ['Has llegado a tu destino', /arrived/i],
    ['Continúa recto', /straight/i],
  ],
};
for (const [lang, list] of Object.entries(cases)) {
  test(`frases de voz en ${lang}`, async () => {
    const store = { 'rumbo:settings': JSON.stringify({ lang }) };
    globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
    const url = new URL('../js/i18n.js', import.meta.url);
    url.search = '?' + lang;
    const i18n = await import(url.href);
    globalThis.document = { documentElement: {}, title: 'Rumbo', body: null };
    // carga el diccionario sin tocar el DOM
    const mod = await import(new URL(`../js/i18n-${lang}.js`, import.meta.url).href);
    i18n.__build(mod.default, lang);
    for (const [es, re] of list) assert.match(i18n.t(es), re, `${es} → ${i18n.t(es)}`);
  });
}
