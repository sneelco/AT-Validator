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

  function ATChart(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks || {};
    this.samples = [];
    this.state = null;     // { windowStart, windowLen, threshold, baseline, splitLen }
    this.hoverT = null;
    this.drag = null;
    this.absoluteT0 = null; // unix seconds of first sample, when known

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
      outside: v('--series-outside', '#b9b7ae')
    };
  };

  ATChart.prototype.setData = function (samples, absoluteT0) {
    this.samples = samples;
    this.absoluteT0 = absoluteT0 !== undefined ? absoluteT0 : null;
    this.hoverT = null;
    this.render();
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
    return {
      w: w, h: h,
      plotX: MARGIN.left, plotY: MARGIN.top,
      plotW: w - MARGIN.left - MARGIN.right,
      plotH: h - MARGIN.top - MARGIN.bottom
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
    if (this.state) hrMax = Math.max(hrMax, this.state.threshold);
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

      // Window wash + split ticks.
      ctx.fillStyle = P.wash;
      ctx.fillRect(wsX, L.plotY, weX - wsX, L.plotH);

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
        ctx.lineTo(x, L.plotY + L.plotH);
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

      // Baseline marker at window start.
      var bY = yOf(st.baseline);
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
      var bLabel = 'start ' + Math.round(st.baseline);
      var blx = Math.max(wsX - ctx.measureText(bLabel).width - 8, L.plotX + 2);
      ctx.fillText(bLabel, blx, Math.min(bY + 6, L.plotY + L.plotH - 12));
    } else {
      drawPath();
      ctx.strokeStyle = P.series;
      ctx.stroke();
    }

    // Crosshair + hover dot.
    if (this.hoverT !== null) {
      var hs = this.sampleAt(this.hoverT);
      if (hs) {
        var hx = xOf(hs.t);
        ctx.strokeStyle = P.axis;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(hx) + 0.5, L.plotY);
        ctx.lineTo(Math.round(hx) + 0.5, L.plotY + L.plotH);
        ctx.stroke();
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
      ctx.fillStyle = P.muted;
      ctx.fillText(fmtElapsed(t - D.tMin), x, L.plotY + L.plotH + 8);
    }

    // Axis baseline.
    ctx.strokeStyle = P.axis;
    ctx.beginPath();
    ctx.moveTo(L.plotX, Math.round(L.plotY + L.plotH) + 0.5);
    ctx.lineTo(L.plotX + L.plotW, Math.round(L.plotY + L.plotH) + 0.5);
    ctx.stroke();
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
