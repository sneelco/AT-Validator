/*
 * Synthetic demo activity so the tool is usable before you upload anything:
 * 90 minutes — a 10-minute warm-up ramp, ~70 minutes of steady work with
 * gradual cardiac drift and noise, then a short cool-down.
 */
(function (global) {
  'use strict';

  function generateDemo() {
    // Deterministic PRNG so the demo looks the same on every load.
    var seed = 42;
    function rnd() {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    }

    var records = [];
    var t0 = Math.floor(Date.UTC(2026, 6, 18, 6, 30, 0) / 1000);
    var duration = 90 * 60;
    var hrNoise = 0;
    for (var t = 0; t <= duration; t += 1) {
      var base;
      if (t < 600) {
        base = 105 + (142 - 105) * (t / 600);                      // warm-up ramp
      } else if (t < 5100) {
        var work = (t - 600) / 4500;
        base = 142 + 9 * work;                                     // steady + drift
        base += 3 * Math.sin(t / 420);                             // terrain undulation
        if (t > 2400 && t < 2700) base += 6 * Math.sin((t - 2400) / 300 * Math.PI); // one hill
      } else {
        base = 148 - (t - 5100) / 300 * 30;                        // cool-down
      }
      hrNoise = hrNoise * 0.92 + (rnd() - 0.5) * 2.4;
      records.push({ t: t0 + t, hr: Math.round(base + hrNoise) });
    }
    return { records: records, sports: ['Running (demo)'] };
  }

  var api = { generateDemo: generateDemo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.demo = api;
})(typeof window !== 'undefined' ? window : globalThis);
