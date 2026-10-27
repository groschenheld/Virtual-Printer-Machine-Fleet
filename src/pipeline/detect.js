'use strict';
// Erkennung und Normalisierung der Eingangsdaten -> PDF (das "RIP-Eingangsformat" der Simulation).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { PDFDocument, rgb, StandardFonts } = require('../vendor/pdf-lib');
const { unwrapPjl, parsePjlCommands } = require('../protocols/pjl');
const { encodePng } = require('../util/png');
const { mm2pt, r1, pt2mm } = require('../util/misc');

function detectFormat(buf) {
  const head = buf.subarray(0, 16).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('%!PS') || head.startsWith('\x04%!PS')) return 'postscript';
  if (buf[0] === 0xc5 && buf[1] === 0xd0 && buf[2] === 0xd3 && buf[3] === 0xc6) return 'eps-binary';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (head.startsWith('\x89PNG')) return 'png';
  if (head.startsWith('RaS2')) return 'pwg-raster';
  if (head.startsWith('UNIRAST')) return 'urf';
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'tiff';
  if (head.startsWith('PK')) return 'zip/xps';
  if (head.startsWith('\x1b%-12345X') || head.startsWith('@PJL')) return 'pjl';
  if (head.startsWith('\x1bE') || head.startsWith('\x1b&')) return 'pcl';
  if (/^(\x1b%-?\d?B|\x1bE\x1b%-?1B|IN;|BP|IN\s*;|DF;|PS\d)/.test(head) || /^\s*(IN|BP|PS|SP|PU|PD)[\d;,\s]/.test(head)) return 'hpgl';
  if (head.startsWith('<?xml')) return 'xml';
  return 'unknown';
}

const FORMAT_DE = {
  pdf: 'PDF', postscript: 'PostScript', 'eps-binary': 'EPS (binär)', jpeg: 'JPEG-Bild', png: 'PNG-Bild', 'pwg-raster': 'PWG-Raster (IPP Everywhere)',
  urf: 'Apple Raster (URF)', tiff: 'TIFF', 'zip/xps': 'XPS/ZIP', pjl: 'PJL', pcl: 'PCL', hpgl: 'HP-GL/2', xml: 'XML', unknown: 'unbekannt',
};

function findGhostscript(configured) {
  const cands = configured ? [configured] : process.platform === 'win32' ? ['gswin64c', 'gswin32c', 'gs'] : ['gs'];
  return cands;
}

function runGs(exe, inFile, outFile) {
  return new Promise((resolve, reject) => {
    execFile(exe, ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', `-sOutputFile=${outFile}`, inFile], { timeout: 120000 }, (err, so, se) => {
      if (err) reject(Object.assign(err, { stderr: se })); else resolve();
    });
  });
}

// ---------------------------------------------------------------- Bilder
function jpegInfo(buf) {
  let i = 2, dpi = null;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe0 && buf.subarray(i + 4, i + 9).toString('latin1') === 'JFIF\0') {
      const units = buf[i + 11];
      const xd = buf.readUInt16BE(i + 12);
      if (units === 1 && xd >= 72) dpi = xd;
      if (units === 2 && xd >= 28) dpi = Math.round(xd * 2.54);
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), dpi };
    }
    i += 2 + len;
  }
  return { width: 0, height: 0, dpi };
}

async function imageToPdf(buf, kind, job) {
  const doc = await PDFDocument.create();
  const img = kind === 'jpeg' ? await doc.embedJpg(buf) : await doc.embedPng(buf);
  let dpi = 300;
  if (kind === 'jpeg') { const info = jpegInfo(buf); if (info.dpi) dpi = info.dpi; }
  const wPt = (img.width / dpi) * 72, hPt = (img.height / dpi) * 72;
  const page = doc.addPage([wPt, hPt]);
  page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
  job.addLog('FORMAT', `Bild ${img.width} × ${img.height} px bei ${dpi} dpi → Seite ${r1(pt2mm(wPt))} × ${r1(pt2mm(hPt))} mm (Bildmaß; Zuschnitt auf Printgröße erfolgt im Layout)`);
  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------- PWG-Raster
function decodePwgRaster(buf, job) {
  const pages = [];
  let pos = 4;
  while (pos + 1796 <= buf.length) {
    const h = buf.subarray(pos, pos + 1796);
    const u = (o) => h.readUInt32BE(o);
    const hdr = {
      mediaType: h.subarray(128, 192).toString('latin1').replace(/\0.*$/s, ''),
      hwRes: [u(276), u(280)], pageSize: [u(352), u(356)], duplex: u(272), tumble: u(368), copies: u(340),
      width: u(372), height: u(376), bitsPerColor: u(384), bitsPerPixel: u(388), bytesPerLine: u(392), colorSpace: u(400), numColors: u(420),
    };
    pos += 1796;
    const { width, height, bitsPerPixel, bytesPerLine } = hdr;
    const bpp = bitsPerPixel / 8;
    const out = Buffer.alloc(bytesPerLine * height, 0xff);
    let y = 0;
    while (y < height && pos < buf.length) {
      const repeat = buf[pos++] + 1;
      const line = Buffer.alloc(bytesPerLine);
      let x = 0;
      while (x < bytesPerLine && pos < buf.length) {
        const c = buf[pos++];
        if (c <= 127) {
          const n = c + 1;
          const px = buf.subarray(pos, pos + Math.max(1, bpp));
          pos += Math.max(1, bpp);
          for (let k = 0; k < n && x < bytesPerLine; k++) { px.copy(line, x); x += Math.max(1, bpp); }
        } else {
          const n = 257 - c;
          const len = n * Math.max(1, bpp);
          buf.copy(line, x, pos, pos + len);
          pos += len; x += len;
        }
      }
      for (let r = 0; r < repeat && y < height; r++, y++) line.copy(out, y * bytesPerLine);
    }
    pages.push({ hdr, data: out });
    // nächste Seite beginnt direkt mit Header (ohne erneutes "RaS2")
  }
  job.addLog('FORMAT', `PWG-Raster: ${pages.length} Seite(n), ${pages[0] ? pages[0].hdr.hwRes.join('×') + ' dpi, Farbraum ' + pages[0].hdr.colorSpace + ', ' + pages[0].hdr.bitsPerPixel + ' bit/px' : ''}`);
  return pages;
}

async function pwgToPdf(buf, job) {
  const pages = decodePwgRaster(buf, job);
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const { width, height, bitsPerPixel, colorSpace, bytesPerLine } = p.hdr;
    let channels = 1;
    let pix;
    if (bitsPerPixel === 24) { channels = 3; pix = p.data; }
    else if (bitsPerPixel === 8) {
      pix = p.data;
      if (colorSpace === 3) { pix = Buffer.from(pix); for (let i = 0; i < pix.length; i++) pix[i] = 255 - pix[i]; } // K: 0 = weiß
    } else if (bitsPerPixel === 1) {
      pix = Buffer.alloc(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const bit = (p.data[y * bytesPerLine + (x >> 3)] >> (7 - (x & 7))) & 1;
        pix[y * width + x] = colorSpace === 3 ? (bit ? 0 : 255) : bit ? 255 : 0;
      }
    } else if (bitsPerPixel === 32) { // CMYK grob nach RGB
      channels = 3; pix = Buffer.alloc(width * height * 3);
      for (let i = 0, o = 0; i < p.data.length; i += 4, o += 3) {
        const k = p.data[i + 3] / 255;
        pix[o] = 255 * (1 - p.data[i] / 255) * (1 - k); pix[o + 1] = 255 * (1 - p.data[i + 1] / 255) * (1 - k); pix[o + 2] = 255 * (1 - p.data[i + 2] / 255) * (1 - k);
      }
    } else throw new Error(`PWG-Raster mit ${bitsPerPixel} bit/px wird nicht unterstützt`);
    const png = encodePng(width, height, channels, pix.subarray(0, width * height * channels));
    const img = await doc.embedPng(png);
    const [wPt, hPt] = p.hdr.pageSize[0] ? p.hdr.pageSize : [(width / p.hdr.hwRes[0]) * 72, (height / p.hdr.hwRes[1]) * 72];
    const page = doc.addPage([wPt, hPt]);
    page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
  }
  return { pdf: Buffer.from(await doc.save()), pages };
}

// ---------------------------------------------------------------- HP-GL/2 (Grundumfang)
const PEN_COLORS = [[0, 0, 0], [0, 0, 0], [0.85, 0, 0], [0, 0.6, 0], [0.85, 0.7, 0], [0, 0, 0.85], [0.7, 0, 0.7], [0, 0.6, 0.7], [0.5, 0.5, 0.5]];
async function hpglToPdf(buf, job) {
  let s = buf.toString('latin1').replace(/\x1b%-?\d*[AB]/g, ';').replace(/\x1b[EeAB]/g, ';').replace(/\x1b%-12345X/g, ';');
  const cmds = s.split(/;|\n|\r/).map((c) => c.trim()).filter(Boolean);
  const UNIT = 0.025; // mm pro Plottereinheit
  let pen = 1, down = false, abs = true, x = 0, y = 0, width = 0.35;
  let plotSize = null;
  const segs = [];
  const labels = [];
  const unsupported = new Set();
  const nums = (p) => p.split(/[ ,]+/).filter(Boolean).map(Number).filter((n) => !isNaN(n));
  for (const c of cmds) {
    const op = c.slice(0, 2).toUpperCase();
    const p = c.slice(2);
    const moveTo = (arr) => {
      for (let i = 0; i + 1 < arr.length; i += 2) {
        const nx = abs ? arr[i] : x + arr[i];
        const ny = abs ? arr[i + 1] : y + arr[i + 1];
        if (down) segs.push({ x1: x, y1: y, x2: nx, y2: ny, pen, width });
        x = nx; y = ny;
      }
    };
    switch (op) {
      case 'IN': case 'DF': pen = 1; down = false; abs = true; x = 0; y = 0; break;
      case 'BP': case 'PG': case 'RO': case 'IP': case 'SC': case 'NP': case 'TR': case 'MC': case 'QL': case 'WU': case 'LA': case 'LT': case 'FT': case 'PC': case 'CR': case 'SI': case 'SD': case 'AD': case 'DT': case 'SS':
        if (['RO', 'IP', 'SC'].includes(op) && p.trim()) unsupported.add(op);
        break;
      case 'PS': { const n = nums(p); if (n.length) plotSize = [n[1] || n[0], n[0]]; break; }
      case 'SP': pen = nums(p)[0] || 0; break;
      case 'PW': { const n = nums(p); if (n.length) width = n[0]; break; }
      case 'PU': down = false; moveTo(nums(p)); break;
      case 'PD': down = true; moveTo(nums(p)); break;
      case 'PA': abs = true; moveTo(nums(p)); break;
      case 'PR': abs = false; moveTo(nums(p)); abs = false; break;
      case 'CI': { const r = nums(p)[0] || 0; const N = 48; for (let k = 0; k < N; k++) { const a1 = (k / N) * 2 * Math.PI, a2 = ((k + 1) / N) * 2 * Math.PI; segs.push({ x1: x + r * Math.cos(a1), y1: y + r * Math.sin(a1), x2: x + r * Math.cos(a2), y2: y + r * Math.sin(a2), pen, width }); } break; }
      case 'LB': labels.push({ x, y, text: p.replace(/\x03$/, ''), pen }); break;
      default: if (/^[A-Z]{2}$/.test(op)) unsupported.add(op);
    }
  }
  if (unsupported.size) job.warn('FORMAT', `HP-GL/2-Befehle nicht simuliert: ${Array.from(unsupported).join(', ')} (Darstellung kann abweichen)`);
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const g of segs) { minX = Math.min(minX, g.x1, g.x2); minY = Math.min(minY, g.y1, g.y2); maxX = Math.max(maxX, g.x1, g.x2); maxY = Math.max(maxY, g.y1, g.y2); }
  let wMm, hMm;
  if (plotSize) { wMm = plotSize[0] * UNIT; hMm = plotSize[1] * UNIT; }
  else { wMm = (maxX - minX) * UNIT + 10; hMm = (maxY - minY) * UNIT + 10; minX -= 5 / UNIT; minY -= 5 / UNIT; }
  if (plotSize) { minX = 0; minY = 0; }
  const doc = await PDFDocument.create();
  const page = doc.addPage([mm2pt(Math.max(wMm, 20)), mm2pt(Math.max(hMm, 20))]);
  const toPt = (v, o) => mm2pt((v - o) * UNIT);
  for (const g of segs) {
    const c = PEN_COLORS[g.pen] || [0, 0, 0];
    if (g.pen === 0) continue;
    page.drawLine({ start: { x: toPt(g.x1, minX), y: toPt(g.y1, minY) }, end: { x: toPt(g.x2, minX), y: toPt(g.y2, minY) }, thickness: mm2pt(g.width), color: rgb(...c) });
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const l of labels) page.drawText(l.text.replace(/[^\x20-\x7e]/g, ''), { x: toPt(l.x, minX), y: toPt(l.y, minY), size: 8, font });
  job.addLog('FORMAT', `HP-GL/2 interpretiert: ${segs.length} Vektoren, ${labels.length} Beschriftungen, Plotgröße ${r1(wMm)} × ${r1(hMm)} mm${plotSize ? ' (aus PS-Befehl)' : ' (aus Zeichnungsgrenzen + 5 mm)'}`);
  return Buffer.from(await doc.save());
}

/**
 * Hauptfunktion: liefert { pdfBytes, format, pjl }.
 * Fehler werfen eine Exception mit verständlicher Meldung.
 */
async function normalize(buf, job, settings) {
  let format = detectFormat(buf);
  let pjl = null;
  job.addLog('FORMAT', `Datenstrom ${buf.length.toLocaleString('de-DE')} Bytes, erkannt: ${FORMAT_DE[format] || format}`);
  if (format === 'pjl') {
    const u = unwrapPjl(buf);
    pjl = parsePjlCommands(u.pjl.commands.concat(u.pjl.trailer));
    job.addProtocol('in', `PJL-Kopf (${u.pjl.commands.length} Befehle${u.pjl.language ? ', ENTER LANGUAGE=' + u.pjl.language : ''})`, u.pjl.commands.concat(u.pjl.trailer.length ? ['--- nach Daten ---', ...u.pjl.trailer] : []).join('\n'));
    buf = u.payload;
    format = detectFormat(buf);
    job.addLog('FORMAT', `Nach PJL-Kopf: ${FORMAT_DE[format] || format}${u.pjl.language ? ` (angekündigt: ${u.pjl.language})` : ''}`);
  }
  let pdfBytes;
  switch (format) {
    case 'pdf': pdfBytes = buf; break;
    case 'jpeg': case 'png': pdfBytes = await imageToPdf(buf, format, job); break;
    case 'pwg-raster': pdfBytes = (await pwgToPdf(buf, job)).pdf; break;
    case 'hpgl': pdfBytes = await hpglToPdf(buf, job); break;
    case 'postscript': case 'eps-binary': {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpf-'));
      const inF = path.join(tmp, 'in.ps'), outF = path.join(tmp, 'out.pdf');
      fs.writeFileSync(inF, buf);
      let ok = false, lastErr = null;
      for (const exe of findGhostscript(settings.ghostscript)) {
        try { await runGs(exe, inF, outF); ok = true; job.addLog('FORMAT', `PostScript mit Ghostscript (${exe}) nach PDF gewandelt – entspricht dem PS-Interpreter des Front-Ends`); break; } catch (e) { lastErr = e; }
      }
      if (!ok) throw new Error('PostScript empfangen, aber kein Ghostscript gefunden (in den Einstellungen Pfad zu gs/gswin64c angeben). ' + (lastErr && lastErr.code === 'ENOENT' ? '' : String(lastErr?.stderr || lastErr?.message || '')));
      pdfBytes = fs.readFileSync(outF);
      fs.rmSync(tmp, { recursive: true, force: true });
      break;
    }
    default:
      throw new Error(`Datenformat ${FORMAT_DE[format] || format} wird von der Simulation nicht gerastert. Unterstützt: PDF, PostScript (mit Ghostscript), JPEG, PNG, PWG-Raster, HP-GL/2.`);
  }
  return { pdfBytes, format, pjl };
}

module.exports = { normalize, detectFormat, FORMAT_DE, decodePwgRaster };
