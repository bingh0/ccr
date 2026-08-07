// @ts-check
'use strict';
// Unit tests for src/instance-slot.js — the parts features/instance-slots.feature
// does not speak to: the env hand-off shape, and the safety properties the claim
// primitive's comments claim for themselves.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_SLOTS, OWNER_FILE,
  slotPaths, allocateSlot, applySlotEnv, releaseSlot,
  sweepDeadInstances, retireInstance,
  defaultReserve, defaultInspect, defaultDirUsable, pidAlive,
} = require('../src/instance-slot');
const { HEARTBEAT_FILE } = require('../src/sidecar');

// A pid that is certainly not running, so a slot recorded to it reads free.
const DEAD_PID = 0x7ffffff0;

/** A temp dir removed when the test ends, pass or fail. */
function freshDir(/** @type {import('node:test').TestContext} */ t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-slot-unit-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('slotPaths: every slot is a member of instances/; slot 1 keeps the historical session name', () => {
  assert.deepStrictEqual(slotPaths(1, '/home/me'), {
    slot: 1, session: 'ccr', stateDir: path.join('/home/me', '.ccr', 'instances', '1'),
  });
  assert.deepStrictEqual(slotPaths(2, '/home/me'), {
    slot: 2, session: 'ccr-2', stateDir: path.join('/home/me', '.ccr', 'instances', '2'),
  });
});

test('applySlotEnv: a slot becomes exactly the two vars every launcher already reads', () => {
  const env = { PATH: '/bin', CCR_SIDEBAR_PCT: '40' };
  const out = applySlotEnv(env, { session: 'ccr-2', stateDir: '/home/me/.ccr/2' });
  assert.deepStrictEqual(out, {
    PATH: '/bin', CCR_SIDEBAR_PCT: '40',
    CCR_SESSION: 'ccr-2', CCR_STATE_DIR: '/home/me/.ccr/2',
  });
  assert.notStrictEqual(out, env, 'the caller\'s env is not mutated');
});

test('applySlotEnv: no slot hands back the very same env object', () => {
  const env = { PATH: '/bin' };
  assert.strictEqual(applySlotEnv(env, null), env);
});

test('defaultReserve: the first caller wins and the second is refused', (t) => {
  const dir = freshDir(t);
  assert.strictEqual(defaultReserve(dir), true);
  assert.strictEqual(defaultReserve(dir), false, 'the reservation holds the slot');
  assert.match(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'), /^\d+:\d+$/);
});

test('defaultReserve: a dead owner is cleared and the slot retaken', (t) => {
  const dir = freshDir(t);
  fs.writeFileSync(path.join(dir, OWNER_FILE), `${DEAD_PID}:1`);
  assert.strictEqual(defaultReserve(dir), true, 'a crash must not retire the slot');
  assert.strictEqual(String(process.pid), fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8').split(':')[0]);
});

test('defaultReserve: never touches the sidebar heartbeat', (t) => {
  // Writing a newer nonce into that file is what makes a live sidebar stand
  // down — reusing an attached slot must not kill the pane we mean to reuse.
  const dir = freshDir(t);
  const beat = path.join(dir, HEARTBEAT_FILE);
  fs.writeFileSync(beat, '4242:1');
  assert.strictEqual(defaultReserve(dir), true);
  assert.strictEqual(fs.readFileSync(beat, 'utf8'), '4242:1');
});

test('defaultReserve: never writes through a symlink planted at the owner path', (t) => {
  // The state dir is writable by anything running as the user, so this path is
  // plantable. The link records no live pid, so it is treated as a dead owner
  // and UNLINKED — rmSync removes the link itself, never its target — and the
  // exclusive create then makes a file of our own. At no point is the target
  // opened for writing, so this cannot become an arbitrary-file write.
  const dir = freshDir(t);
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'original');
  const link = path.join(dir, OWNER_FILE);
  fs.symlinkSync(victim, link);

  assert.strictEqual(defaultReserve(dir), true);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'original', 'the target is untouched');
  assert.strictEqual(fs.lstatSync(link).isSymbolicLink(), false, 'the link was replaced by our own file');
});

test('defaultReserve: a planted link that names a LIVE pid declines the slot', (t) => {
  // The other half: content that parses as a running owner is respected rather
  // than cleared, so a reservation can never be stolen by planting a link.
  const dir = freshDir(t);
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, `${process.pid}:${Date.now()}`);
  fs.symlinkSync(victim, path.join(dir, OWNER_FILE));

  assert.strictEqual(defaultReserve(dir), false);
  assert.strictEqual(fs.readFileSync(victim, 'utf8').startsWith(String(process.pid)), true, 'untouched');
});

test('releaseSlot: gives back our own record and leaves anyone else\'s alone', (t) => {
  const dir = freshDir(t);
  defaultReserve(dir);
  releaseSlot(dir);
  assert.strictEqual(fs.existsSync(path.join(dir, OWNER_FILE)), false);

  fs.writeFileSync(path.join(dir, OWNER_FILE), `${DEAD_PID}:1`);
  releaseSlot(dir);
  assert.strictEqual(fs.existsSync(path.join(dir, OWNER_FILE)), true, 'not ours to release');
});

test('pidAlive: true for this process, false for a pid that is not running', () => {
  assert.strictEqual(pidAlive(process.pid), true);
  assert.strictEqual(pidAlive(DEAD_PID), false);
  for (const bogus of [0, -1, NaN, 1.5]) assert.strictEqual(pidAlive(bogus), false, `pid ${bogus}`);
});

test('defaultDirUsable: rejects a symlink standing in for a slot directory', (t) => {
  const dir = freshDir(t);
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  const file = path.join(dir, 'file');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  fs.writeFileSync(file, '');

  assert.strictEqual(defaultDirUsable(real), true);
  assert.strictEqual(defaultDirUsable(path.join(dir, 'absent')), true, 'absent is fine — it gets created');
  assert.strictEqual(defaultDirUsable(link), false, 'a symlink to a directory is still a symlink');
  assert.strictEqual(defaultDirUsable(file), false);
});

test('defaultInspect: a missing state dir is free and unattached', (t) => {
  assert.deepStrictEqual(defaultInspect(path.join(freshDir(t), 'nope')), { live: false, attached: false });
});

test('defaultInspect: a live owner outranks every other signal', (t) => {
  // The regression this exists for: the sidebar is what dies first, and losing
  // it must not hand a running session's slot to the next launcher.
  const dir = freshDir(t);
  fs.writeFileSync(path.join(dir, OWNER_FILE), `${process.pid}:${Date.now()}`);
  assert.deepStrictEqual(defaultInspect(dir), { live: true, attached: false }, 'no sidebar at all');
  fs.writeFileSync(path.join(dir, 'exited'), '');
  assert.deepStrictEqual(defaultInspect(dir), { live: true, attached: false }, 'even with a stray sentinel');
});

test('defaultInspect: with the owner gone, a beating sidebar decides', (t) => {
  const dir = freshDir(t);
  fs.writeFileSync(path.join(dir, OWNER_FILE), `${DEAD_PID}:1`);
  fs.writeFileSync(path.join(dir, HEARTBEAT_FILE), `4242:${Date.now()}`);
  assert.deepStrictEqual(defaultInspect(dir), { live: true, attached: false }, 'detached session');
  fs.writeFileSync(path.join(dir, 'exited'), '');
  assert.deepStrictEqual(defaultInspect(dir), { live: false, attached: true }, 'session over, sidebar waiting');
});

test('allocateSlot: a slot that cannot be created is skipped, not fatal', (t) => {
  // ensureDir throwing for slot 1 (an unwritable ~/.ccr, a file in the way) must
  // fall through to the next slot rather than abort the launch.
  const home = freshDir(t);
  /** @type {string[]} */
  const tried = [];
  const slot = allocateSlot({
    env: {},
    home,
    inspect: () => ({ live: false, attached: false }),
    ensureDir: (d) => { tried.push(d); if (tried.length === 1) throw new Error('EACCES'); },
    dirUsable: () => true,
    reserve: () => true,
  });
  assert.ok(slot && !('exhausted' in slot));
  assert.strictEqual(slot.slot, 2);
  assert.strictEqual(tried.length, 2);
});

test('allocateSlot: with every slot live the launch is refused, not shared', (t) => {
  // The old fallback target (the shared container) was the reported bug, so
  // exhaustion is an explicit refusal the caller turns into an error.
  let probes = 0;
  const slot = allocateSlot({
    env: {},
    home: freshDir(t),
    inspect: () => { probes++; return { live: true, attached: false }; },
    ensureDir: () => {},
    dirUsable: () => true,
    reserve: () => true,
  });
  assert.deepStrictEqual(slot, { exhausted: true });
  assert.strictEqual(probes, MAX_SLOTS);
});

test('allocateSlot: slot 1 passes the same dir check as every other slot', (t) => {
  // Under the container layout slot 1 is an ordinary member of instances/,
  // so the symlink guard applies to it uniformly.
  /** @type {string[]} */
  const asked = [];
  const home = freshDir(t);
  const slot = allocateSlot({
    env: {},
    home,
    inspect: () => ({ live: false, attached: false }),
    ensureDir: () => {},
    dirUsable: (d) => { asked.push(d); return true; },
    reserve: () => true,
  });
  assert.ok(slot && !('exhausted' in slot));
  assert.strictEqual(slot.slot, 1);
  assert.deepStrictEqual(asked, [path.join(home, '.ccr', 'instances', '1')]);
});

test('allocateSlot: an explicit override short-circuits before any filesystem work', (t) => {
  for (const env of [{ CCR_SESSION: 'mine' }, { CCR_STATE_DIR: '/tmp/mine' }]) {
    const slot = allocateSlot({
      env,
      home: freshDir(t),
      inspect: () => { throw new Error('must not probe'); },
      ensureDir: () => { throw new Error('must not create'); },
      dirUsable: () => { throw new Error('must not stat'); },
      reserve: () => { throw new Error('must not reserve'); },
    });
    assert.strictEqual(slot, null);
  }
});

// --- ephemerality: the sweep and the retirement ---

/** Build <home>/.ccr/instances/<n> with the given files. */
function makeInstance(/** @type {string} */ home, /** @type {number} */ n, /** @type {Record<string,string>} */ files) {
  const dir = path.join(home, '.ccr', 'instances', String(n));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test('sweepDeadInstances: a dead instance is removed, a live one is untouched', (t) => {
  const home = freshDir(t);
  const dead = makeInstance(home, 1, { [OWNER_FILE]: `${DEAD_PID}:1`, 'last-status.json': '{}' });
  const live = makeInstance(home, 2, { [OWNER_FILE]: `${process.pid}:1` });
  assert.strictEqual(sweepDeadInstances({ home, minAgeMs: 0 }), 1);
  assert.strictEqual(fs.existsSync(dead), false, 'dead pid, dir deleted');
  assert.strictEqual(fs.existsSync(live), true, 'live pid, dir kept');
});

test('sweepDeadInstances: a stale heartbeat alone never deletes while the process lives', (t) => {
  // The ruled asymmetry: heartbeat staleness is display-only. Suspend, swap
  // and Ctrl-Z silence a live session far past the 5s window.
  const home = freshDir(t);
  const dir = makeInstance(home, 1, {
    [OWNER_FILE]: `${process.pid}:1`,
    [HEARTBEAT_FILE]: `4242:${Date.now() - 20 * 60_000}`,
  });
  assert.strictEqual(sweepDeadInstances({ home, minAgeMs: 0 }), 0);
  assert.strictEqual(fs.existsSync(dir), true);
});

test('sweepDeadInstances: an attached sidebar keeps its dir for reuse', (t) => {
  const home = freshDir(t);
  const dir = makeInstance(home, 1, {
    [OWNER_FILE]: `${DEAD_PID}:1`,
    [HEARTBEAT_FILE]: `4242:${Date.now()}`,
    exited: '',
  });
  assert.strictEqual(sweepDeadInstances({ home, minAgeMs: 0 }), 0);
  assert.strictEqual(fs.existsSync(dir), true, 'a live process still reads this dir');
});

test('sweepDeadInstances: only numeric member dirs are candidates, and never through a symlink', (t) => {
  const home = freshDir(t);
  const root = path.join(home, '.ccr', 'instances');
  makeInstance(home, 1, { [OWNER_FILE]: `${DEAD_PID}:1` });
  fs.mkdirSync(path.join(root, 'not-a-slot'));
  const target = makeInstance(home, 9, { [OWNER_FILE]: `${DEAD_PID}:1` });
  fs.symlinkSync(target, path.join(root, '3'));
  // Slots 1 and 9 are dead members and go; the symlink at "3" is skipped, so
  // its target is only ever touched under its own name.
  assert.strictEqual(sweepDeadInstances({ home, minAgeMs: 0 }), 2);
  assert.strictEqual(fs.existsSync(path.join(root, 'not-a-slot')), true);
  assert.strictEqual(fs.existsSync(target), false, 'swept as slot 9 itself, not through the link');
  assert.strictEqual(fs.lstatSync(path.join(root, '3')).isSymbolicLink(), true, 'the link is left alone');
});

test('sweepDeadInstances: a recently written dir is left for the next sweep', (t) => {
  // The native-Windows startup window: launcher gone, heartbeat not yet
  // beating. Declining to delete young dirs is the safe direction.
  const home = freshDir(t);
  const dir = makeInstance(home, 1, {});
  assert.strictEqual(sweepDeadInstances({ home }), 0);
  assert.strictEqual(fs.existsSync(dir), true);
});

test('retireInstance: a polite exit deletes the instance dir', (t) => {
  const home = freshDir(t);
  const dir = makeInstance(home, 1, { [OWNER_FILE]: `${process.pid}:1`, 'last-status.json': '{}' });
  retireInstance(dir, { home, sidecarAlive: () => false });
  assert.strictEqual(fs.existsSync(dir), false);
});

test('retireInstance: an attached sidebar downgrades deletion to a release', (t) => {
  const home = freshDir(t);
  const dir = makeInstance(home, 1, { [OWNER_FILE]: `${process.pid}:1`, exited: '' });
  retireInstance(dir, { home, sidecarAlive: () => true });
  assert.strictEqual(fs.existsSync(dir), true, 'the sidebar is still reading it');
  assert.strictEqual(fs.existsSync(path.join(dir, OWNER_FILE)), false, 'but the reservation is released');
});

test('retireInstance: never deletes outside the instances container', (t) => {
  const home = freshDir(t);
  const outside = path.join(home, 'custom-state');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, OWNER_FILE), `${process.pid}:1`);
  retireInstance(outside, { home, sidecarAlive: () => false });
  assert.strictEqual(fs.existsSync(outside), true, 'an explicit override dir is not ccr\'s to delete');
  assert.strictEqual(fs.existsSync(path.join(outside, OWNER_FILE)), false, 'reservation released only');
});
