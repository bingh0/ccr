// @ts-check
'use strict';
// Step definitions for features/instance-resolution.feature.
//
// Every scenario runs the REAL CLI (`ccr economy`, or the refusing command)
// against a sandbox of live instances — each an actual dir with an owner pid,
// a name file, a launch-cwd record and a captured status, so the chain reads
// exactly what a user's disk would hold. "Resolves to X" is observed the way
// a user observes it: the panel is headed by the name it resolved to.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const slots = require('../../src/instance-slot');

const CCR_JS = path.join(__dirname, '..', '..', 'bin', 'ccr.js');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineInstanceResolutionSteps(reg) {
  const home = (/** @type {Record<string, any>} */ w) => {
    if (!w.home) {
      // realpath: macOS tmpdir is a symlink (/var -> /private/var), and the
      // child CLI's process.cwd() is always physical — an un-resolved sandbox
      // path here would fail cwd containment for a reason that isn't the chain's.
      w.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-res-')));
      w.home = path.join(w.root, 'home');
      fs.mkdirSync(path.join(w.home, '.ccr', 'instances'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(w.home, '.ccr', '.layout'), '1\n');
      w.nextSlot = 1;
      w.dirs = {};
      w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));
    }
    return w.home;
  };

  /** Map the feature's "~/..." paths into the sandbox home. */
  const at = (/** @type {Record<string, any>} */ w, /** @type {string} */ p) =>
    path.join(home(w), p.replace(/^~\//, ''));

  const T5 = Math.floor(Date.now() / 1000) + 14_400;

  /** A live instance: owner pid, name, launch dir, captured status. */
  const liveInstance = (/** @type {Record<string, any>} */ w, /** @type {string} */ name, /** @type {string} */ launchCwd = '') => {
    home(w);
    const n = w.nextSlot++;
    const dir = path.join(home(w), '.ccr', 'instances', String(n));
    fs.mkdirSync(dir, { recursive: true });
    const lc = launchCwd || path.join(home(w), 'trees', name);
    fs.mkdirSync(lc, { recursive: true });
    fs.writeFileSync(path.join(dir, slots.OWNER_FILE), `${process.pid}:${Date.now()}`);
    fs.writeFileSync(path.join(dir, 'name'), name + '\n');
    fs.writeFileSync(path.join(dir, 'launch-cwd'), lc + '\n');
    fs.writeFileSync(path.join(dir, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 4.8' },
      rate_limits: { five_hour: { used_percentage: 20, resets_at: T5 } },
      cost: { total_cost_usd: 1 },
    }));
    w.dirs[name] = { stateDir: dir, launchCwd: lc };
    return dir;
  };

  const runCcr = (/** @type {Record<string, any>} */ w, /** @type {string[]} */ args) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, HOME: home(w), USERPROFILE: home(w) };
    delete env.CCR_STATE_DIR;
    delete env.CCR_SESSION;
    Object.assign(env, w.env || {});
    const r = spawnSync(process.execPath, [CCR_JS, ...args], { env, encoding: 'utf8', cwd: w.cwd || home(w), input: '' });
    w.got = { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
  };

  // --- Givens ---

  reg.define(/^instance "([^"]+)" is live and was launched in the current directory$/, (w, name) => {
    w.cwd = path.join(home(w), 'here');
    fs.mkdirSync(w.cwd, { recursive: true });
    liveInstance(w, String(name), w.cwd);
  });

  reg.define(/^CCR_STATE_DIR names instance "b"'s state dir$/, (w) => {
    const dir = liveInstance(w, 'b');
    (w.env ||= {}).CCR_STATE_DIR = dir;
  });

  reg.define(/^instance "([^"]+)" was launched in "([^"]+)"$/, (w, name, where) => {
    liveInstance(w, String(name), at(w, String(where)));
  });

  reg.define(/^the current directory is "([^"]+)"$/, (w, where) => {
    w.cwd = at(w, String(where));
    fs.mkdirSync(w.cwd, { recursive: true });
  });

  reg.define(/^only instance "a" is live$/, (w) => {
    liveInstance(w, 'a');
  });

  reg.define(/^the current directory is inside no instance's launch directory$/, (w) => {
    w.cwd = path.join(home(w), 'somewhere-unrelated');
    fs.mkdirSync(w.cwd, { recursive: true });
  });

  reg.define(/^instances "([^"]+)" and "([^"]+)" are live$/, (w, a, b) => {
    liveInstance(w, String(a));
    liveInstance(w, String(b));
  });

  reg.define(/^instance "([^"]+)" is live$/, (w, name) => {
    liveInstance(w, String(name));
  });

  reg.define(/^the current directory is inside "main-work"'s launch directory$/, (w) => {
    w.cwd = path.join(w.dirs['main-work'].launchCwd, 'src');
    fs.mkdirSync(w.cwd, { recursive: true });
  });

  reg.define(/^CCR_STATE_DIR names the ccr home itself$/, (w) => {
    (w.env ||= {}).CCR_STATE_DIR = path.join(home(w), '.ccr');
  });

  // --- Whens ---

  reg.define(/^ccr economy resolves its instance$/, (w) => { runCcr(w, ['economy']); });

  reg.define(/^ccr economy runs with -i "([^"]+)"$/, (w, name) => { runCcr(w, ['economy', '-i', String(name)]); });

  reg.define(/^ccr economy runs$/, (w) => { runCcr(w, ['economy']); });

  reg.define(/^ccr (resume|doctor|statusline|launch) runs with -i "([^"]+)"$/, (w, cmd, name) => {
    runCcr(w, [String(cmd), '-i', String(name)]);
  });

  // --- Thens ---

  reg.define(/^it resolves to instance "([^"]+)"$/, (w, name) => {
    assert.strictEqual(w.got.out.split('\n')[0], name, 'the panel is headed by what was resolved');
  });

  reg.define(/^the panel is headed "([^"]+)"$/, (w, name) => {
    assert.strictEqual(w.got.out.split('\n')[0], name);
  });

  reg.define(/^the command fails$/, (w) => {
    assert.notStrictEqual(w.got.code, 0);
  });

  reg.define(/^the output lists "([^"]+)" and "([^"]+)"$/, (w, a, b) => {
    assert.ok(w.got.err.includes(a), `expected ${a} in ${JSON.stringify(w.got.err)}`);
    assert.ok(w.got.err.includes(b), `expected ${b} in ${JSON.stringify(w.got.err)}`);
  });

  reg.define(/^the output offers -i as the way to choose$/, (w) => {
    assert.match(w.got.err, /-i <name>/, 'the refusal tells the user the next keystroke');
  });

  reg.define(/^the error names "([^"]+)" as not live$/, (w, name) => {
    assert.ok(w.got.err.includes(`no live instance named '${name}'`), w.got.err);
  });

  reg.define(/^the error says -i applies to economy, sidecar and cycle-view$/, (w) => {
    assert.match(w.got.err, /-i applies to economy, sidecar, cycle-view/);
  });

  reg.define(/^the error says the ccr home is a container, not an instance$/, (w) => {
    assert.match(w.got.err, /container, not an instance/);
  });
};
