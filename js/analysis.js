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

  /*
   * Automatic baseline detection: find the first "settled" plateau after the
   * warm-up ramp. Pure function — never throws, degrades to
   * { confidence: 'none' } whenever no clear plateau exists.
   */
  var PLATEAU = {
    SMOOTH_HALF_SEC: 10,    // rolling-median half-width → ~21 s window
    WARMUP_MIN_SEC: 300,    // never scan before minute 5
    FLAT_TOL_BPM: 3,        // ramp counts as flattened within this of the next-2-min level
    FLAT_LOOKAHEAD_SEC: 120,
    WIN_SEC: 300,           // sliding candidate window
    STEP_SEC: 30,
    SLOPE_MAX: 0.3,         // bpm/min — |slope| must be below this to qualify
    IQR_MAX: 4,             // bpm — spread must be below this to qualify
    SLOPE_HIGH: 0.15,       // bpm/min — high-confidence slope bound
    STABLE_BAND_BPM: 2,     // ±bpm the next 5 min must hold for high confidence
    SCAN_LIMIT_SEC: 1500,   // report 'none' if nothing qualifies by minute 25
    MAX_SYNTH_FRAC: 0.2,    // window disqualified if >20% of it is gap-interpolated
    SYNTH_DIST_SEC: 5       // a 1 Hz point further than this from a real sample is synthetic
  };

  function median(arr) {
    var a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function percentile(sorted, p) {
    var i = p * (sorted.length - 1);
    var lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function iqrOf(arr, lo, hi) {
    var a = Array.prototype.slice.call(arr, lo, hi).sort(function (x, y) { return x - y; });
    return percentile(a, 0.75) - percentile(a, 0.25);
  }

  // Theil–Sen slope (median of pairwise slopes) on arr[lo..hi), subsampled for
  // speed. Returns bpm per second.
  function theilSen(arr, lo, hi, stride) {
    var xs = [], ys = [];
    for (var i = lo; i < hi; i += stride) { xs.push(i); ys.push(arr[i]); }
    var slopes = [];
    for (var a = 0; a < xs.length; a++) {
      for (var b = a + 1; b < xs.length; b++) {
        slopes.push((ys[b] - ys[a]) / (xs[b] - xs[a]));
      }
    }
    return slopes.length ? median(slopes) : 0;
  }

  function detectBaseline(samples) {
    try {
      return detectBaselineInner(samples);
    } catch (e) {
      return { confidence: 'none' };
    }
  }

  function detectBaselineInner(samples) {
    var P = PLATEAU;
    if (!samples || samples.length < 2) return { confidence: 'none' };
    var t0 = samples[0].t;
    var total = samples[samples.length - 1].t - t0;
    var n = Math.floor(total) + 1;
    if (n < P.WARMUP_MIN_SEC + P.WIN_SEC) return { confidence: 'none' };

    // 1a. Resample to 1 Hz (linear interpolation), tracking which points are
    // synthetic (inside a recording gap) so a gap can't fake a plateau.
    var hr = new Float64Array(n);
    var synth = new Uint8Array(n);
    var idx = 0;
    for (var s = 0; s < n; s++) {
      while (idx < samples.length - 1 && samples[idx + 1].t - t0 <= s) idx++;
      var a = samples[idx];
      var b = samples[Math.min(idx + 1, samples.length - 1)];
      var ta = a.t - t0, tb = b.t - t0;
      if (s <= ta) hr[s] = a.hr;
      else if (s >= tb) hr[s] = b.hr;
      else hr[s] = a.hr + (b.hr - a.hr) * (s - ta) / (tb - ta);
      synth[s] = Math.min(Math.abs(s - ta), Math.abs(tb - s)) > P.SYNTH_DIST_SEC ? 1 : 0;
    }

    // 1b. Rolling median — robust to HR-monitor dropout spikes.
    var sm = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var lo = Math.max(0, i - P.SMOOTH_HALF_SEC);
      var hi = Math.min(n, i + P.SMOOTH_HALF_SEC + 1);
      sm[i] = median(hr.subarray(lo, hi));
    }

    // 2. Skip the warm-up ramp: first point within FLAT_TOL of the level it
    // holds for the next two minutes, but never before minute 5.
    var scanStart = P.WARMUP_MIN_SEC;
    for (var f = 0; f + P.FLAT_LOOKAHEAD_SEC < n; f++) {
      if (Math.abs(sm[f] - median(sm.subarray(f, f + P.FLAT_LOOKAHEAD_SEC))) <= P.FLAT_TOL_BPM) {
        scanStart = Math.max(f, P.WARMUP_MIN_SEC);
        break;
      }
    }

    // 3–5. Slide a 5-minute window; take the FIRST qualifying one (the
    // protocol wants the initially-settled value, before drift accumulates).
    var lastStart = Math.min(P.SCAN_LIMIT_SEC, n - P.WIN_SEC);
    for (var start = scanStart; start <= lastStart; start += P.STEP_SEC) {
      var end = start + P.WIN_SEC;
      var synthCount = 0;
      for (var g = start; g < end; g++) synthCount += synth[g];
      if (synthCount / P.WIN_SEC > P.MAX_SYNTH_FRAC) continue;

      var slope = theilSen(sm, start, end, 5) * 60; // bpm/min
      var iqr = iqrOf(sm, start, end);
      if (Math.abs(slope) >= P.SLOPE_MAX || iqr >= P.IQR_MAX) continue;

      var baseline = median(sm.subarray(start, end));

      // 6. Confidence: near-zero slope AND the next contiguous 5 minutes
      // holding within ±2 bpm of the baseline → high; otherwise low.
      var confidence = 'low';
      if (Math.abs(slope) < P.SLOPE_HIGH && end + P.WIN_SEC <= n) {
        var stable = true;
        for (var q = end; q < end + P.WIN_SEC; q++) {
          if (Math.abs(sm[q] - baseline) > P.STABLE_BAND_BPM) { stable = false; break; }
        }
        if (stable) confidence = 'high';
      }

      return {
        confidence: confidence,
        baseline: baseline,
        windowStart: start,
        windowEnd: end,
        slopeBpmPerMin: slope,
        iqr: iqr
      };
    }
    return { confidence: 'none' };
  }

  var api = { rangeStats: rangeStats, analyzeWindow: analyzeWindow, lowerBound: lowerBound,
    detectBaseline: detectBaseline, PLATEAU: PLATEAU, MAX_GAP: MAX_GAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.analysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
