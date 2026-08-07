// @ts-check
'use strict';
// src/git-index.js — parse `.git/index`, the staging area, without git.
//
// Second stop of the build fork src/git-repo.js rules in its header: the pane
// reads `.git` itself, so the working-tree section needs the index in git's own
// on-disk format. The contract this parser is held to lives in
// features/design/git-index-format.feature — the design tier, because an index
// byte layout is an implementation criterion no visionary should be asked to
// review.
//
// WHAT IS PARSED, AND WHAT IS DELIBERATELY NOT. Versions 2, 3 and 4 — the three
// git writes today — including the stage bits that mark conflicts and the stat
// cache the modified-check needs. Extensions (TREE, REUC, link…) are skipped
// whole: every one is an optimization cache over the entries themselves, and a
// reader that consults none of them can never be lied to by a stale one.
//
// EVERY FAILURE IS null, NEVER A GUESS. A truncated entry, an impossible count,
// an unknown version, an over-cap file — the caller degrades to "git data
// unavailable" (features/git-pane-safety.feature), which is honest where a
// partial listing would be a quiet lie about what is staged.
//
// Hostile-input rules are src/safe-read.js's: the index is read through
// readBytesCapped (regular file only, size-capped, never blocks), and paths are
// NOT display-sanitized here — the model layer does that at its own boundary,
// because these paths are also compared against real directory listings and a
// stripped path would fail to match the file it names.

const fs = require('node:fs');
const path = require('node:path');
const { readBytesCapped, readTextCapped } = require('./safe-read');

// A generous roof, not a target: the linux kernel's index is ~10 MB. Past this
// the pane degrades rather than spending the draw loop's budget parsing.
const INDEX_MAX_BYTES = 32 * 1024 * 1024;

// Entries are ~70 bytes plus a path, so this cap can only trip on a file whose
// header count lies about its body — the exact corruption it exists to stop.
const MAX_ENTRIES = 200_000;

/**
 * One index entry. `stage` is 0 for an ordinary staged path and 1..3 for the
 * three sides of a conflict (base, ours, theirs).
 *
 * @typedef {object} IndexEntry
 * @property {string} path      Repo-relative, POSIX separators, as git stores it.
 * @property {number} mode      File mode (e.g. 0o100644, 0o120000 symlink).
 * @property {number} stage     0 normal, 1-3 conflict stages.
 * @property {string} oid       Object id, lowercase hex (40 or 64 chars).
 * @property {number} size      Cached worktree size at add time.
 * @property {number} mtimeSec  Cached worktree mtime (seconds).
 * @property {number} mtimeNsec Cached worktree mtime (nanoseconds part).
 */

/**
 * @typedef {object} GitIndex
 * @property {IndexEntry[]} entries  In file order (git keeps them path-sorted).
 * @property {number} version
 * @property {number} mtimeMs        The index file's own mtime — the racy-clean
 *   comparison needs it (see src/git-working-tree.js).
 */

/**
 * Does this repository use sha-256 object names? The index does not declare its
 * hash width; the repository does, in config. A config that cannot be read
 * means the default format, which is what the fallback answers.
 * @param {string} gitDir
 * @returns {boolean}
 */
function usesSha256(gitDir) {
  const cfg = readTextCapped(path.join(gitDir, 'config'), 64 * 1024);
  return cfg != null && /^\s*objectformat\s*=\s*sha256\s*$/im.test(cfg);
}

/**
 * Parse `.git/index`. Returns the entries, or null when the file cannot be
 * trusted, or `{ entries: [] }` (empty, versioned 0) when it simply does not
 * exist — a freshly-initialized repository has no index yet, and "nothing is
 * staged" is the true statement about it.
 *
 * @param {string} gitDir
 * @returns {GitIndex|null}
 */
function readIndex(gitDir) {
  const file = path.join(gitDir, 'index');
  let st = null;
  try { st = fs.lstatSync(file); } catch { st = null; }
  if (st === null) return { entries: [], version: 0, mtimeMs: 0 };

  const buf = readBytesCapped(file, INDEX_MAX_BYTES);
  if (buf === null || buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) !== 'DIRC') return null;
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return null;
  const count = buf.readUInt32BE(8);
  if (count > MAX_ENTRIES) return null;

  const hashBytes = usesSha256(gitDir) ? 32 : 20;
  /** @type {IndexEntry[]} */
  const entries = [];
  let off = 12;
  let prevPath = '';
  for (let i = 0; i < count; i += 1) {
    const start = off;
    // Fixed part: ctime(8) mtime(8) dev(4) ino(4) mode(4) uid(4) gid(4)
    // size(4) oid(hashBytes) flags(2).
    if (off + 40 + hashBytes + 2 > buf.length) return null;
    const mtimeSec = buf.readUInt32BE(off + 8);
    const mtimeNsec = buf.readUInt32BE(off + 12);
    const mode = buf.readUInt32BE(off + 24);
    const size = buf.readUInt32BE(off + 36);
    const oid = buf.toString('hex', off + 40, off + 40 + hashBytes);
    const flags = buf.readUInt16BE(off + 40 + hashBytes);
    off += 40 + hashBytes + 2;
    const stage = (flags >> 12) & 0x3;
    // Version 3+ may carry an extended-flags word, marked by bit 14.
    if (flags & 0x4000) {
      if (version < 3 || off + 2 > buf.length) return null;
      off += 2;
    }

    /** @type {string} */
    let p;
    if (version === 4) {
      // v4 compresses paths: a varint N ("strip N bytes from the previous
      // path"), then the NUL-terminated suffix to append.
      if (off >= buf.length) return null;
      let b = buf[off]; off += 1;
      let strip = b & 0x7f;
      let hops = 0;
      while (b & 0x80) {
        // Git's offset varint: the accumulated value gains 1 BEFORE each
        // 7-bit shift — decode_varint in git's own varint.c.
        if (off >= buf.length || hops > 6) return null;
        b = buf[off]; off += 1;
        strip = ((strip + 1) << 7) + (b & 0x7f);
        hops += 1;
      }
      const nul = buf.indexOf(0, off);
      if (nul === -1) return null;
      const suffix = buf.toString('utf8', off, nul);
      off = nul + 1;
      if (strip > prevPath.length) return null;
      p = prevPath.slice(0, prevPath.length - strip) + suffix;
    } else {
      // v2/v3: NUL-terminated path, then the whole entry padded with NULs to a
      // multiple of 8 bytes from the entry's start.
      const nameLen = flags & 0x0fff;
      const nul = nameLen < 0x0fff && off + nameLen <= buf.length && buf[off + nameLen] === 0
        ? off + nameLen
        : buf.indexOf(0, off);
      if (nul === -1) return null;
      p = buf.toString('utf8', off, nul);
      off = nul + 1;
      const entryLen = off - start;
      const padded = Math.ceil(entryLen / 8) * 8;
      off = start + padded;
      if (off > buf.length) return null;
    }
    if (!p) return null;
    entries.push({ path: p, mode, stage, oid, size, mtimeSec, mtimeNsec });
    prevPath = p;
  }
  return { entries, version, mtimeMs: st.mtimeMs };
}

module.exports = { readIndex, usesSha256, INDEX_MAX_BYTES, MAX_ENTRIES };
