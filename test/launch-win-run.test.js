'use strict';

// Phase 3 — launcher orchestration.
// Mirrors the run/launch scenarios of features/windows-launcher.feature and
// features/fallback-no-wt.feature. All side effects are injected so no wt.exe,
// claude, or filesystem is touched.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { run, fallbackNoWt } = require('../src/launch-win.js');

/**
 * Build a fully-stubbed Deps object plus call recorders.
 *
 * The stub is typed against the real Deps contract on purpose: if a dependency
 * changes shape, this stops compiling instead of drifting silently into a test
 * that stubs something the launcher no longer asks for. Partial, because that
 * is exactly what run() accepts — it fills the rest via withDefaults.
 *
 * @param {Partial<import('../src/launch-win.js').Deps>} [o]
 */
function makeDeps(o = {}) {
  /** @type {string[]} */
  const errs = [];
  /** @type {string[]} */
  const outs = [];
  const calls = {
    /** @type {{ wt: string, args: string[] }[]} */
    spawnWt: [],
    /** @type {string[]} */
    ensureDir: [],
    /** @type {string[]} */
    removeExited: [],
    /** @type {{ dir: string, cwd: string }[]} */
    recordLaunchDir: [],
    /** @type {string[]} */
    cleanup: [],
    writeSettings: 0,
  };
  /** @type {Partial<import('../src/launch-win.js').Deps>} */
  const deps = {
    env: o.env || {},
    home: o.home || '/home/me',
    // Pinned, not inherited: cwd now reaches wt as `-d`, so leaving it to
    // withDefaults would make the spawned argv depend on where the suite was
    // run from — green on one machine, shifted on another.
    cwd: o.cwd !== undefined ? o.cwd : 'C:\\work\\app',
    node: o.node || '/usr/bin/node',
    ccrJs: o.ccrJs || '/repo/bin/ccr.js',
    out: (s) => outs.push(s),
    err: (s) => errs.push(s),
    findWt: o.findWt || (() => 'C:\\wt.exe'),
    which: o.which || (() => '/bin/found'),
    existsDir: o.existsDir || (() => true),
    listDir: o.listDir || (() => ['c1', 'c2']),
    ensureDir: (d) => calls.ensureDir.push(d),
    // Slot allocation touches the real filesystem, so stub it here rather than
    // relying on the fake home being unwritable. Default: slot 1 under the
    // instances container — EVERY launch slots now, profiled or bare;
    // features/instance-slots.feature owns the allocation behaviour itself.
    prepareInstance: o.prepareInstance || (() => ({ name: 'stub', title: 'stub' })),
    allocateSlot: o.allocateSlot || (() => ({
      slot: 1, session: 'ccr',
      stateDir: path.join(o.home || '/home/me', '.ccr', 'instances', '1'),
      attached: false,
    })),
    removeExited: (d) => calls.removeExited.push(d),
    recordLaunchDir: (dir, cwd) => calls.recordLaunchDir.push({ dir, cwd }),
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

  const stateDir = path.join('/home/me', '.ccr', 'instances', '1');
  const panes = args.filter((a) => a.startsWith('set "CCR_STATE_DIR='));
  assert.strictEqual(panes.length, 2);
  assert.ok(panes.every((p) => p.includes(stateDir)));

  assert.ok(calls.ensureDir.includes(stateDir));
  assert.ok(calls.removeExited.includes(stateDir));
  assert.strictEqual(calls.writeSettings, 1);
});

test('run: an allocated instance slot reaches both panes', () => {
  // The second concurrent bare launch: the allocator hands back slot 2, and the
  // whole window — both panes' CCR_STATE_DIR, the state dir prepared on disk —
  // has to follow it, or the two instances share a snapshot again.
  const slot2 = path.join('/home/me', '.ccr', 'instances', '2');
  const { deps, calls } = makeDeps({
    allocateSlot: () => ({ slot: 2, session: 'ccr-2', stateDir: slot2, attached: false }),
  });
  assert.strictEqual(run(undefined, deps), 0);

  const panes = calls.spawnWt[0].args.filter((a) => a.startsWith('set "CCR_STATE_DIR='));
  assert.strictEqual(panes.length, 2);
  assert.ok(panes.every((p) => p.includes(slot2)), 'both panes carry the slot dir');
  assert.ok(calls.ensureDir.includes(slot2));
  assert.ok(calls.removeExited.includes(slot2));
});

test('run: a named profile slots like a bare launch', () => {
  // The profiles-removal ruling: a profile's old per-profile namespace let two
  // launches of the SAME profile kill-session each other. The allocator is
  // still told which profile was named (the join key records it), but the
  // namespace is the slot's.
  /** @type {any[]} */
  const asked = [];
  const slot1 = path.join('/home/me', '.ccr', 'instances', '1');
  const { deps, calls } = makeDeps({
    allocateSlot: (o) => { asked.push(o); return { slot: 1, session: 'ccr', stateDir: slot1, attached: false }; },
  });
  run('c1', deps);
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].profile, 'c1', 'the allocator is told which profile was named');
  assert.ok(calls.ensureDir.includes(slot1), 'the profile session lives in its slot dir');
});

test('run: the instance title reaches the Windows Terminal tab', () => {
  // Fix for the half-lit platform: naming/title used to live on the tmux path
  // only, so a Windows tab stayed "Claude" and its instance had no name.
  const { deps, calls } = makeDeps({
    prepareInstance: (slot, o) => ({ name: 'a', title: `${o.profile} / a` }),
  });
  run('c1', deps, { name: null });
  const { args } = calls.spawnWt[0];
  assert.strictEqual(args[args.indexOf('--title') + 1], 'c1 / a');
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
  // Found by content, not by index — the argv grows options (`-d`) over time
  // and a hardcoded position turns an unrelated addition into a red test.
  assert.ok(args.some((a) => /ccs c1 --settings/.test(a)), 'pane 0 runs the profile');
  const stateDir = path.join('/home/me', '.ccr', 'instances', '1');
  assert.ok(args.filter((a) => a.startsWith('set "CCR_STATE_DIR=')).every((p) => p.includes(stateDir)));
});

// --- The panes' starting directory (@AC10) --------------------------------

test('run: the launch directory reaches wt and the record from ONE source (@AC10)', () => {
  const { deps, calls } = makeDeps({ cwd: 'C:\\work\\app' });
  assert.strictEqual(run(undefined, deps), 0);

  const { args } = calls.spawnWt[0];
  assert.strictEqual(args[args.indexOf('-d') + 1], 'C:\\work\\app', 'wt is told where to open');
  assert.strictEqual(calls.recordLaunchDir[0].cwd, 'C:\\work\\app', 'and the record agrees');

  // The whole point of routing both through d.cwd: the git pane reads the
  // record while Claude Code lives in the pane, so if these two could differ
  // the sidebar would describe a session that is somewhere else entirely.
  assert.strictEqual(args[args.indexOf('-d') + 1], calls.recordLaunchDir[0].cwd);
});

test('run: a directory wt cannot be given still launches, and says so (@AC10)', () => {
  const { deps, errs, calls } = makeDeps({ cwd: 'C:\\my;dir\\app' });
  assert.strictEqual(run(undefined, deps), 0, 'a legal directory name never blocks the launch');

  assert.strictEqual(calls.spawnWt.length, 1, 'the window still opens');
  assert.strictEqual(calls.spawnWt[0].args.includes('-d'), false, 'with no starting directory');

  const msg = errs.join('');
  assert.match(msg, /my;dir/, 'the directory is named');
  assert.match(msg, /default directory/, 'and where the panes will land instead');

  // The record still holds the true launch dir — only wt could not be told.
  assert.strictEqual(calls.recordLaunchDir[0].cwd, 'C:\\my;dir\\app');
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
  /** @type {string[]} */
  const errs = [];
  const code = fallbackNoWt({ err: (s) => errs.push(s) });
  assert.strictEqual(code, 1);
  const msg = errs.join('');
  assert.match(msg, /winget/);
  assert.match(msg, /ccr economy/);
  assert.match(msg, /ccr statusline/);
  assert.match(msg, /ccr doctor/);
});
