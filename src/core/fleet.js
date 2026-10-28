'use strict';
const { $t, $tp, $lazy, setLang, getLang, inLang, Pair } = require('../i18n.js');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const defaults = require('../config/defaults');
const { Device } = require('./device');
const { Job, FINAL } = require('./job');
const { baseTicket, applyObject, setTicket } = require('../pipeline/ticket');
const { clone, deepMerge, safeName } = require('../util/misc');
const { frontendOf } = require('../frontends');

class Fleet extends EventEmitter {
  constructor(store, overrides = {}) {
    super();
    this.setMaxListeners(100);
    this.store = store;
    this.settings = deepMerge(clone(defaults.settings), store.readJson('settings.json', {}));
    deepMerge(this.settings, overrides);
    if (this.settings.lang) setLang(this.settings.lang);
    this.catalog = new Map();
    for (const m of store.readJson('media.json', null) || clone(defaults.media)) this.catalog.set(m.id, m);
    const saved = store.readJson('fleet.json', null);
    const cfgs = saved && saved.devices ? saved.devices : clone(defaults.devices);
    this.devices = new Map();
    cfgs.forEach((c, i) => this._addDevice(c, i));
    this.relabel();
    this.state = store.readJson('state.json', { nextJobId: 1001 });
    this.jobs = new Map();
    this.globalLog = [];
    this._loadJobs();
    this._saveTimer = null;
  }

  _addDevice(cfg, index) {
    cfg.ports = cfg.ports || {};
    const b = this.settings.basePorts;
    cfg.ports.http = cfg.ports.http || b.http + index;
    cfg.ports.lpd = cfg.ports.lpd || b.lpd + index;
    cfg.ports.raw = cfg.ports.raw || b.raw + index;
    if (!cfg.ip) {
      const used = new Set(Array.from(this.devices.values()).map((d) => d.cfg.ip));
      let n = 11 + index;
      while (used.has(`127.0.0.${n}`)) n++;
      cfg.ip = `127.0.0.${n}`;
    }
    cfg.enabled = cfg.enabled !== false;
    for (const s of cfg.slots || []) if (s.kind === 'roll' && s.loaded && s.loaded.levelM == null) { const m = this.catalog.get(s.loaded.mediaId); if (m) s.loaded.levelM = m.lengthM; }
    // Bezeichnungen älterer Versionen aktualisieren
    const { PRODUCTS } = require('../frontends');
    if (cfg.vendor === 'Epson' && cfg.kind === 'wide') for (const p of cfg.presets || []) if (!p.frontend && /Nesting|Randlos/.test(p.name)) p.frontend = 'edgeprint';
    if (cfg.frontend && PRODUCTS[cfg.frontend.type] && /Publisher Select|^Epson Edge Print$|^Epson-Treiber|^Epson Order Controller$|^Roland VersaWorks 6$/.test(cfg.frontend.product || '')) cfg.frontend.product = PRODUCTS[cfg.frontend.type];
    const d = new Device(this, cfg);
    this.devices.set(cfg.id, d);
    return d;
  }

  _loadJobs() {
    for (const id of this.store.listJobIds()) {
      const dir = path.join(this.store.jobsDir, String(id));
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
        const j = Job.load(dir, data);
        if (!FINAL.has(j.state) && j.state !== 'held') {
          j.addLog('STATUS', $t('Simulation wurde neu gestartet – Job wird erneut verarbeitet', 'Simulation was restarted – job is processed again'));
          j.state = 'pending';
          if (j.resumeFrom === 'print') j.resumeFrom = 'rip';
        }
        if (j.state === 'held' && j.resumeFrom === 'print') j.resumeFrom = 'rip';
        this._wireJob(j);
        this.jobs.set(j.id, j);
        if (id >= this.state.nextJobId) this.state.nextJobId = id + 1;
      } catch { /* defektes Verzeichnis ignorieren */ }
    }
  }

  start() {
    for (const d of this.devices.values()) d.kick();
  }

  // ------------------------------------------------ Persistenz
  /** Sprache umstellen / switch language (UI, logs, device pages, drivers). */
  setLanguage(l) {
    this.settings.lang = setLang(l);
    this.relabel();
    this.saveFleet();
    for (const d of this.devices.values()) d.changed && d.changed();
    this.emit('event', { type: 'settings', data: { lang: this.settings.lang } });
    return this.settings.lang;
  }

  /** Standardnamen (Material, Fächer, Finisher, Ablagen) in die aktuelle Sprache – eigene Namen bleiben. */
  relabel() {
    const lang = getLang();
    const pick = (cur, pair) => (pair instanceof Pair && (cur === pair.de || cur === pair.en) ? pair[lang] : cur);
    const dm = new Map(defaults.media.map((m) => [m.id, m]));
    for (const m of this.catalog.values()) { const d = dm.get(m.id); if (d) m.name = pick(m.name, d.name); }
    const dd = new Map(defaults.devices.map((d) => [d.id, d]));
    for (const dev of this.devices.values()) {
      const c = dev.cfg;
      const d = dd.get(c.id) || dd.get(String(c.id).replace(/-\d+$/, ''));
      if (!d) continue;
      c.model = pick(c.model, d.model);
      if (c.frontend && d.frontend && d.frontend.product instanceof Pair && d.frontend.type === c.frontend.type) c.frontend.product = pick(c.frontend.product, d.frontend.product);
      if (c.frontend && c.frontend.type) {
        const P = require('../frontends').PRODUCTS;
        const pr = new Pair(inLang('de', () => P[c.frontend.type]), inLang('en', () => P[c.frontend.type]));
        if (pr.de) c.frontend.product = pick(c.frontend.product, pr);
      }
      for (const s of c.slots || []) { const ds = (d.slots || []).find((x) => x.id === s.id); if (ds) s.name = pick(s.name, ds.name); }
      if (c.finisher && d.finisher) {
        c.finisher.name = pick(c.finisher.name, d.finisher.name);
        for (const b of c.finisher.bins || []) { const db = (d.finisher.bins || []).find((x) => x.id === b.id); if (db) b.name = pick(b.name, db.name); }
      }
    }
  }

  saveFleet() {
    if (this._closed) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 300);
  }
  saveNow() {
    this.store.writeJson('fleet.json', { version: 1, devices: Array.from(this.devices.values()).map((d) => d.cfg) });
    this.store.writeJson('media.json', Array.from(this.catalog.values()));
    this.store.writeJson('settings.json', this.settings);
    this.store.writeJson('state.json', this.state);
  }

  // ------------------------------------------------ Ereignisse
  log(deviceId, level, msg) {
    const e = { ts: new Date().toISOString(), deviceId, level, msg };
    this.globalLog.push(e);
    if (this.globalLog.length > 2000) this.globalLog.splice(0, 500);
    this.emit('event', { type: 'log', data: e });
  }
  emitDevice(d) {
    this.emit('event', { type: 'device', data: this.deviceSummary(d) });
  }

  _wireJob(job) {
    job.onChange((kind, data, j) => {
      if (kind === 'state') {
        this.emit('event', { type: 'job', data: j.toJSON() });
        this.log(j.deviceId, j.state === 'aborted' ? 'error' : 'info', `Job ${j.id} "${j.name}": ${j.stateText}${j.stateMessage ? ' – ' + j.stateMessage : ''}`);
        this.emit('jobState', j, data);
      } else if (kind === 'log') {
        this.emit('event', { type: 'joblog', data: { jobId: j.id, entry: data } });
      } else if (kind === 'progress') {
        this.emit('event', { type: 'jobprogress', data: { jobId: j.id, progress: j.progress, counters: j.counters } });
      }
    });
  }

  // ------------------------------------------------ Jobs
  device(id) {
    const d = this.devices.get(id);
    if (!d) throw Object.assign(new Error($t(`Gerät ${id} unbekannt`, `Device ${id} unknown`)), { status: 404 });
    return d;
  }
  jobsOf(deviceId) { return Array.from(this.jobs.values()).filter((j) => j.deviceId === deviceId); }
  job(id) {
    const j = this.jobs.get(Number(id));
    if (!j) throw Object.assign(new Error($t(`Job ${id} unbekannt`, `Job ${id} unknown`)), { status: 404 });
    return j;
  }

  /**
   * Neuer Job: Basisticket + Warteschlangen-/Preset-Ticket. Protokolle ergänzen danach ihr Ticket.
   */
  createJob(deviceId, { name, user, source, queue } = {}) {
    const dev = this.device(deviceId);
    const id = this.state.nextJobId++;
    this.store.writeJson('state.json', this.state);
    const job = new Job(id, deviceId, this.store.jobDir(id), { name: name || `Job ${id}`, user, source });
    job.ticket = baseTicket();
    this._wireJob(job);
    this.jobs.set(id, job);
    const fe = frontendOf(dev.cfg);
    job.addLog('EMPFANG', $t(`Neuer Job ${id} für ${dev.cfg.name} (${fe.label} – ${dev.cfg.frontend.product}) über ${source?.protocol || 'UI'}${source?.remote ? ' von ' + source.remote : ''}`, `New job ${id} for ${dev.cfg.name} (${fe.label} – ${dev.cfg.frontend.product}) via ${source?.protocol || 'UI'}${source?.remote ? ' from ' + source.remote : ''}`));
    const q = dev.queueByName(queue) || dev.queues[0];
    if (queue && !dev.queueByName(queue)) job.warn('EMPFANG', $t(`Warteschlange/virtueller Drucker „${queue}" unbekannt – verwende „${q.name}"`, `Queue/virtual printer “${queue}” unknown – using “${q.name}”`));
    job.queueMode = q.mode;
    job.ticket.queue = q.name;
    job.ticketSources.queue = $t('Warteschlange', 'Queue');
    job.addLog('EMPFANG', $t(`Warteschlange: ${q.name} (${q.info})`, `Queue: ${q.name} (${q.info})`));
    if (q.ticket && Object.keys(q.ticket).length) applyObject(job, q.ticket, `Preset "${q.name}"`);
    if (dev.cfg.defaultTicket) applyObject(job, dev.cfg.defaultTicket, $t('Gerätestandard', 'Device default'));
    this.emit('event', { type: 'job', data: job.toJSON() });
    return job;
  }

  /** Daten übernehmen und einreihen. */
  submit(job, data, { filename, format } = {}) {
    const ext = (filename && path.extname(filename)) || '.bin';
    const file = 'eingang' + ext.toLowerCase().replace(/[^.\w]/g, '');
    fs.writeFileSync(job.file(file), data);
    job.input = { file, originalName: filename || null, bytes: data.length, mime: format || null };
    if (job.ticket.jobName && job.name.startsWith('Job ')) job.name = job.ticket.jobName;
    job.addLog('EMPFANG', $t(`${data.length.toLocaleString('de-DE')} Bytes gespeichert als ${file}${filename ? ` (Originalname ${filename})` : ''}`, `${data.length.toLocaleString('en-US')} bytes saved as ${file}${filename ? ` (original name ${filename})` : ''}`));
    job.setState('pending', ['job-queued'], $t('In Warteschlange', 'In queue'));
    this.device(job.deviceId).kick();
    return job;
  }

  /** Bedieneraktionen am Front-End. */
  jobAction(id, action, opts = {}) {
    const job = this.job(id);
    const dev = this.device(job.deviceId);
    switch (action) {
      case 'release':
        if (job.state !== 'held' && job.state !== 'waiting') throw new Error($t('Job ist nicht angehalten', 'Job is not held'));
        if (opts.force) { job.ignoreConflicts = true; job.addLog('BEDIENER', $t('Freigabe mit „Trotzdem drucken" (Konflikte ignorieren)', 'Released with “Print anyway” (ignore conflicts)')); }
        if (opts.mediaId || opts.source) {
          if (opts.mediaId) setTicket(job, 'media.mediaId', opts.mediaId, $t('Bediener (Materialzuweisung)', 'Operator (media assignment)'));
          if (opts.source) setTicket(job, 'media.source', opts.source, $t('Bediener (Fachzuweisung)', 'Operator (tray assignment)'));
          if (opts.mediaId) { setTicket(job, 'media.sizeMm', null, $t('Bediener', 'Operator'), true); setTicket(job, 'media.type', null, $t('Bediener', 'Operator'), true); }
        }
        job.ticket.hold = false;
        job.queueMode = 'print';
        job.addLog('BEDIENER', $t('Job freigegeben', 'Job released'));
        job.setState('pending', ['job-queued'], $t('Freigegeben', 'Released'));
        dev.kick();
        break;
      case 'hold':
        if (job.state !== 'pending') throw new Error($t('Nur wartende Jobs können angehalten werden', 'Only waiting jobs can be held'));
        job.setState('held', ['job-hold-until-specified'], $t('Vom Bediener angehalten', 'Held by operator'));
        break;
      case 'cancel':
        if (job.isFinal) throw new Error($t('Job ist bereits abgeschlossen', 'Job is already finished'));
        job._cancel = true;
        if (dev.current !== job) job.setState('canceled', ['job-canceled-by-user'], $t('Abgebrochen', 'Cancelled'));
        dev.changed();
        break;
      case 'reprint':
        if (!job.isFinal) throw new Error($t('Job läuft noch', 'Job is still running'));
        job._cancel = false;
        job.ignoreConflicts = false;
        job.resumeFrom = job.input && fs.existsSync(job.file('dokument.pdf')) ? 'rip' : 'spool';
        job.queueMode = 'print';
        job.ticket.hold = false;
        job.progress = 0;
        job.counters = { surfaces: 0, sheets: 0, impressions: 0, sets: 0, m2: 0, lengthMm: 0, cuts: 0, prints: 0 };
        job.consumption = [];
        job.addLog('BEDIENER', $t('Erneut drucken', 'Print again'));
        job.setState('pending', ['job-queued'], $t('Erneut drucken', 'Print again'));
        dev.kick();
        break;
      case 'ticket':
        if (!['held', 'pending', 'aborted', 'canceled', 'completed'].includes(job.state)) throw new Error($t('Ticket kann während der Verarbeitung nicht geändert werden', 'Ticket cannot be changed during processing'));
        applyObject(job, opts.ticket || {}, $t('Bediener (Job-Eigenschaften)', 'Operator (job properties)'));
        if (job.resumeFrom === 'print') job.resumeFrom = 'rip';
        job.save();
        break;
      case 'delete':
        if (dev.current === job) throw new Error($t('Job wird gerade verarbeitet', 'Job is being processed'));
        this.jobs.delete(job.id);
        this.store.removeJob(job.id);
        this.emit('event', { type: 'jobdeleted', data: { id: job.id } });
        break;
      default: throw new Error($t(`Aktion ${action} unbekannt`, `Action ${action} unknown`));
    }
    return job;
  }

  onJobFinishedProcessing(job) {
    // Aufräumen alter Jobs
    const max = this.settings.keepJobs || 500;
    if (this.jobs.size > max) {
      const finals = Array.from(this.jobs.values()).filter((j) => j.isFinal).sort((a, b) => a.id - b.id);
      for (const j of finals.slice(0, this.jobs.size - max)) { this.jobs.delete(j.id); this.store.removeJob(j.id); }
    }
  }

  /**
   * Netzwerkadresse eines Geräts je nach Adressierungsart:
   * 'ip'    – eigene Loopback-IP je Gerät mit Standardports (wie echte Maschinen im Netz)
   * 'ports' – gemeinsame IP, Geräte über eigene Ports unterschieden
   */
  netOf(c) {
    if (this.settings.addressing === 'ip') return { mode: 'ip', host: c.ip, http: 631, httpExtra: [80], lpd: 515, raw: 9100, snmp: 161 };
    return { mode: 'ports', host: c.host || this.settings.bindHost, http: c.ports.http, httpExtra: [], lpd: c.ports.lpd, raw: c.ports.raw, snmp: c.ports.snmp || null };
  }

  // ------------------------------------------------ Übersicht
  deviceSummary(d) {
    const c = d.cfg;
    const fe = frontendOf(c);
    const net = this.netOf(c);
    const host = net.host;
    const shownHost = host === '0.0.0.0' ? (this.settings.publicHost || '127.0.0.1') : host;
    const P = (p) => (p === 631 && net.mode === 'ip' ? '' : `:${p}`);
    return {
      id: c.id, name: c.name, vendor: c.vendor, model: c.model, kind: c.kind, enabled: c.enabled,
      frontend: { ...c.frontend, label: fe.label, station: fe.station, stationDe: require('../frontends').STATION_DE[fe.station] || 'Front-End', choices: require('../frontends').frontendChoices(c), features: fe.features, mismatchPolicy: c.settings.mismatchPolicy || fe.mismatchPolicy, conflictPolicy: c.settings.conflictPolicy || fe.conflictPolicy },
      status: d.status, errors: d.errors,
      color: c.color, duplex: c.duplex, speed: c.speed, marginsMm: c.marginsMm, sheet: c.sheet || null, roll: c.roll || null,
      slots: c.slots.map((s) => ({ ...s, media: s.loaded ? this.catalog.get(s.loaded.mediaId) || null : null })),
      finisher: c.finisher, finisherInstalled: require('../frontends').installedModules(c), supplies: c.supplies, presets: c.presets || [], settings: c.settings,
      queues: d.queues.map((q) => ({ name: q.name, mode: q.mode, info: q.info, ticket: q.ticket, hotfolder: path.join(this.store.hotDir, c.id, safeName(q.name)) })),
      ports: { ...c.ports, http: net.http, lpd: net.lpd, raw: net.raw, snmp: net.snmp, web: net.httpExtra[0] || net.http }, addressing: net.mode, ip: c.ip, host: shownHost,
      endpoints: {
        ipp: `ipp://${shownHost}${P(net.http)}/ipp/print`,
        ippQueues: d.queues.map((q) => `ipp://${shownHost}${P(net.http)}/ipp/print/${encodeURIComponent(q.name)}`),
        lpd: `${shownHost}:${net.lpd}`,
        lpdQueues: d.queues.map((q) => q.name),
        raw: `${shownHost}:${net.raw}`,
        snmp: net.snmp ? `${shownHost}:${net.snmp}` : null,
        web: `http://${shownHost}${net.mode === 'ip' ? '' : ':' + net.http}/`,
        jmf: `http://${shownHost}:${net.http}/jmf`,
        fieryApi: fe.features.includes('fiery-api') ? `http://${shownHost}${net.mode === 'ip' ? '' : ':' + net.http}/live/api/v5` : null,
        hotfolders: path.join(this.store.hotDir, c.id),
      },
      ifaces: d.ifaces,
      jobs: { total: this.jobsOf(c.id).length, active: this.jobsOf(c.id).filter((j) => !j.isFinal).length },
    };
  }

  summary() {
    return {
      settings: this.settings, lang: getLang(), dataDir: this.store.dir,
      devices: Array.from(this.devices.values()).map((d) => this.deviceSummary(d)),
      media: Array.from(this.catalog.values()),
    };
  }
}

module.exports = { Fleet };
