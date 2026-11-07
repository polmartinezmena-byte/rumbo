import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePolyline } from '../js/online.js';
import { zoneAt, zbeOnCoords, zonesAlong, bannedZones } from '../js/live-route.js';

test('decodifica polilíneas (ejemplo de Google, 5 decimales)', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5), [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
});

const ring = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const live = {
  version: 1,
  zbe: {
    updated: 't',
    zones: [
      { name: 'Ciudad', restricted: ['A'], days: 'LF', times: ['00:00-23:59'], polys: [ring(0, 0, 10, 10)] },
      { name: 'Centro', restricted: ['C', 'B', 'A'], days: 'LF', times: ['00:00-23:59'], polys: [ring(4, 4, 6, 6)] },
    ],
  },
};

test('ZBE solapadas: manda la más restrictiva', () => {
  assert.equal(zoneAt(live, 5, 5), 1);
  assert.equal(zoneAt(live, 2, 2), 0);
  assert.equal(zoneAt(live, 20, 20), -1);
});

test('tramos de ZBE de una ruta online y si tu etiqueta puede entrar', () => {
  const coords = [[1, 5], [3, 5], [5, 5], [7, 5], [9, 5]];
  const route = { coords, cum: [0, 100, 200, 300, 400] };
  const now = new Date('2026-11-09T10:00:00').getTime(); // lunes
  const runs = zbeOnCoords(route, zonesAlong(route, live), live, { sticker: 'B', now });
  assert.deepEqual(runs.map((r) => [r.name, r.banned]), [['Ciudad', false], ['Centro', true], ['Ciudad', false]]);
  assert.deepEqual(bannedZones(live, { sticker: 'B', now }), [false, true]);
  assert.equal(bannedZones(live, { sticker: 'ECO', now }), null);
});
