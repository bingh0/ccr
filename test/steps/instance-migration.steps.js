// @ts-check
'use strict';
// Step definitions for features/instance-migration.feature.
//
// Same far-side seam as the lifecycle steps: the REAL CLI runs in a sandbox
// (fake HOME, stub `bash` session), so migration executes exactly as a user's
// launch would run it — including the refusals, which must stop the launch
// itself, not merely return a value.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CCR_JS = path.join(__dirname, '..', '..', 'bin', 'ccr.js');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineInstanceMigrationSteps(reg) {
  const home = (/** @type {Record<string, any>} */ w) => {
    if (!w.home) {
      w.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-mig-'));
      w.home = path.join(w.root, 'home');
      const bin = path.join(w.root, 'bin');
      fs.mkdirSync(w.home, { recursive: true });
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'bash'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      w.bin = bin;
      w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));
    }
    return w.home;
  };

  const ccr = (/** @type {Record<string, any>} */ w) => path.join(home(w), '.ccr');

  const put = (/** @type {string} */ dir, /** @type {string} */ name, /** @type {string} */ body = '') => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  /** Every path under the container, relative, sorted — the "nothing moved" witness. */
  const snapshot = (/** @type {Record<string, any>} */ w) => {
    /** @type {string[]} */
    const acc = [];
    const walk = (/** @type {string} */ dir, /** @type {string} */ rel) => {
      let names; try { names = fs.readdirSync(dir); } catch { return; }
      for (const n of names) {
        const p = path.join(dir, n);
        const r = rel ? `${rel}/${n}` : n;
        acc.push(r);
        try { if (fs.lstatSync(p).isDirectory()) walk(p, r); } catch { /* ignore */ }
      }
    };
    walk(ccr(w), '');
    return acc.sort();
  };

  const runCcr = (/** @type {Record<string, any>} */ w, /** @type {string[]} */ args = []) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, HOME: home(w), USERPROFILE: home(w), PATH: `${w.bin}${path.delimiter}${process.env.PATH}` };
    delete env.CCR_SESSION;
    delete env.CCR_STATE_DIR;
    delete env.TERM_PROGRAM;
    if (process.platform === 'win32') {
      // Route the spawned CLI down the VS Code branch: migration, pruning and
      // the refusals all run BEFORE launch routing, and this branch cannot
      // open a real Windows Terminal on a CI runner (it stops at the missing
      // `claude` binary instead).
      env.TERM_PROGRAM = 'vscode';
      env.CCR_VSCODE = '1';
    }
    const r = spawnSync(process.execPath, [CCR_JS, ...args], { env, encoding: 'utf8', input: '' });
    w.got = { code: r.status, err: String(r.stderr || '') };
  };

  // --- Givens: worlds the 0.3 layout actually left behind ---

  reg.define(/^a ccr home in the 0\.3 layout$/, (w) => {
    put(ccr(w), 'last-status.json', '{}');
    put(ccr(w), 'burnlog-base01.jsonl', '{"t":1}\n');
  });

  reg.define(/^a ccr home in the 0\.3 layout holding profile dir "([^"]+)" with burnlog "([^"]+)" and a captured status$/, (w, name, log) => {
    const dir = path.join(ccr(w), name);
    put(dir, log, '{"t":1}\n');
    put(dir, 'last-status.json', '{}');
    put(dir, 'exited', '');
  });

  reg.define(/^a ccr home in the 0\.3 layout holding a loose captured status and burnlog "([^"]+)"$/, (w, log) => {
    put(ccr(w), 'last-status.json', '{}');
    put(ccr(w), 'exited', '');
    put(ccr(w), log, '{"t":1}\n');
  });

  reg.define(/^a live 0\.3 instance is running$/, (w) => {
    // The freshest signal 0.3 could leave: a beating sidecar heartbeat, no
    // exited sentinel — in profile dir "cq", so the refusal has a name.
    const dir = path.join(ccr(w), 'cq');
    put(dir, 'sidecar-alive', `4242:${Date.now()}`);
    put(dir, 'burnlog-live01.jsonl', '{"t":1}\n');
  });

  reg.define(/^a migrated ccr home whose "\.layout" marker is present$/, (w) => {
    put(ccr(w), '.layout', '1\n');
  });

  reg.define(/^burnlog "([^"]+)" is at the container's top level$/, (w, log) => {
    put(ccr(w), log, '{"t":1}\n');
  });

  reg.define(/^a migration that was interrupted before writing the "\.layout" marker$/, (w) => {
    // Half the harvest already happened; the marker did not.
    put(ccr(w), 'burnlog-done01.jsonl', '{"t":1}\n');
  });

  reg.define(/^profile dir "([^"]+)" still holds burnlog "([^"]+)"$/, (w, name, log) => {
    put(path.join(ccr(w), name), log, '{"t":1}\n');
  });

  reg.define(/^a ccr home in the 0\.3 layout with an unrecognized entry named "([^"]+)"$/, (w, name) => {
    put(path.join(ccr(w), 'cq'), 'burnlog-xyz01.jsonl', '{"t":1}\n');
    fs.mkdirSync(path.join(ccr(w), name), { recursive: true });
    w.before = snapshot(w);
  });

  reg.define(/^a ccr home in the 0\.3 layout where a 0\.4 statusline already wrote session file "([^"]+)"$/, (w, name) => {
    put(ccr(w), 'last-status.json', '{}');
    put(ccr(w), 'exited', '');
    put(ccr(w), 'burnlog-mixed01.jsonl', '{"t":1}\n');
    put(ccr(w), name, '{"session_id":"abc123"}\n');
  });

  reg.define(/^a migrated ccr home where a 0\.3 ccr later wrote a loose captured status and heartbeat$/, (w) => {
    put(ccr(w), '.layout', '1\n');
    put(ccr(w), 'burnlog-day01.jsonl', '{"t":1}\n');
    put(ccr(w), 'last-status.json', '{}');
    const beat = put(ccr(w), 'sidecar-alive', '4242:1');
    const old = (Date.now() - 120_000) / 1000;
    fs.utimesSync(beat, old, old);
  });

  reg.define(/^that 0\.3 session has ended$/, (w) => {
    put(ccr(w), 'exited', '');
  });

  // --- Whens ---

  reg.define(/^a bare ccr launches$/, (w) => {
    if (!w.before) w.before = snapshot(w);
    runCcr(w);
  });

  reg.define(/^ccr statusline runs$/, (w) => {
    w.before = snapshot(w);
    runCcr(w, ['statusline']);
  });

  // --- Thens ---

  reg.define(/^"([^"]+)" is at the container's top level$/, (w, log) => {
    assert.ok(fs.existsSync(path.join(ccr(w), log)), `${log} should have been harvested to the container root`);
  });

  reg.define(/^"([^"]+)" is still at the container's top level$/, (w, log) => {
    assert.ok(fs.existsSync(path.join(ccr(w), log)));
  });

  reg.define(/^the profile dir "([^"]+)" is gone$/, (w, name) => {
    assert.strictEqual(fs.existsSync(path.join(ccr(w), name)), false);
  });

  reg.define(/^the "\.layout" marker is present$/, (w) => {
    assert.ok(fs.existsSync(path.join(ccr(w), '.layout')));
  });

  reg.define(/^every directory the migration created is owner-only$/, (w) => {
    // POSIX only: NTFS has no mode bits — stat reads back a synthetic 0666,
    // so on Windows this would assert a filesystem fiction either way. The
    // scenario's other Thens (what was moved, what was refused) hold there.
    if (process.platform === 'win32') return;
    for (const d of [ccr(w), path.join(ccr(w), 'instances')]) {
      if (!fs.existsSync(d)) continue;
      assert.strictEqual(fs.statSync(d).mode & 0o777, 0o700, d);
    }
  });

  reg.define(/^the loose captured status is gone$/, (w) => {
    assert.strictEqual(fs.existsSync(path.join(ccr(w), 'last-status.json')), false);
  });

  reg.define(/^the loose captured status and heartbeat are gone$/, (w) => {
    assert.strictEqual(fs.existsSync(path.join(ccr(w), 'last-status.json')), false, 'captured status swept');
    assert.strictEqual(fs.existsSync(path.join(ccr(w), 'sidecar-alive')), false, 'heartbeat swept');
  });

  reg.define(/^no container entry has moved$/, (w) => {
    // The launch itself may create instances/…; everything that predated it
    // must be exactly where it was.
    const after = snapshot(w).filter((p) => p !== 'instances' && !p.startsWith('instances/'));
    const before = w.before.filter((/** @type {string} */ p) => p !== 'instances' && !p.startsWith('instances/'));
    assert.deepStrictEqual(after, before);
  });

  reg.define(/^no file or directory has moved$/, (w) => {
    assert.deepStrictEqual(snapshot(w), w.before, 'the stop must change nothing');
  });

  reg.define(/^the launch fails$/, (w) => {
    assert.notStrictEqual(w.got.code, 0);
  });

  reg.define(/^the launch fails naming "([^"]+)"$/, (w, name) => {
    assert.notStrictEqual(w.got.code, 0);
    assert.ok(w.got.err.includes(`'${name}'`), w.got.err);
  });

  reg.define(/^the error names the live instance to close first$/, (w) => {
    assert.match(w.got.err, /close 'cq' first/);
    // And the refusal must have PRECEDED the harvest: a migration that moves
    // first and refuses after has already disturbed a running session.
    assert.ok(fs.existsSync(path.join(ccr(w), 'cq', 'burnlog-live01.jsonl')), 'the live instance\'s history is untouched');
    assert.strictEqual(fs.existsSync(path.join(ccr(w), 'burnlog-live01.jsonl')), false, 'nothing was harvested');
  });

  reg.define(/^that 0\.3 session's burnlog is still present$/, (w) => {
    assert.ok(fs.existsSync(path.join(ccr(w), 'burnlog-day01.jsonl')), 'the day\'s history merges for free');
  });
};
