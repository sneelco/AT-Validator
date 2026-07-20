/*
 * App wiring: file loading, settings, stats tiles, splits table, verdict.
 */
(function () {
  'use strict';

  var analysis = window.ATV.analysis;
  var fmtElapsed = window.ATV.chart.fmtElapsed;

  var DEFAULTS = {
    windowMin: 60,     // analysis window, minutes
    thresholdPct: 5,   // allowed rise, percent
    splitMin: 10,      // split length, minutes
    smoothSec: 30,     // baseline averaging, seconds
    endSec: 300        // "end of test" averaging, seconds
  };

  var state = {
    samples: [],           // { t: elapsed s, hr }
    absoluteT0: null,      // unix s of first sample when known
    meta: null,            // { name, sports, distance }
    windowStart: 0,        // elapsed s
    baselineOverride: null, // manual baseline (bpm), null = auto
    detected: null,        // detectBaseline() result for the loaded activity
    hrRange: null,         // [min, max] bpm of loaded activity
    settings: Object.assign({}, DEFAULTS)
  };

  var els = {};
  ['dropzone', 'file-input', 'demo-btn', 'chart', 'window-slider', 'window-readout',
   'stats', 'splits-body', 'splits-table', 'verdict', 'activity-meta', 'settings-form',
   'set-window', 'set-threshold', 'set-split', 'set-smooth', 'reset-settings',
   'analysis-section', 'load-error', 'slider-row',
   'baseline-slider', 'baseline-readout', 'baseline-reset', 'baseline-warning'
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  var chart = new window.ATV.chart.ATChart(els.chart, {
    onWindowChange: function (startT, lenS, resized) {
      var s = state.samples;
      if (!s.length) return;
      state.baselineOverride = null; // window moved: baseline returns to auto
      if (resized) {
        var lenMin = Math.round(lenS / 60);
        if (lenMin >= 5) {
          state.settings.windowMin = lenMin;
          els['set-window'].value = lenMin;
        }
      }
      var maxStart = Math.max(s[s.length - 1].t - effectiveWindowLen(), 0);
      state.windowStart = clamp(startT, 0, maxStart);
      refresh();
    }
  });

  // ---- loading -----------------------------------------------------------

  function loadFile(file) {
    hideError();
    var name = file.name.toLowerCase();
    var reader = new FileReader();
    reader.onerror = function () { showError('Could not read ' + file.name); };
    if (name.endsWith('.fit')) {
      reader.onload = function () {
        try {
          var parsed = window.ATV.fit.parseFit(reader.result);
          ingest(parsed, file.name);
        } catch (e) { showError('FIT parse failed: ' + e.message); }
      };
      reader.readAsArrayBuffer(file);
    } else if (name.endsWith('.zip')) {
      reader.onload = function () {
        window.ATV.zip.extractFit(reader.result).then(function (entry) {
          ingest(window.ATV.fit.parseFit(entry.buffer), entry.name);
        }).catch(function (e) {
          showError('Could not read ' + file.name + ': ' + e.message);
        });
      };
      reader.readAsArrayBuffer(file);
    } else if (name.endsWith('.csv') || name.endsWith('.txt')) {
      reader.onload = function () {
        try {
          var parsed = window.ATV.csv.parseCsv(reader.result);
          ingest({ records: parsed.records, sports: [], csvAbsolute: parsed.absolute }, file.name);
        } catch (e) { showError('CSV parse failed: ' + e.message); }
      };
      reader.readAsText(file);
    } else {
      showError('Unsupported file type — use a Garmin .fit file or a timestamp,heartrate .csv');
    }
  }

  function ingest(parsed, name) {
    var recs = parsed.records.filter(function (r) {
      return r.t !== null && r.hr !== undefined && r.hr > 20 && r.hr < 250;
    });
    if (recs.length < 2) {
      showError('No usable heart-rate samples found in ' + name +
        '. Make sure the activity was recorded with a heart-rate monitor.');
      return;
    }
    recs.sort(function (a, b) { return a.t - b.t; });

    var t0 = recs[0].t;
    // Absolute timestamps (FIT always; CSV when detected) → keep wall clock.
    var absolute = parsed.csvAbsolute !== undefined ? parsed.csvAbsolute : true;
    state.absoluteT0 = absolute ? t0 : null;
    state.samples = recs.map(function (r) { return { t: r.t - t0, hr: r.hr }; });

    var last = parsed.records[parsed.records.length - 1];
    state.meta = {
      name: name,
      sports: parsed.sports || [],
      distance: last && last.distance !== undefined ? last.distance : null
    };
    state.windowStart = 0;
    state.baselineOverride = null;
    state.detected = analysis.detectBaseline(state.samples);
    if (state.detected.confidence !== 'none') {
      state.windowStart = state.detected.windowStart; // suggested start
    }
    var hrLo = Infinity, hrHi = -Infinity;
    state.samples.forEach(function (r) {
      if (r.hr < hrLo) hrLo = r.hr;
      if (r.hr > hrHi) hrHi = r.hr;
    });
    state.hrRange = [hrLo, hrHi];
    fitWindowToActivity();
    chart.setData(state.samples, state.absoluteT0);
    els['analysis-section'].hidden = false;
    refresh();
    els['analysis-section'].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // The window actually analyzed: the configured length, capped to the
  // activity. The setting itself is never silently changed — a too-short
  // activity yields an "insufficient" verdict instead.
  function effectiveWindowLen() {
    var s = state.samples;
    var total = s[s.length - 1].t;
    return Math.max(Math.min(state.settings.windowMin * 60, total), 60);
  }

  // The baseline used when no manual override is active: the detected
  // plateau when we have one, else null (analyzeWindow falls back to the
  // window-start average).
  function detectedBaseline() {
    return state.detected && state.detected.confidence !== 'none'
      ? state.detected.baseline : null;
  }

  function fitWindowToActivity() {
    var s = state.samples;
    if (!s.length) return;
    var total = s[s.length - 1].t;
    state.windowStart = clamp(state.windowStart, 0, Math.max(total - effectiveWindowLen(), 0));
  }

  // ---- rendering ---------------------------------------------------------

  function refresh() {
    var s = state.samples;
    if (!s.length) return;
    var set = state.settings;
    var winLen = effectiveWindowLen();
    var result = analysis.analyzeWindow(s, state.windowStart, {
      windowLen: winLen,
      thresholdPct: set.thresholdPct,
      splitLen: set.splitMin * 60,
      smoothSec: set.smoothSec,
      endSec: Math.min(set.endSec, winLen / 4),
      baselineOverride: state.baselineOverride !== null
        ? state.baselineOverride : detectedBaseline()
    });
    if (!result) return;

    // Activity shorter than the configured window → never a definitive verdict.
    if (winLen < set.windowMin * 60 - 1) result.verdict = 'insufficient';

    chart.setState({
      windowStart: state.windowStart,
      windowLen: winLen,
      baseline: result.baseline,
      threshold: result.threshold,
      splitLen: set.splitMin * 60
    });

    renderSlider(winLen);
    renderBaseline(result);
    renderMeta();
    renderVerdict(result);
    renderStats(result);
    renderSplits(result);
  }

  function renderSlider(winLen) {
    var total = state.samples[state.samples.length - 1].t;
    var maxStart = Math.max(total - winLen, 0);
    els['slider-row'].hidden = maxStart <= 0;
    els['window-slider'].max = Math.ceil(maxStart);
    els['window-slider'].value = Math.round(state.windowStart);
    els['window-readout'].textContent =
      'Window: ' + fmtElapsed(state.windowStart) + ' – ' + fmtElapsed(state.windowStart + winLen);
  }

  function baselineSourceLabel() {
    if (state.baselineOverride !== null) return 'manual (slider)';
    var d = state.detected;
    if (d && d.confidence !== 'none') {
      return 'detected plateau (' + fmtElapsed(d.windowStart) + '\u2013' + fmtElapsed(d.windowEnd) + ')' +
        (d.confidence === 'low' ? ' \u00b7 low confidence' : '');
    }
    return 'auto (unsettled \u2014 no clear plateau found)';
  }

  function renderBaseline(r) {
    var manual = state.baselineOverride !== null;
    var slider = els['baseline-slider'];
    slider.min = Math.max(Math.floor(state.hrRange[0]) - 5, 30);
    slider.max = Math.ceil(state.hrRange[1]) + 5;
    slider.value = Math.round(r.baseline);
    els['baseline-readout'].textContent =
      'Baseline ' + Math.round(r.baseline) + ' bpm \u2014 ' + baselineSourceLabel();
    els['baseline-reset'].hidden = !manual;
    renderBaselineWarning(r);
  }

  // Non-blocking heads-up when the manual baseline strays from the detected
  // plateau: show the counterfactual verdict at the detected value.
  function renderBaselineWarning(r) {
    var warn = els['baseline-warning'];
    var det = detectedBaseline();
    if (state.baselineOverride === null || det === null ||
        Math.abs(state.baselineOverride - det) <= 2) {
      warn.hidden = true;
      return;
    }
    var set = state.settings;
    var winLen = effectiveWindowLen();
    var cf = analysis.analyzeWindow(state.samples, state.windowStart, {
      windowLen: winLen,
      thresholdPct: set.thresholdPct,
      splitLen: set.splitMin * 60,
      smoothSec: set.smoothSec,
      endSec: Math.min(set.endSec, winLen / 4),
      baselineOverride: det
    });
    warn.textContent = '';
    if (!cf) { warn.hidden = true; return; }
    if (winLen < set.windowMin * 60 - 1) cf.verdict = 'insufficient';
    var names = { pass: 'PASS', fail: 'FAIL', insufficient: 'INSUFFICIENT' };
    var rise = cf.endRisePct !== null ? ' (' + fmtSigned(cf.endRisePct, 1) + '%)' : '';
    warn.appendChild(document.createTextNode(
      '\u26a0 Manual baseline ' + Math.round(state.baselineOverride) +
      ' vs detected plateau ' + Math.round(det) + ' \u2014 verdict ' +
      (cf.verdict === r.verdict ? 'stays ' : 'changes to ')));
    var strong = document.createElement('strong');
    strong.className = cf.verdict;
    strong.textContent = names[cf.verdict];
    warn.appendChild(strong);
    warn.appendChild(document.createTextNode(rise + ' at detected value.'));
    warn.hidden = false;
  }

  function renderMeta() {
    var m = state.meta;
    var parts = [m.name];
    if (m.sports.length) parts.push(m.sports.join(', '));
    var total = state.samples[state.samples.length - 1].t;
    parts.push('Duration ' + fmtElapsed(total));
    if (m.distance) parts.push((m.distance / 1000).toFixed(2) + ' km');
    if (state.absoluteT0 !== null) {
      parts.push(new Date(state.absoluteT0 * 1000).toLocaleString([], {
        dateStyle: 'medium', timeStyle: 'short'
      }));
    }
    els['activity-meta'].textContent = parts.join('  ·  ');
  }

  function renderVerdict(r) {
    var v = els.verdict;
    v.className = 'verdict ' + r.verdict;
    var title, body;
    var riseStr = r.endRisePct !== null
      ? fmtSigned(r.endRisePct, 1) + '% (' + fmtSigned(r.endRiseBpm, 0) + ' bpm)'
      : 'n/a';
    if (r.verdict === 'pass') {
      title = 'Below aerobic threshold';
      body = 'Heart rate at the end of the window averaged ' + Math.round(r.endAvg) +
        ' bpm — a rise of ' + riseStr + ' from the starting ' + Math.round(r.baseline) +
        ' bpm. That is within the ' + state.settings.thresholdPct +
        '% limit, so this effort looks aerobic.';
    } else if (r.verdict === 'fail') {
      title = 'Above aerobic threshold';
      body = 'Heart rate at the end of the window averaged ' + Math.round(r.endAvg) +
        ' bpm — a rise of ' + riseStr + ' from the starting ' + Math.round(r.baseline) +
        ' bpm, exceeding the ' + state.settings.thresholdPct +
        '% limit. The starting heart rate was likely above your aerobic threshold.';
    } else {
      title = 'Not enough data for a verdict';
      var winMin = state.settings.windowMin;
      var total = state.samples[state.samples.length - 1].t;
      if (total < winMin * 60 - 1) {
        body = 'The test needs a full ' + winMin + '-minute window, but this activity is only ' +
          fmtElapsed(total) + ' long. Stats below describe the whole activity anyway.';
      } else {
        body = 'The test needs a full ' + winMin + '-minute window with continuous heart-rate ' +
          'data (coverage here: ' + Math.round(r.coverage * 100) + '%). Stats below still ' +
          'describe the data that is present.';
      }
    }
    v.querySelector('.verdict-title').textContent = title;
    v.querySelector('.verdict-body').textContent = body;
  }

  function renderStats(r) {
    var tiles = [
      { label: 'Baseline HR', value: Math.round(r.baseline), unit: 'bpm',
        sub: baselineSourceLabel() },
      { label: 'Threshold (+' + state.settings.thresholdPct + '%)', value: Math.round(r.threshold),
        unit: 'bpm', sub: 'limit for the window' },
      { label: 'End-of-window rise', value: r.endRisePct !== null ? fmtSigned(r.endRisePct, 1) : '—',
        unit: '%', sub: r.endRiseBpm !== null ? fmtSigned(r.endRiseBpm, 0) + ' bpm vs start' : '',
        delta: r.endRisePct !== null ? (r.endRisePct > state.settings.thresholdPct ? 'bad' : 'good') : null },
      { label: 'Average HR', value: Math.round(r.window.avg), unit: 'bpm',
        sub: Math.round(r.window.min) + '–' + Math.round(r.window.max) + ' bpm range' },
      { label: 'Time under threshold', value: r.window.pctUnder.toFixed(1), unit: '%',
        sub: fmtElapsed(r.window.timeUnder) + ' of ' + fmtElapsed(r.window.seconds) },
      { label: 'Time over threshold', value: r.window.pctOver.toFixed(1), unit: '%',
        sub: fmtElapsed(r.window.timeOver),
        delta: r.window.pctOver > 5 ? 'bad' : null },
      { label: 'Headroom', value: fmtSigned(r.headroomPct, 1), unit: '%',
        sub: fmtSigned(r.headroomBpm, 1) + ' bpm avg below threshold',
        delta: r.headroomBpm < 0 ? 'bad' : 'good' },
      { label: 'HR drift (halves)', value: r.driftPct !== null ? fmtSigned(r.driftPct, 1) : '—',
        unit: '%', sub: '2nd half vs 1st half',
        delta: r.driftPct !== null ? (r.driftPct > state.settings.thresholdPct ? 'bad' : 'good') : null }
    ];
    var host = els.stats;
    host.textContent = '';
    tiles.forEach(function (t) {
      var tile = document.createElement('div');
      tile.className = 'stat-tile';
      var lab = document.createElement('div');
      lab.className = 'stat-label';
      lab.textContent = t.label;
      var val = document.createElement('div');
      val.className = 'stat-value' + (t.delta ? ' ' + t.delta : '');
      val.textContent = t.value;
      var unit = document.createElement('span');
      unit.className = 'stat-unit';
      unit.textContent = ' ' + t.unit;
      val.appendChild(unit);
      var sub = document.createElement('div');
      sub.className = 'stat-sub';
      sub.textContent = t.sub || '';
      tile.appendChild(lab); tile.appendChild(val); tile.appendChild(sub);
      host.appendChild(tile);
    });
  }

  function renderSplits(r) {
    var body = els['splits-body'];
    body.textContent = '';
    r.splits.forEach(function (sp, i) {
      var tr = document.createElement('tr');
      var label = String(i + 1) + (sp.partial ? '*' : '');
      var cells;
      if (sp.stats) {
        cells = [
          label,
          fmtElapsed(sp.start) + '–' + fmtElapsed(sp.end),
          String(Math.round(sp.stats.avg)),
          Math.round(sp.stats.min) + '–' + Math.round(sp.stats.max),
          fmtSigned(sp.risePct, 1) + '%',
          sp.stats.pctOver.toFixed(1) + '%',
          fmtSigned(sp.headroomPct, 1) + '%'
        ];
      } else {
        cells = [label, fmtElapsed(sp.start) + '–' + fmtElapsed(sp.end), '—', '—', '—', '—', '—'];
      }
      cells.forEach(function (c, ci) {
        var td = document.createElement('td');
        td.textContent = c;
        if (ci >= 2) td.className = 'num';
        if (ci === 5 && sp.stats && sp.stats.pctOver > 50) td.classList.add('bad');
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });

    // Overall row (the whole window).
    var tr = document.createElement('tr');
    tr.className = 'overall';
    var w = r.window;
    [ 'Overall',
      fmtElapsed(r.windowStart) + '–' + fmtElapsed(r.windowEnd),
      String(Math.round(w.avg)),
      Math.round(w.min) + '–' + Math.round(w.max),
      r.endRisePct !== null ? fmtSigned(r.endRisePct, 1) + '%' : '—',
      w.pctOver.toFixed(1) + '%',
      fmtSigned(r.headroomPct, 1) + '%'
    ].forEach(function (c, ci) {
      var td = document.createElement('td');
      td.textContent = c;
      if (ci >= 2) td.className = 'num';
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }

  // ---- events ------------------------------------------------------------

  els['file-input'].addEventListener('change', function () {
    if (this.files.length) loadFile(this.files[0]);
    this.value = '';
  });
  ['dragover', 'dragenter'].forEach(function (ev) {
    els.dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      els.dropzone.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    els.dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      els.dropzone.classList.remove('dragging');
    });
  });
  els.dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });
  els.dropzone.addEventListener('click', function (e) {
    if (e.target.closest('button, label')) return;
    els['file-input'].click();
  });

  els['demo-btn'].addEventListener('click', function () {
    hideError();
    ingest(window.ATV.demo.generateDemo(), 'Demo activity');
  });

  els['window-slider'].addEventListener('input', function () {
    state.windowStart = +this.value;
    state.baselineOverride = null; // window moved: baseline returns to auto
    refresh();
  });

  els['baseline-slider'].addEventListener('input', function () {
    state.baselineOverride = +this.value;
    refresh();
  });
  els['baseline-reset'].addEventListener('click', function () {
    state.baselineOverride = null;
    refresh();
  });

  function readSettings() {
    var w = clamp(+els['set-window'].value || DEFAULTS.windowMin, 5, 600);
    if (w !== state.settings.windowMin) state.baselineOverride = null;
    var t = clamp(+els['set-threshold'].value || DEFAULTS.thresholdPct, 0.5, 25);
    var sp = clamp(+els['set-split'].value || DEFAULTS.splitMin, 1, 120);
    var sm = clamp(+els['set-smooth'].value || DEFAULTS.smoothSec, 5, 600);
    state.settings.windowMin = w;
    state.settings.thresholdPct = t;
    state.settings.splitMin = sp;
    state.settings.smoothSec = sm;
    fitWindowToActivity();
    refresh();
  }
  ['set-window', 'set-threshold', 'set-split', 'set-smooth'].forEach(function (id) {
    els[id].addEventListener('change', readSettings);
  });
  els['settings-form'].addEventListener('submit', function (e) { e.preventDefault(); });
  els['reset-settings'].addEventListener('click', function () {
    state.settings = Object.assign({}, DEFAULTS);
    state.baselineOverride = null;
    els['set-window'].value = DEFAULTS.windowMin;
    els['set-threshold'].value = DEFAULTS.thresholdPct;
    els['set-split'].value = DEFAULTS.splitMin;
    els['set-smooth'].value = DEFAULTS.smoothSec;
    fitWindowToActivity();
    refresh();
  });

  function showError(msg) {
    els['load-error'].textContent = msg;
    els['load-error'].hidden = false;
  }
  function hideError() { els['load-error'].hidden = true; }

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  function fmtSigned(v, digits) {
    var s = v.toFixed(digits);
    return v > 0 ? '+' + s : s;
  }
})();
