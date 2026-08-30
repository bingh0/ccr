// @ts-check
'use strict';
// Step definitions for features/sidecar-hotkeys.feature.
//
// The interesting behaviour here is ORDERING and CLEANUP — raw mode handed back
// on every exit path, the panel killed when the parent is interrupted, the
// child's exit code carried out — and none of it is observable with a real tty
// and a real child process in the way. So the terminal and the spawn are
// injected and recorded, and everything else is the real thing: the real key
// table, the real counting, the real spawn arguments.
//
// The one step that must NOT be injected is the `--view` refusal: a flag parser
// is only worth what the real process does with it, so that scenario runs
// `bin/ccr.js` as an actual subprocess and reads its exit code — the far side of
// the boundary, not our own opinion of it.

const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const keys = require('../../src/sidecar-keys');
const sidecar = require('../../src/sidecar');

const CCR_JS = path.join(__dirname, '..', '..', 'bin', 'ccr.js');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineSidecarHotkeysSteps(reg) {
  /**
   * A terminal that records what was asked of it. `setRawMode` is present even
   * when `isTTY` is false, deliberately: the product's guard is on isTTY, and a
   * stand-in that simply lacked the method would pass whether that guard existed
   * or not.
   */
  const makeStdin = (/** @type {boolean} */ isTTY) => {
    /** @type {Record<string, Function>} */
    const handlers = {};
    return {
      isTTY,
      /** @type {boolean[]} */ rawCalls: [],
      pauses: 0,
      setRawMode(/** @type {boolean} */ v) { this.rawCalls.push(v); },
      resume() {},
      pause() { this.pauses += 1; },
      setEncoding() {},
      on(/** @type {string} */ ev, /** @type {Function} */ fn) { handlers[ev] = fn; },
      /** Deliver a chunk exactly as a terminal would. */
      type(/** @type {string} */ s) { if (handlers.data) handlers.data(s); },
    };
  };

  const makeChild = () => {
    /** @type {Record<string, Function>} */
    const handlers = {};
    return {
      /** @type {string[]} */ killed: [],
      kill(/** @type {string} */ sig) { this.killed.push(sig); },
      on(/** @type {string} */ ev, /** @type {Function} */ fn) { handlers[ev] = fn; },
      fire(/** @type {string} */ ev, /** @type {any[]} */ ...args) { if (handlers[ev]) handlers[ev](...args); },
    };
  };

  const start = (/** @type {Record<string, any>} */ w) => {
    w.stdin = w.stdin || makeStdin(true);
    w.child = makeChild();
    w.cycles = [];
    w.exits = [];
    w.signals = [];
    w.handle = keys.runWithKeys({
      stateDir: '/state/dir',
      node: '/usr/bin/node',
      ccrJs: '/repo/bin/ccr.js',
      spawnFn: (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ o) => {
        w.spawned = { cmd, args, opts: o };
        return w.child;
      },
      stdin: w.stdin,
      cycle: (/** @type {string} */ dir) => { w.cycles.push(dir); },
      exit: (/** @type {number} */ code) => { w.exits.push(code); },
      onSignal: (/** @type {string} */ sig) => { w.signals.push(sig); },
    });
  };

  // ── Given ─────────────────────────────────────────────────────────────────

  reg.define(/^the sidecar is started with a key reader$/, start);
  reg.define(/^stdin is not a terminal$/, (w) => { w.stdin = makeStdin(false); });

  reg.define(/^the sidecar is asked to open on view (\d+)$/, (w, n) => {
    w.wantView = Number(n);
    w.views = [];
    sidecar.__resetViewState();
    w.defer(() => sidecar.__resetViewState());
  });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^the cycle key is pressed$/, (w) => { w.stdin.type(keys.CYCLE_KEYS[0]); });

  reg.define(/^the cycle key is pressed (\d+) times in one burst$/, (w, n) => {
    // One chunk, the way a terminal delivers a fast repeat — not N separate
    // reads, which would prove nothing about the counting.
    w.stdin.type(keys.CYCLE_KEYS[0].repeat(Number(n)));
  });

  // Named rather than indexed: a scenario that types CYCLE_KEYS[0] proves the
  // list has a first element, not that a particular terminal can reach the view.
  /** @type {Record<string, string>} */
  const F3 = { SS3: '\x1bOR', 'linux-console': '\x1b[[C', 'csi-tilde': '\x1b[13~' };
  reg.define(/^F3 arrives in the (\S+) encoding$/, (w, name) => {
    const seq = F3[String(name)];
    assert.ok(seq, `no F3 sequence named ${name}`);
    assert.ok(keys.CYCLE_KEYS.includes(seq), `${name} is not a cycle key`);
    w.stdin.type(seq);
  });

  reg.define(/^the key "([^"]+)" is pressed$/, (w, k) => { w.stdin.type(k); });
  reg.define(/^the interrupt key is pressed$/, (w) => { w.stdin.type(keys.INTERRUPT); });
  reg.define(/^the panel exits with code (\d+)$/, (w, code) => { w.child.fire('exit', Number(code), null); });
  reg.define(/^the panel fails to start$/, (w) => { w.child.fire('error', new Error('ENOENT')); });

  reg.define(/^it draws its first frame$/, (w) => {
    // The real `run`, with only the clock and the process controls stubbed: the
    // opening view has to travel through run → frame → composeFrame, which is
    // the path a `--view` that was accepted and then dropped would fail.
    sidecar.run({
      view: w.wantView,
      stateDir: '/state/dir',
      tick: () => sidecar.frame({
        stateDir: '/state/dir',
        compose: (/** @type {string} */ _d, /** @type {any} */ o) => { w.views.push(o.view); return ''; },
        paint: () => {},
      }),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      beat: () => 'claimed',
      clearBeat: () => {},
      exit: () => {},
      onSignal: () => {},
    });
  });

  reg.define(/^ccr is run with "([^"]+)"$/, (w, argline) => {
    try {
      execFileSync(process.execPath, [CCR_JS, ...String(argline).split(' ')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
      w.cli = { code: 0, stderr: '' };
    } catch (e) {
      const err = /** @type {any} */ (e);
      w.cli = { code: err.status, stderr: String(err.stderr || '') };
    }
  });

  // ── Then ──────────────────────────────────────────────────────────────────

  reg.define(/^the sidebar is asked to advance (\d+) views?$/, (w, n) => {
    assert.strictEqual(w.cycles.length, Number(n),
      `expected ${n} advance request(s), got ${w.cycles.length}`);
    for (const dir of w.cycles) {
      assert.strictEqual(dir, '/state/dir', 'each request must name THIS instance');
    }
  });

  reg.define(/^the sidebar is not asked to advance$/, (w) => {
    assert.deepStrictEqual(w.cycles, [], 'a key outside the closed set must do nothing');
  });

  reg.define(/^the panel was started with its input closed$/, (w) => {
    assert.deepStrictEqual(w.spawned.opts.stdio, ['ignore', 'inherit', 'inherit'],
      'the renderer must not be able to read this terminal');
    // And it is the panel, with this instance's state dir — a child spawned with
    // the right stdio and the wrong arguments would satisfy the line above.
    assert.deepStrictEqual(w.spawned.args, ['/repo/bin/ccr.js', 'sidecar', '--state-dir', '/state/dir']);
  });

  reg.define(/^the panel is asked to stop$/, (w) => {
    assert.deepStrictEqual(w.child.killed, ['SIGTERM']);
  });

  reg.define(/^the terminal is taken out of raw mode$/, (w) => {
    assert.ok(w.stdin.rawCalls.includes(false),
      `raw mode was never turned off; calls were ${JSON.stringify(w.stdin.rawCalls)}`);
    assert.strictEqual(w.stdin.rawCalls[w.stdin.rawCalls.length - 1], false,
      'the LAST thing done to the terminal must be handing it back');
  });

  reg.define(/^the key reader exits with code (\d+)$/, (w, code) => {
    assert.deepStrictEqual(w.exits, [Number(code)]);
  });

  reg.define(/^the panel is started$/, (w) => {
    assert.ok(w.spawned, 'no panel was spawned');
    assert.strictEqual(w.spawned.args[1], 'sidecar');
  });

  reg.define(/^raw mode is never asked for$/, (w) => {
    assert.deepStrictEqual(w.stdin.rawCalls, [],
      'a terminal that is not a terminal must never be put into raw mode');
  });

  reg.define(/^the frame is drawn for view (\d+)$/, (w, n) => {
    assert.deepStrictEqual(w.views, [Number(n)],
      `the first frame should be composed for view ${n}, got ${JSON.stringify(w.views)}`);
  });

  reg.define(/^it exits with code (\d+)$/, (w, code) => {
    assert.strictEqual(w.cli.code, Number(code), `stderr was: ${w.cli.stderr}`);
  });

  reg.define(/^stderr names the view flag$/, (w) => {
    assert.match(w.cli.stderr, /--view/);
  });

  reg.define(/^no panel is started$/, (w) => {
    // The process returned instead of running the loop; a panel that started
    // would not have exited at all, and the run above would have timed out.
    assert.doesNotMatch(w.cli.stderr, /waiting for the first status tick/);
  });
};
