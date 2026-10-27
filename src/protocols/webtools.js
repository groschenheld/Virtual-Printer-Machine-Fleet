'use strict';
// Web-Oberfläche des simulierten Druckservers (vergleichbar mit Fiery WebTools, PRISMAsync-Fernzugriff,
// FreeFlow-Weboberfläche, ClearConnect/WebTools Express). Erreichbar unter http://<host>:<http-port>/
// – dorthin zeigt auch printer-more-info (IPP) und adminurl (Bonjour), wie bei echten Geräten.
const { frontendOf, installedModules, MODULE_DE } = require('../frontends');
const { generatePpd } = require('../system/ppd');
const { sendText } = require('../util/http');

const TITLES = {
  fiery: 'Fiery WebTools',
  prismasync: 'PRISMAsync Fernzugriff',
  ffps: 'FreeFlow Print Server – Weboberfläche',
  publisher: 'ClearConnect / WebTools Express',
  edgeprint: 'Epson Edge Print – Fernzugriff',
  driver: 'Geräte-Webseite',
  ordercontroller: 'Order Controller – Fernzugriff',
  versaworks: 'VersaWorks – Fernzugriff',
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(dev, host, tab, body, flash) {
  const c = dev.cfg;
  const fe = frontendOf(c);
  const st = dev.status;
  const title = TITLES[c.frontend.type] || 'Druckserver';
  const tabs = [['/', 'Start'], ['/jobs', 'Aufträge'], ['/config', 'Konfiguration'], ['/driver', 'Treiber & Software']];
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} – ${esc(c.name)}</title>
<style>
:root{--bg:#f4f5f7;--p:#fff;--l:#dde0e5;--t:#1c1e22;--m:#6a6f78;--a:${c.vendor === 'Xerox' ? '#c8102e' : c.vendor === 'Canon' ? '#cc0000' : c.vendor === 'Epson' ? '#003399' : '#0b5394'}}
@media(prefers-color-scheme:dark){:root{--bg:#17181b;--p:#202226;--l:#33363c;--t:#eceef1;--m:#9ba1ab}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--t)}
header{background:var(--p);border-bottom:3px solid var(--a);padding:12px 20px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
header b{font-size:16px}header small{color:var(--m)}nav{display:flex;gap:4px;margin-left:auto}nav a{padding:6px 12px;border-radius:6px;text-decoration:none;color:var(--m)}nav a.on{background:var(--bg);color:var(--t);font-weight:600}
main{max-width:1100px;margin:0 auto;padding:20px}.card{background:var(--p);border:1px solid var(--l);border-radius:8px;padding:14px 16px;margin-bottom:14px}
h2{font-size:15px;margin:0 0 10px}table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid var(--l);text-align:left;vertical-align:top}th{font-size:11px;color:var(--m);text-transform:uppercase}
.st{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;background:#e6f4ea;color:#1e7b34}.st.stopped{background:#fdecea;color:#b3261e}.st.processing{background:#e8f0fe;color:#1a56c8}
button,select,input{font:inherit}button{padding:5px 12px;border:1px solid var(--l);border-radius:6px;background:var(--p);color:var(--t);cursor:pointer}button.p{background:var(--a);border-color:var(--a);color:#fff}
code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}pre{background:var(--bg);padding:10px;border-radius:6px;overflow:auto;white-space:pre-wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}.muted{color:var(--m)}.flash{background:#e6f4ea;color:#1e7b34;padding:8px 12px;border-radius:6px;margin-bottom:14px}
label.row{display:flex;gap:8px;align-items:center;padding:5px 0}.bar{height:7px;background:var(--l);border-radius:4px;overflow:hidden}.bar i{display:block;height:100%}
</style></head><body>
<header><div><b>${esc(title)}</b> <small>Simulation</small><br><small>${esc(c.frontend.product)} · ${esc(c.vendor)} ${esc(c.model)}</small></div>
<span class="st ${st.state}">${esc(st.stateDe)}</span>
<nav>${tabs.map(([h, t]) => `<a href="${h}" class="${tab === h ? 'on' : ''}">${t}</a>`).join('')}</nav></header>
<main>${flash ? `<div class="flash">${esc(flash)}</div>` : ''}${body}
<p class="muted" style="font-size:12px">Virtual Print Fleet – simulierter Druckserver „${esc(fe.label)}". <a href="${esc(dev.fleet.uiUrl)}/#/device/${esc(c.id)}">Zur Simulations-Oberfläche</a></p></main></body></html>`;
}

function startPage(fleet, dev, host) {
  const c = dev.cfg;
  const s = fleet.deviceSummary(dev);
  const active = fleet.jobsOf(c.id).filter((j) => !j.isFinal);
  const trays = c.slots.map((sl) => {
    const m = sl.loaded && fleet.catalog.get(sl.loaded.mediaId);
    const lvl = !m ? 0 : sl.kind === 'roll' ? (sl.loaded.levelM ?? m.lengthM) / m.lengthM : sl.loaded.level / sl.capacity;
    return `<tr><td>${esc(sl.name)}</td><td>${m ? esc(m.name) : '<span class="muted">leer</span>'}</td><td style="width:160px"><div class="bar"><i style="width:${Math.round(lvl * 100)}%;background:${lvl < 0.1 ? '#d93025' : '#1e8e3e'}"></i></div></td><td>${m ? (sl.kind === 'roll' ? `${Math.round((sl.loaded.levelM ?? m.lengthM) * 10) / 10} m` : `${sl.loaded.level}/${sl.capacity}`) : ''}</td></tr>`;
  }).join('');
  return `<div class="grid"><div class="card"><h2>Status</h2><p><span class="st ${s.status.state}">${esc(s.status.stateDe)}</span> ${esc(s.status.message)}</p><p class="muted"><code>${esc(s.status.reasons.join(', '))}</code></p><p>${active.length} aktive Aufträge</p></div>
  <div class="card"><h2>Verbrauchsmaterial</h2>${(c.supplies || []).map((x) => `<div style="display:flex;gap:8px;align-items:center;margin:3px 0"><span style="width:110px">${esc(x.name)}</span><div class="bar" style="flex:1"><i style="width:${x.level}%;background:${x.color}"></i></div><span style="width:40px;text-align:right">${Math.round(x.level)} %</span></div>`).join('')}</div></div>
  <div class="card"><h2>${c.kind === 'sheet' ? 'Papierfächer' : 'Rollen'}</h2><table><tr><th>${c.kind === 'sheet' ? 'Fach' : 'Rolle'}</th><th>Material</th><th>Füllstand</th><th></th></tr>${trays}</table></div>
  <div class="card"><h2>Finisher</h2><p>${esc(c.finisher?.name || '–')}</p><p>Installiert: ${Object.keys(installedModules(c)).map((k) => esc(MODULE_DE[k] || k)).join(', ') || '–'}</p></div>`;
}

function jobsPage(fleet, dev) {
  const list = fleet.jobsOf(dev.id).sort((a, b) => b.id - a.id).slice(0, 100);
  const btn = (j, a, t, p) => `<form method="post" action="/jobs/${j.id}/${a}" style="display:inline"><button${p ? ' class="p"' : ''}>${t}</button></form>`;
  return `<div class="card"><h2>Aufträge</h2><table><tr><th>Nr.</th><th>Name</th><th>Benutzer</th><th>Warteschlange</th><th>Status</th><th></th></tr>${list.map((j) => `<tr><td>${j.id}</td><td>${esc(j.name)}</td><td>${esc(j.user)}</td><td>${esc(j.ticket?.queue || '')}</td><td>${esc(j.stateText)}<div class="muted" style="font-size:12px">${esc(j.stateMessage || '')}</div></td>
  <td style="white-space:nowrap">${['held', 'waiting'].includes(j.state) ? btn(j, 'release', 'Drucken', true) : ''}${j.state === 'pending' ? btn(j, 'hold', 'Halten') : ''}${!j.isFinal ? btn(j, 'cancel', 'Abbrechen') : btn(j, 'reprint', 'Erneut drucken')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Keine Aufträge</td></tr>'}</table></div>`;
}

function configPage(fleet, dev) {
  const c = dev.cfg;
  const fe = frontendOf(c);
  const mods = c.finisher?.modules || {};
  const media = Array.from(fleet.catalog.values());
  return `<form method="post" action="/config"><div class="grid">
  <div class="card"><h2>Installierbare Optionen</h2><p class="muted">Welche Finisher-Module am Gerät angeschlossen sind. Nicht installierte Module stehen im Treiber nicht zur Verfügung; Aufträge, die sie anfordern, führen zu einem Finishing-Konflikt.</p>
  ${Object.entries(mods).map(([k, m]) => `<label class="row"><input type="checkbox" name="mod_${k}" ${m.installed !== false ? 'checked' : ''}> ${esc(MODULE_DE[k] || k)} <span class="muted" style="font-size:12px">${esc(Object.entries(m).filter(([a]) => a !== 'installed').map(([a, b]) => `${a}: ${Array.isArray(b) ? b.join('/') : b}`).join(' · '))}</span></label>`).join('')}</div>
  <div class="card"><h2>Auftragsverarbeitung</h2>
  <label class="row">Fehlendes Material: <select name="mismatchPolicy"><option value="hold" ${(c.settings.mismatchPolicy || fe.mismatchPolicy) === 'hold' ? 'selected' : ''}>Auftrag anhalten</option><option value="wait" ${(c.settings.mismatchPolicy || fe.mismatchPolicy) === 'wait' ? 'selected' : ''}>Warten, bis Material eingelegt ist</option></select></label>
  <label class="row">Finishing-Konflikt: <select name="conflictPolicy"><option value="hold" ${(c.settings.conflictPolicy || fe.conflictPolicy) === 'hold' ? 'selected' : ''}>Auftrag anhalten</option><option value="ignore" ${(c.settings.conflictPolicy || fe.conflictPolicy) === 'ignore' ? 'selected' : ''}>Ohne Weiterverarbeitung drucken</option></select></label>
  <label class="row"><input type="checkbox" name="autoTraySwitch" ${c.settings.autoTraySwitch !== false ? 'checked' : ''}> Automatische Fachumschaltung</label></div></div>
  <div class="card"><h2>${c.kind === 'sheet' ? 'Fachzuordnung (Papierkatalog)' : 'Rollen'}</h2><table><tr><th>${c.kind === 'sheet' ? 'Fach' : 'Rolle'}</th><th>Material</th></tr>
  ${c.slots.map((s) => `<tr><td>${esc(s.name)} <code class="muted">${esc(s.ippSource)}</code></td><td><select name="slot_${s.id}"><option value="">– leer –</option>${media.filter((m) => m.kind === s.kind).map((m) => `<option value="${esc(m.id)}" ${s.loaded && s.loaded.mediaId === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></td></tr>`).join('')}</table></div>
  <p><button class="p">Übernehmen</button></p></form>`;
}

function driverPage(fleet, dev, host) {
  const c = dev.cfg;
  const s = fleet.deviceSummary(dev);
  const h = host.split(':')[0];
  const name = `VPF_${c.id}`;
  return `<div class="card"><h2>Druckertreiber</h2>
  <p>PPD-Treiber für CUPS (Linux, macOS) mit den aktuell eingestellten <b>Installierbaren Optionen</b>, Fächern, Materialarten, Ablagen und der Weiterverarbeitung dieses Geräts.</p>
  <p><a href="/driver.ppd"><button class="p">PPD herunterladen (VPF-${esc(c.id)}.ppd)</button></a></p>
  <h2 style="margin-top:18px">Linux / macOS (CUPS)</h2>
  <pre>curl -o VPF-${esc(c.id)}.ppd http://${esc(host)}/driver.ppd
sudo lpadmin -p ${esc(name)} -E -v ipp://${esc(host)}/ipp/print -P VPF-${esc(c.id)}.ppd \\
  -D "${esc(c.frontend.product)} – ${esc(c.name)}"</pre>
  <p class="muted">Oder alle Geräte auf einmal: <code>sudo vpf drucker-einrichten</code>. Weitere Warteschlangen (virtuelle Drucker) über die URIs unten. Die Installierbaren Optionen lassen sich danach auch in den Druckereinstellungen des Systems umschalten.</p>
  <h2 style="margin-top:18px">Windows</h2>
  <pre>Add-PrinterPort -Name "VPF_${esc(c.id)}" -PrinterHostAddress "${esc(h)}" -PortNumber ${c.ports.raw}
Add-Printer -Name "${esc(c.name)} (VPF)" -PortName "VPF_${esc(c.id)}" -DriverName "Microsoft PS Class Driver"</pre>
  <p class="muted">Oder als IPP-Drucker: <code>http://${esc(host)}/ipp/print</code> mit dem „Microsoft IPP Class Driver". PostScript-Eingang benötigt Ghostscript in der Simulation.</p></div>
  <div class="card"><h2>Verbindungen</h2><table>
  <tr><td>IPP</td><td><code>ipp://${esc(host)}/ipp/print</code></td></tr>
  ${s.queues.map((q) => `<tr><td>IPP „${esc(q.name)}" (${esc(q.mode)})</td><td><code>ipp://${esc(host)}/ipp/print/${encodeURIComponent(q.name)}</code></td></tr>`).join('')}
  <tr><td>LPR</td><td><code>${esc(h)}:${c.ports.lpd}</code> · Warteschlangen ${s.queues.map((q) => `<code>${esc(q.name)}</code>`).join(', ')}</td></tr>
  <tr><td>Socket</td><td><code>${esc(h)}:${c.ports.raw}</code></td></tr>
  <tr><td>JDF/JMF</td><td><code>http://${esc(host)}/jmf</code></td></tr>
  ${s.endpoints.fieryApi ? `<tr><td>Fiery-API</td><td><code>http://${esc(host)}/live/api/v5</code></td></tr>` : ''}
  <tr><td>Hotfolder</td><td><code>${esc(s.endpoints.hotfolders)}</code></td></tr></table></div>`;
}

/** Bearbeitet GET/POST auf die Server-Webseite. Rückgabe true, wenn behandelt. */
async function handleWebtools(fleet, dev, req, res, p, body) {
  const host = req.headers.host || `${fleet.settings.bindHost}:${dev.cfg.ports.http}`;
  const html = (tab, content, flash) => sendText(res, 200, page(dev, host, tab, content, flash), 'text/html; charset=utf-8');
  const redirect = (to) => { res.writeHead(303, { Location: to }); res.end(); };
  if (req.method === 'GET') {
    if (p === '/' || p === '/index.html') return html('/', startPage(fleet, dev, host)), true;
    if (p === '/jobs') return html('/jobs', jobsPage(fleet, dev)), true;
    if (p === '/config') return html('/config', configPage(fleet, dev), new URL(req.url, 'http://x').searchParams.get('ok') ? 'Einstellungen übernommen' : null), true;
    if (p === '/driver' || p === '/drivers' || p === '/downloads') return html('/driver', driverPage(fleet, dev, host)), true;
    if (p === '/driver.ppd' || /\.ppd$/i.test(p)) {
      sendText(res, 200, generatePpd(fleet, dev), 'application/vnd.cups-ppd', { 'Content-Disposition': `attachment; filename="VPF-${dev.id}.ppd"` });
      return true;
    }
    return false;
  }
  if (req.method === 'POST') {
    const form = new URLSearchParams(body.toString('utf8'));
    let m;
    if ((m = /^\/jobs\/(\d+)\/(release|hold|cancel|reprint)$/.exec(p))) {
      try { fleet.jobAction(Number(m[1]), m[2]); } catch (e) { /* in Liste sichtbar */ }
      dev.trace('web', 'in', `Server-Webseite: Auftrag ${m[1]} → ${m[2]}`);
      return redirect('/jobs'), true;
    }
    if (p === '/config') {
      const c = dev.cfg;
      const changes = [];
      for (const [k, mod] of Object.entries(c.finisher?.modules || {})) {
        const on = form.has(`mod_${k}`);
        if ((mod.installed !== false) !== on) { mod.installed = on; changes.push(`${MODULE_DE[k] || k}: ${on ? 'installiert' : 'nicht installiert'}`); }
      }
      for (const k of ['mismatchPolicy', 'conflictPolicy']) if (form.get(k) && form.get(k) !== c.settings[k]) { c.settings[k] = form.get(k); changes.push(`${k} = ${form.get(k)}`); }
      const ats = form.has('autoTraySwitch');
      if ((c.settings.autoTraySwitch !== false) !== ats) { c.settings.autoTraySwitch = ats; changes.push(`Fachumschaltung ${ats ? 'an' : 'aus'}`); }
      for (const s of c.slots) {
        const v = form.get(`slot_${s.id}`);
        if (v === null) continue;
        const cur = s.loaded ? s.loaded.mediaId : '';
        if (v !== cur) { try { dev.loadSlot(s.id, v || null); changes.push(`${s.name}: ${v || 'leer'}`); } catch (e) { changes.push(`${s.name}: ${e.message}`); } }
      }
      if (changes.length) {
        fleet.log(dev.id, 'info', `Druckserver-Konfiguration geändert: ${changes.join('; ')}`);
        dev.trace('web', 'in', 'Server-Webseite: Konfiguration geändert', changes.join('\n'));
        fleet.saveFleet();
        if (fleet.mdns) fleet.mdns.announce();
        dev.changed();
      }
      return redirect('/config?ok=1'), true;
    }
  }
  return false;
}

module.exports = { handleWebtools, TITLES };
