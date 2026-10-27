'use strict';
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
    this.catalog = new Map();
    for (const m of store.readJson('media.json', null) || defaults.media) this.catalog.set(m.id, m);
    const saved = store.readJson('fleet.json', null);
    const cfgs = saved && saved.devices ? saved.devices : clone(defaults.devices);
    this.devices = new Map();
    cfgs.forEach((c, i) => this._addDevice(c, i));
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
    cfg.enabled = cfg.enabled !== false;
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
          j.addLog('STATUS', 'Simulation wurde neu gestartet – Job wird erneut verarbeitet');
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
        this.log(j.deviceId, j.state === 'aborted' ? 'error' : 'info', `Job ${j.id} „${j.name}": ${j.stateText}${j.stateMessage ? ' – ' + j.stateMessage : ''}`);
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
    if (!d) throw Object.assign(new Error(`Gerät ${id} unbekannt`), { status: 404 });
    return d;
  }
  jobsOf(deviceId) { return Array.from(this.jobs.values()).filter((j) => j.deviceId === deviceId); }
  job(id) {
    const j = this.jobs.get(Number(id));
    if (!j) throw Object.assign(new Error(`Job ${id} unbekannt`), { status: 404 });
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
    job.addLog('EMPFANG', `Neuer Job ${id} für ${dev.cfg.name} (${fe.label} – ${dev.cfg.frontend.product}) über ${source?.protocol || 'UI'}${source?.remote ? ' von ' + source.remote : ''}`);
    const q = dev.queueByName(queue) || dev.queues[0];
    if (queue && !dev.queueByName(queue)) job.warn('EMPFANG', `Warteschlange/virtueller Drucker „${queue}" unbekannt – verwende „${q.name}"`);
    job.queueMode = q.mode;
    job.ticket.queue = q.name;
    job.ticketSources.queue = 'Warteschlange';
    job.addLog('EMPFANG', `Warteschlange: ${q.name} (${q.info})`);
    if (q.ticket && Object.keys(q.ticket).length) applyObject(job, q.ticket, `Preset „${q.name}"`);
    if (dev.cfg.defaultTicket) applyObject(job, dev.cfg.defaultTicket, 'Gerätestandard');
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
    job.addLog('EMPFANG', `${data.length.toLocaleString('de-DE')} Bytes gespeichert als ${file}${filename ? ` (Originalname ${filename})` : ''}`);
    job.setState('pending', ['job-queued'], 'In Warteschlange');
    this.device(job.deviceId).kick();
    return job;
  }

  /** Bedieneraktionen am Front-End. */
  jobAction(id, action, opts = {}) {
    const job = this.job(id);
    const dev = this.device(job.deviceId);
    switch (action) {
      case 'release':
        if (job.state !== 'held' && job.state !== 'waiting') throw new Error('Job ist nicht angehalten');
        if (opts.force) { job.ignoreConflicts = true; job.addLog('BEDIENER', 'Freigabe mit „Trotzdem drucken" (Konflikte ignorieren)'); }
        if (opts.mediaId || opts.source) {
          if (opts.mediaId) setTicket(job, 'media.mediaId', opts.mediaId, 'Bediener (Materialzuweisung)');
          if (opts.source) setTicket(job, 'media.source', opts.source, 'Bediener (Fachzuweisung)');
          if (opts.mediaId) { setTicket(job, 'media.sizeMm', null, 'Bediener', true); setTicket(job, 'media.type', null, 'Bediener', true); }
        }
        job.ticket.hold = false;
        job.queueMode = 'print';
        job.addLog('BEDIENER', 'Job freigegeben');
        job.setState('pending', ['job-queued'], 'Freigegeben');
        dev.kick();
        break;
      case 'hold':
        if (job.state !== 'pending') throw new Error('Nur wartende Jobs können angehalten werden');
        job.setState('held', ['job-hold-until-specified'], 'Vom Bediener angehalten');
        break;
      case 'cancel':
        if (job.isFinal) throw new Error('Job ist bereits abgeschlossen');
        job._cancel = true;
        if (dev.current !== job) job.setState('canceled', ['job-canceled-by-user'], 'Abgebrochen');
        dev.changed();
        break;
      case 'reprint':
        if (!job.isFinal) throw new Error('Job läuft noch');
        job._cancel = false;
        job.ignoreConflicts = false;
        job.resumeFrom = job.input && fs.existsSync(job.file('dokument.pdf')) ? 'rip' : 'spool';
        job.queueMode = 'print';
        job.ticket.hold = false;
        job.progress = 0;
        job.counters = { surfaces: 0, sheets: 0, impressions: 0, sets: 0, m2: 0, lengthMm: 0, cuts: 0, prints: 0 };
        job.consumption = [];
        job.addLog('BEDIENER', 'Erneut drucken');
        job.setState('pending', ['job-queued'], 'Erneut drucken');
        dev.kick();
        break;
      case 'ticket':
        if (!['held', 'pending', 'aborted', 'canceled', 'completed'].includes(job.state)) throw new Error('Ticket kann während der Verarbeitung nicht geändert werden');
        applyObject(job, opts.ticket || {}, 'Bediener (Job-Eigenschaften)');
        if (job.resumeFrom === 'print') job.resumeFrom = 'rip';
        job.save();
        break;
      case 'delete':
        if (dev.current === job) throw new Error('Job wird gerade verarbeitet');
        this.jobs.delete(job.id);
        this.store.removeJob(job.id);
        this.emit('event', { type: 'jobdeleted', data: { id: job.id } });
        break;
      default: throw new Error(`Aktion ${action} unbekannt`);
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

  // ------------------------------------------------ Übersicht
  deviceSummary(d) {
    const c = d.cfg;
    const fe = frontendOf(c);
    const host = c.host || this.settings.bindHost;
    const shownHost = host === '0.0.0.0' ? (this.settings.publicHost || '127.0.0.1') : host;
    return {
      id: c.id, name: c.name, vendor: c.vendor, model: c.model, kind: c.kind, enabled: c.enabled,
      frontend: { ...c.frontend, label: fe.label, features: fe.features, mismatchPolicy: c.settings.mismatchPolicy || fe.mismatchPolicy, conflictPolicy: c.settings.conflictPolicy || fe.conflictPolicy },
      status: d.status, errors: d.errors,
      color: c.color, duplex: c.duplex, speed: c.speed, marginsMm: c.marginsMm, sheet: c.sheet || null, roll: c.roll || null,
      slots: c.slots.map((s) => ({ ...s, media: s.loaded ? this.catalog.get(s.loaded.mediaId) || null : null })),
      finisher: c.finisher, finisherInstalled: require('../frontends').installedModules(c), supplies: c.supplies, presets: c.presets || [], settings: c.settings,
      queues: d.queues.map((q) => ({ name: q.name, mode: q.mode, info: q.info, ticket: q.ticket, hotfolder: path.join(this.store.hotDir, c.id, safeName(q.name)) })),
      ports: c.ports, host: shownHost,
      endpoints: {
        ipp: `ipp://${shownHost}:${c.ports.http}/ipp/print`,
        ippQueues: d.queues.map((q) => `ipp://${shownHost}:${c.ports.http}/ipp/print/${encodeURIComponent(q.name)}`),
        lpd: `${shownHost}:${c.ports.lpd}`,
        lpdQueues: d.queues.map((q) => q.name),
        raw: `${shownHost}:${c.ports.raw}`,
        jmf: `http://${shownHost}:${c.ports.http}/jmf`,
        fieryApi: fe.features.includes('fiery-api') ? `http://${shownHost}:${c.ports.http}/live/api/v5` : null,
        hotfolders: path.join(this.store.hotDir, c.id),
      },
      ifaces: d.ifaces,
      jobs: { total: this.jobsOf(c.id).length, active: this.jobsOf(c.id).filter((j) => !j.isFinal).length },
    };
  }

  summary() {
    return {
      settings: this.settings, dataDir: this.store.dir,
      devices: Array.from(this.devices.values()).map((d) => this.deviceSummary(d)),
      media: Array.from(this.catalog.values()),
    };
  }
}

module.exports = { Fleet };
