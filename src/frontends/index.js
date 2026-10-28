'use strict';
// Front-End-Persönlichkeiten: Verhalten, Begriffe, Warteschlangen und Standard-Regeln
// so, wie sie sich gegenüber einer Druck-App und im Protokoll bemerkbar machen.
const { $t, $tp, $lazy } = require('../i18n.js');

const FRONTENDS = $lazy({
  fiery: {
    label: 'EFI Fiery', station: 'server',
    queues: [
      { name: 'print', mode: 'print', info: $tp('Druckwarteschlange – wird gespoolt, gerippt und gedruckt', 'Print queue – spooled, RIPped and printed') },
      { name: 'hold', mode: 'hold', info: $tp('Warteschlange „Angehalten" – Job bleibt bis zur Freigabe liegen', '“Hold” queue – job stays until released') },
      { name: 'direct', mode: 'direct', info: $tp('Direktverbindung – kein Spoolen, Job wird nicht gespeichert', 'Direct connection – no spooling, job is not stored') },
    ],
    stages: { spool: $tp('Spoolen', 'Spooling'), rip: $tp('RIPpen', 'RIPping'), wait: $tp('Wartet auf Papier', 'Waiting for paper'), print: $tp('Drucken', 'Printing'), done: $tp('Gedruckt', 'Printed'), held: $tp('Angehalten', 'Held') },
    mismatchPolicy: 'hold',
    conflictPolicy: 'hold',
    ripMsPerPage: 350,
    ripBaseMs: 1500,
    cutColors: [],
    features: ['fiery-api', 'jmf', 'hotfolder', 'virtual-printers', 'impose'],
    ippInfo: 'Fiery Virtual Printer',
    mismatchText: $tp('Papier stimmt nicht überein – Job angehalten (Fiery: „Fehlendes Papier")', 'Paper mismatch – job held (Fiery: “Missing paper”)'),
  },
  prismasync: {
    label: 'Canon PRISMAsync', station: 'server',
    queues: [
      { name: 'print', mode: 'print', info: $tp('Geplante Aufträge', 'Scheduled jobs') },
      { name: 'hold', mode: 'hold', info: $tp('Wartende Aufträge', 'Waiting jobs') },
      { name: 'docbox', mode: 'hold', info: $tp('DocBox (gespeicherte Aufträge)', 'DocBox (stored jobs)') },
    ],
    stages: { spool: $tp('Empfangen', 'Received'), rip: $tp('Verarbeiten', 'Processing'), wait: $tp('Material erforderlich', 'Media required'), print: $tp('Drucken', 'Printing'), done: $tp('Gedruckt', 'Printed'), held: $tp('Wartende Aufträge', 'Waiting jobs') },
    mismatchPolicy: 'wait',
    conflictPolicy: 'hold',
    ripMsPerPage: 200,
    ripBaseMs: 1000,
    cutColors: [],
    features: ['jmf', 'hotfolder', 'automated-workflows'],
    ippInfo: 'PRISMAsync Print Server',
    mismatchText: $tp('Material nicht im Gerät – Auftrag bleibt in „Geplante Aufträge" und läuft weiter, sobald das Material eingelegt ist', 'Media not in the device – job stays in “Scheduled jobs” and continues as soon as the media is loaded'),
  },
  ffps: {
    label: 'Xerox FreeFlow Print Server', station: 'server',
    queues: [
      { name: 'DefaultQueue', mode: 'print', info: $tp('Standard-Warteschlange (Freigeben)', 'Default queue (release)') },
      { name: 'HoldQueue', mode: 'hold', info: $tp('Warteschlange mit Job-Halt', 'Queue with job hold') },
    ],
    stages: { spool: $tp('Empfang', 'Receiving'), rip: $tp('Verarbeitung', 'Processing'), wait: $tp('Fehlende Ressourcen', 'Missing resources'), print: $tp('Drucken', 'Printing'), done: $tp('Abgeschlossen', 'Completed'), held: $tp('Angehalten', 'Held') },
    mismatchPolicy: 'hold',
    conflictPolicy: 'hold',
    ripMsPerPage: 300,
    ripBaseMs: 1500,
    cutColors: [],
    features: ['jmf', 'hotfolder'],
    ippInfo: 'FreeFlow Print Server',
    mismatchText: $tp('Fehlendes Material („Paper mismatch") – Job angehalten', 'Missing media (“Paper mismatch”) – job held'),
  },
  publisher: {
    label: 'colorWAVE-Controller', station: 'embedded',
    queues: [
      { name: 'print', mode: 'print', info: $tp('Direkt drucken', 'Print direct') },
      { name: 'SmartInbox', mode: 'hold', info: $tp('Smart Inbox – Job wartet am Gerät auf Abruf', 'Smart Inbox – job waits at the device to be recalled') },
    ],
    stages: { spool: $tp('Empfangen', 'Received'), rip: $tp('Verarbeitung', 'Processing'), wait: $tp('Rolle erforderlich', 'Roll required'), print: $tp('Drucken', 'Printing'), done: $tp('Gedruckt', 'Printed'), held: 'Smart Inbox' },
    mismatchPolicy: 'wait',
    conflictPolicy: 'ignore',
    ripMsPerPage: 600,
    ripBaseMs: 800,
    cutColors: [],
    features: ['hotfolder', 'hpgl', 'auto-roll'],
    ippInfo: 'ClearConnect',
    mismatchText: $tp('Keine passende Rolle – Job wartet, bis eine passende Rolle geladen ist', 'No matching roll – job waits until a matching roll is loaded'),
  },
  edgeprint: {
    label: 'Epson Edge Print', station: 'software',
    queues: [
      { name: 'print', mode: 'print', info: $tp('Druckwarteschlange', 'Print queue') },
      { name: 'hold', mode: 'hold', info: $tp('Angehalten (Layout prüfen)', 'Held (check layout)') },
    ],
    stages: { spool: $tp('Empfangen', 'Received'), rip: 'RIP', wait: $tp('Medium prüfen', 'Checking media'), print: $tp('Drucken', 'Printing'), done: $tp('Fertig', 'Done'), held: $tp('Angehalten', 'Held') },
    mismatchPolicy: 'hold',
    conflictPolicy: 'ignore',
    ripMsPerPage: 2500,
    ripBaseMs: 2000,
    cutColors: [],
    features: ['hotfolder', 'nesting', 'tiling'],
    ippInfo: 'Epson Edge Print',
    mismatchText: $tp('Medienbreite/-typ passt nicht – Job angehalten', 'Media width/type does not match – job held'),
  },
  driver: {
    label: $tp('Direkt (Web Config)', 'Direct (Web Config)'), station: 'embedded',
    queues: [{ name: 'print', mode: 'print', info: $tp('Direkt', 'Direct') }],
    stages: { spool: $tp('Empfangen', 'Received'), rip: $tp('Rastern', 'Rasterizing'), wait: $tp('Papier prüfen', 'Checking paper'), print: $tp('Drucken', 'Printing'), done: $tp('Fertig', 'Done'), held: $tp('Angehalten', 'Held') },
    mismatchPolicy: 'hold',
    conflictPolicy: 'ignore',
    ripMsPerPage: 400,
    ripBaseMs: 300,
    cutColors: [],
    features: ['hpgl', 'auto-roll'],
    ippInfo: 'Epson Web Config',
    mismatchText: $tp('Papiereinstellung stimmt nicht überein – Bedienfeld meldet Fehler', 'Paper setting does not match – control panel reports an error'),
  },
  ordercontroller: {
    label: 'Epson Order Controller', station: 'software',
    queues: [{ name: 'print', mode: 'print', info: $tp('Druckaufträge', 'Print jobs') }, { name: 'hold', mode: 'hold', info: $tp('Angehalten', 'Held') }],
    stages: { spool: $tp('Auftrag empfangen', 'Job received'), rip: $tp('Bildverarbeitung', 'Image processing'), wait: $tp('Papierrolle wechseln', 'Change paper roll'), print: $tp('Drucken', 'Printing'), done: $tp('Fertig', 'Done'), held: $tp('Angehalten', 'Held') },
    mismatchPolicy: 'wait',
    conflictPolicy: 'ignore',
    ripMsPerPage: 250,
    ripBaseMs: 500,
    cutColors: [],
    features: ['hotfolder', 'photo'],
    ippInfo: 'SureLab',
    mismatchText: $tp('Papierbreite passt nicht zur Printgröße – Rollenwechsel erforderlich', 'Paper width does not match the print size – roll change required'),
  },
  versaworks: {
    label: 'Roland VersaWorks', station: 'software',
    queues: [
      { name: 'QueueA', mode: 'print', info: $tp('Warteschlange A (sofort drucken)', 'Queue A (print immediately)') },
      { name: 'QueueB', mode: 'hold', info: $tp('Warteschlange B (halten)', 'Queue B (hold)') },
    ],
    stages: { spool: $tp('Job empfangen', 'Job received'), rip: $tp('RIP-Verarbeitung', 'RIP processing'), wait: $tp('Medium prüfen', 'Checking media'), print: $tp('Drucken & Schneiden', 'Print & cut'), done: $tp('Fertig', 'Done'), held: $tp('Angehalten', 'Held') },
    mismatchPolicy: 'hold',
    conflictPolicy: 'ignore',
    ripMsPerPage: 1500,
    ripBaseMs: 1500,
    cutColors: ['CutContour', 'PerfCutContour'],
    features: ['hotfolder', 'nesting', 'contour-cut'],
    ippInfo: 'VersaWorks',
    mismatchText: $tp('Medienbreite zu klein für den Job – Job angehalten', 'Media width too small for the job – job held'),
  },
});

const STATION_DE = $lazy({ server: $tp('Druckserver', 'Print server'), embedded: $tp('Integrierter Controller', 'Embedded controller'), software: $tp('Software-RIP am PC', 'Software RIP on a PC') });
const PRODUCTS = $lazy({
  publisher: $tp('Integrierter Controller (ClearConnect-Bedienfeld, WebTools Express)', 'Embedded controller (ClearConnect panel, WebTools Express)'),
  driver: $tp('Integrierte Netzwerkschnittstelle (Epson Web Config) – ohne RIP', 'Embedded network interface (Epson Web Config) – no RIP'),
  edgeprint: $tp('Epson Edge Print (Software-RIP auf einem PC vor dem Drucker)', 'Epson Edge Print (software RIP on a PC in front of the printer)'),
  ordercontroller: $tp('Epson Order Controller (Software auf dem angeschlossenen PC)', 'Epson Order Controller (software on the connected PC)'),
  versaworks: $tp('Roland VersaWorks 6 (Software-RIP auf einem PC)', 'Roland VersaWorks 6 (software RIP on a PC)'),
});
/** Welche Betriebsarten ein Gerät haben kann (z. B. Epson-Plotter direkt oder mit Edge Print). */
function frontendChoices(cfg) {
  if (cfg.vendor === 'Epson' && cfg.kind === 'wide') return ['driver', 'edgeprint'];
  return [cfg.frontend?.type].filter(Boolean);
}

function frontendOf(device) {
  return FRONTENDS[device.frontend?.type] || FRONTENDS.driver;
}

/** Alle Warteschlangen/Presets eines Geräts (Front-End-Standard + gerätespezifische Presets). */
function queuesOf(device) {
  const fe = frontendOf(device);
  const out = fe.queues.map((q) => ({ ...q, ticket: {}, builtin: true }));
  for (const p of device.presets || []) {
    if (p.frontend && p.frontend !== device.frontend?.type) continue; // Preset gehört zu einer anderen Betriebsart (z. B. RIP)
    const existing = out.find((q) => q.name.toLowerCase() === p.name.toLowerCase());
    if (existing) { existing.ticket = p.ticket || {}; if (p.mode) existing.mode = p.mode; }
    else out.push({ name: p.name, mode: p.mode || 'print', info: $t('Preset / virtueller Drucker', 'Preset / virtual printer'), ticket: p.ticket || {}, builtin: false });
  }
  return out;
}

const MODULE_DE = $lazy({ stapler: $tp('Hefter', 'Stapler'), puncher: $tp('Locher', 'Puncher'), booklet: $tp('Broschürenmodul', 'Booklet maker'), folder: $tp('Falzeinheit', 'Folding unit'), stacker: $tp('Hochstapler/Ablage', 'High-capacity stacker'), cutter: $tp('Querschneider', 'Cross cutter'), wfFolder: $tp('Online-Faltmaschine', 'Online folder'), takeUp: $tp('Aufwickler', 'Take-up reel'), contourCutter: $tp('Konturschneider', 'Contour cutter'), backprint: $tp('Rückseitendruck', 'Back printing'), sorter: $tp('Sortierer', 'Sorter') });

/** Nur die als „installiert" konfigurierten Finisher-Module (Installierbare Optionen am Druckserver). */
function installedModules(cfg) {
  const out = {};
  for (const [k, v] of Object.entries(cfg.finisher?.modules || {})) if (v && v.installed !== false) out[k] = v;
  return out;
}

module.exports = { FRONTENDS, frontendOf, queuesOf, installedModules, MODULE_DE, STATION_DE, PRODUCTS, frontendChoices };
