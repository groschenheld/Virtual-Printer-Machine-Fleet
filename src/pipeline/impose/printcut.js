'use strict';
// Print & Cut (Roland TrueVIS / BN2 mit VersaWorks): Nesting auf der Rolle, Schnittmarken,
// Konturschnitt aus CutContour/PerfCutContour, Querschnitt.
const { mm2pt, pt2mm, r1, fmtSize, M } = require('../../util/misc');
const { place, newSurface } = require('./common');
const { selectRoll } = require('../media');
const { selectPages } = require('./sheet');
const { transformSubpaths, flatten } = require('../contentparser');

function rectPath(x, y, w, h) {
  return [[{ op: 'M', x, y }, { op: 'L', x: x + w, y }, { op: 'L', x: x + w, y: y + h }, { op: 'L', x, y: y + h }, { op: 'Z' }]];
}

function imposePrintCut(ctx) {
  const { job, device, catalog, pf, ticket } = ctx;
  const pages = selectPages(pf, ticket.pageRanges, job);
  const cap = device.roll;
  const mode = ticket.cut.mode || 'contour';
  const withMarks = mode !== 'none' && ticket.cut.marks !== false;
  const gap = cap.gapMm || 5;
  const mSide = device.marginsMm.left || 10;
  const mEnd = device.marginsMm.top || 10;
  const markOff = withMarks ? cap.markOffsetMm || 10 : 0;
  const markSize = withMarks ? cap.markSizeMm || 10 : 0;
  const markSpace = withMarks ? markOff + markSize : 0;
  const modeDe = { contour: 'Drucken & Konturschneiden', trimbox: 'Drucken & Schneiden an der TrimBox', 'cut-only': 'Nur Schneiden', none: 'Nur Drucken', 'print-only': 'Nur Drucken' };
  job.addLog('AUSSCHUSS', `VersaWorks-Auftrag: ${modeDe[mode] || mode}; Schnittmarken ${withMarks ? 'an' : 'aus'}; Nutzenabstand ${gap} mm; ${ticket.copies} Exemplar(e)`);

  // Nutzen sammeln
  const items = [];
  for (let c = 0; c < ticket.copies; c++) for (const pg of pages) items.push({ pg, copy: c + 1 });
  if (items.length > 500) { job.warn('AUSSCHUSS', `${items.length} Nutzen – Darstellung auf 500 begrenzt`); items.length = 500; }
  const dimsOf = (pg) => {
    const b = pg.bleed || pg.crop;
    const w = pt2mm(b[2] - b[0]), h = pt2mm(b[3] - b[1]);
    return pg.rotate === 90 || pg.rotate === 270 ? [h, w] : [w, h];
  };
  const maxMin = Math.max(...items.map((it) => Math.min(...dimsOf(it.pg))));
  const needW = maxMin + 2 * (mSide + markSpace);
  const totalArea = items.reduce((a, it) => a + dimsOf(it.pg)[0] * dimsOf(it.pg)[1], 0);
  const sel = selectRoll(device, catalog, ticket, needW, 1, job);
  if (!sel.ok) return { ok: false, media: sel };
  const W = sel.media.widthMm;
  const usable = W - 2 * (mSide + markSpace);
  // Regal-Packung (Reihen quer zur Rolle)
  const rows = [];
  let row = null;
  for (const it of items) {
    const [w0, h0] = dimsOf(it.pg);
    let best = null;
    for (const rot of [0, 90]) {
      const w = rot ? h0 : w0, h = rot ? w0 : h0;
      if (w > usable + 0.01) continue;
      const fitsRow = row && row.used + gap + w <= usable + 0.01;
      const score = (fitsRow ? 0 : 1e6) + (fitsRow ? Math.max(0, h - row.h) : h) + rot * 0.001;
      if (!best || score < best.score) best = { rot, w, h, score, fitsRow };
    }
    if (!best) return { ok: false, media: { ok: false, reason: 'media-needed', text: `Nutzen ${fmtSize(w0, h0)} breiter als nutzbare Breite ${r1(usable)} mm` } };
    if (!best.fitsRow) { row = { items: [], used: -gap, h: 0 }; rows.push(row); }
    row.items.push({ ...it, rot: best.rot, w: best.w, h: best.h, x: row.used + gap });
    row.used += gap + best.w;
    row.h = Math.max(row.h, best.h);
  }
  const areaH = rows.reduce((s, r) => s + r.h, 0) + gap * (rows.length - 1);
  const areaW = Math.max(...rows.map((r) => r.used));
  const lenMm = areaH + 2 * (mEnd + markSpace);
  const s = newSurface({ id: 'pc1', kind: 'printcut', label: `Print & Cut – ${sel.slot.name}`, wPt: mm2pt(W), hPt: mm2pt(lenMm), slotId: sel.slot.id, mediaId: sel.media.id, mediaName: sel.media.name, sheetNo: 1, feed: 'up' });
  s.overlay.areas.push({ x: 0, y: 0, w: mm2pt(mSide), h: s.hPt, kind: 'unprintable', label: 'Andruckrollen' }, { x: s.wPt - mm2pt(mSide), y: 0, w: mm2pt(mSide), h: s.hPt, kind: 'unprintable' });
  const x0 = mSide + markSpace, y0 = mEnd + markSpace; // Ursprung Nutzenbereich (mm)
  let y = y0 + areaH;
  const cutPaths = [];
  let cutCount = 0, perfCount = 0, noCut = 0;
  for (const r of rows) {
    y -= r.h;
    for (const it of r.items) {
      const rect = { x: mm2pt(x0 + it.x), y: mm2pt(y + (r.h - it.h)), w: mm2pt(it.w), h: mm2pt(it.h) };
      const b = it.pg.bleed || it.pg.crop;
      const p = place(it.pg, b, it.rot, rect, 1);
      p.clip = rect;
      p.label = `S.${it.pg.index + 1}${ticket.copies > 1 ? ' #' + it.copy : ''}${it.rot ? ' ↻' : ''}`;
      if (mode === 'cut-only') p.noPrint = true;
      if (mode !== 'none' && mode !== 'print-only') s.placements.push(p); else s.placements.push(p);
      // Schneidpfade
      if (mode === 'contour' || mode === 'cut-only') {
        const cuts = it.pg.cuts || [];
        if (!cuts.length) noCut++;
        for (const c of cuts) {
          if (c.kind === 'perf' && ticket.cut.perf === false) continue;
          cutPaths.push({ kind: c.kind, name: c.name, subpaths: transformSubpaths(c.subpaths, p.matrix), item: p.label });
          if (c.kind === 'perf') perfCount += c.subpaths.length; else cutCount += c.subpaths.length;
        }
      } else if (mode === 'trimbox') {
        const t = it.pg.trim;
        cutPaths.push({ kind: 'contour', name: 'TrimBox', subpaths: transformSubpaths(rectPath(t[0], t[1], t[2] - t[0], t[3] - t[1]), p.matrix), item: p.label });
        cutCount++;
      }
    }
    y -= gap;
  }
  if (noCut && mode === 'contour') job.warn('SCHNITT', `${noCut} Nutzen ohne CutContour/PerfCutContour – werden nur gedruckt, nicht geschnitten (VersaWorks schneidet nur Pfade in diesen Schmuckfarben)`);
  // Schnittmarken (L-förmig an den 4 Ecken + Zwischenmarken)
  let markOrigin = null;
  if (withMarks) {
    const ms = mm2pt(markSize), th = mm2pt(1);
    const L = mm2pt(x0 - markOff), R = mm2pt(x0 + areaW + markOff), B = mm2pt(y0 - markOff), T = mm2pt(y0 + areaH + markOff);
    const corner = (cx, cy, dx, dy) => {
      s.marks.push({ t: 'rect', x: dx > 0 ? cx : cx - ms, y: dy > 0 ? cy : cy - th, w: ms, h: th, fill: true });
      s.marks.push({ t: 'rect', x: dx > 0 ? cx : cx - th, y: dy > 0 ? cy : cy - ms, w: th, h: ms, fill: true });
    };
    corner(L - th, B - th, 1, 1); corner(R + th, B - th, -1, 1); corner(L - th, T + th, 1, -1); corner(R + th, T + th, -1, -1);
    let mids = 0;
    if (cap.multiMarkEveryMm && areaH > cap.multiMarkEveryMm) {
      for (let yy = cap.multiMarkEveryMm; yy < areaH; yy += cap.multiMarkEveryMm) {
        const ym = mm2pt(y0 + yy);
        s.marks.push({ t: 'rect', x: L - ms, y: ym, w: ms, h: th, fill: true }, { t: 'rect', x: R, y: ym, w: ms, h: th, fill: true });
        mids++;
      }
    }
    markOrigin = [x0 - markOff, y0 - markOff];
    job.addLog('SCHNITT', `Schnittmarken: 4 Eckmarken (${markSize} mm, Abstand ${markOff} mm zum Nutzenbereich)${mids ? ` + ${mids} Zwischenmarken-Paar(e) alle ${cap.multiMarkEveryMm} mm` : ''}. Der optische Sensor liest diese Marken vor dem Schneiden und korrigiert Versatz/Schräglauf.`);
  }
  s.overlay.cutPaths = cutPaths.map((c, i) => ({ ...c, n: i + 1 }));
  if (ticket.cut.sheetCut !== false && !ticket.roll.takeUp && mode !== 'none') {
    s.overlay.cuts.push({ x1: 0, y1: s.hPt, x2: s.wPt, y2: s.hPt, kind: 'sheet-cut', n: 1 });
  }
  s.lengthMm = lenMm;
  s.markOrigin = markOrigin;
  job.addLog('AUSSCHUSS', `Nesting: ${items.length} Nutzen in ${rows.length} Reihe(n), Nutzenbereich ${r1(areaW)} × ${r1(areaH)} mm auf ${W} mm Rolle (nutzbar ${r1(usable)} mm), Medienverbrauch ${r1(lenMm)} mm, Ausnutzung ${r1((totalArea / (W * lenMm)) * 100)} %`);
  if (mode === 'contour' || mode === 'trimbox' || mode === 'cut-only') job.addLog('SCHNITT', `Konturschnitt: ${cutCount} Kontur(en)${perfCount ? `, ${perfCount} Perforationsschnitt(e)` : ''}${ticket.cut.sheetCut !== false ? ' + Querschnitt am Jobende' : ''}`);
  const cutLen = cutPaths.reduce((a, c) => a + c.subpaths.reduce((b, sp) => {
    const { pts } = flatten(sp);
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return b + L;
  }, 0), 0);
  return {
    ok: true,
    layout: {
      kind: 'printcut', mode, surfaces: [s], sets: 1, sheetsPerSet: 1, totalSheets: 1, impressionsPerSet: mode === 'cut-only' ? 0 : 1, totalImpressions: mode === 'cut-only' ? 0 : 1,
      lengthMm: lenMm + (cap.leadTrimMm || 0), m2: (W * lenMm) / 1e6, cutLengthMm: pt2mm(cutLen), cuts: cutCount + perfCount,
      consumption: [{ slotId: sel.slot.id, mm: lenMm + (cap.leadTrimMm || 0) }],
      markOrigin,
    },
  };
}

module.exports = { imposePrintCut };
