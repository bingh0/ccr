// @ts-check
'use strict';
// Step definitions for features/wt-args-builder.feature — drives the pure
// buildWtArgs() / findWindowsTerminal(). These assert structural properties of
// the argv (both panes carry env, sidecar is the split, settings by path, the
// exit sentinel is wired); the exact-token pinning lives in launch-win.test.js.

const assert = require('node:assert');
const { launchWin, panes } = require('./_win-helpers');

const DEFAULTS = {
  ccCmd: 'claude',
  settingsFile: 'C:\\Temp\\ccr-settings-ab12.json',
  stateDir: 'C:\\Users\\me\\.ccr',
  node: 'C:\\Program Files\\nodejs\\node.exe',
  ccrJs: 'C:\\repo\\bin\\ccr.js',
};

function build(w) {
  w.settingsFile = w.settingsFile || DEFAULTS.settingsFile;
  w.args = launchWin.buildWtArgs({
    ccCmd: w.ccCmd || DEFAULTS.ccCmd,
    settingsFile: w.settingsFile,
    stateDir: w.stateDir || DEFAULTS.stateDir,
    node: w.node || DEFAULTS.node,
    ccrJs: w.ccrJs || DEFAULTS.ccrJs,
    sidebarPct: w.pct != null ? w.pct : 34,
    sidebarSide: w.side,
  });
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineWtArgsBuilderSteps(reg) {
  // Givens (canonical scenario)
  reg.define(/^node resolves to "([^"]+)"$/, (w, v) => { w.node = v; });
  reg.define(/^ccrJs resolves to the packaged "([^"]+)"$/, (w, v) => { w.ccrJs = 'C:\\repo\\' + v.replace(/\//g, '\\'); });
  reg.define(/^the state dir is "([^"]+)"$/, (w, v) => { w.stateDir = v; });
  reg.define(/^the settings file is "([^"]+)"$/, (w, v) => { w.settingsFile = v; });
  reg.define(/^the Claude command is "([^"]+)"$/, (w, v) => { w.ccCmd = v; });
  reg.define(/^the sidebar percentage is (\d+)$/, (w, v) => { w.pct = Number(v); });

  // When
  reg.define(/^I build the wt\.exe args$/, (w) => build(w));

  // Then
  reg.define(/^the first pane is a "new-tab" titled "Claude"$/, (w) => {
    assert.strictEqual(w.args[0], 'new-tab');
    assert.ok(w.args.includes('Claude'));
  });
  reg.define(/^the first pane command sets CCR_STATE_DIR then runs `claude --settings` with the settings file$/, (w) => {
    const { pane0 } = panes(w.args);
    assert.match(pane0, /^set "CCR_STATE_DIR=/);
    assert.ok(pane0.includes(`claude --settings "${w.settingsFile}"`), pane0);
  });
  reg.define(/^a "split-pane" token "-V" with size "0\.34" follows$/, (w) => {
    const p = panes(w.args);
    assert.ok(p.hasSplit);
    assert.strictEqual(p.splitFlag, '-V');
    assert.strictEqual(p.frac, '0.34');
  });
  reg.define(/^the pane separator ";" is a standalone argv token$/, (w) => {
    assert.ok(w.args.includes(';'));
  });
  reg.define(/^the second pane command sets CCR_STATE_DIR then runs node with ccrJs and "sidecar"$/, (w) => {
    const { pane1 } = panes(w.args);
    assert.match(pane1, /^set "CCR_STATE_DIR=/);
    assert.match(pane1, /sidecar$/);
  });
  reg.define(/^each pane command is wrapped in `cmd \/k set CCR_STATE_DIR=\.\.\.&& \.\.\.`$/, (w) => {
    const idxs = w.args.map((/** @type {string} */ t, /** @type {number} */ i) => (t === 'cmd' && w.args[i + 1] === '/k' ? i + 2 : -1)).filter((/** @type {number} */ i) => i >= 0);
    assert.strictEqual(idxs.length, 2, 'two cmd /k panes');
    for (const i of idxs) assert.match(w.args[i], /^set "CCR_STATE_DIR=.*"&& /);
  });
  reg.define(/^CCR_STATE_DIR is present in both panes' commands$/, (w) => {
    const p = panes(w.args);
    assert.ok(p.pane0.includes('CCR_STATE_DIR=') && p.pane1.includes('CCR_STATE_DIR='));
  });
  reg.define(/^pane 0's command appends a write of the "exited" sentinel into the state dir$/, (w) => {
    assert.match(panes(w.args).pane0, /type nul > ".*exited"/);
  });
  reg.define(/^the claude command references the settings file by path$/, (w) => {
    assert.ok(panes(w.args).pane0.includes(`"${w.settingsFile}"`));
  });
  reg.define(/^no raw JSON object appears on the command line$/, (w) => {
    assert.ok(!w.args.join(' ').includes('{'));
  });

  // findWindowsTerminal
  reg.define(/^`wt\.exe` is not resolvable on PATH$/, (w) => { w.wtResolvable = false; });
  reg.define(/^findWindowsTerminal is called$/, (w) => {
    w.wtResult = launchWin.findWindowsTerminal({ runWhere: () => (w.wtResolvable ? 'C:\\wt.exe' : null) });
  });
  reg.define(/^it returns null$/, (w) => assert.strictEqual(w.wtResult, null));
  reg.define(/^it does not throw$/, () => { /* reaching here means the When did not throw */ });
};
