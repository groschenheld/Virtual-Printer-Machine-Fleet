'use strict';
// Desktop-Hülle: startet die Simulation im selben Prozess und zeigt die Oberfläche.
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const { startServer } = require('../src/server');

let srv = null;
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function menu(url, dataDir) {
  return Menu.buildFromTemplate([
    { label: 'Datei', submenu: [
      { label: 'Datenordner öffnen', click: () => shell.openPath(dataDir) },
      { label: 'Hotfolder öffnen', click: () => shell.openPath(path.join(dataDir, 'hotfolders')) },
      { label: 'Oberfläche im Browser öffnen', click: () => shell.openExternal(url) },
      { type: 'separator' },
      { role: 'quit', label: 'Beenden' },
    ] },
    { label: 'Ansicht', submenu: [{ role: 'reload', label: 'Neu laden' }, { role: 'toggleDevTools', label: 'Entwicklertools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
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
    const r = await dialog.showMessageBox({ type: 'warning', message: 'Simulation konnte nicht gestartet werden', detail: `${e.message}\n\nLäuft sie bereits (z. B. als Dienst oder zweites Fenster)? Dann kann die laufende Instanz geöffnet werden.`, buttons: ['Laufende Instanz öffnen', 'Beenden'] });
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
