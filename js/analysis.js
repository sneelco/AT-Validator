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

  // Time-weighted stats for samples within [startT, endT). Speed-aware: when
  // samples carry a speed (m/s), the same dt weighting accumulates it too.
  function rangeStats(samples, startT, endT, threshold) {
    var sumHrDt = 0, sumDt = 0, timeOver = 0;
    var sumSpeedDt = 0, speedDt = 0;
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
      if (s.speed !== undefined && s.speed !== null) {
        sumSpeedDt += s.speed * dt;
        speedDt += dt;
      }
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
      pctUnder: 100 * (sumDt - timeOver) / sumDt,
      avgSpeed: speedDt > 0 ? sumSpeedDt / speedDt : null,
      speedCoverage: speedDt / sumDt
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

  // Resample HR to 1 Hz (tracking gap-interpolated points) and smooth with a
  // rolling median. Shared by plateau detection and the evaluation layer.
  function prepareSeries(samples) {
    var P = PLATEAU;
    if (!samples || samples.length < 2) return null;
    var t0 = samples[0].t;
    var total = samples[samples.length - 1].t - t0;
    var n = Math.floor(total) + 1;
    if (n < 2) return null;

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

    var sm = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var lo = Math.max(0, i - P.SMOOTH_HALF_SEC);
      var hi = Math.min(n, i + P.SMOOTH_HALF_SEC + 1);
      sm[i] = median(hr.subarray(lo, hi));
    }
    return { hr: hr, sm: sm, synth: synth, n: n, t0: t0 };
  }

  function detectBaselineInner(samples) {
    var P = PLATEAU;
    var series = prepareSeries(samples);
    if (!series) return { confidence: 'none' };
    var n = series.n, sm = series.sm, synth = series.synth;
    if (n < P.WARMUP_MIN_SEC + P.WIN_SEC) return { confidence: 'none' };

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

  /*
   * Evaluation layer: turn analyzeWindow's numbers into a layered,
   * findings-based verdict. Primary metric is Pa:HR decoupling (speed per
   * heartbeat, first half vs second half) when speed covers enough of the
   * window; otherwise HR-only drift. Pure function; never throws.
   */
  var EVAL = {
    AEROBIC_MAX_PCT: 3.5,      // decoupling below this → aerobic (green)
    BORDERLINE_MAX_PCT: 6,     // …up to this → borderline (amber); above → red
    EDGE_TOL_PCT: 0.5,         // within this of a band edge → boundary finding
    SPEED_COVERAGE_MIN: 0.8,   // speed must cover this fraction for Pa:HR
    PACE_SLOW_WARN_PCT: 2,     // 2nd half this much slower → warning
    PACE_CV_CAVEAT: 0.12,      // smoothed-pace CV above this → erratic-pace caveat
    SHORT_WINDOW_SEC: 45 * 60, // analyzed window below this → caveat
    COVERAGE_CAVEAT: 0.95,     // HR coverage in (0.90, 0.95) → caveat
    FINAL_SLOPE_MAX: 0.3,      // bpm/min over final third → not-plateaued finding
    LATE_FRAC: 0.2,            // "final 20% of the window"
    LATE_CONC_MIN: 0.5,        // >50% of over-threshold time in that slice
    LATE_MIN_OVER_SEC: 120,    // ignore late-concentration below this much total
    BREAK_RISE_BPM: 3,         // sustained rise above plateau that counts as a break
    BREAK_SUSTAIN_SEC: 120,
    BREAK_ONSET_BPM: 0.5,      // backtrack from the crossing to where the rise began
    XCHECK_DIFF_PCT: 2.5,      // Pa:HR vs HR-only disagreement that voids Pa:HR
    BASELINE_MISMATCH_BPM: 2
  };

  var SEVERITY_RANK = { warning: 0, caveat: 1, info: 2 };

  /*
   * Speed-source trust matrix, keyed on file provenance rather than sport:
   * a treadmill FIT written by Peloton carries true belt speed; the same
   * workout recorded natively on a watch carries a wrist-accelerometer
   * estimate. IDs are from the official FIT SDK profile.
   */
  var SPEED_EQUIPMENT_IDS = {
    340: 1,  // Peloton
    111: 1,  // Technogym
    266: 1,  // Precor
    85: 1,   // Woodway
    56: 1,   // Star Trac
    314: 1,  // True Fitness
    122: 1,  // Johnson Health Tech
    40: 1,   // Concept2
    73: 1,   // Wattbike
    260: 1,  // Zwift (trainer-derived virtual speed)
    89: 1,   // Tacx
    67: 1,   // Bkool
    121: 1,  // Kinetic
    282: 1   // The Sufferfest
  };

  function assessSpeedTrust(provenance) {
    if (!provenance) {
      return { trusted: false, source: 'unknown', label: 'unknown speed source',
        reason: 'no recording-device metadata in this file' };
    }
    if (provenance.manufacturerId !== null && provenance.manufacturerId !== undefined &&
        SPEED_EQUIPMENT_IDS[provenance.manufacturerId]) {
      var maker = provenance.manufacturer || 'fitness equipment';
      return { trusted: true, source: 'equipment',
        label: 'belt/machine speed (' + maker + ')',
        reason: 'written by ' + maker + ', which reports true belt/machine speed' };
    }
    if (provenance.hasGps) {
      return { trusted: true, source: 'gps', label: 'GPS',
        reason: 'outdoor activity with GPS fixes' };
    }
    if (provenance.manufacturer) {
      return { trusted: false, source: 'watch-estimate',
        label: 'watch estimate (accelerometer)',
        reason: 'indoor recording by ' + provenance.manufacturer +
          ' — speed is a wrist-accelerometer estimate, not measured' };
    }
    return { trusted: false, source: 'unknown', label: 'unknown speed source',
      reason: 'unrecognized recording device' +
        (provenance.manufacturerId !== null && provenance.manufacturerId !== undefined
          ? ' (manufacturer #' + provenance.manufacturerId + ')' : '') +
        ' and no GPS fixes' };
  }

  /*
   * Some equipment (Peloton among them) writes no per-record speed, only
   * cumulative distance. Derive speed in place from distance deltas so the
   * decoupling math has a channel to work with; the derived speed inherits
   * the distance channel's provenance. Returns the number of samples filled.
   */
  function deriveSpeedFromDistance(samples) {
    if (!samples || samples.length < 2) return 0;
    var withSpeed = 0, withDist = 0;
    for (var i = 0; i < samples.length; i++) {
      if (samples[i].speed !== undefined && samples[i].speed !== null) withSpeed++;
      if (samples[i].distance !== undefined && samples[i].distance !== null) withDist++;
    }
    // Only derive when the speed channel is essentially absent but distance is rich.
    if (withSpeed > samples.length * 0.2 || withDist < samples.length * 0.8) return 0;
    var filled = 0;
    for (var j = 0; j < samples.length; j++) {
      var a = samples[j];
      var b = samples[Math.min(j + 1, samples.length - 1)];
      if (j === samples.length - 1) { a = samples[j - 1]; b = samples[j]; }
      if (a.distance === undefined || b.distance === undefined) continue;
      var dt = b.t - a.t;
      if (dt <= 0 || dt > MAX_GAP) continue;
      var ds = b.distance - a.distance;
      if (ds < 0) continue;
      samples[j].speed = ds / dt;
      filled++;
    }
    return filled;
  }

  function evaluate(samples, result, settings) {
    try {
      return evaluateInner(samples, result, settings || {});
    } catch (e) {
      var v = result && result.driftPct !== null && result.driftPct !== undefined ? result.driftPct : 0;
      return { verdict: 'insufficient', band: null, confidence: 'low', findings: [],
        primary: { value: v, method: 'hr-only' } };
    }
  }

  function evaluateInner(samples, result, settings) {
    var E = EVAL;
    var ws = result.windowStart, we = result.windowEnd;
    var len = we - ws;
    var mid = ws + len / 2;
    var h1 = rangeStats(samples, ws, mid, result.threshold);
    var h2 = rangeStats(samples, mid, we, result.threshold);
    var findings = [];

    // ---- primary metric ---------------------------------------------------
    // Pa:HR needs speed that both exists and can be believed: treadmill /
    // indoor "speed" is a wrist-accelerometer estimate, not belt speed, and a
    // large disagreement with the HR trace voids it from either source.
    var trust = settings.speedTrust || null;
    var speedTrusted = trust ? !!trust.trusted : settings.speedTrusted !== false;
    var hrOnly = result.driftPct !== null ? result.driftPct : 0;
    var speedOk = result.window.speedCoverage > E.SPEED_COVERAGE_MIN &&
      h1 && h2 && h1.avgSpeed !== null && h2.avgSpeed !== null &&
      h1.avgSpeed > 0.1 && h1.avg > 0;
    var paHr = null;
    if (speedOk) {
      var eff1 = h1.avgSpeed / h1.avg;
      var eff2 = h2.avgSpeed / h2.avg;
      paHr = 100 * (eff1 - eff2) / eff1;
    }

    var primary, secondary = null;
    if (!speedOk) {
      primary = { value: hrOnly, method: 'hr-only', reason: 'no-speed' };
    } else if (!speedTrusted) {
      primary = { value: hrOnly, method: 'hr-only', reason: 'untrusted-speed' };
      secondary = { value: paHr, method: 'pa:hr', untrusted: true };
      var why = trust
        ? 'Speed here is a ' + trust.label + ' — ' + trust.reason
        : 'Indoor/treadmill activity — watch "speed" is a wrist-accelerometer estimate, not belt speed';
      findings.push({ severity: 'info', code: 'speed-untrusted',
        text: why + '. The verdict uses HR-only drift; estimated-pace decoupling (' +
          (paHr >= 0 ? '+' : '') + paHr.toFixed(1) + '%) is shown for reference only.' });
    } else {
      primary = { value: paHr, method: 'pa:hr' };
    }

    // Cross-check regardless of source: a large Pa:HR vs HR-only split means
    // either pace really changed that much or the speed channel is bad —
    // either way Pa:HR cannot be trusted as the primary.
    if (speedOk && Math.abs(paHr - hrOnly) > E.XCHECK_DIFF_PCT) {
      if (primary.method !== 'hr-only') {
        primary = { value: hrOnly, method: 'hr-only', reason: 'disagreement' };
      }
      if (!secondary) secondary = { value: paHr, method: 'pa:hr', untrusted: !speedTrusted };
      var speedChange = 100 * (h2.avgSpeed / h1.avgSpeed - 1);
      // Include the computed half averages so the claim can be eyeballed
      // against the chart — a bare percentage is not checkable.
      var halves = fmtHalfSpeeds(h1.avgSpeed, h2.avgSpeed, settings.units, settings.displayMode);
      findings.push({ severity: 'warning', code: 'speed-hr-disagree',
        text: 'Pa:HR (' + (paHr >= 0 ? '+' : '') + paHr.toFixed(1) + '%) and HR-only drift (' +
          (hrOnly >= 0 ? '+' : '') + hrOnly.toFixed(1) + '%) disagree by ' +
          Math.abs(paHr - hrOnly).toFixed(1) + ' points — the speed channel implies the second ' +
          'half was ' + Math.abs(speedChange).toFixed(1) + '% ' +
          (speedChange < 0 ? 'slower' : 'faster') + ' (' + halves + '). Either pace genuinely ' +
          'changed that much or the speed data is bad; the verdict falls back to HR-only drift.' });
    }

    if (result.verdict === 'insufficient') {
      return { verdict: 'insufficient', band: null, confidence: 'low', findings: [],
        primary: primary, secondary: secondary };
    }

    var band = primary.value < E.AEROBIC_MAX_PCT ? 'green'
      : primary.value <= E.BORDERLINE_MAX_PCT ? 'amber' : 'red';
    var verdict = band === 'green' ? 'aerobic' : band === 'amber' ? 'borderline' : 'above-threshold';

    // Band edge: don't over-read a value sitting on a boundary.
    [E.AEROBIC_MAX_PCT, E.BORDERLINE_MAX_PCT].forEach(function (edge) {
      if (Math.abs(primary.value - edge) <= E.EDGE_TOL_PCT) {
        findings.push({ severity: 'caveat', code: 'band-edge',
          text: 'Decoupling ' + primary.value.toFixed(1) + '% sits within ' + E.EDGE_TOL_PCT +
            '% of the ' + edge + '% band edge — treat the band as approximate, not a hard call.' });
      }
    });

    // ---- precondition findings -------------------------------------------
    if (speedOk) {
      // Second-half slowdown flatters HR drift (partly self-corrected by Pa:HR).
      var slowPct = 100 * (h1.avgSpeed / h2.avgSpeed - 1);
      if (slowPct > E.PACE_SLOW_WARN_PCT) {
        findings.push({ severity: 'warning', code: 'pace-slowed',
          text: 'Second-half pace was ' + slowPct.toFixed(1) + '% slower than the first half — ' +
            'slowing to hold heart rate down understates HR drift. Pa:HR partly corrects for this, ' +
            'but a steady-pace retest is more trustworthy.' });
      }
      // Erratic pacing (terrain, stops) makes the ratio noisy.
      var cv = paceCv(samples, ws, we);
      if (cv !== null && cv > E.PACE_CV_CAVEAT) {
        findings.push({ severity: 'caveat', code: 'pace-erratic',
          text: 'Pace varied widely across the window (CV ' + Math.round(cv * 100) +
            '%) — decoupling is noisier on uneven terrain or with stops.' });
      }
    }

    if (len < E.SHORT_WINDOW_SEC) {
      findings.push({ severity: 'caveat', code: 'short-window',
        text: 'Analyzed window is ' + Math.round(len / 60) + ' minutes — drift is understated vs ' +
          'the 60-minute protocol; treat a green result gently.' });
    }

    if (result.coverage > 0.90 && result.coverage < E.COVERAGE_CAVEAT) {
      findings.push({ severity: 'caveat', code: 'coverage',
        text: 'Heart-rate data covers only ' + Math.round(result.coverage * 100) +
          '% of the window (recording gaps).' });
    }

    if (settings.baselineOverride != null && settings.detectedBaseline != null &&
        Math.abs(settings.baselineOverride - settings.detectedBaseline) > E.BASELINE_MISMATCH_BPM) {
      findings.push({ severity: 'warning', code: 'baseline-mismatch',
        text: 'Manual baseline ' + Math.round(settings.baselineOverride) + ' bpm differs from the ' +
          'detected plateau ' + Math.round(settings.detectedBaseline) +
          ' bpm — threshold-relative stats follow the manual value.' });
    }

    // ---- trend-shape findings --------------------------------------------
    var series = prepareSeries(samples);
    if (series) {
      // Series indices are seconds since the first sample.
      var iws = Math.max(Math.round(ws - series.t0), 0);
      var iwe = Math.min(Math.round(we - series.t0), series.n);

      // Final-third slope: still climbing at the end?
      var thirdStart = Math.round(iws + (iwe - iws) * 2 / 3);
      if (iwe - thirdStart > 60) {
        var slope = theilSen(series.sm, thirdStart, iwe, 5) * 60;
        if (slope > E.FINAL_SLOPE_MAX) {
          findings.push({ severity: 'warning', code: 'not-plateaued',
            text: 'Heart rate was still rising ~' + slope.toFixed(1) + ' bpm/min over the final ' +
              'third of the window — it had not plateaued, and a longer window would likely read worse.' });
        }
      }

      // Plateau-then-break: the durability signal.
      var brk = findBreakpoint(series, iws, iwe);
      if (brk) {
        findings.push({ severity: 'info', code: 'break-point', breakSec: brk.breakSec,
          plateauHr: brk.plateauHr,
          text: 'Held ~' + Math.round(brk.plateauHr) + ' bpm until ~' + fmtMinSec(brk.breakSec) +
            ', then rose ' + (brk.riseBpm >= 0 ? '+' : '') + Math.round(brk.riseBpm) +
            ' bpm by the window end — that breakpoint is the durability limit at this effort.' });
      }
    }

    // Late concentration of over-threshold time.
    var lateStart = we - len * E.LATE_FRAC;
    var late = rangeStats(samples, lateStart, we, result.threshold);
    if (late && result.window.timeOver >= E.LATE_MIN_OVER_SEC &&
        late.timeOver / result.window.timeOver > E.LATE_CONC_MIN) {
      findings.push({ severity: 'info', code: 'late-breakdown',
        text: Math.round(100 * late.timeOver / result.window.timeOver) +
          '% of time over threshold falls in the final ' + Math.round(len * E.LATE_FRAC / 60) +
          ' minutes — a late-run breakdown rather than drift spread across the hour.' });
    }

    findings.sort(function (a, b) { return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]; });

    var confidence = 'high';
    if (findings.some(function (f) { return f.severity === 'caveat'; })) confidence = 'medium';
    if (findings.some(function (f) { return f.severity === 'warning'; })) confidence = 'low';

    return { verdict: verdict, band: band, confidence: confidence, findings: findings,
      primary: primary, secondary: secondary };
  }

  // Coefficient of variation of smoothed pace (s per meter) over the window.
  function paceCv(samples, ws, we) {
    var speeds = [];
    for (var i = lowerBound(samples, ws); i < samples.length && samples[i].t < we; i++) {
      var v = samples[i].speed;
      if (v !== undefined && v !== null && v > 0.3) speeds.push(v);
    }
    if (speeds.length < 30) return null;
    var paces = [];
    for (var j = 0; j < speeds.length; j++) {
      var lo = Math.max(0, j - 7), hi = Math.min(speeds.length, j + 8);
      paces.push(1 / median(speeds.slice(lo, hi)));
    }
    var mean = paces.reduce(function (a, b) { return a + b; }, 0) / paces.length;
    var varsum = paces.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / paces.length;
    return Math.sqrt(varsum) / mean;
  }

  // Find a settled plateau inside [iws, iwe) and the point where HR breaks
  // sustainably above it. Reuses the plateau qualifying machinery.
  function findBreakpoint(series, iws, iwe) {
    var P = PLATEAU, E = EVAL;
    var sm = series.sm, synth = series.synth;
    var plateauHr = null, plateauEnd = null;
    for (var start = iws; start + P.WIN_SEC <= iwe; start += P.STEP_SEC) {
      var end = start + P.WIN_SEC;
      var synthCount = 0;
      for (var g = start; g < end; g++) synthCount += synth[g];
      if (synthCount / P.WIN_SEC > P.MAX_SYNTH_FRAC) continue;
      var slope = theilSen(sm, start, end, 5) * 60;
      if (Math.abs(slope) >= P.SLOPE_MAX || iqrOf(sm, start, end) >= P.IQR_MAX) continue;
      plateauHr = median(sm.subarray(start, end));
      plateauEnd = end;
      break;
    }
    if (plateauHr === null) return null;

    // First index after the plateau where HR stays above plateau + BREAK_RISE
    // for BREAK_SUSTAIN seconds.
    for (var i = plateauEnd; i < iwe; i++) {
      if (sm[i] > plateauHr + E.BREAK_RISE_BPM) {
        var sustained = true;
        var stop = Math.min(i + E.BREAK_SUSTAIN_SEC, iwe);
        if (stop - i < E.BREAK_SUSTAIN_SEC) { sustained = false; }
        for (var k = i; sustained && k < stop; k++) {
          if (sm[k] <= plateauHr + E.BREAK_RISE_BPM) sustained = false;
        }
        if (sustained) {
          // The crossing of plateau+3 lags the actual inflection; report the
          // onset — the last moment HR was still at the plateau level.
          var onset = i;
          while (onset > plateauEnd && sm[onset - 1] > plateauHr + E.BREAK_ONSET_BPM) onset--;
          return { plateauHr: plateauHr, breakSec: onset, riseBpm: sm[iwe - 1] - plateauHr };
        }
      }
    }
    return null;
  }

  // "9:05 \u2192 8:41 /mi" (pace) or "11.2 \u2192 11.5 mph" (speed) for the
  // 1st- and 2nd-half average speeds, in the caller's display units.
  function fmtHalfSpeeds(v1, v2, units, displayMode) {
    var imperial = units === 'imperial';
    if (displayMode === 'speed') {
      var f = imperial ? 2.236936 : 3.6;
      return (v1 * f).toFixed(1) + ' \u2192 ' + (v2 * f).toFixed(1) + (imperial ? ' mph' : ' km/h');
    }
    var per = imperial ? 1609.344 : 1000;
    return fmtMinSec(per / v1) + ' \u2192 ' + fmtMinSec(per / v2) + (imperial ? ' /mi' : ' /km');
  }

  function fmtMinSec(sec) {
    sec = Math.round(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  var api = { rangeStats: rangeStats, analyzeWindow: analyzeWindow, lowerBound: lowerBound,
    detectBaseline: detectBaseline, evaluate: evaluate,
    assessSpeedTrust: assessSpeedTrust, deriveSpeedFromDistance: deriveSpeedFromDistance,
    SPEED_EQUIPMENT_IDS: SPEED_EQUIPMENT_IDS,
    PLATEAU: PLATEAU, EVAL: EVAL, MAX_GAP: MAX_GAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.analysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
