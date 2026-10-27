'use strict';
// Front-End-Persönlichkeiten: Verhalten, Begriffe, Warteschlangen und Standard-Regeln
// so, wie sie sich gegenüber einer Druck-App und im Protokoll bemerkbar machen.

const FRONTENDS = {
  fiery: {
    label: 'EFI Fiery',
    queues: [
      { name: 'print', mode: 'print', info: 'Druckwarteschlange – wird gespoolt, gerippt und gedruckt' },
      { name: 'hold', mode: 'hold', info: 'Warteschlange „Angehalten" – Job bleibt bis zur Freigabe liegen' },
      { name: 'direct', mode: 'direct', info: 'Direktverbindung – kein Spoolen, Job wird nicht gespeichert' },
    ],
    stages: { spool: 'Spoolen', rip: 'RIPpen', wait: 'Wartet auf Papier', print: 'Drucken', done: 'Gedruckt', held: 'Angehalten' },
    mismatchPolicy: 'hold',
    conflictPolicy: 'hold',
    ripMsPerPage: 350,
    ripBaseMs: 1500,
    cutColors: [],
    features: ['fiery-api', 'jmf', 'hotfolder', 'virtual-printers', 'impose'],
    ippInfo: 'Fiery Virtual Printer',
    mismatchText: 'Papier stimmt nicht überein – Job angehalten (Fiery: „Fehlendes Papier")',
  },
  prismasync: {
    label: 'Canon PRISMAsync',
    queues: [
      { name: 'print', mode: 'print', info: 'Geplante Aufträge' },
      { name: 'hold', mode: 'hold', info: 'Wartende Aufträge' },
      { name: 'docbox', mode: 'hold', info: 'DocBox (gespeicherte Aufträge)' },
    ],
    stages: { spool: 'Empfangen', rip: 'Verarbeiten', wait: 'Material erforderlich', print: 'Drucken', done: 'Gedruckt', held: 'Wartende Aufträge' },
    mismatchPolicy: 'wait',
    conflictPolicy: 'hold',
    ripMsPerPage: 200,
    ripBaseMs: 1000,
    cutColors: [],
    features: ['jmf', 'hotfolder', 'automated-workflows'],
    ippInfo: 'PRISMAsync Print Server',
    mismatchText: 'Material nicht im Gerät – Auftrag bleibt in „Geplante Aufträge" und läuft weiter, sobald das Material eingelegt ist',
  },
  ffps: {
    label: 'Xerox FreeFlow Print Server',
    queues: [
      { name: 'DefaultQueue', mode: 'print', info: 'Standard-Warteschlange (Freigeben)' },
      { name: 'HoldQueue', mode: 'hold', info: 'Warteschlange mit Job-Halt' },
    ],
    stages: { spool: 'Empfang', rip: 'Verarbeitung', wait: 'Fehlende Ressourcen', print: 'Drucken', done: 'Abgeschlossen', held: 'Angehalten' },
    mismatchPolicy: 'hold',
    conflictPolicy: 'hold',
    ripMsPerPage: 300,
    ripBaseMs: 1500,
    cutColors: [],
    features: ['jmf', 'hotfolder'],
    ippInfo: 'FreeFlow Print Server',
    mismatchText: 'Fehlendes Material („Paper mismatch") – Job angehalten',
  },
  publisher: {
    label: 'Canon ClearConnect / Publisher',
    queues: [
      { name: 'print', mode: 'print', info: 'Direkt drucken' },
      { name: 'SmartInbox', mode: 'hold', info: 'Smart Inbox – Job wartet am Gerät auf Abruf' },
    ],
    stages: { spool: 'Empfangen', rip: 'Verarbeitung', wait: 'Rolle erforderlich', print: 'Drucken', done: 'Gedruckt', held: 'Smart Inbox' },
    mismatchPolicy: 'wait',
    conflictPolicy: 'ignore',
    ripMsPerPage: 600,
    ripBaseMs: 800,
    cutColors: [],
    features: ['hotfolder', 'hpgl', 'auto-roll'],
    ippInfo: 'ClearConnect',
    mismatchText: 'Keine passende Rolle – Job wartet, bis eine passende Rolle geladen ist',
  },
  edgeprint: {
    label: 'Epson Edge Print',
    queues: [
      { name: 'print', mode: 'print', info: 'Druckwarteschlange' },
      { name: 'hold', mode: 'hold', info: 'Angehalten (Layout prüfen)' },
    ],
    stages: { spool: 'Empfangen', rip: 'RIP', wait: 'Medium prüfen', print: 'Drucken', done: 'Fertig', held: 'Angehalten' },
    mismatchPolicy: 'hold',
    conflictPolicy: 'ignore',
    ripMsPerPage: 2500,
    ripBaseMs: 2000,
    cutColors: [],
    features: ['hotfolder', 'nesting', 'tiling'],
    ippInfo: 'Epson Edge Print',
    mismatchText: 'Medienbreite/-typ passt nicht – Job angehalten',
  },
  driver: {
    label: 'Druckertreiber (ohne RIP)',
    queues: [{ name: 'print', mode: 'print', info: 'Direkt' }],
    stages: { spool: 'Empfangen', rip: 'Rastern', wait: 'Papier prüfen', print: 'Drucken', done: 'Fertig', held: 'Angehalten' },
    mismatchPolicy: 'hold',
    conflictPolicy: 'ignore',
    ripMsPerPage: 400,
    ripBaseMs: 300,
    cutColors: [],
    features: ['hpgl', 'auto-roll'],
    ippInfo: 'Epson',
    mismatchText: 'Papiereinstellung stimmt nicht überein – Bedienfeld meldet Fehler',
  },
  ordercontroller: {
    label: 'Epson Order Controller',
    queues: [{ name: 'print', mode: 'print', info: 'Druckaufträge' }, { name: 'hold', mode: 'hold', info: 'Angehalten' }],
    stages: { spool: 'Auftrag empfangen', rip: 'Bildverarbeitung', wait: 'Papierrolle wechseln', print: 'Drucken', done: 'Fertig', held: 'Angehalten' },
    mismatchPolicy: 'wait',
    conflictPolicy: 'ignore',
    ripMsPerPage: 250,
    ripBaseMs: 500,
    cutColors: [],
    features: ['hotfolder', 'photo'],
    ippInfo: 'SureLab',
    mismatchText: 'Papierbreite passt nicht zur Printgröße – Rollenwechsel erforderlich',
  },
  versaworks: {
    label: 'Roland VersaWorks',
    queues: [
      { name: 'QueueA', mode: 'print', info: 'Warteschlange A (sofort drucken)' },
      { name: 'QueueB', mode: 'hold', info: 'Warteschlange B (halten)' },
    ],
    stages: { spool: 'Job empfangen', rip: 'RIP-Verarbeitung', wait: 'Medium prüfen', print: 'Drucken & Schneiden', done: 'Fertig', held: 'Angehalten' },
    mismatchPolicy: 'hold',
    conflictPolicy: 'ignore',
    ripMsPerPage: 1500,
    ripBaseMs: 1500,
    cutColors: ['CutContour', 'PerfCutContour'],
    features: ['hotfolder', 'nesting', 'contour-cut'],
    ippInfo: 'VersaWorks',
    mismatchText: 'Medienbreite zu klein für den Job – Job angehalten',
  },
};

function frontendOf(device) {
  return FRONTENDS[device.frontend?.type] || FRONTENDS.driver;
}

/** Alle Warteschlangen/Presets eines Geräts (Front-End-Standard + gerätespezifische Presets). */
function queuesOf(device) {
  const fe = frontendOf(device);
  const out = fe.queues.map((q) => ({ ...q, ticket: {}, builtin: true }));
  for (const p of device.presets || []) {
    const existing = out.find((q) => q.name.toLowerCase() === p.name.toLowerCase());
    if (existing) { existing.ticket = p.ticket || {}; if (p.mode) existing.mode = p.mode; }
    else out.push({ name: p.name, mode: p.mode || 'print', info: 'Preset / virtueller Drucker', ticket: p.ticket || {}, builtin: false });
  }
  return out;
}

const MODULE_DE = { stapler: 'Hefter', puncher: 'Locher', booklet: 'Broschürenmodul', folder: 'Falzeinheit', stacker: 'Hochstapler/Ablage', cutter: 'Querschneider', wfFolder: 'Online-Faltmaschine', takeUp: 'Aufwickler', contourCutter: 'Konturschneider', backprint: 'Rückseitendruck', sorter: 'Sortierer' };

/** Nur die als „installiert" konfigurierten Finisher-Module (Installierbare Optionen am Druckserver). */
function installedModules(cfg) {
  const out = {};
  for (const [k, v] of Object.entries(cfg.finisher?.modules || {})) if (v && v.installed !== false) out[k] = v;
  return out;
}

module.exports = { FRONTENDS, frontendOf, queuesOf, installedModules, MODULE_DE };
