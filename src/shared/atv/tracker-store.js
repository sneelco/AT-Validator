/*
 * Tracker persistence: a list of activities in localStorage, plus JSON
 * export/import so the history can be backed up or moved between browsers.
 *
 * What is stored is a compact 5-second series (speed, heart rate, cumulative
 * distance) rather than the derived numbers — so changing the walk/run
 * threshold, or the trimming rules, re-measures every past activity instead of
 * leaving a history computed under settings you no longer use. A one-hour run
 * costs roughly 10 kB.
 */
(function (global) {
  'use strict';

  var KEY = 'atv-tracker-activities-v1';
  var SETTINGS_KEY = 'atv-tracker-settings-v1';
  var FORMAT = 'at-validator-tracker';
  var VERSION = 1;
  var SERIES_DT = 5;          // seconds between stored points
  var MAX_SERIES_POINTS = 40000; // ~55 h at 5 s — a sanity bound on imports

  function analysisApi() {
    if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
      return require('./tracker-analysis.js');
    }
    return global.ATV && global.ATV.trackerAnalysis;
  }

  // ---- compact series -------------------------------------------------------

  // Resample to SERIES_DT: speed in cm/s, HR in bpm, cumulative distance in m.
  function compressSeries(samples) {
    var A = analysisApi();
    var track = A.buildTrack(samples);
    if (!track) return null;
    var sp = [], hr = [], d = [];
    var n = track.n;
    for (var i = 0; i < n; i += SERIES_DT) {
      sp.push(Math.round(track.speed[i] * 100));
      hr.push(track.hasHr ? Math.round(track.hr[i]) : 0);
      d.push(Math.round(track.dist[i]));
    }
    var last = n - 1;
    if (last % SERIES_DT !== 0) {
      sp.push(Math.round(track.speed[last] * 100));
      hr.push(track.hasHr ? Math.round(track.hr[last]) : 0);
      d.push(Math.round(track.dist[last]));
    }
    return { dt: SERIES_DT, n: n, sp: sp, hr: hr, d: d };
  }

  // Back to { t, speed, hr, distance } samples the analysis can consume.
  function expandSeries(series) {
    if (!series || !series.sp || !series.sp.length) return null;
    var dt = series.dt || SERIES_DT;
    var count = series.sp.length;
    var n = series.n || ((count - 1) * dt + 1);
    var hasHr = series.hr && series.hr.some(function (v) { return v > 0; });
    var out = [];
    for (var i = 0; i < count; i++) {
      var t = i < count - 1 ? i * dt : Math.max(n - 1, i * dt);
      var rec = { t: t, speed: (series.sp[i] || 0) / 100 };
      if (series.d) rec.distance = series.d[i];
      if (hasHr && series.hr[i] > 0) rec.hr = series.hr[i];
      out.push(rec);
    }
    return out;
  }

  // ---- identity -------------------------------------------------------------

  // Same start time + duration = the same run, however it reached the browser.
  function activityKey(rec) {
    if (!rec) return '';
    if (num(rec.startTime)) {
      return 's|' + Math.round(rec.startTime) + '|' + Math.round(rec.durationSec || 0);
    }
    return 'n|' + String(rec.name || '') + '|' + Math.round(rec.durationSec || 0) +
      '|' + Math.round(rec.distanceM || 0);
  }

  function idFor(rec) { return 'act-' + hash36(activityKey(rec)); }

  function hash36(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  function num(v) { return typeof v === 'number' && isFinite(v); }

  // ---- list operations ------------------------------------------------------

  function sortActivities(list) {
    return list.slice().sort(function (a, b) {
      var at = num(a.startTime) ? a.startTime : a.addedAt || 0;
      var bt = num(b.startTime) ? b.startTime : b.addedAt || 0;
      return at - bt;
    });
  }

  /*
   * Merge incoming activities into an existing list. An activity already
   * present (same key) is replaced rather than duplicated, so importing the
   * same export twice is a no-op.
   */
  function mergeActivities(existing, incoming) {
    var list = existing.slice();
    var byId = {};
    list.forEach(function (a, i) { byId[a.id] = i; });
    var added = 0, replaced = 0;
    (incoming || []).forEach(function (raw) {
      var rec = sanitize(raw);
      if (!rec) return;
      if (byId[rec.id] !== undefined) {
        list[byId[rec.id]] = rec;
        replaced++;
      } else {
        byId[rec.id] = list.length;
        list.push(rec);
        added++;
      }
    });
    return { list: sortActivities(list), added: added, replaced: replaced };
  }

  // Defensive: imported JSON is user-supplied and may be hand-edited.
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var series = sanitizeSeries(raw.series);
    if (!series) return null;
    var rec = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : null,
      name: String(raw.name || 'Activity').slice(0, 200),
      sport: raw.sport ? String(raw.sport).slice(0, 60) : null,
      startTime: num(raw.startTime) ? raw.startTime : null,
      addedAt: num(raw.addedAt) ? raw.addedAt : 0,
      durationSec: num(raw.durationSec) ? Math.round(raw.durationSec) : series.n - 1,
      distanceM: num(raw.distanceM) ? raw.distanceM : (series.d ? series.d[series.d.length - 1] : 0),
      source: raw.source ? String(raw.source).slice(0, 20) : 'import',
      series: series
    };
    if (!rec.id) rec.id = idFor(rec);
    return rec;
  }

  function sanitizeSeries(s) {
    if (!s || !Array.isArray(s.sp) || s.sp.length < 2) return null;
    if (s.sp.length > MAX_SERIES_POINTS) return null;
    var dt = num(s.dt) && s.dt > 0 ? Math.round(s.dt) : SERIES_DT;
    var count = s.sp.length;
    var sp = numbers(s.sp, count);
    var hr = Array.isArray(s.hr) ? numbers(s.hr, count) : new Array(count).fill(0);
    var d = Array.isArray(s.d) ? numbers(s.d, count) : null;
    var n = num(s.n) && s.n > 1 ? Math.round(s.n) : (count - 1) * dt + 1;
    return { dt: dt, n: n, sp: sp, hr: hr, d: d };
  }

  function numbers(arr, count) {
    var out = new Array(count);
    for (var i = 0; i < count; i++) {
      var v = arr[i];
      out[i] = num(v) ? Math.round(v) : 0;
    }
    return out;
  }

  // ---- export / import ------------------------------------------------------

  function toExport(list, nowSec) {
    return JSON.stringify({
      format: FORMAT,
      version: VERSION,
      exportedAt: num(nowSec) ? Math.round(nowSec) : null,
      activities: list
    }, null, 1);
  }

  /*
   * Accepts a full export envelope or a bare array of activities. Returns
   * { activities } or { error } — never throws.
   */
  function fromExport(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { error: 'Not valid JSON: ' + e.message };
    }
    var raw = Array.isArray(data) ? data : (data && data.activities);
    if (!Array.isArray(raw)) {
      return { error: 'No "activities" list found in that file.' };
    }
    if (data && !Array.isArray(data) && data.format && data.format !== FORMAT) {
      return { error: 'Unrecognized export format "' + String(data.format).slice(0, 40) + '".' };
    }
    var activities = [];
    var skipped = 0;
    raw.forEach(function (r) {
      var rec = sanitize(r);
      if (rec) activities.push(rec); else skipped++;
    });
    if (!activities.length) return { error: 'That file contained no usable activities.' };
    return { activities: activities, skipped: skipped };
  }

  // ---- persistence ----------------------------------------------------------
  //
  // By default the history lives in localStorage (the original, standalone
  // behaviour, still used to pick up pre-Outpost data). Outpost installs a
  // backend that routes reads and writes through its synced store instead.

  var backend = null;

  /*
   * backend: { loadActivities(): any[], saveActivities(list): void,
   *            loadSettings(): object|null, saveSettings(settings): void }
   */
  function setBackend(b) { backend = b || null; }

  function load() {
    if (backend) {
      try {
        return sortActivities((backend.loadActivities() || []).map(sanitize).filter(Boolean));
      } catch (e) {
        return [];
      }
    }
    return loadFromLocalStorage();
  }

  function loadFromLocalStorage() {
    try {
      var text = global.localStorage && global.localStorage.getItem(KEY);
      if (!text) return [];
      var parsed = JSON.parse(text);
      var raw = Array.isArray(parsed) ? parsed : (parsed && parsed.activities) || [];
      return sortActivities(raw.map(sanitize).filter(Boolean));
    } catch (e) {
      return [];
    }
  }

  function save(list) {
    if (backend) {
      try {
        backend.saveActivities(list);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: 'Could not save history: ' + (e && e.message) };
      }
    }
    try {
      global.localStorage.setItem(KEY, JSON.stringify({
        format: FORMAT, version: VERSION, activities: list
      }));
      return { ok: true };
    } catch (e) {
      var full = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
      return { ok: false, error: full
        ? 'Browser storage is full — export your history, then remove older activities.'
        : 'Could not save to browser storage: ' + (e && e.message) };
    }
  }

  function loadSettings() {
    if (backend) {
      try { return backend.loadSettings() || null; } catch (e) { return null; }
    }
    return loadSettingsFromLocalStorage();
  }

  function loadSettingsFromLocalStorage() {
    try {
      var text = global.localStorage && global.localStorage.getItem(SETTINGS_KEY);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      return null;
    }
  }

  function saveSettings(settings) {
    if (backend) {
      try { backend.saveSettings(settings); } catch (e) { /* ignore */ }
      return;
    }
    try {
      global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) { /* private mode */ }
  }

  var api = {
    KEY: KEY, SETTINGS_KEY: SETTINGS_KEY, FORMAT: FORMAT, VERSION: VERSION,
    SERIES_DT: SERIES_DT,
    compressSeries: compressSeries, expandSeries: expandSeries,
    activityKey: activityKey, idFor: idFor,
    sortActivities: sortActivities, mergeActivities: mergeActivities,
    sanitize: sanitize,
    toExport: toExport, fromExport: fromExport,
    load: load, save: save, loadSettings: loadSettings, saveSettings: saveSettings,
    setBackend: setBackend,
    loadFromLocalStorage: loadFromLocalStorage, loadSettingsFromLocalStorage: loadSettingsFromLocalStorage
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.trackerStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
