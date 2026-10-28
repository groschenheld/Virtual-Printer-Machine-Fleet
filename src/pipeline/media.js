'use strict';
// Materialauswahl: welches Fach / welche Rolle ein Front-End für den Job verwenden würde.
const { $t, $tp, $lazy } = require('../i18n.js');
const { r1, fmtSize } = require('../util/misc');

const TOL = 1.5;

function sameSize(aW, aH, bW, bH, tol = TOL) {
  return (Math.abs(aW - bW) <= tol && Math.abs(aH - bH) <= tol) || (Math.abs(aW - bH) <= tol && Math.abs(aH - bW) <= tol);
}
function fits(innerW, innerH, outerW, outerH) {
  return (innerW <= outerW + 0.01 && innerH <= outerH + 0.01) || (innerW <= outerH + 0.01 && innerH <= outerW + 0.01);
}

function describeMedia(m) {
  if (!m) return $t('leer', 'empty');
  return m.kind === 'roll' ? `${m.name}` : `${m.name} (${fmtSize(m.widthMm, m.heightMm)}, ${m.gsm} g/m²)`;
}

/** Materialanforderung aus dem Ticket ableiten (mediaId hat Vorrang und bringt Größe/Typ/Grammatur mit). */
function wantedFromTicket(ticket, catalog) {
  const t = ticket.media || {};
  const w = { mediaId: t.mediaId || null, sizeMm: t.sizeMm || null, type: t.type || null, gsm: t.gsm || null, source: t.source || null, name: null };
  if (w.mediaId) {
    const m = catalog.get(w.mediaId);
    if (m) {
      w.name = m.name;
      if (!w.sizeMm && m.kind === 'sheet') w.sizeMm = [m.widthMm, m.heightMm];
      if (!w.type) w.type = m.type;
      if (!w.gsm) w.gsm = m.gsm;
    }
  }
  return w;
}

function typeMatches(wantedType, media) {
  if (!wantedType) return true;
  const wt = String(wantedType).toLowerCase();
  return [media.type, media.ippType, media.name.toLowerCase()].some((x) => x && String(x).toLowerCase() === wt) || media.name.toLowerCase().includes(wt);
}

function findSlotBySource(device, source) {
  if (!source) return null;
  const s = String(source).toLowerCase();
  return device.slots.find((x) => x.id.toLowerCase() === s || (x.ippSource || '').toLowerCase() === s || x.name.toLowerCase() === s) || null;
}

/**
 * Bogenmaterial wählen.
 * need: { exact: [w,h] } – Dokumentformat muss exakt vorhanden sein
 *       { minFit: [w,h] } – kleinster geladener Bogen, auf den das passt
 */
function selectSheet(device, catalog, ticket, need, job) {
  const wanted = wantedFromTicket(ticket, catalog);
  const rows = [];
  const loaded = device.slots.filter((s) => s.kind === 'sheet');
  // 1) explizites Fach
  if (wanted.source) {
    const slot = findSlotBySource(device, wanted.source);
    if (!slot) {
      job.warn('MATERIAL', $t(`Angefordertes Fach „${wanted.source}" existiert an diesem Gerät nicht – automatische Fachwahl`, `Requested tray “${wanted.source}” does not exist on this device – automatic tray selection`));
    } else {
      const m = slot.loaded && catalog.get(slot.loaded.mediaId);
      if (!m) return { ok: false, reason: 'media-empty', slot, wanted, text: $t(`${slot.name} ist leer`, `${slot.name} is empty`) };
      const sizeOk = !wanted.sizeMm || sameSize(m.widthMm, m.heightMm, ...wanted.sizeMm);
      const typeOk = typeMatches(wanted.type, m);
      if (!sizeOk || !typeOk) {
        return { ok: false, reason: 'media-needed', slot, wanted, text: $t(`${slot.name} enthält ${describeMedia(m)}, angefordert ${wanted.sizeMm ? fmtSize(...wanted.sizeMm) : ''} ${wanted.type || ''}`, `${slot.name} contains ${describeMedia(m)}, requested ${wanted.sizeMm ? fmtSize(...wanted.sizeMm) : ''} ${wanted.type || ''}`).trim() };
      }
      job.addLog('MATERIAL', $t(`Fach per Ticket festgelegt: ${slot.name} → ${describeMedia(m)}`, `Tray set by ticket: ${slot.name} → ${describeMedia(m)}`));
      return { ok: true, slot, media: m, wanted, empty: slot.loaded.level <= 0 };
    }
  }
  const size = wanted.sizeMm || (need.exact || null);
  let best = null;
  for (const slot of loaded) {
    const m = slot.loaded && catalog.get(slot.loaded.mediaId);
    const row = { fach: slot.name, material: describeMedia(m), bestand: slot.loaded ? slot.loaded.level : 0, passt: false, grund: '' };
    rows.push(row);
    if (!m) { row.grund = $t('leer', 'empty'); continue; }
    if (wanted.mediaId && m.id !== wanted.mediaId && !(wanted.sizeMm && sameSize(m.widthMm, m.heightMm, ...wanted.sizeMm) && typeMatches(wanted.type, m) && (!wanted.gsm || Math.abs(m.gsm - wanted.gsm) <= 10))) { row.grund = $t('anderes Material', 'different media'); continue; }
    if (size && !sameSize(m.widthMm, m.heightMm, ...size)) { row.grund = `Format ${fmtSize(m.widthMm, m.heightMm)} ≠ ${fmtSize(...size)}`; continue; }
    if (!size && need.minFit && !fits(need.minFit[0], need.minFit[1], m.widthMm, m.heightMm)) { row.grund = $t(`zu klein für ${fmtSize(...need.minFit)}`, `too small for ${fmtSize(...need.minFit)}`); continue; }
    if (!typeMatches(wanted.type, m)) { row.grund = `Typ ${m.type} ≠ ${wanted.type}`; continue; }
    if (wanted.gsm && Math.abs(m.gsm - wanted.gsm) > 10) { row.grund = `${m.gsm} g/m² ≠ ${wanted.gsm} g/m²`; continue; }
    if (device.sheet && m.gsm > device.sheet.maxGsm) { row.grund = $t(`Grammatur > ${device.sheet.maxGsm} g/m²`, `grammage > ${device.sheet.maxGsm} g/m²`); continue; }
    row.passt = true;
    row.grund = slot.loaded.level > 0 ? $t('passt', 'fits') : $t('passt, aber leer', 'fits, but empty');
    const area = m.widthMm * m.heightMm;
    const score = (slot.loaded.level > 0 ? 0 : 1e9) + (need.prefer === 'largest' ? -area : area);
    if (!best || score < best.score) best = { slot, media: m, score };
  }
  job.addLog('MATERIAL', $t(`Fachauswahl – gesucht: ${size ? fmtSize(...size) : need.minFit ? '≥ ' + fmtSize(...need.minFit) : 'beliebig'}${wanted.type ? ', Typ ' + wanted.type : ''}${wanted.gsm ? ', ' + wanted.gsm + ' g/m²' : ''}${wanted.name ? ' (' + wanted.name + ')' : ''}`, `Tray selection – wanted: ${size ? fmtSize(...size) : need.minFit ? '≥ ' + fmtSize(...need.minFit) : 'any'}${wanted.type ? ', type ' + wanted.type : ''}${wanted.gsm ? ', ' + wanted.gsm + ' g/m²' : ''}${wanted.name ? ' (' + wanted.name + ')' : ''}`), rows);
  if (!best) {
    return { ok: false, reason: 'media-needed', wanted: { ...wanted, sizeMm: size || null, minFit: need.minFit || null }, text: $t(`Kein Fach mit ${size ? fmtSize(...size) : '≥ ' + fmtSize(...(need.minFit || [0, 0]))}${wanted.type ? ' ' + wanted.type : ''}${wanted.name ? ' (' + wanted.name + ')' : ''} geladen`, `No tray with ${size ? fmtSize(...size) : '≥ ' + fmtSize(...(need.minFit || [0, 0]))}${wanted.type ? ' ' + wanted.type : ''}${wanted.name ? ' (' + wanted.name + ')' : ''} loaded`) };
  }
  if (best.slot.loaded.level <= 0) return { ok: false, reason: 'media-empty', slot: best.slot, wanted, text: $t(`${best.slot.name} (${best.media.name}) ist leer`, `${best.slot.name} (${best.media.name}) is empty`) };
  return { ok: true, slot: best.slot, media: best.media, wanted };
}

/** Geladene Rollen mit Restlänge. */
function rollsOf(device, catalog) {
  return device.slots.filter((s) => s.kind === 'roll').map((slot) => {
    const m = slot.loaded && catalog.get(slot.loaded.mediaId);
    const remainingM = m ? (slot.loaded.levelM == null ? m.lengthM : slot.loaded.levelM) : 0;
    return { slot, media: m, remainingM };
  });
}

/**
 * Rolle wählen: kleinste Rolle, deren Breite ≥ needWidthMm, passender Typ.
 * Liefert auch die Kandidatentabelle für das Log.
 */
function selectRoll(device, catalog, ticket, needWidthMm, needLengthMm, job, label = '') {
  const wanted = wantedFromTicket(ticket, catalog);
  const rolls = rollsOf(device, catalog);
  const rows = [];
  let best = null;
  const forced = wanted.source ? findSlotBySource(device, wanted.source) : null;
  for (const r of rolls) {
    const row = { rolle: r.slot.name, material: r.media ? r.media.name : $t('leer', 'empty'), breite: r.media ? r.media.widthMm : 0, rest_m: r1(r.remainingM), passt: false, grund: '' };
    rows.push(row);
    if (forced && forced !== r.slot) { row.grund = $t('nicht angefordert', 'not requested'); continue; }
    if (!r.media) { row.grund = $t('keine Rolle', 'no roll'); continue; }
    if (wanted.mediaId && r.media.id !== wanted.mediaId && !(typeMatches(wanted.type, r.media) && wanted.type)) { row.grund = $t('anderes Material', 'different media'); continue; }
    if (!typeMatches(wanted.type, r.media)) { row.grund = `Typ ${r.media.type} ≠ ${wanted.type}`; continue; }
    if (r.media.widthMm + 0.01 < needWidthMm) { row.grund = $t(`zu schmal (${r.media.widthMm} < ${r1(needWidthMm)} mm)`, `too narrow (${r.media.widthMm} < ${r1(needWidthMm)} mm)`); continue; }
    if (r.remainingM * 1000 < needLengthMm) { row.grund = $t(`Restlänge zu kurz (${r1(r.remainingM)} m)`, `remaining length too short (${r1(r.remainingM)} m)`); row.passt = $t('leer', 'empty'); }
    else { row.passt = true; row.grund = $t('passt', 'fits'); }
    const score = (row.passt === true ? 0 : 1e9) + r.media.widthMm;
    if (!best || score < best.score) best = { ...r, score, short: row.passt !== true };
  }
  job.addLog('MATERIAL', $t(`Rollenwahl${label ? ' ' + label : ''} – benötigt Breite ≥ ${r1(needWidthMm)} mm, Länge ${r1(needLengthMm / 1000)} m${wanted.type ? ', Typ ' + wanted.type : ''}${wanted.name ? ' (' + wanted.name + ')' : ''}`, `Roll selection${label ? ' ' + label : ''} – needs width ≥ ${r1(needWidthMm)} mm, length ${r1(needLengthMm / 1000)} m${wanted.type ? ', type ' + wanted.type : ''}${wanted.name ? ' (' + wanted.name + ')' : ''}`), rows);
  if (!best) return { ok: false, reason: 'media-needed', text: $t(`Keine Rolle ≥ ${r1(needWidthMm)} mm${wanted.type ? ' (' + wanted.type + ')' : ''} geladen`, `No roll ≥ ${r1(needWidthMm)} mm${wanted.type ? ' (' + wanted.type + ')' : ''} loaded`), rows };
  if (best.short) return { ok: false, reason: 'media-empty', slot: best.slot, media: best.media, text: $t(`${best.slot.name}: Restlänge reicht nicht`, `${best.slot.name}: remaining length not sufficient`), rows };
  return { ok: true, slot: best.slot, media: best.media, remainingM: best.remainingM, rows };
}

module.exports = { selectSheet, selectRoll, rollsOf, sameSize, fits, describeMedia, wantedFromTicket, findSlotBySource };
