'use strict';
// Erzeugt je Gerät eine PPD-Datei („Treiber") – so, wie Fiery, PRISMAsync & Co. sie für CUPS/macOS
// mitliefern: mit Installierbaren Optionen (Finisher-Module), Fächern/Rollen, Materialarten, Ablagen,
// Duplex und Weiterverarbeitung. Die Optionen werden über cupsIPPFinishings & Co. als IPP-Attribute
// an die Simulation übertragen; das PDF selbst geht unverändert durch.
const { frontendOf, installedModules, MODULE_DE } = require('../frontends');
const { SIZES } = require('../pipeline/ticket');

const PT = 72 / 25.4;
const pt = (mm) => Math.round(mm * PT * 100) / 100;
const q = (s) => String(s).replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
const tr = (s) => String(s).replace(/[/:]/g, '-'); // Übersetzungstext darf / und : nicht enthalten

const STAPLE = { 'top-left': ['UpperLeft', 'Oben links', 20], 'bottom-left': ['LowerLeft', 'Unten links', 21], 'top-right': ['UpperRight', 'Oben rechts', 22], 'bottom-right': ['LowerRight', 'Unten rechts', 23], 'dual-left': ['DualLeft', '2x links', 28], 'dual-top': ['DualTop', '2x oben', 29], 'dual-right': ['DualRight', '2x rechts', 30], 'dual-bottom': ['DualBottom', '2x unten', 31] };
const PUNCH = { 2: ['Punch2Left', '2-fach links', 74], 3: ['Punch3Left', '3-fach links', 78], 4: ['Punch4Left', '4-fach links', 82] };
const FOLD_SHEET = { half: ['Half', 'Mittelfalz', 93], letter: ['Letter', 'Wickelfalz', 96], z: ['ZFold', 'Zickzackfalz', 100], 'engineering-z': ['EngineeringZ', 'Z-Falz A3 auf A4', 101] };
const FOLD_WIDE = { 'din824-a': ['DIN824A', 'DIN 824 Form A (Heftrand)', 101], 'din824-b': ['DIN824B', 'DIN 824 Form B', 98], fan: ['Fan', 'Leporello', 90] };

function pageSizes(c) {
  const list = [];
  const add = (key, text, w, h) => { if (!list.some((x) => x.key === key)) list.push({ key, text, w, h }); };
  if (c.kind === 'sheet') {
    const [minA, minB] = [Math.min(...c.sheet.minMm), Math.max(...c.sheet.minMm)];
    const [maxA, maxB] = [Math.min(...c.sheet.maxMm), Math.max(...c.sheet.maxMm)];
    const ok = (w, h) => Math.min(w, h) >= minA - 0.5 && Math.max(w, h) >= minB - 0.5 && Math.min(w, h) <= maxA + 0.5 && Math.max(w, h) <= maxB + 0.5;
    for (const [k, t] of [['A4', 'A4'], ['A3', 'A3'], ['A5', 'A5'], ['SRA3', 'SRA3'], ['SRA4', 'SRA4'], ['B4', 'B4'], ['B3', 'B3'], ['LETTER', 'Letter'], ['LEGAL', 'Legal'], ['TABLOID', 'Tabloid'], ['12X18', '12x18 Zoll'], ['13X19', '13x19 Zoll']]) {
      const [w, h] = SIZES[k];
      if (ok(w, h)) add(t.replace(/ Zoll/, '').replace(/\s/g, ''), t, w, h);
    }
    for (const [w, h] of [[330, 488], [330, 660], [330, 1200], [210, 594]]) if (ok(w, h)) add(`w${Math.round(pt(w))}h${Math.round(pt(h))}`, `${w} x ${h} mm (Langbogen)`, w, h);
  } else if (c.kind === 'photo') {
    for (const [k, t] of [['9X13', '9x13'], ['10X15', '10x15'], ['13X18', '13x18'], ['15X20', '15x20'], ['15X21', '15x21'], ['20X25', '20x25'], ['20X30', '20x30'], ['21X30', '21x30 (A4)']]) {
      const [w, h] = SIZES[k];
      add(`Photo${k.replace('X', 'x')}`, `${t} cm`, w, h);
    }
  } else {
    const maxW = c.roll.maxWidthMm;
    for (const k of ['A4', 'A3', 'A2', 'A1', 'A0', 'ARCH-D', 'ARCH-E']) {
      const [w, h] = SIZES[k];
      if (Math.min(w, h) <= maxW + 0.5) add(k.replace('-', ''), k, w, h);
    }
    if (maxW >= 1189) add('2A0', '2A0', 1189, 1682);
  }
  return list;
}

function generatePpd(fleet, dev) {
  const c = dev.cfg;
  const fe = frontendOf(c);
  const mods = c.finisher?.modules || {};
  const inst = installedModules(c);
  const m = c.marginsMm || {};
  const L = [];
  const P = (s) => L.push(s);
  const sizes = pageSizes(c);
  const def = sizes.find((s) => /^(A4|Photo10x15|A1)$/.test(s.key)) || sizes[0];
  const nick = `${c.vendor} ${c.model} - ${c.frontend.product} (Virtual Print Fleet)`;
  const pcName = ('VPF' + c.id.replace(/[^A-Za-z0-9]/g, '').toUpperCase()).slice(0, 8) + '.PPD';

  P('*PPD-Adobe: "4.3"');
  P('*%%%% Virtual Print Fleet – erzeugt für ' + q(c.name) + ' (' + q(fe.label) + ')');
  P('*FormatVersion: "4.3"');
  P('*FileVersion: "1.0"');
  P('*LanguageVersion: German');
  P('*LanguageEncoding: ISOLatin1');
  P(`*PCFileName: "${pcName}"`);
  P(`*Manufacturer: "${q(c.vendor)}"`);
  P(`*Product: "(${q(c.model)})"`);
  P(`*ModelName: "${q(`${c.vendor} ${c.model} ${fe.label} VPF`)}"`);
  P(`*ShortNickName: "${q(`${c.model} VPF`).slice(0, 31)}"`);
  P(`*NickName: "${q(nick)}"`);
  P('*PSVersion: "(3010.000) 0"');
  P('*LanguageLevel: "3"');
  P(`*ColorDevice: ${c.color ? 'True' : 'False'}`);
  P(`*DefaultColorSpace: ${c.color ? 'CMYK' : 'Gray'}`);
  P('*FileSystem: False');
  P(`*Throughput: "${Math.max(1, Math.round(c.speed?.ppm || 1))}"`);
  P('*LandscapeOrientation: Plus90');
  P('*TTRasterizer: Type42');
  P('*cupsVersion: 2.4');
  P('*cupsManualCopies: False');
  P('*cupsMaxCopies: 9999');
  P('*cupsFilter2: "application/pdf application/pdf 0 -"');
  P('*cupsFilter2: "application/vnd.cups-pdf application/pdf 10 -"');
  P('*cupsFilter2: "application/vnd.cups-postscript application/postscript 20 -"');
  P(`*APSupportsCustomColorMatching: False`);
  P(`*% Druckserver: ${q(c.frontend.product)} – Webseite http://<host>:${c.ports.http}/`);
  P('');

  // ---------------- Installierbare Optionen
  const instOpts = [];
  for (const k of Object.keys(mods)) {
    if (!['stapler', 'puncher', 'booklet', 'folder', 'wfFolder', 'cutter', 'contourCutter', 'takeUp', 'backprint', 'stacker'].includes(k)) continue;
    instOpts.push({ key: `VPFInst${k[0].toUpperCase()}${k.slice(1)}`, mod: k, text: MODULE_DE[k] || k, on: !!inst[k] });
  }
  if (instOpts.length) {
    P('*OpenGroup: InstallableOptions/Installierbare Optionen');
    for (const o of instOpts) {
      P(`*OpenUI *${o.key}/${tr(o.text)}: Boolean`);
      P(`*Default${o.key}: ${o.on ? 'True' : 'False'}`);
      P(`*${o.key} True/Installiert: ""`);
      P(`*${o.key} False/Nicht installiert: ""`);
      P(`*CloseUI: *${o.key}`);
    }
    P('*CloseGroup: InstallableOptions');
    P('');
  }

  // ---------------- Seitengröße
  P('*OpenUI *PageSize/Papierformat: PickOne');
  P('*OrderDependency: 10 AnySetup *PageSize');
  P(`*DefaultPageSize: ${def.key}`);
  for (const s of sizes) P(`*PageSize ${s.key}/${tr(s.text)}: "<</PageSize[${pt(s.w)} ${pt(s.h)}]/ImagingBBox null>>setpagedevice"`);
  P('*CloseUI: *PageSize');
  P('*OpenUI *PageRegion/Papierformat: PickOne');
  P('*OrderDependency: 10 AnySetup *PageRegion');
  P(`*DefaultPageRegion: ${def.key}`);
  for (const s of sizes) P(`*PageRegion ${s.key}/${tr(s.text)}: "<</PageSize[${pt(s.w)} ${pt(s.h)}]/ImagingBBox null>>setpagedevice"`);
  P('*CloseUI: *PageRegion');
  P(`*DefaultImageableArea: ${def.key}`);
  for (const s of sizes) P(`*ImageableArea ${s.key}: "${pt(m.left || 0)} ${pt(m.bottom || 0)} ${pt(s.w - (m.right || 0))} ${pt(s.h - (m.top || 0))}"`);
  P(`*DefaultPaperDimension: ${def.key}`);
  for (const s of sizes) P(`*PaperDimension ${s.key}: "${pt(s.w)} ${pt(s.h)}"`);
  const maxW = c.kind === 'sheet' ? Math.min(...c.sheet.maxMm) : c.roll.maxWidthMm;
  const maxH = c.kind === 'sheet' ? Math.max(...c.sheet.maxMm) : c.roll.maxLengthMm;
  const minW = c.kind === 'sheet' ? Math.min(...c.sheet.minMm) : (c.roll.minLengthMm || 50);
  P(`*MaxMediaWidth: "${pt(maxW)}"`);
  P(`*MaxMediaHeight: "${pt(maxH)}"`);
  P(`*HWMargins: ${pt(m.left || 0)} ${pt(m.bottom || 0)} ${pt(m.right || 0)} ${pt(m.top || 0)}`);
  P('*CustomPageSize True: "pop pop pop <</PageSize[5 -2 roll]/ImagingBBox null>>setpagedevice"');
  P(`*ParamCustomPageSize Width: 1 points ${pt(minW)} ${pt(maxW)}`);
  P(`*ParamCustomPageSize Height: 2 points ${pt(minW)} ${pt(maxH)}`);
  P('*ParamCustomPageSize WidthOffset: 3 points 0 0');
  P('*ParamCustomPageSize HeightOffset: 4 points 0 0');
  P('*ParamCustomPageSize Orientation: 5 int 0 3');
  P('');

  // ---------------- Quelle / Material / Ablage / Duplex / Farbe
  P(`*OpenUI *InputSlot/${c.kind === 'sheet' ? 'Papierfach' : 'Rolle'}: PickOne`);
  P('*OrderDependency: 20 AnySetup *InputSlot');
  P('*DefaultInputSlot: auto');
  P('*InputSlot auto/Automatisch: ""');
  for (const s of c.slots) {
    const med = s.loaded && fleet.catalog.get(s.loaded.mediaId);
    P(`*InputSlot ${s.ippSource}/${tr(s.name + (med ? ' - ' + med.name : ''))}: ""`);
  }
  P('*CloseUI: *InputSlot');
  const types = Array.from(new Set(Array.from(fleet.catalog.values()).filter((x) => x.kind === (c.kind === 'sheet' ? 'sheet' : 'roll')).map((x) => x.ippType || 'stationery')));
  const TYPE_DE = { stationery: 'Normalpapier', 'stationery-coated': 'Gestrichen', cardstock: 'Karton', labels: 'Etiketten/Folie', 'photographic-glossy': 'Foto glänzend', 'photographic-satin': 'Foto satin', 'photographic-semi-gloss': 'Foto halbmatt', fabric: 'Gewebe/Canvas', other: 'Sonstiges' };
  P('*OpenUI *MediaType/Materialart: PickOne');
  P('*OrderDependency: 20 AnySetup *MediaType');
  P('*DefaultMediaType: auto');
  P('*MediaType auto/Automatisch: ""');
  for (const t of types) P(`*MediaType ${t}/${tr(TYPE_DE[t] || t)}: ""`);
  P('*CloseUI: *MediaType');
  const bins = c.finisher?.bins || [];
  if (bins.length) {
    P('*OpenUI *OutputBin/Ausgabefach: PickOne');
    P('*OrderDependency: 20 AnySetup *OutputBin');
    P(`*DefaultOutputBin: ${bins[0].id}`);
    for (const b of bins) P(`*OutputBin ${b.id}/${tr(b.name)}: ""`);
    P('*CloseUI: *OutputBin');
  }
  if (c.duplex) {
    P('*OpenUI *Duplex/Beidseitig: PickOne');
    P('*OrderDependency: 20 AnySetup *Duplex');
    P('*DefaultDuplex: None');
    P('*Duplex None/Einseitig: "<</Duplex false>>setpagedevice"');
    P('*Duplex DuplexNoTumble/Lange Kante: "<</Duplex true/Tumble false>>setpagedevice"');
    P('*Duplex DuplexTumble/Kurze Kante: "<</Duplex true/Tumble true>>setpagedevice"');
    P('*CloseUI: *Duplex');
  }
  if (c.color) {
    P('*OpenUI *ColorModel/Farbmodus: PickOne');
    P('*OrderDependency: 20 AnySetup *ColorModel');
    P('*DefaultColorModel: CMYK');
    P('*ColorModel CMYK/Farbe: ""');
    P('*ColorModel Gray/Graustufen: ""');
    P('*CloseUI: *ColorModel');
  }
  P('');

  // ---------------- Weiterverarbeitung
  const fin = [];
  const constraints = [];
  const pickOne = (key, text, entries, instKey) => {
    if (!entries.length) return;
    P(`*OpenUI *${key}/${tr(text)}: PickOne`);
    P(`*OrderDependency: 30 AnySetup *${key}`);
    P(`*Default${key}: None`);
    P(`*${key} None/Aus: ""`);
    for (const [kw, t, num] of entries) { P(`*${key} ${kw}/${tr(t)}: ""`); fin.push(`*cupsIPPFinishings ${num}/${kw}: "*${key} ${kw}"`); }
    P(`*CloseUI: *${key}`);
    if (instKey) constraints.push(`*UIConstraints: *${instKey} False *${key}`, `*UIConstraints: *${key} *${instKey} False`);
  };
  const ik = (mod) => (mods[mod] ? `VPFInst${mod[0].toUpperCase()}${mod.slice(1)}` : null);
  if (Object.keys(mods).some((k) => ['stapler', 'puncher', 'booklet', 'folder', 'wfFolder'].includes(k))) P('*OpenGroup: Finishing/Weiterverarbeitung');
  if (mods.stapler) pickOne('StapleLocation', 'Heften', (mods.stapler.positions || []).filter((p) => STAPLE[p]).map((p) => STAPLE[p]), ik('stapler'));
  if (mods.puncher) pickOne('Punch', 'Lochen', (mods.puncher.holes || []).filter((h) => PUNCH[h]).map((h) => PUNCH[h]), ik('puncher'));
  if (mods.booklet) pickOne('Booklet', 'Broschüre', [['Saddle', 'Rückstichheftung (Broschüre)', 8]], ik('booklet'));
  if (mods.folder) pickOne('Fold', 'Falzen', (mods.folder.types || []).filter((t) => FOLD_SHEET[t]).map((t) => FOLD_SHEET[t]), ik('folder'));
  if (mods.wfFolder) pickOne('Fold', 'Falten', (mods.wfFolder.forms || []).filter((t) => FOLD_WIDE[t]).map((t) => FOLD_WIDE[t]), ik('wfFolder'));
  if (Object.keys(mods).some((k) => ['stapler', 'puncher', 'booklet', 'folder', 'wfFolder'].includes(k))) P('*CloseGroup: Finishing');
  for (const f of fin) P(f);
  for (const k of constraints) P(k);
  P('');
  P('*DefaultFont: Courier');
  P('*Font Courier: Standard "(002.004S)" Standard ROM');
  P('*Font Helvetica: Standard "(001.006S)" Standard ROM');
  P('*% Ende');
  const text = (L.join('\n') + '\n').replace(/[–—]/g, '-').replace(/[„“”]/g, "'").replace(/[‚‘’]/g, "'").replace(/…/g, '...').replace(/[^\x09\x0a\x20-\x7e\xa0-\xff]/g, '?');
  return Buffer.from(text, 'latin1');
}

/** Grobe Selbstprüfung (Ersatz für cupstestppd, falls CUPS fehlt). */
function checkPpd(buf) {
  const text = buf.toString('latin1');
  const errors = [];
  for (const k of ['*PPD-Adobe', '*FormatVersion', '*LanguageVersion', '*Manufacturer', '*ModelName', '*NickName', '*ShortNickName', '*PCFileName', '*Product', '*PSVersion', '*DefaultPageSize', '*DefaultPageRegion', '*DefaultImageableArea', '*DefaultPaperDimension']) if (!text.includes(k + ':')) errors.push(`${k} fehlt`);
  const open = (text.match(/^\*OpenUI /gm) || []).length, close = (text.match(/^\*CloseUI:/gm) || []).length;
  if (open !== close) errors.push('OpenUI/CloseUI ungleich');
  for (const mm of text.matchAll(/^\*OpenUI \*(\w+)/gm)) {
    const opt = mm[1];
    const dflt = new RegExp(`^\\*Default${opt}: (\\S+)`, 'm').exec(text);
    if (!dflt) { errors.push(`*Default${opt} fehlt`); continue; }
    if (!new RegExp(`^\\*${opt} ${dflt[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/:]`, 'm').test(text)) errors.push(`Standardwert ${dflt[1]} für ${opt} nicht definiert`);
  }
  const sn = /\*ShortNickName: "([^"]*)"/.exec(text);
  if (sn && sn[1].length > 31) errors.push('ShortNickName > 31 Zeichen');
  for (const line of text.split('\n')) if (line.length > 255) errors.push('Zeile > 255 Zeichen');
  for (const mm of text.matchAll(/^\*(\w+) ([^/:\s]+)\/([^:]*):/gm)) if (mm[3].length > 80) errors.push(`Übersetzung zu lang: ${mm[1]} ${mm[2]}`);
  return errors;
}

module.exports = { generatePpd, checkPpd, pageSizes };
