import test from 'node:test';
import assert from 'node:assert/strict';
import { liveOnRoute, applyLiveTraffic } from '../js/live-traffic.js';
import { utmToLatLon, parseBarcelona, parseMadrid } from '../tools/datos.mjs';

// Ruta recta de oeste a este de ~2,2 km (lon, lat), con un punto cada ~110 m.
const coords = Array.from({ length: 21 }, (_, i) => [-3.70 + i * 0.0013, 40.42]);
const cum = coords.map((_, i) => i * 0.0013 * 111320 * Math.cos((40.42 * Math.PI) / 180));
const mk = () => ({ coords, cum, distance: cum.at(-1), duration: 300 });

test('un sensor lento en tu sentido ralentiza la ruta', () => {
  const r = applyLiveTraffic(mk(), { traf: { items: [{ p: [[40.4201, -3.6935]], l: 2, b: 90 }] } });
  assert.ok(r.liveTraffic, 'debe detectar el atasco');
  assert.ok(r.duration > 300 && r.liveTraffic.delay > 10);
  assert.ok(r.traffic.seg.some((f) => f >= 2.5));
});

test('un sensor del sentido contrario no cuenta', () => {
  const r = applyLiveTraffic(mk(), { traf: { items: [{ p: [[40.4201, -3.6935]], l: 3, b: 270 }] } });
  assert.equal(r.liveTraffic, undefined);
  assert.equal(r.duration, 300);
});

test('un tramo se aplica solo si va en el sentido de la ruta', () => {
  const ida = liveOnRoute(mk(), [{ p: [[40.42, -3.698], [40.42, -3.690]], l: 1 }]);
  const vuelta = liveOnRoute(mk(), [{ p: [[40.42, -3.690], [40.42, -3.698]], l: 1 }]);
  assert.ok(ida && ida.ranges[0].end - ida.ranges[0].start > 600);
  assert.equal(vuelta, null);
});

test('datos lejos de la ruta no cuentan', () => {
  assert.equal(liveOnRoute(mk(), [{ p: [[40.45, -3.69]], l: 3 }]), null);
});

test('UTM huso 30 → lat/lon (Puerta del Sol)', () => {
  const [la, lo] = utmToLatLon(440291, 4474254);
  assert.ok(Math.abs(la - 40.4169) < 0.001 && Math.abs(lo - -3.7035) < 0.001, `${la}, ${lo}`);
});

test('Madrid y Barcelona: solo lo que no es fluido', () => {
  const xml = '<pms><pm><descripcion>ALCALA E-O (X - Y)</descripcion><nivelServicio>2</nivelServicio><error>N</error><st_x>440291,0</st_x><st_y>4474254,0</st_y></pm>'
    + '<pm><descripcion>Z</descripcion><nivelServicio>0</nivelServicio><error>N</error><st_x>440291,0</st_x><st_y>4474254,0</st_y></pm></pms>';
  const mad = parseMadrid(xml);
  assert.equal(mad.length, 1);
  assert.equal(mad[0].l, 2);
  assert.equal(mad[0].b, 270);
  const bcn = parseBarcelona('1#20261110201552#5#5\n2#20261110201552#2#2\n', '"Tram","Descripció","Coordenades"\n1,"A","2.1,41.38,2.11,41.39"\n2,"B","2.1,41.38,2.11,41.39"\n');
  assert.deepEqual(bcn, [{ p: [[41.38, 2.1], [41.39, 2.11]], l: 3 }]);
});
