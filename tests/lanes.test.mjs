import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanesFor, lanesSpeech } from '../js/lanes.js';

const ok = (l) => l && l.map((x) => (x.ok ? 1 : 0)).join('');

test('giro a la izquierda: solo el carril de giro', () => {
  const l = lanesFor('left|through|through', 'turn', -90);
  assert.equal(ok(l), '100');
  assert.equal(lanesSpeech(l), 'Usa el carril izquierdo');
});

test('seguir recto con carriles de giro a los lados', () => {
  const l = lanesFor('left|through|through|right', 'straight', 0);
  assert.equal(ok(l), '0110');
  assert.equal(lanesSpeech(l), 'Usa los carriles centrales');
});

test('salida a la derecha con carril compartido', () => {
  const l = lanesFor('through|through|through;slight_right|slight_right', 'slight', 45);
  assert.equal(ok(l), '0011');
  assert.equal(lanesSpeech(l), 'Usa los dos carriles de la derecha');
});

test('si todos los carriles sirven o ninguno, no se indica nada', () => {
  assert.equal(lanesFor('through|through', 'straight', 0), null);
  assert.equal(lanesFor('left|left', 'turn', 90), null);
  assert.equal(lanesFor('through', 'straight', 0), null);
});

test('carril sin marcar cuenta como recto', () => {
  assert.equal(ok(lanesFor('left||', 'straight', 0)), '011');
});
