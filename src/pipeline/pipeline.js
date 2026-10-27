'use strict';
// Ablauf eines Jobs durch das simulierte Front-End und die Maschine:
// Format → Ticket (PJL) → Halten? → Preflight → Material → Ausschießen → Finishing → Ausgabe → Druck.
const fs = require('fs');
const { normalize } = require('./detect');
const { preflight, DEFAULT_CUT_NAMES } = require('./preflight');
const { applyPjl } = require('./ticket');
const { imposeSheet } = require('./impose/sheet');
const { imposeWide, imposePhoto } = require('./impose/roll');
const { imposePrintCut } = require('./impose/printcut');
const { applyFinishing } = require('./finishing');
const { renderOutputs } = require('./render');
const { frontendOf } = require('../frontends');
const { pt2mm, r1, r2, mm2pt } = require('../util/misc');
const { fmtSim } = require('../core/job');

class Canceled extends Error {}

async function processJob(dev, job) {
  const fleet = dev.fleet;
  const device = dev.cfg;
  const fe = frontendOf(device);
  const settings = fleet.settings;
  const ctx = { job, device, dev, fleet, fe, catalog: fleet.catalog, settings, ticket: job.ticket };
  const stage = (st) => job.addLog('STATUS', `▶ ${st}`);
  const delay = (simMs) => dev.simDelay(job, simMs);

  try {
    // ------------------------------------------------ 1. Spoolen / Format
    if (!job.resumeFrom || job.resumeFrom === 'spool') {
      job.setState('processing', ['job-spooling'], fe.stages.spool);
      stage(fe.stages.spool);
      const data = fs.readFileSync(job.file(job.input.file));
      await delay(Math.max(200, data.length / (40 * 1024 * 1024) * 1000));
      const norm = await normalize(data, job, settings);
      fs.writeFileSync(job.file('dokument.pdf'), norm.pdfBytes);
      job.input.format = norm.format;
      if (norm.pjl) applyPjl(job, norm.pjl);
      job.resumeFrom = 'rip';
      // Halten?
      if (job.ticket.hold || job.queueMode === 'hold') {
        job.setState('held', ['job-hold-until-specified'], `${fe.stages.held} – Freigabe am Front-End erforderlich`);
        job.addLog('BEDIENER', `Job liegt in „${fe.stages.held}". Freigeben über Oberfläche, IPP Release-Job${fe.features.includes('fiery-api') ? ', Fiery-API' : ''}${fe.features.includes('jmf') ? ' oder JMF ResumeQueueEntry' : ''}.`);
        return 'held';
      }
    }
    if (job.queueMode === 'direct') job.addLog('STATUS', 'Direktverbindung: Job wird nach dem Druck nicht in der Druckliste gespeichert (Fiery „direct"). Für die Simulation bleibt das Protokoll erhalten.');

    // ------------------------------------------------ 2. RIP: Preflight, Material, Ausschießen
    if (job.resumeFrom === 'rip' || job.resumeFrom === 'media') {
      job.setState('processing', ['job-interpreting'], fe.stages.rip);
      stage(fe.stages.rip);
      const pdfBytes = fs.readFileSync(job.file('dokument.pdf'));
      const cutNames = fe.cutColors.length ? fe.cutColors : DEFAULT_CUT_NAMES;
      const pf = await preflight(pdfBytes, job, cutNames);
      ctx.pf = pf;
      job.doc = { pages: pf.pages.length, sizesMm: pf.pages.slice(0, 50).map((p) => [r1(pt2mm(p.wPt)), r1(pt2mm(p.hPt))]), spots: pf.spots, cutPaths: pf.cutCount };
      if (job.resumeFrom === 'rip') await delay(fe.ripBaseMs + fe.ripMsPerPage * pf.pages.length);

      let res;
      if (device.kind === 'sheet') res = imposeSheet(ctx);
      else if (device.kind === 'wide') res = imposeWide(ctx);
      else if (device.kind === 'photo') res = imposePhoto(ctx);
      else res = imposePrintCut(ctx);

      if (!res.ok) {
        const m = res.media;
        const policy = dev.settings.mismatchPolicy || fe.mismatchPolicy;
        job.warn('MATERIAL', `${m.text}. ${fe.mismatchText}`);
        job.waitReason = { kind: m.reason, text: m.text, wanted: m.wanted || null };
        job.resumeFrom = 'media';
        if (policy === 'wait') {
          job.setState('waiting', [m.reason === 'media-empty' ? 'resources-are-not-ready' : 'resources-are-not-ready'], `${fe.stages.wait}: ${m.text}`);
          dev.setWaitingReason(m.reason === 'media-empty' ? 'media-empty-error' : 'media-needed-error', m.text);
          const r = await dev.waitFor(job, () => dev.mediaVersionChanged(job), 'Material');
          dev.setWaitingReason(null);
          if (r === 'canceled') throw new Canceled();
          job.addLog('BEDIENER', 'Material geändert – Job wird erneut geprüft');
          return processJob(dev, job);
        }
        job.setState('held', ['resources-are-not-ready', 'job-hold-until-specified'], `${fe.stages.held}: ${m.text}`);
        job.addLog('BEDIENER', 'Material einlegen bzw. Ticket ändern und Job freigeben (oder „Ersetzen" erzwingen).');
        return 'held';
      }
      const layout = res.layout;
      const { conflicts } = applyFinishing(ctx, layout);
      if (conflicts.length) {
        for (const c of conflicts) job.warn('FINISHING', c);
        const policy = dev.settings.conflictPolicy || fe.conflictPolicy;
        if (policy === 'hold' && !job.ignoreConflicts) {
          job.resumeFrom = 'media';
          job.waitReason = { kind: 'conflict', text: conflicts.join('; ') };
          job.setState('held', ['conflicting-attributes', 'job-hold-until-specified'], `Finishing-Konflikt: ${conflicts[0]}`);
          job.addLog('BEDIENER', 'Konflikt beheben (Ticket ändern) oder „Trotzdem drucken" wählen – dann wird ohne die betroffene Weiterverarbeitung gedruckt.');
          return 'held';
        }
        job.addLog('FINISHING', 'Konflikte werden ignoriert – Druck ohne betroffene Weiterverarbeitung');
      }
      await renderOutputs(ctx, layout);
      ctx.layout = layout;
      job.summary = summarize(layout, device, fleet);
      job.counters.surfaces = layout.surfaces.length;
      job.waitReason = null;
      job.resumeFrom = 'print';
      job._layout = layout;
      job.save();
    }

    // ------------------------------------------------ 3. Drucken
    if (job.resumeFrom === 'print') {
      const layout = job._layout || ctx.layout;
      if (!layout) { job.resumeFrom = 'rip'; return processJob(dev, job); }
      await simulatePrint(ctx, layout);
      job.resumeFrom = null;
      job.progress = 1;
      job.setState('completed', ['job-completed-successfully'], fe.stages.done);
      job.addLog('STATUS', `Fertig – simulierte Laufzeit ${fmtSim(job.simMs)}, Ablage: ${layout.outputBin || '–'}`);
      dev.afterJob(job, layout);
      return 'completed';
    }
  } catch (e) {
    if (e instanceof Canceled || job._cancel) {
      job.setState('canceled', ['job-canceled-by-user'], 'Abgebrochen');
      return 'canceled';
    }
    job.error('STATUS', `Verarbeitung abgebrochen: ${e.message}`, e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : undefined);
    job.setState('aborted', ['aborted-by-system', 'document-format-error'], e.message);
    return 'aborted';
  }
  return job.state;
}

function summarize(layout, device, fleet) {
  const s = {
    kind: layout.kind, mode: layout.mode, surfaces: layout.surfaces.length, outputBin: layout.outputBin || null,
    finishing: layout.finishingSummary || [],
    sheetsTotal: layout.totalSheets, impressionsTotal: layout.totalImpressions, sets: layout.sets,
    consumption: (layout.consumption || []).map((c) => {
      const slot = device.slots.find((x) => x.id === c.slotId);
      const m = slot && slot.loaded ? fleet.catalog.get(slot.loaded.mediaId) : null;
      return { slot: slot ? slot.name : c.slotId, media: m ? m.name : '', sheets: c.sheets, meters: c.mm != null ? r2(c.mm / 1000) : undefined };
    }),
  };
  if (layout.sheet) s.sheet = `${r1(layout.sheet.wMm)} × ${r1(layout.sheet.hMm)} mm`;
  if (layout.m2) s.m2 = r2(layout.m2);
  if (layout.cutLengthMm) s.cutLengthM = r2(layout.cutLengthMm / 1000);
  return s;
}

// ------------------------------------------------------------------ Drucksimulation
async function simulatePrint(ctx, layout) {
  const { job, device, dev, fe, fleet } = ctx;
  job.setState('printing', ['job-printing'], fe.stages.print);
  job.addLog('DRUCK', `▶ ${fe.stages.print}`);
  if (layout.kind === 'sheet') {
    const total = layout.totalSheets;
    const a4 = 210 * 297;
    const sheetArea = layout.sheet.wMm * layout.sheet.hMm;
    const a4eq = sheetArea > a4 * 2.2 ? Math.ceil(sheetArea / (a4 * 2)) * 2 : sheetArea > a4 * 1.15 ? 2 : 1;
    const impPerSheet = layout.duplex ? 2 : 1;
    const msPerSheet = (60000 / device.speed.ppm) * a4eq * impPerSheet;
    job.addLog('DRUCK', `${total} Bogen (${layout.totalImpressions} Drucke), Nenngeschwindigkeit ${device.speed.ppm} A4/min → ${r1(60000 / msPerSheet)} Bogen/min bei ${r1(layout.sheet.wMm)} × ${r1(layout.sheet.hMm)} mm${layout.duplex ? ' duplex' : ''}`);
    let slot = device.slots.find((s) => s.id === layout.slot);
    const batch = Math.max(1, Math.ceil(total / 40));
    let done = 0;
    while (done < total) {
      await dev.checkInterrupts(job);
      const n = Math.min(batch, total - done);
      // Material abbuchen, ggf. Fachumschaltung
      let need = n;
      while (need > 0) {
        if (!slot.loaded || slot.loaded.level <= 0 || slot.loaded.mediaId !== layout.media) {
          const alt = device.slots.find((s) => s.kind === 'sheet' && s.loaded && s.loaded.mediaId === layout.media && s.loaded.level > 0);
          if (alt && dev.settings.autoTraySwitch !== false) {
            job.addLog('DRUCK', `${slot.name} leer → automatische Fachumschaltung auf ${alt.name} (gleiches Material)`);
            slot = alt;
          } else {
            const txt = `${slot.name} leer – ${fleet.catalog.get(layout.media)?.name || ''} nachlegen`;
            job.warn('DRUCK', txt);
            job.setState('stopped', ['media-empty-error', 'job-printing'], txt);
            dev.setWaitingReason('media-empty-error', txt);
            const r = await dev.waitFor(job, () => device.slots.some((s) => s.kind === 'sheet' && s.loaded && s.loaded.mediaId === layout.media && s.loaded.level > 0), 'Material');
            dev.setWaitingReason(null);
            if (r === 'canceled') throw new Canceled();
            job.setState('printing', ['job-printing'], fe.stages.print);
            job.addLog('BEDIENER', 'Material nachgelegt – Druck läuft weiter');
            continue;
          }
        }
        const take = Math.min(need, slot.loaded.level);
        slot.loaded.level -= take;
        need -= take;
        job.consumption.push({ slotId: slot.id, sheets: take });
      }
      await dev.simDelay(job, msPerSheet * n);
      done += n;
      job.counters.sheets = done;
      job.counters.impressions = Math.round((done / total) * layout.totalImpressions);
      job.progress = done / total;
      dev.consumeSupplies(layout.totalImpressions ? (n / total) * layout.totalImpressions : n, job);
      dev.changed();
      job._emit('progress', { done, total });
    }
    // Finisher-Verbrauch
    const fin = device.finisher?.modules || {};
    if (layout.mode === 'booklet' && fin.booklet) fin.booklet.staples = Math.max(0, (fin.booklet.staples ?? 2000) - 2 * layout.sets);
    if (job.ticket.finishing.staple && fin.stapler && layout.surfaces.some((s) => s.overlay.staples.length)) {
      const per = /dual/.test(job.ticket.finishing.staple) ? 2 : 1;
      fin.stapler.staples = Math.max(0, (fin.stapler.staples ?? 5000) - per * layout.sets);
      job.addLog('FINISHING', `${per * layout.sets} Heftklammer(n) verbraucht, Rest ${fin.stapler.staples}`);
    }
    job.counters.sets = layout.sets;
    if (layout.mode === 'step-repeat' && layout.surfaces[0]?.stepRepeat) job.counters.cuts = layout.surfaces[0].stepRepeat.cuts;
    job.addLog('DRUCK', `${total} Bogen gedruckt, ${layout.sets} Satz/Sätze → ${layout.outputBin}`);
  } else {
    // Rolle
    const segs = layout.surfaces;
    const copies = layout.kind === 'printcut' ? 1 : layout.sets || 1;
    const units = [];
    for (let c = 0; c < copies; c++) for (const s of segs) units.push(s);
    let msPer;
    if (layout.kind === 'photo') {
      const ref = device.speed.refSizeMm[0] * device.speed.refSizeMm[1];
      msPer = (s) => (3600000 / device.speed.printsPerHour) * Math.max(0.5, (pt2mm(s.wPt) * pt2mm(s.hPt)) / ref);
    } else msPer = (s) => ((pt2mm(s.wPt) * (s.lengthMm || pt2mm(s.hPt))) / 1e6 / device.speed.m2h) * 3600000;
    job.addLog('DRUCK', layout.kind === 'photo' ? `${units.length} Print(s), ca. ${device.speed.printsPerHour} Prints/h (10×15)` : `${units.length} Abschnitt(e), ${r2(layout.m2 || 0)} m², Druckleistung ${device.speed.m2h} m²/h`);
    let i = 0;
    for (const s of units) {
      await dev.checkInterrupts(job);
      const slot = device.slots.find((x) => x.id === s.slotId);
      const media = slot && slot.loaded && fleet.catalog.get(slot.loaded.mediaId);
      const needM = (s.lengthMm || pt2mm(s.hPt)) / 1000;
      const rest = slot && slot.loaded ? (slot.loaded.levelM ?? media?.lengthM ?? 0) : 0;
      if (!media || rest < needM) {
        const txt = `${slot ? slot.name : 'Rolle'}: Rollenende – neue Rolle (${media ? media.name : 'Material'}) laden`;
        job.warn('DRUCK', txt);
        job.setState('stopped', ['media-empty-error', 'job-printing'], txt);
        dev.setWaitingReason('media-empty-error', txt);
        const r = await dev.waitFor(job, () => { const sl = device.slots.find((x) => x.id === s.slotId); const mm = sl && sl.loaded && fleet.catalog.get(sl.loaded.mediaId); return !!mm && (sl.loaded.levelM ?? mm.lengthM) >= needM; }, 'Rolle');
        dev.setWaitingReason(null);
        if (r === 'canceled') throw new Canceled();
        job.setState('printing', ['job-printing'], fe.stages.print);
      }
      const sl2 = device.slots.find((x) => x.id === s.slotId);
      const m2 = fleet.catalog.get(sl2.loaded.mediaId);
      sl2.loaded.levelM = Math.max(0, (sl2.loaded.levelM ?? m2.lengthM) - needM);
      job.consumption.push({ slotId: sl2.id, mm: r1(needM * 1000) });
      let t = msPer(s);
      if (layout.kind === 'printcut' && layout.cutLengthMm) {
        const cutMs = (layout.cutLengthMm / (device.speed.cutMmS || 300)) * 1000 * 1.3;
        if (layout.mode === 'cut-only') t = cutMs; else t += cutMs + 15000; // + Markenerkennung
        job.addLog('SCHNITT', `${layout.mode === 'cut-only' ? '' : 'Nach dem Druck: '}Medium zurückfahren, Schnittmarken einlesen (Sensor), dann ${r2(layout.cutLengthMm / 1000)} m Kontur schneiden (~${Math.round(cutMs / 1000)} s)`);
        if (layout.mode !== 'cut-only' && layout.mode !== 'none') job.addLog('DRUCK', 'Hinweis: bei lösemittel-/latexbasierten Tinten ggf. Trocknungszeit vor dem Schneiden (in VersaWorks einstellbar)');
      }
      await dev.simDelay(job, t);
      i++;
      job.counters.prints = i;
      job.counters.lengthMm = r1((job.counters.lengthMm || 0) + needM * 1000);
      job.counters.m2 = r2((job.counters.m2 || 0) + (pt2mm(s.wPt) * needM) / 1000);
      job.progress = i / units.length;
      dev.consumeSupplies(1, job);
      dev.changed();
      if (s.overlay.cuts.some((c) => c.kind === 'roll-cut' || c.kind === 'sheet-cut')) job.counters.cuts = (job.counters.cuts || 0) + 1;
      job._emit('progress', { done: i, total: units.length });
    }
    if (layout.kind === 'printcut' && layout.cuts) job.counters.cuts = (job.counters.cuts || 0) + layout.cuts;
    job.addLog('DRUCK', `${units.length} ${layout.kind === 'photo' ? 'Print(s)' : 'Abschnitt(e)'} fertig, ${r2(job.counters.lengthMm / 1000)} m Rolle verbraucht → ${layout.outputBin}`);
  }
}

module.exports = { processJob, Canceled };
