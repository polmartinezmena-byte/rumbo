import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryOf, houseNumberOf, typeLabel } from '../js/search-online.js';

test('categorías', () => {
  assert.equal(categoryOf('Gasolinera'), 'amenity:fuel');
  assert.equal(categoryOf('farmacias cerca'), 'amenity:pharmacy');
  assert.equal(categoryOf('un supermercado'), 'shop:supermarket');
  assert.equal(categoryOf('Mercadona'), null);
});

test('número de portal', () => {
  assert.equal(houseNumberOf('gran via 30 madrid'), '30');
  assert.equal(houseNumberOf('Calle Mayor, 12 b, Logroño'), '12');
  assert.equal(houseNumberOf('calle 12 de octubre'), null);
  assert.equal(houseNumberOf('mercadona'), null);
});

test('tipos en español', () => {
  assert.equal(typeLabel('shop', 'supermarket'), 'Supermercado');
  assert.equal(typeLabel('shop', 'xyz'), 'Tienda');
  assert.equal(typeLabel('highway', 'residential'), 'Calle');
});
