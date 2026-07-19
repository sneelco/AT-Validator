/*
 * CSV fallback parser. Accepts two-column CSV: timestamp, heartrate.
 * Timestamp may be ISO-8601 (2026-07-19T06:00:00Z), Unix epoch seconds or
 * milliseconds, or plain elapsed seconds from the start of the activity.
 * A header row is detected and skipped. Extra columns are ignored.
 */
(function (global) {
  'use strict';

  function parseCsv(text) {
    var lines = text.split(/\r\n|\n|\r/);
    var records = [];
    var absolute = null; // whether timestamps are absolute (unix s) or elapsed

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var cells = line.split(/[,;\t]/).map(function (c) { return c.trim().replace(/^"|"$/g, ''); });
      if (cells.length < 2) continue;

      var hr = parseFloat(cells[1]);
      var t = parseTime(cells[0]);
      if (t === null || !isFinite(hr)) {
        // Probably a header row; skip silently only near the top.
        if (records.length === 0 && i < 5) continue;
        continue;
      }
      if (absolute === null) absolute = t.absolute;
      records.push({ t: t.value, hr: Math.round(hr) });
    }

    if (!records.length) {
      throw new Error('No "timestamp,heartrate" rows found in CSV.');
    }
    return { records: records, absolute: absolute === true };
  }

  function parseTime(str) {
    if (/^-?\d+(\.\d+)?$/.test(str)) {
      var n = parseFloat(str);
      if (n > 1e12) return { value: n / 1000, absolute: true };  // epoch ms
      if (n > 1e9) return { value: n, absolute: true };          // epoch s
      return { value: n, absolute: false };                      // elapsed s
    }
    var d = Date.parse(str);
    if (!isNaN(d)) return { value: d / 1000, absolute: true };
    // "hh:mm:ss" elapsed time
    var m = str.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) {
      var h = +m[1], mm = +m[2], ss = m[3] !== undefined ? +m[3] : null;
      return { value: ss === null ? h * 60 + mm : h * 3600 + mm * 60 + ss, absolute: false };
    }
    return null;
  }

  var api = { parseCsv: parseCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.csv = api;
})(typeof window !== 'undefined' ? window : globalThis);
