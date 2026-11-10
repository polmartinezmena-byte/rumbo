// Búsqueda con conexión en toda España:
//   · direcciones con número de portal (Photon / OpenStreetMap y, si no lo tiene, CartoCiudad del IGN)
//   · negocios por nombre («Mercadona», «Repsol»…) ordenados por cercanía
//   · categorías («gasolinera», «farmacia», «supermercado»…): lo más cercano de ese tipo
// Cada resultado dice qué es y a qué distancia está.
import { haversine, fmtDist } from './geo.js';

const PHOTON = 'https://photon.komoot.io/api/';
const CARTOCIUDAD = 'https://www.cartociudad.es/geocoder/api/geocoder/candidates';

export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Qué es cada cosa, en español.
const TYPE = {
  'amenity:fuel': 'Gasolinera', 'amenity:charging_station': 'Punto de carga', 'amenity:pharmacy': 'Farmacia',
  'amenity:hospital': 'Hospital', 'amenity:clinic': 'Centro de salud', 'amenity:doctors': 'Médico', 'amenity:dentist': 'Dentista',
  'amenity:police': 'Policía', 'amenity:fire_station': 'Bomberos', 'amenity:parking': 'Aparcamiento', 'amenity:atm': 'Cajero',
  'amenity:bank': 'Banco', 'amenity:restaurant': 'Restaurante', 'amenity:fast_food': 'Comida rápida', 'amenity:cafe': 'Cafetería',
  'amenity:bar': 'Bar', 'amenity:pub': 'Bar', 'amenity:school': 'Colegio', 'amenity:university': 'Universidad',
  'amenity:townhall': 'Ayuntamiento', 'amenity:post_office': 'Correos', 'amenity:library': 'Biblioteca', 'amenity:cinema': 'Cine',
  'amenity:theatre': 'Teatro', 'amenity:place_of_worship': 'Iglesia', 'amenity:veterinary': 'Veterinario', 'amenity:car_wash': 'Lavadero',
  'amenity:marketplace': 'Mercado', 'amenity:bus_station': 'Estación de autobuses',
  'shop:supermarket': 'Supermercado', 'shop:convenience': 'Tienda', 'shop:bakery': 'Panadería', 'shop:butcher': 'Carnicería',
  'shop:clothes': 'Ropa', 'shop:shoes': 'Zapatería', 'shop:mall': 'Centro comercial', 'shop:department_store': 'Grandes almacenes',
  'shop:car_repair': 'Taller', 'shop:tyres': 'Neumáticos', 'shop:car': 'Concesionario', 'shop:hairdresser': 'Peluquería',
  'shop:electronics': 'Electrónica', 'shop:hardware': 'Ferretería', 'shop:doityourself': 'Bricolaje', 'shop:furniture': 'Muebles',
  'shop:optician': 'Óptica', 'shop:books': 'Librería', 'shop:florist': 'Floristería', 'shop:kiosk': 'Quiosco', 'shop:tobacco': 'Estanco',
  'tourism:hotel': 'Hotel', 'tourism:hostel': 'Albergue', 'tourism:guest_house': 'Pensión', 'tourism:apartment': 'Apartamentos',
  'tourism:camp_site': 'Camping', 'tourism:museum': 'Museo', 'tourism:attraction': 'Lugar de interés', 'tourism:viewpoint': 'Mirador',
  'railway:station': 'Estación de tren', 'railway:halt': 'Apeadero', 'aeroway:aerodrome': 'Aeropuerto', 'aeroway:terminal': 'Terminal',
  'leisure:park': 'Parque', 'leisure:sports_centre': 'Polideportivo', 'leisure:stadium': 'Estadio', 'leisure:swimming_pool': 'Piscina',
  'leisure:fitness_centre': 'Gimnasio', 'office:company': 'Empresa', 'office:government': 'Oficina pública',
  'place:city': 'Ciudad', 'place:town': 'Población', 'place:village': 'Pueblo', 'place:hamlet': 'Aldea', 'place:suburb': 'Barrio',
  'place:neighbourhood': 'Barrio', 'place:locality': 'Paraje', 'place:house': 'Dirección', 'building:yes': 'Edificio',
  'boundary:administrative': 'Municipio', 'natural:peak': 'Pico', 'natural:beach': 'Playa', 'tourism:information': 'Información',
};
const BY_KEY = { shop: 'Tienda', amenity: 'Servicio', tourism: 'Turismo', leisure: 'Ocio', office: 'Oficina', craft: 'Taller', highway: 'Calle', building: 'Edificio', historic: 'Monumento', natural: 'Naturaleza' };
export const typeLabel = (key, value) => TYPE[`${key}:${value}`] || (key === 'highway' ? 'Calle' : BY_KEY[key]) || 'Lugar';

// Palabras que piden una categoría (singular y plural): lo más cercano de ese tipo.
const CATS = [
  [['gasolinera', 'gasolineras', 'gasolina', 'estacion de servicio', 'repostar', 'benzinera', 'benzineres', 'petrol station', 'gas station', 'petrol', 'fuel'], 'amenity:fuel'],
  [['cargador', 'cargadores', 'electrolinera', 'electrolineras', 'punto de carga', 'puntos de carga', 'punt de càrrega', 'ev charger', 'charging station'], 'amenity:charging_station'],
  [['farmacia', 'farmacias', 'farmacia', 'farmacies', 'pharmacy', 'pharmacies', 'chemist'], 'amenity:pharmacy'],
  [['hospital', 'hospitales', 'urgencias', 'urgències', 'urgencies', 'emergency room'], 'amenity:hospital'],
  [['centro de salud', 'ambulatorio', 'cap'], 'amenity:clinic'],
  [['supermercado', 'supermercados', 'super', 'supermercat', 'supermercats', 'supermarket', 'supermarkets'], 'shop:supermarket'],
  [['parking', 'parkings', 'aparcamiento', 'aparcamientos', 'aparcar', 'aparcament', 'aparcaments', 'car park'], 'amenity:parking'],
  [['cajero', 'cajeros', 'caixer', 'caixers', 'atm', 'cash machine'], 'amenity:atm'],
  [['banco', 'bancos'], 'amenity:bank'],
  [['restaurante', 'restaurantes', 'comer', 'restaurant', 'restaurants'], 'amenity:restaurant'],
  [['cafeteria', 'cafeterias', 'cafe'], 'amenity:cafe'],
  [['bar', 'bares'], 'amenity:bar'],
  [['hotel', 'hoteles', 'hotels'], 'tourism:hotel'],
  [['taller', 'talleres', 'mecanico'], 'shop:car_repair'],
  [['policia', 'comisaria', 'guardia civil', 'policia', 'police', 'police station'], 'amenity:police'],
  [['panaderia', 'panaderias'], 'shop:bakery'],
  [['correos'], 'amenity:post_office'],
  [['estanco', 'estancos'], 'shop:tobacco'],
  [['lavadero', 'lavado de coches', 'autolavado'], 'amenity:car_wash'],
  [['camping', 'campings'], 'tourism:camp_site'],
  [['veterinario', 'veterinarios'], 'amenity:veterinary'],
  [['estacion de tren', 'renfe', 'tren'], 'railway:station'],
  [['aeropuerto'], 'aeroway:aerodrome'],
];
export function categoryOf(q) {
  const n = norm(q).replace(/^(una?|el|la|los|las)\s+/, '').replace(/\s+(cerca|cercana|cercano|aqui)$/, '');
  for (const [words, tag] of CATS) if (words.includes(n)) return tag;
  return null;
}

/** El número de portal que se ha escrito («gran via 30», «c/ mayor, 12 b»), si hay uno. */
export function houseNumberOf(q) {
  const m = norm(q).match(/(?:^|[\s,])(\d{1,4})\s*([a-z])?(?=$|[\s,])(?!\s+de\s)/);
  if (!m) return null;
  if (/^\d/.test(norm(q).trim()) && norm(q).trim().indexOf(m[1]) === 0) return null; // «12 de octubre»
  return m[1];
}

function photonUrl(params) {
  const u = new URL(PHOTON);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.append(k, v);
  return u;
}
async function photon(params, timeout = 6000) {
  const r = await fetch(photonUrl(params), { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) return [];
  return (await r.json()).features || [];
}

function fromPhoton(f, near) {
  const p = f.properties;
  const lat = f.geometry.coordinates[1], lon = f.geometry.coordinates[0];
  const street = p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : '';
  const isAddress = p.osm_key === 'place' && p.osm_value === 'house';
  const name = (isAddress ? street : p.name) || street || p.city || '';
  const type = p.type === 'street' ? 'Calle' : typeLabel(p.osm_key, p.osm_value);
  const city = p.city || p.county || '';
  const where = [!isAddress && p.name && street, city && norm(city) !== norm(name) && city, !city && p.state].filter(Boolean).join(', ');
  const dist = near ? haversine(near[0], near[1], lat, lon) : null;
  return {
    name, lat, lon, online: true, type, hn: p.housenumber || '', street: p.street || (p.type === 'street' ? p.name : ''), city,
    dist, kind: [type, where, dist != null && fmtDist(dist)].filter(Boolean).join(' · '),
  };
}

/** CartoCiudad (IGN): todos los portales de España. Se usa cuando OpenStreetMap no tiene ese número. */
async function cartoPortal(street, num, city, near) {
  const u = new URL(CARTOCIUDAD);
  // CartoCiudad necesita el tipo de vía delante («calle gran via 30, madrid»).
  const s = /^(calle|carrer|avenida|avinguda|av\.?|paseo|passeig|plaza|placa|plaça|camino|cami|carretera|ronda|travesia|rua|kalea)\b/i.test(norm(street)) ? street : `calle ${street}`;
  u.search = new URLSearchParams({ q: `${s} ${num}, ${city}`, limit: '10' });
  const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const list = (await r.json()).filter((x) => x.type === 'portal' && norm(x.muni) === norm(city) && x.lat && x.lng);
  // El exacto o, si no existe, el más cercano del mismo lado de la calle (pares o impares).
  const gap = (x) => Math.abs(x.portalNumber - num) + ((x.portalNumber - num) % 2 ? 1000 : 0);
  const best = list.find((x) => String(x.portalNumber) === String(num)) || list.sort((a, b) => gap(a) - gap(b))[0];
  if (!best) return null;
  const exact = String(best.portalNumber) === String(num);
  const dist = near ? haversine(near[0], near[1], best.lat, best.lng) : null;
  return {
    name: `${street} ${best.portalNumber}${best.extension ? ' ' + best.extension : ''}`, lat: best.lat, lon: best.lng, online: true,
    type: 'Dirección', hn: String(best.portalNumber), dist,
    kind: ['Dirección', city, !exact && `el ${num} no existe: el más cercano`, dist != null && fmtDist(dist)].filter(Boolean).join(' · '),
  };
}

export async function searchOnline(q, near) {
  const ll = near ? { lat: near[0].toFixed(4), lon: near[1].toFixed(4) } : {};
  // Categoría: lo más cercano de ese tipo, por distancia.
  const cat = categoryOf(q);
  if (cat && near) {
    const fs = await photon({ q: norm(q), osm_tag: cat, limit: '20', ...ll, location_bias_scale: '0.1', zoom: '14' });
    const list = fs.map((f) => fromPhoton(f, near)).filter((x) => x.name);
    // Sin nombre propio (p. ej. un cajero): «Cajero · Calle…»
    if (list.length) return list.sort((a, b) => a.dist - b.dist).slice(0, 12);
  }

  const num = houseNumberOf(q);
  const fs = await photon({ q, limit: '12', ...ll, location_bias_scale: '0.3' });
  let list = fs.map((f) => fromPhoton(f, near)).filter((x) => x.name);

  if (num) {
    // Con número: primero el portal exacto; las calles sin número, detrás.
    const exact = list.filter((x) => x.hn && norm(x.hn).startsWith(num));
    // Si en ese portal solo sale un negocio, también se ofrece la dirección tal cual.
    const poi = exact.find((x) => x.type !== 'Dirección' && x.street);
    if (poi && !exact.some((x) => x.type === 'Dirección' && norm(x.street) === norm(poi.street) && norm(x.city) === norm(poi.city))) {
      list.unshift({ ...poi, name: `${poi.street} ${poi.hn}`, type: 'Dirección', kind: ['Dirección', poi.city, poi.dist != null && fmtDist(poi.dist)].filter(Boolean).join(' · ') });
    }
    if (!exact.length) {
      const st = list.find((x) => x.street && x.city);
      const portal = st && (await cartoPortal(st.street, num, st.city, near).catch(() => null));
      if (portal) list.unshift(portal);
    }
  }
  // Photon apenas tiene en cuenta la cercanía: se mezcla su orden con la distancia (5 km ≈ un puesto).
  const score = (x, i) => i + (x.dist != null ? x.dist / 5000 : 0) - (num && x.hn && norm(x.hn).startsWith(num) ? 6 : 0) + (num && !x.hn ? 2 : 0);
  const seen = new Set();
  return list.map((x, i) => ({ x, s: score(x, i) })).sort((a, b) => a.s - b.s).map(({ x }) => x)
    .filter((x) => { const k = norm(x.name) + Math.round(x.lat * 2000) + Math.round(x.lon * 2000); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 10);
}
