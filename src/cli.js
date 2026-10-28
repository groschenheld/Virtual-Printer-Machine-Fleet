#!/usr/bin/env node
'use strict';
// Headless-Start: node src/cli.js [--port 8650] [--data DIR] [--bind 0.0.0.0] [--time 20] [--open]
const { $t, $tp, $lazy, setLang } = require('./i18n.js');
const { startServer } = require('./server');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes(n);

// Sprache: --lang, sonst gespeicherte Einstellung / Language: --lang, else saved setting
(() => {
  try {
    const dir = arg('--data') || require('./core/store').defaultDataDir();
    const saved = JSON.parse(require('fs').readFileSync(require('path').join(dir, 'settings.json'), 'utf8'));
    if (saved.lang) setLang(saved.lang);
  } catch { /* noch keine Einstellungen */ }
  if (arg('--lang')) setLang(arg('--lang'));
})();

if (flag('--help') || flag('-h')) {
  console.log($t(`Virtual Print Fleet – virtueller Druckmaschinenpark

Optionen:
  --port <n>        Port der Oberfläche/API (Standard 8650)
  --ui-host <ip>    Adresse der Oberfläche (Standard 127.0.0.1)
  --bind <ip>       Adresse der Geräte-Schnittstellen (Standard 127.0.0.1, 0.0.0.0 = im Netz erreichbar)
  --data <dir>      Datenverzeichnis (Standard ~/.local/share/virtual-print-fleet bzw. %APPDATA%)
  --time <faktor>   Zeitraffer (20 = 20× schneller, 0 = sofort, 1 = Echtzeit)
  --open            Oberfläche im Browser öffnen
  --no-mdns         Geräte nicht per Bonjour/mDNS ankündigen
  --lang de|en      Sprache (wird gespeichert)
  --eigene-ips      jedes Gerät bekommt eine eigene IP (127.0.0.11, .12 …) mit Standardports
                    IPP 631, Web 80, LPD 515, Socket 9100, SNMP 161 – wie echte Maschinen.
                    Braucht Root bzw. CAP_NET_BIND_SERVICE (sudo ./install.sh --service --eigene-ips).
                    Wird gespeichert; zurück mit --gemeinsame-ip

Befehle:
  vpf steuerung     grafische Steuerzentrale (Start/Stopp, Drucker ein/aus, Druckerseiten öffnen)
  vpf drucker-einrichten [--alle-queues] [--raw]
                    alle Geräte als Systemdrucker eintragen (CUPS bzw. Windows), damit sie
                    in Druckdialogen und Apps erscheinen. --alle-queues: auch hold/Presets
                    als eigene Drucker, --raw: ohne Treiber, --driverless: CUPS-Treiber
                    aus IPP statt des mitgelieferten PPD (Standard: PPD mit Installierbaren Optionen)
  vpf drucker-treiber <gerät> [datei]
                    PPD-Treiber eines Geräts speichern (z. B. für ein anderes System)
  vpf drucker-pruefen
                    Systemdrucker und Treiber prüfen (Ausgabe für Fehlermeldungen)
  vpf drucker-entfernen
                    alle von Virtual Print Fleet eingetragenen Systemdrucker entfernen
  vpf drucker-befehle
                    nur die Befehle anzeigen (zum manuellen Ausführen)
`, `Virtual Print Fleet – virtual printing machine park

Options:
  --port <n>        port of the interface/API (default 8650)
  --ui-host <ip>    address of the interface (default 127.0.0.1)
  --bind <ip>       address of the device interfaces (default 127.0.0.1, 0.0.0.0 = reachable on the network)
  --data <dir>      data directory (default ~/.local/share/virtual-print-fleet or %APPDATA%)
  --time <factor>   time lapse (20 = 20× faster, 0 = instant, 1 = real time)
  --open            open the interface in the browser
  --no-mdns         do not announce devices via Bonjour/mDNS
  --lang de|en      language (saved)
  --eigene-ips      every device gets its own IP (127.0.0.11, .12 …) with standard ports
  (--own-ips)       IPP 631, web 80, LPD 515, socket 9100, SNMP 161 – like real machines.
                    Needs root or CAP_NET_BIND_SERVICE (sudo ./install.sh --service --eigene-ips).
                    Saved; back with --gemeinsame-ip (--shared-ip)

Commands:
  vpf control       graphical control centre (start/stop, printers on/off, open printer pages)
  vpf drucker-einrichten [--alle-queues] [--raw]      (alias: vpf printers-install)
                    register all devices as system printers (CUPS or Windows) so they
                    appear in print dialogs and apps. --alle-queues: hold queues/presets
                    as separate printers too, --raw: without driver, --driverless: CUPS driver
                    from IPP instead of the bundled PPD (default: PPD with installable options)
  vpf drucker-treiber <device> [file]                 (alias: vpf printers-driver)
                    save the PPD driver of a device (e.g. for another system)
  vpf drucker-pruefen                                 (alias: vpf printers-check)
                    check system printers and drivers (output for bug reports)
  vpf drucker-entfernen                               (alias: vpf printers-remove)
                    remove all system printers registered by Virtual Print Fleet
  vpf drucker-befehle                                 (alias: vpf printers-commands)
                    only show the commands (to run them manually)
`));
  process.exit(0);
}

const ADDRESSING = flag('--eigene-ips') || flag('--own-ips') ? 'ip' : flag('--gemeinsame-ip') || flag('--shared-ip') ? 'ports' : undefined;
// Befehl = erstes Argument, das keine Option und kein Optionswert ist (der Starter kann Optionen voranstellen)
const VALUE_OPTS = new Set(['--port', '--ui-host', '--bind', '--data', '--time', '--lang']);
const ALIASES = { 'printers-install': 'drucker-einrichten', 'printers-remove': 'drucker-entfernen', 'printers-commands': 'drucker-befehle', 'printers-driver': 'drucker-treiber', 'printers-check': 'drucker-pruefen', steuerung: 'control' };
const CMD = (() => {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (VALUE_OPTS.has(a[i])) { i++; continue; }
    if (!a[i].startsWith('-')) return ALIASES[a[i]] || a[i];
  }
  return null;
})();
const CMD_ARGS = CMD ? process.argv.slice(process.argv.findIndex((x, i) => i > 1 && (x === CMD || ALIASES[x] === CMD)) + 1).filter((x) => !x.startsWith('-')) : [];

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
  const app = await startServer({ port, dataDir: arg('--data'), bindHost: arg('--bind'), addressing: ADDRESSING, mdns: false });
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
  if (CMD === 'control') {
    await require('./control').launch({ open: !flag('--no-open'), port: arg('--control-port') ? Number(arg('--control-port')) : undefined });
    return;
  }
  if (CMD === 'control-serve') {
    await require('./control').serve({ port: arg('--control-port') ? Number(arg('--control-port')) : undefined });
    await new Promise(() => {});
  }
  if (CMD === 'drucker-befehle') {
    await withFleet((s) => console.log(sp.manualCommands(s, { allQueues: flag('--alle-queues') })));
  } else if (CMD === 'drucker-einrichten') {
    await withFleet(async (s, running, getPpd) => {
      console.log($t(`Richte ${s.devices.filter((d) => d.enabled).length} Geräte als Systemdrucker ein${running ? '' : ' (Simulation dafür kurz gestartet)'} …`, `Registering ${s.devices.filter((d) => d.enabled).length} devices as system printers${running ? '' : ' (simulation started briefly for this)'} …`));
      const r = await sp.installSystemPrinters(s, { allQueues: flag('--alle-queues'), raw: flag('--raw'), driverless: flag('--driverless'), getPpd });
      console.log($t(`\nFertig${r ? `: ${r.ok} eingerichtet${r.failed ? `, ${r.failed} fehlgeschlagen` : ''}` : ''}. Die Simulation muss laufen (vpf bzw. Dienst), damit Druckjobs ankommen.`, `\nDone${r ? `: ${r.ok} registered${r.failed ? `, ${r.failed} failed` : ''}` : ''}. The simulation must be running (vpf or service) for print jobs to arrive.`));
    });
  } else if (CMD === 'drucker-treiber') {
    const id = CMD_ARGS[0];
    if (!id) throw new Error($t('Gerät angeben, z. B.: vpf drucker-treiber ipv1350', 'Specify a device, e.g.: vpf drucker-treiber ipv1350'));
    await withFleet(async (s, running, getPpd) => {
      const out = CMD_ARGS[1] || `VPF-${id}.ppd`;
      require('fs').writeFileSync(out, await getPpd(id));
      console.log(`✔ ${out}`);
    });
  } else if (CMD === 'drucker-pruefen') {
    await withFleet(async (s, running, getPpd) => sp.diagnose(getPpd, s));
  } else if (CMD === 'drucker-entfernen') {
    const n = await sp.removeSystemPrinters();
    console.log($t(`Fertig${n != null ? $t(`: ${n} Drucker entfernt`, `: ${n} printers removed`) : ''}.`, `Done${n != null ? `: ${n} printers removed` : ''}.`));
  } else {
    console.error($t(`Unbekannter Befehl „${CMD}" – siehe vpf --help`, `Unknown command “${CMD}” – see vpf --help`));
    process.exit(1);
  }
}


// Browser unabhängig vom Terminal öffnen (überlebt das Schließen des Terminals)
function openBrowser(url) {
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore' }); c.on('error', () => console.log($t(`Bitte im Browser öffnen: ${url}`, `Please open in the browser: ${url}`))); c.unref(); } catch { console.log($t(`Bitte im Browser öffnen: ${url}`, `Please open in the browser: ${url}`)); }
}
// Bei Start aus dem Startmenü: Meldung stehen lassen, bis Enter gedrückt wird
function waitEnter() {
  if (!flag('--open') || !process.stdin.isTTY) return Promise.resolve();
  console.log($t('\nEnter drücken zum Schließen …', '\nPress Enter to close …'));
  return new Promise((r) => { process.stdin.resume(); process.stdin.once('data', r); });
}

(async () => {
  if (CMD) {
    try { await command(); process.exit(0); } catch (e) { console.error('✘', e.message); process.exit(1); }
  }
  let app;
  try {
    app = await startServer({
      mdns: !flag('--no-mdns'),
      addressing: ADDRESSING,
      port: arg('--port') ? Number(arg('--port')) : undefined,
      uiHost: arg('--ui-host'),
      bindHost: arg('--bind'),
      dataDir: arg('--data'),
      timeFactor: arg('--time') != null ? Number(arg('--time')) : undefined,
      onQuit: async () => { try { await app.close(); } finally { process.exit(0); } },
    });
    if (arg('--lang')) app.fleet.setLanguage(arg('--lang'));
    const f = app.fleet;
    console.log($t(`\nVirtual Print Fleet läuft: ${app.url}`, `\nVirtual Print Fleet is running: ${app.url}`));
    console.log($t(`Daten: ${f.store.dir}\n`, `Data: ${f.store.dir}\n`));
    for (const d of f.devices.values()) {
      const s = f.deviceSummary(d);
      const errs = Object.entries(d.ifaces).filter(([, v]) => v && v.error).map(([k, v]) => `${k}: ${v.error}`);
      console.log(`  ${s.name.padEnd(36)} ${s.endpoints.ipp.padEnd(40)} LPD ${s.endpoints.lpd.padEnd(18)} Socket ${s.endpoints.raw}${s.endpoints.snmp ? '  SNMP ' + s.endpoints.snmp : ''}${errs.length ? '  ⚠ ' + errs.join('; ') : ''}`);
    }
    const md = f.mdns && f.mdns.status;
    if (md) setTimeout(() => console.log(md.active ? $t(`\nBonjour/mDNS: Geräte angekündigt als ${f.mdns.hostName()} (${md.addresses.join(', ')})`, `\nBonjour/mDNS: devices announced as ${f.mdns.hostName()} (${md.addresses.join(', ')})`) : $t(`\nBonjour/mDNS aus${md.error ? ': ' + md.error : ''}`, `\nBonjour/mDNS off${md.error ? ': ' + md.error : ''}`)), 300);
    console.log($t('\nSystemdrucker eintragen (für Druckdialoge/Apps): vpf drucker-einrichten', '\nRegister system printers (for print dialogs/apps): vpf drucker-einrichten'));
    console.log($t('Beenden mit Strg+C', 'Quit with Ctrl+C'));
    if (flag('--open')) openBrowser(app.url);
    const stop = async () => { console.log($t('\nBeende …', '\nShutting down …')); await app.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    const port = arg('--port') ? Number(arg('--port')) : 8650;
    const url = `http://127.0.0.1:${port}`;
    let running = false;
    try { running = (await fetch(`${url}/api/state`)).ok; } catch { /* */ }
    if (running) {
      console.log($t(`Virtual Print Fleet läuft bereits (z. B. als Dienst): ${url}`, `Virtual Print Fleet is already running (e.g. as a service): ${url}`));
      if (flag('--open')) { openBrowser(url); setTimeout(() => process.exit(0), 1500); return; }
      process.exit(0);
    }
    console.error($t('Start fehlgeschlagen:', 'Start failed:'), e.message);
    await waitEnter();
    process.exit(1);
  }
})();
