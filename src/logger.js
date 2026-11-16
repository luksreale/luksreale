// Registro de viaje: lee en loop los sensores de 5 V + contexto, detecta anomalias,
// guarda en el telefono (IndexedDB, solo local) un resumen por viaje y el detalle
// alrededor de cada evento. Solo lectura: todo pasa por Diag.q -> assertSafe.
import { ALL, readAny, supportedSet } from './extra.js';
import { parseFrames, dtcStr } from './elm.js';

export const TRIP_PIDS = [0x0C, 0x0D, 0x05, 0x0B, 0x33, 0x23, 0x49, 0x4A, 0x2C, 0x2D, 0x6A, 0x42, 0x04];
const RING = 25;          // muestras guardadas antes de cada evento
const AFTER = 10;         // muestras guardadas despues
const MAX_EVENTS = 60;    // por viaje
const DTC_EVERY_MS = 60000;

// ---- almacenamiento local (IndexedDB). No sale del telefono.
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('s10diag', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('trips', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('trips', mode); const out = fn(t.objectStore('trips')); t.oncomplete = () => res(out.result ?? out); t.onerror = () => rej(t.error); });
}
export const saveTrip = (trip) => tx('readwrite', (s) => s.put(trip));
export const listTrips = () => tx('readonly', (s) => s.getAll());
export const clearTrips = () => tx('readwrite', (s) => s.clear());

async function readDtcs(diag) {
  const out = [];
  for (const [mode, tag] of [['03', ''], ['07', ' (pend)']]) {
    const resp = parseInt(mode, 16) + 0x40;
    for (const msgs of Object.values(await diag.q(mode, 4000))) for (const m of msgs) if (m[0] === resp) {
      const d = m.slice(2); for (let i = 0; i + 1 < d.length; i += 2) if (d[i] || d[i + 1]) out.push(dtcStr(d[i], d[i + 1]) + tag);
    }
  }
  return out.sort();
}
async function readMil(diag) {
  for (const msgs of Object.values(await diag.q('0101'))) for (const m of msgs) if (m[0] === 0x41 && m[1] === 1) return !!(m[2] & 0x80);
  return null;
}

// Reglas de anomalia para una muestra s = {pid: valor|null}
function anomalies(s, prev, baro) {
  const a = [], rpm = s[0x0C] ?? 0;
  for (const [p, v] of Object.entries(s)) if (v === null && prev && prev[p] !== null && prev[p] !== undefined) a.push(`${ALL[p][0]} sin respuesta`);
  const d = s[0x49], e = s[0x4A];
  if (d != null && e != null && Math.abs(e - d / 2) > 6) a.push(`Pedal D ${d}% / E ${e}% no concuerdan`);
  if (d != null && (d < 3 || d > 97)) a.push(`Pedal D en extremo (${d}%)`);
  if (e != null && (e < 1 || e > 97)) a.push(`Pedal E en extremo (${e}%)`);
  const map = s[0x0B];
  if (map != null && baro && rpm === 0 && Math.abs(map - baro) > 10) a.push(`MAP ${map} vs baro ${baro} con motor parado`);
  if (map != null && rpm > 400 && map < 40) a.push(`MAP muy bajo (${map} kPa) en marcha`);
  const rail = s[0x23];
  if (rail != null && rpm > 600 && rail < 15000) a.push(`Presion rail baja (${rail} kPa) en marcha`);
  if (prev) for (const [p, lim] of [[0x0B, 60], [0x23, 60000]]) {
    if (s[p] != null && prev[p] != null && Math.abs(s[p] - prev[p]) > lim) a.push(`Salto en ${ALL[p][0]}: ${prev[p]} -> ${s[p]}`);
  }
  return a;
}

export class TripLogger {
  constructor(diag, ui) { this.diag = diag; this.ui = ui; this.stop = false; }
  async run() {
    const sup = supportedSet(this.diag);
    const pids = TRIP_PIDS.filter((p) => sup.has(p));
    const t0 = Date.now();
    const trip = { id: new Date(t0).toISOString(), inicio: new Date(t0).toISOString(), pids: pids.map((p) => ALL[p][0]),
      muestras: 0, columnas: ['ms', ...pids.map((p) => ALL[p][0])], stats: {}, eventos: [], dtc_inicio: [], dtc_fin: [], mil_inicio: null, mil_fin: null };
    trip.dtc_inicio = await readDtcs(this.diag); trip.mil_inicio = await readMil(this.diag);
    let lastDtc = trip.dtc_inicio.join(','), lastMil = trip.mil_inicio, nextDtc = Date.now() + DTC_EVERY_MS;
    const ring = []; let prev = null, pend = []; let lastSave = Date.now();
    const baro = sup.has(0x33) ? await readAny(this.diag, 0x33) : null;
    const event = (motivo, s) => {
      if (trip.eventos.length >= MAX_EVENTS) return;
      const ev = { t: new Date().toISOString(), seg: Math.round((Date.now() - t0) / 1000), motivo, antes: ring.slice(), despues: [] };
      trip.eventos.push(ev); pend.push(ev); this.ui(trip, motivo);
    };
    while (!this.stop) {
      const s = { ts: Date.now() - t0 };
      for (const p of pids) { if (this.stop) break; s[p] = await readAny(this.diag, p); }
      if (this.stop) break;
      trip.muestras++;
      for (const p of pids) { const v = s[p]; const st = (trip.stats[ALL[p][0]] ||= { min: null, max: null, sin_resp: 0 });
        if (v === null) st.sin_resp++; else { st.min = st.min === null ? v : Math.min(st.min, v); st.max = st.max === null ? v : Math.max(st.max, v); } }
      const row = [s.ts, ...pids.map((p) => s[p])];
      for (const ev of pend) ev.despues.push(row);
      pend = pend.filter((ev) => ev.despues.length < AFTER);
      const an = anomalies(Object.fromEntries(pids.map((p) => [p, s[p]])), prev, baro);
      if (an.length) event(an.join('; '), s);
      ring.push(row); if (ring.length > RING) ring.shift();
      prev = Object.fromEntries(pids.map((p) => [p, s[p]]));
      if (Date.now() > nextDtc) {
        nextDtc = Date.now() + DTC_EVERY_MS;
        const dt = await readDtcs(this.diag), mil = await readMil(this.diag);
        if (dt.join(',') !== lastDtc) event(`Codigos cambiaron: [${lastDtc}] -> [${dt.join(',')}]`, s);
        if (mil !== lastMil) event(`Testigo MIL ${mil ? 'ENCENDIO' : 'se apago'}`, s);
        lastDtc = dt.join(','); lastMil = mil;
      }
      if (Date.now() - lastSave > 30000) { trip.fin = new Date().toISOString(); await saveTrip(trip).catch(() => {}); lastSave = Date.now(); }
      this.ui(trip);
    }
    trip.dtc_fin = await readDtcs(this.diag).catch(() => []); trip.mil_fin = await readMil(this.diag).catch(() => null);
    trip.fin = new Date().toISOString(); trip.duracion_min = Math.round((Date.now() - t0) / 600) / 100;
    await saveTrip(trip);
    return trip;
  }
}

export function tripsText(trips) {
  return trips.sort((a, b) => a.id.localeCompare(b.id)).map((t) => [
    `=== VIAJE ${t.inicio} (${t.duracion_min ?? '?'} min, ${t.muestras} muestras) ===`,
    `Codigos inicio: ${t.dtc_inicio.join(', ') || '-'} | fin: ${(t.dtc_fin || []).join(', ') || '-'} | MIL inicio ${t.mil_inicio ? 'ON' : 'off'} fin ${t.mil_fin ? 'ON' : 'off'}`,
    ...Object.entries(t.stats).map(([k, s]) => `  ${k}: min ${s.min ?? '-'} max ${s.max ?? '-'}${s.sin_resp ? ` (${s.sin_resp} sin resp.)` : ''}`),
    `Eventos: ${t.eventos.length}`,
    ...t.eventos.map((e) => `  [+${e.seg}s ${e.t}] ${e.motivo}\n    columnas: ${(t.columnas || []).join('|')}\n    antes: ${JSON.stringify(e.antes)}\n    despues: ${JSON.stringify(e.despues)}`),
  ].join('\n')).join('\n\n');
}
