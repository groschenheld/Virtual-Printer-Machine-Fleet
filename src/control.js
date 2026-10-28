'use strict';
/**
 * Steuerzentrale / Control centre
 *
 * Kleines Fenster (im Browser, App-Modus) zum Ein-/Ausschalten der Simulation, zum Beenden,
 * zum Ein-/Ausschalten einzelner Drucker und zum direkten Öffnen der Druckerseiten.
 * Läuft als eigener Prozess auf 127.0.0.1:8649 – auch wenn die Simulation aus ist.
 *
 * Small window (browser app mode) to switch the simulation on/off, quit, switch single printers
 * on/off and open the printer pages directly. Runs as its own process on 127.0.0.1:8649 –
 * also while the simulation is off.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { $t, setLang, getLang } = require('./i18n');
const { defaultDataDir } = require('./core/store');

const NAME = 'virtual-print-fleet';
const APP_DIR = path.resolve(__dirname, '..');
const CLI = path.join(APP_DIR, 'src', 'cli.js');
const DEFAULT_PORT = 8649;

const dataDir = () => (process.env.VPF_DATA ? path.resolve(process.env.VPF_DATA) : defaultDataDir());
function readSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), 'settings.json'), 'utf8')); } catch { return {}; }
}
function writeSetting(k, v) {
  const s = readSettings();
  s[k] = v;
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(path.join(dataDir(), 'settings.json'), JSON.stringify(s, null, 2));
}
const simUrl = () => `http://127.0.0.1:${readSettings().uiPort || 8650}`;

async function simFetch(p, opts = {}) {
  const r = await fetch(simUrl() + p, { ...opts, signal: AbortSignal.timeout(opts.timeout || 3000) });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || r.statusText);
  return data;
}
async function simRunning() {
  try { await simFetch('/api/system', { timeout: 1500 }); return true; } catch { return false; }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 60000, env: { ...process.env, LC_ALL: 'C' } }, (err, out, errOut) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(out || ''), err: String(errOut || (err && err.message) || '') });
    });
  });
}
const which = (cmd) => (process.env.PATH || '').split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });

/** Wie wird die Simulation betrieben? system = systemd-Systemdienst, user = Benutzerdienst, process = eigener Prozess. */
function runMode() {
  if (process.platform !== 'linux' || !which('systemctl')) return 'process';
  if (fs.existsSync(`/etc/systemd/system/${NAME}.service`)) return 'system';
  const u = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', `${NAME}.service`);
  if (fs.existsSync(u)) return 'user';
  return 'process';
}

async function systemctl(action) {
  const mode = runMode();
  if (mode === 'user') {
    const r = await run('systemctl', ['--user', action, `${NAME}.service`]);
    if (!r.ok) throw new Error(`systemctl --user ${action}: ${r.err.trim()}`);
    return;
  }
  // Systemdienst: erlaubt über die Polkit-Regel des Installers, sonst grafische Passwortabfrage (pkexec)
  let r = await run('systemctl', ['--no-ask-password', action, `${NAME}.service`]);
  if (!r.ok && which('pkexec')) r = await run('pkexec', ['systemctl', action, `${NAME}.service`], { timeout: 120000 });
  if (!r.ok) throw new Error($t(`Systemdienst konnte nicht ${action === 'stop' ? 'gestoppt' : 'gestartet'} werden – im Terminal: sudo systemctl ${action} ${NAME}`, `Could not ${action} the system service – in a terminal: sudo systemctl ${action} ${NAME}`) + (r.err.trim() ? ` (${r.err.trim().split('\n')[0]})` : ''));
}

let child = null;
const logFile = () => path.join(dataDir(), 'simulation.log');
function logTail(n = 12) {
  try { return fs.readFileSync(logFile(), 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; }
}

async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 400)); }
  return false;
}

async function startSim() {
  if (await simRunning()) return;
  const mode = runMode();
  if (mode !== 'process') await systemctl('start');
  else {
    fs.mkdirSync(dataDir(), { recursive: true });
    const out = fs.openSync(logFile(), 'a');
    fs.writeSync(out, `\n----- ${new Date().toISOString()} start (control centre) -----\n`);
    child = spawn(process.execPath, [CLI], { cwd: APP_DIR, detached: true, stdio: ['ignore', out, out], env: { ...process.env, VPF_CONTROL: '1' }, windowsHide: true });
    child.unref();
    child.on('exit', () => { child = null; });
  }
  if (!(await waitFor(simRunning, 20000))) {
    const tail = mode === 'process' ? logTail() : (await run('journalctl', [...(mode === 'user' ? ['--user'] : []), '-u', `${NAME}.service`, '-n', '12', '--no-pager'])).out.trim();
    throw new Error($t('Simulation startet nicht.', 'Simulation does not start.') + (tail ? '\n' + tail : ''));
  }
}

async function stopSim() {
  if (!(await simRunning())) return;
  const mode = runMode();
  if (mode !== 'process') await systemctl('stop');
  else { try { await simFetch('/api/quit', { method: 'POST' }); } catch { /* beendet sich gerade */ } }
  if (!(await waitFor(async () => !(await simRunning()), 15000))) throw new Error($t('Simulation reagiert nicht auf Beenden.', 'Simulation does not respond to quit.'));
}

async function status() {
  const s = readSettings();
  if (s.lang) setLang(s.lang);
  const base = { running: false, mode: runMode(), lang: getLang(), url: simUrl(), devices: [] };
  try {
    const st = await simFetch('/api/state');
    if (st.lang) setLang(st.lang);
    return {
      ...base, running: true, lang: getLang(), addressing: st.settings.addressing,
      devices: st.devices.map((d) => ({
        id: d.id, name: d.name, kind: d.kind, vendor: d.vendor, frontend: d.frontend && (d.frontend.label || d.frontend.product),
        enabled: d.enabled !== false, state: d.status && d.status.state, stateText: d.status && (d.status.stateDe || d.status.state),
        message: d.status && d.status.message, web: d.endpoints && d.endpoints.web, ipp: d.endpoints && d.endpoints.ipp,
        errors: Object.entries(d.ifaces || {}).filter(([, v]) => v && v.error).map(([k, v]) => `${k}: ${v.error}`),
      })),
    };
  } catch { return base; }
}

// ---------------------------------------------------------------- HTTP
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(b);
}
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

function serve(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, app: 'vpf-control' });
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, await status());
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      // Schutz gegen fremde Webseiten: nur Anfragen mit eigenem Header (erzwingt CORS-Preflight)
      if (req.headers['x-vpf'] !== '1') return send(res, 403, { error: 'forbidden' });
      const b = await readBody(req);
      if (url.pathname === '/api/start') { await startSim(); return send(res, 200, await status()); }
      if (url.pathname === '/api/stop') { await stopSim(); return send(res, 200, await status()); }
      if (url.pathname === '/api/restart') { await stopSim(); await startSim(); return send(res, 200, await status()); }
      if (url.pathname === '/api/lang') {
        const l = b.lang === 'en' ? 'en' : 'de';
        setLang(l);
        if (await simRunning()) await simFetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) });
        else writeSetting('lang', l);
        return send(res, 200, await status());
      }
      let m;
      if ((m = /^\/api\/device\/([\w-]+)\/power$/.exec(url.pathname))) {
        await simFetch(`/api/devices/${encodeURIComponent(m[1])}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!b.on }) });
        return send(res, 200, await status());
      }
      if (url.pathname === '/api/all-power') {
        const st = await simFetch('/api/state');
        for (const d of st.devices) if ((d.enabled !== false) !== !!b.on) await simFetch(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!b.on }) });
        return send(res, 200, await status());
      }
      if (url.pathname === '/api/quit') {
        if (b.stopSimulation !== false) await stopSim();
        send(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 200);
        return;
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 500, { error: e.message }); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function controlRunning(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1000) }); return r.ok && (await r.json()).app === 'vpf-control'; } catch { return false; }
}

/** Fenster öffnen – möglichst als eigenes App-Fenster (Chromium/Chrome/Edge --app), sonst Standardbrowser. */
function openWindow(url) {
  const tries = process.platform === 'win32'
    ? [['cmd', ['/c', 'start', '', 'msedge', `--app=${url}`, '--window-size=980,760']], ['cmd', ['/c', 'start', '', url]]]
    : process.platform === 'darwin'
      ? [['open', ['-na', 'Google Chrome', '--args', `--app=${url}`, '--window-size=980,760']], ['open', [url]]]
      : [...['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'brave-browser'].filter(which).map((b) => [b, [`--app=${url}`, '--window-size=980,760', '--class=virtual-print-fleet']]), ['xdg-open', [url]]];
  const attempt = (i) => {
    if (i >= tries.length) { console.log($t(`Bitte im Browser öffnen: ${url}`, `Please open in the browser: ${url}`)); return; }
    try {
      const c = spawn(tries[i][0], tries[i][1], { detached: true, stdio: 'ignore', windowsHide: true });
      c.on('error', () => attempt(i + 1));
      c.unref();
    } catch { attempt(i + 1); }
  };
  attempt(0);
}

/** `vpf steuerung` / `vpf control`: Steuerzentrale starten (falls nötig) und Fenster öffnen. */
async function launch(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}/`;
  if (!(await controlRunning(port))) {
    fs.mkdirSync(dataDir(), { recursive: true });
    const out = fs.openSync(path.join(dataDir(), 'control.log'), 'a');
    const c = spawn(process.execPath, [CLI, 'control-serve', '--control-port', String(port)], { cwd: APP_DIR, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    c.unref();
    if (!(await waitFor(() => controlRunning(port), 8000))) throw new Error($t('Steuerzentrale startet nicht – siehe ', 'Control centre does not start – see ') + path.join(dataDir(), 'control.log'));
  }
  console.log($t(`Steuerzentrale: ${url}`, `Control centre: ${url}`));
  if (opts.open !== false) { openWindow(url); await new Promise((r) => setTimeout(r, 800)); }
}

// ---------------------------------------------------------------- Seite / page
const PAGE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Virtual Print Fleet – Steuerung</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='4' y='11' width='24' height='13' rx='2' fill='%23e8590c'/%3E%3Crect x='9' y='4' width='14' height='8' fill='%23333'/%3E%3Crect x='9' y='20' width='14' height='8' fill='%23fff' stroke='%23333'/%3E%3C/svg%3E">
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#1d2330;--muted:#6b7280;--line:#e3e6ea;--accent:#e8590c;--ok:#1e8e3e;--warn:#b26a00;--err:#d93025;--off:#9aa0a6}
@media (prefers-color-scheme:dark){:root{--bg:#15181d;--card:#1e232b;--ink:#e8eaed;--muted:#9aa0a6;--line:#2e3540;--off:#5f6368}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
.logo{width:22px;height:22px;border-radius:5px;background:var(--accent);box-shadow:inset 0 -7px 0 #333}
h1{font-size:16px;margin:0;font-weight:650}h1 small{display:block;font-size:11px;color:var(--muted);font-weight:400}
.sp{flex:1}.lang{display:flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}.lang button{border:0;border-radius:0;padding:5px 10px;background:transparent}.lang button.on{background:var(--accent);color:#fff}
main{max-width:980px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.hero{display:flex;flex-wrap:wrap;align-items:center;gap:14px}
.dot{width:14px;height:14px;border-radius:50%;background:var(--off);flex:none}.dot.on{background:var(--ok);box-shadow:0 0 0 4px rgba(30,142,62,.15)}
.big{font-size:18px;font-weight:650}.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:7px;padding:7px 12px}
button:hover{border-color:var(--accent)}button.p{background:var(--accent);border-color:var(--accent);color:#fff}button.d{color:var(--err)}
button:disabled{opacity:.5;cursor:default}.btns{display:flex;flex-wrap:wrap;gap:8px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:12px;color:var(--muted);font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;background:var(--line)}.pill.idle{background:#e6f4ea;color:var(--ok)}.pill.processing{background:#e8f0fe;color:#1a56c8}.pill.stopped{background:#fce8e6;color:var(--err)}.pill.off{background:var(--line);color:var(--muted)}
@media (prefers-color-scheme:dark){.pill.idle{background:#1e3a26}.pill.processing{background:#1d2c4d}.pill.stopped{background:#4a2321}}
.sw{position:relative;width:42px;height:24px;flex:none;display:inline-block}.sw input{opacity:0;width:0;height:0}.sw span{position:absolute;inset:0;border-radius:12px;background:var(--off);transition:.15s;cursor:pointer}.sw span:before{content:"";position:absolute;width:18px;height:18px;left:3px;top:3px;border-radius:50%;background:#fff;transition:.15s}.sw input:checked+span{background:var(--ok)}.sw input:checked+span:before{transform:translateX(18px)}
.err{color:var(--err);white-space:pre-wrap}.note{font-size:12px;color:var(--muted);margin-top:8px}
#msg{position:fixed;right:16px;bottom:16px;max-width:520px}#msg div{background:#323232;color:#fff;padding:10px 14px;border-radius:8px;margin-top:8px;white-space:pre-wrap}#msg div.e{background:var(--err)}
.busy{position:fixed;inset:0;background:rgba(0,0,0,.08);display:none;cursor:progress}.busy.on{display:block}
@media (max-width:640px){.hide-s{display:none}}
</style></head><body>
<header><div class="logo"></div><h1>Virtual Print Fleet<small id="sub"></small></h1><div class="sp"></div>
<div class="lang"><button data-l="de">DE</button><button data-l="en">EN</button></div></header>
<main>
<section class="card"><div class="hero"><span class="dot" id="dot"></span><div><div class="big" id="state"></div><div class="muted" id="info"></div></div><div class="sp"></div>
<div class="btns"><button class="p" id="bStart"></button><button id="bStop"></button><button id="bRestart"></button><button id="bUi"></button><button class="d" id="bQuit"></button></div></div>
<div class="err" id="err"></div></section>
<section class="card"><div class="hero" style="margin-bottom:6px"><b id="tPrinters"></b><div class="sp"></div><div class="btns"><button id="bAllOn"></button><button id="bAllOff"></button></div></div>
<table><thead><tr><th style="width:56px" id="thPower"></th><th id="thPrinter"></th><th class="hide-s" id="thFe"></th><th id="thState"></th><th></th></tr></thead><tbody id="list"></tbody></table>
<div class="note" id="note"></div></section>
</main><div id="msg"></div><div class="busy" id="busy"></div>
<script>
const T = {
  de: { sub: 'Steuerzentrale', on: 'Simulation läuft', off: 'Simulation ist aus', start: 'Einschalten', stop: 'Ausschalten', restart: 'Neu starten', ui: 'Oberfläche öffnen', quit: 'Programm beenden',
    printers: 'Drucker', allOn: 'Alle ein', allOff: 'Alle aus', power: 'Ein/Aus', printer: 'Drucker', fe: 'Druckserver / RIP', state: 'Zustand', page: 'Druckerseite', sim: 'In der Simulation', offState: 'aus',
    mode: { system: 'Systemdienst', user: 'Benutzerdienst', process: 'eigener Prozess' }, modeL: 'Betrieb', noSim: 'Zum Bedienen der Drucker die Simulation einschalten.',
    note: 'Ausgeschaltete Drucker antworten nicht mehr auf IPP, LPD, Socket und SNMP – wie ein echtes Gerät ohne Strom. „Druckerseite“ öffnet die Webseite des Geräts bzw. Druckservers (Fiery WebTools, PRISMAsync, Epson Web Config …).',
    quitAsk: 'Simulation und Steuerzentrale beenden?', bye: 'Virtual Print Fleet wurde beendet. Dieses Fenster kann geschlossen werden.', ifErr: 'Schnittstellen-Fehler', starting: 'Starte …', stopping: 'Stoppe …' },
  en: { sub: 'Control centre', on: 'Simulation running', off: 'Simulation is off', start: 'Switch on', stop: 'Switch off', restart: 'Restart', ui: 'Open interface', quit: 'Quit program',
    printers: 'Printers', allOn: 'All on', allOff: 'All off', power: 'On/off', printer: 'Printer', fe: 'Print server / RIP', state: 'State', page: 'Printer page', sim: 'In the simulation', offState: 'off',
    mode: { system: 'system service', user: 'user service', process: 'own process' }, modeL: 'Mode', noSim: 'Switch the simulation on to operate the printers.',
    note: 'Printers that are switched off no longer answer IPP, LPD, socket and SNMP – like a real device without power. “Printer page” opens the web page of the device or print server (Fiery WebTools, PRISMAsync, Epson Web Config …).',
    quitAsk: 'Quit simulation and control centre?', bye: 'Virtual Print Fleet has been shut down. You can close this window.', ifErr: 'Interface errors', starting: 'Starting …', stopping: 'Stopping …' },
};
let S = { lang: 'de', running: false, devices: [] };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = () => T[S.lang] || T.de;
function msg(text, err) { const d = document.createElement('div'); d.textContent = text; if (err) d.className = 'e'; $('#msg').appendChild(d); setTimeout(() => d.remove(), err ? 9000 : 3000); }
async function post(p, body) {
  $('#busy').classList.add('on');
  try {
    const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VPF': '1' }, body: JSON.stringify(body || {}) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    if (d.devices) { S = d; render(); }
    return d;
  } catch (e) { msg(e.message, true); } finally { $('#busy').classList.remove('on'); }
}
function render() {
  const L = t();
  document.documentElement.lang = S.lang;
  document.title = 'Virtual Print Fleet – ' + L.sub;
  document.querySelectorAll('.lang button').forEach((b) => b.classList.toggle('on', b.dataset.l === S.lang));
  $('#sub').textContent = L.sub;
  $('#dot').classList.toggle('on', S.running);
  $('#state').textContent = S.running ? L.on : L.off;
  $('#info').innerHTML = (S.running ? '<span class="mono">' + esc(S.url) + '</span> · ' : '') + L.modeL + ': ' + esc(L.mode[S.mode] || S.mode);
  [['#bStart', 'start'], ['#bStop', 'stop'], ['#bRestart', 'restart'], ['#bUi', 'ui'], ['#bQuit', 'quit'], ['#bAllOn', 'allOn'], ['#bAllOff', 'allOff'], ['#thPower', 'power'], ['#thPrinter', 'printer'], ['#thFe', 'fe'], ['#thState', 'state'], ['#tPrinters', 'printers']].forEach(([s, k]) => { $(s).textContent = L[k]; });
  $('#bStart').disabled = S.running; $('#bStop').disabled = !S.running; $('#bRestart').disabled = !S.running; $('#bUi').disabled = !S.running;
  $('#bAllOn').disabled = !S.running; $('#bAllOff').disabled = !S.running;
  $('#note').textContent = S.running ? L.note : L.noSim;
  $('#list').innerHTML = S.devices.map((d) => {
    const st = d.enabled ? d.state : 'off';
    return '<tr><td><label class="sw"><input type="checkbox" data-pw="' + esc(d.id) + '"' + (d.enabled ? ' checked' : '') + '><span></span></label></td>' +
      '<td><b>' + esc(d.name) + '</b><div class="mono muted">' + esc(d.ipp || '') + '</div>' + (d.errors && d.errors.length ? '<div class="err" style="font-size:12px">' + esc(L.ifErr + ': ' + d.errors.join('; ')) + '</div>' : '') + '</td>' +
      '<td class="hide-s">' + esc(d.frontend || '') + '</td>' +
      '<td><span class="pill ' + esc(st) + '">' + esc(d.enabled ? d.stateText : L.offState) + '</span>' + (d.enabled && d.message && d.message !== d.stateText ? '<div class="muted" style="font-size:12px">' + esc(d.message) + '</div>' : '') + '</td>' +
      '<td style="white-space:nowrap;text-align:right"><button data-web="' + esc(d.web || '') + '"' + (d.enabled && d.web ? '' : ' disabled') + '>' + L.page + ' ↗</button> <button data-sim="' + esc(d.id) + '">' + L.sim + ' ↗</button></td></tr>';
  }).join('');
  document.querySelectorAll('[data-pw]').forEach((el) => { el.onchange = () => post('/api/device/' + encodeURIComponent(el.dataset.pw) + '/power', { on: el.checked }); });
  document.querySelectorAll('[data-web]').forEach((el) => { el.onclick = () => window.open(el.dataset.web, '_blank'); });
  document.querySelectorAll('[data-sim]').forEach((el) => { el.onclick = () => window.open(S.url + '/#/device/' + encodeURIComponent(el.dataset.sim), 'vpf-ui'); });
}
async function refresh() {
  try { const r = await fetch('/api/status'); S = await r.json(); render(); } catch { /* Steuerzentrale beendet */ }
}
$('#bStart').onclick = () => { $('#state').textContent = t().starting; post('/api/start'); };
$('#bStop').onclick = () => { $('#state').textContent = t().stopping; post('/api/stop'); };
$('#bRestart').onclick = () => { $('#state').textContent = t().starting; post('/api/restart'); };
$('#bUi').onclick = () => window.open(S.url + '/', 'vpf-ui');
$('#bAllOn').onclick = () => post('/api/all-power', { on: true });
$('#bAllOff').onclick = () => post('/api/all-power', { on: false });
$('#bQuit').onclick = async () => {
  if (!confirm(t().quitAsk)) return;
  const L = t();
  await post('/api/quit', { stopSimulation: true });
  clearInterval(timer);
  document.querySelector('main').innerHTML = '<section class="card"><div class="big">' + esc(L.bye) + '</div></section>';
  setTimeout(() => window.close(), 1500);
};
document.querySelectorAll('.lang button').forEach((b) => { b.onclick = () => post('/api/lang', { lang: b.dataset.l }); });
const timer = setInterval(refresh, 2500);
refresh();
</script></body></html>`;

module.exports = { serve, launch, startSim, stopSim, status, runMode };
