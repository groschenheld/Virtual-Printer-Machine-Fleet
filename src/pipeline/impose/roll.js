'use strict';
// Rollen-Layout für Großformat (Canon colorWAVE, Epson SureColor) und Foto-Minilabs (Epson SureLab).
const { mm2pt, pt2mm, r1, fmtSize } = require('../../util/misc');
const { place, newSurface } = require('./common');
const { selectRoll, rollsOf } = require('../media');
const { selectPages } = require('./sheet');

const DIN_LENGTHS = [210, 297, 420, 594, 841, 1189];

function imposeWide(ctx) {
  const { job, device, catalog, pf, ticket } = ctx;
  const pages = selectPages(pf, ticket.pageRanges, job);
  const cap = device.roll;
  const borderless = !!(ticket.roll.borderless && cap.borderless);
  const m = borderless ? 0 : device.marginsMm.left || 0;
  const mEnd = borderless ? 0 : device.marginsMm.top || 0;
  const nesting = ticket.roll.nesting === true && cap.nesting;
  const allowRot = ticket.roll.rotate !== 0 && ticket.roll.rotate !== '0' && ticket.roll.rotate !== 'none';
  const cutMode = ticket.roll.takeUp ? 'none' : (ticket.roll.cut === 'auto' ? (device.finisher.modules.cutter?.modes || ['auto'])[0] : ticket.roll.cut);
  job.addLog('AUSSCHUSS', `Rollenmodus: ${nesting ? 'Nesting (mehrere Seiten nebeneinander)' : 'eine Seite je Abschnitt'}; Drehung ${allowRot ? 'automatisch' : 'aus'}; ${borderless ? 'randlos' : `Ränder ${m} mm seitlich / ${mEnd} mm Anfang/Ende`}; Schnitt: ${cutMode}`);
  const loaded = rollsOf(device, catalog).filter((r) => r.media);
  if (!loaded.length) return { ok: false, media: { ok: false, reason: 'media-empty', text: 'Keine Rolle geladen' } };
  const surfaces = [];
  const consumption = new Map();
  let totalLen = 0;
  const addCons = (slot, mm) => { consumption.set(slot.id, (consumption.get(slot.id) || 0) + mm); totalLen += mm; };
  const leadTrim = cap.leadTrimMm || 0;
  const folds = ticket.finishing.fold;

  if (!nesting) {
    let segNo = 0;
    for (const pg of pages) {
      const pw = pt2mm(pg.wPt), ph = pt2mm(pg.hPt);
      // Varianten: Ausrichtung × Rolle
      const opts = [];
      for (const rot of allowRot ? [0, 90] : [0]) {
        const across = rot ? ph : pw, along = rot ? pw : ph;
        for (const r of loaded) {
          if (r.media.widthMm + 0.01 >= across + (ticket.roll.addMargins ? 2 * m : 0)) opts.push({ rot, across, along, r, waste: r.media.widthMm - across });
        }
      }
      const forcedSource = ticket.media.source;
      let candidates = opts;
      if (forcedSource) candidates = opts.filter((o) => o.r.slot.id === forcedSource || o.r.slot.ippSource === forcedSource);
      if (ticket.media.mediaId) candidates = candidates.filter((o) => o.r.media.id === ticket.media.mediaId);
      if (ticket.media.type) candidates = candidates.filter((o) => o.r.media.type === ticket.media.type || o.r.media.ippType === ticket.media.type);
      candidates.sort((a, b) => a.r.media.widthMm - b.r.media.widthMm || a.along - b.along);
      let pick = candidates[0];
      const label = `für Seite ${pg.index + 1} (${fmtSize(pw, ph)})`;
      if (!pick) {
        // Kacheln oder Skalieren?
        const widest = loaded.slice().sort((a, b) => b.media.widthMm - a.media.widthMm)[0];
        if (ticket.roll.tiling || ticket.scaling === 'fit') {
          pick = { rot: pw > ph && allowRot ? 90 : 0, r: widest };
          pick.across = pick.rot ? ph : pw; pick.along = pick.rot ? pw : ph;
          pick.oversize = true;
        } else {
          selectRoll(device, catalog, ticket, Math.min(pw, ph) + 2 * m, Math.max(pw, ph), job, label);
          return { ok: false, media: { ok: false, reason: 'media-needed', text: `Keine Rolle ≥ ${r1(Math.min(pw, ph) + 2 * m)} mm geladen (Seite ${pg.index + 1}, ${fmtSize(pw, ph)})`, wanted: { widthMm: Math.min(pw, ph) + 2 * m } } };
        }
      }
      const sel = selectRoll(device, catalog, { ...ticket, media: { ...ticket.media, source: pick.r.slot.id } }, pick.oversize ? 0 : pick.across + (ticket.roll.addMargins ? 2 * m : 0), (pick.along + leadTrim) * ticket.copies, job, label);
      if (!sel.ok) return { ok: false, media: sel };
      const W = pick.r.media.widthMm;
      if (pick.rot) job.addLog('AUSSCHUSS', `Seite ${pg.index + 1} um 90° gedreht → ${r1(pick.across)} mm quer zur Rolle (spart Rollenbreite)`);
      // Kacheln
      const usable = W - 2 * m;
      const tiles = [];
      if (pick.oversize && ticket.roll.tiling) {
        const ov = ticket.roll.overlapMm || 10;
        const n = Math.ceil((pick.across - ov) / (usable - ov));
        for (let t = 0; t < n; t++) tiles.push({ offsetMm: t * (usable - ov), widthMm: Math.min(usable, pick.across - t * (usable - ov)) });
        job.warn('AUSSCHUSS', `Seite ${pg.index + 1} breiter als Rolle (${r1(pick.across)} > ${usable} mm) → ${n} Kacheln à max. ${usable} mm mit ${ov} mm Überlappung`);
      } else tiles.push({ offsetMm: 0, widthMm: pick.across });
      let scale = 1;
      if (pick.oversize && !ticket.roll.tiling) {
        scale = usable / pick.across;
        job.warn('AUSSCHUSS', `Seite ${pg.index + 1} auf ${r1(scale * 100)} % verkleinert, um auf ${W} mm Rolle zu passen`);
      }
      for (const tile of tiles) {
        segNo++;
        let lenMm = pick.along * scale + (ticket.roll.addMargins ? 2 * mEnd : 0);
        if (cutMode === 'standard') {
          const std = DIN_LENGTHS.find((d) => d >= lenMm - 0.5);
          if (std && std !== Math.round(lenMm)) job.addLog('SCHNITT', `Formatschnitt: Länge ${r1(lenMm)} mm → Normlänge ${std} mm`);
          if (std) lenMm = std;
        }
        if (cap.maxLengthMm && lenMm > cap.maxLengthMm) job.warn('AUSSCHUSS', `Abschnitt ${r1(lenMm)} mm länger als max. ${cap.maxLengthMm} mm`);
        const s = newSurface({ id: `r${segNo}`, kind: 'roll', label: `Abschnitt ${segNo} – ${pick.r.slot.name}`, wPt: mm2pt(W), hPt: mm2pt(lenMm), slotId: pick.r.slot.id, mediaId: pick.r.media.id, mediaName: pick.r.media.name, sheetNo: segNo, feed: 'up' });
        const pr = { x: mm2pt(m), y: mm2pt(borderless ? 0 : mEnd), w: mm2pt(usable), h: mm2pt(lenMm - (borderless ? 0 : 2 * mEnd)) };
        s.printable = pr;
        if (!borderless) {
          s.overlay.areas.push({ x: 0, y: 0, w: mm2pt(m), h: s.hPt, kind: 'unprintable' }, { x: s.wPt - mm2pt(m), y: 0, w: mm2pt(m), h: s.hPt, kind: 'unprintable' });
          if (mEnd) s.overlay.areas.push({ x: mm2pt(m), y: 0, w: pr.w, h: mm2pt(mEnd), kind: 'unprintable' }, { x: mm2pt(m), y: s.hPt - mm2pt(mEnd), w: pr.w, h: mm2pt(mEnd), kind: 'unprintable' });
        }
        const yOff = ticket.roll.addMargins ? mm2pt(mEnd) : 0;
        const dispW = pick.across * scale, dispH = pick.along * scale;
        const xLeft = tiles.length > 1 ? mm2pt(m - tile.offsetMm) : (ticket.roll.addMargins ? mm2pt(m) : 0);
        if (segNo === 1 && !borderless && !ticket.roll.addMargins && m) job.addLog('AUSSCHUSS', `Druckbild beginnt an der Rollenkante – Inhalte in den ${m} mm Randbereichen werden nicht gedruckt (Option „Ränder hinzufügen" würde die Länge um ${2 * mEnd} mm verlängern)`);
        const p = place(pg, 'crop', pick.rot, { x: xLeft, y: yOff, w: mm2pt(dispW), h: mm2pt(dispH) }, scale === 1 ? 1 : 'fit', 'bottom-left');
        p.clip = tiles.length > 1 ? { x: mm2pt(m), y: 0, w: mm2pt(tile.widthMm), h: s.hPt } : pr;
        p.label = `S.${pg.index + 1}${tiles.length > 1 ? ` Kachel ${tiles.indexOf(tile) + 1}/${tiles.length}` : ''}`;
        s.placements.push(p);
        const usedW = tiles.length > 1 ? tile.widthMm + m : (ticket.roll.addMargins ? dispW + 2 * m : dispW);
        if (W - usedW > 1) s.overlay.areas.push({ x: mm2pt(usedW), y: 0, w: mm2pt(W - usedW), h: s.hPt, kind: 'waste', label: `Restbreite ${r1(W - usedW)} mm` });
        if (cutMode !== 'none') {
          s.overlay.cuts.push({ x1: 0, y1: s.hPt, x2: s.wPt, y2: s.hPt, kind: 'roll-cut', n: 1 });
        }
        s.lengthMm = lenMm;
        s.rot = pick.rot;
        surfaces.push(s);
        addCons(pick.r.slot, lenMm * ticket.copies);
        job.addLog('AUSSCHUSS', `Abschnitt ${segNo}: ${pick.r.slot.name} (${W} mm) – Länge ${r1(lenMm)} mm, Druckbild ${r1(dispW)} × ${r1(dispH)} mm, Restbreite ${r1(Math.max(0, W - usedW))} mm`);
      }
    }
    if (cutMode === 'none') job.addLog('SCHNITT', 'Kein Querschnitt (Aufwickler/kein Schnitt) – Abschnitte bleiben auf der Rolle');
    else job.addLog('SCHNITT', `${cutMode === 'synchro' ? 'Synchronschnitt (Länge = Zeichnung)' : cutMode === 'standard' ? 'Formatschnitt (Normlänge)' : 'Automatischer Querschnitt'} nach jedem Abschnitt`);
  } else {
    // ---------- Nesting ----------
    const gap = cap.gapMm || 5;
    const items = [];
    for (const pg of pages) items.push(pg);
    const needW = Math.max(...items.map((pg) => (allowRot ? Math.min(pt2mm(pg.wPt), pt2mm(pg.hPt)) : pt2mm(pg.wPt)) + 2 * m));
    const sel = selectRoll(device, catalog, ticket, needW, 1, job, '(Nesting)');
    if (!sel.ok) return { ok: false, media: sel };
    const W = sel.media.widthMm, usable = W - 2 * m;
    const rows = [];
    let row = null;
    for (const pg of items) {
      const pw = pt2mm(pg.wPt), ph = pt2mm(pg.hPt);
      const optsRot = allowRot ? [0, 90] : [0];
      let chosen = null;
      for (const rot of optsRot) {
        const w = rot ? ph : pw, h = rot ? pw : ph;
        if (w > usable + 0.01) continue;
        const fitsRow = row && row.used + gap + w <= usable + 0.01;
        const score = (fitsRow ? 0 : 1e6) + h; // in bestehende Reihe, niedrige Höhe bevorzugt
        if (!chosen || score < chosen.score) chosen = { rot, w, h, score, fitsRow };
      }
      if (!chosen) return { ok: false, media: { ok: false, reason: 'media-needed', text: `Seite ${pg.index + 1} breiter als nutzbare Rollenbreite ${usable} mm` } };
      if (!chosen.fitsRow) { row = { items: [], used: -gap, h: 0 }; rows.push(row); }
      row.items.push({ pg, rot: chosen.rot, w: chosen.w, h: chosen.h, x: row.used + gap });
      row.used += gap + chosen.w;
      row.h = Math.max(row.h, chosen.h);
    }
    const totalH = rows.reduce((s, r) => s + r.h, 0) + gap * (rows.length - 1) + 2 * mEnd;
    const s = newSurface({ id: 'r1', kind: 'roll', label: `Nesting – ${sel.slot.name}`, wPt: mm2pt(W), hPt: mm2pt(totalH), slotId: sel.slot.id, mediaId: sel.media.id, mediaName: sel.media.name, sheetNo: 1, feed: 'up' });
    s.overlay.areas.push({ x: 0, y: 0, w: mm2pt(m), h: s.hPt, kind: 'unprintable' }, { x: s.wPt - mm2pt(m), y: 0, w: mm2pt(m), h: s.hPt, kind: 'unprintable' });
    let y = totalH - mEnd;
    let n = 0;
    for (const r of rows) {
      y -= r.h;
      for (const it of r.items) {
        n++;
        const p = place(it.pg, 'crop', it.rot, { x: mm2pt(m + it.x), y: mm2pt(y + (r.h - it.h)), w: mm2pt(it.w), h: mm2pt(it.h) }, 1, 'bottom-left');
        p.clip = { x: mm2pt(m + it.x), y: mm2pt(y + (r.h - it.h)), w: mm2pt(it.w), h: mm2pt(it.h) };
        p.label = `S.${it.pg.index + 1}${it.rot ? ' ↻' : ''}`;
        s.placements.push(p);
      }
      if (cutMode !== 'none' && ticket.roll.cutRows) s.overlay.cuts.push({ x1: 0, y1: mm2pt(y - gap / 2), x2: s.wPt, y2: mm2pt(y - gap / 2), kind: 'roll-cut' });
      y -= gap;
    }
    if (cutMode !== 'none') s.overlay.cuts.push({ x1: 0, y1: s.hPt, x2: s.wPt, y2: s.hPt, kind: 'roll-cut', n: 1 });
    s.lengthMm = totalH;
    surfaces.push(s);
    addCons(sel.slot, totalH * ticket.copies);
    job.addLog('AUSSCHUSS', `Nesting: ${n} Seiten in ${rows.length} Reihe(n) auf ${W} mm (nutzbar ${usable} mm), Abstand ${gap} mm, Länge ${r1(totalH)} mm; Ausnutzung ${r1((items.reduce((a, pg) => a + pt2mm(pg.wPt) * pt2mm(pg.hPt), 0) / (W * totalH)) * 100)} %`);
  }
  if (leadTrim && surfaces.length) {
    job.addLog('SCHNITT', `Anschnitt am Rollenanfang: ${leadTrim} mm Abfall (Kantenbegradigung)`);
    const first = surfaces[0];
    addCons({ id: first.slotId }, leadTrim);
  }
  const m2 = surfaces.reduce((a, s) => a + (pt2mm(s.wPt) * (s.lengthMm || pt2mm(s.hPt))) / 1e6, 0) * ticket.copies;
  return {
    ok: true,
    layout: {
      kind: 'wide', mode: nesting ? 'nesting' : 'per-page', surfaces, sets: ticket.copies, sheetsPerSet: surfaces.length, totalSheets: surfaces.length * ticket.copies,
      impressionsPerSet: surfaces.length, totalImpressions: surfaces.length * ticket.copies, lengthMm: totalLen, m2,
      consumption: Array.from(consumption.entries()).map(([slotId, mm]) => ({ slotId, mm })), cutMode,
    },
  };
}

// ------------------------------------------------------------------ Foto-Minilab
function imposePhoto(ctx) {
  const { job, device, catalog, pf, ticket } = ctx;
  const pages = selectPages(pf, ticket.pageRanges, job);
  const cap = device.roll;
  const over = cap.overspillMm || 0;
  const loaded = rollsOf(device, catalog).filter((r) => r.media);
  if (!loaded.length) return { ok: false, media: { ok: false, reason: 'media-empty', text: 'Keine Papierrolle geladen' } };
  const surfaces = [];
  const consumption = new Map();
  let n = 0;
  for (const pg of pages) {
    const iw = pt2mm(pg.wPt), ih = pt2mm(pg.hPt);
    let size = ticket.photo.printSizeMm || ticket.media.sizeMm || [iw, ih];
    // Printgröße an Bildausrichtung anpassen
    let [a, b] = size[0] <= size[1] ? size : [size[1], size[0]];
    // Rolle wählen: Breite == eine Printkante
    const opts = [];
    for (const r of loaded) {
      const W = r.media.widthMm;
      if (Math.abs(W - a) <= 1.5) opts.push({ r, across: a, along: b });
      else if (Math.abs(W - b) <= 1.5) opts.push({ r, across: b, along: a });
    }
    const label = `für Print ${fmtSize(a, b)}`;
    const rows = loaded.map((r) => ({ rolle: r.slot.name, papier: r.media.name, breite: r.media.widthMm, passt: opts.some((o) => o.r === r) }));
    job.addLog('MATERIAL', `Rollenwahl ${label} – Rollenbreite muss einer Printkante entsprechen (${a} oder ${b} mm)`, rows);
    if (!opts.length) {
      return { ok: false, media: { ok: false, reason: 'media-needed', text: `Printgröße ${fmtSize(a, b)} benötigt eine Rolle mit ${a} mm oder ${b} mm Breite`, wanted: { widthMm: a } } };
    }
    if (b > cap.maxLengthMm) job.warn('AUSSCHUSS', `Printlänge ${b} mm über Maximallänge ${cap.maxLengthMm} mm`);
    if (ticket.media.type) {
      const t = opts.filter((o) => o.r.media.type === ticket.media.type || o.r.media.ippType === ticket.media.type);
      if (!t.length) return { ok: false, media: { ok: false, reason: 'media-needed', text: `Papiertyp ${ticket.media.type} nicht geladen` } };
      opts.splice(0, opts.length, ...t);
    }
    const o = opts.sort((x, y) => x.along - y.along)[0];
    const W = o.r.media.widthMm;
    for (let c = 0; c < Math.min(ticket.copies, 1); c++) {
      n++;
      const s = newSurface({ id: `p${n}`, kind: 'photo', label: `Print ${n} – ${fmtSize(o.across, o.along)}`, wPt: mm2pt(W), hPt: mm2pt(o.along), slotId: o.r.slot.id, mediaId: o.r.media.id, mediaName: o.r.media.name, sheetNo: n, feed: 'up' });
      const cell = { x: -mm2pt(over), y: -mm2pt(over), w: mm2pt(o.across + 2 * over), h: mm2pt(o.along + 2 * over) };
      const imgLand = iw > ih, cellLand = o.across > o.along;
      const rot = imgLand === cellLand ? 0 : 90;
      const fit = ticket.photo.fit === 'fit' ? 'fit' : 'fill';
      const p = place(pg, 'crop', rot, fit === 'fit' ? { x: 0, y: 0, w: s.wPt, h: s.hPt } : cell, fit);
      p.clip = { x: 0, y: 0, w: s.wPt, h: s.hPt };
      p.label = `Bild ${pg.index + 1}`;
      s.placements.push(p);
      // Beschnitt berechnen
      const visW = Math.min(p.rect.w, s.wPt), visH = Math.min(p.rect.h, s.hPt);
      const cropX = Math.max(0, p.rect.w - s.wPt), cropY = Math.max(0, p.rect.h - s.hPt);
      if (fit === 'fill' && (cropX > 1 || cropY > 1)) {
        job.addLog('AUSSCHUSS', `Print ${n}: Bild ${fmtSize(iw, ih)}${rot ? ' (gedreht)' : ''} auf ${fmtSize(o.across, o.along)} gefüllt → Beschnitt ${r1(pt2mm(cropX))} mm quer / ${r1(pt2mm(cropY))} mm längs (${r1((1 - (visW * visH) / (p.rect.w * p.rect.h)) * 100)} % der Bildfläche abgeschnitten)`);
        // sichtbar abgeschnittene Bereiche markieren (außerhalb des Prints – in Overlay als Notiz)
        s.overlay.notes.push({ x: 2, y: s.hPt - 8, text: `Beschnitt ${r1(pt2mm(cropX))}/${r1(pt2mm(cropY))} mm` });
      } else if (fit === 'fit') {
        job.addLog('AUSSCHUSS', `Print ${n}: Bild eingepasst (weißer Rand ${r1(pt2mm(s.wPt - p.rect.w) / 2)} / ${r1(pt2mm(s.hPt - p.rect.h) / 2)} mm)`);
      }
      if (over) s.overlay.areas.push({ x: 0, y: 0, w: s.wPt, h: s.hPt, kind: 'overspill', label: `Randlos: ${over} mm Überdruck je Kante` });
      s.overlay.cuts.push({ x1: 0, y1: s.hPt, x2: s.wPt, y2: s.hPt, kind: 'roll-cut', n: 1 });
      if (ticket.photo.backprint) s.backprint = String(ticket.photo.backprint).replace('{n}', n).replace('{datei}', job.name);
      s.lengthMm = o.along;
      surfaces.push(s);
    }
    consumption.set(o.r.slot.id, (consumption.get(o.r.slot.id) || 0) + o.along * ticket.copies);
  }
  if (ticket.photo.backprint) job.addLog('FINISHING', `Rückseitendruck je Print: „${ticket.photo.backprint}"`);
  job.addLog('SCHNITT', `Schneider: ${surfaces.length * ticket.copies} Querschnitt(e), randlos mit ${over} mm Überdruck`);
  const lengthMm = Array.from(consumption.values()).reduce((a, b) => a + b, 0);
  return {
    ok: true,
    layout: {
      kind: 'photo', mode: 'prints', surfaces, sets: ticket.copies, sheetsPerSet: surfaces.length, totalSheets: surfaces.length * ticket.copies,
      impressionsPerSet: surfaces.length, totalImpressions: surfaces.length * ticket.copies, lengthMm,
      m2: surfaces.reduce((a, s) => a + pt2mm(s.wPt) * pt2mm(s.hPt) / 1e6, 0) * ticket.copies,
      consumption: Array.from(consumption.entries()).map(([slotId, mm]) => ({ slotId, mm })),
    },
  };
}

module.exports = { imposeWide, imposePhoto, DIN_LENGTHS };
