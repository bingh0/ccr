// @ts-check
'use strict';
// Step definitions for features/fallback-no-wt.feature — drives launch-win.run()
// with Windows Terminal absent and asserts the graceful guidance + non-zero exit
// with no crash / stack trace.

const assert = require('node:assert');
const { launchWin, launcherDeps } = require('./_win-helpers');

function runLauncher(w) {
  const deps = launcherDeps(w);
  w.threw = false;
  try { w.code = launchWin.run(undefined, deps); } catch (e) { w.threw = true; w.error = e; }
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineFallbackNoWtSteps(reg) {
  // Background
  reg.define(/^the platform is win32$/, (w) => { w.platform = 'win32'; });
  reg.define(/^`wt\.exe` is not resolvable on PATH$/, (w) => { (w.present ||= {}).wt = false; });

  // When
  reg.define(/^I run "ccr"$/, (w) => runLauncher(w));

  // Then
  reg.define(/^it prints guidance pointing to the working native commands$/, (w) => {
    assert.match(w.err, /native commands/);
  });
  reg.define(/^the guidance mentions `ccr economy`, `ccr statusline`, and `ccr doctor`$/, (w) => {
    assert.ok(/ccr economy/.test(w.err) && /ccr statusline/.test(w.err) && /ccr doctor/.test(w.err), w.err);
  });
  reg.define(/^it suggests installing Windows Terminal \(winget\) to get the sidecar$/, (w) => {
    assert.match(w.err, /winget/);
  });
  reg.define(/^the process exits non-zero$/, (w) => assert.notStrictEqual(w.code, 0));

  reg.define(/^no unhandled exception is raised$/, (w) => assert.strictEqual(w.threw, false));
  reg.define(/^no stack trace is printed$/, (w) => assert.ok(!/\n\s+at .+:\d+:\d+/.test(w.err)));
};
