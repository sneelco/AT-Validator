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
      var speed = 3.2 + 0.15 * Math.sin(t / 300) + (rnd() - 0.5) * 0.12;
      if (t >= 5100) speed = Math.max(speed - (t - 5100) / 300 * 1.6, 1.2); // cool-down jog
      records.push({ t: t0 + t, hr: Math.round(base + hrNoise), speed: +speed.toFixed(3) });
    }
    return {
      records: records,
      sports: ['Running (demo)'],
      provenance: { manufacturerId: null, manufacturer: null, productId: null,
        product: null, sport: 'Running', subSport: null, hasGps: true }
    };
  }

  /*
   * Demo block for the tracker: six weekly Zone 2 run/walk sessions with the
   * progression the tool is meant to reveal — run periods lengthening, walk
   * breaks fewer and shorter, pace creeping up, heart rate easing down.
   * Deterministic (fixed dates and seeds), so adding it twice updates the same
   * six activities instead of piling up duplicates.
   */
  function generateZone2Block() {
    var out = [];
    var base = Math.floor(Date.UTC(2026, 5, 7, 6, 30, 0) / 1000); // Sundays from 7 Jun 2026
    for (var i = 0; i < 6; i++) out.push(generateZone2Run(i, base + i * 7 * 86400));
    return out;
  }

  function generateZone2Run(i, startTime) {
    var MPH = 0.44704;
    var seed = 1009 + i * 7717;
    function rnd() {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    }

    var runSpeed = (4.9 + 0.08 * i) * MPH;   // 4.9 → 5.3 mph
    var walkSpeed = 3.1 * MPH;               // below the 4 mph default threshold
    var warmup = 300, cooldown = 240;        // opening and closing walks
    var runLen = Math.round((4 + 1.5 * i) * 60);
    var walkLen = Math.round(90 - 6 * i);
    var total = (62 + 3 * i) * 60;

    var records = [];
    var dist = 0, speed = walkSpeed, hr = 104;
    for (var t = 0; t <= total; t++) {
      var running;
      if (t < warmup || t >= total - cooldown) {
        running = false;
      } else {
        running = ((t - warmup) % (runLen + walkLen)) < runLen;
      }
      var targetSpeed = (running ? runSpeed : walkSpeed) + (rnd() - 0.5) * 0.06;
      speed += (targetSpeed - speed) * 0.15;                 // no instant jumps
      var targetHr = (running ? 145 - 0.8 * i : 120 - 0.5 * i) + 4 * (t / total);
      hr += (targetHr - hr) * 0.02 + (rnd() - 0.5) * 0.6;
      dist += speed;
      records.push({ t: startTime + t, hr: Math.round(hr),
        speed: +speed.toFixed(3), distance: +dist.toFixed(2) });
    }
    return {
      records: records,
      name: 'Demo Zone 2 run ' + (i + 1),
      sports: ['Running'],
      provenance: { manufacturerId: null, manufacturer: null, productId: null,
        product: null, sport: 'Running', subSport: null, hasGps: true }
    };
  }

  var api = { generateDemo: generateDemo, generateZone2Block: generateZone2Block };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.demo = api;
})(typeof window !== 'undefined' ? window : globalThis);
