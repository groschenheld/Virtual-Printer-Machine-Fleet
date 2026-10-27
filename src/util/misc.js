'use strict';
// Kleine Helfer ohne externe Abhängigkeiten.

const PT_PER_MM = 72 / 25.4;
const mm2pt = (mm) => mm * PT_PER_MM;
const pt2mm = (pt) => pt / PT_PER_MM;
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

/** "297 × 420 mm" */
function fmtSize(wMm, hMm) {
  return `${r1(wMm)} × ${r1(hMm)} mm`;
}

function clone(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}

function deepMerge(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = clone(v);
    }
  }
  return target;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

/** Text für die Standard-PDF-Schrift (WinAnsi) entschärfen. */
function pdfSafe(text) {
  return String(text)
    .replace(/[→⇒]/g, '->')
    .replace(/[←]/g, '<-')
    .replace(/[≥]/g, '>=')
    .replace(/[≤]/g, '<=')
    .replace(/[…]/g, '...')
    .replace(/[„“”]/g, '"')
    .replace(/[‚‘’]/g, "'")
    .replace(/[^\x20-\x7E\xA0-\xFF–—×€•]/g, '?');
}

function hexdump(buf, max = 512) {
  const b = buf.subarray(0, max);
  const lines = [];
  for (let i = 0; i < b.length; i += 16) {
    const chunk = b.subarray(i, i + 16);
    const hex = Array.from(chunk).map((x) => x.toString(16).padStart(2, '0')).join(' ');
    const asc = Array.from(chunk).map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    lines.push(i.toString(16).padStart(6, '0') + '  ' + hex.padEnd(48) + '  ' + asc);
  }
  if (buf.length > max) lines.push(`… (${buf.length - max} weitere Bytes)`);
  return lines.join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIso() {
  return new Date().toISOString();
}

function safeName(s) {
  return String(s || 'job').replace(/[^\w.\-äöüÄÖÜß ]+/g, '_').slice(0, 120);
}

// 2D-Matrizen im PDF-Format [a b c d e f]
const M = {
  identity: () => [1, 0, 0, 1, 0, 0],
  // Ergebnis = m1 gefolgt von m2 (PDF: "m1 cm" in Kontext m2 -> m1 × m2)
  mul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[1] * m2[2],
      m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2],
      m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
      m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
    ];
  },
  apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  },
  translate: (tx, ty) => [1, 0, 0, 1, tx, ty],
  scale: (s) => [s, 0, 0, s, 0, 0],
  rotateDeg(deg) {
    const a = (deg * Math.PI) / 180;
    const c = Math.round(Math.cos(a) * 1e12) / 1e12;
    const s = Math.round(Math.sin(a) * 1e12) / 1e12;
    return [c, s, -s, c, 0, 0];
  },
};

module.exports = { mm2pt, pt2mm, r1, r2, fmtSize, clone, deepMerge, getPath, setPath, pdfSafe, hexdump, sleep, nowIso, safeName, M, PT_PER_MM };
