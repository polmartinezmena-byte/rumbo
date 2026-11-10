// Conducción sin ruta: aunque no elijas destino, Rumbo avisa de lo que tienes por delante según tu
// rumbo (radares fijos, tramos con su velocidad media y semáforos con cámara) y del límite de la vía.
import { haversine, bearing, fmtDistSpeech } from './geo.js';
import { settings } from './settings.js';

const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const START_KMH = 15;   // a partir de aquí se considera que vas conduciendo
const STOP_AFTER = 90;  // s parado (< 5 km/h) para salir del modo

export class FreeDrive {
  /**
   * @param ask   (lat, lon, heading) → Promise<{cams, limit}>  (consulta al worker)
   * @param speak texto → voz
   * @param onState estado → pinta la interfaz (null = modo apagado)
   */
  constructor({ ask, speak, onState }) {
    Object.assign(this, { ask, speak, onState });
    this.active = false;
    this.cams = [];
    this.limit = null;
    this.said = new Set();
    this.sec = null;
    this.last = null;      // última posición (para el rumbo si el GPS no lo da)
    this.heading = null;
    this.lastAsk = null;
    this.slowSince = 0;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.sec = null;
    this.onState(null);
  }

  update({ lat, lon, speed = 0, heading = null }) {
    const now = Date.now() / 1000;
    const kmh = (speed || 0) * 3.6;
    // Rumbo: el del GPS si lo da (en marcha); si no, el de los últimos metros recorridos.
    if (this.last) {
      const moved = haversine(this.last.lat, this.last.lon, lat, lon);
      if (moved > 12) {
        this.heading = heading != null && !Number.isNaN(heading) && kmh > 8 ? heading : bearing(this.last.lat, this.last.lon, lat, lon);
        if (this.sec) this.sec.travelled += moved;
        this.last = { lat, lon };
      }
    } else this.last = { lat, lon };

    if (!this.active) {
      if (!settings.freeDrive || kmh < START_KMH) return;
      this.active = true;
      this.slowSince = 0;
    }
    if (kmh < 5) {
      this.slowSince ||= now;
      if (now - this.slowSince > STOP_AFTER && !this.sec) return this.stop();
    } else this.slowSince = 0;

    // Se pregunta al worker cada ~2 s o cada 80 m.
    if (!this.lastAsk || now - this.lastAsk.t > 2 || haversine(this.lastAsk.lat, this.lastAsk.lon, lat, lon) > 80) {
      this.lastAsk = { t: now, lat, lon };
      this.ask(lat, lon, this.heading).then((r) => { this.cams = r?.cams || []; this.limit = r?.limit || null; }).catch(() => {});
    }

    const h = this.heading;
    let radar = null;
    if (h != null) {
      for (const c of this.cams) {
        const d = haversine(lat, lon, c.lat, c.lon);
        if (d > 1500) { this.said.delete(c.id); continue; }
        // Por delante: en un cono de ±30° y a menos de 35 m de tu línea de avance.
        const off = angle(bearing(lat, lon, c.lat, c.lon), h);
        if (off > 30 || d * Math.sin((off * Math.PI) / 180) > 35) continue;
        if (c.dir >= 0 && angle(c.dir, h) > 70) continue; // es del otro sentido
        if (c.kind === 2) continue; // final de tramo: solo cuenta dentro del tramo
        const on = c.kind === 3 ? settings.alertRedLight : c.kind === 1 ? settings.alertSection : settings.alertFixed;
        if (!on) continue;
        if (!radar || d < radar.dist) radar = { ...c, dist: d };
      }
    }

    // Avisos por voz (una vez por radar) y entrada en un tramo.
    if (radar) {
      const reach = radar.kind === 3 ? 250 : radar.kind === 1 ? 600 : Math.max(300, (speed || 0) * 20);
      if (radar.dist <= reach && !this.said.has(radar.id)) {
        this.said.add(radar.id);
        this.speak(radar.kind === 3 ? `Semáforo con cámara a ${fmtDistSpeech(radar.dist)}`
          : radar.kind === 1 ? `Tramo de control de velocidad en ${fmtDistSpeech(radar.dist)}${radar.speed ? `. Límite ${radar.speed}` : ''}`
          : `Radar a ${fmtDistSpeech(radar.dist)}${radar.speed ? `. Límite ${radar.speed}` : ''}`, radar.kind === 1 ? 'section' : 'radar');
      }
      if (radar.kind === 1 && radar.end && radar.dist < 40 && (!this.sec || this.sec.id !== radar.id)) {
        const len = haversine(radar.lat, radar.lon, radar.end[0], radar.end[1]);
        this.sec = { id: radar.id, end: radar.end, len, speed: radar.speed || this.limit?.limit || 0, t0: now, travelled: 0, minLeft: len };
        this.speak(`Inicio de tramo${this.sec.speed ? `. Mantén la media por debajo de ${this.sec.speed}` : ''}`);
      }
    }

    // Dentro de un tramo: lo que queda, tu media y el final.
    let section = null;
    if (this.sec) {
      const s = this.sec;
      const left = haversine(lat, lon, s.end[0], s.end[1]);
      s.minLeft = Math.min(s.minLeft, left);
      const el = now - s.t0;
      const avg = el > 3 ? (s.travelled / el) * 3.6 : kmh;
      const passed = left < 30 || (s.minLeft < 120 && left > s.minLeft + 60);
      const lost = left > s.len * 1.6 + 300; // te has ido por otra carretera
      if (passed || lost) {
        if (passed) this.speak(`Fin del tramo. Velocidad media ${Math.round(avg)}`);
        this.said.add(s.id);
        this.sec = null;
      } else {
        section = { speed: s.speed, avg, left, len: s.len, done: Math.max(0, s.len - left) };
        if (radar?.id === s.id) radar = null;
      }
    }

    this.onState({ radar, section, limit: this.limit, speed: speed || 0 });
  }
}
