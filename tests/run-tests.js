/*
 * Node test suite: FIT parser (against values cross-checked with the official
 * Garmin FIT SDK), CSV parser, and the drift analysis.  Run: node tests/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFit } = require('../js/fit-parser.js');
const { parseCsv } = require('../js/csv-parser.js');
const { analyzeWindow, rangeStats, detectBaseline, evaluate, EVAL,
  assessSpeedTrust, deriveSpeedFromDistance } = require('../js/analysis.js');
const tracker = require('../js/tracker-analysis.js');
const trackerStore = require('../js/tracker-store.js');
const { niceTicks } = require('../js/tracker-chart.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function close(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }

// Fixtures are stored base64-encoded so the repo stays text-only.
function loadFit(name) {
  const b64 = fs.readFileSync(path.join(__dirname, 'fixtures', name + '.b64'), 'utf8');
  const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  return parseFit(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

// ---- FIT parser (expectations verified against garmin-fit-sdk) ------------
console.log('fit-parser');
{
  const r = loadFit('garmin-fenix-5-bike.fit');
  check('fenix5: record count', r.records.length === 19, `got ${r.records.length}`);
  check('fenix5: first record', r.records[0].t === 1497283762 && r.records[0].hr === 77);
  check('fenix5: last record', r.records[18].t === 1497283823 && r.records[18].hr === 114);
  check('fenix5: sport', r.sports[0] === 'Cycling');
}
{
  const r = loadFit('sample-activity-indoor-trainer.fit');
  check('trainer: record count', r.records.length === 2263, `got ${r.records.length}`);
  check('trainer: first/last', r.records[0].t === 1320238459 && r.records[0].hr === 81 &&
    r.records[2262].t === 1320240722 && r.records[2262].hr === 122);
  const avg = r.records.reduce((a, x) => a + x.hr, 0) / r.records.length;
  check('trainer: avg HR', close(avg, 147.747, 0.001), `got ${avg.toFixed(3)}`);
  const mono = r.records.every((x, i) => i === 0 || x.t >= r.records[i - 1].t);
  check('trainer: monotonic timestamps', mono);
}
check('garbage input throws', (() => {
  try { parseFit(new Uint8Array([1, 2, 3, 4]).buffer); return false; }
  catch (e) { return true; }
})());

// ---- CSV parser -----------------------------------------------------------
console.log('csv-parser');
{
  const r = parseCsv('timestamp,heartrate\n0,120\n1,121\n2,122\n');
  check('elapsed csv', r.records.length === 3 && r.records[2].t === 2 &&
    r.records[2].hr === 122 && r.absolute === false);
}
{
  const r = parseCsv('2026-07-19T06:00:00Z,130\n2026-07-19T06:00:01Z,131\n');
  check('iso csv', r.records.length === 2 && r.absolute === true &&
    r.records[1].t - r.records[0].t === 1);
}
{
  const r = parseCsv('time,hr\n1752904800,140\n1752904801,141\n');
  check('epoch-seconds csv', r.records.length === 2 && r.absolute === true &&
    r.records[0].t === 1752904800);
}
{
  const r = parseCsv('0:00,110\n0:01:40,115\n');
  check('hh:mm:ss csv', r.records.length === 2 && r.records[1].t === 100);
}
check('empty csv throws', (() => {
  try { parseCsv('nothing here'); return false; } catch (e) { return true; }
})());

// ---- analysis -------------------------------------------------------------
console.log('analysis');
const SET = { windowLen: 3600, thresholdPct: 5, splitLen: 600, smoothSec: 30, endSec: 300 };

// Flat 140 bpm for 60 min → pass, zero drift, zero time over.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 140 });
  const r = analyzeWindow(samples, 0, SET);
  check('flat: baseline 140', close(r.baseline, 140, 0.01));
  check('flat: threshold 147', close(r.threshold, 147, 0.01));
  check('flat: verdict pass', r.verdict === 'pass');
  check('flat: end rise 0%', close(r.endRisePct, 0, 0.01));
  check('flat: 0% over', close(r.window.pctOver, 0, 0.01));
  check('flat: headroom ~4.76%', close(r.headroomPct, 100 * 7 / 147, 0.01));
  check('flat: 6 splits', r.splits.length === 6);
  check('flat: no partial splits', r.splits.every(s => !s.partial));
}

// Linear ramp 140 → 154 (+10%) over the hour → fail.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 140 + (14 * t / 3600) });
  const r = analyzeWindow(samples, 0, SET);
  check('ramp: verdict fail', r.verdict === 'fail');
  check('ramp: end rise ≈ 9.6%', close(r.endRisePct, 100 * ((154 - 7 * 300 / 3600 / 2) - 140.03) / 140.03, 0.3),
    `got ${r.endRisePct.toFixed(2)}`);
  check('ramp: drift positive', r.driftPct > 4.5 && r.driftPct < 5.5);
  check('ramp: split 6 rise > split 1 rise', r.splits[5].risePct > r.splits[0].risePct);
}

// Rise of exactly 4% → pass (within 5% limit).
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: t < 60 ? 150 : 156 });
  const r = analyzeWindow(samples, 0, SET);
  check('4% step: verdict pass', r.verdict === 'pass', r.verdict);
}

// Window offset: analysis at windowStart=600 uses HR at t=600 as baseline.
{
  const samples = [];
  for (let t = 0; t <= 5400; t++) samples.push({ t, hr: t < 600 ? 110 : 145 });
  const r = analyzeWindow(samples, 600, SET);
  check('offset: baseline from window start', close(r.baseline, 145, 0.01), `got ${r.baseline}`);
  check('offset: splits span window', close(r.splits[0].start, 600) && close(r.splits[5].end, 4200));
}

// Short activity → insufficient.
{
  const samples = [];
  for (let t = 0; t <= 1200; t++) samples.push({ t, hr: 140 });
  const r = analyzeWindow(samples, 0, SET);
  check('short: verdict insufficient', r.verdict === 'insufficient');
}

// Recording gap: a 10-minute dropout must not dominate the averages.
{
  const samples = [];
  for (let t = 0; t <= 1000; t++) samples.push({ t, hr: 140 });
  samples.push({ t: 1600, hr: 200 }); // spike right after a 600 s gap
  for (let t = 1601; t <= 3600; t++) samples.push({ t, hr: 140 });
  const r = analyzeWindow(samples, 0, SET);
  check('gap: avg barely moved', r.window.avg < 141, `got ${r.window.avg.toFixed(2)}`);
}

// Manual baseline override: threshold and verdict follow the override.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 150 });
  const auto = analyzeWindow(samples, 0, SET);
  check('override: auto verdict pass', auto.verdict === 'pass');
  // Designate a lower target HR: flat 150 is +7.1% over a 140 baseline → fail.
  const r = analyzeWindow(samples, 0, Object.assign({}, SET, { baselineOverride: 140 }));
  check('override: baseline honored', close(r.baseline, 140));
  check('override: threshold from override', close(r.threshold, 147, 0.01));
  check('override: verdict fail', r.verdict === 'fail', r.verdict);
  check('override: 100% over threshold', close(r.window.pctOver, 100, 0.01));
  // Override above the data: everything under threshold again.
  const r2 = analyzeWindow(samples, 0, Object.assign({}, SET, { baselineOverride: 160 }));
  check('override high: verdict pass', r2.verdict === 'pass');
  check('override high: 0% over', close(r2.window.pctOver, 0, 0.01));
}

// rangeStats half-open interval: sample at endT excluded.
{
  const samples = [{ t: 0, hr: 100 }, { t: 10, hr: 200 }];
  const r = rangeStats(samples, 0, 10);
  check('rangeStats: half-open', close(r.avg, 100), `got ${r.avg}`);
}

// ---- detectBaseline -------------------------------------------------------
console.log('detectBaseline');

// Deterministic pseudo-noise so tests are reproducible.
function noise(t, amp) { return amp * Math.sin(t * 7.13) * Math.cos(t * 1.91); }

// Clean steady run: 10-min ramp 105→140, then flat 140 → high confidence,
// plateau found soon after the ramp ends.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) {
    const base = t < 600 ? 105 + 35 * t / 600 : 140;
    samples.push({ t, hr: Math.round(base + noise(t, 1)) });
  }
  const d = detectBaseline(samples);
  check('steady: confidence high', d.confidence === 'high', d.confidence);
  check('steady: baseline ≈ 140', Math.abs(d.baseline - 140) <= 1.5, `got ${d.baseline}`);
  // Earliest qualifying window may absorb a bit of ramp tail (median-robust);
  // what matters is it skips the bulk of the ramp and doesn't dawdle.
  check('steady: plateau starts after ramp, promptly',
    d.windowStart >= 450 && d.windowStart <= 900, `got ${d.windowStart}`);
}

// Interval run: 3-min surges/floats — no 5-min window is settled → none.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) {
    const base = t < 300 ? 100 + 50 * t / 300 : (Math.floor((t - 300) / 180) % 2 ? 120 : 165);
    samples.push({ t, hr: Math.round(base + noise(t, 1)) });
  }
  const d = detectBaseline(samples);
  check('intervals: confidence none', d.confidence === 'none', d.confidence);
}

// Plateau then step up (treadmill speed change): must catch the FIRST plateau.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) {
    let base;
    if (t < 300) base = 100 + 40 * t / 300;
    else if (t < 1200) base = 140;
    else base = 155;
    samples.push({ t, hr: Math.round(base + noise(t, 1)) });
  }
  const d = detectBaseline(samples);
  check('step-up: found a plateau', d.confidence !== 'none', d.confidence);
  check('step-up: FIRST plateau (≈140, not 155)', Math.abs(d.baseline - 140) <= 1.5, `got ${d.baseline}`);
  check('step-up: window inside first plateau', d.windowEnd <= 1200, `got ${d.windowEnd}`);
}

// HR dropout gap inside the plateau: tolerated (interpolated), no crash.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) {
    if (t > 700 && t < 760) continue; // 60 s dropout
    const base = t < 300 ? 110 + 35 * t / 300 : 145;
    samples.push({ t, hr: Math.round(base + noise(t, 1)) });
  }
  const d = detectBaseline(samples);
  check('dropout: still detects', d.confidence !== 'none', d.confidence);
  check('dropout: baseline ≈ 145', Math.abs(d.baseline - 145) <= 1.5, `got ${d.baseline}`);
}

// Runs shorter than the scannable minimum → none, never throws.
{
  const samples = [];
  for (let t = 0; t <= 480; t++) samples.push({ t, hr: 150 });
  check('8-min run: none', detectBaseline(samples).confidence === 'none');
}
// …but a 15-minute run with a real plateau still works.
{
  const samples = [];
  for (let t = 0; t <= 900; t++) {
    const base = t < 240 ? 110 + 38 * t / 240 : 148;
    samples.push({ t, hr: Math.round(base + noise(t, 1)) });
  }
  const d = detectBaseline(samples);
  check('15-min run: detects', d.confidence !== 'none', d.confidence);
  check('15-min run: baseline ≈ 148', Math.abs(d.baseline - 148) <= 1.5, `got ${d.baseline}`);
}

// Sparse recording (4 s sample interval, "smart recording") → resampled, works.
{
  const samples = [];
  for (let t = 0; t <= 3600; t += 4) {
    const base = t < 600 ? 105 + 35 * t / 600 : 142;
    samples.push({ t, hr: Math.round(base + noise(t, 1)) });
  }
  const d = detectBaseline(samples);
  check('4s-interval: detects', d.confidence !== 'none', d.confidence);
  check('4s-interval: baseline ≈ 142', Math.abs(d.baseline - 142) <= 1.5, `got ${d.baseline}`);
}

// Degenerate inputs never throw.
check('empty input: none', detectBaseline([]).confidence === 'none');
check('single sample: none', detectBaseline([{ t: 0, hr: 140 }]).confidence === 'none');
check('null input: none', detectBaseline(null).confidence === 'none');

// ---- evaluate (banded, findings-based verdict) ----------------------------
console.log('evaluate');

function run(samples) {
  const r = analyzeWindow(samples, 0, SET);
  return { r, ev: evaluate(samples, r, {}) };
}
function has(ev, code) { return ev.findings.some(f => f.code === code); }

// Clean flat hour with steady speed -> green via Pa:HR, no warnings.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 140, speed: 3.0 });
  const { ev } = run(samples);
  check('flat+speed: band green', ev.band === 'green', ev.band);
  check('flat+speed: Pa:HR used', ev.primary.method === 'pa:hr', ev.primary.method);
  check('flat+speed: ~0% decoupling', Math.abs(ev.primary.value) < 0.5, ev.primary.value);
  check('flat+speed: no warnings', !ev.findings.some(f => f.severity === 'warning'));
  check('flat+speed: high confidence', ev.confidence === 'high', ev.confidence);
}

// Accelerating rise, borderline and still climbing -> amber + not-plateaued.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 140 + 14 * Math.pow(t / 3600, 2) });
  const { ev } = run(samples);
  check('climbing: band amber', ev.band === 'amber', `${ev.band} @ ${ev.primary.value.toFixed(2)}%`);
  check('climbing: hr-only (no speed)', ev.primary.method === 'hr-only');
  check('climbing: not-plateaued finding', has(ev, 'not-plateaued'));
}

// Hot start, strong monotonic rise -> red.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 150 + 25 * t / 3600, speed: 3.0 });
  const { ev } = run(samples);
  check('hot-start: band red', ev.band === 'red', `${ev.band} @ ${ev.primary.value.toFixed(2)}%`);
  check('hot-start: Pa:HR used', ev.primary.method === 'pa:hr');
}

// Flat HR but second half 5% slower -> pace-slowed warning + the cross-check
// fires (Pa:HR ~5% vs HR-only 0% disagree by >2.5 pts), so the verdict falls
// back to HR-only with the Pa:HR number demoted to a secondary stat.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 140, speed: t < 1800 ? 3.0 : 2.85 });
  const { ev } = run(samples);
  check('slowdown: pace warning emitted', has(ev, 'pace-slowed'));
  check('slowdown: disagreement warning too', has(ev, 'speed-hr-disagree'));
  check('slowdown: confidence low', ev.confidence === 'low', ev.confidence);
  check('slowdown: falls back to hr-only', ev.primary.method === 'hr-only' &&
    ev.primary.reason === 'disagreement', ev.primary.method + '/' + ev.primary.reason);
  check('slowdown: Pa:HR demoted to secondary ~5%', ev.secondary &&
    ev.secondary.value > 4 && ev.secondary.value < 6, ev.secondary && ev.secondary.value.toFixed(2));
}

// Plateau-then-break at a known minute -> breakpoint within +/-2 min.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) {
    const hr = t < 3000 ? 135 : 135 + (t - 3000) / 60 * 0.9; // break at 50:00
    samples.push({ t, hr });
  }
  const { ev } = run(samples);
  const bp = ev.findings.find(f => f.code === 'break-point');
  check('break: finding present', !!bp);
  check('break: within +/-2 min of 50:00', bp && Math.abs(bp.breakSec - 3000) <= 120,
    bp && String(bp.breakSec));
  check('break: plateau HR reported', bp && Math.abs(bp.plateauHr - 135) <= 1.5,
    bp && String(bp.plateauHr));
}

// No speed channel -> HR-only drift, labeled as such.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 140 + 6 * t / 3600 });
  const { r, ev } = run(samples);
  check('no-speed: hr-only method', ev.primary.method === 'hr-only');
  check('no-speed: equals driftPct', close(ev.primary.value, r.driftPct, 1e-9));
}

// Band-edge value (~3.4%) -> green with a boundary finding.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 140 + 9.68 * t / 3600 });
  const { ev } = run(samples);
  check('edge: band green', ev.band === 'green', `${ev.band} @ ${ev.primary.value.toFixed(2)}%`);
  check('edge: within tolerance of 3.5', Math.abs(ev.primary.value - EVAL.AEROBIC_MAX_PCT) <= EVAL.EDGE_TOL_PCT,
    ev.primary.value.toFixed(2));
  check('edge: boundary finding', has(ev, 'band-edge'));
}

// Short analyzed window (30 min) -> caveat, still banded.
{
  const samples = [];
  for (let t = 0; t <= 1800; t++) samples.push({ t, hr: 140 });
  const r = analyzeWindow(samples, 0, Object.assign({}, SET, { windowLen: 1800 }));
  const ev = evaluate(samples, r, {});
  check('short-window: caveat', ev.findings.some(f => f.code === 'short-window'));
  check('short-window: confidence medium', ev.confidence === 'medium', ev.confidence);
}

// Baseline mismatch -> warning finding, confidence capped low.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 140 });
  const r = analyzeWindow(samples, 0, Object.assign({}, SET, { baselineOverride: 135 }));
  const ev = evaluate(samples, r, { baselineOverride: 135, detectedBaseline: 140 });
  check('mismatch: finding present', has(ev, 'baseline-mismatch'));
  check('mismatch: confidence low', ev.confidence === 'low', ev.confidence);
}

// Insufficient stays insufficient; evaluate never throws on junk.
{
  const samples = [];
  for (let t = 0; t <= 1200; t++) samples.push({ t, hr: 140 });
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, {});
  check('insufficient: passed through', ev.verdict === 'insufficient' && ev.band === null);
  check('evaluate(garbage) no throw', evaluate(null, null, null).verdict === 'insufficient');
}

// ---- speed trust & cross-check --------------------------------------------
console.log('speed trust');

// Treadmill (no GPS): drifting accelerometer speed must not drive the verdict.
// HR flat (green by HR-only); accelerometer "speed" decays 6% -> Pa:HR ~6%.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) {
    samples.push({ t, hr: 140, speed: 3.0 * (1 - 0.06 * t / 3600) });
  }
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, { speedTrusted: false });
  check('treadmill: hr-only primary', ev.primary.method === 'hr-only');
  check('treadmill: untrusted reason', ['untrusted-speed', 'disagreement'].includes(ev.primary.reason),
    ev.primary.reason);
  check('treadmill: band green (HR flat)', ev.band === 'green', ev.band);
  check('treadmill: untrusted-speed finding', ev.findings.some(f => f.code === 'speed-untrusted'));
  check('treadmill: secondary marked untrusted', ev.secondary && ev.secondary.untrusted === true);
}

// Outdoor with consistent GPS speed -> Pa:HR stays primary (trusted default).
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 140 + 4 * t / 3600, speed: 3.0 });
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, { speedTrusted: true });
  check('outdoor: pa:hr primary', ev.primary.method === 'pa:hr', ev.primary.method);
  check('outdoor: no disagreement warning', !ev.findings.some(f => f.code === 'speed-hr-disagree'));
  check('outdoor: no secondary', !ev.secondary);
}

// Disagreement fixture: Pa:HR ~-0.1% vs HR-only ~+4.6% -> warning + fallback.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) {
    const hr = 138 + 13 * t / 3600;
    const speed = t < 1800 ? 3.0 : 3.14; // second half faster, masking HR drift
    samples.push({ t, hr, speed });
  }
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, { speedTrusted: true });
  check('disagree: warning emitted', ev.findings.some(f => f.code === 'speed-hr-disagree'));
  check('disagree: hr-only primary', ev.primary.method === 'hr-only' &&
    ev.primary.reason === 'disagreement', ev.primary.method + '/' + ev.primary.reason);
  check('disagree: primary ~4.6%', ev.primary.value > 4 && ev.primary.value < 5.2,
    ev.primary.value.toFixed(2));
  check('disagree: Pa:HR near zero in secondary', ev.secondary &&
    Math.abs(ev.secondary.value) < 1, ev.secondary && ev.secondary.value.toFixed(2));
  check('disagree: band amber (from HR-only)', ev.band === 'amber', ev.band);
  check('disagree: confidence low', ev.confidence === 'low');
  check('disagree: finding mentions implied pace change',
    ev.findings.find(f => f.code === 'speed-hr-disagree').text.includes('faster'));
}

// Parser flags on real fixtures (cross-checked against garmin-fit-sdk data).
{
  const outdoor = loadFit('garmin-fenix-5-bike.fit');
  check('flags: outdoor ride hasGps', outdoor.hasGps === true);
  const indoor = loadFit('sample-activity-indoor-trainer.fit');
  check('flags: indoor trainer no GPS', indoor.hasGps === false);
  check('flags: subSports exposed', Array.isArray(indoor.subSports));
}

// ---- provenance & speed trust matrix --------------------------------------
console.log('provenance');

// Hand-crafted Peloton-style FIT: file_id(manufacturer=peloton, product_name),
// session(running/treadmill), distance-only records (like the real Tread files).
function buildPelotonFit() {
  const parts = [];
  const pName = 'HOME_TREAD';
  // file_id def: type(0,1,enum) manufacturer(1,2,u16) product(2,2,u16) product_name(8,11,string)
  parts.push([0x40, 0, 0, 0x00, 0x00, 4,
    0, 1, 0x00,  1, 2, 0x84,  2, 2, 0x84,  8, pName.length + 1, 0x07]);
  parts.push([0x00, 4, 340 & 0xFF, 340 >> 8, 10, 0,
    ...Array.from(pName).map(c => c.charCodeAt(0)), 0]);
  // session def: sport(5) subSport(6)
  parts.push([0x41, 0, 0, 0x12, 0x00, 2, 5, 1, 0x00, 6, 1, 0x00]);
  parts.push([0x01, 1, 1]); // running, treadmill
  // record def: timestamp(253,4,u32) hr(3,1,u8) distance(5,4,u32 scale 100)
  parts.push([0x42, 0, 0, 0x14, 0x00, 3, 253, 4, 0x86, 3, 1, 0x02, 5, 4, 0x86]);
  const t0 = 1000000000;
  for (let i = 0; i < 10; i++) {
    const ts = t0 + i, dist = i * 280; // 2.8 m/s in cm
    parts.push([0x02,
      ts & 0xFF, (ts >> 8) & 0xFF, (ts >> 16) & 0xFF, (ts >> 24) & 0xFF,
      120 + i,
      dist & 0xFF, (dist >> 8) & 0xFF, (dist >> 16) & 0xFF, (dist >> 24) & 0xFF]);
  }
  const body = parts.flat();
  const buf = Buffer.alloc(12 + body.length + 2);
  buf[0] = 12; buf[1] = 0x10;
  buf.writeUInt16LE(2132, 2);
  buf.writeUInt32LE(body.length, 4);
  buf.write('.FIT', 8);
  Buffer.from(body).copy(buf, 12);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

{
  const r = parseFit(buildPelotonFit());
  const prov = r.provenance;
  check('peloton fixture: manufacturer', prov.manufacturer === 'Peloton' && prov.manufacturerId === 340,
    JSON.stringify(prov));
  check('peloton fixture: product name string', prov.product === 'HOME_TREAD', prov.product);
  check('peloton fixture: treadmill sub-sport', prov.subSport === 'Treadmill');
  check('peloton fixture: no gps', prov.hasGps === false);
  check('peloton fixture: distance parsed', r.records.every(x => x.distance !== undefined));
  const trust = assessSpeedTrust(prov);
  check('peloton fixture: speed TRUSTED (belt)', trust.trusted === true && trust.source === 'equipment');
  check('peloton fixture: belt label', trust.label === 'belt/machine speed (Peloton)', trust.label);
}

// Real-file provenance (values verified against garmin-fit-sdk).
{
  const outdoor = loadFit('garmin-fenix-5-bike.fit');
  check('fenix5: provenance Garmin Fenix 5', outdoor.provenance.manufacturer === 'Garmin' &&
    outdoor.provenance.product === 'Fenix 5', JSON.stringify(outdoor.provenance));
  const t1 = assessSpeedTrust(outdoor.provenance);
  check('fenix5: GPS trusted', t1.trusted === true && t1.source === 'gps');

  const indoor = loadFit('sample-activity-indoor-trainer.fit');
  check('edge800: provenance Garmin Edge 800', indoor.provenance.product === 'Edge 800',
    JSON.stringify(indoor.provenance));
  const t2 = assessSpeedTrust(indoor.provenance);
  check('edge800: indoor watch-estimate untrusted', t2.trusted === false && t2.source === 'watch-estimate');
}

// Trust matrix corner cases.
{
  const unknown = assessSpeedTrust({ manufacturerId: 9999, manufacturer: null, hasGps: false });
  check('unknown maker: untrusted', unknown.trusted === false && unknown.source === 'unknown');
  check('unknown maker: says why', unknown.reason.includes('9999'), unknown.reason);
  const noProv = assessSpeedTrust(null);
  check('no provenance: untrusted with reason', noProv.trusted === false && noProv.reason.length > 0);
  const watchGps = assessSpeedTrust({ manufacturerId: 1, manufacturer: 'Garmin', hasGps: true });
  check('garmin outdoor: GPS trusted', watchGps.trusted === true && watchGps.source === 'gps');
}

// deriveSpeedFromDistance: Peloton-style distance-only samples.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 130, distance: t * 2.8 });
  const filled = deriveSpeedFromDistance(samples);
  check('derive: fills nearly all samples', filled > 3500, String(filled));
  check('derive: ~2.8 m/s', Math.abs(samples[1800].speed - 2.8) < 0.01, String(samples[1800].speed));
  // trusted belt speed + flat everything -> Pa:HR primary, green
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, { speedTrust: { trusted: true, source: 'equipment',
    label: 'belt/machine speed (Peloton)', reason: 'belt' } });
  check('derive+trust: pa:hr primary', ev.primary.method === 'pa:hr', ev.primary.method);
  check('derive+trust: band green', ev.band === 'green');
  // does NOT derive when speed already present
  const withSpeed = [];
  for (let t = 0; t <= 100; t++) withSpeed.push({ t, hr: 130, speed: 2.0, distance: t * 2.8 });
  check('derive: skips when speed exists', deriveSpeedFromDistance(withSpeed) === 0 &&
    withSpeed[50].speed === 2.0);
}

// evaluate with a trust OBJECT (untrusted): finding text names the source.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 140, speed: 3.0 * (1 - 0.06 * t / 3600) });
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, { speedTrust: { trusted: false, source: 'watch-estimate',
    label: 'watch estimate (accelerometer)', reason: 'indoor recording by Garmin' } });
  check('trust-object: hr-only primary', ev.primary.method === 'hr-only');
  const f = ev.findings.find(x => x.code === 'speed-untrusted');
  check('trust-object: finding names source', f && f.text.includes('watch estimate (accelerometer)'),
    f && f.text.slice(0, 80));
}

// ---- window-bounds regression (warm-up/cooldown must not leak) ------------
console.log('window bounds');

// 10-min slow warm-up ramp + 60-min window with CONSTANT speed and HR halves
// drifting ~+4.5% + 10-min cooldown walk. Pa:HR must agree with HR-only and
// the surrounding ramp/walk must have zero effect on either number.
function boundsFixture(speedStep) {
  const samples = [];
  for (let t = 0; t <= 4800; t++) {
    let hr, speed;
    if (t < 600) { hr = 100 + 38 * t / 600; speed = 1.2 + 1.6 * t / 600; }
    else if (t < 4200) {
      const w = (t - 600) / 3600;
      hr = 138 * (1 + 0.09 * w);                    // halves drift ≈ +4.4%
      speed = (speedStep && t >= 2400) ? 2.8 * 1.03 : 2.8;
    } else { hr = 120 - 20 * (t - 4200) / 600; speed = 1.1; }
    samples.push({ t, hr, speed });
  }
  return samples;
}
const TRUST = { speedTrust: { trusted: true, source: 'equipment', label: 'belt', reason: 'belt' } };

{
  const samples = boundsFixture(false);
  const r = analyzeWindow(samples, 600, SET);
  const ev = evaluate(samples, r, TRUST);
  check('bounds: hr drift ~4.4%', r.driftPct > 4.0 && r.driftPct < 4.9, r.driftPct.toFixed(2));
  check('bounds: Pa:HR agrees with HR-only', Math.abs(ev.primary.value - r.driftPct) < 1,
    `paHr-equivalent ${ev.primary.value.toFixed(2)} vs drift ${r.driftPct.toFixed(2)}`);
  check('bounds: pa:hr stays primary', ev.primary.method === 'pa:hr', ev.primary.method);
  check('bounds: NO disagreement warning', !ev.findings.some(f => f.code === 'speed-hr-disagree'));
  check('bounds: no pace-slowed warning', !ev.findings.some(f => f.code === 'pace-slowed'));

  // The strong form: strip the warm-up and cooldown entirely — every number
  // must be identical, proving they never entered the computation.
  const trimmed = samples.filter(x => x.t >= 600 && x.t < 4200);
  const rt = analyzeWindow(trimmed, 600, SET);
  const evt = evaluate(trimmed, rt, TRUST);
  check('bounds: warm-up/cooldown inert (Pa:HR)',
    Math.abs(ev.primary.value - evt.primary.value) < 0.01,
    `${ev.primary.value.toFixed(3)} vs ${evt.primary.value.toFixed(3)}`);
  check('bounds: warm-up/cooldown inert (HR drift)',
    Math.abs(r.driftPct - rt.driftPct) < 0.01);
}

// Same fixture with a genuine +3% speed step at the window midpoint:
// disagreement fires with the correct implied paces in the text.
{
  const samples = boundsFixture(true);
  const r = analyzeWindow(samples, 600, SET);
  const ev = evaluate(samples, r, Object.assign({ units: 'metric', displayMode: 'pace' }, TRUST));
  const w = ev.findings.find(f => f.code === 'speed-hr-disagree');
  check('step: disagreement warning fires', !!w);
  check('step: falls back to hr-only', ev.primary.method === 'hr-only' &&
    ev.primary.reason === 'disagreement');
  // 1st half avg 2.8 m/s -> 1000/2.8 = 357 s = 5:57 /km; the +3% step covers
  // the whole 2nd half -> 2.884 m/s -> 346.7 s -> 5:47 /km.
  check('step: implied paces in text', w && w.text.includes('5:57') && w.text.includes('5:47'),
    w && w.text);
  check('step: pace unit in text', w && w.text.includes('/km'));
  // imperial + speed mode variants format accordingly
  const evMi = evaluate(samples, r, Object.assign({ units: 'imperial', displayMode: 'speed' }, TRUST));
  const wMi = evMi.findings.find(f => f.code === 'speed-hr-disagree');
  check('step: mph variant', wMi && wMi.text.includes('mph'), wMi && wMi.text);
}

// ---- suspected-AeT gating --------------------------------------------------
console.log('suspected AeT');

function flatHour(hr) {
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr });
  return samples;
}

// Baseline well BELOW suspected AeT: banded verdict kept, untested finding,
// relation 'below' (app suppresses the raising-evidence line off this).
{
  const samples = flatHour(126);
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, { suspectedAeT: 138 });
  check('aet below: band still green', ev.band === 'green');
  check('aet below: relation', ev.aetRelation === 'below');
  const f = ev.findings.find(x => x.code === 'aet-untested');
  check('aet below: untested finding', !!f);
  check('aet below: says 12 bpm below and names 138',
    f && f.text.includes('12 bpm below') && f.text.includes('138') &&
    f.text.includes('does not test the threshold'), f && f.text);
}

// Baseline AT the suspected AeT: true-threshold-test finding.
{
  const samples = flatHour(137);
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, { suspectedAeT: 138 });
  check('aet near: relation', ev.aetRelation === 'near');
  check('aet near: true-test finding', ev.findings.some(x => x.code === 'aet-true-test'));
}

// Baseline ABOVE suspected AeT with a green result: conservative-ceiling flag.
{
  const samples = flatHour(145);
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, { suspectedAeT: 138 });
  check('aet above green: relation', ev.aetRelation === 'above');
  check('aet above green: conservative finding',
    ev.findings.some(x => x.code === 'aet-conservative'));
}

// Baseline above but the result is red: no conservative claim.
{
  const samples = [];
  for (let t = 0; t <= 3600; t++) samples.push({ t, hr: 145 + 14 * t / 3600 });
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, { suspectedAeT: 138 });
  check('aet above red: no conservative finding',
    !ev.findings.some(x => x.code === 'aet-conservative'));
  check('aet above red: relation still above', ev.aetRelation === 'above');
}

// Gray zone (4 bpm below): no AeT finding either way.
{
  const samples = flatHour(134);
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, { suspectedAeT: 138 });
  check('aet gray zone: no relation', ev.aetRelation === null);
  check('aet gray zone: no findings', !ev.findings.some(x => /^aet-/.test(x.code)));
}

// Unset: no AeT findings, relation null (current behavior).
{
  const samples = flatHour(140);
  const r = analyzeWindow(samples, 0, SET);
  const ev = evaluate(samples, r, {});
  check('aet unset: relation null', ev.aetRelation === null);
  check('aet unset: no aet findings', !ev.findings.some(x => /^aet-/.test(x.code)));
}

// ---- tracker: walk/run segmentation ---------------------------------------
console.log('tracker segmentation');

const RUN_MS = 2.5;    // ≈5.6 mph — above the 4 mph default threshold
const WALK_MS = 1.3;   // ≈2.9 mph — below it

// Build 1 Hz samples from [durationSeconds, speed] phases.
function phases(list, opts) {
  const samples = [];
  let t = 0;
  list.forEach(([dur, speed]) => {
    for (let i = 0; i < dur; i++) samples.push({ t: t++, speed, hr: (opts && opts.hr) || 138 });
  });
  samples.push({ t: t, speed: list[list.length - 1][1], hr: (opts && opts.hr) || 138 });
  return samples;
}

// Warm-up walk · run · walk · run · walk · run · cool-down walk.
const CLASSIC = [[300, WALK_MS], [600, RUN_MS], [120, WALK_MS], [600, RUN_MS],
  [120, WALK_MS], [600, RUN_MS], [300, WALK_MS]];

{
  const r = tracker.analyze(phases(CLASSIC));
  const types = r.segments.map(s => s.type);
  check('classic: 7 alternating periods', r.segments.length === 7 &&
    types.join('') === [tracker.WALK, tracker.RUN, tracker.WALK, tracker.RUN,
      tracker.WALK, tracker.RUN, tracker.WALK].join(''), types.join(','));
  check('classic: boundaries exact', r.segments[1].start === 300 && r.segments[1].end === 900,
    `${r.segments[1].start}–${r.segments[1].end}`);
  check('classic: window skips the opening walk', r.window.start === 300, String(r.window.start));
  check('classic: window drops the closing walk', r.window.end === 2340, String(r.window.end));
  check('classic: trimmed amounts reported',
    r.window.trimmedLead === 300 && r.window.trimmedTail === 300,
    `${r.window.trimmedLead}/${r.window.trimmedTail}`);
  const m = r.overall;
  check('classic: 2 walk breaks inside the window', m.walks === 2, String(m.walks));
  check('classic: 3 run periods', m.runs === 3, String(m.runs));
  check('classic: avg run period 10:00', close(m.avgRunSec, 600, 1), String(m.avgRunSec));
  check('classic: avg walk period 2:00', close(m.avgWalkSec, 120, 1), String(m.avgWalkSec));
  check('classic: longest run 10:00', close(m.longestRunSec, 600, 1));
  check('classic: run time 1800 s', close(m.runSeconds, 1800, 1), String(m.runSeconds));
  check('classic: avg speed ≈ 2.36 m/s',
    Math.abs(m.avgSpeed - (1800 * RUN_MS + 240 * WALK_MS) / 2040) < 0.02, String(m.avgSpeed));
  check('classic: run-only pace ≈ run speed', Math.abs(m.runAvgSpeed - RUN_MS) < 0.02,
    String(m.runAvgSpeed));
  check('classic: run share of time ≈ 88%', Math.abs(m.runTimePct - 100 * 1800 / 2040) < 0.5,
    String(m.runTimePct));
  check('classic: walks per mile', Math.abs(m.walksPerMile - 2 / (m.distance / tracker.MI_M)) < 1e-9);
}

// A ten-second dip below the threshold is noise, not a walk break.
{
  const samples = phases(CLASSIC);
  for (let t = 1200; t < 1210; t++) samples[t].speed = WALK_MS;
  const r = tracker.analyze(samples);
  check('dip: still 2 walk breaks', r.overall.walks === 2, String(r.overall.walks));
  check('dip: run periods intact', r.overall.runs === 3, String(r.overall.runs));
}
// …but a 60-second walk is a real break.
{
  const samples = phases(CLASSIC);
  for (let t = 1200; t < 1260; t++) samples[t].speed = WALK_MS;
  const r = tracker.analyze(samples);
  check('60s break: counted', r.overall.walks === 3, String(r.overall.walks));
}

// Trimming switched off: the opening and closing walks are measured too.
{
  const r = tracker.analyze(phases(CLASSIC),
    { trimLeadingWalk: false, trimTrailingWalk: false });
  check('no-trim: window is the whole activity', r.window.start === 0);
  check('no-trim: 4 walk periods', r.overall.walks === 4, String(r.overall.walks));
}

// Threshold above every recorded speed: nothing qualifies as running.
{
  const r = tracker.analyze(phases(CLASSIC), { thresholdMs: 3.0 });
  check('high threshold: no run periods', r.window.noRun === true && r.overall.runs === 0);
  check('high threshold: whole activity measured', r.window.start === 0 &&
    r.overall.avgRunSec === null);
}

// A slower threshold (3 mph) makes the "walks" running.
{
  const r = tracker.analyze(phases(CLASSIC), { thresholdMs: 3 * tracker.MPH_TO_MS * 0.9 });
  check('low threshold: everything is a run', r.overall.walks === 0, String(r.overall.walks));
}

// ---- tracker: fixed windows and per-mile segments --------------------------
console.log('tracker windows');

{
  // 100 minutes of running between an opening and closing walk.
  const r = tracker.analyze(phases([[300, WALK_MS], [6000, RUN_MS], [300, WALK_MS]]));
  check('buckets: 30/45/60/75/90', r.buckets.map(b => b.minutes).join(',') === '30,45,60,75,90',
    r.buckets.map(b => b.minutes).join(','));
  const b30 = r.buckets[0].metrics, b60 = r.buckets[2].metrics;
  check('buckets: 30-min window is 1800 s', b30.seconds === 1800, String(b30.seconds));
  check('buckets: distance scales with the window',
    Math.abs(b60.distance / b30.distance - 2) < 0.01, String(b60.distance / b30.distance));
  check('buckets: pace identical across windows',
    Math.abs(b30.avgSpeed - b60.avgSpeed) < 0.01);
}
{
  const short = tracker.analyze(phases([[1500, RUN_MS]]));
  check('buckets: none below 30 min', short.buckets.length === 0, String(short.buckets.length));
  const edge = tracker.analyze(phases([[1775, RUN_MS]]));
  check('buckets: 29:35 still counts as the 30-min window', edge.buckets.length === 1,
    String(edge.buckets.length));
  const under = tracker.analyze(phases([[1740, RUN_MS]]));
  check('buckets: 29:00 does not', under.buckets.length === 0, String(under.buckets.length));
}
{
  // Constant 2.5 m/s: a mile takes 1609.344 / 2.5 ≈ 644 s.
  const r = tracker.analyze(phases([[3000, RUN_MS]]));
  check('miles: 5 segments (last partial)', r.distanceSegments.length === 5,
    String(r.distanceSegments.length));
  check('miles: first mile ≈ 644 s', Math.abs(r.distanceSegments[0].metrics.seconds - 644) <= 2,
    String(r.distanceSegments[0].metrics.seconds));
  check('miles: last segment flagged partial',
    r.distanceSegments[4].partial === true && r.distanceSegments[0].partial === false);
  check('miles: pace matches the run speed',
    Math.abs(r.distanceSegments[1].metrics.avgSpeed - RUN_MS) < 0.02);
  const km = tracker.analyze(phases([[3000, RUN_MS]]), { segmentDistance: tracker.KM_M });
  check('km: 8 kilometre segments', km.distanceSegments.length === 8,
    String(km.distanceSegments.length));
}
{
  // Walk breaks land in the mile they start in.
  const r = tracker.analyze(phases([[700, RUN_MS], [120, WALK_MS], [1200, RUN_MS]]));
  const walksBySeg = r.distanceSegments.map(s => s.metrics.walks);
  check('miles: one walk, in the segment it starts in',
    walksBySeg.reduce((a, b) => a + b, 0) === 1, walksBySeg.join(','));
}

// ---- tracker: channels, gaps and degenerate input --------------------------
console.log('tracker input handling');

{
  // Distance-only file (Peloton-style): speed is derived from the deltas.
  const samples = [];
  for (let t = 0; t <= 2000; t++) {
    const speed = t < 300 ? WALK_MS : RUN_MS;
    samples.push({ t, distance: t === 0 ? 0 : null, hr: 140 });
  }
  let d = 0;
  samples.forEach((s, t) => { d += t === 0 ? 0 : (t <= 300 ? WALK_MS : RUN_MS); s.distance = d; });
  const r = tracker.analyze(samples);
  check('distance-only: run detected', r.overall.runs === 1, String(r.overall.runs));
  check('distance-only: pace ≈ 2.5 m/s', Math.abs(r.overall.runAvgSpeed - RUN_MS) < 0.05,
    String(r.overall.runAvgSpeed));
}
{
  // A five-minute recording gap becomes a paused period, excluded from time.
  const samples = phases([[600, RUN_MS], [600, RUN_MS]]).filter(s => s.t < 600 || s.t >= 900);
  const r = tracker.analyze(samples, { trimLeadingWalk: false, trimTrailingWalk: false });
  check('gap: paused period present', r.segments.some(s => s.type === tracker.PAUSE));
  check('gap: excluded from moving time',
    Math.abs(r.overall.movingSeconds - (r.overall.seconds - r.overall.pausedSeconds)) <= 1,
    `${r.overall.movingSeconds} / ${r.overall.seconds} / ${r.overall.pausedSeconds}`);
  check('gap: run periods on both sides', r.overall.runs === 2, String(r.overall.runs));
}
check('tracker: empty input', tracker.analyze([]) === null);
check('tracker: null input', tracker.analyze(null) === null);
check('tracker: HR-only file rejected',
  tracker.analyze([{ t: 0, hr: 140 }, { t: 10, hr: 141 }, { t: 20, hr: 142 }]) === null);

// ---- tracker store: series round-trip, identity, import/export -------------
console.log('tracker store');

const sampleActivity = phases(CLASSIC);
{
  const series = trackerStore.compressSeries(sampleActivity);
  check('series: 5-second resolution', series.dt === 5 && series.n === 2641,
    `${series.dt}/${series.n}`);
  check('series: point count', series.sp.length === Math.ceil(2641 / 5),
    String(series.sp.length));
  const round = tracker.analyze(trackerStore.expandSeries(series));
  const direct = tracker.analyze(sampleActivity);
  check('series: walk count survives the round trip',
    round.overall.walks === direct.overall.walks, `${round.overall.walks}`);
  check('series: window survives the round trip',
    Math.abs(round.window.start - direct.window.start) <= 5 &&
    Math.abs(round.window.end - direct.window.end) <= 5,
    `${round.window.start}–${round.window.end}`);
  check('series: distance within 1%',
    Math.abs(round.overall.distance / direct.overall.distance - 1) < 0.01,
    `${round.overall.distance} vs ${direct.overall.distance}`);
  check('series: heart rate preserved', Math.abs(round.overall.avgHr - 138) < 0.5,
    String(round.overall.avgHr));
}

function storedActivity(startTime, name) {
  const rec = {
    name: name || 'Run',
    sport: 'Running',
    startTime: startTime,
    addedAt: 1,
    durationSec: 2640,
    distanceM: 5000,
    source: 'test',
    series: trackerStore.compressSeries(sampleActivity)
  };
  rec.id = trackerStore.idFor(rec);
  return rec;
}

{
  const a = storedActivity(1700000000, 'Tuesday run');
  const b = storedActivity(1700000000, 'Tuesday run (renamed)');
  const c = storedActivity(1700600000, 'Next week');
  check('identity: same start+duration is the same activity', a.id === b.id, `${a.id}/${b.id}`);
  check('identity: different start is a different activity', a.id !== c.id);

  const first = trackerStore.mergeActivities([], [a, c]);
  check('merge: both added', first.added === 2 && first.list.length === 2);
  check('merge: sorted by date', first.list[0].startTime < first.list[1].startTime);
  const again = trackerStore.mergeActivities(first.list, [b]);
  check('merge: re-import replaces rather than duplicates',
    again.added === 0 && again.replaced === 1 && again.list.length === 2);
  check('merge: replacement kept the newer name',
    again.list[0].name === 'Tuesday run (renamed)', again.list[0].name);
}

{
  const list = trackerStore.mergeActivities([], [storedActivity(1700000000)]).list;
  const json = trackerStore.toExport(list, 1700000500);
  const back = trackerStore.fromExport(json);
  check('export: round trip', !back.error && back.activities.length === 1);
  check('export: series survives', back.activities[0].series.sp.length === list[0].series.sp.length);
  check('export: envelope carries format + version',
    JSON.parse(json).format === trackerStore.FORMAT && JSON.parse(json).version === 1);
  check('import: bare array accepted',
    !trackerStore.fromExport(JSON.stringify(list)).error);
  check('import: garbage rejected', !!trackerStore.fromExport('not json at all').error);
  check('import: wrong shape rejected', !!trackerStore.fromExport('{"foo":1}').error);
  check('import: foreign format rejected',
    !!trackerStore.fromExport('{"format":"strava","activities":[]}').error);
  check('import: empty list rejected', !!trackerStore.fromExport('{"activities":[]}').error);
  check('import: entries without a series are skipped',
    !!trackerStore.fromExport('{"activities":[{"name":"x"}]}').error);
  const mixed = trackerStore.fromExport(JSON.stringify({
    activities: [list[0], { name: 'broken' }]
  }));
  check('import: partial file keeps the good entries',
    mixed.activities.length === 1 && mixed.skipped === 1);
  check('import: hand-edited values are coerced', (() => {
    const hand = trackerStore.fromExport(JSON.stringify({
      activities: [{ name: 'x', series: { dt: 5, sp: [100, 'oops', 250], hr: [0, 0, 0] } }]
    }));
    return !hand.error && hand.activities[0].series.sp[1] === 0;
  })());
}

check('store: no localStorage in Node degrades to empty', trackerStore.load().length === 0);
check('store: save without localStorage reports failure', trackerStore.save([]).ok === false);

// ---- tracker chart axis ticks ---------------------------------------------
console.log('tracker chart');
{
  const t = niceTicks(0, 10, 5);
  check('ticks: round steps', t.length >= 4 && t.length <= 7 && t[1] - t[0] === 2, t.join(','));
  check('ticks: cover the range', t[0] >= 0 && t[t.length - 1] <= 10 + 1e-9);
  check('ticks: degenerate span', niceTicks(5, 5, 5).length === 1);
  const pace = niceTicks(540, 620, 5);
  check('ticks: pace seconds', pace.every(v => v % 20 === 0), pace.join(','));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests passed');
process.exit(failures ? 1 : 0);
