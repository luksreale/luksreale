import { registerPlugin } from '@capacitor/core';
import { ELM, Diag, PIDS, reportText } from './elm.js';

const BT = registerPlugin('BluetoothSerial');
const $ = (id) => document.getElementById(id);
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
let addr = null, elm = null, diag = null, stopLive = false, busy = false, report = '';

const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

function setStatus(t) { $('st').textContent = t; }
function prog(t) { $('prog').textContent = t; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function lock(on) { busy = on; document.querySelectorAll('#acts button:not(#bStop)').forEach((b) => (b.disabled = on)); }

$('mac').value = store.get('mac') || '';

function btError(e, pre) {
  const m = String((e && e.message) || e);
  if (/permission denied/i.test(m)) return 'Falta el permiso. Ajustes > Apps > S10 Diag > Permisos > Dispositivos cercanos: Permitir.';
  if (/disabled/i.test(m)) return 'Activá el Bluetooth del teléfono y volvé a intentar.';
  return pre + ': ' + m;
}

$('bScan').onclick = async () => {
  // scan() pide el permiso "Dispositivos cercanos" si falta; isEnabled() devuelve false
  // mientras no este concedido, por eso no se consulta antes.
  try {
    prog('Buscando (5 s)... El ELM tiene que estar enchufado y con contacto puesto.');
    const { devices } = await BT.scan();
    const list = devices.filter((d) => d.address)
      .sort((a, b) => /obd|elm|v-?link/i.test(b.name || '') - /obd|elm|v-?link/i.test(a.name || ''));
    $('devs').innerHTML = list.length ? list.map((d) =>
      `<div class="dev" data-a="${esc(d.address)}"><b>${esc(d.name || 'sin nombre')}</b><br><small>${esc(d.address)}</small></div>`).join('')
      : '<p>No se encontró nada. Probá de nuevo o escribí la MAC.</p>';
    document.querySelectorAll('.dev').forEach((el) => (el.onclick = () => { $('mac').value = el.dataset.a; }));
    prog('Tocá tu ELM (suele llamarse OBDII) y después Conectar.');
  } catch (e) { prog(btError(e, 'Error buscando')); }
};

$('bConn').onclick = async () => {
  const mac = $('mac').value.trim().toUpperCase();
  if (!MAC_RE.test(mac)) return prog('MAC inválida.');
  try {
    prog('Conectando...');
    await BT.connect({ address: mac }); // el plugin no implementa connectInsecure en Android
    addr = mac; store.set('mac', mac);
    const transport = {
      write: (v) => BT.write({ address: addr, value: v }),
      read: async () => (await BT.read({ address: addr })).value || '',
    };
    elm = new ELM(transport);
    diag = new Diag(elm, prog);
    lock(true);
    await diag.init();
    await diag.supported();
    setStatus('Conectado · ' + (diag.r.bateria || ''));
    $('conn').hidden = true; $('acts').hidden = false;
    prog('Listo. Protocolo ' + diag.r.protocolo);
  } catch (e) {
    const m = btError(e, 'No se pudo conectar');
    prog(/failed to connect/i.test(m)
      ? 'No se pudo conectar. Vinculá el OBDII en Ajustes > Bluetooth con PIN 1234 (o 0000) y reintentá.' : m);
    setStatus('Desconectado');
  }
  finally { lock(false); }
};

$('bFull').onclick = async () => {
  if (busy) return; lock(true);
  try {
    diag.r = { fecha: new Date().toISOString(), adaptador: diag.r.adaptador, bateria: (await elm.cmd('ATRV')).join(' '), protocolo: diag.r.protocolo };
    await diag.full();
    report = reportText(diag.r);
    $('rep').textContent = report; $('out').hidden = false; prog('Diagnóstico terminado.');
  } catch (e) { prog('Error: ' + e.message); }
  finally { lock(false); }
};

$('bTest').onclick = async () => {
  if (busy) return; lock(true);
  try {
    const t = await diag.adapterTest();
    report = Object.entries(t).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
    $('rep').textContent = report; $('out').hidden = false; prog('Test terminado.');
  } catch (e) { prog('Error: ' + e.message); }
  finally { lock(false); }
};

$('bLive').onclick = async () => {
  if (busy) return; lock(true); stopLive = false;
  const want = [0x0C, 0x0D, 0x05, 0x0B, 0x10, 0x23, 0x0F, 0x5C, 0x42, 0x49];
  const pids = want.filter((p) => diag.knownPids().includes(p));
  $('bStop').hidden = false; $('live').hidden = false;
  $('live').innerHTML = '<div class="g">' + pids.map((p) => `<div class="v"><small>${esc(PIDS[p][0])}</small><b id="p${p}">-</b><small>${esc(PIDS[p][1])}</small></div>`).join('') + '</div>';
  prog('Leyendo en vivo...');
  try {
    while (!stopLive) for (const p of pids) {
      if (stopLive) break;
      const v = await diag.readPid(p);
      const el = $('p' + p); if (el) el.textContent = v ?? '-';
    }
  } catch (e) { prog('Error: ' + e.message); }
  $('bStop').hidden = true; lock(false); prog('Detenido.');
};
$('bStop').onclick = () => { stopLive = true; };

$('bDisc').onclick = async () => {
  stopLive = true;
  try { await BT.disconnect({ address: addr }); } catch {}
  addr = null; $('acts').hidden = true; $('conn').hidden = false; $('live').hidden = true; setStatus('Desconectado'); prog('');
};

async function copy(text) {
  try { await navigator.clipboard.writeText(text); prog('Copiado. Pegalo en el chat con Claude.'); }
  catch { prog('No se pudo copiar automáticamente: mantené apretado el texto para copiarlo.'); }
}
$('bCopy').onclick = () => copy(report);
$('bRaw').onclick = () => copy(JSON.stringify(elm ? elm.log.slice(-3000) : []));
