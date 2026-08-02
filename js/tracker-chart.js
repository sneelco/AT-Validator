/*
 * Trend chart for the tracker: one metric across activities, one line per
 * fixed window (30 / 45 / 60 … minutes).
 *
 * Canvas, theme-aware, no dependencies — the same approach as the validator's
 * chart. Colors come from the categorical slots in css/style.css (validated for
 * colorblind separation in both light and dark); identity is never carried by
 * color alone: every line is direct-labeled at its right end and repeated in
 * the legend, and the table below the chart is the same data in text.
 */
(function (global) {
  'use strict';

  var MARGIN = { top: 18, right: 74, bottom: 34, left: 58 };
  var DOT_R = 4;      // 8px markers
  var LINE_W = 2;

  function TrendChart(container) {
    this.container = container;
    this.series = [];
    this.xLabels = [];
    this.format = function (v) { return String(Math.round(v)); };
    this.yTitle = '';
    this.hoverIdx = null;
    this.empty = 'No activities yet.';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'atv-chart-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Trend across stored activities');
    container.appendChild(this.canvas);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'atv-tooltip';
    this.tooltip.hidden = true;
    container.appendChild(this.tooltip);

    this.ctx = this.canvas.getContext('2d');

    var self = this;
    this.ro = new ResizeObserver(function () { self.render(); });
    this.ro.observe(container);
    if (global.matchMedia) {
      global.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', function () { self.render(); });
    }
    this.canvas.addEventListener('pointermove', function (e) { self.onMove(e); });
    this.canvas.addEventListener('pointerleave', function () {
      self.hoverIdx = null; self.tooltip.hidden = true; self.render();
    });
  }

  TrendChart.prototype.palette = function () {
    var cs = getComputedStyle(this.container);
    function v(name, fallback) { return cs.getPropertyValue(name).trim() || fallback; }
    return {
      text: v('--text-primary', '#0b0b0b'),
      secondary: v('--text-secondary', '#52514e'),
      muted: v('--text-muted', '#898781'),
      grid: v('--gridline', '#e1e0d9'),
      axis: v('--baseline', '#c3c2b7'),
      surface: v('--surface-1', '#fcfcfb'),
      series: [
        v('--series-1', '#2a78d6'), v('--series-2', '#eb6834'), v('--series-3', '#1baf7a'),
        v('--series-4', '#eda100'), v('--series-5', '#e87ba4')
      ]
    };
  };

  /*
   * data: {
   *   series: [{ label, points: [{ x, y } | null] }],   // x = activity index
   *   xLabels: ['Jul 3', …],                            // one per activity
   *   format(v) -> string, yTitle, empty
   * }
   */
  TrendChart.prototype.setData = function (data) {
    this.series = (data.series || []).slice(0, 5);
    this.xLabels = data.xLabels || [];
    this.format = data.format || this.format;
    this.yTitle = data.yTitle || '';
    this.empty = data.empty || this.empty;
    this.hoverIdx = null;
    this.tooltip.hidden = true;
    this.render();
  };

  TrendChart.prototype.layout = function () {
    var rect = this.container.getBoundingClientRect();
    var w = Math.max(rect.width, 280);
    var h = Math.max(rect.height, 180);
    return {
      w: w, h: h,
      x: MARGIN.left, y: MARGIN.top,
      pw: Math.max(w - MARGIN.left - MARGIN.right, 10),
      ph: Math.max(h - MARGIN.top - MARGIN.bottom, 10)
    };
  };

  TrendChart.prototype.domain = function () {
    var lo = Infinity, hi = -Infinity, count = this.xLabels.length;
    this.series.forEach(function (s) {
      s.points.forEach(function (p) {
        if (!p || !isFinite(p.y)) return;
        if (p.y < lo) lo = p.y;
        if (p.y > hi) hi = p.y;
      });
    });
    if (!isFinite(lo)) return null;
    if (hi === lo) { hi = lo + Math.max(Math.abs(lo) * 0.1, 1); lo = lo - Math.max(Math.abs(lo) * 0.1, 1); }
    var pad = (hi - lo) * 0.12;
    return { lo: lo - pad, hi: hi + pad, count: Math.max(count, 1) };
  };

  TrendChart.prototype.render = function () {
    var L = this.layout();
    var dpr = global.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(L.w * dpr) || this.canvas.height !== Math.round(L.h * dpr)) {
      this.canvas.width = Math.round(L.w * dpr);
      this.canvas.height = Math.round(L.h * dpr);
      this.canvas.style.width = L.w + 'px';
      this.canvas.style.height = L.h + 'px';
    }
    var c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, L.w, L.h);
    var P = this.palette();
    c.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

    var dom = this.domain();
    if (!dom) {
      c.fillStyle = P.muted;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(this.empty, L.w / 2, L.h / 2);
      return;
    }

    var self = this;
    var xAt = function (i) {
      return dom.count === 1 ? L.x + L.pw / 2 : L.x + L.pw * i / (dom.count - 1);
    };
    var yAt = function (v) { return L.y + L.ph * (1 - (v - dom.lo) / (dom.hi - dom.lo)); };

    // Gridlines + y ticks (recessive).
    var ticks = niceTicks(dom.lo, dom.hi, 5);
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    ticks.forEach(function (t) {
      var y = yAt(t);
      if (y < L.y - 1 || y > L.y + L.ph + 1) return;
      c.strokeStyle = P.grid;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(L.x, Math.round(y) + 0.5);
      c.lineTo(L.x + L.pw, Math.round(y) + 0.5);
      c.stroke();
      c.fillStyle = P.muted;
      c.fillText(self.format(t), L.x - 8, y);
    });

    // X labels, thinned so they never collide.
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.fillStyle = P.muted;
    var step = Math.max(1, Math.ceil(this.xLabels.length / Math.max(Math.floor(L.pw / 74), 1)));
    this.xLabels.forEach(function (lab, i) {
      if (i % step !== 0 && i !== self.xLabels.length - 1) return;
      c.fillText(lab, xAt(i), L.y + L.ph + 8);
    });

    // Hover crosshair sits under the marks.
    if (this.hoverIdx !== null) {
      c.strokeStyle = P.axis;
      c.lineWidth = 1;
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(Math.round(xAt(this.hoverIdx)) + 0.5, L.y);
      c.lineTo(Math.round(xAt(this.hoverIdx)) + 0.5, L.y + L.ph);
      c.stroke();
      c.setLineDash([]);
    }

    var endLabels = [];
    this.series.forEach(function (s, si) {
      var color = P.series[si % P.series.length];
      var pts = s.points.map(function (p, i) {
        return p && isFinite(p.y) ? { x: xAt(i), y: yAt(p.y), v: p.y, i: i } : null;
      }).filter(Boolean);
      if (!pts.length) return;
      c.strokeStyle = color;
      c.lineWidth = LINE_W;
      c.lineJoin = 'round';
      c.beginPath();
      pts.forEach(function (p, i) { i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y); });
      c.stroke();
      // 2px surface ring so overlapping series stay separable.
      pts.forEach(function (p) {
        c.beginPath();
        c.arc(p.x, p.y, DOT_R, 0, Math.PI * 2);
        c.fillStyle = color;
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = P.surface;
        c.stroke();
      });
      // Direct label at the right end — identity without relying on color.
      var last = pts[pts.length - 1];
      endLabels.push({ text: s.label, x: Math.min(last.x + 9, L.x + L.pw + 8), y: last.y });
    });

    // Converging lines would stack their labels on top of each other; spread
    // them just enough to stay legible.
    endLabels.sort(function (a, b) { return a.y - b.y; });
    for (var li = 1; li < endLabels.length; li++) {
      if (endLabels[li].y - endLabels[li - 1].y < 13) endLabels[li].y = endLabels[li - 1].y + 13;
    }
    var overflow = endLabels.length
      ? endLabels[endLabels.length - 1].y - (L.y + L.ph) : 0;
    if (overflow > 0) endLabels.forEach(function (l) { l.y -= overflow; });
    c.fillStyle = P.secondary;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    endLabels.forEach(function (l) { c.fillText(l.text, l.x, Math.max(l.y, L.y)); });

    if (this.yTitle) {
      c.save();
      c.translate(12, L.y + L.ph / 2);
      c.rotate(-Math.PI / 2);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = P.muted;
      c.fillText(this.yTitle, 0, 0);
      c.restore();
    }
  };

  TrendChart.prototype.onMove = function (e) {
    if (!this.series.length || !this.xLabels.length) return;
    var L = this.layout();
    var rect = this.canvas.getBoundingClientRect();
    var px = e.clientX - rect.left;
    var count = this.xLabels.length;
    var frac = count === 1 ? 0 : (px - L.x) / L.pw * (count - 1);
    var idx = Math.round(Math.min(Math.max(frac, 0), count - 1));
    if (idx !== this.hoverIdx) { this.hoverIdx = idx; this.render(); }
    this.showTooltip(e, idx);
  };

  TrendChart.prototype.showTooltip = function (e, idx) {
    var tt = this.tooltip;
    tt.textContent = '';
    var head = document.createElement('div');
    head.className = 'atv-tooltip-time';
    head.textContent = this.xLabels[idx] || '';
    tt.appendChild(head);
    var P = this.palette();
    var any = false;
    var self = this;
    this.series.forEach(function (s, si) {
      var p = s.points[idx];
      if (!p || !isFinite(p.y)) return;
      any = true;
      var row = document.createElement('div');
      row.className = 'atv-tooltip-value';
      var key = document.createElement('span');
      key.className = 'atv-tooltip-key';
      key.style.borderTopColor = P.series[si % P.series.length];
      row.appendChild(key);
      var strong = document.createElement('strong');
      strong.textContent = self.format(p.y);
      row.appendChild(strong);
      var lab = document.createElement('span');
      lab.className = 'atv-tooltip-delta';
      lab.textContent = s.label;
      row.appendChild(lab);
      tt.appendChild(row);
    });
    if (!any) { tt.hidden = true; return; }
    tt.hidden = false;
    var rect = this.container.getBoundingClientRect();
    var x = e.clientX - rect.left + 14;
    var y = e.clientY - rect.top - 10;
    if (x + tt.offsetWidth > rect.width - 8) x = e.clientX - rect.left - tt.offsetWidth - 14;
    if (y + tt.offsetHeight > rect.height - 4) y = rect.height - tt.offsetHeight - 4;
    tt.style.left = Math.max(x, 4) + 'px';
    tt.style.top = Math.max(y, 4) + 'px';
  };

  // Human-friendly axis ticks (1/2/5 × 10^n) covering [lo, hi].
  function niceTicks(lo, hi, target) {
    var span = hi - lo;
    if (!(span > 0)) return [lo];
    var raw = span / Math.max(target, 2);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm > 5 ? 10 : norm > 2 ? 5 : norm > 1 ? 2 : 1) * mag;
    var out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
    return out;
  }

  var api = { TrendChart: TrendChart, niceTicks: niceTicks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.trackerChart = api;
})(typeof window !== 'undefined' ? window : globalThis);
