// @ts-check
'use strict';
// Step definitions for features/vscode-sidecar.feature — drives
// src/launch-vscode.js run()/hint() with fully-injected, recorded side effects.

const assert = require('node:assert');
const path = require('node:path');
const vscode = require('../../src/launch-vscode');
const sidecar = require('../../src/sidecar');

const OS = { macOS: 'darwin', Windows: 'win32', Linux: 'linux' };

function deps(/** @type {Record<string, any>} */ w) {
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
    // Slot allocation is REAL filesystem work against `home`. Unstubbed it
    // probes and creates ~/.ccr/2… under the fake home — which fails on a dev
    // box (/home/me is unwritable) and SUCCEEDS in a container running as root,
    // making these scenarios pass or fail by machine. Worse for this feature
    // specifically: a real slot carries attached=false, which would silently
    // override the `sidecarAlive` Given that the attached-relaunch scenario is
    // built on. Default to "no slot" — the historical namespace — so these
    // scenarios test the launcher; features/instance-slots.feature owns the rest.
    // Modelled on the real allocator rather than stubbed to null: EVERY launch
    // gets a slot in production — profiled or bare — so returning null here
    // would quietly point scenarios at the env-override path instead. Slot 1's
    // `attached` verdict is the same heartbeat question these scenarios already
    // drive through `sidecarAlive`.
    prepareInstance: () => ({ name: 'stub', title: 'stub' }),
    allocateSlot: w.allocateSlot || (() => ({
      slot: 1, session: 'ccr', stateDir: path.join(w.home || '/home/me', '.ccr', 'instances', '1'), attached: !!w.sidecarAlive,
    })),
    releaseSlot: () => {},
    removeExited: () => {},
    dropExited: () => { w.droppedExited++; },
    writeSettings: () => 'C:\\Temp\\ccr-settings-x.json',
    cleanup: (/** @type {string} */ f) => { w.cleaned.push(f); },
    spawnClaude: (/** @type {string} */ bin, /** @type {string[]} */ args, /** @type {Record<string,string>=} */ extraEnv) => { w.spawnedClaude = { bin, args, extraEnv }; return { status: 0 }; },
    spawnCopy: (/** @type {string} */ cmd, /** @type {string[]} */ a, /** @type {string} */ input) => { w.copied = (w.copied || []).concat({ cmd, input }); return { status: 0 }; },
    sidecarAlive: () => !!w.sidecarAlive,
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
  reg.define(/^I run "ccr" on "([^"]+)"$/, (w, osName) => {
    w.platform = /** @type {Record<string, string>} */ (OS)[osName] || osName;
    w.code = vscode.run(undefined, deps(w));
  });
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
    assert.match(w.out, /sidecar --state-dir ".*\.ccr.instances.1"/);
  });
  reg.define(/^it is copied to the clipboard via an OSC 52 escape$/, (w) => assert.strictEqual(w.osc52, true));

  reg.define(/^the sidecar one-liner asks for the key reader$/, (w) => {
    // Ordered, not merely present: `--keys` has to survive on the same command
    // as the state dir, since the pasted line is the only thing the user runs.
    assert.match(w.out, /sidecar --state-dir ".*\.ccr.instances.1" --keys/);
  });

  reg.define(/^the banner names the keys that cycle the views$/, (w) => {
    // A key nothing on screen mentions is a key nobody presses — this host shows
    // no other hint that a second view exists.
    for (const key of ['Space', 'F3']) {
      assert.ok(w.out.includes(key), `the banner never names ${key}:\n${w.out}`);
    }
  });

  reg.define(/^the "exited" sentinel is dropped in the state dir$/, (w) => assert.ok(w.droppedExited >= 1));
  reg.define(/^the temp settings file is cleaned up$/, (w) => assert.ok(w.cleaned.length >= 1));

  reg.define(/^a banner with the split steps is printed$/, (w) => assert.match(w.out, /live sidecar/));
  reg.define(/^no Claude process is started$/, (w) => assert.strictEqual(w.spawnedClaude, null));

  reg.define(/^Claude starts via `ccs c1 --settings <temp-file>`$/, (w) => {
    assert.strictEqual(w.spawnedClaude.bin, 'ccs');
    assert.strictEqual(w.spawnedClaude.args[0], 'c1');
  });
  reg.define(/^the sidecar one-liner targets the "~\/\.ccr\/instances\/1" state dir$/, (w) => {
    const expected = path.join(w.home || '/home/me', '.ccr', 'instances', '1');
    assert.ok(w.out.includes(`--state-dir "${expected}"`), w.out);
  });
  reg.define(/^stderr explains the profile was not found$/, (w) => assert.match(w.err, /not found/));

  reg.define(/^Claude's environment carries CCR_STATE_DIR = the "~\/\.ccr\/instances\/1" state dir$/, (w) => {
    const expected = path.join(w.home || '/home/me', '.ccr', 'instances', '1');
    assert.strictEqual(w.spawnedClaude.extraEnv && w.spawnedClaude.extraEnv.CCR_STATE_DIR, expected);
  });

  // Relaunch dedupe: fresh heartbeat → note instead of banner + clipboard.
  reg.define(/^a live sidecar is already attached to the state dir$/, (w) => { w.sidecarAlive = true; });
  reg.define(/^a sidecar heartbeat that stopped beating$/, (w) => { w.sidecarAlive = false; });
  reg.define(/^a short note says the attached sidecar picks this session up$/, (w) => {
    assert.match(w.out, /already attached/);
    assert.match(w.out, /picks this session up/);
  });
  reg.define(/^no split banner is printed$/, (w) => {
    assert.ok(!w.out.includes('split your VS Code terminal'), `banner leaked into: ${w.out}`);
  });
  reg.define(/^nothing is copied to the clipboard$/, (w) => {
    assert.strictEqual(w.osc52, false, 'no OSC 52 escape');
    assert.strictEqual(w.copied, undefined, 'no native copy tool spawned');
  });

  // Takeover: a second pasted sidecar converges to a single live panel. Drives
  // src/sidecar.js run() with injected timers/heartbeat, mirroring how the
  // launcher-side steps above inject launch-vscode's side effects.
  reg.define(/^a sidecar is running in a pane$/, (w) => {
    w.pane = { beatResult: 'claimed', yields: 0, exited: 0, clearedBeat: 0, loopCb: null };
    sidecar.run({
      exitOnEnd: false,
      tick: () => {},
      sentinelExists: () => false,
      beat: () => w.pane.beatResult,
      clearBeat: () => { w.pane.clearedBeat++; },
      onYield: () => { w.pane.yields++; },
      setIntervalFn: (/** @type {() => void} */ cb) => { w.pane.loopCb = cb; return 'ID'; },
      setTimeoutFn: () => 'ID',
      clearIntervalFn: () => {},
      clearTimeoutFn: () => {},
      exit: () => { w.pane.exited++; },
      onSignal: () => {},
    });
    assert.strictEqual(w.pane.exited, 0, 'first sidecar is live');
  });
  reg.define(/^a newer sidecar claims the same state dir$/, (w) => {
    w.pane.beatResult = 'yielded'; // the newer nonce now owns the heartbeat
    w.pane.loopCb();               // next render tick notices
  });
  reg.define(/^the older pane paints a hand-off note and exits$/, (w) => {
    assert.strictEqual(w.pane.yields, 1, 'hand-off note painted');
    assert.strictEqual(w.pane.exited, 1, 'older pane folded');
  });
  reg.define(/^the newer sidecar's heartbeat is left in place$/, (w) => {
    assert.strictEqual(w.pane.clearedBeat, 0, 'yield never clears the newer claim');
  });
};
