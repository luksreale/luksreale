import { ELM, Diag, reportText, assertSafe } from '../src/elm.js';
const R = {
  ATZ: 'ELM327 v1.5', ATI: 'ELM327 v1.5', ATRV: '12.4V', ATDPN: 'A6', 'AT@1': '?',
  '0100': '7E8064100BE3FA813', '0120': '7E8064120A007B019', '0140': '7E8064140FED08500',
  '0902': '7E81014490201314731\r7E8215A4A3843343537\r7E8223230313233', '090A': 'NO DATA',
  '0101': '7E8064101830B0040', '03': '7E8044301 0133'.replace(' ', ''), '07': '7E80447010401', '0A': '7E80244A0',
  '020200': '7E805420200 0133'.replace(' ', ''), '010C': '7E804410C0000', '0105': '7E8034105 41'.replace(' ', ''),
  '010B': '7E803410B 65'.replace(' ', ''), '0133': '7E8034133 64'.replace(' ', ''), '0142': '7E8044142 2EE0'.replace(' ', ''),
  '010F': '7E803410F 4E'.replace(' ', ''), '0131': '7E8044131 0028'.replace(' ', ''),
  '3E00': (h) => h === '7E0' ? '7E8027E00' : h === '243' ? '643027E00' : 'NO DATA',
  '1902FF': (h) => h === '243' ? '643075902FFC1000008' : '7E8037F1911',
};
let hdr = '7DF', last = '';
const t = {
  write: async (v) => { const c = v.trim(); if (c.startsWith('ATSH')) hdr = c.slice(4);
    const r = R[c]; last = (typeof r === 'function' ? r(hdr) : r ?? (c.startsWith('AT') ? 'OK' : 'NO DATA')) + '\r\r>'; },
  read: async () => { const x = last; last = ''; return x; },
};
const d = new Diag(new ELM(t), () => {});
await d.init(); const r = await d.full();
console.log(reportText(r));
for (const c of ['04', '14FFFFFF', '2EF190', '3101', '1003', '27 01', 'ATPP0CSV']) { try { assertSafe(c); console.log('NO BLOQUEO', c); } catch (e) { console.log('ok bloqueado', c); } }
