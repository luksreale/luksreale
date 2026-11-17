// Extensiones de lectura que no estan en elm.js (que no se modifica).
// Todo pasa por Diag.q -> ELM.cmd -> assertSafe: sigue siendo solo lectura.
import { PIDS, dtcStr, NRC } from './elm.js';

const hx = (n, w = 3) => n.toString(16).toUpperCase().padStart(w, '0');
const ascii = (arr) => String.fromCharCode(...arr).replace(/[\x00-\x1F]/g, '').trim();
const r2 = (x) => Math.round(x * 100) / 100;

// PIDs estandar que este ECM ofrece y elm.js no decodifica.
export const EXTRA = {
  0x2C: ['EGR comandada', '%', (d) => d[0] * 100 / 255],
  0x2D: ['Error EGR', '%', (d) => (d[0] - 128) * 100 / 128],
  0x4A: ['Pedal acelerador E', '%', (d) => d[0] * 100 / 255],
  0x6A: ['Mariposa admision (relativa)', '%', (d) => (d[0] & 2 ? d[2] * 100 / 255 : null)],
  0x68: ['Temp aire admision (sensor A)', 'C', (d) => (d[0] & 1 ? d[1] - 40 : null)],
};
// Nivel de combustible: el ECM de la S10 manda el porcentaje directo (0-100) en vez de la
// escala OBD estandar 0-255. Verificado contra la aguja del tablero: byte 0x52 = 82 % (no 32 %).
// Si alguna vez llega un byte > 100, no puede ser porcentaje directo y se usa la escala estandar.
export const fuelPct = (a) => (a <= 100 ? a : a * 100 / 255);
export const ALL = { ...PIDS, 0x49: ['Pedal acelerador D', ...PIDS[0x49].slice(1)], 0x2F: ['Nivel combustible', '%', (d) => fuelPct(d[0])], ...EXTRA };

// Corrige en el reporte de Diag (que usa la escala estandar de elm.js) el nivel de combustible.
export function fixFuelInReport(r) {
  const fix = (obj) => {
    if (!obj || typeof obj !== 'object' || !('Nivel combustible' in obj)) return;
    const std = parseFloat(obj['Nivel combustible']);
    if (Number.isFinite(std)) obj['Nivel combustible'] = `${Math.round(fuelPct(Math.round(std * 255 / 100)) * 10) / 10} %`;
  };
  for (const v of Object.values(r.valores_actuales || {})) fix(v);
  if (r.freeze_frame && typeof r.freeze_frame === 'object') for (const v of Object.values(r.freeze_frame)) fix(v);
}

export const supportedSet = (diag) => { const s = new Set(); for (const v of Object.values(diag.sup)) v.forEach((x) => s.add(x)); return s; };

export async function readAny(diag, pid) {
  for (const msgs of Object.values(await diag.q('01' + hx(pid, 2), 1500))) for (const m of msgs)
    if (m.length > 2 && m[0] === 0x41 && m[1] === pid) { try { const v = ALL[pid][2](m.slice(2)); return v == null ? null : r2(v); } catch {} }
  return null;
}

export async function extraSnapshot(diag) {
  const sup = supportedSet(diag), out = {};
  for (const pid of Object.keys(EXTRA).map(Number)) if (sup.has(pid)) {
    const v = await readAny(diag, pid); if (v !== null) out[EXTRA[pid][0]] = `${v} ${EXTRA[pid][1]}`;
  }
  return out;
}

// Sensores alimentados por referencias de 5 V que este ECM publica por OBD estandar.
export const LIVE_5V = [0x0C, 0x0B, 0x33, 0x23, 0x49, 0x4A, 0x2C, 0x2D, 0x6A, 0x42];
export const LIVE_GENERAL = [0x0C, 0x0D, 0x05, 0x0B, 0x10, 0x23, 0x0F, 0x5C, 0x42, 0x49, 0x4A, 0x2C, 0x6A];

// Busqueda de modulos GM. El ECM de la S10 no responde a 3E00 (TesterPresent),
// asi que se detecta cada modulo con lecturas de identificacion (GMLAN 1A90 / UDS 22F190).
export async function gmModules(diag, progress = () => {}) {
  const cands = [];
  for (let r = 0x7E0; r < 0x7E8; r++) cands.push([r, r + 8]);
  for (let r = 0x240; r < 0x260; r++) cands.push([r, r + 0x400]);
  const names = { 0x7E0: 'ECM (motor)', 0x7E2: 'TCM (transmision)' };
  const found = {};
  let i = 0;
  for (const [req, resp] of cands) {
    progress(`Buscando modulos ${++i}/${cands.length}...`);
    await diag.target(req, resp);
    const key = hx(resp);
    let alive = false;
    const mod = { pedido: hx(req), nombre: names[req] || 'modulo 0x' + hx(req), codigos: [] };
    for (const c of ['1A90', '22F190']) {
      const msgs = (await diag.q(c, 1500))[key] || [];
      if (msgs.length) alive = true;
      for (const m of msgs) {
        if (m[0] === 0x5A && m[1] === 0x90) mod.VIN_modulo = ascii(m.slice(2));
        else if (m[0] === 0x62) mod.VIN_modulo = ascii(m.slice(3));
      }
      if (mod.VIN_modulo) break;
    }
    if (!alive) continue;
    let note = null;
    for (const m of (await diag.q('1902FF', 4000))[key] || []) {
      if (m[0] === 0x59 && m[1] === 2) {
        const rec = m.slice(3);
        for (let j = 0; j + 3 < rec.length; j += 4) {
          const [hi, mid, ftb, st] = rec.slice(j, j + 4); if (!(hi || mid)) continue;
          const fl = [[0, 'falla ahora'], [2, 'pendiente'], [3, 'confirmado'], [7, 'enciende testigo']].filter(([b]) => st & (1 << b)).map(([, n]) => n);
          mod.codigos.push(`${dtcStr(hi, mid)}-${hx(ftb, 2)} (estado ${hx(st, 2)}: ${fl.join(', ') || 'historico'})`);
        }
      } else if (m.length >= 3 && m[0] === 0x7f) note = 'UDS 19 no disponible: ' + (NRC[m[2]] || 'NRC ' + hx(m[2], 2));
    }
    if (note && !mod.codigos.length) mod.nota = note + ' (modulo GMLAN: sus codigos se leen con el servicio A9, que la app no habilita)';
    found[mod.pedido] = mod;
  }
  await diag.resetTarget();
  return found;
}

const REF5V = { P0641: 'referencia 5 V 1', P0651: 'referencia 5 V 2', P0697: 'referencia 5 V 3', P06A3: 'referencia 5 V 4' };
export function ref5vHints(r) {
  const out = [];
  for (const [ecu, g] of Object.entries(r.dtc_obd || {})) for (const c of [...(g.confirmados || []), ...(g.pendientes || [])])
    if (REF5V[c]) out.push(['ALTO', `${ecu}: ${c} = falla en ${REF5V[c]} de sensores. Usar "Sensores 5V" en vivo y mover mazos/fichas con motor en marcha: el sensor que salta a 0 o al maximo junto con el movimiento esta en el circuito afectado`]);
  return out;
}

// Muchos clones ELM327 v1.5 responden OK a ATSH/ATCRA pero los ignoran: entonces todo pedido
// "a un modulo" lo contesta el ECM. Prueba real: pedir 0100 a 7E7 (no existe en la S10);
// si contesta 7E8, el adaptador no direcciona.
export async function addressingTest(diag) {
  await diag.target(0x7E7, 0x7EF);
  const res = await diag.q('0100', 1500);
  await diag.resetTarget();
  const ids = Object.keys(res);
  if (!ids.length) return { ok: true, txt: 'OK (7E7 no responde, como corresponde)' };
  return { ok: false, txt: `FALLA: un pedido a 7E7 lo contesto ${ids.join(',')} -> el adaptador ignora ATSH/ATCRA` };
}

// ---- Todo lo que el ECM ofrece por modo 01, ademas de lo que ya se decodifica.
// Se excluyen los mapas de PIDs soportados y los de estado (no son mediciones).
const NOT_DATA = new Set([0x00, 0x20, 0x40, 0x60, 0x80, 0xA0, 0xC0, 0xE0, 0x01, 0x02, 0x03, 0x12, 0x13, 0x1C, 0x1D, 0x1E, 0x41, 0x4D, 0x4E, 0x51, 0x65]);
export const extraPids = (diag, skip) => [...supportedSet(diag)].filter((p) => !NOT_DATA.has(p) && !skip.includes(p)).sort((a, b) => a - b);
export const pidName = (p) => (ALL[p] ? ALL[p][0] : `PID 01${hx(p, 2)} (bruto)`);
// PID sin decodificador: se guardan los bytes en hexadecimal para analizarlos despues
export async function readPidAny(diag, pid) {
  if (ALL[pid]) return readAny(diag, pid);
  for (const msgs of Object.values(await diag.q('01' + hx(pid, 2), 1500))) for (const m of msgs)
    if (m.length > 2 && m[0] === 0x41 && m[1] === pid) return [...m.slice(2)].map((b) => hx(b, 2)).join('');
  return null;
}

// ---- PIDs extendidos de GM (servicio 22, "leer dato por identificador"). Es lo que usan los
// perfiles "Chevrolet/GM" de apps como Car Scanner. Solo lectura (22 esta permitido en assertSafe).
// Valor: 1-4 bytes como numero entero sin escala (la escala se deduce despues comparando con
// el comportamiento del motor); mas largos, en hexadecimal.
const didVal = (d) => (d.length <= 4 ? d.reduce((a, b) => a * 256 + b, 0) : [...d].map((b) => hx(b, 2)).join(''));
export async function readDid(diag, did, timeout = 1500) {
  const hi = did >> 8, lo = did & 0xFF;
  for (const msgs of Object.values(await diag.q('22' + hx(did, 4), timeout))) for (const m of msgs)
    if (m.length > 3 && m[0] === 0x62 && m[1] === hi && m[2] === lo) return didVal(m.slice(3));
  return null;
}
export const didName = (did) => `GM 22${hx(did, 4)}`;

// Rangos donde los ECM GM suelen tener sus datos de motor. ~4900 identificadores: unos minutos.
export const DID_RANGES = [[0x1100, 0x1FFF], [0x2000, 0x20FF], [0x3000, 0x33FF]];
export async function scanDids(diag, { progress = () => {}, stop = () => false, found = () => {} } = {}) {
  const ids = []; for (const [a, b] of DID_RANGES) for (let d = a; d <= b; d++) ids.push(d);
  const out = []; let answered = 0;
  await diag.e.cmd('ATST32'); // espera maxima 200 ms por respuesta (el ECM contesta "no soportado" al instante)
  try {
    for (let i = 0; i < ids.length && !stop(); i++) {
      const did = ids[i];
      if (i % 16 === 0) progress(i, ids.length, out.length);
      const res = await diag.q('22' + hx(did, 4), 1500);
      const msgs = Object.values(res).flat();
      if (msgs.length) answered++;
      for (const m of msgs) if (m.length > 3 && m[0] === 0x62 && m[1] === did >> 8 && m[2] === (did & 0xFF)) {
        const d = m.slice(3); const r = { did: hx(did, 4), bytes: d.length, valor: didVal(d), hex: [...d].map((b) => hx(b, 2)).join('') };
        out.push(r); found(r);
      }
      // si el ECM no contesta nada (ni siquiera "no soportado") en los primeros 64, no tiene servicio 22
      if (i === 63 && !answered) return { out, sinServicio: true };
    }
  } finally { await diag.e.cmd('ATST96'); }
  return { out, sinServicio: false };
}
