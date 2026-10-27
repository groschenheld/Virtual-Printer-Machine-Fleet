'use strict';
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.pdf': 'application/pdf', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.map': 'application/json', '.ico': 'image/x-icon', '.camm': 'text/plain; charset=utf-8', '.hpgl': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.jmf': 'application/vnd.cip4-jmf+xml', '.jdf': 'application/vnd.cip4-jdf+xml',
};

function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8', headers = {}) {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, ...headers });
  res.end(body);
}

function sendFile(res, file, opts = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Nicht gefunden');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const h = { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': opts.cache ? 'max-age=3600' : 'no-store' };
    if (opts.download) h['Content-Disposition'] = `attachment; filename="${encodeURIComponent(opts.download)}"`;
    res.writeHead(200, h);
    fs.createReadStream(file).pipe(res);
  });
}

/** Sehr kleiner Router: add(method, '/api/jobs/:id', fn) */
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, fn) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\*$/, '(.*)') + '/?$');
    this.routes.push({ method, re, keys, fn });
  }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && r.method !== '*') continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        if (m.length > r.keys.length + 1) params.rest = m[m.length - 1];
        return { fn: r.fn, params };
      }
    }
    return null;
  }
}

module.exports = { readBody, sendJson, sendText, sendFile, Router, MIME };
