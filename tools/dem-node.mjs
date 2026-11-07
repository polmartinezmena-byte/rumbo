// Relieve para Node: descarga teselas "terrarium" (AWS Open Data) y las decodifica sin dependencias.
import { inflateSync } from 'node:zlib';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('No es PNG');
  let p = 8, w = 0, h = 0, ct = 0, depth = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; ct = body[9]; if (body[12]) throw new Error('PNG entrelazado'); }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`PNG no soportado (tipo ${ct}, ${depth} bits)`);
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y ? out[prev + x] : 0;
      const c = x >= bpp && y ? out[prev + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

const lon2px = (lon, z) => ((lon + 180) / 360) * 2 ** z * 256;
const lat2px = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * 256; };

/** Mismo formato que flood.js · fetchDem, para poder reutilizar nodeRisk(). */
export async function fetchDemNode(b, z, onProgress) {
  const x0 = Math.floor(lon2px(b.w, z) / 256), x1 = Math.floor(lon2px(b.e, z) / 256);
  const y0 = Math.floor(lat2px(b.n, z) / 256), y1 = Math.floor(lat2px(b.s, z) / 256);
  const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256;
  const data = new Float32Array(W * H).fill(NaN);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  const total = jobs.length;
  let done = 0, ok = 0;
  const run = async () => {
    while (jobs.length) {
      const [x, y] = jobs.pop();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
          if (!r.ok) break;
          const png = decodePng(Buffer.from(await r.arrayBuffer()));
          const ox = (x - x0) * 256, oy = (y - y0) * 256;
          for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
            const k = (j * 256 + i) * png.bpp;
            data[(oy + j) * W + ox + i] = png.data[k] * 256 + png.data[k + 1] + png.data[k + 2] / 256 - 32768;
          }
          ok++;
          break;
        } catch { /* reintento */ }
      }
      onProgress?.(++done / total);
    }
  };
  await Promise.all(Array.from({ length: 12 }, run));
  return ok ? { z, ox: x0 * 256, oy: y0 * 256, W, H, data } : null;
}
