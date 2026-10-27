'use strict';
// Bonjour / mDNS / DNS-SD (RFC 6762/6763): kündigt jedes Gerät im Netz an, so wie echte
// Drucker und Front-Ends es tun – als _ipp._tcp (IPP), _printer._tcp (LPD) und _pdl-datastream._tcp (Socket 9100).
// Ohne externe Abhängigkeiten; beantwortet auch gezielte Anfragen (Browse/Resolve).
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const T = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };

// ------------------------------------------------------------------ DNS-Kodierung
function encName(name) {
  const parts = name.replace(/\.$/, '').split('.');
  // Instanznamen können Punkte enthalten -> als ein Label übergeben (mit \. maskiert)
  const labels = [];
  let cur = '';
  for (const p of parts) { if (cur.endsWith('\\')) cur = cur.slice(0, -1) + '.' + p; else { if (cur) labels.push(cur); cur = p; } }
  if (cur) labels.push(cur);
  const bufs = labels.map((l) => { const b = Buffer.from(l, 'utf8').subarray(0, 63); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}
function rr(name, type, ttl, rdata, flush) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(flush ? 0x8001 : 0x0001, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return { name, type, buf: Buffer.concat([encName(name), head, rdata]) };
}
const ptr = (name, target, ttl) => rr(name, T.PTR, ttl, encName(target), false);
const srv = (name, port, host, ttl) => { const b = Buffer.alloc(6); b.writeUInt16BE(0, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(port, 4); return rr(name, T.SRV, ttl, Buffer.concat([b, encName(host)]), true); };
const txt = (name, kv, ttl) => {
  const parts = Object.entries(kv).filter(([, v]) => v != null && v !== '').map(([k, v]) => { const b = Buffer.from(`${k}=${v}`, 'utf8').subarray(0, 255); return Buffer.concat([Buffer.from([b.length]), b]); });
  return rr(name, T.TXT, ttl, parts.length ? Buffer.concat(parts) : Buffer.from([0]), true);
};
const a = (name, ip, ttl) => rr(name, T.A, ttl, Buffer.from(ip.split('.').map(Number)), true);

function message(answers, additionals = [], id = 0) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(0x8400, 2);
  h.writeUInt16BE(answers.length, 6);
  h.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([h, ...answers.map((r) => r.buf), ...additionals.map((r) => r.buf)]);
}

function readName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  while (off < buf.length && guard++ < 128) {
    const len = buf[off];
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true; continue; }
    labels.push(buf.subarray(off + 1, off + 1 + len).toString('utf8'));
    off += len + 1;
  }
  return { name: labels.join('.'), end };
}

function parseQuery(buf) {
  if (buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null; // Antwort, keine Frage
  const id = buf.readUInt16BE(0);
  const qd = buf.readUInt16BE(4);
  let off = 12;
  const questions = [];
  for (let i = 0; i < qd && off < buf.length; i++) {
    const n = readName(buf, off);
    off = n.end;
    const type = buf.readUInt16BE(off), cls = buf.readUInt16BE(off + 2);
    off += 4;
    questions.push({ name: n.name.toLowerCase(), type, unicast: !!(cls & 0x8000) });
  }
  return { id, questions };
}

// ------------------------------------------------------------------ Responder
class MdnsResponder {
  constructor(fleet) {
    this.fleet = fleet;
    this.sock = null;
    this.records = [];
    this.timer = null;
    this.status = { active: false, error: null, addresses: [], services: 0 };
  }

  addresses() {
    const bind = this.fleet.settings.bindHost;
    if (bind && bind !== '0.0.0.0') return [bind];
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' || i.family === 4) if (!i.internal) out.push(i.address);
    return out.length ? out : ['127.0.0.1'];
  }

  hostName() {
    return `vpf-${os.hostname().split('.')[0].replace(/[^A-Za-z0-9-]/g, '-')}.local`;
  }

  /** Alle Ressourceneinträge aus dem aktuellen Maschinenpark erzeugen. */
  build(ttl = 4500) {
    const f = this.fleet;
    const host = this.hostName();
    const ips = this.addresses();
    const recs = [];
    const services = new Set();
    for (const d of f.devices.values()) {
      const c = d.cfg;
      if (!c.enabled) continue;
      const s = f.deviceSummary(d);
      const inst = `${c.name} (VPF)`.replace(/\./g, '\\.');
      const uuid = (() => { const h = crypto.createHash('sha1').update('vpf-' + c.id).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; })();
      const mods = require('../frontends').installedModules(c);
      const kind = { sheet: 'document', wide: 'document,large-format,roll', photo: 'photo,roll', printcut: 'large-format,roll,label' }[c.kind];
      const common = { txtvers: 1, qtotal: 1, ty: `${c.vendor} ${c.model}`, product: `(${c.model})`, note: 'Virtual Print Fleet (Simulation)', priority: 50, usb_MFG: c.vendor, usb_MDL: c.model, UUID: uuid, adminurl: `http://${ips[0]}:${c.ports.http}/` };
      const add = (svc, port, extra) => {
        const type = `${svc}.local`;
        const name = `${inst}.${type}`;
        services.add(type);
        recs.push(ptr(type, name, ttl), srv(name, port, host, 120), txt(name, { ...common, ...extra }, ttl));
      };
      add('_ipp._tcp', c.ports.http, { rp: 'ipp/print', pdl: 'application/pdf,image/pwg-raster,image/jpeg,image/png,application/postscript', Color: c.color ? 'T' : 'F', Duplex: c.duplex ? 'T' : 'F', Staple: mods.stapler ? 'T' : 'F', Punch: mods.puncher ? 'T' : 'F', Bind: mods.booklet ? 'T' : 'F', Fold: mods.folder || mods.wfFolder ? 'T' : 'F', Sort: 'T', kind, 'printer-type': '0x' + (0x900e | (c.color ? 0x8 : 0) | (c.duplex ? 0x10 : 0) | (mods.stapler ? 0x80 : 0) | (mods.puncher ? 0x100 : 0)).toString(16), TLS: undefined, URF: undefined, mopria_certified: undefined });
      add('_printer._tcp', c.ports.lpd, { rp: s.queues[0]?.name || 'print', pdl: 'application/pdf,application/postscript' });
      add('_pdl-datastream._tcp', c.ports.raw, { pdl: 'application/pdf,application/postscript,application/vnd.hp-PCL' });
    }
    for (const type of services) recs.push(ptr('_services._dns-sd._udp.local', type, ttl));
    for (const ip of ips) recs.push(a(host, ip, 120));
    this.records = recs;
    this.status.addresses = ips;
    this.status.services = recs.filter((r) => r.type === T.SRV).length;
    return recs;
  }

  start() {
    if (this.fleet.settings.mdns === false) { this.status = { ...this.status, active: false, error: 'deaktiviert' }; return; }
    try {
      this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock.on('error', (e) => { this.status.error = e.message; this.status.active = false; this.fleet.log(null, 'warn', `Bonjour/mDNS nicht verfügbar: ${e.message}`); try { this.sock.close(); } catch { /* */ } this.sock = null; });
      this.sock.on('message', (msg, rinfo) => this.onQuery(msg, rinfo));
      this.sock.bind(MDNS_PORT, () => {
        try { this.sock.setMulticastTTL(255); this.sock.setMulticastLoopback(true); } catch { /* */ }
        let joined = 0;
        for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
          if (i.family !== 'IPv4' && i.family !== 4) continue;
          try { this.sock.addMembership(MDNS_ADDR, i.address); joined++; } catch { /* Schnittstelle ohne Multicast */ }
        }
        if (!joined) try { this.sock.addMembership(MDNS_ADDR); } catch { /* */ }
        this.status.active = true;
        this.status.error = null;
        this.announce();
      });
    } catch (e) {
      this.status.error = e.message;
    }
  }

  /** Unaufgeforderte Ankündigung (3×, wie RFC 6762 empfiehlt). */
  announce() {
    if (!this.sock) return;
    const recs = this.build();
    clearTimeout(this.timer);
    let n = 0;
    const send = () => {
      this.sendAll(recs);
      if (++n < 3) this.timer = setTimeout(send, 1000 * n);
    };
    send();
    const loopNote = this.status.addresses.every((x) => x.startsWith('127.')) ? ' – nur Adresse 127.0.0.1: Andere Rechner können die Geräte nicht erreichen; für Netzwerksuche „Geräte im Netzwerk erreichbar" (0.0.0.0) wählen' : '';
    this.fleet.log(null, 'info', `Bonjour/mDNS: ${this.status.services} Dienste angekündigt als ${this.hostName()} (${this.status.addresses.join(', ')})${loopNote}`);
  }

  sendAll(recs, ttlZero = false) {
    if (!this.sock) return;
    // pro Dienstinstanz ein Paket (bleibt unter der MTU)
    const host = recs.filter((r) => r.type === T.A);
    const packets = [];
    let cur = [];
    let size = 12;
    for (const r of recs.filter((x) => x.type !== T.A)) {
      if (size + r.buf.length > 1300 && cur.length) { packets.push(cur); cur = []; size = 12; }
      cur.push(r); size += r.buf.length;
    }
    if (cur.length) packets.push(cur);
    for (const p of packets) this.send(message(ttlZero ? p.map(zeroTtl) : p, ttlZero ? host.map(zeroTtl) : host));
  }

  send(buf, port = MDNS_PORT, addr = MDNS_ADDR) {
    try { this.sock.send(buf, port, addr); } catch { /* */ }
  }

  onQuery(msg, rinfo) {
    const q = parseQuery(msg);
    if (!q || !q.questions.length) return;
    const answers = [];
    const extra = [];
    for (const qq of q.questions) {
      for (const r of this.records) {
        if (r.name.toLowerCase().replace(/\\\./g, '.') !== qq.name) continue;
        if (qq.type !== T.ANY && qq.type !== r.type) continue;
        if (!answers.includes(r)) answers.push(r);
      }
    }
    if (!answers.length) return;
    // Zusatzinfos mitschicken (SRV/TXT zur Instanz, A zum Host)
    for (const r of answers.filter((x) => x.type === T.PTR)) {
      const inst = this.records.filter((x) => (x.type === T.SRV || x.type === T.TXT) && r.buf.includes(encName(x.name)));
      for (const x of inst) if (!answers.includes(x) && !extra.includes(x)) extra.push(x);
    }
    if (answers.some((x) => x.type === T.SRV) || extra.some((x) => x.type === T.SRV)) for (const x of this.records.filter((y) => y.type === T.A)) if (!answers.includes(x)) extra.push(x);
    const legacy = rinfo.port !== MDNS_PORT; // einfache DNS-Anfrage (z. B. dig -p 5353) -> unicast mit gleicher ID
    const unicast = legacy || q.questions.some((x) => x.unicast);
    // In Pakete ≤ 1400 Bytes aufteilen; Zusatzeinträge nur, solange Platz ist
    const packets = [];
    let cur = [], size = 12;
    for (const r of answers) {
      if (size + r.buf.length > 1400 && cur.length) { packets.push(cur); cur = []; size = 12; }
      cur.push(r); size += r.buf.length;
    }
    packets.push(cur);
    packets.forEach((p, i) => {
      const add = [];
      if (i === packets.length - 1) {
        let s2 = 12 + p.reduce((x, r) => x + r.buf.length, 0);
        for (const x of extra) if (s2 + x.buf.length <= 1400) { add.push(x); s2 += x.buf.length; }
      }
      const buf = message(p, add, legacy ? q.id : 0);
      if (unicast) this.send(buf, rinfo.port, rinfo.address); else this.send(buf);
    });
    const what = q.questions.map((x) => x.name).join(', ');
    for (const d of this.fleet.devices.values()) if (what.includes(d.cfg.name.toLowerCase().slice(0, 20)) || /_ipp|_printer|_pdl/.test(what)) { d.trace('mdns', 'in', `Bonjour-Anfrage ${what} von ${rinfo.address}`, '', true); break; }
  }

  async stop() {
    clearTimeout(this.timer);
    if (!this.sock) return;
    this.sendAll(this.records, true); // Goodbye (TTL 0)
    await new Promise((r) => setTimeout(r, 50));
    try { this.sock.close(); } catch { /* */ }
    this.sock = null;
    this.status.active = false;
  }

  async restart() { await this.stop(); this.start(); }
}

function zeroTtl(r) {
  const b = Buffer.from(r.buf);
  // TTL liegt nach Name + Typ(2) + Klasse(2)
  const nameLen = encName(r.name).length;
  b.writeUInt32BE(0, nameLen + 4);
  return { ...r, buf: b };
}

module.exports = { MdnsResponder, parseQuery, encName, T };
