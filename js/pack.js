// Formato binario de un paquete de rutas (.rumbo): cabecera JSON + arrays tipados alineados.
//   "RUMBO1\n" | uint32 LE longitud cabecera | cabecera JSON | relleno a 8 | bloques binarios
// El fichero publicado va comprimido con gzip (.rumbo.gz) y puede trocearse en partes.
import { norm } from './geo.js';

const MAGIC = 'RUMBO1\n';
const TYPES = { Float64Array, Float32Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int16Array };
// Arrays que pueden perder precisión sin problema al empaquetar (≈ 0,5 m en coordenadas).
const AS_F32 = new Set(['la', 'lo', 'sLa', 'sLo', 'eLa', 'eLo', 'cLa', 'cLo']);
const SKIP = new Set(['sNorm']); // se recalcula al cargar

export function serialize(G) {
  const meta = {};
  const arrays = [];
  for (const [k, v] of Object.entries(G)) {
    if (SKIP.has(k)) continue;
    if (ArrayBuffer.isView(v)) {
      const a = AS_F32.has(k) && v instanceof Float64Array ? Float32Array.from(v) : v;
      arrays.push([k, a]);
    } else meta[k] = v;
  }
  let offset = 0;
  const index = arrays.map(([k, a]) => {
    const e = { k, t: a.constructor.name, o: offset, n: a.length };
    offset += Math.ceil(a.byteLength / 8) * 8;
    return e;
  });
  const head = new TextEncoder().encode(JSON.stringify({ meta, index }));
  const pre = MAGIC.length + 4 + head.length;
  const start = Math.ceil(pre / 8) * 8;
  const out = new Uint8Array(start + offset);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(MAGIC.length, head.length, true);
  out.set(head, MAGIC.length + 4);
  arrays.forEach(([, a], i) => out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), start + index[i].o));
  return out;
}

export function deserialize(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const magic = new TextDecoder().decode(bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error('El paquete descargado no es válido');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hlen = dv.getUint32(MAGIC.length, true);
  const { meta, index } = JSON.parse(new TextDecoder().decode(bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + hlen)));
  const start = Math.ceil((MAGIC.length + 4 + hlen) / 8) * 8;
  const G = { ...meta };
  // Copia alineada (el buffer de entrada puede no estarlo).
  const aligned = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
  for (const e of index) {
    const T = TYPES[e.t];
    let a = new T(aligned.buffer, aligned.byteOffset + start + e.o, e.n);
    if (T === Float32Array && AS_F32.has(e.k)) a = Float64Array.from(a);
    G[e.k] = a;
  }
  G.sNorm = G.sName.map(norm);
  return G;
}
