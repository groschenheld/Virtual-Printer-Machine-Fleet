'use strict';
// Laufzeit-Zustand eines simulierten Geräts: Warteschlange, Status/Fehler, Material, Verbrauch.
const { $t, $tp, $lazy } = require('../i18n.js');
const { frontendOf, queuesOf } = require('../frontends');
const { processJob, Canceled } = require('../pipeline/pipeline');
const { sleep } = require('../util/misc');

const ERRORS = $lazy({
  jam: { reason: 'media-jam-error', text: $tp('Papierstau', 'Paper jam'), blocking: true },
  cover: { reason: 'cover-open-error', text: $tp('Abdeckung offen', 'Cover open'), blocking: true },
  offline: { reason: 'offline-report', text: 'Offline', blocking: true },
  staples: { reason: 'other-error', text: $tp('Heftklammern leer', 'Staples empty'), blocking: false, finisher: true },
  finisher: { reason: 'other-error', text: $tp('Finisher-Störung', 'Finisher fault'), blocking: true },
  cutter: { reason: 'other-error', text: $tp('Schneidmesser-Fehler', 'Cutter blade error'), blocking: true },
  ink: { reason: 'marker-supply-low-warning', text: $tp('Tinte/Toner niedrig', 'Ink/toner low'), blocking: false },
  paused: { reason: 'paused', text: $tp('Angehalten (Bediener)', 'Paused (operator)'), blocking: true },
});

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
    const stateDe = { idle: $t('Bereit', 'Ready'), processing: $t('Druckt', 'Printing'), stopped: $t('Gestoppt', 'Stopped') }[state];
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
    if (!ERRORS[type]) throw new Error($t(`Unbekannter Fehler ${type}`, `Unknown error ${type}`));
    this.errors[type] = !!on;
    this.fleet.log(this.id, on ? 'warn' : 'info', `${ERRORS[type].text} ${on ? $t('ausgelöst', 'triggered') : $t('behoben', 'cleared')}`);
    if (this.current) this.current.addLog('BEDIENER', $t(`Gerätezustand: ${ERRORS[type].text} ${on ? 'ausgelöst' : 'behoben'}`, `Device state: ${ERRORS[type].text} ${on ? 'triggered' : 'cleared'}`));
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
      job.warn('DRUCK', $t(`Unterbrechung: ${ERRORS[k].text} – Druck pausiert`, `Interruption: ${ERRORS[k].text} – printing paused`));
      const r = await this.waitFor(job, () => blocking().length === 0, $t('Fehler', 'Error'));
      if (r === 'canceled') throw new Canceled();
      job.setState(prev === 'stopped' ? 'printing' : prev, ['job-printing'], this.fe.stages.print);
      job.addLog('BEDIENER', $t('Störung behoben – Druck läuft weiter', 'Fault cleared – printing continues'));
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
      if (before >= 10 && s.level < 10) { job.warn('DRUCK', $t(`${s.name} unter 10 % – ${s.type === 'toner' ? $t('Toner', 'Toner') : $t('Tinte', 'Ink')} bereitlegen`, `${s.name} below 10 % – have ${s.type === 'toner' ? 'toner' : 'ink'} ready`)); }
    }
  }

  afterJob(job) {
    this.fleet.saveFleet();
  }

  // ------------------------------------------------ Material
  loadSlot(slotId, mediaId, level) {
    const slot = this.cfg.slots.find((s) => s.id === slotId);
    if (!slot) throw new Error($t(`Fach/Rolle ${slotId} unbekannt`, `Tray/roll ${slotId} unknown`));
    if (!mediaId) { slot.loaded = null; this.fleet.log(this.id, 'info', $t(`${slot.name} entladen`, `${slot.name} unloaded`)); }
    else {
      const m = this.fleet.catalog.get(mediaId);
      if (!m) throw new Error($t(`Material ${mediaId} unbekannt`, `Media ${mediaId} unknown`));
      const why = this.mediaProblem(slot, m);
      if (why) throw new Error(why);
      if (slot.kind === 'roll') {
        slot.loaded = { mediaId, levelM: level != null && level !== '' ? Number(level) : m.lengthM };
      } else {
        slot.loaded = { mediaId, level: level != null && level !== '' ? Number(level) : slot.capacity };
      }
      this.fleet.log(this.id, 'info', $t(`${slot.name}: ${m.name} geladen (${slot.kind === 'roll' ? slot.loaded.levelM + ' m' : slot.loaded.level + ' Bogen'})`, `${slot.name}: ${m.name} loaded (${slot.kind === 'roll' ? slot.loaded.levelM + ' m' : slot.loaded.level + ' sheets'})`));
    }
    this.mediaVersion++;
    if (this.current) this.current.addLog('BEDIENER', $t(`Material geändert: ${slot.name} → ${slot.loaded ? this.fleet.catalog.get(slot.loaded.mediaId).name : 'leer'}`, `Media changed: ${slot.name} → ${slot.loaded ? this.fleet.catalog.get(slot.loaded.mediaId).name : 'empty'}`));
    this.fleet.saveFleet();
    this.changed();
    this.kick();
    return slot;
  }

  /** Grund, warum Material m nicht in slot passt (oder null). */
  mediaProblem(slot, m) {
    if (m.kind !== slot.kind) return $t(`${m.name} ist ${m.kind === 'roll' ? 'Rollenware' : 'Bogenware'} – passt nicht in ${slot.name}`, `${m.name} is ${m.kind === 'roll' ? 'roll media' : 'sheet media'} – does not fit ${slot.name}`);
    if (slot.kind === 'roll') {
      const cap = this.cfg.roll || {};
      if (cap.maxWidthMm && m.widthMm > cap.maxWidthMm) return $t(`Rollenbreite ${m.widthMm} mm > max. ${cap.maxWidthMm} mm`, `Roll width ${m.widthMm} mm > max. ${cap.maxWidthMm} mm`);
      if (cap.minWidthMm && m.widthMm < cap.minWidthMm) return $t(`Rollenbreite ${m.widthMm} mm < min. ${cap.minWidthMm} mm`, `Roll width ${m.widthMm} mm < min. ${cap.minWidthMm} mm`);
      return null;
    }
    const sh = this.cfg.sheet || {};
    const a = Math.min(m.widthMm, m.heightMm), b = Math.max(m.widthMm, m.heightMm);
    if (sh.maxMm && (a > Math.min(...sh.maxMm) + 0.5 || b > Math.max(...sh.maxMm) + 0.5)) return $t(`${m.name}: Format zu groß für dieses Gerät (max. ${sh.maxMm.join(' × ')} mm)`, `${m.name}: size too large for this device (max. ${sh.maxMm.join(' × ')} mm)`);
    if (sh.maxGsm && m.gsm > sh.maxGsm) return $t(`${m.gsm} g/m² über Maximum ${sh.maxGsm} g/m²`, `${m.gsm} g/m² above maximum ${sh.maxGsm} g/m²`);
    return null;
  }

  setLevel(slotId, level) {
    const slot = this.cfg.slots.find((s) => s.id === slotId);
    if (!slot || !slot.loaded) throw new Error($t('Fach leer', 'Tray empty'));
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
        try { await processJob(this, next); } catch (e) { next.error('STATUS', $t('Interner Fehler: ', 'Internal error: ') + e.message, e.stack); next.setState('aborted', ['aborted-by-system'], e.message); }
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
