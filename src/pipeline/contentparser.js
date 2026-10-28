'use strict';
// Interpretiert PDF-Content-Streams soweit nötig, um Schmuckfarben (z. B. CutContour,
// PerfCutContour) zu finden und die damit gezeichneten Pfade als Schneidkonturen zu extrahieren.
const { $t, $tp, $lazy } = require('../i18n.js');

const { PDFName, PDFArray, PDFDict, PDFRawStream, PDFContentStream, PDFStream, decodePDFRawStream } = require('../vendor/pdf-lib');
const { M } = require('../util/misc');

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function streamBytes(stream) {
  if (!stream) return new Uint8Array(0);
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (stream instanceof PDFContentStream) return stream.getUnencodedContents();
  if (stream.getContents) return stream.getContents();
  return new Uint8Array(0);
}

/** Tokenizer + Operanden-Stack; ruft onOp(operator, operands, ctx) auf. */
function runContent(bytes, onOp) {
  const b = bytes;
  const n = b.length;
  let i = 0;
  const stack = [];
  const containers = []; // für [ ] und << >>
  const push = (v) => { if (containers.length) containers[containers.length - 1].push(v); else stack.push(v); };
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } // Kommentar
    if (c === 0x28) { // (String)
      let depth = 1; i++;
      const start = i;
      while (i < n && depth > 0) {
        if (b[i] === 0x5c) { i += 2; continue; }
        if (b[i] === 0x28) depth++;
        else if (b[i] === 0x29) depth--;
        i++;
      }
      push({ str: Buffer.from(b.subarray(start, i - 1)).toString('latin1') });
      continue;
    }
    if (c === 0x3c) {
      if (b[i + 1] === 0x3c) { containers.push([]); i += 2; continue; }
      const end = b.indexOf(0x3e, i);
      push({ hex: Buffer.from(b.subarray(i + 1, end === -1 ? n : end)).toString('latin1') });
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === 0x3e && b[i + 1] === 0x3e) { const d = containers.pop() || []; push({ dict: d }); i += 2; continue; }
    if (c === 0x5b) { containers.push([]); i++; continue; }
    if (c === 0x5d) { const a = containers.pop() || []; push(a); i++; continue; }
    if (c === 0x2f) { // /Name
      let j = i + 1;
      while (j < n && !WS.has(b[j]) && !DELIM.has(b[j])) j++;
      push({ name: Buffer.from(b.subarray(i + 1, j)).toString('latin1').replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) });
      i = j;
      continue;
    }
    if (c === 0x7b || c === 0x7d) { i++; continue; }
    // Zahl oder Operator
    let j = i;
    while (j < n && !WS.has(b[j]) && !DELIM.has(b[j])) j++;
    if (j === i) { i++; continue; }
    const tok = Buffer.from(b.subarray(i, j)).toString('latin1');
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { push(parseFloat(tok)); continue; }
    if (tok === 'true' || tok === 'false') { push(tok === 'true'); continue; }
    if (tok === 'null') { push(null); continue; }
    if (containers.length) { push({ op: tok }); continue; }
    if (tok === 'BI') {
      // Inline-Bild überspringen: bis "ID", dann Binärdaten bis Whitespace EI Whitespace
      const idPos = findSeq(b, [0x49, 0x44], i); // "ID"
      let k = idPos + 3;
      while (k < n) {
        if (b[k] === 0x45 && b[k + 1] === 0x49 && WS.has(b[k - 1]) && (k + 2 >= n || WS.has(b[k + 2]))) break;
        k++;
      }
      i = k + 2;
      stack.length = 0;
      continue;
    }
    onOp(tok, stack.splice(0));
  }
}

function findSeq(b, seq, from) {
  outer: for (let i = from; i < b.length - seq.length; i++) {
    for (let k = 0; k < seq.length; k++) if (b[i + k] !== seq[k]) continue outer;
    if ((i === 0 || WS.has(b[i - 1])) && WS.has(b[i + seq.length])) return i;
  }
  return b.length;
}

/** Löst einen Farbraum-Eintrag auf: liefert Liste der Schmuckfarben-Namen oder null. */
function spotNamesOf(context, csObj) {
  const obj = context.lookup(csObj);
  if (obj instanceof PDFArray) {
    const fam = context.lookup(obj.get(0));
    const famName = fam instanceof PDFName ? fam.decodeText() : '';
    if (famName === 'Separation') {
      const nm = context.lookup(obj.get(1));
      return nm instanceof PDFName ? [nm.decodeText()] : null;
    }
    if (famName === 'DeviceN') {
      const arr = context.lookup(obj.get(1));
      if (arr instanceof PDFArray) return arr.asArray().map((x) => context.lookup(x)).filter((x) => x instanceof PDFName).map((x) => x.decodeText());
    }
    if (famName === 'Indexed') return spotNamesOf(context, obj.get(1));
  }
  return null;
}

function dictGet(context, dict, key) {
  if (!dict) return undefined;
  const d = context.lookup(dict);
  if (!(d instanceof PDFDict)) return undefined;
  return context.lookup(d.get(PDFName.of(key)));
}

/**
 * Analysiert eine Seite: alle Schmuckfarben + Pfade in den gesuchten Schneidfarben.
 * Koordinaten im Benutzerraum der Seite (wie MediaBox).
 */
function analyzePage(doc, page, cutNames = []) {
  const context = doc.context;
  const cutSet = new Set(cutNames.map((s) => s.toLowerCase()));
  const spots = new Set();
  const cuts = [];
  const visitedForms = new Set();

  function collectSpots(resources) {
    const csDict = dictGet(context, resources, 'ColorSpace');
    if (csDict instanceof PDFDict) {
      for (const [, v] of csDict.entries()) {
        const names = spotNamesOf(context, v);
        if (names) names.forEach((x) => { if (!/^(All|None)$/.test(x)) spots.add(x); });
      }
    }
  }

  function interpret(bytes, resources, baseCtm, depth) {
    collectSpots(resources);
    const gstack = [];
    let gs = { ctm: baseCtm.slice(), strokeSpot: null, fillSpot: null };
    let path = [];
    let sub = null;
    let cx = 0, cy = 0;
    const T = (x, y) => M.apply(gs.ctm, x, y);
    const resolveCS = (name) => {
      if (['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK'].includes(name)) return null;
      const csDict = dictGet(context, resources, 'ColorSpace');
      if (!(csDict instanceof PDFDict)) return null;
      const entry = csDict.get(PDFName.of(name));
      if (!entry) return null;
      const names = spotNamesOf(context, entry);
      return names && names.length ? names : null;
    };
    const isCut = (names) => names && names.find((x) => cutSet.has(x.toLowerCase()));
    const paint = (stroke, fill) => {
      const s = stroke && isCut(gs.strokeSpot);
      const f = !s && fill && isCut(gs.fillSpot);
      const name = s || f;
      if (name && path.length) {
        cuts.push({ name, kind: /perf/i.test(name) ? 'perf' : 'contour', via: s ? $t('Kontur', 'contour') : $t('Fläche', 'fill'), subpaths: path.filter((p) => p.length > 1) });
      }
      path = []; sub = null;
    };
    runContent(bytes, (op, a) => {
      switch (op) {
        case 'q': gstack.push({ ...gs, ctm: gs.ctm.slice() }); break;
        case 'Q': if (gstack.length) gs = gstack.pop(); break;
        case 'cm': if (a.length >= 6) gs.ctm = M.mul(a.slice(-6), gs.ctm); break;
        case 'm': { cx = a[0]; cy = a[1]; const [x, y] = T(cx, cy); sub = [{ op: 'M', x, y }]; path.push(sub); break; }
        case 'l': { cx = a[0]; cy = a[1]; const [x, y] = T(cx, cy); if (!sub) { sub = [{ op: 'M', x, y }]; path.push(sub); } else sub.push({ op: 'L', x, y }); break; }
        case 'c': case 'v': case 'y': {
          let p1, p2, p3;
          if (op === 'c') { p1 = [a[0], a[1]]; p2 = [a[2], a[3]]; p3 = [a[4], a[5]]; }
          else if (op === 'v') { p1 = [cx, cy]; p2 = [a[0], a[1]]; p3 = [a[2], a[3]]; }
          else { p1 = [a[0], a[1]]; p2 = [a[2], a[3]]; p3 = [a[2], a[3]]; }
          const [x1, y1] = T(...p1); const [x2, y2] = T(...p2); const [x, y] = T(...p3);
          cx = p3[0]; cy = p3[1];
          if (!sub) { sub = [{ op: 'M', x, y }]; path.push(sub); } else sub.push({ op: 'C', x1, y1, x2, y2, x, y });
          break;
        }
        case 'h': if (sub) sub.push({ op: 'Z' }); break;
        case 're': {
          const [x, y, w, h] = a;
          const p = [T(x, y), T(x + w, y), T(x + w, y + h), T(x, y + h)];
          sub = [{ op: 'M', x: p[0][0], y: p[0][1] }, { op: 'L', x: p[1][0], y: p[1][1] }, { op: 'L', x: p[2][0], y: p[2][1] }, { op: 'L', x: p[3][0], y: p[3][1] }, { op: 'Z' }];
          path.push(sub); sub = null;
          break;
        }
        case 'S': paint(true, false); break;
        case 's': if (sub) sub.push({ op: 'Z' }); paint(true, false); break;
        case 'f': case 'F': case 'f*': paint(false, true); break;
        case 'B': case 'B*': paint(true, true); break;
        case 'b': case 'b*': if (sub) sub.push({ op: 'Z' }); paint(true, true); break;
        case 'n': path = []; sub = null; break;
        case 'CS': gs.strokeSpot = a[0] && a[0].name ? resolveCS(a[0].name) : null; break;
        case 'cs': gs.fillSpot = a[0] && a[0].name ? resolveCS(a[0].name) : null; break;
        case 'G': case 'RG': case 'K': gs.strokeSpot = null; break;
        case 'g': case 'rg': case 'k': gs.fillSpot = null; break;
        case 'Do': {
          if (depth > 8 || !a[0] || !a[0].name) break;
          const xo = dictGet(context, resources, 'XObject');
          if (!(xo instanceof PDFDict)) break;
          const ref = xo.get(PDFName.of(a[0].name));
          const form = context.lookup(ref);
          if (!(form instanceof PDFStream) && !(form instanceof PDFRawStream)) break;
          const sub2 = form.dict.lookup(PDFName.of('Subtype'));
          if (!(sub2 instanceof PDFName) || sub2.decodeText() !== 'Form') break;
          const key = String(ref);
          if (visitedForms.has(key) && depth > 3) break;
          visitedForms.add(key);
          const mArr = form.dict.lookup(PDFName.of('Matrix'));
          const fm = mArr instanceof PDFArray ? mArr.asArray().map((x) => context.lookup(x).asNumber()) : [1, 0, 0, 1, 0, 0];
          const fres = form.dict.get(PDFName.of('Resources')) || resources;
          try { interpret(streamBytes(form), fres, M.mul(fm, gs.ctm), depth + 1); } catch (e) { /* defekte Form ignorieren */ }
          break;
        }
        default: break;
      }
    });
  }

  const resources = page.node.Resources();
  const contents = page.node.Contents();
  const parts = [];
  if (contents) {
    const c = context.lookup(contents);
    if (c instanceof PDFArray) for (const r of c.asArray()) parts.push(streamBytes(context.lookup(r)));
    else parts.push(streamBytes(c));
  }
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; all[off++] = 10; }
  interpret(all, resources, M.identity(), 0);
  return { spots: Array.from(spots), cuts };
}

/** Bounding-Box einer Pfadliste */
function pathsBBox(subpaths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of subpaths) for (const s of sp) {
    for (const [x, y] of [[s.x, s.y], [s.x1, s.y1], [s.x2, s.y2]]) {
      if (x === undefined) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/** Bezier-Kurven in Polylinien zerlegen (für Plotterdateien). */
function flatten(subpath, steps = 12) {
  const pts = [];
  let sx = 0, sy = 0, px = 0, py = 0, closed = false;
  for (const s of subpath) {
    if (s.op === 'M') { px = sx = s.x; py = sy = s.y; pts.push([px, py]); }
    else if (s.op === 'L') { px = s.x; py = s.y; pts.push([px, py]); }
    else if (s.op === 'C') {
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, u = 1 - t;
        const x = u * u * u * px + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x;
        const y = u * u * u * py + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y;
        pts.push([x, y]);
      }
      px = s.x; py = s.y;
    } else if (s.op === 'Z') { closed = true; if (px !== sx || py !== sy) pts.push([sx, sy]); px = sx; py = sy; }
  }
  return { pts, closed };
}

function transformSubpaths(subpaths, m) {
  return subpaths.map((sp) => sp.map((s) => {
    if (s.op === 'Z') return s;
    const [x, y] = M.apply(m, s.x, s.y);
    if (s.op === 'C') {
      const [x1, y1] = M.apply(m, s.x1, s.y1);
      const [x2, y2] = M.apply(m, s.x2, s.y2);
      return { op: 'C', x1, y1, x2, y2, x, y };
    }
    return { op: s.op, x, y };
  }));
}

module.exports = { analyzePage, runContent, pathsBBox, flatten, transformSubpaths, streamBytes };
