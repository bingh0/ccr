// @ts-check
'use strict';
// src/cycle-view.js — ask the running sidecar to show its next view.
//
// The sidecar reads no stdin, by construction: an input channel is exactly the
// capability the pane threat model refuses it (docs/PANE-CONTRACT.md,
// "Structural invariants"). So the host binds a key, the key runs this, and
// this leaves a REQUEST the sidecar picks up on its next tick.
//
// WHY A FILE AND NOT A SIGNAL. The first version of this read the sidecar's pid
// from its heartbeat file and sent SIGUSR1. That was wrong, and an adversarial
// review reproduced the consequence: the heartbeat lives in a directory
// anything running as the user can write (src/safe-read.js says so in its own
// header), so writing "<victim_pid>:<now>" into it redirected the signal at any
// process of the user's choosing — and SIGUSR1's default disposition is
// terminate. A cosmetic "show me the next pane" key was a kill primitive.
//
// No guard fixes that, because the pid and its freshness both come from the
// attacker's own file: a liveness probe only proves the victim exists. The
// mechanism had to change, not gain checks. Writing a request costs the same
// attacker exactly what they should get — the ability to change which pane is
// on screen — and nothing else.
//
// The cost is latency: the sidecar notices on its next tick, so up to ~1s. That
// is the honest price for not holding a loaded weapon, and a keypress that
// repaints within a second reads as responsive anyway.

const fs = require('node:fs');
const path = require('node:path');
const { readTextCapped } = require('./safe-read');

/** The request file the sidecar polls. Content is a counter, not a command. */
const REQUEST_FILE = 'view-request';

/**
 * Record a request to advance the view. Never throws: a keypress that cannot
 * write is a no-op, not an error worth painting over the user's terminal.
 * @param {string} stateDir
 * @returns {{ ok: boolean, reason?: string, count?: number }}
 */
function cycleView(stateDir) {
  const file = path.join(stateDir, REQUEST_FILE);
  // Monotonic counter rather than a timestamp: two presses inside the same
  // millisecond must still read as two requests.
  // Capped, regular-files-only: a fifo planted here would otherwise block this
  // process forever, and under tmux run-shell every keypress would leak another
  // hung node. Same rule as every other file the sidecar reads.
  let count = 0;
  const cur = (readTextCapped(file, 64) || '').trim();
  if (/^\d+$/.test(cur)) count = Number(cur);
  if (!Number.isSafeInteger(count) || count < 0) count = 0;

  try {
    // Never write THROUGH a symlink planted at this path.
    try { if (fs.lstatSync(file).isSymbolicLink()) fs.rmSync(file, { force: true }); } catch { /* absent */ }
    fs.writeFileSync(file, String(count + 1));
    return { ok: true, count: count + 1 };
  } catch {
    return { ok: false, reason: 'state dir not writable' };
  }
}

/**
 * How many advance-requests have been recorded. The sidecar calls this each
 * tick and advances its view by the DIFFERENCE since the previous tick, so a
 * request that arrives while the pane is busy is never lost, and a burst of
 * presses advances by the number pressed.
 * @param {string} stateDir
 * @returns {number}
 */
function readViewRequests(stateDir) {
  const cur = (readTextCapped(path.join(stateDir, REQUEST_FILE), 64) || '').trim();
  if (!/^\d+$/.test(cur)) return 0;
  const n = Number(cur);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

module.exports = { cycleView, readViewRequests, REQUEST_FILE };
