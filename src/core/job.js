'use strict';
const fs = require('fs');
const path = require('path');

const PHASES = {
  EMPFANG: 'Empfang', PROTOKOLL: 'Protokoll', ANTWORT: 'Antwort', TICKET: 'Ticket', FORMAT: 'Format', PREFLIGHT: 'Preflight',
  MATERIAL: 'Material', RIP: 'RIP', AUSSCHUSS: 'Ausschießen', FINISHING: 'Finishing', DRUCK: 'Druck', SCHNITT: 'Schnitt',
  STATUS: 'Status', AUSGABE: 'Ausgabe', BEDIENER: 'Bediener',
};

// Interne Zustände -> IPP job-state
const IPP_STATE = { receiving: 3, pending: 3, held: 4, processing: 5, waiting: 6, printing: 5, stopped: 6, canceled: 7, aborted: 8, completed: 9 };
const STATE_DE = {
  receiving: 'Empfang', pending: 'Wartet', held: 'Angehalten', processing: 'Verarbeitung', waiting: 'Wartet auf Material',
  printing: 'Druckt', stopped: 'Unterbrochen', canceled: 'Abgebrochen', aborted: 'Fehler', completed: 'Fertig',
};
const FINAL = new Set(['canceled', 'aborted', 'completed']);

class Job {
  constructor(id, deviceId, dir, init = {}) {
    this.id = id;
    this.deviceId = deviceId;
    this.dir = dir;
    this.name = init.name || `Job ${id}`;
    this.user = init.user || 'unbekannt';
    this.source = init.source || { protocol: 'ui' };
    this.state = 'receiving';
    this.stateReasons = ['job-incoming'];
    this.stateMessage = '';
    this.created = new Date().toISOString();
    this.updated = this.created;
    this.completedAt = null;
    this.ticket = {};
    this.ticketSources = {};
    this.input = null;
    this.doc = null;
    this.summary = null;
    this.counters = { surfaces: 0, sheets: 0, impressions: 0, sets: 0, m2: 0, lengthMm: 0, cuts: 0, prints: 0 };
    this.consumption = [];
    this.outputs = {};
    this.progress = 0;
    this.simMs = 0;
    this.resumeFrom = null;
    this.waitReason = null;
    this.log = [];
    this.protocol = [];
    this.notify = [];
    this._listeners = [];
  }

  get ippState() { return IPP_STATE[this.state] || 3; }
  get isFinal() { return FINAL.has(this.state); }
  get stateText() { return STATE_DE[this.state] || this.state; }

  onChange(fn) { this._listeners.push(fn); }
  _emit(kind, data) { for (const fn of this._listeners) { try { fn(kind, data, this); } catch (e) { /* ignorieren */ } } }

  setState(state, reasons, message) {
    const prev = this.state;
    this.state = state;
    if (reasons) this.stateReasons = Array.isArray(reasons) ? reasons : [reasons];
    if (message !== undefined) this.stateMessage = message;
    this.updated = new Date().toISOString();
    if (FINAL.has(state)) this.completedAt = this.updated;
    if (prev !== state) this.addLog('STATUS', `Job-Status: ${STATE_DE[prev] || prev} → ${STATE_DE[state] || state}` + (this.stateReasons.length ? ` [${this.stateReasons.join(', ')}]` : '') + (message ? ` – ${message}` : ''));
    this._emit('state', { prev, state });
    this.save();
  }

  addLog(phase, msg, data, level = 'info') {
    const e = { ts: new Date().toISOString(), sim: this.simMs, phase: PHASES[phase] || phase, level, msg };
    if (data !== undefined) e.data = data;
    this.log.push(e);
    this._emit('log', e);
    return e;
  }
  warn(phase, msg, data) { return this.addLog(phase, msg, data, 'warn'); }
  error(phase, msg, data) { return this.addLog(phase, msg, data, 'error'); }

  /** Rohes Protokoll (Anfrage/Antwort) für die Nachvollziehbarkeit. */
  addProtocol(direction, title, text) {
    const e = { ts: new Date().toISOString(), direction, title, text: String(text) };
    this.protocol.push(e);
    this.addLog(direction === 'in' ? 'PROTOKOLL' : 'ANTWORT', title);
    return e;
  }

  advance(ms) { this.simMs += ms; }

  file(name) { return path.join(this.dir, name); }

  toJSON() {
    return {
      id: this.id, deviceId: this.deviceId, name: this.name, user: this.user, source: this.source,
      state: this.state, stateText: this.stateText, ippState: this.ippState, stateReasons: this.stateReasons, stateMessage: this.stateMessage,
      created: this.created, updated: this.updated, completedAt: this.completedAt,
      ticket: this.ticket, ticketSources: this.ticketSources, input: this.input, doc: this.doc, summary: this.summary,
      counters: this.counters, consumption: this.consumption, outputs: this.outputs, progress: this.progress, simMs: this.simMs,
      resumeFrom: this.resumeFrom, waitReason: this.waitReason, notify: this.notify, queueMode: this.queueMode || 'print', ignoreConflicts: !!this.ignoreConflicts,
    };
  }

  save() {
    try {
      fs.writeFileSync(this.file('job.json'), JSON.stringify(this.toJSON(), null, 2));
      fs.writeFileSync(this.file('log.json'), JSON.stringify(this.log, null, 1));
      fs.writeFileSync(this.file('log.txt'), this.logText());
      if (this.protocol.length) fs.writeFileSync(this.file('protokoll.txt'), this.protocolText());
    } catch (e) { /* Verzeichnis evtl. gelöscht */ }
  }

  logText() {
    const head = [
      `Virtual Print Fleet – Job-Protokoll`,
      `Job ${this.id} „${this.name}" auf Gerät ${this.deviceId}`,
      `Eingang: ${this.source.protocol}${this.source.queue ? ' / Warteschlange ' + this.source.queue : ''}${this.source.remote ? ' von ' + this.source.remote : ''}`,
      `Status: ${this.stateText}${this.stateMessage ? ' – ' + this.stateMessage : ''}`,
      `Simulierte Gesamtdauer: ${fmtSim(this.simMs)}`,
      '='.repeat(100),
    ];
    const lines = this.log.map((e) => {
      const lvl = e.level === 'warn' ? 'WARNUNG ' : e.level === 'error' ? 'FEHLER  ' : '';
      let s = `${e.ts.replace('T', ' ').replace('Z', '')}  [+${fmtSim(e.sim)}]  ${e.phase.padEnd(12)} ${lvl}${e.msg}`;
      if (e.data !== undefined && e.data !== null) {
        const d = typeof e.data === 'string' ? e.data : Array.isArray(e.data) && e.data.length && typeof e.data[0] === 'object' ? table(e.data) : JSON.stringify(e.data, null, 2);
        s += '\n' + d.split('\n').map((l) => '        │ ' + l).join('\n');
      }
      return s;
    });
    return head.concat(lines).join('\n') + '\n';
  }

  protocolText() {
    return this.protocol.map((p) => `${'-'.repeat(100)}\n${p.ts}  ${p.direction === 'in' ? '>>> EINGANG' : '<<< ANTWORT'}  ${p.title}\n${'-'.repeat(100)}\n${p.text}\n`).join('\n');
  }

  static load(dir, data) {
    const j = new Job(data.id, data.deviceId, dir);
    const { stateText, ippState, ...rest } = data;
    Object.assign(j, rest);
    try { j.log = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8')); } catch { j.log = []; }
    j.protocol = [];
    j._listeners = [];
    return j;
  }
}

function table(rows) {
  const keys = Object.keys(rows[0]);
  const cell = (v) => (v === true ? 'ja' : v === false ? 'nein' : v == null ? '' : String(v));
  const w = keys.map((k) => Math.min(48, Math.max(k.length, ...rows.map((r) => cell(r[k]).length))));
  const line = (vals) => vals.map((v, i) => v.slice(0, 48).padEnd(w[i])).join('  ');
  return [line(keys.map((k) => k.toUpperCase())), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(keys.map((k) => cell(r[k]))))].join('\n');
}

function fmtSim(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const frac = Math.floor((ms % 1000) / 100);
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + '.' + frac;
}

module.exports = { Job, IPP_STATE, STATE_DE, FINAL, fmtSim };
