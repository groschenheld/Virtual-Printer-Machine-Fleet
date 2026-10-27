'use strict';
// JDF/JMF (CIP4) – Teilmenge, wie sie Front-Ends (Fiery JDF, PRISMAsync, FreeFlow) für die Job-Übergabe nutzen.
const fs = require('fs');
const path = require('path');
const { parseXml, attr, find, findAll, child, esc } = require('../util/xml');
const { parseMultipart } = require('../util/multipart');
const { setTicket, noteUnknown } = require('../pipeline/ticket');
const { pt2mm, r1 } = require('../util/misc');

const NS = 'http://www.CIP4.org/JDFSchema_1_1';
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
let rid = 1;

function jmfWrap(dev, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<JMF xmlns="${NS}" SenderID="VPF-${esc(dev.id)}" TimeStamp="${now()}" Version="1.3" MaxVersion="1.6">\n${inner}\n</JMF>\n`;
}
function response(msg, type, rc, body = '', comment) {
  return `  <Response ID="R${rid++}" refID="${esc(attr(msg, 'ID') || '')}" Type="${esc(type)}" ReturnCode="${rc}">${comment ? `\n    <Notification Class="${rc ? 'Error' : 'Information'}"><Comment>${esc(comment)}</Comment></Notification>` : ''}${body ? '\n' + body : ''}\n  </Response>`;
}

const STATUS_MAP = { receiving: 'Waiting', pending: 'Waiting', held: 'Held', processing: 'Running', waiting: 'Suspended', printing: 'Running', stopped: 'Suspended', completed: 'Completed', canceled: 'Aborted', aborted: 'Aborted' };

function queueEntryXml(j) {
  return `      <QueueEntry QueueEntryID="${j.id}" JobID="${esc(j.jdfJobId || String(j.id))}" Status="${STATUS_MAP[j.state] || 'Waiting'}" Priority="${j.ticket.priority || 50}" SubmissionTime="${j.created.replace(/\.\d+Z$/, 'Z')}" DescriptiveName="${esc(j.name)}"${j.completedAt ? ` EndTime="${j.completedAt.replace(/\.\d+Z$/, 'Z')}"` : ''}/>`;
}

function deviceStatus(dev) {
  const s = dev.status;
  return s.state === 'stopped' ? 'Stopped' : s.state === 'processing' ? 'Running' : 'Idle';
}

function mediaXml(fleet, dev) {
  return dev.cfg.slots.filter((s) => s.loaded).map((s) => {
    const m = fleet.catalog.get(s.loaded.mediaId);
    if (!m) return '';
    const dim = m.kind === 'roll' ? `${r1((m.widthMm * 72) / 25.4)} 0` : `${r1((Math.min(m.widthMm, m.heightMm) * 72) / 25.4)} ${r1((Math.max(m.widthMm, m.heightMm) * 72) / 25.4)}`;
    return `      <ResourceInfo ResourceName="Media" Status="Available" Amount="${m.kind === 'roll' ? r1(s.loaded.levelM ?? m.lengthM) : s.loaded.level}" Unit="${m.kind === 'roll' ? 'm' : 'Sheet'}">\n        <Media ID="${esc(m.id)}" DescriptiveName="${esc(m.name)}" Dimension="${dim}" Weight="${m.gsm}" MediaType="Paper" MediaTypeDetails="${esc(m.type)}" MediaUnit="${m.kind === 'roll' ? 'Roll' : 'Sheet'}">\n          <Location LocationName="${esc(s.name)}" PhysicalLocation="${esc(s.ippSource)}"/>\n        </Media>\n      </ResourceInfo>`;
  }).join('\n');
}

/** JDF-Knoten -> Ticket */
function applyJdf(job, jdf, fleet, dev) {
  const src = (x) => `JDF ${x}`;
  job.jdfJobId = attr(jdf, 'JobID') || null;
  if (attr(jdf, 'DescriptiveName')) setTicket(job, 'jobName', attr(jdf, 'DescriptiveName'), src('DescriptiveName'));
  const types = attr(jdf, 'Types') || attr(jdf, 'Type');
  if (types) job.addLog('TICKET', `JDF-Knoten Typ: ${types}`);
  const media = find(jdf, 'Media');
  if (media) {
    const dim = (attr(media, 'Dimension') || '').split(/\s+/).map(Number).filter((x) => !isNaN(x));
    if (dim.length === 2 && dim[0] > 0 && dim[1] > 0) setTicket(job, 'media.sizeMm', [r1(pt2mm(dim[0])), r1(pt2mm(dim[1]))], src('Media/@Dimension (pt)'));
    if (attr(media, 'Weight')) setTicket(job, 'media.gsm', Number(attr(media, 'Weight')), src('Media/@Weight'));
    const mt = attr(media, 'MediaTypeDetails') || (attr(media, 'MediaType') && attr(media, 'MediaType') !== 'Paper' ? attr(media, 'MediaType') : null);
    if (mt) setTicket(job, 'media.type', mt.toLowerCase(), src('Media/@MediaTypeDetails'));
    const id = attr(media, 'ProductID') || attr(media, 'ID');
    if (id && fleet.catalog.get(id)) setTicket(job, 'media.mediaId', id, src('Media/@ProductID'));
    const loc = child(media, 'Location');
    if (loc && attr(loc, 'LocationName')) setTicket(job, 'media.source', attr(loc, 'LocationName'), src('Media/Location'));
  }
  const lpp = find(jdf, 'LayoutPreparationParams');
  if (lpp) {
    const sides = attr(lpp, 'Sides');
    if (sides) setTicket(job, 'sides', sides === 'OneSided' || sides === 'OneSidedFront' ? 'one-sided' : sides === 'TwoSidedHeadToFoot' || sides === 'TwoSidedFlipX' ? 'two-sided-short-edge' : 'two-sided-long-edge', src(`LayoutPreparationParams/@Sides=${sides}`));
    const nu = (attr(lpp, 'NumberUp') || '').split(/\s+/).map(Number);
    if (nu.length === 2 && nu[0] * nu[1] > 1) { setTicket(job, 'numberUp', nu[0] * nu[1], src('LayoutPreparationParams/@NumberUp')); setTicket(job, 'imposition', 'n-up', src('LayoutPreparationParams/@NumberUp')); }
    if (attr(lpp, 'PageDistributionScheme') === 'Saddle') { setTicket(job, 'imposition', 'booklet', src('LayoutPreparationParams/@PageDistributionScheme=Saddle')); }
  }
  const comp = findAll(jdf, 'ComponentLink').find((c) => attr(c, 'Usage') === 'Output' && attr(c, 'Amount'));
  if (comp) setTicket(job, 'copies', Number(attr(comp, 'Amount')) || 1, src('ComponentLink/@Amount'));
  const dpp = find(jdf, 'DigitalPrintingParams');
  if (dpp) {
    if (attr(dpp, 'OutputBin')) setTicket(job, 'outputBin', attr(dpp, 'OutputBin'), src('DigitalPrintingParams/@OutputBin'));
    if (attr(dpp, 'Collate')) setTicket(job, 'collate', attr(dpp, 'Collate') !== 'None', src('DigitalPrintingParams/@Collate'));
  }
  const st = find(jdf, 'StitchingParams');
  if (st) {
    const type = attr(st, 'StitchType') || 'Corner';
    const edge = (attr(st, 'ReferenceEdge') || 'Left').toLowerCase();
    if (type === 'Saddle') { setTicket(job, 'imposition', 'booklet', src('StitchingParams/@StitchType=Saddle')); setTicket(job, 'finishing.booklet', { saddle: true }, src('StitchingParams')); }
    else if (type === 'Corner') setTicket(job, 'finishing.staple', edge === 'top' ? 'top-left' : edge === 'right' ? 'top-right' : 'top-left', src('StitchingParams/@StitchType=Corner'));
    else setTicket(job, 'finishing.staple', `dual-${edge}`, src(`StitchingParams/@StitchType=${type}`));
  }
  const hm = find(jdf, 'HoleMakingParams');
  if (hm) {
    const ht = attr(hm, 'HoleType') || 'R2-generic';
    const n = /R4|4/.test(ht) ? 4 : /R3|3/.test(ht) ? 3 : 2;
    setTicket(job, 'finishing.punch', { holes: n, edge: (attr(hm, 'ReferenceEdge') || 'Left').toLowerCase() }, src(`HoleMakingParams/@HoleType=${ht}`));
  }
  const fp = find(jdf, 'FoldingParams');
  if (fp) {
    const cat = attr(fp, 'FoldCatalog');
    const map = { 'F4-1': 'half', 'F6-1': 'z', 'F6-4': 'letter', 'F8-7': 'gate' };
    if (map[cat]) setTicket(job, 'finishing.fold', map[cat], src(`FoldingParams/@FoldCatalog=${cat}`));
    else noteUnknown(job, 'FoldingParams/@FoldCatalog', cat, 'JDF');
  }
  const tp = find(jdf, 'TrimmingParams') || find(jdf, 'CuttingParams');
  if (tp) setTicket(job, 'finishing.trimMm', 3, src(tp.local));
  for (const n of ['BindingIntent', 'LaminatingParams', 'CoverApplicationParams', 'InsertingParams', 'ImageSetterParams', 'InterpretingParams', 'ColorantControl']) {
    const node = find(jdf, n);
    if (node) job.addLog('TICKET', `JDF ${n} vorhanden – von der Simulation nicht ausgewertet`);
  }
  const rl = findAll(jdf, 'RunList').map((r) => find(r, 'FileSpec')).find((f) => f && attr(f, 'URL'));
  return rl ? attr(rl, 'URL') : null;
}

async function loadUrl(url, parts, baseDir) {
  if (!url) return null;
  if (url.startsWith('cid:')) {
    const id = url.slice(4);
    const p = parts.find((x) => x.contentId === id || x.contentId === `<${id}>`);
    return p ? { data: p.data, name: p.filename || id } : null;
  }
  if (url.startsWith('file:')) {
    let f = decodeURIComponent(url.replace(/^file:\/\/(localhost)?/, ''));
    if (process.platform === 'win32') f = f.replace(/^\/([A-Za-z]:)/, '$1');
    return { data: fs.readFileSync(f), name: path.basename(f) };
  }
  if (/^https?:/.test(url)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} beim Laden von ${url}`);
    return { data: Buffer.from(await r.arrayBuffer()), name: url.split('/').pop() };
  }
  if (baseDir) { const f = path.resolve(baseDir, decodeURIComponent(url)); return { data: fs.readFileSync(f), name: path.basename(f) }; }
  return null;
}

/** Hauptfunktion: verarbeitet JMF (XML oder MIME-Paket) und liefert die Antwort als XML. */
async function handleJmf(fleet, dev, req, body) {
  const ct = req.headers['content-type'] || '';
  const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  let parts = [];
  let jmfText;
  if (/multipart\//i.test(ct)) {
    parts = parseMultipart(body, ct);
    const jp = parts.find((p) => /jmf/i.test(p.contentType)) || parts[0];
    jmfText = jp ? jp.data.toString('utf8') : '';
  } else jmfText = body.toString('utf8');
  const root = parseXml(jmfText);
  if (!root) return { status: 400, xml: jmfWrap(dev, '  <Response ReturnCode="1"><Notification Class="Error"><Comment>Kein JMF</Comment></Notification></Response>') };
  // Direkt ein JDF gesendet? (manche Clients posten JDF ohne JMF-Umschlag)
  if (root.local === 'JDF') {
    const j = await submitJdf(fleet, dev, root, parts, null, remote, { Hold: false });
    return { status: 200, xml: jmfWrap(dev, `  <Response ID="R${rid++}" Type="SubmitQueueEntry" ReturnCode="0">\n    <QueueEntry QueueEntryID="${j.id}" Status="Waiting"/>\n  </Response>`) };
  }
  const out = [];
  for (const msg of root.children) {
    const type = attr(msg, 'Type');
    const family = msg.local;
    const title = `JMF ${family} ${type}`;
    dev.trace('jmf', 'in', `${title} von ${remote}`, jmfText.length < 8000 ? jmfText : jmfText.slice(0, 8000) + '…', ['QueueStatus', 'Status', 'KnownMessages'].includes(type));
    try {
      switch (type) {
        case 'KnownMessages': {
          const list = ['KnownMessages', 'KnownDevices', 'Status', 'QueueStatus', 'SubmitQueueEntry', 'AbortQueueEntry', 'RemoveQueueEntry', 'HoldQueueEntry', 'ResumeQueueEntry', 'Resource', 'ReturnQueueEntry'];
          out.push(response(msg, type, 0, list.map((t) => `    <MessageService Type="${t}" Query="${['SubmitQueueEntry', 'AbortQueueEntry', 'RemoveQueueEntry', 'HoldQueueEntry', 'ResumeQueueEntry'].includes(t) ? 'false' : 'true'}" Command="${['SubmitQueueEntry', 'AbortQueueEntry', 'RemoveQueueEntry', 'HoldQueueEntry', 'ResumeQueueEntry'].includes(t) ? 'true' : 'false'}"/>`).join('\n')));
          break;
        }
        case 'KnownDevices': case 'Status':
          out.push(response(msg, type, 0, `    <DeviceList>\n      <DeviceInfo DeviceStatus="${deviceStatus(dev)}" StatusDetails="${esc(dev.status.message)}">\n        <Device DeviceID="${esc(dev.id)}" DescriptiveName="${esc(dev.cfg.name)}" ModelName="${esc(dev.cfg.model)}" Manufacturer="${esc(dev.cfg.vendor)}"/>${dev.current ? `\n        <JobPhase JobID="${esc(dev.current.jdfJobId || String(dev.current.id))}" QueueEntryID="${dev.current.id}" Status="InProgress" PercentCompleted="${Math.round(dev.current.progress * 100)}"/>` : ''}\n      </DeviceInfo>\n    </DeviceList>`));
          break;
        case 'QueueStatus': {
          const jobs = fleet.jobsOf(dev.id).sort((a, b) => a.id - b.id).slice(-100);
          out.push(response(msg, type, 0, `    <Queue Status="${dev.status.state === 'stopped' ? 'Blocked' : dev.status.state === 'processing' ? 'Running' : 'Waiting'}" DeviceID="${esc(dev.id)}">\n${jobs.map(queueEntryXml).join('\n')}\n    </Queue>`));
          break;
        }
        case 'Resource':
          out.push(response(msg, type, 0, mediaXml(fleet, dev)));
          break;
        case 'SubmitQueueEntry': {
          const qsp = find(msg, 'QueueSubmissionParams');
          const url = qsp && attr(qsp, 'URL');
          const loaded = await loadUrl(url, parts, null);
          if (!loaded) { out.push(response(msg, type, 3, '', `JDF unter ${url} nicht gefunden`)); break; }
          const jdf = parseXml(loaded.data.toString('utf8'));
          const opts = { Hold: qsp && attr(qsp, 'Hold') === 'true', Priority: qsp && attr(qsp, 'Priority'), ReturnJMF: qsp && (attr(qsp, 'ReturnJMF') || attr(qsp, 'ReturnURL')) };
          const baseDir = url.startsWith('file:') ? path.dirname(decodeURIComponent(url.replace(/^file:\/\/(localhost)?/, '')).replace(/^\/([A-Za-z]:)/, '$1')) : null;
          const j = await submitJdf(fleet, dev, jdf, parts, baseDir, remote, opts, jmfText);
          const xml = response(msg, type, 0, queueEntryXml(j).replace(/^ {6}/, '    '));
          j.addProtocol('out', 'JMF-Antwort SubmitQueueEntry', xml);
          out.push(xml);
          break;
        }
        case 'AbortQueueEntry': case 'RemoveQueueEntry': case 'HoldQueueEntry': case 'ResumeQueueEntry': {
          const def = find(msg, 'QueueEntryDef');
          const id = def && attr(def, 'QueueEntryID');
          const action = { AbortQueueEntry: 'cancel', RemoveQueueEntry: 'delete', HoldQueueEntry: 'hold', ResumeQueueEntry: 'release' }[type];
          try {
            const j = fleet.jobAction(Number(id), action);
            j.addProtocol && j.addProtocol('in', `JMF ${type} von ${remote}`, jmfText);
            out.push(response(msg, type, 0, action === 'delete' ? '' : queueEntryXml(j).replace(/^ {6}/, '    ')));
          } catch (e) { out.push(response(msg, type, 105, '', e.message)); }
          break;
        }
        default:
          out.push(response(msg, type || family, 5, '', `${family} ${type} wird von der Simulation nicht unterstützt`));
      }
    } catch (e) {
      out.push(response(msg, type, 1, '', e.message));
    }
  }
  const xml = jmfWrap(dev, out.join('\n'));
  dev.trace('jmf', 'out', 'JMF-Antwort', xml, true);
  return { status: 200, xml };
}

async function submitJdf(fleet, dev, jdf, parts, baseDir, remote, opts, jmfText) {
  const job = fleet.createJob(dev.id, { name: attr(jdf, 'DescriptiveName') || null, source: { protocol: 'JMF/JDF', remote, queue: dev.queues[0].name } });
  if (jmfText) job.addProtocol('in', `JMF SubmitQueueEntry von ${remote}`, jmfText);
  const jdfXml = parts.find((p) => /jdf/i.test(p.contentType));
  job.addProtocol('in', 'JDF-Jobticket', jdfXml ? jdfXml.data.toString('utf8').slice(0, 20000) : '(per URL geladen)');
  const url = applyJdf(job, jdf, fleet, dev);
  if (opts.Hold) setTicket(job, 'hold', true, 'JMF QueueSubmissionParams/@Hold');
  if (opts.Priority) setTicket(job, 'priority', Number(opts.Priority), 'JMF QueueSubmissionParams/@Priority');
  if (opts.ReturnJMF) { job.notify.push({ type: 'jmf', url: opts.ReturnJMF }); job.addLog('EMPFANG', `Rückmeldung (ReturnJMF) an ${opts.ReturnJMF} nach Abschluss`); }
  const doc = await loadUrl(url, parts, baseDir);
  if (!doc) {
    job.error('EMPFANG', `RunList-Datei ${url || '(keine)'} nicht ladbar`);
    job.setState('aborted', ['job-data-insufficient'], 'Dokument aus JDF-RunList nicht gefunden');
    return job;
  }
  job.addLog('EMPFANG', `Dokument aus RunList: ${url}`);
  fleet.submit(job, doc.data, { filename: doc.name });
  return job;
}

/** Rückmeldung an ReturnJMF-URL senden, wenn ein Job fertig ist. */
function setupJmfNotifications(fleet) {
  fleet.on('jobState', async (job) => {
    if (!job.isFinal || !job.notify?.length) return;
    for (const n of job.notify.filter((x) => x.type === 'jmf' && !x.sent)) {
      n.sent = true;
      const dev = fleet.devices.get(job.deviceId);
      const xml = jmfWrap(dev, `  <Command ID="C${rid++}" Type="ReturnQueueEntry">\n    <ReturnQueueEntryParams QueueEntryID="${job.id}" ${job.state === 'completed' ? 'Completed' : 'Aborted'}="${esc(job.jdfJobId || String(job.id))}"/>\n  </Command>`);
      try {
        const r = await fetch(n.url, { method: 'POST', headers: { 'Content-Type': 'application/vnd.cip4-jmf+xml' }, body: xml });
        job.addProtocol('out', `JMF ReturnQueueEntry an ${n.url} → HTTP ${r.status}`, xml);
      } catch (e) {
        job.warn('STATUS', `ReturnJMF an ${n.url} fehlgeschlagen: ${e.message}`);
      }
      job.save();
    }
  });
}

module.exports = { handleJmf, applyJdf, setupJmfNotifications };
