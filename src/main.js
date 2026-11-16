import { registerPlugin } from '@capacitor/core';
import { BleClient, dataViewToText, numbersToDataView } from '@capacitor-community/bluetooth-le';
import { ELM, Diag, reportText, analyzeSnapshot } from './elm.js';
import { TripLogger, listTrips, clearTrips, tripsText } from './logger.js';
import { ALL, readAny, extraSnapshot, gmModules, addressingTest, ref5vHints, supportedSet, LIVE_5V, LIVE_GENERAL } from './extra.js';

const VERSION = '0.5.0';
const BT = registerPlugin('BluetoothSerial'); // ELM327 Bluetooth clasico (SPP)
const $ = (id) => document.getElementById(id);
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
let link = null, elm = null, diag = null, stopLive = false, busy = false, report = '';

const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

function setStatus(t) { $('st').textContent = t; }
function prog(t) { $('prog').textContent = t; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function lock(on) { busy = on; document.querySelectorAll('#acts button:not(#bStop)').forEach((b) => (b.disabled = on)); }

let kind = store.get('kind') || 'spp'; // 'spp' (clasico) o 'ble'
$('mac').value = store.get('mac') || '';
$('mac').oninput = () => { kind = 'spp'; };
document.querySelector('.foot').append(` · v${VERSION}`);

function btError(e, pre) {
  const m = String((e && e.message) || e);
  if (/permission/i.test(m)) return 'Falta el permiso. Ajustes > Apps > S10 Diag > Permisos > Dispositivos cercanos: Permitir.';
  if (/disabled|not enabled/i.test(m)) return 'Activá el Bluetooth del teléfono y volvé a intentar.';
  return pre + ': ' + m;
}

// ---- Bluetooth LE: los ELM327 BLE exponen un "puerto serie" con una caracteristica
// notify (respuestas) y otra write (comandos). Se detectan solas; FFF0/FFE0/18F0 primero.
let bleReady = false;
async function bleInit() { if (!bleReady) { await BleClient.initialize({ androidNeverForLocation: true }); bleReady = true; } }
const STD_SVC = /^0000(1800|1801|180a|180f)-/i;
const PREF_SVC = ['fff0', 'ffe0', '18f0'];
const short = (u) => u.slice(4, 8).toLowerCase();

async function bleOpen(id) {
  await bleInit();
  await BleClient.connect(id, () => { if (link && link.id === id) { prog('Se cortó la conexión Bluetooth.'); setStatus('Desconectado'); } }, { timeout: 15000 });
  const svcs = (await BleClient.getServices(id)).filter((s) => !STD_SVC.test(s.uuid))
    .sort((a, b) => ((PREF_SVC.indexOf(short(a.uuid)) + 1 || 99) - (PREF_SVC.indexOf(short(b.uuid)) + 1 || 99)));
  let svc, rx, tx;
  for (const s of svcs) {
    const n = s.characteristics.find((c) => c.properties.notify || c.properties.indicate);
    const w = s.characteristics.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    if (n && w) { svc = s.uuid; rx = n; tx = w; break; }
  }
  if (!svc) { await BleClient.disconnect(id).catch(() => {}); throw new Error('ese equipo BLE no tiene un canal serie de ELM327'); }
  let buf = '';
  await BleClient.startNotifications(id, svc, rx.uuid, (dv) => { buf += dataViewToText(dv); });
  const noResp = !tx.properties.write;
  return {
    kind: 'ble', id,
    transport: {
      write: async (v) => {
        const bytes = Array.from(v, (c) => c.charCodeAt(0) & 0xff);
        for (let i = 0; i < bytes.length; i += 20) {
          const dv = numbersToDataView(bytes.slice(i, i + 20));
          if (noResp) await BleClient.writeWithoutResponse(id, svc, tx.uuid, dv); else await BleClient.write(id, svc, tx.uuid, dv);
        }
      },
      read: async () => { const x = buf; buf = ''; return x; },
    },
    close: async () => { await BleClient.stopNotifications(id, svc, rx.uuid).catch(() => {}); await BleClient.disconnect(id); },
  };
}

async function sppOpen(mac) {
  await BT.connect({ address: mac }); // el plugin no implementa connectInsecure en Android
  // El plugin cierra la conexion cuando la app pasa a segundo plano (handleOnStop -> stopAll).
  // Si una lectura/escritura falla, se reconecta una vez y se reintenta. El ELM sigue
  // alimentado por la camioneta, asi que conserva la configuracion AT.
  const retry = async (fn) => {
    try { return await fn(); } catch (e) {
      prog('Reconectando Bluetooth...');
      await BT.connect({ address: mac });
      prog('Reconectado.');
      return fn();
    }
  };
  return {
    kind: 'spp', id: mac,
    transport: {
      write: (v) => retry(() => BT.write({ address: mac, value: v })),
      read: () => retry(async () => (await BT.read({ address: mac })).value || ''),
    },
    close: () => BT.disconnect({ address: mac }),
  };
}

const looksElm = (n) => /obd|elm|v-?link|vgate|veepeak|kiwi|icar|konnwei/i.test(n || '');
function bleScan(ms) {
  return new Promise(async (res) => {
    const found = new Map();
    try {
      await bleInit();
      await BleClient.requestLEScan({}, (r) => { const d = r.device; if (d && d.deviceId) found.set(d.deviceId, { kind: 'ble', id: d.deviceId, name: d.name || r.localName || '' }); });
    } catch (e) { return res({ list: [], err: e }); }
    setTimeout(async () => { await BleClient.stopLEScan().catch(() => {}); res({ list: [...found.values()] }); }, ms);
  });
}

$('bScan').onclick = async () => {
  // scan() / initialize() piden el permiso "Dispositivos cercanos" si falta.
  $('bScan').disabled = true;
  try {
    prog('Buscando Bluetooth LE (5 s)... El ELM tiene que estar enchufado y con contacto puesto.');
    const ble = await bleScan(5000);
    prog('Buscando Bluetooth clásico (5 s)...');
    let spp = [], sppErr = null;
    try { spp = ((await BT.scan()).devices || []).filter((d) => d.address).map((d) => ({ kind: 'spp', id: d.address, name: d.name || '' })); }
    catch (e) { sppErr = e; }
    const list = [...ble.list, ...spp].filter((d) => d.name)
      .sort((a, b) => looksElm(b.name) - looksElm(a.name));
    $('devs').innerHTML = list.length ? list.map((d) =>
      `<div class="dev" data-k="${d.kind}" data-a="${esc(d.id)}"><b>${esc(d.name || 'sin nombre')}</b> <small>${d.kind === 'ble' ? 'BLE' : 'Clásico'}</small><br><small>${esc(d.id)}</small></div>`).join('')
      : '<p>No se encontró nada. Probá de nuevo o escribí la MAC.</p>';
    document.querySelectorAll('.dev').forEach((el) => (el.onclick = () => {
      document.querySelectorAll('.dev').forEach((x) => (x.style.outline = ''));
      el.style.outline = '2px solid var(--ac)'; $('mac').value = el.dataset.a; kind = el.dataset.k;
    }));
    const err = ble.err || sppErr;
    prog(err && !list.length ? btError(err, 'Error buscando')
      : 'Tocá tu ELM (suele llamarse OBDII) y después Conectar. Si aparece dos veces, probá primero el que dice BLE.');
  } catch (e) { prog(btError(e, 'Error buscando')); }
  finally { $('bScan').disabled = false; }
};

$('bConn').onclick = async () => {
  const mac = $('mac').value.trim().toUpperCase();
  if (!MAC_RE.test(mac)) return prog('MAC inválida.');
  try {
    prog(`Conectando (${kind === 'ble' ? 'BLE' : 'clásico'})...`);
    link = kind === 'ble' ? await bleOpen(mac) : await sppOpen(mac);
    store.set('mac', mac); store.set('kind', kind);
    elm = new ELM(link.transport);
    diag = new Diag(elm, prog);
    lock(true);
    await diag.init();
    await diag.supported();
    setStatus('Conectado · ' + (diag.r.bateria || ''));
    $('conn').hidden = true; $('acts').hidden = false;
    prog('Listo. Protocolo ' + diag.r.protocolo);
  } catch (e) {
    const m = btError(e, 'No se pudo conectar');
    prog(kind === 'spp' && /failed to connect/i.test(m)
      ? 'No se pudo conectar por Bluetooth clásico. Si tu ELM es BLE, tocá Buscar y elegí el que dice BLE; si es clásico, vinculalo en Ajustes > Bluetooth con PIN 1234 (o 0000).' : m);
    if (link) { try { await link.close(); } catch {} link = null; }
    setStatus('Desconectado');
  }
  finally { lock(false); }
};

$('bFull').onclick = async () => {
  if (busy) return; lock(true);
  try {
    diag.r = { fecha: new Date().toISOString(), adaptador: diag.r.adaptador, bateria: (await elm.cmd('ATRV')).join(' '), protocolo: diag.r.protocolo };
    // Igual que Diag.full() pero con la busqueda de modulos de extra.js (el ECM no responde a 3E00)
    // y con los PIDs extra que ofrece este ECM.
    await diag.adapterTest(); await diag.info(); await diag.supported(); await diag.status();
    await diag.obdDtcs(); await diag.freeze(); await diag.snapshot();
    Object.assign(diag.r.valores_actuales['7E8'], await extraSnapshot(diag));
    prog('Probando direccionamiento del adaptador...');
    const dir = await addressingTest(diag);
    diag.r.test_adaptador.direccionamiento = dir.txt;
    if (dir.ok) diag.r.modulos = await gmModules(diag, prog);
    else {
      diag.r.test_adaptador.veredicto = 'Limitado: solo datos OBD del ECM (no puede dirigirse a otros modulos)';
      diag.r.modulos = { '-': { nombre: 'busqueda omitida: este adaptador no puede dirigirse a modulos individuales', codigos: [], nota: 'hace falta un adaptador que respete ATSH/ATCRA (p.ej. OBDLink o un ELM327 de calidad)' } };
    }
    diag.r.hallazgos = [...ref5vHints(diag.r), ...analyzeSnapshot(diag.r)];
    report = reportText(diag.r);
    $('rep').textContent = report; $('out').hidden = false; prog('Diagnóstico terminado.');
  } catch (e) { prog('Error: ' + e.message); }
  finally { lock(false); }
};

$('bTest').onclick = async () => {
  if (busy) return; lock(true);
  try {
    const t = await diag.adapterTest();
    const dir = await addressingTest(diag); t.direccionamiento = dir.txt;
    if (!dir.ok) t.veredicto = 'Limitado: solo datos OBD del ECM (no puede dirigirse a otros modulos)';
    report = Object.entries(t).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
    $('rep').textContent = report; $('out').hidden = false; prog('Test terminado.');
  } catch (e) { prog('Error: ' + e.message); }
  finally { lock(false); }
};

async function live(want, title) {
  if (busy) return; lock(true); stopLive = false;
  const sup = supportedSet(diag);
  const pids = want.filter((p) => sup.has(p) && ALL[p]);
  const st = {}; let vueltas = 0;
  $('bStop').hidden = false; $('live').hidden = false;
  $('live').innerHTML = '<div class="g">' + pids.map((p) => `<div class="v"><small>${esc(ALL[p][0])}</small><b id="p${p}">-</b><small>${esc(ALL[p][1])} · <span id="m${p}">min - / max -</span></small></div>`).join('') + '</div>';
  prog(`${title}: leyendo... (min/max se registran hasta que toques Detener)`);
  try {
    while (!stopLive) {
      for (const p of pids) {
        if (stopLive) break;
        const v = await readAny(diag, p);
        const s = (st[p] ||= { min: null, max: null, sinResp: 0, n: 0 });
        if (v === null) s.sinResp++; else { s.n++; s.min = s.min === null ? v : Math.min(s.min, v); s.max = s.max === null ? v : Math.max(s.max, v); }
        const el = $('p' + p); if (el) el.textContent = v ?? '-';
        const mm = $('m' + p); if (mm) mm.textContent = `min ${s.min ?? '-'} / max ${s.max ?? '-'}` + (s.sinResp ? ` / ${s.sinResp} sin resp.` : '');
      }
      vueltas++;
    }
  } catch (e) { prog('Error: ' + e.message); }
  report = [`${title} - ${new Date().toISOString()} - ${vueltas} vueltas`, ...pids.map((p) => { const s = st[p] || {};
    return `${ALL[p][0]}: min ${s.min ?? '-'} / max ${s.max ?? '-'} ${ALL[p][1]} (${s.n || 0} lecturas, ${s.sinResp || 0} sin respuesta)`; })].join('\n');
  $('rep').textContent = report; $('out').hidden = false;
  $('bStop').hidden = true; lock(false); prog('Detenido. Resumen min/max abajo: Copiar reporte para pasarlo.');
}
$('bLive').onclick = () => live(LIVE_GENERAL, 'Datos en vivo');
$('b5v').onclick = () => live(LIVE_5V, 'Sensores 5V');
$('bStop').onclick = () => { stopLive = true; };

$('bDisc').onclick = async () => {
  stopLive = true;
  try { if (link) await link.close(); } catch {}
  link = null; $('acts').hidden = true; $('conn').hidden = false; $('live').hidden = true; setStatus('Desconectado'); prog('');
};

async function copy(text) {
  try { await navigator.clipboard.writeText(text); prog('Copiado. Pegalo en el chat con Claude.'); }
  catch { prog('No se pudo copiar automáticamente: mantené apretado el texto para copiarlo.'); }
}
$('bCopy').onclick = () => copy(report);
$('bRaw').onclick = () => copy(JSON.stringify(elm ? elm.log.slice(-3000) : []));

// ---- Registro de viaje
let trip = null;
async function refreshTrips() {
  try { const n = (await listTrips()).length; $('bTrips').textContent = `Copiar registros (${n} viaje${n === 1 ? '' : 's'})`; } catch {}
}
refreshTrips();
$('bTrip').onclick = async () => {
  if (busy) return; lock(true); stopLive = false;
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  $('bStop').hidden = false; $('live').hidden = false;
  $('live').innerHTML = '<p>Grabando viaje. Dejá la app abierta y en pantalla (con cargador). Tocá Detener al llegar.</p><pre id="tripst"></pre>';
  trip = new TripLogger(diag, (t, ev) => {
    const mins = ((Date.now() - Date.parse(t.inicio)) / 60000).toFixed(1);
    $('tripst').textContent = `${mins} min · ${t.muestras} muestras · ${t.eventos.length} eventos` + (t.eventos.length ? `\nUltimo: ${t.eventos[t.eventos.length - 1].motivo}` : '');
    if (ev) prog('EVENTO: ' + ev);
  });
  $('bStop').onclick = () => { stopLive = true; if (trip) trip.stop = true; };
  prog('Registro de viaje en curso...');
  try { const t = await trip.run(); prog(`Viaje guardado: ${t.duracion_min} min, ${t.eventos.length} eventos.`); }
  catch (e) { prog('Error en registro (lo grabado hasta ahora quedó guardado): ' + e.message); }
  try { await wake?.release(); } catch {}
  trip = null; $('bStop').hidden = true; $('bStop').onclick = () => { stopLive = true; };
  lock(false); refreshTrips();
};
$('bTrips').onclick = async () => {
  try { const t = await listTrips(); if (!t.length) return prog('No hay viajes guardados.'); await copy(tripsText(t)); } catch (e) { prog('Error leyendo registros: ' + e.message); }
};
$('bClr').onclick = async () => {
  if (!confirm('¿Borrar todos los viajes guardados?')) return;
  try { await clearTrips(); prog('Registros borrados.'); refreshTrips(); } catch (e) { prog('Error: ' + e.message); }
};
