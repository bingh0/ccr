// @ts-check
'use strict';
// src/state-dir.js — ccr keeps its local state under the user's home (~/.ccr),
// never in world-shared /tmp. Captured status includes the transcript path,
// cost, and usage %, so the directory is created owner-only (0700) to keep other
// local users from reading it. Best-effort: state I/O must never break the
// status line, so callers wrap this in try/catch.

const fs = require('node:fs');

/**
 * Create (or tighten to owner-only) a state directory.
 * @param {string} dir
 */
function ensureSecureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to dirs it creates; tighten a pre-existing one.
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

/**
 * Record the directory ccr was launched in, for the git pane's launch-repo
 * identity (features/git-repo-identity.feature: the launch repo is the tab's
 * stable identity, while the current repo follows the session).
 *
 * It is written rather than inferred because only the LAUNCHER knows it. The
 * sidecar's own `process.cwd()` happens to be the launch directory under tmux
 * and wt.exe, where the pane inherits it — but not in VS Code, where the user
 * pastes the sidecar one-liner into a terminal that opened wherever the editor
 * felt like. Inferring would be right most of the time and quietly wrong in the
 * host that needed it most, so the launcher states it.
 *
 * Best-effort by the same rule as everything else in this file: a tab that
 * cannot record its launch directory falls back to naming only the current
 * repo, which is a smaller loss than a launcher that fails.
 *
 * @param {string} dir  The state directory.
 * @param {string} cwd  The launch directory.
 */
function recordLaunchDir(dir, cwd) {
  const path = require('node:path');
  const file = path.join(dir, 'launch-cwd');
  try {
    // Never write THROUGH anything but a plain file, for the two reasons the
    // heartbeat write (src/sidecar.js) and the cycle counter (src/cycle-view.js)
    // already guard against at their own paths in this same directory:
    //
    //   A SYMLINK turns this into an arbitrary-file overwrite of a directory
    //   name — verified: a link planted at launch-cwd had its target replaced.
    //
    //   A FIFO is worse and quieter. Opening one for write BLOCKS until a reader
    //   appears, and this runs in all three launchers BEFORE Claude is spawned —
    //   verified: `ccr` hangs forever with no output at all. That is the silent
    //   -abort failure this project already shipped once (scripts/launch.sh's
    //   nvm glob under `set -e`), arriving by a different door.
    //
    // Anything under <stateDir> is writable by anything running as the user, so
    // this is the same trust boundary, not a new one.
    try { if (!fs.lstatSync(file).isFile()) fs.rmSync(file, { force: true }); } catch { /* absent */ }
    fs.writeFileSync(file, String(cwd) + '\n', { mode: 0o600 });
  } catch { /* best effort */ }
}

/**
 * Forget the recorded launch directory.
 *
 * NOT the same as declining to write one. Slots are REUSED, so a record left by
 * whatever ran in this slot before would still be sitting there — and
 * src/sidecar.js launchDir() PREFERS the record over the pane's own cwd, so a
 * stale one wins outright. The launcher calls this whenever it could not
 * deliver the directory to the panes, which is the only moment it knows the
 * record would be a lie.
 *
 * @param {string} dir  The state directory.
 */
function clearLaunchDir(dir) {
  const path = require('node:path');
  try { fs.rmSync(path.join(dir, 'launch-cwd'), { force: true }); } catch { /* best effort */ }
}

module.exports = { ensureSecureDir, recordLaunchDir, clearLaunchDir };
