// Registro de viaje: lee en loop los sensores de 5 V + contexto, detecta anomalias,
// guarda en el telefono (IndexedDB, solo local) un resumen por viaje y el detalle
// alrededor de cada evento. Solo lectura: todo pasa por Diag.q -> assertSafe.
import { ALL, readAny, supportedSet, extraPids, pidName, readPidAny, readDid, didName, didHint } from './extra.js';
import { parseFrames, dtcStr } from './elm.js';

const RING = 60;          // muestras guardadas antes de cada evento (~70 s: cubre el intervalo de revision de codigos)
const AFTER = 10;         // muestras guardadas despues
const MAX_EVENTS = 60;    // por viaje
const DTC_EVERY_MS = 20000; // revision de codigos y testigo

// ---- almacenamiento local (IndexedDB). No sale del telefono.
// 'trips': resumen y eventos de cada viaje. 'filas': grabacion continua, en bloques de ~1 min
// (clave "<id del viaje>#<nro de bloque>") para no reescribir todo el viaje en cada guardado.
const KEEP_TRIPS_ROWS = 40; // viajes con grabacion continua que se conservan (~0,4 MB por hora)
let dbp = null;
function db() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('s10diag', 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('trips')) r.result.createObjectStore('trips', { keyPath: 'id' });
      if (!r.result.objectStoreNames.contains('filas')) r.result.createObjectStore('filas', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error); };
  }));
}
async function tx(mode, fn, store = 'trips') {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store, mode); const out = fn(t.objectStore(store)); t.oncomplete = () => res(out.result ?? out); t.onerror = () => rej(t.error); });
}
export const saveTrip = (trip) => tx('readwrite', (s) => s.put(trip));
export const listTrips = () => tx('readonly', (s) => s.getAll());
export async function clearTrips() { await tx('readwrite', (s) => s.clear()); await tx('readwrite', (s) => s.clear(), 'filas'); }
const saveRows = (id, n, filas) => tx('readwrite', (s) => s.put({ k: `${id}#${String(n).padStart(5, '0')}`, filas }), 'filas');
export const tripRows = async (id) => (await tx('readonly', (s) => s.getAll(IDBKeyRange.bound(id + '#', id + '#\uffff')), 'filas')).flatMap((b) => b.filas);
async function pruneRows() {
  const ids = (await listTrips()).map((t) => t.id).sort().reverse().slice(KEEP_TRIPS_ROWS);
  for (const id of ids) await tx('readwrite', (s) => s.delete(IDBKeyRange.bound(id + '#', id + '#\uffff')), 'filas');
}

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
  // solo con la mariposa abierta (contacto puesto sin arrancar); al apagar el motor la mariposa cierra
  if (map != null && baro && rpm === 0 && (cur[0x0D] ?? 0) === 0 && mariposa > 50 && Math.abs(map - baro) > 10) a.push(`MAP ${map} vs baro ${baro} con motor parado`);
  // > 600 rpm: al apagar el motor las RPM caen por debajo del ralenti y el MAP baja a vacio
  // 2 lecturas seguidas: al apagar el motor la mariposa cierra y el MAP cae a vacio un instante
  // (la mariposa se lee cada varias vueltas y puede figurar abierta todavia)
  if (map != null && rpm != null && rpm > 600 && mariposa > 10 && map < 40) { miss.mapLow = (miss.mapLow || 0) + 1; if (miss.mapLow === 2) a.push(`MAP muy bajo (${map} kPa) en marcha, 2 lecturas`); } else miss.mapLow = 0;
  const rail = s[0x23];
  if (rail != null && rpm != null && rpm > 600 && mariposa > 10 && rail < 15000) a.push(`Presion rail baja (${rail} kPa) en marcha`);
  if (prev && pieQuieto && mariposa > 10) for (const [p, lim] of [[0x0B, 60], [0x23, 60000]]) {
    // solo caidas: una subida brusca de MAP/rail con el pie quieto es el turbo cargando, no una falla
    if (s[p] != null && prev[p] != null && prev[p] - s[p] > lim) a.push(`Caida en ${ALL[p][0]} con el pie quieto: ${prev[p]} -> ${s[p]}`);
  }
  return a;
}

// Rapidos: se leen en cada vuelta (tablero fluido y deteccion de cortes en los sensores de 5 V).
// Lentos: rotan de a 2 por vuelta; entre lecturas se usa el ultimo valor conocido.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const FAST = [0x0C, 0x0D, 0x0B, 0x49, 0x4A, 0x23];
export const SLOW = [0x05, 0x2F, 0x42, 0x04, 0x33, 0x2C, 0x2D, 0x6A];
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

export class TripLogger {
  constructor(diag, ui, opts = {}) { this.diag = diag; this.ui = ui; this.stop = false; this.dids = opts.dids || []; this.version = opts.version; this.varPrev = opts.varPrev || []; }
  async run() {
    const sup = supportedSet(this.diag);
    const fast = FAST.filter((p) => sup.has(p)), slow = SLOW.filter((p) => sup.has(p));
    const pids = [...fast, ...slow];
    // grabacion continua: ademas, todo PID que el ECM ofrezca y los PIDs GM (22) encontrados con "Explorar"
    const extra = [...extraPids(this.diag, pids).map((p) => ({ k: 'p' + p, name: pidName(p), read: () => readPidAny(this.diag, p) })),
      ...(this.dids || []).map((d) => ({ k: 'd' + d, name: didName(d), read: () => readDid(this.diag, d) }))];
    const cols = [...pids.map((p) => ALL[p][0]), ...extra.map((x) => x.name), 'Tension adaptador (ATRV)'];
    const t0 = Date.now();
    const trip = { id: new Date(t0).toISOString(), inicio: new Date(t0).toISOString(), pids: pids.map((p) => ALL[p][0]),
      muestras: 0, columnas: ['ms', ...pids.map((p) => ALL[p][0])], stats: {}, eventos: [], dtc_inicio: [], dtc_fin: [], mil_inicio: null, mil_fin: null,
      km: 0, nivel_inicio: null, nivel_fin: null, ultimo: {}, columnas_filas: ['ms', ...cols], filas: 0, version: this.version };
    await pruneRows().catch(() => {});
    const xv = {}, varPrev = new Set(this.varPrev || []); let ci = 0, loopN = 0;
    for (const x of extra) { x.n = 0; x.changed = false; x.last = undefined; }
    const hot = (x) => x.changed || x.n < 2 || varPrev.has(x.k);
    const readX = async (x) => { const v = await x.read(); if (x.n && v != null && x.last != null && v !== x.last) x.changed = true; if (v != null) x.last = v; x.n++; xv[x.k] = v; };
    let xi = 0, nextRv = 0, rv = null, rows = [], block = 0;
    const flushRows = async () => { if (!rows.length) return; const r = rows; rows = []; trip.filas += r.length; await saveRows(trip.id, block++, r).catch(() => {}); };
    const pushRow = (vals, now) => rows.push([now - t0, ...pids.map((p) => vals[p] ?? null), ...extra.map((x) => xv[x.k] ?? null), rv]);
    trip.dtc_inicio = (await readDtcs(this.diag)) ?? []; trip.mil_inicio = await readMil(this.diag);
    let lastDtc = trip.dtc_inicio.join(','), lastMil = trip.mil_inicio, nextDtc = Date.now() + DTC_EVERY_MS;
    const ring = []; let prev = null, pend = []; let lastSave = Date.now();
    const cur = {}; // ultimo valor conocido de cada PID
    const miss = {}; // lecturas sin respuesta seguidas por PID
    for (const p of slow) cur[p] = await readAny(this.diag, p);
    const baro = cur[0x33] ?? null;
    // combustible: mediana de lecturas con la camioneta quieta (en movimiento el gasoil se mueve)
    const nivStart = [], nivEnd = []; let lastSpeedT = null, lastSpeed = null, si = 0;
    // el mismo motivo (sin contar los numeros) dentro de 30 s no se repite
    let lastEvKey = '', lastEvT = 0;
    const event = (motivo) => {
      if (trip.eventos.length >= MAX_EVENTS) return;
      const key = motivo.replace(/[\d.,-]+/g, '#');
      if (key === lastEvKey && Date.now() - lastEvT < 30000) return;
      lastEvKey = key; lastEvT = Date.now();
      const ev = { t: new Date().toISOString(), seg: Math.round((Date.now() - t0) / 1000), motivo, antes: ring.slice(), despues: [] };
      trip.eventos.push(ev); pend.push(ev); this.ui(trip, motivo);
    };
    let fallos = 0, lowV = false, keyOff = false;
    while (!this.stop) {
      // En segundo plano (p.ej. WhatsApp) se pausa la lectura; al volver se sigue.
      // El hueco no suma km (la integracion ignora huecos > 10 s).
      if (typeof document !== 'undefined' && document.hidden) {
        if (!trip.pausas) trip.pausas = 0;
        trip.pausas++;
        while (document.hidden && !this.stop) await sleep(400);
        continue;
      }
      const fresh = {};
      try {
        for (const p of fast) { if (this.stop) break; fresh[p] = await readAny(this.diag, p); }
        for (let k = 0; k < 2 && slow.length && !this.stop; k++) { const p = slow[si++ % slow.length]; fresh[p] = await readAny(this.diag, p); }
        // PIDs extra: los que cambian (o todavia no se sabe) se leen seguido; los que quedaron fijos
        // en este viaje y en los anteriores, uno cada 5 vueltas. Asi 375 PIDs GM no frenan a los utiles.
        for (let k = 0, g = 0; k < 3 && g < extra.length && !this.stop; g++) { const x = extra[xi++ % extra.length]; if (!hot(x)) continue; await readX(x); k++; }
        if (++loopN % 5 === 0 && extra.length && !this.stop) for (let g = 0; g < extra.length; g++) { const x = extra[ci++ % extra.length]; if (hot(x)) continue; await readX(x); break; }
        if (Date.now() > nextRv && !this.stop) { nextRv = Date.now() + 10000; const v = parseFloat(String((await this.diag.e.cmd('ATRV')).join(''))); rv = Number.isFinite(v) ? v : null; }
        fallos = 0;
      } catch (e) {
        // corte de Bluetooth: se guarda lo grabado y se reintenta; tras 5 fallos seguidos se termina
        if (++fallos >= 5) { await flushRows(); await saveTrip(trip).catch(() => {}); throw e; }
        await flushRows(); await saveTrip(trip).catch(() => {});
        await sleep(2000);
        continue;
      }
      if (this.stop) break;
      // 255 km/h es el valor invalido que manda el ECM al cortar contacto
      if (fresh[0x0D] === 255) fresh[0x0D] = null;
      // Contacto cortado: tension del modulo < 5 V o nada contesta. El ECM sigue respondiendo unos
      // segundos mientras se apaga, con valores que no sirven para alarmas, estadisticas ni codigos.
      if (fresh[0x42] != null) lowV = fresh[0x42] < 5;
      keyOff = lowV || Object.values(fresh).every((x) => x === null);
      if (keyOff) {
        trip.contacto_cortado = (trip.contacto_cortado || 0) + 1;
        pushRow({ ...cur, ...fresh }, Date.now()); // se graba igual (sirve ver como se apagan los sensores)
        this.ui(trip); continue;
      }
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
      pushRow(cur, now);
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
      if (now - lastSave > 30000) { trip.fin = new Date().toISOString(); await flushRows(); await saveTrip(trip).catch(() => {}); lastSave = now; }
      this.ui(trip);
    }
    // con el contacto cortado el ECM contesta "sin codigos" y testigo apagado aunque no sea asi:
    // en ese caso valen los ultimos leidos con el contacto puesto
    const known = trip.dtc_actual || trip.dtc_inicio, knownMil = trip.mil_actual ?? trip.mil_inicio;
    if (keyOff) { trip.dtc_fin = known; trip.mil_fin = knownMil; }
    else { trip.dtc_fin = (await readDtcs(this.diag).catch(() => null)) ?? known; trip.mil_fin = (await readMil(this.diag).catch(() => null)) ?? knownMil; }
    trip.fin = new Date().toISOString(); trip.duracion_min = Math.round((Date.now() - t0) / 600) / 100;
    trip.km = Math.round(trip.km * 100) / 100;
    trip.extra_variables = extra.filter((x) => x.changed).map((x) => x.k);
    await flushRows();
    await saveTrip(trip);
    return trip;
  }
}

// Consumo. El sensor de nivel tiene resolucion de 1 % (~0,76 L): restar viaje por viaje pierde
// lo que no llega a 1 % en cada uno. Por eso se encadenan los viajes seguidos (el siguiente
// arranca con el mismo nivel con que termino el anterior, +-1,5 %) y se usa nivel inicial del
// primero menos nivel final del ultimo. Si entre viajes el nivel cambia (carga de combustible o
// manejo sin grabar) empieza un tramo nuevo.
export function fuelSummary(trips, tankL) {
  const ts = trips.filter((t) => t.nivel_inicio != null && t.nivel_fin != null).sort((a, b) => a.id.localeCompare(b.id));
  const tramos = [];
  for (const t of ts) {
    const cur = tramos[tramos.length - 1];
    if (cur && Math.abs(t.nivel_inicio - cur.fin) <= 1.5) { cur.fin = t.nivel_fin; cur.km += t.km || 0; cur.viajes++; }
    else tramos.push({ inicio: t.nivel_inicio, fin: t.nivel_fin, km: t.km || 0, viajes: 1 });
  }
  let km = 0, litros = 0;
  for (const tr of tramos) if (tr.km > 0 && tr.inicio >= tr.fin) { km += tr.km; litros += (tr.inicio - tr.fin) / 100 * tankL; }
  const kmTot = trips.reduce((a, t) => a + (t.km || 0), 0);
  return { km: Math.round(kmTot * 10) / 10, km_medidos: Math.round(km * 10) / 10, litros: Math.round(litros * 10) / 10,
    viajes: trips.length, tramos: tramos.length, l100: km >= 50 && litros > 0 ? Math.round(litros / km * 1000) / 10 : null };
}

export function tripsText(trips, tankL = 76) {
  const f = fuelSummary(trips, tankL);
  const head = `RESUMEN: ${f.viajes} viajes, ${f.km} km (${f.km_medidos} km con nivel continuo, ${f.tramos} tramo/s), ~${f.litros} L (tanque ${tankL} L) -> ${f.l100 ?? 'faltan km (min 50)'} L/100km\n\n`;
  return head + trips.sort((a, b) => a.id.localeCompare(b.id)).map((t) => [
    `=== VIAJE ${t.inicio} (${t.duracion_min ?? '?'} min, ${t.muestras} muestras) ===`,
    `Km: ${t.km ?? '?'} | Nivel tanque inicio ${t.nivel_inicio ?? '?'}% fin ${t.nivel_fin ?? '?'}%`,
    `Codigos inicio: ${t.dtc_inicio.join(', ') || '-'} | fin: ${(t.dtc_fin || []).join(', ') || '-'} | MIL inicio ${t.mil_inicio ? 'ON' : 'off'} fin ${t.mil_fin ? 'ON' : 'off'}`,
    ...Object.entries(t.stats).map(([k, s]) => `  ${k}: min ${s.min ?? '-'} max ${s.max ?? '-'}${s.sin_resp ? ` (${s.sin_resp} sin resp.)` : ''}`),
    `Eventos: ${t.eventos.length}`,
    ...t.eventos.map((e) => `  [+${e.seg}s ${e.t}] ${e.motivo}\n    columnas: ${(t.columnas || []).join('|')}\n    antes: ${JSON.stringify(e.antes)}\n    despues: ${JSON.stringify(e.despues)}`),
  ].join('\n')).join('\n\n');
}

// CSV de la grabacion continua: separador ';' y coma decimal (abre bien en Excel en castellano).
const local = (ms) => { const d = new Date(ms), z = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
export async function tripsCsv(trips) {
  const ts = [...trips].filter((t) => t.columnas_filas).sort((a, b) => a.id.localeCompare(b.id));
  const cols = []; for (const t of ts) for (const c of t.columnas_filas.slice(1)) if (!cols.includes(c)) cols.push(c);
  const cell = (v) => (v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v).replace(/[;\n"]/g, ' '));
  const out = ['\ufeff' + ['viaje', 'hora', 'seg', ...cols].join(';')];
  let n = 0;
  for (const t of ts) {
    const idx = cols.map((c) => t.columnas_filas.indexOf(c)), t0 = Date.parse(t.inicio);
    for (const r of await tripRows(t.id)) {
      out.push([local(t0).slice(0, 16), local(t0 + r[0]).slice(11), cell(Math.round(r[0] / 100) / 10),
        ...idx.map((i) => (i < 0 ? '' : cell(r[i])))].join(';'));
      n++;
    }
  }
  return { csv: out.join('\n'), filas: n, viajes: ts.length };
}

// ---- Identificar PIDs GM: compara cada PID GM grabado con los datos OBD estandar del mismo
// momento (RPM, temperaturas, presiones, pedal...). Si sigue a uno casi exactamente (r >= 0,95),
// es el mismo dato con otra escala: se informa la conversion (valor = bruto x a + b).
const pearson = (xs, ys) => {
  const n = xs.length; if (n < 20) return null;
  let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n; let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  if (!sxx || !syy) return null;
  const slope = sxy / sxx; return { r: sxy / Math.sqrt(sxx * syy), a: slope, b: my - slope * mx };
};
const sig = (x) => (Math.abs(x) < 1e-9 ? '0' : String(Number(x.toPrecision(3))).replace('.', ','));
export async function analyzeGm(trips) {
  const ts = trips.filter((t) => (t.columnas_filas || []).some((c) => c.startsWith('GM 22')));
  const series = {}; // nombre -> [[gm, std...]] por fila
  const pairs = {}; let filas = 0;
  for (const t of ts) {
    const cols = t.columnas_filas, gm = cols.map((c, i) => [c, i]).filter(([c]) => c.startsWith('GM 22'));
    const std = cols.map((c, i) => [c, i]).filter(([c]) => !c.startsWith('GM 22') && !c.startsWith('PID 01') && c !== 'ms');
    const rows = await tripRows(t.id); filas += rows.length;
    let prev = {};
    for (const r of rows) for (const [g, gi] of gm) {
      const v = r[gi]; if (typeof v !== 'number') continue;
      (series[g] ||= []).push(v);
      if (prev[g] === v && Math.random() < 0.7) continue; // menos peso a los valores repetidos (lectura vieja)
      prev[g] = v;
      for (const [s, si] of std) { const w = r[si]; if (typeof w === 'number') { const p = ((pairs[g] ||= {})[s] ||= [[], []]); p[0].push(v); p[1].push(w); } }
    }
  }
  const out = [];
  for (const [g, vs] of Object.entries(series)) {
    const min = Math.min(...vs), max = Math.max(...vs), dist = new Set(vs).size;
    let best = null;
    for (const [s, [x, y]] of Object.entries(pairs[g] || {})) { const f = pearson(x, y); if (f && (!best || Math.abs(f.r) > Math.abs(best.r))) best = { ...f, s }; }
    let txt;
    if (dist <= 1) txt = `fijo en ${min}`;
    else if (best && Math.abs(best.r) >= 0.95) txt = `= ${best.s} (r ${sig(best.r)}): valor = bruto x ${sig(best.a)} + ${sig(best.b)}`;
    else if (best && Math.abs(best.r) >= 0.8) txt = `relacionado con ${best.s} (r ${sig(best.r)})`;
    else txt = `varia sola (no sigue a ningun dato estandar)`;
    const h = didHint(parseInt(g.slice(5, 9), 16)); if (h) txt += ` [${h}]`;
    out.push({ g, min, max, dist, n: vs.length, txt, r: best ? Math.abs(best.r) : 0 });
  }
  const order = (o) => (o.dist <= 1 ? 3 : o.r >= 0.95 ? 1 : o.r >= 0.8 ? 2 : 0);
  out.sort((a, b) => order(a) - order(b) || a.g.localeCompare(b.g));
  return { viajes: ts.length, filas, pids: out };
}
