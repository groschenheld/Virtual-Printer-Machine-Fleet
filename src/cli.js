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
  --no-mdns         Geräte nicht per Bonjour/mDNS ankündigen

Befehle:
  vpf drucker-einrichten [--alle-queues] [--raw]
                    alle Geräte als Systemdrucker eintragen (CUPS bzw. Windows), damit sie
                    in Druckdialogen und Apps erscheinen. --alle-queues: auch hold/Presets
                    als eigene Drucker, --raw: ohne Treiber, --driverless: CUPS-Treiber
                    aus IPP statt des mitgelieferten PPD (Standard: PPD mit Installierbaren Optionen)
  vpf drucker-treiber <gerät> [datei]
                    PPD-Treiber eines Geräts speichern (z. B. für ein anderes System)
  vpf drucker-entfernen
                    alle von Virtual Print Fleet eingetragenen Systemdrucker entfernen
  vpf drucker-befehle
                    nur die Befehle anzeigen (zum manuellen Ausführen)
`);
  process.exit(0);
}

const CMD = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;

/** Läuft die Simulation schon? Dann deren Zustand nehmen, sonst kurz selbst starten. */
async function withFleet(fn) {
  const port = arg('--port') ? Number(arg('--port')) : 8650;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`);
    if (r.ok) {
      const getPpd = async (id) => Buffer.from(await (await fetch(`http://127.0.0.1:${port}/api/devices/${encodeURIComponent(id)}/driver.ppd`)).arrayBuffer());
      return fn(await r.json(), true, getPpd);
    }
  } catch { /* läuft nicht */ }
  const app = await startServer({ port, dataDir: arg('--data'), bindHost: arg('--bind'), mdns: false });
  const { generatePpd } = require('./system/ppd');
  try { return await fn(app.fleet.summary(), false, async (id) => generatePpd(app.fleet, app.fleet.device(id))); } finally {
    await app.close();
    // Unter sudo gestartet: Daten wieder dem eigentlichen Benutzer geben
    if (process.getuid && process.getuid() === 0 && process.env.SUDO_USER) {
      try { require('child_process').execFileSync('chown', ['-R', process.env.SUDO_USER, app.fleet.store.dir]); } catch { /* */ }
    }
  }
}

async function command() {
  const sp = require('./system/printers');
  if (CMD === 'drucker-befehle') {
    await withFleet((s) => console.log(sp.manualCommands(s, { allQueues: flag('--alle-queues') })));
  } else if (CMD === 'drucker-einrichten') {
    await withFleet(async (s, running, getPpd) => {
      console.log(`Richte ${s.devices.filter((d) => d.enabled).length} Geräte als Systemdrucker ein${running ? '' : ' (Simulation dafür kurz gestartet)'} …`);
      const r = await sp.installSystemPrinters(s, { allQueues: flag('--alle-queues'), raw: flag('--raw'), driverless: flag('--driverless'), getPpd });
      console.log(`\nFertig${r ? `: ${r.ok} eingerichtet${r.failed ? `, ${r.failed} fehlgeschlagen` : ''}` : ''}. Die Simulation muss laufen (vpf bzw. Dienst), damit Druckjobs ankommen.`);
    });
  } else if (CMD === 'drucker-treiber') {
    const id = process.argv[3];
    if (!id) throw new Error('Gerät angeben, z. B.: vpf drucker-treiber ipv1350');
    await withFleet(async (s, running, getPpd) => {
      const out = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : `VPF-${id}.ppd`;
      require('fs').writeFileSync(out, await getPpd(id));
      console.log(`✔ ${out}`);
    });
  } else if (CMD === 'drucker-entfernen') {
    const n = await sp.removeSystemPrinters();
    console.log(`Fertig${n != null ? `: ${n} Drucker entfernt` : ''}.`);
  } else {
    console.error(`Unbekannter Befehl „${CMD}" – siehe vpf --help`);
    process.exit(1);
  }
}

(async () => {
  if (CMD) {
    try { await command(); process.exit(0); } catch (e) { console.error('✘', e.message); process.exit(1); }
  }
  try {
    const app = await startServer({
      mdns: !flag('--no-mdns'),
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
    const md = f.mdns && f.mdns.status;
    if (md) setTimeout(() => console.log(md.active ? `\nBonjour/mDNS: Geräte angekündigt als ${f.mdns.hostName()} (${md.addresses.join(', ')})` : `\nBonjour/mDNS aus${md.error ? ': ' + md.error : ''}`), 300);
    console.log('\nSystemdrucker eintragen (für Druckdialoge/Apps): vpf drucker-einrichten');
    console.log('Beenden mit Strg+C');
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
