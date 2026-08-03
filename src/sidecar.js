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
const { freshenAccountLimits } = require('./account-limits');
const { renderEconomy } = require('./render/economy');
const { renderFeed } = require('./render/feed');
const { clampVisible } = require('./render/shared');
const { liveness } = require('./liveness');
const { currentTranscriptPath, readNewLines, parseEvents } = require('./transcripts');
const { readTextCapped } = require('./safe-read');
const { stripControl } = require('./sanitize');
const { loadPaneConfig } = require('./pane-config');
const { loadPaneBlob } = require('./pane-blob');
const { renderPane } = require('./render/pane');
const { readViewRequests } = require('./cycle-view');

const STATE_DIR = process.env.CCR_STATE_DIR || path.join(os.homedir(), '.ccr');

// Single-instance heartbeat: each live sidecar re-claims <stateDir>/sidecar-alive
// roughly once a second with a "<pid>:<startMs>" nonce. Two readers use it:
//  - the VS Code launcher skips the split+paste banner while the file is fresh
//    (an attached sidecar picks the new session up by itself once the launcher
//    clears the exited sentinel — see launch-vscode.js), so relaunching stops
//    minting duplicate panes;
//  - an older sidecar that sees a NEWER nonce yields its pane (see run()), so
//    pasting the one-liner twice still converges to a single live panel.
const HEARTBEAT_FILE = 'sidecar-alive';
// "Fresh" = beaten within this window. Beats land ~1s apart; 5s tolerates a
// busy machine without ever mistaking a dead pane (minutes old) for live.
const HEARTBEAT_FRESH_MS = 5000;

/** @param {string} s @returns {{ pid: number, start: number } | null} */
function parseNonce(s) {
  const m = /^(\d+):(\d+)$/.exec(s.trim());
  return m ? { pid: Number(m[1]), start: Number(m[2]) } : null;
}

/**
 * One heartbeat: re-claim the file with our nonce, unless a NEWER sidecar
 * (later start; higher pid breaks a same-millisecond tie) holds it — then
 * yield WITHOUT writing, so the newer panel's claim is never clobbered and
 * exactly one of the two keeps beating. Unreadable or unparseable content is
 * claimed over (a garbage file must not wedge the panel), and any fs error
 * claims rather than kills the loop — the heartbeat is strictly best-effort.
 * @param {string} stateDir @param {string} nonce
 * @param {{ now?: number, freshMs?: number }} [opts] injectable clock, for tests
 * @returns {'claimed' | 'yielded'}
 */
function heartbeatTick(stateDir, nonce, opts = {}) {
  const file = path.join(stateDir, HEARTBEAT_FILE);
  const mine = parseNonce(nonce);
  const now = opts.now != null ? opts.now : Date.now();
  const freshMs = opts.freshMs != null ? opts.freshMs : HEARTBEAT_FRESH_MS;
  try {
    const cur = readTextCapped(file, 256) || '';
    // Yield only to a nonce that is BOTH newer and still being beaten. Nonce
    // order alone is a wall-clock comparison against a file that outlives its
    // writer: a hard-killed sidecar leaves its nonce behind, and after any
    // backwards clock step (NTP correction, VM restore) every sidecar launched
    // since reads that dead nonce as "newer" and stands down — so the pane ends
    // up with no live sidecar at all, repeatably, until the clock catches up.
    // Mtime is what distinguishes a live rival from a corpse; sidecarAlive()
    // has always used it, and the takeover decision needs it just as much.
    const fresh = (() => {
      try { return now - fs.lstatSync(file).mtimeMs <= freshMs; } catch { return false; }
    })();
    const other = fresh && cur && cur.trim() !== nonce ? parseNonce(cur) : null;
    if (other && mine && (other.start > mine.start || (other.start === mine.start && other.pid > mine.pid))) {
      return 'yielded';
    }
    // Never write THROUGH a symlink planted at this path — that turns a
    // heartbeat into an arbitrary-file write of "<pid>:<ms>".
    try { if (fs.lstatSync(file).isSymbolicLink()) fs.rmSync(file, { force: true }); } catch { /* absent */ }
    fs.writeFileSync(file, nonce);
  } catch { /* best-effort */ }
  return 'claimed';
}

/**
 * Remove the heartbeat on the way out — but only while it still holds OUR
 * nonce; after a takeover the file belongs to the newer sidecar.
 * @param {string} stateDir @param {string} nonce
 */
function clearHeartbeat(stateDir, nonce) {
  const file = path.join(stateDir, HEARTBEAT_FILE);
  try {
    if ((readTextCapped(file, 256) || '').trim() === nonce) fs.rmSync(file, { force: true });
  } catch { /* already gone / unreadable — nothing to clear */ }
}

/**
 * Is a sidecar attached to this state dir right now? Mtime-based, so a killed
 * pane (whose stale file nobody cleared) reads as dead within seconds. Used by
 * the VS Code launcher to print "already attached" instead of the split banner.
 * @param {string} stateDir @param {{ now?: number, freshMs?: number }} [opts]
 * @returns {boolean}
 */
function sidecarAlive(stateDir, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const freshMs = opts.freshMs != null ? opts.freshMs : HEARTBEAT_FRESH_MS;
  try {
    return now - fs.statSync(path.join(stateDir, HEARTBEAT_FILE)).mtimeMs <= freshMs;
  } catch {
    return false;
  }
}

// Live feed accumulator: tail the current transcript incrementally (by byte
// offset) and roll up tool/skill events + per-session stats. Reset on session
// switch. Best-effort — must never break the economy panel.
const FEED_CAP = 200;
const feedState = { path: /** @type {string|null} */ (null), offset: 0, events: /** @type {any[]} */ ([]), tools: /** @type {Record<string,number>} */ (Object.create(null)), commands: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, files: new Set() };

/** Zero the rolling totals — on a session switch, and on a tail restart. */
function resetFeedState(/** @type {string|null} */ tpath) {
  feedState.path = tpath; feedState.offset = 0; feedState.events = [];
  // Null-prototype: these keys are tool NAMES from the transcript, i.e. attacker
  // -influenceable. On a plain object a tool called "constructor" reads back the
  // inherited function (the feed header rendered its native source), and one
  // called "__proto__" silently vanishes into a prototype write instead of
  // counting. With no prototype there is nothing to inherit or to set.
  feedState.tools = Object.create(null);
  feedState.commands = 0;
  feedState.tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  feedState.files = new Set();
}

/** @param {string} tpath @returns {any} feed view for renderFeed */
function updateFeed(tpath) {
  if (feedState.path !== tpath) resetFeedState(tpath);   // new session → start clean
  const { offset, lines, restarted } = readNewLines(tpath, feedState.offset);
  // The tail went back to 0 because the file shrank, so the lines below are ones
  // we have already counted. Resetting the offset without resetting the totals
  // double-counts every tool, file, and token for the rest of the session.
  if (restarted) resetFeedState(tpath);
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
 * `view` selects which whole-pane view to draw: 0 is ccr's own economy view and
 * 1..N are the configured external panes, in config order. It is taken modulo
 * the number of views, so an index that outlives a shrinking config wraps rather
 * than showing nothing. External panes are FULL-HEIGHT views, never stacked
 * beside the economy panel — one pane, one subject.
 *
 * @param {string} stateDir
 * @param {{ now?: number, cols?: number, rows?: number, view?: number,
 *   panes?: Array<{path: string, source: string}> }} [opts]
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

  // External panes. Config is re-read per tick so adding a pane needs no
  // relaunch, and it is best-effort: a broken config costs the panes, never the
  // panel (loadPaneConfig is total — see src/pane-config.js).
  const panes = opts.panes || loadPaneConfig().panes;
  const viewCount = 1 + panes.length;
  const view = ((Math.trunc(opts.view || 0) % viewCount) + viewCount) % viewCount;
  if (view > 0) {
    const pane = panes[view - 1];
    // Guarded like the economy branch below: "a malformed file must cost a pane
    // state, never the sidecar" is the contract's rule, and leaving it to rest
    // on the renderer never throwing would make it one careless edit from false.
    try {
      const res = loadPaneBlob(pane.path, { now });
      return clamp(renderPane(res, {
        source: pane.source,
        position: `${view + 1}/${viewCount}`,
        width: typeof cols === 'number' && cols > 0 ? cols : 48,
        // Rows the body may use: the pane's height less the chrome (title,
        // basis, blank) and a line of breathing room. Without this the overflow
        // collapse in renderPane is unreachable, and a long blob silently
        // scrolls the pane — which is exactly what obligation 8 forbids.
        maxRows: Math.max(1, (opts.rows || resolveRows() || 24) - 4),
      }) + '\n');
    } catch (e) {
      const msg = stripControl(e && e instanceof Error ? e.message : String(e)) || 'unknown';
      return clamp(dim('ccr · pane render error: ' + msg.slice(0, 120)) + '\n');
    }
  }
  // Capped, regular-files-only read: a fifo here would block this synchronous
  // loop forever and an unbounded file can blank the panel (see src/safe-read.js).
  const raw = readTextCapped(snapshot) || '';
  if (!raw.trim()) return clamp(dim('ccr · waiting for the first status tick…') + '\n');
  let state;
  try { state = JSON.parse(raw); } catch { return clamp(dim('ccr · status unreadable') + '\n'); }
  let out;
  try {
    // 5h/weekly are ACCOUNT-WIDE but captured per-profile, so an idle sibling's
    // panel lags a busy one. Reconcile the meters against sibling profiles on the
    // SAME account (see src/account-limits.js) before rendering — best-effort, and
    // strictly guarded so a different account is never mixed in.
    const reconciled = { ...state, rate_limits: freshenAccountLimits(state.rate_limits, stateDir) };
    out = renderEconomy(normalizeStatus(reconciled), { tick: Math.floor(now / 1000) % 2 === 0 });
    // ccr's own view is position 1 of the cycle. Shown only when there is a
    // cycle to be in — a lone economy view has no position worth naming.
    if (viewCount > 1) out = out.replace(/\n/, dim(`   1/${viewCount}`) + '\n');
  } catch (e) {
    // Sanitize and bound the message: it is the one error surface that prints
    // text ccr did not author, and an exception string can quote the input that
    // caused it. Everything else here is a named state naming a path only.
    const msg = stripControl(e && e instanceof Error ? e.message : String(e)) || 'unknown';
    out = dim('ccr render error: ' + msg.slice(0, 120));
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
  // Staleness annotation (never a wipe): Claude Code does not emit the status line
  // during a single long operation, so the snapshot legitimately ages. Surface a
  // quiet "updated Nm ago" so a stale panel reads as stale rather than broken —
  // otherwise a long agent run (or a CC statusLine that stopped firing) looks like
  // the sidecar just froze. See src/liveness.js + features/liveness.feature.
  try {
    const ageMs = now - fs.statSync(snapshot).mtimeMs;
    const mark = liveness({ exited: false, ageMs }).marker;
    if (mark) out += (out.endsWith('\n') ? '' : '\n') + '  ' + dim('· ' + mark);
  } catch { /* snapshot mtime unknown → no marker */ }
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

/** The pane's height, for the row budget. Unknown (non-TTY) → undefined. */
function resolveRows() {
  const live = process.stdout.rows;
  return typeof live === 'number' && live > 0 ? live : undefined;
}

// Which whole-pane view is showing. composeFrame takes it modulo the view
// count, so it never needs clamping here.
let currentView = 0;
// Advance-requests already applied. The host's key writes a counter (see
// src/cycle-view.js) and we consume the DIFFERENCE, so a burst of presses
// advances by the number pressed and none is lost between ticks.
/** @type {number|null} */
let seenRequests = null;

/**
 * One tick: consume any pending advance-requests, then paint.
 * The seams exist so a test can observe what reaches composeFrame — without
 * them, "the view index actually reaches the frame" is unobservable, and both
 * halves of the cycling wiring can be broken with the suite still green.
 * @param {{ stateDir?: string, compose?: Function, paint?: Function }} [deps]
 */
function frame(deps = {}) {
  const stateDir = deps.stateDir || STATE_DIR;
  const compose = deps.compose || composeFrame;
  const paint = deps.paint || draw;
  const requests = readViewRequests(stateDir);
  if (seenRequests == null) seenRequests = requests;      // adopt on first tick
  else if (requests !== seenRequests) {
    currentView += Math.max(0, requests - seenRequests);
    seenRequests = requests;
  }
  // Read columns and rows each tick so a live resize re-flows on the next frame.
  paint(compose(stateDir, {
    now: Date.now(), cols: resolveCols(), rows: resolveRows(), view: currentView,
  }));
}

/** Test seam: reset the cycling state between scenarios (module-level by design). */
function __resetViewState() { currentView = 0; seenRequests = null; }

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
 * A second sidecar pasted against the same state dir takes the heartbeat over
 * (its nonce is newer); this one then paints a hand-off note and exits WITHOUT
 * clearing the file — it now belongs to the newer panel. `beat`/`clearBeat`/
 * `onYield` are injectable so the takeover is unit-testable too.
 *
 * @param {{ exitOnEnd?: boolean, stateDir?: string, graceMs?: number,
 *   tick?: () => void, sentinelExists?: () => boolean,
 *   beat?: () => ('claimed' | 'yielded'), clearBeat?: () => void, onYield?: () => void,
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
  const nonce = `${process.pid}:${Date.now()}`;
  const beat = opts.beat || (() => heartbeatTick(stateDir, nonce));
  const clearBeat = opts.clearBeat || (() => clearHeartbeat(stateDir, nonce));
  const onYield = opts.onYield || (() => draw(bold('ccr') + '  ' + dim('another sidecar attached — this pane stood down') + '\n'));
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const exit = opts.exit || (() => process.exit(0));
  const onSignal = opts.onSignal || ((sig, handler) => process.on(sig, handler));

  // Poll the sentinel fast when we have to detect the end; keep the redraw at ~1s.
  const RENDER_MS = 1000;
  const pollMs = exitOnEnd ? 120 : RENDER_MS;

  /** @type {ReturnType<typeof setInterval>|null} */
  let id = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let endTimer = null;
  let sinceRender = RENDER_MS; // render on the first loop
  const teardown = (/** @type {boolean} */ clearHb) => {
    if (id != null) clearIntervalFn(id);
    if (endTimer != null) clearTimeoutFn(endTimer);
    if (clearHb) clearBeat();
    exit();
  };
  const stop = () => teardown(true);
  const checkEnd = () => {
    // Once the session has ended, paint it once then sweep this pane closed.
    if (exitOnEnd && endTimer == null && sentinelExists()) {
      tick();
      endTimer = setTimeoutFn(stop, graceMs);
    }
  };
  const loop = () => {
    sinceRender += pollMs;
    if (sinceRender >= RENDER_MS) {
      sinceRender = 0;
      tick();
      // Beat at render cadence (~1s). A newer sidecar owns the dir now →
      // hand the state dir over and fold this pane, leaving ITS heartbeat.
      if (beat() === 'yielded') { onYield(); teardown(false); return; }
    }
    checkEnd();
  };
  loop();
  id = setIntervalFn(loop, pollMs);
  // SIGUSR1 also advances the view, for anyone who can already signal this
  // process (`kill -USR1 $(pgrep -f 'ccr.js sidecar')`). The KEY binding does
  // not use it: routing a keypress through a pid read out of a writable file
  // turned a cosmetic hotkey into an arbitrary-kill primitive, so the host
  // writes a request file instead (see src/cycle-view.js). Cycling still never
  // reaches stdin, which is the invariant that matters.
  onSignal('SIGUSR1', () => { currentView += 1; tick(); });
  onSignal('SIGINT', stop);
  onSignal('SIGTERM', stop);
  return stop;
}

// `updateFeed` + `composeFrame` are exported for tests (the incremental tail +
// session-switch reset and the ended/waiting/render states are the subtle
// parts); the live loop uses `run`. The heartbeat trio is exported for tests
// and for the VS Code launcher's `sidecarAlive` check.
module.exports = {
  run, updateFeed, composeFrame, heartbeatTick, clearHeartbeat, sidecarAlive,
  frame, __resetViewState,
};
