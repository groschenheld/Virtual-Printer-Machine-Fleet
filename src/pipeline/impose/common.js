'use strict';
const { M, mm2pt, pt2mm, r1 } = require('../../util/misc');

/**
 * Platziert eine Quellseite in ein Zielrechteck.
 * pg: Preflight-Seiteninfo; box: 'crop' | 'trim' | 'bleed' | Array [l,b,r,t] (Seitenraum)
 * rot: zusätzliche Drehung (CCW, 0/90/180/270) relativ zur angezeigten Seite
 * mode: 'fit' | 'fill' | 'none' | Zahl (fester Maßstab)
 * Liefert Platzierung mit Form-Origin, Maßstab und Matrix Seitenraum -> Fläche.
 */
function place(pg, box, rot, rect, mode = 'fit', align = 'center') {
  const bbox = Array.isArray(box) ? box : pg[box] || pg.crop;
  const fw = bbox[2] - bbox[0], fh = bbox[3] - bbox[1];
  const pageRot = pg.rotate || 0;
  const formRot = (((rot - pageRot) % 360) + 360) % 360; // Form ist ungedreht, /Rotate dreht im Uhrzeigersinn
  const dispW = formRot === 90 || formRot === 270 ? fh : fw;
  const dispH = formRot === 90 || formRot === 270 ? fw : fh;
  let s;
  if (typeof mode === 'number') s = mode;
  else if (mode === 'none') s = 1;
  else if (mode === 'fill') s = Math.max(rect.w / dispW, rect.h / dispH);
  else s = Math.min(rect.w / dispW, rect.h / dispH);
  const w = dispW * s, h = dispH * s;
  let x = rect.x + (rect.w - w) / 2, y = rect.y + (rect.h - h) / 2;
  if (align === 'bottom-left') { x = rect.x; y = rect.y; }
  let ox = x, oy = y;
  if (formRot === 90) ox = x + fh * s;
  else if (formRot === 180) { ox = x + fw * s; oy = y + fh * s; }
  else if (formRot === 270) oy = y + fw * s;
  const matrix = M.mul(M.mul(M.mul(M.translate(-bbox[0], -bbox[1]), M.scale(s)), M.rotateDeg(formRot)), M.translate(ox, oy));
  return { page: pg.index, bbox, formRot, scale: s, ox, oy, rect: { x, y, w, h }, matrix };
}

function rectIntersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

function newSurface(o) {
  return {
    id: o.id, kind: o.kind, label: o.label, wPt: o.wPt, hPt: o.hPt, slotId: o.slotId || null, mediaId: o.mediaId || null, mediaName: o.mediaName || '',
    sheetNo: o.sheetNo ?? null, side: o.side || 'front', setNo: o.setNo ?? 1, printable: o.printable || { x: 0, y: 0, w: o.wPt, h: o.hPt },
    placements: [], marks: [],
    overlay: { cuts: [], cutPaths: [], folds: [], staples: [], holes: [], areas: [], notes: [], feed: o.feed || null },
  };
}

/** Nicht bedruckbare Ränder als Overlay-Flächen. */
function addUnprintable(surface, marginsMm) {
  if (!marginsMm) return;
  const { left = 0, right = 0, top = 0, bottom = 0 } = marginsMm;
  const W = surface.wPt, H = surface.hPt;
  const L = mm2pt(left), R = mm2pt(right), T = mm2pt(top), B = mm2pt(bottom);
  surface.printable = { x: L, y: B, w: W - L - R, h: H - T - B };
  const a = surface.overlay.areas;
  if (L) a.push({ x: 0, y: 0, w: L, h: H, kind: 'unprintable' });
  if (R) a.push({ x: W - R, y: 0, w: R, h: H, kind: 'unprintable' });
  if (B) a.push({ x: L, y: 0, w: W - L - R, h: B, kind: 'unprintable' });
  if (T) a.push({ x: L, y: H - T, w: W - L - R, h: T, kind: 'unprintable' });
}

/** Schnittmarken (Crop marks) an Rechteck-Kanten nach außen. */
function cropMarks(surface, rect, lenMm = 5, offMm = 2, bleedPt = 0) {
  const L = mm2pt(lenMm), O = mm2pt(offMm) + bleedPt;
  const { x, y, w, h } = rect;
  const lines = [
    [x - O - L, y, x - O, y], [x, y - O - L, x, y - O],
    [x + w + O, y, x + w + O + L, y], [x + w, y - O - L, x + w, y - O],
    [x - O - L, y + h, x - O, y + h], [x, y + h + O, x, y + h + O + L],
    [x + w + O, y + h, x + w + O + L, y + h], [x + w, y + h + O, x + w, y + h + O + L],
  ];
  for (const [x1, y1, x2, y2] of lines) surface.marks.push({ t: 'line', x1, y1, x2, y2, w: 0.25 });
}

function mmStr(pt) { return `${r1(pt2mm(pt))} mm`; }

module.exports = { place, rectIntersect, newSurface, addUnprintable, cropMarks, mmStr };
