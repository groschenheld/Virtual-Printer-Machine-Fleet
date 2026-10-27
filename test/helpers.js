'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer } = require('../src/server');

let samplesDir = null;
function samples() {
  if (!samplesDir) {
    samplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpf-samples-'));
    execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'make-samples.js'), samplesDir]);
  }
  return samplesDir;
}

async function startTest(offset = 0) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpf-test-'));
  const app = await startServer({ dataDir, port: 18650 + offset, timeFactor: 0, mdns: false, basePorts: { http: 16310 + offset * 20, lpd: 15150 + offset * 20, raw: 19100 + offset * 20 } });
  return { app, fleet: app.fleet, dataDir, close: async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung');
    await new Promise((r2) => setTimeout(r2, 50));
  }
}

module.exports = { samples, startTest, waitFor };
