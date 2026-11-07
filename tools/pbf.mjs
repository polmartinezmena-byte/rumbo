// Lector mínimo de ficheros OpenStreetMap .osm.pbf (sin dependencias).
// Especificación: https://wiki.openstreetmap.org/wiki/PBF_Format
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- protobuf
class Pb {
  constructor(buf, start = 0, end = buf.length) { this.b = buf; this.p = start; this.end = end; }
  more() { return this.p < this.end; }
  varint() {
    const b = this.b;
    let x = b[this.p++];
    if (x < 0x80) return x;
    x &= 0x7f;
    let mul = 128;
    for (;;) {
      const c = b[this.p++];
      x += (c & 0x7f) * mul;
      if (c < 0x80) return x;
      mul *= 128;
    }
  }
  svarint() { const v = this.varint(); return v % 2 === 1 ? -(v + 1) / 2 : v / 2; }
  key() { const k = this.varint(); return [Math.floor(k / 8), k & 7]; }
  bytes() { const len = this.varint(); const s = this.p; this.p += len; return [s, this.p]; }
  skip(wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.p += 8;
    else if (wt === 2) { const len = this.varint(); this.p += len; }
    else if (wt === 5) this.p += 4;
    else throw new Error('wire type ' + wt);
  }
  packed(fn) { const [s, e] = this.bytes(); const out = []; const sub = new Pb(this.b, s, e); while (sub.more()) out.push(fn(sub)); return out; }
}
const U = (r) => r.varint();
const S = (r) => r.svarint();

// ---------------------------------------------------------------- bloques
function* blobs(path) {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  let pos = 0;
  const lenBuf = Buffer.alloc(4);
  try {
    while (pos < size) {
      readSync(fd, lenBuf, 0, 4, pos);
      const hlen = lenBuf.readUInt32BE(0);
      pos += 4;
      const hbuf = Buffer.alloc(hlen);
      readSync(fd, hbuf, 0, hlen, pos);
      pos += hlen;
      let type = '', dsize = 0;
      const h = new Pb(hbuf);
      while (h.more()) {
        const [f, wt] = h.key();
        if (f === 1) { const [s, e] = h.bytes(); type = hbuf.toString('utf8', s, e); }
        else if (f === 3) dsize = h.varint();
        else h.skip(wt);
      }
      const bbuf = Buffer.alloc(dsize);
      readSync(fd, bbuf, 0, dsize, pos);
      pos += dsize;
      const b = new Pb(bbuf);
      let data = null;
      while (b.more()) {
        const [f, wt] = b.key();
        if (f === 1) { const [s, e] = b.bytes(); data = bbuf.subarray(s, e); }
        else if (f === 3) { const [s, e] = b.bytes(); data = inflateSync(bbuf.subarray(s, e)); }
        else b.skip(wt);
      }
      if (!data) throw new Error('Compresión de bloque no soportada');
      yield { type, data, progress: pos / size };
    }
  } finally {
    closeSync(fd);
  }
}

/** Lee la caja delimitadora de la cabecera (Geofabrik la incluye). */
export function readHeaderBbox(path) {
  for (const { type, data } of blobs(path)) {
    if (type !== 'OSMHeader') continue;
    const r = new Pb(data);
    while (r.more()) {
      const [f, wt] = r.key();
      if (f === 1) {
        const [s, e] = r.bytes();
        const bb = new Pb(data, s, e);
        const v = {};
        while (bb.more()) { const [g] = bb.key(); v[g] = bb.svarint() * 1e-9; }
        return { w: v[1], e: v[2], n: v[3], s: v[4] };
      }
      r.skip(wt);
    }
    return null;
  }
  return null;
}

/**
 * Recorre el fichero y llama a los callbacks:
 *   node(id, lat, lon, tags|null)   — tags solo se decodifican si wantNodeTags
 *   way(id, refs[], tags)
 *   relation(id, members[{type, ref, role}], tags)
 */
export function scan(path, { node, way, relation, wantNodeTags = true, onProgress } = {}) {
  let last = 0;
  for (const { type, data, progress } of blobs(path)) {
    if (type !== 'OSMData') continue;
    if (onProgress && progress - last > 0.02) { last = progress; onProgress(progress); }
    const r = new Pb(data);
    let strings = [];
    const groups = [];
    let gran = 100, latOff = 0, lonOff = 0;
    while (r.more()) {
      const [f, wt] = r.key();
      if (f === 1) {
        const [s, e] = r.bytes();
        const st = new Pb(data, s, e);
        strings = [];
        while (st.more()) { const [, w2] = st.key(); if (w2 !== 2) { st.skip(w2); continue; } const [a, b] = st.bytes(); strings.push(data.toString('utf8', a, b)); }
      } else if (f === 2) groups.push(r.bytes());
      else if (f === 17) gran = r.varint();
      else if (f === 19) latOff = r.varint();
      else if (f === 20) lonOff = r.varint();
      else r.skip(wt);
    }
    const toDeg = (v, o) => (o + gran * v) * 1e-9;

    for (const [gs, ge] of groups) {
      const g = new Pb(data, gs, ge);
      while (g.more()) {
        const [f, wt] = g.key();
        if (f === 2 && node) {
          // DenseNodes
          const [s, e] = g.bytes();
          const d = new Pb(data, s, e);
          let ids = [], lats = [], lons = [], kv = [];
          while (d.more()) {
            const [h, w2] = d.key();
            if (h === 1) ids = d.packed(S);
            else if (h === 8) lats = d.packed(S);
            else if (h === 9) lons = d.packed(S);
            else if (h === 10 && wantNodeTags) kv = d.packed(U);
            else d.skip(w2);
          }
          let id = 0, lat = 0, lon = 0, k = 0;
          for (let i = 0; i < ids.length; i++) {
            id += ids[i]; lat += lats[i]; lon += lons[i];
            let tags = null;
            if (kv.length) {
              while (k < kv.length && kv[k] !== 0) {
                (tags ??= {})[strings[kv[k]]] = strings[kv[k + 1]];
                k += 2;
              }
              k++;
            }
            node(id, toDeg(lat, latOff), toDeg(lon, lonOff), tags);
          }
        } else if (f === 1 && node) {
          const [s, e] = g.bytes();
          const n = new Pb(data, s, e);
          let id = 0, lat = 0, lon = 0, keys = [], vals = [];
          while (n.more()) {
            const [h, w2] = n.key();
            if (h === 1) id = n.svarint();
            else if (h === 2) keys = n.packed(U);
            else if (h === 3) vals = n.packed(U);
            else if (h === 8) lat = n.svarint();
            else if (h === 9) lon = n.svarint();
            else n.skip(w2);
          }
          let tags = null;
          for (let i = 0; i < keys.length; i++) (tags ??= {})[strings[keys[i]]] = strings[vals[i]];
          node(id, toDeg(lat, latOff), toDeg(lon, lonOff), tags);
        } else if (f === 4 && relation) {
          const [s, e] = g.bytes();
          const w = new Pb(data, s, e);
          let id = 0, keys = [], vals = [], roles = [], mem = [], types = [];
          while (w.more()) {
            const [h, w2] = w.key();
            if (h === 1) id = w.varint();
            else if (h === 2) keys = w.packed(U);
            else if (h === 3) vals = w.packed(U);
            else if (h === 8) roles = w.packed(U);
            else if (h === 9) mem = w.packed(S);
            else if (h === 10) types = w.packed(U);
            else w.skip(w2);
          }
          const tags = {};
          for (let i = 0; i < keys.length; i++) tags[strings[keys[i]]] = strings[vals[i]];
          let ref = 0;
          const members = mem.map((d, i) => ({ type: ['node', 'way', 'relation'][types[i]], ref: (ref += d), role: strings[roles[i]] }));
          relation(id, members, tags);
        } else if (f === 3 && way) {
          const [s, e] = g.bytes();
          const w = new Pb(data, s, e);
          let id = 0, keys = [], vals = [], refs = [];
          while (w.more()) {
            const [h, w2] = w.key();
            if (h === 1) id = w.varint();
            else if (h === 2) keys = w.packed(U);
            else if (h === 3) vals = w.packed(U);
            else if (h === 8) refs = w.packed(S);
            else w.skip(w2);
          }
          const tags = {};
          for (let i = 0; i < keys.length; i++) tags[strings[keys[i]]] = strings[vals[i]];
          for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1];
          way(id, refs, tags);
        } else g.skip(wt);
      }
    }
  }
}
