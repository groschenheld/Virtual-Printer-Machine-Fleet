'use strict';
// Erzeugt die Ausgabedateien:
//  ausgabe.pdf  – was die Maschine druckt (ausgeschossene Bogen/Rollenabschnitte inkl. RIP-Marken)
//  nachweis.pdf – dasselbe mit ein-/ausblendbaren Ebenen: Schnitt, Falz, Heftung/Lochung, Nutzen, Abfall, Info
//  layout.json  – Geometrie für die Oberfläche
//  schnitt.camm – Schneiddaten (Print & Cut)
const fs = require('fs');
const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFHexString, PDFOperator, PDFOperatorNames,
  pushGraphicsState, popGraphicsState, rectangle, clip, endPath, moveTo, lineTo, appendBezierCurve, closePath, stroke,
  setLineWidth, setStrokingRgbColor, setDashPattern, concatTransformationMatrix } = require('../vendor/pdf-lib');
const { mm2pt, pt2mm, r1, pdfSafe, fmtSize } = require('../util/misc');
const { flatten } = require('./contentparser');

const C = {
  cut: rgb(0.86, 0.08, 0.12), perf: rgb(0.86, 0.08, 0.12), trim: rgb(0.95, 0.45, 0), fold: rgb(0.1, 0.35, 0.9),
  staple: rgb(0.05, 0.45, 0.2), hole: rgb(0.75, 0, 0.6), place: rgb(0, 0.6, 0.75), info: rgb(0.15, 0.15, 0.18),
  frame: rgb(0.93, 0.93, 0.94), waste: rgb(0.55, 0.55, 0.58), unprint: rgb(0.7, 0.7, 0.72), sheet: rgb(1, 1, 1), mark: rgb(0, 0, 0),
};
const LAYERS = ['Druckbild', 'Nicht druckbar / Abfall', 'Nutzen & Seiten', 'Schnitt', 'Falz', 'Heftung & Lochung', 'Info'];

function setupOCGs(doc) {
  const ctx = doc.context;
  const refs = LAYERS.map((n) => ctx.register(ctx.obj({ Type: 'OCG', Name: PDFHexString.fromText(n) })));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: refs, D: { Name: PDFHexString.fromText('Simulationsebenen'), Order: refs, ON: refs } }));
  return refs;
}

function bindPageOCGs(doc, page, refs) {
  const props = doc.context.obj({});
  refs.forEach((r, i) => props.set(PDFName.of(`L${i}`), r));
  page.node.Resources().set(PDFName.of('Properties'), props);
}
const beginLayer = (page, i) => page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), PDFName.of(`L${i}`)]));
const endLayer = (page) => page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));

function pathOps(subpaths, dx, dy) {
  const ops = [];
  for (const sp of subpaths) for (const s of sp) {
    if (s.op === 'M') ops.push(moveTo(s.x + dx, s.y + dy));
    else if (s.op === 'L') ops.push(lineTo(s.x + dx, s.y + dy));
    else if (s.op === 'C') ops.push(appendBezierCurve(s.x1 + dx, s.y1 + dy, s.x2 + dx, s.y2 + dy, s.x + dx, s.y + dy));
    else if (s.op === 'Z') ops.push(closePath());
  }
  return ops;
}

class Embedder {
  constructor(out, srcDoc) { this.out = out; this.src = srcDoc; this.cache = new Map(); }
  async get(pageIndex, bbox) {
    const key = `${pageIndex}|${bbox.map((v) => v.toFixed(3)).join(',')}`;
    if (!this.cache.has(key)) {
      const page = this.src.getPage(pageIndex);
      this.cache.set(key, await this.out.embedPage(page, { left: bbox[0], bottom: bbox[1], right: bbox[2], top: bbox[3] }));
    }
    return this.cache.get(key);
  }
}

async function drawContent(page, emb, surface, dx, dy, font) {
  for (const p of surface.placements) {
    if (p.page < 0 || p.noPrint) continue;
    const form = await emb.get(p.page, p.bbox);
    const ops = [pushGraphicsState()];
    if (p.clip) ops.push(rectangle(p.clip.x + dx, p.clip.y + dy, p.clip.w, p.clip.h), clip(), endPath());
    page.pushOperators(...ops);
    page.drawPage(form, { x: p.ox + dx, y: p.oy + dy, xScale: p.scale, yScale: p.scale, rotate: degrees(p.formRot) });
    page.pushOperators(popGraphicsState());
  }
  for (const m of surface.marks) {
    if (m.t === 'line') page.drawLine({ start: { x: m.x1 + dx, y: m.y1 + dy }, end: { x: m.x2 + dx, y: m.y2 + dy }, thickness: m.w || 0.25, color: C.mark });
    else if (m.t === 'rect') page.drawRectangle({ x: m.x + dx, y: m.y + dy, width: m.w, height: m.h, color: C.mark });
    else if (m.t === 'text') page.drawText(pdfSafe(m.text), { x: m.x + dx, y: m.y + dy, size: m.size || 6, font, color: C.mark });
  }
}

function label(page, font, text, x, y, size, color) {
  page.drawText(pdfSafe(text), { x, y, size, font, color: color || C.info });
}

function badge(page, font, n, x, y, color) {
  const t = String(n);
  const w = font.widthOfTextAtSize(t, 6) + 4;
  page.drawRectangle({ x: x - w / 2, y: y - 4, width: w, height: 8, color: rgb(1, 1, 1), borderColor: color, borderWidth: 0.5 });
  page.drawText(t, { x: x - w / 2 + 2, y: y - 2.2, size: 6, font, color });
}

async function renderOutputs(ctx, layout) {
  const { job, device, pf } = ctx;
  const out = await PDFDocument.create();
  const proof = await PDFDocument.create();
  out.setTitle(`${job.name} – Ausgabe ${device.name}`);
  out.setProducer('Virtual Print Fleet (Simulation)');
  proof.setTitle(`${job.name} – Nachweis ${device.name}`);
  proof.setProducer('Virtual Print Fleet (Simulation)');
  const fontO = await out.embedFont(StandardFonts.Helvetica);
  const font = await proof.embedFont(StandardFonts.Helvetica);
  const fontB = await proof.embedFont(StandardFonts.HelveticaBold);
  const embO = new Embedder(out, pf.doc);
  const embP = new Embedder(proof, pf.doc);
  const refs = setupOCGs(proof);
  const F = mm2pt(12), HEAD = mm2pt(16), FOOT = mm2pt(10);

  for (const [si, s] of layout.surfaces.entries()) {
    // ---------- Ausgabe
    const po = out.addPage([s.wPt, s.hPt]);
    await drawContent(po, embO, s, 0, 0, fontO);

    // ---------- Nachweis
    const W = s.wPt + 2 * F, H = s.hPt + F + HEAD + FOOT;
    const pp = proof.addPage([Math.max(W, mm2pt(180)), H]);
    bindPageOCGs(proof, pp, refs);
    const dx = F, dy = FOOT;
    pp.drawRectangle({ x: 0, y: 0, width: pp.getWidth(), height: H, color: C.frame });
    pp.drawRectangle({ x: dx, y: dy, width: s.wPt, height: s.hPt, color: C.sheet, borderColor: rgb(0.3, 0.3, 0.3), borderWidth: 0.6 });

    beginLayer(pp, 0);
    await drawContent(pp, embP, s, dx, dy, font);
    endLayer(pp);

    beginLayer(pp, 1);
    for (const a of s.overlay.areas) {
      const col = a.kind === 'waste' ? C.waste : a.kind === 'overspill' ? C.trim : C.unprint;
      if (a.kind === 'overspill') pp.drawRectangle({ x: a.x + dx, y: a.y + dy, width: a.w, height: a.h, borderColor: col, borderWidth: 0.8, borderDashArray: [2, 2] });
      else pp.drawRectangle({ x: a.x + dx, y: a.y + dy, width: a.w, height: a.h, color: col, opacity: a.kind === 'waste' ? 0.35 : 0.3 });
      if (a.label && a.w > 40 && a.h > 8) label(pp, font, a.label, a.x + dx + 2, a.y + dy + Math.min(a.h - 7, 3), 5, C.info);
    }
    endLayer(pp);

    beginLayer(pp, 2);
    for (const p of s.placements) {
      const r = p.rect;
      pp.drawRectangle({ x: r.x + dx, y: r.y + dy, width: r.w, height: r.h, borderColor: C.place, borderWidth: 0.4, borderDashArray: [1.5, 1.5], opacity: 0, borderOpacity: 0.9 });
      if (p.label && r.w > 20) label(pp, font, p.label + (p.noPrint ? ' (nicht gedruckt)' : '') + (p.formRot ? ` ${p.formRot}°` : '') + (p.scale && Math.abs(p.scale - 1) > 0.001 ? ` ${r1(p.scale * 100)}%` : ''), r.x + dx + 2, r.y + dy + r.h - 7, 5.5, C.place);
    }
    endLayer(pp);

    beginLayer(pp, 3);
    for (const c of s.overlay.cuts) {
      const col = c.kind === 'face-trim' ? C.trim : C.cut;
      pp.drawLine({ start: { x: c.x1 + dx, y: c.y1 + dy }, end: { x: c.x2 + dx, y: c.y2 + dy }, thickness: c.kind === 'guillotine' ? 0.5 : 0.9, color: col, dashArray: c.kind === 'face-trim' ? [4, 2] : undefined });
      if (c.n && c.kind === 'guillotine') badge(pp, font, c.n, c.x1 === c.x2 ? c.x1 + dx : dx - 6, c.x1 === c.x2 ? s.hPt + dy + 6 : c.y1 + dy, col);
    }
    for (const c of s.overlay.cutPaths) {
      const ops = [pushGraphicsState(), setStrokingRgbColor(0.86, 0.08, 0.12), setLineWidth(0.8)];
      if (c.kind === 'perf') ops.push(setDashPattern([3, 2], 0));
      pp.pushOperators(...ops, ...pathOps(c.subpaths, dx, dy), stroke(), popGraphicsState());
    }
    if (s.overlay.cutPaths.length) {
      // Schnittreihenfolge
      s.overlay.cutPaths.forEach((c, i) => {
        const sp = c.subpaths[0];
        if (sp && sp[0]) badge(pp, font, i + 1, sp[0].x + dx, sp[0].y + dy, C.cut);
      });
    }
    endLayer(pp);

    beginLayer(pp, 4);
    for (const f of s.overlay.folds) {
      pp.drawLine({ start: { x: f.x1 + dx, y: f.y1 + dy }, end: { x: f.x2 + dx, y: f.y2 + dy }, thickness: 0.9, color: C.fold, dashArray: f.kind === 'mountain' ? [6, 2, 1, 2] : [4, 3] });
      if (f.n) badge(pp, font, f.n, (f.x1 + f.x2) / 2 + dx, (f.y1 + f.y2) / 2 + dy, C.fold);
    }
    endLayer(pp);

    beginLayer(pp, 5);
    for (const st of s.overlay.staples) {
      const a = (st.angle * Math.PI) / 180, hx = (Math.cos(a) * st.len) / 2, hy = (Math.sin(a) * st.len) / 2;
      pp.drawLine({ start: { x: st.x - hx + dx, y: st.y - hy + dy }, end: { x: st.x + hx + dx, y: st.y + hy + dy }, thickness: 2.2, color: C.staple });
    }
    for (const h of s.overlay.holes) pp.drawCircle({ x: h.x + dx, y: h.y + dy, size: h.r, borderColor: C.hole, borderWidth: 0.8, color: rgb(1, 0.9, 0.97) });
    endLayer(pp);

    beginLayer(pp, 6);
    const head = `${device.name}  ·  ${s.label}  ·  ${s.mediaName || ''}`;
    label(pp, fontB, head, dx, H - mm2pt(7), 8);
    const sub = `Fläche ${fmtSize(pt2mm(s.wPt), pt2mm(s.hPt))}  ·  Job ${job.id} „${job.name}"  ·  ${si + 1}/${layout.surfaces.length}${s.side === 'back' ? '  ·  Rückseite (von hinten gesehen)' : ''}${s.tumble ? '  ·  Wenden an kurzer Kante' : ''}`;
    label(pp, font, sub, dx, H - mm2pt(12), 6.5);
    if (s.overlay.feed === 'up') {
      const ax = dx - mm2pt(6), ay0 = dy + s.hPt * 0.4, ay1 = ay0 + mm2pt(14);
      pp.drawLine({ start: { x: ax, y: ay0 }, end: { x: ax, y: ay1 }, thickness: 1, color: C.info });
      pp.drawLine({ start: { x: ax, y: ay1 }, end: { x: ax - 2.5, y: ay1 - 4 }, thickness: 1, color: C.info });
      pp.drawLine({ start: { x: ax, y: ay1 }, end: { x: ax + 2.5, y: ay1 - 4 }, thickness: 1, color: C.info });
      label(pp, font, 'Vorschub', ax - 10, ay0 - 8, 5);
    }
    if (s.backprint) label(pp, font, `Rückseitendruck: ${s.backprint}`, dx, dy - mm2pt(4), 6);
    for (const n of s.overlay.notes) if (n.text) label(pp, font, n.text, n.x + dx, n.y + dy, 5.5, C.trim);
    const legend = 'Legende: rot = Schnitt/Kontur (gestrichelt = Perforation) · orange = Frontbeschnitt/Überdruck · blau = Falz (Strich-Punkt = Bergfalz) · grün = Heftklammer · magenta = Lochung · grau = nicht bedruckbar/Abfall';
    label(pp, font, legend, dx, mm2pt(3.5), 5);
    endLayer(pp);
  }
  const ausgabe = await out.save();
  const nachweis = await proof.save();
  fs.writeFileSync(job.file('ausgabe.pdf'), ausgabe);
  fs.writeFileSync(job.file('nachweis.pdf'), nachweis);
  job.outputs.ausgabe = 'ausgabe.pdf';
  job.outputs.nachweis = 'nachweis.pdf';
  job.addLog('AUSGABE', `ausgabe.pdf (${layout.surfaces.length} Seite(n), ${(ausgabe.length / 1024).toFixed(0)} KB) und nachweis.pdf mit Ebenen (${LAYERS.join(', ')}) erzeugt`);

  // Layout für die UI
  const ui = {
    kind: layout.kind, mode: layout.mode, outputBin: layout.outputBin, finishingSummary: layout.finishingSummary,
    surfaces: layout.surfaces.map((s) => ({
      id: s.id, label: s.label, kind: s.kind, wPt: s.wPt, hPt: s.hPt, side: s.side, sheetNo: s.sheetNo, slotId: s.slotId, mediaName: s.mediaName, printable: s.printable, backprint: s.backprint || null, tumble: !!s.tumble,
      placements: s.placements.map((p) => ({ page: p.page, rect: p.rect, label: p.label, rot: p.formRot, scale: p.scale, noPrint: !!p.noPrint })),
      overlay: s.overlay,
    })),
  };
  fs.writeFileSync(job.file('layout.json'), JSON.stringify(ui));
  job.outputs.layout = 'layout.json';

  // Schneiddatei
  if (layout.kind === 'printcut') {
    const s = layout.surfaces[0];
    if (s.overlay.cutPaths.length) {
      const camm = buildCammGl(s, device, job);
      fs.writeFileSync(job.file('schnitt.camm'), camm);
      job.outputs.cut = 'schnitt.camm';
    }
  }
}

/** CAMM-GL-III-artige Schneiddaten (1 Einheit = 0,025 mm), Ursprung = linke untere Schnittmarke. */
function buildCammGl(surface, device, job) {
  const cc = device.finisher.modules.contourCutter || {};
  const origin = surface.markOrigin ? surface.markOrigin.map(mm2pt) : [0, 0];
  const U = (pt) => Math.round(pt2mm(pt) * 40);
  const polys = [];
  for (const c of surface.overlay.cutPaths) for (const sp of c.subpaths) {
    const { pts } = flatten(sp);
    if (pts.length > 1) polys.push({ kind: c.kind, pts: pts.map(([x, y]) => [U(x - origin[0]), U(y - origin[1])]) });
  }
  // Reihenfolge: nächster Nachbar ab Ursprung, Perforation zuerst (wie üblich, damit Konturen nicht verrutschen)
  const ordered = [];
  let cur = [0, 0];
  const pool = polys.slice().sort((a, b) => (a.kind === 'perf' ? -1 : 0) - (b.kind === 'perf' ? -1 : 0));
  for (const kind of ['perf', 'contour']) {
    let rest = pool.filter((p) => p.kind === kind);
    while (rest.length) {
      let bi = 0, bd = Infinity;
      rest.forEach((p, i) => { const d = Math.hypot(p.pts[0][0] - cur[0], p.pts[0][1] - cur[1]); if (d < bd) { bd = d; bi = i; } });
      const p = rest.splice(bi, 1)[0];
      ordered.push(p);
      cur = p.pts[p.pts.length - 1];
    }
  }
  const lines = ['IN;', `VS${cc.speedCmS || 30};`];
  const CUT = 3 * 40, GAP = 1.5 * 40; // Perforation: 3 mm schneiden, 1,5 mm stehen lassen
  for (const p of ordered) {
    lines.push(`PU${p.pts[0][0]},${p.pts[0][1]};`);
    if (p.kind !== 'perf') { lines.push('PD' + p.pts.slice(1).map((q) => `${q[0]},${q[1]}`).join(',') + ';'); continue; }
    let down = true, left = CUT;
    for (let i = 1; i < p.pts.length; i++) {
      let [x0, y0] = p.pts[i - 1];
      const [x1, y1] = p.pts[i];
      let seg = Math.hypot(x1 - x0, y1 - y0);
      while (seg > 0) {
        const step = Math.min(seg, left);
        const t = step / seg;
        x0 = Math.round(x0 + (x1 - x0) * t); y0 = Math.round(y0 + (y1 - y0) * t);
        lines.push(`${down ? 'PD' : 'PU'}${x0},${y0};`);
        seg -= step; left -= step;
        if (left <= 0) { down = !down; left = down ? CUT : GAP; }
      }
    }
  }
  lines.push('PU0,0;');
  job.addLog('SCHNITT', `Schneiddaten erzeugt: ${ordered.length} Polylinien (${ordered.filter((p) => p.kind === 'perf').length} Perforation zuerst, als 3/1,5-mm-Schnittfolge), Reihenfolge nach kürzestem Leerweg; Einheiten 0,025 mm ab linker unterer Schnittmarke → schnitt.camm`);
  return lines.join('\n') + '\n';
}

module.exports = { renderOutputs, LAYERS };
