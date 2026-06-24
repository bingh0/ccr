// @ts-check
'use strict';
// Step definitions for features/resume.feature — drives src/resume.js (buildRow)
// and src/render/resume.js (renderResume). Pure: no filesystem.

const assert = require('node:assert');
const { buildRow } = require('../../src/resume');
const { renderResume } = require('../../src/render/resume');

const strip = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const NOW = Date.UTC(2026, 5, 21, 12, 0, 0); // fixed "now" for deterministic ages

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineResumeSteps(reg) {
  // --- buildRow inputs ---
  reg.define(/^a session whose last assistant turn re-feeds (\d+) context tokens on model "([^"]+)"$/, (w, ctx, model) => {
    w.parsed = { title: 'S', lastPrompt: null, meta: { gitBranch: 'main', cwd: '/p' }, stats: { lastTurn: { input: Number(ctx), output: 0, cacheRead: 0, cacheCreate: 0 }, lastModel: model } };
    w.file = { sessionId: 'abc', mtimeMs: NOW };
  });
  reg.define(/^the session was last active (\d+) days ago$/, (w, d) => { w.file.mtimeMs = NOW - Number(d) * 86400000; });
  reg.define(/^the session was last active (\d+) minutes ago$/, (w, m) => { w.file.mtimeMs = NOW - Number(m) * 60000; });
  reg.define(/^the advisor row is built$/, (w) => { w.row = buildRow(w.parsed, w.file, NOW); });
  reg.define(/^the row context is (\d+) tokens$/, (w, n) => assert.strictEqual(w.row.ctx, Number(n)));
  reg.define(/^the row cache is cold$/, (w) => assert.strictEqual(w.row.cold, true));
  reg.define(/^the row cache is warm$/, (w) => assert.strictEqual(w.row.cold, false));
  reg.define(/^the row window percentage is (\d+)$/, (w, n) => assert.strictEqual(w.row.winPct, Number(n)));

  // --- renderResume inputs ---
  reg.define(/^an advisor row titled "([^"]+)" with (\d+)K context at (\d+)% (cold|warm)$/, (w, title, k, pct, cache) => {
    w.rows = [{ sessionId: 's', title, branch: 'main', ageMin: 100, ctx: Number(k) * 1000, winPct: Number(pct), cold: cache === 'cold' }];
  });
  reg.define(/^no advisor rows$/, (w) => { w.rows = []; });
  reg.define(/^the advisor renders$/, (w) => { w.out = strip(renderResume(w.rows, { scope: 'cwd' })); });
  reg.define(/^the advisor renders for the current project$/, (w) => { w.out = strip(renderResume(w.rows, { scope: 'cwd' })); });

  // --- assertions ---
  reg.define(/^the output shows the title "([^"]+)"$/, (w, t) => assert.ok(w.out.includes(t), w.out));
  reg.define(/^the output shows "([^"]+)"$/, (w, s) => assert.ok(w.out.includes(s), w.out));
  reg.define(/^the output points to "([^"]+)"$/, (w, s) => assert.ok(w.out.includes(s), w.out));
  reg.define(/^the output does not claim a percentage of the rate-limit window$/, (w) => {
    assert.ok(!/(5h|weekly|rate.?limit)/i.test(w.out), `must not reference rate-limit windows:\n${w.out}`);
  });
  reg.define(/^the output flags it as near \/clear$/, (w) => assert.match(w.out, /near \/clear/));
  reg.define(/^the output suggests "([^"]+)"$/, (w, s) => assert.ok(w.out.includes(s), w.out));
};
