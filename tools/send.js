#!/usr/bin/env node
'use strict';
// Kleiner Test-Client, der Druckdaten wie eine Drucker-App über die echten Protokolle schickt.
//
//   node tools/send.js ipp  <datei> --url ipp://127.0.0.1:6310/ipp/print [--attr copies=2 --attr sides=two-sided-long-edge --attr finishings=20 --attr media=iso_a4_210x297mm]
//   node tools/send.js lpr  <datei> --host 127.0.0.1 --port 5150 --queue hold
//   node tools/send.js raw  <datei> --host 127.0.0.1 --port 9100
//   node tools/send.js jmf  <datei> --url http://127.0.0.1:6310/jmf [--copies 2 --duplex --staple]
//   node tools/send.js status --url ipp://127.0.0.1:6310/ipp/print
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { encode, decode, v, describe } = require('../src/protocols/ipp/codec');

const args = process.argv.slice(2);
const mode = args[0];
const file = args[1] && !args[1].startsWith('--') ? args[1] : null;
const opt = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 ? args[i + 1] : d; };
const flag = (n) => args.includes('--' + n);
const multi = (n) => args.flatMap((a, i) => (a === '--' + n ? [args[i + 1]] : []));

function ippRequest(url, code, opAttrs, jobAttrs, data) {
  const u = new URL(url.replace(/^ipp:/, 'http:'));
  const body = Buffer.concat([encode({ version: '2.0', code, requestId: 1, groups: [{ tag: 1, attrs: opAttrs }, ...(jobAttrs && Object.keys(jobAttrs).length ? [{ tag: 2, attrs: jobAttrs }] : [])] }), data || Buffer.alloc(0)]);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port || 631, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length } }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve(decode(Buffer.concat(ch))));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function parseAttr(s) {
  const [k, val] = s.split('=');
  if (k === 'finishings') return [k, val.split(',').map((x) => v.enum(Number(x)))];
  if (['copies', 'number-up', 'job-priority'].includes(k)) return [k, v.int(Number(val))];
  if (k === 'media-col') {
    // media-col=210x297[,source][,type]
    const [size, source, type] = val.split(',');
    const [w, h] = size.split('x').map(Number);
    const col = { 'media-size': v.col({ 'x-dimension': v.int(w * 100), 'y-dimension': v.int(h * 100) }) };
    if (source) col['media-source'] = v.kw(source);
    if (type) col['media-type'] = v.kw(type);
    return [k, v.col(col)];
  }
  if (k === 'page-ranges') { const [a, b] = val.split('-').map(Number); return [k, v.range(a, b || a)]; }
  return [k, v.kw(val)];
}

(async () => {
  if (mode === 'ipp' || mode === 'status') {
    const url = opt('url', 'ipp://127.0.0.1:6310/ipp/print');
    const op = { 'attributes-charset': v.charset('utf-8'), 'attributes-natural-language': v.lang('de'), 'printer-uri': v.uri(url), 'requesting-user-name': v.name(process.env.USER || 'tester') };
    if (mode === 'status') {
      const r = await ippRequest(url, 0x000b, { ...op, 'requested-attributes': [v.kw('printer-state'), v.kw('printer-state-reasons'), v.kw('media-ready'), v.kw('media-col-ready'), v.kw('marker-levels'), v.kw('finishings-supported')] });
      console.log(describe(r, false));
      return;
    }
    const data = fs.readFileSync(file);
    op['job-name'] = v.name(path.basename(file));
    op['document-format'] = v.mime(opt('format', 'application/octet-stream'));
    const jobAttrs = Object.fromEntries(multi('attr').map(parseAttr));
    const r = await ippRequest(url, 0x0002, op, jobAttrs, data);
    console.log(describe(r, false));
    const jobId = r.groups.find((g) => g.name === 'job')?.attrs['job-id'];
    if (jobId && flag('wait')) {
      for (;;) {
        await new Promise((res) => setTimeout(res, 1000));
        const s = await ippRequest(url, 0x0009, { ...op, 'job-id': v.int(jobId), 'requested-attributes': [v.kw('job-state'), v.kw('job-state-reasons'), v.kw('job-state-message'), v.kw('job-media-sheets-completed')] });
        const a = s.groups.find((g) => g.name === 'job')?.attrs || {};
        console.log(`job ${jobId}: state=${a['job-state']} reasons=${a['job-state-reasons']} msg=${a['job-state-message']} sheets=${a['job-media-sheets-completed']}`);
        if ([4, 7, 8, 9].includes(a['job-state'])) break;
      }
    }
  } else if (mode === 'lpr') {
    const data = fs.readFileSync(file);
    const host = opt('host', '127.0.0.1'), port = Number(opt('port', 5150)), queue = opt('queue', 'print');
    const n = 100 + Math.floor(Math.random() * 800);
    const cf = `H${require('os').hostname()}\nP${process.env.USER || 'tester'}\nJ${path.basename(file)}\nN${path.basename(file)}\nldfA${n}host\n`;
    const s = net.connect(port, host);
    const steps = [Buffer.from(`\x02${queue}\n`), Buffer.from(`\x02${cf.length} cfA${n}host\n`), Buffer.concat([Buffer.from(cf), Buffer.from([0])]), Buffer.from(`\x03${data.length} dfA${n}host\n`), Buffer.concat([data, Buffer.from([0])])];
    let i = 0;
    s.on('connect', () => s.write(steps[i++]));
    s.on('data', (d) => {
      if (d[0] !== 0) { console.error('NACK vom Server'); s.end(); return; }
      if (i < steps.length) s.write(steps[i++]); else { console.log(`LPR an ${host}:${port} Queue „${queue}" übertragen (${data.length} Bytes)`); s.end(); }
    });
  } else if (mode === 'raw') {
    const data = fs.readFileSync(file);
    const host = opt('host', '127.0.0.1'), port = Number(opt('port', 9100));
    const s = net.connect(port, host, () => { s.end(data); });
    s.on('data', (d) => process.stdout.write(d.toString('latin1')));
    s.on('close', () => console.log(`\nSocket ${host}:${port}: ${data.length} Bytes gesendet`));
  } else if (mode === 'jmf') {
    const data = fs.readFileSync(file);
    const url = new URL(opt('url', 'http://127.0.0.1:6310/jmf'));
    const copies = opt('copies', '1');
    const jdf = `<?xml version="1.0" encoding="UTF-8"?>
<JDF xmlns="http://www.CIP4.org/JDFSchema_1_1" ID="n1" JobID="J-${Date.now()}" Type="Combined" Types="LayoutPreparation Imposition Interpreting Rendering DigitalPrinting${flag('staple') ? ' Stitching' : ''}" Status="Waiting" Version="1.3" DescriptiveName="${path.basename(file)}">
  <ResourcePool>
    <RunList ID="RL1" Class="Parameter" Status="Available"><LayoutElement><FileSpec URL="cid:dokument" MimeType="application/pdf"/></LayoutElement></RunList>
    <LayoutPreparationParams ID="LPP" Class="Parameter" Status="Available" Sides="${flag('duplex') ? 'TwoSidedFlipY' : 'OneSidedFront'}"/>
    <Media ID="M1" Class="Consumable" Status="Available" Dimension="595.28 841.89" MediaType="Paper" Weight="100"/>
    ${flag('staple') ? '<StitchingParams ID="SP" Class="Parameter" Status="Available" StitchType="Corner" ReferenceEdge="Left"/>' : ''}
    <Component ID="C1" Class="Quantity" Status="Unavailable" ComponentType="FinalProduct"/>
  </ResourcePool>
  <ResourceLinkPool>
    <RunListLink rRef="RL1" Usage="Input"/><MediaLink rRef="M1" Usage="Input"/><LayoutPreparationParamsLink rRef="LPP" Usage="Input"/>
    ${flag('staple') ? '<StitchingParamsLink rRef="SP" Usage="Input"/>' : ''}
    <ComponentLink rRef="C1" Usage="Output" Amount="${copies}"/>
  </ResourceLinkPool>
</JDF>`;
    const jmf = `<?xml version="1.0" encoding="UTF-8"?>
<JMF xmlns="http://www.CIP4.org/JDFSchema_1_1" SenderID="send.js" TimeStamp="${new Date().toISOString()}" Version="1.3">
  <Command ID="c1" Type="SubmitQueueEntry"><QueueSubmissionParams URL="cid:ticket" ${flag('hold') ? 'Hold="true"' : ''}/></Command>
</JMF>`;
    const b = 'vpf' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Type: application/vnd.cip4-jmf+xml\r\nContent-ID: <jmf>\r\n\r\n${jmf}\r\n`),
      Buffer.from(`--${b}\r\nContent-Type: application/vnd.cip4-jdf+xml\r\nContent-ID: <ticket>\r\n\r\n${jdf}\r\n`),
      Buffer.from(`--${b}\r\nContent-Type: application/pdf\r\nContent-ID: <dokument>\r\nContent-Transfer-Encoding: binary\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}; type="application/vnd.cip4-jmf+xml"`, 'Content-Length': body.length } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => console.log(t));
    });
    req.end(body);
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 10).join('\n'));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
