'use strict';
// LPD/LPR-Server (RFC 1179) je Gerät. Warteschlangennamen wie am echten Front-End
// (Fiery: print / hold / direct, VersaWorks: QueueA / QueueB, ...).
const net = require('net');
const { setTicket } = require('../pipeline/ticket');

const CF_DE = { H: 'Host', P: 'Benutzer', J: 'Jobname', C: 'Klasse', L: 'Bannerseite für', T: 'Titel', N: 'Dateiname', M: 'Mail an', I: 'Einzug', W: 'Breite', U: 'Datei löschen', '#': 'Exemplare (BSD)', f: 'formatiert drucken', l: 'Steuerzeichen durchlassen', o: 'PostScript', p: 'mit pr', v: 'Raster', d: 'DVI', g: 'Plot' };

function startLpd(fleet, dev, host, port) {
  const server = net.createServer((sock) => {
    const remote = `${sock.remoteAddress}:${sock.remotePort}`;
    let buf = Buffer.alloc(0);
    let state = 'cmd';
    let queue = null;
    let expect = null; // { type:'control'|'data', len, name }
    const files = { control: null, data: [] };
    const transcript = [];
    const ack = () => sock.write(Buffer.from([0]));
    const nack = () => sock.write(Buffer.from([1]));

    function finish() {
      if (!files.data.length) return;
      const cf = files.control ? files.control.toString('latin1') : '';
      const lines = cf.split('\n').filter(Boolean);
      const info = {};
      for (const l of lines) { const k = l[0]; info[k] = info[k] || l.slice(1); }
      const q = dev.queueByName(queue) ? queue : null;
      const job = fleet.createJob(dev.id, { name: info.J || info.N || null, user: info.P, source: { protocol: 'LPR', remote, queue: queue }, queue: q || queue });
      job.addProtocol('in', `LPD Druckauftrag an Warteschlange „${queue}" von ${remote}`, transcript.join('\n') + '\n\nSteuerdatei:\n' + lines.map((l) => `  ${l[0]}  ${(CF_DE[l[0]] || '?').padEnd(22)} ${l.slice(1)}`).join('\n'));
      const copies = lines.filter((l) => /^[flopvdg]/.test(l)).length / Math.max(1, files.data.length);
      if (info['#']) setTicket(job, 'copies', Number(info['#']) || 1, 'LPD Steuerdatei #');
      else if (copies > 1) setTicket(job, 'copies', Math.round(copies), 'LPD Steuerdatei (Druckzeilen je Datei)');
      if (info.N && !info.J) job.name = info.N;
      const data = Buffer.concat(files.data.map((d) => d.data));
      fleet.submit(job, data, { filename: info.N || files.data[0].name });
      files.data = []; files.control = null;
    }

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (expect) {
          if (expect.len === 0) {
            // unbekannte Länge (bis Verbindungsende)
            return;
          }
          if (buf.length < expect.len + 1) return;
          const data = buf.subarray(0, expect.len);
          buf = buf.subarray(expect.len + 1); // abschließendes \0
          if (expect.type === 'control') files.control = data;
          else files.data.push({ name: expect.name, data });
          transcript.push(`  ← ${expect.type === 'control' ? 'Steuerdatei' : 'Datendatei'} ${expect.name} (${expect.len} Bytes) empfangen, ACK`);
          expect = null;
          ack();
          if (files.control && files.data.length) { /* evtl. weitere Dateien folgen; Abschluss bei Verbindungsende */ }
          continue;
        }
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        const line = buf.subarray(0, nl).toString('latin1');
        buf = buf.subarray(nl + 1);
        const code = line.charCodeAt(0);
        const rest = line.slice(1);
        if (state === 'cmd') {
          if (code === 0x02) { // Receive job
            queue = rest.trim();
            transcript.push(`→ 0x02 Auftrag empfangen, Warteschlange „${queue}"`);
            const q = dev.queueByName(queue);
            if (!q) transcript.push(`  (Warteschlange „${queue}" unbekannt – wird an Standard weitergeleitet; ein echtes Fiery würde den Job ablehnen)`);
            if (!dev.status.accepting) { nack(); transcript.push('  ← NACK (offline)'); return; }
            state = 'sub';
            ack();
          } else if (code === 0x03 || code === 0x04) { // Queue state
            const q = rest.split(' ')[0];
            const jobs = fleet.jobsOf(dev.id).filter((j) => !j.isFinal);
            const long = code === 0x04;
            const out = [`${dev.cfg.name} (${q}) ist ${dev.status.stateDe.toLowerCase()}`];
            if (!jobs.length) out.push('keine Einträge');
            else for (const j of jobs) out.push(long ? `${j.user}: ${j.id} ${j.name} – ${j.stateText} (${j.input?.bytes || 0} Bytes)` : `${j.id} ${j.user} ${j.name} ${j.stateText}`);
            sock.end(out.join('\n') + '\n');
            dev.trace('lpd', 'in', `LPD Statusabfrage (${long ? 'lang' : 'kurz'}) „${q}" von ${remote}`, out.join('\n'), true);
            return;
          } else if (code === 0x05) { // Remove jobs
            const [q, agent, ...ids] = rest.split(' ');
            for (const id of ids) { try { fleet.jobAction(Number(id), 'cancel'); } catch { /* */ } }
            dev.trace('lpd', 'in', `LPD Jobs entfernen ${ids.join(',')} (${agent}) in „${q}"`);
            sock.end();
            return;
          } else if (code === 0x01) { // Print waiting jobs
            dev.trace('lpd', 'in', `LPD „Wartende Jobs drucken" für ${rest}`);
            ack(); sock.end(); return;
          } else { nack(); sock.end(); return; }
        } else if (state === 'sub') {
          if (code === 0x01) { transcript.push('→ 0x01 Auftrag abbrechen'); files.data = []; files.control = null; ack(); continue; }
          if (code === 0x02 || code === 0x03) {
            const sp = rest.indexOf(' ');
            const len = parseInt(rest.slice(0, sp), 10);
            const name = rest.slice(sp + 1).trim();
            expect = { type: code === 0x02 ? 'control' : 'data', len, name };
            transcript.push(`→ 0x0${code} ${code === 0x02 ? 'Steuerdatei' : 'Datendatei'} ${name}, ${len === 0 ? 'Länge unbekannt (bis Verbindungsende)' : len + ' Bytes'}`);
            ack();
            continue;
          }
          nack();
        }
      }
    });
    sock.on('end', () => {
      if (expect && expect.len === 0) {
        files.data.push({ name: expect.name, data: buf });
        transcript.push(`  ← Datendatei ${expect.name} (${buf.length} Bytes, bis Verbindungsende) empfangen`);
      }
      try { finish(); } catch (e) { fleet.log(dev.id, 'error', `LPD: ${e.message}`); }
    });
    sock.on('close', () => { try { finish(); } catch { /* */ } });
    sock.on('error', () => {});
  });
  return listen(server, host, port);
}

function listen(server, host, port) {
  return new Promise((resolve) => {
    server.once('error', (e) => resolve({ server: null, error: e.code === 'EACCES' ? `Port ${port}: keine Berechtigung (Ports < 1024 benötigen Admin-/Root-Rechte)` : e.code === 'EADDRINUSE' ? `Port ${port} ist bereits belegt` : e.message }));
    server.listen(port, host, () => resolve({ server, error: null }));
  });
}

module.exports = { startLpd, listen };
