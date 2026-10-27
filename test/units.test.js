'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { encode, decode, v } = require('../src/protocols/ipp/codec');
const { unwrapPjl, parsePjlCommands } = require('../src/protocols/pjl');
const { parseXml, find, attr } = require('../src/util/xml');
const { parseMultipart } = require('../src/util/multipart');
const { preflight } = require('../src/pipeline/preflight');
const { sizeFromName, pwgName } = require('../src/pipeline/ticket');
const { samples } = require('./helpers');

const fakeJob = () => ({ log: [], addLog(p, m) { this.log.push(m); }, warn(p, m) { this.log.push('W ' + m); }, error() {}, addProtocol() {} });

test('IPP: Kodieren/Dekodieren inkl. Collection und Mehrfachwerten', () => {
  const buf = encode({ code: 0x0002, requestId: 7, groups: [
    { tag: 1, attrs: { 'attributes-charset': v.charset('utf-8'), 'job-name': v.name('Test') } },
    { tag: 2, attrs: { copies: v.int(3), finishings: [v.enum(20), v.enum(74)], 'media-col': v.col({ 'media-size': v.col({ 'x-dimension': v.int(21000), 'y-dimension': v.int(29700) }), 'media-source': v.kw('tray-2') }) } },
  ] });
  const m = decode(Buffer.concat([buf, Buffer.from('%PDF-1.4')]));
  assert.equal(m.code, 2);
  assert.equal(m.requestId, 7);
  const job = m.groups.find((g) => g.name === 'job').attrs;
  assert.equal(job.copies, 3);
  assert.deepEqual(job.finishings, [20, 74]);
  assert.equal(job['media-col']['media-size']['x-dimension'], 21000);
  assert.equal(job['media-col']['media-source'], 'tray-2');
  assert.equal(m.data.toString(), '%PDF-1.4');
});

test('PJL: Kopf entpacken und Befehle lesen', () => {
  const b = Buffer.from('\x1b%-12345X@PJL JOB NAME="x"\r\n@PJL SET COPIES=2\r\n@PJL SET DUPLEX=ON\r\n@PJL ENTER LANGUAGE=PDF\r\n%PDF-1.4 data\x1b%-12345X@PJL EOJ\r\n', 'latin1');
  const u = unwrapPjl(b);
  assert.equal(u.pjl.language, 'PDF');
  assert.ok(u.payload.toString().startsWith('%PDF'));
  const p = parsePjlCommands(u.pjl.commands);
  assert.equal(p.set.COPIES, '2');
  assert.equal(p.job.NAME, 'x');
});

test('XML/JDF und Multipart', () => {
  const x = parseXml('<?xml version="1.0"?><JDF xmlns="a" JobID="J1"><ResourcePool><Media Dimension="595 842" Weight="100"/></ResourcePool></JDF>');
  assert.equal(attr(x, 'JobID'), 'J1');
  assert.equal(attr(find(x, 'Media'), 'Weight'), '100');
  const body = Buffer.from('--b\r\nContent-Type: text/plain\r\nContent-ID: <a>\r\n\r\nhallo\r\n--b\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\n\r\n%PDF\r\n--b--\r\n');
  const parts = parseMultipart(body, 'multipart/related; boundary=b');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].contentId, 'a');
  assert.equal(parts[1].filename, 'x.pdf');
});

test('Formatnamen', () => {
  assert.deepEqual(sizeFromName('A4'), [210, 297]);
  assert.deepEqual(sizeFromName('iso_a3_297x420mm'), [297, 420]);
  assert.equal(pwgName(320, 450), 'iso_sra3_320x450mm');
});

test('Preflight erkennt CutContour/PerfCutContour als Schneidpfade', async () => {
  const pdf = fs.readFileSync(path.join(samples(), 'aufkleber-cutcontour.pdf'));
  const pf = await preflight(pdf, fakeJob(), ['CutContour', 'PerfCutContour']);
  assert.deepEqual(pf.spots.sort(), ['CutContour', 'PerfCutContour']);
  const cuts = pf.pages[0].cuts;
  assert.equal(cuts.length, 2);
  assert.ok(cuts.find((c) => c.kind === 'perf'));
  assert.ok(pf.pages[0].hasTrim);
});
