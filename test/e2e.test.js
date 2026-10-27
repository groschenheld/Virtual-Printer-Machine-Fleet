'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { encode, decode, v } = require('../src/protocols/ipp/codec');
const { samples, startTest, waitFor } = require('./helpers');

function ipp(port, pathName, code, op, jobAttrs, data) {
  const body = Buffer.concat([encode({ code, requestId: 1, groups: [{ tag: 1, attrs: { 'attributes-charset': v.charset('utf-8'), 'attributes-natural-language': v.lang('de'), 'printer-uri': v.uri(`ipp://127.0.0.1:${port}${pathName}`), ...op } }, ...(jobAttrs ? [{ tag: 2, attrs: jobAttrs }] : [])] }), data || Buffer.alloc(0)]);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: { 'Content-Type': 'application/ipp' } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve(decode(Buffer.concat(c))));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function lpr(port, queue, data) {
  return new Promise((resolve, reject) => {
    const cf = 'Htest\nPtester\nJtest.pdf\nldfA001test\n';
    const steps = [Buffer.from(`\x02${queue}\n`), Buffer.from(`\x02${cf.length} cfA001test\n`), Buffer.concat([Buffer.from(cf), Buffer.from([0])]), Buffer.from(`\x03${data.length} dfA001test\n`), Buffer.concat([data, Buffer.from([0])])];
    let i = 0;
    const s = net.connect(port, '127.0.0.1', () => s.write(steps[i++]));
    s.on('data', () => { if (i < steps.length) s.write(steps[i++]); else s.end(); });
    s.on('close', resolve);
    s.on('error', reject);
  });
}

test('Ende-zu-Ende über echte Schnittstellen', async (t) => {
  const S = samples();
  const env = await startTest(0);
  const { fleet } = env;
  const dev = (id) => fleet.devices.get(id);
  try {
    await t.test('IPP Get-Printer-Attributes meldet geladene Medien', async () => {
      const r = await ipp(dev('ipv1350').cfg.ports.http, '/ipp/print', 0x000b, {});
      const a = r.groups.find((g) => g.name === 'printer').attrs;
      assert.equal(r.code, 0);
      assert.ok(Array.isArray(a['media-col-ready']));
      assert.ok(a['printer-make-and-model'].includes('imagePRESS'));
    });

    await t.test('IPP Broschüre mit 2 Exemplaren', async () => {
      const port = dev('ipv1350').cfg.ports.http;
      const r = await ipp(port, '/ipp/print', 0x0002, { 'document-format': v.mime('application/pdf') }, { copies: v.int(2), finishings: v.enum(8) }, fs.readFileSync(path.join(S, 'broschuere-a4-10-seiten.pdf')));
      const id = r.groups.find((g) => g.name === 'job').attrs['job-id'];
      const job = await waitFor(() => { const j = fleet.jobs.get(id); return j && j.isFinal && j; });
      assert.equal(job.state, 'completed', job.stateMessage);
      const layout = JSON.parse(fs.readFileSync(job.file('layout.json')));
      assert.equal(layout.surfaces.length, 6);
      assert.equal(job.counters.sheets, 6);
      assert.ok(fs.existsSync(job.file('ausgabe.pdf')) && fs.existsSync(job.file('nachweis.pdf')));
      const st = await ipp(port, '/ipp/print', 0x0009, { 'job-id': v.int(id) });
      assert.equal(st.groups.find((g) => g.name === 'job').attrs['job-state'], 9);
    });

    await t.test('LPR in Fiery-Hold-Queue → angehalten → Freigabe', async () => {
      await lpr(dev('ipv1350').cfg.ports.lpd, 'hold', fs.readFileSync(path.join(S, 'broschuere-a4-10-seiten.pdf')));
      const job = await waitFor(() => Array.from(fleet.jobs.values()).find((j) => j.source.protocol === 'LPR' && j.state === 'held'));
      fleet.jobAction(job.id, 'release');
      await waitFor(() => job.state === 'completed');
    });

    await t.test('PRISMAsync wartet auf Material und läuft nach dem Laden weiter', async () => {
      const port = dev('vpix3200').cfg.ports.http;
      const r = await ipp(port, '/ipp/print', 0x0002, {}, { media: v.kw('iso_a4_210x297mm') }, fs.readFileSync(path.join(S, 'broschuere-a4-10-seiten.pdf')));
      const id = r.groups.find((g) => g.name === 'job').attrs['job-id'];
      const job = await waitFor(() => { const j = fleet.jobs.get(id); return j && j.state === 'waiting' && j; });
      assert.equal(dev('vpix3200').status.state, 'stopped');
      dev('vpix3200').loadSlot('tray-4', 'cc-100-a4');
      await waitFor(() => job.state === 'completed');
    });

    await t.test('Roland Print & Cut mit CutContour', async () => {
      const r = await ipp(dev('vg3640').cfg.ports.http, '/ipp/print/QueueA', 0x0002, {}, { copies: v.int(4) }, fs.readFileSync(path.join(S, 'aufkleber-cutcontour.pdf')));
      const id = r.groups.find((g) => g.name === 'job').attrs['job-id'];
      const job = await waitFor(() => { const j = fleet.jobs.get(id); return j && j.isFinal && j; });
      assert.equal(job.state, 'completed', job.stateMessage);
      const layout = JSON.parse(fs.readFileSync(job.file('layout.json')));
      assert.equal(layout.surfaces[0].overlay.cutPaths.length, 8);
      assert.ok(fs.readFileSync(job.file('schnitt.camm'), 'utf8').startsWith('IN;'));
    });

    await t.test('Socket 9100 mit PJL (Heften + Lochen)', async () => {
      await new Promise((res) => { const s = net.connect(dev('ipv1350').cfg.ports.raw, '127.0.0.1', () => s.end(fs.readFileSync(path.join(S, 'pjl-job-a4-heften-lochen.prn')))); s.on('close', res); });
      const job = await waitFor(() => Array.from(fleet.jobs.values()).find((j) => j.source.protocol === 'Socket 9100' && j.isFinal));
      assert.equal(job.state, 'completed', job.stateMessage);
      assert.equal(job.ticket.finishing.staple, 'top-left');
      assert.equal(job.ticket.copies, 3);
    });

    await t.test('colorWAVE: A0 automatisch auf 841-mm-Rolle gedreht und gefaltet', async () => {
      const r = await ipp(dev('cw3800').cfg.ports.http, '/ipp/print/CAD_Falten_DIN824', 0x0002, {}, null, fs.readFileSync(path.join(S, 'plan-a0-quer.pdf')));
      const id = r.groups.find((g) => g.name === 'job').attrs['job-id'];
      const job = await waitFor(() => { const j = fleet.jobs.get(id); return j && j.isFinal && j; });
      const layout = JSON.parse(fs.readFileSync(job.file('layout.json')));
      assert.equal(Math.round(layout.surfaces[0].wPt * 25.4 / 72), 841);
      assert.ok(layout.surfaces[0].overlay.folds.length >= 3);
    });

    await t.test('Foto 10×15 mit Füllen/Beschnitt', async () => {
      const r = await ipp(dev('sld1070').cfg.ports.http, '/ipp/print/10x15_Luster', 0x0002, {}, { copies: v.int(2) }, fs.readFileSync(path.join(S, 'foto-3zu2-1800x1200.png')));
      const id = r.groups.find((g) => g.name === 'job').attrs['job-id'];
      const job = await waitFor(() => { const j = fleet.jobs.get(id); return j && j.isFinal && j; });
      assert.equal(job.state, 'completed', job.stateMessage);
      assert.equal(job.counters.prints, 2);
    });
  } finally {
    await env.close();
  }
});
