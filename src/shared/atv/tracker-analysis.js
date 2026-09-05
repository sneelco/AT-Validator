/*
 * Zone 2 tracker analysis: split an activity into walk and run periods on a
 * speed threshold, then measure the things that show whether the aerobic base
 * is improving — how many walk breaks, how long the run periods last, pace and
 * distance held over fixed windows (30/45/60/75/90 min), and the same per
 * mile.
 *
 * Everything is computed from a 1 Hz resampled track so recording intervals
 * (1 s, 4 s "smart recording", or a stored 5 s summary) all behave alike.
 * Pure functions — no DOM, no storage; the UI layer feeds samples in and
 * formats what comes back.
 */
(function (global) {
  'use strict';

  var MPH_TO_MS = 0.44704;
  var MI_M = 1609.344;
  var KM_M = 1000;
  var MAX_GAP = 30;      // s — a longer sample interval is a recording gap

  var WALK = 0, RUN = 1, PAUSE = 2;

  var DEFAULTS = {
    thresholdMs: 4 * MPH_TO_MS, // walk/run split — 4 mph by default
    minSegmentSec: 20,          // shorter periods are noise: merged into a neighbour
    smoothSec: 9,               // rolling-median width on the speed channel
    trimLeadingWalk: true,      // start the window at the first run period
    trimTrailingWalk: true,     // end the window at the last run period
    bucketStartMin: 30,         // first fixed window
    bucketStepMin: 15,          // …then every 15 minutes
    bucketTolSec: 30,           // a 59:40 window still counts as the 60-min bucket
    segmentDistance: MI_M       // per-mile segment length
  };

  function num(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  function median(arr, lo, hi) {
    var a = [];
    for (var i = lo; i < hi; i++) a.push(arr[i]);
    a.sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // ---- track construction ---------------------------------------------------

  /*
   * Resample samples ({ t, speed?, distance?, hr? }, seconds) to 1 Hz.
   * Missing channels are derived where possible: speed from distance deltas,
   * cumulative distance from integrated speed. Seconds that fall inside a
   * recording gap longer than MAX_GAP are marked and excluded from time totals.
   */
  function buildTrack(samples) {
    if (!samples || samples.length < 2) return null;
    var sorted = samples.slice().sort(function (a, b) { return a.t - b.t; });
    var t0 = sorted[0].t;
    var total = Math.floor(sorted[sorted.length - 1].t - t0);
    if (total < 2) return null;
    var n = total + 1;

    var speed = new Float64Array(n);
    var dist = new Float64Array(n);
    var hr = new Float64Array(n);
    var gap = new Uint8Array(n);

    var nSpeed = 0, nDist = 0, nHr = 0;
    for (var i = 0; i < sorted.length; i++) {
      if (num(sorted[i].speed)) nSpeed++;
      if (num(sorted[i].distance)) nDist++;
      if (num(sorted[i].hr)) nHr++;
    }
    var hasSpeed = nSpeed > sorted.length * 0.5;
    var hasDist = nDist > sorted.length * 0.5;
    var hasHr = nHr > sorted.length * 0.5;
    if (!hasSpeed && !hasDist) return null;

    var idx = 0;
    for (var s = 0; s < n; s++) {
      while (idx < sorted.length - 1 && sorted[idx + 1].t - t0 <= s) idx++;
      var a = sorted[idx];
      var b = sorted[Math.min(idx + 1, sorted.length - 1)];
      var ta = a.t - t0, tb = b.t - t0;
      var f = tb > ta ? clamp((s - ta) / (tb - ta), 0, 1) : 0;
      speed[s] = blend(a.speed, b.speed, f);
      dist[s] = blend(a.distance, b.distance, f);
      hr[s] = blend(a.hr, b.hr, f);
      gap[s] = (tb - ta > MAX_GAP && s > ta && s < tb) ? 1 : 0;
    }

    if (hasDist) {
      // Cumulative distance must never go backwards; rebase to zero.
      var base = dist[0];
      var run = 0;
      for (var d = 0; d < n; d++) {
        var v = dist[d] - base;
        if (!(v >= run)) v = run;
        run = v;
        dist[d] = v;
      }
    }
    if (!hasSpeed) {
      for (var k = 0; k < n; k++) {
        var lo = Math.max(k - 1, 0), hi = Math.min(k + 1, n - 1);
        speed[k] = hi > lo ? (dist[hi] - dist[lo]) / (hi - lo) : 0;
      }
    }
    for (var g = 0; g < n; g++) {
      if (gap[g]) speed[g] = 0;
      if (!(speed[g] >= 0)) speed[g] = 0;
    }
    if (!hasDist) {
      var acc = 0;
      for (var e = 0; e < n; e++) {
        if (e > 0 && !gap[e]) acc += speed[e];
        dist[e] = acc;
      }
    }

    return { n: n, t0: t0, speed: speed, dist: dist, hr: hr, gap: gap,
      hasHr: hasHr, hasSpeed: hasSpeed, hasDist: hasDist };
  }

  function blend(a, b, f) {
    var av = num(a) ? a : null, bv = num(b) ? b : null;
    if (av === null && bv === null) return 0;
    if (av === null) return bv;
    if (bv === null) return av;
    return av + (bv - av) * f;
  }

  // Rolling median: robust to the one-second GPS spikes that would otherwise
  // manufacture walk breaks in the middle of a steady run.
  function smoothSpeed(speed, widthSec) {
    var n = speed.length;
    var half = Math.max(Math.floor((widthSec || 1) / 2), 0);
    var out = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = half === 0 ? speed[i]
        : median(speed, Math.max(0, i - half), Math.min(n, i + half + 1));
    }
    return out;
  }

  // ---- segmentation ---------------------------------------------------------

  /*
   * Label every second run/walk/paused on the smoothed speed, then merge away
   * periods shorter than minSegmentSec — a four-second dip below 4 mph is not a
   * walk break, and counting it as one would wreck the walk-count trend.
   */
  function segmentTrack(track, opts) {
    var n = track.n, sm = track.sm, thr = opts.thresholdMs;
    var segs = [];
    for (var i = 0; i < n; i++) {
      var type = track.gap[i] ? PAUSE : (sm[i] >= thr ? RUN : WALK);
      if (segs.length && segs[segs.length - 1].type === type) segs[segs.length - 1].end = i + 1;
      else segs.push({ type: type, start: i, end: i + 1 });
    }
    segs = mergeShort(segs, opts.minSegmentSec);
    return segs.map(function (seg) { return decorate(track, seg); });
  }

  function mergeShort(segs, minSec) {
    var frozen = {};
    while (segs.length > 1) {
      var pick = -1, shortest = Infinity;
      for (var i = 0; i < segs.length; i++) {
        var dur = segs[i].end - segs[i].start;
        if (segs[i].type === PAUSE || dur >= minSec || frozen[key(segs[i])]) continue;
        if (dur < shortest) { shortest = dur; pick = i; }
      }
      if (pick < 0) break;
      var prev = pick > 0 ? segs[pick - 1] : null;
      var next = pick < segs.length - 1 ? segs[pick + 1] : null;
      var target = null;
      if (prev && next && prev.type === next.type && prev.type !== PAUSE) {
        target = prev.type;                      // a blip inside a longer period
      } else {
        var cands = [prev, next].filter(function (s) { return s && s.type !== PAUSE; });
        if (cands.length) {
          cands.sort(function (a, b) { return (b.end - b.start) - (a.end - a.start); });
          target = cands[0].type;                // absorb into the longer neighbour
        }
      }
      if (target === null) {                     // stranded between recording gaps
        frozen[key(segs[pick])] = 1;
        continue;
      }
      segs[pick].type = target;
      segs = coalesce(segs);
    }
    return segs;
  }

  function key(seg) { return seg.start + ':' + seg.end; }

  function coalesce(segs) {
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      if (out.length && out[out.length - 1].type === segs[i].type) {
        out[out.length - 1].end = segs[i].end;
      } else {
        out.push({ type: segs[i].type, start: segs[i].start, end: segs[i].end });
      }
    }
    return out;
  }

  function decorate(track, seg) {
    var st = rangeStats(track, seg.start, seg.end);
    return { type: seg.type, start: seg.start, end: seg.end,
      seconds: seg.end - seg.start, distance: st.distance,
      avgSpeed: st.avgSpeed, avgHr: st.avgHr };
  }

  // Distance, average speed and average heart rate over [start, end) seconds.
  function rangeStats(track, start, end) {
    var n = track.n;
    var s = clamp(Math.round(start), 0, n - 1);
    var e = clamp(Math.round(end), 0, n - 1);
    var distance = Math.max(track.dist[e] - track.dist[s], 0);
    var moving = 0, hrSum = 0, hrSec = 0;
    for (var i = s; i < e; i++) {
      if (track.gap[i]) continue;
      moving++;
      if (track.hasHr && track.hr[i] > 0) { hrSum += track.hr[i]; hrSec++; }
    }
    return {
      seconds: e - s,
      movingSeconds: moving,
      distance: distance,
      avgSpeed: moving > 0 ? distance / moving : null,
      avgHr: hrSec > 0 ? hrSum / hrSec : null
    };
  }

  // ---- window placement -----------------------------------------------------

  /*
   * A Zone 2 run usually opens with a warm-up walk and closes with a cool-down
   * walk; neither is a walk *break*, and leaving them in would count them as
   * such and drag the pace down. So the measured window starts at the first run
   * period and ends at the last (both individually switchable).
   */
  function chooseWindow(track, segments, opts) {
    var start = 0, end = track.n - 1;
    var runs = segments.filter(function (s) { return s.type === RUN; });
    var trimmedLead = 0, trimmedTail = 0;
    if (!runs.length) {
      return { start: start, end: end, trimmedLead: 0, trimmedTail: 0, noRun: true };
    }
    var firstNonPause = null, lastNonPause = null;
    segments.forEach(function (s) {
      if (s.type === PAUSE) return;
      if (firstNonPause === null) firstNonPause = s;
      lastNonPause = s;
    });
    if (opts.trimLeadingWalk && firstNonPause && firstNonPause.type === WALK) {
      trimmedLead = runs[0].start - start;
      start = runs[0].start;
    }
    if (opts.trimTrailingWalk && lastNonPause && lastNonPause.type === WALK) {
      var lastRun = runs[runs.length - 1];
      if (lastRun.end > start) {
        trimmedTail = end - lastRun.end;
        end = lastRun.end;
      }
    }
    return { start: start, end: end, trimmedLead: trimmedLead, trimmedTail: trimmedTail,
      noRun: false };
  }

  // ---- window metrics -------------------------------------------------------

  function windowMetrics(track, segments, start, end) {
    var n = track.n;
    var ws = clamp(Math.round(start), 0, n - 1);
    var we = clamp(Math.round(end), 0, n - 1);
    var base = rangeStats(track, ws, we);
    var walkSec = 0, runSec = 0, pauseSec = 0;
    var walks = 0, runsCount = 0;
    var walkDist = 0, runDist = 0;
    var longestRun = 0, longestWalk = 0;

    segments.forEach(function (seg) {
      var s = Math.max(seg.start, ws), e = Math.min(seg.end, we);
      if (e <= s) return;
      var dur = e - s;
      var d = Math.max(track.dist[Math.min(e, n - 1)] - track.dist[s], 0);
      if (seg.type === RUN) {
        runSec += dur; runDist += d; runsCount++;
        if (dur > longestRun) longestRun = dur;
      } else if (seg.type === WALK) {
        walkSec += dur; walkDist += d; walks++;
        if (dur > longestWalk) longestWalk = dur;
      } else {
        pauseSec += dur;
      }
    });

    var miles = base.distance / MI_M;
    return {
      startSec: ws,
      endSec: we,
      seconds: we - ws,
      movingSeconds: base.movingSeconds,
      distance: base.distance,
      avgSpeed: base.avgSpeed,
      avgHr: base.avgHr,
      walks: walks,
      runs: runsCount,
      walkSeconds: walkSec,
      runSeconds: runSec,
      pausedSeconds: pauseSec,
      avgWalkSec: walks ? walkSec / walks : null,
      avgRunSec: runsCount ? runSec / runsCount : null,
      longestRunSec: longestRun || null,
      longestWalkSec: longestWalk || null,
      runDistance: runDist,
      walkDistance: walkDist,
      runAvgSpeed: runSec > 0 ? runDist / runSec : null,
      walkAvgSpeed: walkSec > 0 ? walkDist / walkSec : null,
      runTimePct: (we - ws) > 0 ? 100 * runSec / (we - ws) : null,
      walksPerMile: miles > 0.1 ? walks / miles : null
    };
  }

  /*
   * Fixed windows measured from the window start: 30, 45, 60, 75, 90 … minutes.
   * Comparing like with like across activities is the whole point — a 75-minute
   * run and a 50-minute run share a 30- and a 45-minute bucket.
   */
  function bucketMetrics(track, segments, win, opts) {
    var out = [];
    var span = win.end - win.start;
    for (var m = opts.bucketStartMin; m * 60 <= span + opts.bucketTolSec; m += opts.bucketStepMin) {
      var end = Math.min(win.start + m * 60, win.end);
      out.push({ minutes: m, metrics: windowMetrics(track, segments, win.start, end) });
    }
    return out;
  }

  /*
   * Per-mile (or per-km) segments across the window: pace, walk count and walk
   * time for each mile, so a fade in the back half is visible.
   */
  function distanceSegmentStats(track, segments, win, unit) {
    var out = [];
    if (!(unit > 0)) return out;
    var n = track.n;
    var ws = clamp(Math.round(win.start), 0, n - 1);
    var we = clamp(Math.round(win.end), 0, n - 1);
    var d0 = track.dist[ws];
    var total = track.dist[we] - d0;
    if (!(total > 0)) return out;

    var segStart = ws;
    var count = Math.ceil(total / unit);
    for (var k = 1; k <= count; k++) {
      var targetD = d0 + k * unit;
      var segEnd = we;
      for (var i = segStart; i <= we; i++) {
        if (track.dist[i] >= targetD) { segEnd = i; break; }
      }
      if (segEnd <= segStart) segEnd = Math.min(segStart + 1, we);
      if (segEnd <= segStart) break;
      var m = windowMetrics(track, segments, segStart, segEnd);
      out.push({
        index: k,
        partial: track.dist[segEnd] - track.dist[segStart] < unit * 0.995,
        startSec: segStart - ws,
        endSec: segEnd - ws,
        metrics: m
      });
      segStart = segEnd;
      if (segStart >= we) break;
    }
    return out;
  }

  // ---- entry point ----------------------------------------------------------

  function analyze(samples, options) {
    var opts = Object.assign({}, DEFAULTS, options || {});
    var track = buildTrack(samples);
    if (!track) return null;
    track.sm = smoothSpeed(track.speed, opts.smoothSec);
    var segments = segmentTrack(track, opts);
    var win = chooseWindow(track, segments, opts);
    var full = rangeStats(track, 0, track.n - 1);
    return {
      options: opts,
      track: track,
      segments: segments,
      window: win,
      total: {
        seconds: track.n - 1,
        movingSeconds: full.movingSeconds,
        distance: full.distance,
        avgHr: full.avgHr
      },
      overall: windowMetrics(track, segments, win.start, win.end),
      buckets: bucketMetrics(track, segments, win, opts),
      distanceSegments: distanceSegmentStats(track, segments, win, opts.segmentDistance)
    };
  }

  var api = {
    analyze: analyze,
    buildTrack: buildTrack,
    smoothSpeed: smoothSpeed,
    segmentTrack: segmentTrack,
    chooseWindow: chooseWindow,
    windowMetrics: windowMetrics,
    bucketMetrics: bucketMetrics,
    distanceSegmentStats: distanceSegmentStats,
    DEFAULTS: DEFAULTS,
    WALK: WALK, RUN: RUN, PAUSE: PAUSE,
    MPH_TO_MS: MPH_TO_MS, MI_M: MI_M, KM_M: KM_M, MAX_GAP: MAX_GAP
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.trackerAnalysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
