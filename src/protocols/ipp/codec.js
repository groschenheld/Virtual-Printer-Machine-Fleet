'use strict';
// IPP/1.1 & 2.0 Binärformat (RFC 8010) – Dekodieren/Enkodieren inkl. Collections.

const TAG = {
  operation: 0x01, job: 0x02, end: 0x03, printer: 0x04, unsupported: 0x05,
  unsupportedValue: 0x10, unknown: 0x12, noValue: 0x13,
  integer: 0x21, boolean: 0x22, enum: 0x23,
  octetString: 0x30, dateTime: 0x31, resolution: 0x32, rangeOfInteger: 0x33, begCollection: 0x34, textWithLanguage: 0x35, nameWithLanguage: 0x36, endCollection: 0x37,
  textWithoutLanguage: 0x41, nameWithoutLanguage: 0x42, keyword: 0x44, uri: 0x45, uriScheme: 0x46, charset: 0x47, naturalLanguage: 0x48, mimeMediaType: 0x49, memberAttrName: 0x4a,
};
const TAG_NAME = Object.fromEntries(Object.entries(TAG).map(([k, v]) => [v, k]));
const GROUP_NAME = { 1: 'operation', 2: 'job', 4: 'printer', 5: 'unsupported', 6: 'subscription', 7: 'event-notification', 9: 'document' };

const OP = {
  0x0002: 'Print-Job', 0x0003: 'Print-URI', 0x0004: 'Validate-Job', 0x0005: 'Create-Job', 0x0006: 'Send-Document', 0x0007: 'Send-URI',
  0x0008: 'Cancel-Job', 0x0009: 'Get-Job-Attributes', 0x000a: 'Get-Jobs', 0x000b: 'Get-Printer-Attributes', 0x000c: 'Hold-Job', 0x000d: 'Release-Job',
  0x000e: 'Restart-Job', 0x0010: 'Pause-Printer', 0x0011: 'Resume-Printer', 0x0012: 'Purge-Jobs', 0x0013: 'Set-Printer-Attributes', 0x0014: 'Set-Job-Attributes',
  0x003b: 'Close-Job', 0x003c: 'Identify-Printer', 0x0039: 'Cancel-My-Jobs', 0x003a: 'Cancel-Current-Job',
  0x4001: 'CUPS-Get-Default', 0x4002: 'CUPS-Get-Printers',
};
const OP_ID = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, Number(k)]));
const STATUS = {
  0x0000: 'successful-ok', 0x0001: 'successful-ok-ignored-or-substituted-attributes', 0x0002: 'successful-ok-conflicting-attributes',
  0x0400: 'client-error-bad-request', 0x0401: 'client-error-forbidden', 0x0404: 'client-error-not-possible', 0x0406: 'client-error-not-found', 0x0408: 'client-error-request-value-too-long',
  0x040a: 'client-error-document-format-not-supported', 0x040b: 'client-error-attributes-or-values-not-supported', 0x040d: 'client-error-conflicting-attributes',
  0x0500: 'server-error-internal-error', 0x0501: 'server-error-operation-not-supported', 0x0502: 'server-error-service-unavailable', 0x0503: 'server-error-version-not-supported', 0x0506: 'server-error-not-accepting-jobs', 0x0507: 'server-error-busy',
};

/** Dekodiert eine IPP-Nachricht. Rückgabe { version, code, requestId, groups:[{tag,name,attrs:{}}], data } */
function decode(buf) {
  let pos = 0;
  const u8 = () => buf[pos++];
  const u16 = () => { const v = buf.readUInt16BE(pos); pos += 2; return v; };
  const i32 = () => { const v = buf.readInt32BE(pos); pos += 4; return v; };
  const version = `${buf[0]}.${buf[1]}`;
  pos = 2;
  const code = u16();
  const requestId = i32();
  const groups = [];
  let group = null;
  let lastName = null;
  const colStack = [];

  function readValue(tag, len) {
    const v = buf.subarray(pos, pos + len);
    pos += len;
    switch (tag) {
      case TAG.integer: case TAG.enum: return len === 4 ? v.readInt32BE(0) : 0;
      case TAG.boolean: return !!v[0];
      case TAG.rangeOfInteger: return { lower: v.readInt32BE(0), upper: v.readInt32BE(4) };
      case TAG.resolution: return { x: v.readInt32BE(0), y: v.readInt32BE(4), units: v[8] === 3 ? 'dpi' : 'dpcm' };
      case TAG.dateTime: return `${v.readUInt16BE(0)}-${String(v[2]).padStart(2, '0')}-${String(v[3]).padStart(2, '0')}T${String(v[4]).padStart(2, '0')}:${String(v[5]).padStart(2, '0')}:${String(v[6]).padStart(2, '0')}`;
      case TAG.textWithLanguage: case TAG.nameWithLanguage: {
        const ll = v.readUInt16BE(0); const tl = v.readUInt16BE(2 + ll);
        return v.subarray(4 + ll, 4 + ll + tl).toString('utf8');
      }
      case TAG.octetString: return v.toString('latin1');
      case TAG.noValue: case TAG.unknown: case TAG.unsupportedValue: return null;
      default: return v.toString('utf8');
    }
  }

  while (pos < buf.length) {
    const tag = u8();
    if (tag === TAG.end) break;
    if (tag < 0x10) {
      group = { tag, name: GROUP_NAME[tag] || `group-${tag}`, attrs: {} };
      groups.push(group);
      continue;
    }
    const nameLen = u16();
    const name = buf.subarray(pos, pos + nameLen).toString('utf8');
    pos += nameLen;
    const valLen = u16();
    // Collection-Verarbeitung
    if (tag === TAG.begCollection) {
      pos += valLen;
      const col = {};
      if (colStack.length) {
        const parent = colStack[colStack.length - 1];
        const key = nameLen ? name : parent._lastMember;
        addValue(parent.obj, key, col, true);
        colStack.push({ obj: col, _lastMember: null });
      } else {
        const key = nameLen ? name : lastName;
        addValue(group.attrs, key, col, true, TAG.begCollection);
        lastName = key;
        colStack.push({ obj: col, _lastMember: null });
      }
      continue;
    }
    if (tag === TAG.endCollection) { pos += valLen; colStack.pop(); continue; }
    if (tag === TAG.memberAttrName) {
      const member = buf.subarray(pos, pos + valLen).toString('utf8');
      pos += valLen;
      colStack[colStack.length - 1]._lastMember = member;
      continue;
    }
    const value = readValue(tag, valLen);
    if (colStack.length) {
      const top = colStack[colStack.length - 1];
      addValue(top.obj, top._lastMember, value, false);
      continue;
    }
    const key = nameLen ? name : lastName;
    if (!group) { group = { tag: 1, name: 'operation', attrs: {} }; groups.push(group); }
    addValue(group.attrs, key, value, !nameLen, tag);
    lastName = key;
  }
  return { version, code, requestId, groups, data: buf.subarray(pos) };
}

function addValue(obj, key, value, isAdditional, tag) {
  if (!key) return;
  if (!(key in obj)) { obj[key] = value; if (tag) Object.defineProperty(obj, `__tag_${key}`, { value: tag, enumerable: false }); return; }
  if (Array.isArray(obj[key]) && obj[`__multi_${key}`]) obj[key].push(value);
  else { obj[key] = [obj[key], value]; Object.defineProperty(obj, `__multi_${key}`, { value: true, enumerable: false }); }
}

function attrsOf(msg, groupName) {
  const out = {};
  for (const g of msg.groups) if (g.name === groupName) Object.assign(out, g.attrs);
  return out;
}

// ------------------------------------------------------------------ Enkodieren
// Werte werden als { tag, value } oder Array davon angegeben; Collections als { tag:'collection', value:{ name: {tag,value} } }
function encode({ version = '2.0', code, requestId, groups }) {
  const parts = [];
  const head = Buffer.alloc(8);
  const [maj, min] = version.split('.').map(Number);
  head[0] = maj; head[1] = min;
  head.writeUInt16BE(code, 2);
  head.writeInt32BE(requestId, 4);
  parts.push(head);
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const writeAttr = (tag, name, valBuf) => {
    const nb = Buffer.from(name, 'utf8');
    parts.push(Buffer.from([tag]), u16(nb.length), nb, u16(valBuf.length), valBuf);
  };
  const valueBuf = (tag, v) => {
    switch (tag) {
      case TAG.integer: case TAG.enum: { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); return b; }
      case TAG.boolean: return Buffer.from([v ? 1 : 0]);
      case TAG.rangeOfInteger: { const b = Buffer.alloc(8); b.writeInt32BE(v.lower); b.writeInt32BE(v.upper, 4); return b; }
      case TAG.resolution: { const b = Buffer.alloc(9); b.writeInt32BE(v.x); b.writeInt32BE(v.y, 4); b[8] = v.units === 'dpcm' ? 4 : 3; return b; }
      case TAG.dateTime: {
        const d = v instanceof Date ? v : new Date(v);
        const b = Buffer.alloc(11);
        b.writeUInt16BE(d.getUTCFullYear()); b[2] = d.getUTCMonth() + 1; b[3] = d.getUTCDate(); b[4] = d.getUTCHours(); b[5] = d.getUTCMinutes(); b[6] = d.getUTCSeconds(); b[7] = 0; b[8] = 0x2b; b[9] = 0; b[10] = 0;
        return b;
      }
      case TAG.noValue: case TAG.unknown: case TAG.unsupportedValue: return Buffer.alloc(0);
      case TAG.octetString: return Buffer.from(String(v), 'latin1');
      default: return Buffer.from(String(v), 'utf8');
    }
  };
  const writeValue = (name, entry, first) => {
    if (entry.tag === 'collection') {
      writeAttr(TAG.begCollection, first ? name : '', Buffer.alloc(0));
      for (const [mName, mEntry] of Object.entries(entry.value)) {
        writeAttr(TAG.memberAttrName, '', Buffer.from(mName, 'utf8'));
        const vals = Array.isArray(mEntry) ? mEntry : [mEntry];
        vals.forEach((ve) => writeValue('', ve, false));
      }
      writeAttr(TAG.endCollection, '', Buffer.alloc(0));
      return;
    }
    writeAttr(entry.tag, first ? name : '', valueBuf(entry.tag, entry.value));
  };
  for (const g of groups) {
    parts.push(Buffer.from([g.tag]));
    for (const [name, val] of Object.entries(g.attrs)) {
      const vals = Array.isArray(val) ? val : [val];
      vals.forEach((ve, i) => writeValue(name, ve, i === 0));
    }
  }
  parts.push(Buffer.from([TAG.end]));
  return Buffer.concat(parts);
}

// Bequeme Konstruktoren
const v = {
  int: (value) => ({ tag: TAG.integer, value }),
  bool: (value) => ({ tag: TAG.boolean, value }),
  enum: (value) => ({ tag: TAG.enum, value }),
  kw: (value) => ({ tag: TAG.keyword, value }),
  text: (value) => ({ tag: TAG.textWithoutLanguage, value }),
  name: (value) => ({ tag: TAG.nameWithoutLanguage, value }),
  uri: (value) => ({ tag: TAG.uri, value }),
  scheme: (value) => ({ tag: TAG.uriScheme, value }),
  charset: (value) => ({ tag: TAG.charset, value }),
  lang: (value) => ({ tag: TAG.naturalLanguage, value }),
  mime: (value) => ({ tag: TAG.mimeMediaType, value }),
  range: (lower, upper) => ({ tag: TAG.rangeOfInteger, value: { lower, upper } }),
  res: (x, y) => ({ tag: TAG.resolution, value: { x, y: y || x, units: 'dpi' } }),
  date: (d) => ({ tag: TAG.dateTime, value: d }),
  octets: (value) => ({ tag: TAG.octetString, value }),
  noValue: () => ({ tag: TAG.noValue, value: null }),
  col: (value) => ({ tag: 'collection', value }),
};

/** Lesbare Darstellung für das Protokoll. */
function describe(msg, isRequest = true) {
  const lines = [];
  const title = isRequest ? `${OP[msg.code] || '0x' + msg.code.toString(16)} (0x${msg.code.toString(16).padStart(4, '0')})` : `${STATUS[msg.code] || '0x' + msg.code.toString(16)} (0x${msg.code.toString(16).padStart(4, '0')})`;
  lines.push(`IPP/${msg.version}  ${title}  request-id=${msg.requestId}`);
  for (const g of msg.groups) {
    lines.push(`  [${g.name}-attributes-tag]`);
    for (const [k, val] of Object.entries(g.attrs)) lines.push(`    ${k} = ${fmtVal(val)}`);
  }
  if (msg.data && msg.data.length) lines.push(`  [Dokumentdaten: ${msg.data.length.toLocaleString('de-DE')} Bytes]`);
  return lines.join('\n');
}
function fmtVal(val) {
  if (Array.isArray(val)) return val.map(fmtVal).join(', ');
  if (val && typeof val === 'object') {
    if ('lower' in val) return `${val.lower}-${val.upper}`;
    if ('units' in val) return `${val.x}x${val.y}${val.units}`;
    return '{' + Object.entries(val).map(([k, x]) => `${k}=${fmtVal(x)}`).join(' ') + '}';
  }
  return JSON.stringify(val);
}
/** Für Antworten aus Encoder-Struktur */
function describeResponse(resp, max = 60) {
  const lines = [`IPP/${resp.version || '2.0'}  ${STATUS[resp.code] || resp.code} (0x${resp.code.toString(16).padStart(4, '0')})  request-id=${resp.requestId}`];
  for (const g of resp.groups) {
    lines.push(`  [${GROUP_NAME[g.tag] || g.tag}-attributes-tag]`);
    const entries = Object.entries(g.attrs);
    for (const [k, val] of entries.slice(0, max)) lines.push(`    ${k} = ${fmtEnc(val)}`);
    if (entries.length > max) lines.push(`    … ${entries.length - max} weitere Attribute`);
  }
  return lines.join('\n');
}
function fmtEnc(val) {
  if (Array.isArray(val)) return val.map(fmtEnc).join(', ');
  if (val && val.tag === 'collection') return '{' + Object.entries(val.value).map(([k, x]) => `${k}=${fmtEnc(x)}`).join(' ') + '}';
  if (val && val.value && typeof val.value === 'object' && 'lower' in val.value) return `${val.value.lower}-${val.value.upper}`;
  if (val && val.value && typeof val.value === 'object' && 'units' in val.value) return `${val.value.x}x${val.value.y}dpi`;
  return val ? JSON.stringify(val.value) : 'null';
}

module.exports = { decode, encode, attrsOf, v, TAG, OP, OP_ID, STATUS, describe, describeResponse };
