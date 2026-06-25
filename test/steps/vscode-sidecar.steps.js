// @ts-check
'use strict';
// Step definitions for features/vscode-sidecar.feature — drives
// src/launch-vscode.js run()/hint() with fully-injected, recorded side effects.

const assert = require('node:assert');
const path = require('node:path');
const vscode = require('../../src/launch-vscode');

const OS = { macOS: 'darwin', Windows: 'win32', Linux: 'linux' };

function deps(w) {
  w.out = '';
  w.err = '';
  w.spawnedClaude = null;
  w.droppedExited = 0;
  w.cleaned = [];
  w.osc52 = false;
  const present = Object.assign({ claude: true, ccr: true }, w.present || {});
  return {
    env: w.env || {},
    home: w.home || '/home/me',
    node: '/usr/bin/node',
    ccrJs: '/repo/bin/ccr.js',
    platform: w.platform || 'win32',
    color: false,
    out: (/** @type {string} */ s) => { w.out += s; if (/\x1b\]52;c;/.test(s)) w.osc52 = true; },
    err: (/** @type {string} */ s) => { w.err += s; },
    which: (/** @type {string} */ name) => (present[name] ? `/usr/bin/${name}` : null),
    existsDir: () => !!w.existsProfile,
    listDir: () => ['c1', 'c2'],
    ensureDir: () => {},
    removeExited: () => {},
    dropExited: () => { w.droppedExited++; },
    writeSettings: () => 'C:\\Temp\\ccr-settings-x.json',
    cleanup: (/** @type {string} */ f) => { w.cleaned.push(f); },
    spawnClaude: (/** @type {string} */ bin, /** @type {string[]} */ args) => { w.spawnedClaude = { bin, args }; return { status: 0 }; },
    spawnCopy: (/** @type {string} */ cmd, /** @type {string[]} */ a, /** @type {string} */ input) => { w.copied = (w.copied || []).concat({ cmd, input }); return { status: 0 }; },
  };
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineVscodeSidecarSteps(reg) {
  // Background + Givens
  reg.define(/^`ccr` is running inside a VS Code integrated terminal$/, (w) => { w.inVscode = true; });
  reg.define(/^`claude` is resolvable on PATH$/, (w) => { (w.present ||= {}).claude = true; });
  reg.define(/^`ccs` is resolvable on PATH$/, (w) => { (w.present ||= {}).ccs = true; });
  reg.define(/^the CCS profile directory for "c1" exists$/, (w) => { w.existsProfile = true; });
  reg.define(/^the CCS profile directory for "nope" does not exist$/, (w) => { w.existsProfile = false; });

  // When
  reg.define(/^I run "ccr"$/, (w) => { w.code = vscode.run(undefined, deps(w)); });
  reg.define(/^I run "ccr" on "([^"]+)"$/, (w, osName) => { w.platform = OS[osName] || osName; w.code = vscode.run(undefined, deps(w)); });
  reg.define(/^I run "ccr" and Claude exits$/, (w) => { w.code = vscode.run(undefined, deps(w)); });
  reg.define(/^I run "ccr sidecar --hint"$/, (w) => { w.code = vscode.hint(path.join(w.home || '/home/me', '.ccr'), deps(w)); });
  reg.define(/^I run "ccr ([A-Za-z0-9._-]+)"$/, (w, profile) => { w.code = vscode.run(profile, deps(w)); });

  // Then
  reg.define(/^Claude starts in the current pane via `claude --settings <temp-file>`$/, (w) => {
    assert.strictEqual(w.spawnedClaude.bin, 'claude');
    assert.ok(w.spawnedClaude.args.includes('--settings'), w.spawnedClaude.args.join(' '));
  });
  reg.define(/^a prominent banner shows the split keybinding and the sidecar one-liner$/, (w) => {
    assert.match(w.out, /live sidecar/);
    assert.match(w.out, /Ctrl\+Shift\+5|Cmd\+\\/);
    assert.match(w.out, /sidecar --state-dir/);
  });
  reg.define(/^the process exits with Claude's exit code$/, (w) => assert.strictEqual(w.code, 0));

  reg.define(/^the banner shows the split keybinding "([^"]+)"$/, (w, key) => assert.ok(w.out.includes(key), `${key} not in: ${w.out}`));

  reg.define(/^the sidecar one-liner targets the resolved state dir by argument$/, (w) => {
    assert.match(w.out, /sidecar --state-dir ".*\.ccr"/);
  });
  reg.define(/^it is copied to the clipboard via an OSC 52 escape$/, (w) => assert.strictEqual(w.osc52, true));

  reg.define(/^the "exited" sentinel is dropped in the state dir$/, (w) => assert.ok(w.droppedExited >= 1));
  reg.define(/^the temp settings file is cleaned up$/, (w) => assert.ok(w.cleaned.length >= 1));

  reg.define(/^a banner with the split steps is printed$/, (w) => assert.match(w.out, /live sidecar/));
  reg.define(/^no Claude process is started$/, (w) => assert.strictEqual(w.spawnedClaude, null));

  reg.define(/^Claude starts via `ccs c1 --settings <temp-file>`$/, (w) => {
    assert.strictEqual(w.spawnedClaude.bin, 'ccs');
    assert.strictEqual(w.spawnedClaude.args[0], 'c1');
  });
  reg.define(/^the sidecar one-liner targets the "~\/\.ccr\/c1" state dir$/, (w) => {
    const expected = path.join(w.home || '/home/me', '.ccr', 'c1');
    assert.ok(w.out.includes(`--state-dir "${expected}"`), w.out);
  });
  reg.define(/^stderr explains the profile was not found$/, (w) => assert.match(w.err, /not found/));
};
