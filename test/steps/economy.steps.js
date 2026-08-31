// @ts-check
'use strict';
// Step definitions for features/economy.feature — drives src/render/economy.js.

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { refuteWithControl } = require('./_absence');
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
/**
 * @param {Record<string, any>} w
 * @param {string} key
 * @param {string} label
 * @param {string} usedPct a step capture, hence the Number() below
 * @param {string} dur a step capture like "3h20m", parsed to minutes
 * @param {number} windowMinutes passed as a literal by the callers
 */
function setWindow(w, key, label, usedPct, dur, windowMinutes) {
  w.view = w.view || {};
  w.view.windows = w.view.windows || [];
  const win = { key, label, usedPct: Number(usedPct), minutesToReset: dur != null ? parseDur(dur) : null, windowMinutes };
  const i = w.view.windows.findIndex((/** @type {any} */ x) => x.key === key);
  if (i >= 0) w.view.windows[i] = win; else w.view.windows.push(win);
}

function render(/** @type {Record<string, any>} */ w) {
  w.view = w.view || {};
  w.raw = renderEconomy(w.view, { theme: w.theme || 'plain', ageMs: w.ageMs || 0 });
  w.out = strip(w.raw);
  w.lines = w.out.split('\n');
  w.hero = w.lines[2] || '';                          // [0]=title [1]=blank [2]=hero
  w.meterLines = w.lines.filter((/** @type {string} */ l) => /[▓░]/.test(l)); // lines that contain a bar
}
/** find the bar row for a label (5h / weekly / ctx) */
function meterRow(/** @type {Record<string, any>} */ w, /** @type {string} */ label) {
  return w.lines.find((/** @type {string} */ l) => /[▓░]/.test(l) && new RegExp('\\b' + label + '\\b').test(l)) || '';
}

// Several refusals below are of one shape: a word that lives in ccr's MODEL
// must never reach the SCREEN. Each is controlled against the module that
// legitimately uses it, so renaming the concept upstream fails the control
// instead of quietly retiring the refusal.
const srcOf = (/** @type {string} */ name) =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'src', name), 'utf8');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineEconomySteps(reg) {
  // --- Background / given ---
  reg.define(/^a subscription session on model "([^"]+)" with a 1\.0M context window$/, (w, model) => {
    w.view = w.view || {}; w.view.model = model; w.view.windowSize = 1000000;
  });
  reg.define(/^the 5h window is (\d+)% used and resets in (.+)$/, (w, used, dur) => setWindow(w, '5h', '5h', String(used), String(dur), 300));
  reg.define(/^the weekly window is (\d+)% used and resets in (.+)$/, (w, used, dur) => setWindow(w, 'weekly', 'weekly', String(used), String(dur), 10080));
  reg.define(/^a Sonnet-only weekly bucket is (\d+)% used and resets in (.+)$/, (w, used, dur) => setWindow(w, 'seven_day_sonnet', 'weekly · Sonnet', String(used), String(dur), 10080));
  reg.define(/^the only bucket present is the 5h window at (\d+)% used resetting in (.+)$/, (w, used, dur) => {
    w.view = w.view || {}; w.view.windows = [{ key: '5h', label: '5h', usedPct: Number(used), minutesToReset: parseDur(String(dur)), windowMinutes: 300 }];
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
  // Fractional used% gets its own phrasing so it can never collide with the
  // integer "is N% used" setters — the harness rejects ambiguous step patterns.
  reg.define(/^the 5h window's raw used_percentage is ([\d.]+), resetting in (.+)$/,
    (w, used, dur) => setWindow(w, '5h', '5h', String(used), String(dur), 300));
  reg.define(/^the snapshot was captured (\d+) minutes? ago$/, (w, min) => { w.ageMs = Number(min) * 60000; });

  // --- Action ---
  reg.define(/^the economy screen renders$/, render);

  // --- Hero ---
  reg.define(/^the most prominent line shows the time remaining until the binding limit$/, (w) => {
    assert.match(w.hero, /\b(5h|weekly)\b/, 'hero names the binding window');
    assert.match(w.hero, /~\d+[mhd]/, 'hero shows a time figure');
  });
  reg.define(/^the screen does not headline a percentage-per-minute burn rate$/, (w) => {
    refuteWithControl('%/min', w.out, srcOf('burn.js'), 'no %/min anywhere');
  });
  reg.define(/^the time figure reads as remaining budget, not as percentage used$/, (w) => {
    assert.match(w.hero, /~\d/, 'hero is a time, not a %');
    // step-lint: allow unearned-absence -- the used-vs-left step below asserts /\d+% used/ positively on a meter row from this same render
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
    refuteWithControl('ROI', w.out, srcOf('economy-model.js'),
      'the screen must not make the reader know the jargon its model uses');
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

  // --- Meter-bar alignment (regression: a huge time-to-exhaust shifted a bar) ---
  reg.define(/^the 5h and weekly meter bars start in the same column$/, (w) => {
    const barCol = (/** @type {string} */ label) => meterRow(w, label).search(/[▓░]/);
    const c5 = barCol('5h'), cw = barCol('weekly');
    assert.ok(c5 >= 0 && cw >= 0, 'both the 5h and weekly meter rows are present');
    assert.strictEqual(c5, cw, `5h bar @${c5} must align with weekly bar @${cw}`);
  });

  // --- Used vs left labels ---
  reg.define(/^the "([^"]+)" line is labelled as used, not left$/, (w, meter) => {
    const row = meterRow(w, String(meter));
    assert.match(row, /\d+% used/, `${meter} shows "% used"`);
    // step-lint: allow unearned-absence -- "left" is this scenario's own forbidden word, not a name anything upstream can rename, so the needle cannot drift out from under the refusal; the /\d+% used/ assertion on the line above rules out the other way this could go vacuous, an empty row. NOT claimed: that "used" proves "left" — it does not
    assert.ok(!/\d+% left/.test(row), `${meter} must not show "% left"`);
  });
  reg.define(/^any time figure labelled "left" or "until" refers to remaining budget$/, (w) => {
    // step-lint: allow unearned-absence -- same reasoning as the used-vs-left step: "left" is the spec's own forbidden word with nothing upstream to rename it, and that step's positive /\d+% used/ proves this output renders percentage labels at all
    assert.ok(!/% left/.test(w.out), 'no percentage is labelled "left"');
  });

  // --- Plain labels ---
  reg.define(/^the screen does not contain the label "re-read"$/, (w) => {
    refuteWithControl('re-read', w.out, srcOf('sidecar.js'),
      'the screen names things plainly; "re-read" is the codebase\'s word');
  });
  reg.define(/^cache efficiency, if shown, uses a self-evident word like "cached"$/, (w) => {
    refuteWithControl(/cache[ -]read/i, w.out, 'cache read / cache-read',
      'cache efficiency is said in a self-evident word, never as "cache read"');
    if (/cache/i.test(w.out)) assert.ok(w.out.includes('cached'));
  });

  // --- The wall ---
  reg.define(/^the binding window is marked "the wall"$/, (w) => {
    assert.ok(w.out.includes('the wall'), 'binding window marked "the wall"');
  });

  // --- Graceful multi-bucket handling ---
  reg.define(/^a "([^"]+)" meter is shown$/, (w, label) => {
    const needle = String(label).replace(/.*·\s*/, '').trim() || String(label);
    assert.ok(w.meterLines.some((/** @type {string} */ l) => l.includes(needle)), `expected a meter for "${label}"`);
  });
  reg.define(/^the screen renders without error$/, (w) => {
    assert.ok(typeof w.raw === 'string' && w.lines.length > 2);
  });

  // --- Theme ---
  reg.define(/^the screen does not use the phrase "bad moon rising"$/, (w) => {
    // step-lint: allow unearned-absence -- the sibling step immediately below asserts this exact phrase positively on the same output
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
    refuteWithControl(/next limit/, w.out, srcOf('theme.js'), 'no invented next-limit label');
    // step-lint: allow unearned-absence -- the hero step above asserts /~\d+[mhd]/ positively on a real render, proving this needle finds a time figure when one exists
    assert.ok(!/~\d+[mhd]/.test(w.out), 'no invented time-to-limit');
  });

  // --- Critical-zone precision + snapshot freshness ---
  // The dim wrapper is invisible once ANSI is stripped, so these read w.raw.
  const DIMMED_USED = /\x1b\[2m[^\x1b]*\d% used\x1b\[0m/;

  reg.define(/^the 5h meter reads "([^"]+)% used"$/, (w, shown) => {
    const row = meterRow(w, '5h');
    assert.ok(row.includes(shown + '% used'), `5h row should read "${shown}% used" — got: ${row.trim()}`);
  });
  reg.define(/^the whole-number part still matches Claude's \/usage floor of (\d+)$/, (w, floorStr) => {
    const m = /(\d+(?:\.\d)?)% used/.exec(meterRow(w, '5h'));
    assert.ok(m, 'a used% figure is present');
    assert.strictEqual(Math.floor(Number(m[1])), Number(floorStr), 'floor(shown) must equal the /usage integer');
  });
  reg.define(/^the used% figure is shown dimmed, not as a live value$/, (w) => {
    assert.match(w.raw, DIMMED_USED, 'used% should be dim-wrapped when the snapshot is stale');
  });
  reg.define(/^the used% figure is not dimmed$/, (w) => {
    assert.doesNotMatch(w.raw, DIMMED_USED, 'used% must not be dim-wrapped while the snapshot is fresh');
  });
};
