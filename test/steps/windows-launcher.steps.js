// @ts-check
'use strict';
// Step definitions for features/windows-launcher.feature — drives
// src/launch-win.js run() with fully-injected, recorded side effects. The
// scenarios assert user-observable launch behavior (one window, two wired
// panes, clean errors); exact argv tokens stay in test/launch-win.test.js.

const assert = require('node:assert');
const path = require('node:path');
const { launchWin, launcherDeps, panes } = require('./_win-helpers');

function runLauncher(/** @type {Record<string, any>} */ world, /** @type {string|undefined} */ profile) {
  const deps = launcherDeps(world);
  world.code = launchWin.run(profile, deps);
  world.args = world.spawns.length ? world.spawns[0].args : null;
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineWindowsLauncherSteps(reg) {
  // Background
  reg.define(/^the platform is win32$/, (w) => { w.platform = 'win32'; });
  reg.define(/^Node 18\.3\+ is installed$/, () => {});
  reg.define(/^`claude` is resolvable on PATH$/, (w) => { (w.present ||= {}).claude = true; });
  reg.define(/^`wt\.exe` \(Windows Terminal\) is resolvable on PATH$/, (w) => { (w.present ||= {}).wt = true; });

  // Scenario-specific Givens
  reg.define(/^the environment sets CCR_SIDEBAR_PCT to "(\d+)"$/, (w, pct) => { (w.env ||= {}).CCR_SIDEBAR_PCT = pct; });
  reg.define(/^`ccs` is resolvable on PATH$/, (w) => { (w.present ||= {}).ccs = true; });
  reg.define(/^`ccs` is not resolvable on PATH$/, (w) => { (w.present ||= {}).ccs = false; });
  reg.define(/^the CCS profile directory "([^"]+)" exists$/, (w) => { w.existsProfile = true; });
  reg.define(/^the CCS profile directory "([^"]+)" does not exist$/, (w) => { w.existsProfile = false; });
  reg.define(/^a stale file "exited" exists in the resolved state dir$/, (w) => { w.staleExited = true; });
  reg.define(/^ccr is run from the directory "([^"]+)"$/, (w, dir) => { w.cwd = dir; });

  // When
  reg.define(/^I run "ccr"$/, (w) => runLauncher(w, undefined));
  reg.define(/^I run "ccr (.+)"$/, (w, profile) => runLauncher(w, profile));

  // Then — the split window
  reg.define(/^exactly one Windows Terminal window opens with two panes$/, (w) => {
    assert.strictEqual(w.spawns.length, 1, 'exactly one wt spawn');
    const p = panes(w.args);
    assert.ok(p.hasNewTab && p.hasSplit, 'new-tab + split-pane present');
  });
  reg.define(/^the left pane runs Claude Code via `claude --settings <temp-file>`$/, (w) => {
    assert.match(panes(w.args).pane0, /claude --settings "/);
  });
  reg.define(/^the right pane runs `ccr sidecar` at approximately 34% width$/, (w) => {
    const p = panes(w.args);
    assert.match(p.pane1, /sidecar/);
    assert.strictEqual(p.frac, '0.34');
  });
  reg.define(/^both panes receive CCR_STATE_DIR pointing at "~\/\.ccr\/instances\/1"$/, (w) => {
    const expected = path.join(w.home || '/home/me', '.ccr', 'instances', '1');
    const p = panes(w.args);
    for (const pane of [p.pane0, p.pane1]) assert.ok(pane.includes(`set "CCR_STATE_DIR=${expected}"`), pane);
  });
  // Then — where the panes open (@AC10). Each `-d` is checked inside its OWN
  // pane's segment of the argv: one before the ";" separator and one after it.
  // A single -d covering only the first segment would leave the sidecar in the
  // Windows Terminal profile's default directory.
  reg.define(/^both panes are given the starting directory "([^"]+)"$/, (w, dir) => {
    const sep = w.args.indexOf(';');
    const pane0 = w.args.slice(0, sep);
    const pane1 = w.args.slice(sep);
    assert.strictEqual(pane0[pane0.indexOf('-d') + 1], dir, 'pane 0 starting directory');
    assert.strictEqual(pane1[pane1.indexOf('-d') + 1], dir, 'pane 1 starting directory');
  });
  reg.define(/^the recorded launch directory is "([^"]+)"$/, (w, dir) => {
    assert.ok(w.recorded, 'the launch directory was recorded');
    assert.strictEqual(w.recorded.cwd, dir);
  });
  reg.define(/^no starting directory is given to Windows Terminal$/, (w) => {
    assert.strictEqual(w.args.includes('-d'), false, 'no -d in the argv');
  });
  reg.define(/^ccr is run from a directory of (\d+) characters$/, (w, n) => {
    const head = 'C:\\long\\';
    w.cwd = head + 'x'.repeat(Number(n) - head.length);
    assert.strictEqual(w.cwd.length, Number(n), 'the fixture must be exactly that long');
  });
  reg.define(/^stderr gives the reason "([^"]+)"$/, (w, fragment) => {
    assert.ok(w.err.includes(fragment), `expected stderr to name "${fragment}", got:\n${w.err}`);
  });
  reg.define(/^stderr explains the panes open in the default directory$/, (w) => {
    assert.match(w.err, /default directory/);
  });

  reg.define(/^the process exits 0$/, (w) => assert.strictEqual(w.code, 0));
  reg.define(/^the sidecar pane is split at approximately 50% width$/, (w) => {
    assert.strictEqual(panes(w.args).frac, '0.5');
  });

  // Then — the profile path
  reg.define(/^the left pane runs Claude Code via `ccs c1 --settings <temp-file>`$/, (w) => {
    assert.match(panes(w.args).pane0, /ccs c1 --settings "/);
  });
  reg.define(/^the profile launch slots like a bare one, session "ccr"$/, (w) => {
    // The sanctioned rename (profiles-removal ruling): no per-profile session
    // names anywhere — a profile launch rides its slot's session like any other.
    const st = launchWin.resolveProfileState('c1', { env: w.env || {}, home: w.home || '/home/me' });
    assert.strictEqual(st.session, 'ccr');
  });

  // Then — error paths
  reg.define(/^stderr explains the profile was not found$/, (w) => assert.match(w.err, /not found/));
  reg.define(/^stderr lists the available profiles$/, (w) => assert.match(w.err, /available:/));
  reg.define(/^the process exits non-zero$/, (w) => assert.notStrictEqual(w.code, 0));
  reg.define(/^no Windows Terminal window is opened$/, (w) => assert.strictEqual(w.spawns.length, 0));
  reg.define(/^stderr explains that `ccs` must be installed to use a profile$/, (w) => assert.match(w.err, /CCS is installed/i));
  reg.define(/^stderr reports an invalid profile name$/, (w) => assert.match(w.err, /invalid profile/i));
  reg.define(/^the allowed character set "letters, digits, \. _ -" is shown$/, (w) => assert.match(w.err, /letters, digits/));
  reg.define(/^no command is spawned$/, (w) => assert.strictEqual(w.spawns.length, 0));

  // Then — prep
  reg.define(/^the "exited" sentinel is removed before the panes start$/, (w) => assert.ok(w.removedExited.length >= 1));
  reg.define(/^the secure state dir is ensured to exist$/, (w) => assert.ok(w.ensured.length >= 1));
};
