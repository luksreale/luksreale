// Presentacion: convierte los resultados del diagnostico en tarjetas HTML.
// Todo texto que viene del vehiculo o del adaptador pasa por esc().
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const IC = {
  car: '<svg viewBox="0 0 24 24"><path d="M5 17h14M4 17v-4l2-5h12l2 5v4M4 17v2h3v-2M17 17v2h3v-2"/><circle cx="7.5" cy="13.5" r="1" class="fill"/><circle cx="16.5" cy="13.5" r="1" class="fill"/></svg>',
  bt: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10-5 5V2l5 5L7 17"/></svg>',
};

// Descripcion breve de codigos frecuentes en la S10 2.8 (orientativo).
const DTC_TXT = {
  P0641: 'Referencia de 5 V del sensor "A": circuito abierto o fuera de rango',
  P0651: 'Referencia de 5 V del sensor "B": circuito abierto o fuera de rango',
  P0697: 'Referencia de 5 V del sensor "C": circuito abierto o fuera de rango',
  P06A3: 'Referencia de 5 V del sensor "D": circuito abierto o fuera de rango',
  P0401: 'Flujo de EGR insuficiente', P0402: 'Flujo de EGR excesivo',
  P0087: 'Presión del rail de combustible demasiado baja', P0088: 'Presión del rail de combustible demasiado alta',
  P0101: 'Sensor MAF: rango/rendimiento', P0106: 'Sensor MAP: rango/rendimiento', P0107: 'Sensor MAP: señal baja', P0108: 'Sensor MAP: señal alta',
  P0234: 'Sobrepresión del turbo', P0299: 'Presión del turbo baja',
  P0471: 'Sensor de presión de escape: rango/rendimiento', P2002: 'Filtro de partículas (DPF): eficiencia baja',
  P2463: 'Filtro de partículas (DPF): acumulación de hollín', P20EE: 'Catalizador SCR: eficiencia baja',
  P0128: 'Temperatura del refrigerante por debajo de la del termostato', P0335: 'Sensor de posición del cigüeñal',
  P0340: 'Sensor de posición del árbol de levas', P2138: 'Sensores del pedal D/E: correlación',
  P0562: 'Tensión del sistema baja', P0563: 'Tensión del sistema alta',
};

export function deviceItem(d, looksElm) {
  const tag = d.kind === 'ble' ? '<span class="chip ble">BLE</span>' : '<span class="chip">Clásico</span>';
  const elm = looksElm(d.name) ? ' <span class="chip elm">ELM327</span>' : '';
  return `<div class="dev" data-k="${d.kind}" data-a="${esc(d.id)}"><span class="dic">${IC.bt}</span>` +
    `<span class="dtx"><b>${esc(d.name || 'Sin nombre')}</b><small>${esc(d.id)}</small></span>${tag}${elm}</div>`;
}

const volt = (s) => { const v = parseFloat(String(s || '').replace(',', '.')); return Number.isFinite(v) ? v : null; };
const protoTxt = (p) => ({ 6: 'CAN 500k', 7: 'CAN 29b 500k', 8: 'CAN 250k', 9: 'CAN 29b 250k', A6: 'CAN 500k' }[String(p || '').trim()] || (p ? 'Prot. ' + p : '—'));

export function vehicleCard(r) {
  const v = volt(r.bateria);
  const vc = v == null ? '' : v < 12.2 ? 'bad' : v < 12.4 || v > 14.8 ? 'warn' : 'ok';
  const ecm = Object.values(r.ecus_obd || {})[0];
  return `<div class="vh"><span class="vic">${IC.car}</span><div><b>Chevrolet S10 2.8 Duramax</b>` +
    `<small>${esc(r.VIN || 'VIN no leído')}</small></div></div>` +
    `<div class="stats"><div class="stat ${vc}"><small>Batería</small><b>${v == null ? '—' : v.toFixed(1).replace('.', ',') + ' V'}</b></div>` +
    `<div class="stat"><small>Red</small><b>${esc(protoTxt(r.protocolo))}</b></div>` +
    `<div class="stat"><small>Módulo</small><b>${esc(!ecm || /ECM|Engine/i.test(ecm) ? 'ECM motor' : ecm)}</b></div></div>`;
}

const kv = (obj) => `<dl class="kv">${Object.entries(obj).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
const sect = (title, body, open = false) => `<details class="rcard"${open ? ' open' : ''}><summary>${esc(title)}</summary><div class="rb">${body}</div></details>`;

export function renderReport(r) {
  const est = Object.values(r.estado || {})[0] || {};
  const codes = [], pend = [], perm = [];
  for (const g of Object.values(r.dtc_obd || {})) { codes.push(...(g.confirmados || [])); pend.push(...(g.pendientes || [])); perm.push(...(g.permanentes || [])); }
  const v = volt(r.bateria);
  const vals = Object.values(r.valores_actuales || {})[0] || {};
  const kmClr = vals['Km desde borrado de codigos'];
  const kpi = (label, val, cls) => `<div class="kpi ${cls}"><small>${label}</small><b>${esc(val)}</b></div>`;
  const out = [];
  out.push(`<div class="kpis">${kpi('Testigo (MIL)', est.MIL_encendida ? 'Encendido' : 'Apagado', est.MIL_encendida ? 'bad' : 'ok')}` +
    kpi('Códigos', String(codes.length + pend.length + perm.length), codes.length + pend.length + perm.length ? 'warn' : 'ok') +
    kpi('Batería', v == null ? '—' : v.toFixed(1).replace('.', ',') + ' V', v == null ? '' : v < 12.2 ? 'bad' : v > 14.8 ? 'warn' : 'ok') +
    kpi('Desde último borrado', kmClr ?? '—', '') + '</div>');

  const f = r.hallazgos || [];
  if (f.length) out.push(`<div class="rcard"><div class="rh">Hallazgos</div><div class="rb">${f.map(([s, t]) =>
    `<div class="find"><span class="sev ${esc(s)}">${esc(s)}</span><span>${esc(String(t).replace(/^7E[0-9A-F]: /, ''))}</span></div>`).join('')}</div></div>`);

  const dtcRow = (c, cls, tag) => `<div class="dtc ${cls}"><code>${esc(c)}</code><span>${esc(DTC_TXT[c] || 'Consultar descripción del fabricante')}${tag}</span></div>`;
  const dtcs = [...codes.map((c) => dtcRow(c, '', '')), ...pend.map((c) => dtcRow(c, 'pend', ' · pendiente')), ...perm.map((c) => dtcRow(c, '', ' · permanente'))];
  out.push(sect('Códigos de falla', dtcs.length ? dtcs.join('') : '<p class="muted">Sin códigos guardados.</p>', true));

  const mon = Object.entries(est.monitores || {});
  if (mon.length) out.push(sect('Monitores', `<dl class="kv">${mon.map(([k, s]) =>
    `<dt>${esc(k)}</dt><dd><span class="badge ${s === 'ok' ? 'ok' : 'bad'}">${s === 'ok' ? 'Completo' : 'Incompleto'}</span></dd>`).join('')}</dl>`));

  if (typeof r.freeze_frame === 'object' && r.freeze_frame) {
    const ff = Object.values(r.freeze_frame)[0] || {};
    out.push(sect(`Freeze frame${ff.codigo_que_lo_guardo ? ' · ' + ff.codigo_que_lo_guardo : ''}`,
      '<p class="muted" style="margin:0 0 6px">Condiciones del motor en el momento en que se guardó el código.</p>' +
      kv(Object.fromEntries(Object.entries(ff).filter(([k]) => k !== 'codigo_que_lo_guardo')))));
  }
  if (Object.keys(vals).length) out.push(sect('Valores actuales', kv(vals)));

  const mods = Object.entries(r.modulos || {});
  if (mods.length) out.push(sect('Módulos', mods.map(([k, m]) =>
    `<div class="find"><span class="sev INFO">${esc(k)}</span><span><b>${esc(m.nombre)}</b>${m.VIN_modulo ? `<br><span class="muted">${esc(m.VIN_modulo)}</span>` : ''}` +
    `${(m.codigos || []).map((c) => `<br>${esc(c)}`).join('')}${m.nota ? `<br><span class="muted">${esc(m.nota)}</span>` : ''}</span></div>`).join('')));

  if (r.test_adaptador) out.push(sect('Adaptador', kv(Object.fromEntries(Object.entries(r.test_adaptador)
    .map(([k, v]) => [k, typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a} ${b}`).join(' · ') : v])))));
  return out.join('');
}

export function renderSimple(title, lines) {
  return `<div class="rcard"><div class="rh">${esc(title)}</div><div class="rb"><dl class="kv">${lines.map((l) => {
    const i = l.indexOf(':'); return i > 0 ? `<dt>${esc(l.slice(0, i))}</dt><dd>${esc(l.slice(i + 1).trim())}</dd>` : `<dt>${esc(l)}</dt><dd></dd>`;
  }).join('')}</dl></div></div>`;
}
