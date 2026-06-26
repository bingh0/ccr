'use strict';

// Phase 3 — launcher orchestration.
// Mirrors the run/launch scenarios of features/windows-launcher.feature and
// features/fallback-no-wt.feature. All side effects are injected so no wt.exe,
// claude, or filesystem is touched.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { run, fallbackNoWt } = require('../src/launch-win.js');

/** Build a fully-stubbed Deps object plus call recorders. */
function makeDeps(o = {}) {
  const errs = [];
  const outs = [];
  const calls = { spawnWt: [], ensureDir: [], removeExited: [], cleanup: [], writeSettings: 0 };
  const deps = {
    env: o.env || {},
    home: o.home || '/home/me',
    node: o.node || '/usr/bin/node',
    ccrJs: o.ccrJs || '/repo/bin/ccr.js',
    out: (s) => outs.push(s),
    err: (s) => errs.push(s),
    findWt: o.findWt || (() => 'C:\\wt.exe'),
    which: o.which || (() => '/bin/found'),
    existsDir: o.existsDir || (() => true),
    listDir: o.listDir || (() => ['c1', 'c2']),
    ensureDir: (d) => calls.ensureDir.push(d),
    removeExited: (d) => calls.removeExited.push(d),
    writeSettings: o.writeSettings || (() => { calls.writeSettings++; return 'C:\\Temp\\ccr-settings-x.json'; }),
    cleanup: (f) => calls.cleanup.push(f),
    spawnWt: o.spawnWt || ((wt, args) => { calls.spawnWt.push({ wt, args }); return { status: 0 }; }),
  };
  return { deps, errs, outs, calls };
}

test('run: bare ccr opens a split window with both panes carrying CCR_STATE_DIR (@AC2)', () => {
  const { deps, calls } = makeDeps();
  const code = run(undefined, deps);
  assert.strictEqual(code, 0);
  assert.strictEqual(calls.spawnWt.length, 1);

  const { wt, args } = calls.spawnWt[0];
  assert.strictEqual(wt, 'C:\\wt.exe');
  assert.ok(args.includes('new-tab'));
  assert.ok(args.includes('split-pane'));

  const stateDir = path.join('/home/me', '.ccr');
  const panes = args.filter((a) => a.startsWith('set "CCR_STATE_DIR='));
  assert.strictEqual(panes.length, 2);
  assert.ok(panes.every((p) => p.includes(stateDir)));

  assert.ok(calls.ensureDir.includes(stateDir));
  assert.ok(calls.removeExited.includes(stateDir));
  assert.strictEqual(calls.writeSettings, 1);
});

test('run: honors CCR_SIDEBAR_PCT (@AC2)', () => {
  const { deps, calls } = makeDeps({ env: { CCR_SIDEBAR_PCT: '50' } });
  run(undefined, deps);
  assert.ok(calls.spawnWt[0].args.includes('0.5'));
});

test('run: ccr <profile> targets the CCS state dir (@AC6)', () => {
  const { deps, calls } = makeDeps();
  const code = run('c1', deps);
  assert.strictEqual(code, 0);

  const { args } = calls.spawnWt[0];
  assert.match(args[7], /ccs c1 --settings/);
  const stateDir = path.join('/home/me', '.ccr', 'c1');
  assert.ok(args.filter((a) => a.startsWith('set "CCR_STATE_DIR=')).every((p) => p.includes(stateDir)));
});

test('run: unknown profile errors, lists available, no spawn (@AC6)', () => {
  const { deps, errs, calls } = makeDeps({ existsDir: () => false, listDir: () => ['work', 'play'] });
  const code = run('c1', deps);
  assert.strictEqual(code, 1);
  assert.strictEqual(calls.spawnWt.length, 0);
  const msg = errs.join('');
  assert.match(msg, /not found/);
  assert.match(msg, /available:.*work play/);
});

test('run: profile requires ccs on PATH (@AC6)', () => {
  const { deps, errs, calls } = makeDeps({ which: (n) => (n === 'ccs' ? null : '/bin/x') });
  const code = run('c1', deps);
  assert.strictEqual(code, 1);
  assert.strictEqual(calls.spawnWt.length, 0);
  assert.match(errs.join(''), /'ccs' not found on PATH/);
});

test('run: requires claude on PATH for the default launch', () => {
  const { deps, errs, calls } = makeDeps({ which: () => null });
  const code = run(undefined, deps);
  assert.strictEqual(code, 1);
  assert.strictEqual(calls.spawnWt.length, 0);
  assert.match(errs.join(''), /'claude' not found on PATH/);
});

test('run: invalid profile is rejected before any spawn or wt lookup', () => {
  let findWtCalls = 0;
  const { deps, errs, calls } = makeDeps({ findWt: () => { findWtCalls++; return 'C:\\wt.exe'; } });
  const code = run('../escape', deps);
  assert.strictEqual(code, 1);
  assert.strictEqual(calls.spawnWt.length, 0);
  assert.strictEqual(findWtCalls, 0);
  assert.match(errs.join(''), /invalid profile name/);
});

test('run: missing Windows Terminal falls back gracefully, no spawn (@AC7)', () => {
  const { deps, errs, calls } = makeDeps({ findWt: () => null });
  const code = run(undefined, deps);
  assert.strictEqual(code, 1);
  assert.strictEqual(calls.spawnWt.length, 0);
  const msg = errs.join('');
  assert.match(msg, /Windows Terminal/);
  assert.match(msg, /winget install Microsoft\.WindowsTerminal/);
  assert.match(msg, /ccr economy/);
});

test('run: a spawn error cleans up the temp settings file and exits 1', () => {
  const { deps, errs, calls } = makeDeps({ spawnWt: () => ({ status: null, error: new Error('boom') }) });
  const code = run(undefined, deps);
  assert.strictEqual(code, 1);
  assert.strictEqual(calls.cleanup.length, 1);
  assert.match(errs.join(''), /failed to launch Windows Terminal: boom/);
});

test('fallbackNoWt: returns 1 with native-CLI guidance and no crash (@AC7)', () => {
  const errs = [];
  const code = fallbackNoWt({ err: (s) => errs.push(s) });
  assert.strictEqual(code, 1);
  const msg = errs.join('');
  assert.match(msg, /winget/);
  assert.match(msg, /ccr economy/);
  assert.match(msg, /ccr statusline/);
  assert.match(msg, /ccr doctor/);
});
