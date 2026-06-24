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

module.exports = { ensureSecureDir };
