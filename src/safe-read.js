// @ts-check
'use strict';
// src/safe-read.js — bounded, non-blocking reads of files ccr does not control.
//
// docs/PANE-CONTRACT.md states this rule for external pane blobs ("Safe reads":
// lstat, regular file only, size cap enforced before the read completes). The
// rule is not blob-specific — it belongs at every point where the sidecar reads
// a file some other process writes, which includes ccr's OWN inputs:
// last-status.json and the heartbeat file both live in a directory anything
// running as the user can write.
//
// Two failure modes it closes, both verified against the pre-fix sidecar:
//
//   A FIFO at the path. `readFileSync` on a fifo BLOCKS until a writer appears.
//   The sidecar's loop is single-threaded and synchronous, so one mkfifo froze
//   the whole panel forever — no render, no heartbeat, no recovery. `lstat`
//   answers "is this a regular file?" without opening anything, so the block
//   never happens.
//
//   An unbounded file. The reader had no cap at all (the WRITER caps itself at
//   1 MB, which says nothing about a planted file). A large planted snapshot
//   drove quadratic label padding into a RangeError and blanked the panel.
//
// `lstat` also means a SYMLINK is refused rather than followed: this is state,
// not configuration, and nothing legitimate links it elsewhere.

const fs = require('node:fs');

/** Default cap. Generous for a status snapshot (a real one is ~1-2 KB). */
const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Read a file as UTF-8 if — and only if — it is a regular file no larger than
 * `maxBytes`. Returns null for every other case (missing, fifo, socket, device,
 * symlink, directory, too large, unreadable). Never throws, never blocks.
 *
 * The size is re-checked from the open descriptor, not just the lstat: the file
 * can be replaced between the two calls, and the fstat describes the bytes we
 * actually hold. The read is capped regardless, so a file that grows after the
 * check still yields at most `maxBytes`.
 *
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {string|null}
 */
function readTextCapped(file, maxBytes = DEFAULT_MAX_BYTES) {
  const buf = readBytesCapped(file, maxBytes);
  return buf === null ? null : buf.toString('utf8');
}

/**
 * The binary form of the same rule, for files that are not text: the git pane
 * reads `.git/index`, object files and packfiles, none of which survive a
 * UTF-8 round trip. Identical guards — lstat first (regular file only, so a
 * fifo never blocks and a symlink is never followed), size re-checked from the
 * open descriptor, capped read, never throws.
 *
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {Buffer|null}
 */
function readBytesCapped(file, maxBytes = DEFAULT_MAX_BYTES) {
  let st;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (!st.isFile() || st.size > maxBytes) return null;

  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.size > maxBytes) return null;
    const buf = Buffer.alloc(Math.min(fst.size, maxBytes));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

module.exports = { readTextCapped, readBytesCapped, DEFAULT_MAX_BYTES };
