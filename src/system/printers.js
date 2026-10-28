'use strict';
// Trägt die simulierten Geräte als Drucker im Betriebssystem ein (Linux/macOS: CUPS, Windows: Druckwarteschlange),
// damit sie in Druckdialogen und Apps erscheinen, die die System-Druckerliste verwenden.
const { $t, $tp, $lazy } = require('../i18n.js');
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
  if (!has) throw new Error($t('lpadmin nicht gefunden – CUPS ist nicht installiert (Debian/Ubuntu: sudo apt install cups).', 'lpadmin not found – CUPS is not installed (Debian/Ubuntu: sudo apt install cups).'));
  let ok = 0, failed = 0;
  for (const t of targets(summary, allQueues)) {
    const name = cupsName(t.dev, t.queue);
    const base = ['-p', name, '-E', '-v', t.uri, '-D', `${t.dev.frontend?.product ? t.dev.frontend.product + ' – ' : ''}${t.dev.name}${t.queue ? ' / ' + t.queue : ''} (Virtual Print Fleet)`, '-L', 'Virtual Print Fleet (Simulation)', '-o', 'printer-is-shared=false'];
    let r = { ok: false };
    let model = '';
    if (!raw && !driverless && getPpd) {
      const ppdFile = path.join(tmp, `${t.dev.id}.ppd`);
      fs.writeFileSync(ppdFile, await getPpd(t.dev.id));
      const test = await run('cupstestppd', ['-W', 'translations', '-W', 'constraints', ppdFile]);
      if (test.code !== 'ENOENT' && !test.ok) log($t(`  ! ${name}: cupstestppd meldet:\n${(test.out + test.err).split('\n').filter((l) => /FAIL|WARN|\*\*/.test(l)).slice(0, 12).map((l) => '      ' + l.trim()).join('\n')}`, `  ! ${name}: cupstestppd reports:\n${(test.out + test.err).split('\n').filter((l) => /FAIL|WARN|\*\*/.test(l)).slice(0, 12).map((l) => '      ' + l.trim()).join('\n')}`));
      r = await run('lpadmin', [...base, '-P', ppdFile]);
      model = $t('PPD-Treiber mit Installierbaren Optionen', 'PPD driver with installable options');
      // Prüfen, ob CUPS die Warteschlange wirklich mit Treiber angelegt hat
      if (r.ok) {
        const chk = await run('lpoptions', ['-p', name, '-l']);
        if (!chk.ok || !/PageSize/.test(chk.out)) {
          log($t(`  ! ${name}: Warteschlange ohne Treiber angelegt (${(chk.err || 'keine Optionen').trim().split('\n')[0]}) – lege sie driverless neu an`, `  ! ${name}: queue created without driver (${(chk.err || 'no options').trim().split('\n')[0]}) – recreating it driverless`));
          await run('lpadmin', ['-x', name]);
          r = { ok: false, err: $t('PPD nicht übernommen', 'PPD not accepted') };
        }
      }
    }
    if (!r.ok && !raw) {
      if (r.err && /forbidden|not authorized|nicht berechtigt|Zugriff verweigert/i.test(r.err)) throw new Error($t(`Keine Berechtigung für lpadmin. Mit sudo ausführen oder den Benutzer in die Gruppe „lpadmin" aufnehmen (sudo usermod -aG lpadmin $USER).`, `No permission for lpadmin. Run with sudo or add the user to the “lpadmin” group (sudo usermod -aG lpadmin $USER).`));
      if (model) log($t(`  ! ${name}: PPD abgelehnt (${r.err.trim().split('\n')[0]}) – versuche driverless`, `  ! ${name}: PPD rejected (${r.err.trim().split('\n')[0]}) – trying driverless`));
      r = await run('lpadmin', [...base, '-m', 'everywhere']);
      model = 'everywhere (driverless)';
    }
    if (!r.ok) {
      if (!raw && /forbidden|not authorized|nicht berechtigt|Zugriff verweigert/i.test(r.err)) throw new Error($t(`Keine Berechtigung für lpadmin. Mit sudo ausführen oder den Benutzer in die Gruppe „lpadmin" aufnehmen (sudo usermod -aG lpadmin $USER).`, `No permission for lpadmin. Run with sudo or add the user to the “lpadmin” group (sudo usermod -aG lpadmin $USER).`));
      r = await run('lpadmin', [...base, '-m', 'raw']);
      model = $t('raw (Daten unverändert)', 'raw (data unchanged)');
    }
    if (r.ok) { ok++; log(`  ✔ ${name.padEnd(48)} ${t.uri}  [${model}]`); }
    else { failed++; log(`  ✘ ${name}: ${r.err.trim()}`); if (/forbidden|not authorized/i.test(r.err)) throw new Error($t('Keine Berechtigung für lpadmin – mit sudo ausführen.', 'No permission for lpadmin – run with sudo.')); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { ok, failed };
}

async function cupsList() {
  // Sprachunabhängig: Namen über "lpstat -e", URIs über "lpstat -v" mit englischer Ausgabe
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };
  const names = await run('lpstat', ['-e'], { env });
  const v = await run('lpstat', ['-v'], { env });
  const uris = {};
  for (const l of v.out.split('\n')) { const m = /^\S+\s+\S+\s+(\S+?):\s*(\S+)/.exec(l); if (m) uris[m[1]] = m[2]; }
  const list = names.out.split('\n').map((x) => x.trim()).filter((x) => x.startsWith(PREFIX));
  for (const n of Object.keys(uris)) if (n.startsWith(PREFIX) && !list.includes(n)) list.push(n);
  return list.map((name) => ({ name, uri: uris[name] || '' }));
}

async function cupsRemove({ log = console.log } = {}) {
  const list = await cupsList();
  let n = 0;
  for (const p of list) {
    const r = await run('lpadmin', ['-x', p.name]);
    if (r.ok) { n++; log($t(`  ✔ entfernt: ${p.name}`, `  ✔ removed: ${p.name}`)); } else log(`  ✘ ${p.name}: ${r.err.trim()}`);
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
  if (!r.ok) throw new Error($t(`PowerShell meldet einen Fehler (als Administrator ausführen?): ${r.err.trim().split('\n')[0]}`, `PowerShell reports an error (run as administrator?): ${r.err.trim().split('\n')[0]}`));
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

/** Diagnose: alle VPF-Warteschlangen mit Treiberstatus. */
async function diagnose(getPpd, summary, log = console.log) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const list = await cupsList();
  if (!list.length) log($t('Keine VPF_-Systemdrucker gefunden (vpf drucker-einrichten ausführen).', 'No VPF_ system printers found (run vpf drucker-einrichten).'));
  for (const p of list) {
    const o = await run('lpoptions', ['-p', p.name, '-l']);
    const n = o.ok ? o.out.split('\n').filter(Boolean).length : 0;
    log(`${o.ok && n ? '✔' : '✘'} ${p.name.padEnd(48)} ${p.uri}  ${o.ok && n ? n + $t(' Treiberoptionen', ' driver options') : $t('KEIN Treiber/PPD: ', 'NO driver/PPD: ') + (o.err || '').trim().split('\n')[0]}`);
  }
  const tc = await run('cupstestppd', ['-h']);
  if (tc.code === 'ENOENT') { log($t('\n(cupstestppd nicht installiert – Treiberprüfung übersprungen; Debian/Ubuntu: Paket cups-client)', '\n(cupstestppd not installed – driver check skipped; Debian/Ubuntu: package cups-client)')); return; }
  log($t('\nPrüfung der erzeugten Treiber mit cupstestppd:', '\nChecking the generated drivers with cupstestppd:'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpf-chk-'));
  for (const d of summary.devices) {
    const f = path.join(tmp, `${d.id}.ppd`);
    fs.writeFileSync(f, await getPpd(d.id));
    const r = await run('cupstestppd', ['-W', 'translations', f]);
    log(`${r.ok ? '✔' : '✘'} ${d.id.padEnd(12)} ${r.ok ? 'PASS' : '\n' + (r.out + r.err).split('\n').filter((l) => /FAIL|WARN|\*\*/.test(l)).slice(0, 15).map((l) => '      ' + l.trim()).join('\n')}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

module.exports = { diagnose, installSystemPrinters, removeSystemPrinters, manualCommands, cupsList, cupsName };
