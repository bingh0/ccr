// @ts-check
'use strict';
// Step definitions for features/statusline.feature — drives src/render/statusline.js.

const assert = require('node:assert');
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
function parseTok(s) {
  const m = /([\d.]+)\s*([KM]?)/.exec(s);
  if (!m) return Number(s);
  const n = Number(m[1]);
  return m[2] === 'M' ? n * 1e6 : m[2] === 'K' ? n * 1e3 : n;
}
function view(/** @type {Record<string, any>} */ w) {
  w.view = w.view || { windows: [] };
  return w.view;
}
function setWindow(/** @type {Record<string, any>} */ w, key, label, usedPct, dur, rate) {
  view(w).windows.push({ key, label, usedPct: Number(usedPct), minutesToReset: parseDur(dur), windowMinutes: parseDur(dur) + 1, rate });
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineStatuslineSteps(reg) {
  reg.define(/^a status view on model "([^"]+)"$/, (w, model) => { view(w).model = model; });
  reg.define(/^a status view on model "([^"]+)" with no rate limits$/, (w, model) => {
    view(w).model = model; view(w).windows = [];
  });
  reg.define(/^a 5h limit at (\d+)% used, resetting in (\S+), burning ([\d.]+)%\/min$/,
    (w, u, dur, rate) => setWindow(w, 'five_hour', '5h', u, dur, Number(rate)));
  reg.define(/^a weekly limit at (\d+)% used, resetting in (\S+), burning ([\d.]+)%\/min$/,
    (w, u, dur, rate) => setWindow(w, 'seven_day', 'weekly', u, dur, Number(rate)));
  reg.define(/^status context of (\S+) tokens in a (\S+) window$/, (w, ctx, win) => {
    view(w).contextTokens = parseTok(ctx); view(w).windowSize = parseTok(win);
  });
  reg.define(/^a status session cost of ([\d.]+) USD$/, (w, usd) => { view(w).costUsd = Number(usd); });

  reg.define(/^the status line renders$/, (w) => { w.line = renderStatusline(view(w)); });

  reg.define(/^the line contains the model "([^"]+)"$/, (w, m) => assert.ok(w.line.includes(m), w.line));
  reg.define(/^the line names the weekly window as the binding limit$/, (w) => {
    assert.ok(/weekly\s+~/.test(w.line), `expected "weekly ~<time>" in: ${w.line}`);
  });
  reg.define(/^the line shows the context percentage "([^"]+)"$/, (w, s) => assert.ok(w.line.includes(s), w.line));
  reg.define(/^the line shows the cost "([^"]+)"$/, (w, s) => assert.ok(w.line.includes(s), w.line));
  reg.define(/^the line contains no ANSI colour codes$/, (w) => assert.ok(!/\x1b\[/.test(w.line), `ANSI found: ${JSON.stringify(w.line)}`));
  reg.define(/^the line contains the warning marker$/, (w) => assert.ok(w.line.includes('⚠'), `no marker in: ${w.line}`));
  reg.define(/^the line states there are no limits$/, (w) => assert.ok(/no limits/i.test(w.line), w.line));
  reg.define(/^the line shows no fabricated time-to-limit$/, (w) => assert.ok(!/~\d/.test(w.line), `unexpected time figure: ${w.line}`));
};
