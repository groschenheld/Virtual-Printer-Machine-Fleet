'use strict';
// Normalisiertes Job-Ticket + Zuordnung aus PJL / IPP / JDF / Presets – jede Einstellung
// wird mit ihrer Quelle protokolliert.
const { $t, $tp, $lazy } = require('../i18n.js');

const { setPath, getPath, clone } = require('../util/misc');

const SIZES = {
  A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297], A5: [148, 210], A6: [105, 148],
  SRA3: [320, 450], SRA4: [225, 320], B3: [353, 500], B4: [250, 353], B5: [176, 250], 'B4-JIS': [257, 364],
  LETTER: [215.9, 279.4], LEGAL: [215.9, 355.6], TABLOID: [279.4, 431.8], LEDGER: [279.4, 431.8], '12X18': [304.8, 457.2], '13X19': [330.2, 482.6],
  '9X13': [89, 127], '10X15': [102, 152], '13X18': [127, 178], '15X20': [152, 203], '15X21': [152, 210], '20X25': [203, 254], '20X30': [203, 305], '21X30': [210, 297],
  'ARCH-D': [609.6, 914.4], 'ARCH-E': [914.4, 1219.2], 'ANSI-D': [558.8, 863.6], 'ANSI-E': [863.6, 1117.6],
};

function sizeFromName(name) {
  if (!name) return null;
  const up = String(name).toUpperCase().replace(/\s+/g, '');
  if (SIZES[up]) return SIZES[up].slice();
  // PWG-Selbstbeschreibung: iso_a4_210x297mm, na_letter_8.5x11in, custom_100x200mm, roll_max_914x50000mm
  const m = /_([\d.]+)x([\d.]+)(mm|in)$/i.exec(name);
  if (m) {
    const f = m[3].toLowerCase() === 'in' ? 25.4 : 1;
    return [parseFloat(m[1]) * f, parseFloat(m[2]) * f];
  }
  const m2 = /^ISO[_-]?(A\d|B\d|SRA\d)/i.exec(name);
  if (m2 && SIZES[m2[1].toUpperCase()]) return SIZES[m2[1].toUpperCase()].slice();
  return null;
}

function nameFromSize(wMm, hMm, tol = 2) {
  const a = Math.min(wMm, hMm), b = Math.max(wMm, hMm);
  for (const [n, [w, h]] of Object.entries(SIZES)) if (Math.abs(w - a) <= tol && Math.abs(h - b) <= tol) return n;
  return null;
}

function pwgName(wMm, hMm) {
  const n = nameFromSize(wMm, hMm, 1);
  const a = Math.round(Math.min(wMm, hMm) * 10) / 10, b = Math.round(Math.max(wMm, hMm) * 10) / 10;
  if (n && /^A\d$/.test(n)) return `iso_${n.toLowerCase()}_${a}x${b}mm`;
  if (n === 'SRA3') return `iso_sra3_${a}x${b}mm`;
  if (n === 'B3' || n === 'B4' || n === 'B5') return `iso_${n.toLowerCase()}_${a}x${b}mm`;
  if (n === 'LETTER') return 'na_letter_8.5x11in';
  if (n === 'LEGAL') return 'na_legal_8.5x14in';
  return `custom_${a}x${b}_${a}x${b}mm`; // PWG verlangt Klasse_Name_Maß
}

function baseTicket() {
  return {
    jobName: null,
    copies: 1,
    collate: true,
    sides: 'one-sided',
    colorMode: 'auto',
    media: { mediaId: null, sizeMm: null, sizeName: null, type: null, gsm: null, source: null },
    imposition: 'none',
    numberUp: 1,
    stepRepeat: { gapMm: 0, bleedMm: 3, marks: true },
    booklet: { creepMm: 0 },
    scaling: 'auto',
    orientation: 'auto',
    pageRanges: null,
    finishing: { staple: null, punch: null, fold: null, booklet: null, trimMm: null },
    outputBin: null,
    marks: { crop: false, slug: false },
    roll: { cut: 'auto', nesting: null, rotate: 'auto', tiling: false, overlapMm: 10, borderless: false, addMargins: false, takeUp: false },
    photo: { printSizeMm: null, fit: 'fill', backprint: null },
    cut: { mode: 'contour', marks: true, sheetCut: true, perf: true },
    hold: false,
    queue: null,
    priority: 50,
    unknown: [],
  };
}

/** Setzt einen Ticketwert inkl. Quellenvermerk und Logeintrag. */
function setTicket(job, path, value, source, quiet = false) {
  const old = getPath(job.ticket, path);
  setPath(job.ticket, path, value);
  job.ticketSources[path] = source;
  if (!quiet) {
    const changed = JSON.stringify(old) !== JSON.stringify(value);
    job.addLog('TICKET', `${path} = ${JSON.stringify(value)}   ⟵ ${source}${changed && old != null && old !== '' ? $t(`  (vorher ${JSON.stringify(old)})`, `  (before ${JSON.stringify(old)})`) : ''}`);
  }
}

/** Objekt (z. B. Preset-Ticket) rekursiv übernehmen. */
function applyObject(job, obj, source, prefix = '') {
  if (!obj) return;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) applyObject(job, v, source, p);
    else setTicket(job, p, clone(v), source);
  }
}

function noteUnknown(job, key, value, source, hint) {
  job.ticket.unknown.push({ key, value, source });
  job.warn('TICKET', $t(`Nicht ausgewertete Einstellung ${key}=${JSON.stringify(value)} aus ${source}`, `Unevaluated setting ${key}=${JSON.stringify(value)} from ${source}`) + (hint ? ` – ${hint}` : $t(' – ein echtes Gerät würde sie ggf. ignorieren oder herstellerspezifisch auswerten', ' – a real device might ignore it or evaluate it vendor-specifically')));
}

// ---------------------------------------------------------------------------- PJL
const PJL_SOURCE = { TRAY1: 'tray-1', TRAY2: 'tray-2', TRAY3: 'tray-3', TRAY4: 'tray-4', TRAY5: 'tray-5', MANUALFEED: 'manual', MPTRAY: 'manual', BYPASS: 'manual', LCT: 'large-capacity', ROLL1: 'main-roll', ROLL2: 'alternate-roll', ROLL3: 'roll-3', ROLL4: 'roll-4', ROLL: 'main-roll' };
const PJL_STAPLE = { LEFTTOP: 'top-left', TOPLEFT: 'top-left', RIGHTTOP: 'top-right', TOPRIGHT: 'top-right', LEFTBOTTOM: 'bottom-left', RIGHTBOTTOM: 'bottom-right', LEFTDUAL: 'dual-left', DUALLEFT: 'dual-left', LEFT2: 'dual-left', TOPDUAL: 'dual-top', TOP2: 'dual-top', SADDLE: 'saddle', CENTER: 'saddle' };

function applyPjl(job, pjl) {
  const src = 'PJL';
  const { set, job: pjob, comments } = pjl;
  if (pjob.NAME) setTicket(job, 'jobName', pjob.NAME, 'PJL JOB NAME');
  if (comments.length) job.addLog('TICKET', $t(`PJL-Kommentare: ${comments.join(' | ')}`, `PJL comments: ${comments.join(' | ')}`));
  for (const [k, v] of Object.entries(set)) {
    const V = v.toUpperCase();
    switch (k) {
      case 'COPIES': case 'QTY': setTicket(job, 'copies', Math.max(1, parseInt(v, 10) || 1), `${src} SET ${k}`); break;
      case 'DUPLEX': if (V === 'ON') { if (job.ticket.sides === 'one-sided') setTicket(job, 'sides', 'two-sided-long-edge', `${src} SET DUPLEX`); } else setTicket(job, 'sides', 'one-sided', `${src} SET DUPLEX`); break;
      case 'BINDING': if (job.ticket.sides !== 'one-sided' || set.DUPLEX === 'ON') setTicket(job, 'sides', V.startsWith('SHORT') ? 'two-sided-short-edge' : 'two-sided-long-edge', `${src} SET BINDING`); break;
      case 'PAPER': case 'PAPERSIZE': {
        const s = sizeFromName(v);
        if (s) { setTicket(job, 'media.sizeMm', s, `${src} SET ${k}`); setTicket(job, 'media.sizeName', V, `${src} SET ${k}`); }
        else noteUnknown(job, k, v, src, $t('Formatname unbekannt', 'size name unknown'));
        break;
      }
      case 'MEDIASOURCE': case 'TRAY': setTicket(job, 'media.source', PJL_SOURCE[V] || v.toLowerCase(), `${src} SET ${k}`); break;
      case 'MEDIATYPE': setTicket(job, 'media.type', v.toLowerCase(), `${src} SET MEDIATYPE`); break;
      case 'RENDERMODE': case 'COLORMODE': case 'PLANESINUSE': setTicket(job, 'colorMode', /GRAY|MONO|BW|^1$/.test(V) ? 'monochrome' : 'color', `${src} SET ${k}`); break;
      case 'ORIENTATION': setTicket(job, 'orientation', V === 'LANDSCAPE' ? 'landscape' : 'portrait', `${src} SET ORIENTATION`); break;
      case 'STAPLE': case 'STAPLEOPTION': case 'STAPLING':
        if (V !== 'OFF' && V !== 'NONE') setTicket(job, 'finishing.staple', PJL_STAPLE[V] || 'top-left', `${src} SET ${k}`);
        break;
      case 'PUNCH': case 'PUNCHHOLES': case 'HOLEPUNCH':
        if (V !== 'OFF' && V !== 'NONE') setTicket(job, 'finishing.punch', { holes: /4|FOUR/.test(V) ? 4 : /3|THREE/.test(V) ? 3 : 2, edge: 'left' }, `${src} SET ${k}`);
        break;
      case 'FOLD': case 'FOLDING': if (V !== 'OFF' && V !== 'NONE') setTicket(job, 'finishing.fold', V.toLowerCase().replace(/fold$/, '').replace('_', '-') || 'half', `${src} SET ${k}`); break;
      case 'BOOKLET': if (V === 'ON') { setTicket(job, 'imposition', 'booklet', `${src} SET BOOKLET`); setTicket(job, 'finishing.booklet', { saddle: true }, `${src} SET BOOKLET`); } break;
      case 'OUTBIN': case 'OUTPUTBIN': setTicket(job, 'outputBin', v.toLowerCase(), `${src} SET ${k}`); break;
      case 'HOLD': if (V === 'ON' || V === 'STORE' || V === 'PROOF') setTicket(job, 'hold', true, `${src} SET HOLD`); break;
      case 'JOBNAME': setTicket(job, 'jobName', v, `${src} SET JOBNAME`); break;
      case 'USERNAME': job.user = v; job.addLog('TICKET', $t(`Benutzer = ${v}  ⟵ PJL SET USERNAME`, `User = ${v}  ⟵ PJL SET USERNAME`)); break;
      case 'RESOLUTION': case 'ECONOMODE': case 'LPARM:PCL': case 'TIMEOUT': case 'JOBATTR':
        job.addLog('TICKET', $t(`PJL ${k}=${v} gelesen (für die Simulation ohne Wirkung)`, `PJL ${k}=${v} read (no effect in the simulation)`)); break;
      default: noteUnknown(job, `PJL ${k}`, v, src);
    }
  }
}

// ---------------------------------------------------------------------------- IPP finishings (PWG 5100.1)
const IPP_FINISHINGS = {
  3: 'none', 4: 'staple', 5: 'punch', 6: 'cover', 7: 'bind', 8: 'saddle-stitch', 9: 'edge-stitch', 10: 'fold', 11: 'trim', 12: 'bale', 13: 'booklet-maker', 14: 'jog-offset', 15: 'coat', 16: 'laminate',
  20: 'staple-top-left', 21: 'staple-bottom-left', 22: 'staple-top-right', 23: 'staple-bottom-right', 24: 'edge-stitch-left', 25: 'edge-stitch-top', 26: 'edge-stitch-right', 27: 'edge-stitch-bottom',
  28: 'staple-dual-left', 29: 'staple-dual-top', 30: 'staple-dual-right', 31: 'staple-dual-bottom', 32: 'staple-triple-left', 33: 'staple-triple-top', 34: 'staple-triple-right', 35: 'staple-triple-bottom',
  50: 'bind-left', 51: 'bind-top', 52: 'bind-right', 53: 'bind-bottom', 60: 'trim-after-pages', 61: 'trim-after-documents', 62: 'trim-after-copies', 63: 'trim-after-job',
  70: 'punch-top-left', 71: 'punch-bottom-left', 72: 'punch-top-right', 73: 'punch-bottom-right', 74: 'punch-dual-left', 75: 'punch-dual-top', 76: 'punch-dual-right', 77: 'punch-dual-bottom',
  78: 'punch-triple-left', 79: 'punch-triple-top', 80: 'punch-triple-right', 81: 'punch-triple-bottom', 82: 'punch-quad-left', 83: 'punch-quad-top', 84: 'punch-quad-right', 85: 'punch-quad-bottom',
  90: 'fold-accordion', 91: 'fold-double-gate', 92: 'fold-gate', 93: 'fold-half', 94: 'fold-half-z', 95: 'fold-left-gate', 96: 'fold-letter', 97: 'fold-parallel', 98: 'fold-poster', 99: 'fold-right-gate', 100: 'fold-z', 101: 'fold-engineering-z',
};
const IPP_FINISHINGS_REV = Object.fromEntries(Object.entries(IPP_FINISHINGS).map(([k, v]) => [v, Number(k)]));

/** Wendet einen IPP-finishings-Keyword auf das Ticket an. Rückgabe false = nicht unterstützt. */
function applyFinishingKeyword(job, kw, source) {
  let m;
  if (kw === 'none') return true;
  if (kw === 'staple') { setTicket(job, 'finishing.staple', 'top-left', source); return true; }
  if ((m = /^staple-(top-left|top-right|bottom-left|bottom-right|dual-left|dual-top|dual-right|dual-bottom)$/.exec(kw))) { setTicket(job, 'finishing.staple', m[1], source); return true; }
  if (kw === 'saddle-stitch' || kw === 'booklet-maker') {
    setTicket(job, 'imposition', 'booklet', source);
    setTicket(job, 'finishing.booklet', { saddle: true }, source);
    return true;
  }
  if (kw === 'punch') { setTicket(job, 'finishing.punch', { holes: 2, edge: 'left' }, source); return true; }
  if ((m = /^punch-(dual|triple|quad)-(left|top|right|bottom)$/.exec(kw))) {
    setTicket(job, 'finishing.punch', { holes: { dual: 2, triple: 3, quad: 4 }[m[1]], edge: m[2] }, source); return true;
  }
  if (kw === 'fold') { setTicket(job, 'finishing.fold', 'half', source); return true; }
  if ((m = /^fold-(half|letter|z|engineering-z|accordion|half-z|gate|double-gate|parallel|poster|left-gate|right-gate)$/.exec(kw))) {
    setTicket(job, 'finishing.fold', m[1], source); return true;
  }
  if (kw === 'trim' || kw.startsWith('trim-after')) { setTicket(job, 'finishing.trimMm', 3, source); return true; }
  if (kw === 'jog-offset') { job.addLog('TICKET', $t(`Versatzablage (jog-offset) ⟵ ${source}`, `Offset stacking (jog-offset) ⟵ ${source}`)); return true; }
  return false;
}

module.exports = { SIZES, sizeFromName, nameFromSize, pwgName, baseTicket, setTicket, applyObject, noteUnknown, applyPjl, IPP_FINISHINGS, IPP_FINISHINGS_REV, applyFinishingKeyword };
