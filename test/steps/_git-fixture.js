// @ts-check
'use strict';
// test/steps/_git-fixture.js — build real repository states by hand.
//
// The identity steps write HEAD and a ref; the working-tree scenarios need the
// rest of a repository: an index in git's v2 layout, loose commit and tree
// objects, and worktree files whose cached stats say what each scenario means.
// Built by hand for the same two reasons git-repo-identity.steps.js gives —
// the suite must pass with no git installed, and a hand-built fixture states
// exactly which bytes the reader is held to. test/git-working-tree.test.js is
// the far side: real git reading THESE fixtures (fsck, ls-files, status) and
// this reader reading repositories REAL git built.
//
// One deliberate economy: blob objects are never written. The product reads
// commits and trees only (src/git-objects.js header) — a blob oid is compared,
// never dereferenced — so fixtures carry blob ids computed the way git names
// them, with no object file behind them. The far-side test does not get this
// shortcut and builds its repos with real git.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** @param {Buffer|string} b */
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

/**
 * Name bytes the way git does: `"<type> <size>\0"` + data.
 * @param {'blob'|'tree'|'commit'} type
 * @param {Buffer} data
 * @returns {{ oid: string, framed: Buffer }}
 */
function frame(type, data) {
  const framed = Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'latin1'), data]);
  return { oid: sha1(framed), framed };
}

/** The oid a blob of this content would have, without writing anything. */
const blobOid = (/** @type {string|Buffer} */ content) =>
  frame('blob', Buffer.isBuffer(content) ? content : Buffer.from(content)).oid;

/**
 * Write a loose object and return its oid.
 * @param {string} gitDir
 * @param {'blob'|'tree'|'commit'} type
 * @param {Buffer} data
 */
function writeLoose(gitDir, type, data) {
  const { oid, framed } = frame(type, data);
  const dir = path.join(gitDir, 'objects', oid.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, oid.slice(2)), zlib.deflateSync(framed));
  return oid;
}

/**
 * Write the tree objects for a flat `path → { oid, mode }` map, nested the way
 * git stores them, and return the root tree's oid.
 * @param {string} gitDir
 * @param {Map<string, { oid: string, mode: number }>} files
 * @returns {string}
 */
function writeTrees(gitDir, files) {
  /** @typedef {{ trees: Map<string, Node>, files: Map<string, { oid: string, mode: number }> }} Node */
  /** @type {Node} */
  const root = { trees: new Map(), files: new Map() };
  for (const [p, v] of files) {
    const parts = p.split('/');
    let at = root;
    for (const part of parts.slice(0, -1)) {
      if (!at.trees.has(part)) at.trees.set(part, { trees: new Map(), files: new Map() });
      at = /** @type {Node} */ (at.trees.get(part));
    }
    at.files.set(/** @type {string} */ (parts[parts.length - 1]), v);
  }
  /** @param {Node} node @returns {string} */
  const write = (node) => {
    /** @type {Array<{ sortKey: string, line: Buffer }>} */
    const entries = [];
    for (const [name, sub] of node.trees) {
      const oid = write(sub);
      entries.push({
        // Git's tree sort compares directory names as `name + '/'`.
        sortKey: name + '/',
        line: Buffer.concat([Buffer.from(`40000 ${name}\0`, 'utf8'), Buffer.from(oid, 'hex')]),
      });
    }
    for (const [name, v] of node.files) {
      entries.push({
        sortKey: name,
        line: Buffer.concat([Buffer.from(`${v.mode.toString(8)} ${name}\0`, 'utf8'), Buffer.from(v.oid, 'hex')]),
      });
    }
    entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return writeLoose(gitDir, 'tree', Buffer.concat(entries.map((e) => e.line)));
  };
  return write(root);
}

/**
 * Write a commit object over a tree and return its oid.
 * @param {string} gitDir
 * @param {string} treeOid
 * @param {{ parents?: string[], message?: string, when?: number }} [o]
 */
function writeCommit(gitDir, treeOid, o = {}) {
  const when = o.when || 1700000000;
  const who = `ccr fixture <fixture@ccr.invalid> ${when} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const p of o.parents || []) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '', o.message || 'fixture', '');
  return writeLoose(gitDir, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/**
 * Write a v2 index. Entries carry the cached stat each scenario means them to
 * have; the trailer checksum is real so git itself can read the file back.
 *
 * @param {string} gitDir
 * @param {Array<{ path: string, oid: string, mode?: number, stage?: number,
 *   size: number, mtimeSec: number, mtimeNsec?: number }>} entries
 */
function writeIndex(gitDir, entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1
    : (a.stage || 0) - (b.stage || 0)));
  const parts = [Buffer.alloc(12)];
  parts[0].write('DIRC', 0, 'latin1');
  parts[0].writeUInt32BE(2, 4);
  parts[0].writeUInt32BE(sorted.length, 8);
  for (const e of sorted) {
    const pathBuf = Buffer.from(e.path, 'utf8');
    const fixed = Buffer.alloc(62);
    fixed.writeUInt32BE(e.mtimeSec, 0);                    // ctime sec
    fixed.writeUInt32BE(e.mtimeNsec || 0, 4);              // ctime nsec
    fixed.writeUInt32BE(e.mtimeSec, 8);                    // mtime sec
    fixed.writeUInt32BE(e.mtimeNsec || 0, 12);             // mtime nsec
    fixed.writeUInt32BE(0, 16);                            // dev
    fixed.writeUInt32BE(0, 20);                            // ino
    fixed.writeUInt32BE(e.mode == null ? 0o100644 : e.mode, 24);
    fixed.writeUInt32BE(0, 28);                            // uid
    fixed.writeUInt32BE(0, 32);                            // gid
    fixed.writeUInt32BE(e.size >>> 0, 36);
    Buffer.from(e.oid, 'hex').copy(fixed, 40);
    fixed.writeUInt16BE(((e.stage || 0) << 12) | Math.min(pathBuf.length, 0xfff), 60);
    const entryLen = 62 + pathBuf.length + 1;
    const padded = Math.ceil(entryLen / 8) * 8;
    parts.push(fixed, pathBuf, Buffer.alloc(padded - entryLen + 1));
  }
  const body = Buffer.concat(parts);
  fs.writeFileSync(path.join(gitDir, 'index'),
    Buffer.concat([body, Buffer.from(sha1(body), 'hex')]));
}

/**
 * @typedef {object} RepoSpec
 * @property {Record<string, string>} [committed]  Path → content: in HEAD, in the
 *   index, on disk, all agreeing (clean).
 * @property {Record<string, string>} [staged]     Path → content: on disk and in
 *   the index (agreeing), absent from HEAD.
 * @property {Record<string, [string, string]>} [modified]  Path → [committed,
 *   worktree]: HEAD and index hold the first, disk holds the second.
 * @property {Record<string, string>} [untracked]  Path → content: on disk only.
 * @property {string[]} [conflicted]  Paths holding stage-1/2/3 entries.
 * @property {boolean} [rebase]       Leave a rebase-merge state directory.
 */

/**
 * Build a full working-tree scenario world: worktree files, loose commit and
 * tree objects, a v2 index, HEAD on refs/heads/main.
 *
 * Tracked files get an mtime firmly in the past (and the index is written
 * after), so "the stat matches" is true the way it is in a real quiet tree —
 * otherwise the racy rule would hash every fixture and a stat-path bug could
 * never be caught.
 *
 * @param {string} dir
 * @param {RepoSpec} spec
 */
function buildWorkRepo(dir, spec) {
  const git = path.join(dir, '.git');
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });

  const writeWorkFile = (/** @type {string} */ rel, /** @type {string} */ content) => {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  const past = Math.floor(Date.now() / 1000) - 900;
  /** @type {Map<string, { oid: string, mode: number }>} */
  const headFiles = new Map();
  /** @type {Array<Parameters<typeof writeIndex>[1][0]>} */
  const index = [];

  for (const [p, content] of Object.entries(spec.committed || {})) {
    const abs = writeWorkFile(p, content);
    fs.utimesSync(abs, past, past);
    const oid = blobOid(content);
    headFiles.set(p, { oid, mode: 0o100644 });
    index.push({ path: p, oid, size: Buffer.byteLength(content), mtimeSec: past });
  }
  for (const [p, content] of Object.entries(spec.staged || {})) {
    const abs = writeWorkFile(p, content);
    fs.utimesSync(abs, past, past);
    index.push({ path: p, oid: blobOid(content), size: Buffer.byteLength(content), mtimeSec: past });
  }
  for (const [p, pair] of Object.entries(spec.modified || {})) {
    const [committed, work] = pair;
    const abs = writeWorkFile(p, work);
    fs.utimesSync(abs, past, past);
    const oid = blobOid(committed);
    headFiles.set(p, { oid, mode: 0o100644 });
    // The index caches the stat of the file AS ADDED — the committed size,
    // not the worktree's.
    index.push({ path: p, oid, size: Buffer.byteLength(committed), mtimeSec: past });
  }
  for (const [p, content] of Object.entries(spec.untracked || {})) {
    writeWorkFile(p, content);
  }
  for (const p of spec.conflicted || []) {
    writeWorkFile(p, 'conflict both sides\n');
    for (const stage of [1, 2, 3]) {
      index.push({
        path: p, oid: blobOid(`side ${stage} of ${p}\n`), stage,
        size: 0, mtimeSec: past,
      });
    }
  }

  const treeOid = writeTrees(git, headFiles);
  const commitOid = writeCommit(git, treeOid);
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), commitOid + '\n');
  writeIndex(git, index);
  if (spec.rebase) fs.mkdirSync(path.join(git, 'rebase-merge'), { recursive: true });
  return dir;
}

module.exports = { buildWorkRepo, writeIndex, writeTrees, writeCommit, writeLoose, blobOid, frame };
