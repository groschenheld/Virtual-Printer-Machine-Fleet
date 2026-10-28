// Virtual Print Fleet – Oberfläche (ohne Framework)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Sprache / language: gespeicherte Wahl im Browser, abgeglichen mit der Einstellung des Servers
const LS = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); return localStorage.getItem(k) === v; } catch { return false; } } };
let LANG = LS.get('vpf-lang') || (/^de/i.test(navigator.language || 'de') ? 'de' : 'en');
const $t = (de, en) => (LANG === 'en' && en != null ? en : de);
const LOCALE = () => (LANG === 'en' ? 'en-GB' : 'de-DE');
function switchLang(l, reload = true) {
  if (l === LANG) return;
  const stored = LS.set('vpf-lang', l);
  LANG = l;
  if (reload && stored) location.reload();
  else { applyStatic(); renderSide(); route(); }
}
function applyStatic() {
  document.documentElement.lang = LANG;
  $$('[data-en]').forEach((el) => { if (el.dataset.de == null) el.dataset.de = el.textContent; el.textContent = LANG === 'en' ? el.dataset.en : el.dataset.de; });
  $$('[data-en-title]').forEach((el) => { if (el.dataset.deTitle == null) el.dataset.deTitle = el.title; el.title = LANG === 'en' ? el.dataset.enTitle : el.dataset.deTitle; });
  const b = $('#btnLang');
  if (b) { b.textContent = LANG === 'en' ? 'DE' : 'EN'; b.title = LANG === 'en' ? 'Deutsch' : 'English'; }
}
const mm = (pt) => Math.round((pt * 25.4 / 72) * 10) / 10;
const KIND_DE = { sheet: $t('Bogenmaschinen (Laser/Digitaldruck)', 'Sheet-fed presses (laser/digital)'), wide: $t('Großformat / Plotter', 'Wide format / plotters'), photo: $t('Fotodrucker (Rolle bis 210 mm)', 'Photo printers (roll up to 210 mm)'), printcut: 'Print & Cut' };
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString(LOCALE()) : '');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(LOCALE(), { dateStyle: 'short', timeStyle: 'medium' }) : '');

const S = { state: null, jobs: [], route: '', jobDetail: null, traffic: {}, viewer: { surface: 0, layers: { print: true, place: true, cut: true, fold: true, staple: true, waste: true } }, tab: {} };

async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers = { 'Content-Type': 'application/json' }; o.method = o.method || 'POST'; delete o.json; }
  const r = await fetch(path, o);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || data || r.statusText);
  return data;
}
function toast(msg, err) {
  const d = document.createElement('div');
  d.textContent = msg;
  if (err) d.className = 'err';
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), err ? 6000 : 3000);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); }
}
const dev = (id) => S.state?.devices.find((d) => d.id === id);
const mediaById = (id) => S.state?.media.find((m) => m.id === id);

// ------------------------------------------------------------------ Laden + Live
async function loadState() {
  S.state = await api('/api/state');
  if (S.state.lang && S.state.lang !== LANG) switchLang(S.state.lang, !sessionStorage.getItem('vpf-reloaded') && (sessionStorage.setItem('vpf-reloaded', '1'), true));
  S.jobs = await api('/api/jobs');
  $('#timeFactor').value = String(S.state.settings.timeFactor);
  if (!$('#timeFactor').value) { const o = document.createElement('option'); o.value = o.textContent = String(S.state.settings.timeFactor); $('#timeFactor').appendChild(o); $('#timeFactor').value = o.value; }
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('#live').classList.add('ok');
  es.onerror = () => $('#live').classList.remove('ok');
  es.addEventListener('device', (e) => {
    const d = JSON.parse(e.data);
    const i = S.state.devices.findIndex((x) => x.id === d.id);
    if (i >= 0) S.state.devices[i] = d; else S.state.devices.push(d);
    scheduleRender('device', d.id);
  });
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data);
    const i = S.jobs.findIndex((x) => x.id === j.id);
    if (i >= 0) S.jobs[i] = { ...S.jobs[i], ...j }; else S.jobs.unshift(j);
    if (S.jobDetail && S.jobDetail.id === j.id) { Object.assign(S.jobDetail, j); if (j.state === 'completed' || j.state === 'held' || j.state === 'aborted') S.jobDetail._reload = true; }
    scheduleRender('job', j.id);
  });
  es.addEventListener('jobprogress', (e) => {
    const p = JSON.parse(e.data);
    const j = S.jobs.find((x) => x.id === p.jobId);
    if (j) { j.progress = p.progress; j.counters = p.counters; }
    if (S.jobDetail && S.jobDetail.id === p.jobId) { S.jobDetail.progress = p.progress; S.jobDetail.counters = p.counters; }
    const bar = $(`[data-prog="${p.jobId}"]`);
    if (bar) bar.style.width = Math.round(p.progress * 100) + '%';
  });
  es.addEventListener('joblog', (e) => {
    const p = JSON.parse(e.data);
    if (S.jobDetail && S.jobDetail.id === p.jobId) {
      S.jobDetail.log.push(p.entry);
      const box = $('#joblog');
      if (box) { box.insertAdjacentHTML('beforeend', logEntry(p.entry)); box.scrollTop = box.scrollHeight; }
    }
  });
  es.addEventListener('jobdeleted', (e) => { const p = JSON.parse(e.data); S.jobs = S.jobs.filter((j) => j.id !== p.id); scheduleRender('job'); });
  es.addEventListener('trace', (e) => {
    const t = JSON.parse(e.data);
    if (S.route.startsWith('/device/' + t.deviceId) && S.tab.device === 'traffic') scheduleRender('traffic');
  });
  es.addEventListener('settings', (e) => { const p = JSON.parse(e.data); if (p.lang && p.lang !== LANG) { sessionStorage.removeItem('vpf-reloaded'); switchLang(p.lang); } });
  es.addEventListener('log', () => { if (S.route === '/log') scheduleRender('log'); });
}

let renderTimer = null;
let pendingKinds = new Set();
function scheduleRender(kind) {
  pendingKinds.add(kind);
  if (renderTimer) return;
  renderTimer = setTimeout(async () => {
    renderTimer = null;
    const kinds = pendingKinds; pendingKinds = new Set();
    renderSide();
    const r = S.route;
    if (r === '/' ) renderOverview();
    else if (r === '/jobs') renderAllJobs();
    else if (r.startsWith('/device/')) { if (!document.activeElement || !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) await renderDevice(r.split('/')[2], true); }
    else if (r.startsWith('/job/') && S.jobDetail && (S.jobDetail._reload || kinds.has('job'))) {
      if (S.jobDetail._reload) { S.jobDetail._reload = false; await loadJob(S.jobDetail.id); }
      renderJob(true);
    } else if (r === '/log') renderLog();
  }, 250);
}

// ------------------------------------------------------------------ Seitenleiste
function renderSide() {
  const groups = {};
  for (const d of S.state.devices) (groups[d.kind] = groups[d.kind] || []).push(d);
  let h = '';
  for (const k of ['sheet', 'wide', 'photo', 'printcut']) {
    if (!groups[k]) continue;
    h += `<h4>${KIND_DE[k]}</h4>`;
    for (const d of groups[k]) {
      const cur = d.status.current ? S.jobs.find((j) => j.id === d.status.current) : null;
      h += `<a class="dev ${S.route.startsWith('/device/' + d.id) ? 'act' : ''}" href="#/device/${d.id}"><span class="dot ${d.enabled ? d.status.state : ''}"></span><span class="n">${esc(d.name)}</span><span class="s">${esc(d.frontend.label)} · ${cur ? esc(cur.stateText || cur.state) + ' ' + Math.round((cur.progress || 0) * 100) + '%' : esc(d.status.message)}</span></a>`;
    }
  }
  $('#side').innerHTML = h;
}

// ------------------------------------------------------------------ Übersicht
function slotLevel(s) {
  if (!s.media) return { pct: 0, txt: $t('leer', 'empty'), cls: 'empty' };
  if (s.kind === 'roll') { const l = s.loaded.levelM ?? s.media.lengthM; const pct = l / s.media.lengthM; return { pct, txt: `${Math.round(l * 10) / 10} m`, cls: pct < 0.1 ? 'low' : '' }; }
  const pct = s.loaded.level / s.capacity;
  return { pct, txt: `${s.loaded.level}/${s.capacity}`, cls: s.loaded.level <= 0 ? 'empty' : pct < 0.1 ? 'low' : '' };
}
function renderOverview() {
  setNav('/');
  let h = `<div class="row"><div><h1>${$t('Maschinenpark', 'Machine park')}</h1><div class="sub">${S.state.devices.length} ${$t('simulierte Geräte · Daten in', 'simulated devices · data in')} <code>${esc(S.state.dataDir)}</code></div></div></div><div id="visibility"></div>`;
  for (const k of ['sheet', 'wide', 'photo', 'printcut']) {
    const list = S.state.devices.filter((d) => d.kind === k);
    if (!list.length) continue;
    h += `<h2>${KIND_DE[k]}</h2><div class="grid cards">`;
    for (const d of list) {
      const active = S.jobs.filter((j) => j.deviceId === d.id && !['completed', 'canceled', 'aborted'].includes(j.state));
      h += `<a class="card link" href="#/device/${d.id}">
        <div class="hd"><span class="dot ${d.status.state}"></span><div style="flex:1"><div class="t">${esc(d.name)}</div><div class="m">${esc(d.frontend.product)}</div></div><span class="st ${d.status.state}">${esc(d.status.stateDe)}</span></div>
        <div class="slots">${d.slots.map((s) => { const l = slotLevel(s); return `<div class="slotmini"><span class="nm">${esc(s.name)}</span><span class="md">${s.media ? esc(s.media.name) : '<span class="sub">' + $t('— leer —', '— empty —') + '</span>'}</span><span class="lv">${l.txt}</span></div>`; }).join('')}</div>
        <div class="row" style="margin-top:8px"><div class="supplies" title="${$t('Toner/Tinte', 'Toner/ink')}">${(d.supplies || []).map((s) => `<span style="height:${Math.max(2, s.level / 100 * 26)}px;background:${s.color}" title="${esc(s.name)} ${Math.round(s.level)} %"></span>`).join('')}</div><span class="spacer"></span>
        <span class="sub">${active.length ? active.length + $t(' aktiv', ' active') : ''}</span>
        ${d.status.reasons.filter((r) => r !== 'none').map((r) => `<span class="badge">${esc(r)}</span>`).join(' ')}</div>
      </a>`;
    }
    h += '</div>';
  }
  const keep = $('#visibility');
  $('#main').innerHTML = h;
  if (keep && keep.innerHTML) $('#visibility').replaceWith(keep);
  else renderVisibility($('#visibility'));
}

async function renderVisibility(el) {
  if (!el) return;
  let sys;
  try { sys = await api('/api/system'); } catch { return; }
  const n = sys.systemPrinters.length;
  const md = sys.mdns || {};
  const loop = (md.addresses || []).every((a) => a.startsWith('127.'));
  el.innerHTML = `<div class="card" style="margin-top:14px"><div class="row"><b>${$t('Sichtbarkeit für Druck-Apps', 'Visibility for print apps')}</b><span class="spacer"></span>
      <span class="badge" title="Bonjour/mDNS">${md.active ? $t(`Bonjour aktiv · ${esc(sys.mdnsHost)} (${esc((md.addresses || []).join(', '))})`, `Bonjour active · ${esc(sys.mdnsHost)} (${esc((md.addresses || []).join(', '))})`) : $t('Bonjour aus', 'Bonjour off') + (md.error ? ': ' + esc(md.error) : '')}</span>
      <span class="badge">${n ? n + $t(' Systemdrucker eingetragen', ' system printers registered') : $t('keine Systemdrucker eingetragen', 'no system printers registered')}</span></div>
    <div class="sub" style="margin:6px 0 10px">${$t('Apps finden Drucker meist über die', 'Apps usually find printers via the')} <b>${$t('System-Druckerliste', 'system printer list')}</b> ${$t('(CUPS/Windows) oder per', '(CUPS/Windows) or via')} <b>${$t('Netzwerksuche', 'network discovery')}</b> ${$t('(Bonjour). Andere Apps brauchen die Adresse direkt – siehe „Front-End &amp; Schnittstellen" des Geräts.', '(Bonjour). Other apps need the address directly – see “Front end &amp; interfaces” of the device.')}${md.active && loop ? $t(' Hinweis: Die Geräte lauschen nur auf 127.0.0.1 – für Apps auf anderen Rechnern in den Einstellungen „im Netzwerk erreichbar" wählen.', ' Note: the devices only listen on 127.0.0.1 – for apps on other computers choose “reachable on the network” in the settings.') : ''}</div>
    <div class="row"><button class="primary" id="sysadd">${n ? $t('Systemdrucker aktualisieren', 'Update system printers') : $t('Als Systemdrucker eintragen', 'Register as system printers')}</button><label class="chk"><input type="checkbox" id="sysq"> ${$t('auch Warteschlangen/Presets (hold, …) als eigene Drucker', 'also queues/presets (hold, …) as separate printers')}</label>${n ? '<button class="danger" id="sysdel">' + $t('Systemdrucker entfernen', 'Remove system printers') + '</button>' : ''}<span class="spacer"></span><button class="ghost small" id="syscmd">${$t('Befehle anzeigen', 'Show commands')}</button></div>
    <pre class="proto" id="sysout" hidden style="margin-top:10px"></pre></div>`;
  const out = $('#sysout', el);
  const show = (t) => { out.hidden = false; out.textContent = t; };
  const go = async (b) => {
    show($t('Bitte warten …', 'Please wait …'));
    const r = await api('/api/system/printers', { json: b });
    show((r.output ? r.output + '\n' : '') + (r.ok ? $t('✔ Fertig – die Geräte erscheinen jetzt in Druckdialogen und Apps, die die Systemliste nutzen.', '✔ Done – the devices now appear in print dialogs and apps that use the system list.') : `✘ ${r.error}\n\n${r.hint}`));
    if (r.ok) setTimeout(() => renderVisibility(el), 1500);
  };
  $('#sysadd', el).onclick = () => go({ allQueues: $('#sysq', el).checked });
  if ($('#sysdel', el)) $('#sysdel', el).onclick = () => confirm($t('Alle VPF-Systemdrucker entfernen?', 'Remove all VPF system printers?')) && go({ remove: true });
  $('#syscmd', el).onclick = () => show(sys.commands);
}

// ------------------------------------------------------------------ Gerät
async function renderDevice(id, soft) {
  setNav('/device');
  const d = dev(id);
  if (!d) { $('#main').innerHTML = '<div class="empty">' + $t('Gerät nicht gefunden', 'Device not found') + '</div>'; return; }
  const tab = S.tab.device || 'jobs';
  const errBtns = [['jam', $t('Papierstau', 'Paper jam')], ['cover', $t('Abdeckung offen', 'Cover open')], ['finisher', $t('Finisher-Störung', 'Finisher fault')], ['cutter', $t('Messer-Fehler', 'Blade error')], ['offline', 'Offline'], ['paused', 'Pause']];
  let h = `<div class="row"><div><h1>${esc(d.name)} <span class="badge fe">${esc(d.frontend.label)}</span></h1>
    <div class="sub">${esc(d.vendor)} ${esc(d.model)} · ${esc(d.frontend.product)} · <span class="st ${d.status.state}">${esc(d.status.stateDe)}</span> <span class="mono">${esc(d.status.reasons.join(', '))}</span>${d.status.message && d.status.message !== d.status.stateDe ? ' – ' + esc(d.status.message) : ''}</div></div></div>
    <div class="row" style="margin-top:10px"><span class="sub">${$t('Störung simulieren:', 'Simulate fault:')}</span><div class="err-toggles">${errBtns.map(([k, t]) => `<button class="small ${d.errors[k] ? 'on' : ''}" data-err="${k}">${t}${d.errors[k] ? ' ✕' : ''}</button>`).join('')}</div>
    <span class="spacer"></span><a class="small" href="http://${esc(d.host === '0.0.0.0' ? '127.0.0.1' : d.host)}:${d.ports.http}/" target="_blank"><button class="small">${$t('Webseite', 'Web page')}: ${esc(d.frontend.label)} ↗</button></a><a href="/api/devices/${d.id}/driver.ppd"><button class="small">${$t('Treiber (PPD)', 'Driver (PPD)')}</button></a><button class="small" id="refill">${$t('Verbrauchsmaterial auffüllen', 'Refill consumables')}</button></div>`;
  const ifErr = Object.entries(d.ifaces || {}).filter(([, v]) => v && v.error);
  if (ifErr.length) h += `<div class="note err" style="margin-top:10px">${$t('Schnittstellen-Fehler:', 'Interface errors:')} ${ifErr.map(([k, v]) => `${k.toUpperCase()}: ${esc(v.error)}`).join(' · ')}</div>`;
  h += `<div class="tabs">${[['jobs', 'Jobs'], ['media', $t('Material laden', 'Load media')], ['finisher', $t('Finisher & Verbrauch', 'Finisher & consumables')], ['frontend', $t('Front-End & Schnittstellen', 'Front end & interfaces')], ['traffic', $t('Schnittstellen-Mitschnitt', 'Interface capture')]].map(([k, t]) => `<button data-tab="${k}" class="${tab === k ? 'act' : ''}">${t}</button>`).join('')}</div><div id="tabbody"></div>`;
  $('#main').innerHTML = h;
  $$('[data-tab]').forEach((b) => b.onclick = () => { S.tab.device = b.dataset.tab; renderDevice(id); });
  $$('[data-err]').forEach((b) => b.onclick = () => act(() => api(`/api/devices/${id}/errors`, { json: { type: b.dataset.err, active: !d.errors[b.dataset.err] } })));
  $('#refill').onclick = () => act(() => api(`/api/devices/${id}/refill`, { method: 'POST' }), $t('Aufgefüllt', 'Refilled'));
  const body = $('#tabbody');
  if (tab === 'jobs') deviceJobs(d, body);
  else if (tab === 'media') deviceMedia(d, body);
  else if (tab === 'finisher') deviceFinisher(d, body);
  else if (tab === 'frontend') deviceFrontend(d, body);
  else if (tab === 'traffic') await deviceTraffic(d, body);
}

function jobRows(list, showDev) {
  if (!list.length) return '<div class="empty">' + $t('Noch keine Jobs', 'No jobs yet') + '</div>';
  return `<table><tr><th>Job</th>${showDev ? '<th>' + $t('Gerät', 'Device') + '</th>' : ''}<th>Name</th><th>${$t('Eingang', 'Input')}</th><th>Status</th><th style="width:140px">${$t('Fortschritt', 'Progress')}</th><th>${$t('Zeit', 'Time')}</th></tr>${list.map((j) => `
    <tr class="click" data-job="${j.id}"><td class="num">${j.id}</td>${showDev ? `<td>${esc(dev(j.deviceId)?.name || j.deviceId)}</td>` : ''}<td>${esc(j.name)}</td><td><span class="badge">${esc(j.source?.protocol)}</span> <span class="sub">${esc(j.source?.queue || '')}</span></td>
    <td><span class="st ${j.state}">${esc(j.stateText || j.state)}</span><div class="sub" style="font-size:11.5px;max-width:340px">${esc(j.stateMessage || '')}</div></td>
    <td><div class="bar"><i data-prog="${j.id}" style="width:${Math.round((j.progress || 0) * 100)}%"></i></div></td><td class="num">${fmtTime(j.created)}</td></tr>`).join('')}</table>`;
}

function deviceJobs(d, body) {
  const q = d.queues;
  const roll = d.kind !== 'sheet';
  body.innerHTML = `<div class="card"><div class="row"><b>${$t('Testjob senden', 'Send test job')}</b><span class="sub">${$t('– geht durch dieselbe Verarbeitung wie Jobs von IPP/LPR/Hotfolder', '– goes through the same processing as jobs from IPP/LPR/hot folder')}</span></div>
    <div class="form" style="margin-top:10px">
      <label>${$t('Warteschlange / Preset', 'Queue / preset')}<select id="tq">${q.map((x) => `<option value="${esc(x.name)}">${esc(x.name)} (${x.mode})</option>`).join('')}</select></label>
      <label>${$t('Exemplare', 'Copies')}<input type="number" id="tcopies" value="1" min="1"></label>
      ${d.kind === 'sheet' ? `<label>${$t('Seiten', 'Sides')}<select id="tsides"><option value="">${$t('wie Preset', 'as preset')}</option><option value="one-sided">${$t('einseitig', 'one-sided')}</option><option value="two-sided-long-edge">${$t('duplex lange Kante', 'duplex long edge')}</option><option value="two-sided-short-edge">${$t('duplex kurze Kante', 'duplex short edge')}</option></select></label>
      <label>${$t('Ausschießen', 'Imposition')}<select id="timp"><option value="">${$t('wie Preset', 'as preset')}</option><option value="none">normal</option><option value="n-up">2-up</option><option value="booklet">${$t('Broschüre', 'Booklet')}</option><option value="step-repeat">Step &amp; Repeat</option></select></label>
      <label>${$t('Heften', 'Staple')}<select id="tstaple"><option value="">—</option>${(d.finisherInstalled.stapler?.positions || []).map((p) => `<option>${p}</option>`).join('')}</select></label>
      <label>${$t('Lochen', 'Punch')}<select id="tpunch"><option value="">—</option>${(d.finisherInstalled.puncher?.holes || []).map((p) => `<option>${p}</option>`).join('')}</select></label>
      <label>${$t('Falzen', 'Fold')}<select id="tfold"><option value="">—</option>${(d.finisherInstalled.folder?.types || []).map((p) => `<option>${p}</option>`).join('')}</select></label>` : ''}
      ${d.kind === 'wide' ? `<label>${$t('Falten', 'Fold (wide format)')}<select id="tfold"><option value="">—</option>${(d.finisherInstalled.wfFolder?.forms || []).map((p) => `<option>${p}</option>`).join('')}</select></label>
      <label class="chk"><input type="checkbox" id="tnest"> Nesting</label><label class="chk"><input type="checkbox" id="ttile"> ${$t('Kacheln wenn zu breit', 'Tile if too wide')}</label><label class="chk"><input type="checkbox" id="tmarg"> ${$t('Ränder hinzufügen', 'Add margins')}</label>` : ''}
      ${d.kind === 'photo' ? `<label>${$t('Printgröße', 'Print size')}<select id="tphoto"><option value="">${$t('wie Preset/Bild', 'as preset/image')}</option><option>89x127</option><option>102x152</option><option>127x178</option><option>152x203</option><option>203x254</option><option>203x305</option><option>210x297</option></select></label><label>${$t('Einpassen', 'Fit')}<select id="tfit"><option value="fill">${$t('füllen (beschneiden)', 'fill (crop)')}</option><option value="fit">${$t('einpassen (Rand)', 'fit (border)')}</option></select></label><label>${$t('Rückseitendruck', 'Back printing')}<input type="text" id="tback" placeholder="${$t('z. B. Auftrag 4711 / Bild {n}', 'e.g. order 4711 / image {n}')}"></label>` : ''}
      ${d.kind === 'printcut' ? `<label>${$t('Schneiden', 'Cut')}<select id="tcut"><option value="">${$t('wie Preset', 'as preset')}</option><option value="contour">CutContour</option><option value="trimbox">${$t('an TrimBox', 'at TrimBox')}</option><option value="none">${$t('nur Drucken', 'print only')}</option><option value="cut-only">${$t('nur Schneiden', 'cut only')}</option></select></label>` : ''}
      <label>${$t('Material erzwingen', 'Force media')}<select id="tmedia"><option value="">${$t('automatisch', 'automatic')}</option>${S.state.media.filter((m) => (m.kind === 'sheet') === (d.kind === 'sheet')).map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
    </div>
    <div class="drop" id="drop" style="margin-top:12px">${$t('Datei hierher ziehen oder klicken (PDF, PS, JPG, PNG, HP-GL, PRN)', 'Drag a file here or click (PDF, PS, JPG, PNG, HP-GL, PRN)')}<input type="file" id="tfile" hidden></div></div>
    <h2>Jobs</h2>${jobRows(S.jobs.filter((j) => j.deviceId === d.id))}`;
  $$('[data-job]', body).forEach((tr) => tr.onclick = () => (location.hash = '#/job/' + tr.dataset.job));
  const drop = $('#drop'), fi = $('#tfile');
  drop.onclick = () => fi.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); for (const f of e.dataTransfer.files) upload(d, f); };
  fi.onchange = () => { for (const f of fi.files) upload(d, f); fi.value = ''; };
}

async function upload(d, file) {
  const t = { copies: Number($('#tcopies').value) || 1 };
  const v = (id) => ($('#' + id) ? $('#' + id).value : '');
  if (v('tsides')) t.sides = v('tsides');
  if (v('timp')) { t.imposition = v('timp'); if (t.imposition === 'n-up') t.numberUp = 2; if (t.imposition === 'booklet') t.finishing = { booklet: { saddle: true } }; }
  const fin = t.finishing || {};
  if (v('tstaple')) fin.staple = v('tstaple');
  if (v('tpunch')) fin.punch = { holes: Number(v('tpunch')), edge: 'left' };
  if (v('tfold')) fin.fold = v('tfold');
  if (Object.keys(fin).length) t.finishing = fin;
  if ($('#tnest')?.checked || $('#ttile')?.checked || $('#tmarg')?.checked) t.roll = { nesting: !!$('#tnest')?.checked || undefined, tiling: !!$('#ttile')?.checked || undefined, addMargins: !!$('#tmarg')?.checked || undefined };
  if (t.roll) for (const k of Object.keys(t.roll)) if (t.roll[k] === undefined) delete t.roll[k];
  if (v('tphoto')) t.photo = { printSizeMm: v('tphoto').split('x').map(Number) };
  if ($('#tfit')) t.photo = { ...(t.photo || {}), fit: v('tfit') };
  if (v('tback')) t.photo = { ...(t.photo || {}), backprint: v('tback') };
  if (v('tcut')) t.cut = { mode: v('tcut') };
  if (v('tmedia')) t.media = { mediaId: v('tmedia') };
  const fd = new FormData();
  fd.append('file', file);
  fd.append('queue', v('tq'));
  fd.append('ticket', JSON.stringify(t));
  const j = await act(() => api(`/api/devices/${d.id}/jobs`, { method: 'POST', body: fd }), $t(`Job „${file.name}" gesendet`, `Job “${file.name}” sent`));
  if (j) { S.jobs.unshift(j); location.hash = '#/job/' + j.id; }
}

function deviceMedia(d, body) {
  const compat = (s) => S.state.media.filter((m) => m.kind === s.kind && (s.kind === 'sheet'
    ? (!d.sheet || (Math.max(m.widthMm, m.heightMm) <= Math.max(...d.sheet.maxMm) + 0.5 && Math.min(m.widthMm, m.heightMm) <= Math.min(...d.sheet.maxMm) + 0.5 && m.gsm <= d.sheet.maxGsm))
    : (!d.roll || (m.widthMm <= d.roll.maxWidthMm && m.widthMm >= d.roll.minWidthMm))));
  const waiting = S.jobs.filter((j) => j.deviceId === d.id && ['held', 'waiting', 'stopped'].includes(j.state) && j.waitReason);
  let h = waiting.length ? `<div class="note warn">${waiting.map((j) => $t(`Job ${j.id} „${esc(j.name)}" wartet: ${esc(j.waitReason.text)}`, `Job ${j.id} “${esc(j.name)}” is waiting: ${esc(j.waitReason.text)}`)).join('<br>')}</div>` : '';
  h += `<div class="sub" style="margin:8px 0 12px">${d.kind === 'sheet' ? $t(`Bogenformat ${d.sheet.minMm.join('×')} bis ${d.sheet.maxMm.join('×')} mm, bis ${d.sheet.maxGsm} g/m²`, `Sheet size ${d.sheet.minMm.join('×')} to ${d.sheet.maxMm.join('×')} mm, up to ${d.sheet.maxGsm} g/m²`) : $t(`Rollenbreite ${d.roll.minWidthMm}–${d.roll.maxWidthMm} mm`, `Roll width ${d.roll.minWidthMm}–${d.roll.maxWidthMm} mm`)} ${$t('· nicht bedruckbarer Rand', '· non-printable margin')} ${d.marginsMm.left} mm</div><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(380px,1fr))">`;
  for (const s of d.slots) {
    const l = slotLevel(s);
    const viz = s.kind === 'roll'
      ? `<div class="rollviz"><div class="roll" style="width:${s.media ? Math.max(30, Math.min(200, s.media.widthMm / 8)) : 60}px"><i style="width:${Math.round(l.pct * 100)}%"></i></div><span class="mono">${s.media ? s.media.widthMm + ' mm' : ''}</span></div>`
      : `<div class="sheetviz"><i style="height:${Math.round(l.pct * 100)}%"></i></div>`;
    h += `<div class="slot"><div><div class="row"><b>${esc(s.name)}</b><span class="badge mono">${esc(s.ippSource)}</span></div>
      <div style="margin:4px 0 8px">${s.media ? esc(s.media.name) : '<span class="sub">' + $t('leer', 'empty') + '</span>'}${s.media ? ` <span class="sub">· ${s.media.gsm} g/m² · ${esc(s.media.type)}</span>` : ''}</div>
      <div class="row"><select data-slot="${s.id}" style="max-width:260px"><option value="">${$t('— entladen —', '— unload —')}</option>${compat(s).map((m) => `<option value="${m.id}" ${s.media && s.media.id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <input type="number" data-level="${s.id}" value="${s.media ? (s.kind === 'roll' ? Math.round((s.loaded.levelM ?? s.media.lengthM) * 100) / 100 : s.loaded.level) : ''}" title="${s.kind === 'roll' ? $t('Restlänge m', 'Remaining length m') : $t('Bogen', 'Sheets')}"><span class="sub">${s.kind === 'roll' ? 'm' : $t('Bogen', 'Sheets')}</span>
      <button class="small primary" data-load="${s.id}${$t('">Laden', '">Load')}</button></div></div><div style="text-align:center">${viz}<div class="mono sub" style="margin-top:4px">${l.txt}</div></div></div>`;
  }
  h += '</div>';
  body.innerHTML = h;
  // Noch nicht geladene Auswahl über Neuzeichnen (Statusmeldungen) hinweg behalten
  S.slotDraft = S.slotDraft || {};
  for (const s of d.slots) {
    const dr = S.slotDraft[d.id + '/' + s.id];
    if (!dr) continue;
    if (dr.media != null) $(`[data-slot="${s.id}"]`, body).value = dr.media;
    if (dr.level != null) $(`[data-level="${s.id}"]`, body).value = dr.level;
    $(`[data-load="${s.id}"]`, body).classList.add('pulse');
  }
  $$('[data-slot],[data-level]', body).forEach((el) => el.addEventListener('input', () => {
    const id = el.dataset.slot || el.dataset.level;
    const k = d.id + '/' + id;
    S.slotDraft[k] = { ...(S.slotDraft[k] || {}), [el.dataset.slot ? 'media' : 'level']: el.value };
    $(`[data-load="${id}"]`, body).classList.add('pulse');
  }));
  $$('[data-load]', body).forEach((b) => b.onclick = () => {
    const id = b.dataset.load;
    delete S.slotDraft[d.id + '/' + id];
    const mediaId = $(`[data-slot="${id}"]`, body).value;
    const lvl = $(`[data-level="${id}"]`, body).value;
    const s = d.slots.find((x) => x.id === id);
    const same = s.media && s.media.id === mediaId;
    act(() => api(`/api/devices/${d.id}/slots/${id}`, { json: same ? { level: lvl, keepMedia: true } : { mediaId, level: same ? lvl : undefined } }), mediaId ? $t('Material geladen', 'Media loaded') : $t('Entladen', 'Unloaded'));
  });
}

function deviceFinisher(d, body) {
  const m = d.finisher?.modules || {};
  const DE = { stapler: $t('Hefter', 'Stapler'), puncher: $t('Locher', 'Puncher'), booklet: $t('Broschürenmodul', 'Booklet maker'), folder: $t('Falzeinheit', 'Folding unit'), stacker: $t('Stapler/Ablage', 'Stacker/tray'), cutter: $t('Querschneider', 'Cross cutter'), wfFolder: $t('Online-Faltmaschine', 'Online folder'), takeUp: $t('Aufwickler', 'Take-up reel'), contourCutter: $t('Konturschneider', 'Contour cutter'), backprint: $t('Rückseitendruck', 'Back printing'), sorter: $t('Sortierer', 'Sorter') };
  let h = `<h2 style="margin-top:0">${esc(d.finisher?.name || 'Finisher')}</h2><div class="grid cards">`;
  for (const [k, v] of Object.entries(m)) {
    h += `<div class="card"><b>${DE[k] || k}</b><dl class="kv" style="margin-top:6px">${Object.entries(v).map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(Array.isArray(b) ? b.join(', ') : typeof b === 'object' ? JSON.stringify(b) : b)}</dd>`).join('') || '<dd class="sub">' + $t('vorhanden', 'present') + '</dd>'}</dl></div>`;
  }
  h += `</div><h2>${$t('Ablagen', 'Output trays')}</h2><div class="row">${(d.finisher?.bins || []).map((b) => `<span class="badge">${esc(b.name)} <code>${esc(b.id)}</code></span>`).join(' ')}</div>
  <h2>${$t('Toner / Tinte', 'Toner / ink')}</h2><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">${(d.supplies || []).map((s) => `<div><div class="row"><span style="width:10px;height:10px;border-radius:2px;background:${s.color}"></span>${esc(s.name)}<span class="spacer"></span><span class="mono">${Math.round(s.level)} %</span></div><div class="bar ${s.level < 10 ? 'low' : ''}"><i style="width:${s.level}%;background:${s.color}"></i></div></div>`).join('')}</div>`;
  body.innerHTML = h;
}

function deviceFrontend(d, body) {
  const ep = d.endpoints;
  const copy = (t) => `<button class="small" data-copy="${esc(t)}${$t('">kopieren', '">copy')}</button>`;
  const MODDE = { stapler: $t('Hefter', 'Stapler'), puncher: $t('Locher', 'Puncher'), booklet: $t('Broschürenmodul', 'Booklet maker'), folder: $t('Falzeinheit', 'Folding unit'), stacker: $t('Hochstapler/Ablage', 'High-capacity stacker'), cutter: $t('Querschneider', 'Cross cutter'), wfFolder: $t('Online-Faltmaschine', 'Online folder'), takeUp: $t('Aufwickler', 'Take-up reel'), contourCutter: $t('Konturschneider', 'Contour cutter'), backprint: $t('Rückseitendruck', 'Back printing'), sorter: $t('Sortierer', 'Sorter') };
  const srvUrl = `http://${d.host === '0.0.0.0' ? '127.0.0.1' : d.host}:${d.ports.http}/`;
  let h = `<div class="card" style="margin-bottom:12px"><div class="row"><b>${esc(d.frontend.stationDe)}: ${esc(d.frontend.product)}</b><span class="badge fe">${esc(d.frontend.label)}</span>${d.frontend.choices.length > 1 ? `<label class="chk" style="margin-left:8px">${$t('Betriebsart', 'Operating mode')} <select id="femode">${d.frontend.choices.map((c) => `<option value="${c}" ${c === d.frontend.type ? 'selected' : ''}>${c === 'driver' ? $t('Direkt an den Drucker (ohne RIP)', 'Direct to the printer (no RIP)') : c === 'edgeprint' ? $t('Mit Software-RIP (Epson Edge Print)', 'With software RIP (Epson Edge Print)') : c}</option>`).join('')}</select></label>` : ''}<span class="spacer"></span><a href="${esc(srvUrl)}" target="_blank">${$t('Webseite', 'Web page')} ↗</a> · <a href="${esc(srvUrl)}${$t('driver" target="_blank">Treiber &amp; Software ↗', 'driver" target="_blank">Driver &amp; software ↗')}</a> · <a href="/api/devices/${d.id}${$t('/driver.ppd">PPD herunterladen', '/driver.ppd">Download PPD')}</a></div>
    <div class="sub" style="margin:6px 0 8px">${$t('Installierbare Optionen – welche Finisher-Module am Gerät hängen. Gilt für Verarbeitung, IPP-Fähigkeiten, Bonjour und den erzeugten Treiber. Nach Änderungen „Systemdrucker aktualisieren" (Maschinenpark-Seite), damit der Systemtreiber passt.', 'Installable options – which finisher modules are attached to the device. Applies to processing, IPP capabilities, Bonjour and the generated driver. After changes use “Update system printers” (machine park page) so the system driver matches.')}</div>
    <div class="row">${Object.entries(d.finisher?.modules || {}).map(([k, m]) => `<label class="chk"><input type="checkbox" data-mod="${k}" ${m.installed !== false ? 'checked' : ''}> ${esc(MODDE[k] || k)}</label>`).join('')}</div></div>
    <div class="grid" style="grid-template-columns:1fr 1fr;align-items:start"><div class="card"><b>${$t('So spricht die Drucker-App dieses Gerät an', 'How the printer app talks to this device')}</b>
    <div style="margin-top:8px">
    <div class="endpoint"><span class="k">${$t('IPP (Standard)', 'IPP (default)')}</span><code>${esc(ep.ipp)}</code>${copy(ep.ipp)}</div>
    ${ep.ippQueues.map((u, i) => `<div class="endpoint"><span class="k">${$t('IPP „', 'IPP “')}${esc(d.queues[i].name)}"</span><code>${esc(u)}</code>${copy(u)}</div>`).join('')}
    <div class="endpoint"><span class="k">LPR/LPD</span><code>${esc(ep.lpd)} ${$t('· Queues:', '· queues:')} ${esc(ep.lpdQueues.join(', '))}</code>${copy(ep.lpd)}</div>
    <div class="endpoint"><span class="k">Socket (AppSocket/9100)</span><code>${esc(ep.raw)}</code>${copy(ep.raw)}</div>
    <div class="endpoint"><span class="k">JDF/JMF</span><code>${esc(ep.jmf)}</code>${copy(ep.jmf)}</div>
    ${ep.fieryApi ? `<div class="endpoint"><span class="k">${$t('Fiery-API (Nachbildung)', 'Fiery API (emulation)')}</span><code>${esc(ep.fieryApi)}</code>${copy(ep.fieryApi)}</div>` : ''}
    <div class="endpoint"><span class="k">Hotfolder</span><code>${esc(ep.hotfolders)}</code>${copy(ep.hotfolders)}</div></div>
    <div class="note" style="margin-top:10px">${$t('Für Windows-Drucker mit „LPR-Port" (fest Port 515) oder Standard-Ports 631/9100 jedem Gerät eine eigene Loopback-Adresse geben (z. B. 127.0.0.11) und die Ports unten auf 631/515/9100 setzen.', 'For Windows printers with an “LPR port” (fixed port 515) or standard ports 631/9100, give each device its own loopback address (e.g. 127.0.0.11) and set the ports below to 631/515/9100.')}</div></div>
    <div class="card"><b>${$t('Front-End-Verhalten', 'Front-end behaviour')}</b><div class="form" style="margin-top:10px">
      <label>${$t('Bei fehlendem Material', 'When media is missing')}<select id="fmis"><option value="hold" ${d.frontend.mismatchPolicy === 'hold' ? 'selected' : ''}${$t('>Job anhalten (Fiery/FreeFlow)', '>Hold job (Fiery/FreeFlow)')}</option><option value="wait" ${d.frontend.mismatchPolicy === 'wait' ? 'selected' : ''}${$t('>Warten bis Material geladen (PRISMAsync)', '>Wait until media is loaded (PRISMAsync)')}</option></select></label>
      <label>${$t('Bei Finishing-Konflikt', 'On finishing conflict')}<select id="fcon"><option value="hold" ${d.frontend.conflictPolicy === 'hold' ? 'selected' : ''}${$t('>Job anhalten', '>Hold job')}</option><option value="ignore" ${d.frontend.conflictPolicy === 'ignore' ? 'selected' : ''}${$t('>Ohne Finishing drucken', '>Print without finishing')}</option></select></label>
      <label class="chk"><input type="checkbox" id="fats" ${d.settings.autoTraySwitch !== false ? 'checked' : ''}${$t('> Automatische Fachumschaltung', '> Automatic tray switching')}</label>
      <label class="chk"><input type="checkbox" id="fauth" ${d.settings.fieryApiAuth ? 'checked' : ''}${$t('> Fiery-API: Login verlangen', '> Fiery API: require login')}</label>
    </div><h3>${$t('Netzwerk', 'Network')}</h3><div class="form">
      <label>${$t('Adresse (leer = global)', 'Address (empty = global)')}<input type="text" id="fhost" value="${esc(d.host === S.state.settings.bindHost ? '' : d.host)}" placeholder="${esc(S.state.settings.bindHost)}"></label>
      <label>HTTP (IPP/JMF/API)<input type="number" id="fhttp" value="${d.ports.http}"></label>
      <label>LPD<input type="number" id="flpd" value="${d.ports.lpd}"></label>
      <label>Socket<input type="number" id="fraw" value="${d.ports.raw}"></label>
    </div><div class="row" style="margin-top:12px"><button class="primary" id="fsave">${$t('Speichern', 'Save')}</button><button id="fdup">${$t('Gerät duplizieren', 'Duplicate device')}</button><span class="spacer"></span><button class="danger" id="fdel">${$t('Gerät entfernen', 'Remove device')}</button></div></div></div>
    <h2>${$t('Warteschlangen, virtuelle Drucker &amp; Hotfolder', 'Queues, virtual printers &amp; hot folders')}</h2><table><tr><th>Name</th><th>${$t('Modus', 'Mode')}</th><th>${$t('Ticket-Vorgaben', 'Ticket defaults')}</th><th>Hotfolder</th></tr>
    ${d.queues.map((q) => `<tr><td><b>${esc(q.name)}</b><div class="sub">${esc(q.info)}</div></td><td><span class="badge">${q.mode}</span></td><td><code>${esc(JSON.stringify(q.ticket))}</code></td><td><code style="font-size:11px">${esc(q.hotfolder)}</code></td></tr>`).join('')}</table>
    <h3>${$t('Presets bearbeiten (JSON)', 'Edit presets (JSON)')}</h3><textarea id="fpresets" rows="8" style="width:100%;font-family:var(--mono);font-size:12px">${esc(JSON.stringify(d.presets, null, 2))}</textarea>
    <div class="sub">${$t('Format:', 'Format:')} <code>[{"name":"Broschuere","mode":"print|hold","ticket":{"imposition":"booklet", "copies":2, "media":{"mediaId":"..."}, "finishing":{"staple":"top-left"}}}]</code></div>`;
  body.innerHTML = h;
  $$('[data-copy]', body).forEach((b) => b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast($t('Kopiert', 'Copied')); });
  if ($('#femode', body)) $('#femode', body).onchange = (e) => act(() => api(`/api/devices/${d.id}`, { method: 'PUT', json: { frontendType: e.target.value } }).then(loadState).then(() => renderDevice(d.id)), $t('Betriebsart geändert', 'Operating mode changed'));
  $$('[data-mod]', body).forEach((cb) => cb.onchange = () => {
    const fin = JSON.parse(JSON.stringify(d.finisher));
    fin.modules[cb.dataset.mod].installed = cb.checked;
    act(() => api(`/api/devices/${d.id}`, { method: 'PUT', json: { finisher: fin } }).then(loadState), `${MODDE[cb.dataset.mod] || cb.dataset.mod}: ${cb.checked ? $t('installiert', 'installed') : $t('nicht installiert', 'not installed')}`);
  });
  $('#fsave').onclick = () => {
    let presets;
    try { presets = JSON.parse($('#fpresets').value); } catch (e) { return toast($t('Presets: ungültiges JSON', 'Presets: invalid JSON'), true); }
    act(() => api(`/api/devices/${d.id}`, { method: 'PUT', json: {
      settings: { ...d.settings, mismatchPolicy: $('#fmis').value, conflictPolicy: $('#fcon').value, autoTraySwitch: $('#fats').checked, fieryApiAuth: $('#fauth').checked },
      host: $('#fhost').value.trim() || undefined, ports: { http: Number($('#fhttp').value), lpd: Number($('#flpd').value), raw: Number($('#fraw').value) }, presets,
    } }).then(loadState), $t('Gespeichert', 'Saved'));
  };
  $('#fdup').onclick = async () => { const r = await act(() => api(`/api/devices/${d.id}/duplicate`, { json: {} }), $t('Gerät dupliziert', 'Device duplicated')); if (r) { await loadState(); location.hash = '#/device/' + r.id; } };
  $('#fdel').onclick = async () => { if (!confirm($t(`${d.name} entfernen?`, `Remove ${d.name}?`))) return; await act(() => api(`/api/devices/${d.id}`, { method: 'DELETE' }), $t('Entfernt', 'Removed')); await loadState(); location.hash = '#/'; };
}

async function deviceTraffic(d, body) {
  const list = await api(`/api/devices/${d.id}/traffic`);
  const hideNoisy = S.hideNoisy !== false;
  const shown = list.filter((e) => !hideNoisy || !e.noisy).reverse();
  body.innerHTML = `<div class="row" style="margin-bottom:8px"><label class="chk"><input type="checkbox" id="noisy" ${hideNoisy ? 'checked' : ''}${$t('> Statusabfragen (Polling) ausblenden', '> Hide status queries (polling)')}</label><span class="sub">${list.length} ${$t('Einträge,', 'entries,')} ${list.filter((e) => e.noisy).length} ${$t('Abfragen', 'queries')}</span></div>
    <div class="log traffic">${shown.map((e, i) => `<div class="e ${e.dir}" data-i="${i}"><span class="ts">${fmtTime(e.ts)}</span><span class="ph">${e.dir === 'in' ? '→ ' : '← '}${esc(e.proto.toUpperCase())}</span><span>${esc(e.title)}</span>${e.text ? `<pre hidden>${esc(e.text)}</pre>` : ''}</div>`).join('') || '<div class="empty">' + $t('Noch kein Verkehr', 'No traffic yet') + '</div>'}</div>`;
  $('#noisy').onchange = (ev) => { S.hideNoisy = ev.target.checked; deviceTraffic(d, body); };
  $$('.traffic .e', body).forEach((el) => el.onclick = () => { const p = $('pre', el); if (p) p.hidden = !p.hidden; });
}

// ------------------------------------------------------------------ Job
async function loadJob(id) {
  S.jobDetail = await api('/api/jobs/' + id);
  try { S.jobDetail.layout = S.jobDetail.outputs?.layout ? await api(`/api/jobs/${id}/files/layout.json`) : null; } catch { S.jobDetail.layout = null; }
  try { S.jobDetail.protocolText = await api(`/api/jobs/${id}/protocol`); } catch { S.jobDetail.protocolText = ''; }
}

function logEntry(e) {
  const data = e.data !== undefined && e.data !== null ? (Array.isArray(e.data) && e.data.length && typeof e.data[0] === 'object' ? tableText(e.data) : typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2)) : null;
  return `<div class="e ${e.level}"><span class="ts">+${(e.sim / 1000).toFixed(1)} s</span><span class="ph">${esc(e.phase)}</span><span>${esc(e.msg)}</span>${data ? `<pre>${esc(data)}</pre>` : ''}</div>`;
}
function tableText(rows) {
  const keys = Object.keys(rows[0]);
  const c = (v) => (v === true ? $t('ja', 'yes') : v === false ? $t('nein', 'no') : v == null ? '' : String(v));
  const w = keys.map((k) => Math.max(k.length, ...rows.map((r) => c(r[k]).length)));
  return [keys.map((k, i) => k.toUpperCase().padEnd(w[i])).join('  '), ...rows.map((r) => keys.map((k, i) => c(r[k]).padEnd(w[i])).join('  '))].join('\n');
}

function renderJob(soft) {
  setNav('/job');
  const j = S.jobDetail;
  const d = dev(j.deviceId);
  const tab = S.tab.job || 'view';
  const canRelease = ['held', 'waiting'].includes(j.state);
  const prevScroll = soft ? $('#joblog')?.scrollTop : null;
  let h = `<div class="row"><div><div class="sub"><a href="#/device/${j.deviceId}">${esc(d?.name || j.deviceId)}</a> · Job ${j.id}</div><h1>${esc(j.name)}</h1>
    <div class="row"><span class="st ${j.state}">${esc(j.stateText)}</span><span class="sub">${esc(j.stateMessage || '')}</span><span class="mono sub">${esc((j.stateReasons || []).join(', '))}</span></div></div><span class="spacer"></span>
    <div class="row">${canRelease ? `<button class="primary" id="jrel">${$t('Freigeben', 'Release')}</button>${j.waitReason?.kind === 'conflict' ? '<button id="jforce">' + $t('Trotzdem drucken', 'Print anyway') + '</button>' : ''}` : ''}
    ${!['completed', 'canceled', 'aborted'].includes(j.state) ? '<button class="danger" id="jcan">' + $t('Abbrechen', 'Cancel') + '</button>' : '<button id="jre">' + $t('Erneut drucken', 'Print again') + '</button>'}
    <button id="jdel" class="ghost">${$t('Löschen', 'Delete')}</button></div></div>
    <div class="bar" style="margin-top:10px"><i data-prog="${j.id}" style="width:${Math.round((j.progress || 0) * 100)}%"></i></div>`;
  if (j.waitReason) h += `<div class="note warn" style="margin-top:10px"><b>${j.waitReason.kind === 'conflict' ? $t('Finishing-Konflikt', 'Finishing conflict') : $t('Material', 'Media')}:</b> ${esc(j.waitReason.text)}${j.waitReason.kind !== 'conflict' ? ` ${$t('– Material im Tab', '– load the media in the tab')} <a href="#/device/${j.deviceId}${$t('" onclick="window.__tab=\'media\'">„Material laden"', '" onclick="window.__tab=\'media\'">“Load media”')}</a> einlegen${d?.frontend.mismatchPolicy === 'hold' ? $t(' und Job freigeben', ' and release the job') : $t(' (Job läuft dann automatisch weiter)', ' (the job then continues automatically)')}.` : ''}</div>`;
  const sm = j.summary;
  h += `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr));margin-top:14px">
    <div class="card"><h3 style="margin-top:0">${$t('Eingang', 'Input')}</h3><dl class="kv"><dt>${$t('Protokoll', 'Protocol')}</dt><dd>${esc(j.source?.protocol)}${j.source?.op ? ' ' + esc(j.source.op) : ''}</dd><dt>${$t('Warteschlange', 'Queue')}</dt><dd>${esc(j.ticket?.queue || '')}</dd><dt>${$t('Benutzer', 'User')}</dt><dd>${esc(j.user)}</dd><dt>Format</dt><dd>${esc(j.input?.format || '')} · ${(j.input?.bytes || 0).toLocaleString(LOCALE())} B</dd><dt>${$t('Dokument', 'Document')}</dt><dd>${j.doc ? `${j.doc.pages} ${$t('S.', 'p.')} · ${esc((j.doc.sizesMm || []).slice(0, 2).map((s) => s.join('×')).join(', '))} mm` : ''}</dd>${j.doc?.spots?.length ? `<dt>${$t('Schmuckfarben', 'Spot colours')}</dt><dd>${esc(j.doc.spots.join(', '))}</dd>` : ''}</dl></div>
    <div class="card"><h3 style="margin-top:0">${$t('Ergebnis', 'Result')}</h3>${sm ? `<dl class="kv">${sm.sheet ? `<dt>${$t('Bogen', 'Sheet')}</dt><dd>${esc(sm.sheet)}</dd>` : ''}<dt>${$t('Flächen', 'Surfaces')}</dt><dd>${sm.surfaces} ${$t('(gesamt', '(total')} ${sm.sheetsTotal} ${sm.kind === 'sheet' ? $t('Bogen', 'Sheets') : sm.kind === 'photo' ? 'Prints' : $t('Abschnitte', 'Sections')})</dd>${sm.m2 ? `<dt>${$t('Fläche', 'Area')}</dt><dd>${sm.m2} m²</dd>` : ''}${sm.cutLengthM ? `<dt>${$t('Schnittlänge', 'Cut length')}</dt><dd>${sm.cutLengthM} m</dd>` : ''}<dt>${$t('Ablage', 'Output tray')}</dt><dd>${esc(sm.outputBin || '')}</dd>${sm.consumption.map((c) => `<dt>${esc(c.slot)}</dt><dd>${c.sheets != null ? c.sheets + $t(' Bogen', ' sheets') : c.meters + ' m'} ${esc(c.media)}</dd>`).join('')}</dl>` : '<div class="sub">' + $t('noch nicht gerippt', 'not RIPped yet') + '</div>'}</div>
    <div class="card"><h3 style="margin-top:0">${$t('Weiterverarbeitung', 'Finishing')}</h3>${sm?.finishing?.length ? sm.finishing.map((f) => `<div style="margin-bottom:4px">• ${esc(f)}</div>`).join('') : '<div class="sub">—</div>'}</div>
    <div class="card"><h3 style="margin-top:0">${$t('Zähler', 'Counters')}</h3><dl class="kv"><dt>${$t('Bogen', 'Sheets')}</dt><dd class="mono">${j.counters?.sheets || 0}</dd><dt>${$t('Drucke', 'Impressions')}</dt><dd class="mono">${j.counters?.impressions || 0}</dd><dt>${$t('Prints/Abschnitte', 'Prints/sections')}</dt><dd class="mono">${j.counters?.prints || 0}</dd><dt>${$t('Rolle', 'Roll')}</dt><dd class="mono">${((j.counters?.lengthMm || 0) / 1000).toFixed(2)} m</dd><dt>${$t('Schnitte', 'Cuts')}</dt><dd class="mono">${j.counters?.cuts || 0}</dd><dt>${$t('Sim.-Zeit', 'Sim. time')}</dt><dd class="mono">${(j.simMs / 1000).toFixed(1)} s</dd></dl></div></div>`;
  h += `<div class="tabs">${[['view', $t('Bogen-/Rollenansicht', 'Sheet/roll view')], ['log', $t('Ablauf-Log', 'Process log')], ['proto', $t('Protokoll-Mitschnitt', 'Protocol capture')], ['ticket', $t('Ticket', 'Ticket')], ['files', $t('Dateien', 'Files')]].map(([k, t]) => `<button data-jtab="${k}" class="${tab === k ? 'act' : ''}">${t}</button>`).join('')}</div><div id="jbody"></div>`;
  $('#main').innerHTML = h;
  $$('[data-jtab]').forEach((b) => b.onclick = () => { S.tab.job = b.dataset.jtab; renderJob(); });
  const A = (a, b) => act(() => api(`/api/jobs/${j.id}/${a}`, { json: b || {} }));
  if ($('#jrel')) $('#jrel').onclick = () => A('release');
  if ($('#jforce')) $('#jforce').onclick = () => A('release', { force: true });
  if ($('#jcan')) $('#jcan').onclick = () => A('cancel');
  if ($('#jre')) $('#jre').onclick = () => A('reprint');
  $('#jdel').onclick = async () => { if (!confirm($t('Job löschen?', 'Delete job?'))) return; await A('delete'); location.hash = '#/device/' + j.deviceId; };
  const body = $('#jbody');
  if (tab === 'view') renderViewer(j, body);
  else if (tab === 'log') { body.innerHTML = `<div class="log" id="joblog">${j.log.map(logEntry).join('')}</div><div class="row" style="margin-top:8px"><a href="/api/jobs/${j.id}/files/log.txt?download=1">log.txt herunterladen</a><a href="/api/jobs/${j.id}/files/log.json?download=1">log.json</a></div>`; const lb = $('#joblog'); lb.scrollTop = prevScroll ?? lb.scrollHeight; }
  else if (tab === 'proto') body.innerHTML = `<div class="sub" style="margin-bottom:6px">${$t('Alles, was über die Schnittstelle hereinkam (IPP-Attribute, LPD-Steuerdatei, PJL-Kopf, JMF/JDF, Fiery-API) und was die App als Antwort bekam.', 'Everything that came in through the interface (IPP attributes, LPD control file, PJL header, JMF/JDF, Fiery API) and what the app got as a response.')}</div><pre class="proto">${esc(j.protocolText || $t('(kein Protokoll)', '(no log)'))}</pre>`;
  else if (tab === 'ticket') {
    const flat = [];
    const walk = (o, p) => { for (const [k, v] of Object.entries(o || {})) { const path = p ? p + '.' + k : k; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path); else flat.push([path, v]); } };
    walk(j.ticket, '');
    body.innerHTML = `<table><tr><th>${$t('Einstellung', 'Setting')}</th><th>${$t('Wert', 'Value')}</th><th>${$t('Quelle', 'Source')}</th></tr>${flat.filter(([k]) => k !== 'unknown').map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(JSON.stringify(v))}</td><td>${esc(j.ticketSources?.[k] || (v === null || v === false ? '' : $t('Standard', 'Default')))}</td></tr>`).join('')}</table>
      ${j.ticket.unknown?.length ? `<h3>${$t('Nicht ausgewertete Angaben', 'Unevaluated settings')}</h3><pre class="proto">${esc(JSON.stringify(j.ticket.unknown, null, 2))}</pre>` : ''}`;
  } else if (tab === 'files') {
    const files = [['eingang', j.input?.file, $t('Original wie empfangen', 'Original as received')], ['dokument.pdf', 'dokument.pdf', $t('Normalisiertes PDF (RIP-Eingang)', 'Normalized PDF (RIP input)')], ['ausgabe.pdf', j.outputs?.ausgabe, $t('Was die Maschine druckt – ausgeschossen, mit RIP-Marken', 'What the machine prints – imposed, with RIP marks')], ['nachweis.pdf', j.outputs?.nachweis, $t('Nachweis mit ein-/ausblendbaren Ebenen (Schnitt, Falz, Heftung, …)', 'Proof with layers that can be shown/hidden (cut, fold, stapling, …)')], ['schnitt.camm', j.outputs?.cut, $t('Schneiddaten (CAMM-GL-artig)', 'Cut data (CAMM-GL style)')], ['layout.json', j.outputs?.layout, $t('Geometrie aller Flächen', 'Geometry of all surfaces')], ['log.txt', 'log.txt', $t('Ablauf-Log', 'Process log')], ['protokoll.txt', 'protokoll.txt', $t('Schnittstellen-Mitschnitt', 'Interface capture')], ['job.json', 'job.json', $t('Job-Zustand', 'Job state')]].filter((f) => f[1]);
    body.innerHTML = `<table>${files.map(([n, f, d2]) => `<tr><td><a href="/api/jobs/${j.id}/files/${encodeURIComponent(f)}" target="_blank">${esc(n === 'eingang' ? f : n)}</a></td><td class="sub">${esc(d2)}</td><td><a href="/api/jobs/${j.id}/files/${encodeURIComponent(f)}?download=1">herunterladen</a></td></tr>`).join('')}</table>`;
  }
}

// ------------------------------------------------------------------ Bogenansicht
let pdfjs = null;
const pdfCache = new Map();
async function getPdf(url) {
  if (!pdfjs) {
    pdfjs = await import('/vendor/pdfjs/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
  }
  if (!pdfCache.has(url)) pdfCache.set(url, pdfjs.getDocument({ url }).promise);
  return pdfCache.get(url);
}

function renderViewer(j, body) {
  const L = j.layout;
  if (!L) { body.innerHTML = '<div class="empty">' + $t('Noch kein Layout – der Job wurde noch nicht gerippt.', 'No layout yet – the job has not been RIPped yet.') + '</div>'; return; }
  const v = S.viewer;
  if (v.job !== j.id) { v.job = j.id; v.surface = 0; }
  const s = L.surfaces[v.surface] || L.surfaces[0];
  const layerDefs = [['print', $t('Druckbild', 'Print image'), '#888'], ['place', $t('Nutzen/Seiten', 'Items/pages'), '#0aa'], ['cut', $t('Schnitt', 'Cut'), '#dc1f26'], ['fold', $t('Falz', 'Fold'), '#1a5ae6'], ['staple', $t('Heftung/Lochung', 'Stapling/punching'), '#0b7334'], ['waste', $t('Rand/Abfall', 'Margin/waste'), '#aaa']];
  body.innerHTML = `<div class="viewer"><div class="thumbs">${L.surfaces.map((x, i) => `<button data-surf="${i}" class="${i === v.surface ? 'act' : ''}">${esc(x.label)}<div class="sub mono" style="font-size:11px">${mm(x.wPt)} × ${mm(x.hPt)} mm</div></button>`).join('')}</div>
    <div><div class="layers">${layerDefs.map(([k, t, c]) => `<label><input type="checkbox" data-layer="${k}" ${v.layers[k] ? 'checked' : ''}><i style="background:${c}"></i>${t}</label>`).join('')}<span class="spacer"></span><span class="sub">${esc(s.mediaName || '')}${s.backprint ? $t(' · Rückseitendruck: ', ' · back printing: ') + esc(s.backprint) : ''}</span></div>
    <div class="stage" id="stage"><div class="sheetwrap" id="sheet"><canvas id="cv"></canvas><svg id="ov"></svg></div></div>
    <div class="sub" style="margin-top:6px">${s.overlay.feed ? $t('Vorschubrichtung: nach oben (Vorderkante oben). ', 'Feed direction: upwards (leading edge at the top). ') : ''}${s.side === 'back' ? $t('Rückseite – so gesehen, wie sie gedruckt wird. ', 'Back – seen as it is printed. ') : ''}${s.tumble ? $t('Wenden an kurzer Kante. ', 'Tumble on short edge. ') : ''}${$t('Linke Maustaste auf Linien zeigt Details.', 'Left-click on lines shows details.')}</div></div></div>`;
  $$('[data-surf]', body).forEach((b) => b.onclick = () => { v.surface = Number(b.dataset.surf); renderViewer(j, body); });
  $$('[data-layer]', body).forEach((c) => c.onchange = () => { v.layers[c.dataset.layer] = c.checked; drawOverlay(s); $('#cv').style.visibility = v.layers.print ? 'visible' : 'hidden'; });
  const stage = $('#stage');
  const maxW = stage.clientWidth - 40, maxH = Math.max(320, window.innerHeight - stage.getBoundingClientRect().top - 70);
  const scale = Math.min(maxW / s.wPt, maxH / s.hPt, 3);
  const sheet = $('#sheet');
  sheet.style.width = s.wPt * scale + 'px';
  sheet.style.height = s.hPt * scale + 'px';
  $('#cv').style.visibility = v.layers.print ? 'visible' : 'hidden';
  drawOverlay(s);
  (async () => {
    try {
      const pdf = await getPdf(`/api/jobs/${j.id}/files/ausgabe.pdf?v=${encodeURIComponent(j.updated)}`);
      const page = await pdf.getPage(v.surface + 1);
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: scale * dpr });
      const cv = $('#cv');
      if (!cv) return;
      cv.width = vp.width; cv.height = vp.height;
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, canvas: cv }).promise;
    } catch (e) { console.warn(e); }
  })();
}

function drawOverlay(s) {
  const L = S.viewer.layers;
  const H = s.hPt;
  const Y = (y) => H - y;
  const o = s.overlay;
  const parts = [];
  const sw = Math.max(s.wPt, s.hPt) / 600;
  if (L.waste) for (const a of o.areas) parts.push(`<rect x="${a.x}" y="${Y(a.y + a.h)}" width="${a.w}" height="${a.h}" fill="${a.kind === 'overspill' ? 'none' : a.kind === 'waste' ? 'rgba(120,120,120,.28)' : 'rgba(160,160,160,.25)'}" ${a.kind === 'overspill' ? `stroke="#f08c00" stroke-dasharray="${sw * 4}" stroke-width="${sw}"` : ''}><title>${esc(a.label || (a.kind === 'unprintable' ? $t('nicht bedruckbar', 'non-printable') : a.kind))}</title></rect>`);
  if (L.place) for (const p of s.placements) parts.push(`<rect x="${p.rect.x}" y="${Y(p.rect.y + p.rect.h)}" width="${p.rect.w}" height="${p.rect.h}" fill="${p.page < 0 ? 'rgba(0,160,180,.06)' : 'none'}" stroke="#0aa" stroke-width="${sw * 0.8}" stroke-dasharray="${sw * 3}"><title>${esc(p.label || '')}${p.rot ? $t(' · gedreht ', ' · rotated ') + p.rot + '°' : ''}${p.scale && Math.abs(p.scale - 1) > 0.001 ? ' · ' + Math.round(p.scale * 1000) / 10 + ' %' : ''}</title></rect>` + (p.label ? `<text x="${p.rect.x + sw * 4}" y="${Y(p.rect.y + p.rect.h) + sw * 14}" font-size="${sw * 11}" fill="#078" font-family="sans-serif">${esc(p.label)}</text>` : ''));
  if (L.cut) {
    for (const c of o.cuts) parts.push(`<line x1="${c.x1}" y1="${Y(c.y1)}" x2="${c.x2}" y2="${Y(c.y2)}" stroke="${c.kind === 'face-trim' ? '#f08c00' : '#dc1f26'}" stroke-width="${sw * (c.kind === 'guillotine' ? 1 : 1.8)}" ${c.kind === 'face-trim' ? `stroke-dasharray="${sw * 6}"` : ''}><title>${esc({ guillotine: $t('Schneidemaschine', 'Guillotine'), 'roll-cut': $t('Querschnitt (Rolle)', 'Cross cut (roll)'), 'sheet-cut': $t('Querschnitt am Jobende', 'Cross cut at job end'), 'face-trim': $t('Frontbeschnitt', 'Face trim') }[c.kind] || c.kind)}${c.n ? ' #' + c.n : ''}</title></line>`);
    for (const c of o.cutPaths) {
      const d = c.subpaths.map((sp) => sp.map((q) => (q.op === 'M' ? `M${q.x} ${Y(q.y)}` : q.op === 'L' ? `L${q.x} ${Y(q.y)}` : q.op === 'C' ? `C${q.x1} ${Y(q.y1)} ${q.x2} ${Y(q.y2)} ${q.x} ${Y(q.y)}` : 'Z')).join(' ')).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="#dc1f26" stroke-width="${sw * 1.6}" ${c.kind === 'perf' ? `stroke-dasharray="${sw * 5} ${sw * 3}"` : ''}><title>${esc(c.name)} ${$t('· Schnitt', '· cut')} ${c.n} · ${esc(c.item || '')}</title></path>`);
    }
  }
  if (L.fold) for (const f of o.folds) parts.push(`<line x1="${f.x1}" y1="${Y(f.y1)}" x2="${f.x2}" y2="${Y(f.y2)}" stroke="#1a5ae6" stroke-width="${sw * 1.6}" stroke-dasharray="${f.kind === 'mountain' ? `${sw * 10} ${sw * 3} ${sw * 2} ${sw * 3}` : `${sw * 7} ${sw * 4}`}"><title>${f.kind === 'mountain' ? $t('Bergfalz', 'Mountain fold') : $t('Talfalz', 'Valley fold')} ${f.n || ''} ${esc(f.label || '')}</title></line>`);
  if (L.staple) {
    for (const st of o.staples) { const a = st.angle * Math.PI / 180, hx = Math.cos(a) * st.len / 2, hy = Math.sin(a) * st.len / 2; parts.push(`<line x1="${st.x - hx}" y1="${Y(st.y - hy)}" x2="${st.x + hx}" y2="${Y(st.y + hy)}" stroke="#0b7334" stroke-width="${sw * 4}" stroke-linecap="round"><title>${$t('Heftklammer', 'Staple')}</title></line>`); }
    for (const ho of o.holes) parts.push(`<circle cx="${ho.x}" cy="${Y(ho.y)}" r="${ho.r}" fill="#fde" stroke="#b0a" stroke-width="${sw}"><title>${$t('Lochung Ø 6 mm', 'Punch hole Ø 6 mm')}</title></circle>`);
  }
  const svg = $('#ov');
  if (!svg) return;
  svg.setAttribute('viewBox', `0 0 ${s.wPt} ${s.hPt}`);
  svg.innerHTML = parts.join('');
}

// ------------------------------------------------------------------ Weitere Seiten
function renderAllJobs() {
  setNav('/jobs');
  $('#main').innerHTML = `<h1>${$t('Alle Jobs', 'All jobs')}</h1><div class="sub" style="margin-bottom:12px">${$t('Die letzten', 'The last')} ${S.jobs.length} ${$t('Jobs aller Geräte', 'jobs of all devices')}</div>${jobRows(S.jobs, true)}`;
  $$('[data-job]').forEach((tr) => tr.onclick = () => (location.hash = '#/job/' + tr.dataset.job));
}

function renderMedia() {
  setNav('/media');
  const m = S.state.media;
  $('#main').innerHTML = `<h1>${$t('Materialkatalog', 'Media catalogue')}</h1><div class="sub">${$t('Materialien, die den Geräten zugewiesen werden können. Werte sind frei änderbar.', 'Media that can be assigned to the devices. Values can be changed freely.')}</div>
    <div class="card" style="margin:14px 0"><b>${$t('Material hinzufügen / ändern', 'Add / change media')}</b><div class="form" style="margin-top:8px">
      <label>ID<input type="text" id="mid" placeholder="${$t('z. B. gloss-170-sra3', 'e.g. gloss-170-sra3')}"></label><label>Name<input type="text" id="mname"></label>
      <label>${$t('Art', 'Kind')}<select id="mkind"><option value="sheet">${$t('Bogen', 'Sheet')}</option><option value="roll">${$t('Rolle', 'Roll')}</option></select></label>
      <label>${$t('Breite mm', 'Width mm')}<input type="number" id="mw"></label><label>${$t('Höhe mm (Bogen)', 'Height mm (sheet)')}<input type="number" id="mh"></label><label>${$t('Länge m (Rolle)', 'Length m (roll)')}<input type="number" id="ml"></label>
      <label>g/m²<input type="number" id="mg"></label><label>${$t('Typ', 'Type')}<input type="text" id="mt" placeholder="coated-glossy, bond, vinyl …"></label><label>IPP media-type<input type="text" id="mi" placeholder="stationery-coated"></label>
    </div><button class="primary" id="msave" style="margin-top:10px">${$t('Speichern', 'Save')}</button></div>
    <table><tr><th>ID</th><th>Name</th><th>${$t('Art', 'Kind')}</th><th>${$t('Maße', 'Dimensions')}</th><th>g/m²</th><th>${$t('Typ', 'Type')}</th><th></th></tr>${m.map((x) => `<tr><td class="mono">${esc(x.id)}</td><td>${esc(x.name)}</td><td>${x.kind === 'roll' ? $t('Rolle', 'Roll') : $t('Bogen', 'Sheet')}</td><td class="mono">${x.kind === 'roll' ? `${x.widthMm} mm × ${x.lengthM} m` : `${x.widthMm} × ${x.heightMm} mm`}</td><td class="num">${x.gsm}</td><td>${esc(x.type)} <span class="sub mono">${esc(x.ippType || '')}</span></td><td><button class="small" data-edit="${esc(x.id)}${$t('">bearbeiten', '">edit')}</button> <button class="small danger" data-delm="${esc(x.id)}">×</button></td></tr>`).join('')}</table>`;
  $('#msave').onclick = () => act(() => api('/api/media', { json: { id: $('#mid').value.trim(), name: $('#mname').value.trim(), kind: $('#mkind').value, widthMm: $('#mw').value, heightMm: $('#mh').value || undefined, lengthM: $('#ml').value || undefined, gsm: $('#mg').value, type: $('#mt').value, ippType: $('#mi').value || 'stationery' } }).then(async () => { await loadState(); renderMedia(); }), $t('Gespeichert', 'Saved'));
  $$('[data-edit]').forEach((b) => b.onclick = () => { const x = mediaById(b.dataset.edit); $('#mid').value = x.id; $('#mname').value = x.name; $('#mkind').value = x.kind; $('#mw').value = x.widthMm; $('#mh').value = x.heightMm || ''; $('#ml').value = x.lengthM || ''; $('#mg').value = x.gsm; $('#mt').value = x.type; $('#mi').value = x.ippType || ''; window.scrollTo(0, 0); });
  $$('[data-delm]').forEach((b) => b.onclick = () => confirm($t('Material löschen?', 'Delete media?')) && act(() => api('/api/media/' + b.dataset.delm, { method: 'DELETE' }).then(async () => { await loadState(); renderMedia(); })));
}

async function renderLog() {
  setNav('/log');
  const list = await api('/api/log');
  $('#main').innerHTML = `<h1>${$t('Ereignisse', 'Events')}</h1><div class="log" style="margin-top:12px">${list.slice().reverse().map((e) => `<div class="e ${e.level}"><span class="ts">${fmtTime(e.ts)}</span><span class="ph">${esc(e.deviceId ? dev(e.deviceId)?.name || e.deviceId : 'System')}</span><span>${esc(e.msg)}</span></div>`).join('')}</div>`;
}

function settingsDialog() {
  const s = S.state.settings;
  const d = $('#dlg');
  d.innerHTML = `<h2 style="margin-top:0">${$t('Einstellungen', 'Settings')}</h2><div class="form" style="grid-template-columns:1fr">
    <label>${$t('Adresse der Geräte-Schnittstellen', 'Address of the device interfaces')}<select id="sbind"><option value="127.0.0.1" ${s.bindHost === '127.0.0.1' ? 'selected' : ''}${$t('>127.0.0.1 – nur dieser Rechner', '>127.0.0.1 – this computer only')}</option><option value="0.0.0.0" ${s.bindHost === '0.0.0.0' ? 'selected' : ''}${$t('>0.0.0.0 – im Netzwerk erreichbar', '>0.0.0.0 – reachable on the network')}</option></select></label>
    <label>${$t('Adressierung der Geräte', 'Device addressing')}<select id="saddr"><option value="ports" ${s.addressing !== 'ip' ? 'selected' : ''}${$t('>Eine IP (127.0.0.1), Geräte über eigene Ports', '>One IP (127.0.0.1), devices on their own ports')}</option><option value="ip" ${s.addressing === 'ip' ? 'selected' : ''}${$t('>Jedes Gerät eigene IP (127.0.0.11 …) mit Standardports 631/80/515/9100 + SNMP 161', '>Every device its own IP (127.0.0.11 …) with standard ports 631/80/515/9100 + SNMP 161')}</option></select></label>
    <div class="sub" style="font-size:12px">${$t('„Eigene IP" brauchen Apps, die nur die IP kennen und IPP/SNMP auf den Standardports abfragen. Benötigt Root bzw. CAP_NET_BIND_SERVICE (Dienst: sudo ./install.sh --service --eigene-ips). Danach Systemdrucker neu einrichten.', '“Own IP” is needed by apps that only know the IP and query IPP/SNMP on the standard ports. Needs root or CAP_NET_BIND_SERVICE (service: sudo ./install.sh --service --eigene-ips). Afterwards re-register the system printers.')}</div>
    <label class="chk"><input type="checkbox" id="smdns" ${s.mdns !== false ? 'checked' : ''}${$t('> Geräte per Bonjour/mDNS im Netzwerk ankündigen', '> Announce devices on the network via Bonjour/mDNS')}</label>
    <label>${$t('Angezeigte Adresse bei 0.0.0.0 (z. B. LAN-IP)', 'Displayed address with 0.0.0.0 (e.g. LAN IP)')}<input type="text" id="spub" value="${esc(s.publicHost || '')}"></label>
    <label>${$t('Ghostscript (für PostScript), leer = automatisch', 'Ghostscript (for PostScript), empty = automatic')}<input type="text" id="sgs" value="${esc(s.ghostscript || '')}" placeholder="${$t('gs bzw. C:\\Program Files\\gs\\…\\gswin64c.exe', 'gs or C:\\Program Files\\gs\\…\\gswin64c.exe')}"></label>
    <label>${$t('Max. gespeicherte Jobs', 'Max. stored jobs')}<input type="number" id="skeep" value="${s.keepJobs}"></label></div>
    <div class="row" style="margin-top:14px"><button class="primary" id="ssave">${$t('Speichern', 'Save')}</button><button id="sclose">${$t('Schließen', 'Close')}</button><span class="spacer"></span><button class="danger" id="sreset">${$t('Maschinenpark zurücksetzen', 'Reset machine park')}</button></div>`;
  d.showModal();
  $('#sclose').onclick = () => d.close();
  $('#ssave').onclick = async () => { await act(() => api('/api/settings', { method: 'PUT', json: { addressing: $('#saddr').value, mdns: $('#smdns').checked, bindHost: $('#sbind').value, publicHost: $('#spub').value.trim(), ghostscript: $('#sgs').value.trim(), keepJobs: Number($('#skeep').value) } }), $t('Gespeichert', 'Saved')); await loadState(); d.close(); route(); };
  $('#sreset').onclick = async () => { if (!confirm($t('Geräte und Materialkatalog auf Standard zurücksetzen? (Jobs bleiben erhalten, Neustart nötig)', 'Reset devices and media catalogue to the defaults? (Jobs are kept, restart required)'))) return; await act(() => api('/api/reset', { method: 'POST' }), $t('Zurückgesetzt – bitte Anwendung neu starten', 'Reset – please restart the application')); d.close(); };
}

// ------------------------------------------------------------------ Routing
function setNav(r) { $$('header nav a').forEach((a) => a.classList.toggle('act', a.getAttribute('href') === '#' + r)); }
async function route() {
  const r = (location.hash || '#/').slice(1);
  S.route = r;
  if (window.__tab) { S.tab.device = window.__tab; window.__tab = null; }
  renderSide();
  if (r === '/' || r === '') return renderOverview();
  if (r === '/jobs') return renderAllJobs();
  if (r === '/media') return renderMedia();
  if (r === '/log') return renderLog();
  if (r.startsWith('/device/')) return renderDevice(r.split('/')[2]);
  if (r.startsWith('/job/')) { await loadJob(r.split('/')[2]); return renderJob(); }
  renderOverview();
}

$('#timeFactor').onchange = (e) => act(() => api('/api/settings', { method: 'PUT', json: { timeFactor: Number(e.target.value) } }), $t('Zeitraffer geändert', 'Time lapse changed'));
$('#btnSettings').onclick = settingsDialog;
$('#btnLang').onclick = async () => {
  const l = LANG === 'en' ? 'de' : 'en';
  sessionStorage.removeItem('vpf-reloaded');
  await act(() => api('/api/settings', { method: 'PUT', json: { lang: l } }));
  switchLang(l);
};
$('#btnControl').onclick = async () => {
  const url = 'http://127.0.0.1:8649/';
  try { await fetch(url + 'api/ping', { mode: 'no-cors', signal: AbortSignal.timeout(1200) }); window.open(url, 'vpf-control'); }
  catch { toast($t('Steuerzentrale läuft nicht – über das Startmenü „Virtual Print Fleet“ oder im Terminal mit „vpf steuerung“ starten.', 'Control centre is not running – start it from the “Virtual Print Fleet” menu entry or with “vpf control” in a terminal.'), true); }
};
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { if (S.route.startsWith('/job/') && (S.tab.job || 'view') === 'view') renderJob(true); });
(async () => {
  applyStatic();
  try { await loadState(); connect(); route(); } catch (e) { $('#main').innerHTML = `<div class="note err">${$t('Server nicht erreichbar:', 'Server not reachable:')} ${esc(e.message)}</div>`; }
})();
