'use strict';
// Minimaler XML-Parser für JDF/JMF (wohlgeformtes XML, ohne DTD).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseXml(str) {
  const root = { name: '#root', local: '#root', attrs: {}, children: [], text: '', parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(str))) {
    if (m[1] !== undefined) cur.text += m[1];
    else if (m[2]) { if (cur.parent) cur = cur.parent; }
    else if (m[3]) {
      const node = { name: m[3], local: m[3].split(':').pop(), attrs: {}, children: [], text: '', parent: cur };
      const ar = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ''))) node.attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
      cur.children.push(node);
      if (!m[5]) cur = node;
    } else if (m[6]) {
      if (/\S/.test(m[6])) cur.text += decode(m[6]);
    }
  }
  return root.children[0] || null;
}

function attr(node, name) {
  if (!node) return undefined;
  if (name in node.attrs) return node.attrs[name];
  for (const k of Object.keys(node.attrs)) if (k.split(':').pop() === name) return node.attrs[k];
  return undefined;
}
function find(node, local) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.local === local) return c;
    const f = find(c, local);
    if (f) return f;
  }
  return null;
}
function findAll(node, local, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (c.local === local) out.push(c);
    findAll(c, local, out);
  }
  return out;
}
function child(node, local) {
  return node ? node.children.find((c) => c.local === local) || null : null;
}

module.exports = { parseXml, attr, find, findAll, child, esc };
