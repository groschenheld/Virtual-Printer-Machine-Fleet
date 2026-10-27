'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultDataDir() {
  if (process.env.VPF_DATA) return path.resolve(process.env.VPF_DATA);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'virtual-print-fleet');
  // Unter sudo die Daten des eigentlichen Benutzers verwenden, nicht die von root
  if (process.platform !== 'win32' && process.getuid && process.getuid() === 0 && process.env.SUDO_USER) {
    try {
      const line = require('child_process').execFileSync('getent', ['passwd', process.env.SUDO_USER], { encoding: 'utf8' });
      const home = line.split(':')[5];
      if (home) return path.join(home, '.local', 'share', 'virtual-print-fleet');
    } catch { /* weiter mit HOME */ }
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'virtual-print-fleet');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'virtual-print-fleet');
}

class Store {
  constructor(dir) {
    this.dir = path.resolve(dir || defaultDataDir());
    this.jobsDir = path.join(this.dir, 'jobs');
    this.hotDir = path.join(this.dir, 'hotfolders');
    for (const d of [this.dir, this.jobsDir, this.hotDir]) fs.mkdirSync(d, { recursive: true });
  }
  file(name) { return path.join(this.dir, name); }
  readJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return fallback; }
  }
  writeJson(name, obj) {
    const f = this.file(name);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, f);
  }
  jobDir(id) {
    const d = path.join(this.jobsDir, String(id));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  listJobIds() {
    try {
      return fs.readdirSync(this.jobsDir).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
    } catch { return []; }
  }
  removeJob(id) {
    fs.rmSync(path.join(this.jobsDir, String(id)), { recursive: true, force: true });
  }
}

module.exports = { Store, defaultDataDir };
