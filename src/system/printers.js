'use strict';
// Trägt die simulierten Geräte als Drucker im Betriebssystem ein (Linux/macOS: CUPS, Windows: Druckwarteschlange),
// damit sie in Druckdialogen und Apps erscheinen, die die System-Druckerliste verwenden.
const { execFile } = require('child_process');

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 60000, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, code: err && err.code, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
});

const PREFIX = 'VPF_';
const FE_SHORT = { fiery: 'Fiery', prismasync: 'PRISMAsync', ffps: 'FreeFlow', publisher: 'ClearConnect', edgeprint: 'EdgePrint', driver: '', ordercontroller: 'OrderController', versaworks: 'VersaWorks' };
const feShort = (dev) => FE_SHORT[dev.frontend?.type] ?? '';
const cupsName = (dev, queue) => (PREFIX + [feShort(dev), dev.name, queue].filter(Boolean).join('_')).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/_$/, '').slice(0, 127);
const winName = (dev, queue) => `${FE_SHORT[dev.frontend?.type] ? FE_SHORT[dev.frontend.type] + ' – ' : ''}${dev.name}${queue ? ' – ' + queue : ''} (VPF)`;

function targets(summary, allQueues) {
  const out = [];
  for (const d of summary.devices) {
    if (!d.enabled) continue;
    out.push({ dev: d, queue: null, uri: d.endpoints.ipp, raw: d.ports.raw, host: d.host });
    if (allQueues) d.queues.forEach((q, i) => out.push({ dev: d, queue: q.name, uri: d.endpoints.ippQueues[i], raw: d.ports.raw, host: d.host }));
  }
  return out;
}

// ------------------------------------------------------------------ CUPS
async function cupsInstall(summary, { allQueues = false, raw = false, driverless = false, getPpd = null, log = console.log } = {}) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpf-ppd-'));
  const has = await run('lpadmin', ['-h']).then((r) => r.code !== 'ENOENT');
  if (!has) throw new Error('lpadmin nicht gefunden – CUPS ist nicht installiert (Debian/Ubuntu: sudo apt install cups).');
  let ok = 0, failed = 0;
  for (const t of targets(summary, allQueues)) {
    const name = cupsName(t.dev, t.queue);
    const base = ['-p', name, '-E', '-v', t.uri, '-D', `${t.dev.frontend?.product ? t.dev.frontend.product + ' – ' : ''}${t.dev.name}${t.queue ? ' / ' + t.queue : ''} (Virtual Print Fleet)`, '-L', 'Virtual Print Fleet (Simulation)', '-o', 'printer-is-shared=false'];
    let r = { ok: false };
    let model = '';
    if (!raw && !driverless && getPpd) {
      const ppdFile = path.join(tmp, `${t.dev.id}.ppd`);
      fs.writeFileSync(ppdFile, await getPpd(t.dev.id));
      r = await run('lpadmin', [...base, '-P', ppdFile]);
      model = 'PPD-Treiber mit Installierbaren Optionen';
    }
    if (!r.ok && !raw) {
      if (r.err && /forbidden|not authorized|nicht berechtigt|Zugriff verweigert/i.test(r.err)) throw new Error(`Keine Berechtigung für lpadmin. Mit sudo ausführen oder den Benutzer in die Gruppe „lpadmin" aufnehmen (sudo usermod -aG lpadmin $USER).`);
      if (model) log(`  ! ${name}: PPD abgelehnt (${r.err.trim().split('\n')[0]}) – versuche driverless`);
      r = await run('lpadmin', [...base, '-m', 'everywhere']);
      model = 'everywhere (driverless)';
    }
    if (!r.ok) {
      if (!raw && /forbidden|not authorized|nicht berechtigt|Zugriff verweigert/i.test(r.err)) throw new Error(`Keine Berechtigung für lpadmin. Mit sudo ausführen oder den Benutzer in die Gruppe „lpadmin" aufnehmen (sudo usermod -aG lpadmin $USER).`);
      r = await run('lpadmin', [...base, '-m', 'raw']);
      model = 'raw (Daten unverändert)';
    }
    if (r.ok) { ok++; log(`  ✔ ${name.padEnd(48)} ${t.uri}  [${model}]`); }
    else { failed++; log(`  ✘ ${name}: ${r.err.trim()}`); if (/forbidden|not authorized/i.test(r.err)) throw new Error('Keine Berechtigung für lpadmin – mit sudo ausführen.'); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { ok, failed };
}

async function cupsList() {
  const r = await run('lpstat', ['-v']);
  if (!r.ok && !r.out) return [];
  return r.out.split('\n').map((l) => (/^(?:device for|Gerät für)\s+(\S+?):\s*(\S+)/i.exec(l) || [])).filter((m) => m[1] && m[1].startsWith(PREFIX)).map((m) => ({ name: m[1], uri: m[2] }));
}

async function cupsRemove({ log = console.log } = {}) {
  const list = await cupsList();
  let n = 0;
  for (const p of list) {
    const r = await run('lpadmin', ['-x', p.name]);
    if (r.ok) { n++; log(`  ✔ entfernt: ${p.name}`); } else log(`  ✘ ${p.name}: ${r.err.trim()}`);
  }
  return n;
}

// ------------------------------------------------------------------ Windows
function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }
function windowsScript(summary, { allQueues = false } = {}) {
  const lines = ['$ErrorActionPreference = "Continue"'];
  const seenPorts = new Set();
  for (const t of targets(summary, allQueues)) {
    const port = `VPF_${t.dev.id}_${t.raw}`;
    if (!seenPorts.has(port)) {
      seenPorts.add(port);
      lines.push(`if (-not (Get-PrinterPort -Name ${psQuote(port)} -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name ${psQuote(port)} -PrinterHostAddress ${psQuote(t.host === '0.0.0.0' ? '127.0.0.1' : t.host)} -PortNumber ${t.raw} }`);
    }
    const n = winName(t.dev, t.queue);
    lines.push(`if (-not (Get-Printer -Name ${psQuote(n)} -ErrorAction SilentlyContinue)) { Add-Printer -Name ${psQuote(n)} -PortName ${psQuote(port)} -DriverName 'Microsoft PS Class Driver' -Comment 'Virtual Print Fleet (Simulation)' -Location 'Virtual Print Fleet'; Write-Host 'eingerichtet:' ${psQuote(n)} }`);
  }
  return lines.join('\r\n');
}
const windowsRemoveScript = () => [
  "Get-Printer | Where-Object { $_.Name -like '*(VPF)' } | ForEach-Object { Remove-Printer -Name $_.Name; Write-Host 'entfernt:' $_.Name }",
  "Get-PrinterPort | Where-Object { $_.Name -like 'VPF_*' } | ForEach-Object { Remove-PrinterPort -Name $_.Name }",
].join('\r\n');

async function windowsRun(script, log = console.log) {
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { maxBuffer: 4 * 1024 * 1024 });
  if (r.out.trim()) log(r.out.trim());
  if (!r.ok) throw new Error(`PowerShell meldet einen Fehler (als Administrator ausführen?): ${r.err.trim().split('\n')[0]}`);
}

// ------------------------------------------------------------------ Gemeinsame Schnittstelle
async function installSystemPrinters(summary, opts = {}) {
  if (process.platform === 'win32') { await windowsRun(windowsScript(summary, opts), opts.log); return; }
  return cupsInstall(summary, opts);
}
async function removeSystemPrinters(opts = {}) {
  if (process.platform === 'win32') { await windowsRun(windowsRemoveScript(), opts.log); return; }
  return cupsRemove(opts);
}
function manualCommands(summary, opts = {}) {
  if (process.platform === 'win32') return windowsScript(summary, opts);
  return targets(summary, opts.allQueues).map((t) => `curl -s -o /tmp/${t.dev.id}.ppd http://127.0.0.1:${opts.uiPort || 8650}/api/devices/${t.dev.id}/driver.ppd && \\\n  lpadmin -p ${cupsName(t.dev, t.queue)} -E -v ${t.uri} -P /tmp/${t.dev.id}.ppd -D "${t.dev.name}${t.queue ? ' / ' + t.queue : ''} (Virtual Print Fleet)"`).join('\n');
}

module.exports = { installSystemPrinters, removeSystemPrinters, manualCommands, cupsList, cupsName };
