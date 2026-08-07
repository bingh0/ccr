// @ts-check
'use strict';
// Step definitions for features/instance-naming.feature.
//
// The REAL CLI runs in a sandbox with real repository fixtures and controlled
// launch directories — the mapping, the suffix generator and the refusals all
// execute exactly as a user's launch would run them. The stub session echoes
// the name file the launcher wrote into the instance dir, because the dir is
// deleted the moment the session ends (ephemerality) — the session itself is
// the only witness.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const slots = require('../../src/instance-slot');

const CCR_JS = path.join(__dirname, '..', '..', 'bin', 'ccr.js');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineInstanceNamingSteps(reg) {
  const home = (/** @type {Record<string, any>} */ w) => {
    if (!w.home) {
      w.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-name-'));
      w.home = path.join(w.root, 'home');
      const bin = path.join(w.root, 'bin');
      fs.mkdirSync(w.home, { recursive: true });
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'bash'),
        '#!/bin/sh\n'
        + 'echo "session=$CCR_SESSION"\n'
        + 'echo "state=$CCR_STATE_DIR"\n'
        + 'echo "profile=$2"\n'
        + 'if [ -f "$CCR_STATE_DIR/name" ]; then echo "name=$(cat "$CCR_STATE_DIR/name")"; fi\n',
        { mode: 0o755 });
      w.bin = bin;
      // A migrated home, as every 0.4 launch guarantees.
      fs.mkdirSync(path.join(w.home, '.ccr'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(w.home, '.ccr', '.layout'), '1\n');
      w.nextSlot = 1;
      w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));
    }
    return w.home;
  };

  const instDir = (/** @type {Record<string, any>} */ w, /** @type {number} */ n) =>
    path.join(home(w), '.ccr', 'instances', String(n));

  /** A live, named instance on the next free slot (this test process owns it). */
  const liveInstance = (/** @type {Record<string, any>} */ w, /** @type {string} */ name, /** @type {number} */ slot = 0) => {
    home(w); // the sandbox (and its slot counter) must exist first
    const n = slot || w.nextSlot++;
    if (slot) w.nextSlot = Math.max(w.nextSlot, slot + 1);
    const dir = instDir(w, n);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, slots.OWNER_FILE), `${process.pid}:${Date.now()}`);
    fs.writeFileSync(path.join(dir, 'name'), name + '\n');
    return dir;
  };

  /** A directory to launch from, by basename — weird characters and all. */
  const launchDirNamed = (/** @type {Record<string, any>} */ w, /** @type {string} */ basename) => {
    const dir = path.join(home(w), 'trees', String(w.treeSeq = (w.treeSeq || 0) + 1), basename);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const makeRepo = (/** @type {string} */ dir) => {
    const git = path.join(dir, '.git', 'refs', 'heads');
    fs.mkdirSync(git, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(git, 'main'), '9749285e1c0a4b2d3f5e6a7b8c9d0e1f2a3b4c5d\n');
    return dir;
  };

  const runCcr = (/** @type {Record<string, any>} */ w, /** @type {string[]} */ args = []) => {
    if (process.platform === 'win32') {
      // The tmux launcher does not exist here; the same product functions run
      // in-process, mirroring cmdLaunch's sequence (validation → collision →
      // allocate → prepareInstance). The spawn/env delivery is pinned
      // cross-platform by launch-win's own dep-injected tests. Never spawn
      // the real launcher on a Windows runner: with wt.exe present it would
      // open real terminal windows.
      const naming = require('../../src/instance-name');
      const nameIx = args.indexOf('--name');
      const explicit = nameIx >= 0 ? args[nameIx + 1] : null;
      const profile = args.find((a, i) => !a.startsWith('-') && (nameIx < 0 || i !== nameIx + 1));
      if (explicit != null && !naming.NAME_RE.test(explicit)) {
        w.got = { code: 1, err: `ccr: invalid instance name '${explicit}' (allowed: letters, digits, . _ -)`, session: '', stateDir: '', profile: '', name: '' };
        return;
      }
      const live = naming.liveNames({ home: home(w) });
      if (explicit != null && live.has(explicit)) {
        w.got = { code: 1, err: `ccr: instance name '${explicit}' is already live — pick another`, session: '', stateDir: '', profile: '', name: '' };
        return;
      }
      const slot = slots.allocateSlot({ env: {}, home: home(w) });
      if (!slot || 'exhausted' in slot) {
        w.got = { code: 1, err: 'no slot', session: '', stateDir: '', profile: '', name: '' };
        return;
      }
      const inst = naming.prepareInstance(slot, { profile, name: explicit, cwd: w.cwd || home(w), home: home(w) });
      w.got = { code: 0, err: '', session: slot.session, stateDir: slot.stateDir, profile: profile || '', name: inst.name };
      slots.retireInstance(slot.stateDir, { home: home(w), sidecarAlive: () => false });
      return;
    }
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, HOME: home(w), USERPROFILE: home(w), PATH: `${w.bin}${path.delimiter}${process.env.PATH}` };
    delete env.CCR_SESSION;
    delete env.CCR_STATE_DIR;
    delete env.TERM_PROGRAM;
    const r = spawnSync(process.execPath, [CCR_JS, ...args], { env, encoding: 'utf8', cwd: w.cwd || home(w) });
    const out = String(r.stdout || '');
    const field = (/** @type {RegExp} */ re) => { const m = re.exec(out); return m ? m[1].trim() : ''; };
    w.got = {
      code: r.status,
      err: String(r.stderr || ''),
      session: field(/session=(.*)/),
      stateDir: field(/state=(.*)/),
      profile: field(/profile=(.*)/),
      name: field(/name=(.*)/),
    };
  };

  // --- Givens ---

  reg.define(/^the launch directory is a git repository checked out at "~\/code\/gitrepo"$/, (w) => {
    w.cwd = makeRepo(path.join(home(w), 'code', 'gitrepo'));
    fs.mkdirSync(w.cwd, { recursive: true });
  });

  reg.define(/^the launch directory "~\/notes" is not inside a git repository$/, (w) => {
    w.cwd = path.join(home(w), 'notes');
    fs.mkdirSync(w.cwd, { recursive: true });
  });

  reg.define(/^the launch directory's basename is "([^"]+)"$/, (w, basename) => {
    w.cwd = launchDirNamed(w, basename);
  });

  reg.define(/^the launch takes slot 2$/, (w) => {
    liveInstance(w, 'occupant', 1);
  });

  reg.define(/^a live instance named "([^"]+)"$/, (w, name) => {
    liveInstance(w, name);
  });

  reg.define(/^a live instance named "([^"]+)" on slot (\d+)$/, (w, name, n) => {
    liveInstance(w, name, Number(n));
  });

  reg.define(/^live instances named "gitrepo" and "gitrepo2" through "gitrepo9"$/, (w) => {
    liveInstance(w, 'gitrepo');
    for (let k = 2; k <= 9; k++) liveInstance(w, `gitrepo${k}`);
  });

  reg.define(/^instance "gitrepo" has exited while instance "gitrepo2" lives$/, (w) => {
    // Ephemerality already erased "gitrepo": its dir is gone, so only
    // "gitrepo2" exists to reserve anything.
    liveInstance(w, 'gitrepo2');
  });

  reg.define(/^the launch directory is a git repository named "gitrepo"$/, (w) => {
    w.cwd = makeRepo(launchDirNamed(w, 'gitrepo'));
  });

  // --- Whens ---

  reg.define(/^a bare ccr launches$/, (w) => { runCcr(w); });

  reg.define(/^a bare ccr launches from another directory also named "([^"]+)"$/, (w, basename) => {
    w.cwd = launchDirNamed(w, basename);
    runCcr(w);
  });

  reg.define(/^a bare ccr launches from a directory named "([^"]+)"$/, (w, basename) => {
    w.cwd = launchDirNamed(w, basename);
    runCcr(w);
  });

  reg.define(/^ccr launches with --name "([^"]+)"$/, (w, name) => {
    runCcr(w, ['--name', name]);
  });

  reg.define(/^ccr launches with positional "cc1" and --name "([^"]+)"$/, (w, name) => {
    runCcr(w, ['cc1', '--name', name]);
  });

  // --- Thens ---

  reg.define(/^the instance's name is "([^"]+)"$/, (w, name) => {
    assert.strictEqual(w.got.name, name);
  });

  reg.define(/^the new instance's name is "([^"]+)"$/, (w, name) => {
    assert.strictEqual(w.got.name, name);
  });

  reg.define(/^the new instance takes slot (\d+)$/, (w, n) => {
    assert.strictEqual(w.got.stateDir, instDir(w, Number(n)));
  });

  reg.define(/^the launch fails$/, (w) => {
    assert.notStrictEqual(w.got.code, 0);
    assert.strictEqual(w.got.session, '', 'no session was ever spawned');
  });

  reg.define(/^the error reads "(.+)"$/, (w, msg) => {
    assert.ok(w.got.err.includes(msg), `expected ${JSON.stringify(msg)} in ${JSON.stringify(w.got.err)}`);
  });

  reg.define(/^the error says "([^"]+)" is already live$/, (w, name) => {
    assert.match(w.got.err, new RegExp(`'${name}' is already live`));
  });

  reg.define(/^the launch targets CCS profile "cc1"$/, (w) => {
    assert.strictEqual(w.got.profile, 'cc1', 'the positional reached the launcher as a profile');
  });
};
