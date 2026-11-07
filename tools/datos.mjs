#!/usr/bin/env node
// Datos «en directo» que el navegador no puede pedir por sí mismo (las fuentes no permiten CORS):
//   · incidencias.json — cortes, obras, accidentes y retenciones de la DGT (DATEX II v3.7, cada 15 min)
//   · zbe.json         — Zonas de Bajas Emisiones oficiales de la DGT (DATEX II, una vez al día)
// Un workflow los publica en la rama «datos», que la app lee desde raw.githubusercontent.com.
//
//   node tools/datos.mjs [carpeta-salida] [--zbe]
// Fuente: DGT, Punto de Acceso Nacional (nap.dgt.es) — licencia CC BY 4.0.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'datos';
const WITH_ZBE = process.argv.includes('--zbe');
const UA = { 'User-Agent': 'rumbo-datos (github.com/polmartinezmena-byte/rumbo)' };
mkdirSync(OUT, { recursive: true });

const tag = (s, name) => s.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
const num = (v) => (v === undefined ? NaN : parseFloat(v));
const r5 = (v) => Math.round(v * 1e5) / 1e5;

// ------------------------------------------------------------------ incidencias
const INCIDENTS = 'https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v37.xml';

export function parseIncidents(xml) {
  const out = [];
  for (const rec of xml.split('<sit:situationRecord').slice(1)) {
    const status = tag(rec, 'com:validityStatus');
    if (status && status !== 'active') continue;
    const mgmt = tag(rec, 'sit:roadOrCarriagewayOrLaneManagementType');
    const cause = tag(rec, 'sit:causeType');
    const detail = rec.match(/<sit:([a-zA-Z]+Type)>([^<]+)<\/sit:\1>/g)?.map((m) => m.replace(/<[^>]+>/g, '')).join(' ') || '';
    let kind;
    if (/flood/i.test(detail)) kind = 'inundacion';
    else if (mgmt === 'roadClosed') kind = 'cortada';
    else if (mgmt === 'carriagewayClosures') kind = 'calzada';
    else if (cause === 'accident') kind = 'accidente';
    else if (/^(laneClosures|narrowLanes|singleAlternateLineTraffic|lanesDeviated|doNotUseSpecifiedLanesOrCarriageways|intermittentShortTermClosures)$/.test(mgmt || '')) kind = 'carril';
    else if (cause === 'roadMaintenance') kind = 'obras';
    else if (cause === 'abnormalTraffic' || /AbnormalTraffic/.test(rec.slice(0, 200))) kind = 'retencion';
    else if (/^(environmentalObstruction|poorEnvironment)$/.test(cause || '')) kind = 'meteo';
    else if (/^(vehicleObstruction|obstruction|infrastructureDamageObstruction)$/.test(cause || '')) kind = 'obstaculo';
    else kind = 'otro';
    const pts = [...rec.matchAll(/<loc:latitude>([-\d.]+)<\/loc:latitude>\s*<loc:longitude>([-\d.]+)<\/loc:longitude>/g)].map((m) => [r5(+m[1]), r5(+m[2])]);
    if (!pts.length) continue;
    // En los tramos, el XML trae primero «to» y luego «from».
    const isLinear = /<loc:from /.test(rec) && pts.length >= 2;
    const from = isLinear ? pts[1] : pts[0];
    const to = isLinear ? pts[0] : null;
    out.push({
      k: kind,
      road: tag(rec, 'loc:roadName') || '',
      from, to,
      dir: tag(rec, 'loc:tpegDirection') || '',
      since: (tag(rec, 'com:overallStartTime') || '').slice(0, 16),
      town: tag(rec, 'lse:municipality') || '',
      pk: num(tag(rec, 'lse:kilometerPoint')),
      det: detail.split(' ').filter((d) => d !== kind).slice(0, 2).join(' '),
    });
  }
  return out;
}

// ------------------------------------------------------------------ ZBE
const ZBE_PAGE = 'https://nap.dgt.es/es/dataset/zonas-de-bajas-emisiones';
const LABELS = ['Sin distintivo', 'B', 'C', 'ECO', '0'];
const LABEL_ID = { 'Sin distintivo': 'A', B: 'B', C: 'C', ECO: 'ECO', 0: '0' };

// Las publicaciones municipales no son homogéneas: unas listan las etiquetas restringidas y otras las
// permitidas. Regla prudente: si aparece «Sin distintivo» (y no todas) son las restringidas; si no
// aparece, son las permitidas y se restringe el resto; si aparecen todas o ninguna, se aplica la regla
// general de las ZBE en España: no pueden entrar los vehículos sin etiqueta.
export function restrictedLabels(mentioned) {
  const m = [...new Set(mentioned)];
  if (!m.length || m.length === LABELS.length) return ['A'];
  if (m.includes('Sin distintivo')) return m.map((x) => LABEL_ID[x]);
  return LABELS.filter((x) => !m.includes(x)).map((x) => LABEL_ID[x]);
}

export function parseZbe(xml, source) {
  const zones = [];
  for (const z of xml.split('<conz:controlledZone ').slice(1)) {
    const status = tag(z, 'conz:status');
    if (status && status !== 'active') continue;
    const name = z.match(/<com:value lang="ES">([^<]+)<\/com:value>/)?.[1]?.trim() || 'ZBE';
    const url = tag(z, 'conz:urlForFurtherInformation') || '';
    const mentioned = [...z.matchAll(/<com:value lang="ES">([^<]+)<\/com:value>\s*<\/com:values>\s*<\/conz:condition>\s*<conz:type>stickerCondition/g)].map((m) => m[1].trim());
    const days = [...new Set([...z.matchAll(/<com:periodName>\s*<com:values>\s*<com:value lang="ES">([^<]+)</g)].map((m) => m[1]))];
    const times = [...new Set([...z.matchAll(/<com:startTimeOfPeriod>([^<]+)<\/com:startTimeOfPeriod>\s*<com:endTimeOfPeriod>([^<]+)/g)].map((m) => `${m[1].slice(0, 5)}-${m[2].slice(0, 5)}`))];
    const polys = [];
    for (const corners of z.split('<loc:openlrPolygonCorners>').slice(1)) {
      const body = corners.slice(0, corners.indexOf('</loc:openlrPolygonCorners>'));
      const ring = [...body.matchAll(/<loc:latitude>([-\d.]+)<\/loc:latitude>\s*<loc:longitude>([-\d.]+)<\/loc:longitude>/g)].map((m) => [r5(+m[2]), r5(+m[1])]);
      if (ring.length >= 3) polys.push(ring);
    }
    if (!polys.length) continue;
    zones.push({
      name, url, source,
      restricted: restrictedLabels(mentioned),
      // L = laborables (lunes a viernes), F = festivos y fines de semana; «LF» = todos los días.
      days: days.join('') || 'LF',
      times: times.length ? times : ['00:00-23:59'],
      polys,
    });
  }
  return zones;
}

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(90000) });
      if (r.ok) return await r.text();
      throw new Error('HTTP ' + r.status);
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('datos.mjs')) {
  const inc = parseIncidents(await get(INCIDENTS));
  const counts = inc.reduce((a, x) => ((a[x.k] = (a[x.k] || 0) + 1), a), {});
  writeFileSync(join(OUT, 'incidencias.json'), JSON.stringify({ updated: new Date().toISOString(), source: 'DGT · NAP (CC BY 4.0)', items: inc }));
  console.log(`incidencias.json: ${inc.length}`, counts);

  if (WITH_ZBE) {
    const page = await get(ZBE_PAGE);
    const urls = [...new Set([...page.matchAll(/https?:\/\/[^"<]*ControledZonePublication\/[^"<]*\.xml/g)].map((m) => m[0]))];
    const zones = [];
    for (const u of urls) {
      try {
        zones.push(...parseZbe(await get(u), decodeURIComponent(u.split('/').pop().replace('.xml', ''))));
      } catch (e) {
        console.log('  ZBE no disponible:', u, e.message);
      }
    }
    writeFileSync(join(OUT, 'zbe.json'), JSON.stringify({ updated: new Date().toISOString(), source: 'DGT · NAP (CC BY 4.0)', zones }));
    console.log(`zbe.json: ${zones.length} zonas de ${urls.length} municipios`);
  }
}
