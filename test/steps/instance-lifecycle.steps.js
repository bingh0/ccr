// @ts-check
'use strict';
// Step definitions for features/instance-lifecycle.feature.
//
// Launch scenarios run the REAL CLI in a sandbox (a fake HOME, a `bash` on
// PATH that reports the env it was handed and the state dir it saw while the
// "session" ran) — the same far-side seam test/cli-slot-delivery.test.js
// pinned after an adversarial review found the env hand-off uncovered.
// Allocation, sweeping and retirement therefore execute for real against the
// sandbox home; nothing is stubbed but the session itself.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const slots = require('../../src/instance-slot');
const { HEARTBEAT_FILE: HEARTBEAT } = require('../../src/sidecar');

const CCR_JS = path.join(__dirname, '..', '..', 'bin', 'ccr.js');
const LAUNCH_SH = path.join(__dirname, '..', '..', 'scripts', 'launch.sh');

// A pid that is certainly not running.
const DEAD_PID = 0x7ffffff0;

// Shared reset instants, so two snapshots read as the same account.
const T5 = Math.floor(Date.now() / 1000) + 10_000;
const TW = Math.floor(Date.now() / 1000) + 500_000;

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineInstanceLifecycleSteps(reg) {
  const home = (/** @type {Record<string, any>} */ w) => {
    if (!w.home) {
      w.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-life-'));
      w.home = path.join(w.root, 'home');
      const bin = path.join(w.root, 'bin');
      fs.mkdirSync(w.home, { recursive: true });
      fs.mkdirSync(bin);
      // The stub session: reports its namespace AND what the state dir looked
      // like while the session was alive — the only moment an ephemeral
      // instance's dir can be observed from outside.
      fs.writeFileSync(path.join(bin, 'bash'),
        '#!/bin/sh\n'
        + 'echo "session=$CCR_SESSION"\n'
        + 'echo "state=$CCR_STATE_DIR"\n'
        + 'if [ -d "$CCR_STATE_DIR" ]; then echo "dirmode=$(stat -c %a "$CCR_STATE_DIR" 2>/dev/null || stat -f %A "$CCR_STATE_DIR" 2>/dev/null)"; fi\n',
        { mode: 0o755 });
      w.bin = bin;
      w.env = {};
      // These worlds are MIGRATED homes: the container carries its marker, as
      // every 0.4 launch guarantees before instances/ can exist.
      fs.mkdirSync(path.join(w.home, '.ccr'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(w.home, '.ccr', '.layout'), '1\n');
      w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));
    }
    return w.home;
  };

  const instDir = (/** @type {Record<string, any>} */ w, /** @type {number} */ n) =>
    path.join(home(w), '.ccr', 'instances', String(n));

  const put = (/** @type {string} */ dir, /** @type {string} */ name, /** @type {string} */ body = '') => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  /** This test process plays the live session's launcher. */
  const makeLive = (/** @type {string} */ dir) => put(dir, slots.OWNER_FILE, `${process.pid}:${Date.now()}`);

  const status = (/** @type {{ctxPct?: number, cost?: number, five?: number}} */ o) => JSON.stringify({
    model: { display_name: 'Opus 4.8' },
    context_window: { context_window_size: 200000, total_input_tokens: Math.round(((o.ctxPct ?? 10) / 100) * 200000) },
    rate_limits: {
      five_hour: { used_percentage: o.five ?? 10, resets_at: T5 },
      seven_day: { used_percentage: 18, resets_at: TW },
    },
    cost: { total_cost_usd: o.cost ?? 0.5 },
  });

  /**
   * Run a launch against the sandbox and capture what the session observed.
   *
   * POSIX: the REAL CLI, end to end — the stub `bash` session reports the env
   * it was handed and the state dir it saw while alive.
   *
   * win32: the tmux launcher does not exist; the same product functions run
   * in-process — allocateSlot (which sweeps), prepareInstance, retireInstance
   * — mirroring cmdLaunch's sequence. The env/spawn hand-off itself is pinned
   * cross-platform by test/launch-win-run.test.js with injected deps.
   */
  const runCcr = (/** @type {Record<string, any>} */ w, /** @type {string[]} */ args = []) => {
    if (process.platform === 'win32') {
      const profile = args.find((a) => !a.startsWith('-'));
      const slot = slots.allocateSlot({ env: w.env, home: home(w) });
      if (slot && 'exhausted' in slot) {
        w.got = { code: 1, err: `ccr: every slot is in use (${slots.MAX_SLOTS} live instances) — close one first\n`, session: '', stateDir: '', dirMode: '' };
        return;
      }
      const naming = require('../../src/instance-name');
      if (slot) naming.prepareInstance(slot, { profile, cwd: home(w), home: home(w) });
      const dirMode = slot && fs.existsSync(slot.stateDir) ? '700' : '';
      w.got = {
        code: 0, err: '',
        session: slot ? slot.session : '',
        stateDir: slot ? slot.stateDir : '',
        dirMode, // POSIX asserts the literal mode; NTFS has no comparable bit
      };
      if (slot) slots.retireInstance(slot.stateDir, { home: home(w), sidecarAlive: () => false });
      return;
    }
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, HOME: home(w), USERPROFILE: home(w), PATH: `${w.bin}${path.delimiter}${process.env.PATH}` };
    delete env.CCR_SESSION;
    delete env.CCR_STATE_DIR;
    delete env.TERM_PROGRAM;
    Object.assign(env, w.env);
    const r = spawnSync(process.execPath, [CCR_JS, ...args], { env, encoding: 'utf8' });
    const out = String(r.stdout || '');
    const field = (/** @type {RegExp} */ re) => { const m = re.exec(out); return m ? m[1].trim() : ''; };
    w.got = {
      code: r.status,
      err: String(r.stderr || ''),
      session: field(/session=(.*)/),
      stateDir: field(/state=(.*)/),
      dirMode: field(/dirmode=(.*)/),
    };
  };

  // --- Givens ---

  reg.define(/^no ccr instance is running$/, (w) => { home(w); });

  reg.define(/^a live instance named "([^"]+)" on slot (\d+)$/, (w, name, n) => {
    // The name is bookkeeping until the naming feature binds; the instance is real.
    const dir = instDir(w, Number(n));
    makeLive(dir);
    put(dir, 'last-status.json', status({}));
    put(path.join(home(w), '.ccr'), `burnlog-sess-${name}.jsonl`, '{"t":1}\n');
    w.instance = { name, dir, slot: Number(n) };
  });

  reg.define(/^slot (\d+) holds an instance whose recorded process no longer exists$/, (w, n) => {
    const dir = instDir(w, Number(n));
    put(dir, slots.OWNER_FILE, `${DEAD_PID}:1`);
    put(dir, 'last-status.json', status({}));
    // The sweep declines to touch a freshly written dir (the launcher-less
    // startup window); this instance died a while ago.
    const old = (Date.now() - 120_000) / 1000;
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
    fs.utimesSync(dir, old, old);
  });

  reg.define(/^a live instance on slot (\d+) whose heartbeat is 20 minutes stale$/, (w, n) => {
    const dir = instDir(w, Number(n));
    makeLive(dir);
    const beat = put(dir, HEARTBEAT, `4242:${Date.now() - 20 * 60_000}`);
    const old = (Date.now() - 20 * 60_000) / 1000;
    fs.utimesSync(beat, old, old);
    fs.utimesSync(dir, old, old);
    w.marker = put(dir, 'last-status.json', status({}));
    fs.utimesSync(w.marker, old, old);
    fs.utimesSync(dir, old, old);
  });

  reg.define(/^its recorded process still exists$/, () => { /* the owner IS this test process */ });

  reg.define(/^(\d+) live instances hold slots (\d+) through (\d+)$/, (w, count, from, to) => {
    assert.strictEqual(Number(to) - Number(from) + 1, Number(count), 'the Given must be internally consistent');
    for (let n = Number(from); n <= Number(to); n++) makeLive(instDir(w, n));
  });

  reg.define(/^instance "a" on slot 1 has context at 40% and cost \$1\.00$/, (w) => {
    w.aDir = instDir(w, 1);
    makeLive(w.aDir);
    put(w.aDir, 'last-status.json', status({ ctxPct: 40, cost: 1.0, five: 10 }));
  });

  reg.define(/^instance "b" on slot 2 on the same account has burned the 5h window to 30%$/, (w) => {
    const dir = instDir(w, 2);
    makeLive(dir);
    put(dir, 'last-status.json', status({ ctxPct: 90, cost: 9.0, five: 30 }));
  });

  reg.define(/^a user settings file with known contents$/, (w) => {
    w.settingsFile = put(path.join(home(w), '.claude'), 'settings.json', '{"user":"untouchable"}');
  });

  reg.define(/^a live instance on slot (\d+) has captured a status$/, (w, n) => {
    const dir = instDir(w, Number(n));
    makeLive(dir);
    put(dir, 'last-status.json', status({}));
    w.captureDir = dir;
  });

  reg.define(/^a live instance of CCS profile "cq" holds slot 1$/, (w) => {
    makeLive(instDir(w, 1));
  });

  // --- Whens ---

  reg.define(/^a bare ccr launches$/, (w) => { runCcr(w); });

  reg.define(/^ccr launches with CCS profile "cq"$/, (w) => { runCcr(w, ['cq']); });

  reg.define(/^its session ends$/, (w) => {
    slots.retireInstance(w.instance.dir, { home: home(w), sidecarAlive: () => false });
  });

  reg.define(/^instance "a" redraws its sidebar$/, (w) => {
    const { composeFrame } = require('../../src/sidecar');
    w.frame = composeFrame(w.aDir, { home: home(w), cols: 80 });
  });

  reg.define(/^ccr doctor runs$/, (w) => {
    let text = '';
    require('../../src/doctor').run({ homedir: home(w), write: (/** @type {string} */ s) => { text += s; } });
    w.doctorOut = text;
  });

  // --- Thens ---

  reg.define(/^the instance's state dir is "instances\/1" under the ccr home$/, (w) => {
    assert.strictEqual(w.got.stateDir, instDir(w, 1));
  });

  reg.define(/^that directory is owner-only$/, (w) => {
    assert.strictEqual(w.got.dirMode, '700', 'as observed while the session was alive');
  });

  reg.define(/^the slot (\d+) instance directory is gone$/, (w, n) => {
    assert.strictEqual(fs.existsSync(instDir(w, Number(n))), false);
  });

  reg.define(/^the account's burn history is still present$/, (w) => {
    assert.ok(fs.existsSync(path.join(home(w), '.ccr', `burnlog-sess-${w.instance.name}.jsonl`)));
  });

  reg.define(/^the slot (\d+) instance directory is untouched$/, (w, n) => {
    const dir = instDir(w, Number(n));
    assert.ok(fs.existsSync(dir), 'the live instance\'s dir must survive the other launch');
    assert.ok(fs.existsSync(w.marker), 'and its contents with it');
  });

  reg.define(/^it takes slot (\d+)$/, (w, n) => {
    assert.strictEqual(w.got.stateDir, instDir(w, Number(n)));
  });

  reg.define(/^the launch fails$/, (w) => {
    assert.notStrictEqual(w.got.code, 0);
    assert.strictEqual(w.got.session, '', 'no session was ever spawned');
  });

  reg.define(/^the error says every slot is in use$/, (w) => {
    assert.match(w.got.err, /every slot is in use/);
  });

  reg.define(/^the slot 1 instance is still live$/, (w) => {
    assert.strictEqual(slots.defaultInspect(instDir(w, 1)).live, true);
  });

  reg.define(/^a's sidebar shows context at 40% and cost \$1\.00$/, (w) => {
    assert.match(w.frame, /40%/, 'a\'s own context, not b\'s');
    assert.match(w.frame, /\$1\.00/, 'a\'s own cost, not b\'s');
    assert.doesNotMatch(w.frame, /\$9\.00/, 'b\'s cost must not leak into a\'s panel');
  });

  reg.define(/^a's 5h meter reads 30%$/, (w) => {
    assert.match(w.frame, /5h[^\n]*30%/, 'reconciliation raised a\'s meter to b\'s fresher value');
  });

  reg.define(/^the settings file's contents are unchanged$/, (w) => {
    assert.strictEqual(fs.readFileSync(w.settingsFile, 'utf8'), '{"user":"untouchable"}');
  });

  reg.define(/^the launched session is still handed the ccr status line$/, () => {
    // The launcher injects the status line per-launch via --settings: an inline
    // JSON payload naming ccr's statusline command, never an edit to any file.
    const sh = fs.readFileSync(LAUNCH_SH, 'utf8');
    assert.match(sh, /SETTINGS='\{"statusLine":\{"type":"command","command":"/);
    assert.match(sh, /--settings '\$SETTINGS'/);
  });

  reg.define(/^doctor reports a captured status from slot (\d+)'s instance$/, (w, _n) => {
    assert.match(w.doctorOut, /status captured/, 'the positive case, not the both-ways match');
    assert.ok(w.doctorOut.includes(w.captureDir), 'and it names the instance dir it found');
  });
};
