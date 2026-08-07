// @ts-check
'use strict';
// test/cli-slot-delivery.test.js — the Linux/macOS delivery path, end to end.
//
// bin/ccr.js hands the chosen slot to scripts/launch.sh through the spawn env,
// and the launcher turns those two variables into its session name, tmux socket
// and state dir. Nothing else covered that hand-off: an adversarial review
// deleted `env` from the spawn — which reverts bare `ccr` to the single hardcoded
// namespace, i.e. deletes this whole feature — and the suite stayed green.
//
// So this runs the REAL CLI with `bash` shadowed on PATH by a stub that reports
// the environment it was handed. No tmux, no Claude, no repo state touched.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CCR_JS = path.join(__dirname, '..', 'bin', 'ccr.js');

// This file's SUBJECT is the bash/tmux hand-off (bin/ccr.js → scripts/launch.sh
// via the spawn env) — a POSIX surface. On win32 the equivalent delivery is
// pinned by test/launch-win-run.test.js ("an allocated instance slot reaches
// both panes"), so these skip rather than fake a launcher that doesn't exist.
const isWin = process.platform === 'win32';

/** A sandbox with a fake HOME and a `bash` on PATH that echoes what it received. */
function sandbox(/** @type {import('node:test').TestContext} */ t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'home'));
  // A migrated home: the container marker predates every instances/ entry.
  fs.mkdirSync(path.join(root, 'home', '.ccr'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'home', '.ccr', '.layout'), '1\n');
  fs.writeFileSync(
    path.join(bin, 'bash'),
    '#!/bin/sh\necho "session=$CCR_SESSION"\necho "state=$CCR_STATE_DIR"\n',
    { mode: 0o755 },
  );
  return { root, home: path.join(root, 'home'), bin };
}

/** Run `node bin/ccr.js <args>` with the sandbox's HOME and shadowed bash. */
function runCcr(/** @type {{home: string, bin: string}} */ s, /** @type {string[]} */ args = [], /** @type {Record<string,string>} */ extraEnv = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HOME: s.home, PATH: `${s.bin}:${process.env.PATH}` };
  // Drop these BEFORE applying extraEnv: inherited from the developer's own
  // shell they would suppress allocation outright (an explicit namespace always
  // wins), so the test would prove nothing — while a case that deliberately sets
  // one must still get it.
  delete env.CCR_SESSION;
  delete env.CCR_STATE_DIR;
  delete env.TERM_PROGRAM; // never take the VS Code branch
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [CCR_JS, ...args], { env, encoding: 'utf8' });
  const out = String(r.stdout || '');
  const field = (/** @type {RegExp} */ re) => {
    const m = re.exec(out);
    return m ? m[1].trim() : '';
  };
  return { session: field(/session=(.*)/), stateDir: field(/state=(.*)/) };
}

/** Mark a slot dir as held by a live session (this test process is the owner). */
function occupy(/** @type {string} */ dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'slot-owner'), `${process.pid}:${Date.now()}`);
}

const inst = (/** @type {{home: string}} */ s, /** @type {number} */ n) =>
  path.join(s.home, '.ccr', 'instances', String(n));

test('bare `ccr` hands slot 1 to the launcher, under the instances container', { skip: isWin }, (t) => {
  const s = sandbox(t);
  const got = runCcr(s);
  assert.strictEqual(got.session, 'ccr');
  assert.strictEqual(got.stateDir, inst(s, 1));
});

test('a second bare `ccr` hands the launcher a different session, socket and state dir', { skip: isWin }, (t) => {
  // The reported bug in one assertion: these two values are what launch.sh turns
  // into the tmux session and socket, so equal values here mean the second launch
  // kill-sessions the first.
  const s = sandbox(t);
  occupy(inst(s, 1));
  const got = runCcr(s);
  assert.strictEqual(got.session, 'ccr-2');
  assert.strictEqual(got.stateDir, inst(s, 2));
});

test('a third bare `ccr` steps past both', { skip: isWin }, (t) => {
  const s = sandbox(t);
  occupy(inst(s, 1));
  occupy(inst(s, 2));
  assert.strictEqual(runCcr(s).session, 'ccr-3');
});

test('a profile launch slots exactly like a bare one', { skip: isWin }, (t) => {
  // The profiles-removal ruling's delivery half: `ccr c1` rides slot env too,
  // so two same-profile launches can never share a session name again.
  const s = sandbox(t);
  occupy(inst(s, 1));
  const got = runCcr(s, ['c1']);
  assert.strictEqual(got.session, 'ccr-2');
  assert.strictEqual(got.stateDir, inst(s, 2));
});

test('the instance dir is deleted when the session ends — ephemeral, not just released', { skip: isWin }, (t) => {
  const s = sandbox(t);
  runCcr(s); // the stub bash "session" ends immediately
  assert.strictEqual(fs.existsSync(inst(s, 1)), false, 'a polite exit deletes the instance');
  assert.strictEqual(runCcr(s).session, 'ccr', 'slots are reused, not counted upward');
});

test('an explicit CCR_STATE_DIR is passed through untouched, with no slot assigned', { skip: isWin }, (t) => {
  const s = sandbox(t);
  occupy(inst(s, 1));
  const got = runCcr(s, [], { CCR_STATE_DIR: '/tmp/chosen-by-hand' });
  assert.strictEqual(got.stateDir, '/tmp/chosen-by-hand');
  assert.strictEqual(fs.existsSync(inst(s, 2)), false, 'no slot was probed');
});
