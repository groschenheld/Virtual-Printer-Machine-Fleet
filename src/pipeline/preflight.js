'use strict';
const { PDFDocument } = require('../vendor/pdf-lib');
const { analyzePage, pathsBBox } = require('./contentparser');
const { pt2mm, r1, fmtSize } = require('../util/misc');
const { nameFromSize } = require('./ticket');

const DEFAULT_CUT_NAMES = ['CutContour', 'PerfCutContour', 'Thru-cut', 'Kiss-cut', 'Cut', 'Through-cut'];

function boxOf(page, getter) {
  try { const b = page[getter](); return [b.x, b.y, b.x + b.width, b.y + b.height]; } catch { return null; }
}

/**
 * Lädt das PDF und erstellt eine Analyse je Seite:
 * Boxen, wirksame Größe (inkl. /Rotate), Schmuckfarben, Schneidpfade.
 */
async function preflight(pdfBytes, job, cutNames) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const names = cutNames && cutNames.length ? cutNames : DEFAULT_CUT_NAMES;
  const info = [];
  const allSpots = new Set();
  let cutCount = 0;
  pages.forEach((p, i) => {
    const media = boxOf(p, 'getMediaBox');
    const crop = boxOf(p, 'getCropBox') || media;
    const trim = boxOf(p, 'getTrimBox') || crop;
    const bleed = boxOf(p, 'getBleedBox') || crop;
    const rotate = ((p.getRotation().angle % 360) + 360) % 360;
    const w = crop[2] - crop[0], h = crop[3] - crop[1];
    const swap = rotate === 90 || rotate === 270;
    const tw = trim[2] - trim[0], th = trim[3] - trim[1];
    let analysis = { spots: [], cuts: [] };
    if (i < 300) {
      try { analysis = analyzePage(doc, p, names); } catch (e) { job.warn('PREFLIGHT', `Seite ${i + 1}: Inhaltsanalyse fehlgeschlagen (${e.message})`); }
    }
    analysis.spots.forEach((s) => allSpots.add(s));
    cutCount += analysis.cuts.length;
    info.push({
      index: i, media, crop, trim, bleed, rotate,
      wPt: swap ? h : w, hPt: swap ? w : h,
      trimWPt: swap ? th : tw, trimHPt: swap ? tw : th,
      hasTrim: !!(trim && crop && (Math.abs(trim[0] - crop[0]) > 0.5 || Math.abs(trim[2] - crop[2]) > 0.5 || Math.abs(trim[1] - crop[1]) > 0.5 || Math.abs(trim[3] - crop[3]) > 0.5)),
      spots: analysis.spots,
      cuts: analysis.cuts.map((c) => ({ ...c, bbox: pathsBBox(c.subpaths) })),
    });
  });
  // Zusammenfassung loggen
  const sizes = {};
  for (const p of info) {
    const key = fmtSize(pt2mm(p.wPt), pt2mm(p.hPt));
    sizes[key] = (sizes[key] || 0) + 1;
  }
  job.addLog('PREFLIGHT', `PDF ${doc.getPageCount()} Seite(n); Formate: ${Object.entries(sizes).map(([k, v]) => `${v}× ${k}${nameFromSize(...k.split(' × ').map(parseFloat)) ? ' (' + nameFromSize(...k.split(' × ').map(parseFloat)) + ')' : ''}`).join(', ')}`);
  const withTrim = info.filter((p) => p.hasTrim);
  if (withTrim.length) job.addLog('PREFLIGHT', `${withTrim.length} Seite(n) mit TrimBox ≠ CropBox (Beschnittzugabe ${r1(pt2mm((withTrim[0].crop[2] - withTrim[0].crop[0] - (withTrim[0].trim[2] - withTrim[0].trim[0])) / 2))} mm je Seite)`);
  const rotated = info.filter((p) => p.rotate);
  if (rotated.length) job.addLog('PREFLIGHT', `${rotated.length} Seite(n) mit /Rotate (${Array.from(new Set(rotated.map((p) => p.rotate))).join('/')}°) – wird beim Ausschießen berücksichtigt`);
  if (allSpots.size) job.addLog('PREFLIGHT', `Schmuckfarben gefunden: ${Array.from(allSpots).join(', ')}`);
  else job.addLog('PREFLIGHT', 'Keine Schmuckfarben gefunden');
  if (cutCount) {
    const per = info.filter((p) => p.cuts.length).map((p) => `S.${p.index + 1}: ${p.cuts.map((c) => `${c.name} (${c.subpaths.length} Pfad${c.subpaths.length === 1 ? '' : 'e'}, als ${c.via})`).join(', ')}`);
    job.addLog('PREFLIGHT', `Schneidkonturen erkannt (${names.join('/')}) → ${per.join('; ')}`);
  }
  return { doc, pages: info, spots: Array.from(allSpots), cutCount };
}

module.exports = { preflight, DEFAULT_CUT_NAMES };
