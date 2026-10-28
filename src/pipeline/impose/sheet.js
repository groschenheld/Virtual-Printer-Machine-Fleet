'use strict';
// Ausschießen für Bogenmaschinen (Canon imagePRESS/varioPRINT, Xerox Iridesse/Versant).
const { $t, $tp, $lazy } = require('../../i18n.js');
const { mm2pt, pt2mm, r1, fmtSize } = require('../../util/misc');
const { place, newSurface, addUnprintable, cropMarks, mmStr } = require('./common');
const { selectSheet, fits } = require('../media');

function selectPages(pf, ranges, job) {
  const all = pf.pages;
  if (!ranges || !ranges.length) return all;
  const out = [];
  for (const [a, b] of ranges) for (let i = a; i <= b && i <= all.length; i++) if (all[i - 1]) out.push(all[i - 1]);
  job.addLog('AUSSCHUSS', $t(`Seitenbereich ${ranges.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(',')} → ${out.length} von ${all.length} Seiten`, `Page range ${ranges.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(',')} → ${out.length} of ${all.length} pages`));
  return out;
}

const isLand = (w, h) => w > h + 0.5;

function nUpGrid(n, sheetW, sheetH, pw, ph) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    if (n % cols) continue;
    const rows = n / cols;
    for (const rot of [0, 90]) {
      const w = rot ? ph : pw, h = rot ? pw : ph;
      const s = Math.min(sheetW / cols / w, sheetH / rows / h);
      if (!best || s > best.s + 1e-6) best = { cols, rows, rot, s };
    }
  }
  return best;
}

function imposeSheet(ctx) {
  const { job, device, catalog, pf, ticket } = ctx;
  const pages = selectPages(pf, ticket.pageRanges, job);
  if (!pages.length) throw new Error($t('Keine Seiten zu drucken', 'No pages to print'));
  let mode = ticket.imposition || 'none';
  if (mode === 'none' && ticket.numberUp > 1) mode = 'n-up';
  let duplex = ticket.sides !== 'one-sided';
  if (mode === 'booklet') duplex = true;
  if (duplex && !device.duplex) { job.warn('AUSSCHUSS', $t('Gerät kann nicht duplex – einseitiger Druck', 'Device cannot print duplex – single-sided printing')); duplex = false; }
  const p0 = pages[0];
  const p0w = pt2mm(p0.wPt), p0h = pt2mm(p0.hPt);
  const p0tw = pt2mm(p0.trimWPt), p0th = pt2mm(p0.trimHPt);
  const modeDe = { none: $t('Normal (1 Seite pro Bogenseite)', 'Normal (1 page per sheet side)'), 'n-up': $t(`${ticket.numberUp}-fach Nutzen (N-up)`, `${ticket.numberUp}-up`), booklet: $t('Broschüre (Rückstichheftung)', 'Booklet (saddle stitching)'), 'step-repeat': $t('Step & Repeat (Mehrfachnutzen gleicher Seite)', 'Step & repeat (multiple ups of the same page)') };
  job.addLog('AUSSCHUSS', $t(`Ausschießmodus: ${modeDe[mode] || mode}; ${duplex ? 'Duplex ' + (ticket.sides === 'two-sided-short-edge' ? '(kurze Kante)' : '(lange Kante)') : 'Simplex'}; Exemplare: ${ticket.copies}${ticket.copies > 1 ? (ticket.collate ? ' (sortiert)' : ' (unsortiert)') : ''}`, `Imposition mode: ${modeDe[mode] || mode}; ${duplex ? 'duplex ' + (ticket.sides === 'two-sided-short-edge' ? '(short edge)' : '(long edge)') : 'simplex'}; copies: ${ticket.copies}${ticket.copies > 1 ? (ticket.collate ? ' (collated)' : ' (uncollated)') : ''}`));

  // ---------- Materialbedarf ----------
  let need;
  if (mode === 'booklet') {
    const bw = p0.hasTrim ? p0tw : p0w, bh = p0.hasTrim ? p0th : p0h;
    need = { minFit: [2 * bw, bh] };
  } else if (mode === 'step-repeat') {
    const bl = ticket.stepRepeat.bleedMm || 0;
    need = { minFit: [p0tw + 2 * bl + 10, p0th + 2 * bl + 10], prefer: 'largest' };
  } else need = { exact: [p0w, p0h] };
  const sel = selectSheet(device, catalog, ticket, need, job);
  if (!sel.ok) return { ok: false, media: sel };
  const med = sel.media;
  job.addLog('MATERIAL', $t(`Gewählt: ${sel.slot.name} – ${med.name} (${fmtSize(med.widthMm, med.heightMm)}, ${med.gsm} g/m²)`, `Selected: ${sel.slot.name} – ${med.name} (${fmtSize(med.widthMm, med.heightMm)}, ${med.gsm} g/m²)`));
  // Bogenausrichtung: Laufrichtung kurze Kante, Fläche = Hochformat. Für Ausschießen Querformat zulassen.
  let SW = mm2pt(Math.min(med.widthMm, med.heightMm)), SH = mm2pt(Math.max(med.widthMm, med.heightMm));
  let landscapeSheet = false;
  if (mode === 'booklet' || (mode === 'none' && isLand(p0.wPt, p0.hPt))) { [SW, SH] = [SH, SW]; landscapeSheet = true; }
  const sides = [];
  const margins = device.marginsMm;
  const mkSurface = (sheetNo, side) => {
    const s = newSurface({ id: `s${sheetNo}${side[0]}`, kind: 'sheet', label: $t(`Bogen ${sheetNo} ${side === 'front' ? 'Vorderseite' : 'Rückseite'}`, `Sheet ${sheetNo} ${side === 'front' ? 'front' : 'back'}`), wPt: SW, hPt: SH, slotId: sel.slot.id, mediaId: med.id, mediaName: med.name, sheetNo, side });
    addUnprintable(s, margins);
    s.landscape = landscapeSheet;
    return s;
  };
  const scaleNotes = new Set();

  // ---------- Modi ----------
  if (mode === 'none') {
    pages.forEach((pg) => {
      const s = mkSurface(0, 'front');
      const sameOri = isLand(pg.wPt, pg.hPt) === isLand(SW, SH) || Math.abs(pg.wPt - pg.hPt) < 1;
      const rot = sameOri ? 0 : 90;
      const dw = rot ? pg.hPt : pg.wPt, dh = rot ? pg.wPt : pg.hPt;
      let m = 'none';
      if (dw > SW + 0.5 || dh > SH + 0.5) {
        m = ticket.scaling === 'none' ? 'none' : ticket.scaling === 'fill' ? 'fill' : 'fit';
        scaleNotes.add(m === 'none' ? $t(`Seite ${fmtSize(pt2mm(pg.wPt), pt2mm(pg.hPt))} größer als Bogen – wird beschnitten (Skalierung aus)`, `Page ${fmtSize(pt2mm(pg.wPt), pt2mm(pg.hPt))} larger than the sheet – will be cropped (scaling off)`) : $t(`Seite ${fmtSize(pt2mm(pg.wPt), pt2mm(pg.hPt))} wird auf Bogen eingepasst`, `Page ${fmtSize(pt2mm(pg.wPt), pt2mm(pg.hPt))} is fitted to the sheet`));
      } else if (ticket.scaling === 'fit' || ticket.scaling === 'fill') m = ticket.scaling;
      const rect = m === 'fit' && ticket.scaling === 'fit' ? s.printable : { x: 0, y: 0, w: SW, h: SH };
      const p = place(pg, 'crop', rot, rect, m);
      if (rot) scaleNotes.add($t(`Seite(n) im ${isLand(pg.wPt, pg.hPt) ? 'Quer' : 'Hoch'}format auf ${landscapeSheet ? 'Quer' : 'Hoch'}bogen → automatisch um 90° gedreht`, `Page(s) in ${isLand(pg.wPt, pg.hPt) ? 'landscape' : 'portrait'} on ${landscapeSheet ? 'landscape' : 'portrait'} sheet → automatically rotated by 90°`));
      if (Math.abs(p.scale - 1) > 0.001) scaleNotes.add($t(`Skalierung ${r1(p.scale * 100)} %`, `Scaling ${r1(p.scale * 100)} %`));
      p.clip = s.printable;
      s.placements.push(p);
      sides.push(s);
    });
  } else if (mode === 'n-up') {
    const n = Math.max(2, ticket.numberUp);
    const g = nUpGrid(n, SW, SH, p0.wPt, p0.hPt);
    const cw = SW / g.cols, ch = SH / g.rows;
    job.addLog('AUSSCHUSS', $t(`${n}-up Raster ${g.cols} × ${g.rows}, Zellen ${mmStr(cw)} × ${mmStr(ch)}, Seiten ${g.rot ? 'gedreht 90°' : 'ungedreht'}, Maßstab ${r1(g.s * 100)} %`, `${n}-up grid ${g.cols} × ${g.rows}, cells ${mmStr(cw)} × ${mmStr(ch)}, pages ${g.rot ? 'rotated 90°' : 'not rotated'}, scale ${r1(g.s * 100)} %`));
    for (let i = 0; i < pages.length; i += n) {
      const s = mkSurface(0, 'front');
      for (let k = 0; k < n && i + k < pages.length; k++) {
        const col = k % g.cols, row = Math.floor(k / g.cols);
        const rect = { x: col * cw, y: SH - (row + 1) * ch, w: cw, h: ch };
        const pg = pages[i + k];
        const p = place(pg, 'crop', g.rot, rect, 'fit');
        p.clip = s.printable;
        p.label = `S.${pg.index + 1}`;
        s.placements.push(p);
      }
      sides.push(s);
    }
  } else if (mode === 'booklet') {
    let list = pages.slice();
    const pad = (4 - (list.length % 4)) % 4;
    if (pad) job.addLog('AUSSCHUSS', $t(`Broschüre: ${list.length} Seiten → ${pad} Leerseite(n) am Ende ergänzt (Vielfaches von 4)`, `Booklet: ${list.length} pages → ${pad} blank page(s) added at the end (multiple of 4)`));
    for (let k = 0; k < pad; k++) list.push(null);
    const N = list.length, S = N / 4;
    const bw = p0.hasTrim ? p0.trimWPt : p0.wPt, bh = p0.hasTrim ? p0.trimHPt : p0.hPt;
    const box = p0.hasTrim ? 'trim' : 'crop';
    const s = Math.min(1, SW / 2 / bw, SH / bh);
    if (s < 1) scaleNotes.add($t(`Broschürenseiten auf ${r1(s * 100)} % verkleinert, damit 2 Seiten auf ${fmtSize(pt2mm(SW), pt2mm(SH))} passen`, `Booklet pages reduced to ${r1(s * 100)} % so that 2 pages fit on ${fmtSize(pt2mm(SW), pt2mm(SH))}`));
    const creep = mm2pt(ticket.booklet?.creepMm || 0);
    const pw = bw * s, ph = bh * s;
    const cx = SW / 2, y0 = (SH - ph) / 2;
    job.addLog('AUSSCHUSS', $t(`Broschüre: ${N} Seiten auf ${S} Bogen (${2 * S} Bogenseiten), Endformat ${fmtSize(pt2mm(pw), pt2mm(ph))}, Bogen ${fmtSize(pt2mm(SW), pt2mm(SH))}${creep ? `, Bundzuwachs-Ausgleich ${ticket.booklet.creepMm} mm` : ''}`, `Booklet: ${N} pages on ${S} sheets (${2 * S} sheet sides), finished size ${fmtSize(pt2mm(pw), pt2mm(ph))}, sheet ${fmtSize(pt2mm(SW), pt2mm(SH))}${creep ? `, creep compensation ${ticket.booklet.creepMm} mm` : ''}`));
    const order = [];
    for (let i = 0; i < S; i++) {
      const shift = S > 1 ? (creep * i) / (S - 1) : 0;
      const pair = (L, R, side) => {
        const surf = mkSurface(i + 1, side);
        surf.label = $t(`Bogen ${i + 1}/${S} ${side === 'front' ? 'Außenseite' : 'Innenseite'}`, `Sheet ${i + 1}/${S} ${side === 'front' ? 'outside' : 'inside'}`);
        const mk = (pi, xLeft) => {
          const pg = list[pi];
          if (!pg) { surf.placements.push({ page: -1, rect: { x: xLeft, y: y0, w: pw, h: ph }, label: $t(`Leer (S.${pi + 1})`, `Blank (p.${pi + 1})`) }); return; }
          const p = place(pg, box === 'trim' && pg.hasTrim ? 'trim' : 'crop', 0, { x: xLeft, y: y0, w: pw, h: ph }, 'fit');
          p.clip = { x: xLeft, y: y0, w: pw, h: ph };
          p.label = `S.${pi + 1}`;
          surf.placements.push(p);
        };
        mk(L, cx - pw + shift);
        mk(R, cx - shift);
        order.push($t(`${surf.label}: links S.${L + 1}, rechts S.${R + 1}`, `${surf.label}: left p.${L + 1}, right p.${R + 1}`));
        surf.booklet = { foldX: cx, pageW: pw, pageH: ph, y0, sheetIndex: i, sheets: S };
        sides.push(surf);
      };
      pair(N - 1 - 2 * i, 2 * i, 'front');
      pair(2 * i + 1, N - 2 - 2 * i, 'back');
    }
    job.addLog('AUSSCHUSS', $t('Seitenfolge (Ausschießschema)', 'Page order (imposition scheme)'), order.join('\n'));
  } else if (mode === 'step-repeat') {
    const bl = mm2pt(ticket.stepRepeat.bleedMm || 0);
    const gap = mm2pt(ticket.stepRepeat.gapMm || 0);
    const markSpace = ticket.stepRepeat.marks !== false ? mm2pt(8) : 0;
    const iw = p0.trimWPt + 2 * bl, ih = p0.trimHPt + 2 * bl;
    const avail = { x: margins.left ? mm2pt(margins.left) : 0, y: mm2pt(margins.bottom || 0), w: 0, h: 0 };
    let best = null;
    for (const [W, H, land] of [[SW, SH, landscapeSheet], [SH, SW, !landscapeSheet]]) {
      const aw = W - mm2pt((margins.left || 0) + (margins.right || 0)) - 2 * markSpace;
      const ah = H - mm2pt((margins.top || 0) + (margins.bottom || 0)) - 2 * markSpace;
      for (const rot of [0, 90]) {
        const w = rot ? ih : iw, h = rot ? iw : ih;
        const cols = Math.floor((aw + gap) / (w + gap)), rows = Math.floor((ah + gap) / (h + gap));
        if (cols < 1 || rows < 1) continue;
        if (!best || cols * rows > best.cols * best.rows) best = { W, H, land, rot, cols, rows, w, h };
      }
    }
    if (!best) throw new Error($t(`Nutzen ${fmtSize(pt2mm(iw), pt2mm(ih))} passt nicht auf ${fmtSize(pt2mm(SW), pt2mm(SH))}`, `Item ${fmtSize(pt2mm(iw), pt2mm(ih))} does not fit on ${fmtSize(pt2mm(SW), pt2mm(SH))}`));
    [SW, SH] = [best.W, best.H];
    landscapeSheet = best.land;
    const gridW = best.cols * best.w + (best.cols - 1) * gap, gridH = best.rows * best.h + (best.rows - 1) * gap;
    const gx = (SW - gridW) / 2, gy = (SH - gridH) / 2;
    const per = best.cols * best.rows;
    const sheetsNeeded = Math.ceil(ticket.copies / per);
    job.addLog('AUSSCHUSS', $t(`Step & Repeat: Nutzen ${fmtSize(pt2mm(p0.trimWPt), pt2mm(p0.trimHPt))} + ${ticket.stepRepeat.bleedMm} mm Anschnitt, Raster ${best.cols} × ${best.rows} = ${per} Nutzen/Bogen${best.rot ? ' (gedreht)' : ''}, Bogen ${landscapeSheet ? 'quer' : 'hoch'}; ${ticket.copies} Stück → ${sheetsNeeded} Bogen`, `Step & repeat: item ${fmtSize(pt2mm(p0.trimWPt), pt2mm(p0.trimHPt))} + ${ticket.stepRepeat.bleedMm} mm bleed, grid ${best.cols} × ${best.rows} = ${per} ups/sheet${best.rot ? ' (rotated)' : ''}, sheet ${landscapeSheet ? 'landscape' : 'portrait'}; ${ticket.copies} pieces → ${sheetsNeeded} sheets`));
    avail.w = gridW; avail.h = gridH;
    const docPages = pages.length > 2 && !duplex ? pages : pages.slice(0, duplex ? 2 : 1);
    for (let pi = 0; pi < docPages.length; pi++) {
      const pg = docPages[pi];
      const s = mkSurface(0, 'front');
      s.wPt = SW; s.hPt = SH;
      s.overlay.areas = []; addUnprintable(s, margins);
      const xs = [], ys = [];
      for (let r = 0; r < best.rows; r++) for (let c = 0; c < best.cols; c++) {
        const x = gx + c * (best.w + gap), y = gy + r * (best.h + gap);
        const cellTrim = { x: x + bl, y: y + bl, w: best.w - 2 * bl, h: best.h - 2 * bl };
        const bbox = [pg.trim[0] - bl, pg.trim[1] - bl, pg.trim[2] + bl, pg.trim[3] + bl];
        const p = place(pg, bbox, best.rot, { x, y, w: best.w, h: best.h }, 1);
        p.clip = { x, y, w: best.w, h: best.h };
        p.label = $t(`Nutzen ${(best.rows - 1 - r) * best.cols + c + 1}`, `Item ${(best.rows - 1 - r) * best.cols + c + 1}`);
        s.placements.push(p);
        xs.push(cellTrim.x, cellTrim.x + cellTrim.w); ys.push(cellTrim.y, cellTrim.y + cellTrim.h);
      }
      // Schnittlinien (Schneidemaschine) und Schnittmarken
      const ux = Array.from(new Set(xs.map((v) => Math.round(v * 100) / 100))).sort((a, b) => a - b);
      const uy = Array.from(new Set(ys.map((v) => Math.round(v * 100) / 100))).sort((a, b) => a - b);
      let n = 1;
      for (const y of uy) s.overlay.cuts.push({ x1: 0, y1: y, x2: SW, y2: y, kind: 'guillotine', n: n++ });
      for (const x of ux) s.overlay.cuts.push({ x1: x, y1: 0, x2: x, y2: SH, kind: 'guillotine', n: n++ });
      if (ticket.stepRepeat.marks !== false) {
        const L = mm2pt(5), O = mm2pt(2);
        const top = gy + gridH, bot = gy, left = gx, right = gx + gridW;
        for (const x of ux) { s.marks.push({ t: 'line', x1: x, y1: top + O, x2: x, y2: top + O + L, w: 0.25 }); s.marks.push({ t: 'line', x1: x, y1: bot - O, x2: x, y2: bot - O - L, w: 0.25 }); }
        for (const y of uy) { s.marks.push({ t: 'line', x1: left - O - L, y1: y, x2: left - O, y2: y, w: 0.25 }); s.marks.push({ t: 'line', x1: right + O, y1: y, x2: right + O + L, y2: y, w: 0.25 }); }
      }
      s.stepRepeat = { perSheet: per, sheetsNeeded, cuts: ux.length + uy.length };
      sides.push(s);
    }
    job.addLog('SCHNITT', $t(`Schneidemaschine (nach dem Druck): ${ux_len(sides[0])} Schnitte je Stapel – ${sides[0].overlay.cuts.filter((c) => c.x1 === c.x2).length} senkrecht, ${sides[0].overlay.cuts.filter((c) => c.y1 === c.y2).length} waagerecht (Schnittfolge im Nachweis nummeriert)`, `Guillotine (after printing): ${ux_len(sides[0])} cuts per stack – ${sides[0].overlay.cuts.filter((c) => c.x1 === c.x2).length} vertical, ${sides[0].overlay.cuts.filter((c) => c.y1 === c.y2).length} horizontal (cut order numbered in the proof)`));
  } else {
    throw new Error($t(`Unbekannter Ausschießmodus ${mode}`, `Unknown imposition mode ${mode}`));
  }
  if (scaleNotes.size) job.addLog('AUSSCHUSS', Array.from(scaleNotes).join('; '));

  // ---------- Bogen bilden (Duplex) ----------
  const surfaces = [];
  let sheetNo = 0;
  if (mode === 'booklet') {
    surfaces.push(...sides);
    sheetNo = sides.length / 2;
  } else if (duplex) {
    for (let i = 0; i < sides.length; i += 2) {
      sheetNo++;
      const f = sides[i]; f.sheetNo = sheetNo; f.side = 'front'; f.id = `s${sheetNo}f`; f.label = $t(`Bogen ${sheetNo} Vorderseite`, `Sheet ${sheetNo} front`);
      surfaces.push(f);
      const b = sides[i + 1] || (() => { const e = mkSurface(sheetNo, 'back'); e.wPt = f.wPt; e.hPt = f.hPt; return e; })();
      b.sheetNo = sheetNo; b.side = 'back'; b.id = `s${sheetNo}b`; b.label = $t(`Bogen ${sheetNo} Rückseite`, `Sheet ${sheetNo} back`);
      if (ticket.sides === 'two-sided-short-edge') b.tumble = true;
      surfaces.push(b);
    }
  } else {
    for (const s of sides) { sheetNo++; s.sheetNo = sheetNo; s.side = 'front'; s.id = `s${sheetNo}f`; s.label = $t(`Bogen ${sheetNo}`, `Sheet ${sheetNo}`); surfaces.push(s); }
  }
  const sr = surfaces[0] && surfaces[0].stepRepeat;
  const sheetsPerSet = sr ? sr.sheetsNeeded : sheetNo;
  const sets = sr ? 1 : ticket.copies;
  const impressionsPerSet = surfaces.filter((s) => s.placements.some((p) => p.page >= 0)).length * (sr ? sr.sheetsNeeded / Math.max(1, sheetNo) : 1);
  return {
    ok: true,
    layout: {
      kind: 'sheet', mode, duplex, surfaces, slot: sel.slot.id, media: med.id,
      sheet: { wMm: pt2mm(SW), hMm: pt2mm(SH), landscape: landscapeSheet },
      sheetsPerSet, sets, totalSheets: sheetsPerSet * sets, impressionsPerSet, totalImpressions: Math.round(impressionsPerSet * sets),
      consumption: [{ slotId: sel.slot.id, mediaId: med.id, sheets: sheetsPerSet * sets }],
    },
  };
}

function ux_len(s) { return s ? s.overlay.cuts.length : 0; }

module.exports = { imposeSheet, selectPages };
