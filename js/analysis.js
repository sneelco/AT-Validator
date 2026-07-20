/*
 * Aerobic Threshold (AeT) drift analysis.
 *
 * Method (per Scott Johnston / Uphill Athlete's AeT field test): hold a steady
 * effort at your suspected AeT heart rate for 60 minutes. If heart rate rises
 * more than 5% above the rate at the start of the test, the effort was above
 * your aerobic threshold.
 *
 * Samples are { t: seconds elapsed, hr: bpm }, sorted by t. All statistics are
 * time-weighted: each sample "owns" the interval until the next sample, capped
 * at MAX_GAP so recording pauses don't skew averages.
 */
(function (global) {
  'use strict';

  var MAX_GAP = 30; // seconds — cap per-sample weight across recording gaps

  // Time-weighted stats for samples within [startT, endT).
  function rangeStats(samples, startT, endT, threshold) {
    var sumHrDt = 0, sumDt = 0, timeOver = 0;
    var min = Infinity, max = -Infinity;
    var i = lowerBound(samples, startT);
    for (; i < samples.length && samples[i].t < endT; i++) {
      var s = samples[i];
      var next = i + 1 < samples.length ? Math.min(samples[i + 1].t, endT) : endT;
      var dt = Math.min(Math.max(next - s.t, 0), MAX_GAP);
      if (dt === 0 && next > s.t) dt = 0; // fully clipped
      sumHrDt += s.hr * dt;
      sumDt += dt;
      if (threshold !== undefined && s.hr > threshold) timeOver += dt;
      if (s.hr < min) min = s.hr;
      if (s.hr > max) max = s.hr;
    }
    if (sumDt === 0) return null;
    return {
      avg: sumHrDt / sumDt,
      min: min,
      max: max,
      seconds: sumDt,
      timeOver: timeOver,
      timeUnder: sumDt - timeOver,
      pctOver: 100 * timeOver / sumDt,
      pctUnder: 100 * (sumDt - timeOver) / sumDt
    };
  }

  // First index with samples[i].t >= t (binary search).
  function lowerBound(samples, t) {
    var lo = 0, hi = samples.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (samples[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /*
   * Full analysis of a window placed at windowStart.
   * settings: { windowLen (s), thresholdPct, splitLen (s), smoothSec, endSec }
   */
  function analyzeWindow(samples, windowStart, settings) {
    if (!samples.length) return null;
    var ws = windowStart;
    var we = ws + settings.windowLen;
    var t0 = samples[0].t;
    var tEnd = samples[samples.length - 1].t;

    // Baseline: time-weighted average HR over the first `smoothSec` of the
    // window (a single-sample baseline would be hostage to HR monitor noise).
    // A manual override (settings.baselineOverride, bpm) takes precedence.
    var baseStats = rangeStats(samples, ws, Math.min(ws + settings.smoothSec, we));
    var baselineAuto = baseStats ? baseStats.avg : null;
    var baseline = settings.baselineOverride != null ? settings.baselineOverride : baselineAuto;
    if (baseline === null) return null;
    var threshold = baseline * (1 + settings.thresholdPct / 100);

    var win = rangeStats(samples, ws, we, threshold);
    if (!win) return null;

    // "After the 60 minutes": average of the final endSec vs. baseline.
    var endStats = rangeStats(samples, Math.max(we - settings.endSec, ws), we);
    var endRisePct = endStats ? 100 * (endStats.avg - baseline) / baseline : null;
    var endRiseBpm = endStats ? endStats.avg - baseline : null;

    // Classic decoupling proxy: 2nd-half average vs. 1st-half average.
    var mid = ws + settings.windowLen / 2;
    var firstHalf = rangeStats(samples, ws, mid);
    var secondHalf = rangeStats(samples, mid, we);
    var driftPct = (firstHalf && secondHalf)
      ? 100 * (secondHalf.avg - firstHalf.avg) / firstHalf.avg : null;

    // Coverage: how much of the window actually has data.
    var coverage = win.seconds / settings.windowLen;

    // Splits.
    var splits = [];
    for (var st = ws; st < we - 1e-9; st += settings.splitLen) {
      var se = Math.min(st + settings.splitLen, we);
      var stats = rangeStats(samples, st, se, threshold);
      splits.push({
        start: st,
        end: se,
        partial: (se - st) < settings.splitLen - 1e-9,
        stats: stats,
        risePct: stats ? 100 * (stats.avg - baseline) / baseline : null,
        headroomBpm: stats ? threshold - stats.avg : null,
        headroomPct: stats ? 100 * (threshold - stats.avg) / threshold : null
      });
    }

    var verdict;
    if (coverage < 0.9 || (tEnd - t0) < settings.windowLen * 0.98) {
      verdict = 'insufficient';
    } else if (endRisePct === null) {
      verdict = 'insufficient';
    } else if (endRisePct > settings.thresholdPct) {
      verdict = 'fail';
    } else {
      verdict = 'pass';
    }

    return {
      windowStart: ws,
      windowEnd: we,
      baseline: baseline,
      threshold: threshold,
      window: win,
      endRisePct: endRisePct,
      endRiseBpm: endRiseBpm,
      endAvg: endStats ? endStats.avg : null,
      driftPct: driftPct,
      coverage: coverage,
      headroomBpm: threshold - win.avg,
      headroomPct: 100 * (threshold - win.avg) / threshold,
      splits: splits,
      verdict: verdict
    };
  }

  var api = { rangeStats: rangeStats, analyzeWindow: analyzeWindow, lowerBound: lowerBound, MAX_GAP: MAX_GAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.analysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
