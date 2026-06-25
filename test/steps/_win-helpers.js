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

function toolLine(name, input) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name, input }] },
  });
}
const append = (f, lines) => fs.appendFileSync(f, lines.map((l) => l + '\n').join(''));

/**
 * Split the wt.exe argv into its meaningful pieces. Shape (see buildWtArgs):
 *   new-tab --title Claude cmd /k <pane0> ; split-pane <flag> -s <frac> cmd /k <pane1>
 * @param {string[]} args
 */
function panes(args) {
  const sep = args.indexOf(';');
  return {
    pane0: args[5],
    pane1: args[args.length - 1],
    splitFlag: args[sep + 2],
    frac: args[sep + 4],
    hasNewTab: args[0] === 'new-tab',
    hasSplit: args[sep + 1] === 'split-pane',
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
  return {
    env: world.env || {},
    home: world.home || path.join('/home', 'me'),
    node: world.node || '/usr/bin/node',
    ccrJs: world.ccrJs || '/repo/bin/ccr.js',
    out: (/** @type {string} */ s) => { world.out += s; },
    err: (/** @type {string} */ s) => { world.err += s; },
    findWt: () => (present.wt ? 'C:\\Program Files\\WindowsApps\\wt.exe' : null),
    which: (/** @type {string} */ name) => (present[name] ? `/usr/bin/${name}` : null),
    existsDir: () => !!world.existsProfile,
    listDir: () => world.availableProfiles || ['c1', 'c2'],
    ensureDir: (/** @type {string} */ dir) => { world.ensured.push(dir); },
    removeExited: (/** @type {string} */ dir) => { world.removedExited.push(dir); },
    writeSettings: opts.writeSettings || ((s) => { world.written.push(s); return 'C:\\Temp\\ccr-settings-feat.json'; }),
    cleanup: (/** @type {string} */ f) => { world.cleaned.push(f); },
    spawnWt: (/** @type {string} */ wt, /** @type {string[]} */ args) => { world.spawns.push({ wt, args }); return { status: 0 }; },
  };
}

module.exports = { launchWin, inject, SAMPLE, freshDir, tmpFile, toolLine, append, panes, launcherDeps };
