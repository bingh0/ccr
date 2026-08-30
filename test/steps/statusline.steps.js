// @ts-check
'use strict';
// Step definitions for features/statusline.feature — drives src/render/statusline.js.

const assert = require('node:assert');
const { refuteWithControl } = require('./_absence');
const { renderStatusline } = require('../../src/render/statusline');

/** @param {string} s e.g. "4h00m", "5d00h" → minutes */
function parseDur(s) {
  let m = 0;
  const d = /(\d+)d/.exec(s); if (d) m += Number(d[1]) * 1440;
  const h = /(\d+)h/.exec(s); if (h) m += Number(h[1]) * 60;
  const mm = /(\d+)m\b/.exec(s); if (mm) m += Number(mm[1]);
  return m;
}
/** "150K" / "1.0M" → tokens */
function parseTok(/** @type {string} */ s) {
  const m = /([\d.]+)\s*([KM]?)/.exec(s);
  if (!m) return Number(s);
  const n = Number(m[1]);
  return m[2] === 'M' ? n * 1e6 : m[2] === 'K' ? n * 1e3 : n;
}
function view(/** @type {Record<string, any>} */ w) {
  w.view = w.view || { windows: [] };
  return w.view;
}
/**
 * @param {Record<string, any>} w
 * @param {string} key
 * @param {string} label
 * @param {string} usedPct a step capture, hence the Number() below
 * @param {string} dur a step capture like "4h00m", parsed to minutes
 * @param {number} rate the callers coerce this one themselves
 */
function setWindow(w, key, label, usedPct, dur, rate) {
  view(w).windows.push({ key, label, usedPct: Number(usedPct), minutesToReset: parseDur(dur), windowMinutes: parseDur(dur) + 1, rate });
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineStatuslineSteps(reg) {
  reg.define(/^a status view on model "([^"]+)"$/, (w, model) => { view(w).model = model; });
  reg.define(/^a status view on model "([^"]+)" with no rate limits$/, (w, model) => {
    view(w).model = model; view(w).windows = [];
  });
  reg.define(/^a 5h limit at (\d+)% used, resetting in (\S+), burning ([\d.]+)%\/min$/,
    (w, u, dur, rate) => setWindow(w, 'five_hour', '5h', String(u), String(dur), Number(rate)));
  reg.define(/^a weekly limit at (\d+)% used, resetting in (\S+), burning ([\d.]+)%\/min$/,
    (w, u, dur, rate) => setWindow(w, 'seven_day', 'weekly', String(u), String(dur), Number(rate)));
  // Fractional used% — the distinct "at a raw" phrasing keeps it clear of the
  // integer setters above (the harness rejects ambiguous step patterns).
  reg.define(/^a 5h limit at a raw ([\d.]+)% used, resetting in (\S+), burning ([\d.]+)%\/min$/,
    (w, u, dur, rate) => setWindow(w, 'five_hour', '5h', String(u), String(dur), Number(rate)));
  reg.define(/^status context of (\S+) tokens in a (\S+) window$/, (w, ctx, win) => {
    view(w).contextTokens = parseTok(String(ctx)); view(w).windowSize = parseTok(String(win));
  });
  reg.define(/^a status session cost of ([\d.]+) USD$/, (w, usd) => { view(w).costUsd = Number(usd); });

  reg.define(/^the status line renders$/, (w) => { w.line = renderStatusline(view(w)); });

  reg.define(/^the line contains the model "([^"]+)"$/, (w, m) => assert.ok(w.line.includes(m), w.line));
  reg.define(/^the line names the weekly window as the binding limit$/, (w) => {
    assert.ok(/weekly\s+~/.test(w.line), `expected "weekly ~<time>" in: ${w.line}`);
  });
  reg.define(/^the line shows the context percentage "([^"]+)"$/, (w, s) => assert.ok(w.line.includes(s), w.line));
  reg.define(/^the line shows the cost "([^"]+)"$/, (w, s) => assert.ok(w.line.includes(s), w.line));
  // Witness: a real SGR run. Claude Code renders the status line itself, so
  // the refusal is the whole contract here and nothing positive can stand in.
  reg.define(/^the line contains no ANSI colour codes$/, (w) =>
    refuteWithControl(/\x1b\[/, w.line, '\x1b[31mred\x1b[0m',
      `ANSI found: ${JSON.stringify(w.line)}`));
  reg.define(/^the line contains the warning marker$/, (w) => assert.ok(w.line.includes('⚠'), `no marker in: ${w.line}`));
  reg.define(/^the line states there are no limits$/, (w) => assert.ok(/no limits/i.test(w.line), w.line));
  // step-lint: allow unearned-absence -- the binding-window step below asserts /~\d/ POSITIVELY on this same w.line, so a needle that stopped matching a real time-to-limit would fail there first
  reg.define(/^the line shows no fabricated time-to-limit$/, (w) => assert.ok(!/~\d/.test(w.line), `unexpected time figure: ${w.line}`));

  // --- Critical-zone progressive disclosure ---
  reg.define(/^the line shows the binding used% as "([^"]+)"$/,
    (w, s) => assert.ok(w.line.includes(s), `expected "${s}" in: ${w.line}`));
  reg.define(/^the binding window shows time-to-limit but no used% figure$/, (w) => {
    assert.match(w.line, /~\d/, `expected a time-to-limit in: ${w.line}`);
    // A disclosed used% renders as "<n>% ~<time>". The context percentage
    // ("ctx 15%") is never followed by a time, so it cannot false-positive here.
    refuteWithControl(/%\s*~/, w.line, '87% ~2h',
      `unexpected used% before the time in: ${w.line}`);
  });
};
