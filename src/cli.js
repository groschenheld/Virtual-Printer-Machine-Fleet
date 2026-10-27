#!/usr/bin/env node
'use strict';
// Headless-Start: node src/cli.js [--port 8650] [--data DIR] [--bind 0.0.0.0] [--time 20] [--open]
const { startServer } = require('./server');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes(n);

if (flag('--help') || flag('-h')) {
  console.log(`Virtual Print Fleet – virtueller Druckmaschinenpark

Optionen:
  --port <n>        Port der Oberfläche/API (Standard 8650)
  --ui-host <ip>    Adresse der Oberfläche (Standard 127.0.0.1)
  --bind <ip>       Adresse der Geräte-Schnittstellen (Standard 127.0.0.1, 0.0.0.0 = im Netz erreichbar)
  --data <dir>      Datenverzeichnis (Standard ~/.local/share/virtual-print-fleet bzw. %APPDATA%)
  --time <faktor>   Zeitraffer (20 = 20× schneller, 0 = sofort, 1 = Echtzeit)
  --open            Oberfläche im Browser öffnen
`);
  process.exit(0);
}

(async () => {
  try {
    const app = await startServer({
      port: arg('--port') ? Number(arg('--port')) : undefined,
      uiHost: arg('--ui-host'),
      bindHost: arg('--bind'),
      dataDir: arg('--data'),
      timeFactor: arg('--time') != null ? Number(arg('--time')) : undefined,
    });
    const f = app.fleet;
    console.log(`\nVirtual Print Fleet läuft: ${app.url}`);
    console.log(`Daten: ${f.store.dir}\n`);
    for (const d of f.devices.values()) {
      const s = f.deviceSummary(d);
      const errs = Object.entries(d.ifaces).filter(([, v]) => v && v.error).map(([k, v]) => `${k}: ${v.error}`);
      console.log(`  ${s.name.padEnd(36)} ${s.endpoints.ipp.padEnd(40)} LPD ${s.endpoints.lpd.padEnd(18)} Socket ${s.endpoints.raw}${errs.length ? '  ⚠ ' + errs.join('; ') : ''}`);
    }
    console.log('\nBeenden mit Strg+C');
    if (flag('--open')) {
      const { exec } = require('child_process');
      exec(process.platform === 'win32' ? `start "" "${app.url}"` : process.platform === 'darwin' ? `open "${app.url}"` : `xdg-open "${app.url}"`);
    }
    const stop = async () => { console.log('\nBeende …'); await app.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    console.error('Start fehlgeschlagen:', e.message);
    process.exit(1);
  }
})();
