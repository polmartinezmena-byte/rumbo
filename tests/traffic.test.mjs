import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trafficProfile, trafficFactor } from '../js/traffic.js';

const at = (s) => new Date(s); // hora local

test('hora punta entre semana: la ciudad se frena mucho más que la autopista', () => {
  const p = trafficProfile(at('2026-11-10T08:30:00')); // martes
  assert.equal(p.label, 'hora punta');
  assert.ok(trafficFactor(p, 10) > 1.5);          // calle urbana
  assert.ok(trafficFactor(p, 33) < trafficFactor(p, 10)); // autopista
});

test('de madrugada no hay tráfico', () => {
  const p = trafficProfile(at('2026-11-10T03:00:00'));
  assert.equal(p.label, 'vía libre');
  assert.equal(trafficFactor(p, 10), 1);
});

test('domingo por la tarde: retorno en autopistas', () => {
  const p = trafficProfile(at('2026-11-15T19:00:00')); // domingo
  assert.ok(trafficFactor(p, 33) >= 1.18);
});

test('sin perfil, sin cambios', () => {
  assert.equal(trafficFactor(null, 10), 1);
});
