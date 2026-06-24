// @ts-check
'use strict';
// Step definitions for features/burn-rate.feature — drives src/burn.js.

const assert = require('node:assert');
const {
  FIVE_HOUR_MIN, SEVEN_DAY_MIN,
  inferWindow, parseResetsAt, rateFromSamples, smoothedRate, windowEstimate, binding, clearROI,
} = require('../../src/burn');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineBurnSteps(reg) {
  // --- Plan-agnostic rate from the percentage meter (outline 1) ---
  reg.define(/^the 5h meter moved from (\d+)% to (\d+)% over (\d+) minutes on one model$/, (w, u0, u1, mins) => {
    const m = 'claude-opus-4-8';
    w.samples = [{ t: 0, u: Number(u0), m }, { t: Number(mins), u: Number(u1), m }];
    w.activeModel = m;
  });
  reg.define(/^the burn rate is computed$/, (w) => {
    w.burn = rateFromSamples(w.samples, w.activeModel);
    w.rate = w.burn.rate;
    const last = w.samples[w.samples.length - 1];
    w.lastU = last ? last.u : null;
    w.minutesLeft = (w.rate && w.rate > 0 && w.lastU != null) ? (100 - w.lastU) / w.rate : null;
  });
  reg.define(/^the rate is approximately ([\d.]+) percent per minute$/, (w, rate) => {
    assert.ok(Math.abs(w.rate - Number(rate)) < 0.01, `rate ${w.rate} ≉ ${rate}`);
  });
  reg.define(/^the minutes-left equals \(100 - (\d+)\) divided by the rate$/, (w, u1) => {
    assert.strictEqual(w.minutesLeft, (100 - Number(u1)) / w.rate);
  });
  reg.define(/^the calculation does not depend on the plan's absolute token cap$/, (w) => {
    const a = w.samples.map((/** @type {any} */ s) => ({ ...s, w: 200000 }));
    const b = w.samples.map((/** @type {any} */ s) => ({ ...s, w: 1000000 }));
    assert.strictEqual(rateFromSamples(a, w.activeModel).rate, rateFromSamples(b, w.activeModel).rate);
  });

  // --- Model scoping (scenario 2) ---
  reg.define(/^a sample buffer with 3 slow Sonnet samples followed by 4 fast Opus samples$/, (w) => {
    const son = 'claude-sonnet-4-6', op = 'claude-opus-4-8';
    w.samples = [
      { t: 0, u: 40.0, m: son }, { t: 3, u: 40.1, m: son }, { t: 6, u: 40.2, m: son },
      { t: 9, u: 41, m: op }, { t: 12, u: 45, m: op }, { t: 15, u: 49, m: op }, { t: 18, u: 53, m: op },
    ];
  });
  reg.define(/^the active model is Opus$/, (w) => { w.activeModel = 'claude-opus-4-8'; });
  reg.define(/^only the Opus tail is used for the rate$/, (w) => { assert.strictEqual(w.burn.count, 4); });
  reg.define(/^the rate reflects the fast Opus burn, not the blended average$/, (w) => {
    assert.ok(w.burn.rate > 0.8, `expected fast Opus rate, got ${w.burn.rate}`);
  });
  reg.define(/^the result is flagged as having switched models$/, (w) => { assert.strictEqual(w.burn.switched, true); });

  // --- Binding window: Max (scenario 3) ---
  reg.define(/^a Max session where the 5h window is (\d+)% used and resets in (\d+)h(\d+)m$/, (w, used, h, m) => {
    w.fiveHour = windowEstimate({ usedPct: Number(used), minutesToReset: Number(h) * 60 + Number(m), windowMinutes: FIVE_HOUR_MIN });
  });
  reg.define(/^the weekly window is (\d+)% used and resets in (\d+)d$/, (w, used, d) => {
    w.sevenDay = windowEstimate({ usedPct: Number(used), minutesToReset: Number(d) * 1440, windowMinutes: SEVEN_DAY_MIN });
  });
  reg.define(/^the burn rate and time-to-limit are computed$/, (w) => {
    const arr = [];
    if (w.fiveHour) arr.push({ key: '5h', est: w.fiveHour, reset: w.fiveHour.minutesToReset });
    if (w.sevenDay) arr.push({ key: 'weekly', est: w.sevenDay, reset: w.sevenDay.minutesToReset });
    w.binding = binding(arr);
  });
  reg.define(/^both windows have their own burn rate and minutes-left$/, (w) => {
    for (const win of [w.fiveHour, w.sevenDay]) {
      assert.ok(win.rate != null && win.minutesLeft != null, 'each window needs rate + minutesLeft');
    }
  });
  reg.define(/^the reported time-to-limit is the smaller of the two horizons$/, (w) => {
    assert.strictEqual(w.binding.minutesLeft, Math.min(w.fiveHour.minutesLeft, w.sevenDay.minutesLeft));
  });
  reg.define(/^the screen indicates the weekly window is the wall$/, (w) => {
    assert.strictEqual(w.binding.window, 'weekly');
  });

  // --- Binding window: Pro, 5h only (scenario 4) ---
  reg.define(/^a Pro session where the 5h window is (\d+)% used$/, (w, used) => {
    w.fiveHour = windowEstimate({ usedPct: Number(used) });
    w.sevenDay = undefined;
  });
  reg.define(/^there is no weekly rate-limit meter present$/, (w) => { w.sevenDay = null; });
  reg.define(/^the time-to-limit is computed$/, (w) => {
    const arr = [];
    if (w.fiveHour) arr.push({ key: '5h', est: w.fiveHour, reset: w.fiveHour.minutesToReset });
    if (w.sevenDay) arr.push({ key: 'weekly', est: w.sevenDay, reset: w.sevenDay.minutesToReset });
    w.binding = binding(arr);
  });
  reg.define(/^it is based on the 5h window$/, (w) => { assert.strictEqual(w.binding.window, '5h'); });
  reg.define(/^the absence of a weekly meter does not blank the screen$/, (w) => { assert.ok(w.binding != null); });

  // --- Clear-ROI bounds (scenarios 5 & 6) ---
  reg.define(/^the 5h window resets in (\d+)h(\d+)m and the weekly window resets in (\d+)m$/, (w, h, m, wk) => {
    w.resetMinutes = Math.min(Number(h) * 60 + Number(m), Number(wk));
  });
  reg.define(/^clearing would sharply reduce the projected burn$/, (w) => {
    w.roiInput = { rate: 2, usedPct: 50, contextC: 400000, baselineB: 14000, calib: null };
  });
  reg.define(/^the clear-ROI is computed$/, (w) => {
    w.roi = clearROI({ ...w.roiInput, resetMinutes: w.resetMinutes });
  });
  reg.define(/^the minutes bought are capped at 30 minutes$/, (w) => {
    assert.ok(w.roi.boughtMinutes <= 30, `bought ${w.roi.boughtMinutes}m`);
    const uncapped = clearROI({ ...w.roiInput, resetMinutes: Infinity });
    assert.ok(uncapped.boughtMinutes > w.roi.boughtMinutes, 'the reset cap should bind');
  });
  reg.define(/^the figure never exceeds the nearest reset horizon$/, (w) => {
    assert.ok(w.roi.boughtMinutes <= w.resetMinutes);
  });
  reg.define(/^a calibrated context-to-burn line that extrapolates below zero at baseline$/, (w) => {
    w.roiInput = { rate: 0.15, usedPct: 44.4, contextC: 400000, baselineB: 14000, calib: { a: 1e-5, b: -1 } };
  });
  reg.define(/^the current budget already outlasts the reset horizon$/, (w) => { w.resetMinutes = 120; });
  reg.define(/^the projected post-clear burn is floored to a realistic minimum$/, (w) => {
    assert.ok(w.roi.projectedBurn >= 0.01, `projectedBurn ${w.roi.projectedBurn}`);
  });
  reg.define(/^the minutes bought never exceed the reset horizon$/, (w) => {
    assert.ok(w.roi.boughtMinutes <= w.resetMinutes);
  });
  reg.define(/^the screen never shows hundreds or more hours of budget bought$/, (w) => {
    assert.ok(w.roi.boughtMinutes < 6000, `bought ${w.roi.boughtMinutes}m`);
  });

  // --- Window inference (scenarios 7 & 8) ---
  reg.define(/^the live status reports a context_window_size of (\d+)$/, (w, n) => { w.reportedWindowSize = Number(n); });
  reg.define(/^the session never exceeded (\d+)K tokens$/, (w, k) => { w.maxCtx = Number(k) * 1000; });
  reg.define(/^the working context is normalized to percent of window$/, (w) => {
    w.window = inferWindow({ reportedWindowSize: w.reportedWindowSize, maxCtx: w.maxCtx });
  });
  reg.define(/^the window used is (\d+) from the live status$/, (w, n) => { assert.strictEqual(w.window, Number(n)); });
  reg.define(/^it is not under-estimated to a 200K tier$/, (w) => { assert.ok(w.window > 200000); });

  reg.define(/^a transcript on model "([^"]+)" whose max observed context is (\d+)$/, (w, model, maxCtx) => {
    w.model = model; w.maxCtx = Number(maxCtx);
  });
  reg.define(/^its window is inferred$/, (w) => { w.window = inferWindow({ model: w.model, maxCtx: w.maxCtx }); });
  reg.define(/^the inferred window is at least (\d+)$/, (w, n) => {
    assert.ok(w.window >= Number(n), `window ${w.window} < ${n}`);
  });

  // --- Smoothed estimator is steadier than the raw slope ---
  reg.define(/^a bursty meter series alternating fast and slow intervals$/, (w) => {
    w.series = []; let u = 0;
    for (let i = 0; i < 20; i++) { u += (i % 2 ? 0.2 : 3); w.series.push({ t: i, u, m: 'claude-opus-4-8' }); }
  });
  reg.define(/^the smoothed rate and the raw last-interval slope are tracked across the series$/, (w) => {
    let smPrev = null, rawPrev = null, smJit = 0, rawJit = 0, n = 0;
    for (let k = 2; k <= w.series.length; k++) {
      const sm = smoothedRate(w.series.slice(0, k), 'claude-opus-4-8').rate;
      const a = w.series[k - 1], b = w.series[k - 2];
      const raw = (a.u - b.u) / (a.t - b.t);
      if (smPrev != null) { smJit += Math.abs(sm - smPrev); rawJit += Math.abs(raw - rawPrev); n++; }
      smPrev = sm; rawPrev = raw;
    }
    w.smJit = smJit / n; w.rawJit = rawJit / n;
  });
  reg.define(/^the smoothed rate's step-to-step jitter is much lower than the raw slope's$/, (w) => {
    assert.ok(w.smJit < w.rawJit * 0.6, `smoothed jitter ${w.smJit.toFixed(3)} not << raw ${w.rawJit.toFixed(3)}`);
  });

  // --- resets_at robustness (scenario 9) ---
  reg.define(/^a five_hour reset value of "([^"]+)"$/, (w, v) => { w.resetVal = v; });
  reg.define(/^the time-to-reset is computed$/, (w) => { w.parsed = parseResetsAt(w.resetVal); });
  reg.define(/^it yields a finite duration, not NaN$/, (w) => { assert.ok(Number.isFinite(w.parsed)); });
};
