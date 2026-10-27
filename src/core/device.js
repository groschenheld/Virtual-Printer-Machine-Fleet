'use strict';
// Laufzeit-Zustand eines simulierten Geräts: Warteschlange, Status/Fehler, Material, Verbrauch.
const { frontendOf, queuesOf } = require('../frontends');
const { processJob, Canceled } = require('../pipeline/pipeline');
const { sleep } = require('../util/misc');

const ERRORS = {
  jam: { reason: 'media-jam-error', text: 'Papierstau', blocking: true },
  cover: { reason: 'cover-open-error', text: 'Abdeckung offen', blocking: true },
  offline: { reason: 'offline-report', text: 'Offline', blocking: true },
  staples: { reason: 'other-error', text: 'Heftklammern leer', blocking: false, finisher: true },
  finisher: { reason: 'other-error', text: 'Finisher-Störung', blocking: true },
  cutter: { reason: 'other-error', text: 'Schneidmesser-Fehler', blocking: true },
  ink: { reason: 'marker-supply-low-warning', text: 'Tinte/Toner niedrig', blocking: false },
  paused: { reason: 'paused', text: 'Angehalten (Bediener)', blocking: true },
};

class Device {
  constructor(fleet, cfg) {
    this.fleet = fleet;
    this.cfg = cfg;
    cfg.settings = cfg.settings || {};
    this.errors = {};
    this.waitReason = null;
    this.current = null;
    this.busy = false;
    this.waiters = [];
    this.ifaces = {};
    this.mediaVersion = 0;
    this.startedAt = Date.now();
    this.traffic = [];
  }

  /** Schnittstellen-Mitschnitt (IPP, LPD, Socket, JMF, Fiery-API). noisy = Statusabfragen/Polling. */
  trace(proto, dir, title, text = '', noisy = false) {
    const e = { ts: new Date().toISOString(), proto, dir, title, text: text ? String(text).slice(0, 20000) : '', noisy: !!noisy };
    this.traffic.push(e);
    if (this.traffic.length > 400) this.traffic.splice(0, 100);
    this.fleet.emit('event', { type: 'trace', data: { deviceId: this.id, ...e, text: undefined } });
  }
  get id() { return this.cfg.id; }
  get fe() { return frontendOf(this.cfg); }
  get settings() { return this.cfg.settings; }
  get queues() { return queuesOf(this.cfg); }

  queueByName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase().replace(/^\/+/, '');
    return this.queues.find((q) => q.name.toLowerCase() === n) || null;
  }

  // ------------------------------------------------ Status
  get status() {
    const reasons = [];
    let msg = '';
    for (const [k, on] of Object.entries(this.errors)) if (on && ERRORS[k]) { reasons.push(ERRORS[k].reason); msg = msg || ERRORS[k].text; }
    if (this.waitReason) { reasons.push(this.waitReason.reason); msg = msg || this.waitReason.text; }
    const low = (this.cfg.supplies || []).filter((s) => s.level < 10);
    if (low.length) reasons.push(this.cfg.supplies[0]?.type === 'toner' ? 'toner-low-warning' : 'marker-supply-low-warning');
    for (const s of this.cfg.slots) if (s.kind === 'sheet' && s.ippSource !== 'manual' && (!s.loaded || s.loaded.level <= 0)) { if (!reasons.includes('media-empty-warning')) reasons.push('media-empty-warning'); }
    const blocking = Object.entries(this.errors).some(([k, on]) => on && ERRORS[k]?.blocking) || !!this.waitReason;
    const state = blocking ? 'stopped' : this.current ? 'processing' : 'idle';
    if (!reasons.length) reasons.push('none');
    const stateDe = { idle: 'Bereit', processing: 'Druckt', stopped: 'Gestoppt' }[state];
    return { state, stateDe, ipp: { idle: 3, processing: 4, stopped: 5 }[state], reasons, message: msg || stateDe, accepting: !this.errors.offline, current: this.current ? this.current.id : null };
  }

  changed() {
    for (const w of this.waiters.slice()) {
      if (w.job._cancel) { w.resolve('canceled'); this.waiters.splice(this.waiters.indexOf(w), 1); continue; }
      let ok = false;
      try { ok = w.pred(); } catch { ok = false; }
      if (ok) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve('ok'); }
    }
    this.fleet.emitDevice(this);
  }

  waitFor(job, pred, what) {
    if (pred()) return Promise.resolve('ok');
    return new Promise((resolve) => this.waiters.push({ job, pred, resolve, what }));
  }

  mediaVersionChanged(job) {
    if (job._mv === undefined) { job._mv = this.mediaVersion; return false; }
    if (this.mediaVersion !== job._mv) { delete job._mv; return true; }
    return false;
  }

  setWaitingReason(reason, text) {
    this.waitReason = reason ? { reason, text } : null;
    this.changed();
  }

  setError(type, on) {
    if (!ERRORS[type]) throw new Error(`Unbekannter Fehler ${type}`);
    this.errors[type] = !!on;
    this.fleet.log(this.id, on ? 'warn' : 'info', `${ERRORS[type].text} ${on ? 'ausgelöst' : 'behoben'}`);
    if (this.current) this.current.addLog('BEDIENER', `Gerätezustand: ${ERRORS[type].text} ${on ? 'ausgelöst' : 'behoben'}`);
    this.changed();
    if (!on) this.kick();
  }

  /** Blockierende Fehler während des Drucks abwarten. */
  async checkInterrupts(job) {
    if (job._cancel) throw new Canceled();
    const blocking = () => Object.entries(this.errors).filter(([k, on]) => on && ERRORS[k]?.blocking);
    if (blocking().length) {
      const [k] = blocking()[0];
      const prev = job.state;
      job.setState('stopped', [ERRORS[k].reason, 'job-printing'], ERRORS[k].text);
      job.warn('DRUCK', `Unterbrechung: ${ERRORS[k].text} – Druck pausiert`);
      const r = await this.waitFor(job, () => blocking().length === 0, 'Fehler');
      if (r === 'canceled') throw new Canceled();
      job.setState(prev === 'stopped' ? 'printing' : prev, ['job-printing'], this.fe.stages.print);
      job.addLog('BEDIENER', 'Störung behoben – Druck läuft weiter');
    }
  }

  /** Simulierte Zeit vergeht (skaliert mit dem Zeitfaktor). */
  async simDelay(job, simMs) {
    job.advance(simMs);
    const f = this.fleet.settings.timeFactor;
    if (!f) return;
    let real = simMs / f;
    while (real > 0) {
      if (job._cancel) throw new Canceled();
      const step = Math.min(real, 250);
      await sleep(step);
      real -= step;
    }
  }

  consumeSupplies(impressions, job) {
    const per = this.cfg.kind === 'sheet' ? 0.004 : this.cfg.kind === 'photo' ? 0.02 : 0.15;
    for (const s of this.cfg.supplies || []) {
      const before = s.level;
      s.level = Math.max(0, Math.round((s.level - per * impressions * (0.6 + Math.random() * 0.8)) * 100) / 100);
      if (before >= 10 && s.level < 10) { job.warn('DRUCK', `${s.name} unter 10 % – ${s.type === 'toner' ? 'Toner' : 'Tinte'} bereitlegen`); }
    }
  }

  afterJob(job) {
    this.fleet.saveFleet();
  }

  // ------------------------------------------------ Material
  loadSlot(slotId, mediaId, level) {
    const slot = this.cfg.slots.find((s) => s.id === slotId);
    if (!slot) throw new Error(`Fach/Rolle ${slotId} unbekannt`);
    if (!mediaId) { slot.loaded = null; this.fleet.log(this.id, 'info', `${slot.name} entladen`); }
    else {
      const m = this.fleet.catalog.get(mediaId);
      if (!m) throw new Error(`Material ${mediaId} unbekannt`);
      if (m.kind !== slot.kind) throw new Error(`${m.name} ist ${m.kind === 'roll' ? 'Rollenware' : 'Bogenware'} – passt nicht in ${slot.name}`);
      if (slot.kind === 'roll') {
        const cap = this.cfg.roll || {};
        if (cap.maxWidthMm && m.widthMm > cap.maxWidthMm) throw new Error(`Rollenbreite ${m.widthMm} mm > max. ${cap.maxWidthMm} mm`);
        if (cap.minWidthMm && m.widthMm < cap.minWidthMm) throw new Error(`Rollenbreite ${m.widthMm} mm < min. ${cap.minWidthMm} mm`);
        slot.loaded = { mediaId, levelM: level != null && level !== '' ? Number(level) : m.lengthM };
      } else {
        const sh = this.cfg.sheet || {};
        const a = Math.min(m.widthMm, m.heightMm), b = Math.max(m.widthMm, m.heightMm);
        if (sh.maxMm && (a > Math.min(...sh.maxMm) + 0.5 || b > Math.max(...sh.maxMm) + 0.5)) throw new Error(`${m.name}: Format zu groß für dieses Gerät (max. ${sh.maxMm.join(' × ')} mm)`);
        if (sh.maxGsm && m.gsm > sh.maxGsm) throw new Error(`${m.gsm} g/m² über Maximum ${sh.maxGsm} g/m²`);
        slot.loaded = { mediaId, level: level != null && level !== '' ? Number(level) : slot.capacity };
      }
      this.fleet.log(this.id, 'info', `${slot.name}: ${m.name} geladen (${slot.kind === 'roll' ? slot.loaded.levelM + ' m' : slot.loaded.level + ' Bogen'})`);
    }
    this.mediaVersion++;
    if (this.current) this.current.addLog('BEDIENER', `Material geändert: ${slot.name} → ${slot.loaded ? this.fleet.catalog.get(slot.loaded.mediaId).name : 'leer'}`);
    this.fleet.saveFleet();
    this.changed();
    this.kick();
    return slot;
  }

  setLevel(slotId, level) {
    const slot = this.cfg.slots.find((s) => s.id === slotId);
    if (!slot || !slot.loaded) throw new Error('Fach leer');
    if (slot.kind === 'roll') slot.loaded.levelM = Number(level); else slot.loaded.level = Math.min(Number(level), slot.capacity);
    this.mediaVersion++;
    this.fleet.saveFleet();
    this.changed();
    this.kick();
  }

  refillSupplies() {
    for (const s of this.cfg.supplies || []) s.level = 100;
    const f = this.cfg.finisher?.modules || {};
    if (f.stapler) f.stapler.staples = 5000;
    if (f.booklet) f.booklet.staples = 5000;
    this.fleet.saveFleet();
    this.changed();
  }

  // ------------------------------------------------ Warteschlange
  pendingJobs() {
    return this.fleet.jobsOf(this.id).filter((j) => j.state === 'pending').sort((a, b) => (b.ticket.priority || 50) - (a.ticket.priority || 50) || a.id - b.id);
  }

  async kick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        if (Object.entries(this.errors).some(([k, on]) => on && ['offline', 'paused'].includes(k))) break;
        const next = this.pendingJobs()[0];
        if (!next) break;
        this.current = next;
        this.changed();
        try { await processJob(this, next); } catch (e) { next.error('STATUS', 'Interner Fehler: ' + e.message, e.stack); next.setState('aborted', ['aborted-by-system'], e.message); }
        this.current = null;
        this.fleet.onJobFinishedProcessing(next);
        this.changed();
      }
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}

module.exports = { Device, ERRORS };
