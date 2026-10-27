#!/usr/bin/env node
'use strict';
// Erzeugt Testdateien in ./samples (oder Zielordner als Argument).
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFOperator, PDFNumber } = require('../src/vendor/pdf-lib');
const { encodePng } = require('../src/util/png');
const mm = (v) => (v * 72) / 25.4;

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'samples'));
fs.mkdirSync(out, { recursive: true });

async function booklet() {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 10; i++) {
    const p = d.addPage([mm(210), mm(297)]);
    p.drawRectangle({ x: mm(10), y: mm(10), width: mm(190), height: mm(277), borderColor: rgb(0.2, 0.4, 0.8), borderWidth: 2 });
    p.drawText(String(i), { x: mm(80), y: mm(130), size: 160, font: f, color: rgb(0.2, 0.4, 0.8) });
    p.drawText(`Seite ${i} – Broschürentest A4`, { x: mm(20), y: mm(270), size: 16, font: f });
  }
  fs.writeFileSync(path.join(out, 'broschuere-a4-10-seiten.pdf'), await d.save());
}

async function cards() {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.HelveticaBold);
  for (const [i, col] of [[1, rgb(0.9, 0.3, 0.1)], [2, rgb(0.1, 0.5, 0.3)]]) {
    const p = d.addPage([mm(91), mm(61)]);
    p.setTrimBox(mm(3), mm(3), mm(85), mm(55));
    p.setBleedBox(0, 0, mm(91), mm(61));
    p.drawRectangle({ x: 0, y: 0, width: mm(91), height: mm(61), color: col });
    p.drawRectangle({ x: mm(3), y: mm(3), width: mm(85), height: mm(55), borderColor: rgb(1, 1, 1), borderWidth: 0.5 });
    p.drawText(i === 1 ? 'Max Muster' : 'Rückseite', { x: mm(10), y: mm(30), size: 16, font: f, color: rgb(1, 1, 1) });
  }
  fs.writeFileSync(path.join(out, 'visitenkarte-85x55-3mm-anschnitt.pdf'), await d.save());
}

async function plan(name, w, h) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([mm(w), mm(h)]);
  p.drawRectangle({ x: mm(20), y: mm(10), width: mm(w - 30), height: mm(h - 20), borderColor: rgb(0, 0, 0), borderWidth: 1.2 });
  for (let x = 40; x < w - 20; x += 50) p.drawLine({ start: { x: mm(x), y: mm(15) }, end: { x: mm(x), y: mm(h - 15) }, thickness: 0.3, color: rgb(0.6, 0.6, 0.6) });
  for (let y = 30; y < h - 10; y += 50) p.drawLine({ start: { x: mm(25), y: mm(y) }, end: { x: mm(w - 15), y: mm(y) }, thickness: 0.3, color: rgb(0.6, 0.6, 0.6) });
  p.drawCircle({ x: mm(w / 2), y: mm(h / 2), size: mm(Math.min(w, h) / 4), borderColor: rgb(0.8, 0, 0), borderWidth: 2 });
  p.drawRectangle({ x: mm(w - 190), y: mm(10), width: mm(180), height: mm(55), borderColor: rgb(0, 0, 0), borderWidth: 1 });
  p.drawText(`Schriftfeld – Plan ${name} (${w} × ${h} mm)`, { x: mm(w - 185), y: mm(50), size: 12, font: f });
  fs.writeFileSync(path.join(out, `plan-${name}.pdf`), await d.save());
}

async function stickers() {
  const d = await PDFDocument.create();
  const ctx = d.context;
  const tint = (c) => ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: c, N: 1 });
  const cut = ctx.register(ctx.obj([PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), tint([0, 1, 0, 0])]));
  const perf = ctx.register(ctx.obj([PDFName.of('Separation'), PDFName.of('PerfCutContour'), PDFName.of('DeviceCMYK'), tint([1, 0, 0, 0])]));
  const f = await d.embedFont(StandardFonts.HelveticaBold);
  const W = mm(126), H = mm(86), b = mm(3);
  const p = d.addPage([W, H]);
  p.setTrimBox(b, b, W - 2 * b, H - 2 * b);
  p.setBleedBox(0, 0, W, H);
  p.node.Resources().set(PDFName.of('ColorSpace'), ctx.obj({ CS0: cut, CS1: perf }));
  p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 0.85, 0.2) });
  p.drawEllipse({ x: W / 2, y: H / 2, xScale: mm(50), yScale: mm(32), color: rgb(0.1, 0.3, 0.7) });
  p.drawText('STICKER', { x: W / 2 - 62, y: H / 2 - 10, size: 28, font: f, color: rgb(1, 1, 1) });
  // Konturschnitt: Ellipse (4 Bezier-Segmente) in CutContour
  const cx = W / 2, cy = H / 2, rx = mm(53), ry = mm(35), k = 0.5523;
  const op = (n, ...a) => PDFOperator.of(n, a.map((x) => (typeof x === 'number' ? PDFNumber.of(x) : x)));
  p.pushOperators(
    op('q'), op('CS', PDFName.of('CS0')), op('SCN', 1), op('w', 0.5),
    op('m', cx + rx, cy), op('c', cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry), op('c', cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy),
    op('c', cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry), op('c', cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy), op('h'), op('S'), op('Q'),
    // Perforation: Linie quer über den Aufkleber
    op('q'), op('CS', PDFName.of('CS1')), op('SCN', 1), op('w', 0.5), op('m', b + mm(8), mm(14)), op('l', W - b - mm(8), mm(14)), op('S'), op('Q'),
  );
  fs.writeFileSync(path.join(out, 'aufkleber-cutcontour.pdf'), await d.save());
}

function photo() {
  const w = 1800, h = 1200;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    px[i] = (x / w) * 255; px[i + 1] = (y / h) * 200 + 30; px[i + 2] = 180 - (x / w) * 120;
    if ((x - w / 2) ** 2 + (y - h / 2) ** 2 < 300 ** 2) { px[i] = 250; px[i + 1] = 220; px[i + 2] = 40; }
  }
  fs.writeFileSync(path.join(out, 'foto-3zu2-1800x1200.png'), encodePng(w, h, 3, px));
}

function hpgl() {
  const L = ['IN;', 'PS33640,23760;', 'SP1;', 'PW0.5;', 'PU0,0;', 'PD33640,0,33640,23760,0,23760,0,0;', 'SP2;', 'PU8000,8000;', 'CI4000;', 'SP5;', 'PU12000,4000;', 'PD28000,4000,28000,18000,12000,18000,12000,4000;', 'SP1;', 'PU26000,1000;', 'LBPlan HPGL A1\x03;', 'PU0,0;SP0;'];
  fs.writeFileSync(path.join(out, 'plan-a1.plt'), L.join('\n'));
}

async function pjlWrapped() {
  const pdf = fs.readFileSync(path.join(out, 'broschuere-a4-10-seiten.pdf'));
  const head = Buffer.from('\x1b%-12345X@PJL JOB NAME="PJL-Test Broschuere"\r\n@PJL SET COPIES=3\r\n@PJL SET DUPLEX=ON\r\n@PJL SET BINDING=LONGEDGE\r\n@PJL SET PAPER=A4\r\n@PJL SET STAPLE=LEFTTOP\r\n@PJL SET PUNCH=TWO\r\n@PJL SET USERNAME="pjl-user"\r\n@PJL ENTER LANGUAGE=PDF\r\n', 'latin1');
  const tail = Buffer.from('\x1b%-12345X@PJL EOJ NAME="PJL-Test Broschuere"\r\n\x1b%-12345X', 'latin1');
  fs.writeFileSync(path.join(out, 'pjl-job-a4-heften-lochen.prn'), Buffer.concat([head, pdf, tail]));
}

(async () => {
  await booklet();
  await cards();
  await plan('a1-quer', 841, 594);
  await plan('a0-quer', 1189, 841);
  await plan('a3-quer', 420, 297);
  await stickers();
  photo();
  hpgl();
  await pjlWrapped();
  fs.writeFileSync(path.join(out, 'visitenkarte-85x55-3mm-anschnitt.json'), JSON.stringify({ copies: 500, sides: 'two-sided-long-edge', imposition: 'step-repeat', media: { mediaId: 'matt-300-sra3' } }, null, 2));
  console.log('Beispieldateien erzeugt in', out);
  for (const f of fs.readdirSync(out)) console.log('  ', f);
})();
