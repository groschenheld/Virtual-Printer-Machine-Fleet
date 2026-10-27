'use strict';
// Weiterverarbeitung: Heften, Lochen, Falzen, Broschüre (Rückstich, Frontbeschnitt, Rückenpressung),
// DIN-824-Faltung für Großformat. Prüft Grenzen der Finisher-Module und erzeugt Overlay-Geometrie.
const { mm2pt, pt2mm, r1, fmtSize } = require('../util/misc');

const STAPLE_DE = { 'top-left': 'oben links', 'top-right': 'oben rechts', 'bottom-left': 'unten links', 'bottom-right': 'unten rechts', 'dual-left': '2× links', 'dual-top': '2× oben', 'dual-right': '2× rechts', 'dual-bottom': '2× unten', saddle: 'Rückstich' };
const FOLD_DE = { half: 'Mittelfalz', letter: 'Wickelfalz', z: 'Zickzackfalz', 'engineering-z': 'Z-Falz (A3 → A4, Einhefter)', accordion: 'Leporello', 'half-z': 'Halb-Z', gate: 'Fensterfalz', 'double-gate': 'Doppelfensterfalz', parallel: 'Doppelparallelfalz', 'din824-a': 'DIN 824 Form A (mit Heftrand)', 'din824-b': 'DIN 824 Form B (ohne Heftrand)', fan: 'Leporello/Fächer' };

/** Geometrie eines Bogens in Leserichtung: "oben" ist die obere Kante der Seite. */
function staplesFor(pos, W, H) {
  const off = mm2pt(6), len = mm2pt(12);
  const out = [];
  const diag = (x, y, a) => out.push({ x, y, angle: a, len });
  switch (pos) {
    case 'top-left': diag(off + len / 3, H - off - len / 3, 45); break;
    case 'top-right': diag(W - off - len / 3, H - off - len / 3, -45); break;
    case 'bottom-left': diag(off + len / 3, off + len / 3, -45); break;
    case 'bottom-right': diag(W - off - len / 3, off + len / 3, 45); break;
    case 'dual-left': out.push({ x: off, y: H * 0.25, angle: 90, len }, { x: off, y: H * 0.75, angle: 90, len }); break;
    case 'dual-right': out.push({ x: W - off, y: H * 0.25, angle: 90, len }, { x: W - off, y: H * 0.75, angle: 90, len }); break;
    case 'dual-top': out.push({ x: W * 0.25, y: H - off, angle: 0, len }, { x: W * 0.75, y: H - off, angle: 0, len }); break;
    case 'dual-bottom': out.push({ x: W * 0.25, y: off, angle: 0, len }, { x: W * 0.75, y: off, angle: 0, len }); break;
    default: break;
  }
  return out;
}

function holesFor(n, edge, W, H) {
  // DIN-Lochung: Abstand 80 mm (2-fach), 4-fach 3×80 mm; 3-fach (US) 108 mm. Lochmitte 12 mm vom Rand, Ø 6 mm.
  const pitch = mm2pt(n === 3 ? 108 : 80), r = mm2pt(3), d = mm2pt(12);
  const vertical = edge === 'left' || edge === 'right';
  const L = vertical ? H : W;
  const total = pitch * (n - 1);
  const start = (L - total) / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * pitch;
    if (edge === 'left') out.push({ x: d, y: t, r });
    else if (edge === 'right') out.push({ x: W - d, y: t, r });
    else if (edge === 'top') out.push({ x: t, y: H - d, r });
    else out.push({ x: t, y: d, r });
  }
  return out;
}

/** Faltlinien (Bogen-Koordinaten). Faltung teilt die lange Seite. */
function foldLines(type, W, H) {
  const long = Math.max(W, H);
  const horiz = H >= W; // Falzlinien horizontal, wenn Bogen hochkant
  const at = (t, kind, n) => (horiz ? { x1: 0, y1: H - t, x2: W, y2: H - t, kind, n } : { x1: t, y1: 0, x2: t, y2: H, kind, n });
  switch (type) {
    case 'half': return [at(long / 2, 'valley', 1)];
    case 'letter': { const p = long / 3; return [at(p - mm2pt(1), 'valley', 1), at(2 * p, 'valley', 2)]; }
    case 'z': case 'accordion': { const p = long / 3; return [at(p, 'valley', 1), at(2 * p, 'mountain', 2)]; }
    case 'engineering-z': return [at(long / 2, 'valley', 1), at(long / 4, 'mountain', 2)];
    case 'half-z': return [at(long / 2, 'valley', 1), at(long / 4, 'mountain', 2)];
    case 'gate': return [at(long / 4, 'valley', 1), at((3 * long) / 4, 'valley', 2)];
    case 'double-gate': return [at(long / 4, 'valley', 1), at((3 * long) / 4, 'valley', 2), at(long / 2, 'valley', 3)];
    case 'parallel': return [at(long / 2, 'valley', 1), at(long / 4, 'valley', 2)];
    default: return null;
  }
}

/** DIN 824 (vereinfachte Nachbildung): Längsfaltung auf 190/210 mm, dann Querfaltung auf 297 mm. */
function din824(form, W, H) {
  // Bogen in Zeichnungsorientierung: lange Seite = Breite der Zeichnung
  const longIsX = W >= H;
  const Lmm = pt2mm(longIsX ? W : H), Smm = pt2mm(longIsX ? H : W);
  const folds = [];
  const panel = form === 'din824-b' || form === 'fan' ? 210 : 190;
  const finalW = 210;
  // Längsfaltung: von rechts (Schriftfeld) Felder à "panel", Rest links inkl. 20 mm Heftrand
  let pos = Lmm;
  let n = 0;
  if (Lmm > finalW + 0.5) {
    while (pos - panel > finalW - (form === 'din824-a' ? 0 : 0) + 0.5) {
      pos -= panel;
      n++;
      folds.push({ t: pos, axis: 'long', kind: n % 2 ? 'valley' : 'mountain', n });
    }
    const rest = pos;
    if (form === 'din824-a' && rest > finalW + 0.5) { n++; folds.push({ t: rest - finalW, axis: 'long', kind: 'valley', n }); }
  }
  // Querfaltung auf 297 mm
  if (form !== 'fan' && Smm > 297 + 0.5) {
    let q = 297, k = 0;
    while (q < Smm - 0.5) { k++; n++; folds.push({ t: q, axis: 'short', kind: k % 2 ? 'valley' : 'mountain', n }); q += 297; }
  }
  return folds.map((f) => {
    const tPt = mm2pt(f.t);
    if (f.axis === 'long') return longIsX ? { x1: tPt, y1: 0, x2: tPt, y2: H, kind: f.kind, n: f.n } : { x1: 0, y1: tPt, x2: W, y2: tPt, kind: f.kind, n: f.n };
    return longIsX ? { x1: 0, y1: tPt, x2: W, y2: tPt, kind: f.kind, n: f.n } : { x1: tPt, y1: 0, x2: tPt, y2: H, kind: f.kind, n: f.n };
  });
}

/**
 * Wendet das Finishing auf ein Layout an. Rückgabe { conflicts: [...] }.
 */
function applyFinishing(ctx, layout) {
  const { job, device, catalog, ticket } = ctx;
  const mods = device.finisher?.modules || {};
  const fin = ticket.finishing || {};
  const conflicts = [];
  const media = layout.media ? catalog.get(layout.media) : null;
  const summary = [];

  if (layout.kind === 'sheet') {
    const front = layout.surfaces.filter((s) => s.side === 'front');
    const sheetsPerSet = layout.sheetsPerSet;
    // --- Broschüre
    if (layout.mode === 'booklet') {
      const b = mods.booklet;
      const want = fin.booklet || { saddle: true };
      if (!b) conflicts.push('Kein Broschürenmodul am Finisher – Bogen werden nur ausgeschossen, nicht gefalzt/geheftet');
      else {
        if (sheetsPerSet > b.maxSheets) conflicts.push(`Broschüre mit ${sheetsPerSet} Bogen überschreitet Maximum des Broschürenmoduls (${b.maxSheets} Bogen)`);
        const trimMm = want.trimMm ?? fin.trimMm ?? (b.trim ? 5 : 0);
        if (trimMm && !b.trim) conflicts.push('Frontbeschnitt angefordert, aber kein Trimmer vorhanden');
        if (b.maxTrimMm && trimMm > b.maxTrimMm) conflicts.push(`Frontbeschnitt ${trimMm} mm > maximal ${b.maxTrimMm} mm`);
        if (want.squareFold && !b.squareFold) conflicts.push('Rückenpressung (SquareFold) angefordert, aber nicht vorhanden');
        for (const s of layout.surfaces) {
          const bk = s.booklet;
          s.overlay.folds.push({ x1: bk.foldX, y1: 0, x2: bk.foldX, y2: s.hPt, kind: 'valley', n: 1, label: want.squareFold && b.squareFold ? 'Falz + Rückenpressung' : 'Mittelfalz' });
          if (s.side === 'front') {
            s.overlay.staples.push({ x: bk.foldX, y: bk.y0 + bk.pageH * 0.25, angle: 90, len: mm2pt(12) }, { x: bk.foldX, y: bk.y0 + bk.pageH * 0.75, angle: 90, len: mm2pt(12) });
          }
          if (trimMm && b.trim) {
            // Frontbeschnitt: an den offenen Kanten (außen). Bei Bogen größer als 2 Seiten an den Seitenkanten.
            const creepTrim = mm2pt(trimMm);
            const xl = Math.max(0, bk.foldX - bk.pageW) + creepTrim * 0, xr = Math.min(s.wPt, bk.foldX + bk.pageW);
            s.overlay.cuts.push({ x1: xl + creepTrim, y1: 0, x2: xl + creepTrim, y2: s.hPt, kind: 'face-trim', n: 1 }, { x1: xr - creepTrim, y1: 0, x2: xr - creepTrim, y2: s.hPt, kind: 'face-trim', n: 1 });
          }
          if (bk.y0 > mm2pt(2)) s.overlay.areas.push({ x: 0, y: 0, w: s.wPt, h: bk.y0, kind: 'waste', label: 'Kopf/Fuß – bleibt stehen (kein 3-Seiten-Beschnitt)' }, { x: 0, y: bk.y0 + bk.pageH, w: s.wPt, h: s.hPt - bk.y0 - bk.pageH, kind: 'waste' });
        }
        const pw = layout.surfaces[0].booklet.pageW, ph = layout.surfaces[0].booklet.pageH;
        summary.push(`Broschüre: falzen + 2 Rückstichklammern${want.squareFold && b.squareFold ? ' + Rückenpressung (SquareFold)' : ''}${trimMm && b.trim ? ` + Frontbeschnitt ${trimMm} mm` : ''} → Endformat ca. ${fmtSize(pt2mm(pw) - (b.trim ? trimMm : 0), pt2mm(ph))}, ${sheetsPerSet} Bogen/${sheetsPerSet * 4} Seiten je Exemplar`);
        if (media && media.gsm > 300) conflicts.push(`Grammatur ${media.gsm} g/m² für Broschürenfalzung zu hoch`);
      }
    }
    // --- Heften
    if (fin.staple && fin.staple !== 'saddle') {
      const st = mods.stapler;
      if (!st) conflicts.push('Heftung angefordert, aber kein Hefter am Finisher');
      else if (st.positions && !st.positions.includes(fin.staple)) conflicts.push(`Heftposition „${STAPLE_DE[fin.staple] || fin.staple}" nicht unterstützt (möglich: ${st.positions.map((p) => STAPLE_DE[p] || p).join(', ')})`);
      else if (sheetsPerSet > st.maxSheets) conflicts.push(`Heftung: ${sheetsPerSet} Bogen > maximal ${st.maxSheets} Bogen`);
      else if (layout.mode === 'step-repeat') conflicts.push('Heftung bei Step & Repeat nicht sinnvoll');
      else {
        for (const s of layout.surfaces) {
          const pos = s.side === 'back' ? mirrorPos(fin.staple) : fin.staple;
          s.overlay.staples.push(...staplesFor(pos, s.wPt, s.hPt));
        }
        summary.push(`Heftung ${STAPLE_DE[fin.staple] || fin.staple} durch ${sheetsPerSet} Bogen je Satz`);
      }
    }
    // --- Lochen
    if (fin.punch) {
      const pu = mods.puncher;
      const holes = fin.punch.holes || 2;
      const edge = fin.punch.edge || 'left';
      if (!pu) conflicts.push('Lochung angefordert, aber kein Locher am Finisher');
      else if (!pu.holes.includes(holes)) conflicts.push(`${holes}-fach-Lochung nicht unterstützt (möglich: ${pu.holes.join('/')})`);
      else if (media && pu.maxGsm && media.gsm > pu.maxGsm) conflicts.push(`Lochung bei ${media.gsm} g/m² nicht möglich (max. ${pu.maxGsm} g/m²)`);
      else {
        for (const s of layout.surfaces) {
          const e = s.side === 'back' ? ({ left: 'right', right: 'left' }[edge] || edge) : edge;
          s.overlay.holes.push(...holesFor(holes, e, s.wPt, s.hPt));
        }
        summary.push(`${holes}-fach-Lochung am ${({ left: 'linken', right: 'rechten', top: 'oberen', bottom: 'unteren' })[edge]} Rand (Lochabstand ${holes === 3 ? 108 : 80} mm, Ø 6 mm)`);
      }
    }
    // --- Falzen (Einzelbogen)
    if (fin.fold && layout.mode !== 'booklet') {
      const fo = mods.folder;
      if (!fo) conflicts.push(`Falzung (${FOLD_DE[fin.fold] || fin.fold}) angefordert, aber keine Falzeinheit`);
      else if (!fo.types.includes(fin.fold)) conflicts.push(`Falzart ${FOLD_DE[fin.fold] || fin.fold} nicht unterstützt (möglich: ${fo.types.map((t) => FOLD_DE[t] || t).join(', ')})`);
      else if (media && fo.maxGsm && media.gsm > fo.maxGsm) conflicts.push(`Falzen bei ${media.gsm} g/m² nicht möglich (max. ${fo.maxGsm} g/m²)`);
      else {
        for (const s of layout.surfaces) {
          const lines = foldLines(fin.fold, s.wPt, s.hPt) || [];
          s.overlay.folds.push(...lines);
        }
        summary.push(`${FOLD_DE[fin.fold] || fin.fold} je Bogen`);
      }
    }
    if (layout.mode === 'step-repeat' && layout.surfaces[0]?.stepRepeat) {
      const sr = layout.surfaces[0].stepRepeat;
      summary.push(`Schneidemaschine: ${sr.cuts} Schnitte je Stapel → ${sr.perSheet} Nutzen/Bogen, ${ticket.copies} Stück aus ${sr.sheetsNeeded} Bogen${sr.sheetsNeeded * sr.perSheet > ticket.copies ? ` (${sr.sheetsNeeded * sr.perSheet - ticket.copies} Überschuss)` : ''}`);
    }
    if (fin.trimMm && layout.mode !== 'booklet' && layout.mode !== 'step-repeat') job.addLog('FINISHING', `Beschnitt ${fin.trimMm} mm angefordert – an diesem Gerät nur im Broschürenmodus möglich, ignoriert`);
    // --- Ablage
    const bins = device.finisher?.bins || [];
    let bin = ticket.outputBin && bins.find((b) => b.id === ticket.outputBin || b.name.toLowerCase() === String(ticket.outputBin).toLowerCase());
    if (ticket.outputBin && !bin) job.warn('FINISHING', `Ausgabefach „${ticket.outputBin}" unbekannt – Standardablage`);
    if (!bin) bin = layout.mode === 'booklet' ? bins.find((b) => b.id === 'booklet') : (fin.staple || fin.punch || fin.fold) ? bins.find((b) => b.id === 'stacker') || bins[0] : bins[0];
    layout.outputBin = bin ? bin.name : 'Ablage';
    summary.push(`Ablage: ${layout.outputBin}${layout.sets > 1 ? ' (Sätze versetzt abgelegt)' : ''}`);
  }

  if (layout.kind === 'wide') {
    if (fin.fold) {
      const wf = mods.wfFolder;
      if (!wf) conflicts.push('Faltung angefordert, aber keine Online-Faltmaschine angeschlossen');
      else if (!wf.forms.includes(fin.fold)) conflicts.push(`Faltform ${FOLD_DE[fin.fold] || fin.fold} nicht unterstützt (möglich: ${wf.forms.map((t) => FOLD_DE[t] || t).join(', ')})`);
      else {
        let folded = 0;
        for (const s of layout.surfaces) {
          const wMm = pt2mm(s.wPt), lMm = s.lengthMm || pt2mm(s.hPt);
          if (Math.min(wMm, lMm) > wf.maxWidthMm || Math.max(wMm, lMm) > wf.maxLengthMm) {
            job.warn('FINISHING', `${s.label}: ${fmtSize(wMm, lMm)} außerhalb des Faltbereichs → ungefaltet in die Ablage`);
            continue;
          }
          s.overlay.folds.push(...din824(fin.fold, s.wPt, s.hPt));
          folded++;
        }
        summary.push(`${FOLD_DE[fin.fold]}: ${folded} Blatt gefaltet auf ca. 210 × 297 mm (vereinfachte Nachbildung der Faltlinien)`);
      }
    }
    if (layout.cutMode && layout.cutMode !== 'none') summary.push(`Querschnitt nach jedem Abschnitt (${layout.cutMode})`);
    const bins = device.finisher?.bins || [];
    const bin = (ticket.outputBin && bins.find((b) => b.id === ticket.outputBin)) || (fin.fold && bins.find((b) => b.id === 'folder')) || (ticket.roll.takeUp && bins.find((b) => b.id === 'takeup')) || bins[0];
    layout.outputBin = bin ? bin.name : 'Ablage';
    summary.push(`Ablage: ${layout.outputBin}`);
  }

  if (layout.kind === 'photo') {
    summary.push(`${layout.totalSheets} Print(s) geschnitten${ticket.photo.backprint ? ', mit Rückseitendruck' : ''}`);
    layout.outputBin = (device.finisher?.bins || [])[0]?.name || 'Ausgabefach';
  }

  if (layout.kind === 'printcut') {
    summary.push(layout.mode === 'none' ? 'Nur Druck – kein Schnitt' : `Konturschnitt mit integriertem Messer: ${layout.cuts} Pfad(e), Schnittlänge ${r1(layout.cutLengthMm / 1000)} m`);
    layout.outputBin = ticket.roll.takeUp ? 'Aufwickler' : 'Medienausgabe';
  }

  for (const s of summary) job.addLog('FINISHING', s);
  layout.finishingSummary = summary;
  return { conflicts };
}

function mirrorPos(p) {
  return { 'top-left': 'top-right', 'top-right': 'top-left', 'bottom-left': 'bottom-right', 'bottom-right': 'bottom-left', 'dual-left': 'dual-right', 'dual-right': 'dual-left' }[p] || p;
}

module.exports = { applyFinishing, STAPLE_DE, FOLD_DE, din824, foldLines };
