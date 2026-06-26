// @ts-check
'use strict';
// src/sidecar.js — the live economy panel that runs in the tmux sidebar.
// Reads the per-session snapshot that `ccr statusline` writes (CCR_STATE_DIR),
// re-renders the economy screen every second (so the imminent band flashes),
// and shows a clean ended/waiting state. Pure Node, zero dependencies.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeStatus } = require('./normalize');
const { renderEconomy } = require('./render/economy');
const { renderFeed } = require('./render/feed');
const { clampVisible } = require('./render/shared');
const { currentTranscriptPath, readNewLines, parseEvents } = require('./transcripts');

const STATE_DIR = process.env.CCR_STATE_DIR || path.join(os.homedir(), '.ccr');

// Live feed accumulator: tail the current transcript incrementally (by byte
// offset) and roll up tool/skill events + per-session stats. Reset on session
// switch. Best-effort — must never break the economy panel.
const FEED_CAP = 200;
const feedState = { path: /** @type {string|null} */ (null), offset: 0, events: /** @type {any[]} */ ([]), tools: /** @type {Record<string,number>} */ ({}), commands: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, files: new Set() };

/** @param {string} tpath @returns {any} feed view for renderFeed */
function updateFeed(tpath) {
  if (feedState.path !== tpath) {           // new session → start clean
    feedState.path = tpath; feedState.offset = 0; feedState.events = []; feedState.tools = {};
    feedState.commands = 0; feedState.tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }; feedState.files = new Set();
  }
  const { offset, lines } = readNewLines(tpath, feedState.offset);
  feedState.offset = offset;
  if (lines.length) {
    const p = parseEvents(lines);
    for (const e of p.events) feedState.events.push(e);
    if (feedState.events.length > FEED_CAP) feedState.events.splice(0, feedState.events.length - FEED_CAP);
    for (const k of Object.keys(p.stats.tools)) feedState.tools[k] = (feedState.tools[k] || 0) + p.stats.tools[k];
    feedState.commands += p.stats.commands;
    feedState.tokens.input += p.stats.tokens.input;
    feedState.tokens.output += p.stats.tokens.output;
    feedState.tokens.cacheRead += p.stats.tokens.cacheRead;
    feedState.tokens.cacheCreate += p.stats.tokens.cacheCreate;
    for (const f of p.stats.files) feedState.files.add(f);
  }
  return { events: feedState.events, tools: feedState.tools, commands: feedState.commands, tokens: feedState.tokens, files: [...feedState.files] };
}

const dim = (/** @type {string} */ s) => `\x1b[2m${s}\x1b[0m`;
const bold = (/** @type {string} */ s) => `\x1b[1m${s}\x1b[0m`;

let prev = '';
function draw(/** @type {string} */ s) {
  if (s === prev) return;
  prev = s;
  // Cursor home, clear-to-EOL per line, then clear below — flicker-free.
  process.stdout.write('\x1b[H' + s.replace(/\n/g, '\x1b[K\n') + '\x1b[J');
}

/**
 * Compose the screen for one tick — the ended / waiting / unreadable / live
 * states — and return it as a string (no I/O to stdout). Pure enough to test:
 * the only inputs are the state dir on disk, `now`, and the pane width `cols`.
 *
 * `cols` is the pane's visible column count (process.stdout.columns); every line
 * is clamped to it so a wide row can't soft-wrap and corrupt the cursor-home
 * redraw in a narrow cmd/PowerShell/split pane. Omit it (non-TTY) for no clamp.
 *
 * @param {string} stateDir
 * @param {{ now?: number, cols?: number }} [opts]
 * @returns {string}
 */
function composeFrame(stateDir, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const cols = opts.cols;
  const clamp = (/** @type {string} */ s) =>
    (typeof cols === 'number' && cols > 0
      ? s.split('\n').map((l) => clampVisible(l, cols)).join('\n')
      : s);
  const snapshot = path.join(stateDir, 'last-status.json');
  const exited = path.join(stateDir, 'exited');

  if (fs.existsSync(exited)) return clamp(bold('ccr') + '  ' + dim('session ended') + '\n');
  let raw = '';
  try { raw = fs.readFileSync(snapshot, 'utf8'); } catch { /* none yet */ }
  if (!raw.trim()) return clamp(dim('ccr · waiting for the first status tick…') + '\n');
  let state;
  try { state = JSON.parse(raw); } catch { return clamp(dim('ccr · status unreadable') + '\n'); }
  let out;
  try {
    out = renderEconomy(normalizeStatus(state), { tick: Math.floor(now / 1000) % 2 === 0 });
  } catch (e) {
    out = dim('ccr render error: ' + (e && e instanceof Error ? e.message : String(e)));
  }
  // Live tool/skills feed below the panel — best-effort; never break the panel.
  // Its inner width tracks the pane so args truncate cleanly (the clamp below is
  // the hard safety net regardless).
  try {
    const tpath = currentTranscriptPath(state);
    if (tpath) {
      const feedWidth = typeof cols === 'number' && cols > 0 ? Math.max(20, Math.min(48, cols - 2)) : 48;
      const feedStr = renderFeed(updateFeed(tpath), { max: 6, width: feedWidth });
      if (feedStr) out += '\n\n' + feedStr;
    }
  } catch { /* feed is optional */ }
  return clamp(out.endsWith('\n') ? out : out + '\n');
}

/**
 * Resolve the column budget to clamp the panel to. `process.stdout.columns` is
 * authoritative when present (live resize re-flows on the next frame), but inside
 * the Windows launcher's `cmd /c` conpty pane it is unreliable — often undefined
 * or the FULL window width rather than the narrow split. So the launcher injects
 * the computed pane width as CCR_SIDECAR_COLS; we take the SMALLER of the two,
 * which is safe whichever is wrong: a bogus full-width `columns` can't defeat the
 * hint, and a missing hint (Linux/tmux, standalone `ccr sidecar`) leaves the live
 * value untouched. Returns undefined only when neither is known (no clamp).
 *
 * @returns {number|undefined}
 */
function resolveCols() {
  const live = process.stdout.columns;
  const haveLive = typeof live === 'number' && live > 0;
  const hint = parseInt(process.env.CCR_SIDECAR_COLS || '', 10);
  const haveHint = Number.isFinite(hint) && hint > 0;
  if (haveLive && haveHint) return Math.min(live, hint);
  if (haveHint) return hint;
  return haveLive ? live : undefined;
}

function frame() {
  // Read columns each tick so a live resize re-flows on the next frame.
  draw(composeFrame(STATE_DIR, { now: Date.now(), cols: resolveCols() }));
}

/**
 * The live loop. With `exitOnEnd` (the Windows launcher passes `--exit-on-end`),
 * the sidecar closes its own pane as soon as the `exited` sentinel appears — so a
 * `cmd /c` pane folds away on session end rather than lingering, matching the tmux
 * launcher's kill-session sweep. Without it (Linux/tmux, standalone `ccr sidecar`)
 * the loop runs until signalled, exactly as before.
 *
 * For the fastest, correctly-ordered close, the sentinel is POLLED faster than the
 * render cadence when `exitOnEnd` (a redraw is ~1s; waiting a full second just to
 * NOTICE the exit would dominate the close time). A single interval ticks at
 * `pollMs`; the expensive redraw is throttled to ~1s, while the cheap sentinel
 * check runs every poll. On exit we paint "session ended" once and close after a
 * short `graceMs`. The launcher's pane 0 then lingers slightly longer (see
 * buildWtArgs) so this RIGHT pane closes first and the border sweeps left→right.
 * Side effects are injectable so the end-sweep is unit-testable.
 *
 * @param {{ exitOnEnd?: boolean, stateDir?: string, graceMs?: number,
 *   tick?: () => void, sentinelExists?: () => boolean,
 *   setIntervalFn?: Function, setTimeoutFn?: Function,
 *   clearIntervalFn?: Function, clearTimeoutFn?: Function,
 *   exit?: () => void, onSignal?: (sig: string, handler: () => void) => void }} [opts]
 * @returns {() => void} the stop handler (exposed for tests)
 */
function run(opts = {}) {
  const stateDir = opts.stateDir || STATE_DIR;
  const exitOnEnd = opts.exitOnEnd != null ? opts.exitOnEnd : (process.env.CCR_SIDECAR_EXIT_ON_END === '1');
  // Tiny grace so the "session ended" frame paints before we close — kept short
  // since this drives the close speed (the launcher tunes pane 0 to outlast it).
  const graceMs = opts.graceMs != null ? opts.graceMs : 200;
  const tick = opts.tick || frame;
  const sentinelExists = opts.sentinelExists || (() => fs.existsSync(path.join(stateDir, 'exited')));
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const exit = opts.exit || (() => process.exit(0));
  const onSignal = opts.onSignal || ((sig, handler) => process.on(sig, handler));

  // Poll the sentinel fast when we have to detect the end; keep the redraw at ~1s.
  const RENDER_MS = 1000;
  const pollMs = exitOnEnd ? 120 : RENDER_MS;

  let id = null;
  let endTimer = null;
  let sinceRender = RENDER_MS; // render on the first loop
  const stop = () => {
    if (id != null) clearIntervalFn(id);
    if (endTimer != null) clearTimeoutFn(endTimer);
    exit();
  };
  const checkEnd = () => {
    // Once the session has ended, paint it once then sweep this pane closed.
    if (exitOnEnd && endTimer == null && sentinelExists()) {
      tick();
      endTimer = setTimeoutFn(stop, graceMs);
    }
  };
  const loop = () => {
    sinceRender += pollMs;
    if (sinceRender >= RENDER_MS) { sinceRender = 0; tick(); }
    checkEnd();
  };
  loop();
  id = setIntervalFn(loop, pollMs);
  onSignal('SIGINT', stop);
  onSignal('SIGTERM', stop);
  return stop;
}

// `updateFeed` + `composeFrame` are exported for tests (the incremental tail +
// session-switch reset and the ended/waiting/render states are the subtle
// parts); the live loop uses `run`.
module.exports = { run, updateFeed, composeFrame };
