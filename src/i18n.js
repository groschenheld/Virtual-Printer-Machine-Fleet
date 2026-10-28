'use strict';
/**
 * Zweisprachigkeit (Deutsch/Englisch) – Bilingual support (German/English).
 *
 *   $t('Text', 'Text')      → string in the current language (evaluated at call time)
 *   $tp('Text', 'Text')     → lazy pair for module-level constants; resolved by $lazy() proxies
 *   $lazy({ … })            → proxy that resolves pairs on every read (language can change at runtime)
 *
 * The language comes from the fleet settings (settings.lang), else from VPF_LANG / LANG.
 */

let lang = detect();

function detect() {
  const v = String(process.env.VPF_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || '').toLowerCase();
  if (process.env.VPF_LANG) return v.startsWith('en') ? 'en' : 'de';
  if (!v && process.platform === 'win32') {
    try { return /^de/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'de' : 'en'; } catch { return 'en'; }
  }
  return v.startsWith('de') ? 'de' : v && v !== 'c' && v !== 'posix' && !v.startsWith('c.') ? 'en' : 'de';
}

function setLang(l) { lang = l === 'en' ? 'en' : 'de'; return lang; }
function getLang() { return lang; }

function inLang(l, fn) { const old = lang; lang = l; try { return fn(); } finally { lang = old; } }

function $t(de, en) { return lang === 'en' && en != null ? en : de; }

class Pair {
  constructor(de, en) { this.de = de; this.en = en; }
  toString() { return $t(this.de, this.en); }
  toJSON() { return this.toString(); }
  [Symbol.toPrimitive]() { return this.toString(); }
}
function $tp(de, en) { return new Pair(de, en); }

const cache = new WeakMap();
function $lazy(obj) {
  if (obj instanceof Pair) return obj;
  if (!obj || typeof obj !== 'object') return obj;
  if (cache.has(obj)) return cache.get(obj);
  const p = new Proxy(obj, {
    get(target, key, recv) {
      const v = Reflect.get(target, key, recv);
      if (v instanceof Pair) return v.toString();
      if (v && typeof v === 'object' && typeof key !== 'symbol') return $lazy(v);
      return v;
    },
    getOwnPropertyDescriptor(target, key) {
      const d = Reflect.getOwnPropertyDescriptor(target, key);
      if (d && 'value' in d && d.value instanceof Pair && d.configurable) return { ...d, value: d.value.toString() };
      return d;
    },
  });
  cache.set(obj, p);
  return p;
}

module.exports = { $t, $tp, $lazy, setLang, getLang, inLang, Pair };
