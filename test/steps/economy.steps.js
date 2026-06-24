// @ts-check
'use strict';
// Step definitions for features/economy.feature — drives src/render/economy.js.

const assert = require('node:assert');
const { renderEconomy } = require('../../src/render/economy');

const strip = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** @param {string} s e.g. "3h20m", "5d10h", "4h00m" → minutes */
function parseDur(s) {
  let m = 0;
  const d = /(\d+)d/.exec(s); if (d) m += Number(d[1]) * 1440;
  const h = /(\d+)h/.exec(s); if (h) m += Number(h[1]) * 60;
  const mm = /(\d+)m\b/.exec(s); if (mm) m += Number(mm[1]);
  return m;
}

/** add or replace a rate-limit bucket on the view (keyed, so overrides replace) */
function setWindow(/** @type {Record<string, any>} */ w, key, label, usedPct, dur, windowMinutes) {
  w.view = w.view || {};
  w.view.windows = w.view.windows || [];
  const win = { key, label, usedPct: Number(usedPct), minutesToReset: dur != null ? parseDur(dur) : null, windowMinutes };
  const i = w.view.windows.findIndex((/** @type {any} */ x) => x.key === key);
  if (i >= 0) w.view.windows[i] = win; else w.view.windows.push(win);
}

function render(/** @type {Record<string, any>} */ w) {
  w.view = w.view || {};
  w.raw = renderEconomy(w.view, { theme: w.theme || 'plain' });
  w.out = strip(w.raw);
  w.lines = w.out.split('\n');
  w.hero = w.lines[2] || '';                          // [0]=title [1]=blank [2]=hero
  w.meterLines = w.lines.filter((l) => /[▓░]/.test(l)); // lines that contain a bar
}
/** find the bar row for a label (5h / weekly / ctx) */
function meterRow(/** @type {Record<string, any>} */ w, /** @type {string} */ label) {
  return w.lines.find((/** @type {string} */ l) => /[▓░]/.test(l) && new RegExp('\\b' + label + '\\b').test(l)) || '';
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineEconomySteps(reg) {
  // --- Background / given ---
  reg.define(/^a subscription session on model "([^"]+)" with a 1\.0M context window$/, (w, model) => {
    w.view = w.view || {}; w.view.model = model; w.view.windowSize = 1000000;
  });
  reg.define(/^the 5h window is (\d+)% used and resets in (.+)$/, (w, used, dur) => setWindow(w, '5h', '5h', used, dur, 300));
  reg.define(/^the weekly window is (\d+)% used and resets in (.+)$/, (w, used, dur) => setWindow(w, 'weekly', 'weekly', used, dur, 10080));
  reg.define(/^a Sonnet-only weekly bucket is (\d+)% used and resets in (.+)$/, (w, used, dur) => setWindow(w, 'seven_day_sonnet', 'weekly · Sonnet', used, dur, 10080));
  reg.define(/^the only bucket present is the 5h window at (\d+)% used resetting in (.+)$/, (w, used, dur) => {
    w.view = w.view || {}; w.view.windows = [{ key: '5h', label: '5h', usedPct: Number(used), minutesToReset: parseDur(dur), windowMinutes: 300 }];
  });
  reg.define(/^the live context is (\d+)K tokens$/, (w, k) => {
    w.view = w.view || {}; w.view.contextTokens = Number(k) * 1000; w.view.cachedPct = 80;
  });
  reg.define(/^the projected post-clear context baseline is (\d+)K tokens$/, (w, k) => {
    w.view.baselineTok = Number(k) * 1000;
  });
  reg.define(/^an API session with no five_hour or seven_day rate limit$/, (w) => {
    w.view = w.view || {}; w.view.windows = [];
  });
  reg.define(/^the session cost so far is ([\d.]+) USD$/, (w, usd) => { w.view.costUsd = Number(usd); });
  reg.define(/^the mary interface is enabled$/, (w) => { w.theme = 'mary'; });

  // --- Action ---
  reg.define(/^the economy screen renders$/, render);

  // --- Hero ---
  reg.define(/^the most prominent line shows the time remaining until the binding limit$/, (w) => {
    assert.match(w.hero, /\b(5h|weekly)\b/, 'hero names the binding window');
    assert.match(w.hero, /~\d+[mhd]/, 'hero shows a time figure');
  });
  reg.define(/^the screen does not headline a percentage-per-minute burn rate$/, (w) => {
    assert.ok(!w.out.includes('%/min'), 'no %/min anywhere');
  });
  reg.define(/^the time figure reads as remaining budget, not as percentage used$/, (w) => {
    assert.match(w.hero, /~\d/, 'hero is a time, not a %');
    assert.ok(!/% used/.test(w.hero), 'hero is not "% used"');
  });

  // --- Clear decision ---
  reg.define(/^the clear line states how many more minutes clearing now would buy$/, (w) => {
    assert.match(w.out, /clear now → \+\d/, 'shows "clear now → +<time>"');
  });
  reg.define(/^it shows the context drop "([^"]+)"$/, (w, drop) => {
    assert.ok(w.out.includes(drop), `expected "${drop}"`);
  });
  reg.define(/^the screen does not require the reader to know what "ROI" means$/, (w) => {
    assert.ok(!w.out.includes('ROI'));
  });
  reg.define(/^the clear line says there is little to gain from clearing$/, (w) => {
    assert.match(w.out, /little to gain/);
  });

  // --- Meters appear once ---
  reg.define(/^the 5h window meter appears exactly once$/, (w) => {
    assert.strictEqual(w.meterLines.filter((/** @type {string} */ l) => /\b5h\b/.test(l)).length, 1);
  });
  reg.define(/^the context meter appears exactly once$/, (w) => {
    assert.strictEqual(w.meterLines.filter((/** @type {string} */ l) => /\bctx\b/.test(l)).length, 1);
  });
  reg.define(/^the weekly window meter appears exactly once$/, (w) => {
    assert.strictEqual(w.meterLines.filter((/** @type {string} */ l) => /\bweekly\b/.test(l)).length, 1);
  });

  // --- Used vs left labels ---
  reg.define(/^the "([^"]+)" line is labelled as used, not left$/, (w, meter) => {
    const row = meterRow(w, meter);
    assert.match(row, /\d+% used/, `${meter} shows "% used"`);
    assert.ok(!/\d+% left/.test(row), `${meter} must not show "% left"`);
  });
  reg.define(/^any time figure labelled "left" or "until" refers to remaining budget$/, (w) => {
    assert.ok(!/% left/.test(w.out), 'no percentage is labelled "left"');
  });

  // --- Plain labels ---
  reg.define(/^the screen does not contain the label "re-read"$/, (w) => {
    assert.ok(!w.out.includes('re-read'));
  });
  reg.define(/^cache efficiency, if shown, uses a self-evident word like "cached"$/, (w) => {
    assert.ok(!/cache[ -]read/i.test(w.out));
    if (/cache/i.test(w.out)) assert.ok(w.out.includes('cached'));
  });

  // --- The wall ---
  reg.define(/^the binding window is marked "the wall"$/, (w) => {
    assert.ok(w.out.includes('the wall'), 'binding window marked "the wall"');
  });

  // --- Graceful multi-bucket handling ---
  reg.define(/^a "([^"]+)" meter is shown$/, (w, label) => {
    const needle = label.replace(/.*·\s*/, '').trim() || label;
    assert.ok(w.meterLines.some((/** @type {string} */ l) => l.includes(needle)), `expected a meter for "${label}"`);
  });
  reg.define(/^the screen renders without error$/, (w) => {
    assert.ok(typeof w.raw === 'string' && w.lines.length > 2);
  });

  // --- Theme ---
  reg.define(/^the screen does not use the phrase "bad moon rising"$/, (w) => {
    assert.ok(!w.out.includes('bad moon rising'));
  });
  reg.define(/^the screen uses the phrase "bad moon rising"$/, (w) => {
    assert.ok(w.out.includes('bad moon rising'));
  });

  // --- API degrade ---
  reg.define(/^the screen does not crash or render an empty panel$/, (w) => {
    assert.ok(typeof w.raw === 'string' && w.lines.length > 2);
  });
  reg.define(/^it states that window economy is for subscription plans$/, (w) => {
    assert.match(w.out, /subscription/i);
  });
  reg.define(/^it still shows the session cost "(\$[\d.]+)"$/, (w, cost) => {
    assert.ok(w.out.includes(cost), `expected ${cost}`);
  });
  reg.define(/^it shows no fabricated burn rate or time-to-limit$/, (w) => {
    assert.ok(!/next limit/.test(w.out) && !/~\d+[mhd]/.test(w.out), 'no invented time-to-limit');
  });
};
