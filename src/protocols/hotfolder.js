'use strict';
// Hotfolder je Gerät und Warteschlange/Preset (wie Fiery Hot Folders, VersaWorks- oder Edge-Print-Hotfolder).
// Optional: Begleitdatei <name>.json (Ticket) oder <name>.jdf (JDF-Ticket) neben der Druckdatei.
const fs = require('fs');
const path = require('path');
const { applyObject } = require('../pipeline/ticket');
const { parseXml } = require('../util/xml');
const { applyJdf } = require('./jmf');
const { safeName } = require('../util/misc');

const SIDE = new Set(['.json', '.jdf', '.xml', '.tmp', '.part', '.crdownload']);

class HotFolders {
  constructor(fleet) {
    this.fleet = fleet;
    this.seen = new Map();
    this.timer = null;
  }
  dirs() {
    const out = [];
    for (const dev of this.fleet.devices.values()) {
      if (!dev.cfg.enabled) continue;
      for (const q of dev.queues) out.push({ dev, queue: q.name, dir: path.join(this.fleet.store.hotDir, dev.id, safeName(q.name)) });
    }
    return out;
  }
  start() {
    for (const d of this.dirs()) {
      fs.mkdirSync(d.dir, { recursive: true });
      const readme = path.join(d.dir, 'LIESMICH.txt');
      if (!fs.existsSync(readme)) fs.writeFileSync(readme, `Hotfolder für ${d.dev.cfg.name} – Warteschlange/Preset „${d.queue}".\nDruckdateien (PDF, PS, JPG, PNG, HP-GL) hier ablegen.\nOptional Ticket als <dateiname>.json (Simulationsformat) oder <dateiname>.jdf daneben legen.\nVerarbeitete Dateien landen in _erledigt bzw. _fehler.\n`);
    }
    this.timer = setInterval(() => this.scan().catch(() => {}), 1500);
  }
  stop() { clearInterval(this.timer); }

  async scan() {
    for (const d of this.dirs()) {
      let names;
      try { names = fs.readdirSync(d.dir); } catch { continue; }
      for (const n of names) {
        if (n.startsWith('.') || n.startsWith('_') || n === 'LIESMICH.txt') continue;
        const ext = path.extname(n).toLowerCase();
        if (SIDE.has(ext)) {
          const base = n.slice(0, -ext.length);
          if (names.some((x) => x !== n && x.startsWith(base + '.') && !SIDE.has(path.extname(x).toLowerCase()))) continue;
          if (ext === '.jdf' || ext === '.xml') { /* reines JDF mit RunList-Verweis */ } else continue;
        }
        const f = path.join(d.dir, n);
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        if (!st.isFile()) continue;
        const key = f;
        const prev = this.seen.get(key);
        if (!prev || prev.size !== st.size || prev.mtime !== st.mtimeMs) { this.seen.set(key, { size: st.size, mtime: st.mtimeMs }); continue; }
        if (Date.now() - st.mtimeMs < 1000) continue;
        this.seen.delete(key);
        await this.take(d, n, f, ext);
      }
    }
  }

  async take(d, n, f, ext) {
    const { fleet } = this;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const move = (sub, file) => {
      const target = path.join(d.dir, sub);
      fs.mkdirSync(target, { recursive: true });
      try { fs.renameSync(file, path.join(target, `${stamp}_${path.basename(file)}`)); } catch { /* */ }
    };
    const base = n.slice(0, n.length - ext.length);
    let job = null;
    try {
      job = fleet.createJob(d.dev.id, { name: base, user: 'hotfolder', source: { protocol: 'Hotfolder', queue: d.queue, path: f }, queue: d.queue });
      job.addLog('EMPFANG', `Datei „${n}" im Hotfolder ${d.dir} gefunden`);
      let data;
      if (ext === '.jdf' || ext === '.xml') {
        const jdf = parseXml(fs.readFileSync(f, 'utf8'));
        job.addProtocol('in', `JDF im Hotfolder: ${n}`, fs.readFileSync(f, 'utf8').slice(0, 20000));
        const url = applyJdf(job, jdf, fleet, d.dev);
        const df = url && path.resolve(d.dir, decodeURIComponent(url.replace(/^file:\/\/(localhost)?/, '').replace(/^\/([A-Za-z]:)/, '$1')));
        if (!df || !fs.existsSync(df)) throw new Error(`RunList-Datei ${url} nicht gefunden`);
        data = fs.readFileSync(df);
        move('_erledigt', df);
      } else {
        data = fs.readFileSync(f);
        for (const sx of ['.json', '.jdf']) {
          const side = path.join(d.dir, base + sx);
          if (!fs.existsSync(side)) continue;
          const txt = fs.readFileSync(side, 'utf8');
          job.addProtocol('in', `Begleit-Ticket ${base + sx}`, txt);
          if (sx === '.json') applyObject(job, JSON.parse(txt), `Hotfolder-Ticket ${base}.json`);
          else applyJdf(job, parseXml(txt), fleet, d.dev);
          move('_erledigt', side);
        }
      }
      fleet.submit(job, data, { filename: n });
      move('_erledigt', f);
    } catch (e) {
      fleet.log(d.dev.id, 'error', `Hotfolder ${d.queue}: ${n} – ${e.message}`);
      if (job) { job.error('EMPFANG', e.message); job.setState('aborted', ['job-data-insufficient'], e.message); }
      move('_fehler', f);
    }
  }
}

module.exports = { HotFolders };
