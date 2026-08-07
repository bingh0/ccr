// @ts-check
'use strict';
// src/git-working-tree.js — what is uncommitted, computed from the index, the
// HEAD tree and the working tree itself. The model behind the pane section
// features/git-working-tree.feature describes.
//
// THE FOUR MARKS, AND THEIR PRECEDENCE. Each path gets exactly one:
//   !  conflicted — the index holds a stage-1/2/3 entry for it
//   M  modified   — the working tree differs from the index
//   +  staged     — the index differs from HEAD (and the tree matches the index)
//   ?  untracked  — in the working tree, in no index entry, not ignored
// A staged-then-edited file shows M, not +: the mark describes the FRESHEST
// divergence, the one the user's editor is holding. Conflict outranks both
// because it blocks everything else until resolved.
//
// THE MODIFIED CHECK IS GIT'S OWN, including the racy rule: an index entry
// whose cached stat (size + mtime) matches the file is clean — unless the
// entry's mtime is not older than the index file itself, where a same-second
// edit could hide, so the content is hashed. Hashing uses the oid's own width
// (sha-1 or sha-256) over git's blob framing.
//
// NO CACHE, BY DECISION. Refresh cadence was explicitly deferred to the build
// (features/OUT-OF-SCOPE.md); the section is computed per render, only while
// the git view is the one on screen, and the stat-match rule keeps a quiet
// tree cheap (one lstat per index entry, no hashing). If a pathological repo
// ever makes a tick heavy, a cache is an additive change behind this API.
//
// EVERY UNTRUSTED READ IS BOUNDED (safe-read rules; the walk carries its own
// visit budget), and every parse failure degrades to { state: 'unavailable' }
// — the pane says "git data unavailable" rather than describing a tree it
// could not actually read.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readIndex } = require('./git-index');
const { readHeadTree } = require('./git-objects');
const { parseIgnore, matchRules } = require('./git-ignore');
const { readTextCapped } = require('./safe-read');
const { stripControl } = require('./sanitize');

// The untracked walk's visit budget: dirents looked at, not files listed.
// Past it the walk stops and says so (`truncated`) instead of wedging the
// draw loop — the safety feature's rule applied to a whole directory tree.
const MAX_VISITED = 50_000;

// Hashing budget per compute: files whose stat is suspicious enough to need
// content hashed. A tree with more racy files than this degrades the excess
// to M (suspicion shown as suspicion) rather than reading gigabytes.
const MAX_HASHED = 500;

// Display cap for one path, applied at this boundary (the renderer trusts it).
const PATH_MAX = 512;

/** @typedef {'!'|'M'|'+'|'?'} ChangeMark */

/**
 * @typedef {object} WorkingTree
 * @property {'ok'|'unavailable'} state
 * @property {boolean} rebase             A rebase is part-way through.
 * @property {Array<{ path: string, mark: ChangeMark }>} entries
 * @property {boolean} truncated          The untracked walk hit its budget.
 */

/** @type {WorkingTree} */
const UNAVAILABLE = { state: 'unavailable', rebase: false, entries: [], truncated: false };

/**
 * Hash a working-tree file the way git names blobs: `"blob <size>\0"` + bytes.
 * A symlink's blob is its target string. Null when unreadable or over-cap.
 * @param {string} file
 * @param {fs.Stats} st  lstat of `file`.
 * @param {20|32} hashBytes
 * @returns {string|null}
 */
function hashWorkFile(file, st, hashBytes) {
  const algo = hashBytes === 32 ? 'sha256' : 'sha1';
  /** @type {Buffer} */
  let body;
  if (st.isSymbolicLink()) {
    try { body = Buffer.from(fs.readlinkSync(file), 'utf8'); } catch { return null; }
  } else {
    // Bounded read straight through the descriptor: no cap here would let one
    // giant racy file spend the whole draw budget. Files past the object cap
    // are legitimate content, but the pane only needs "same or different", and
    // a file that big with a suspicious stat is different in every real case.
    if (st.size > 64 * 1024 * 1024) return null;
    let fd = -1;
    try {
      fd = fs.openSync(file, 'r');
      const fst = fs.fstatSync(fd);
      if (!fst.isFile()) return null;
      body = Buffer.alloc(fst.size);
      const read = fs.readSync(fd, body, 0, body.length, 0);
      body = body.subarray(0, read);
    } catch {
      return null;
    } finally {
      if (fd !== -1) { try { fs.closeSync(fd); } catch { /* closed */ } }
    }
  }
  const h = crypto.createHash(algo);
  h.update('blob ' + body.length + '\0');
  h.update(body);
  return h.digest('hex');
}

/**
 * Compute the working-tree section's model.
 *
 * `opts.maxVisited` exists for exactly one caller: the design-tier scenario
 * that pins the walk-budget behavior (features/design/git-working-tree-rules
 * .feature), which could otherwise only be proven with a 50,000-file fixture.
 * Production callers pass nothing and get the real budget.
 *
 * @param {{ root: string, gitDir: string }} repo
 * @param {{ maxVisited?: number }} [opts]
 * @returns {WorkingTree}
 */
function computeWorkingTree(repo, opts = {}) {
  const { root, gitDir } = repo;
  const maxVisited = opts.maxVisited || MAX_VISITED;
  const idx = readIndex(gitDir);
  if (idx === null) return UNAVAILABLE;
  const headTree = readHeadTree(gitDir);
  if (headTree === null) return UNAVAILABLE;

  // A rebase leaves a state directory under .git for its whole run — both the
  // interactive form (rebase-merge) and the apply form (rebase-apply).
  let rebase = false;
  for (const marker of ['rebase-merge', 'rebase-apply']) {
    try { if (fs.lstatSync(path.join(gitDir, marker)).isDirectory()) rebase = true; } catch { /* absent */ }
  }

  /** @type {Set<string>} */
  const conflicted = new Set();
  /** @type {Map<string, import('./git-index').IndexEntry>} */
  const stage0 = new Map();
  for (const e of idx.entries) {
    if (e.stage === 0) stage0.set(e.path, e);
    else conflicted.add(e.path);
  }

  const indexMtimeSec = Math.floor(idx.mtimeMs / 1000);
  /** @type {string[]} */
  const modified = [];
  /** @type {string[]} */
  const staged = [];
  let hashed = 0;

  for (const [p, e] of stage0) {
    if (conflicted.has(p)) continue;
    const file = path.join(root, ...p.split('/'));
    let st = null;
    try { st = fs.lstatSync(file); } catch { st = null; }

    let treeDiffers = false;
    if (st === null || st.isDirectory()) {
      // Gone from the working tree (or replaced by a directory): modified,
      // unstaged — `git rm` would have removed the entry.
      treeDiffers = true;
    } else {
      const isLink = (e.mode & 0o170000) === 0o120000;
      if (isLink !== st.isSymbolicLink()) {
        treeDiffers = true;
      } else if (!isLink && process.platform !== 'win32'
        && ((e.mode & 0o100) !== 0) !== ((st.mode & 0o100) !== 0)) {
        // The executable bit is content to git. Not consulted on Windows,
        // where the filesystem has no such bit and git sets core.filemode off.
        treeDiffers = true;
      } else {
        const statClean = st.size === e.size
          && Math.floor(st.mtimeMs / 1000) === e.mtimeSec
          && e.mtimeSec < indexMtimeSec; // the racy rule: same-second is suspect
        if (!statClean) {
          if (st.size !== e.size) {
            treeDiffers = true;
          } else if (hashed < MAX_HASHED) {
            hashed += 1;
            const oid = hashWorkFile(file, st, /** @type {20|32} */ (e.oid.length / 2));
            treeDiffers = oid === null || oid !== e.oid;
          } else {
            treeDiffers = true; // over the hash budget: suspicion shown as M
          }
        }
      }
    }

    if (treeDiffers) {
      modified.push(p);
      continue;
    }
    const committed = headTree.get(p);
    if (!committed || committed.oid !== e.oid || committed.mode !== e.mode) staged.push(p);
  }

  // Staged deletions: committed paths with no index entry at all. (A path
  // whose entry is conflicted is already carrying the louder mark.)
  for (const p of headTree.keys()) {
    if (!stage0.has(p) && !conflicted.has(p)) staged.push(p);
  }

  // ── Untracked: walk the tree the user can see ────────────────────────────
  /** @type {string[]} */
  const untracked = [];
  let truncated = false;
  /** Ignore-rule frames: repo-wide exclude first (weakest), then each
   * directory's .gitignore on the way down. `base` is the POSIX-relative
   * directory the frame's patterns are anchored to. */
  const excludeRules = parseIgnore(readTextCapped(path.join(gitDir, 'info', 'exclude'), 256 * 1024));
  /** @type {(rel: string, isDir: boolean, frames: Array<{ base: string, rules: import('./git-ignore').IgnoreRule[] }>) => boolean} */
  const ignored = (rel, isDir, frames) => {
    let verdict = matchRules(excludeRules, rel, isDir);
    for (const f of frames) {
      const sub = f.base === '' ? rel : rel.slice(f.base.length + 1);
      const v = matchRules(f.rules, sub, isDir);
      if (v !== null) verdict = v;
    }
    return verdict === true;
  };

  let visited = 0;
  /** @type {Array<{ dir: string, rel: string, frames: Array<{ base: string, rules: import('./git-ignore').IgnoreRule[] }> }>} */
  const stack = [{ dir: root, rel: '', frames: [] }];
  while (stack.length > 0) {
    const top = /** @type {NonNullable<typeof stack[0]>} */ (stack.pop());
    const gi = readTextCapped(path.join(top.dir, '.gitignore'), 256 * 1024);
    const frames = gi === null ? top.frames : [...top.frames, { base: top.rel, rules: parseIgnore(gi) }];
    /** @type {fs.Dirent[]} */
    let dirents = [];
    try { dirents = fs.readdirSync(top.dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      visited += 1;
      if (visited > maxVisited) { truncated = true; break; }
      if (d.name === '.git') continue; // the repo itself, or a submodule's
      const rel = top.rel === '' ? d.name : top.rel + '/' + d.name;
      if (d.isDirectory()) {
        if (ignored(rel, true, frames)) continue;
        stack.push({ dir: path.join(top.dir, d.name), rel, frames });
      } else if (d.isFile() || d.isSymbolicLink()) {
        if (stage0.has(rel) || conflicted.has(rel)) continue;
        if (ignored(rel, false, frames)) continue;
        untracked.push(rel);
      }
    }
    if (truncated) break;
  }

  /** Display form: control bytes stripped, capped, at this boundary only. */
  const show = (/** @type {string} */ p) => {
    const clean = stripControl(p);
    const cps = [...clean];
    return cps.length <= PATH_MAX ? clean : cps.slice(0, PATH_MAX - 1).join('') + '…';
  };
  const sort = (/** @type {string[]} */ a) => [...a].sort();
  /** @type {WorkingTree['entries']} */
  const entries = [
    ...sort([...conflicted]).map((p) => ({ path: show(p), mark: /** @type {ChangeMark} */ ('!') })),
    ...sort(staged).map((p) => ({ path: show(p), mark: /** @type {ChangeMark} */ ('+') })),
    ...sort(modified).map((p) => ({ path: show(p), mark: /** @type {ChangeMark} */ ('M') })),
    ...sort(untracked).map((p) => ({ path: show(p), mark: /** @type {ChangeMark} */ ('?') })),
  ];
  return { state: 'ok', rebase, entries, truncated };
}

module.exports = { computeWorkingTree, MAX_VISITED, PATH_MAX };
