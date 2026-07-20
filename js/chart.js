/*
 * Canvas heart-rate chart with a draggable analysis window.
 *
 * - HR line: muted outside the window; series blue under the threshold and
 *   status red above it inside the window (clip-region painting, so crossings
 *   are pixel-exact).
 * - Threshold: dashed line across the window, recomputed from the heart rate
 *   at the window start whenever the window moves.
 * - Window: drag the body to move it; drag an edge handle to resize it
 *   (which updates the window-duration setting). Arrow keys nudge the window
 *   when the chart has focus (Shift for bigger steps).
 */
(function (global) {
  'use strict';

  var MARGIN = { top: 24, right: 16, bottom: 34, left: 48 };
  var HANDLE_PX = 7;   // half-width of the edge-grab zone
  var MIN_WINDOW = 5 * 60;
  var SPEED_H = 64;    // slim pace/speed strip height
  var SPEED_GAP = 12;  // gap between HR plot and the strip
  var DEV_TOL = 0.05;  // highlight beyond ±5% of the window median

  function ATChart(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks || {};
    this.samples = [];
    this.state = null;     // { windowStart, windowLen, threshold, baseline, splitLen }
    this.hoverT = null;
    this.drag = null;
    this.absoluteT0 = null; // unix seconds of first sample, when known
    this.hasSpeed = false;
    this.speedMode = 'pace'; // 'pace' (up = faster) | 'speed'
    this.units = 'metric';   // 'metric' (km) | 'imperial' (mi)

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'atv-chart-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label',
      'Heart rate chart with adjustable analysis window. Use arrow keys to move the window.');
    container.appendChild(this.canvas);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'atv-tooltip';
    this.tooltip.hidden = true;
    container.appendChild(this.tooltip);

    this.ctx = this.canvas.getContext('2d');

    var self = this;
    this.ro = new ResizeObserver(function () { self.render(); });
    this.ro.observe(container);

    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', function () { self.render(); });
    }

    this.canvas.addEventListener('pointerdown', function (e) { self.onPointerDown(e); });
    this.canvas.addEventListener('pointermove', function (e) { self.onPointerMove(e); });
    this.canvas.addEventListener('pointerup', function (e) { self.onPointerUp(e); });
    this.canvas.addEventListener('pointercancel', function (e) { self.onPointerUp(e); });
    this.canvas.addEventListener('pointerleave', function () {
      if (!self.drag) { self.hoverT = null; self.hideTooltip(); self.render(); }
    });
    this.canvas.addEventListener('keydown', function (e) { self.onKeyDown(e); });
  }

  ATChart.prototype.palette = function () {
    var cs = getComputedStyle(this.container);
    function v(name, fallback) {
      var val = cs.getPropertyValue(name).trim();
      return val || fallback;
    }
    return {
      surface: v('--surface-1', '#fcfcfb'),
      textPrimary: v('--text-primary', '#0b0b0b'),
      textSecondary: v('--text-secondary', '#52514e'),
      muted: v('--text-muted', '#898781'),
      grid: v('--gridline', '#e1e0d9'),
      axis: v('--baseline', '#c3c2b7'),
      series: v('--series-1', '#2a78d6'),
      over: v('--status-critical', '#d03b3b'),
      wash: v('--window-wash', 'rgba(42, 120, 214, 0.08)'),
      washEdge: v('--window-edge', 'rgba(42, 120, 214, 0.55)'),
      outside: v('--series-outside', '#b9b7ae'),
      speed: v('--series-speed', '#008300'),
      deviate: v('--amber-text', '#8a5f00')
    };
  };

  ATChart.prototype.setData = function (samples, absoluteT0) {
    this.samples = samples;
    this.absoluteT0 = absoluteT0 !== undefined ? absoluteT0 : null;
    this.hoverT = null;
    var withSpeed = 0;
    for (var i = 0; i < samples.length; i++) {
      if (samples[i].speed !== undefined && samples[i].speed !== null && samples[i].speed > 0.05) withSpeed++;
    }
    this.hasSpeed = samples.length > 0 && withSpeed / samples.length > 0.5;
    this.render();
  };

  ATChart.prototype.setSpeedMode = function (mode) {
    this.speedMode = mode === 'speed' ? 'speed' : 'pace';
    this.render();
  };

  ATChart.prototype.setUnits = function (units) {
    this.units = units === 'imperial' ? 'imperial' : 'metric';
    this.render();
  };

  // Displayed value for the strip: km/h / mph, or s-per-km / s-per-mi for pace.
  ATChart.prototype.speedValue = function (v) {
    if (this.speedMode === 'speed') {
      return this.units === 'imperial' ? v * 2.236936 : v * 3.6;
    }
    return (this.units === 'imperial' ? 1609.344 : 1000) / v;
  };

  ATChart.prototype.unitLabel = function () {
    if (this.speedMode === 'speed') return this.units === 'imperial' ? 'mph' : 'km/h';
    return this.units === 'imperial' ? 'min/mi' : 'min/km';
  };

  ATChart.prototype.setState = function (state) {
    this.state = state;
    this.render();
  };

  // ---- scales ------------------------------------------------------------

  ATChart.prototype.layout = function () {
    var rect = this.container.getBoundingClientRect();
    var w = Math.max(rect.width, 320);
    var h = Math.max(rect.height, 240);
    var stripSpace = this.hasSpeed ? SPEED_H + SPEED_GAP : 0;
    var plotH = h - MARGIN.top - MARGIN.bottom - stripSpace;
    return {
      w: w, h: h,
      plotX: MARGIN.left, plotY: MARGIN.top,
      plotW: w - MARGIN.left - MARGIN.right,
      plotH: plotH,
      speedY: MARGIN.top + plotH + SPEED_GAP,
      speedH: SPEED_H,
      bottomY: MARGIN.top + plotH + stripSpace   // where x-axis labels sit
    };
  };

  ATChart.prototype.domain = function () {
    var s = this.samples;
    if (!s.length) return null;
    var tMin = s[0].t, tMax = s[s.length - 1].t;
    if (tMax <= tMin) tMax = tMin + 1;
    var hrMin = Infinity, hrMax = -Infinity;
    for (var i = 0; i < s.length; i++) {
      if (s[i].hr < hrMin) hrMin = s[i].hr;
      if (s[i].hr > hrMax) hrMax = s[i].hr;
    }
    if (this.state) {
      hrMax = Math.max(hrMax, this.state.threshold);
      if (this.state.suspectedAeT) {
        hrMax = Math.max(hrMax, this.state.suspectedAeT);
        hrMin = Math.min(hrMin, this.state.suspectedAeT);
      }
    }
    var pad = Math.max(4, (hrMax - hrMin) * 0.08);
    return { tMin: tMin, tMax: tMax, hrMin: Math.max(0, hrMin - pad), hrMax: hrMax + pad };
  };

  // ---- rendering ---------------------------------------------------------

  ATChart.prototype.render = function () {
    var L = this.layout();
    var dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(L.w * dpr) || this.canvas.height !== Math.round(L.h * dpr)) {
      this.canvas.width = Math.round(L.w * dpr);
      this.canvas.height = Math.round(L.h * dpr);
      this.canvas.style.width = L.w + 'px';
      this.canvas.style.height = L.h + 'px';
    }
    var ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var P = this.palette();
    ctx.clearRect(0, 0, L.w, L.h);

    var D = this.domain();
    if (!D) {
      ctx.fillStyle = P.muted;
      ctx.font = '14px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Load an activity to see the chart', L.w / 2, L.h / 2);
      return;
    }

    var self = this;
    var xOf = function (t) { return L.plotX + (t - D.tMin) / (D.tMax - D.tMin) * L.plotW; };
    var yOf = function (hr) { return L.plotY + (1 - (hr - D.hrMin) / (D.hrMax - D.hrMin)) * L.plotH; };
    this._xOf = xOf; this._yOf = yOf; this._D = D; this._L = L;

    this.drawGrid(ctx, L, D, P, xOf, yOf);

    var st = this.state;
    var wsX = null, weX = null, thY = null;
    if (st) {
      wsX = xOf(Math.max(st.windowStart, D.tMin));
      weX = xOf(Math.min(st.windowStart + st.windowLen, D.tMax + st.windowLen));
      weX = Math.min(weX, L.plotX + L.plotW);
      thY = yOf(st.threshold);

      // Window wash + split ticks (wash spans the speed strip too).
      var washBottom = this.hasSpeed ? L.speedY + L.speedH : L.plotY + L.plotH;
      ctx.fillStyle = P.wash;
      ctx.fillRect(wsX, L.plotY, weX - wsX, washBottom - L.plotY);

      ctx.strokeStyle = P.grid;
      ctx.lineWidth = 1;
      for (var sp = st.windowStart + st.splitLen; sp < st.windowStart + st.windowLen; sp += st.splitLen) {
        var spx = xOf(sp);
        if (spx <= wsX || spx >= weX) continue;
        ctx.beginPath();
        ctx.moveTo(Math.round(spx) + 0.5, L.plotY);
        ctx.lineTo(Math.round(spx) + 0.5, L.plotY + L.plotH);
        ctx.stroke();
      }

      // Window edges.
      ctx.strokeStyle = P.washEdge;
      ctx.lineWidth = 2;
      [wsX, weX].forEach(function (x) {
        ctx.beginPath();
        ctx.moveTo(x, L.plotY);
        ctx.lineTo(x, washBottom);
        ctx.stroke();
      });
      // Edge grab handles.
      ctx.fillStyle = P.washEdge;
      [wsX, weX].forEach(function (x) {
        roundRect(ctx, x - 3, L.plotY + L.plotH / 2 - 12, 6, 24, 3);
        ctx.fill();
      });
    }

    // HR line, painted in three clip regions for exact crossings.
    var drawPath = function () {
      ctx.beginPath();
      var s = self.samples;
      var prevT = null;
      for (var i = 0; i < s.length; i++) {
        var x = xOf(s[i].t), y = yOf(s[i].hr);
        if (prevT === null || s[i].t - prevT > 60) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        prevT = s[i].t;
      }
    };
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (st) {
      // Outside the window: muted.
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.plotX, L.plotY - 4, Math.max(wsX - L.plotX, 0), L.plotH + 8);
      ctx.rect(weX, L.plotY - 4, Math.max(L.plotX + L.plotW - weX, 0), L.plotH + 8);
      ctx.clip();
      drawPath();
      ctx.strokeStyle = P.outside;
      ctx.stroke();
      ctx.restore();

      // Inside, below threshold: series blue.
      ctx.save();
      ctx.beginPath();
      ctx.rect(wsX, thY, weX - wsX, L.plotY + L.plotH + 8 - thY);
      ctx.clip();
      drawPath();
      ctx.strokeStyle = P.series;
      ctx.stroke();
      ctx.restore();

      // Inside, above threshold: status red.
      ctx.save();
      ctx.beginPath();
      ctx.rect(wsX, L.plotY - 4, weX - wsX, thY - (L.plotY - 4));
      ctx.clip();
      drawPath();
      ctx.strokeStyle = P.over;
      ctx.stroke();
      ctx.restore();

      // Threshold line (dashed = threshold semantics, not grid).
      ctx.save();
      ctx.strokeStyle = P.over;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(wsX, thY);
      ctx.lineTo(weX, thY);
      ctx.stroke();
      ctx.restore();

      // Suspected-AeT reference: a subtle full-width line, labeled at the
      // right edge so it never collides with the threshold label.
      if (st.suspectedAeT) {
        var aY = Math.round(yOf(st.suspectedAeT)) + 0.5;
        ctx.save();
        ctx.strokeStyle = P.muted;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(L.plotX, aY);
        ctx.lineTo(L.plotX + L.plotW, aY);
        ctx.stroke();
        ctx.restore();
        ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillStyle = P.muted;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('AeT ' + Math.round(st.suspectedAeT), L.plotX + L.plotW - 4, aY - 2);
      }

      // Baseline guide across the window (dotted — the designated start HR,
      // which may be manually refined via the vertical slider).
      var bY = yOf(st.baseline);
      ctx.save();
      ctx.strokeStyle = P.series;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(wsX, bY);
      ctx.lineTo(weX, bY);
      ctx.stroke();
      ctx.restore();

      // Baseline marker at window start.
      ctx.beginPath();
      ctx.arc(wsX, bY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = P.series;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = P.surface;
      ctx.stroke();

      // Direct labels: threshold value and baseline value (text tokens, keyed
      // by placement next to their marks — text never wears the data color).
      ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = P.textSecondary;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      var thLabel = 'threshold ' + Math.round(st.threshold);
      var tlx = Math.min(wsX + 6, L.plotX + L.plotW - ctx.measureText(thLabel).width - 4);
      ctx.fillText(thLabel, tlx, thY - 3);
      ctx.textBaseline = 'top';
      var bLabel = 'base ' + Math.round(st.baseline);
      var blx = Math.max(wsX - ctx.measureText(bLabel).width - 8, L.plotX + 2);
      ctx.fillText(bLabel, blx, Math.min(bY + 6, L.plotY + L.plotH - 12));
    } else {
      drawPath();
      ctx.strokeStyle = P.series;
      ctx.stroke();
    }

    if (this.hasSpeed) this.drawSpeedStrip(ctx, L, D, P, xOf, wsX, weX);

    // Crosshair + hover dot.
    if (this.hoverT !== null) {
      var hs = this.sampleAt(this.hoverT);
      if (hs) {
        var hx = xOf(hs.t);
        ctx.strokeStyle = P.axis;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(hx) + 0.5, L.plotY);
        ctx.lineTo(Math.round(hx) + 0.5,
          this.hasSpeed ? L.speedY + L.speedH : L.plotY + L.plotH);
        ctx.stroke();
        if (this.hasSpeed && this._speedYOf && hs.speed !== undefined &&
            hs.speed !== null && hs.speed > 0.05) {
          var sy = this._speedYOf(this.speedValue(hs.speed));
          if (sy >= L.speedY - 2 && sy <= L.speedY + L.speedH + 2) {
            ctx.beginPath();
            ctx.arc(hx, sy, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = P.speed;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = P.surface;
            ctx.stroke();
          }
        }
        var hy = yOf(hs.hr);
        var inWin = st && hs.t >= st.windowStart && hs.t <= st.windowStart + st.windowLen;
        ctx.beginPath();
        ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = inWin ? (hs.hr > st.threshold ? P.over : P.series) : P.outside;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = P.surface;
        ctx.stroke();
      }
    }
  };

  ATChart.prototype.drawGrid = function (ctx, L, D, P, xOf, yOf) {
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

    // Y (heart rate): clean bpm steps.
    var hrSpan = D.hrMax - D.hrMin;
    var yStep = [2, 5, 10, 20, 25, 50].find(function (s) { return hrSpan / s <= 8; }) || 50;
    var yStart = Math.ceil(D.hrMin / yStep) * yStep;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var hr = yStart; hr <= D.hrMax; hr += yStep) {
      var y = Math.round(yOf(hr)) + 0.5;
      ctx.strokeStyle = P.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L.plotX, y);
      ctx.lineTo(L.plotX + L.plotW, y);
      ctx.stroke();
      ctx.fillStyle = P.muted;
      ctx.fillText(String(hr), L.plotX - 8, y);
    }
    // Y axis title.
    ctx.save();
    ctx.translate(12, L.plotY + L.plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.muted;
    ctx.fillText('bpm', 0, 0);
    ctx.restore();

    // X (elapsed time).
    var tSpan = D.tMax - D.tMin;
    var xStep = [60, 120, 300, 600, 900, 1200, 1800, 3600, 7200]
      .find(function (s) { return tSpan / s <= 9; }) || 7200;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var xStart = Math.ceil((D.tMin) / xStep) * xStep;
    for (var t = xStart; t <= D.tMax; t += xStep) {
      var x = Math.round(xOf(t)) + 0.5;
      ctx.strokeStyle = P.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, L.plotY);
      ctx.lineTo(x, L.plotY + L.plotH);
      ctx.stroke();
      if (this.hasSpeed) {
        ctx.beginPath();
        ctx.moveTo(x, L.speedY);
        ctx.lineTo(x, L.speedY + L.speedH);
        ctx.stroke();
      }
      ctx.fillStyle = P.muted;
      ctx.fillText(fmtElapsed(t - D.tMin), x, L.bottomY + 8);
    }

    // Axis baseline.
    ctx.strokeStyle = P.axis;
    ctx.beginPath();
    ctx.moveTo(L.plotX, Math.round(L.plotY + L.plotH) + 0.5);
    ctx.lineTo(L.plotX + L.plotW, Math.round(L.plotY + L.plotH) + 0.5);
    ctx.stroke();
  };

  // Slim pace/speed strip below the HR plot. Up = faster in both modes.
  // Segments deviating more than DEV_TOL from the window median are amber.
  ATChart.prototype.drawSpeedStrip = function (ctx, L, D, P, xOf, wsX, weX) {
    var self = this;
    var s = this.samples;
    var st = this.state;

    // Per-sample displayed values, then a rolling median (~15 samples): raw
    // per-second deltas (especially distance-derived ones) are heavily
    // quantized, and the strip should show pacing, not quantization noise.
    var raw = new Array(s.length);
    for (var r = 0; r < s.length; r++) {
      var rsp = s[r].speed;
      raw[r] = (rsp === undefined || rsp === null || rsp <= 0.3) ? null : this.speedValue(rsp);
    }
    var smooth = new Array(s.length);
    var HALF = 7;
    for (var m = 0; m < s.length; m++) {
      if (raw[m] === null) { smooth[m] = null; continue; }
      var windowVals = [];
      for (var q = Math.max(0, m - HALF); q <= Math.min(s.length - 1, m + HALF); q++) {
        if (raw[q] !== null) windowVals.push(raw[q]);
      }
      windowVals.sort(function (a, b) { return a - b; });
      smooth[m] = windowVals[windowVals.length >> 1];
    }

    var vals = [];
    var winVals = [];
    for (var i = 0; i < s.length; i++) {
      if (smooth[i] === null) continue;
      vals.push(smooth[i]);
      if (st && s[i].t >= st.windowStart && s[i].t < st.windowStart + st.windowLen) winVals.push(smooth[i]);
    }
    if (vals.length < 10) return;
    // Scale the axis to the ANALYSIS WINDOW's pace range, not the whole
    // activity — otherwise a cooldown walk compresses the axis until
    // in-window drift is invisible. Out-of-window segments clamp to the edge.
    var domainVals = winVals.length >= 10 ? winVals.slice() : vals.slice();
    domainVals.sort(function (a, b) { return a - b; });
    var lo = domainVals[Math.floor(domainVals.length * 0.05)];
    var hi = domainVals[Math.floor(domainVals.length * 0.95)];
    if (hi - lo < 1e-6) { hi = lo + 1; }
    var pad = Math.max((hi - lo) * 0.25, hi * 0.025);
    lo -= pad; hi += pad;
    vals.sort(function (a, b) { return a - b; });

    // Up = faster: km/h maps normally, pace (s/km) inverts.
    var invert = this.speedMode === 'pace';
    var yOfV = function (v) {
      var f = (v - lo) / (hi - lo);
      f = Math.max(0, Math.min(1, f));
      return invert ? L.speedY + f * L.speedH : L.speedY + (1 - f) * L.speedH;
    };
    this._speedYOf = yOfV;

    // Median of the window (or whole activity when no window).
    var medArr = winVals.length >= 10 ? winVals.slice() : vals.slice();
    medArr.sort(function (a, b) { return a - b; });
    var median = medArr[medArr.length >> 1];

    // Panel frame line + title + two tick labels.
    ctx.strokeStyle = P.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L.plotX, Math.round(L.speedY + L.speedH) + 0.5);
    ctx.lineTo(L.plotX + L.plotW, Math.round(L.speedY + L.speedH) + 0.5);
    ctx.stroke();
    ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillStyle = P.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText((this.speedMode === 'pace' ? 'pace (' : 'speed (') + this.unitLabel() + ')',
      L.plotX + 2, L.speedY - 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var topVal = invert ? lo : hi;
    var botVal = invert ? hi : lo;
    ctx.fillText(this.fmtSpeedVal(topVal), L.plotX - 6, L.speedY + 5);
    ctx.fillText(this.fmtSpeedVal(botVal), L.plotX - 6, L.speedY + L.speedH - 5);

    var drawPath = function () {
      ctx.beginPath();
      var prevT = null;
      for (var j = 0; j < s.length; j++) {
        if (smooth[j] === null) { prevT = null; continue; }
        var x = xOf(s[j].t), y = yOfV(smooth[j]);
        if (prevT === null || s[j].t - prevT > 60) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        prevT = s[j].t;
      }
    };
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    var stripTop = L.speedY - 2, stripBot = L.speedY + L.speedH + 2;
    if (st && wsX !== null) {
      // Outside the window: muted.
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.plotX, stripTop, Math.max(wsX - L.plotX, 0), stripBot - stripTop);
      ctx.rect(weX, stripTop, Math.max(L.plotX + L.plotW - weX, 0), stripBot - stripTop);
      ctx.clip();
      drawPath();
      ctx.strokeStyle = P.outside;
      ctx.stroke();
      ctx.restore();

      // Median guide across the window.
      var medY = yOfV(median);
      ctx.save();
      ctx.strokeStyle = P.speed;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(wsX, medY);
      ctx.lineTo(weX, medY);
      ctx.stroke();
      ctx.restore();

      // Inside, within ±DEV_TOL of the median: normal green.
      var bandA = yOfV(median * (1 + DEV_TOL));
      var bandB = yOfV(median * (1 - DEV_TOL));
      var bandTop = Math.min(bandA, bandB), bandBot = Math.max(bandA, bandB);
      ctx.save();
      ctx.beginPath();
      ctx.rect(wsX, bandTop, weX - wsX, bandBot - bandTop);
      ctx.clip();
      drawPath();
      ctx.strokeStyle = P.speed;
      ctx.stroke();
      ctx.restore();

      // Inside, deviating: amber, slightly heavier.
      ctx.save();
      ctx.beginPath();
      ctx.rect(wsX, stripTop, weX - wsX, Math.max(bandTop - stripTop, 0));
      ctx.rect(wsX, bandBot, weX - wsX, Math.max(stripBot - bandBot, 0));
      ctx.clip();
      ctx.lineWidth = 2;
      drawPath();
      ctx.strokeStyle = P.deviate;
      ctx.stroke();
      ctx.restore();
    } else {
      drawPath();
      ctx.strokeStyle = P.speed;
      ctx.stroke();
    }
  };

  ATChart.prototype.fmtSpeedVal = function (v) {
    if (this.speedMode === 'speed') return v.toFixed(1);
    var sec = Math.round(v);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  // ---- interaction -------------------------------------------------------

  ATChart.prototype.eventT = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var D = this._D, L = this._L;
    if (!D) return null;
    return D.tMin + (x - L.plotX) / L.plotW * (D.tMax - D.tMin);
  };

  ATChart.prototype.hitTest = function (e) {
    if (!this.state || !this._D) return 'none';
    var rect = this.canvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var wsX = this._xOf(this.state.windowStart);
    var weX = this._xOf(this.state.windowStart + this.state.windowLen);
    if (Math.abs(x - wsX) <= HANDLE_PX) return 'left-edge';
    if (Math.abs(x - weX) <= HANDLE_PX) return 'right-edge';
    if (x > wsX && x < weX) return 'body';
    return 'none';
  };

  ATChart.prototype.onPointerDown = function (e) {
    if (!this.state || !this.samples.length) return;
    var hit = this.hitTest(e);
    if (hit === 'none') return;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = {
      mode: hit,
      startT: this.eventT(e),
      windowStart0: this.state.windowStart,
      windowLen0: this.state.windowLen
    };
    this.hideTooltip();
    e.preventDefault();
  };

  ATChart.prototype.onPointerMove = function (e) {
    if (!this._D) return;
    if (this.drag) {
      var dt = this.eventT(e) - this.drag.startT;
      var d = this.drag;
      if (d.mode === 'body') {
        this.emitWindow(d.windowStart0 + dt, d.windowLen0, false);
      } else if (d.mode === 'left-edge') {
        var newStart = Math.min(d.windowStart0 + dt, d.windowStart0 + d.windowLen0 - MIN_WINDOW);
        this.emitWindow(newStart, d.windowLen0 + (d.windowStart0 - newStart), true);
      } else if (d.mode === 'right-edge') {
        this.emitWindow(d.windowStart0, Math.max(d.windowLen0 + dt, MIN_WINDOW), true);
      }
      return;
    }
    var hit = this.hitTest(e);
    this.canvas.style.cursor =
      hit === 'body' ? 'grab' : (hit === 'none' ? 'crosshair' : 'ew-resize');
    this.hoverT = this.eventT(e);
    this.showTooltip(e);
    this.render();
  };

  ATChart.prototype.onPointerUp = function (e) {
    if (this.drag) {
      this.drag = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* released */ }
    }
  };

  ATChart.prototype.onKeyDown = function (e) {
    if (!this.state) return;
    var step = e.shiftKey ? 300 : 60;
    if (e.key === 'ArrowLeft') {
      this.emitWindow(this.state.windowStart - step, this.state.windowLen, false);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      this.emitWindow(this.state.windowStart + step, this.state.windowLen, false);
      e.preventDefault();
    }
  };

  ATChart.prototype.emitWindow = function (start, len, resized) {
    if (this.callbacks.onWindowChange) this.callbacks.onWindowChange(start, len, !!resized);
  };

  ATChart.prototype.sampleAt = function (t) {
    var s = this.samples;
    if (!s.length) return null;
    var lo = 0, hi = s.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (s[mid].t < t) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(s[lo - 1].t - t) < Math.abs(s[lo].t - t)) lo--;
    return s[lo];
  };

  ATChart.prototype.showTooltip = function (e) {
    var hs = this.sampleAt(this.hoverT);
    if (!hs) { this.hideTooltip(); return; }
    var st = this.state;
    var tt = this.tooltip;
    tt.textContent = '';

    var timeRow = document.createElement('div');
    timeRow.className = 'atv-tooltip-time';
    var timeStr = fmtElapsed(hs.t - this.samples[0].t);
    if (this.absoluteT0 !== null) {
      var d = new Date((this.absoluteT0 + (hs.t - this.samples[0].t)) * 1000);
      timeStr += ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    timeRow.textContent = timeStr;
    tt.appendChild(timeRow);

    var hrRow = document.createElement('div');
    hrRow.className = 'atv-tooltip-value';
    var key = document.createElement('span');
    key.className = 'atv-tooltip-key';
    var inWin = st && hs.t >= st.windowStart && hs.t <= st.windowStart + st.windowLen;
    key.classList.add(inWin ? (hs.hr > st.threshold ? 'over' : 'under') : 'outside');
    hrRow.appendChild(key);
    var strong = document.createElement('strong');
    strong.textContent = hs.hr + ' bpm';
    hrRow.appendChild(strong);
    if (inWin && st) {
      var delta = document.createElement('span');
      delta.className = 'atv-tooltip-delta';
      var diff = hs.hr - st.threshold;
      delta.textContent = diff > 0
        ? '+' + Math.round(diff) + ' over threshold'
        : Math.round(-diff) + ' under threshold';
      hrRow.appendChild(delta);
    }
    tt.appendChild(hrRow);

    if (this.hasSpeed && hs.speed !== undefined && hs.speed !== null && hs.speed > 0.05) {
      var spRow = document.createElement('div');
      spRow.className = 'atv-tooltip-value';
      var spKey = document.createElement('span');
      spKey.className = 'atv-tooltip-key speed';
      spRow.appendChild(spKey);
      var spStrong = document.createElement('strong');
      spStrong.textContent = this.speedMode === 'speed'
        ? this.speedValue(hs.speed).toFixed(1) + ' ' + this.unitLabel()
        : this.fmtSpeedVal(this.speedValue(hs.speed)) + ' /' + (this.units === 'imperial' ? 'mi' : 'km');
      spRow.appendChild(spStrong);
      tt.appendChild(spRow);
    }

    tt.hidden = false;
    var rect = this.container.getBoundingClientRect();
    var x = e.clientX - rect.left + 14;
    var y = e.clientY - rect.top - 10;
    if (x + tt.offsetWidth > rect.width - 8) x = e.clientX - rect.left - tt.offsetWidth - 14;
    if (y + tt.offsetHeight > rect.height - 4) y = rect.height - tt.offsetHeight - 4;
    tt.style.left = Math.max(x, 4) + 'px';
    tt.style.top = Math.max(y, 4) + 'px';
  };

  ATChart.prototype.hideTooltip = function () {
    this.tooltip.hidden = true;
  };

  // ---- helpers -----------------------------------------------------------

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fmtElapsed(sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0');
    if (s === 0) return m + ':00';
    return m + ':' + String(s).padStart(2, '0');
  }

  var api = { ATChart: ATChart, fmtElapsed: fmtElapsed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.chart = api;
})(typeof window !== 'undefined' ? window : globalThis);
