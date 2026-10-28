'use strict';
// SNMP-Agent (v1/v2c, nur lesend) mit den Teilen der Host-Resources- und Printer-MIB (RFC 3805),
// über die Druck-Apps Gerätestatus, Fächer/Rollen und Verbrauchsmaterial abfragen.
// Unterstützt GET, GETNEXT und GETBULK; jede Community wird akzeptiert.
const { $t, $tp, $lazy } = require('../i18n.js');
const dgram = require('dgram');

// ---------------------------------------------------------------- BER
function encLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), encLen(content.length), content]);
function encInt(v, tag = 0x02) {
  v = Math.trunc(v);
  const b = [];
  if (tag !== 0x02) { // unsigned (Counter/Gauge/TimeTicks)
    v = v >>> 0;
    do { b.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
    if (b[0] & 0x80) b.unshift(0);
  } else {
    let x = v;
    do { b.unshift(x & 0xff); x >>= 8; } while (!((x === 0 && !(b[0] & 0x80)) || (x === -1 && (b[0] & 0x80))));
  }
  return tlv(tag, Buffer.from(b));
}
function encOid(oid) {
  const p = oid.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const t = [n & 0x7f];
    let x = n >>> 7;
    while (x > 0) { t.unshift((x & 0x7f) | 0x80); x >>>= 7; }
    out.push(...t);
  }
  return tlv(0x06, Buffer.from(out));
}
const encStr = (s) => tlv(0x04, Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8'));
const seq = (...items) => tlv(0x30, Buffer.concat(items));

function decode(buf) {
  let pos = 0;
  function read() {
    const tag = buf[pos++];
    let len = buf[pos++];
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[pos++]; }
    const start = pos;
    pos += len;
    const c = buf.subarray(start, start + len);
    if (tag === 0x30 || (tag >= 0xa0 && tag <= 0xa8)) {
      const save = pos;
      pos = start;
      const items = [];
      while (pos < start + len) items.push(read());
      pos = save;
      return { tag, items };
    }
    if (tag === 0x02) return { tag, value: c.length ? c.readIntBE(0, Math.min(6, c.length)) : 0 };
    if (tag === 0x06) {
      const p = [Math.floor(c[0] / 40), c[0] % 40];
      let x = 0;
      for (const b of c.subarray(1)) { x = x * 128 + (b & 0x7f); if (!(b & 0x80)) { p.push(x); x = 0; } }
      return { tag, value: p.join('.') };
    }
    return { tag, value: c };
  }
  return read();
}

const cmpOid = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};

// ---------------------------------------------------------------- MIB-Daten eines Geräts
const T = { int: (v) => encInt(v), str: (v) => encStr(v), oid: (v) => encOid(v), ticks: (v) => encInt(v, 0x43), gauge: (v) => encInt(v, 0x42), counter: (v) => encInt(v, 0x41) };

function mibFor(fleet, dev) {
  const c = dev.cfg;
  const st = dev.status;
  const vars = [];
  const add = (oid, enc) => vars.push([oid, enc]);
  const up = Math.floor((Date.now() - dev.startedAt) / 10);
  const descr = `${c.vendor} ${c.model} – ${c.frontend.product} (Virtual Print Fleet)`;
  // system
  add('1.3.6.1.2.1.1.1.0', T.str(descr));
  add('1.3.6.1.2.1.1.2.0', T.oid('1.3.6.1.4.1.2699.1.2.1.0.1')); // PWG-Drucker
  add('1.3.6.1.2.1.1.3.0', T.ticks(up));
  add('1.3.6.1.2.1.1.4.0', T.str('Virtual Print Fleet'));
  add('1.3.6.1.2.1.1.5.0', T.str(c.name));
  add('1.3.6.1.2.1.1.6.0', T.str('Virtual Print Fleet (Simulation)'));
  add('1.3.6.1.2.1.1.7.0', T.int(72));
  // hrDevice / hrPrinter (Index 1)
  add('1.3.6.1.2.1.25.3.2.1.1.1', T.int(1));
  add('1.3.6.1.2.1.25.3.2.1.2.1', T.oid('1.3.6.1.2.1.25.3.1.5')); // hrDevicePrinter
  add('1.3.6.1.2.1.25.3.2.1.3.1', T.str(`${c.vendor} ${c.model}`));
  add('1.3.6.1.2.1.25.3.2.1.5.1', T.int(st.state === 'stopped' ? 5 : st.reasons.some((r) => r.endsWith('-warning')) ? 3 : 2)); // hrDeviceStatus: running(2) warning(3) down(5)
  add('1.3.6.1.2.1.25.3.5.1.1.1', T.int(st.state === 'processing' ? 4 : st.state === 'stopped' ? 1 : 3)); // hrPrinterStatus other/idle/printing
  const err = [0, 0];
  const setBit = (n) => { err[Math.floor(n / 8)] |= 0x80 >> (n % 8); };
  for (const r of st.reasons) {
    if (/media-empty/.test(r)) setBit(1); // noPaper
    if (/media-needed|media-low/.test(r)) setBit(0); // lowPaper
    if (/toner-low|marker-supply-low/.test(r)) setBit(2);
    if (/door-open|cover-open/.test(r)) setBit(4);
    if (/media-jam/.test(r)) setBit(5);
    if (/offline/.test(r)) setBit(6);
  }
  add('1.3.6.1.2.1.25.3.5.1.2.1', T.str(Buffer.from(err)));
  // prtGeneral
  add('1.3.6.1.2.1.43.5.1.1.16.1', T.str(c.name));
  add('1.3.6.1.2.1.43.5.1.1.17.1', T.str(c.id));
  // prtInputTable (43.8.2.1.<Spalte>.1.<Fach>)
  c.slots.forEach((s, i) => {
    const idx = `1.${i + 1}`;
    const m = s.loaded && fleet.catalog.get(s.loaded.mediaId);
    const roll = s.kind === 'roll';
    const um = (mm) => Math.round(mm * 1000);
    const remainM = m && roll ? (s.loaded.levelM ?? m.lengthM) : 0;
    const col = (n, enc) => add(`1.3.6.1.2.1.43.8.2.1.${n}.${idx}`, enc);
    col(1, T.int(i + 1));
    col(2, T.int(roll ? 6 : s.ippSource === 'manual' ? 5 : 3)); // continuousRoll(6) / sheetFeedManual(5) / sheetFeedAutoRemovableTray(3)
    col(3, T.int(4)); // micrometers
    col(4, T.int(m ? (roll ? um(remainM * 1000) : um(Math.max(m.widthMm, m.heightMm))) : -2));
    col(5, T.int(m ? (roll ? um(m.widthMm) : um(Math.min(m.widthMm, m.heightMm))) : -2));
    col(6, T.int(m ? (roll ? um(remainM * 1000) : um(Math.max(m.widthMm, m.heightMm))) : -2));
    col(7, T.int(m ? (roll ? um(m.widthMm) : um(Math.min(m.widthMm, m.heightMm))) : -2));
    col(8, T.int(roll ? 17 : 8)); // meters(17) / sheets(8)
    col(9, T.int(roll ? (m ? Math.round(m.lengthM) : -2) : s.capacity || -2));
    col(10, T.int(roll ? 1 : 10));
    col(11, T.int(!m ? 0 : roll ? Math.round(remainM) : Math.max(0, s.loaded.level)));
    col(12, T.int(!m ? 19 : 0)); // status: 0 = verfügbar, 19 = leer/nicht verfügbar
    col(13, T.str(m ? m.name : ''));
    col(14, T.str(s.ippSource));
    col(15, T.str(c.vendor));
    col(16, T.str(c.model));
    col(18, T.str(''));
    col(19, T.str(s.name));
    col(21, T.int(m ? m.gsm : -2));
    col(22, T.str(m ? m.ippType || 'stationery' : ''));
    col(23, T.str(m ? 'white' : ''));
  });
  // prtOutputTable (43.9.2.1)
  (c.finisher?.bins || []).forEach((b, i) => {
    const idx = `1.${i + 1}`;
    add(`1.3.6.1.2.1.43.9.2.1.2.${idx}`, T.int(3));
    add(`1.3.6.1.2.1.43.9.2.1.7.${idx}`, T.str(b.id));
    add(`1.3.6.1.2.1.43.9.2.1.12.${idx}`, T.str(b.name));
  });
  // prtMarkerSuppliesTable (43.11.1.1)
  (c.supplies || []).forEach((s, i) => {
    const idx = `1.${i + 1}`;
    add(`1.3.6.1.2.1.43.11.1.1.4.${idx}`, T.int(3)); // supplyThatIsConsumed
    add(`1.3.6.1.2.1.43.11.1.1.5.${idx}`, T.int(s.type === 'toner' ? 3 : 6)); // toner(3) / ink(6)?
    add(`1.3.6.1.2.1.43.11.1.1.6.${idx}`, T.str(s.name));
    add(`1.3.6.1.2.1.43.11.1.1.7.${idx}`, T.int(19)); // percent
    add(`1.3.6.1.2.1.43.11.1.1.8.${idx}`, T.int(100));
    add(`1.3.6.1.2.1.43.11.1.1.9.${idx}`, T.int(Math.round(s.level)));
  });
  // prtConsoleDisplayBuffer
  add('1.3.6.1.2.1.43.16.5.1.2.1.1', T.str(st.message || st.stateDe));
  return vars.sort((a, b) => cmpOid(a[0], b[0]));
}

// ---------------------------------------------------------------- Agent
function startSnmp(fleet, dev, host, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', (e) => { resolve({ server: null, error: e.code === 'EACCES' ? $t(`SNMP-Port ${port}: keine Berechtigung (Ports < 1024 brauchen Root bzw. CAP_NET_BIND_SERVICE)`, `SNMP port ${port}: permission denied (ports < 1024 need root or CAP_NET_BIND_SERVICE)`) : e.code === 'EADDRINUSE' ? $t(`SNMP-Port ${port} belegt`, `SNMP port ${port} in use`) : e.message }); });
    sock.on('message', (msg, rinfo) => {
      try {
        const m = decode(msg);
        const [ver, community, pdu] = m.items;
        const reqId = pdu.items[0].value;
        const vbs = pdu.items[3].items.map((vb) => vb.items[0].value);
        const mib = mibFor(fleet, dev);
        const find = (oid) => mib.find(([o]) => o === oid);
        const next = (oid) => mib.find(([o]) => cmpOid(o, oid) > 0);
        const v2 = ver.value === 1;
        const out = [];
        let errStatus = 0, errIndex = 0;
        const endOfMib = (oid) => seq(encOid(oid), v2 ? tlv(0x82, Buffer.alloc(0)) : tlv(0x05, Buffer.alloc(0)));
        if (pdu.tag === 0xa0) { // GET
          vbs.forEach((oid, i) => {
            const f = find(oid);
            if (f) out.push(seq(encOid(f[0]), f[1]));
            else if (v2) out.push(seq(encOid(oid), tlv(0x80, Buffer.alloc(0)))); // noSuchObject
            else { errStatus = 2; errIndex = errIndex || i + 1; out.push(seq(encOid(oid), tlv(0x05, Buffer.alloc(0)))); }
          });
        } else if (pdu.tag === 0xa1) { // GETNEXT
          vbs.forEach((oid, i) => {
            const n = next(oid);
            if (n) out.push(seq(encOid(n[0]), n[1]));
            else if (v2) out.push(endOfMib(oid));
            else { errStatus = 2; errIndex = errIndex || i + 1; out.push(seq(encOid(oid), tlv(0x05, Buffer.alloc(0)))); }
          });
        } else if (pdu.tag === 0xa5) { // GETBULK
          const nonRep = pdu.items[1].value, maxRep = Math.min(pdu.items[2].value || 10, 60);
          vbs.slice(0, nonRep).forEach((oid) => { const n = next(oid); out.push(n ? seq(encOid(n[0]), n[1]) : endOfMib(oid)); });
          const rest = vbs.slice(nonRep);
          let cur = rest.slice();
          for (let r = 0; r < maxRep && rest.length; r++) {
            cur = cur.map((oid) => { const n = next(oid); out.push(n ? seq(encOid(n[0]), n[1]) : endOfMib(oid)); return n ? n[0] : oid; });
          }
        } else return; // SET usw. nicht unterstützt
        const resp = seq(encInt(ver.value), encStr(community.value), tlv(0xa2, Buffer.concat([encInt(reqId), encInt(errStatus), encInt(errIndex), seq(...out)])));
        sock.send(resp, rinfo.port, rinfo.address);
        dev.trace('snmp', 'in', $t(`SNMP ${({ 160: 'GET', 161: 'GETNEXT', 165: 'GETBULK' })[pdu.tag]} ${vbs.slice(0, 3).join(', ')}${vbs.length > 3 ? ' …' : ''} von ${rinfo.address}`, `SNMP ${({ 160: 'GET', 161: 'GETNEXT', 165: 'GETBULK' })[pdu.tag]} ${vbs.slice(0, 3).join(', ')}${vbs.length > 3 ? ' …' : ''} from ${rinfo.address}`), '', true);
      } catch (e) { /* defekte Anfrage ignorieren */ }
    });
    sock.bind(port, host, () => resolve({ server: { close: (cb) => { try { sock.close(cb); } catch { cb && cb(); } } }, error: null }));
  });
}

module.exports = { startSnmp, mibFor, decode, encOid, encStr, encInt, seq, tlv };
