// @ts-check
'use strict';
// Step definitions for features/liveness.feature.
//
// The screen-facing scenarios drive the REAL frame composer (composeFrame) with
// a temp state dir — an aged snapshot mtime and the exit sentinel are the actual
// inputs — so "the dashboard stays visible" is asserted on rendered output, not
// on the policy function's mode field. The two policy scenarios at the bottom
// pin src/liveness.js directly (determinism, no process probing).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { liveness } = require('../../src/liveness');
const { composeFrame } = require('../../src/sidecar');
const { freshDir, SAMPLE } = require('./_win-helpers');

const LIVENESS_SRC = path.join(__dirname, '..', '..', 'src', 'liveness.js');

const strip = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');
/** The dashboard proper: model name from the snapshot + at least one meter bar. */
const dashboardVisible = (/** @type {string} */ frame) =>
  /Opus 4\.8/.test(frame) && /[▓░]/.test(frame);

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineLivenessSteps(reg) {
  // --- Background / context ---
  reg.define(/^a live economy frame was last rendered from a valid status snapshot$/, (w) => {
    w.dir = freshDir();
    w.defer(() => fs.rmSync(w.dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(w.dir, 'last-status.json'), SAMPLE);
    w.now = Date.now();
    w.exited = false;
    w.ageMs = 0;
  });
  reg.define(/^no exit sentinel is present$/, (w) => {
    fs.rmSync(path.join(w.dir, 'exited'), { force: true });
    w.exited = false;
  });
  reg.define(/^the exit sentinel is present$/, (w) => {
    fs.writeFileSync(path.join(w.dir, 'exited'), '');
    w.exited = true;
  });
  /** @type {import('../gherkin').StepFn} */
  const age = (w, n) => {
    w.ageMs = Number(n) * 60000;
    const agoSec = (w.now - w.ageMs) / 1000;
    fs.utimesSync(path.join(w.dir, 'last-status.json'), agoSec, agoSec);
  };
  reg.define(/^the status snapshot has not been updated for (\d+) minutes$/, age);
  reg.define(/^the status snapshot was last updated (\d+) minutes ago$/, age);
  reg.define(/^CCR_STALE_MS is set to (\d+)$/, (w, ms) => { w.staleEnv = ms; });

  // --- Action: render the real frame (staleness threshold via env, restored) ---
  reg.define(/^the sidecar renders$/, (w) => {
    const prev = process.env.CCR_STALE_MS;
    if (w.staleEnv != null) process.env.CCR_STALE_MS = w.staleEnv;
    try {
      w.frame = strip(composeFrame(w.dir, { now: w.now }));
    } finally {
      if (prev === undefined) delete process.env.CCR_STALE_MS;
      else process.env.CCR_STALE_MS = prev;
    }
  });

  // --- Screen assertions (on the rendered frame) ---
  reg.define(/^the economy dashboard is still shown with the last-known numbers$/, (w) => {
    assert.ok(dashboardVisible(w.frame), `dashboard not visible in:\n${w.frame}`);
    assert.match(w.frame, /50% used/, "the snapshot's 5h number survives");
  });
  reg.define(/^the dashboard remains visible$/, (w) => {
    assert.ok(dashboardVisible(w.frame), `dashboard not visible in:\n${w.frame}`);
  });
  reg.define(/^the dashboard renders normally$/, (w) => {
    assert.ok(dashboardVisible(w.frame), `dashboard not visible in:\n${w.frame}`);
  });
  reg.define(/^the screen is not replaced with "([^"]+)"$/, (w, msg) => {
    assert.ok(!w.frame.includes(msg), `frame must not contain "${msg}"`);
    assert.ok(dashboardVisible(w.frame), 'the dashboard, not a placeholder, is on screen');
  });
  reg.define(/^a dim "updated (\d+)m ago" marker is appended$/, (w, n) => {
    assert.ok(w.frame.includes(`updated ${n}m ago`), `no "updated ${n}m ago" in:\n${w.frame}`);
  });
  reg.define(/^no freshness marker is shown yet$/, (w) => {
    assert.doesNotMatch(w.frame, /updated \d+m ago/);
  });
  reg.define(/^the screen shows "session ended"$/, (w) => {
    assert.match(w.frame, /session ended/);
  });
  reg.define(/^the live meters are no longer shown$/, (w) => {
    assert.ok(!/[▓░]/.test(w.frame), 'ended screen must not keep meter bars');
  });
  reg.define(/^the screen does not claim the session ended$/, (w) => {
    assert.ok(!w.frame.includes('session ended'));
  });
  reg.define(/^the dashboard remains visible with a freshness marker$/, (w) => {
    assert.ok(dashboardVisible(w.frame), `dashboard not visible in:\n${w.frame}`);
    assert.match(w.frame, /updated \d+m ago/);
  });

  // --- Policy scenarios: pin src/liveness.js itself ---
  reg.define(/^the sidecar determines whether to show the ended screen$/, (w) => {
    w.result = liveness({ exited: w.exited, ageMs: w.ageMs });
  });
  reg.define(/^the decision uses only the exit sentinel and the snapshot age$/, (w) => {
    // Deterministic over just those two inputs — no hidden process/time deps.
    const a = liveness({ exited: w.exited, ageMs: w.ageMs });
    const b = liveness({ exited: w.exited, ageMs: w.ageMs });
    assert.deepStrictEqual(a, b);
    assert.ok(a.mode === 'live' || a.mode === 'ended');
  });
  reg.define(/^it does not shell out to pstree or tmux to inspect a process tree$/, () => {
    // Architectural fitness check on executable code, not comments (which are
    // free to explain the design). Scope: src/liveness.js only.
    const code = fs.readFileSync(LIVENESS_SRC, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/\/\/.*$/gm, '');           // line comments
    assert.doesNotMatch(code, /pstree|list-panes|child_process|execSync|spawnSync/);
  });
};
