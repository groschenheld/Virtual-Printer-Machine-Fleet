'use strict';
// PJL (Printer Job Language): Entpacken, Auswerten und Status-Antworten.

const UEL = Buffer.from('\x1b%-12345X', 'latin1');

/** Trennt PJL-Kopf vom eigentlichen Druckdatenstrom. */
function unwrapPjl(buf) {
  const startsUel = buf.subarray(0, UEL.length).equals(UEL);
  const startsPjl = buf.subarray(0, 4).toString('latin1') === '@PJL';
  if (!startsUel && !startsPjl) return { pjl: null, payload: buf };
  let pos = startsUel ? UEL.length : 0;
  const commands = [];
  let language = null;
  while (pos < buf.length) {
    // Zeile lesen
    let end = buf.indexOf(0x0a, pos);
    if (end === -1) end = buf.length;
    const line = buf.subarray(pos, end).toString('latin1').replace(/\r$/, '');
    if (!line.startsWith('@PJL') && line.trim() !== '') {
      break; // Datenbeginn ohne ENTER LANGUAGE
    }
    pos = end + 1;
    if (line.trim()) commands.push(line.trim());
    const m = /^@PJL\s+ENTER\s+LANGUAGE\s*=\s*(\S+)/i.exec(line);
    if (m) { language = m[1].toUpperCase(); break; }
  }
  let payload = buf.subarray(pos);
  // Abschließendes UEL und nachfolgende PJL-Zeilen (EOJ) entfernen
  const tail = payload.lastIndexOf(UEL);
  let trailer = [];
  if (tail !== -1) {
    trailer = payload.subarray(tail + UEL.length).toString('latin1').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    payload = payload.subarray(0, tail);
  }
  return { pjl: { commands, trailer, language }, payload };
}

/** Erzeugt aus PJL-Befehlen ein Key/Value-Objekt. */
function parsePjlCommands(commands) {
  const out = { set: {}, job: {}, comments: [], other: [] };
  for (const c of commands) {
    let m;
    if ((m = /^@PJL\s+SET\s+([\w.:-]+)\s*=\s*(.*)$/i.exec(c))) out.set[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '').trim();
    else if ((m = /^@PJL\s+JOB\b(.*)$/i.exec(c))) {
      const re = /(\w+)\s*=\s*("[^"]*"|\S+)/g;
      let a;
      while ((a = re.exec(m[1]))) out.job[a[1].toUpperCase()] = a[2].replace(/^"|"$/g, '');
    } else if ((m = /^@PJL\s+COMMENT\s*(.*)$/i.exec(c))) out.comments.push(m[1]);
    else out.other.push(c);
  }
  return out;
}

/** Antworten auf PJL-Statusabfragen (bidirektionale Verbindung, z. B. Port 9100). */
function pjlInquiryResponse(line, device) {
  const up = line.toUpperCase();
  if (/@PJL\s+INFO\s+ID/.test(up)) return `@PJL INFO ID\r\n"${device.model}"\r\n\f`;
  if (/@PJL\s+INFO\s+STATUS/.test(up)) {
    const st = device.status || {};
    const code = st.state === 'stopped' ? 40000 : st.state === 'processing' ? 10023 : 10001;
    const disp = st.state === 'stopped' ? (st.message || 'FEHLER') : st.state === 'processing' ? 'DRUCKT' : 'BEREIT';
    return `@PJL INFO STATUS\r\nCODE=${code}\r\nDISPLAY="${disp}"\r\nONLINE=${st.state === 'stopped' ? 'FALSE' : 'TRUE'}\r\n\f`;
  }
  if (/@PJL\s+INFO\s+CONFIG/.test(up)) {
    const trays = (device.slots || []).map((s) => `\t${s.ippSource.toUpperCase()}`).join('\r\n');
    return `@PJL INFO CONFIG\r\nIN TRAYS [${device.slots.length} ENUMERATED]\r\n${trays}\r\nDUPLEX=${device.duplex ? 'TRUE' : 'FALSE'}\r\nLANGUAGES [3 ENUMERATED]\r\n\tPDF\r\n\tPOSTSCRIPT\r\n\tHPGL2\r\n\f`;
  }
  if (/@PJL\s+INFO\s+USTATUS/.test(up)) return `@PJL INFO USTATUS\r\nDEVICE=ON\r\nJOB=ON\r\nPAGE=OFF\r\nTIMED=0\r\n\f`;
  if (/@PJL\s+INQUIRE\s+(\S+)/.test(up)) {
    const v = /@PJL\s+INQUIRE\s+(\S+)/.exec(up)[1];
    return `@PJL INQUIRE ${v}\r\n?\r\n\f`;
  }
  if (/@PJL\s+ECHO\s+(.*)/i.test(line)) return `@PJL ECHO ${/@PJL\s+ECHO\s+(.*)/i.exec(line)[1]}\r\n\f`;
  return null;
}

module.exports = { unwrapPjl, parsePjlCommands, pjlInquiryResponse, UEL };
