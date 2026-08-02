/*
 * Zone 2 Tracker: UI wiring for the walk/run tracker tab.
 *
 * Activities are added from .fit/.zip (or .csv with a speed channel), measured
 * with tracker-analysis.js under the current settings, kept in localStorage as
 * a compact series, and compared across runs. Because the stored form is the
 * series rather than the numbers, changing the walk/run threshold re-measures
 * the whole history at once.
 */
(function () {
  'use strict';

  var A = window.ATV.trackerAnalysis;
  var store = window.ATV.trackerStore;

  var MPH = A.MPH_TO_MS, MI = A.MI_M, KM = A.KM_M;
  var MAX_SERIES = 5;   // categorical slots available in the palette

  var DEFAULT_SETTINGS = {
    thresholdMs: 4 * MPH,
    minSegmentSec: A.DEFAULTS.minSegmentSec,
    trimLeadingWalk: true,
    trimTrailingWalk: true,
    units: 'imperial'
  };

  var state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    activities: [],
    selectedId: null,
    metric: 'walks',
    buckets: null,     // null = auto-pick once the history is known
    cache: {}
  };

  var els = {};
  ['tracker-dropzone', 'trk-file-input', 'trk-demo-btn', 'trk-status',
   'trk-settings', 'trk-threshold', 'trk-threshold-unit', 'trk-min-seg',
   'trk-trim-lead', 'trk-trim-tail', 'trk-unit-mi', 'trk-unit-km', 'trk-reset',
   'trk-metric', 'trk-buckets', 'trk-chart', 'trk-legend', 'trk-trend-note',
   'trk-count', 'trk-export', 'trk-import-input', 'trk-clear', 'trk-history-body',
   'trk-detail', 'trk-detail-title', 'trk-detail-meta', 'trk-timeline',
   'trk-detail-stats', 'trk-buckets-body', 'trk-splits-body'
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  var chart = new window.ATV.trackerChart.TrendChart(els['trk-chart']);

  // ---- units & formatting ---------------------------------------------------

  function imperial() { return state.settings.units === 'imperial'; }
  function distUnit() { return imperial() ? MI : KM; }
  function distLabel() { return imperial() ? 'mi' : 'km'; }
  function speedLabel() { return imperial() ? 'mph' : 'km/h'; }
  function speedFactor() { return imperial() ? 1 / MPH : 3.6; }

  function fmtDist(m, digits) {
    if (!isFinite(m)) return '—';
    return (m / distUnit()).toFixed(digits === undefined ? 2 : digits);
  }
  function paceSec(speedMs) {
    return speedMs && speedMs > 0.05 ? distUnit() / speedMs : null;
  }
  function fmtMinSec(sec) {
    if (sec === null || !isFinite(sec)) return '—';
    sec = Math.round(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  function fmtPace(speedMs) {
    var p = paceSec(speedMs);
    return p === null ? '—' : fmtMinSec(p);
  }
  function fmtDur(sec) {
    if (sec === null || !isFinite(sec)) return '—';
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }
  function fmtNum(v, digits) {
    return v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(digits);
  }
  function activityDate(act) {
    return act.startTime ? new Date(act.startTime * 1000) : null;
  }
  function fmtDate(act) {
    var d = activityDate(act);
    return d ? d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  }
  function fmtShortDate(act, i) {
    var d = activityDate(act);
    return d ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '#' + (i + 1);
  }

  // ---- measurement ----------------------------------------------------------

  function analyzeOpts() {
    return {
      thresholdMs: state.settings.thresholdMs,
      minSegmentSec: state.settings.minSegmentSec,
      trimLeadingWalk: state.settings.trimLeadingWalk,
      trimTrailingWalk: state.settings.trimTrailingWalk,
      segmentDistance: distUnit()
    };
  }
  function settingsKey() { return JSON.stringify(analyzeOpts()); }

  // Measured lazily and cached per (activity, settings); the heavy typed arrays
  // are dropped so a long history costs kilobytes, not megabytes.
  function resultFor(act) {
    var key = settingsKey();
    var hit = state.cache[act.id];
    if (hit && hit.key === key) return hit.result;
    var samples = store.expandSeries(act.series);
    var res = samples ? A.analyze(samples, analyzeOpts()) : null;
    if (res) delete res.track;
    state.cache[act.id] = { key: key, result: res };
    return res;
  }

  function metricsFor(res, bucket) {
    if (!res) return null;
    if (bucket === 'full') return res.overall;
    var found = res.buckets.filter(function (b) { return b.minutes === bucket; })[0];
    return found ? found.metrics : null;
  }

  function walksPerDist(m) {
    if (!m || !m.distance) return null;
    var units = m.distance / distUnit();
    return units > 0.15 ? m.walks / units : null;
  }

  // ---- metric catalogue -----------------------------------------------------

  var METRICS = {
    walks: {
      label: function () { return 'Walk breaks'; },
      value: function (m) { return m.walks; },
      format: function (v) { return v % 1 ? v.toFixed(1) : v.toFixed(0); },
      note: 'Fewer walk breaks over the same window is the clearest sign the aerobic base is building.'
    },
    walksPerDist: {
      label: function () { return 'Walk breaks per ' + distLabel(); },
      value: walksPerDist,
      format: function (v) { return v.toFixed(2); },
      note: 'Walk breaks normalised by distance, so a longer run is not penalised.'
    },
    pace: {
      label: function () { return 'Average pace (/' + distLabel() + ')'; },
      value: function (m) { return paceSec(m.avgSpeed); },
      format: fmtMinSec,
      note: 'Average pace across the whole window, walk breaks included — lower is faster.'
    },
    runPace: {
      label: function () { return 'Running pace (/' + distLabel() + ')'; },
      value: function (m) { return paceSec(m.runAvgSpeed); },
      format: fmtMinSec,
      note: 'Pace during the run periods only — lower is faster.'
    },
    distance: {
      label: function () { return 'Distance (' + distLabel() + ')'; },
      value: function (m) { return m.distance / distUnit(); },
      format: function (v) { return v.toFixed(2); },
      note: 'Distance covered inside each fixed window — more ground in the same time is progress.'
    },
    avgRun: {
      label: function () { return 'Average run period (min)'; },
      value: function (m) { return m.avgRunSec === null ? null : m.avgRunSec / 60; },
      format: function (v) { return v.toFixed(1); },
      note: 'How long you hold a run before walking — rising is progress.'
    },
    avgWalk: {
      label: function () { return 'Average walk period (min)'; },
      value: function (m) { return m.avgWalkSec === null ? null : m.avgWalkSec / 60; },
      format: function (v) { return v.toFixed(1); },
      note: 'How long the walk breaks last — shorter recoveries are progress.'
    },
    runPct: {
      label: function () { return 'Time spent running (%)'; },
      value: function (m) { return m.runTimePct; },
      format: function (v) { return v.toFixed(0) + '%'; },
      note: 'Share of the window spent above the walk/run threshold.'
    },
    avgHr: {
      label: function () { return 'Average heart rate (bpm)'; },
      value: function (m) { return m.avgHr; },
      format: function (v) { return v.toFixed(0); },
      note: 'Average heart rate over the window — the same pace at a lower heart rate is progress.'
    }
  };

  // ---- ingest ---------------------------------------------------------------

  function readFile(file, asText) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('could not be read')); };
      reader.onload = function () { resolve(reader.result); };
      if (asText) reader.readAsText(file); else reader.readAsArrayBuffer(file);
    });
  }

  function parseActivityFile(file) {
    var name = file.name.toLowerCase();
    if (name.endsWith('.fit')) {
      return readFile(file, false).then(function (buf) {
        return window.ATV.fit.parseFit(buf);
      });
    }
    if (name.endsWith('.zip')) {
      return readFile(file, false).then(function (buf) {
        return window.ATV.zip.extractFit(buf).then(function (entry) {
          return window.ATV.fit.parseFit(entry.buffer);
        });
      });
    }
    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      return readFile(file, true).then(function (text) {
        var parsed = window.ATV.csv.parseCsv(text);
        return { records: parsed.records, sports: [], csvAbsolute: parsed.absolute };
      });
    }
    return Promise.reject(new Error('unsupported file type'));
  }

  // parsed -> stored activity record (or throws with a readable reason).
  function toActivity(parsed, fileName, source) {
    var recs = (parsed.records || []).filter(function (r) { return r.t !== null && r.t !== undefined; });
    if (recs.length < 10) throw new Error('too few records to measure');
    recs.sort(function (a, b) { return a.t - b.t; });
    var t0 = recs[0].t;
    var samples = recs.map(function (r) {
      return { t: r.t - t0, speed: r.speed, distance: r.distance, hr: r.hr };
    });
    var series = store.compressSeries(samples);
    if (!series) throw new Error('no speed or distance data — the tracker needs a pace channel');
    var absolute = parsed.csvAbsolute !== undefined ? parsed.csvAbsolute : true;
    var last = samples[samples.length - 1];
    var rec = {
      name: parsed.name || fileName.replace(/\.[^.]+$/, ''),
      sport: (parsed.sports || []).join(', ') || null,
      startTime: absolute ? t0 : null,
      addedAt: Math.floor(Date.now() / 1000),
      durationSec: Math.round(last.t),
      distanceM: series.d ? series.d[series.d.length - 1] : 0,
      source: source || 'file',
      series: series
    };
    rec.id = store.idFor(rec);
    if (!A.analyze(store.expandSeries(series), analyzeOpts())) {
      throw new Error('could not measure walk/run periods in this activity');
    }
    return rec;
  }

  function addActivities(records) {
    var merged = store.mergeActivities(state.activities, records);
    state.activities = merged.list;
    var saved = store.save(state.activities);
    if (!saved.ok) return { error: saved.error, added: merged.added, replaced: merged.replaced };
    return merged;
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    setStatus('Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…');
    var records = [], failures = [];
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return parseActivityFile(file).then(function (parsed) {
          records.push(toActivity(parsed, file.name, 'file'));
        }).catch(function (e) {
          failures.push(file.name + ' — ' + (e && e.message ? e.message : 'could not be read'));
        });
      });
    });
    chain.then(function () {
      var msg = [];
      if (records.length) {
        var res = addActivities(records);
        if (res.error) { setStatus(res.error, true); return; }
        if (res.added) msg.push('Added ' + res.added + ' activit' + (res.added === 1 ? 'y' : 'ies'));
        if (res.replaced) msg.push(res.replaced + ' already in history (updated)');
        state.selectedId = records[records.length - 1].id;
        render();
      }
      if (failures.length) msg.push('Skipped ' + failures.length + ': ' + failures.join(' · '));
      setStatus(msg.join(' · ') || 'Nothing to add.', failures.length > 0 && !records.length);
    });
  }

  // ---- status ---------------------------------------------------------------

  function setStatus(text, isError) {
    els['trk-status'].textContent = text;
    els['trk-status'].classList.toggle('error', !!isError);
    els['trk-status'].hidden = !text;
  }

  // ---- rendering ------------------------------------------------------------

  function render() {
    renderUnitWords();
    renderBucketPicker();
    renderTrend();
    renderHistory();
    renderDetail();
  }

  function renderUnitWords() {
    var panel = document.getElementById('panel-tracker');
    panel.querySelectorAll('.unit-word').forEach(function (n) { n.textContent = distLabel(); });
    panel.querySelectorAll('.unit-word-long').forEach(function (n) {
      n.textContent = imperial() ? 'mile' : 'kilometre';
    });
    panel.querySelectorAll('.unit-word-cap').forEach(function (n) {
      n.textContent = imperial() ? 'Mile' : 'Km';
    });
    els['trk-threshold-unit'].textContent = speedLabel();
  }

  // Which fixed windows exist across the history, longest first in the picker.
  function availableBuckets() {
    var seen = {};
    state.activities.forEach(function (act) {
      var res = resultFor(act);
      if (!res) return;
      res.buckets.forEach(function (b) { seen[b.minutes] = 1; });
    });
    return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
  }

  function activeBuckets() {
    var avail = availableBuckets();
    var valid = ['full'].concat(avail);
    // Latch a default only once windows are known, so an empty tracker does not
    // lock the picker to "full window" before the first activity arrives.
    if (state.buckets === null) {
      if (!avail.length) return ['full'];
      // Default to the three shortest windows — the ones most activities reach.
      state.buckets = avail.slice(0, 3);
    }
    var picked = state.buckets.filter(function (b) { return valid.indexOf(b) !== -1; });
    if (!picked.length) picked = avail.length ? [avail[0]] : ['full'];
    return picked.slice(0, MAX_SERIES);
  }

  function renderBucketPicker() {
    var host = els['trk-buckets'];
    host.textContent = '';
    var avail = availableBuckets();
    var picked = activeBuckets();
    var options = avail.map(function (m) { return { value: m, label: m + ' min' }; });
    options.push({ value: 'full', label: 'Full window' });
    if (!state.activities.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    options.forEach(function (opt) {
      var on = picked.indexOf(opt.value) !== -1;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip' + (on ? ' on' : '');
      btn.textContent = opt.label;
      btn.setAttribute('aria-pressed', String(on));
      btn.addEventListener('click', function () {
        var cur = activeBuckets().slice();
        var at = cur.indexOf(opt.value);
        if (at !== -1) {
          if (cur.length > 1) cur.splice(at, 1);
        } else if (cur.length < MAX_SERIES) {
          cur.push(opt.value);
        } else {
          setStatus('At most ' + MAX_SERIES + ' windows can be plotted at once.', false);
          return;
        }
        cur.sort(function (a, b) {
          if (a === 'full') return 1;
          if (b === 'full') return -1;
          return a - b;
        });
        state.buckets = cur;
        persistSettings();
        renderBucketPicker();
        renderTrend();
      });
      host.appendChild(btn);
    });
  }

  function renderTrend() {
    var metric = METRICS[state.metric];
    var acts = state.activities;
    var buckets = activeBuckets();
    var series = buckets.map(function (b) {
      return {
        label: b === 'full' ? 'Full' : b + 'm',
        points: acts.map(function (act) {
          var m = metricsFor(resultFor(act), b);
          if (!m) return null;
          var v = metric.value(m);
          return v === null || v === undefined || !isFinite(v) ? null : { y: v };
        })
      };
    });
    chart.setData({
      series: series,
      xLabels: acts.map(fmtShortDate),
      format: metric.format,
      yTitle: metric.label(),
      empty: 'Add an activity to start tracking trends.'
    });
    renderLegend(series);
    els['trk-trend-note'].textContent = metric.note +
      ' A window only appears for activities long enough to fill it.';
  }

  function renderLegend(series) {
    var host = els['trk-legend'];
    host.textContent = '';
    if (series.length < 2) return;
    series.forEach(function (s, i) {
      var item = document.createElement('span');
      item.className = 'legend-item';
      var key = document.createElement('span');
      key.className = 'legend-key';
      key.style.background = 'var(--series-' + (i + 1) + ')';
      item.appendChild(key);
      item.appendChild(document.createTextNode(
        s.label === 'Full' ? 'Full window' : s.label.replace('m', '-minute window')));
      host.appendChild(item);
    });
  }

  function renderHistory() {
    var body = els['trk-history-body'];
    body.textContent = '';
    els['trk-count'].textContent = state.activities.length
      ? '(' + state.activities.length + ')' : '';
    els['trk-export'].disabled = !state.activities.length;
    els['trk-clear'].disabled = !state.activities.length;

    if (!state.activities.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 11;
      td.className = 'empty-row';
      td.textContent = 'No activities yet — drop a .fit file above, or add the demo block.';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    state.activities.slice().reverse().forEach(function (act) {
      var res = resultFor(act);
      var m = res ? res.overall : null;
      var tr = document.createElement('tr');
      tr.className = 'clickable' + (act.id === state.selectedId ? ' selected' : '');
      tr.tabIndex = 0;
      var cells = [
        fmtDate(act),
        act.name,
        m ? fmtDur(m.seconds) : '—',
        m ? fmtDist(m.distance) : '—',
        m ? fmtPace(m.avgSpeed) : '—',
        m ? String(m.walks) : '—',
        m ? fmtNum(walksPerDist(m), 2) : '—',
        m ? fmtMinSec(m.avgRunSec) : '—',
        m ? fmtMinSec(m.avgWalkSec) : '—',
        m && m.avgHr ? String(Math.round(m.avgHr)) : '—'
      ];
      cells.forEach(function (c, i) {
        var td = document.createElement('td');
        td.textContent = c;
        if (i >= 2) td.className = 'num';
        tr.appendChild(td);
      });
      var actions = document.createElement('td');
      actions.className = 'num';
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.title = 'Remove this activity';
      del.setAttribute('aria-label', 'Remove ' + act.name);
      del.textContent = '✕';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removeActivity(act.id);
      });
      actions.appendChild(del);
      tr.appendChild(actions);

      tr.addEventListener('click', function () { selectActivity(act.id); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectActivity(act.id); }
      });
      body.appendChild(tr);
    });
  }

  function selectActivity(id) {
    state.selectedId = id;
    renderHistory();
    renderDetail();
    els['trk-detail'].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function removeActivity(id) {
    state.activities = state.activities.filter(function (a) { return a.id !== id; });
    delete state.cache[id];
    if (state.selectedId === id) state.selectedId = null;
    var saved = store.save(state.activities);
    setStatus(saved.ok ? 'Activity removed.' : saved.error, !saved.ok);
    render();
  }

  function selectedActivity() {
    if (!state.activities.length) return null;
    var found = state.activities.filter(function (a) { return a.id === state.selectedId; })[0];
    return found || state.activities[state.activities.length - 1];
  }

  function renderDetail() {
    var act = selectedActivity();
    if (!act) { els['trk-detail'].hidden = true; return; }
    var res = resultFor(act);
    if (!res) { els['trk-detail'].hidden = true; return; }
    els['trk-detail'].hidden = false;
    state.selectedId = act.id;

    els['trk-detail-title'].textContent = act.name;
    var m = res.overall;
    var parts = [fmtDate(act)];
    if (act.sport) parts.push(act.sport);
    parts.push('Recorded ' + fmtDur(res.total.seconds) + ' · ' + fmtDist(res.total.distance) + ' ' + distLabel());
    parts.push('Measured window ' + fmtDur(res.window.start) + '–' + fmtDur(res.window.end));
    if (res.window.trimmedLead) parts.push('opening walk ' + fmtDur(res.window.trimmedLead) + ' trimmed');
    if (res.window.trimmedTail) parts.push('closing walk ' + fmtDur(res.window.trimmedTail) + ' trimmed');
    if (res.window.noRun) parts.push('no period above the threshold — whole activity measured');
    parts.push('threshold ' + (state.settings.thresholdMs * speedFactor()).toFixed(1) + ' ' + speedLabel());
    els['trk-detail-meta'].textContent = parts.join('  ·  ');

    renderTimeline(res);
    renderDetailStats(res, m);
    renderBucketTable(res);
    renderSegmentTable(res);
  }

  function renderTimeline(res) {
    var host = els['trk-timeline'];
    host.textContent = '';
    var total = Math.max(res.total.seconds, 1);
    res.segments.forEach(function (seg) {
      var inWindow = seg.start >= res.window.start && seg.end <= res.window.end;
      var div = document.createElement('div');
      var kind = seg.type === A.RUN ? 'run' : seg.type === A.WALK ? 'walk' : 'pause';
      div.className = 'tl-seg ' + kind + (inWindow ? '' : ' outside');
      div.style.width = (100 * (seg.end - seg.start) / total) + '%';
      var label = (kind === 'pause' ? 'Recording gap' : kind === 'run' ? 'Run' : 'Walk') +
        ' ' + fmtDur(seg.seconds) +
        (kind === 'pause' ? '' : ' · ' + fmtDist(seg.distance) + ' ' + distLabel() +
          ' · ' + fmtPace(seg.avgSpeed) + ' /' + distLabel()) +
        (inWindow ? '' : ' · outside the measured window');
      div.title = label;
      host.appendChild(div);
    });
  }

  function renderDetailStats(res, m) {
    var tiles = [
      { label: 'Measured window', value: fmtDur(m.seconds), unit: '',
        sub: fmtDist(m.distance) + ' ' + distLabel() + ' covered' },
      { label: 'Average pace', value: fmtPace(m.avgSpeed), unit: '/' + distLabel(),
        sub: 'walk breaks included' },
      { label: 'Running pace', value: fmtPace(m.runAvgSpeed), unit: '/' + distLabel(),
        sub: 'run periods only' },
      { label: 'Walk breaks', value: String(m.walks), unit: '',
        sub: fmtNum(walksPerDist(m), 2) + ' per ' + distLabel() },
      { label: 'Average run period', value: fmtMinSec(m.avgRunSec), unit: 'min:s',
        sub: m.runs + ' run period' + (m.runs === 1 ? '' : 's') +
          (m.longestRunSec ? ' · longest ' + fmtMinSec(m.longestRunSec) : '') },
      { label: 'Average walk period', value: fmtMinSec(m.avgWalkSec), unit: 'min:s',
        sub: m.longestWalkSec ? 'longest ' + fmtMinSec(m.longestWalkSec) : 'no walk breaks' },
      { label: 'Time spent running', value: fmtNum(m.runTimePct, 0), unit: '%',
        sub: fmtDur(m.runSeconds) + ' running · ' + fmtDur(m.walkSeconds) + ' walking' },
      { label: 'Average heart rate', value: m.avgHr ? String(Math.round(m.avgHr)) : '—', unit: 'bpm',
        sub: m.avgHr ? 'across the measured window' : 'no heart-rate data' }
    ];
    var host = els['trk-detail-stats'];
    host.textContent = '';
    tiles.forEach(function (t) {
      var tile = document.createElement('div');
      tile.className = 'stat-tile';
      var lab = document.createElement('div');
      lab.className = 'stat-label';
      lab.textContent = t.label;
      var val = document.createElement('div');
      val.className = 'stat-value';
      val.textContent = t.value;
      if (t.unit) {
        var unit = document.createElement('span');
        unit.className = 'stat-unit';
        unit.textContent = ' ' + t.unit;
        val.appendChild(unit);
      }
      var sub = document.createElement('div');
      sub.className = 'stat-sub';
      sub.textContent = t.sub;
      tile.appendChild(lab); tile.appendChild(val); tile.appendChild(sub);
      host.appendChild(tile);
    });
  }

  function renderBucketTable(res) {
    var body = els['trk-buckets-body'];
    body.textContent = '';
    var rows = res.buckets.map(function (b) {
      return { label: b.minutes + ' min', m: b.metrics };
    });
    rows.push({ label: 'Full window', m: res.overall, overall: true });
    rows.forEach(function (row) {
      var m = row.m;
      var tr = document.createElement('tr');
      if (row.overall) tr.className = 'overall';
      [ row.label,
        fmtDist(m.distance),
        fmtPace(m.avgSpeed),
        String(m.walks),
        fmtNum(walksPerDist(m), 2),
        fmtMinSec(m.avgRunSec),
        fmtMinSec(m.avgWalkSec),
        fmtNum(m.runTimePct, 0) + '%',
        m.avgHr ? String(Math.round(m.avgHr)) : '—'
      ].forEach(function (c, i) {
        var td = document.createElement('td');
        td.textContent = c;
        if (i >= 1) td.className = 'num';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function renderSegmentTable(res) {
    var body = els['trk-splits-body'];
    body.textContent = '';
    res.distanceSegments.forEach(function (seg) {
      var m = seg.metrics;
      var tr = document.createElement('tr');
      [ String(seg.index) + (seg.partial ? '*' : ''),
        fmtDur(seg.endSec),
        fmtDur(m.seconds),
        fmtPace(m.avgSpeed),
        String(m.walks),
        fmtDur(m.walkSeconds),
        m.avgHr ? String(Math.round(m.avgHr)) : '—'
      ].forEach(function (c, i) {
        var td = document.createElement('td');
        td.textContent = c;
        if (i >= 1) td.className = 'num';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  // ---- settings -------------------------------------------------------------

  function applySettingsToInputs() {
    els['trk-threshold'].value = (state.settings.thresholdMs * speedFactor()).toFixed(1);
    els['trk-min-seg'].value = state.settings.minSegmentSec;
    els['trk-trim-lead'].checked = state.settings.trimLeadingWalk;
    els['trk-trim-tail'].checked = state.settings.trimTrailingWalk;
    els['trk-unit-mi'].classList.toggle('active', imperial());
    els['trk-unit-mi'].setAttribute('aria-pressed', String(imperial()));
    els['trk-unit-km'].classList.toggle('active', !imperial());
    els['trk-unit-km'].setAttribute('aria-pressed', String(!imperial()));
    els['trk-metric'].value = state.metric;
  }

  function readSettings() {
    var raw = parseFloat(els['trk-threshold'].value);
    if (isFinite(raw) && raw > 0) {
      state.settings.thresholdMs = Math.min(Math.max(raw / speedFactor(), 0.2), 12);
    }
    var seg = parseInt(els['trk-min-seg'].value, 10);
    if (isFinite(seg)) state.settings.minSegmentSec = Math.min(Math.max(seg, 5), 300);
    state.settings.trimLeadingWalk = els['trk-trim-lead'].checked;
    state.settings.trimTrailingWalk = els['trk-trim-tail'].checked;
    persistSettings();
    applySettingsToInputs();
    render();
  }

  function setUnits(units) {
    state.settings.units = units === 'metric' ? 'metric' : 'imperial';
    persistSettings();
    applySettingsToInputs();
    render();
  }

  function persistSettings() {
    store.saveSettings({
      thresholdMs: state.settings.thresholdMs,
      minSegmentSec: state.settings.minSegmentSec,
      trimLeadingWalk: state.settings.trimLeadingWalk,
      trimTrailingWalk: state.settings.trimTrailingWalk,
      units: state.settings.units,
      metric: state.metric,
      buckets: state.buckets
    });
  }

  function restoreSettings() {
    var saved = store.loadSettings();
    if (!saved) return;
    if (isFinite(saved.thresholdMs) && saved.thresholdMs > 0) state.settings.thresholdMs = saved.thresholdMs;
    if (isFinite(saved.minSegmentSec)) state.settings.minSegmentSec = saved.minSegmentSec;
    if (typeof saved.trimLeadingWalk === 'boolean') state.settings.trimLeadingWalk = saved.trimLeadingWalk;
    if (typeof saved.trimTrailingWalk === 'boolean') state.settings.trimTrailingWalk = saved.trimTrailingWalk;
    if (saved.units) state.settings.units = saved.units;
    if (saved.metric && METRICS[saved.metric]) state.metric = saved.metric;
    if (Array.isArray(saved.buckets) && saved.buckets.length) state.buckets = saved.buckets;
  }

  // ---- export / import ------------------------------------------------------

  function exportHistory() {
    var json = store.toExport(state.activities, Date.now() / 1000);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'zone2-tracker-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus('Exported ' + state.activities.length + ' activit' +
      (state.activities.length === 1 ? 'y' : 'ies') + '.');
  }

  function importHistory(file) {
    readFile(file, true).then(function (text) {
      var parsed = store.fromExport(text);
      if (parsed.error) { setStatus('Import failed: ' + parsed.error, true); return; }
      var res = addActivities(parsed.activities);
      if (res.error) { setStatus(res.error, true); return; }
      state.cache = {};
      render();
      var msg = 'Imported ' + res.added + ' new activit' + (res.added === 1 ? 'y' : 'ies');
      if (res.replaced) msg += ' · ' + res.replaced + ' already present (updated)';
      if (parsed.skipped) msg += ' · ' + parsed.skipped + ' unreadable entr' +
        (parsed.skipped === 1 ? 'y' : 'ies') + ' skipped';
      setStatus(msg);
    }).catch(function (e) {
      setStatus('Import failed: ' + (e && e.message ? e.message : 'unreadable file'), true);
    });
  }

  // ---- events ---------------------------------------------------------------

  els['trk-file-input'].addEventListener('change', function () {
    if (this.files.length) handleFiles(this.files);
    this.value = '';
  });
  ['dragover', 'dragenter'].forEach(function (ev) {
    els['tracker-dropzone'].addEventListener(ev, function (e) {
      e.preventDefault();
      els['tracker-dropzone'].classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    els['tracker-dropzone'].addEventListener(ev, function (e) {
      e.preventDefault();
      els['tracker-dropzone'].classList.remove('dragging');
    });
  });
  els['tracker-dropzone'].addEventListener('drop', function (e) {
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });
  els['tracker-dropzone'].addEventListener('click', function (e) {
    if (e.target.closest('button, label')) return;
    els['trk-file-input'].click();
  });

  els['trk-demo-btn'].addEventListener('click', function () {
    var block = window.ATV.demo.generateZone2Block();
    var records = block.map(function (a) { return toActivity(a, a.name, 'demo'); });
    var res = addActivities(records);
    if (res.error) { setStatus(res.error, true); return; }
    state.selectedId = records[records.length - 1].id;
    render();
    setStatus('Added ' + res.added + ' demo activities' +
      (res.replaced ? ' (' + res.replaced + ' already present)' : '') + '.');
  });

  ['trk-threshold', 'trk-min-seg', 'trk-trim-lead', 'trk-trim-tail'].forEach(function (id) {
    els[id].addEventListener('change', readSettings);
  });
  els['trk-settings'].addEventListener('submit', function (e) { e.preventDefault(); });
  els['trk-unit-mi'].addEventListener('click', function () { setUnits('imperial'); });
  els['trk-unit-km'].addEventListener('click', function () { setUnits('metric'); });
  els['trk-reset'].addEventListener('click', function () {
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    persistSettings();
    applySettingsToInputs();
    render();
  });
  els['trk-metric'].addEventListener('change', function () {
    state.metric = METRICS[this.value] ? this.value : 'walks';
    persistSettings();
    renderTrend();
  });

  els['trk-export'].addEventListener('click', exportHistory);
  els['trk-import-input'].addEventListener('change', function () {
    if (this.files.length) importHistory(this.files[0]);
    this.value = '';
  });
  els['trk-clear'].addEventListener('click', function () {
    if (!state.activities.length) return;
    if (!window.confirm('Remove all ' + state.activities.length +
        ' stored activities? Export first if you want a copy.')) return;
    state.activities = [];
    state.cache = {};
    state.selectedId = null;
    store.save(state.activities);
    render();
    setStatus('History cleared.');
  });

  document.addEventListener('atv:tabshown', function (e) {
    if (e.detail && e.detail.id === 'tracker') chart.render();
  });

  // ---- init -----------------------------------------------------------------

  restoreSettings();
  applySettingsToInputs();
  state.activities = store.load();
  render();
})();
