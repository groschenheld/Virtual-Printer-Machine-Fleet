'use strict';
// Startet die Simulation: Oberfläche/REST-API + je Gerät IPP/JMF/Fiery-API (HTTP), LPD, Socket 9100, Hotfolder.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./core/store');
const { Fleet } = require('./core/fleet');
const { Router, readBody, sendJson, sendText, sendFile } = require('./util/http');
const { parseMultipart } = require('./util/multipart');
const { handleIpp } = require('./protocols/ipp/server');
const { handleJmf, setupJmfNotifications } = require('./protocols/jmf');
const { handleFieryApi } = require('./protocols/fieryapi');
const { startLpd, listen } = require('./protocols/lpd');
const { startRaw } = require('./protocols/raw');
const { HotFolders } = require('./protocols/hotfolder');
const { MdnsResponder } = require('./protocols/mdns');
const { handleWebtools } = require('./protocols/webtools');
const { installSystemPrinters, removeSystemPrinters, manualCommands, cupsList } = require('./system/printers');
const { generatePpd } = require('./system/ppd');
const { applyObject } = require('./pipeline/ticket');
const { frontendOf } = require('./frontends');
const { clone } = require('./util/misc');

const UI_DIR = path.join(__dirname, '..', 'ui');

// ------------------------------------------------------------------ Geräte-Schnittstellen
async function startDeviceInterfaces(fleet, dev) {
  await stopDeviceInterfaces(dev);
  const c = dev.cfg;
  dev.ifaces = {};
  if (!c.enabled) { dev.ifaces.note = 'deaktiviert'; return; }
  const host = c.host || fleet.settings.bindHost;
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (req.method === 'POST' && (ct.startsWith('application/ipp') || p.startsWith('/ipp'))) {
        const body = await readBody(req);
        const out = await handleIpp(fleet, dev, req, body, p.startsWith('/ipp') ? p : '/ipp/print');
        res.writeHead(200, { 'Content-Type': 'application/ipp', 'Content-Length': out.length });
        return res.end(out);
      }
      if (p.startsWith('/live/api/')) {
        if (!frontendOf(c).features.includes('fiery-api')) return sendJson(res, 404, { error: 'Dieses Front-End hat keine Fiery-API' });
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
        return handleFieryApi(fleet, dev, req, res, body, p, url.searchParams);
      }
      if (req.method === 'GET' || (req.method === 'POST' && (p === '/config' || p.startsWith('/jobs/')) && /form-urlencoded/.test(ct))) {
        const body = req.method === 'POST' ? await readBody(req, 1024 * 1024) : Buffer.alloc(0);
        if (await handleWebtools(fleet, dev, req, res, p, body)) return;
        return sendText(res, 404, 'Nicht gefunden');
      }
      if (req.method === 'POST' && (p === '/jmf' || p.startsWith('/jmf/') || p === '/' || /cip4|jmf|jdf|multipart\/related/.test(ct))) {
        const body = await readBody(req);
        const r = await handleJmf(fleet, dev, req, body);
        return sendText(res, r.status, r.xml, 'application/vnd.cip4-jmf+xml; charset=utf-8');
      }
      sendText(res, 405, 'Methode nicht unterstützt');
    } catch (e) {
      fleet.log(dev.id, 'error', `HTTP ${req.method} ${p}: ${e.message}`);
      if (!res.headersSent) sendText(res, 500, e.message);
    }
  });
  const h = await listen(httpServer, host, c.ports.http);
  dev._servers = [h.server];
  dev.ifaces.http = h.error ? { error: h.error } : { ok: true, port: c.ports.http };
  const l = await startLpd(fleet, dev, host, c.ports.lpd);
  dev._servers.push(l.server);
  dev.ifaces.lpd = l.error ? { error: l.error } : { ok: true, port: c.ports.lpd };
  const r = await startRaw(fleet, dev, host, c.ports.raw);
  dev._servers.push(r.server);
  dev.ifaces.raw = r.error ? { error: r.error } : { ok: true, port: c.ports.raw };
  for (const [k, v] of Object.entries(dev.ifaces)) if (v && v.error) fleet.log(dev.id, 'error', `${k.toUpperCase()}: ${v.error}`);
}

async function stopDeviceInterfaces(dev) {
  for (const s of dev._servers || []) if (s) await new Promise((r) => s.close(() => r()));
  dev._servers = [];
}

// ------------------------------------------------------------------ REST-API + UI
function buildApi(fleet, ctl) {
  const r = new Router();
  const body = async (req) => { const b = await readBody(req, 4 * 1024 * 1024); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

  r.add('GET', '/api/state', (req, res) => sendJson(res, 200, fleet.summary()));
  r.add('GET', '/api/log', (req, res) => sendJson(res, 200, fleet.globalLog.slice(-500)));
  r.add('GET', '/api/devices/:id', (req, res, p) => sendJson(res, 200, fleet.deviceSummary(fleet.device(p.id))));
  r.add('GET', '/api/devices/:id/driver.ppd', (req, res, p) => {
    const dev = fleet.device(p.id);
    sendText(res, 200, generatePpd(fleet, dev), 'application/vnd.cups-ppd', { 'Content-Disposition': `attachment; filename="VPF-${dev.id}.ppd"` });
  });
  r.add('GET', '/api/devices/:id/traffic', (req, res, p) => sendJson(res, 200, fleet.device(p.id).traffic.slice(-300)));
  r.add('POST', '/api/devices/:id/slots/:slot', async (req, res, p) => {
    const b = await body(req);
    const dev = fleet.device(p.id);
    if (b.level != null && !b.mediaId && b.keepMedia) dev.setLevel(p.slot, b.level);
    else dev.loadSlot(p.slot, b.mediaId || null, b.level);
    sendJson(res, 200, fleet.deviceSummary(dev));
  });
  r.add('POST', '/api/devices/:id/errors', async (req, res, p) => {
    const b = await body(req);
    const dev = fleet.device(p.id);
    dev.setError(b.type, b.active);
    sendJson(res, 200, fleet.deviceSummary(dev));
  });
  r.add('POST', '/api/devices/:id/refill', async (req, res, p) => { const dev = fleet.device(p.id); dev.refillSupplies(); sendJson(res, 200, fleet.deviceSummary(dev)); });
  r.add('PUT', '/api/devices/:id', async (req, res, p) => {
    const b = await body(req);
    const dev = fleet.device(p.id);
    const c = dev.cfg;
    const restart = (b.ports && JSON.stringify(b.ports) !== JSON.stringify(c.ports)) || (b.host !== undefined && b.host !== c.host) || (b.enabled !== undefined && b.enabled !== c.enabled);
    for (const k of ['name', 'host', 'ports', 'settings', 'marginsMm', 'speed', 'presets', 'defaultTicket', 'enabled', 'finisher', 'supplies', 'roll', 'sheet', 'duplex', 'color']) if (b[k] !== undefined) c[k] = b[k];
    fleet.saveNow();
    if (restart) await startDeviceInterfaces(fleet, dev);
    ctl.hot.stop(); ctl.hot.start();
    ctl.mdns.announce();
    dev.changed();
    sendJson(res, 200, fleet.deviceSummary(dev));
  });
  r.add('POST', '/api/devices/:id/duplicate', async (req, res, p) => {
    const b = await body(req);
    const src = fleet.device(p.id);
    const cfg = clone(src.cfg);
    cfg.id = (b.id || `${cfg.id}-${Math.random().toString(36).slice(2, 6)}`).replace(/[^\w-]/g, '');
    cfg.name = b.name || `${cfg.name} (Kopie)`;
    cfg.ports = {};
    const used = new Set(Array.from(fleet.devices.values()).flatMap((d) => Object.values(d.cfg.ports)));
    const pick = (base) => { let x = base; while (used.has(x)) x++; used.add(x); return x; };
    cfg.ports = { http: pick(fleet.settings.basePorts.http), lpd: pick(fleet.settings.basePorts.lpd), raw: pick(fleet.settings.basePorts.raw) };
    const dev = fleet._addDevice(cfg, fleet.devices.size);
    fleet.saveNow();
    await startDeviceInterfaces(fleet, dev);
    ctl.hot.stop(); ctl.hot.start();
    sendJson(res, 200, fleet.deviceSummary(dev));
  });
  r.add('DELETE', '/api/devices/:id', async (req, res, p) => {
    const dev = fleet.device(p.id);
    await stopDeviceInterfaces(dev);
    fleet.devices.delete(p.id);
    fleet.saveNow();
    sendJson(res, 200, { deleted: p.id });
  });
  r.add('POST', '/api/reset', async (req, res) => {
    for (const d of fleet.devices.values()) await stopDeviceInterfaces(d);
    for (const f of ['fleet.json', 'media.json']) { try { fs.unlinkSync(fleet.store.file(f)); } catch { /* */ } }
    sendJson(res, 200, { ok: true, note: 'Bitte Anwendung neu starten, um den Standard-Maschinenpark zu laden.' });
    setTimeout(() => ctl.restart && ctl.restart(), 200);
  });
  r.add('GET', '/api/devices/:id/jobs', (req, res, p) => sendJson(res, 200, fleet.jobsOf(p.id).sort((a, b) => b.id - a.id).map((j) => j.toJSON())));
  r.add('POST', '/api/devices/:id/jobs', async (req, res, p) => {
    const dev = fleet.device(p.id);
    const raw = await readBody(req);
    const parts = parseMultipart(raw, req.headers['content-type']);
    const file = parts.find((x) => x.filename);
    if (!file) return sendJson(res, 400, { error: 'Keine Datei' });
    const queue = (parts.find((x) => x.name === 'queue') || {}).data?.toString('utf8') || null;
    const ticketPart = parts.find((x) => x.name === 'ticket');
    const job = fleet.createJob(dev.id, { name: file.filename, user: 'Oberfläche', source: { protocol: 'Upload (Oberfläche)', queue }, queue });
    if (ticketPart && ticketPart.data.length) applyObject(job, JSON.parse(ticketPart.data.toString('utf8')), 'Upload-Ticket');
    fleet.submit(job, file.data, { filename: file.filename });
    sendJson(res, 200, job.toJSON());
  });
  r.add('GET', '/api/jobs', (req, res) => sendJson(res, 200, Array.from(fleet.jobs.values()).sort((a, b) => b.id - a.id).slice(0, 300).map((j) => j.toJSON())));
  r.add('GET', '/api/jobs/:id', (req, res, p) => {
    const j = fleet.job(p.id);
    sendJson(res, 200, { ...j.toJSON(), log: j.log, protocol: j.protocol.length ? j.protocol : undefined });
  });
  r.add('GET', '/api/jobs/:id/protocol', (req, res, p) => {
    const j = fleet.job(p.id);
    const f = j.file('protokoll.txt');
    if (j.protocol.length) return sendText(res, 200, j.protocolText());
    if (fs.existsSync(f)) return sendFile(res, f);
    sendText(res, 200, '(kein Protokoll)');
  });
  r.add('GET', '/api/jobs/:id/files/:name', (req, res, p) => {
    const j = fleet.job(p.id);
    const name = path.basename(p.name);
    const dl = new URL(req.url, 'http://x').searchParams.get('download');
    sendFile(res, j.file(name), { download: dl ? `job${j.id}_${name}` : null });
  });
  r.add('POST', '/api/jobs/:id/:action', async (req, res, p) => {
    const b = await body(req);
    const j = fleet.jobAction(p.id, p.action, b);
    sendJson(res, 200, j.toJSON());
  });
  r.add('GET', '/api/media', (req, res) => sendJson(res, 200, Array.from(fleet.catalog.values())));
  r.add('POST', '/api/media', async (req, res) => {
    const m = await body(req);
    if (!m.id || !m.name || !['sheet', 'roll'].includes(m.kind)) return sendJson(res, 400, { error: 'id, name und kind (sheet|roll) erforderlich' });
    for (const k of ['widthMm', 'heightMm', 'lengthM', 'gsm']) if (m[k] != null && m[k] !== '') m[k] = Number(m[k]);
    fleet.catalog.set(m.id, m);
    fleet.saveNow();
    sendJson(res, 200, m);
  });
  r.add('DELETE', '/api/media/:id', (req, res, p) => { fleet.catalog.delete(p.id); fleet.saveNow(); sendJson(res, 200, { deleted: p.id }); });
  r.add('PUT', '/api/settings', async (req, res) => {
    const b = await body(req);
    for (const k of ['timeFactor', 'ghostscript', 'keepJobs', 'publicHost']) if (b[k] !== undefined) fleet.settings[k] = b[k];
    const mdnsChanged = b.mdns !== undefined && b.mdns !== fleet.settings.mdns;
    if (b.mdns !== undefined) fleet.settings.mdns = !!b.mdns;
    let restart = false;
    if (b.bindHost && b.bindHost !== fleet.settings.bindHost) { fleet.settings.bindHost = b.bindHost; restart = true; }
    fleet.saveNow();
    if (restart) for (const d of fleet.devices.values()) await startDeviceInterfaces(fleet, d);
    if (restart || mdnsChanged) await ctl.mdns.restart();
    sendJson(res, 200, fleet.settings);
  });
  r.add('GET', '/api/system', async (req, res) => {
    let printers = [];
    try { printers = await cupsList(); } catch { /* */ }
    sendJson(res, 200, { platform: process.platform, mdns: ctl.mdns.status, mdnsHost: ctl.mdns.hostName(), systemPrinters: printers, commands: manualCommands(fleet.summary(), { uiPort: fleet.settings.uiPort }) });
  });
  r.add('POST', '/api/system/printers', async (req, res) => {
    const b = await body(req);
    const lines = [];
    try {
      if (b.remove) await removeSystemPrinters({ log: (l) => lines.push(l) });
      else await installSystemPrinters(fleet.summary(), { allQueues: !!b.allQueues, raw: !!b.raw, driverless: !!b.driverless, getPpd: (id) => generatePpd(fleet, fleet.device(id)), log: (l) => lines.push(l) });
      fleet.log(null, 'info', `Systemdrucker ${b.remove ? 'entfernt' : 'eingerichtet'}:\n${lines.join('\n')}`);
      sendJson(res, 200, { ok: true, output: lines.join('\n') });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: e.message, output: lines.join('\n'), hint: process.platform === 'win32' ? 'PowerShell als Administrator: vpf drucker-einrichten' : 'Im Terminal: sudo vpf drucker-einrichten' });
    }
  });
  r.add('GET', '/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const on = (ev) => { try { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`); } catch { /* */ } };
    fleet.on('event', on);
    const ka = setInterval(() => res.write(': ka\n\n'), 25000);
    req.on('close', () => { fleet.off('event', on); clearInterval(ka); });
  });
  return r;
}

async function startServer(opts = {}) {
  const store = new Store(opts.dataDir);
  const overrides = {};
  if (opts.timeFactor != null) overrides.timeFactor = opts.timeFactor;
  if (opts.bindHost) overrides.bindHost = opts.bindHost;
  if (opts.basePorts) overrides.basePorts = opts.basePorts;
  const fleet = new Fleet(store, overrides);
  const uiPort = opts.port || fleet.settings.uiPort;
  const uiHost = opts.uiHost || fleet.settings.uiHost || '127.0.0.1';
  fleet.uiUrl = `http://${uiHost === '0.0.0.0' ? '127.0.0.1' : uiHost}:${uiPort}`;
  setupJmfNotifications(fleet);
  const ctl = { hot: new HotFolders(fleet), mdns: new MdnsResponder(fleet), restart: opts.onRestart };
  fleet.mdns = ctl.mdns;
  const api = buildApi(fleet, ctl);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    try {
      if (p.startsWith('/api/')) {
        const m = api.match(req.method, p);
        if (!m) return sendJson(res, 404, { error: 'Unbekannter API-Endpunkt' });
        return await m.fn(req, res, m.params);
      }
      const f = path.join(UI_DIR, p === '/' ? 'index.html' : path.normalize(p).replace(/^([/\\])+/, ''));
      if (!f.startsWith(UI_DIR)) return sendText(res, 403, 'Verboten');
      return sendFile(res, f);
    } catch (e) {
      sendJson(res, e.status || 500, { error: e.message });
    }
  });
  const main = await listen(server, uiHost, uiPort);
  if (main.error) throw new Error(`Oberfläche: ${main.error}`);
  for (const d of fleet.devices.values()) await startDeviceInterfaces(fleet, d);
  ctl.hot.start();
  if (opts.mdns !== false) ctl.mdns.start();
  fleet.start();
  fleet.log(null, 'info', `Simulation gestartet – Oberfläche ${fleet.uiUrl}, Daten in ${store.dir}`);
  return {
    fleet, url: fleet.uiUrl, server,
    async close() {
      ctl.hot.stop();
      await ctl.mdns.stop();
      clearTimeout(fleet._saveTimer);
      fleet.saveNow();
      fleet._closed = true;
      for (const d of fleet.devices.values()) await stopDeviceInterfaces(d);
      await new Promise((r) => server.close(() => r()));
      server.closeAllConnections && server.closeAllConnections();
    },
  };
}

module.exports = { startServer };
