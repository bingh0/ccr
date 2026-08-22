// @ts-check
'use strict';
// test/steps/_win-helpers.js — shared helpers for the Windows feature step
// definitions: a recording Deps factory for launch-win.run(), a wt.exe argv
// splitter, and sidecar/transcript fixtures. Like the *.steps.js modules this
// is auto-discovered by `node --test` as a zero-test file (harmless) — the real
// assertions run via test/features.test.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const launchWin = require('../../src/launch-win');
const inject = require('../../src/settings-inject');

// A representative Claude status snapshot (same shape src/sidecar.js consumes).
const SAMPLE = JSON.stringify({
  model: { display_name: 'Opus 4.8' },
  context_window: { context_window_size: 1000000, total_input_tokens: 262000 },
  rate_limits: {
    five_hour: { used_percentage: 50, resets_at: Math.floor(Date.now() / 1000) + 16800 },
    seven_day: { used_percentage: 40, resets_at: Math.floor(Date.now() / 1000) + 500000 },
  },
  cost: { total_cost_usd: 4.2 },
});

let SEQ = 0;
const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-feat-'));
const tmpFile = () => path.join(os.tmpdir(), `ccr-feat-${process.pid}-${++SEQ}.jsonl`);

function toolLine(/** @type {string} */ name, /** @type {any} */ input) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name, input }] },
  });
}
const append = (/** @type {string} */ f, /** @type {string[]} */ lines) =>
  fs.appendFileSync(f, lines.map((l) => l + '\n').join(''));

/**
 * Split the wt.exe argv into its meaningful pieces. Shape (see buildWtArgs):
 *   -w 0 new-tab --title Claude cmd /c <pane0> ; split-pane <flag> -s <frac> cmd /c <pane1>
 * @param {string[]} args
 */
function panes(args) {
  // Read by CONTENT, never by offset. The previous version took pane payloads
  // at fixed distances from `;` and from the first `cmd`, and the split flag and
  // fraction at +2 and +4 from the separator — which meant the order of
  // PRODUCTION argv was constrained by this helper's arithmetic. Move a flag and
  // the helper does not fail, it silently reads a different token and the
  // scenarios keep passing while asserting the wrong thing.
  //
  // Each payload is whatever follows a `cmd /c` pair, in the order wt receives
  // them: pane 0 is the first, the sidecar pane the second.
  const payloads = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === 'cmd' && args[i + 1] === '/c') payloads.push(args[i + 2]);
  }
  /** The token after a flag, wherever the flag sits. */
  const after = (/** @type {string} */ flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    pane0: payloads[0],
    pane1: payloads[1],
    // The split direction is its own token, so match on the token rather than
    // on where it happens to fall relative to the separator.
    splitFlag: args.find((/** @type {string} */ t) => t === '-H' || t === '-V'),
    frac: after('-s'),
    hasNewTab: args.includes('new-tab'),
    hasSplit: args.includes('split-pane'),
    targetsCurrentWindow: after('-w') === '0',
  };
}

/**
 * Build an injected Deps object for launch-win.run() that records every side
 * effect into `world`, so step Thens can assert on the spawned wt argv, stderr,
 * exit code, and the prep calls — without spawning or touching the filesystem.
 * @param {Record<string, any>} world
 * @param {{ writeSettings?: (s: object) => string }} [opts]
 */
function launcherDeps(world, opts = {}) {
  world.spawns = [];
  world.err = '';
  world.out = '';
  world.ensured = [];
  world.removedExited = [];
  world.written = [];
  world.cleaned = [];
  const present = world.present || {};
  world.recorded = null;
  return {
    env: world.env || {},
    home: world.home || path.join('/home', 'me'),
    // Pinned rather than inherited: the cwd now reaches wt as `-d`, so leaving
    // it to withDefaults would put the suite's own working directory into the
    // spawned argv and make these scenarios machine-dependent.
    cwd: world.cwd || 'C:\\work\\app',
    node: world.node || '/usr/bin/node',
    ccrJs: world.ccrJs || '/repo/bin/ccr.js',
    out: (/** @type {string} */ s) => { world.out += s; },
    err: (/** @type {string} */ s) => { world.err += s; },
    findWt: () => (present.wt ? 'C:\\Program Files\\WindowsApps\\wt.exe' : null),
    which: (/** @type {string} */ name) => (present[name] ? `/usr/bin/${name}` : null),
    existsDir: () => !!world.existsProfile,
    listDir: () => world.availableProfiles || ['c1', 'c2'],
    ensureDir: (/** @type {string} */ dir) => { world.ensured.push(dir); },
    // Slot allocation is REAL filesystem work against `home`. Left unstubbed it
    // probes and creates instance dirs under the fake home — which happens to
    // fail on a dev box (/home/me is unwritable) and SUCCEEDS in a container
    // running as root, so the suite would pass or fail depending on the machine.
    // These scenarios pin launcher wiring, not allocation: default to slot 1 —
    // EVERY launch slots now, profiled or bare (features/instance-lifecycle
    // .feature). features/instance-slots.feature owns allocation itself.
    prepareInstance: world.prepareInstance || (() => ({ name: 'stub', title: 'stub' })),
    allocateSlot: world.allocateSlot || (() => ({
      slot: 1, session: 'ccr', stateDir: path.join(world.home || path.join('/home', 'me'), '.ccr', 'instances', '1'), attached: false,
    })),
    removeExited: (/** @type {string} */ dir) => { world.removedExited.push(dir); },
    // Recorded, not performed: the real one writes to the fake home.
    recordLaunchDir: (/** @type {string} */ dir, /** @type {string} */ cwd) => { world.recorded = { dir, cwd }; },
    clearLaunchDir: (/** @type {string} */ dir) => { world.cleared = { dir }; },
    writeSettings: opts.writeSettings || ((s) => { world.written.push(s); return 'C:\\Temp\\ccr-settings-feat.json'; }),
    cleanup: (/** @type {string} */ f) => { world.cleaned.push(f); },
    spawnWt: (/** @type {string} */ wt, /** @type {string[]} */ args) => { world.spawns.push({ wt, args }); return { status: 0 }; },
  };
}

module.exports = { launchWin, inject, SAMPLE, freshDir, tmpFile, toolLine, append, panes, launcherDeps };
