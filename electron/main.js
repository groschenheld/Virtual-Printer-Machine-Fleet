'use strict';
// Desktop-Hülle: startet die Simulation im selben Prozess und zeigt die Oberfläche.
const { $t, $tp, $lazy } = require('../src/i18n.js');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const { startServer } = require('../src/server');

let srv = null;
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function menu(url, dataDir) {
  return Menu.buildFromTemplate([
    { label: $t('Datei', 'File'), submenu: [
      { label: $t('Datenordner öffnen', 'Open data folder'), click: () => shell.openPath(dataDir) },
      { label: $t('Hotfolder öffnen', 'Open hot folders'), click: () => shell.openPath(path.join(dataDir, 'hotfolders')) },
      { label: $t('Oberfläche im Browser öffnen', 'Open interface in browser'), click: () => shell.openExternal(url) },
      { type: 'separator' },
      { role: 'quit', label: $t('Beenden', 'Quit') },
    ] },
    { label: $t('Ansicht', 'View'), submenu: [{ role: 'reload', label: $t('Neu laden', 'Reload') }, { role: 'toggleDevTools', label: $t('Entwicklertools', 'Developer tools') }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]);
}

app.whenReady().then(async () => {
  let url = 'http://127.0.0.1:8650';
  let dataDir = '';
  try {
    srv = await startServer({ onRestart: () => { app.relaunch(); app.exit(0); } });
    url = srv.url;
    dataDir = srv.fleet.store.dir;
  } catch (e) {
    const r = await dialog.showMessageBox({ type: 'warning', message: $t('Simulation konnte nicht gestartet werden', 'Simulation could not be started'), detail: $t(`${e.message}\n\nLäuft sie bereits (z. B. als Dienst oder zweites Fenster)? Dann kann die laufende Instanz geöffnet werden.`, `${e.message}\n\nIs it already running (e.g. as a service or in a second window)? Then the running instance can be opened.`), buttons: [$t('Laufende Instanz öffnen', 'Open running instance'), $t('Beenden', 'Quit')] });
    if (r.response === 1) { app.quit(); return; }
  }
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, title: 'Virtual Print Fleet',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  Menu.setApplicationMenu(menu(url, dataDir));
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    // PDFs und Logs aus der Oberfläche in eigenem Fenster anzeigen
    if (u.startsWith(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 850, autoHideMenuBar: true } };
    shell.openExternal(u);
    return { action: 'deny' };
  });
  win.loadURL(url);
});

app.on('window-all-closed', async () => {
  if (srv) { try { await srv.close(); } catch { /* */ } }
  app.quit();
});
