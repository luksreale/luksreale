// Registro de viaje: lee en loop los sensores de 5 V + contexto, detecta anomalias,
// guarda en el telefono (IndexedDB, solo local) un resumen por viaje y el detalle
// alrededor de cada evento. Solo lectura: todo pasa por Diag.q -> assertSafe.
import { ALL, readAny, supportedSet } from './extra.js';
import { parseFrames, dtcStr } from './elm.js';

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

// Devuelve null si el ECM no contesto al modo 03: un fallo de lectura no es "codigos borrados".
async function readDtcs(diag) {
  const out = []; let got = false;
  for (const [mode, tag] of [['03', ''], ['07', ' (pend)']]) {
    const resp = parseInt(mode, 16) + 0x40;
    for (const msgs of Object.values(await diag.q(mode, 4000))) for (const m of msgs) if (m[0] === resp) {
      if (mode === '03') got = true;
      const d = m.slice(2); for (let i = 0; i + 1 < d.length; i += 2) if (d[i] || d[i + 1]) out.push(dtcStr(d[i], d[i + 1]) + tag);
    }
  }
  return got ? out.sort() : null;
}
async function readMil(diag) {
  for (const msgs of Object.values(await diag.q('0101'))) for (const m of msgs) if (m[0] === 0x41 && m[1] === 1) return !!(m[2] & 0x80);
  return null;
}

// Reglas de anomalia. Ajustadas con viajes reales de la S10 para no confundir conducir con fallas:
// - un PID que no contesta una vez es un corte del Bluetooth, no del sensor: se marca a la 2da seguida;
// - pedal D/E: solo con el pedal D quieto y si el desacuerdo se repite 2 lecturas (se leen a ~0,1 s);
// - saltos de MAP o rail solo cuentan con el pie quieto (al soltar o cambiar de marcha caen normalmente);
// - con la mariposa cerrada (apagado del motor) el MAP cae a vacio: no es falla;
// - RPM desconocida (null) no se toma como "motor parado".
export function anomalies(s, prev, baro, cur, miss) {
  const a = [];
  for (const [p, v] of Object.entries(s)) {
    if (v === null) { miss[p] = (miss[p] || 0) + 1; if (miss[p] === 2) a.push(`${ALL[p][0]} sin respuesta (2 lecturas seguidas)`); } else miss[p] = 0;
  }
  const rpm = s[0x0C], mariposa = cur[0x6A] ?? 100;
  const d = s[0x49], e = s[0x4A], pd = prev ? prev[0x49] : null, pe = prev ? prev[0x4A] : null;
  const pieQuieto = d != null && pd != null && Math.abs(d - pd) < 2;
  // desfase D/E: con el pedal D quieto y repetido en 2 lecturas seguidas (no es un desfase de tiempo)
  if (pieQuieto && e != null && Math.abs(e - d / 2) > 6) { miss.pedal = (miss.pedal || 0) + 1; if (miss.pedal === 2) a.push(`Pedal D ${d}% / E ${e}% no concuerdan (pie quieto, 2 lecturas)`); } else miss.pedal = 0;
  if (d != null && (d < 3 || d > 97)) a.push(`Pedal D en extremo (${d}%)`);
  if (e != null && (e < 1 || e > 97)) a.push(`Pedal E en extremo (${e}%)`);
  const map = s[0x0B];
  if (map != null && baro && rpm === 0 && (cur[0x0D] ?? 0) === 0 && Math.abs(map - baro) > 10) a.push(`MAP ${map} vs baro ${baro} con motor parado`);
  if (map != null && rpm != null && rpm > 400 && mariposa > 10 && map < 40) a.push(`MAP muy bajo (${map} kPa) en marcha`);
  const rail = s[0x23];
  if (rail != null && rpm != null && rpm > 600 && mariposa > 10 && rail < 15000) a.push(`Presion rail baja (${rail} kPa) en marcha`);
  if (prev && pieQuieto && mariposa > 10) for (const [p, lim] of [[0x0B, 60], [0x23, 60000]]) {
    if (s[p] != null && prev[p] != null && Math.abs(s[p] - prev[p]) > lim) a.push(`Salto en ${ALL[p][0]} con el pie quieto: ${prev[p]} -> ${s[p]}`);
  }
  return a;
}

// Rapidos: se leen en cada vuelta (tablero fluido y deteccion de cortes en los sensores de 5 V).
// Lentos: rotan de a 2 por vuelta; entre lecturas se usa el ultimo valor conocido.
export const FAST = [0x0C, 0x0D, 0x0B, 0x49, 0x4A, 0x23];
export const SLOW = [0x05, 0x2F, 0x42, 0x04, 0x33, 0x2C, 0x2D, 0x6A];
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

export class TripLogger {
  constructor(diag, ui) { this.diag = diag; this.ui = ui; this.stop = false; }
  async run() {
    const sup = supportedSet(this.diag);
    const fast = FAST.filter((p) => sup.has(p)), slow = SLOW.filter((p) => sup.has(p));
    const pids = [...fast, ...slow];
    const t0 = Date.now();
    const trip = { id: new Date(t0).toISOString(), inicio: new Date(t0).toISOString(), pids: pids.map((p) => ALL[p][0]),
      muestras: 0, columnas: ['ms', ...pids.map((p) => ALL[p][0])], stats: {}, eventos: [], dtc_inicio: [], dtc_fin: [], mil_inicio: null, mil_fin: null,
      km: 0, nivel_inicio: null, nivel_fin: null, ultimo: {} };
    trip.dtc_inicio = (await readDtcs(this.diag)) ?? []; trip.mil_inicio = await readMil(this.diag);
    let lastDtc = trip.dtc_inicio.join(','), lastMil = trip.mil_inicio, nextDtc = Date.now() + DTC_EVERY_MS;
    const ring = []; let prev = null, pend = []; let lastSave = Date.now();
    const cur = {}; // ultimo valor conocido de cada PID
    const miss = {}; // lecturas sin respuesta seguidas por PID
    for (const p of slow) cur[p] = await readAny(this.diag, p);
    const baro = cur[0x33] ?? null;
    // combustible: mediana de lecturas con la camioneta quieta (en movimiento el gasoil se mueve)
    const nivStart = [], nivEnd = []; let lastSpeedT = null, lastSpeed = null, si = 0;
    const event = (motivo) => {
      if (trip.eventos.length >= MAX_EVENTS) return;
      const ev = { t: new Date().toISOString(), seg: Math.round((Date.now() - t0) / 1000), motivo, antes: ring.slice(), despues: [] };
      trip.eventos.push(ev); pend.push(ev); this.ui(trip, motivo);
    };
    while (!this.stop) {
      const fresh = {};
      for (const p of fast) { if (this.stop) break; fresh[p] = await readAny(this.diag, p); }
      for (let k = 0; k < 2 && slow.length && !this.stop; k++) { const p = slow[si++ % slow.length]; fresh[p] = await readAny(this.diag, p); }
      if (this.stop) break;
      const now = Date.now();
      Object.assign(cur, fresh);
      trip.muestras++;
      // distancia: integra la velocidad entre lecturas (trapecio), ignora huecos > 10 s
      const v = fresh[0x0D];
      if (v != null) {
        if (lastSpeed != null && now - lastSpeedT < 10000) trip.km += ((v + lastSpeed) / 2) * (now - lastSpeedT) / 3600000;
        lastSpeed = v; lastSpeedT = now;
      }
      if (fresh[0x2F] != null && (cur[0x0D] ?? 0) === 0) {
        if (trip.km < 0.2) { nivStart.push(fresh[0x2F]); if (nivStart.length > 15) nivStart.shift(); }
        nivEnd.push(fresh[0x2F]); if (nivEnd.length > 15) nivEnd.shift();
      }
      trip.nivel_inicio = median(nivStart); trip.nivel_fin = median(nivEnd);
      for (const [p, val] of Object.entries(fresh)) { const st = (trip.stats[ALL[p][0]] ||= { min: null, max: null, sin_resp: 0 });
        if (val === null) st.sin_resp++; else { st.min = st.min === null ? val : Math.min(st.min, val); st.max = st.max === null ? val : Math.max(st.max, val); } }
      const row = [now - t0, ...pids.map((p) => cur[p] ?? null)];
      for (const ev of pend) ev.despues.push(row);
      pend = pend.filter((ev) => ev.despues.length < AFTER);
      // "sin respuesta" solo cuenta para lo leido en esta vuelta
      const an = anomalies(fresh, prev, baro, cur, miss);
      if (an.length) event(an.join('; '));
      ring.push(row); if (ring.length > RING) ring.shift();
      prev = { ...cur };
      trip.ultimo = { ...cur, baro };
      if (now > nextDtc) {
        nextDtc = now + DTC_EVERY_MS;
        const dt = await readDtcs(this.diag), mil = await readMil(this.diag);
        if (dt !== null && dt.join(',') !== lastDtc) event(`Codigos cambiaron: [${lastDtc}] -> [${dt.join(',')}]`);
        if (mil !== null && mil !== lastMil) event(`Testigo MIL ${mil ? 'ENCENDIO' : 'se apago'}`);
        if (dt !== null) { lastDtc = dt.join(','); trip.dtc_actual = dt; }
        if (mil !== null) { lastMil = mil; trip.mil_actual = mil; }
      }
      if (now - lastSave > 30000) { trip.fin = new Date().toISOString(); await saveTrip(trip).catch(() => {}); lastSave = now; }
      this.ui(trip);
    }
    trip.dtc_fin = (await readDtcs(this.diag).catch(() => null)) ?? (trip.dtc_actual || trip.dtc_inicio); trip.mil_fin = await readMil(this.diag).catch(() => null);
    trip.fin = new Date().toISOString(); trip.duracion_min = Math.round((Date.now() - t0) / 600) / 100;
    trip.km = Math.round(trip.km * 100) / 100;
    await saveTrip(trip);
    return trip;
  }
}

// Consumo: por viaje, (nivel inicio - nivel fin) * capacidad del tanque. Solo es fiable
// sumando muchos km; un 1 % de tanque son ~0,76 L.
export function fuelSummary(trips, tankL) {
  let km = 0, litros = 0, usados = 0;
  for (const t of trips) {
    if (!t.km) continue;
    km += t.km;
    if (t.nivel_inicio != null && t.nivel_fin != null && t.nivel_inicio >= t.nivel_fin) { litros += (t.nivel_inicio - t.nivel_fin) / 100 * tankL; usados++; }
  }
  return { km: Math.round(km * 10) / 10, litros: Math.round(litros * 10) / 10, viajes: trips.length, viajes_con_nivel: usados,
    l100: km >= 50 && litros > 0 ? Math.round(litros / km * 1000) / 10 : null };
}

export function tripsText(trips, tankL = 76) {
  const f = fuelSummary(trips, tankL);
  const head = `RESUMEN: ${f.viajes} viajes, ${f.km} km, ~${f.litros} L (tanque ${tankL} L) -> ${f.l100 ?? 'faltan km (min 50)'} L/100km\n\n`;
  return head + trips.sort((a, b) => a.id.localeCompare(b.id)).map((t) => [
    `=== VIAJE ${t.inicio} (${t.duracion_min ?? '?'} min, ${t.muestras} muestras) ===`,
    `Km: ${t.km ?? '?'} | Nivel tanque inicio ${t.nivel_inicio ?? '?'}% fin ${t.nivel_fin ?? '?'}%`,
    `Codigos inicio: ${t.dtc_inicio.join(', ') || '-'} | fin: ${(t.dtc_fin || []).join(', ') || '-'} | MIL inicio ${t.mil_inicio ? 'ON' : 'off'} fin ${t.mil_fin ? 'ON' : 'off'}`,
    ...Object.entries(t.stats).map(([k, s]) => `  ${k}: min ${s.min ?? '-'} max ${s.max ?? '-'}${s.sin_resp ? ` (${s.sin_resp} sin resp.)` : ''}`),
    `Eventos: ${t.eventos.length}`,
    ...t.eventos.map((e) => `  [+${e.seg}s ${e.t}] ${e.motivo}\n    columnas: ${(t.columnas || []).join('|')}\n    antes: ${JSON.stringify(e.antes)}\n    despues: ${JSON.stringify(e.despues)}`),
  ].join('\n')).join('\n\n');
}
