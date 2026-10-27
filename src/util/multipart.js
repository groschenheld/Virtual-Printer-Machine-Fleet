'use strict';
// Parser für multipart/form-data und multipart/related (MIME-Pakete für JMF/JDF).

function getBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  return m ? m[1] || m[2] : null;
}

function parseHeaderParams(value) {
  const out = {};
  const re = /;\s*([\w*-]+)=(?:"([^"]*)"|([^;]*))/g;
  let m;
  while ((m = re.exec(value))) out[m[1].toLowerCase()] = m[2] ?? (m[3] || '').trim();
  return out;
}

function parseMultipart(buf, contentType) {
  const boundary = getBoundary(contentType);
  if (!boundary) throw new Error('multipart ohne boundary');
  const delim = Buffer.from('--' + boundary);
  const parts = [];
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    let start = pos + delim.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // Abschluss "--"
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a) start += 1;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    let end = next;
    if (buf[end - 1] === 0x0a) end--;
    if (buf[end - 1] === 0x0d) end--;
    const part = buf.subarray(start, end);
    let hEnd = part.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (hEnd === -1) { hEnd = part.indexOf('\n\n'); sepLen = 2; }
    const headerText = hEnd === -1 ? '' : part.subarray(0, hEnd).toString('latin1');
    let data = hEnd === -1 ? part : part.subarray(hEnd + sepLen);
    const headers = {};
    for (const line of headerText.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    if ((headers['content-transfer-encoding'] || '').toLowerCase() === 'base64') data = Buffer.from(data.toString('latin1'), 'base64');
    const disp = parseHeaderParams(';' + (headers['content-disposition'] || '').replace(/^[^;]*/, ''));
    parts.push({
      headers,
      name: disp.name,
      filename: disp.filename,
      contentType: (headers['content-type'] || '').split(';')[0].trim(),
      contentId: (headers['content-id'] || '').replace(/^<|>$/g, ''),
      data: Buffer.from(data),
    });
    pos = next;
  }
  return parts;
}

module.exports = { parseMultipart, getBoundary };
