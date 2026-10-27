'use strict';
// Socket-Druck (AppSocket/JetDirect, Port 9100) inkl. bidirektionaler PJL-Statusabfragen.
const net = require('net');
const { pjlInquiryResponse, unwrapPjl } = require('./pjl');
const { listen } = require('./lpd');
const { hexdump } = require('../util/misc');

function startRaw(fleet, dev, host, port) {
  const server = net.createServer((sock) => {
    const remote = `${sock.remoteAddress}:${sock.remotePort}`;
    const chunks = [];
    let size = 0;
    let scanned = 0;
    const answers = [];
    let text = '';
    sock.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      // PJL-Abfragen beantworten, solange wir im PJL-Teil sind
      if (scanned < 64 * 1024) {
        text += c.toString('latin1');
        const lines = text.split(/\r?\n/);
        text = lines.pop();
        for (const l of lines) {
          scanned += l.length + 1;
          const clean = l.replace(/^\x1b%-12345X/, '').trim();
          if (/^@PJL\s+(INFO|INQUIRE|DINQUIRE|ECHO)\b/i.test(clean)) {
            const r = pjlInquiryResponse(clean, { ...dev.cfg, status: dev.status });
            if (r) { sock.write(r); answers.push(`${clean}\n  ⇒ ${r.replace(/\r\n/g, ' | ').replace(/\f/, '')}`); }
          }
        }
      }
    });
    sock.on('end', () => {
      const data = Buffer.concat(chunks, size);
      const { pjl, payload } = unwrapPjl(data);
      const hasPayload = payload.length > 16 && payload.toString('latin1').trim().length > 0 && !/^@PJL/.test(payload.toString('latin1', 0, 4));
      if (!hasPayload) {
        dev.trace('raw', 'in', `Socket ${port}: ${pjl ? pjl.commands.length + ' PJL-Befehle' : data.length + ' Bytes'} ohne Druckdaten von ${remote} (Statusabfrage)`, (answers.join('\n') || (pjl ? pjl.commands.join('\n') : hexdump(data, 256))), true);
        sock.end();
        return;
      }
      try {
        const job = fleet.createJob(dev.id, { name: null, user: null, source: { protocol: 'Socket 9100', remote, port } });
        job.addProtocol('in', `Socket-Verbindung (AppSocket) von ${remote}, ${data.length} Bytes`, `Erste Bytes:\n${hexdump(data, 256)}${answers.length ? '\n\nBeantwortete PJL-Abfragen:\n' + answers.join('\n') : ''}`);
        if (answers.length) job.addLog('PROTOKOLL', `${answers.length} PJL-Statusabfrage(n) beantwortet`);
        fleet.submit(job, data, {});
      } catch (e) { fleet.log(dev.id, 'error', `Socket: ${e.message}`); }
      sock.end();
    });
    sock.on('error', () => {});
  });
  return listen(server, host, port);
}

module.exports = { startRaw };
