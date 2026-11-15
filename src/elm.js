// Nucleo de diagnostico ELM327 (port de s10diag.py). Independiente del transporte:
// sirve igual para la app Android, para Web Serial en bsynk o para tests.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- SEGURIDAD DEL VEHICULO: solo se permiten servicios de lectura.
// Bloquea borrado (04, 14), escritura (2E, 3B), rutinas/actuadores (31, 2F, 30, AE),
// sesiones/seguridad (10, 27, 28), reset (11), programacion (34-37) y cualquier otro.
const READ_ONLY = /^(AT[A-Z@0-9 ]*|0[1-3]|07|09|0A|22|19|1A|3E)/;
export function assertSafe(cmd) {
  const c = cmd.replace(/\s+/g, '').toUpperCase();
  if (c.startsWith('AT')) {
    // AT de configuracion del adaptador; se excluyen los que reprograman el ELM
    if (/^AT(PP|BRD|BRT|WS)/.test(c)) throw new Error('Comando AT bloqueado: ' + c);
    return c;
  }
  if (!/^[0-9A-F]+$/.test(c) || !READ_ONLY.test(c)) throw new Error('Comando bloqueado (no es de lectura): ' + c);
  return c;
}

export class ELM {
  // transport: { write(str): Promise, read(): Promise<string> }
  constructor(transport, onLog) { this.t = transport; this.log = []; this.onLog = onLog; }
  async cmd(c, timeout = 4000) {
    const safe = assertSafe(c);
    await this.t.read(); // descartar basura previa
    await this.t.write(safe + '\r');
    let buf = '';
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      buf += await this.t.read();
      if (buf.includes('>')) break;
      await sleep(15);
    }
    const lines = buf.replace(/>/g, '').split(/[\r\n]+/).map((l) => l.trim())
      .filter((l) => l && l.replace(/\s/g, '').toUpperCase() !== safe && !l.startsWith('SEARCHING'));
    const entry = { t: Date.now(), cmd: safe, resp: lines };
    this.log.push(entry); if (this.log.length > 20000) this.log.shift();
    this.onLog && this.onLog(entry);
    return lines;
  }
}

// ---- ISO-TP con ATH1/ATS0: '7E8064100BE3FA813' -> {7E8: [Uint8Array,...]}
export function parseFrames(lines) {
  const out = {}, pend = {};
  for (const l of lines) {
    const s = l.replace(/\s/g, '').toUpperCase();
    if (s.length < 5 || !/^[0-9A-F]+$/.test(s) || (s.length - 3) % 2) continue;
    const id = s.slice(0, 3);
    const d = Uint8Array.from(s.slice(3).match(/../g).map((h) => parseInt(h, 16)));
    const t = d[0] >> 4;
    if (t === 0) (out[id] ||= []).push(d.slice(1, 1 + (d[0] & 15)));
    else if (t === 1) pend[id] = { n: ((d[0] & 15) << 8) | d[1], b: Array.from(d.slice(2)) };
    else if (t === 2 && pend[id]) {
      pend[id].b.push(...d.slice(1));
      if (pend[id].b.length >= pend[id].n) { (out[id] ||= []).push(Uint8Array.from(pend[id].b.slice(0, pend[id].n))); delete pend[id]; }
    }
  }
  for (const [id, p] of Object.entries(pend)) (out[id] ||= []).push(Uint8Array.from(p.b));
  return out;
}

export const dtcStr = (a, b) => 'PCBU'[a >> 6] + ((a >> 4) & 3) + (a & 15).toString(16).toUpperCase() + b.toString(16).toUpperCase().padStart(2, '0');
const ascii = (arr) => String.fromCharCode(...arr).replace(/[\x00-\x1F]/g, '').trim();
const u16 = (d) => (d[0] << 8) | d[1];

export const NRC = { 0x11: 'servicio no soportado', 0x12: 'subfuncion no soportada', 0x13: 'largo invalido',
  0x22: 'condiciones no correctas', 0x31: 'fuera de rango', 0x33: 'acceso denegado', 0x7f: 'no soportado en sesion' };

export const PIDS = {
  0x04: ['Carga motor', '%', (d) => d[0] * 100 / 255],
  0x05: ['Temp refrigerante', 'C', (d) => d[0] - 40],
  0x0B: ['Presion admision MAP', 'kPa', (d) => d[0]],
  0x0C: ['RPM', 'rpm', (d) => u16(d) / 4],
  0x0D: ['Velocidad', 'km/h', (d) => d[0]],
  0x0F: ['Temp aire admision', 'C', (d) => d[0] - 40],
  0x10: ['Caudal aire MAF', 'g/s', (d) => u16(d) / 100],
  0x11: ['Acelerador/mariposa', '%', (d) => d[0] * 100 / 255],
  0x1F: ['Tiempo desde arranque', 's', (d) => u16(d)],
  0x21: ['Km con MIL encendida', 'km', (d) => u16(d)],
  0x23: ['Presion rail combustible', 'kPa', (d) => u16(d) * 10],
  0x2F: ['Nivel combustible', '%', (d) => d[0] * 100 / 255],
  0x30: ['Arranques desde borrado', '', (d) => d[0]],
  0x31: ['Km desde borrado de codigos', 'km', (d) => u16(d)],
  0x33: ['Presion barometrica', 'kPa', (d) => d[0]],
  0x42: ['Tension modulo', 'V', (d) => u16(d) / 1000],
  0x46: ['Temp ambiente', 'C', (d) => d[0] - 40],
  0x49: ['Pedal acelerador', '%', (d) => d[0] * 100 / 255],
  0x4D: ['Minutos con MIL encendida', 'min', (d) => u16(d)],
  0x4E: ['Minutos desde borrado', 'min', (d) => u16(d)],
  0x5C: ['Temp aceite', 'C', (d) => d[0] - 40],
  0x5E: ['Consumo combustible', 'L/h', (d) => u16(d) / 20],
};
const DIESEL_MON = { 0: 'Catalizador NMHC', 1: 'NOx/SCR', 3: 'Presion turbo', 5: 'Sensor gases escape', 6: 'Filtro particulas (DPF)', 7: 'EGR/VVT' };
const r2 = (x) => Math.round(x * 100) / 100;
const hx = (n, w = 3) => n.toString(16).toUpperCase().padStart(w, '0');

export class Diag {
  constructor(elm, progress = () => {}) { this.e = elm; this.p = progress; this.r = { fecha: new Date().toISOString() }; this.sup = {}; }
  q(c, t) { return this.e.cmd(c, t).then(parseFrames); }

  async init() {
    this.p('Inicializando adaptador...');
    await this.e.cmd('ATZ', 5000); await sleep(800);
    const ver = await this.e.cmd('ATI');
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH1', 'ATD0', 'ATSP6', 'ATAT1', 'ATST96']) await this.e.cmd(c);
    this.r.adaptador = ver.join(' ');
    this.r.bateria = (await this.e.cmd('ATRV')).join(' ');
    let ok = Object.keys(await this.q('0100', 8000)).length;
    if (!ok) { await this.e.cmd('ATSP0'); ok = Object.keys(await this.q('0100', 15000)).length; }
    if (!ok) throw new Error('La camioneta no responde. ¿Contacto puesto? ¿Adaptador bien enchufado?');
    this.r.protocolo = (await this.e.cmd('ATDPN')).join(' ');
  }

  async target(req, resp) {
    for (const c of ['ATSH' + hx(req), 'ATCRA' + hx(resp), 'ATFCSH' + hx(req), 'ATFCSD300000', 'ATFCSM1']) await this.e.cmd(c);
  }
  async resetTarget() { for (const c of ['ATCRA', 'ATFCSM0', 'ATSH7DF']) await this.e.cmd(c); }

  async adapterTest() {
    this.p('Probando adaptador...');
    const t = { ATI: (await this.e.cmd('ATI')).join(' '), 'AT@1': (await this.e.cmd('AT@1')).join(' ') };
    const cmds = {};
    for (const c of ['ATCRA7E8', 'ATFCSH7E0', 'ATFCSD300000', 'ATFCSM1', 'ATCAF1', 'ATST19'])
      cmds[c] = (await this.e.cmd(c)).some((l) => l.includes('OK')) ? 'OK' : 'NO ACEPTA';
    await this.resetTarget(); await this.e.cmd('ATST96');
    t.comandos = cmds;
    const vin = await this.q('0902', 6000);
    const vlen = Math.max(0, ...Object.values(vin).flat().map((m) => m.length));
    t['respuesta larga'] = vlen >= 20 ? 'OK' : `FALLA (${vlen} bytes)`;
    const t0 = Date.now(); let n = 0;
    for (let i = 0; i < 20; i++) if (Object.keys(await this.q('010C', 1000)).length) n++;
    t.velocidad = `${(20000 / (Date.now() - t0)).toFixed(1)} lecturas/s (${n}/20 ok)`;
    const adv = ['ATCRA7E8', 'ATFCSH7E0', 'ATFCSD300000', 'ATFCSM1'].every((k) => cmds[k] === 'OK');
    t.veredicto = adv && vlen >= 20 ? 'Sirve para modulos GM y datos propios' : 'Limitado: solo datos OBD estandar fiables';
    this.r.test_adaptador = t;
    return t;
  }

  async supported() {
    const sup = {};
    for (let base = 0; base <= 0xE0; base += 0x20) {
      const res = await this.q('01' + hx(base, 2)); let more = false;
      for (const [ecu, msgs] of Object.entries(res)) for (const m of msgs) {
        if (m.length >= 6 && m[0] === 0x41 && m[1] === base) {
          const bits = ((m[2] << 24) | (m[3] << 16) | (m[4] << 8) | m[5]) >>> 0;
          for (let i = 0; i < 32; i++) if (bits & (2 ** (31 - i))) (sup[ecu] ||= new Set()).add(base + i + 1);
          if (bits & 1) more = true;
        }
      }
      if (!more) break;
    }
    this.sup = sup;
    this.r.pids_soportados = Object.fromEntries(Object.entries(sup).map(([k, v]) => [k, [...v].map((x) => hx(x, 2))]));
    return sup;
  }
  knownPids() { const all = new Set(); for (const s of Object.values(this.sup)) s.forEach((x) => all.add(x)); return Object.keys(PIDS).map(Number).filter((p) => all.has(p)).sort((a, b) => a - b); }

  async info() {
    this.p('Leyendo VIN y ECUs...');
    for (const msgs of Object.values(await this.q('0902', 6000))) for (const m of msgs) if (m[0] === 0x49 && m[1] === 2) this.r.VIN = ascii(m.slice(3));
    this.r.ecus_obd = {};
    for (const [ecu, msgs] of Object.entries(await this.q('090A', 6000))) for (const m of msgs) if (m[0] === 0x49 && m[1] === 0x0A) this.r.ecus_obd[ecu] = ascii(m.slice(3));
  }

  async status() {
    this.p('Estado y monitores...');
    const st = {};
    for (const [ecu, msgs] of Object.entries(await this.q('0101'))) for (const m of msgs) {
      if (m.length < 6 || m[0] !== 0x41 || m[1] !== 1) continue;
      const [A, B, C, D] = m.slice(2, 6); const mon = {};
      if (B & 8) for (const [bit, n] of Object.entries(DIESEL_MON)) if (C & (1 << bit)) mon[n] = D & (1 << bit) ? 'INCOMPLETO' : 'ok';
      [[0, 'Fallo de combustion'], [1, 'Sistema combustible'], [2, 'Componentes']].forEach(([bit, n]) => { if (B & (1 << bit)) mon[n] = B & (1 << (bit + 4)) ? 'INCOMPLETO' : 'ok'; });
      st[ecu] = { MIL_encendida: !!(A & 0x80), cant_codigos: A & 0x7f, diesel: !!(B & 8), monitores: mon };
    }
    this.r.estado = st;
  }

  async obdDtcs() {
    this.p('Codigos de falla OBD...');
    const out = {};
    for (const [mode, name] of [['03', 'confirmados'], ['07', 'pendientes'], ['0A', 'permanentes']]) {
      const resp = parseInt(mode, 16) + 0x40;
      for (const [ecu, msgs] of Object.entries(await this.q(mode, 6000))) {
        const codes = [];
        for (const m of msgs) if (m[0] === resp) { const d = m.slice(2); for (let i = 0; i + 1 < d.length; i += 2) if (d[i] || d[i + 1]) codes.push(dtcStr(d[i], d[i + 1])); }
        (out[ecu] ||= {})[name] = codes;
      }
    }
    this.r.dtc_obd = out;
  }

  async freeze() {
    this.p('Freeze frame...');
    const ff = {};
    for (const [ecu, msgs] of Object.entries(await this.q('020200'))) for (const m of msgs)
      if (m.length >= 5 && m[0] === 0x42 && m[1] === 2) (ff[ecu] ||= {}).codigo_que_lo_guardo = m[3] || m[4] ? dtcStr(m[3], m[4]) : 'ninguno';
    if (!Object.values(ff).some((v) => v.codigo_que_lo_guardo !== 'ninguno')) { this.r.freeze_frame = 'no hay freeze frame guardado'; return; }
    for (const pid of this.knownPids()) for (const [ecu, msgs] of Object.entries(await this.q('02' + hx(pid, 2) + '00'))) for (const m of msgs)
      if (m.length > 3 && m[0] === 0x42 && m[1] === pid) { const [n, u, f] = PIDS[pid]; try { (ff[ecu] ||= {})[n] = `${r2(f(m.slice(3)))} ${u}`; } catch {} }
    this.r.freeze_frame = ff;
  }

  async readPid(pid) {
    for (const msgs of Object.values(await this.q('01' + hx(pid, 2), 1500))) for (const m of msgs)
      if (m.length > 2 && m[0] === 0x41 && m[1] === pid) { try { return r2(PIDS[pid][2](m.slice(2))); } catch {} }
    return null;
  }

  async snapshot() {
    this.p('Valores actuales...');
    const s = {};
    for (const pid of this.knownPids()) { const v = await this.readPid(pid); if (v !== null) s[PIDS[pid][0]] = `${v} ${PIDS[pid][1]}`; }
    this.r.valores_actuales = { '7E8': s };
  }

  async modules() {
    const cands = [];
    for (let r = 0x7E0; r < 0x7E8; r++) cands.push([r, r + 8]);
    for (let r = 0x240; r < 0x260; r++) cands.push([r, r + 0x400]);
    const names = { 0x7E0: 'ECM (motor)', 0x7E2: 'TCM (transmision)' };
    const found = {};
    let i = 0;
    for (const [req, resp] of cands) {
      this.p(`Buscando modulos ${++i}/${cands.length}...`);
      await this.target(req, resp);
      const key = hx(resp);
      if (!(key in (await this.q('3E00', 1500)))) continue;
      const mod = { pedido: hx(req), nombre: names[req] || 'modulo 0x' + hx(req), codigos: [] };
      for (const c of ['22F190', '1A90']) for (const m of (await this.q(c, 2000))[key] || []) {
        if (m[0] === 0x62) mod.VIN_modulo = ascii(m.slice(3)); else if (m[0] === 0x5A) mod.VIN_modulo = ascii(m.slice(2));
      }
      let note = null;
      for (const m of (await this.q('1902FF', 4000))[key] || []) {
        if (m[0] === 0x59 && m[1] === 2) {
          const rec = m.slice(3);
          for (let j = 0; j + 3 < rec.length; j += 4) {
            const [hi, mid, ftb, st] = rec.slice(j, j + 4); if (!(hi || mid)) continue;
            const fl = [[0, 'falla ahora'], [2, 'pendiente'], [3, 'confirmado'], [7, 'enciende testigo']].filter(([b]) => st & (1 << b)).map(([, n]) => n);
            mod.codigos.push(`${dtcStr(hi, mid)}-${hx(ftb, 2)} (estado ${hx(st, 2)}: ${fl.join(', ') || 'historico'})`);
          }
        } else if (m.length >= 3 && m[0] === 0x7f) note = 'UDS 19 no disponible: ' + (NRC[m[2]] || 'NRC ' + hx(m[2], 2));
      }
      if (note && !mod.codigos.length) mod.nota = note + ' (puede usar protocolo GMLAN antiguo)';
      found[mod.pedido] = mod;
    }
    await this.resetTarget();
    this.r.modulos = found;
  }

  async full() {
    await this.adapterTest(); await this.info(); await this.supported(); await this.status();
    await this.obdDtcs(); await this.freeze(); await this.snapshot(); await this.modules();
    this.r.hallazgos = analyzeSnapshot(this.r);
    return this.r;
  }
}

// ---- cruces / inconsistencias
const num = (s) => { const v = parseFloat(String(s)); return Number.isFinite(v) ? v : null; };
export function analyzeSnapshot(r) {
  const f = [], vals = {};
  for (const d of Object.values(r.valores_actuales || {})) for (const [k, v] of Object.entries(d)) vals[k] ??= num(v);
  const rpm = vals.RPM || 0;
  for (const [ecu, g] of Object.entries(r.dtc_obd || {})) {
    if (g.permanentes?.length && !g.confirmados?.length) f.push(['ALTO', `${ecu}: codigos PERMANENTES ${g.permanentes} sin confirmados: se borraron pero la falla no se reparo`]);
    if (g.pendientes?.length) f.push(['ALTO', `${ecu}: codigos PENDIENTES ${g.pendientes}: la falla volvio a detectarse despues del borrado`]);
  }
  const km = vals['Km desde borrado de codigos'];
  if (km != null && km < 100) f.push(['INFO', `Solo ${km} km desde el ultimo borrado: los monitores todavia no reflejan el estado real`]);
  for (const [ecu, s] of Object.entries(r.estado || {})) {
    const inc = Object.entries(s.monitores).filter(([, v]) => v === 'INCOMPLETO').map(([k]) => k);
    if (inc.length) f.push(['MEDIO', `${ecu}: monitores incompletos: ${inc.join(', ')}`]);
  }
  const temps = Object.fromEntries(['Temp refrigerante', 'Temp aire admision', 'Temp aceite', 'Temp ambiente'].filter((k) => vals[k] != null).map((k) => [k, vals[k]]));
  const tv = Object.values(temps);
  if (rpm === 0 && tv.length >= 2) {
    const sp = Math.max(...tv) - Math.min(...tv);
    f.push(sp <= 6 ? ['OK', `Temperaturas coherentes entre si (${JSON.stringify(temps)})`]
      : ['MEDIO', `Temperaturas con ${sp} C de diferencia con motor apagado ${JSON.stringify(temps)}. Si estuvo parada varias horas, el sensor que se aparta esta mal`]);
  }
  const mp = vals['Presion admision MAP'], bp = vals['Presion barometrica'];
  if (rpm === 0 && mp != null && bp != null) { const d = Math.abs(mp - bp); f.push([d <= 4 ? 'OK' : 'MEDIO', `MAP ${mp} kPa vs barometrica ${bp} kPa con motor apagado (dif ${d})${d <= 4 ? '' : ' -> revisar sensor MAP/baro o mangueras'}`]); }
  const vEcm = vals['Tension modulo'], vElm = num(String(r.bateria || '').replace('V', ''));
  if (vEcm && vElm) {
    const d = Math.abs(vEcm - vElm);
    f.push([d <= 0.4 ? 'OK' : 'MEDIO', `Tension ECM ${vEcm} V vs conector OBD ${vElm} V (dif ${r2(d)})${d <= 0.4 ? '' : ' -> posible mala masa o falso contacto'}`]);
    if (rpm === 0 && vElm < 12.2) f.push(['MEDIO', `Bateria ${vElm} V en reposo: baja; puede generar codigos falsos`]);
    if (rpm > 0 && (vElm < 13.2 || vElm > 14.8)) f.push(['MEDIO', `Tension ${vElm} V con motor en marcha: fuera de 13.2-14.8 V, revisar carga`]);
  }
  for (const [k, m] of Object.entries(r.modulos || {})) {
    const u = (m.codigos || []).filter((c) => c.startsWith('U'));
    if (u.length) f.push(['MEDIO', `${k} (${m.nombre}) tiene codigos de comunicacion: ${u.join('; ')}`]);
  }
  return f;
}

export function reportText(r) {
  const L = ['REPORTE DIAGNOSTICO S10 2.8 - ' + r.fecha, '='.repeat(40),
    `Adaptador: ${r.adaptador} | Bateria: ${r.bateria} | Protocolo: ${r.protocolo}`, `VIN: ${r.VIN || '?'}`, ''];
  L.push('--- CRUCES E INCONSISTENCIAS ---'); for (const [l, t] of r.hallazgos || []) L.push(`[${l}] ${t}`);
  L.push('', '--- ESTADO / TESTIGO ---');
  for (const [ecu, s] of Object.entries(r.estado || {})) {
    L.push(`${ecu}: MIL ${s.MIL_encendida ? 'ENCENDIDA' : 'apagada'}, ${s.cant_codigos} codigo(s)`);
    for (const [k, v] of Object.entries(s.monitores)) L.push(`   ${k}: ${v}`);
  }
  L.push('', '--- CODIGOS OBD ---');
  for (const [ecu, g] of Object.entries(r.dtc_obd || {})) for (const [k, v] of Object.entries(g)) L.push(`${ecu} ${k}: ${v.join(', ') || '-'}`);
  L.push('', '--- FREEZE FRAME ---');
  if (typeof r.freeze_frame === 'object') { for (const [ecu, vs] of Object.entries(r.freeze_frame)) for (const [k, v] of Object.entries(vs)) L.push(`${ecu} ${k}: ${v}`); }
  else L.push(String(r.freeze_frame));
  L.push('', '--- VALORES ACTUALES ---');
  for (const vs of Object.values(r.valores_actuales || {})) for (const [k, v] of Object.entries(vs)) L.push(`${k}: ${v}`);
  L.push('', '--- MODULOS GM ---');
  for (const [k, m] of Object.entries(r.modulos || {})) {
    L.push(`${k} ${m.nombre} ${m.VIN_modulo || ''}`);
    m.codigos.forEach((c) => L.push('   ' + c)); if (m.nota) L.push('   ' + m.nota); if (!m.codigos.length && !m.nota) L.push('   sin codigos');
  }
  if (r.test_adaptador) { L.push('', '--- TEST ADAPTADOR ---'); for (const [k, v] of Object.entries(r.test_adaptador)) L.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`); }
  return L.join('\n');
}
