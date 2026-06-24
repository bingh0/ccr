// @ts-check
'use strict';
// Step definitions for features/liveness.feature — drives src/liveness.js.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { liveness } = require('../../src/liveness');

const LIVENESS_SRC = path.join(__dirname, '..', '..', 'src', 'liveness.js');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineLivenessSteps(reg) {
  // --- Background / context ---
  reg.define(/^a live economy frame was last rendered from a valid status snapshot$/, (w) => {
    w.exited = false; w.ageMs = 0; w.staleMs = undefined;
  });
  reg.define(/^no exit sentinel is present$/, (w) => { w.exited = false; });
  reg.define(/^the exit sentinel is present$/, (w) => { w.exited = true; });
  reg.define(/^the status snapshot has not been updated for (\d+) minutes$/, (w, n) => { w.ageMs = Number(n) * 60000; });
  reg.define(/^the status snapshot was last updated (\d+) minutes ago$/, (w, n) => { w.ageMs = Number(n) * 60000; });
  reg.define(/^CCR_STALE_MS is set to (\d+)$/, (w, ms) => { w.staleMs = Number(ms); });

  // --- Action ---
  const render = (/** @type {Record<string, any>} */ w) => {
    w.result = liveness({ exited: w.exited, ageMs: w.ageMs, staleMs: w.staleMs });
  };
  reg.define(/^the sidecar renders$/, render);
  reg.define(/^the sidecar determines whether to show the ended screen$/, render);

  // --- Assertions ---
  reg.define(/^the economy dashboard is still shown with the last-known numbers$/, (w) => { assert.strictEqual(w.result.mode, 'live'); });
  reg.define(/^the dashboard remains visible$/, (w) => { assert.strictEqual(w.result.mode, 'live'); });
  reg.define(/^the dashboard renders normally$/, (w) => { assert.strictEqual(w.result.mode, 'live'); });
  reg.define(/^the screen is not replaced with "no active connection"$/, (w) => { assert.notStrictEqual(w.result.mode, 'ended'); });
  reg.define(/^the screen is not replaced with "idle — waiting for input"$/, (w) => { assert.strictEqual(w.result.mode, 'live'); });
  reg.define(/^a dim "updated (\d+)m ago" marker is appended$/, (w, n) => { assert.strictEqual(w.result.marker, `updated ${n}m ago`); });
  reg.define(/^no freshness marker is shown yet$/, (w) => { assert.strictEqual(w.result.marker, null); });
  reg.define(/^the screen shows "session ended"$/, (w) => { assert.strictEqual(w.result.mode, 'ended'); });
  reg.define(/^it shows the last-known session summary$/, (w) => { assert.strictEqual(w.result.mode, 'ended'); });
  reg.define(/^the screen does not claim the session ended$/, (w) => { assert.notStrictEqual(w.result.mode, 'ended'); });
  reg.define(/^the dashboard remains visible with a freshness marker$/, (w) => {
    assert.strictEqual(w.result.mode, 'live');
    assert.ok(w.result.marker, 'expected a freshness marker');
  });
  reg.define(/^the decision uses only the exit sentinel and the snapshot age$/, (w) => {
    // Deterministic over just those two inputs — no hidden process/time deps.
    const a = liveness({ exited: w.exited, ageMs: w.ageMs });
    const b = liveness({ exited: w.exited, ageMs: w.ageMs });
    assert.deepStrictEqual(a, b);
    assert.ok(a.mode === 'live' || a.mode === 'ended');
  });
  reg.define(/^it does not shell out to pstree or tmux to inspect a process tree$/, () => {
    // Check executable code, not comments (which are free to explain the design).
    const code = fs.readFileSync(LIVENESS_SRC, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/\/\/.*$/gm, '');           // line comments
    assert.doesNotMatch(code, /pstree|list-panes|child_process|execSync|spawnSync/);
  });
};
