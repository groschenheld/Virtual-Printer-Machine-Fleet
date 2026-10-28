'use strict';
// Nachbildung einer Teilmenge der Fiery-API (REST, /live/api/v5/...).
// Hinweis: Pfade und Feldnamen sind an die öffentliche Fiery-API angelehnt, aber nicht vollständig
// oder verbindlich – für exakte Tests bitte gegen die Dokumentation des echten Fiery-Servers prüfen.
const { $t, $tp, $lazy } = require('../i18n.js');
const crypto = require('crypto');
const { sendJson, sendText, sendFile } = require('../util/http');
const { parseMultipart } = require('../util/multipart');
const { setTicket, applyObject, sizeFromName } = require('../pipeline/ticket');

const sessions = new Map();

const STATE = { receiving: 'spooling', pending: 'waiting to process', held: 'held', processing: 'processing', waiting: 'waiting for paper', printing: 'printing', stopped: 'printing stopped', completed: 'printed', canceled: 'canceled', aborted: 'error' };

function jobItem(j) {
  return {
    id: String(j.id), title: j.name, username: j.user, state: STATE[j.state] || j.state, 'job state reasons': j.stateReasons,
    'num copies': j.ticket.copies, 'total pages': j.doc ? j.doc.pages : null, 'media size': j.ticket.media.sizeName || (j.ticket.media.sizeMm ? j.ticket.media.sizeMm.join('x') + 'mm' : null),
    duplex: j.ticket.sides !== 'one-sided', 'queue': j.ticket.queue, date: j.created, 'last modified': j.updated, progress: Math.round(j.progress * 100),
    'printed sheets': j.counters.sheets, 'printed impressions': j.counters.impressions, 'status message': j.stateMessage,
  };
}

// Fiery-artige Attributnamen -> Ticket
function applyFieryAttrs(job, attrs) {
  for (const [k, val] of Object.entries(attrs || {})) {
    const key = k.toLowerCase();
    const src = $t(`Fiery-API ${k}`, `Fiery API ${k}`);
    if (['num copies', 'copies', 'copycount'].includes(key)) setTicket(job, 'copies', Number(val) || 1, src);
    else if (['efduplex', 'duplex'].includes(key)) setTicket(job, 'sides', val === true || /true|top|long|on/i.test(val) ? 'two-sided-long-edge' : /short|bottom/i.test(val) ? 'two-sided-short-edge' : 'one-sided', src);
    else if (['efmediasize', 'media size', 'papersize', 'media'].includes(key)) { const s = sizeFromName(val); if (s) setTicket(job, 'media.sizeMm', s, src); else setTicket(job, 'media.mediaId', val, src); }
    else if (['efmediatype', 'media type'].includes(key)) setTicket(job, 'media.type', String(val).toLowerCase(), src);
    else if (['efmediaweight', 'paper weight'].includes(key)) setTicket(job, 'media.gsm', parseInt(val, 10), src);
    else if (['eftraysel', 'tray', 'paper source', 'media source'].includes(key)) setTicket(job, 'media.source', String(val).toLowerCase(), src);
    else if (['efstapler', 'staple'].includes(key)) { if (!/off|none|false/i.test(val)) setTicket(job, 'finishing.staple', /dual|2/i.test(val) ? 'dual-left' : 'top-left', src); }
    else if (['efpunch', 'punch'].includes(key)) { if (!/off|none|false/i.test(val)) setTicket(job, 'finishing.punch', { holes: /4/.test(val) ? 4 : 2, edge: 'left' }, src); }
    else if (['efbooklet', 'booklet'].includes(key)) { if (!/off|none|false/i.test(val)) { setTicket(job, 'imposition', 'booklet', src); setTicket(job, 'finishing.booklet', { saddle: true }, src); } }
    else if (['efnupoption', 'n-up', 'nup'].includes(key)) { const n = parseInt(val, 10); if (n > 1) { setTicket(job, 'numberUp', n, src); setTicket(job, 'imposition', 'n-up', src); } }
    else if (['efoutputbin', 'output tray'].includes(key)) setTicket(job, 'outputBin', val, src);
    else if (key === 'title' || key === 'job name') { job.name = String(val); setTicket(job, 'jobName', String(val), src); }
    else if (key === 'ticket' && typeof val === 'object') applyObject(job, val, $t('Fiery-API ticket (Simulationsformat)', 'Fiery API ticket (simulation format)'));
    else job.warn('TICKET', $t(`Fiery-API Attribut „${k}" = ${JSON.stringify(val)} nicht ausgewertet`, `Fiery API attribute “${k}” = ${JSON.stringify(val)} not evaluated`));
  }
}

async function handleFieryApi(fleet, dev, req, res, body, pathname, query) {
  const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  const sub = pathname.replace(/^\/live\/api\/v\d+/, '') || '/';
  const method = req.method;
  dev.trace('fiery', 'in', $t(`Fiery-API ${method} ${sub} von ${remote}`, `Fiery API ${method} ${sub} from ${remote}`), body && body.length && body.length < 4000 && !/multipart/.test(req.headers['content-type'] || '') ? body.toString('utf8') : '', method === 'GET');
  const reply = (code, obj) => { dev.trace('fiery', 'out', `Fiery-API ${method} ${sub} → ${code}`, JSON.stringify(obj).slice(0, 4000), method === 'GET'); sendJson(res, code, obj); };
  const cookie = (req.headers.cookie || '').match(/vpf_session=([\w-]+)/);
  const authed = (cookie && sessions.has(cookie[1])) || !dev.settings.fieryApiAuth;

  if (sub === '/login' && method === 'POST') {
    let cred = {};
    try { cred = JSON.parse(body.toString('utf8') || '{}'); } catch { /* */ }
    const id = crypto.randomUUID();
    sessions.set(id, { user: cred.username || 'admin', created: Date.now() });
    fleet.log(dev.id, 'info', $t(`Fiery-API Login „${cred.username || '?'}" von ${remote}${cred.accessrights ? ' (API-Schlüssel übergeben)' : ' (ohne API-Schlüssel)'}`, `Fiery API login “${cred.username || '?'}” from ${remote}${cred.accessrights ? ' (API key supplied)' : ' (without API key)'}`));
    res.setHeader('Set-Cookie', `vpf_session=${id}; Path=/; HttpOnly`);
    return reply(200, { authenticated: true, user: cred.username || 'admin', note: $t('Simulation – Zugangsdaten werden nicht geprüft', 'Simulation – credentials are not checked') });
  }
  if (sub === '/logout') return reply(200, { authenticated: false });
  if (!authed) return reply(401, { error: { code: 401, message: $t('Nicht angemeldet – zuerst POST /login', 'Not logged in – POST /login first') } });

  if (sub === '/info' && method === 'GET') {
    return reply(200, { data: { kind: 'info', item: { name: dev.cfg.frontend.product, model: dev.cfg.model, manufacturer: dev.cfg.vendor, 'system version': 'Simulation', status: dev.status.stateDe, 'status reasons': dev.status.reasons, 'printer name': dev.cfg.name } } });
  }
  if (sub === '/consumables' && method === 'GET') {
    return reply(200, { data: { kind: 'consumables', item: {
      colorants: (dev.cfg.supplies || []).map((s) => ({ name: s.name, level: s.level, type: s.type })),
      trays: dev.cfg.slots.map((s) => { const m = s.loaded && fleet.catalog.get(s.loaded.mediaId); return { name: s.name, id: s.id, media: m ? m.name : null, size: m && m.kind === 'sheet' ? `${m.widthMm}x${m.heightMm}mm` : m ? $t(`${m.widthMm}mm Rolle`, `${m.widthMm}mm roll`) : null, weight: m ? m.gsm : null, level: s.loaded ? (s.kind === 'roll' ? `${s.loaded.levelM ?? m?.lengthM} m` : `${s.loaded.level}/${s.capacity}`) : $t('leer', 'empty') }; }),
    } } });
  }
  if ((sub === '/paper' || sub === '/papercatalog') && method === 'GET') {
    return reply(200, { data: { kind: 'papercatalog', items: Array.from(fleet.catalog.values()).filter((m) => (dev.cfg.kind === 'sheet') === (m.kind === 'sheet')) } });
  }
  if (sub === '/jobs' && method === 'GET') {
    let list = fleet.jobsOf(dev.id).sort((a, b) => b.id - a.id);
    if (query.get('state')) list = list.filter((j) => (STATE[j.state] || j.state).includes(query.get('state')));
    return reply(200, { data: { kind: 'jobs', items: list.map(jobItem) } });
  }
  if (sub === '/jobs' && method === 'POST') {
    const ct = req.headers['content-type'] || '';
    let file = null, attrs = {};
    if (/multipart/i.test(ct)) {
      const parts = parseMultipart(body, ct);
      file = parts.find((p) => p.filename) || parts.find((p) => p.name === 'file');
      const a = parts.find((p) => p.name === 'attributes' || p.name === 'ticket');
      if (a) { try { attrs = JSON.parse(a.data.toString('utf8')); } catch { /* */ } }
    } else file = { data: body, filename: query.get('filename') || 'upload.pdf' };
    if (!file || !file.data || !file.data.length) return reply(400, { error: { code: 400, message: $t('Keine Datei (multipart-Feld „file")', 'No file (multipart field “file”)') } });
    const queue = query.get('queue') || attrs.queue || 'hold';
    const job = fleet.createJob(dev.id, { name: attrs.title || file.filename, user: 'fiery-api', source: { protocol: 'Fiery-API', remote, queue }, queue });
    job.addProtocol('in', $t(`Fiery-API POST /jobs von ${remote}`, `Fiery API POST /jobs from ${remote}`), $t(`Datei: ${file.filename} (${file.data.length} Bytes)\nAttribute: ${JSON.stringify(attrs, null, 2)}\nWarteschlange: ${queue}`, `File: ${file.filename} (${file.data.length} bytes)\nAttributes: ${JSON.stringify(attrs, null, 2)}\nQueue: ${queue}`));
    delete attrs.queue;
    applyFieryAttrs(job, attrs);
    fleet.submit(job, file.data, { filename: file.filename });
    return reply(200, { data: { kind: 'job', item: jobItem(job) } });
  }
  const m = /^\/jobs\/(\d+)(?:\/(\w+))?$/.exec(sub);
  if (m) {
    let job;
    try { job = fleet.job(m[1]); } catch { return reply(404, { error: { code: 404, message: $t('Job nicht gefunden', 'Job not found') } }); }
    if (job.deviceId !== dev.id) return reply(404, { error: { code: 404, message: $t('Job gehört zu einem anderen Gerät', 'Job belongs to another device') } });
    const action = m[2];
    try {
      if (!action && method === 'GET') return reply(200, { data: { kind: 'job', item: { ...jobItem(job), ticket: job.ticket, summary: job.summary } } });
      if (!action && method === 'PUT') {
        let attrs = {};
        try { attrs = JSON.parse(body.toString('utf8') || '{}'); } catch { /* */ }
        job.addProtocol('in', $t(`Fiery-API PUT /jobs/${job.id} (Job-Eigenschaften)`, `Fiery API PUT /jobs/${job.id} (job properties)`), JSON.stringify(attrs, null, 2));
        applyFieryAttrs(job, attrs);
        if (job.resumeFrom === 'print') job.resumeFrom = 'rip';
        job.save();
        return reply(200, { data: { kind: 'job', item: jobItem(job) } });
      }
      if (!action && method === 'DELETE') { fleet.jobAction(job.id, 'delete'); return reply(200, { data: { deleted: true } }); }
      if (action === 'preview' && method === 'GET') {
        if (!job.outputs.ausgabe) return reply(404, { error: { code: 404, message: $t('Noch keine Vorschau (Job nicht gerippt)', 'No preview yet (job not RIPped)') } });
        return sendFile(res, job.file('ausgabe.pdf'));
      }
      if (method === 'PUT' || method === 'POST') {
        job.addProtocol('in', `Fiery-API ${method} /jobs/${job.id}/${action}`, '');
        const map = { print: 'release', process: 'release', hold: 'hold', cancel: 'cancel', reprint: 'reprint', release: 'release' };
        if (!map[action]) return reply(400, { error: { code: 400, message: $t(`Aktion ${action} unbekannt`, `Action ${action} unknown`) } });
        if (action === 'print' && job.isFinal) fleet.jobAction(job.id, 'reprint');
        else fleet.jobAction(job.id, map[action]);
        return reply(200, { data: { kind: 'job', item: jobItem(job) } });
      }
    } catch (e) { return reply(409, { error: { code: 409, message: e.message } }); }
  }
  return reply(404, { error: { code: 404, message: $t(`Endpunkt ${method} ${sub} nicht nachgebildet`, `Endpoint ${method} ${sub} not emulated`) } });
}

module.exports = { handleFieryApi };
