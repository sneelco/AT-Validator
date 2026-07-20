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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests passed');
process.exit(failures ? 1 : 0);
