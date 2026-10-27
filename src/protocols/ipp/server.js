'use strict';
// IPP-Server je Gerät (http://host:port/ipp/print[/<warteschlange>]).
const crypto = require('crypto');
const { decode, encode, attrsOf, v, OP, STATUS, describe, describeResponse } = require('./codec');
const { setTicket, noteUnknown, sizeFromName, pwgName, IPP_FINISHINGS, IPP_FINISHINGS_REV, applyFinishingKeyword } = require('../../pipeline/ticket');
const { frontendOf } = require('../../frontends');
const { r1 } = require('../../util/misc');

const OPS_SUPPORTED = [0x0002, 0x0004, 0x0005, 0x0006, 0x0008, 0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x000e, 0x0010, 0x0011, 0x003b, 0x003c];
const FORMATS = ['application/pdf', 'application/postscript', 'image/jpeg', 'image/png', 'image/pwg-raster', 'application/vnd.hp-HPGL', 'application/octet-stream'];

function uuidFor(id) {
  const h = crypto.createHash('sha1').update('vpf-' + id).digest('hex');
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function mediaCol(m, slot, device) {
  const margins = device.marginsMm || {};
  const hm = (mm) => v.int(Math.round(mm * 100));
  const size = m.kind === 'roll'
    ? { 'x-dimension': hm(m.widthMm), 'y-dimension': v.range(Math.round((device.roll?.minLengthMm || 100) * 100), Math.round(Math.min(device.roll?.maxLengthMm || 50000, m.lengthM * 1000) * 100)) }
    : { 'x-dimension': hm(Math.min(m.widthMm, m.heightMm)), 'y-dimension': hm(Math.max(m.widthMm, m.heightMm)) };
  const col = {
    'media-key': v.kw(m.id),
    'media-size': v.col(size),
    'media-size-name': v.kw(m.kind === 'roll' ? `roll_current_${m.widthMm}x${Math.round(m.lengthM * 1000)}mm` : pwgName(m.widthMm, m.heightMm)),
    'media-type': v.kw(m.ippType || 'stationery'),
    'media-color': v.kw('white'),
    'media-weight-metric': v.int(m.gsm),
    'media-info': v.text(m.name),
    'media-top-margin': hm(margins.top || 0), 'media-bottom-margin': hm(margins.bottom || 0), 'media-left-margin': hm(margins.left || 0), 'media-right-margin': hm(margins.right || 0),
  };
  if (slot) col['media-source'] = v.kw(slot.ippSource);
  return v.col(col);
}

function printerAttributes(fleet, dev, baseUri, queueName) {
  const c = dev.cfg;
  const st = dev.status;
  const fe = frontendOf(c);
  const loaded = c.slots.filter((s) => s.loaded).map((s) => ({ slot: s, m: fleet.catalog.get(s.loaded.mediaId) })).filter((x) => x.m);
  const catalogFit = Array.from(fleet.catalog.values()).filter((m) => m.kind === (c.kind === 'sheet' ? 'sheet' : 'roll') && (c.kind !== 'sheet' || !c.sheet || (Math.max(m.widthMm, m.heightMm) <= Math.max(...c.sheet.maxMm) + 0.5 && Math.min(m.widthMm, m.heightMm) <= Math.min(...c.sheet.maxMm) + 0.5)) && (c.kind === 'sheet' || !c.roll || (m.widthMm <= c.roll.maxWidthMm && m.widthMm >= c.roll.minWidthMm)));
  const mediaName = (m) => (m.kind === 'roll' ? `roll_current_${m.widthMm}x${Math.round(m.lengthM * 1000)}mm` : pwgName(m.widthMm, m.heightMm));
  const ready = loaded.map((x) => mediaName(x.m));
  const supported = new Set(catalogFit.filter((m) => m.kind === 'sheet').map((m) => pwgName(m.widthMm, m.heightMm)));
  if (c.kind === 'sheet' && c.sheet) {
    supported.add(`custom_min_${c.sheet.minMm[0]}x${c.sheet.minMm[1]}mm`);
    supported.add(`custom_max_${c.sheet.maxMm[0]}x${c.sheet.maxMm[1]}mm`);
  } else if (c.roll) {
    supported.add(`roll_min_${c.roll.minWidthMm}x${c.roll.minLengthMm || 100}mm`);
    supported.add(`roll_max_${c.roll.maxWidthMm}x${c.roll.maxLengthMm}mm`);
    for (const n of ['iso_a4_210x297mm', 'iso_a3_297x420mm', 'iso_a2_420x594mm', 'iso_a1_594x841mm', 'iso_a0_841x1189mm']) supported.add(n);
    if (c.kind === 'photo') for (const n of ['custom_102x152mm', 'custom_127x178mm', 'custom_152x203mm', 'custom_203x254mm', 'custom_203x305mm', 'iso_a4_210x297mm']) supported.add(n);
  }
  for (const r of ready) supported.add(r);
  const mods = c.finisher?.modules || {};
  const fins = [3];
  if (mods.stapler) { fins.push(4); for (const p of mods.stapler.positions || []) { const kw = 'staple-' + p; if (IPP_FINISHINGS_REV[kw]) fins.push(IPP_FINISHINGS_REV[kw]); } }
  if (mods.puncher) { fins.push(5); for (const h of mods.puncher.holes) fins.push({ 2: 74, 3: 78, 4: 82 }[h]); }
  if (mods.booklet) fins.push(8, 13);
  if (mods.booklet?.trim) fins.push(11);
  if (mods.folder) { fins.push(10); for (const t of mods.folder.types) { const k = IPP_FINISHINGS_REV['fold-' + t]; if (k) fins.push(k); } }
  if (mods.wfFolder) fins.push(10, 101);
  if (mods.cutter) fins.push(11);
  fins.sort((a, b) => a - b);
  const queues = dev.queues;
  const uris = [baseUri, ...queues.map((q) => `${baseUri}/${encodeURIComponent(q.name)}`)];
  const supplies = c.supplies || [];
  const kindMap = { sheet: ['document'], wide: ['document', 'large-format', 'roll'], photo: ['photo', 'roll'], printcut: ['large-format', 'roll', 'label'] };
  const attrs = {
    'charset-configured': v.charset('utf-8'), 'charset-supported': v.charset('utf-8'),
    'natural-language-configured': v.lang('de'), 'generated-natural-language-supported': [v.lang('de'), v.lang('en')],
    'ipp-versions-supported': [v.kw('1.1'), v.kw('2.0')],
    'ipp-features-supported': [v.kw('ipp-everywhere'), v.kw('job-save'), v.kw('page-overrides')].slice(0, 1),
    'operations-supported': OPS_SUPPORTED.map((o) => v.enum(o)),
    'printer-uri-supported': uris.map((u) => v.uri(u)),
    'uri-security-supported': uris.map(() => v.kw('none')),
    'uri-authentication-supported': uris.map(() => v.kw('none')),
    'printer-name': v.name(queueName ? `${c.id}-${queueName}` : c.id),
    'printer-info': v.text(`${c.name} – ${c.frontend.product}${queueName ? ' / ' + queueName : ''} (Simulation)`),
    'printer-location': v.text('Virtual Print Fleet'),
    'printer-make-and-model': v.text(`${c.vendor} ${c.model} (${fe.ippInfo})`),
    'printer-device-id': v.text(`MFG:${c.vendor};MDL:${c.model};CMD:PDF,PS,PWG,${c.kind === 'wide' ? 'HPGL2,' : ''}JPEG;CLS:PRINTER;DES:${c.name} (Simulation);`),
    'printer-uuid': v.uri(uuidFor(c.id)),
    'printer-more-info': v.uri(`${fleet.uiUrl || 'http://127.0.0.1:8650'}/#/device/${c.id}`),
    'printer-state': v.enum(st.ipp),
    'printer-state-reasons': st.reasons.map((r) => v.kw(r)),
    'printer-state-message': v.text(st.message),
    'printer-is-accepting-jobs': v.bool(st.accepting),
    'queued-job-count': v.int(fleet.jobsOf(c.id).filter((j) => !j.isFinal).length),
    'printer-up-time': v.int(Math.floor((Date.now() - dev.startedAt) / 1000) + 1),
    'printer-current-time': v.date(new Date()),
    'printer-kind': (kindMap[c.kind] || ['document']).map((k) => v.kw(k)),
    'pdl-override-supported': v.kw('attempted'),
    'compression-supported': [v.kw('none')],
    'document-format-default': v.mime('application/pdf'),
    'document-format-supported': FORMATS.map((f) => v.mime(f)),
    'multiple-document-jobs-supported': v.bool(true),
    'multiple-operation-time-out': v.int(120),
    'job-ids-supported': v.bool(true),
    'color-supported': v.bool(!!c.color),
    'print-color-mode-default': v.kw('auto'),
    'print-color-mode-supported': [v.kw('auto'), v.kw('color'), v.kw('monochrome')],
    'copies-default': v.int(1), 'copies-supported': v.range(1, 9999),
    'sides-default': v.kw('one-sided'),
    'sides-supported': (c.duplex ? ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'] : ['one-sided']).map((s) => v.kw(s)),
    'media-default': v.kw(ready[0] || Array.from(supported)[0] || 'iso_a4_210x297mm'),
    'media-ready': (ready.length ? ready : ['none']).map((x) => v.kw(x)),
    'media-supported': Array.from(supported).map((x) => v.kw(x)),
    'media-col-default': loaded[0] ? mediaCol(loaded[0].m, loaded[0].slot, c) : v.noValue(),
    'media-col-ready': loaded.length ? loaded.map((x) => mediaCol(x.m, x.slot, c)) : v.noValue(),
    'media-col-database': catalogFit.slice(0, 60).map((m) => mediaCol(m, null, c)),
    'media-col-supported': ['media-key', 'media-size', 'media-size-name', 'media-source', 'media-type', 'media-color', 'media-weight-metric', 'media-info', 'media-top-margin', 'media-bottom-margin', 'media-left-margin', 'media-right-margin'].map((x) => v.kw(x)),
    'media-source-supported': [v.kw('auto'), ...c.slots.map((s) => v.kw(s.ippSource))],
    'media-type-supported': Array.from(new Set(catalogFit.map((m) => m.ippType || 'stationery'))).map((x) => v.kw(x)),
    'media-top-margin-supported': v.int(Math.round((c.marginsMm.top || 0) * 100)),
    'media-bottom-margin-supported': v.int(Math.round((c.marginsMm.bottom || 0) * 100)),
    'media-left-margin-supported': v.int(Math.round((c.marginsMm.left || 0) * 100)),
    'media-right-margin-supported': v.int(Math.round((c.marginsMm.right || 0) * 100)),
    'printer-input-tray': c.slots.map((s) => v.octets(`type=${s.kind === 'roll' ? 'continuousRoll' : 'sheetFeedAutoRemovableTray'};mediafeed=0;mediaxfeed=0;maxcapacity=${s.capacity || -2};level=${s.kind === 'roll' ? (s.loaded ? Math.round(s.loaded.levelM ?? 0) : 0) : s.loaded ? s.loaded.level : 0};status=${s.loaded ? 0 : 19};name=${s.ippSource};`)),
    'finishings-default': v.enum(3),
    'finishings-supported': Array.from(new Set(fins)).map((f) => v.enum(f)),
    'finishings-col-supported': [v.kw('finishing-template')],
    'output-bin-default': v.kw((c.finisher?.bins || [{ id: 'face-down' }])[0].id),
    'output-bin-supported': (c.finisher?.bins || [{ id: 'face-down' }]).map((b) => v.kw(b.id)),
    'number-up-default': v.int(1), 'number-up-supported': c.kind === 'sheet' ? [1, 2, 4, 6, 8, 9, 16].map((n) => v.int(n)) : v.int(1),
    'page-ranges-supported': v.bool(true),
    'print-scaling-default': v.kw('auto'),
    'print-scaling-supported': ['auto', 'auto-fit', 'fill', 'fit', 'none'].map((x) => v.kw(x)),
    'orientation-requested-default': v.enum(3), 'orientation-requested-supported': [3, 4, 5, 6].map((x) => v.enum(x)),
    'print-quality-default': v.enum(4), 'print-quality-supported': [3, 4, 5].map((x) => v.enum(x)),
    'printer-resolution-default': v.res(c.kind === 'sheet' ? 2400 : 1200),
    'printer-resolution-supported': [v.res(600), v.res(1200), v.res(2400)],
    'job-hold-until-default': v.kw('no-hold'),
    'job-hold-until-supported': [v.kw('no-hold'), v.kw('indefinite')],
    'job-priority-default': v.int(50), 'job-priority-supported': v.int(100),
    'multiple-document-handling-supported': ['separate-documents-collated-copies', 'separate-documents-uncollated-copies'].map((x) => v.kw(x)),
    'imposition-template-supported': c.kind === 'sheet' ? [v.kw('none'), v.kw('booklet')] : [v.kw('none')],
    'job-creation-attributes-supported': ['copies', 'finishings', 'finishings-col', 'media', 'media-col', 'sides', 'number-up', 'page-ranges', 'print-color-mode', 'print-scaling', 'output-bin', 'orientation-requested', 'job-hold-until', 'job-priority', 'imposition-template', 'multiple-document-handling'].map((x) => v.kw(x)),
    'which-jobs-supported': ['completed', 'not-completed', 'all'].map((x) => v.kw(x)),
    'marker-names': supplies.length ? supplies.map((s) => v.name(s.name)) : v.noValue(),
    'marker-colors': supplies.length ? supplies.map((s) => v.name(s.color)) : v.noValue(),
    'marker-types': supplies.length ? supplies.map((s) => v.kw(s.type === 'toner' ? 'toner' : 'ink-cartridge')) : v.noValue(),
    'marker-levels': supplies.length ? supplies.map((s) => v.int(Math.round(s.level))) : v.noValue(),
    'marker-low-levels': supplies.length ? supplies.map(() => v.int(10)) : v.noValue(),
    'marker-high-levels': supplies.length ? supplies.map(() => v.int(100)) : v.noValue(),
  };
  return attrs;
}

const GROUPS = {
  'job-template': ['copies', 'finishings', 'media', 'media-col', 'sides', 'number-up', 'page-ranges', 'print-color-mode', 'print-scaling', 'output-bin', 'orientation-requested', 'job-hold-until', 'job-priority', 'imposition-template', 'multiple-document-handling', 'print-quality', 'printer-resolution'],
};
function filterRequested(attrs, requested) {
  if (!requested) return attrs;
  const req = Array.isArray(requested) ? requested : [requested];
  if (req.includes('all')) return attrs;
  const out = {};
  for (const [k, val] of Object.entries(attrs)) {
    if (req.includes(k)) out[k] = val;
    else if (req.includes('printer-description') && !GROUPS['job-template'].some((g) => k.startsWith(g))) out[k] = val;
    else if (req.includes('job-template') && GROUPS['job-template'].some((g) => k.startsWith(g))) out[k] = val;
    else if (req.includes('media-col-database') && k === 'media-col-database') out[k] = val;
  }
  return out;
}

// ---------------------------------------------------------------------- Job-Attribute -> Ticket
function applyJobAttributes(job, attrs, dev, fleet) {
  const unsupported = {};
  const src = (k) => `IPP ${k}`;
  for (const [k, val] of Object.entries(attrs)) {
    const vals = Array.isArray(val) ? val : [val];
    switch (k) {
      case 'copies': setTicket(job, 'copies', Math.max(1, Number(val) || 1), src(k)); break;
      case 'sides':
        if (val !== 'one-sided' && !dev.cfg.duplex) { unsupported[k] = v.kw(val); job.warn('TICKET', `sides=${val} nicht unterstützt (Gerät kann nicht duplex) → one-sided`); }
        else setTicket(job, 'sides', val, src(k));
        break;
      case 'media': {
        const m = fleet.catalog.get(val) || Array.from(fleet.catalog.values()).find((x) => x.name === val);
        if (m) setTicket(job, 'media.mediaId', m.id, src(k));
        else {
          const s = sizeFromName(val);
          if (s) { setTicket(job, 'media.sizeMm', s, src(k)); setTicket(job, 'media.sizeName', val, src(k)); }
          else { unsupported[k] = v.kw(val); noteUnknown(job, k, val, 'IPP', 'Medienname unbekannt'); }
        }
        break;
      }
      case 'media-col': {
        const col = vals[0] || {};
        if (col['media-key'] && fleet.catalog.get(col['media-key'])) setTicket(job, 'media.mediaId', col['media-key'], src('media-col.media-key'));
        if (col['media-size'] && col['media-size']['x-dimension']) {
          const x = col['media-size']['x-dimension'], y = col['media-size']['y-dimension'];
          const yy = typeof y === 'object' ? null : y;
          if (yy) setTicket(job, 'media.sizeMm', [x / 100, yy / 100], src('media-col.media-size'));
          else if (dev.cfg.kind !== 'sheet') job.addLog('TICKET', `media-col.media-size: Rollenbreite ${x / 100} mm angefordert`);
        }
        if (col['media-size-name']) { const s = sizeFromName(col['media-size-name']); if (s && !col['media-size']) setTicket(job, 'media.sizeMm', s, src('media-col.media-size-name')); }
        if (col['media-source'] && col['media-source'] !== 'auto') setTicket(job, 'media.source', col['media-source'], src('media-col.media-source'));
        if (col['media-type'] && col['media-type'] !== 'auto') setTicket(job, 'media.type', col['media-type'], src('media-col.media-type'));
        if (col['media-weight-metric']) setTicket(job, 'media.gsm', col['media-weight-metric'], src('media-col.media-weight-metric'));
        for (const mk of Object.keys(col)) if (!['media-key', 'media-size', 'media-size-name', 'media-source', 'media-type', 'media-weight-metric', 'media-color', 'media-info', 'media-top-margin', 'media-bottom-margin', 'media-left-margin', 'media-right-margin'].includes(mk)) noteUnknown(job, `media-col.${mk}`, col[mk], 'IPP');
        if (['media-top-margin', 'media-bottom-margin', 'media-left-margin', 'media-right-margin'].some((x) => col[x] === 0)) {
          if (dev.cfg.roll?.borderless) setTicket(job, 'roll.borderless', true, src('media-col.*-margin=0'));
          else job.warn('TICKET', 'Randlos (Ränder 0) angefordert – Gerät druckt mit Rand');
        }
        break;
      }
      case 'media-source': if (val !== 'auto') setTicket(job, 'media.source', val, src(k)); break;
      case 'media-type': if (val !== 'auto') setTicket(job, 'media.type', val, src(k)); break;
      case 'finishings': {
        const kw = vals.map((n) => IPP_FINISHINGS[n] || String(n));
        const bad = [];
        for (const f of kw) if (!applyFinishingKeyword(job, f, src('finishings'))) bad.push(f);
        if (bad.length) { unsupported[k] = bad.map((b) => v.enum(IPP_FINISHINGS_REV[b] || 3)); job.warn('TICKET', `finishings ${bad.join(', ')} von der Simulation nicht umgesetzt`); }
        break;
      }
      case 'finishings-col':
        for (const col of vals) if (col && col['finishing-template'] && !applyFinishingKeyword(job, col['finishing-template'], src('finishings-col.finishing-template'))) noteUnknown(job, 'finishings-col', col, 'IPP');
        break;
      case 'number-up': if (Number(val) > 1) { if (dev.cfg.kind !== 'sheet') { unsupported[k] = v.int(val); } else { setTicket(job, 'numberUp', Number(val), src(k)); setTicket(job, 'imposition', 'n-up', src(k)); } } break;
      case 'page-ranges': setTicket(job, 'pageRanges', vals.map((r) => [r.lower, r.upper]), src(k)); break;
      case 'print-scaling': setTicket(job, 'scaling', { 'auto-fit': 'fit', auto: 'auto', fit: 'fit', fill: 'fill', none: 'none' }[val] || 'auto', src(k)); break;
      case 'orientation-requested': setTicket(job, 'orientation', { 3: 'portrait', 4: 'landscape', 5: 'landscape', 6: 'portrait' }[val] || 'auto', src(k)); break;
      case 'output-bin': setTicket(job, 'outputBin', val, src(k)); break;
      case 'job-hold-until': if (val && val !== 'no-hold') setTicket(job, 'hold', true, src(k)); break;
      case 'job-priority': setTicket(job, 'priority', Number(val), src(k)); break;
      case 'print-color-mode': setTicket(job, 'colorMode', val, src(k)); break;
      case 'imposition-template': if (val === 'booklet') { setTicket(job, 'imposition', 'booklet', src(k)); setTicket(job, 'finishing.booklet', { saddle: true }, src(k)); } break;
      case 'multiple-document-handling': setTicket(job, 'collate', !/uncollated/.test(val), src(k)); break;
      case 'sheet-collate': setTicket(job, 'collate', val !== 'uncollated', src(k)); break;
      case 'print-quality': case 'printer-resolution': case 'print-content-optimize': case 'print-rendering-intent':
        job.addLog('TICKET', `${k}=${JSON.stringify(val)} gelesen (Qualitätseinstellung, ohne Einfluss auf das Layout)`); break;
      default:
        if (/^(job-name|requesting-user-name|document-format|document-name|compression|attributes-|printer-uri|job-uri|job-id|last-document|ipp-attribute-fidelity|job-k-octets|job-impressions|job-media-sheets|document-natural-language|job-password|job-uuid|job-originating-host-name)/.test(k)) break;
        unsupported[k] = typeof val === 'number' ? v.int(val) : v.kw(String(Array.isArray(val) ? val[0] : val));
        noteUnknown(job, `IPP ${k}`, val, 'IPP');
    }
  }
  return unsupported;
}

function jobAttributes(job, baseUri, requested) {
  const all = {
    'job-id': v.int(job.id),
    'job-uri': v.uri(`${baseUri}/jobs/${job.id}`),
    'job-printer-uri': v.uri(baseUri),
    'job-name': v.name(job.name),
    'job-originating-user-name': v.name(job.user || 'unbekannt'),
    'job-state': v.enum(job.ippState),
    'job-state-reasons': (job.stateReasons.length ? job.stateReasons : ['none']).map((r) => v.kw(r)),
    'job-state-message': v.text(job.stateMessage || job.stateText),
    'job-printer-up-time': v.int(Math.floor(Date.now() / 1000) % 2147483647),
    'time-at-creation': v.int(Math.floor(new Date(job.created).getTime() / 1000)),
    'time-at-processing': job.state === 'pending' || job.state === 'held' ? v.noValue() : v.int(Math.floor(new Date(job.updated).getTime() / 1000)),
    'time-at-completed': job.completedAt ? v.int(Math.floor(new Date(job.completedAt).getTime() / 1000)) : v.noValue(),
    'job-impressions-completed': v.int(job.counters.impressions || job.counters.prints || 0),
    'job-media-sheets-completed': v.int(job.counters.sheets || job.counters.prints || 0),
    'job-k-octets': v.int(Math.ceil((job.input?.bytes || 0) / 1024)),
    'copies': v.int(job.ticket.copies || 1),
    'sides': v.kw(job.ticket.sides || 'one-sided'),
    'job-hold-until': v.kw(job.state === 'held' ? 'indefinite' : 'no-hold'),
    'job-priority': v.int(job.ticket.priority || 50),
  };
  if (job.summary?.outputBin) all['output-bin'] = v.kw(job.summary.outputBin);
  if (!requested) return { 'job-id': all['job-id'], 'job-uri': all['job-uri'], 'job-state': all['job-state'], 'job-state-reasons': all['job-state-reasons'], 'job-state-message': all['job-state-message'] };
  const req = Array.isArray(requested) ? requested : [requested];
  if (req.includes('all') || req.includes('job-description') || req.includes('job-template')) return all;
  const out = {};
  for (const k of req) if (all[k]) out[k] = all[k];
  if (!out['job-id']) out['job-id'] = all['job-id'];
  return out;
}

/**
 * Bearbeitet eine IPP-HTTP-Anfrage für ein Gerät.
 */
async function handleIpp(fleet, dev, req, body, pathname) {
  const host = req.headers.host || `${fleet.settings.bindHost}:${dev.cfg.ports.http}`;
  const m = /^\/ipp\/print(?:\/([^/]+))?/.exec(pathname);
  const queueName = m && m[1] ? decodeURIComponent(m[1]) : null;
  const baseUri = `ipp://${host}/ipp/print${queueName ? '/' + encodeURIComponent(queueName) : ''}`;
  const rootUri = `ipp://${host}/ipp/print`;
  const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  let msg;
  try { msg = decode(body); } catch (e) {
    dev.trace('ipp', 'in', `Ungültige IPP-Nachricht von ${remote}: ${e.message}`);
    return encode({ code: 0x0400, requestId: 0, groups: [{ tag: 1, attrs: { 'attributes-charset': v.charset('utf-8'), 'attributes-natural-language': v.lang('de') } }] });
  }
  const op = OP[msg.code] || `0x${msg.code.toString(16)}`;
  const opAttrs = attrsOf(msg, 'operation');
  const jobAttrsIn = attrsOf(msg, 'job');
  const reqText = describe(msg, true);
  const opGroup = { tag: 1, attrs: { 'attributes-charset': v.charset('utf-8'), 'attributes-natural-language': v.lang('de') } };
  const respond = (code, groups = [], job) => {
    const resp = { version: msg.version === '1.1' ? '1.1' : '2.0', code, requestId: msg.requestId, groups: [opGroup, ...groups] };
    const text = describeResponse(resp);
    if (job) job.addProtocol('out', `IPP-Antwort ${STATUS[code]}`, text);
    dev.trace('ipp', 'out', `${op} → ${STATUS[code] || code}`, text);
    return encode(resp);
  };
  const statusMsg = (t) => { opGroup.attrs['status-message'] = v.text(t); };
  const findJob = () => {
    let id = opAttrs['job-id'];
    if (!id && opAttrs['job-uri']) id = Number(String(opAttrs['job-uri']).split('/').pop());
    const j = fleet.jobs.get(Number(id));
    return j && j.deviceId === dev.id ? j : null;
  };
  const noisy = ['Get-Printer-Attributes', 'Get-Jobs', 'Get-Job-Attributes'].includes(op);
  dev.trace('ipp', 'in', `${op} von ${remote}${queueName ? ' (Queue ' + queueName + ')' : ''}`, reqText, noisy);

  switch (msg.code) {
    case 0x000b: { // Get-Printer-Attributes
      const attrs = filterRequested(printerAttributes(fleet, dev, rootUri, queueName), opAttrs['requested-attributes']);
      return respond(0x0000, [{ tag: 4, attrs }]);
    }
    case 0x0004: { // Validate-Job
      const tmp = { ticket: require('../../pipeline/ticket').baseTicket(), ticketSources: {}, addLog() {}, warn() {} };
      const uns = applyJobAttributes(tmp, jobAttrsIn, dev, fleet);
      const fmt = opAttrs['document-format'];
      if (fmt && !FORMATS.includes(fmt)) { statusMsg(`document-format ${fmt} nicht unterstützt`); return respond(0x040a, [{ tag: 5, attrs: { 'document-format': v.mime(fmt) } }]); }
      return respond(Object.keys(uns).length ? 0x0001 : 0x0000, Object.keys(uns).length ? [{ tag: 5, attrs: uns }] : []);
    }
    case 0x0002: case 0x0005: { // Print-Job / Create-Job
      if (!dev.status.accepting) { statusMsg('Drucker nimmt keine Jobs an (offline)'); return respond(0x0506); }
      const fmt = opAttrs['document-format'];
      if (fmt && !FORMATS.includes(fmt)) { statusMsg(`document-format ${fmt} nicht unterstützt`); return respond(0x040a, [{ tag: 5, attrs: { 'document-format': v.mime(fmt) } }]); }
      const job = fleet.createJob(dev.id, { name: opAttrs['job-name'] || opAttrs['document-name'] || null, user: opAttrs['requesting-user-name'], source: { protocol: 'IPP', op, remote, queue: queueName || dev.queues[0].name }, queue: queueName });
      job.addProtocol('in', `IPP ${op} von ${remote}`, reqText);
      const uns = applyJobAttributes(job, jobAttrsIn, dev, fleet);
      for (const [k, val] of Object.entries(opAttrs)) if (!/^(attributes-|printer-uri|requesting-user-name|job-name|document-format|document-name|ipp-attribute-fidelity|compression|job-k-octets|job-impressions|job-media-sheets|document-natural-language|job-password|job-uuid|job-originating-host-name|requested-attributes)/.test(k)) applyJobAttributes(job, { [k]: val }, dev, fleet);
      if (opAttrs['ipp-attribute-fidelity'] === true && Object.keys(uns).length) {
        job.setState('aborted', ['unsupported-attributes'], 'ipp-attribute-fidelity=true und nicht unterstützte Attribute');
        return respond(0x040b, [{ tag: 5, attrs: uns }], job);
      }
      const jobGroup = { tag: 2, attrs: {} };
      if (msg.code === 0x0002) {
        fleet.submit(job, msg.data, { filename: opAttrs['document-name'] || null, format: fmt });
      } else {
        job._docs = [];
        job.setState('receiving', ['job-incoming'], 'Warte auf Send-Document');
      }
      Object.assign(jobGroup.attrs, jobAttributes(job, rootUri));
      const groups = [];
      if (Object.keys(uns).length) groups.push({ tag: 5, attrs: uns });
      groups.push(jobGroup);
      return respond(Object.keys(uns).length ? 0x0001 : 0x0000, groups, job);
    }
    case 0x0006: { // Send-Document
      const job = findJob();
      if (!job) { statusMsg('Job nicht gefunden'); return respond(0x0406); }
      job.addProtocol('in', `IPP Send-Document von ${remote}`, reqText);
      job._docs = job._docs || [];
      if (msg.data.length) job._docs.push(msg.data);
      if (opAttrs['document-name'] && !job.ticket.jobName) job.name = opAttrs['document-name'];
      if (opAttrs['last-document'] === true) await finishMultiDoc(fleet, job, opAttrs);
      return respond(0x0000, [{ tag: 2, attrs: jobAttributes(job, rootUri) }], job);
    }
    case 0x003b: { // Close-Job
      const job = findJob();
      if (!job) return respond(0x0406);
      job.addProtocol('in', `IPP Close-Job von ${remote}`, reqText);
      if (job.state === 'receiving') await finishMultiDoc(fleet, job, opAttrs);
      return respond(0x0000, [{ tag: 2, attrs: jobAttributes(job, rootUri) }], job);
    }
    case 0x0009: { // Get-Job-Attributes
      const job = findJob();
      if (!job) { statusMsg('Job nicht gefunden'); return respond(0x0406); }
      job.protocol.length < 400 && job.addProtocol('in', `IPP Get-Job-Attributes (Statusabfrage) von ${remote}`, reqText);
      return respond(0x0000, [{ tag: 2, attrs: jobAttributes(job, rootUri, opAttrs['requested-attributes'] || 'all') }], job.protocol.length < 400 ? job : null);
    }
    case 0x000a: { // Get-Jobs
      const which = opAttrs['which-jobs'] || 'not-completed';
      let list = fleet.jobsOf(dev.id).filter((j) => !(j.queueMode === 'direct' && j.isFinal));
      if (which === 'completed') list = list.filter((j) => j.isFinal);
      else if (which !== 'all') list = list.filter((j) => !j.isFinal);
      if (opAttrs['my-jobs'] && opAttrs['requesting-user-name']) list = list.filter((j) => j.user === opAttrs['requesting-user-name']);
      list.sort((a, b) => b.id - a.id);
      if (opAttrs.limit) list = list.slice(0, opAttrs.limit);
      return respond(0x0000, list.map((j) => ({ tag: 2, attrs: jobAttributes(j, rootUri, opAttrs['requested-attributes'] || ['job-id', 'job-uri', 'job-name', 'job-state', 'job-state-reasons']) })));
    }
    case 0x0008: case 0x000c: case 0x000d: case 0x000e: { // Cancel / Hold / Release / Restart
      const job = findJob();
      if (!job) { statusMsg('Job nicht gefunden'); return respond(0x0406); }
      job.addProtocol('in', `IPP ${op} von ${remote}`, reqText);
      try {
        fleet.jobAction(job.id, { 0x0008: 'cancel', 0x000c: 'hold', 0x000d: 'release', 0x000e: 'reprint' }[msg.code]);
        return respond(0x0000, [], job);
      } catch (e) { statusMsg(e.message); return respond(0x0404, [], job); }
    }
    case 0x0010: dev.setError('paused', true); return respond(0x0000);
    case 0x0011: dev.setError('paused', false); return respond(0x0000);
    case 0x003c: fleet.log(dev.id, 'info', `Identify-Printer von ${remote}: Gerät „piept" (Simulation)`); return respond(0x0000);
    default:
      statusMsg(`${op} wird nicht unterstützt`);
      return respond(0x0501);
  }
}

async function finishMultiDoc(fleet, job, opAttrs) {
  const docs = job._docs || [];
  if (!docs.length) { job.setState('aborted', ['job-data-insufficient'], 'Keine Dokumentdaten'); return; }
  let data = docs[0];
  if (docs.length > 1) {
    const { PDFDocument } = require('pdf-lib');
    const { normalize } = require('../../pipeline/detect');
    const out = await PDFDocument.create();
    for (const d of docs) {
      const n = await normalize(d, job, fleet.settings);
      const src = await PDFDocument.load(n.pdfBytes, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
    data = Buffer.from(await out.save());
    job.addLog('EMPFANG', `${docs.length} Dokumente zu einem Job zusammengeführt (multiple-document-handling)`);
  }
  delete job._docs;
  fleet.submit(job, data, { filename: opAttrs['document-name'] || null, format: opAttrs['document-format'] });
}

module.exports = { handleIpp, printerAttributes };
