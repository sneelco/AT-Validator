/*
 * Node test suite: FIT parser (against values cross-checked with the official
 * Garmin FIT SDK), CSV parser, and the drift analysis.  Run: node tests/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFit } = require('../js/fit-parser.js');
const { parseCsv } = require('../js/csv-parser.js');
const { analyzeWindow, rangeStats } = require('../js/analysis.js');

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

// rangeStats half-open interval: sample at endT excluded.
{
  const samples = [{ t: 0, hr: 100 }, { t: 10, hr: 200 }];
  const r = rangeStats(samples, 0, 10);
  check('rangeStats: half-open', close(r.avg, 100), `got ${r.avg}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests passed');
process.exit(failures ? 1 : 0);
