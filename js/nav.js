// Guiado giro a giro: proyecta la posición GPS sobre la ruta, decide la siguiente maniobra,
// la anuncia por voz y detecta cuándo te sales de la ruta.
import { bearing, fmtDistSpeech } from './geo.js';
import { settings } from './settings.js';
import { nativeSpeak, nativeStop } from './native.js';
import { lanesSpeech } from './lanes.js';

const RAD = Math.PI / 180;
const M_PER_DEG = 111320;

// Punto a una distancia dada a lo largo de la ruta (para el simulador).
export function pointAt(route, along) {
  const { coords, cum } = route;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid; else hi = mid;
  }
  const a = coords[lo], b = coords[Math.min(lo + 1, coords.length - 1)];
  const seg = cum[lo + 1] - cum[lo] || 1;
  const t = Math.min(1, Math.max(0, (along - cum[lo]) / seg));
  return {
    lon: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    heading: bearing(a[1], a[0], b[1], b[0]),
  };
}

let muted = false;
export const setMuted = (m) => { muted = m; if (m && !nativeStop()) globalThis.speechSynthesis?.cancel(); };
export const isMuted = () => muted;

// Sonido suave antes de cada indicación (dos notas cortas generadas aquí: no hay ficheros de audio).
// iOS solo deja sonar audio después de un toque: el contexto se crea y se «despierta» con el primero.
let actx = null;
const unlock = () => { try { actx ??= new (globalThis.AudioContext || globalThis.webkitAudioContext)(); actx.resume?.(); } catch { /* sin audio */ } };
globalThis.addEventListener?.('pointerdown', unlock, { once: false, passive: true });
// Cada aviso suena distinto para saber qué es sin mirar.
const TONES = {
  info: [[880, 0], [1318.5, 0.12]],                     // indicación: dos notas que suben
  radar: [[1567.98, 0], [1567.98, 0.13]],               // radar: dos pitidos agudos
  section: [[659.25, 0], [1318.5, 0.14]],               // tramo: grave y agudo
  arrive: [[783.99, 0], [987.77, 0.11], [1174.66, 0.22]], // llegada: acorde que sube
};
export function playSound(kind = 'info') {
  if (!settings.chime) return 0;
  return chime(kind);
}
function chime(kind = 'info') {
  if (!actx || actx.state !== 'running') return 0;
  const t = actx.currentTime;
  for (const [f, d] of TONES[kind] || TONES.info) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t + d);
    g.gain.linearRampToValueAtTime(0.18, t + d + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.28);
    o.connect(g).connect(actx.destination);
    o.start(t + d); o.stop(t + d + 0.3);
  }
  return 380; // ms hasta empezar a hablar
}

export function speak(text, kind = 'info') {
  if (muted || !settings.voice) return;
  const wait = settings.chime ? chime(kind) : 0;
  if (wait) { setTimeout(() => say(text), wait); return; }
  say(text);
}
function say(text) {
  if (nativeSpeak(text)) return; // app Android/iOS: motor de voz del sistema
  if (!('speechSynthesis' in globalThis)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'es-ES';
  const voice = speechSynthesis.getVoices().find((v) => v.lang?.startsWith('es'));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

const INC_SPEECH = {
  cortada: 'carretera cortada', calzada: 'calzada cortada', inundacion: 'inundación', accidente: 'accidente',
  carril: 'carril cortado', obras: 'obras', retencion: 'retención', meteo: 'meteorología adversa',
  obstaculo: 'obstáculo en la vía', otro: 'incidencia',
};

export class Navigator {
  constructor(route, cb) {
    this.cb = cb;
    this.setRoute(route);
  }

  setRoute(route) {
    this.r = route;
    this.seg = 0;
    this.stepIdx = 1;
    this.spoken = new Set();
    this.offCount = 0;
    this.done = false;
    this.warned = new Set();
    this.camIdx = 0;
    this.secT = {};
    const first = route.steps[0];
    const next = route.steps[1];
    const zbe = route.zbeLimit
      ? route.zbeLimit.reason === 'destino-dentro'
        ? ' Tu destino está en una zona de bajas emisiones donde no puedes entrar: te llevo al punto más cercano fuera de ella.'
        : ' No se puede llegar sin entrar en una zona de bajas emisiones prohibida para tu etiqueta: te llevo hasta su límite.'
      : '';
    speak((next && next.type !== 'arrive'
      ? `${first.text}. Después, ${lowerFirst(next.text)}.`
      : `${first.text}.`) + zbe);
  }

  project(lat, lon, from, to) {
    const { coords, cum } = this.r;
    const kx = Math.cos(lat * RAD) * M_PER_DEG;
    let best = Infinity, bj = from, bt = 0;
    for (let j = from; j < to; j++) {
      const ax = coords[j][0] * kx, ay = coords[j][1] * M_PER_DEG;
      const dx = coords[j + 1][0] * kx - ax, dy = coords[j + 1][1] * M_PER_DEG - ay;
      const px = lon * kx - ax, py = lat * M_PER_DEG - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      const t = Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
      const ex = px - t * dx, ey = py - t * dy;
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d < best) { best = d; bj = j; bt = t; }
    }
    return { off: best, j: bj, t: bt, along: cum[bj] + bt * (cum[bj + 1] - cum[bj]) };
  }

  update({ lat, lon, speed = 0, accuracy = 10 }) {
    if (this.done) return;
    const n = this.r.coords.length - 1;
    let p = this.project(lat, lon, Math.max(0, this.seg - 3), Math.min(n, this.seg + 80));
    if (p.off > 60) p = this.project(lat, lon, 0, n);
    this.seg = p.j;

    if (p.off > Math.max(35, accuracy * 1.5)) {
      if (++this.offCount >= 3) {
        this.offCount = 0;
        this.cb.onOffRoute?.();
      }
    } else this.offCount = 0;

    const steps = this.r.steps;
    while (this.stepIdx < steps.length - 1 && steps[this.stepIdx].along <= p.along + 3) this.stepIdx++;
    const step = steps[this.stepIdx];
    const dist = Math.max(0, step.along - p.along);

    const key = this.stepIdx;
    const nearTh = 35 + Math.max(0, speed) * 3;
    if (dist <= nearTh && !this.spoken.has(key + 'n')) {
      this.spoken.add(key + 'n').add(key + 'f');
      speak(step.text);
    } else if (dist <= 400 && dist > nearTh + 80 && !this.spoken.has(key + 'f')) {
      this.spoken.add(key + 'f');
      const lane = lanesSpeech(step.lanes);
      speak(`En ${fmtDistSpeech(dist)}, ${lowerFirst(step.text)}${lane ? `. ${lane}` : ''}`);
    }

    // Avisos de tramos con riesgo de inundación (solo con el modo ruta segura activo).
    let warn = null;
    if (this.r.level > 0) {
      (this.r.riskRuns || []).forEach((run, i) => {
        const ahead = run.start - p.along;
        if (ahead > 350 || p.along > run.end) return;
        warn = run.hard ? 'Paso inferior o badén: no cruces si hay agua' : 'Tramo con riesgo de inundación';
        if (this.warned.has(i)) return;
        this.warned.add(i);
        speak(run.hard
          ? 'Atención: más adelante hay un paso inferior o un badén. Si hay agua, no lo cruces.'
          : 'Atención: más adelante, tramo con riesgo de inundación. Circula con precaución.');
      });
    }

    // Radares fijos y semáforos con cámara.
    let radar = null;
    const cams = this.r.cameras || [];
    const camOn = (c) => (c.kind === 3 ? settings.alertRedLight : settings.alertFixed);
    while (this.camIdx < cams.length && (cams[this.camIdx].along < p.along - 15 || !camOn(cams[this.camIdx]))) this.camIdx++;
    const cam = cams[this.camIdx];
    if (cam) {
      const d = cam.along - p.along;
      if (d <= Math.max(300, speed * 20)) {
        radar = { kind: cam.kind, speed: cam.speed, dist: Math.max(0, d) };
        if (!this.spoken.has('c' + this.camIdx)) {
          this.spoken.add('c' + this.camIdx);
          speak(cam.kind === 3
            ? `Semáforo con cámara a ${fmtDistSpeech(d)}`
            : `Radar a ${fmtDistSpeech(d)}${cam.speed ? `. Límite ${cam.speed}` : ''}`, 'radar');
        }
      }
    }

    // Radares de tramo: aviso previo, inicio, velocidad media y fin.
    let section = null;
    const now = performance.now() / 1000;
    (settings.alertSection ? this.r.sections || [] : []).forEach((sec, i) => {
      const toStart = sec.start - p.along;
      if (toStart > 0 && toStart <= 600 && !this.spoken.has('s' + i)) {
        this.spoken.add('s' + i);
        speak(`Tramo de control de velocidad en ${fmtDistSpeech(toStart)}${sec.speed ? `. Límite ${sec.speed}` : ''}`, 'section');
      }
      if (p.along >= sec.start && p.along <= sec.end) {
        if (!this.secT[i]) {
          this.secT[i] = { t: now, a: p.along };
          speak(`Inicio de tramo de ${fmtDistSpeech(sec.end - sec.start)}${sec.speed ? `. Mantén la media por debajo de ${sec.speed}` : ''}`);
        }
        const st = this.secT[i];
        const el = now - st.t;
        section = { speed: sec.speed, avg: el > 3 ? ((p.along - st.a) / el) * 3.6 : speed * 3.6, left: sec.end - p.along, len: sec.end - sec.start, done: p.along - sec.start };
      } else if (p.along > sec.end && this.secT[i] && !this.spoken.has('se' + i)) {
        this.spoken.add('se' + i);
        const st = this.secT[i];
        speak(`Fin del tramo. Velocidad media ${Math.round(((sec.end - st.a) / Math.max(1, now - st.t)) * 3.6)}`);
      }
    });

    // Incidencias de la DGT más adelante (aviso visual a 2 km, por voz a 1 km).
    let live = null;
    const incs = this.r.incidents || [];
    for (let i = 0; i < incs.length; i++) {
      const ahead = incs[i].along - p.along;
      if (ahead < -30) continue;
      if (ahead > 2000) break;
      const it = incs[i];
      live = { kind: 'inc', k: it.k, road: it.road, dist: Math.max(0, ahead), bad: /cortada|calzada|inundacion|accidente/.test(it.k) };
      if (ahead <= 1000 && !this.spoken.has('i' + i)) {
        this.spoken.add('i' + i);
        speak(`Atención: ${INC_SPEECH[it.k] || 'incidencia'}${it.road ? ` en ${it.road}` : ''} a ${fmtDistSpeech(Math.max(50, ahead))}`);
      }
      break;
    }
    // Zonas de Bajas Emisiones: aviso al acercarte y mientras estás dentro.
    (this.r.zbe || []).forEach((z, i) => {
      const ahead = z.start - p.along;
      const inside = p.along >= z.start && p.along <= z.end;
      if (!(inside || (ahead > 0 && ahead <= 500))) return;
      if (!live || z.banned) live = { kind: 'zbe', name: z.name.replace(/^ZBE\s*/i, ''), banned: z.banned, inside, dist: Math.max(0, ahead), bad: z.banned };
      if (z.banned && !this.spoken.has('z' + i)) {
        this.spoken.add('z' + i);
        speak(`Atención: vas a entrar en la zona de bajas emisiones ${z.name.replace(/^ZBE\s*/i, '')}. Con tu etiqueta no puedes circular ahora.`);
      }
    });

    // Límite de la vía actual y aviso si lo superas durante varios segundos (máx. uno cada 45 s).
    const limit = this.r.lim?.[p.j] || 0;
    const limitInferred = !!this.r.limInf?.[p.j];
    const kmh = speed * 3.6;
    if (settings.speedWarning && limit && kmh > limit + settings.speedMargin) {
      this.overCount = (this.overCount || 0) + 1;
      if (this.overCount >= 3 && now - (this.overSaid ?? -Infinity) > 45) {
        this.overSaid = now;
        speak(`Atención: el límite es ${limit}`);
      }
    } else this.overCount = 0;

    const remaining = Math.max(0, this.r.distance - p.along);
    const remTime = this.r.duration * (remaining / (this.r.distance || 1));
    const a = this.r.coords[p.j], b = this.r.coords[p.j + 1];
    const snapped = [a[0] + (b[0] - a[0]) * p.t, a[1] + (b[1] - a[1]) * p.t];

    this.cb.onUpdate?.({
      step, dist, remaining, remTime, snapped, along: p.along,
      heading: bearing(a[1], a[0], b[1], b[0]),
      offRoute: p.off,
      warn,
      radar,
      section,
      speed,
      limit,
      limitInferred,
      live,
    });

    if (remaining < 20) {
      this.done = true;
      this.cb.onArrive?.();
    }
  }
}
