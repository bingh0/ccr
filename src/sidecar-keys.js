// @ts-check
'use strict';
// src/sidecar-keys.js — the hotkey host for terminals that have none.
//
// WHY THIS EXISTS. Cycling the sidebar's views is a HOST capability: under tmux
// the launcher binds F3, tmux runs `ccr cycle-view`, and src/sidecar.js never
// sees the key (docs/PANE-CONTRACT.md, "Hotkeys are a host capability"). VS Code
// and its forks bind nothing, and their integrated terminal leaves BOTH panes
// running a foreground process — Claude in one, the sidecar in the other — so
// there is not even a free shell prompt to type `ccr cycle-view` into.
//
// Before the git pane that cost nothing: a user with no configured panes had a
// one-view cycle, so a key that did not exist took nothing away. Every instance
// now has two built-in views, and on those hosts no way at all to reach the
// second one. This file is ccr playing host where the host declines to.
//
// WHY IT IS A SEPARATE PROCESS, and not a stdin listener bolted to the panel.
// The structural invariant is that the sidecar has NO INPUT CHANNEL, so that
// terminal-response channels and echoed keystrokes are structurally dead rather
// than filtered. That invariant is about the process which RENDERS UNTRUSTED
// TEXT, and it survives here intact: this file owns the terminal's stdin and
// spawns `ccr sidecar` as a CHILD whose stdin is `'ignore'`. The renderer still
// cannot read a key. It is exactly tmux's separation — host reads the key, the
// renderer never participates — with ccr standing in for the host.
//
// Both directions are pinned structurally in test/sidecar-capabilities.test.js:
// the renderer's module graph can never reach this file, and this file's graph
// can never reach a renderer. Widening either is a deliberate act.
//
// WHAT AN ATTACKER GETS, stated rather than implied. A hostile blob can emit a
// terminal query whose response the terminal delivers to whoever owns stdin —
// which is now this process rather than nobody. That buys exactly what forging
// <stateDir>/view-request already buys, and the contract prices it: "a different
// pane on screen". This process draws nothing and writes one counter.
//
// THE KEY SET IS A COMPILE-TIME CONSTANT, per the contract's trust rule —
// configuration may choose a key, ccr's own code chooses what it does. There is
// no path from configuration, a blob, or a producer to anything here.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { cycleView } = require('./cycle-view');

// F3 in every encoding a terminal actually sends it, plus SPACE.
//
//   \x1bOR    SS3. What xterm, screen, tmux and vt220 all send (infocmp: kf3).
//   \x1b[[C   The Linux console — infocmp gives `linux: kf3=\E[[C`, and it is
//             the ONLY entry that differs. It is also what arrives on Windows
//             from Node before v22.17.0 / v24.2.0: until "tty: use terminal VT
//             mode on Windows" (db2aae802) setRawMode passed UV_TTY_MODE_RAW,
//             where libuv translates the keypress itself rather than letting
//             the terminal's own sequence through. From UV_TTY_MODE_RAW_VT on
//             it sets ENABLE_VIRTUAL_TERMINAL_INPUT and Windows Terminal sends
//             SS3 like everyone else. Which of the two arrives on Windows is
//             therefore a property of the NODE VERSION, not the terminal.
//   \x1b[13~  The CSI-tilde form VS Code's xterm.js sends. An earlier version
//             of this comment called it the Linux console encoding; it is not,
//             and the console form above was missing entirely.
//
// Space is not a fallback for tidiness: an editor that keeps F3 for its own
// "find next" while the terminal is focused would otherwise leave this pane with
// no key at all, and that behavior differs across VS Code, Cursor, Positron and
// Antigravity. The pane is dedicated to the sidecar, so nothing else there is
// waiting for a space.
const CYCLE_KEYS = ['\x1bOR', '\x1b[[C', '\x1b[13~', ' '];

// In raw mode Ctrl-C arrives as a BYTE, not a signal. Without handling it the
// pane could not be closed from the keyboard at all.
const INTERRUPT = '\x03';

/**
 * How many cycle keys are in this chunk. A burst advances by the number
 * pressed, which is the request counter's own semantics (src/cycle-view.js):
 * a press that lands while the pane is busy is never lost.
 * @param {string} chunk
 * @returns {number}
 */
function countCycleKeys(chunk) {
  let n = 0;
  for (const key of CYCLE_KEYS) n += chunk.split(key).length - 1;
  return n;
}

/**
 * Run the sidecar under a key-reading parent.
 *
 * Every side effect is injectable, because the interesting behavior here is
 * ordering — raw mode restored on EVERY exit path, the child killed when the
 * parent is signalled, the exit code carried back — and none of that is
 * observable if the real tty and a real child process are in the way.
 *
 * @param {{ stateDir: string, argv?: string[], node?: string, ccrJs?: string,
 *   spawnFn?: Function, stdin?: any, cycle?: (dir: string) => any,
 *   exit?: (code: number) => void,
 *   onSignal?: (sig: string, handler: () => void) => void }} opts
 * @returns {{ stop: () => void, child: any }}
 */
function runWithKeys(opts) {
  const stateDir = opts.stateDir;
  const node = opts.node || process.execPath;
  const ccrJs = opts.ccrJs || path.join(__dirname, '..', 'bin', 'ccr.js');
  const spawnFn = opts.spawnFn || spawn;
  const stdin = opts.stdin || process.stdin;
  const cycle = opts.cycle || cycleView;
  const exit = opts.exit || ((/** @type {number} */ code) => process.exit(code));
  const onSignal = opts.onSignal || ((/** @type {string} */ sig, /** @type {() => void} */ h) => { process.on(sig, h); });

  // The child is the panel, unchanged: same command, same flags, and stdin
  // explicitly closed to it. stdout/stderr are inherited so the panel draws
  // straight to this terminal — the parent prints nothing, ever.
  const child = spawnFn(node, [ccrJs, 'sidecar', '--state-dir', stateDir, ...(opts.argv || [])], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let restored = false;
  /** Put the terminal back. Idempotent, and called on every path out. */
  const restore = () => {
    if (restored) return;
    restored = true;
    // A terminal left in raw mode outlives this process and is the worst
    // failure this file could have: the user's shell stops echoing and stops
    // handling Ctrl-C. Both calls are guarded because either can throw on a
    // stream that has already gone away.
    try { if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false); } catch { /* already gone */ }
    try { stdin.pause(); } catch { /* already gone */ }
  };

  let stopping = false;
  const stop = () => {
    stopping = true;
    restore();
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
  };

  // Raw mode only when there IS a terminal. `ccr sidecar --keys` with stdin
  // redirected (a pipe, a service manager, a CI run) must degrade to a plain
  // sidecar rather than throwing on setRawMode.
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(true);
      stdin.resume();
      if (typeof stdin.setEncoding === 'function') stdin.setEncoding('utf8');
      stdin.on('data', (/** @type {any} */ d) => {
        const s = String(d);
        if (s.includes(INTERRUPT)) { stop(); return; }
        for (let i = countCycleKeys(s); i > 0; i -= 1) cycle(stateDir);
      });
    } catch {
      // A terminal that refuses raw mode costs the key, never the panel.
      restore();
    }
  }

  child.on('exit', (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
    restore();
    // A stop WE asked for is a clean close, whatever signal did the work.
    exit(stopping ? 0 : (signal ? 1 : (code == null ? 0 : code)));
  });
  // A child that never started must not leave the terminal in raw mode either.
  child.on('error', () => { restore(); exit(1); });

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) onSignal(sig, stop);

  return { stop, child };
}

module.exports = { runWithKeys, countCycleKeys, CYCLE_KEYS, INTERRUPT };
