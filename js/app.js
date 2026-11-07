import { fmtDist, fmtTime, fmtClock, haversine } from './geo.js';
import { STYLE_URL, MAX_ZOOM, AVG_TILE_KB, prefetchArea, tileList, removeTiles } from './offline-tiles.js';
import { Navigator, pointAt, speak, setMuted, isMuted } from './nav.js';
import { fetchWeather, cachedWeather, LEVELS } from './weather.js';
import { settings, setSetting, onSettingChange, applyTheme } from './settings.js';

applyTheme();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const MAX_AREA_KM2 = 650;
const REGION_MAX_Z = (r) => (r.main ? 10 : MAX_ZOOM); // España entera: mapa general; comunidades: detalle

// ------------------------------------------------------------------ service worker
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));

// ------------------------------------------------------------------ worker de rutas (RPC)
const worker = new Worker(new URL('./graph-worker.js', import.meta.url), { type: 'module' });
let reqId = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  const p = pending.get(m.id);
  if (!p) return;
  if (m.progress) return p.onProgress?.(m.progress);
  pending.delete(m.id);
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
};
const call = (type, data = {}, onProgress) =>
  new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, ...data });
  });

// ------------------------------------------------------------------ utilidades
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const store = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem('rumbo:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rumbo:' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0).replace('.', ',')} MB`;

function arrowSvg(angle) {
  const a = (angle * Math.PI) / 180;
  const ex = 12 + 8 * Math.sin(a), ey = 12 - 8 * Math.cos(a);
  const head = (d) => { const h = a + Math.PI + d; return `${ex + 5 * Math.sin(h)},${ey - 5 * Math.cos(h)}`; };
  return `<svg viewBox="0 0 24 24"><path d="M12 22V12L${ex},${ey}"/><path d="M${head(0.6)} L${ex},${ey} L${head(-0.6)}"/></svg>`;
}
function maneuverSvg(step) {
  if (step.mod === 'arrive') return '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  if (step.mod === 'roundabout') return '<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="4.5"/><path d="M12 22v-7.5"/><path d="M15.2 6.8 19 3m0 0h-4m4 0v4"/></svg>';
  return arrowSvg(step.angle || 0);
}

const SHEETS = ['route', 'nav', 'sos', 'contacts', 'rain', 'favs', 'settings', 'credits'];
let sheetNow = null;
function setSheet(which) {
  sheetNow = which;
  for (const id of SHEETS) $('#sheet-' + id).hidden = id !== which;
  $('#sheet').hidden = !which;
  document.body.classList.toggle('has-sheet', !!which);
  requestAnimationFrame(() => document.body.style.setProperty('--sheet-h', which ? `${$('#sheet').offsetHeight}px` : '0px'));
}
// Al cerrar una hoja secundaria se vuelve a la ruta si había una.
const backToMain = () => (route && !nav ? showRouteSheet() : setSheet(nav ? 'nav' : null));

// ------------------------------------------------------------------ mapa
const view = store.get('view');
const map = new maplibregl.Map({
  container: 'map', style: STYLE_URL,
  center: view?.c || [-3.7038, 40.4168], zoom: view?.z ?? (view ? 13 : 5.2),
  attributionControl: { compact: true }, maxPitch: 70,
});
addEventListener('resize', () => map.resize());
document.addEventListener('visibilitychange', () => !document.hidden && map.resize());
map.on('moveend', () => {
  if (!nav) store.set('view', { c: map.getCenter().toArray(), z: map.getZoom() });
  updateEstimate();
  if ($('#risk-layer').checked && map.getZoom() >= 12) toggleRiskLayer(true);
  refreshCameras();
});

const empty = { type: 'FeatureCollection', features: [] };
let mapReady = false;
map.on('load', () => {
  mapReady = true;
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addSource('areas', { type: 'geojson', data: empty });
  map.addLayer({ id: 'areas-line', type: 'line', source: 'areas', paint: { 'line-color': '#f59e0b', 'line-width': 1.5, 'line-dasharray': [2, 2] } }, firstSymbol);
  map.addSource('flood', { type: 'geojson', data: empty });
  map.addLayer({ id: 'flood-line', type: 'line', source: 'flood', layout: { visibility: 'none', 'line-cap': 'round' },
    paint: {
      'line-color': ['match', ['get', 'level'], 'paso', '#7c3aed', 'alto', '#dc2626', '#f59e0b'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 16, 6], 'line-opacity': 0.8,
    } }, firstSymbol);
  map.addSource('route', { type: 'geojson', data: empty });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#1d4ed8', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 17, 16] } }, firstSymbol);
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#60a5fa', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 17, 10] } }, firstSymbol);
  map.addSource('route-risk', { type: 'geojson', data: empty });
  map.addLayer({ id: 'route-risk-line', type: 'line', source: 'route-risk', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['case', ['get', 'hard'], '#7c3aed', '#f97316'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 17, 10] } }, firstSymbol);
  // Radares: rojo fijo, morado tramo, ámbar semáforo con cámara.
  map.addSource('cameras', { type: 'geojson', data: empty });
  map.addLayer({ id: 'cameras-dot', type: 'circle', source: 'cameras', minzoom: 10,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 9],
      'circle-color': ['match', ['get', 'kind'], 1, '#7c3aed', 2, '#7c3aed', 3, '#f59e0b', '#dc2626'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
    } });
  map.addLayer({ id: 'cameras-label', type: 'symbol', source: 'cameras', minzoom: 12,
    layout: { 'text-field': ['to-string', ['get', 'speed']], 'text-size': 10, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true },
    paint: { 'text-color': '#fff' } });
  map.addSource('favs', { type: 'geojson', data: empty });
  map.addLayer({ id: 'favs-dot', type: 'circle', source: 'favs',
    paint: { 'circle-radius': 7, 'circle-color': '#eab308', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'favs-label', type: 'symbol', source: 'favs',
    layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] },
    paint: { 'text-color': '#713f12', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
  map.on('click', 'favs-dot', (e) => {
    const f = favs.find((x) => x.id === e.features[0].properties.id);
    if (f) setDest({ lat: f.lat, lon: f.lon, label: f.name });
  });
  drawAreas();
  drawFavs();
  if (store.get('riskLayer') && hasMaps()) toggleRiskLayer(true);
});

// ------------------------------------------------------------------ estado
let catalog = {};           // mapas guardados en el dispositivo (worker)
let regionIndex = store.get('regionIndex', null); // catálogo de comunidades publicado
let origin = null, dest = null, route = null, nav = null, simTimer = null;
let follow = true, gps = null, watchId = null, centerOnFix = false, wakeLock = null;
let weather = cachedWeather();
let favs = store.get('favs', []);
let contacts = store.get('contacts', []);

const originMarker = new maplibregl.Marker({ color: '#16a34a' });
const destMarker = new maplibregl.Marker({ color: '#dc2626' });
const meEl = document.createElement('div');
meEl.className = 'me';
const meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: 'map', pitchAlignment: 'map' });
let meOnMap = false;

const hasMaps = () => Object.keys(catalog).length > 0;

// ------------------------------------------------------------------ red
function updateNet() {
  const n = $('#net');
  n.hidden = navigator.onLine;
  n.textContent = hasMaps() ? 'Sin conexión · usando tus mapas descargados' : 'Sin conexión · descarga tu zona cuando vuelvas a tener red';
}
addEventListener('online', () => { updateNet(); refreshWeather(); loadRegionIndex(); });
addEventListener('offline', updateNet);

// ================================================================== MAPAS SIN CONEXIÓN
function drawAreas() {
  if (!mapReady) return;
  refreshCameras();
  map.getSource('areas').setData({
    type: 'FeatureCollection',
    features: Object.values(catalog).filter((st) => st.bbox && !(st.region === 'es')).map(({ bbox: { s, w, n, e } }) => ({
      type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    })),
  });
}

async function loadRegionIndex() {
  try {
    const r = await fetch('./packs/index.json', { cache: 'no-cache' });
    if (r.ok) { regionIndex = await r.json(); store.set('regionIndex', regionIndex); }
  } catch { /* sin red: se usa el guardado */ }
  if (!$('#panel').hidden) renderRegions();
}

function tilesEstimate(r) {
  const n = tileList(r.bbox, REGION_MAX_Z(r)).length;
  return { n, bytes: n * AVG_TILE_KB * 1024 };
}

function renderRegions() {
  const box = $('#regions');
  if (!regionIndex?.regions?.length) {
    box.innerHTML = '<p class="small muted">El catálogo de comunidades aún no está publicado. Se genera con <code>npm run build:region</code> (ver README). Mientras, usa la zona a medida.</p>';
    return;
  }
  box.innerHTML = '';
  for (const r of regionIndex.regions) {
    const key = 'region:' + r.id;
    const have = catalog[key];
    const est = tilesEstimate(r);
    const el = document.createElement('div');
    el.className = 'region' + (have ? ' done' : '');
    const outdated = have && r.date && new Date(r.date) > new Date(have.date);
    el.innerHTML = `<div class="meta"><b>${esc(r.name)}</b>
      <small>${have ? `✔ Descargado · ${new Date(have.date).toLocaleDateString('es-ES')}${outdated ? ' · hay versión nueva' : ''}` : `≈ ${mb(r.size + est.bytes)} · rutas ${mb(r.size)} + mapa ${mb(est.bytes)}`}</small>
      ${r.main ? '<small>Carreteras principales y mapa general para rutas largas entre comunidades</small>' : ''}</div>`;
    const btn = document.createElement('button');
    btn.className = 'btn ' + (have && !outdated ? '' : 'primary');
    btn.textContent = have ? (outdated ? 'Actualizar' : 'Borrar') : 'Descargar';
    btn.onclick = () => (have && !outdated ? removeRegion(r) : downloadRegion(r));
    el.appendChild(btn);
    box.appendChild(el);
  }
}

function setProgress(pct, msg) {
  $('#dl').hidden = false;
  $('#dl-bar').style.width = `${Math.round(pct * 100)}%`;
  $('#dl-text').textContent = msg;
}

let busy = false;
async function withBusy(fn) {
  if (busy) return toast('Ya hay una descarga en curso');
  if (!navigator.onLine) return toast('Necesitas conexión (mejor wifi) para descargar.');
  busy = true;
  $$('#panel button.btn').forEach((b) => (b.disabled = true));
  navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {});
  try { await fn(); } catch (e) { toast(e.message, 6000); setProgress(0, 'Error: ' + e.message); }
  finally {
    busy = false;
    $$('#panel button.btn').forEach((b) => (b.disabled = false));
    if (!nav) wakeLock?.release?.().catch(() => {});
    navigator.storage?.persist?.().catch(() => {});
    renderPanel();
  }
}

function downloadRegion(r) {
  return withBusy(async () => {
    const maxZ = REGION_MAX_Z(r);
    setProgress(0, `${r.name}: preparando…`);
    const tiles = await prefetchArea(r.bbox, (d, t) => setProgress((d / t) * 0.6, `${r.name} · mapa: ${d.toLocaleString('es-ES')} / ${t.toLocaleString('es-ES')}`), maxZ);
    catalog = await call('installPack', { key: 'region:' + r.id, urls: r.files.map((f) => new URL('./packs/' + f, location.href).href), size: r.size },
      (p) => setProgress(0.6 + p.pct * 0.4, `${r.name} · ${p.msg}`));
    setProgress(1, `${r.name} lista`);
    toast(`${r.name} lista para usar sin conexión ✔${tiles.failed ? ` (faltaron ${tiles.failed} teselas: vuelve a pulsar para completar)` : ''}`, 5000);
    drawAreas();
  });
}

async function removeRegion(r) {
  if (!confirm(`¿Borrar ${r.name} del dispositivo?`)) return;
  catalog = await call('remove', { key: 'region:' + r.id });
  const keep = Object.values(catalog).map((st) => ({ bbox: st.bbox, maxZ: st.region === 'es' ? 10 : MAX_ZOOM }));
  await removeTiles(r.bbox, REGION_MAX_Z(r), keep);
  toast(`${r.name} borrada`);
  drawAreas();
  renderPanel();
}

function visibleBbox() {
  const b = map.getBounds();
  return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
}
function bboxKm(b) {
  const mid = (b.s + b.n) / 2;
  return [haversine(mid, b.w, mid, b.e) / 1000, haversine(b.s, b.w, b.n, b.w) / 1000];
}
function updateEstimate() {
  if ($('#panel').hidden) return;
  const b = visibleBbox();
  const [w, h] = bboxKm(b);
  $('#area-estimate').textContent = w * h > MAX_AREA_KM2
    ? `La zona visible mide ${Math.round(w)} × ${Math.round(h)} km: acerca el mapa (máximo ~25 × 25 km) o descarga la comunidad entera.`
    : `Zona visible: ${w.toFixed(1).replace('.', ',')} × ${h.toFixed(1).replace('.', ',')} km · ${tileList(b).length} teselas de mapa.`;
}

$('#btn-download').onclick = () => {
  const b = visibleBbox();
  const [w, h] = bboxKm(b);
  if (w * h > MAX_AREA_KM2) return toast('La zona es demasiado grande: acerca el mapa o descarga la comunidad.');
  withBusy(async () => {
    const tiles = await prefetchArea(b, (d, t) => setProgress((d / t) * 0.4, `Mapa: ${d} / ${t} archivos`));
    catalog = await call('download', { bbox: b }, (p) => setProgress(0.4 + p.pct * 0.6, p.msg));
    setProgress(1, 'Listo');
    toast(tiles.failed ? `Zona lista (faltaron ${tiles.failed} teselas)` : 'Zona lista para usar sin conexión ✔');
    drawAreas();
  });
};
$('#btn-clear').onclick = async () => {
  if (!confirm('¿Borrar la zona a medida?')) return;
  const b = catalog.area?.bbox;
  catalog = await call('remove', { key: 'area' });
  if (b) await removeTiles(b, MAX_ZOOM, Object.values(catalog).map((st) => ({ bbox: st.bbox, maxZ: st.region === 'es' ? 10 : MAX_ZOOM })));
  drawAreas();
  renderPanel();
  toast('Zona borrada');
};

async function renderPanel() {
  const a = catalog.area;
  $('#area-info').innerHTML = a
    ? `<b>Zona guardada</b> · ${new Date(a.date).toLocaleDateString('es-ES')}<br><span class="small">${a.edges.toLocaleString('es-ES')} tramos · ${a.places.toLocaleString('es-ES')} lugares · ${a.emergency.toLocaleString('es-ES')} servicios${a.flood ? ' · riesgo de inundación ✔' : ' · <b>vuelve a descargarla para la ruta segura</b>'}</span>`
    : '<span class="small muted">Para un barrio o un pueblo concreto: mueve el mapa y descarga lo que ves.</span>';
  $('#btn-clear').hidden = !a;
  renderRegions();
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('#storage').textContent = `Espacio usado: ${mb(est.usage)} de ${mb(est.quota)} disponibles para la app.`;
  } catch { /* opcional */ }
  updateNet();
}
$('#btn-menu').onclick = () => { $('#panel').hidden = false; renderPanel(); updateEstimate(); loadRegionIndex(); };
$('#panel-close').onclick = () => { $('#panel').hidden = true; };

// ================================================================== GPS
function startGps() {
  if (watchId !== null) return;
  if (!navigator.geolocation) return toast('Este dispositivo no tiene geolocalización');
  watchId = navigator.geolocation.watchPosition(onPos, (err) => {
    if (err.code === 1) {
      toast('Sin permiso de ubicación. Toca el mapa para elegir un punto de salida.');
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}

function onPos(p) {
  const c = p.coords;
  const first = !gps;
  gps = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, speed: c.speed ?? 0, heading: c.heading };
  if (!simTimer) placeMe(gps.lon, gps.lat, gps.heading);
  if (centerOnFix) {
    centerOnFix = false;
    map.flyTo({ center: [gps.lon, gps.lat], zoom: Math.max(map.getZoom(), 15) });
  }
  if (first) refreshWeather();
  if (nav && !simTimer) nav.update(gps);
  if (sheetNow === 'sos') updateSosCoords();
}

function placeMe(lon, lat, heading) {
  meMarker.setLngLat([lon, lat]);
  if (!meOnMap) { meMarker.addTo(map); meOnMap = true; }
  if (heading != null && !Number.isNaN(heading)) meMarker.setRotation(heading);
}

$('#btn-locate').onclick = () => {
  if (gps) map.flyTo({ center: [gps.lon, gps.lat], zoom: Math.max(map.getZoom(), 16) });
  else { centerOnFix = true; startGps(); toast('Buscando tu posición…'); }
};
// Situarte al abrir: si ya diste permiso, directamente; si no, se pide una vez.
centerOnFix = true;
navigator.permissions?.query({ name: 'geolocation' })
  // La primera vez no se pide el permiso de golpe: lo explica la bienvenida.
  .then((r) => { if (r.state === 'granted' || (r.state === 'prompt' && store.get('onboarded'))) startGps(); else centerOnFix = false; })
  .catch(() => { if (store.get('onboarded')) startGps(); });

// ================================================================== BÚSQUEDA
let searchTimer;
$('#q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#results li[data-i]')?.click();
  if (e.key === 'Escape') { $('#results').hidden = true; e.target.blur(); }
});

async function runSearch() {
  const q = $('#q').value.trim();
  const ul = $('#results');
  if (!q) { ul.hidden = true; return; }
  const c = map.getCenter();
  const nq = q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const favHits = favs.filter((f) => f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(nq))
    .map((f) => ({ name: f.name, kind: '★ Favorito', lat: f.lat, lon: f.lon }));
  const res = [...favHits, ...(hasMaps() ? await call('search', { q, near: [c.lat, c.lng] }) : [])];
  ul.innerHTML = '';
  if (!hasMaps() && !favHits.length) ul.innerHTML = '<li class="empty">Descarga tu comunidad o una zona (botón ⬇) para buscar sin conexión.</li>';
  else if (!res.length) ul.innerHTML = '<li class="empty">Sin resultados en tus mapas descargados.</li>';
  res.forEach((r, i) => {
    const li = document.createElement('li');
    li.dataset.i = i;
    li.tabIndex = 0;
    li.innerHTML = `<b>${esc(r.name)}</b><small>${esc(r.kind)}</small>`;
    li.onclick = () => {
      ul.hidden = true;
      $('#q').value = r.name;
      $('#q').blur();
      setDest({ lat: r.lat, lon: r.lon, label: r.name });
    };
    ul.appendChild(li);
  });
  ul.hidden = false;
}

// ================================================================== ORIGEN / DESTINO
function setDest(p) {
  dest = p;
  destMarker.setLngLat([p.lon, p.lat]).addTo(map);
  computeRoute();
}
function setOrigin(p) {
  origin = p;
  originMarker.setLngLat([p.lon, p.lat]).addTo(map);
  if (dest) computeRoute();
  else toast('Punto de salida fijado. Ahora busca o toca tu destino.');
}

let popup;
map.on('click', (e) => {
  if (nav || (mapReady && map.queryRenderedFeatures(e.point, { layers: ['favs-dot'] }).length)) return;
  $('#results').hidden = true;
  const { lat, lng } = e.lngLat;
  const el = document.createElement('div');
  el.className = 'popup';
  el.innerHTML = '<button class="go" data-a="to">Ir aquí</button><button data-a="from">Salir desde aquí</button><button data-a="fav">★ Guardar en favoritos</button>';
  el.onclick = (ev) => {
    const a = ev.target.dataset.a;
    if (!a) return;
    popup.remove();
    const label = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (a === 'to') setDest({ lat, lon: lng, label });
    else if (a === 'from') setOrigin({ lat, lon: lng, label: 'Punto elegido' });
    else addFav({ lat, lon: lng }, '');
  };
  popup?.remove();
  popup = new maplibregl.Popup({ closeButton: false, offset: 8 }).setLngLat(e.lngLat).setDOMContent(el).addTo(map);
});

// ================================================================== LLUVIA Y RUTA SEGURA
function floodLevel() {
  if (settings.floodMode === 'off') return 0;
  if (settings.floodMode === 'on') return 2;
  return weather && !weather.stale ? weather.level : 0;
}

async function refreshWeather() {
  if (!navigator.onLine) { renderRain(); return; }
  const c = map.getCenter();
  const p = gps || (dest && { lat: dest.lat, lon: dest.lon }) || { lat: c.lat, lon: c.lng };
  const before = floodLevel();
  try { weather = await fetchWeather(p.lat, p.lon); } catch { weather = cachedWeather(); }
  renderRain();
  if (floodLevel() !== before && dest) {
    toast(floodLevel() ? `${LEVELS[floodLevel()].label}: recalculando una ruta más segura…` : 'La lluvia ha remitido: ruta normal');
    computeRoute({ fit: false });
  }
}
setInterval(refreshWeather, 15 * 60e3);

function renderRain() {
  const lvl = floodLevel();
  const pill = $('#rain');
  pill.hidden = false;
  pill.className = `pill rain l${lvl}`;
  const mm = weather ? `${String(weather.maxHour).replace('.', ',')} mm/h` : '';
  pill.textContent = settings.floodMode === 'on'
    ? '⛈️ Ruta segura activada (manual)'
    : lvl ? `${LEVELS[lvl].icon} ${LEVELS[lvl].label} · ruta segura activada` : `${weather ? LEVELS[0].icon : '🌦️'} Ruta segura: ${settings.floodMode === 'off' ? 'desactivada' : 'automática'}${mm ? ' · ' + mm : ''}`;

  const w = weather;
  $('#rain-now').innerHTML = w
    ? `<b>${LEVELS[w.level].icon} ${LEVELS[w.level].label}</b>${w.stale ? ' <span class="muted small">(lectura antigua)</span>' : ''}<br>
       <span class="small">Ahora: ${fmtMm(w.now)}/h · máx. próximas horas: ${fmtMm(w.maxHour)}/h<br>
       Últimas 6 h: ${fmtMm(w.past6)} · próximas 12 h: ${fmtMm(w.next12)}${w.riverRatio >= 1.5 ? `<br>Río cercano: caudal ×${w.riverRatio.toFixed(1).replace('.', ',')} sobre lo normal` : ''}<br>
       <span class="muted">Actualizado ${fmtClock(new Date(w.at))} · Open-Meteo</span></span>`
    : `<span class="small muted">${navigator.onLine ? 'Consultando la lluvia…' : 'Sin conexión y sin lecturas previas. Si llueve fuerte, activa «Llueve fuerte».'}</span>`;
  $$('#sheet-rain .seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.floodMode)));
  $('#rain-mode-help').textContent = {
    auto: 'Con conexión, Rumbo activa sola la ruta segura cuando hay lluvia fuerte en tu zona. Sin conexión usa la última lectura.',
    on: 'Evita badenes y pasos subterráneos y penaliza las calles con riesgo, aunque no haya datos de lluvia. Úsalo sin conexión si está diluviando.',
    off: 'Siempre la ruta más rápida, sin tener en cuenta el riesgo de inundación.',
  }[settings.floodMode];
}
const fmtMm = (v) => `${String(Math.round(v * 10) / 10).replace('.', ',')} mm`;

$('#rain').onclick = () => { setSheet('rain'); renderRain(); refreshWeather(); };
$('#btn-close-rain').onclick = backToMain;
$$('#sheet-rain .seg button').forEach((b) => (b.onclick = () => {
  setSetting('floodMode', b.dataset.mode);
  renderRain();
  if (dest) computeRoute({ fit: false }).then(() => setSheet('rain'));
}));

async function toggleRiskLayer(on, manual = false) {
  $('#risk-layer').checked = on;
  store.set('riskLayer', on);
  if (!mapReady) return;
  if (on) {
    const fc = await call('riskLayer', { bbox: visibleBbox() });
    map.getSource('flood').setData(fc);
    if (!fc.features.length && manual) toast(hasMaps() ? 'Tus mapas no tienen datos de riesgo: vuelve a descargarlos' : 'Descarga tu zona para ver el riesgo');
  }
  map.setLayoutProperty('flood-line', 'visibility', on ? 'visible' : 'none');
}
$('#risk-layer').onchange = (e) => toggleRiskLayer(e.target.checked, true);

// ================================================================== RADARES
let camTimer;
function refreshCameras() {
  clearTimeout(camTimer);
  camTimer = setTimeout(async () => {
    if (!mapReady || !hasMaps() || map.getZoom() < 10) return;
    map.getSource('cameras').setData(await call('cameras', { bbox: visibleBbox() }));
  }, 250);
}

// ================================================================== RUTAS
async function computeRoute({ fit = true } = {}) {
  if (!dest) return;
  const from = origin || gps;
  if (!hasMaps()) {
    toast('Primero descarga tu comunidad o una zona en «Mapas sin conexión».');
    $('#btn-menu').click();
    return;
  }
  if (!from) {
    toast('Activa tu ubicación o toca el mapa y elige «Salir desde aquí».');
    startGps();
    return;
  }
  try {
    const t0 = performance.now();
    route = await call('route', { from: [from.lat, from.lon], to: [dest.lat, dest.lon], level: floodLevel(), avoidTolls: settings.avoidTolls });
    route.ms = Math.round(performance.now() - t0);
  } catch (e) {
    toast(e.message, 5000);
    return;
  }
  drawRoute();
  if (nav) { nav.setRoute(route); return; }
  showRouteSheet();
  if (fit) {
    const b = new maplibregl.LngLatBounds();
    route.coords.forEach((c) => b.extend(c));
    map.fitBounds(b, { padding: { top: 110, bottom: 300, left: 40, right: 40 }, maxZoom: 17 });
  }
}

function drawRoute() {
  if (!mapReady) return;
  map.getSource('route').setData(route ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.coords } } : empty);
  const feats = [];
  if (route && route.level > 0) {
    for (const run of route.riskRuns) {
      const coords = route.coords.filter((_, i) => route.cum[i] >= run.start - 1 && route.cum[i] <= run.end + 1);
      if (coords.length > 1) feats.push({ type: 'Feature', properties: { hard: run.hard }, geometry: { type: 'LineString', coordinates: coords } });
    }
  }
  map.getSource('route-risk').setData({ type: 'FeatureCollection', features: feats });
}

function floodNote(r) {
  if (!r.flood) return r.level > 0 ? { cls: 'warn', html: 'Tus mapas no tienen datos de riesgo de inundación: vuelve a descargarlos para usar la ruta segura.' } : null;
  if (r.level === 0) {
    return r.riskRuns.some((x) => x.hard) && weather?.level
      ? { cls: 'warn', html: 'Esta ruta pasa por un badén o paso inferior. Activa la ruta segura si llueve.' }
      : null;
  }
  const c = r.compare;
  const hardNow = r.riskRuns.filter((x) => x.hard).length;
  const extra = c ? Math.max(0, Math.round((r.duration - c.fastDuration) / 60)) : 0;
  const better = c && c.fastRiskLen - r.riskLen > 100;
  const hardAvoided = c ? Math.max(0, c.fastHard - hardNow) : 0;
  let html = `🛟 <b>Ruta segura</b> (${LEVELS[r.level].label.toLowerCase()})`;
  if (better || hardAvoided) {
    const parts = [];
    if (better) parts.push(`reduce el recorrido por zonas con riesgo de inundación de ${fmtDist(c.fastRiskLen)} a ${fmtDist(r.riskLen)}`);
    if (hardAvoided) parts.push(`evita ${hardAvoided > 1 ? `${hardAvoided} badenes o pasos inferiores` : '1 badén o paso inferior'}`);
    html += ` · ${parts.join(' y ')}${extra ? ` (+${extra} min)` : ''}`;
  } else if (!r.riskLen) html += ' · la ruta más rápida ya es segura';
  else html += ' · no hay una alternativa más segura razonable';
  if (r.riskLen) html += `<br>⚠️ Aún pasa ${fmtDist(r.riskLen)} por zonas con riesgo (en naranja). Precaución.`;
  if (r.forcedHard) html += '<br>⛔ No hay forma de llegar sin pasar por un badén o paso inferior. Si hay agua, no cruces: espera o busca otro destino.';
  return { cls: r.forcedHard ? 'danger' : r.riskLen ? 'warn' : '', html };
}

function showRouteSheet() {
  $('#r-time').textContent = fmtTime(route.duration);
  $('#r-dist').textContent = `· ${fmtDist(route.distance)}`;
  $('#r-to').textContent = `Hacia ${dest.label} · calculada en el dispositivo en ${route.ms} ms`;
  const note = floodNote(route);
  $('#r-flood').hidden = !note;
  if (note) { $('#r-flood').className = 'flood-note ' + note.cls; $('#r-flood').innerHTML = note.html; }
  $('#btn-fav-dest').textContent = favs.some((f) => near(f, dest)) ? '★' : '☆';

  // Radares en la ruta y elección con / sin peaje.
  const extras = [];
  const fixed = (route.cameras || []).filter((c) => c.kind !== 3).length;
  const lights = (route.cameras || []).filter((c) => c.kind === 3).length;
  if (fixed) extras.push(`📷 ${fixed} radar${fixed > 1 ? 'es' : ''}`);
  if (route.sections?.length) extras.push(`⏱️ ${route.sections.length} tramo${route.sections.length > 1 ? 's' : ''}`);
  if (lights) extras.push(`🚦 ${lights} semáforo${lights > 1 ? 's' : ''} con cámara`);
  if (route.tollLen > 50) extras.push(`💶 ${fmtDist(route.tollLen)} de peaje`);
  $('#r-extras').textContent = extras.join(' · ');
  const alt = route.tollAlt;
  $('#r-toll').hidden = !alt && !route.tollLen;
  if (!$('#r-toll').hidden) {
    const withT = settings.avoidTolls ? alt : route, without = settings.avoidTolls ? route : alt;
    const [bWith, bWithout] = [$('#r-toll [data-toll="0"]'), $('#r-toll [data-toll="1"]')];
    bWith.textContent = withT ? `Con peaje · ${fmtTime(withT.duration)}` : 'Con peaje';
    bWithout.textContent = without ? `Sin peaje · ${fmtTime(without.duration)}` : 'Sin peaje · no hay alternativa';
    bWith.setAttribute('aria-checked', String(!settings.avoidTolls));
    bWithout.setAttribute('aria-checked', String(settings.avoidTolls));
  }
  $('#steps-sum').textContent = `Indicaciones (${route.steps.length})`;
  const ol = $('#steps');
  ol.innerHTML = '';
  for (const s of route.steps) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="maneuver">${maneuverSvg(s)}</span><div><span>${esc(s.text)}</span><small>${s.type === 'arrive' ? '' : fmtDist(s.dist)}</small></div>`;
    ol.appendChild(li);
  }
  setSheet('route');
}

$$('#r-toll button').forEach((b) => (b.onclick = () => {
  const want = b.dataset.toll === '1';
  if (want === settings.avoidTolls) return;
  setSetting('avoidTolls', want);
  computeRoute({ fit: false });
}));

$('#btn-close-route').onclick = clearRoute;
function clearRoute() {
  route = null; dest = null; origin = null;
  destMarker.remove();
  originMarker.remove();
  drawRoute();
  setSheet(null);
  $('#q').value = '';
}

// ================================================================== NAVEGACIÓN
function startNav(simulate) {
  if (!route) return;
  if (!simulate && !gps) {
    startGps();
    return toast('Esperando señal GPS… Puedes usar «Simular» para probar la ruta.');
  }
  document.body.classList.add('navigating');
  meEl.className = 'me-nav';
  meEl.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2 20 21 12 17 4 21z" fill="#2563eb" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  follow = true;
  $('#banner').hidden = false;
  $('#speed').hidden = false;
  setSheet('nav');
  navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {});

  nav = new Navigator(route, {
    onUpdate: renderNav,
    onOffRoute: () => {
      if (simTimer) return;
      speak('Recalculando');
      toast('Te has salido de la ruta. Recalculando…');
      origin = null;
      computeRoute({ fit: false });
    },
    onArrive: () => { toast('Has llegado a tu destino 🎉'); setTimeout(stopNav, 2500); },
  });

  if (simulate) {
    let along = 0;
    const SPEED = 15, TICK = 300;
    simTimer = setInterval(() => {
      along = Math.min(route.distance, along + SPEED * 2 * (TICK / 1000));
      const p = pointAt(route, along);
      nav.update({ lat: p.lat, lon: p.lon, speed: SPEED, accuracy: 5 });
      $('#speed-v').textContent = Math.round(SPEED * 3.6);
      if (along >= route.distance) { clearInterval(simTimer); simTimer = null; }
    }, TICK);
  } else nav.update(gps);
}

function renderNav(s) {
  $('#b-icon').innerHTML = maneuverSvg(s.step);
  $('#b-dist').textContent = s.step.type === 'arrive' && s.dist < 30 ? 'Llegando' : fmtDist(s.dist);
  $('#b-text').textContent = s.step.text;
  $('#b-warn').hidden = !s.warn;
  if (s.warn) $('#b-warn').textContent = '⚠️ ' + s.warn;
  const kmh = s.speed * 3.6;
  $('#limit').hidden = !s.limit;
  if (s.limit) {
    $('#limit-v').textContent = s.limit;
    $('#limit').classList.toggle('inferred', s.limitInferred);
    $('#limit').title = s.limitInferred ? 'Límite general para este tipo de vía (no señalizado en el mapa)' : 'Velocidad máxima de la vía';
  }
  $('#speed').classList.toggle('over', !!(s.limit && kmh > s.limit + Math.max(2, settings.speedMargin)));
  let radarTxt = '', over = false;
  if (s.section) {
    radarTxt = `⏱️ Tramo · media ${Math.round(s.section.avg)} km/h${s.section.speed ? ` (límite ${s.section.speed})` : ''} · quedan ${fmtDist(s.section.left)}`;
    over = s.section.speed && s.section.avg > s.section.speed;
  } else if (s.radar) {
    radarTxt = s.radar.kind === 3
      ? `🚦 Semáforo con cámara · ${fmtDist(s.radar.dist)}`
      : `📷 Radar${s.radar.speed ? ` ${s.radar.speed}` : ''} · ${fmtDist(s.radar.dist)}`;
    over = s.radar.kind !== 3 && s.radar.speed && kmh > s.radar.speed + 2;
  }
  $('#b-radar').hidden = !radarTxt;
  $('#b-radar').textContent = radarTxt;
  $('#b-radar').classList.toggle('over', !!over);
  $('#n-eta').textContent = fmtClock(new Date(Date.now() + s.remTime * 1000));
  $('#n-time').textContent = fmtTime(s.remTime);
  $('#n-dist').textContent = fmtDist(s.remaining);
  if (!simTimer && gps) $('#speed-v').textContent = Math.round((gps.speed || 0) * 3.6);
  placeMe(s.snapped[0], s.snapped[1], s.heading);
  if (follow) {
    map.easeTo({ center: s.snapped, bearing: s.heading, pitch: 55, zoom: 17, duration: simTimer ? 300 : 900, easing: (t) => t,
      offset: [0, Math.round(map.getContainer().clientHeight * 0.18)] });
  }
}

function stopNav() {
  clearInterval(simTimer);
  simTimer = null;
  nav = null;
  speechSynthesis?.cancel();
  wakeLock?.release?.().catch(() => {});
  document.body.classList.remove('navigating');
  meEl.className = 'me';
  meEl.innerHTML = '';
  $('#banner').hidden = true;
  $('#speed').hidden = true;
  $('#btn-recenter').hidden = true;
  map.easeTo({ pitch: 0, bearing: 0 });
  if (gps) placeMe(gps.lon, gps.lat, null);
  else { meMarker.remove(); meOnMap = false; }
  if (route) showRouteSheet();
}

map.on('dragstart', () => { if (nav) { follow = false; $('#btn-recenter').hidden = false; } });
$('#btn-recenter').onclick = () => { follow = true; $('#btn-recenter').hidden = true; };
$('#btn-go').onclick = () => startNav(false);
$('#btn-sim').onclick = () => startNav(true);
$('#btn-stop').onclick = stopNav;
$('#btn-mute').onclick = () => setSetting('voice', !settings.voice);
const renderMute = () => { $('#btn-mute').textContent = settings.voice ? '🔊' : '🔇'; setMuted(!settings.voice); };
renderMute();

// ================================================================== SOS
function sosPoint() {
  if (gps) return { lat: gps.lat, lon: gps.lon, acc: gps.accuracy, real: true };
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng, real: false };
}
function updateSosCoords() {
  const p = sosPoint();
  $('#sos-coords').textContent = p.real
    ? `Tu posición: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} (±${Math.round(p.acc)} m)`
    : `Sin GPS todavía · centro del mapa: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
}

async function openSos() {
  startGps();
  setSheet('sos');
  updateSosCoords();
  $('#sos-share-sub').textContent = contacts.length
    ? `por SMS a ${contacts.map((c) => c.name).join(', ')}`
    : 'Toca para elegir tus contactos de emergencia';
  const p = sosPoint();
  for (const btn of $$('.sos-btn.near')) {
    const sub = btn.querySelector('small');
    btn.dataset.lat = '';
    if (!hasMaps()) { sub.textContent = 'Descarga tu zona para usarlo sin conexión'; continue; }
    const [it] = await call('nearby', { near: [p.lat, p.lon], cat: btn.dataset.cat });
    if (!it) { sub.textContent = 'No hay ninguno en tus mapas descargados'; continue; }
    sub.textContent = `${it.name || it.label} · ${fmtDist(it.dist)}${it.phone ? ' · ' + it.phone : ''}`;
    Object.assign(btn.dataset, { lat: it.lat, lon: it.lon, name: it.name || it.label });
  }
}
$('#btn-sos').onclick = openSos;
$('#btn-close-sos').onclick = backToMain;
$$('.sos-btn.near').forEach((btn) => (btn.onclick = () => {
  if (!btn.dataset.lat) return toast(btn.querySelector('small').textContent);
  if (!gps) origin = null;
  setDest({ lat: +btn.dataset.lat, lon: +btn.dataset.lon, label: btn.dataset.name });
}));

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function locationText() {
  const p = sosPoint();
  const ll = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
  return `🆘 Necesito ayuda. Estoy aquí: ${ll}${p.acc ? ` (±${Math.round(p.acc)} m)` : ''} https://www.openstreetmap.org/?mlat=${p.lat.toFixed(5)}&mlon=${p.lon.toFixed(5)}#map=18/${p.lat.toFixed(5)}/${p.lon.toFixed(5)}`;
}
$('#sos-share').onclick = async () => {
  if (!contacts.length) { openContacts(); return toast('Añade al menos un contacto de emergencia'); }
  const body = encodeURIComponent(locationText());
  const tels = contacts.map((c) => c.tel.replace(/[^\d+]/g, ''));
  // iOS y Android usan formatos distintos para varios destinatarios.
  location.href = isIOS ? `sms://open?addresses=${tels.join(',')}&body=${body}` : `sms:${tels.join(',')}?body=${body}`;
};
$('#btn-more-sos').onclick = () => { $('#sos-more').hidden = !$('#sos-more').hidden; if (!$('#sos-more').hidden) renderSosList(); };

const CATS = [
  ['', 'Todo'], ['hospital', 'Hospitales'], ['clinic', 'Centros de salud'], ['pharmacy', 'Farmacias'], ['fuel', 'Gasolineras'],
  ['defibrillator', 'Desfibriladores'], ['police', 'Policía'], ['fire_station', 'Bomberos'], ['drinking_water', 'Agua potable'], ['shelter', 'Refugios'],
];
let sosCat = '';
async function renderSosList() {
  const chips = $('#sos-cats');
  chips.innerHTML = '';
  for (const [k, label] of CATS) {
    const b = document.createElement('button');
    b.className = 'chip' + (k === sosCat ? ' on' : '');
    b.textContent = label;
    b.onclick = () => { sosCat = k; renderSosList(); };
    chips.appendChild(b);
  }
  const ul = $('#sos-list');
  ul.innerHTML = '';
  if (!hasMaps()) { ul.innerHTML = '<li class="muted">Descarga tu zona para ver los servicios sin conexión.</li>'; return; }
  const p = sosPoint();
  const list = await call('nearby', { near: [p.lat, p.lon], cat: sosCat });
  if (!list.length) ul.innerHTML = '<li class="muted">No hay servicios de este tipo en tus mapas.</li>';
  for (const it of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dir maneuver">${arrowSvg(it.bearing)}</span><div class="meta"><b>${esc(it.name || it.label)}</b><small>${esc(it.name ? it.label : '')}${it.phone ? ' · ' + esc(it.phone) : ''}</small></div><span class="d">${fmtDist(it.dist)}</span>`;
    li.onclick = () => setDest({ lat: it.lat, lon: it.lon, label: it.name || it.label });
    ul.appendChild(li);
  }
}

// ------------------------------------------------------------------ contactos
function openContacts() { setSheet('contacts'); renderContacts(); }
function renderContacts() {
  const ul = $('#contacts');
  ul.innerHTML = contacts.length ? '' : '<li class="muted">Aún no tienes contactos de emergencia.</li>';
  contacts.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="meta"><b>${esc(c.name)}</b><small>${esc(c.tel)}</small></div><button class="del" aria-label="Quitar ${esc(c.name)}">✕</button>`;
    li.querySelector('.del').onclick = () => { contacts.splice(i, 1); store.set('contacts', contacts); renderContacts(); };
    ul.appendChild(li);
  });
  $('#btn-pick-contact').hidden = !('contacts' in navigator && 'select' in navigator.contacts);
}
$('#btn-contacts').onclick = openContacts;
$('#btn-close-contacts').onclick = openSos;
$('#contact-form').onsubmit = (e) => {
  e.preventDefault();
  const name = $('#c-name').value.trim(), tel = $('#c-tel').value.trim();
  if (!name || !/\d{6,}/.test(tel.replace(/\D/g, ''))) return toast('Escribe un nombre y un teléfono válido');
  contacts.push({ name, tel });
  store.set('contacts', contacts);
  e.target.reset();
  renderContacts();
};
$('#btn-pick-contact').onclick = async () => {
  try {
    const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
    for (const p of picked) if (p.tel?.[0]) contacts.push({ name: p.name?.[0] || p.tel[0], tel: p.tel[0] });
    store.set('contacts', contacts);
    renderContacts();
  } catch { /* cancelado */ }
};

// ================================================================== FAVORITOS
const near = (a, b) => a && b && haversine(a.lat, a.lon, b.lat, b.lon) < 30;
function drawFavs() {
  if (!mapReady) return;
  map.getSource('favs').setData({
    type: 'FeatureCollection',
    features: favs.map((f) => ({ type: 'Feature', properties: { id: f.id, name: f.name }, geometry: { type: 'Point', coordinates: [f.lon, f.lat] } })),
  });
}
function addFav(p, suggested) {
  const name = prompt('Nombre del favorito (p. ej. Casa, Trabajo):', suggested || '');
  if (!name) return;
  favs.push({ id: Date.now().toString(36), name: name.trim(), lat: p.lat, lon: p.lon });
  store.set('favs', favs);
  drawFavs();
  toast(`★ «${name.trim()}» guardado`);
}
function renderFavs() {
  const ul = $('#favs');
  ul.innerHTML = favs.length ? '' : '<li class="muted">Guarda sitios tocando el mapa o con la ☆ de una ruta.</li>';
  for (const f of favs) {
    const li = document.createElement('li');
    const d = gps ? ` · ${fmtDist(haversine(gps.lat, gps.lon, f.lat, f.lon))}` : '';
    li.innerHTML = `<span class="dir">★</span><div class="meta"><b>${esc(f.name)}</b><small>${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}${d}</small></div><button class="del" aria-label="Borrar ${esc(f.name)}">✕</button>`;
    li.onclick = (e) => {
      if (e.target.closest('.del')) return;
      setDest({ lat: f.lat, lon: f.lon, label: f.name });
    };
    li.querySelector('.del').onclick = () => {
      if (!confirm(`¿Borrar «${f.name}» de favoritos?`)) return;
      favs = favs.filter((x) => x.id !== f.id);
      store.set('favs', favs);
      drawFavs();
      renderFavs();
    };
    ul.appendChild(li);
  }
}
$('#btn-favs').onclick = () => { setSheet('favs'); renderFavs(); };
$('#btn-close-favs').onclick = backToMain;
$('#btn-fav-here').onclick = () => (gps ? addFav(gps, 'Casa') : (startGps(), toast('Esperando tu posición GPS…')));
$('#btn-fav-dest').onclick = () => {
  const ex = favs.find((f) => near(f, dest));
  if (ex) {
    favs = favs.filter((f) => f !== ex);
    store.set('favs', favs);
    toast(`«${ex.name}» quitado de favoritos`);
  } else addFav(dest, /^-?\d/.test(dest.label) ? '' : dest.label);
  drawFavs();
  showRouteSheet();
};

// ================================================================== AJUSTES
const APP_VERSION = '0.4.0';

function renderSettings() {
  $$('#sheet-settings input.switch').forEach((i) => (i.checked = !!settings[i.dataset.set]));
  $$('#sheet-settings .seg[data-seg]').forEach((seg) => {
    for (const b of seg.querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(String(settings[seg.dataset.seg]) === b.dataset.v));
    }
  });
  $('#set-emergency').value = settings.emergencyNumber;
  $('#set-contacts-n').textContent = contacts.length ? `${contacts.length} ›` : 'Ninguno ›';
  $('#set-favs-n').textContent = `${favs.length} ›`;
  const maps = Object.values(catalog).map((st) => st.name || (st.region ? st.region : 'Zona a medida'));
  $('#set-maps-n').textContent = maps.length ? `${maps.length} descargado${maps.length > 1 ? 's' : ''} ›` : 'Ninguno ›';
}

$('#btn-settings').onclick = () => { setSheet('settings'); renderSettings(); };
$('#btn-close-settings').onclick = backToMain;
$('#btn-close-credits').onclick = () => { setSheet('settings'); renderSettings(); };
$('#app-version').textContent = `versión ${APP_VERSION}`;

$$('#sheet-settings input.switch').forEach((i) => (i.onchange = () => setSetting(i.dataset.set, i.checked)));
$$('#sheet-settings .seg[data-seg]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => (b.onclick = () => {
  const cur = settings[seg.dataset.seg];
  setSetting(seg.dataset.seg, typeof cur === 'number' ? Number(b.dataset.v) : b.dataset.v);
  renderSettings();
})));
$('#set-emergency').onchange = (e) => {
  const v = e.target.value.replace(/[^\d]/g, '');
  if (v.length < 3) { toast('Escribe un número de emergencias válido'); e.target.value = settings.emergencyNumber; return; }
  setSetting('emergencyNumber', v);
};
$$('#sheet-settings [data-open]').forEach((b) => (b.onclick = () => {
  const what = b.dataset.open;
  if (what === 'contacts') { setSheet('contacts'); renderContacts(); $('#btn-close-contacts').onclick = () => { setSheet('settings'); renderSettings(); $('#btn-close-contacts').onclick = openSos; }; }
  else if (what === 'favs') { setSheet('favs'); renderFavs(); }
  else if (what === 'maps') { setSheet(null); $('#btn-menu').click(); }
  else if (what === 'credits') setSheet('credits');
}));

$('#btn-wipe-personal').onclick = () => {
  if (!confirm('¿Borrar todos tus favoritos y contactos de emergencia? No se puede deshacer.')) return;
  favs = []; contacts = [];
  store.set('favs', favs); store.set('contacts', contacts);
  drawFavs();
  renderSettings();
  toast('Favoritos y contactos borrados');
};
$('#btn-wipe-all').onclick = async () => {
  if (!confirm('¿Borrar TODOS los datos de Rumbo en este dispositivo (mapas descargados, favoritos, contactos y ajustes)? No se puede deshacer.')) return;
  worker.terminate();
  try { localStorage.clear(); } catch { /* nada */ }
  for (const k of await caches.keys()) await caches.delete(k);
  await new Promise((r) => { const q = indexedDB.deleteDatabase('rumbo'); q.onsuccess = q.onerror = q.onblocked = r; });
  for (const reg of (await navigator.serviceWorker?.getRegistrations()) || []) await reg.unregister();
  location.reload();
};

function renderEmergencyNumber() {
  $('#sos-call').href = `tel:${settings.emergencyNumber}`;
  $('#sos-call-label').textContent = `Llamar al ${settings.emergencyNumber}`;
}
renderEmergencyNumber();

onSettingChange((key) => {
  if (key === 'voice') renderMute();
  if (key === 'theme') applyTheme();
  if (key === 'emergencyNumber') renderEmergencyNumber();
  if (key === 'floodMode') renderRain();
  if ((key === 'avoidTolls' || key === 'floodMode') && dest && sheetNow !== 'rain') computeRoute({ fit: false });
});

// ================================================================== BIENVENIDA
function showOnboarding() {
  const ob = $('#onboarding');
  let step = 0;
  const go = (n) => {
    step = n;
    if (n > 3) { ob.hidden = true; store.set('onboarded', true); return; }
    $$('.ob-step').forEach((s) => (s.hidden = Number(s.dataset.step) !== n));
    $$('.ob-dots span').forEach((d, i) => d.classList.toggle('on', i === n));
    if (n === 2) fillRegions();
  };
  ob.hidden = false;
  go(0);
  $$('#onboarding [data-next]').forEach((b) => (b.onclick = () => go(step + 1)));
  $('#ob-locate').onclick = () => { centerOnFix = true; startGps(); go(2); };
  $('#ob-contacts').onclick = () => {
    go(4);
    setSheet('contacts');
    renderContacts();
  };

  function fillRegions() {
    const sel = $('#ob-region');
    const regions = (regionIndex?.regions || []).filter((r) => !r.main);
    if (!regions.length) {
      $('#ob-region-text').textContent = 'Aún no hay comunidades publicadas. Puedes descargar la zona que ves en el mapa desde el botón ⬇.';
      sel.hidden = true;
      $('#ob-region-size').textContent = '';
      $('#ob-download').textContent = 'Abrir mapas sin conexión';
      $('#ob-download').onclick = () => { go(3); $('#btn-menu').click(); };
      return;
    }
    sel.hidden = false;
    const c = gps ? [gps.lat, gps.lon] : [map.getCenter().lat, map.getCenter().lng];
    const inside = (r) => c[0] >= r.bbox.s && c[0] <= r.bbox.n && c[1] >= r.bbox.w && c[1] <= r.bbox.e;
    const area = (r) => (r.bbox.n - r.bbox.s) * (r.bbox.e - r.bbox.w);
    const guess = regions.filter(inside).sort((a, b) => area(a) - area(b))[0];
    sel.innerHTML = regions.map((r) => `<option value="${esc(r.id)}"${r === guess ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
    const size = () => {
      const r = regions.find((x) => x.id === sel.value);
      $('#ob-region-size').textContent = r ? `≈ ${mb(r.size + tilesEstimate(r).bytes)} · mejor con wifi` : '';
    };
    sel.onchange = size;
    size();
    $('#ob-download').textContent = 'Descargar';
    $('#ob-download').onclick = () => {
      const r = regions.find((x) => x.id === sel.value);
      go(3);
      if (r) {
        downloadRegion(r);
        toast(`Descargando ${r.name}… puedes seguir usando la app. El progreso está en ⬇.`, 6000);
      }
    };
  }
}
$('#btn-replay-onboarding').onclick = () => { setSheet(null); showOnboarding(); };

// ================================================================== ARRANQUE
call('init').then((c) => {
  catalog = c;
  drawAreas();
  if (store.get('riskLayer')) toggleRiskLayer(true);
  updateNet();
  if (!hasMaps() && store.get('onboarded')) setTimeout(() => toast('Descarga tu comunidad (⬇) para usar Rumbo sin conexión.', 6000), 1200);
});
if (!store.get('onboarded')) loadRegionIndex().then(showOnboarding);
else loadRegionIndex();
renderRain();
refreshWeather();

// Solo en desarrollo: acceso al mapa desde la consola para pruebas.
if (location.hostname === 'localhost') window.rumbo = { map, setDest, setOrigin, get route() { return route; } };
